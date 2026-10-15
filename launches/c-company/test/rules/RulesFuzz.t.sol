// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Rules} from "../../src/rules/Rules.sol";
import {MockDesk} from "./mocks/MockDesk.sol";
import {RulesBase} from "./RulesBase.sol";

/// @dev Fuzz tests for the arithmetic and the parsers: comparisons, the spec character rule, the
/// condition readers against arbitrary answers, and the per-rule sums.
contract RulesFuzzTest is RulesBase {
    function _reference(uint8 cmp, uint256 value, uint256 threshold) internal pure returns (bool) {
        if (cmp == 1) return value >= threshold;
        if (cmp == 2) return value <= threshold;
        if (cmp == 3) return value > threshold;
        if (cmp == 4) return value < threshold;
        if (cmp == 5) return value == threshold;
        return value != threshold;
    }

    function testFuzz_view_comparisonMatchesTheReference(uint8 cmp, uint256 value, uint256 threshold) public {
        cmp = uint8(bound(cmp, 1, 6));
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(_viewCond(cmp, threshold), 0, 1), "", 10e18);
        gauge.set(value);
        (bool met, uint256 read, uint64 round) = rules.check(id);
        assertEq(met, _reference(cmp, value, threshold));
        assertEq(read, value);
        assertEq(round, 0);
        assertEq(rules.canFire(id), met);
    }

    /// @dev Values near the threshold, where the six comparisons differ from each other.
    function testFuzz_view_comparisonAtTheLine(uint8 cmp, uint256 threshold, uint8 offset) public {
        cmp = uint8(bound(cmp, 1, 6));
        threshold = bound(threshold, 1, type(uint256).max - 1);
        uint256 value = threshold - 1 + (offset % 3);
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(_viewCond(cmp, threshold), 0, 1), "", 10e18);
        gauge.set(value);
        (bool met,,) = rules.check(id);
        assertEq(met, _reference(cmp, value, threshold));
    }

    /// @dev Whatever a target answers, reading it never reverts, and the rule is met exactly when
    /// the answer has a first word and that word compares true.
    function testFuzz_view_anyAnswer(bytes memory answer, uint8 cmp, uint256 threshold) public {
        cmp = uint8(bound(cmp, 1, 6));
        vm.assume(answer.length <= 600);
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(_rawCond(address(puppet), hex"12345678", cmp, threshold), 0, 1), "", 0);
        puppet.puppetSet(puppet.ANSWER(), answer);

        (bool met, uint256 value, uint64 round) = rules.check(id);

        if (answer.length < 32) {
            assertFalse(met);
            assertEq(value, 0);
        } else {
            uint256 word;
            assembly {
                word := mload(add(answer, 0x20))
            }
            assertEq(value, word);
            assertEq(met, _reference(cmp, word, threshold));
        }
        assertEq(round, 0);
    }

    /// @dev The same for a feed source: five arbitrary words never revert the reader, and the rule
    /// is met exactly when the round and the timestamp are usable and the value compares true.
    function testFuzz_feed_anyAnswer(
        uint256 value,
        uint256 round,
        uint256 updatedAt,
        uint8 cmp,
        uint256 threshold,
        uint32 maxAge,
        bool narrow
    ) public {
        cmp = uint8(bound(cmp, 1, 6));
        maxAge = uint32(bound(maxAge, 1, type(uint32).max));
        if (narrow) {
            // Half the runs stay near the usable range, where the interesting edges are.
            round = bound(round, 0, 3);
            uint256 nowTs = vm.getBlockTimestamp();
            uint256 span = 2 * uint256(maxAge) + 2;
            updatedAt = bound(updatedAt, span > nowTs ? 0 : nowTs - span, nowTs + 2);
        }
        Rules.Condition memory c;
        c.kind = 2;
        c.cmp = cmp;
        c.target = address(puppet);
        c.threshold = threshold;
        c.feedId = FEED_ID;
        c.maxAge = maxAge;
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(c, 0, 1), "", 0);
        puppet.puppetSet(puppet.ANSWER(), abi.encode(value, uint256(1), uint256(2), round, updatedAt));

        (bool met, uint256 read, uint64 readRound) = rules.check(id);

        bool usable = round != 0 && round <= type(uint64).max;
        bool fresh = updatedAt <= vm.getBlockTimestamp() && vm.getBlockTimestamp() - updatedAt <= maxAge;
        assertEq(read, usable ? value : 0);
        assertEq(readRound, usable && fresh ? round : 0);
        assertEq(met, usable && fresh && _reference(cmp, value, threshold));
    }

    function testFuzz_feed_answerLength(uint16 length) public {
        length = uint16(bound(length, 0, 400));
        Rules.Condition memory c;
        c.kind = 2;
        c.cmp = 1;
        c.target = address(puppet);
        c.threshold = 0;
        c.feedId = FEED_ID;
        c.maxAge = 1 days;
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(c, 0, 1), "", 0);

        bytes memory full =
            abi.encode(uint256(7), uint256(1), uint256(2), uint256(1), vm.getBlockTimestamp(), uint256(0));
        bytes memory answer = new bytes(length);
        for (uint256 i; i < length; ++i) {
            answer[i] = i < full.length ? full[i] : bytes1(0xff);
        }
        puppet.puppetSet(puppet.ANSWER(), answer);
        (bool met,,) = rules.check(id);
        assertEq(met, length >= 160, "five whole words are needed, and are enough");
    }

    function testFuzz_feed_freshnessAndRound(uint32 maxAge, uint32 age, uint64 lastRound, uint64 round) public {
        maxAge = uint32(bound(maxAge, 1, 365 days));
        age = uint32(bound(age, 0, 2 * uint256(maxAge)));
        lastRound = uint64(bound(lastRound, 1, type(uint64).max - 1));
        vm.prank(creator);
        uint256 id = rules.createRule(_payParams(_feedCond(1, 1, maxAge), 0, 2), "", 50e18);

        // Fire once on `lastRound` so the rule remembers it.
        feed.set(FEED_ID, 5, lastRound, uint64(vm.getBlockTimestamp()));
        _fire(id);
        assertEq(rules.getRule(id).lastRound, lastRound);

        uint256 stamped = vm.getBlockTimestamp();
        feed.set(FEED_ID, 5, round, uint64(stamped));
        vm.warp(stamped + age);
        bool expected = round > lastRound && age <= maxAge;
        assertEq(rules.canFire(id), expected);
        if (expected) {
            _fire(id);
            assertEq(rules.getRule(id).lastRound, round);
        } else {
            vm.expectRevert(Rules.ConditionNotMet.selector);
            rules.fire(id, "");
        }
    }

    function testFuzz_cooldown(uint32 cooldown, uint32 wait) public {
        cooldown = uint32(bound(cooldown, 0, 400 days));
        wait = uint32(bound(wait, 0, 800 days));
        uint256 id = _createPayRule(cooldown, 2, 50e18);
        gauge.set(100);
        _fire(id);
        uint256 firedAt = vm.getBlockTimestamp();
        skip(wait);
        if (wait >= cooldown) {
            assertTrue(rules.canFire(id));
            _fire(id);
            assertEq(rules.getRule(id).fires, 2);
        } else {
            assertFalse(rules.canFire(id));
            vm.expectRevert(abi.encodeWithSelector(Rules.CoolingDown.selector, firedAt + cooldown));
            rules.fire(id, "");
        }
    }

    function testFuzz_conditionDataLength(uint16 length) public {
        length = uint16(bound(length, 0, 300));
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.when.data = new bytes(length);
        vm.prank(creator);
        if (length > 132) {
            vm.expectRevert(Rules.BadConditionData.selector);
            rules.createRule(p, "", 0);
        } else {
            uint256 id = rules.createRule(p, "", 0);
            assertEq(rules.getRule(id).when.data.length, length);
        }
    }

    /// @dev Rules accepts a spec exactly when the desk would. The desk's rule is written a second
    /// time, independently, in the mock.
    function testFuzz_spec_arbitraryBytesAgreeWithTheDesk(bytes memory spec) public {
        vm.assume(spec.length <= 400);
        _assertSpecAgrees(spec);
    }

    /// @dev Mostly valid text with one byte or one end disturbed, so both outcomes are exercised.
    function testFuzz_spec_nearlyValidTextAgreesWithTheDesk(uint256 seed, uint16 length, uint16 at, uint8 planted)
        public
    {
        length = uint16(bound(length, 1, 300));
        bytes memory spec = new bytes(length);
        for (uint256 i; i < length; ++i) {
            uint8 ch = uint8(0x21 + uint256(keccak256(abi.encode(seed, i))) % 94);
            if (ch == 0x22 || ch == 0x5c) ch = 0x41;
            spec[i] = bytes1(ch);
        }
        assertTrue(desk.specOk(spec));
        _assertSpecAgrees(spec);
        spec[at % length] = bytes1(planted);
        _assertSpecAgrees(spec);
    }

    function testFuzz_spec_lengthLimit(uint16 length) public {
        length = uint16(bound(length, 7_890, 7_910));
        bytes memory spec = new bytes(length);
        for (uint256 i; i < length; ++i) {
            spec[i] = "k";
        }
        _assertSpecAgrees(spec);
    }

    function _assertSpecAgrees(bytes memory spec) internal {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        bool deskAccepts = desk.specOk(spec);
        vm.prank(creator);
        try rules.createRule(p, spec, 0) returns (uint256 id) {
            assertTrue(deskAccepts, "Rules accepted a spec the desk refuses");
            assertEq(rules.getRule(id).specHash, keccak256(spec));
        } catch (bytes memory why) {
            assertFalse(deskAccepts, "Rules refused a spec the desk accepts");
            assertEq(why, abi.encodeWithSelector(Rules.SpecInvalid.selector, _firstFault(spec)), "wrong position");
            // The same bytes the desk itself reverts with for this spec.
            assertEq(why, abi.encodeWithSelector(MockDesk.SpecInvalid.selector, desk.firstBad(spec)), "not the desk's");
        }
    }

    /// @dev Where a refused spec is first at fault, worked out one byte at a time, as the hire desk
    /// reports it: the length, then the lowest index of a byte that is not allowed where it stands
    /// (a space at the start, a byte outside the alphabet anywhere, a space at the end).
    function _firstFault(bytes memory spec) internal pure returns (uint256) {
        uint256 n = spec.length;
        if (n == 0) return 0;
        if (n > 7_900) return 7_900;
        if (spec[0] == " ") return 0;
        for (uint256 i; i < n; ++i) {
            uint8 ch = uint8(spec[i]);
            if (ch < 0x20 || ch > 0x7e || ch == 0x22 || ch == 0x5c) return i;
        }
        if (spec[n - 1] == " ") return n - 1;
        revert("the spec has no fault");
    }

    /// @dev One refused byte planted anywhere in an otherwise valid spec of any length up to the
    /// limit: Rules names exactly that position. Covers every offset inside a 32-byte word, the word
    /// boundaries and the part-filled last word.
    function testFuzz_spec_oneRefusedByteIsFoundWhereItIs(uint16 length, uint16 at, uint8 kind) public {
        length = uint16(bound(length, 3, 7_900));
        at = uint16(bound(at, 1, length - 2)); // not an end: a space there is reported as an end fault
        bytes1 planted = [bytes1(0x00), 0x1f, 0x22, 0x5c, 0x7f, 0x80, 0xff, 0x0a][kind % 8];
        bytes memory spec = new bytes(length);
        for (uint256 i; i < length; ++i) {
            spec[i] = bytes1(uint8(0x61 + i % 26));
        }
        _assertSpecAgrees(spec);
        spec[at] = planted;
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Rules.SpecInvalid.selector, uint256(at)));
        rules.createRule(p, spec, 0);
        // A space in the middle is allowed.
        spec[at] = " ";
        _assertSpecAgrees(spec);
    }

    /// @dev Any flag byte: Rules accepts exactly the values the desk would open an order with.
    function testFuzz_hire_flagsAgreeWithTheDesk(uint8 flags) public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        p.hire.flags = flags;
        gauge.set(100);
        vm.prank(creator);
        if (flags > 3) {
            vm.expectRevert(Rules.BadFlags.selector);
            rules.createRule(p, SPEC, 30e18);
        } else {
            uint256 id = rules.createRule(p, SPEC, 30e18);
            assertEq(desk.paramsOf(_fire(id)).flags, flags);
        }
    }

    /// @dev Any delivery time: Rules accepts exactly those inside the desk's two limits, and a rule
    /// it accepts opens its order.
    function testFuzz_hire_deliveryTimeAgreesWithTheDesk(uint32 deliverySecs, bool nearALimit) public {
        // Read before the prank: a prank is used up by the next call of any kind.
        uint256 least = desk.MIN_DELIVERY();
        uint256 most = desk.MAX_DELIVERY();
        if (nearALimit) {
            uint256 around = deliverySecs % 2 == 0 ? least : most;
            deliverySecs = uint32(bound(deliverySecs, around - 2, around + 2));
        }
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        p.hire.deliverySecs = deliverySecs;
        gauge.set(100);
        vm.prank(creator);
        if (deliverySecs < least) {
            vm.expectRevert(Rules.BelowDeskMinimum.selector);
            rules.createRule(p, SPEC, 30e18);
        } else if (deliverySecs > most) {
            vm.expectRevert(Rules.AboveDeskMaximum.selector);
            rules.createRule(p, SPEC, 30e18);
        } else {
            uint256 id = rules.createRule(p, SPEC, 30e18);
            assertEq(desk.paramsOf(_fire(id)).deliverySecs, deliverySecs);
        }
    }

    /// @dev Any amount and tip: a rule is accepted exactly when one fire fits an escrow.
    function testFuzz_costMustFitAnEscrow(uint96 amount, uint96 tip) public {
        amount = uint96(bound(amount, 1, type(uint96).max));
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.pay.amount = amount;
        p.tip = tip;
        vm.prank(creator);
        if (uint256(amount) + tip > type(uint96).max) {
            vm.expectRevert(Rules.CostTooHigh.selector);
            rules.createRule(p, "", 0);
        } else {
            uint256 id = rules.createRule(p, "", 0);
            assertEq(rules.costOf(id), uint256(amount) + tip);
        }
    }

    /// @dev A PAY rule fired as often as it can be: every wei is the payee's, the caller's or still
    /// in the escrow.
    function testFuzz_pay_sumsAreExact(uint96 deposit, uint96 tip, uint96 amount, uint8 maxFires) public {
        deposit = uint96(bound(deposit, 0, 1_000_000e18));
        tip = uint96(bound(tip, 0, 1_000e18));
        amount = uint96(bound(amount, 1, 10_000e18));
        maxFires = uint8(bound(maxFires, 1, 12));

        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, maxFires);
        p.tip = tip;
        p.pay.amount = amount;
        vm.prank(creator);
        uint256 id = rules.createRule(p, "", deposit);
        gauge.set(100);

        uint256 cost = uint256(tip) + amount;
        uint256 expected = deposit / cost;
        if (expected > maxFires) expected = maxFires;
        uint256 fired;
        while (rules.canFire(id)) {
            _fire(id);
            ++fired;
        }
        assertEq(fired, expected);
        assertEq(imd.balanceOf(payee), fired * amount);
        assertEq(imd.balanceOf(keeper), fired * tip);
        assertEq(_escrow(id), deposit - fired * cost);
        assertEq(imd.balanceOf(address(rules)), deposit - fired * cost);
        assertEq(rules.totalEscrowed(), deposit - fired * cost);

        if (fired < maxFires) {
            vm.expectRevert(abi.encodeWithSelector(Rules.EscrowShort.selector, cost, deposit - fired * cost));
        } else {
            vm.expectRevert(abi.encodeWithSelector(Rules.RuleExhausted.selector, id));
        }
        rules.fire(id, "");
    }

    /// @dev A HIRE rule's order settled at any price: the price is gone, the tip is the caller's, and
    /// the rest is back in the rule.
    function testFuzz_hire_changeComesBackExactly(uint96 maxPay, uint96 price, uint96 tip, uint96 extra) public {
        maxPay = uint96(bound(maxPay, 1, 100_000e18));
        price = uint96(bound(price, 0, maxPay));
        tip = uint96(bound(tip, 0, 100e18));
        extra = uint96(bound(extra, 0, 100e18));

        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        p.hire.maxPay = maxPay;
        p.hire.minPay = 0;
        p.tip = tip;
        uint96 deposit = maxPay + tip + extra;
        vm.prank(creator);
        uint256 id = rules.createRule(p, SPEC, deposit);
        gauge.set(100);
        uint256 orderId = _fire(id);
        assertEq(_escrow(id), extra);

        desk.deliver(orderId, price, bytes16(uint128(1)));
        assertEq(rules.reconcile(id, orderId), maxPay - price);
        assertEq(_escrow(id), uint256(extra) + maxPay - price);
        assertEq(imd.balanceOf(address(rules)), rules.totalEscrowed());
        assertEq(imd.balanceOf(desk.SINK()), price);

        uint256 before = imd.balanceOf(creator);
        vm.prank(creator);
        rules.cancel(id);
        assertEq(imd.balanceOf(creator) - before, uint256(extra) + maxPay - price);
        assertEq(imd.balanceOf(address(rules)), 0);
    }

    /// @dev Two rules side by side with arbitrary deposits and top-ups: what one does never moves
    /// the other's escrow.
    function testFuzz_twoRulesNeverShareMoney(uint96 depositA, uint96 depositB, uint96 topUpA, uint8 firesA) public {
        depositA = uint96(bound(depositA, 0, 1_000e18));
        depositB = uint96(bound(depositB, 0, 1_000e18));
        topUpA = uint96(bound(topUpA, 1, 1_000e18));
        firesA = uint8(bound(firesA, 0, 6));

        uint256 a = _createPayRule(0, 6, depositA);
        uint256 b = _createHireRule(0, 6, depositB);
        gauge.set(100);
        vm.prank(stranger);
        rules.topUp(a, topUpA);

        uint256 expectedA = uint256(depositA) + topUpA;
        for (uint256 i; i < firesA; ++i) {
            if (!rules.canFire(a)) break;
            _fire(a);
            expectedA -= uint256(PAY_AMOUNT) + TIP;
        }
        assertEq(_escrow(a), expectedA);
        assertEq(_escrow(b), depositB);
        assertEq(rules.totalEscrowed(), expectedA + depositB);

        vm.prank(creator);
        rules.cancel(a);
        assertEq(_escrow(b), depositB);
        assertEq(imd.balanceOf(address(rules)), depositB);
    }
}
