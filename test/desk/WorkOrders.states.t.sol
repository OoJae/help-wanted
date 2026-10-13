// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {DeskBase} from "./DeskBase.sol";
import {MockEmployer} from "./mocks/MockEmployer.sol";

/// The state machine as a table: for each of the nine states and each of the sixteen functions
/// that change an order, either the call is legal there or it reverts `BadState`. Nothing else.
contract WorkOrdersStatesTest is DeskBase {
    /// @dev The last receipt a test landed.
    bytes internal landed;

    uint256 internal constant FUNCTIONS = 16;

    // The functions, in table order.
    uint256 internal constant CANCEL = 0;
    uint256 internal constant REFUND = 1;
    uint256 internal constant TRIGGER = 2;
    uint256 internal constant CLAIM = 3;
    uint256 internal constant RELEASE = 4;
    uint256 internal constant EVICT = 5;
    uint256 internal constant REGISTER = 6;
    uint256 internal constant SETTLE = 7;
    uint256 internal constant REPORT_FAILED = 8;
    uint256 internal constant TIMEOUT = 9;
    uint256 internal constant CLAIM_DELIVERED = 10;
    uint256 internal constant CHALLENGE = 11;
    uint256 internal constant FINALIZE = 12;
    uint256 internal constant RESOLVE = 13;
    uint256 internal constant STAMP = 14;
    uint256 internal constant REDELIVER = 15;

    /// @dev Bit `f` set: function `f` is legal in that state (given the right caller, time and proof).
    function _legal(IWorkOrders.State s) internal pure returns (uint256) {
        if (s == IWorkOrders.State.Open) return _bit(CANCEL) | _bit(REFUND) | _bit(TRIGGER) | _bit(CLAIM);
        if (s == IWorkOrders.State.Claimed) return _bit(RELEASE) | _bit(EVICT) | _bit(REGISTER);
        if (s == IWorkOrders.State.Registered) {
            return _bit(REGISTER) | _bit(SETTLE) | _bit(REPORT_FAILED) | _bit(TIMEOUT) | _bit(CLAIM_DELIVERED);
        }
        if (s == IWorkOrders.State.Asserted) {
            return _bit(SETTLE) | _bit(REPORT_FAILED) | _bit(CHALLENGE) | _bit(FINALIZE);
        }
        if (s == IWorkOrders.State.Disputed) {
            return _bit(SETTLE) | _bit(REPORT_FAILED) | _bit(TIMEOUT) | _bit(RESOLVE);
        }
        if (s == IWorkOrders.State.Delivered) return _bit(STAMP) | _bit(REDELIVER);
        // None, Cancelled, Refunded: nothing.
        return 0;
    }

    function _bit(uint256 f) internal pure returns (uint256) {
        return 1 << f;
    }

    /// @dev Calls function `f` on order `id` as the party that would be allowed to, so that a
    /// revert can only be about the state.
    function _call(uint256 f, uint256 id) internal returns (bool ok, bytes memory ret) {
        bytes memory record = _record(JOB);
        address[] memory none = _noChunks();
        bytes memory data;
        address who = stranger;
        if (f == CANCEL) (who, data) = (employer, abi.encodeCall(desk.cancel, (id)));
        else if (f == REFUND) data = abi.encodeCall(desk.refund, (id));
        else if (f == TRIGGER) data = abi.encodeCall(desk.trigger, (id));
        else if (f == CLAIM) (who, data) = (runner2, abi.encodeCall(desk.claim, (id)));
        else if (f == RELEASE) (who, data) = (runner, abi.encodeCall(desk.release, (id)));
        else if (f == EVICT) data = abi.encodeCall(desk.evict, (id));
        else if (f == REGISTER) (who, data) = (runner, abi.encodeCall(desk.register, (id, JOB2)));
        else if (f == SETTLE) data = abi.encodeCall(desk.settle, (id, record, none));
        else if (f == REPORT_FAILED) (who, data) = (runner, abi.encodeCall(desk.reportFailed, (id, record, none)));
        else if (f == TIMEOUT) data = abi.encodeCall(desk.timeout, (id));
        else if (f == CLAIM_DELIVERED) (who, data) = (runner, abi.encodeCall(desk.claimDelivered, (id, bytes32("h"))));
        else if (f == CHALLENGE) (who, data) = (challenger, abi.encodeCall(desk.challenge, (id)));
        else if (f == FINALIZE) data = abi.encodeCall(desk.finalize, (id));
        else if (f == RESOLVE) (who, data) = (arbiter, abi.encodeCall(desk.resolve, (id, true)));
        else if (f == STAMP) data = abi.encodeCall(desk.stamp, (id, record, none));
        else data = abi.encodeCall(desk.redeliver, (id));
        vm.prank(who);
        (ok, ret) = address(desk).call(data);
    }

    struct Snapshot {
        bytes32 order;
        bytes32 claim;
        uint256 deskBalance;
        uint256 employerBalance;
        uint256 runnerBalance;
    }

    function _snapshot(uint256 id) internal view returns (Snapshot memory s) {
        s.order = keccak256(abi.encode(desk.orderOf(id)));
        s.claim = keccak256(abi.encode(desk.claimOf(id)));
        s.deskBalance = imd.balanceOf(address(desk));
        s.employerBalance = imd.balanceOf(employer);
        s.runnerBalance = imd.balanceOf(runner);
    }

    /// Every illegal (state, function) pair reverts `BadState` and changes nothing.
    function test_everyIllegalTransitionRevertsBadState() public {
        uint256 illegalPairs;
        for (uint8 si; si <= uint8(IWorkOrders.State.Refunded); ++si) {
            IWorkOrders.State s = IWorkOrders.State(si);
            uint256 legal = _legal(s);
            for (uint256 f; f < FUNCTIONS; ++f) {
                if (legal & _bit(f) != 0) continue;
                uint256 snap = vm.snapshotState();
                uint256 id = _orderIn(s);
                _assertState(id, s);
                Snapshot memory before = _snapshot(id);
                (bool ok, bytes memory ret) = _call(f, id);
                assertFalse(ok, string.concat("legal by accident: state ", vm.toString(si), " fn ", vm.toString(f)));
                assertEq(
                    bytes4(ret),
                    IWorkOrdersRunner.BadState.selector,
                    string.concat("wrong error: state ", vm.toString(si), " fn ", vm.toString(f))
                );
                Snapshot memory afterwards = _snapshot(id);
                assertEq(
                    keccak256(abi.encode(before)), keccak256(abi.encode(afterwards)), "a refused call changed something"
                );
                ++illegalPairs;
                vm.revertToState(snap);
            }
        }
        // 9 states x 16 functions, less the 22 legal pairs listed in `_legal`.
        assertEq(illegalPairs, 9 * 16 - 22);
    }

    /// The other half of the table: each legal pair does not revert `BadState`. (Whether it then
    /// succeeds depends on the caller, the time and the proof; the other test files cover those.)
    function test_everyLegalTransitionGetsPastTheStateCheck() public {
        uint256 legalPairs;
        for (uint8 si; si <= uint8(IWorkOrders.State.Refunded); ++si) {
            IWorkOrders.State s = IWorkOrders.State(si);
            uint256 legal = _legal(s);
            for (uint256 f; f < FUNCTIONS; ++f) {
                if (legal & _bit(f) == 0) continue;
                // These three have a second condition that shares `BadState` with the state check:
                // trigger needs an untriggered condition, stamp an unproven delivery, redeliver a
                // failed callback. Each has its own tests.
                if (f == TRIGGER || f == STAMP || f == REDELIVER) {
                    ++legalPairs;
                    continue;
                }
                uint256 snap = vm.snapshotState();
                uint256 id = _orderIn(s);
                (bool ok, bytes memory ret) = _call(f, id);
                if (!ok) {
                    assertTrue(
                        bytes4(ret) != IWorkOrdersRunner.BadState.selector,
                        string.concat("refused by state: state ", vm.toString(si), " fn ", vm.toString(f))
                    );
                }
                ++legalPairs;
                vm.revertToState(snap);
            }
        }
        assertEq(legalPairs, 22);
    }

    /// Each transition the design draws, taken once, with the state it must end in.
    function test_everyLegalTransitionLandsWhereTheDesignSays() public {
        bytes memory record = _record(JOB);

        // Open -> Cancelled / Refunded / Claimed
        uint256 id = _orderIn(IWorkOrders.State.Open);
        vm.prank(employer);
        desk.cancel(id);
        _assertState(id, IWorkOrders.State.Cancelled);

        id = _orderIn(IWorkOrders.State.Open);
        uint256 snap = vm.snapshotState();
        vm.warp(START + LIFE);
        desk.refund(id);
        _assertState(id, IWorkOrders.State.Refunded);
        vm.revertToState(snap);
        _claim(id, runner);
        _assertState(id, IWorkOrders.State.Claimed);

        // Claimed -> Open (release, evict) / Registered
        snap = vm.snapshotState();
        vm.prank(runner);
        desk.release(id);
        _assertState(id, IWorkOrders.State.Open);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        vm.warp(START + 1 hours);
        desk.evict(id);
        _assertState(id, IWorkOrders.State.Open);
        vm.revertToState(snap);
        _register(id, runner, JOB);
        _assertState(id, IWorkOrders.State.Registered);

        // Registered -> Registered (retry) / Delivered / Open (failed, timeout) / Asserted
        _register(id, runner, JOB);
        _assertState(id, IWorkOrders.State.Registered);
        snap = vm.snapshotState();
        desk.settle(id, _landGood(id, JOB), _noChunks());
        _assertState(id, IWorkOrders.State.Delivered);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        landed = _land(id, JOB, KIND, "failed");
        vm.prank(runner);
        desk.reportFailed(id, landed, _noChunks());
        _assertState(id, IWorkOrders.State.Open);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        vm.warp(START + DELIVERY);
        desk.timeout(id);
        _assertState(id, IWorkOrders.State.Open);
        vm.revertToState(snap);
        vm.prank(runner);
        desk.claimDelivered(id, keccak256(record));
        _assertState(id, IWorkOrders.State.Asserted);

        // Asserted -> Delivered (settle, finalize) / Open (refuted) / Disputed
        snap = vm.snapshotState();
        desk.settle(id, _landGood(id, JOB), _noChunks());
        _assertState(id, IWorkOrders.State.Delivered);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        vm.warp(START + 24 hours);
        desk.finalize(id);
        _assertState(id, IWorkOrders.State.Delivered);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        landed = _land(id, JOB, KIND, "failed");
        desk.reportFailed(id, landed, _noChunks());
        _assertState(id, IWorkOrders.State.Open);
        vm.revertToState(snap);
        vm.prank(challenger);
        desk.challenge(id);
        _assertState(id, IWorkOrders.State.Disputed);

        // Disputed -> Delivered (settle, resolve true) / Open (refuted, resolve false) / Refunded (timeout)
        snap = vm.snapshotState();
        desk.settle(id, _landGood(id, JOB), _noChunks());
        _assertState(id, IWorkOrders.State.Delivered);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        vm.prank(arbiter);
        desk.resolve(id, true);
        _assertState(id, IWorkOrders.State.Delivered);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        landed = _land(id, JOB, KIND, "failed");
        desk.reportFailed(id, landed, _noChunks());
        _assertState(id, IWorkOrders.State.Open);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        vm.prank(arbiter);
        desk.resolve(id, false);
        _assertState(id, IWorkOrders.State.Open);
        vm.revertToState(snap);
        vm.warp(START + DELIVERY);
        desk.timeout(id);
        _assertState(id, IWorkOrders.State.Refunded);
    }

    /// Delivered, Cancelled and Refunded are final: after trying every function as every party,
    /// the order's record and the money are exactly as they were.
    function test_terminalStatesNeverChange() public {
        IWorkOrders.State[3] memory terminal =
            [IWorkOrders.State.Delivered, IWorkOrders.State.Cancelled, IWorkOrders.State.Refunded];
        address[6] memory parties = [employer, runner, runner2, challenger, arbiter, stranger];
        for (uint256 t; t < terminal.length; ++t) {
            uint256 id = _orderIn(terminal[t]);
            Snapshot memory before = _snapshot(id);
            vm.warp(START + 400 days);
            bytes memory record = _record(JOB);
            for (uint256 f; f < FUNCTIONS; ++f) {
                // A proven delivery cannot be stamped and an order with no callback cannot be
                // redelivered, so these two revert here as well.
                for (uint256 k; k < parties.length; ++k) {
                    bytes memory data = _dataFor(f, id, record);
                    vm.prank(parties[k]);
                    (bool ok,) = address(desk).call(data);
                    assertFalse(ok, "a terminal order accepted a call");
                }
            }
            Snapshot memory afterwards = _snapshot(id);
            assertEq(keccak256(abi.encode(before)), keccak256(abi.encode(afterwards)), "a terminal order changed");
            _assertState(id, terminal[t]);
        }
    }

    function _dataFor(uint256 f, uint256 id, bytes memory record) internal view returns (bytes memory) {
        address[] memory none = _noChunks();
        if (f == CANCEL) return abi.encodeCall(desk.cancel, (id));
        if (f == REFUND) return abi.encodeCall(desk.refund, (id));
        if (f == TRIGGER) return abi.encodeCall(desk.trigger, (id));
        if (f == CLAIM) return abi.encodeCall(desk.claim, (id));
        if (f == RELEASE) return abi.encodeCall(desk.release, (id));
        if (f == EVICT) return abi.encodeCall(desk.evict, (id));
        if (f == REGISTER) return abi.encodeCall(desk.register, (id, JOB2));
        if (f == SETTLE) return abi.encodeCall(desk.settle, (id, record, none));
        if (f == REPORT_FAILED) return abi.encodeCall(desk.reportFailed, (id, record, none));
        if (f == TIMEOUT) return abi.encodeCall(desk.timeout, (id));
        if (f == CLAIM_DELIVERED) return abi.encodeCall(desk.claimDelivered, (id, bytes32("h")));
        if (f == CHALLENGE) return abi.encodeCall(desk.challenge, (id));
        if (f == FINALIZE) return abi.encodeCall(desk.finalize, (id));
        if (f == RESOLVE) return abi.encodeCall(desk.resolve, (id, true));
        if (f == STAMP) return abi.encodeCall(desk.stamp, (id, record, none));
        return abi.encodeCall(desk.redeliver, (id));
    }

    /// The one thing that may still happen to a delivered order: an unproven one can be stamped,
    /// and a failed callback retried. Neither moves money or changes the state.
    function test_deliveredOrderOnlyGainsItsStampAndItsCallback() public {
        MockEmployer boss = new MockEmployer(address(desk), address(imd));
        imd.mint(address(boss), FUNDS);
        IWorkOrders.OrderParams memory p = _claimedParams();
        p.flags = 3;
        uint256 id = boss.open(p, SPEC);
        _claim(id, runner);
        _register(id, runner, JOB);
        bytes memory record = _record(JOB);
        vm.prank(runner);
        desk.claimDelivered(id, keccak256(record));
        boss.setMode(MockEmployer.Mode.Revert);
        vm.warp(START + 24 hours);
        desk.finalize(id);

        (, address e, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
        uint256 deskBalance = imd.balanceOf(address(desk));
        uint256 runnerBalance = imd.balanceOf(runner);

        desk.stamp(id, _landGood(id, JOB), _noChunks());
        boss.setMode(MockEmployer.Mode.Record);
        desk.redeliver(id);

        _assertState(id, IWorkOrders.State.Delivered);
        (, address e2, uint96 escrow2, uint96 spent2, uint96 returned2) = desk.accountOf(id);
        assertEq(e, e2);
        assertEq(escrow, escrow2);
        assertEq(spent, spent2);
        assertEq(returned, returned2);
        assertEq(imd.balanceOf(address(desk)), deskBalance);
        assertEq(imd.balanceOf(runner), runnerBalance);
        assertTrue(desk.orderOf(id).proven);
        assertTrue(desk.orderOf(id).notified);
    }
}
