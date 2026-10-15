// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {DeskBase} from "./DeskBase.sol";
import {MockEmployer} from "./mocks/MockEmployer.sol";

/// The claimed path: claimDelivered, challenge, finalize, stamp, and how a dispute ends.
contract WorkOrdersClaimedTest is DeskBase {
    /// @dev The true record of the first order's first claim: what the registry will hold if the
    /// job `runner` registers for order 1 completes. A runner that claims delivery names its hash,
    /// and `_landGood(1, JOB)` writes exactly these bytes.
    bytes internal record;
    bytes32 internal recordHash;
    /// @dev The last receipt a test landed that is not `record`.
    bytes internal landed;

    bytes16 internal constant NO_SUCH_JOB = bytes16(uint128(0xdead));

    function setUp() public override {
        super.setUp();
        record = _recordOf(
            JOB, KIND, bytes.concat(_refHeader(block.chainid, address(desk), 1, 1, runner), SPEC), "completed"
        );
        recordHash = keccak256(record);
    }

    /// @dev The registry writes a second receipt for the job, as the live one does for about one
    /// job in four: same objective, kind and state as the first, other bytes, no agent list. From
    /// here on only the second can be proven.
    function _supersede(uint256 id, bytes16 jobId) internal returns (bytes memory second) {
        second = _landWith(jobId, KIND, _objective(id), "completed", new uint256[](0));
    }

    /// @dev An order on the claimed path with no arbiter, held by `runner`, who registered a job
    /// id that does not exist and claimed delivery: no swarm job was opened, no fee was paid, and
    /// the registry will never hold a receipt for it.
    function _falseClaim() internal returns (uint256 id) {
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 1;
        id = _open(p);
        _claim(id, runner);
        _register(id, runner, NO_SUCH_JOB);
        vm.prank(runner);
        desk.claimDelivered(id, keccak256("there is no such record"));
    }

    // --- claimDelivered -----------------------------------------------------------------------

    function test_claimDelivered_opensTheChallengeWindow() public {
        uint256 id = _registered(_claimedParams());
        vm.warp(START + 3 hours);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.DeliveryClaimed(id, JOB, recordHash, START + 3 hours + 24 hours);
        vm.prank(runner);
        desk.claimDelivered(id, recordHash);

        _assertState(id, IWorkOrders.State.Asserted);
        IWorkOrdersRunner.Claim memory c = desk.claimOf(id);
        assertEq(c.assertedAt, START + 3 hours);
        assertEq(c.recordHash, recordHash);
        assertEq(c.challenger, address(0));
        // No money moved.
        assertEq(imd.balanceOf(address(desk)), MAX_PAY + BOND);
        assertEq(desk.orderOfJob(JOB), 0);
        _assertSolvent();
    }

    function test_claimDelivered_onlyOnOrdersThatAllowIt() public {
        uint256 id = _registered(_params());
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ClaimedPathOff.selector);
        desk.claimDelivered(id, recordHash);
        // The callback flag alone does not allow it either.
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 2;
        id = _open(p);
        _claim(id, runner);
        _register(id, runner, JOB2);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ClaimedPathOff.selector);
        desk.claimDelivered(id, recordHash);
    }

    function test_claimDelivered_onlyTheRunner() public {
        uint256 id = _registered(_claimedParams());
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.claimDelivered(id, recordHash);
        vm.prank(employer);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.claimDelivered(id, recordHash);
    }

    function test_claimDelivered_needsARegisteredJob() public {
        uint256 id = _open(_claimedParams());
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.claimDelivered(id, recordHash);
        _claim(id, runner);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.claimDelivered(id, recordHash);
    }

    function test_claimDelivered_revertsOnAZeroHash() public {
        uint256 id = _registered(_claimedParams());
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ZeroHash.selector);
        desk.claimDelivered(id, bytes32(0));
    }

    function test_claimDelivered_onlyOncePerClaim() public {
        uint256 id = _asserted(record);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.claimDelivered(id, keccak256("another"));
    }

    /// On this path a job id is only what the runner says: nothing stops one runner from naming
    /// the same job on two orders, and both claims are paid if nobody challenges. Only a receipt
    /// ties a job to an order, and it can do that for one order alone.
    function test_claimDelivered_theJobIdIsOnlyTheRunnersWord() public {
        uint256 first = _asserted(record);
        uint256 second = _open(_claimedParams());
        _claim(second, runner);
        _register(second, runner, JOB);
        vm.prank(runner);
        desk.claimDelivered(second, recordHash);
        vm.warp(START + 24 hours);
        desk.finalize(first);
        desk.finalize(second);
        assertEq(desk.orderOfJob(JOB), 0);

        // The receipt carries the first order's header: it stamps that order and no other.
        _landGood(first, JOB);
        vm.expectRevert(IWorkOrdersRunner.WrongHeader.selector);
        desk.stamp(second, record, _noChunks());
        desk.stamp(first, record, _noChunks());
        vm.expectRevert(IWorkOrdersRunner.JobUsed.selector);
        desk.stamp(second, record, _noChunks());
        assertEq(desk.orderOfJob(JOB), first);
        assertFalse(desk.orderOf(second).proven);
    }

    /// The challenge window and, after it, a day for a dispute to be decided must both fit before
    /// the delivery deadline.
    function test_claimDelivered_mustLeaveRoomForTheChallengeAndTheDispute() public {
        uint256 id = _registered(_claimedParams());
        uint256 deadline = START + DELIVERY;
        assertEq(desk.DISPUTE_WINDOW(), 24 hours);
        vm.warp(deadline - 48 hours + 1);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.TooLate.selector);
        desk.claimDelivered(id, recordHash);
        // One challenge window before the deadline is no longer enough.
        vm.warp(deadline - 24 hours);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.TooLate.selector);
        desk.claimDelivered(id, recordHash);
        vm.warp(deadline + 5 days);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.TooLate.selector);
        desk.claimDelivered(id, recordHash);

        vm.warp(deadline - 48 hours);
        vm.prank(runner);
        desk.claimDelivered(id, recordHash);
        _assertState(id, IWorkOrders.State.Asserted);
    }

    /// Even when the runner claims at the last moment allowed and the challenge comes in the last
    /// second of its window, the arbiter (or a receipt) has a full day before anyone may end the
    /// dispute by `timeout`.
    function test_challenge_inTheLastSecondStillLeavesADayToDecide() public {
        uint256 id = _registered(_claimedParams());
        uint256 deadline = START + DELIVERY;
        vm.warp(deadline - 48 hours);
        vm.prank(runner);
        desk.claimDelivered(id, recordHash);
        vm.warp(deadline - 24 hours - 1);
        vm.prank(challenger);
        desk.challenge(id);

        vm.warp(deadline - 1);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.timeout(id);
        // 24 hours after the challenge the arbiter can still decide.
        vm.prank(arbiter);
        desk.resolve(id, true);
        _assertState(id, IWorkOrders.State.Delivered);
    }

    // --- finalize -----------------------------------------------------------------------------

    function test_finalize_paysAnUnchallengedClaimAsUnproven() public {
        uint256 id = _asserted(record);
        vm.warp(START + 24 hours - 1);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.finalize(id);

        vm.warp(START + 24 hours);
        (uint256 runnerPay, uint256 fee, uint256 tip) = _split(MIN_PAY);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Delivered(
            id, JOB, runner, recordHash, false, runnerPay, fee, tip, MAX_PAY - MIN_PAY, BOND, new uint256[](0)
        );
        vm.prank(stranger);
        desk.finalize(id);

        _assertState(id, IWorkOrders.State.Delivered);
        IWorkOrdersRunner.Order memory o = desk.orderOf(id);
        assertFalse(o.proven, "an unproven delivery was marked proven");
        assertEq(o.spent, MIN_PAY);
        assertEq(o.returned, MAX_PAY - MIN_PAY);
        assertEq(imd.balanceOf(runner), FUNDS + runnerPay);
        assertEq(imd.balanceOf(employer), FUNDS - MIN_PAY);
        assertEq(imd.balanceOf(address(payroll)), fee + tip);
        assertEq(imd.balanceOf(address(desk)), 0);
        // The tip went in with no agent list: Payroll sends such a tip to the seat pool.
        assertEq(payroll.tipCalls(), 1);
        assertEq(payroll.lastAgentIds().length, 0);
        // No receipt was matched, so the job is not tied to the order.
        assertEq(desk.orderOfJob(JOB), 0);
        assertEq(desk.claimOf(id).recordHash, recordHash);
    }

    function test_finalize_revertsUnlessADeliveryClaimStands() public {
        uint256 id = _registered(_claimedParams());
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.finalize(id);
        vm.prank(runner);
        desk.claimDelivered(id, recordHash);
        vm.prank(challenger);
        desk.challenge(id);
        vm.warp(START + 10 days);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.finalize(id);
    }

    function test_finalize_twiceReverts() public {
        uint256 id = _asserted(record);
        vm.warp(START + 24 hours);
        desk.finalize(id);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.finalize(id);
    }

    /// Unchallenged claims are not subject to the delivery timeout: once the window has passed
    /// they can only be paid, however late somebody gets round to it.
    function test_finalize_isLazyAndTimeoutCannotPreemptIt() public {
        uint256 id = _asserted(record);
        vm.warp(START + DELIVERY + 50 days);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.timeout(id);
        vm.expectRevert(IWorkOrdersRunner.TooLate.selector);
        vm.prank(challenger);
        desk.challenge(id);
        desk.finalize(id);
        _assertState(id, IWorkOrders.State.Delivered);
    }

    function test_finalize_callsTheEmployerWithTheNamedHash() public {
        MockEmployer boss = new MockEmployer(address(desk), address(imd));
        imd.mint(address(boss), FUNDS);
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 3;
        uint256 id = boss.open(p, SPEC);
        _claim(id, runner);
        _register(id, runner, JOB);
        vm.prank(runner);
        desk.claimDelivered(id, recordHash);
        vm.warp(START + 24 hours);
        desk.finalize(id);
        assertEq(boss.calls(), 1);
        assertEq(boss.lastOrderId(), id);
        assertEq(boss.lastJobId(), JOB);
        assertEq(boss.lastRecordHash(), recordHash);
    }

    /// A receipt that lands during the window settles the order as proven at once.
    function test_settle_beatsTheWindow() public {
        uint256 id = _asserted(record);
        _landGood(id, JOB);
        desk.settle(id, record, _noChunks());
        assertTrue(desk.orderOf(id).proven);
        assertEq(desk.orderOfJob(JOB), id);
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    /// Unchallenged, the receipt decides and the hash the runner named is beside the point.
    function test_settle_duringTheWindowDoesNotNeedTheNamedHash() public {
        uint256 id = _registered(_claimedParams());
        vm.prank(runner);
        desk.claimDelivered(id, keccak256("a hash the runner got wrong"));
        _landGood(id, JOB);
        desk.settle(id, record, _noChunks());
        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(desk.claimOf(id).recordHash, recordHash);
    }

    /// A receipt that contradicts an unchallenged claim ends it; with no challenger the bond goes
    /// to the employer.
    function test_reportFailed_refutesAnUnchallengedClaim() public {
        uint256 id = _asserted(record);
        landed = _land(id, JOB, KIND, "failed");
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Failed(id, JOB, keccak256(landed));
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(id, runner, IWorkOrdersRunner.End.Refuted, 0, BOND, 0, IWorkOrders.State.Open);
        vm.prank(stranger);
        desk.reportFailed(id, landed, _noChunks());
        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
        _assertSolvent();
    }

    /// Having claimed delivery, the runner answers for everything the receipt shows, the kind
    /// included: unlike a job that was only registered, the bond is not returned.
    function test_reportFailed_anotherKindRefutesAnUnchallengedClaim() public {
        uint256 id = _asserted(record);
        landed = _land(id, JOB, "single", "completed");
        vm.prank(stranger);
        desk.reportFailed(id, landed, _noChunks());
        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
        assertEq(desk.orderOf(id).returned, BOND);
    }

    function test_reportFailed_onAnUnchallengedClaimRevertsIfTheReceiptSettles() public {
        uint256 id = _asserted(record);
        _landGood(id, JOB);
        vm.expectRevert(IWorkOrdersRunner.NotFailed.selector);
        desk.reportFailed(id, record, _noChunks());
    }

    // --- challenge ----------------------------------------------------------------------------

    function test_challenge_postsAnEqualBond() public {
        uint256 id = _asserted(record);
        vm.warp(START + 24 hours - 1);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Challenged(id, challenger, BOND);
        vm.prank(challenger);
        desk.challenge(id);

        _assertState(id, IWorkOrders.State.Disputed);
        assertEq(desk.claimOf(id).challenger, challenger);
        assertEq(imd.balanceOf(challenger), FUNDS - BOND);
        assertEq(imd.balanceOf(address(desk)), MAX_PAY + 2 * uint256(BOND));
        _assertSolvent();
    }

    function test_challenge_revertsOnceTheWindowHasPassed() public {
        uint256 id = _asserted(record);
        vm.warp(START + 24 hours);
        vm.prank(challenger);
        vm.expectRevert(IWorkOrdersRunner.TooLate.selector);
        desk.challenge(id);
    }

    function test_challenge_onlyOne() public {
        uint256 id = _disputed(record);
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.challenge(id);
    }

    function test_challenge_revertsWithoutAClaimToChallenge() public {
        uint256 id = _registered(_claimedParams());
        vm.prank(challenger);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.challenge(id);
    }

    function test_challenge_revertsWithoutTheBond() public {
        uint256 id = _asserted(record);
        address poor = makeAddr("poor");
        vm.prank(poor);
        imd.approve(address(desk), type(uint256).max);
        vm.prank(poor);
        vm.expectRevert();
        desk.challenge(id);
        _assertState(id, IWorkOrders.State.Asserted);
    }

    // --- a dispute decided by the receipt -----------------------------------------------------

    /// The named record is proven: the runner is paid and takes the challenger's bond.
    function test_dispute_theNamedReceiptPaysTheRunnerBothBonds() public {
        uint256 id = _disputed(record);
        _landGood(id, JOB);
        (uint256 runnerPay, uint256 fee, uint256 tip) = _split(MIN_PAY);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Delivered(
            id, JOB, runner, recordHash, true, runnerPay, fee, tip, MAX_PAY - MIN_PAY, 2 * uint256(BOND), _agents()
        );
        desk.settle(id, record, _noChunks());

        _assertState(id, IWorkOrders.State.Delivered);
        assertTrue(desk.orderOf(id).proven);
        assertEq(imd.balanceOf(runner), FUNDS + runnerPay + BOND);
        assertEq(imd.balanceOf(challenger), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MIN_PAY);
        assertEq(imd.balanceOf(address(desk)), 0);
        assertEq(desk.orderOfJob(JOB), id);
    }

    /// A receipt for the job exists, completed and for this order, but its hash is not the one the
    /// runner named. The receipt wins: the hash named in a claim plays no part in what a receipt
    /// decides, because records can be superseded.
    function test_dispute_anyValidReceiptPaysTheRunnerWhateverHashItNamed() public {
        uint256 id = _registered(_claimedParams());
        vm.prank(runner);
        desk.claimDelivered(id, keccak256("not the real record"));
        vm.prank(challenger);
        desk.challenge(id);
        _landGood(id, JOB);

        vm.expectRevert(IWorkOrdersRunner.NotFailed.selector);
        desk.reportFailed(id, record, _noChunks());

        (uint256 runnerPay,,) = _split(MIN_PAY);
        desk.settle(id, record, _noChunks());
        _assertState(id, IWorkOrders.State.Delivered);
        assertTrue(desk.orderOf(id).proven);
        assertEq(desk.claimOf(id).recordHash, recordHash, "the order keeps the receipt's hash, not the named one");
        assertEq(imd.balanceOf(runner), FUNDS + runnerPay + BOND);
        assertEq(imd.balanceOf(challenger), FUNDS - BOND);
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    /// The runner names the job's first record (the only one that exists when it claims) and is
    /// challenged. The registry then holds the job's second receipt. That receipt shows completed
    /// work of the order's kind for this very claim, so it pays the runner, as it does outside a
    /// dispute.
    function test_dispute_aSecondReceiptOfTheSameJobStillPaysTheRunner() public {
        uint256 id = _disputed(record);
        bytes memory second = _supersede(id, JOB);

        // The first record can no longer be proven: the registry answers with the second.
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, keccak256(second), recordHash));
        desk.settle(id, record, _noChunks());

        desk.settle(id, second, _noChunks());
        _assertState(id, IWorkOrders.State.Delivered);
        (uint256 runnerPay, uint256 fee, uint256 tip) = _split(MIN_PAY);
        assertEq(imd.balanceOf(runner), FUNDS + runnerPay + BOND, "runner: pay and the challenger's bond");
        assertEq(imd.balanceOf(challenger), FUNDS - BOND);
        assertEq(imd.balanceOf(address(payroll)), fee + tip);
        assertEq(desk.claimOf(id).recordHash, keccak256(second));
        assertEq(desk.orderOfJob(JOB), id);
        // The second receipt names no agents: the tip went to Payroll with an empty list.
        assertEq(payroll.lastAgentIds().length, 0);
        _assertSolvent();
    }

    /// The same receipt cannot be used as a "failure" to take the runner's bond.
    function test_dispute_aSecondReceiptOfTheSameJobIsNotAFailure() public {
        uint256 id = _disputed(record);
        bytes memory second = _supersede(id, JOB);
        vm.prank(challenger);
        vm.expectRevert(IWorkOrdersRunner.NotFailed.selector);
        desk.reportFailed(id, second, _noChunks());
        _assertState(id, IWorkOrders.State.Disputed);
        assertEq(imd.balanceOf(challenger), FUNDS - BOND);
    }

    /// The other order of events: the runner names the second record (the newest one the API
    /// lists); when receipts resume the first is written first and is `latest` for a while.
    function test_dispute_theFirstReceiptIsNotAFailureEither() public {
        bytes memory second = abi.encodePacked(record, " second receipt, written at delivery");
        uint256 id = _registered(_claimedParams());
        vm.prank(runner);
        desk.claimDelivered(id, keccak256(second));
        vm.prank(challenger);
        desk.challenge(id);
        // The registry catches up: the first receipt lands.
        _landGood(id, JOB);

        vm.prank(challenger);
        vm.expectRevert(IWorkOrdersRunner.NotFailed.selector);
        desk.reportFailed(id, record, _noChunks());
        desk.settle(id, record, _noChunks());
        _assertState(id, IWorkOrders.State.Delivered);
    }

    /// Nobody can turn a valid receipt into a forfeit by challenging first and reporting second:
    /// the challenge stands, the report is refused, and the receipt then costs the challenger its bond.
    function test_dispute_aLateChallengeCannotTurnAValidReceiptIntoAForfeit() public {
        uint256 id = _asserted(record);
        bytes memory second = _supersede(id, JOB);

        vm.startPrank(challenger);
        desk.challenge(id);
        vm.expectRevert(IWorkOrdersRunner.NotFailed.selector);
        desk.reportFailed(id, second, _noChunks());
        vm.stopPrank();
        assertEq(imd.balanceOf(challenger), FUNDS - BOND, "the challenger's bond is still at stake");

        desk.settle(id, second, _noChunks());
        (uint256 runnerPay,,) = _split(MIN_PAY);
        assertEq(imd.balanceOf(runner), FUNDS + runnerPay + BOND);
        assertEq(imd.balanceOf(challenger), FUNDS - BOND);
    }

    /// A receipt that does not settle the order refutes a challenged claim: the employer gets the
    /// release share of the runner's bond, the challenger the rest together with its own.
    function test_dispute_aFailedJobContradictsTheClaim() public {
        uint256 id = _disputed(record);
        landed = _land(id, JOB, KIND, "failed");
        uint256 cut = _cut(BOND);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Failed(id, JOB, keccak256(landed));
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.Refuted, 0, cut, 2 * uint256(BOND) - cut, IWorkOrders.State.Open
        );
        vm.prank(stranger);
        desk.reportFailed(id, landed, _noChunks());
        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(challenger), FUNDS + BOND - cut);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + cut);
        assertEq(imd.balanceOf(stranger), FUNDS);
        assertEq(desk.orderOf(id).returned, cut);
        _assertSolvent();
    }

    function test_dispute_aJobForAnotherObjectiveContradictsTheClaim() public {
        uint256 id = _disputed(record);
        landed =
            _landOtherObjective(JOB, bytes.concat(_refHeader(block.chainid, address(desk), id + 7, 1, runner), SPEC));
        desk.reportFailed(id, landed, _noChunks());
        assertEq(imd.balanceOf(challenger), FUNDS + BOND - _cut(BOND));
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + _cut(BOND));
        _assertState(id, IWorkOrders.State.Open);
    }

    function test_dispute_aJobOfAnotherKindContradictsTheClaim() public {
        uint256 id = _disputed(record);
        landed = _land(id, JOB, "single", "completed");
        vm.expectRevert(IWorkOrdersRunner.WrongKind.selector);
        desk.settle(id, landed, _noChunks());
        desk.reportFailed(id, landed, _noChunks());
        assertEq(imd.balanceOf(challenger), FUNDS + BOND - _cut(BOND));
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        _assertState(id, IWorkOrders.State.Open);
    }

    /// A job whose objective is too short to hold a header at all. WorkProof refuses to split it
    /// after 85 bytes; the desk reads it again unsplit, and it refutes the claim like any other
    /// receipt for another objective.
    function test_dispute_aJobWithAShortObjectiveContradictsTheClaim() public {
        uint256 id = _disputed(record);
        landed = _landOtherObjective(JOB, "hello world");
        vm.expectRevert(IWorkProof.HeadTooLong.selector);
        desk.settle(id, landed, _noChunks());
        vm.prank(challenger);
        desk.reportFailed(id, landed, _noChunks());
        assertEq(imd.balanceOf(challenger), FUNDS + BOND - _cut(BOND));
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + _cut(BOND));
        _assertState(id, IWorkOrders.State.Open);
        _assertSolvent();
    }

    function test_dispute_aValidReceiptCannotBeReportedAsAFailure() public {
        uint256 id = _disputed(record);
        _landGood(id, JOB);
        vm.expectRevert(IWorkOrdersRunner.NotFailed.selector);
        desk.reportFailed(id, record, _noChunks());
    }

    function test_dispute_lostAfterExpiryRefundsTheOrder() public {
        IWorkOrders.OrderParams memory p = _claimedParams();
        p.expiresAt = uint40(START + 1 hours);
        uint256 id = _registered(p);
        vm.prank(runner);
        desk.claimDelivered(id, recordHash);
        vm.prank(challenger);
        desk.challenge(id);
        vm.warp(START + 2 hours);
        landed = _land(id, JOB, KIND, "failed");
        desk.reportFailed(id, landed, _noChunks());
        _assertState(id, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(employer), FUNDS + _cut(BOND));
        assertEq(imd.balanceOf(challenger), FUNDS + BOND - _cut(BOND));
        assertEq(desk.orderOf(id).returned, MAX_PAY + _cut(BOND));
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    // --- a dispute decided by the arbiter -----------------------------------------------------

    function test_resolve_forTheRunner() public {
        uint256 id = _disputed(record);
        (uint256 runnerPay, uint256 fee, uint256 tip) = _split(MIN_PAY);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Resolved(id, arbiter, true);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Delivered(
            id,
            JOB,
            runner,
            recordHash,
            false,
            runnerPay,
            fee,
            tip,
            MAX_PAY - MIN_PAY,
            2 * uint256(BOND),
            new uint256[](0)
        );
        vm.prank(arbiter);
        desk.resolve(id, true);

        _assertState(id, IWorkOrders.State.Delivered);
        assertFalse(desk.orderOf(id).proven);
        assertEq(imd.balanceOf(runner), FUNDS + runnerPay + BOND);
        assertEq(imd.balanceOf(challenger), FUNDS - BOND);
        assertEq(imd.balanceOf(address(payroll)), fee + tip);
        assertEq(imd.balanceOf(arbiter), FUNDS, "the arbiter is paid nothing by the desk");
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    function test_resolve_forTheChallenger() public {
        uint256 id = _disputed(record);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Resolved(id, arbiter, false);
        uint256 cut = _cut(BOND);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.Refuted, 0, cut, 2 * uint256(BOND) - cut, IWorkOrders.State.Open
        );
        vm.prank(arbiter);
        desk.resolve(id, false);

        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(challenger), FUNDS + BOND - cut);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + cut);
        assertEq(imd.balanceOf(arbiter), FUNDS);
        assertEq(desk.orderOf(id).returned, cut);
        _assertSolvent();
        // The order is open to a new runner.
        _claim(id, runner2);
    }

    function test_resolve_onlyTheArbiter() public {
        uint256 id = _disputed(record);
        address[4] memory others = [employer, runner, challenger, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(IWorkOrdersRunner.NotArbiter.selector);
            desk.resolve(id, true);
        }
    }

    /// An order with no arbiter can only be decided by a receipt or the deadline.
    function test_resolve_nobodyCanWhenThereIsNoArbiter() public {
        IWorkOrders.OrderParams memory p = _claimedParams();
        p.arbiter = address(0);
        uint256 id = _registered(p);
        vm.prank(runner);
        desk.claimDelivered(id, recordHash);
        vm.prank(challenger);
        desk.challenge(id);
        address[4] memory anyone = [employer, runner, challenger, arbiter];
        for (uint256 i; i < anyone.length; ++i) {
            vm.prank(anyone[i]);
            vm.expectRevert(IWorkOrdersRunner.NotArbiter.selector);
            desk.resolve(id, false);
        }
    }

    function test_resolve_onlyWhileDisputed() public {
        uint256 id = _asserted(record);
        vm.prank(arbiter);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.resolve(id, true);
        vm.prank(challenger);
        desk.challenge(id);
        vm.prank(arbiter);
        desk.resolve(id, true);
        vm.prank(arbiter);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.resolve(id, false);
    }

    function test_resolve_againstTheRunnerAfterExpiryRefunds() public {
        IWorkOrders.OrderParams memory p = _claimedParams();
        p.expiresAt = uint40(START + 1 hours);
        uint256 id = _registered(p);
        vm.prank(runner);
        desk.claimDelivered(id, recordHash);
        vm.prank(challenger);
        desk.challenge(id);
        vm.warp(START + 2 hours);
        vm.prank(arbiter);
        desk.resolve(id, false);
        _assertState(id, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(employer), FUNDS + _cut(BOND));
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    /// A contract employer hears about an arbitrated delivery like any other, with the hash the
    /// runner named; it hears nothing when the arbiter decides against the runner.
    function test_resolve_forTheRunnerCallsTheEmployer() public {
        MockEmployer boss = new MockEmployer(address(desk), address(imd));
        imd.mint(address(boss), FUNDS);
        IWorkOrders.OrderParams memory p = _claimedParams();
        p.flags = 3;
        uint256 id = boss.open(p, SPEC);
        _claim(id, runner);
        _register(id, runner, JOB);
        vm.prank(runner);
        desk.claimDelivered(id, recordHash);
        vm.prank(challenger);
        desk.challenge(id);

        uint256 snap = vm.snapshotState();
        vm.prank(arbiter);
        desk.resolve(id, false);
        assertEq(boss.calls(), 0);
        _assertState(id, IWorkOrders.State.Open);
        vm.revertToState(snap);

        vm.prank(arbiter);
        desk.resolve(id, true);
        assertEq(boss.calls(), 1);
        assertEq(boss.lastOrderId(), id);
        assertEq(boss.lastJobId(), JOB);
        assertEq(boss.lastRecordHash(), recordHash);
        assertTrue(desk.orderOf(id).notified);
    }

    // --- a dispute nobody decided -------------------------------------------------------------

    /// Undecided at the deadline: the employer is refunded, the challenger gets its bond back, and
    /// the runner is treated as if it had released the order.
    function test_timeout_undecidedDisputeRefundsAndCostsTheRunnerTheReleaseShare() public {
        uint256 id = _disputed(record);
        vm.warp(START + DELIVERY - 1);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.timeout(id);

        uint256 cut = _cut(BOND);
        assertEq(cut, uint256(BOND) * desk.RELEASE_BPS() / 10_000, "the same share that release costs");
        vm.warp(START + DELIVERY);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Refunded(id, MAX_PAY);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.DisputeExpired, BOND - cut, cut, BOND, IWorkOrders.State.Refunded
        );
        vm.prank(stranger);
        desk.timeout(id);

        // Refunded for good, although the order's own expiry is weeks away.
        _assertState(id, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(employer), FUNDS + cut);
        assertEq(imd.balanceOf(runner), FUNDS - cut);
        assertEq(imd.balanceOf(challenger), FUNDS);
        assertEq(imd.balanceOf(stranger), FUNDS);
        assertEq(imd.balanceOf(address(desk)), 0);
        IWorkOrdersRunner.Order memory o = desk.orderOf(id);
        assertEq(o.returned, MAX_PAY + cut);
        assertEq(o.spent, 0);
    }

    /// A delivery claim for a job that does not exist can never be decided by a receipt. Challenged,
    /// it is not free: at the deadline the claimer has lost the release share of its bond.
    function test_timeout_aChallengedFalseClaimCostsTheClaimer() public {
        uint256 id = _falseClaim();
        vm.prank(challenger);
        desk.challenge(id);

        // No receipt exists, so neither path that reads one can be used.
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, NO_SUCH_JOB));
        desk.settle(id, "", _noChunks());
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, NO_SUCH_JOB));
        desk.reportFailed(id, "", _noChunks());

        vm.warp(START + DELIVERY);
        desk.timeout(id);
        assertEq(imd.balanceOf(runner), FUNDS - _cut(BOND), "a challenged false claim cost the claimer nothing");
        assertEq(imd.balanceOf(employer), FUNDS + _cut(BOND));
        assertEq(imd.balanceOf(challenger), FUNDS, "the challenger gets its bond back");
        _assertState(id, IWorkOrders.State.Refunded);
    }

    // --- one party in two roles ---------------------------------------------------------------

    /// A runner may challenge its own claim from a second address. However the dispute then ends
    /// without a delivery, the pair is poorer by at least what `release` would have cost, and the
    /// employer is richer by it.
    function test_selfChallenge_isNeverCheaperThanReleasing() public {
        uint256 cut = _cut(BOND);

        // What releasing costs, for comparison.
        uint256 snap = vm.snapshotState();
        uint256 id = _open(_claimedParams());
        _claim(id, runner);
        vm.prank(runner);
        desk.release(id);
        assertEq(imd.balanceOf(runner), FUNDS - cut);
        vm.revertToState(snap);

        // 1. Nothing decides the dispute: `runner2` is the claimer's own second address.
        snap = vm.snapshotState();
        id = _falseClaim();
        vm.prank(runner2);
        desk.challenge(id);
        vm.warp(START + DELIVERY);
        desk.timeout(id);
        assertEq(imd.balanceOf(runner) + imd.balanceOf(runner2), 2 * FUNDS - cut, "undecided: the pair lost nothing");
        assertEq(imd.balanceOf(employer), FUNDS + cut, "undecided: the employer was paid nothing for the hold");
        vm.revertToState(snap);

        // 2. A receipt refutes the claim: the registered job is for another objective.
        snap = vm.snapshotState();
        id = _registered(_claimedParams());
        bytes memory other = _landOtherObjective(JOB, bytes.concat(_refHeader(1, address(1), 1, 1, address(1)), SPEC));
        vm.prank(runner);
        desk.claimDelivered(id, keccak256(other));
        vm.prank(runner2);
        desk.challenge(id);
        vm.prank(stranger);
        desk.reportFailed(id, other, _noChunks());
        assertEq(imd.balanceOf(runner) + imd.balanceOf(runner2), 2 * FUNDS - cut, "refuted: the pair lost nothing");
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + cut, "refuted: the employer was paid nothing");
        _assertSolvent();
        vm.revertToState(snap);

        // 3. The arbiter decides against the runner.
        id = _disputedBy(runner2);
        vm.prank(arbiter);
        desk.resolve(id, false);
        assertEq(imd.balanceOf(runner) + imd.balanceOf(runner2), 2 * FUNDS - cut, "arbitrated: the pair lost nothing");
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + cut, "arbitrated: the employer was paid nothing");
        _assertSolvent();
    }

    function _disputedBy(address who) internal returns (uint256 id) {
        id = _asserted(record);
        vm.prank(who);
        desk.challenge(id);
    }

    /// The employer may challenge a claim on its own order. What it gets back as the challenger is
    /// not part of `returned`: that figure counts only what it is paid as the order's employer.
    function test_employerAsChallenger() public {
        uint256 cut = _cut(BOND);

        // Undecided: escrow back, its own bond back, and the release share of the runner's.
        uint256 snap = vm.snapshotState();
        uint256 id = _disputedBy(employer);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY - BOND);
        vm.warp(START + DELIVERY);
        desk.timeout(id);
        assertEq(imd.balanceOf(employer), FUNDS + cut);
        assertEq(imd.balanceOf(runner), FUNDS - cut);
        assertEq(desk.orderOf(id).returned, MAX_PAY + cut, "the challenge bond is not part of returned");
        assertEq(imd.balanceOf(address(desk)), 0);
        vm.revertToState(snap);

        // Refuted by a receipt: it ends up with the whole of the runner's bond, in two parts.
        snap = vm.snapshotState();
        id = _disputedBy(employer);
        landed = _land(id, JOB, KIND, "failed");
        desk.reportFailed(id, landed, _noChunks());
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(desk.orderOf(id).returned, cut, "only the employer's share is in returned");
        _assertSolvent();
        vm.revertToState(snap);

        // The receipt upholds the claim: it loses its challenge bond to the runner.
        id = _disputedBy(employer);
        _landGood(id, JOB);
        desk.settle(id, record, _noChunks());
        (uint256 runnerPay,,) = _split(MIN_PAY);
        assertEq(imd.balanceOf(runner), FUNDS + runnerPay + BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MIN_PAY - BOND);
        assertEq(desk.orderOf(id).returned, MAX_PAY - MIN_PAY);
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    /// An employer that names itself arbiter decides its own disputes. The desk allows it; it is
    /// the reason a runner looks at an order's arbiter before using the claimed path.
    function test_employerAsArbiter() public {
        IWorkOrders.OrderParams memory p = _claimedParams();
        p.arbiter = employer;
        uint256 id = _registered(p);
        vm.prank(runner);
        desk.claimDelivered(id, recordHash);
        vm.prank(challenger);
        desk.challenge(id);

        uint256 snap = vm.snapshotState();
        vm.prank(employer);
        desk.resolve(id, false);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + _cut(BOND));
        assertEq(imd.balanceOf(challenger), FUNDS + BOND - _cut(BOND));
        _assertSolvent();
        vm.revertToState(snap);

        vm.prank(employer);
        desk.resolve(id, true);
        (uint256 runnerPay,,) = _split(MIN_PAY);
        assertEq(imd.balanceOf(runner), FUNDS + runnerPay + BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MIN_PAY);
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    /// An employer that runs its own order on the claimed path: what it is paid as the runner is
    /// not part of `returned` either.
    function test_employerAsRunnerOnTheClaimedPath() public {
        uint256 id = _open(_claimedParams());
        _claim(id, employer);
        _register(id, employer, JOB);
        vm.prank(employer);
        desk.claimDelivered(id, recordHash);
        vm.warp(START + 24 hours);
        desk.finalize(id);
        (uint256 runnerPay, uint256 fee, uint256 tip) = _split(MIN_PAY);
        assertEq(imd.balanceOf(employer), FUNDS - fee - tip, "it paid itself and kept all but the fee and the tip");
        assertEq(runnerPay + fee + tip, MIN_PAY);
        assertEq(desk.orderOf(id).returned, MAX_PAY - MIN_PAY);
        assertEq(desk.orderOf(id).spent, MIN_PAY);
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    /// Lazy here too: after the deadline, until somebody calls `timeout`, the receipt or the
    /// arbiter can still decide.
    function test_dispute_canStillBeDecidedAfterTheDeadlineUntilTimeoutIsCalled() public {
        uint256 id = _disputed(record);
        vm.warp(START + DELIVERY + 3 days);
        uint256 snap = vm.snapshotState();
        _landGood(id, JOB);
        desk.settle(id, record, _noChunks());
        _assertState(id, IWorkOrders.State.Delivered);
        vm.revertToState(snap);
        vm.prank(arbiter);
        desk.resolve(id, true);
        _assertState(id, IWorkOrders.State.Delivered);
    }

    // --- stamp --------------------------------------------------------------------------------

    function test_stamp_marksAnUnprovenDeliveryProven() public {
        uint256 id = _asserted(record);
        vm.warp(START + 24 hours);
        desk.finalize(id);
        assertFalse(desk.orderOf(id).proven);

        _landGood(id, JOB);
        uint256[4] memory before =
            [imd.balanceOf(runner), imd.balanceOf(employer), imd.balanceOf(address(payroll)), imd.balanceOf(stranger)];
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Proven(id, JOB, recordHash);
        vm.prank(stranger);
        desk.stamp(id, record, _noChunks());

        assertTrue(desk.orderOf(id).proven);
        assertEq(desk.orderOfJob(JOB), id);
        _assertState(id, IWorkOrders.State.Delivered);
        // No money moved.
        assertEq(imd.balanceOf(runner), before[0]);
        assertEq(imd.balanceOf(employer), before[1]);
        assertEq(imd.balanceOf(address(payroll)), before[2]);
        assertEq(imd.balanceOf(stranger), before[3]);

        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.stamp(id, record, _noChunks());
    }

    function test_stamp_afterAnArbiterDecision() public {
        uint256 id = _disputed(record);
        vm.prank(arbiter);
        desk.resolve(id, true);
        _landGood(id, JOB);
        desk.stamp(id, record, _noChunks());
        assertTrue(desk.orderOf(id).proven);
    }

    /// If the runner named another hash than the receipt's, the stamp records the receipt's.
    function test_stamp_recordsTheReceiptHash() public {
        uint256 id = _registered(_claimedParams());
        vm.prank(runner);
        desk.claimDelivered(id, keccak256("off by one"));
        vm.warp(START + 24 hours);
        desk.finalize(id);
        _landGood(id, JOB);
        desk.stamp(id, record, _noChunks());
        assertEq(desk.claimOf(id).recordHash, recordHash);
    }

    /// As in `settle`, any receipt of the job that passes the checks will do: here the job's
    /// second receipt, after the runner named the first.
    function test_stamp_acceptsALaterReceiptOfTheSameJob() public {
        uint256 id = _asserted(record);
        vm.warp(START + 24 hours);
        desk.finalize(id);
        bytes memory second = _supersede(id, JOB);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Proven(id, JOB, keccak256(second));
        desk.stamp(id, second, _noChunks());
        assertTrue(desk.orderOf(id).proven);
        assertEq(desk.claimOf(id).recordHash, keccak256(second));
        assertEq(desk.orderOfJob(JOB), id);
    }

    function test_stamp_revertsUnlessDeliveredAndUnproven() public {
        uint256 id = _asserted(record);
        _landGood(id, JOB);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.stamp(id, record, _noChunks());
        // Settled by proof: already proven.
        desk.settle(id, record, _noChunks());
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.stamp(id, record, _noChunks());
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.stamp(31337, record, _noChunks());
    }

    function test_stamp_appliesEveryCheckOfSettle() public {
        uint256 id = _asserted(record);
        vm.warp(START + 24 hours);
        desk.finalize(id);

        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, JOB));
        desk.stamp(id, record, _noChunks());

        landed = _land(id, JOB, KIND, "failed");
        vm.expectRevert(IWorkOrdersRunner.NotCompleted.selector);
        desk.stamp(id, landed, _noChunks());

        landed = _land(id, JOB, "single", "completed");
        vm.expectRevert(IWorkOrdersRunner.WrongKind.selector);
        desk.stamp(id, landed, _noChunks());

        landed = _landOtherObjective(JOB, bytes.concat(_refHeader(block.chainid, address(desk), id, 1, runner2), SPEC));
        vm.expectRevert(IWorkOrdersRunner.WrongHeader.selector);
        desk.stamp(id, landed, _noChunks());

        landed = _landOtherObjective(
            JOB, bytes.concat(_refHeader(block.chainid, address(desk), id, 1, runner), "Other text")
        );
        vm.expectRevert(IWorkOrdersRunner.WrongSpec.selector);
        desk.stamp(id, landed, _noChunks());

        assertFalse(desk.orderOf(id).proven);
        assertEq(desk.orderOfJob(JOB), 0);
    }

    function test_stamp_revertsWhenTheJobProvedAnotherOrder() public {
        // Order A is paid on a claim that names JOB.
        uint256 a = _asserted(record);
        vm.warp(START + 24 hours);
        desk.finalize(a);
        // Order B is settled by JOB's receipt.
        uint256 b = _open();
        _claim(b, runner2);
        _register(b, runner2, JOB);
        desk.settle(b, _landGood(b, JOB), _noChunks());
        // Even if WorkProof were to vouch for A now, the job is taken.
        _landGood(a, JOB);
        vm.expectRevert(IWorkOrdersRunner.JobUsed.selector);
        desk.stamp(a, record, _noChunks());
        assertFalse(desk.orderOf(a).proven);
    }

    // --- what the claimed path does and does not promise --------------------------------------

    /// A job id on the claimed path is only what the runner says. So somebody who copies an honest
    /// runner's job id onto a throwaway order and has it finalized first has taken nothing from the
    /// honest runner: its own claim finalizes, and its receipt still proves its order alone.
    function test_copiedJobIdOnTheClaimedPathBlocksNobody() public {
        uint256 honest = _asserted(record);
        // The copier's own order, own runner, same job id, claimed a moment earlier.
        vm.startPrank(stranger);
        uint256 copy = desk.createOrder(_claimedParams(), SPEC);
        vm.stopPrank();
        _claim(copy, runner2);
        _register(copy, runner2, JOB);
        vm.prank(runner2);
        desk.claimDelivered(copy, recordHash);

        vm.warp(START + 24 hours);
        desk.finalize(copy);
        desk.finalize(honest);
        _assertState(honest, IWorkOrders.State.Delivered);

        // When the receipt lands it carries the honest order's header: it stamps that one only.
        _landGood(honest, JOB);
        vm.expectRevert(IWorkOrdersRunner.WrongHeader.selector);
        desk.stamp(copy, record, _noChunks());
        desk.stamp(honest, record, _noChunks());
        assertEq(desk.orderOfJob(JOB), honest);
        assertFalse(desk.orderOf(copy).proven);
        _assertSolvent();
    }

    /// The same, when the honest runner is on the proven path: the copier's finalized claim does
    /// not use the job up.
    function test_copiedJobIdCannotBlockAProvenSettlement() public {
        uint256 honest = _registered();
        vm.prank(stranger);
        uint256 copy = desk.createOrder(_claimedParams(), SPEC);
        _claim(copy, runner2);
        _register(copy, runner2, JOB);
        vm.prank(runner2);
        desk.claimDelivered(copy, recordHash);
        vm.warp(START + 24 hours);
        desk.finalize(copy);

        desk.settle(honest, _landGood(honest, JOB), _noChunks());
        _assertState(honest, IWorkOrders.State.Delivered);
        assertTrue(desk.orderOf(honest).proven);
        assertEq(desk.orderOfJob(JOB), honest);
    }

    // --- what a challenger risks ----------------------------------------------------------------

    /// A challenger's bond stays in the desk until a receipt, the arbiter or the delivery deadline
    /// ends the dispute. An employer that runs its own order with the longest delivery time (90
    /// days), registers a job that does not exist and claims delivery can therefore hold a
    /// watcher's bond for the whole of that time, and loses nothing by it: no receipt can ever be
    /// reported for such a job, and at the deadline the release share of its bond goes to itself
    /// as the employer. The challenger gets its own bond back and nothing more.
    function test_challenge_theBondIsHeldToTheDeliveryDeadline_andAnEmployerThatRunsItsOwnOrderLosesNothing() public {
        uint256 longest = desk.MAX_DELIVERY();
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 1;
        p.deliverySecs = uint32(longest);
        uint256 id = _open(p);
        _claim(id, employer);
        _register(id, employer, NO_SUCH_JOB);
        vm.prank(employer);
        desk.claimDelivered(id, keccak256("there is no such record"));

        vm.prank(challenger);
        desk.challenge(id);
        assertEq(imd.balanceOf(challenger), FUNDS - BOND);

        // Nothing can end it early: the job has no receipt to report, and the order has no arbiter.
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, NO_SUCH_JOB));
        desk.reportFailed(id, record, _noChunks());
        vm.prank(challenger);
        vm.expectRevert(IWorkOrdersRunner.NotArbiter.selector);
        desk.resolve(id, false);
        vm.warp(START + longest - 1);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.timeout(id);
        assertEq(imd.balanceOf(challenger), FUNDS - BOND, "one second short of ninety days, the bond is still held");

        vm.warp(START + longest);
        vm.prank(stranger);
        desk.timeout(id);
        assertEq(imd.balanceOf(challenger), FUNDS, "the challenger: its bond back and nothing for its trouble");
        assertEq(imd.balanceOf(employer), FUNDS, "the employer that was its own runner lost nothing");
        assertEq(imd.balanceOf(address(desk)), 0);
        _assertState(id, IWorkOrders.State.Refunded);
    }

    /// An order's arbiter decides a dispute with no evidence on chain. When the employer, the
    /// runner and the arbiter are one party, a challenge of its untrue claim is decided for the
    /// runner and the challenger's bond is taken. A watcher that does not know an order's arbiter
    /// should leave that order alone.
    function test_challenge_anArbiterOfTheEmployersOwnTakesTheChallengersBond() public {
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 1;
        p.arbiter = employer;
        uint256 id = _open(p);
        _claim(id, employer);
        _register(id, employer, NO_SUCH_JOB);
        vm.prank(employer);
        desk.claimDelivered(id, keccak256("there is no such record"));
        vm.prank(challenger);
        desk.challenge(id);

        vm.prank(employer);
        desk.resolve(id, true);
        (, uint256 fee, uint256 tip) = _split(MIN_PAY);
        assertEq(imd.balanceOf(challenger), FUNDS - BOND, "the challenger lost its bond");
        assertEq(imd.balanceOf(employer), FUNDS + BOND - fee - tip, "the one party took it, less the fee and the tip");
        assertEq(imd.balanceOf(address(desk)), 0);
        _assertState(id, IWorkOrders.State.Delivered);
    }

    /// Once the challenge window has passed anyone may finalize, also when the job's receipt has
    /// landed by then. The delivery is then paid as unproven and the tip goes to Payroll with no
    /// agents, although `settle` with the same receipt names them. Whoever wants the agents tipped
    /// settles instead; a later `stamp` marks the order proven and moves no tip.
    function test_finalize_whenAReceiptExistsStillSendsTheTipWithNoAgents() public {
        uint256 id = _asserted(record);
        vm.warp(START + 24 hours);
        _landGood(id, JOB);
        (,, uint256 tip) = _split(MIN_PAY);

        uint256 snap = vm.snapshotState();
        desk.settle(id, record, _noChunks());
        assertEq(payroll.lastAgentIds().length, 1, "settled on the receipt: the record's agent is named");
        assertEq(payroll.tipOwed(REAL_AGENT), tip);
        vm.revertToState(snap);

        vm.prank(stranger);
        desk.finalize(id);
        assertEq(payroll.lastAgentIds().length, 0, "finalized: nobody is named");
        assertEq(payroll.tipOwed(REAL_AGENT), 0);
        assertEq(payroll.tipsToSeats(), tip, "the whole tip is in the seat pool");

        desk.stamp(id, record, _noChunks());
        assertTrue(desk.orderOf(id).proven);
        assertEq(payroll.tipOwed(REAL_AGENT), 0, "a stamp moves no tip");
    }

    /// Nothing is ever paid on a claim unless the employer opted in: without the flag there is no
    /// way into the claimed states at all.
    function test_withoutTheFlagOnlyAReceiptPays() public {
        uint256 id = _registered(_params());
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ClaimedPathOff.selector);
        desk.claimDelivered(id, recordHash);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.finalize(id);
        vm.prank(challenger);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.challenge(id);
        vm.prank(arbiter);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.resolve(id, true);
        vm.warp(START + DELIVERY);
        desk.timeout(id);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
    }
}
