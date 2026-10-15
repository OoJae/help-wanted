// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IQuestions} from "../../src/interfaces/IQuestions.sol";
import {JobsReport} from "../../src/payroll/JobsReport.sol";
import {MockIntake} from "../questions/mocks/MockIntake.sol";
import {MockIMD} from "./mocks/MockTokens.sol";
import {QuestionsRig, Rig} from "./mocks/QuestionsRig.sol";

using Rig for QuestionsRig;

/// @dev The Jobs Report wired to this project's real `Questions`, through `QuestionsRig`, which lets a
/// test write rounds straight into its storage. The report reads them with the real `roundOf` and
/// `roundCount`. Writing rounds by hand is what lets these tests show the report shapes the real feed
/// never produces (gaps, overlaps, a pending round behind an answered one); the tests under
/// `integration/` print from rounds that were really requested and really answered. "Day k" is the
/// 7,200-block window that starts one block after day k-1 ends, so consecutive days are contiguous.
abstract contract JobsReportSetup is Test {
    bytes32 internal constant PAYROLLS = keccak256("feed: payrolls");
    bytes32 internal constant HIRES = keccak256("feed: hires");
    bytes32 internal constant EMPLOYERS = keccak256("feed: employers");
    uint64 internal constant BASE = 26_000_000;
    uint64 internal constant DAY = 7_200;

    QuestionsRig internal q;
    JobsReport internal report;

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        vm.roll(BASE + 400 * DAY);
        q = new QuestionsRig(
            address(new MockIntake(address(0x4E0F), address(0x3D3C))), address(new MockIMD()), makeAddr("oracle signer")
        );
        report = new JobsReport(address(q), PAYROLLS, HIRES, EMPLOYERS);
    }

    /// @dev Cuts Questions off: every read the report makes reverts with `QuestionsRig.Down`.
    /// `false` puts it back.
    function questionsDown(bool down) internal {
        if (!down) {
            vm.clearMockedCalls();
            return;
        }
        _refuse(abi.encodeWithSelector(IQuestions.roundCount.selector));
        _refuse(abi.encodeWithSelector(IQuestions.roundOf.selector));
    }

    /// @dev Cuts off one feed only: reads of `feedId` revert, reads of the other feeds go through.
    function feedDown(bytes32 feedId) internal {
        _refuse(abi.encodeWithSelector(IQuestions.roundCount.selector, feedId));
        _refuse(abi.encodeWithSelector(IQuestions.roundOf.selector, feedId));
    }

    function _refuse(bytes memory callPrefix) private {
        vm.mockCallRevert(address(q), callPrefix, abi.encodeWithSelector(QuestionsRig.Down.selector));
    }

    function first(uint256 day) internal pure returns (uint64) {
        return uint64(BASE + day * DAY + 1);
    }

    function last(uint256 day) internal pure returns (uint64) {
        return uint64(BASE + (day + 1) * DAY);
    }

    function payrolls(uint256 day, uint256 amount) internal returns (uint64 round) {
        return q.pushAnswered(PAYROLLS, amount, first(day), last(day));
    }

    function hires(uint256 day, uint256 count) internal returns (uint64 round) {
        return q.pushAnswered(HIRES, count, first(day), last(day));
    }

    /// @dev A hires answer whose window sits `shift` blocks after day `day` on both edges: what the
    /// real feed produces once it has been requested `shift` blocks later than payrolls.
    function hiresShifted(uint256 day, uint64 shift, uint256 count) internal returns (uint64 round) {
        return q.pushAnswered(HIRES, count, first(day) + shift, last(day) + shift);
    }

    /// @dev Stores a list answer the way Questions does: as the hash of the attested bytes.
    function employers(bytes memory answer, uint256 firstDay, uint256 lastDay) internal returns (uint64 round) {
        return q.pushAnswered(EMPLOYERS, uint256(keccak256(answer)), first(firstDay), last(lastDay));
    }

    function addresses(uint256 n) internal pure returns (address[] memory list) {
        list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = address(uint160(0xE0000 + i));
        }
    }
}
