// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {stdError} from "forge-std/Test.sol";

import {Rules} from "../../src/rules/Rules.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {RulesBase} from "./RulesBase.sol";

/// @dev Edges of Rules the other files do not pin: the 96-bit ceiling of an escrow, the widest
/// cooldown and order lifetime a creator can set, feeds shared by several rules or whose rounds go
/// backwards, unknown ids on the creator-only functions, and a rule whose condition reads Rules' own
/// books while the transient lock is held.
contract RulesEdgesTest is RulesBase {
    uint96 internal constant MAX96 = type(uint96).max;

    function setUp() public override {
        super.setUp();
        // Enough to fill an escrow to its ceiling.
        imd.mint(creator, uint256(MAX96) * 2);
    }

    // ------------------------------------------------------------------------- the 96-bit ceiling

    function test_topUp_pastTheEscrowCeilingRevertsAndChangesNothing() public {
        uint256 id = _createPayRule(0, 1, MAX96 - 1);
        assertEq(_escrow(id), MAX96 - 1);
        uint256 totalBefore = rules.totalEscrowed();
        uint256 heldBefore = imd.balanceOf(address(rules));

        vm.prank(creator);
        vm.expectRevert(stdError.arithmeticError);
        rules.topUp(id, 2);

        assertEq(_escrow(id), MAX96 - 1, "escrow changed");
        assertEq(rules.totalEscrowed(), totalBefore, "total changed");
        assertEq(imd.balanceOf(address(rules)), heldBefore, "money moved");

        // The last wei that fits is taken.
        vm.prank(creator);
        rules.topUp(id, 1);
        assertEq(_escrow(id), MAX96);
    }

    function test_createRule_aDepositAtTheCeilingIsAccepted_andTheRuleFires() public {
        uint256 id = _createPayRule(0, 1, MAX96);
        assertEq(_escrow(id), MAX96);
        gauge.set(100);
        _fire(id);
        assertEq(_escrow(id), uint256(MAX96) - PAY_AMOUNT - TIP);
        assertEq(imd.balanceOf(payee), PAY_AMOUNT);
        assertEq(imd.balanceOf(keeper), TIP);
    }

    /// @dev A return from the desk is credited to the rule's escrow. If the creator has filled the
    /// escrow to its ceiling in the meantime, the credit cannot be booked and `reconcile` reverts.
    /// The money is not lost: cancelling the rule pays the return straight to the creator.
    function test_reconcile_cannotBookAReturnIntoAFullEscrow_butCancelThenFreesIt() public {
        uint256 id = _createHireRule(0, 2, MAX96);
        gauge.set(100);
        uint256 orderId = _fire(id);
        // Refill what the fire took.
        vm.prank(creator);
        rules.topUp(id, MAX_PAY + TIP);
        assertEq(_escrow(id), MAX96);

        // The desk refunds the order in full.
        vm.warp(vm.getBlockTimestamp() + 14 days);
        desk.refund(orderId);

        vm.expectRevert(stdError.arithmeticError);
        rules.reconcile(id, orderId);
        (,, uint96 credited) = rules.orderOf(orderId);
        assertEq(credited, 0, "credited although it reverted");

        uint256 creatorBefore = imd.balanceOf(creator);
        vm.prank(creator);
        uint256 refund = rules.cancel(id);
        assertEq(refund, MAX96);
        uint256 got = rules.reconcile(id, orderId);
        assertEq(got, MAX_PAY);
        assertEq(imd.balanceOf(creator), creatorBefore + MAX96 + MAX_PAY);
        assertEq(imd.balanceOf(address(rules)), 0, "Rules kept something");
    }

    // ------------------------------------------------------------------------- escrow at the line

    function testFuzz_fire_escrowExactlyAtTheCostFires_oneWeiLessDoesNot(uint96 tip, uint96 amount) public {
        tip = uint96(bound(tip, 0, 1e24));
        amount = uint96(bound(amount, 1, 1e24));
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.tip = tip;
        p.pay.amount = amount;
        uint96 cost = tip + amount;

        vm.prank(creator);
        uint256 id = rules.createRule(p, "", cost - 1);
        gauge.set(100);
        assertFalse(rules.canFire(id));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Rules.EscrowShort.selector, cost, cost - 1));
        rules.fire(id, "");

        vm.prank(stranger);
        rules.topUp(id, 1);
        assertTrue(rules.canFire(id));
        _fire(id);
        assertEq(_escrow(id), 0);
        assertEq(rules.totalEscrowed(), 0);
        assertEq(imd.balanceOf(payee), amount);
        assertEq(imd.balanceOf(keeper), tip);
    }

    // ------------------------------------------------------------------------- the widest settings

    function test_fire_theWidestCooldownHoldsForTheWholeOfIt() public {
        uint32 widest = type(uint32).max;
        uint256 id = _createPayRule(widest, 2, 2 * (PAY_AMOUNT + TIP));
        gauge.set(100);
        _fire(id);
        uint256 readyAt = vm.getBlockTimestamp() + widest;

        assertFalse(rules.canFire(id));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Rules.CoolingDown.selector, readyAt));
        rules.fire(id, "");

        vm.warp(readyAt - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Rules.CoolingDown.selector, readyAt));
        rules.fire(id, "");

        vm.warp(readyAt);
        assertTrue(rules.canFire(id));
        _fire(id);
        assertEq(uint8(rules.statusOf(id)), uint8(Rules.Status.Exhausted));
    }

    function test_fire_hire_theWidestOrderLifetimeStillFitsTheDesksExpiry() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        p.hire.orderTtl = type(uint32).max;
        vm.prank(creator);
        uint256 id = rules.createRule(p, SPEC, MAX_PAY + TIP);
        gauge.set(100);
        uint256 orderId = _fire(id);
        IWorkOrders.OrderParams memory o = desk.paramsOf(orderId);
        assertEq(uint256(o.expiresAt), vm.getBlockTimestamp() + type(uint32).max);
        assertEq(uint8(desk.stateOf(orderId)), uint8(IWorkOrders.State.Open));
    }

    function test_fire_feed_theWidestMaximumAgeAcceptsAnyPastAnswer() public {
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(_feedCond(1, 100, type(uint32).max), 0, 1), "", PAY_AMOUNT + TIP);
        // An answer from the first second of the chain.
        feed.set(FEED_ID, 100, 1, 1);
        assertTrue(rules.canFire(id));
        _fire(id);
        assertEq(rules.getRule(id).lastRound, 1);
    }

    // ------------------------------------------------------------------------- feeds and rounds

    function test_fire_feed_twoRulesOnTheSameFeedEachFireOncePerRound() public {
        vm.startPrank(creator);
        uint256 a = rules.createRule(_payParams(_feedCond(1, 100, 1 days), 0, 5), "", 5 * (PAY_AMOUNT + TIP));
        uint256 b = rules.createRule(_payParams(_feedCond(1, 100, 1 days), 0, 5), "", 5 * (PAY_AMOUNT + TIP));
        vm.stopPrank();

        feed.push(FEED_ID, 150);
        _fire(a);
        // Rule a's fire does not use the round up for rule b.
        assertTrue(rules.canFire(b));
        _fire(b);
        assertFalse(rules.canFire(a));
        assertFalse(rules.canFire(b));
        vm.prank(keeper);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(a, "");

        feed.push(FEED_ID, 150);
        _fire(b);
        _fire(a);
        assertEq(rules.getRule(a).fires, 2);
        assertEq(rules.getRule(b).fires, 2);
        assertEq(rules.getRule(a).lastRound, 2);
        assertEq(rules.getRule(b).lastRound, 2);
    }

    function test_fire_feed_aSourceWhoseRoundsGoBackwardsStopsTheRuleUntilTheyPassTheLastOne() public {
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(_feedCond(1, 100, 1 days), 0, 5), "", 5 * (PAY_AMOUNT + TIP));
        feed.set(FEED_ID, 150, 7, uint64(vm.getBlockTimestamp()));
        _fire(id);
        assertEq(rules.getRule(id).lastRound, 7);

        // The source now reports a lower round, fresh and over the line.
        feed.set(FEED_ID, 150, 3, uint64(vm.getBlockTimestamp()));
        (bool met,, uint64 round) = rules.check(id);
        assertFalse(met);
        assertEq(round, 0);
        vm.prank(keeper);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");

        // The same round again is not news either.
        feed.set(FEED_ID, 150, 7, uint64(vm.getBlockTimestamp()));
        assertFalse(rules.canFire(id));

        feed.set(FEED_ID, 150, 8, uint64(vm.getBlockTimestamp()));
        _fire(id);
        assertEq(rules.getRule(id).lastRound, 8);
    }

    function test_fire_feed_anAnswerExactlyMaxAgeOldIsFresh_oneSecondOlderIsNot() public {
        uint32 maxAge = 1 hours;
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(_feedCond(1, 100, maxAge), 0, 2), "", 2 * (PAY_AMOUNT + TIP));
        uint64 stamped = uint64(vm.getBlockTimestamp());
        feed.set(FEED_ID, 150, 1, stamped);

        vm.warp(stamped + maxAge + 1);
        assertFalse(rules.canFire(id));
        vm.prank(keeper);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");

        vm.warp(stamped + maxAge);
        assertTrue(rules.canFire(id));
        _fire(id);
    }

    // ------------------------------------------------------------------------- unknown ids

    function test_creatorOnlyFunctions_refuseAnUnknownRuleAsNotCreator() public {
        uint256 unknown = 42;
        assertEq(uint8(rules.statusOf(unknown)), uint8(Rules.Status.None));
        vm.prank(creator);
        vm.expectRevert(Rules.NotCreator.selector);
        rules.cancel(unknown);
        vm.prank(creator);
        vm.expectRevert(Rules.NotCreator.selector);
        rules.recall(unknown, 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Rules.UnknownRule.selector, unknown));
        rules.topUp(unknown, 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Rules.UnknownRule.selector, unknown));
        rules.fire(unknown, "");
        assertFalse(rules.canFire(unknown));
        (bool met, uint256 value, uint64 round) = rules.check(unknown);
        assertFalse(met);
        assertEq(value, 0);
        assertEq(round, 0);
        assertEq(rules.costOf(unknown), 0);
    }

    function test_reconcile_refusesRuleZeroAndOrderZero() public {
        uint256 id = _createHireRule(0, 1, MAX_PAY + TIP);
        gauge.set(100);
        uint256 orderId = _fire(id);
        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, 0, orderId));
        rules.reconcile(0, orderId);
        vm.expectRevert(abi.encodeWithSelector(Rules.NotThisRulesOrder.selector, id, 0));
        rules.reconcile(id, 0);
        (uint256 ruleId, uint96 sent, uint96 credited) = rules.orderOf(0);
        assertEq(ruleId, 0);
        assertEq(sent, 0);
        assertEq(credited, 0);
    }

    // ------------------------------------------------------------------------- a rule that reads Rules

    /// @dev A condition may point at Rules itself: the read is a `staticcall` into a view, which the
    /// transient lock does not guard, so a rule can watch this contract's own books.
    function test_fire_view_aRuleMayWatchRulesOwnBooks() public {
        Rules.Condition memory c = _rawCond(address(rules), abi.encodeCall(rules.totalEscrowed, ()), 1, 10e18);
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(c, 0, 1), "", PAY_AMOUNT + TIP);
        assertFalse(rules.canFire(id), "escrowed less than the line");

        // Somebody else's rule lifts the total over the line.
        vm.prank(stranger);
        rules.createRule(_payParams(_viewCond(1, 100), 0, 1), "", 10e18);
        (bool met, uint256 value,) = rules.check(id);
        assertTrue(met);
        assertEq(value, rules.totalEscrowed());
        _fire(id);
        assertEq(imd.balanceOf(payee), PAY_AMOUNT);
    }

    /// @dev A rule that watches its own `canFire` is not a defect but a trap for its creator: the read
    /// recurses until the gas cap runs out, so the answer depends on gas, not on the world. Whatever it
    /// answers, nothing but the rule's own escrow can move.
    function test_fire_view_aRuleWatchingItselfCanOnlySpendItsOwnEscrow() public {
        uint256 id = rules.ruleCount() + 1;
        Rules.Condition memory c = _rawCond(address(rules), abi.encodeCall(rules.canFire, (id)), 5, 0);
        vm.prank(creator);
        assertEq(rules.createRule(_payParams(c, 0, 1), "", PAY_AMOUNT + TIP), id);
        uint256 other = _createPayRule(0, 1, PAY_AMOUNT + TIP);

        uint256 heldBefore = imd.balanceOf(address(rules));
        vm.prank(keeper);
        try rules.fire(id, "") {
            assertEq(_escrow(id), 0);
            assertEq(imd.balanceOf(address(rules)), heldBefore - PAY_AMOUNT - TIP);
        } catch {
            assertEq(_escrow(id), PAY_AMOUNT + TIP);
            assertEq(imd.balanceOf(address(rules)), heldBefore);
        }
        assertEq(_escrow(other), PAY_AMOUNT + TIP, "another rule's escrow moved");
        assertEq(rules.totalEscrowed(), _escrow(id) + _escrow(other));
    }
}
