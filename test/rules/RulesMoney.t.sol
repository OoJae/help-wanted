// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {Rules} from "../../src/rules/Rules.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {MockDesk} from "./mocks/MockDesk.sol";
import {RulesBase} from "./RulesBase.sol";

/// @dev Money entering and leaving a rule other than by firing: top-ups, cancelling, and everything
/// the desk sends back.
contract RulesMoneyTest is RulesBase {
    bytes16 internal constant JOB = bytes16(0xe9efec1656f340d3924352c453effc7d);

    function _firedHireRule(uint96 deposit) internal returns (uint256 id, uint256 orderId) {
        id = _createHireRule(0, 5, deposit);
        gauge.set(100);
        orderId = _fire(id);
    }

    function _assertBooksMatchBalance() internal view {
        assertEq(imd.balanceOf(address(rules)), rules.totalEscrowed(), "every wei held belongs to a rule");
    }

    // ---- topUp ----

    function test_topUp_anyoneAddsToARulesEscrow() public {
        uint256 id = _createPayRule(0, 3, 1e18);
        uint256 before = imd.balanceOf(stranger);

        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.ToppedUp(id, stranger, 4e18);
        vm.prank(stranger);
        rules.topUp(id, 4e18);

        assertEq(_escrow(id), 5e18);
        assertEq(rules.totalEscrowed(), 5e18);
        assertEq(before - imd.balanceOf(stranger), 4e18);
        _assertBooksMatchBalance();
    }

    function test_topUp_refusesUnknownCancelledAndZero() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Rules.UnknownRule.selector, 1));
        rules.topUp(1, 1e18);

        uint256 id = _createPayRule(0, 3, 1e18);
        vm.prank(stranger);
        vm.expectRevert(Rules.ZeroAmount.selector);
        rules.topUp(id, 0);

        vm.prank(creator);
        rules.cancel(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Rules.RuleIsCancelled.selector, id));
        rules.topUp(id, 1e18);
    }

    function test_topUp_anExhaustedRuleStillTakesMoney_whichItsCreatorCanWithdraw() public {
        uint256 id = _createPayRule(0, 1, PAY_AMOUNT + TIP);
        gauge.set(100);
        _fire(id);
        vm.prank(stranger);
        rules.topUp(id, 3e18);
        uint256 before = imd.balanceOf(creator);
        vm.prank(creator);
        assertEq(rules.cancel(id), 3e18);
        assertEq(imd.balanceOf(creator) - before, 3e18);
    }

    // ---- cancel ----

    function test_cancel_returnsTheUnspentEscrowToTheCreator() public {
        uint256 id = _createPayRule(0, 3, 10e18);
        gauge.set(100);
        _fire(id);
        uint256 left = 10e18 - PAY_AMOUNT - TIP;
        uint256 before = imd.balanceOf(creator);

        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.RuleCancelled(id, left);
        vm.prank(creator);
        uint256 refund = rules.cancel(id);

        assertEq(refund, left);
        assertEq(imd.balanceOf(creator) - before, left);
        assertEq(_escrow(id), 0);
        assertEq(rules.totalEscrowed(), 0);
        assertEq(imd.balanceOf(address(rules)), 0);
        assertTrue(rules.getRule(id).cancelled);
        assertEq(uint8(rules.statusOf(id)), uint8(Rules.Status.Cancelled));
    }

    function test_cancel_onlyTheCreator() public {
        uint256 id = _createPayRule(0, 3, 10e18);
        vm.prank(stranger);
        vm.expectRevert(Rules.NotCreator.selector);
        rules.cancel(id);
        vm.prank(keeper);
        vm.expectRevert(Rules.NotCreator.selector);
        rules.cancel(id);
        // A rule that does not exist has no creator to be.
        vm.prank(creator);
        vm.expectRevert(Rules.NotCreator.selector);
        rules.cancel(77);
    }

    function test_cancel_onlyOnce() public {
        uint256 id = _createPayRule(0, 3, 10e18);
        vm.prank(creator);
        rules.cancel(id);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Rules.RuleIsCancelled.selector, id));
        rules.cancel(id);
    }

    function test_cancel_anEmptyRule() public {
        uint256 id = _createPayRule(0, 3, 0);
        vm.prank(creator);
        assertEq(rules.cancel(id), 0);
        assertEq(uint8(rules.statusOf(id)), uint8(Rules.Status.Cancelled));
    }

    function test_cancel_leavesOtherRulesAlone() public {
        uint256 a = _createPayRule(0, 3, 10e18);
        uint256 b = _createPayRule(0, 3, 25e18);
        vm.prank(creator);
        rules.cancel(a);
        assertEq(_escrow(b), 25e18);
        assertEq(rules.totalEscrowed(), 25e18);
        _assertBooksMatchBalance();
    }

    // ---- reconcile ----

    function test_reconcile_creditsARefundedOrder() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        uint256 afterFire = 30e18 - MAX_PAY - TIP;
        assertEq(_escrow(id), afterFire);

        skip(14 days + 1);
        vm.prank(stranger);
        desk.refund(orderId);
        // The money is back in the contract but not yet in any rule's books.
        assertEq(imd.balanceOf(address(rules)), afterFire + MAX_PAY);
        assertEq(rules.totalEscrowed(), afterFire);

        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.Reconciled(id, orderId, MAX_PAY, false);
        vm.prank(stranger);
        uint256 amount = rules.reconcile(id, orderId);

        assertEq(amount, MAX_PAY);
        assertEq(_escrow(id), afterFire + MAX_PAY);
        (,, uint96 credited) = rules.orderOf(orderId);
        assertEq(credited, MAX_PAY);
        _assertBooksMatchBalance();
    }

    function test_reconcile_creditsTheChangeFromADeliveredOrder() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        desk.deliver(orderId, 6e18, JOB);
        assertEq(rules.reconcile(id, orderId), MAX_PAY - 6e18);
        assertEq(_escrow(id), 30e18 - TIP - 6e18);
        _assertBooksMatchBalance();
    }

    function test_reconcile_nothingComesBackFromAnOrderDeliveredAtFullPrice() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        desk.deliver(orderId, MAX_PAY, JOB);
        vm.recordLogs();
        assertEq(rules.reconcile(id, orderId), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(_escrow(id), 30e18 - MAX_PAY - TIP);
        _assertBooksMatchBalance();
    }

    function test_reconcile_nothingToCreditWhileTheOrderIsOpen() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        assertEq(rules.reconcile(id, orderId), 0);
        assertEq(_escrow(id), 30e18 - MAX_PAY - TIP);
    }

    function test_reconcile_isSafeToRepeat() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        desk.deliver(orderId, 6e18, JOB);
        assertEq(rules.reconcile(id, orderId), 4e18);
        assertEq(rules.reconcile(id, orderId), 0);
        assertEq(rules.reconcile(id, orderId), 0);
        assertEq(_escrow(id), 30e18 - TIP - 6e18);
        _assertBooksMatchBalance();
    }

    /// @dev The desk's `returned` figure is cumulative. A bond awarded while the order is still open
    /// and the escrow returned later are credited as they arrive, each once.
    function test_reconcile_creditsEachNewAmountOnce() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        uint256 afterFire = 30e18 - MAX_PAY - TIP;

        imd.mint(address(this), 1e18);
        imd.approve(address(desk), 1e18);
        desk.awardBond(orderId, 0.5e18);
        assertEq(rules.reconcile(id, orderId), 0.5e18);
        assertEq(_escrow(id), afterFire + 0.5e18);

        desk.awardBond(orderId, 0.25e18);
        vm.prank(creator);
        rules.recall(id, orderId);
        // Recall reconciled both the second bond and the returned escrow in one step.
        assertEq(_escrow(id), afterFire + 0.75e18 + MAX_PAY);
        (, uint96 sent, uint96 credited) = rules.orderOf(orderId);
        assertEq(sent, MAX_PAY);
        assertEq(credited, uint256(MAX_PAY) + 0.75e18, "more can come back than was sent");
        _assertBooksMatchBalance();
    }

    function test_reconcile_refusesAnOrderOfAnotherRule() public {
        (uint256 a, uint256 orderA) = _firedHireRule(30e18);
        uint256 b = _createHireRule(0, 5, 30e18);
        uint256 orderB = _fire(b);
        vm.prank(creator);
        rules.recall(a, orderA);
        uint256 escrowB = _escrow(b);

        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, b, orderA));
        rules.reconcile(b, orderA);
        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, a, orderB));
        rules.reconcile(a, orderB);
        assertEq(_escrow(b), escrowB);
    }

    function test_reconcile_refusesOrdersItDidNotOpen() public {
        (uint256 id,) = _firedHireRule(30e18);
        // An order somebody else opened on the same desk.
        imd.mint(stranger, 10e18);
        vm.startPrank(stranger);
        imd.approve(address(desk), 10e18);
        IWorkOrders.OrderParams memory o;
        o.maxPay = 10e18;
        o.bond = 0.25e18;
        o.deliverySecs = 3 days;
        o.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);
        uint256 foreign = desk.createOrder(o, SPEC);
        desk.cancel(foreign);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, id, foreign));
        rules.reconcile(id, foreign);
        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, id, 999));
        rules.reconcile(id, 999);
        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, 0, foreign));
        rules.reconcile(0, foreign);
        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, 0, 999));
        rules.reconcile(0, 999);
    }

    function test_reconcile_creditsOnlyTheRuleThatPaid() public {
        (uint256 a, uint256 orderA) = _firedHireRule(30e18);
        uint256 b = _createHireRule(0, 5, 45e18);
        uint256 orderB = _fire(b);
        uint256 escrowA = _escrow(a);
        uint256 escrowB = _escrow(b);

        desk.deliver(orderA, 7e18, JOB);
        desk.deliver(orderB, 1e18, JOB);
        rules.reconcile(a, orderA);
        assertEq(_escrow(a), escrowA + 3e18);
        assertEq(_escrow(b), escrowB, "rule b's change is not yet credited to anyone");
        rules.reconcile(b, orderB);
        assertEq(_escrow(b), escrowB + 9e18);
        _assertBooksMatchBalance();
    }

    function test_reconcile_theReturnedMoneyCanBeSpentAgain() public {
        // Funded for exactly one fire.
        uint256 id = _createHireRule(0, 5, MAX_PAY + TIP);
        gauge.set(100);
        uint256 first = _fire(id);
        assertFalse(rules.canFire(id));
        desk.deliver(first, 0, JOB);
        rules.reconcile(id, first);
        assertEq(_escrow(id), MAX_PAY);
        vm.prank(creator);
        rules.topUp(id, TIP);
        assertTrue(rules.canFire(id));
        assertEq(_fire(id), 2);
    }

    /// @dev A desk whose books claim more came back than did, while Rules holds no unassigned IMD.
    /// The claim is refused, and no escrow that is already booked is touched.
    function test_reconcile_refusesADeskThatReportsMoreThanItSent() public {
        (uint256 a, uint256 orderA) = _firedHireRule(30e18);
        uint256 b = _createPayRule(0, 5, 500e18);
        desk.setOverReport(orderA, 100e18);

        vm.expectRevert(abi.encodeWithSelector(Rules.ReturnNotReceived.selector, orderA));
        rules.reconcile(a, orderA);
        assertEq(_escrow(a), 30e18 - MAX_PAY - TIP);
        assertEq(_escrow(b), 500e18);

        // The same after the order really was refunded: the honest part is not paid out either
        // while the figure is wrong, because the figure cannot be split into true and false parts.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Rules.ReturnNotReceived.selector, orderA));
        rules.recall(a, orderA);

        desk.setOverReport(orderA, 0);
        vm.prank(creator);
        rules.recall(a, orderA);
        assertEq(_escrow(a), 30e18 - TIP);
        assertEq(_escrow(b), 500e18);
        _assertBooksMatchBalance();
    }

    /// @dev What the balance check in `reconcile` protects, and what it does not. It keeps the
    /// escrows already booked within what the contract holds. It cannot tell one order's return
    /// from another's: IMD the desk sent back for rule b's order, and that nobody has reconciled
    /// yet, is simply "held and unassigned". So per-rule isolation of money on its way back rests
    /// on the desk never reporting more than it sent, which the real desk guarantees. This test
    /// pins that boundary down with a desk that breaks the guarantee.
    function test_reconcile_theBalanceCheckProtectsBookedEscrows_notUnreconciledReturns() public {
        // Two creators, one HIRE rule each, one open order each.
        vm.prank(creator);
        uint256 a = rules.createRule(_hireParams(_viewCond(1, 100), 0, 5), SPEC, 30e18);
        vm.prank(stranger);
        uint256 b = rules.createRule(_hireParams(_viewCond(1, 100), 0, 5), SPEC, 30e18);
        gauge.set(100);
        uint256 orderA = _fire(a);
        uint256 orderB = _fire(b);
        uint256 escrowA = _escrow(a);
        uint256 escrowB = _escrow(b);

        // Rule b's order expires and is refunded: 10 IMD is back in Rules, not yet in b's books.
        skip(14 days);
        desk.refund(orderB);
        assertEq(imd.balanceOf(address(rules)) - rules.totalEscrowed(), MAX_PAY);

        // The desk's books now claim that order A returned 10 IMD it never sent.
        desk.setOverReport(orderA, MAX_PAY);
        assertEq(rules.reconcile(a, orderA), MAX_PAY, "the balance check lets the false figure through");
        assertEq(_escrow(a), escrowA + MAX_PAY, "rule a was credited with rule b's refund");

        // Rule b's true refund can no longer be credited, and its escrow never got it.
        vm.expectRevert(abi.encodeWithSelector(Rules.ReturnNotReceived.selector, orderB));
        rules.reconcile(b, orderB);
        assertEq(_escrow(b), escrowB, "what rule b had already booked is untouched");

        // Whatever the desk reports, the books never exceed the balance: that is all the check promises.
        assertGe(imd.balanceOf(address(rules)), rules.totalEscrowed());
        vm.prank(creator);
        rules.cancel(a);
        vm.prank(stranger);
        assertEq(rules.cancel(b), escrowB, "rule b's creator still withdraws everything booked to it");
        assertGe(imd.balanceOf(address(rules)), rules.totalEscrowed());
    }

    /// @dev An order can be refunded from the very second it expires, and the refund is credited.
    function test_reconcile_creditsAnOrderRefundedAtTheSecondItExpires() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        skip(14 days - 1);
        vm.expectRevert(MockDesk.TooEarly.selector);
        desk.refund(orderId);
        skip(1);
        desk.refund(orderId);
        assertEq(rules.reconcile(id, orderId), MAX_PAY);
        assertEq(_escrow(id), 30e18 - TIP);
        _assertBooksMatchBalance();
    }

    function test_reconcile_refusesADeskThatNamesAnotherEmployer() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        desk.deliver(orderId, 1e18, JOB);
        desk.setEmployerOverride(orderId, stranger);
        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, id, orderId));
        rules.reconcile(id, orderId);
    }

    function test_reconcile_afterCancel_paysTheCreatorDirectly() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        vm.prank(creator);
        rules.cancel(id);
        assertEq(rules.totalEscrowed(), 0);

        desk.deliver(orderId, 4e18, JOB);
        uint256 before = imd.balanceOf(creator);

        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.Reconciled(id, orderId, 6e18, true);
        vm.prank(stranger);
        assertEq(rules.reconcile(id, orderId), 6e18);

        assertEq(imd.balanceOf(creator) - before, 6e18);
        assertEq(_escrow(id), 0, "a cancelled rule holds nothing");
        assertEq(rules.totalEscrowed(), 0);
        assertEq(imd.balanceOf(address(rules)), 0);
        assertEq(rules.reconcile(id, orderId), 0);
    }

    // ---- recall ----

    function test_recall_withdrawsAnUntakenOrderIntoTheRule() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);

        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.Recalled(id, orderId);
        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.Reconciled(id, orderId, MAX_PAY, false);
        vm.prank(creator);
        uint256 amount = rules.recall(id, orderId);

        assertEq(amount, MAX_PAY);
        assertEq(uint8(desk.stateOf(orderId)), uint8(IWorkOrders.State.Cancelled));
        assertEq(_escrow(id), 30e18 - TIP);
        assertEq(imd.balanceOf(address(desk)), 0);
        _assertBooksMatchBalance();
    }

    function test_recall_onlyTheCreator() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        vm.prank(stranger);
        vm.expectRevert(Rules.NotCreator.selector);
        rules.recall(id, orderId);
        vm.prank(keeper);
        vm.expectRevert(Rules.NotCreator.selector);
        rules.recall(id, orderId);
        vm.prank(creator);
        vm.expectRevert(Rules.NotCreator.selector);
        rules.recall(0, orderId);
    }

    function test_recall_refusesAnotherRulesOrder() public {
        (, uint256 orderA) = _firedHireRule(30e18);
        // The same creator's second rule cannot be used to pull the first rule's order.
        uint256 b = _createHireRule(0, 5, 30e18);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, b, orderA));
        rules.recall(b, orderA);

        // And another creator cannot reach it through a rule of their own.
        vm.prank(stranger);
        uint256 theirs = rules.createRule(_hireParams(_viewCond(1, 100), 0, 5), SPEC, 30e18);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, theirs, orderA));
        rules.recall(theirs, orderA);
        assertEq(uint8(desk.stateOf(orderA)), uint8(IWorkOrders.State.Open));
    }

    function test_recall_revertsWhenTheDeskWillNotCancel() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        desk.deliver(orderId, 5e18, JOB);
        vm.prank(creator);
        vm.expectRevert(MockDesk.BadState.selector);
        rules.recall(id, orderId);
        // The change is still there for an ordinary reconcile.
        assertEq(rules.reconcile(id, orderId), 5e18);
    }

    function test_recall_afterCancel_sendsTheOrdersEscrowToTheCreator() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        vm.prank(creator);
        rules.cancel(id);
        uint256 before = imd.balanceOf(creator);
        vm.prank(creator);
        assertEq(rules.recall(id, orderId), MAX_PAY);
        assertEq(imd.balanceOf(creator) - before, MAX_PAY);
        assertEq(imd.balanceOf(address(rules)), 0);
        // Everything the creator put in came back except the one tip.
        assertEq(imd.balanceOf(creator), 1_000_000e18 - TIP);
    }

    // ---- the desk's delivery callback ----

    function _firedCallbackRule(uint96 deposit) internal returns (uint256 id, uint256 orderId) {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 5);
        p.hire.flags = desk.FLAG_CALLBACK();
        vm.prank(creator);
        id = rules.createRule(p, SPEC, deposit);
        gauge.set(100);
        orderId = _fire(id);
    }

    function test_onWorkDelivered_returnsTheChangeInTheSameTransaction() public {
        (uint256 id, uint256 orderId) = _firedCallbackRule(30e18);

        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.WorkDelivered(id, orderId, JOB, keccak256(abi.encode(orderId, JOB)));
        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.Reconciled(id, orderId, 7e18, false);
        desk.deliver(orderId, 3e18, JOB);

        // No reconcile call was needed, and the callback fitted the desk's gas allowance.
        assertEq(_escrow(id), 30e18 - TIP - 3e18);
        assertEq(rules.reconcile(id, orderId), 0);
        _assertBooksMatchBalance();
    }

    function test_onWorkDelivered_afterCancel_paysTheCreator() public {
        (uint256 id, uint256 orderId) = _firedCallbackRule(30e18);
        vm.prank(creator);
        rules.cancel(id);
        uint256 before = imd.balanceOf(creator);
        desk.deliver(orderId, 3e18, JOB);
        assertEq(imd.balanceOf(creator) - before, 7e18);
        assertEq(imd.balanceOf(address(rules)), 0);
    }

    function test_onWorkDelivered_onlyTheDesk() public {
        (, uint256 orderId) = _firedCallbackRule(30e18);
        vm.prank(stranger);
        vm.expectRevert(Rules.NotDesk.selector);
        rules.onWorkDelivered(orderId, JOB, bytes32(uint256(1)));
        vm.prank(creator);
        vm.expectRevert(Rules.NotDesk.selector);
        rules.onWorkDelivered(orderId, JOB, bytes32(uint256(1)));
    }

    function test_onWorkDelivered_ignoresAnOrderItDidNotOpen() public {
        vm.recordLogs();
        vm.prank(address(desk));
        rules.onWorkDelivered(424242, JOB, bytes32(uint256(1)));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_onWorkDelivered_gasFitsTheDesksAllowance() public {
        // Deliver an order that did not ask for the callback, then measure the callback alone, called
        // as the desk would call it.
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        desk.deliver(orderId, 3e18, JOB);
        vm.prank(address(desk));
        uint256 g = gasleft();
        rules.onWorkDelivered(orderId, JOB, bytes32(uint256(1)));
        uint256 used = g - gasleft();
        emit log_named_uint("gas: onWorkDelivered with change to credit", used);
        assertLt(used, 100_000, "well inside the desk's 150,000");
        assertEq(_escrow(id), 30e18 - TIP - 3e18);
    }

    // ---- reentrancy: a desk that calls back in ----

    function _expectLocked(bytes memory callBack) internal {
        desk.setCallBack(callBack);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    }

    function test_reentrancy_everyMoneyFunctionIsLockedWhileARuleFires() public {
        uint256 other = _createHireRule(0, 5, 30e18);
        gauge.set(100);
        uint256 otherOrder = _fire(other);
        uint256 id = _createHireRule(0, 5, 30e18);
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);

        _expectLocked(abi.encodeCall(Rules.fire, (other, SPEC)));
        _fire(id);
        _expectLocked(abi.encodeCall(Rules.reconcile, (other, otherOrder)));
        _fire(id);
        _expectLocked(abi.encodeCall(Rules.recall, (other, otherOrder)));
        _fire(id);
        _expectLocked(abi.encodeCall(Rules.cancel, (other)));
        _fire(id);
        _expectLocked(abi.encodeCall(Rules.topUp, (other, 1)));
        _fire(id);
        _expectLocked(abi.encodeCall(Rules.createRule, (p, "", 0)));
        _fire(id);
        _expectLocked(abi.encodeCall(Rules.onWorkDelivered, (otherOrder, JOB, bytes32(0))));
        _fire(id);

        assertEq(rules.getRule(id).fires, 0);
        assertEq(_escrow(id), 30e18);
    }

    function test_reentrancy_lockedWhileAnOrderIsRecalled() public {
        (uint256 id, uint256 orderId) = _firedHireRule(30e18);
        _expectLocked(abi.encodeCall(Rules.reconcile, (id, orderId)));
        vm.prank(creator);
        rules.recall(id, orderId);
        assertEq(uint8(desk.stateOf(orderId)), uint8(IWorkOrders.State.Open));
    }
}
