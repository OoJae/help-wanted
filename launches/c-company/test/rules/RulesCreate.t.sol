// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDeskLimits, Rules} from "../../src/rules/Rules.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {BareDesk} from "./mocks/BareDesk.sol";
import {MockDesk} from "./mocks/MockDesk.sol";
import {Gauge} from "./mocks/Targets.sol";
import {RulesBase} from "./RulesBase.sol";

/// @dev Creating a rule: what is stored, what is published, and every input that is refused.
contract RulesCreateTest is RulesBase {
    // ---- constructor ----

    function test_constructor_recordsItsTwoAddresses() public view {
        assertEq(address(rules.IMD()), address(imd));
        assertEq(address(rules.WORK_ORDERS()), address(desk));
        assertEq(rules.ruleCount(), 0);
        assertEq(rules.totalEscrowed(), 0);
    }

    function test_constructor_refusesZeroAddresses() public {
        vm.expectRevert(Rules.ZeroAddress.selector);
        new Rules(address(0), address(desk));
        vm.expectRevert(Rules.ZeroAddress.selector);
        new Rules(address(imd), address(0));
    }

    /// @dev Launch checks run constructors on an empty chain: neither address needs code behind it.
    function test_constructor_makesNoCallToItsArguments() public {
        Rules r = new Rules(address(0x1111), address(0x2222));
        assertEq(address(r.IMD()), address(0x1111));
        assertEq(address(r.WORK_ORDERS()), address(0x2222));
    }

    function test_constants() public view {
        assertEq(rules.COND_VIEW(), 1);
        assertEq(rules.COND_FEED(), 2);
        assertEq(rules.ACT_HIRE(), 1);
        assertEq(rules.ACT_PAY(), 2);
        assertEq(rules.CMP_GE(), 1);
        assertEq(rules.CMP_LE(), 2);
        assertEq(rules.CMP_GT(), 3);
        assertEq(rules.CMP_LT(), 4);
        assertEq(rules.CMP_EQ(), 5);
        assertEq(rules.CMP_NE(), 6);
        assertEq(rules.COND_GAS(), 100_000);
        assertEq(rules.MAX_COND_DATA(), 132);
        assertEq(rules.MAX_SPEC(), 7_900);
    }

    // ---- what is stored ----

    function test_createRule_viewHire_storesEverything() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(3, 777), 6 hours, 5);
        p.hire.runnerOnly = address(0xBEEF);
        p.hire.arbiter = address(0xA4B1);
        p.hire.flags = 3;

        vm.prank(creator);
        uint256 id = rules.createRule(p, SPEC, 50e18);

        assertEq(id, 1);
        assertEq(rules.ruleCount(), 1);
        assertEq(rules.totalEscrowed(), 50e18);
        assertEq(imd.balanceOf(address(rules)), 50e18);

        Rules.Rule memory r = rules.getRule(id);
        assertEq(r.creator, creator);
        assertEq(r.tip, TIP);
        assertEq(r.action, 1);
        assertFalse(r.cancelled);
        assertEq(r.cooldown, 6 hours);
        assertEq(r.maxFires, 5);
        assertEq(r.escrow, 50e18);
        assertEq(r.fires, 0);
        assertEq(r.lastFiredAt, 0);
        assertEq(r.lastRound, 0);
        assertEq(r.specHash, keccak256(SPEC));

        assertEq(r.when.kind, 1);
        assertEq(r.when.cmp, 3);
        assertEq(r.when.maxAge, 0);
        assertEq(r.when.target, address(gauge));
        assertEq(r.when.threshold, 777);
        assertEq(r.when.feedId, bytes32(0));
        assertEq(r.when.data, abi.encodeCall(gauge.value, ()));

        assertEq(r.hire.kindHash, KIND_AUDIT);
        assertEq(r.hire.minPay, 4e18);
        assertEq(r.hire.maxPay, MAX_PAY);
        assertEq(r.hire.rampSecs, 1 hours);
        assertEq(r.hire.deliverySecs, 7 days);
        assertEq(r.hire.bond, 0.5e18);
        assertEq(r.hire.runnerOnly, address(0xBEEF));
        assertEq(r.hire.arbiter, address(0xA4B1));
        assertEq(r.hire.flags, 3);
        assertEq(r.hire.orderTtl, 14 days);

        // The PAY half is not stored for a HIRE rule.
        assertEq(r.pay.recipient, address(0));
        assertEq(r.pay.amount, 0);

        assertEq(uint8(rules.statusOf(id)), uint8(Rules.Status.Armed));
        assertEq(rules.costOf(id), uint256(MAX_PAY) + TIP);
    }

    function test_createRule_feedPay_storesEverything() public {
        Rules.RuleParams memory p = _payParams(_feedCond(2, 1_000e18, 2 days), 1 days, 30);
        // Filled in but not the chosen action: ignored and not stored.
        p.hire = _hire();

        vm.prank(creator);
        uint256 id = rules.createRule(p, "", 9e18);

        Rules.Rule memory r = rules.getRule(id);
        assertEq(r.action, 2);
        assertEq(r.specHash, bytes32(0));
        assertEq(r.when.kind, 2);
        assertEq(r.when.cmp, 2);
        assertEq(r.when.maxAge, 2 days);
        assertEq(r.when.target, address(feed));
        assertEq(r.when.threshold, 1_000e18);
        assertEq(r.when.feedId, FEED_ID);
        assertEq(r.when.data.length, 0);
        assertEq(r.pay.recipient, payee);
        assertEq(r.pay.amount, PAY_AMOUNT);
        assertEq(r.hire.maxPay, 0);
        assertEq(r.hire.kindHash, bytes32(0));
        assertEq(rules.costOf(id), uint256(PAY_AMOUNT) + TIP);
    }

    function test_createRule_publishesParamsAndSpec() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.RuleCreated(1, creator, p, SPEC, 20e18);
        vm.prank(creator);
        rules.createRule(p, SPEC, 20e18);
    }

    function test_createRule_pullsExactlyTheDeposit() public {
        uint256 before = imd.balanceOf(creator);
        _createPayRule(0, 1, 7e18);
        assertEq(before - imd.balanceOf(creator), 7e18);
        assertEq(imd.balanceOf(address(rules)), 7e18);
    }

    function test_createRule_acceptsAZeroDeposit() public {
        uint256 id = _createPayRule(0, 1, 0);
        assertEq(_escrow(id), 0);
        assertEq(rules.totalEscrowed(), 0);
        assertFalse(rules.canFire(id));
    }

    function test_createRule_idsCountFromOne() public {
        assertEq(_createPayRule(0, 1, 1e18), 1);
        assertEq(_createHireRule(0, 1, 1e18), 2);
        assertEq(_createPayRule(0, 1, 1e18), 3);
        assertEq(rules.ruleCount(), 3);
        assertEq(rules.totalEscrowed(), 3e18);
    }

    function test_createRule_revertsWithoutAllowance() public {
        address poor = makeAddr("poor");
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        vm.prank(poor);
        vm.expectRevert();
        rules.createRule(p, "", 1e18);
        assertEq(rules.ruleCount(), 0);
    }

    function test_getRule_unknownIdIsAllZeros() public view {
        Rules.Rule memory r = rules.getRule(99);
        assertEq(r.creator, address(0));
        assertEq(r.escrow, 0);
        assertEq(uint8(rules.statusOf(99)), uint8(Rules.Status.None));
        assertEq(rules.costOf(99), 0);
        assertFalse(rules.canFire(99));
        (bool met, uint256 value, uint64 round) = rules.check(99);
        assertFalse(met);
        assertEq(value, 0);
        assertEq(round, 0);
    }

    // ---- conditions that are refused ----

    function test_createRule_refusesUnknownConditionKind() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.when.kind = 0;
        _expectCreateRevert(p, "", Rules.BadCondition.selector);
        p.when.kind = 3;
        _expectCreateRevert(p, "", Rules.BadCondition.selector);
    }

    function test_createRule_refusesUnknownComparison() public {
        Rules.RuleParams memory p = _payParams(_viewCond(0, 100), 0, 1);
        _expectCreateRevert(p, "", Rules.BadComparison.selector);
        p.when.cmp = 7;
        _expectCreateRevert(p, "", Rules.BadComparison.selector);
    }

    function test_createRule_refusesZeroTarget() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.when.target = address(0);
        _expectCreateRevert(p, "", Rules.ZeroAddress.selector);
    }

    function test_createRule_refusesZeroFires() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 0);
        _expectCreateRevert(p, "", Rules.ZeroFires.selector);
    }

    function test_createRule_refusesConditionDataLongerThanTheLimit() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.when.data = new bytes(133);
        _expectCreateRevert(p, "", Rules.BadConditionData.selector);
        p.when.data = new bytes(1_000);
        _expectCreateRevert(p, "", Rules.BadConditionData.selector);
    }

    /// @dev The limit is "at most 132 bytes": anything shorter is stored as given, down to nothing
    /// at all, which is how a target that answers plain calls is read.
    function test_createRule_acceptsShortestAndLongestConditionData() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        bytes[4] memory shorter = [bytes(hex""), hex"aa", hex"aabbcc", hex"aabbccdd"];
        for (uint256 i; i < shorter.length; ++i) {
            p.when.data = shorter[i];
            vm.prank(creator);
            uint256 shortId = rules.createRule(p, "", 0);
            assertEq(rules.getRule(shortId).when.data, shorter[i]);
        }
        p.when.data = abi.encodeCall(Gauge.sum4, (1, 2, 3, 4));
        assertEq(p.when.data.length, 132);
        vm.prank(creator);
        uint256 id = rules.createRule(p, "", 0);
        assertEq(rules.getRule(id).when.data, p.when.data);
    }

    function test_createRule_refusesFeedFieldsOnAViewCondition() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.when.feedId = FEED_ID;
        _expectCreateRevert(p, "", Rules.FieldNotUsed.selector);
        p.when.feedId = bytes32(0);
        p.when.maxAge = 1;
        _expectCreateRevert(p, "", Rules.FieldNotUsed.selector);
    }

    function test_createRule_refusesCalldataOnAFeedCondition() public {
        Rules.RuleParams memory p = _payParams(_feedCond(1, 100, 1 days), 0, 1);
        p.when.data = hex"aabbccdd";
        _expectCreateRevert(p, "", Rules.FieldNotUsed.selector);
    }

    function test_createRule_refusesAFeedConditionWithoutAMaximumAge() public {
        Rules.RuleParams memory p = _payParams(_feedCond(1, 100, 0), 0, 1);
        _expectCreateRevert(p, "", Rules.ZeroMaxAge.selector);
    }

    // ---- actions that are refused ----

    function test_createRule_refusesUnknownAction() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.action = 0;
        _expectCreateRevert(p, "", Rules.BadAction.selector);
        p.action = 3;
        _expectCreateRevert(p, "", Rules.BadAction.selector);
    }

    function test_createRule_pay_refusesBadRecipients() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.pay.recipient = address(0);
        _expectCreateRevert(p, "", Rules.BadRecipient.selector);
        // Paying the contract itself would leave the money with no rule to claim it.
        p.pay.recipient = address(rules);
        _expectCreateRevert(p, "", Rules.BadRecipient.selector);
    }

    function test_createRule_pay_refusesZeroAmount() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.pay.amount = 0;
        _expectCreateRevert(p, "", Rules.BadPay.selector);
    }

    function test_createRule_pay_refusesASpec() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        _expectCreateRevert(p, SPEC, Rules.FieldNotUsed.selector);
    }

    function test_createRule_hire_refusesBadPrices() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        p.hire.maxPay = 0;
        p.hire.minPay = 0;
        _expectCreateRevert(p, SPEC, Rules.BadPay.selector);
        p.hire.maxPay = 5e18;
        p.hire.minPay = 5e18 + 1;
        _expectCreateRevert(p, SPEC, Rules.BadPay.selector);
    }

    function test_createRule_hire_refusesZeroOrderLifetime() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        p.hire.orderTtl = 0;
        _expectCreateRevert(p, SPEC, Rules.ZeroTtl.selector);
    }

    function test_createRule_hire_refusesTermsBelowTheDesksMinimums() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        p.hire.bond = desk.MIN_BOND() - 1;
        _expectCreateRevert(p, SPEC, Rules.BelowDeskMinimum.selector);
        p.hire.bond = desk.MIN_BOND();
        p.hire.deliverySecs = desk.MIN_DELIVERY() - 1;
        _expectCreateRevert(p, SPEC, Rules.BelowDeskMinimum.selector);
        p.hire.deliverySecs = desk.MIN_DELIVERY();
        vm.prank(creator);
        rules.createRule(p, SPEC, 0);
    }

    /// @dev The desk caps the delivery time as well. A rule above the cap could never open its
    /// order, so it is refused when it is written.
    function test_createRule_hire_refusesADeliveryTimeAboveTheDesksMaximum() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        p.hire.deliverySecs = desk.MAX_DELIVERY() + 1;
        _expectCreateRevert(p, SPEC, Rules.AboveDeskMaximum.selector);
        p.hire.deliverySecs = type(uint32).max;
        _expectCreateRevert(p, SPEC, Rules.AboveDeskMaximum.selector);

        // Exactly at the cap the rule is accepted, and the desk agrees when it fires.
        p.hire.deliverySecs = desk.MAX_DELIVERY();
        vm.prank(creator);
        uint256 id = rules.createRule(p, SPEC, 30e18);
        gauge.set(100);
        uint256 orderId = _fire(id);
        assertEq(desk.paramsOf(orderId).deliverySecs, desk.MAX_DELIVERY());
    }

    /// @dev The cap is not in the frozen interface. Rules asks for it by the name the desk gives it.
    function test_createRule_hire_readsTheCapByTheDesksOwnSelector() public view {
        assertEq(IDeskLimits.MAX_DELIVERY.selector, desk.MAX_DELIVERY.selector);
        assertEq(IDeskLimits.MAX_DELIVERY.selector, bytes4(keccak256("MAX_DELIVERY()")));
    }

    /// @dev A desk that publishes only what the frozen interface lists: there is no cap to read, and
    /// a HIRE rule can still be written. Everything else is checked as usual.
    function test_createRule_hire_aDeskThatPublishesNoMaximumIsNotAnObstacle() public {
        BareDesk bare = new BareDesk();
        Rules onBare = new Rules(address(imd), address(bare));
        vm.prank(creator);
        imd.approve(address(onBare), type(uint256).max);

        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        p.hire.deliverySecs = 400 days;
        vm.prank(creator);
        uint256 id = onBare.createRule(p, SPEC, 1e18);
        assertEq(onBare.getRule(id).hire.deliverySecs, 400 days);

        p.hire.deliverySecs = bare.MIN_DELIVERY() - 1;
        vm.prank(creator);
        vm.expectRevert(Rules.BelowDeskMinimum.selector);
        onBare.createRule(p, SPEC, 0);
        p.hire.deliverySecs = 400 days;
        p.hire.flags = 4;
        vm.prank(creator);
        vm.expectRevert(Rules.BadFlags.selector);
        onBare.createRule(p, SPEC, 0);
    }

    /// @dev The desk refuses a flag byte above 7, and its third bit (4) on an order that has no
    /// condition. A rule's orders never have one, so only 0 to 3 can ever open an order. Any other
    /// value is refused when the rule is written: accepted, the rule would take a deposit, report
    /// `canFire`, and never fire.
    function test_createRule_hire_refusesFlagsTheDeskRefuses() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        for (uint256 flags = 4; flags < 256; ++flags) {
            p.hire.flags = uint8(flags);
            vm.prank(creator);
            vm.expectRevert(Rules.BadFlags.selector);
            rules.createRule(p, SPEC, 30e18);
        }
        assertEq(rules.ruleCount(), 0);
        assertEq(imd.balanceOf(address(rules)), 0);
    }

    /// @dev The four values that are left are each accepted and each open an order on a desk that
    /// applies the real desk's flag rule.
    function test_createRule_hire_everyFlagValueItAcceptsCanFire() public {
        gauge.set(100);
        for (uint8 flags; flags < 4; ++flags) {
            Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
            p.hire.flags = flags;
            vm.prank(creator);
            uint256 id = rules.createRule(p, SPEC, 30e18);
            assertTrue(rules.canFire(id));
            uint256 orderId = _fire(id);
            assertEq(desk.paramsOf(orderId).flags, flags);
        }
    }

    /// @dev The mock applies the flag rule itself, so the two tests above would fail if Rules let a
    /// refused value through. Shown here directly against the desk.
    function test_mockDesk_refusesTheFlagsTheRealDeskRefuses() public {
        imd.mint(address(this), 100e18);
        imd.approve(address(desk), type(uint256).max);
        IWorkOrders.OrderParams memory o = _directOrder();
        uint8[4] memory refused = [uint8(4), 6, 8, 255];
        for (uint256 i; i < refused.length; ++i) {
            o.flags = refused[i];
            vm.expectRevert(MockDesk.BadFlags.selector);
            desk.createOrder(o, SPEC);
        }
        // With a condition the third bit is allowed, as on the real desk.
        o.flags = 4;
        o.condTarget = address(gauge);
        o.condCmp = 1;
        desk.createOrder(o, SPEC);
    }

    /// @dev The stand-in desk refuses an order for each reason the real desk does, in the real
    /// desk's order and with the real desk's errors. What Rules is tested against here is therefore
    /// what it will meet: a rule that the stand-in lets fire is not one the desk would turn away.
    function test_mockDesk_refusesAnOrderForEachReasonTheRealDeskDoes() public {
        imd.mint(address(this), 100e18);
        imd.approve(address(desk), type(uint256).max);
        IWorkOrders.OrderParams memory o = _directOrder();

        // The spec comes first, and names the position at fault.
        vm.expectRevert(abi.encodeWithSelector(MockDesk.SpecInvalid.selector, 0));
        desk.createOrder(o, "");
        vm.expectRevert(abi.encodeWithSelector(MockDesk.SpecInvalid.selector, 7_900));
        desk.createOrder(o, _filled(7_901));
        vm.expectRevert(abi.encodeWithSelector(MockDesk.SpecInvalid.selector, 0));
        desk.createOrder(o, " lead");
        vm.expectRevert(abi.encodeWithSelector(MockDesk.SpecInvalid.selector, 4));
        desk.createOrder(o, "tail ");
        vm.expectRevert(abi.encodeWithSelector(MockDesk.SpecInvalid.selector, 2));
        desk.createOrder(o, 'ab"c ');

        o.maxPay = 0;
        vm.expectRevert(MockDesk.PayRange.selector);
        desk.createOrder(o, SPEC);
        o.maxPay = 10e18;
        o.minPay = 10e18 + 1;
        vm.expectRevert(MockDesk.PayRange.selector);
        desk.createOrder(o, SPEC);
        o.minPay = 0;

        o.deliverySecs = 3 days - 1;
        vm.expectRevert(MockDesk.DeliveryTooShort.selector);
        desk.createOrder(o, SPEC);
        o.deliverySecs = 90 days + 1;
        vm.expectRevert(MockDesk.DeliveryTooLong.selector);
        desk.createOrder(o, SPEC);
        o.deliverySecs = 90 days;

        o.bond = 0.25e18 - 1;
        vm.expectRevert(MockDesk.BondTooLow.selector);
        desk.createOrder(o, SPEC);
        o.bond = 0.25e18;

        o.expiresAt = uint40(vm.getBlockTimestamp());
        vm.expectRevert(MockDesk.Expired.selector);
        desk.createOrder(o, SPEC);
        o.expiresAt = uint40(vm.getBlockTimestamp() + 1);

        o.condCmp = 1; // a comparison without a condition target
        vm.expectRevert(MockDesk.BadCondition.selector);
        desk.createOrder(o, SPEC);
        o.condTarget = address(gauge);
        o.condCmp = 0; // a condition target without a comparison
        vm.expectRevert(MockDesk.BadCondition.selector);
        desk.createOrder(o, SPEC);
        o.condCmp = 7;
        vm.expectRevert(MockDesk.BadCondition.selector);
        desk.createOrder(o, SPEC);
        o.condTarget = address(0);
        o.condCmp = 0;

        // Every limit at once is accepted, and only the employer may withdraw the order.
        uint256 id = desk.createOrder(o, SPEC);
        vm.prank(stranger);
        vm.expectRevert(MockDesk.NotEmployer.selector);
        desk.cancel(id);
        desk.cancel(id);
        vm.expectRevert(MockDesk.BadState.selector);
        desk.cancel(id);
        vm.expectRevert(MockDesk.BadState.selector);
        desk.refund(id);
    }

    /// @dev One fire may not cost more than an escrow (a uint96) can hold: such a rule could be
    /// funded by nobody.
    function test_createRule_refusesACostNoEscrowCanHold() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.pay.amount = type(uint96).max;
        p.tip = 1;
        _expectCreateRevert(p, "", Rules.CostTooHigh.selector);

        Rules.RuleParams memory h = _hireParams(_viewCond(1, 100), 0, 1);
        h.hire.maxPay = type(uint96).max - 5;
        h.tip = 6;
        _expectCreateRevert(h, SPEC, Rules.CostTooHigh.selector);

        // Exactly the largest escrow is still a rule somebody could, in principle, fund.
        p.pay.amount = type(uint96).max - 1;
        p.tip = 1;
        vm.prank(creator);
        uint256 id = rules.createRule(p, "", 0);
        assertEq(rules.costOf(id), type(uint96).max);
    }

    /// @dev A HIRE rule needs a live desk to be written at all; a PAY rule never touches the desk.
    function test_createRule_hire_revertsWhenTheDeskHasNoCode_butPayStillWorks() public {
        Rules lonely = new Rules(address(imd), address(0xD35C));
        vm.prank(creator);
        imd.approve(address(lonely), type(uint256).max);

        Rules.RuleParams memory h = _hireParams(_viewCond(1, 100), 0, 1);
        vm.prank(creator);
        vm.expectRevert();
        lonely.createRule(h, SPEC, 0);

        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        vm.prank(creator);
        uint256 id = lonely.createRule(p, "", 3e18);
        gauge.set(100);
        vm.prank(keeper);
        lonely.fire(id, "");
        assertEq(imd.balanceOf(payee), PAY_AMOUNT);
    }

    // ---- specs that are refused ----

    function test_createRule_hire_refusesAnEmptySpec() public {
        _expectSpecRevert("", 0);
    }

    function test_createRule_hire_refusesASpecThatIsTooLong() public {
        bytes memory spec = _filled(7_901);
        _expectSpecRevert(spec, 7_900);
    }

    function test_createRule_hire_acceptsTheLongestSpec() public {
        bytes memory spec = _filled(7_900);
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        vm.prank(creator);
        uint256 gasBefore = gasleft();
        uint256 id = rules.createRule(p, spec, 20e18);
        emit log_named_uint("gas: createRule with a 7,900 byte spec", gasBefore - gasleft());
        assertEq(rules.getRule(id).specHash, keccak256(spec));
        // And the desk agrees: the rule can hire with it.
        gauge.set(100);
        vm.prank(keeper);
        uint256 orderId = rules.fire(id, spec);
        assertEq(desk.specHashOf(orderId), keccak256(spec));
    }

    function test_createRule_hire_refusesLeadingAndTrailingSpaces() public {
        _expectSpecRevert(" audit this", 0);
        _expectSpecRevert("audit this ", 10);
        _expectSpecRevert(" ", 0);
    }

    /// @dev The position reported is the one the desk itself reports: the lowest index at fault. A
    /// space at the end is named only when nothing before it is wrong.
    function test_createRule_hire_reportsTheLowestPositionAtFault() public {
        _expectSpecRevert('audit "this" ', 6);
        _expectSpecRevert(unicode"é audit this ", 0);
        _expectSpecRevert(" audit this ", 0);
        // The same across a word boundary: the fault is in the first word, the space ends the second.
        bytes memory long = _filled(50);
        long[49] = " ";
        _expectSpecRevert(long, 49);
        long[7] = 0x7f;
        _expectSpecRevert(long, 7);
    }

    function test_createRule_hire_refusesQuoteBackslashAndNonPrintableBytes() public {
        _expectSpecRevert('say "hello"', 4);
        _expectSpecRevert("path\\to", 4);
        _expectSpecRevert("line\nbreak", 4);
        _expectSpecRevert(hex"61007a", 1);
        _expectSpecRevert(hex"617f7a", 1);
        _expectSpecRevert(unicode"café", 3);
    }

    /// @dev Every refused byte value, at every position of a spec that spans three 32-byte words
    /// with a part-filled last one. The position reported is the position planted.
    function test_createRule_hire_findsARefusedByteAtEveryPosition() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        bytes1[9] memory refused = [bytes1(0x00), 0x09, 0x1f, 0x22, 0x5c, 0x7f, 0x80, 0xc3, 0xff];
        for (uint256 at; at < 70; ++at) {
            for (uint256 k; k < refused.length; ++k) {
                bytes memory spec = _filled(70);
                spec[at] = refused[k];
                assertFalse(desk.specOk(spec));
                vm.prank(creator);
                vm.expectRevert(abi.encodeWithSelector(Rules.SpecInvalid.selector, at));
                rules.createRule(p, spec, 0);
            }
        }
        // Two faults: the first one is reported.
        bytes memory two = _filled(70);
        two[40] = 0x22;
        two[33] = 0x5c;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Rules.SpecInvalid.selector, 33));
        rules.createRule(p, two, 0);
    }

    function test_createRule_hire_acceptsSpecsOfEveryLengthAroundTheWordSize() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        for (uint256 n = 1; n <= 100; ++n) {
            bytes memory spec = _filled(n);
            vm.prank(creator);
            uint256 id = rules.createRule(p, spec, 0);
            assertEq(rules.getRule(id).specHash, keccak256(spec));
        }
    }

    /// @dev Calldata pads a spec to a whole word. Whatever sits in that padding is not the spec and
    /// must not be read as part of it, even when it is not zeros.
    function test_createRule_hire_ignoresBytesBeyondTheSpec() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        bytes memory spec = _filled(45); // 19 bytes of padding follow it, at the very end of the call
        bytes memory call = abi.encodeCall(Rules.createRule, (p, spec, 0));
        bytes1[4] memory junk = [bytes1(0x22), 0x5c, 0xff, 0x00];
        for (uint256 k; k < junk.length; ++k) {
            for (uint256 i = call.length - 19; i < call.length; ++i) {
                call[i] = junk[k];
            }
            vm.prank(creator);
            (bool ok, bytes memory out) = address(rules).call(call);
            assertTrue(ok, "padding was read as part of the spec");
            uint256 id = abi.decode(out, (uint256));
            assertEq(rules.getRule(id).specHash, keccak256(spec));
        }
    }

    function test_createRule_hire_acceptsEveryAllowedByte() public {
        // 0x20..0x7e without 0x22 and 0x5c, wrapped so it neither starts nor ends with a space.
        bytes memory spec = new bytes(95);
        uint256 n;
        spec[n++] = "a";
        for (uint8 ch = 0x20; ch <= 0x7e; ch++) {
            if (ch == 0x22 || ch == 0x5c) continue;
            spec[n++] = bytes1(ch);
        }
        spec[n++] = "z";
        assertEq(n, 95);
        assertTrue(desk.specOk(spec));
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        vm.prank(creator);
        rules.createRule(p, spec, 0);
    }

    // ---- helpers ----

    function _expectCreateRevert(Rules.RuleParams memory p, bytes memory spec, bytes4 selector) internal {
        vm.prank(creator);
        vm.expectRevert(selector);
        rules.createRule(p, spec, 1e18);
        assertEq(rules.ruleCount(), 0);
        assertEq(imd.balanceOf(address(rules)), 0);
    }

    function _expectSpecRevert(bytes memory spec, uint256 at) internal {
        assertFalse(desk.specOk(spec), "the desk would accept this spec");
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Rules.SpecInvalid.selector, at));
        rules.createRule(p, spec, 1e18);
    }

    function _directOrder() internal view returns (IWorkOrders.OrderParams memory o) {
        o.maxPay = 10e18;
        o.bond = 0.25e18;
        o.deliverySecs = 3 days;
        o.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);
    }

    function _filled(uint256 n) internal pure returns (bytes memory spec) {
        spec = new bytes(n);
        for (uint256 i; i < n; ++i) {
            spec[i] = "x";
        }
    }
}
