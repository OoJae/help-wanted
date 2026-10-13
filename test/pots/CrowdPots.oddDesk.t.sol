// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {MockWorkOrders, OddDesk} from "./mocks/OddDesk.sol";
import {OddDeskBase} from "./PotsBase.sol";

/// @notice CrowdPots against a desk that breaks its own interface. The real desk is immutable code
/// from the same launch and does none of this; these tests show that if the desk's answers and the
/// money ever disagreed, a pot would stop rather than pay out of another pot's chips.
contract CrowdPotsOddDeskTest is OddDeskBase {
    OddDesk internal odd;

    function _newDesk() internal override returns (MockWorkOrders) {
        odd = new OddDesk(address(imd), payroll);
        return odd;
    }

    function _assertStillCollecting(uint256 potId) internal view {
        _assertStage(potId, CrowdPots.Stage.Funding);
        assertEq(pots.potOf(potId).orderId, 0);
        assertEq(imd.balanceOf(address(pots)), pots.owed());
        assertEq(imd.allowance(address(pots), address(desk)), 0);
    }

    function test_launch_aRefusedOrderChangesNothing_andTheChipsStayRefundable() public {
        uint256 potId = _filled(_terms());
        odd.setRejectOrders(true);

        vm.expectRevert(OddDesk.Rejected.selector);
        pots.launch(potId, SPEC);
        _assertStillCollecting(potId);
        assertEq(imd.balanceOf(address(pots)), 10e18);

        vm.warp(_afterLaunchTime(potId));
        assertEq(_claim(potId, alice), 5e18);
        assertEq(_claim(potId, bob), 3e18);
        assertEq(_claim(potId, carol), 2e18);
        assertEq(imd.balanceOf(address(pots)), 0);
    }

    function test_launch_aRefusedOrderCanBeTriedAgain() public {
        uint256 potId = _filled(_terms());
        odd.setRejectOrders(true);
        vm.expectRevert(OddDesk.Rejected.selector);
        pots.launch(potId, SPEC);
        odd.setRejectOrders(false);
        _launch(potId);
        _assertStage(potId, CrowdPots.Stage.Hiring);
    }

    function test_launch_revertsWhenTheDeskPullsLessThanTheTarget() public {
        uint256 potId = _filled(_terms());
        odd.setPullShortBy(1);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.DeskPulledWrongAmount.selector, 1));
        pots.launch(potId, SPEC);
        _assertStillCollecting(potId);
    }

    function test_launch_revertsWhenTheDeskReusesAnOrderId() public {
        (uint256 potA, uint256 orderA) = _launched(_terms());
        uint256 potB = _filled(_terms());
        odd.setReuseLastId(true);

        vm.expectRevert(abi.encodeWithSelector(CrowdPots.OrderIdReused.selector, orderA));
        pots.launch(potB, SPEC);

        assertEq(pots.potOfOrder(orderA), potA, "the order still belongs to the first pot");
        _assertStillCollecting(potB);
    }

    function test_launch_revertsWhenTheDeskNamesAnotherEmployer() public {
        uint256 potId = _filled(_terms());
        odd.setReportEmployer(stranger);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.NotOurOrder.selector, 1));
        pots.launch(potId, SPEC);
        _assertStillCollecting(potId);
    }

    function test_reconcile_revertsWhileTheDeskNamesAnotherEmployer() public {
        (uint256 potId, uint256 orderId) = _launched(_rampTerms());
        _deliver(orderId);
        odd.setReportEmployer(stranger);

        vm.expectRevert(abi.encodeWithSelector(CrowdPots.NotOurOrder.selector, orderId));
        pots.reconcile(potId);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.NotOurOrder.selector, orderId));
        pots.claimRefund(potId, alice);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.NotOurOrder.selector, orderId));
        pots.stageOf(potId);
        _assertStage(potId, CrowdPots.Stage.Hiring);

        odd.setReportEmployer(address(0));
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));
        assertEq(_claim(potId, alice), 3e18);
    }

    function test_reconcile_stopsRatherThanPayFromAnotherPot_whenTheDeskOverReports() public {
        (uint256 potA, uint256 orderA) = _launched(_terms());
        uint256 potB = _open(_terms());
        _chip(carol, potB, 5e18);

        vm.warp(pots.potOf(potA).orderExpiresAt);
        desk.refund(orderA);
        assertEq(imd.balanceOf(address(pots)), 15e18, "B's 5 and A's 10");

        // The desk says it sent 11 for A's order. It sent 10.
        odd.setOverReportBy(1e18);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.DeskShortfall.selector, 16e18, 15e18));
        pots.reconcile(potA);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.DeskShortfall.selector, 16e18, 15e18));
        pots.claimRefund(potA, alice);
        _assertStage(potA, CrowdPots.Stage.Hiring);
        assertEq(pots.owed(), 5e18, "nothing was booked");

        // Pot B is whole.
        assertEq(_claim(potB, carol), 5e18);

        // Once the desk's number and the money agree, A settles.
        odd.setOverReportBy(0);
        assertEq(_claim(potA, alice), 5e18);
        assertEq(_claim(potA, bob), 3e18);
        assertEq(_claim(potA, carol), 2e18);
        assertEq(imd.balanceOf(address(pots)), 0);
    }

    function test_reconcile_survivesADeskThatRefusesTheRefundCall() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.warp(pots.potOf(potId).orderExpiresAt);
        odd.setRefundReverts(true);

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Open);
        // The views forecast the refund; the books wait for the desk to really make it.
        _assertLiveStage(potId, CrowdPots.Stage.Refundable);
        _assertStage(potId, CrowdPots.Stage.Hiring);
        assertEq(pots.owed(), 0);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Hiring));
        pots.claimRefund(potId, alice);

        odd.setRefundReverts(false);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));
    }

    /// The pot asks the desk to end a claim that ran out of time. A desk that refuses, or that has
    /// no such function at all, leaves the pot hiring and nothing booked; the pot never guesses.
    function test_reconcile_survivesADeskThatRefusesToEndAnOverdueClaim() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.warp(pots.potOf(potId).orderExpiresAt - 1);
        _takeAndRegister(orderId, runner);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        odd.setUpkeepReverts(true);

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Registered);
        assertEq(pots.owed(), 0);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Hiring));
        pots.claimRefund(potId, alice);

        odd.setUpkeepReverts(false);
        assertEq(_claim(potId, alice), 5.5e18);
        _assertOrderState(orderId, IWorkOrders.State.Refunded);
    }

    function test_reconcile_survivesADeskThatRefusesToEvict() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        _take(orderId, runner);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        odd.setUpkeepReverts(true);

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Claimed);

        // Anyone can still end the claim on the desk directly once it allows it.
        odd.setUpkeepReverts(false);
        desk.evict(orderId);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Open);
        assertEq(_returned(orderId), 1e18);
    }

    /// The desk over-reports after the pot itself had it end a claim: the pot still stops.
    function test_claimRefund_stopsWhenTheDeskOverReportsAfterATimeoutThePotAskedFor() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.warp(pots.potOf(potId).orderExpiresAt - 1);
        _takeAndRegister(orderId, runner);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        odd.setOverReportBy(1);

        vm.expectRevert(abi.encodeWithSelector(CrowdPots.DeskShortfall.selector, 11e18 + 1, 11e18));
        pots.claimRefund(potId, alice);
        _assertOrderState(orderId, IWorkOrders.State.Registered);
        _assertStage(potId, CrowdPots.Stage.Hiring);

        odd.setOverReportBy(0);
        assertEq(_claim(potId, alice), 5.5e18);
    }

    function test_onWorkDelivered_fromTheDeskForAnOrderNoPotPlaced_reverts() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());

        vm.expectRevert(abi.encodeWithSelector(CrowdPots.UnknownOrder.selector, 999));
        odd.callBack(address(pots), 999, JOB, RECEIPT);

        IWorkOrders.OrderParams memory o = desk.lastOrderParams();
        o.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);
        vm.prank(stranger);
        uint256 foreign = desk.createOrder(o, SPEC);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.UnknownOrder.selector, foreign));
        odd.callBack(address(pots), foreign, JOB, RECEIPT);

        assertEq(pots.potOf(potId).recordHash, bytes32(0));
        assertEq(pots.potOfOrder(orderId), potId);
    }

    function test_theDeskCannotComeBackInWhileAnOrderIsBeingCreated() public {
        address[] memory list = new address[](1);
        list[0] = alice;
        uint256 other = _filled(_terms());

        bytes[] memory attempts = new bytes[](5);
        attempts[0] = abi.encodeCall(pots.launch, (other, SPEC));
        attempts[1] = abi.encodeCall(pots.chipIn, (other, 1e18));
        attempts[2] = abi.encodeCall(pots.claimRefund, (other, alice));
        attempts[3] = abi.encodeCall(pots.claimRefunds, (other, list));
        attempts[4] = abi.encodeCall(pots.reconcile, (other));

        for (uint256 i; i < attempts.length; ++i) {
            uint256 potId = _filled(_terms());
            odd.setReenter(address(pots), attempts[i]);
            _launch(potId);
            assertFalse(odd.reenterOk(), "the inner call must fail");
            assertEq(
                bytes4(odd.reenterResult()),
                ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector,
                "and for this reason"
            );
            _assertStage(potId, CrowdPots.Stage.Hiring);
        }
        _assertStage(other, CrowdPots.Stage.Funding);
        assertEq(pots.potOf(other).raised, 10e18);
    }
}
