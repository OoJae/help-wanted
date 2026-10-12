// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Questions} from "../../../src/questions/Questions.sol";
import {MockIntake} from "../../questions/mocks/MockIntake.sol";

/// @title The real Standing Questions contract, with doors for the Payroll and Jobs Report tests
/// @notice Payroll and the Jobs Report are tested against this project's own `Questions`, not a
/// hand-written copy of its interface: every read they make (`costOf`, `meterOf`, `roundOf`,
/// `roundCount`) and every top-up (`fund`) runs the code that will be launched beside them.
///
/// What this adds is a way to put that contract into a state without walking there. A feed can be
/// planted under a fixed id (the launch feeds are content-addressed, which no test of Payroll's
/// arithmetic needs), a meter spent from as a bought request spends it, and rounds written
/// directly, including shapes the real contract never produces (two pending rounds, windows that
/// overlap or leave gaps). The Jobs Report must stay correct for any rounds it is shown, so its
/// tests need those shapes.
///
/// Nothing here replaces behaviour: no function of `Questions` is overridden. The tests under
/// `integration/` and `fork/` use the unmodified contract and reach every state by real requests
/// and real callbacks.
///
/// @dev The doors are few and small on purpose. `Questions` is close to the size a contract may
/// have, and this one must stay under the same limit so that `forge build --sizes` passes for the
/// whole project. What can be done from outside is done from outside: see `Rig` below.
contract QuestionsRig is Questions {
    /// @dev What the tests make `Questions` answer when they cut it off (see `PayrollSetup` and
    /// `JobsReportSetup`): the revert data of a contract that is down.
    error Down();

    constructor(address intake, address imd, address oracleSigner_) Questions(intake, imd, oracleSigner_) {}

    // ---- feeds ----------------------------------------------------------------------------------

    /// @dev Makes `feedId` an existing feed that buys `action`, with no tip and no cap that could
    /// bind, so that `costOf(feedId)` is exactly the Intake's price for `action`.
    function plant(bytes32 feedId, bytes32 action) external {
        Feed storage f = _feeds[feedId];
        f.state.exists = true;
        f.params.action = action;
        f.params.maxPrice = type(uint96).max;
    }

    /// @dev Makes `feedId` a feed nobody created: `costOf` is zero and `fund` reverts.
    function unplant(bytes32 feedId) external {
        _feeds[feedId].state.exists = false;
    }

    /// @dev What buying a request does to a meter: the amount leaves the meter and the contract.
    function spend(bytes32 feedId, uint256 amount) external {
        Meter storage m = _feeds[feedId].meter;
        if (amount > m.balance) amount = m.balance;
        m.balance -= uint128(amount);
        totalMetered -= amount;
        // The same transfer routine `Questions` itself uses, so it adds no code of its own.
        SafeERC20.safeTransfer(IMD, address(0xdead), amount);
    }

    // ---- rounds ---------------------------------------------------------------------------------

    function openRound(bytes32 feedId, uint64 fromBlock, uint64 toBlock) external returns (uint64 round) {
        FeedState storage s = _feeds[feedId].state;
        round = ++s.rounds;
        Round storage r = _rounds[feedId][round];
        (r.fromBlock, r.toBlock, r.status) = (fromBlock, toBlock, RoundStatus.Pending);
    }

    function answer(bytes32 feedId, uint64 round, uint256 value) external {
        Round storage r = _rounds[feedId][round];
        (r.status, r.value, r.updatedAt) = (RoundStatus.Answered, value, uint48(block.timestamp));
        FeedState storage s = _feeds[feedId].state;
        if (round > s.latestRound) (s.latestRound, s.lastToBlock) = (uint48(round), uint48(r.toBlock));
    }

    function fail(bytes32 feedId, uint64 round) external {
        _rounds[feedId][round].status = RoundStatus.Failed;
    }
}

/// @title What the tests do with the rig in more than one call
/// @notice A test file attaches it with `using Rig for QuestionsRig;` and then reads as if the rig
/// had these doors too. They are kept out of the rig to keep its bytecode small.
library Rig {
    /// @dev Sets what the next request of a planted feed costs, the way it is really set: by the
    /// Intake's price for the feed's action. Zero means the action is not sold.
    function setCost(QuestionsRig q, bytes32 feedId, uint256 cost) internal {
        MockIntake(address(q.INTAKE())).setPrice(q.feedParams(feedId).action, address(q.IMD()), cost);
    }

    function pushAnswered(QuestionsRig q, bytes32 feedId, uint256 value, uint64 fromBlock, uint64 toBlock)
        internal
        returns (uint64 round)
    {
        round = q.openRound(feedId, fromBlock, toBlock);
        q.answer(feedId, round, value);
    }

    function pushFailed(QuestionsRig q, bytes32 feedId, uint64 fromBlock, uint64 toBlock)
        internal
        returns (uint64 round)
    {
        round = q.openRound(feedId, fromBlock, toBlock);
        q.fail(feedId, round);
    }
}
