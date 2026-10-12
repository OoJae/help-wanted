// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IQuestions} from "../../src/interfaces/IQuestions.sol";
import {Payroll} from "../../src/payroll/Payroll.sol";
import {MockIntake} from "../questions/mocks/MockIntake.sol";
import {MockIMD, MockSIMD} from "./mocks/MockTokens.sol";
import {MockSeats, MockAdapter} from "./mocks/MockSeats.sol";
import {QuestionsRig, Rig} from "./mocks/QuestionsRig.sol";

using Rig for QuestionsRig;

/// @dev What every Payroll test starts from: the contract wired to this project's real `Questions`
/// (through `QuestionsRig`, which only adds ways to set it up) and to mocks of the four dependencies
/// that live outside the project (IMD, sIMD, the seat token, the seat Adapter), a staker already in
/// sIMD, and a payer with IMD and an allowance.
///
/// The three house feeds are planted under fixed ids, each buying an action of its own, so a test can
/// give each feed its own cost by setting the Intake's price for that action. Until a test sets a
/// cost the Intake sells nothing and every feed costs zero, which Payroll reads as "needs nothing".
abstract contract PayrollSetup is Test {
    uint256 internal constant SEAT_COUNT = 2000;
    bytes32 internal constant FEED_A = keccak256("feed: payrolls");
    bytes32 internal constant FEED_B = keccak256("feed: hires");
    bytes32 internal constant FEED_C = keccak256("feed: employers");
    /// @dev The mainnet Intake price plus a small keeper tip.
    uint256 internal constant FEED_COST = 0.52e18;
    /// @dev A time well inside a fortnight (period start + 3 days), so ageing tests can count from it.
    uint256 internal constant START = 1456 * 14 days + 3 days;

    MockIMD internal imd;
    MockSIMD internal simd;
    MockSeats internal seats;
    MockAdapter internal adapter;
    MockIntake internal intake;
    QuestionsRig internal questions;
    Payroll internal payroll;

    address internal payer = makeAddr("payer");
    address internal staker = makeAddr("staker");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(START);
        vm.roll(26_000_000);

        imd = new MockIMD();
        simd = new MockSIMD(IERC20(address(imd)));
        seats = new MockSeats(seatCount());
        adapter = new MockAdapter();
        intake = new MockIntake(address(0x4E0F), address(0x3D3C));
        questions = new QuestionsRig(address(intake), address(imd), makeAddr("oracle signer"));
        questions.plant(FEED_A, bytes32("action of feed a"));
        questions.plant(FEED_B, bytes32("action of feed b"));
        questions.plant(FEED_C, bytes32("action of feed c"));
        payroll = deployPayroll();
        // The token's fault switches (see `MockIMD`) act on pulls out of Payroll and nothing else.
        imd.watch(address(payroll));

        // sIMD has stakers, as on mainnet.
        imd.mint(staker, 1_000e18);
        vm.startPrank(staker);
        imd.approve(address(simd), type(uint256).max);
        simd.deposit(1_000e18, staker);
        vm.stopPrank();

        imd.mint(payer, 1_000_000_000e18);
        vm.prank(payer);
        imd.approve(address(payroll), type(uint256).max);
    }

    function seatCount() internal pure virtual returns (uint256) {
        return SEAT_COUNT;
    }

    function deployPayroll() internal virtual returns (Payroll) {
        return new Payroll(
            address(imd),
            address(simd),
            address(seats),
            seatCount(),
            address(adapter),
            address(questions),
            FEED_A,
            FEED_B,
            FEED_C
        );
    }

    function pay(uint256 amount) internal {
        vm.prank(payer);
        payroll.pay(amount, bytes32("test"));
    }

    function tipTo(uint256[] memory agentIds, uint256 amount) internal {
        vm.prank(payer);
        payroll.tip(agentIds, amount);
    }

    function ids(uint256 a) internal pure returns (uint256[] memory list) {
        list = new uint256[](1);
        list[0] = a;
    }

    function ids(uint256 a, uint256 b) internal pure returns (uint256[] memory list) {
        list = new uint256[](2);
        list[0] = a;
        list[1] = b;
    }

    function ids(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory list) {
        list = new uint256[](3);
        list[0] = a;
        list[1] = b;
        list[2] = c;
    }

    function setFeedCosts(uint256 cost) internal {
        questions.setCost(FEED_A, cost);
        questions.setCost(FEED_B, cost);
        questions.setCost(FEED_C, cost);
    }

    /// @dev Cuts Questions off: every call Payroll makes to it reverts, as if the contract were
    /// broken or gone. `false` puts it back.
    function questionsDown(bool down) internal {
        if (!down) {
            vm.clearMockedCalls();
            return;
        }
        bytes4[4] memory selectors = [
            IQuestions.costOf.selector,
            IQuestions.meterOf.selector,
            IQuestions.fund.selector,
            IQuestions.sharesOf.selector
        ];
        for (uint256 i; i < selectors.length; ++i) {
            vm.mockCallRevert(
                address(questions),
                abi.encodeWithSelector(selectors[i]),
                abi.encodeWithSelector(QuestionsRig.Down.selector)
            );
        }
    }

    /// @dev Makes only `fund` revert: Questions answers its views and refuses every top-up.
    function questionsFundDown(bool down) internal {
        if (!down) {
            vm.clearMockedCalls();
            return;
        }
        vm.mockCallRevert(
            address(questions),
            abi.encodeWithSelector(IQuestions.fund.selector),
            abi.encodeWithSelector(QuestionsRig.Down.selector)
        );
    }

    /// @dev The books must add up after anything a test does.
    function assertBooksBalance() internal view {
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.received, l.toStakers + l.toSeats + l.toFeeds, "received != stakers + seats + feeds");
        assertLe(l.dripped, l.toStakers, "dripped > toStakers");
        assertLe(l.seatClaimed, l.toSeats + l.tipsToSeats, "seats paid more than the pool was given");
        assertLe(l.feedsFunded, l.toFeeds, "feeds funded beyond the budget");
        assertEq(payroll.seatAccrued() * seatCount() + payroll.seatCarry(), l.toSeats + l.tipsToSeats, "seat pool");
        (,,,, uint256 total) = payroll.owed();
        assertEq(imd.balanceOf(address(payroll)), total + payroll.unbooked(), "balance != owed + unbooked");
        assertGe(imd.balanceOf(address(payroll)), total, "balance does not cover what is owed");
        assertEq(imd.allowance(address(payroll), address(questions)), 0, "allowance left on Questions");
    }
}
