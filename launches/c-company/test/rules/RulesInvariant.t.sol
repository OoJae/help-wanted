// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Rules} from "../../src/rules/Rules.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockDesk} from "./mocks/MockDesk.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {Gauge} from "./mocks/Targets.sol";

/// @dev Drives Rules through random sequences of everything its users, keepers and the desk can do,
/// and keeps its own books beside the contract's: what each rule's escrow should be, where every
/// wei went, and when each rule last fired.
contract RulesHandler is Test {
    Rules public immutable rules;
    MockIMD public immutable imd;
    MockDesk public immutable desk;
    MockFeed public immutable feed;
    Gauge public immutable gauge;

    address public constant KEEPER = address(0xCEE9E4);
    address public constant PAYEE = address(0x9A7EE);
    bytes32 public constant FEED_ID = keccak256("feed:invariant");
    bytes public constant SPEC =
        "Write a short report on the state of the vault. Inputs: vault=0x00000000000000000000000000000000000000aa; depth=short";

    address[3] public creators = [address(0xC1), address(0xC2), address(0xC3)];

    uint256[] public ruleIds;
    uint256[] public orderIds;

    // ---- the handler's own books ----

    /// @dev What each rule's escrow should be, worked out from the calls made, not read back.
    mapping(uint256 => uint256) public expectedEscrow;
    mapping(uint256 => uint256) public firesSeen;
    mapping(uint256 => uint256) public lastFireAt;
    mapping(uint256 => bool) public cancelledSeen;
    /// @dev Per order: the bonds the desk awarded and the price it paid out.
    mapping(uint256 => uint256) public awardedOf;
    mapping(uint256 => uint256) public spentOf;

    uint256 public paidIn; // deposits and top-ups
    uint256 public sentToDesk;
    uint256 public cameBackFromDesk; // tokens the desk really sent to Rules
    uint256 public toCreators; // cancel refunds and returns forwarded after a cancel
    uint256 public strays; // IMD sent to Rules by plain transfer

    bool public firedTooSoon;
    bool public firedTooOften;
    bool public escrowMismatchAfterCall;

    mapping(bytes32 => uint256) public calls;

    constructor(Rules rules_, MockIMD imd_, MockDesk desk_, MockFeed feed_, Gauge gauge_) {
        rules = rules_;
        imd = imd_;
        desk = desk_;
        feed = feed_;
        gauge = gauge_;
        for (uint256 i; i < 3; ++i) {
            imd.mint(creators[i], 10_000_000e18);
            vm.prank(creators[i]);
            imd.approve(address(rules), type(uint256).max);
        }
        imd.mint(address(this), 10_000_000e18);
        imd.approve(address(desk), type(uint256).max);
        gauge.set(150);
        feed.push(FEED_ID, 150);
    }

    function ruleCount() external view returns (uint256) {
        return ruleIds.length;
    }

    function orderCount() external view returns (uint256) {
        return orderIds.length;
    }

    // ---- users ----

    function createRule(
        uint8 creatorSeed,
        bool feedCondition,
        bool payAction,
        bool callback,
        uint96 amount,
        uint96 deposit,
        uint96 tip,
        uint32 cooldown,
        uint8 maxFires
    ) external {
        // Anything from nothing to enough for several fires. The fuzzer favours tiny numbers, which
        // would leave almost every rule unable to fire, so its inputs are spread out first.
        deposit = deposit % 8 == 0 ? 0 : uint96(_spread(deposit, 1e18, 60e18));
        amount = payAction ? uint96(_spread(amount, 0.1e18, 8e18)) : uint96(_spread(amount, 1e18, 12e18));
        tip = uint96(bound(tip, 0, 1e18));
        cooldown = uint32(bound(cooldown, 0, 2 days));
        maxFires = uint8(bound(maxFires, 1, 4));
        createRuleExact(creatorSeed, feedCondition, payAction, callback, amount, deposit, tip, cooldown, maxFires);
    }

    /// @dev The same with every number taken as given. Not a fuzz target; the scripted walk uses it.
    function createRuleExact(
        uint8 creatorSeed,
        bool feedCondition,
        bool payAction,
        bool callback,
        uint96 amount,
        uint96 deposit,
        uint96 tip,
        uint32 cooldown,
        uint8 maxFires
    ) public {
        if (ruleIds.length >= 12) return;
        Rules.RuleParams memory p;
        if (feedCondition) {
            p.when.kind = 2;
            p.when.target = address(feed);
            p.when.feedId = FEED_ID;
            p.when.maxAge = 2 days;
        } else {
            p.when.kind = 1;
            p.when.target = address(gauge);
            p.when.data = abi.encodeCall(gauge.value, ());
        }
        p.when.cmp = 1;
        p.when.threshold = 100;
        p.tip = tip;
        p.cooldown = cooldown;
        p.maxFires = maxFires;

        bytes memory spec;
        if (payAction) {
            p.action = 2;
            p.pay = Rules.Pay({recipient: PAYEE, amount: amount});
        } else {
            p.action = 1;
            p.hire.kindHash = keccak256("skill:research-report");
            p.hire.maxPay = amount;
            p.hire.minPay = amount / 2;
            p.hire.deliverySecs = 3 days;
            p.hire.bond = 0.25e18;
            p.hire.orderTtl = 5 days;
            // All four values the desk allows for an order without a condition come up.
            p.hire.flags =
                (callback ? desk.FLAG_CALLBACK() : 0) | (creatorSeed & 4 == 0 ? 0 : desk.FLAG_ALLOW_CLAIMED());
            spec = SPEC;
        }

        vm.prank(creators[creatorSeed % 3]);
        uint256 id = rules.createRule(p, spec, deposit);
        ruleIds.push(id);
        expectedEscrow[id] = deposit;
        paidIn += deposit;
        calls["createRule"]++;
    }

    function topUp(uint256 ruleSeed, uint256 actorSeed, uint96 amount) external {
        if (ruleIds.length == 0) return;
        uint256 id = ruleIds[ruleSeed % ruleIds.length];
        if (cancelledSeen[id]) return;
        amount = uint96(_spread(amount, 1, 30e18));
        vm.prank(creators[actorSeed % 3]);
        rules.topUp(id, amount);
        expectedEscrow[id] += amount;
        paidIn += amount;
        calls["topUp"]++;
    }

    function cancel(uint256 ruleSeed) external {
        if (ruleIds.length == 0) return;
        uint256 id = ruleIds[ruleSeed % ruleIds.length];
        if (cancelledSeen[id]) return;
        vm.prank(rules.getRule(id).creator);
        uint256 refund = rules.cancel(id);
        if (refund != expectedEscrow[id]) escrowMismatchAfterCall = true;
        toCreators += refund;
        expectedEscrow[id] = 0;
        cancelledSeen[id] = true;
        calls["cancel"]++;
    }

    // ---- keepers ----

    /// @param nudge When set, the world is first moved to where the rule's condition holds and its
    /// cooldown has passed, so that about half the attempts reach the action itself.
    function fire(uint256 ruleSeed, bool nudge) external {
        if (ruleIds.length == 0) return;
        uint256 id = ruleIds[ruleSeed % ruleIds.length];
        Rules.Rule memory r = rules.getRule(id);
        if (nudge) {
            skip(r.cooldown);
            gauge.set(150);
            feed.push(FEED_ID, 150);
        }
        uint256 cost = rules.costOf(id);
        bool expectedToPass = rules.canFire(id);

        vm.prank(KEEPER);
        try rules.fire(id, r.action == 1 ? bytes(SPEC) : bytes("")) returns (uint256 orderId) {
            // canFire and fire must agree (the mock desk accepts every order these rules write).
            if (!expectedToPass) escrowMismatchAfterCall = true;
            if (firesSeen[id] != 0 && vm.getBlockTimestamp() < lastFireAt[id] + r.cooldown) firedTooSoon = true;
            firesSeen[id] += 1;
            if (firesSeen[id] > r.maxFires) firedTooOften = true;
            lastFireAt[id] = vm.getBlockTimestamp();
            expectedEscrow[id] -= cost;
            if (r.action == 1) {
                orderIds.push(orderId);
                sentToDesk += r.hire.maxPay;
            }
            calls["fire"]++;
        } catch {
            if (expectedToPass) escrowMismatchAfterCall = true;
            calls["fire.refused"]++;
            if (r.cancelled) calls["fire.refused.cancelled"]++;
            else if (r.fires >= r.maxFires) calls["fire.refused.exhausted"]++;
            else if (r.escrow < cost) calls["fire.refused.escrow"]++;
            else calls["fire.refused.conditionOrCooldown"]++;
        }
    }

    function reconcile(uint256 orderSeed) external {
        if (orderIds.length == 0) return;
        uint256 orderId = orderIds[orderSeed % orderIds.length];
        (uint256 id,, uint96 credited) = rules.orderOf(orderId);
        (,,,, uint96 returned) = desk.accountOf(orderId);
        uint256 expected = returned - credited;
        uint256 got = rules.reconcile(id, orderId);
        if (got != expected) escrowMismatchAfterCall = true;
        _credit(id, expected);
        calls["reconcile"]++;
    }

    function recall(uint256 orderSeed) external {
        if (orderIds.length == 0) return;
        uint256 orderId = orderIds[orderSeed % orderIds.length];
        (uint256 id,, uint96 credited) = rules.orderOf(orderId);
        (IWorkOrders.State state,, uint96 escrow,, uint96 returned) = desk.accountOf(orderId);
        if (state != IWorkOrders.State.Open) return;
        vm.prank(rules.getRule(id).creator);
        uint256 got = rules.recall(id, orderId);
        uint256 expected = uint256(returned) + escrow - credited;
        if (got != expected) escrowMismatchAfterCall = true;
        cameBackFromDesk += escrow;
        _credit(id, expected);
        calls["recall"]++;
    }

    // ---- the desk and the world ----

    function deskDeliver(uint256 orderSeed, uint96 price) external {
        if (orderIds.length == 0) return;
        uint256 orderId = orderIds[orderSeed % orderIds.length];
        (uint256 id,, uint96 credited) = rules.orderOf(orderId);
        (IWorkOrders.State state,, uint96 escrow,, uint96 returned) = desk.accountOf(orderId);
        if (state != IWorkOrders.State.Open) return;
        price = uint96(bound(price, 0, escrow));
        bool callsBack = desk.paramsOf(orderId).flags & desk.FLAG_CALLBACK() != 0;

        desk.deliver(orderId, price, bytes16(uint128(orderId)));
        spentOf[orderId] = price;
        cameBackFromDesk += escrow - price;
        // An order that asked for the callback is reconciled inside the delivery itself.
        if (callsBack) _credit(id, uint256(returned) + escrow - price - credited);
        calls["deskDeliver"]++;
    }

    function deskRefund(uint256 orderSeed) external {
        if (orderIds.length == 0) return;
        uint256 orderId = orderIds[orderSeed % orderIds.length];
        (IWorkOrders.State state,, uint96 escrow,,) = desk.accountOf(orderId);
        if (state != IWorkOrders.State.Open) return;
        // The desk refunds from the very second of the expiry.
        uint256 expiresAt = desk.paramsOf(orderId).expiresAt;
        if (vm.getBlockTimestamp() < expiresAt) vm.warp(expiresAt);
        desk.refund(orderId);
        cameBackFromDesk += escrow;
        calls["deskRefund"]++;
    }

    function deskAwardBond(uint256 orderSeed, uint96 amount) external {
        if (orderIds.length == 0) return;
        uint256 orderId = orderIds[orderSeed % orderIds.length];
        (IWorkOrders.State state,,,,) = desk.accountOf(orderId);
        if (state != IWorkOrders.State.Open) return;
        amount = uint96(bound(amount, 1, 2e18));
        desk.awardBond(orderId, amount);
        awardedOf[orderId] += amount;
        cameBackFromDesk += amount;
        calls["deskAwardBond"]++;
    }

    function setGauge(uint256 value) external {
        // Above the line about two times in three, so rules fire often.
        gauge.set(bound(value, 0, 300));
        calls["setGauge"]++;
    }

    function pushFeed(uint256 value) external {
        feed.push(FEED_ID, bound(value, 0, 300));
        calls["pushFeed"]++;
    }

    function warp(uint32 secs) external {
        skip(bound(secs, 1, 3 days));
        calls["warp"]++;
    }

    function stray(uint96 amount) external {
        amount = uint96(bound(amount, 1, 5e18));
        imd.transfer(address(rules), amount);
        strays += amount;
        calls["stray"]++;
    }

    function _spread(uint256 x, uint256 min, uint256 max) private pure returns (uint256) {
        return bound(uint256(keccak256(abi.encode(x))), min, max);
    }

    function _credit(uint256 id, uint256 amount) private {
        if (cancelledSeen[id]) toCreators += amount;
        else expectedEscrow[id] += amount;
    }
}

/// @dev Handler-based invariants for Rules. Each one is a sentence about money or about firing that
/// must hold after any sequence of calls.
/// forge-config: default.invariant.depth = 120
contract RulesInvariantTest is Test {
    MockIMD internal imd;
    MockDesk internal desk;
    MockFeed internal feed;
    Gauge internal gauge;
    Rules internal rules;
    RulesHandler internal handler;

    function setUp() public {
        vm.warp(1_760_000_000);
        imd = new MockIMD();
        desk = new MockDesk(address(imd));
        feed = new MockFeed();
        gauge = new Gauge();
        rules = new Rules(address(imd), address(desk));
        handler = new RulesHandler(rules, imd, desk, feed, gauge);

        // Firing and the calls that bring money back are listed more than once so that a run spends
        // most of its calls where the money moves.
        bytes4[] memory selectors = new bytes4[](22);
        uint256 n;
        selectors[n++] = RulesHandler.createRule.selector;
        selectors[n++] = RulesHandler.createRule.selector;
        selectors[n++] = RulesHandler.topUp.selector;
        selectors[n++] = RulesHandler.cancel.selector;
        for (uint256 i; i < 6; ++i) {
            selectors[n++] = RulesHandler.fire.selector;
        }
        selectors[n++] = RulesHandler.reconcile.selector;
        selectors[n++] = RulesHandler.reconcile.selector;
        selectors[n++] = RulesHandler.recall.selector;
        selectors[n++] = RulesHandler.deskDeliver.selector;
        selectors[n++] = RulesHandler.deskDeliver.selector;
        selectors[n++] = RulesHandler.deskRefund.selector;
        selectors[n++] = RulesHandler.deskAwardBond.selector;
        selectors[n++] = RulesHandler.setGauge.selector;
        selectors[n++] = RulesHandler.pushFeed.selector;
        selectors[n++] = RulesHandler.warp.selector;
        selectors[n++] = RulesHandler.warp.selector;
        selectors[n++] = RulesHandler.stray.selector;
        assertEq(n, selectors.length);
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev A fixed walk through every handler action, so that each path the invariants speak about
    /// is certainly exercised at least once whatever the random runs happen to choose.
    function test_scriptedWalk_everyPathThenEveryInvariant() public {
        // creator, FEED?, PAY?, callback?, amount, deposit, tip, cooldown, maxFires
        handler.createRuleExact(0, false, false, false, 10e18, 60e18, 0.1e18, 0, 4); // rule 1: VIEW then HIRE
        handler.createRuleExact(1, true, true, false, 3e18, 40e18, 0.2e18, 1 hours, 3); // rule 2: FEED then PAY
        handler.createRuleExact(2, true, false, true, 5e18, 50e18, 0, 0, 2); // rule 3: FEED then HIRE, callback
        assertEq(handler.ruleCount(), 3);

        handler.fire(0, false); // order 1
        handler.fire(1, false);
        handler.fire(2, false); // order 2
        assertEq(handler.orderCount(), 2);
        assertEq(handler.calls("fire"), 3);
        _allInvariants();

        // Order 1: a bond arrives while it is open, then its creator withdraws it.
        handler.deskAwardBond(0, 1e18);
        handler.reconcile(0);
        handler.recall(0);
        _allInvariants();

        // Order 2 asked for the callback: it is reconciled inside the delivery.
        handler.deskDeliver(1, 2e18);
        handler.stray(3e18);
        _allInvariants();

        handler.fire(0, false); // order 3, from rule 1
        handler.deskRefund(2);
        _allInvariants(); // the refund is in the contract but in no rule's books yet
        handler.reconcile(2);
        handler.topUp(1, 0, 10e18);
        handler.fire(1, false); // refused: same round, and cooling down
        handler.fire(1, true); // nudged: new round, cooldown passed
        handler.fire(2, false); // order 4, from rule 3, on the new round
        assertEq(handler.orderCount(), 4);
        _allInvariants();

        // Cancelled rules: what their orders return goes to their creators.
        handler.cancel(0);
        handler.fire(0, true); // refused: rule 1 is cancelled
        handler.cancel(2);
        handler.deskDeliver(3, 1e18); // rule 3's second order, callback, rule cancelled
        handler.setGauge(10);
        handler.pushFeed(10);
        handler.warp(1 days);
        handler.fire(1, false); // refused: the new answer is below the line
        _allInvariants();

        assertEq(handler.calls("fire"), 6);
        assertEq(handler.calls("fire.refused"), 3);
        assertEq(handler.calls("reconcile"), 2);
        assertEq(handler.calls("recall"), 1);
        assertEq(handler.calls("deskDeliver"), 2);
        assertEq(handler.calls("deskRefund"), 1);
        assertEq(handler.calls("deskAwardBond"), 1);
        assertEq(handler.calls("cancel"), 2);
        assertGt(handler.toCreators(), 0);
        assertEq(handler.orderCount(), 4);
    }

    function _allInvariants() internal view {
        invariant_eachRulesEscrowIsConserved();
        invariant_holdingsCoverEveryEscrow();
        invariant_escrowsPlusMoneyOnOrdersEqualsHeldPlusOwed();
        invariant_nothingIsCreatedOrLost();
        invariant_firesRespectCooldownAndMaximum();
        invariant_cancelledRulesAndOrderLinks();
    }

    /// @dev R1: every rule's escrow is exactly what the calls made should have left it with.
    function invariant_eachRulesEscrowIsConserved() public view {
        uint256 n = handler.ruleCount();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.ruleIds(i);
            uint256 escrow = rules.getRule(id).escrow;
            assertEq(escrow, handler.expectedEscrow(id), "a rule's escrow drifted from its own history");
            sum += escrow;
        }
        assertEq(sum, rules.totalEscrowed(), "totalEscrowed is not the sum of the rules");
        assertFalse(handler.escrowMismatchAfterCall(), "a call returned or moved an unexpected amount");
    }

    /// @dev The rules' escrows never add up to more than the contract holds; the difference is
    /// exactly what the desk has returned and nobody has reconciled yet, plus stray transfers.
    function invariant_holdingsCoverEveryEscrow() public view {
        uint256 balance = imd.balanceOf(address(rules));
        assertGe(balance, rules.totalEscrowed());
        assertEq(balance, rules.totalEscrowed() + _unreconciled() + handler.strays());
    }

    /// @dev The rules' escrows plus the money still out on their orders equal what Rules holds or is
    /// owed by the desk. "Out on an order" is what was sent, plus bonds awarded, less the price paid
    /// and less what has already been handed back.
    function invariant_escrowsPlusMoneyOnOrdersEqualsHeldPlusOwed() public view {
        uint256 n = handler.orderCount();
        uint256 outOnOrders;
        uint256 owedByDesk;
        for (uint256 i; i < n; ++i) {
            uint256 orderId = handler.orderIds(i);
            (, uint96 sent, uint96 credited) = rules.orderOf(orderId);
            (,, uint96 escrow,,) = desk.accountOf(orderId);
            outOnOrders += uint256(sent) + handler.awardedOf(orderId) - handler.spentOf(orderId) - credited;
            owedByDesk += escrow;
        }
        assertEq(
            rules.totalEscrowed() + outOnOrders,
            imd.balanceOf(address(rules)) - handler.strays() + owedByDesk,
            "escrows plus money on orders differ from holdings plus what the desk still holds"
        );
        assertEq(imd.balanceOf(address(desk)), owedByDesk, "the desk holds only these orders' escrows");
    }

    /// @dev Every wei that ever entered Rules is still there or left to a known place.
    function invariant_nothingIsCreatedOrLost() public view {
        uint256 tips = imd.balanceOf(handler.KEEPER());
        uint256 paid = imd.balanceOf(handler.PAYEE());
        assertEq(
            handler.paidIn() + handler.cameBackFromDesk() + handler.strays(),
            imd.balanceOf(address(rules)) + tips + paid + handler.sentToDesk() + handler.toCreators()
        );
    }

    /// @dev A rule never fires more often than its cooldown and its maximum allow.
    function invariant_firesRespectCooldownAndMaximum() public view {
        assertFalse(handler.firedTooSoon(), "a rule fired inside its cooldown");
        assertFalse(handler.firedTooOften(), "a rule fired more often than its maximum");
        uint256 n = handler.ruleCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.ruleIds(i);
            Rules.Rule memory r = rules.getRule(id);
            assertLe(r.fires, r.maxFires);
            assertEq(r.fires, handler.firesSeen(id));
            assertEq(r.lastFiredAt, handler.lastFireAt(id));
        }
    }

    /// @dev A cancelled rule holds nothing and stays cancelled; no order belongs to two rules; nothing
    /// is credited beyond what the desk reports; and no allowance to the desk outlives a call.
    function invariant_cancelledRulesAndOrderLinks() public view {
        uint256 n = handler.ruleCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.ruleIds(i);
            Rules.Rule memory r = rules.getRule(id);
            if (handler.cancelledSeen(id)) {
                assertTrue(r.cancelled);
                assertEq(r.escrow, 0);
            }
        }
        uint256 m = handler.orderCount();
        for (uint256 i; i < m; ++i) {
            uint256 orderId = handler.orderIds(i);
            (uint256 ruleId,, uint96 credited) = rules.orderOf(orderId);
            (, address employer,,, uint96 returned) = desk.accountOf(orderId);
            assertTrue(ruleId != 0 && ruleId <= rules.ruleCount());
            assertEq(employer, address(rules));
            assertLe(credited, returned);
        }
        assertEq(imd.allowance(address(rules), address(desk)), 0);
    }

    function invariant_callSummary() public {
        emit log_named_uint("rules", handler.ruleCount());
        emit log_named_uint("orders", handler.orderCount());
        emit log_named_uint("fires", handler.calls("fire"));
        emit log_named_uint("fires refused", handler.calls("fire.refused"));
        emit log_named_uint("  rule cancelled", handler.calls("fire.refused.cancelled"));
        emit log_named_uint("  rule exhausted", handler.calls("fire.refused.exhausted"));
        emit log_named_uint("  escrow short", handler.calls("fire.refused.escrow"));
        emit log_named_uint("  condition false or cooling down", handler.calls("fire.refused.conditionOrCooldown"));
        emit log_named_uint("reconciles", handler.calls("reconcile"));
        emit log_named_uint("recalls", handler.calls("recall"));
        emit log_named_uint("deliveries", handler.calls("deskDeliver"));
        emit log_named_uint("refunds", handler.calls("deskRefund"));
        emit log_named_uint("bond awards", handler.calls("deskAwardBond"));
        emit log_named_uint("cancels", handler.calls("cancel"));
    }

    function _unreconciled() internal view returns (uint256 total) {
        uint256 n = handler.orderCount();
        for (uint256 i; i < n; ++i) {
            uint256 orderId = handler.orderIds(i);
            (,, uint96 credited) = rules.orderOf(orderId);
            (,,,, uint96 returned) = desk.accountOf(orderId);
            total += returned - credited;
        }
    }
}
