// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Rules} from "../../src/rules/Rules.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IQuestions} from "../../src/interfaces/IQuestions.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {Flood, GasMeter, Gauge, Puppet} from "./mocks/Targets.sol";
import {RulesBase} from "./RulesBase.sol";

/// @dev Firing a rule: both actions, both condition kinds, every gate, and condition targets that
/// misbehave.
contract RulesFireTest is RulesBase {
    // ---- PAY ----

    function test_fire_pay_paysTheRecipientAndTipsTheCaller() public {
        uint256 id = _createPayRule(0, 3, 10e18);
        gauge.set(100);

        uint256 orderId = _fire(id);

        assertEq(orderId, 0);
        assertEq(imd.balanceOf(payee), PAY_AMOUNT);
        assertEq(imd.balanceOf(keeper), TIP);
        assertEq(_escrow(id), 10e18 - PAY_AMOUNT - TIP);
        assertEq(rules.totalEscrowed(), 10e18 - PAY_AMOUNT - TIP);
        assertEq(imd.balanceOf(address(rules)), 10e18 - PAY_AMOUNT - TIP);

        Rules.Rule memory r = rules.getRule(id);
        assertEq(r.fires, 1);
        assertEq(r.lastFiredAt, vm.getBlockTimestamp());
        assertEq(r.lastRound, 0);
    }

    function test_fire_pay_announcesTheFire() public {
        uint256 id = _createPayRule(0, 3, 10e18);
        gauge.set(123);
        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.Fired(id, keeper, 1, 123, 0, 0, PAY_AMOUNT, TIP);
        _fire(id);
    }

    function test_fire_pay_ignoresWhateverSpecBytesTheCallerSends() public {
        uint256 id = _createPayRule(0, 3, 10e18);
        gauge.set(100);
        vm.prank(keeper);
        rules.fire(id, hex"00ff22");
        assertEq(imd.balanceOf(payee), PAY_AMOUNT);
    }

    function test_fire_withoutATipPaysTheCallerNothing() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.tip = 0;
        vm.prank(creator);
        uint256 id = rules.createRule(p, "", PAY_AMOUNT);
        gauge.set(100);
        _fire(id);
        assertEq(imd.balanceOf(keeper), 0);
        assertEq(imd.balanceOf(payee), PAY_AMOUNT);
        assertEq(_escrow(id), 0);
    }

    function test_fire_theCreatorMayFireItsOwnRule() public {
        uint256 id = _createPayRule(0, 1, 10e18);
        gauge.set(100);
        uint256 before = imd.balanceOf(creator);
        vm.prank(creator);
        rules.fire(id, "");
        assertEq(imd.balanceOf(creator) - before, TIP);
    }

    // ---- HIRE ----

    function test_fire_hire_opensTheOrderWithThePinnedTerms() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 2);
        p.hire.runnerOnly = address(0xBEEF);
        p.hire.arbiter = address(0xA4B1);
        p.hire.flags = 1;
        vm.prank(creator);
        uint256 id = rules.createRule(p, SPEC, 30e18);
        gauge.set(100);

        uint256 orderId = _fire(id);

        assertEq(orderId, 1);
        (IWorkOrders.State state, address employer, uint96 escrow, uint96 spent, uint96 returned) =
            desk.accountOf(orderId);
        assertEq(uint8(state), uint8(IWorkOrders.State.Open));
        assertEq(employer, address(rules), "Rules is the employer");
        assertEq(escrow, MAX_PAY);
        assertEq(spent, 0);
        assertEq(returned, 0);
        assertEq(desk.specHashOf(orderId), keccak256(SPEC));

        IWorkOrders.OrderParams memory o = desk.paramsOf(orderId);
        assertEq(o.kindHash, KIND_AUDIT);
        assertEq(o.minPay, 4e18);
        assertEq(o.maxPay, MAX_PAY);
        assertEq(o.rampSecs, 1 hours);
        assertEq(o.deliverySecs, 7 days);
        assertEq(o.expiresAt, vm.getBlockTimestamp() + 14 days, "the lifetime counts from the fire");
        assertEq(o.bond, 0.5e18);
        assertEq(o.flags, 1);
        assertEq(o.runnerOnly, address(0xBEEF));
        assertEq(o.arbiter, address(0xA4B1));
        // The order carries no condition of its own.
        assertEq(o.condTarget, address(0));
        assertEq(o.condSelector, bytes4(0));
        assertEq(o.condArg, bytes32(0));
        assertEq(o.condCmp, 0);
        assertEq(o.condThreshold, 0);

        assertEq(imd.balanceOf(address(desk)), MAX_PAY);
        assertEq(imd.balanceOf(keeper), TIP);
        assertEq(_escrow(id), 30e18 - MAX_PAY - TIP);
        assertEq(imd.balanceOf(address(rules)), 30e18 - MAX_PAY - TIP);
        assertEq(imd.allowance(address(rules), address(desk)), 0, "no allowance is left behind");

        (uint256 ruleId, uint96 sent, uint96 credited) = rules.orderOf(orderId);
        assertEq(ruleId, id);
        assertEq(sent, MAX_PAY);
        assertEq(credited, 0);
    }

    function test_fire_hire_announcesTheFireWithItsOrder() public {
        uint256 id = _createHireRule(0, 2, 30e18);
        gauge.set(5_000);
        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.Fired(id, keeper, 1, 5_000, 0, 1, MAX_PAY, TIP);
        _fire(id);
    }

    function test_fire_hire_eachFireOpensItsOwnOrder() public {
        uint256 id = _createHireRule(0, 3, 40e18);
        gauge.set(100);
        assertEq(_fire(id), 1);
        skip(1 days);
        assertEq(_fire(id), 2);
        assertEq(desk.paramsOf(2).expiresAt, vm.getBlockTimestamp() + 14 days);
        (uint256 ruleOfFirst,,) = rules.orderOf(1);
        (uint256 ruleOfSecond,,) = rules.orderOf(2);
        assertEq(ruleOfFirst, id);
        assertEq(ruleOfSecond, id);
        assertEq(_escrow(id), 40e18 - 2 * (uint256(MAX_PAY) + TIP));
    }

    function test_fire_hire_refusesAnyOtherSpec() public {
        uint256 id = _createHireRule(0, 2, 30e18);
        gauge.set(100);
        vm.prank(keeper);
        vm.expectRevert(Rules.WrongSpec.selector);
        rules.fire(id, "Audit something else entirely");
        vm.prank(keeper);
        vm.expectRevert(Rules.WrongSpec.selector);
        rules.fire(id, "");
        assertEq(rules.getRule(id).fires, 0);
        assertEq(_escrow(id), 30e18);
    }

    function test_fire_hire_whenTheDeskRefusesNothingChanges() public {
        uint256 id = _createHireRule(0, 2, 30e18);
        gauge.set(100);
        // Makes the mock desk's createOrder revert (its own arithmetic underflows).
        desk.setPullShortBy(MAX_PAY + 1);
        vm.prank(keeper);
        vm.expectRevert();
        rules.fire(id, SPEC);
        assertEq(rules.getRule(id).fires, 0);
        assertEq(_escrow(id), 30e18);
        assertEq(imd.balanceOf(address(rules)), 30e18);
        assertEq(imd.allowance(address(rules), address(desk)), 0);
    }

    function test_fire_hire_refusesADeskThatTakesLessThanTheOrderCosts() public {
        uint256 id = _createHireRule(0, 2, 30e18);
        gauge.set(100);
        desk.setPullShortBy(1);
        vm.prank(keeper);
        vm.expectRevert(Rules.DeskPulledWrongAmount.selector);
        rules.fire(id, SPEC);
        assertEq(_escrow(id), 30e18);
    }

    function test_fire_hire_refusesAnOrderIdItAlreadyKnows() public {
        uint256 a = _createHireRule(0, 2, 30e18);
        uint256 b = _createHireRule(0, 2, 30e18);
        gauge.set(100);
        _fire(a);
        desk.setReuseLastId(true);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Rules.OrderAlreadyLinked.selector, 1));
        rules.fire(b, SPEC);
        (uint256 ruleId,,) = rules.orderOf(1);
        assertEq(ruleId, a, "the order stays with the rule that paid for it");
        assertEq(_escrow(b), 30e18);
    }

    // ---- the gates ----

    function test_fire_refusesAnUnknownRule() public {
        vm.expectRevert(abi.encodeWithSelector(Rules.UnknownRule.selector, 7));
        rules.fire(7, "");
        vm.expectRevert(abi.encodeWithSelector(Rules.UnknownRule.selector, 0));
        rules.fire(0, "");
    }

    function test_fire_refusesACancelledRule() public {
        uint256 id = _createPayRule(0, 3, 10e18);
        gauge.set(100);
        vm.prank(creator);
        rules.cancel(id);
        vm.expectRevert(abi.encodeWithSelector(Rules.RuleIsCancelled.selector, id));
        rules.fire(id, "");
    }

    function test_fire_refusesWhenTheConditionIsFalse() public {
        uint256 id = _createPayRule(0, 3, 10e18);
        gauge.set(99);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");
        assertEq(rules.getRule(id).fires, 0);
    }

    function test_fire_refusesWhenTheEscrowIsShort() public {
        uint256 id = _createPayRule(0, 3, PAY_AMOUNT + TIP - 1);
        gauge.set(100);
        vm.expectRevert(
            abi.encodeWithSelector(Rules.EscrowShort.selector, uint256(PAY_AMOUNT) + TIP, uint256(PAY_AMOUNT) + TIP - 1)
        );
        rules.fire(id, "");
        vm.prank(stranger);
        rules.topUp(id, 1);
        _fire(id);
        assertEq(_escrow(id), 0);
    }

    /// @dev The contract holds plenty, but none of it is this rule's.
    function test_fire_aRuleCannotSpendAnotherRulesEscrow() public {
        uint256 rich = _createPayRule(0, 3, 500e18);
        uint256 poor = _createPayRule(0, 3, 1e18);
        gauge.set(100);
        vm.expectRevert(abi.encodeWithSelector(Rules.EscrowShort.selector, uint256(PAY_AMOUNT) + TIP, 1e18));
        rules.fire(poor, "");
        assertEq(_escrow(rich), 500e18);
        assertEq(_escrow(poor), 1e18);
    }

    function test_fire_respectsTheCooldown() public {
        uint256 id = _createPayRule(6 hours, 5, 50e18);
        gauge.set(100);
        _fire(id);
        uint256 readyAt = vm.getBlockTimestamp() + 6 hours;

        vm.expectRevert(abi.encodeWithSelector(Rules.CoolingDown.selector, readyAt));
        rules.fire(id, "");
        vm.warp(readyAt - 1);
        assertFalse(rules.canFire(id));
        vm.expectRevert(abi.encodeWithSelector(Rules.CoolingDown.selector, readyAt));
        rules.fire(id, "");
        vm.warp(readyAt);
        assertTrue(rules.canFire(id));
        _fire(id);
        assertEq(rules.getRule(id).fires, 2);
    }

    /// @dev The cooldown separates fires; it does not delay the first one, even at a tiny timestamp.
    function test_fire_theFirstFireNeedsNoCooldown() public {
        vm.warp(1);
        uint256 id = _createPayRule(30 days, 5, 50e18);
        gauge.set(100);
        _fire(id);
        assertEq(rules.getRule(id).fires, 1);
    }

    function test_fire_aZeroCooldownAllowsFiresBackToBack() public {
        uint256 id = _createPayRule(0, 3, 50e18);
        gauge.set(100);
        _fire(id);
        _fire(id);
        _fire(id);
        assertEq(imd.balanceOf(payee), 3 * uint256(PAY_AMOUNT));
        assertEq(imd.balanceOf(keeper), 3 * uint256(TIP));
    }

    /// @dev The tip goes to whoever fires first. A keeper's transaction that somebody copies and
    /// gets mined ahead pays the copy the tip; the keeper's own transaction then reverts, having
    /// moved nothing, and the keeper is out its gas. The rule's recipient is paid once either way,
    /// and nobody can take more than the tip. There is no earlier party to pay instead: firing is the
    /// whole of the work, and whoever does it first did it.
    function test_fire_aCopiedFireTakesTheTip_andTheFireItCopiedRevertsHavingMovedNothing() public {
        uint256 id = _createPayRule(0, 1, 10e18);
        gauge.set(100);
        uint256 strangerBefore = imd.balanceOf(stranger);

        vm.prank(stranger);
        rules.fire(id, "");
        assertEq(imd.balanceOf(stranger) - strangerBefore, TIP, "the copy that landed first took the tip");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Rules.RuleExhausted.selector, id));
        rules.fire(id, "");
        assertEq(imd.balanceOf(keeper), 0);
        assertEq(imd.balanceOf(payee), PAY_AMOUNT, "the recipient was paid once");
    }

    /// @dev A creator who wants to end a rule whose condition has become true is in a race with every
    /// keeper: whichever transaction is mined first decides. A fire that lands first spends one fire's
    /// cost and the cancel returns the rest; a cancel that lands first returns everything and the fire
    /// reverts. Neither moves money anywhere the creator did not fix.
    function test_cancel_racesAFireOnceTheConditionHolds_andWhicheverLandsFirstDecides() public {
        uint256 id = _createPayRule(0, 3, 10e18);
        gauge.set(100);
        uint256 snapshot = vm.snapshotState();

        _fire(id);
        uint256 before = imd.balanceOf(creator);
        vm.prank(creator);
        assertEq(rules.cancel(id), 10e18 - PAY_AMOUNT - TIP);
        assertEq(imd.balanceOf(creator) - before, 10e18 - PAY_AMOUNT - TIP);
        assertEq(imd.balanceOf(payee), PAY_AMOUNT);

        vm.revertToState(snapshot);
        vm.prank(creator);
        assertEq(rules.cancel(id), 10e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Rules.RuleIsCancelled.selector, id));
        rules.fire(id, "");
        assertEq(imd.balanceOf(payee), 0);
    }

    function test_fire_stopsAtTheMaximumNumberOfFires() public {
        uint256 id = _createPayRule(0, 2, 50e18);
        gauge.set(100);
        _fire(id);
        assertEq(uint8(rules.statusOf(id)), uint8(Rules.Status.Armed));
        _fire(id);
        assertEq(uint8(rules.statusOf(id)), uint8(Rules.Status.Exhausted));
        assertFalse(rules.canFire(id));
        vm.expectRevert(abi.encodeWithSelector(Rules.RuleExhausted.selector, id));
        rules.fire(id, "");
        // What it did not spend is still the creator's to take.
        uint256 before = imd.balanceOf(creator);
        vm.prank(creator);
        rules.cancel(id);
        assertEq(imd.balanceOf(creator) - before, 50e18 - 2 * (uint256(PAY_AMOUNT) + TIP));
    }

    // ---- comparisons ----

    function test_fire_everyComparison() public {
        // cmp, value, threshold, expected
        _assertCompare(1, 100, 100, true);
        _assertCompare(1, 99, 100, false);
        _assertCompare(2, 100, 100, true);
        _assertCompare(2, 101, 100, false);
        _assertCompare(3, 101, 100, true);
        _assertCompare(3, 100, 100, false);
        _assertCompare(4, 99, 100, true);
        _assertCompare(4, 100, 100, false);
        _assertCompare(5, 100, 100, true);
        _assertCompare(5, 101, 100, false);
        _assertCompare(6, 101, 100, true);
        _assertCompare(6, 100, 100, false);
        // Unsigned: a word with the top bit set is a very large number, not a negative one.
        _assertCompare(3, type(uint256).max, 0, true);
        _assertCompare(4, type(uint256).max, 0, false);
    }

    function _assertCompare(uint8 cmp, uint256 value, uint256 threshold, bool expected) internal {
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(_viewCond(cmp, threshold), 0, 1), "", 10e18);
        gauge.set(value);
        (bool met, uint256 read, uint64 round) = rules.check(id);
        assertEq(met, expected);
        assertEq(read, value);
        assertEq(round, 0);
        assertEq(rules.canFire(id), expected);
        if (expected) {
            _fire(id);
        } else {
            vm.expectRevert(Rules.ConditionNotMet.selector);
            rules.fire(id, "");
        }
    }

    // ---- VIEW conditions with arguments ----

    function test_fire_view_readsAOneArgumentView() public {
        Rules.Condition memory c =
            _rawCond(address(gauge), abi.encodeCall(gauge.balanceOf, (address(0xCAFE))), 4, 1_000e18);
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(c, 0, 1), "", 10e18);

        gauge.setBalance(address(0xCAFE), 5_000e18);
        assertFalse(rules.canFire(id));
        gauge.setBalance(address(0xCAFE), 999e18);
        (bool met, uint256 value,) = rules.check(id);
        assertTrue(met);
        assertEq(value, 999e18);
        _fire(id);
    }

    function test_fire_view_readsAFourArgumentView() public {
        Rules.Condition memory c = _rawCond(address(gauge), abi.encodeCall(Gauge.sum4, (10, 20, 30, 40)), 5, 100);
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(c, 0, 1), "", 10e18);
        (bool met, uint256 value,) = rules.check(id);
        assertTrue(met);
        assertEq(value, 100);
        _fire(id);
    }

    /// @dev A condition with no calldata at all: the target is read through its fallback.
    function test_fire_view_readsATargetThatAnswersPlainCalls() public {
        Rules.Condition memory c = _rawCond(address(puppet), hex"", 1, 100);
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(c, 0, 1), "", 10e18);
        puppet.puppetSet(puppet.ANSWER(), abi.encode(uint256(99)));
        assertFalse(rules.canFire(id));
        puppet.puppetSet(puppet.ANSWER(), abi.encode(uint256(100)));
        (bool met, uint256 value,) = rules.check(id);
        assertTrue(met);
        assertEq(value, 100);
        _fire(id);
        assertEq(imd.balanceOf(payee), PAY_AMOUNT);
    }

    // ---- the caller cannot choose how much gas the condition is answered on ----

    /// @dev WHEN the target's reading is below `threshold` THEN PAY, as a VIEW or as a FEED rule.
    function _meterRule(GasMeter meter, bool asFeed, uint256 threshold) internal returns (uint256 id) {
        Rules.Condition memory c;
        c.cmp = 4;
        c.target = address(meter);
        c.threshold = threshold;
        if (asFeed) {
            c.kind = 2;
            c.feedId = FEED_ID;
            c.maxAge = 1 days;
        } else {
            c.kind = 1;
            c.data = hex"12345678";
        }
        vm.prank(creator);
        id = rules.createRule(_payParams(c, 0, 1), "", 10e18);
    }

    /// @dev Fires `id` with `gasLimit`. The rule's condition is false whenever its target is offered
    /// the whole allowance, so no gas limit may make it fire. Says how the call was refused.
    function _fireWith(uint256 id, uint256 gasLimit) internal returns (bool gasShort, bool notMet) {
        vm.prank(keeper);
        try rules.fire{gas: gasLimit}(id, "") {
            revert("the rule fired on a reading its target gives only when it is short of gas");
        } catch (bytes memory why) {
            gasShort = bytes4(why) == Rules.GasShort.selector;
            notMet = bytes4(why) == Rules.ConditionNotMet.selector;
        }
        assertEq(rules.getRule(id).fires, 0);
    }

    /// @dev The target reports the gas it was offered, and the rule pays when that is even one unit
    /// less than the whole allowance gives. Whoever fires the rule wants the tip and chooses the gas
    /// limit. Whatever limit they choose, the rule must not fire: either the call is refused for
    /// lack of gas, or the target gets the whole allowance and the condition is false.
    function _assertNoGasLimitStarvesTheRead(bool asFeed) internal {
        GasMeter meter = new GasMeter();
        // What the target reports on the whole allowance, read with gas to spare.
        (, uint256 whole,) = rules.check(_meterRule(meter, asFeed, 0));
        assertGt(whole, 99_000, "the target was offered close to the whole allowance");
        assertLe(whole, rules.COND_GAS());

        uint256 id = _meterRule(meter, asFeed, whole);
        (bool met, uint256 value, uint64 round) = rules.check(id);
        assertFalse(met);
        assertEq(value, whole);
        assertEq(round, asFeed ? 1 : 0, "for a feed, the answer itself is usable: fresh and new");

        // A coarse sweep over every plausible limit, noting the lowest that was enough for the read.
        uint256 lowestEnough;
        uint256 refusedForGas;
        for (uint256 gasLimit = 30_000; gasLimit <= 400_000; gasLimit += 97) {
            (bool gasShort, bool notMet) = _fireWith(id, gasLimit);
            if (gasShort) ++refusedForGas;
            if (notMet && lowestEnough == 0) lowestEnough = gasLimit;
        }
        assertGt(refusedForGas, 0, "some limits were too low to offer the whole allowance");
        assertGt(lowestEnough, 0, "some limits were enough, and the true answer is no");

        // Then every single limit around the point where the refusal ends: one unit of gas too few
        // for the target would show here as a fire.
        for (uint256 gasLimit = lowestEnough - 300; gasLimit <= lowestEnough + 300; ++gasLimit) {
            _fireWith(id, gasLimit);
        }
        assertEq(imd.balanceOf(payee), 0);
        assertEq(imd.balanceOf(keeper), 0);
        assertEq(_escrow(id), 10e18);
    }

    function test_fire_view_theCallerCannotStarveTheConditionOfGas() public {
        _assertNoGasLimitStarvesTheRead(false);
    }

    /// @dev The same through a FEED condition: the source's answer depends on the gas it is given.
    function test_fire_feed_theCallerCannotStarveTheSourceOfGas() public {
        _assertNoGasLimitStarvesTheRead(true);
    }

    /// @dev The longest stored calldata makes the read's preparation as expensive as it gets (six
    /// storage slots to load before the call). The gas is counted after that preparation, so the
    /// target is still offered the whole allowance.
    function test_fire_view_theLongestCalldataLeavesTheAllowanceWhole() public {
        GasMeter meter = new GasMeter();
        Rules.Condition memory c = _rawCond(address(meter), new bytes(132), 4, 0);
        vm.prank(creator);
        (, uint256 whole,) = rules.check(rules.createRule(_payParams(c, 0, 1), "", 0));
        c.threshold = whole;
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(c, 0, 1), "", 10e18);

        uint256 lowestEnough;
        for (uint256 gasLimit = 30_000; gasLimit <= 400_000; gasLimit += 97) {
            (, bool notMet) = _fireWith(id, gasLimit);
            if (notMet && lowestEnough == 0) lowestEnough = gasLimit;
        }
        assertGt(lowestEnough, 0);
        for (uint256 gasLimit = lowestEnough - 300; gasLimit <= lowestEnough + 300; ++gasLimit) {
            _fireWith(id, gasLimit);
        }
        assertEq(_escrow(id), 10e18);
    }

    /// @dev The views cannot insist on gas. A reading taken with little gas in hand is a reading of
    /// a target that was offered less than the whole allowance, which is why `fire` reads again
    /// under its own rule and never trusts an earlier `check`.
    function test_check_isOnlyAsGoodAsTheGasItIsGiven() public {
        GasMeter meter = new GasMeter();
        uint256 id = _meterRule(meter, false, 0);
        (, uint256 whole,) = rules.check(id);
        (, uint256 onLess,) = rules.check{gas: 80_000}(id);
        assertGt(onLess, 0, "the read still went through");
        assertLt(onLess, whole, "and the target saw less gas than the allowance");
    }

    /// @dev The requirement is about gas in hand, not gas used: a rule whose read costs a few
    /// thousand gas still fires on an ordinary gas limit, and is refused cleanly on a small one.
    function test_fire_gasShort_isACleanRefusal_andAnOrdinaryLimitIsEnough() public {
        uint256 id = _createPayRule(0, 2, 10e18);
        gauge.set(100);
        vm.prank(keeper);
        vm.expectRevert(Rules.GasShort.selector);
        rules.fire{gas: 90_000}(id, "");
        assertEq(rules.getRule(id).fires, 0);

        vm.prank(keeper);
        rules.fire{gas: 300_000}(id, "");
        assertEq(rules.getRule(id).fires, 1);
        assertEq(imd.balanceOf(payee), PAY_AMOUNT);
    }

    // ---- VIEW targets that misbehave: the rule only does not fire ----

    function _puppetRule() internal returns (uint256 id) {
        Rules.Condition memory c = _rawCond(address(puppet), hex"12345678", 1, 100);
        vm.prank(creator);
        id = rules.createRule(_payParams(c, 0, 1), "", 10e18);
    }

    function _assertDoesNotFire(uint256 id) internal {
        (bool met, uint256 value, uint64 round) = rules.check(id);
        assertFalse(met);
        assertEq(value, 0);
        assertEq(round, 0);
        assertFalse(rules.canFire(id));
        vm.prank(keeper);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");
        assertEq(_escrow(id), 10e18);
    }

    function test_fire_view_aTargetThatRevertsOnlyStopsTheRule() public {
        uint256 id = _puppetRule();
        puppet.puppetSet(puppet.REVERT(), "");
        _assertDoesNotFire(id);
    }

    function test_fire_view_aTargetThatBurnsItsGasOnlyStopsTheRule() public {
        uint256 id = _puppetRule();
        puppet.puppetSet(puppet.SPIN(), "");
        uint256 gasBefore = gasleft();
        (bool met,,) = rules.check(id);
        uint256 used = gasBefore - gasleft();
        assertFalse(met);
        assertLt(used, 130_000, "the read is capped");
        emit log_named_uint("gas: check() against a target that spins", used);
        _assertDoesNotFire(id);
    }

    function test_fire_view_aTargetThatAnswersWithTooFewBytesOnlyStopsTheRule() public {
        uint256 id = _puppetRule();
        puppet.puppetSet(puppet.ANSWER(), "");
        _assertDoesNotFire(id);
        // 31 bytes of 0xff would read as a huge number if the length were not checked.
        bytes memory short = new bytes(31);
        for (uint256 i; i < 31; ++i) {
            short[i] = 0xff;
        }
        puppet.puppetSet(puppet.ANSWER(), short);
        _assertDoesNotFire(id);
    }

    function test_fire_view_aTargetThatTriesToWriteOnlyStopsTheRule() public {
        uint256 id = _puppetRule();
        puppet.puppetSet(puppet.WRITE(), abi.encode(uint256(500)));
        _assertDoesNotFire(id);
    }

    function test_fire_view_aTargetWithoutCodeOnlyStopsTheRule() public {
        Rules.Condition memory c = _rawCond(address(0xE0A), hex"12345678", 1, 0);
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(c, 0, 1), "", 10e18);
        _assertDoesNotFire(id);
    }

    function test_fire_view_exactly32BytesIsEnough() public {
        uint256 id = _puppetRule();
        puppet.puppetSet(puppet.ANSWER(), abi.encode(uint256(100)));
        (bool met, uint256 value,) = rules.check(id);
        assertTrue(met);
        assertEq(value, 100);
        _fire(id);
    }

    function test_fire_view_aVeryLongAnswerIsReadByItsFirstWordOnly() public {
        Flood flood = new Flood();
        Rules.Condition memory c = _rawCond(address(flood), hex"12345678", 5, 100);
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(c, 0, 1), "", 10e18);
        uint256 gasBefore = gasleft();
        (bool met, uint256 value,) = rules.check(id);
        uint256 used = gasBefore - gasleft();
        assertTrue(met);
        assertEq(value, 100);
        assertLt(used, 60_000, "the 64 KB answer is not copied");
        _fire(id);
    }

    // ---- FEED ----

    function _feedRule(uint8 cmp, uint256 threshold, uint32 maxAge, uint32 cooldown, uint32 maxFires)
        internal
        returns (uint256 id)
    {
        vm.prank(creator);
        id = rules.createRule(_payParams(_feedCond(cmp, threshold, maxAge), cooldown, maxFires), "", 50e18);
    }

    function test_feed_theMockAnswersTheFrozenSelector() public pure {
        assertEq(MockFeed.latest.selector, IQuestions.latest.selector);
    }

    function test_fire_feed_firesOnAFreshAnswer() public {
        uint256 id = _feedRule(1, 1_000, 1 days, 0, 5);
        feed.push(FEED_ID, 1_500);
        skip(1 hours);

        (bool met, uint256 value, uint64 round) = rules.check(id);
        assertTrue(met);
        assertEq(value, 1_500);
        assertEq(round, 1);

        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.Fired(id, keeper, 1, 1_500, 1, 0, PAY_AMOUNT, TIP);
        _fire(id);
        assertEq(rules.getRule(id).lastRound, 1);
    }

    function test_fire_feed_doesNotFireBeforeAnyAnswer() public {
        uint256 id = _feedRule(2, type(uint256).max, 1 days, 0, 5);
        (bool met, uint256 value, uint64 round) = rules.check(id);
        assertFalse(met, "a feed with no round has no answer, whatever zero compares to");
        assertEq(value, 0);
        assertEq(round, 0);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");
    }

    function test_fire_feed_firesOncePerRound() public {
        uint256 id = _feedRule(1, 1_000, 1 days, 0, 5);
        feed.push(FEED_ID, 1_500);
        _fire(id);

        // Same answer, no cooldown, fires left, escrow left: only the round holds it back.
        (bool met, uint256 value, uint64 round) = rules.check(id);
        assertFalse(met);
        assertEq(value, 1_500);
        assertEq(round, 0);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");

        feed.push(FEED_ID, 1_600);
        _fire(id);
        assertEq(rules.getRule(id).lastRound, 2);
        assertEq(rules.getRule(id).fires, 2);
    }

    function test_fire_feed_aNewRoundBelowTheLineDoesNotFire_andDoesNotUseTheRoundUp() public {
        uint256 id = _feedRule(1, 1_000, 1 days, 0, 5);
        feed.push(FEED_ID, 900);
        (bool met, uint256 value, uint64 round) = rules.check(id);
        assertFalse(met);
        assertEq(value, 900);
        assertEq(round, 1);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");
        assertEq(rules.getRule(id).lastRound, 0);
    }

    function test_fire_feed_respectsTheMaximumAge() public {
        uint256 id = _feedRule(1, 1_000, 1 days, 0, 5);
        feed.push(FEED_ID, 1_500);
        uint256 stamped = vm.getBlockTimestamp();

        vm.warp(stamped + 1 days);
        assertTrue(rules.canFire(id), "exactly at the limit is still fresh");
        vm.warp(stamped + 1 days + 1);
        assertFalse(rules.canFire(id));
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");

        vm.warp(stamped + 1 days);
        _fire(id);
    }

    function test_fire_feed_anAnswerStampedInTheFutureIsNotAnAnswer() public {
        uint256 id = _feedRule(1, 1_000, 1 days, 0, 5);
        feed.set(FEED_ID, 1_500, 1, uint64(vm.getBlockTimestamp() + 1));
        assertFalse(rules.canFire(id));
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");
        feed.set(FEED_ID, 1_500, 1, uint64(vm.getBlockTimestamp()));
        _fire(id);
    }

    function test_fire_feed_cooldownAndRoundBothApply() public {
        uint256 id = _feedRule(1, 1_000, 30 days, 1 days, 5);
        feed.push(FEED_ID, 1_500);
        _fire(id);
        uint256 readyAt = vm.getBlockTimestamp() + 1 days;

        skip(1 hours);
        feed.push(FEED_ID, 1_700);
        vm.expectRevert(abi.encodeWithSelector(Rules.CoolingDown.selector, readyAt));
        rules.fire(id, "");

        vm.warp(readyAt);
        _fire(id);
        assertEq(rules.getRule(id).lastRound, 2);
    }

    function test_fire_feed_hire() public {
        vm.prank(creator);
        uint256 id = rules.createRule(_hireParams(_feedCond(3, 10, 1 days), 0, 2), SPEC, 30e18);
        feed.push(FEED_ID, 11);
        uint256 orderId = _fire(id);
        assertEq(orderId, 1);
        (, address employer, uint96 escrow,,) = desk.accountOf(orderId);
        assertEq(employer, address(rules));
        assertEq(escrow, MAX_PAY);
    }

    // ---- FEED sources that misbehave ----

    function _puppetFeedRule() internal returns (uint256 id) {
        Rules.Condition memory c;
        c.kind = 2;
        c.cmp = 1;
        c.target = address(puppet);
        c.threshold = 100;
        c.feedId = FEED_ID;
        c.maxAge = 1 days;
        vm.prank(creator);
        id = rules.createRule(_payParams(c, 0, 3), "", 10e18);
    }

    function test_fire_feed_aSourceThatRevertsOnlyStopsTheRule() public {
        uint256 id = _puppetFeedRule();
        puppet.puppetSet(puppet.REVERT(), "");
        _assertDoesNotFire(id);
    }

    function test_fire_feed_aSourceThatBurnsItsGasOnlyStopsTheRule() public {
        uint256 id = _puppetFeedRule();
        puppet.puppetSet(puppet.SPIN(), "");
        uint256 gasBefore = gasleft();
        (bool met,,) = rules.check(id);
        assertFalse(met);
        assertLt(gasBefore - gasleft(), 130_000, "the read is capped");
        _assertDoesNotFire(id);
    }

    function test_fire_feed_aSourceWithoutCodeOnlyStopsTheRule() public {
        Rules.Condition memory c;
        c.kind = 2;
        c.cmp = 2;
        c.target = address(0xE0A);
        c.threshold = type(uint256).max;
        c.feedId = FEED_ID;
        c.maxAge = 1 days;
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(c, 0, 3), "", 10e18);
        _assertDoesNotFire(id);
    }

    function test_fire_feed_aShortAnswerOnlyStopsTheRule() public {
        uint256 id = _puppetFeedRule();
        // Four of the five words: the timestamp is missing.
        puppet.puppetSet(puppet.ANSWER(), abi.encode(uint256(500), uint256(1), uint256(2), uint256(1)));
        _assertDoesNotFire(id);
        // One byte short of five words.
        bytes memory full = abi.encode(uint256(500), uint256(1), uint256(2), uint256(1), vm.getBlockTimestamp());
        bytes memory short = new bytes(159);
        for (uint256 i; i < 159; ++i) {
            short[i] = full[i];
        }
        puppet.puppetSet(puppet.ANSWER(), short);
        _assertDoesNotFire(id);
        // The whole five words do fire, so the cases above failed for their length alone.
        puppet.puppetSet(puppet.ANSWER(), full);
        _fire(id);
    }

    function test_fire_feed_aRoundThatDoesNotFit64BitsOnlyStopsTheRule() public {
        uint256 id = _puppetFeedRule();
        puppet.puppetSet(
            puppet.ANSWER(), abi.encode(uint256(500), uint256(1), uint256(2), uint256(1) << 64, vm.getBlockTimestamp())
        );
        _assertDoesNotFire(id);
        puppet.puppetSet(
            puppet.ANSWER(), abi.encode(uint256(500), uint256(1), uint256(2), type(uint256).max, vm.getBlockTimestamp())
        );
        _assertDoesNotFire(id);
        // The largest round that does fit is accepted.
        puppet.puppetSet(
            puppet.ANSWER(),
            abi.encode(uint256(500), uint256(1), uint256(2), uint256(type(uint64).max), vm.getBlockTimestamp())
        );
        _fire(id);
        assertEq(rules.getRule(id).lastRound, type(uint64).max);
        // After which no later round exists, and the rule is done.
        assertFalse(rules.canFire(id));
    }

    function test_fire_feed_aTimestampWiderThan64BitsOnlyStopsTheRule() public {
        uint256 id = _puppetFeedRule();
        puppet.puppetSet(
            puppet.ANSWER(), abi.encode(uint256(500), uint256(1), uint256(2), uint256(1), uint256(1) << 200)
        );
        (bool met,,) = rules.check(id);
        assertFalse(met);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");
    }

    // ---- canFire ----

    function test_canFire_followsEveryGate() public {
        uint256 id = _createPayRule(1 hours, 2, PAY_AMOUNT + TIP);
        assertFalse(rules.canFire(id), "condition false");
        gauge.set(100);
        assertTrue(rules.canFire(id));
        _fire(id);
        assertFalse(rules.canFire(id), "cooling down");
        skip(1 hours);
        assertFalse(rules.canFire(id), "escrow short");
        vm.prank(creator);
        rules.topUp(id, PAY_AMOUNT + TIP);
        assertTrue(rules.canFire(id));
        _fire(id);
        skip(1 hours);
        assertFalse(rules.canFire(id), "exhausted");

        uint256 other = _createPayRule(0, 2, 50e18);
        assertTrue(rules.canFire(other));
        vm.prank(creator);
        rules.cancel(other);
        assertFalse(rules.canFire(other), "cancelled");
    }

    function test_fire_gas() public {
        uint256 payId = _createPayRule(0, 5, 50e18);
        uint256 hireId = _createHireRule(0, 5, 100e18);
        gauge.set(100);
        vm.prank(keeper);
        uint256 g = gasleft();
        rules.fire(payId, "");
        emit log_named_uint("gas: fire, VIEW then PAY", g - gasleft());
        vm.prank(keeper);
        g = gasleft();
        rules.fire(hireId, SPEC);
        emit log_named_uint("gas: fire, VIEW then HIRE (mock desk)", g - gasleft());
    }
}
