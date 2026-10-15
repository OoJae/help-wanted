// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IWorkOrders} from "b-desk/src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "b-desk/src/interfaces/IWorkOrdersRunner.sol";
import {Rules} from "c-company/src/rules/Rules.sol";
import {IWorkOrders as IDesk} from "c-company/src/interfaces/IWorkOrders.sol";
import {RulesDeskScenario} from "c-company/test/rules/RulesDeskScenario.sol";
import {Siblings} from "./Siblings.sol";

/// @dev Rules against the real hire desk, with the real WorkProof behind it. A HIRE rule opens real
/// orders; a runner takes them; a real IdentityMD work record, carrying the order's header and the
/// rule's spec, is proven and the desk pays; and everything the desk hands back reaches the rule
/// through the desk's own books, including inside the desk's delivery callback.
contract RulesWithRealDeskTest is Siblings, RulesDeskScenario {
    uint96 internal constant MIN_PAY = 4e18;
    uint96 internal constant MAX_PAY = 10e18;
    uint96 internal constant BOND = 0.5e18;
    uint96 internal constant RULE_TIP = 0.05e18;
    bytes16 internal constant JOB = bytes16(keccak256("a swarm job"));

    /// @dev WHEN the vault holds anything THEN HIRE, with the desk's flag bits as given.
    function _hireParams(uint8 flags) internal view returns (Rules.RuleParams memory p) {
        p.when.kind = 1;
        p.when.cmp = 3;
        p.when.target = address(simd);
        p.when.threshold = 0;
        p.when.data = abi.encodeWithSignature("totalAssets()");
        p.action = 1;
        p.hire.kindHash = keccak256(bytes(KIND));
        p.hire.minPay = MIN_PAY;
        p.hire.maxPay = MAX_PAY;
        p.hire.rampSecs = 1 hours;
        p.hire.deliverySecs = 3 days;
        p.hire.bond = BOND;
        p.hire.orderTtl = 14 days;
        p.hire.flags = flags;
        p.tip = RULE_TIP;
        p.maxFires = 3;
    }

    /// @dev A rule funded for three fires, and its first order, opened by the keeper.
    function _firedRule(uint8 flags) internal returns (uint256 id, uint256 orderId) {
        Rules.RuleParams memory p = _hireParams(flags);
        vm.prank(user);
        id = rules.createRule(p, SPEC, 3 * (MAX_PAY + RULE_TIP));
        vm.prank(keeper);
        orderId = rules.fire(id, SPEC);
    }

    /// @dev The runner takes the order at the bottom of its price range and registers a swarm job.
    function _runnerRegisters(uint256 orderId) internal {
        vm.startPrank(runner);
        desk.claim(orderId);
        desk.register(orderId, JOB);
        vm.stopPrank();
    }

    function _booksBalance() internal view {
        assertEq(imd.balanceOf(address(rules)), rules.totalEscrowed(), "Rules holds exactly its rules' escrows");
        assertEq(imd.allowance(address(rules), address(desk)), 0, "no allowance is left with the desk");
    }

    // ------------------------------------------------------------------------------------------
    // Writing a rule: the real desk's limits
    // ------------------------------------------------------------------------------------------

    /// @dev `createRule` reads the real desk's minimums, its delivery cap (a public constant outside
    /// the frozen interface) and its flag bits, and refuses what the desk would refuse later.
    function test_createRule_readsTheRealDesksLimits() public {
        assertEq(desk.MAX_DELIVERY(), 90 days);
        assertEq(desk.MIN_DELIVERY(), 3 days);
        assertEq(desk.MIN_BOND(), 0.25e18);
        assertEq(desk.FLAG_ALLOW_CLAIMED() | desk.FLAG_CALLBACK(), 3);

        Rules.RuleParams memory p = _hireParams(0);
        vm.startPrank(user);
        p.hire.deliverySecs = 90 days + 1;
        vm.expectRevert(Rules.AboveDeskMaximum.selector);
        rules.createRule(p, SPEC, 0);
        p.hire.deliverySecs = 3 days - 1;
        vm.expectRevert(Rules.BelowDeskMinimum.selector);
        rules.createRule(p, SPEC, 0);
        p.hire.deliverySecs = 90 days;
        p.hire.bond = 0.25e18 - 1;
        vm.expectRevert(Rules.BelowDeskMinimum.selector);
        rules.createRule(p, SPEC, 0);
        p.hire.bond = 0.25e18;
        for (uint256 flags = 4; flags < 256; ++flags) {
            // casting to 'uint8' is safe because the loop stops at 255
            // forge-lint: disable-next-line(unsafe-typecast)
            p.hire.flags = uint8(flags);
            vm.expectRevert(Rules.BadFlags.selector);
            rules.createRule(p, SPEC, 0);
        }
        p.hire.flags = 3;
        uint256 id = rules.createRule(p, SPEC, MAX_PAY + RULE_TIP);
        vm.stopPrank();

        // At the very limits the real desk does open the order.
        vm.prank(keeper);
        uint256 orderId = rules.fire(id, SPEC);
        assertEq(uint8(desk.stateOf(orderId)), uint8(IWorkOrders.State.Open));
        IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
        assertEq(o.employer, address(rules));
        assertEq(o.deliverySecs, 90 days);
        assertEq(o.bond, 0.25e18);
        assertEq(o.flags, 3);
        assertEq(o.kindHash, keccak256(bytes(KIND)));
        assertEq(o.specHash, keccak256(SPEC));
        assertEq(o.expiresAt, vm.getBlockTimestamp() + 14 days);
        assertEq(o.condTarget, address(0));
        assertEq(o.runnerOnly, address(0));
        assertEq(o.arbiter, address(0));
    }

    /// @dev Any spec: Rules accepts exactly what the real desk accepts, and where it refuses, its
    /// revert data is the real desk's, byte for byte.
    function testFuzz_createRule_refusesASpecExactlyAsTheRealDeskDoes(
        bytes calldata raw,
        uint16 length,
        uint8 planted,
        uint16 at
    ) public {
        bytes memory spec;
        if (length % 3 == 0) {
            spec = raw;
        } else {
            uint256 n = bound(length, 1, 300);
            spec = new bytes(n);
            for (uint256 i; i < n; ++i) {
                spec[i] = bytes1(uint8(0x61 + i % 26));
            }
            spec[at % n] = bytes1(planted);
        }
        Rules.RuleParams memory p = _hireParams(0);
        IWorkOrders.OrderParams memory o;
        o.maxPay = 1e18;
        o.deliverySecs = 3 days;
        o.bond = 0.25e18;
        o.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);

        vm.startPrank(user);
        (bool deskOk, bytes memory deskSaid) = address(desk).call(abi.encodeCall(IWorkOrders.createOrder, (o, spec)));
        (bool rulesOk, bytes memory rulesSaid) =
            address(rules).call(abi.encodeCall(Rules.createRule, (p, spec, uint96(0))));
        vm.stopPrank();
        assertEq(rulesOk, deskOk, "Rules and the desk disagree about a spec");
        if (!deskOk) assertEq(rulesSaid, deskSaid, "Rules names another fault than the desk");
    }

    /// @dev The longest spec, and one byte more, on both.
    function test_createRule_theLongestSpecIsTheRealDesksLongest() public {
        bytes memory longest = new bytes(7_900);
        for (uint256 i; i < longest.length; ++i) {
            longest[i] = "a";
        }
        Rules.RuleParams memory p = _hireParams(0);
        p.maxFires = 1;
        vm.prank(user);
        uint256 id = rules.createRule(p, longest, MAX_PAY + RULE_TIP);
        vm.prank(keeper);
        uint256 orderId = rules.fire(id, longest);
        assertEq(desk.orderOf(orderId).specHash, keccak256(longest));

        bytes memory tooLong = bytes.concat(longest, "a");
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Rules.SpecInvalid.selector, 7_900));
        rules.createRule(p, tooLong, 0);
        IWorkOrders.OrderParams memory o;
        o.maxPay = 1e18;
        o.deliverySecs = 3 days;
        o.bond = 0.25e18;
        o.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IWorkOrdersRunner.SpecInvalid.selector, 7_900));
        desk.createOrder(o, tooLong);
    }

    // ------------------------------------------------------------------------------------------
    // The walk every desk must allow
    // ------------------------------------------------------------------------------------------

    /// @dev The walk of `RulesDeskScenario`, which the main project runs against its stand-in desk
    /// and will run against the deployed desk, here against the real desk's source: orders with
    /// every flag value Rules accepts, a recall, expiries, refunds, and every wei back.
    function test_scenario_aHireRuleWalksThroughTheRealDesk() public {
        scenarioImd = IERC20(address(imd));
        scenarioDesk = IDesk(address(desk));
        scenarioRules = rules;
        imd.mint(scenarioCreator, SCENARIO_FUNDS);
        vm.prank(scenarioCreator);
        imd.approve(address(rules), SCENARIO_FUNDS);

        Rules.Condition memory when;
        when.kind = 1;
        when.cmp = 3;
        when.target = address(simd);
        when.data = abi.encodeWithSignature("totalAssets()");
        _walkAHireRuleThroughTheDesk(when);
    }

    // ------------------------------------------------------------------------------------------
    // A delivery proven by the real WorkProof
    // ------------------------------------------------------------------------------------------

    /// @dev The whole road with the callback flag. The rule fires, a runner takes the order at 4 IMD
    /// and registers a job, the job's record (a real IdentityMD record with this claim's header and
    /// the rule's spec) is the registry's receipt, and anyone settles. The desk pays, then calls
    /// Rules back, and inside that call the 6 IMD of change rejoin the rule's escrow.
    function test_hire_aProvenDeliveryReturnsTheChangeInsideTheDesksCallback() public {
        (uint256 id, uint256 orderId) = _firedRule(2);
        uint256 escrowBefore = rules.getRule(id).escrow;
        _runnerRegisters(orderId);
        assertEq(desk.priceNow(orderId), MIN_PAY, "taken at the bottom of the range");
        bytes memory record = _landReceipt(orderId, JOB, "completed");

        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.WorkDelivered(id, orderId, JOB, keccak256(record));
        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.Reconciled(id, orderId, MAX_PAY - MIN_PAY, false);
        desk.settle(orderId, record, new address[](0));

        IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
        assertEq(uint8(o.state), uint8(IWorkOrders.State.Delivered));
        assertTrue(o.proven);
        assertTrue(o.notified, "the callback ran inside the desk's allowance");
        assertEq(o.spent, MIN_PAY);
        assertEq(o.returned, MAX_PAY - MIN_PAY);
        assertEq(rules.getRule(id).escrow, escrowBefore + MAX_PAY - MIN_PAY, "the change is the rule's again");
        (, uint96 sent, uint96 credited) = rules.orderOf(orderId);
        assertEq(sent, MAX_PAY);
        assertEq(credited, MAX_PAY - MIN_PAY);
        assertEq(rules.reconcile(id, orderId), 0, "nothing is credited twice");
        _booksBalance();

        // The desk's fee and tip went to Payroll, the rest of the price and the bond to the runner.
        assertEq(payroll.paid() + payroll.tipped(), MIN_PAY / 10);
    }

    /// @dev The same delivery for a rule that did not ask for the callback: the change waits on
    /// Rules' balance, unassigned, until anyone calls `reconcile`.
    function test_hire_withoutTheCallbackTheChangeWaitsForReconcile() public {
        (uint256 id, uint256 orderId) = _firedRule(0);
        uint256 escrowBefore = rules.getRule(id).escrow;
        _runnerRegisters(orderId);
        bytes memory record = _landReceipt(orderId, JOB, "completed");
        desk.settle(orderId, record, new address[](0));

        assertEq(rules.getRule(id).escrow, escrowBefore);
        assertEq(imd.balanceOf(address(rules)), rules.totalEscrowed() + MAX_PAY - MIN_PAY);
        vm.prank(heir);
        assertEq(rules.reconcile(id, orderId), MAX_PAY - MIN_PAY);
        assertEq(rules.getRule(id).escrow, escrowBefore + MAX_PAY - MIN_PAY);
        _booksBalance();
    }

    /// @dev A rule cancelled while its order is out: the callback pays the change straight to the
    /// creator. This is the callback's costliest road (a token transfer), and it still fits.
    function test_hire_aCancelledRulesChangeGoesToItsCreatorInsideTheCallback() public {
        (uint256 id, uint256 orderId) = _firedRule(2);
        _runnerRegisters(orderId);
        vm.prank(user);
        rules.cancel(id);
        bytes memory record = _landReceipt(orderId, JOB, "completed");

        uint256 before = imd.balanceOf(user);
        desk.settle(orderId, record, new address[](0));
        assertTrue(desk.orderOf(orderId).notified);
        assertEq(imd.balanceOf(user), before + MAX_PAY - MIN_PAY);
        _booksBalance();
        assertEq(rules.totalEscrowed(), 0);
    }

    /// @dev Only the desk reaches the callback, and the real desk hands it 150,000 gas.
    function test_hire_theCallbackIsTheDesksAlone() public {
        (, uint256 orderId) = _firedRule(2);
        assertEq(desk.CALLBACK_GAS(), 150_000);
        vm.prank(runner);
        vm.expectRevert(Rules.NotDesk.selector);
        rules.onWorkDelivered(orderId, JOB, bytes32(uint256(1)));
    }

    // ------------------------------------------------------------------------------------------
    // Orders that end without a delivery
    // ------------------------------------------------------------------------------------------

    /// @dev Recall, expiry and a runner that gives the order back, on the real desk: each amount the
    /// desk returns is credited to the rule once, and Rules' balance always equals its books.
    function test_hire_recallRefundAndReleaseOnTheRealDesk() public {
        (uint256 id, uint256 orderA) = _firedRule(0);
        vm.prank(user);
        assertEq(rules.recall(id, orderA), MAX_PAY);
        assertEq(uint8(desk.stateOf(orderA)), uint8(IWorkOrders.State.Cancelled));
        _booksBalance();

        vm.prank(keeper);
        uint256 orderB = rules.fire(id, SPEC);
        skip(14 days - 1);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.refund(orderB);
        skip(1);
        desk.refund(orderB);
        assertEq(rules.reconcile(id, orderB), MAX_PAY);
        _booksBalance();

        // A runner takes the next one and gives it back within the hour: a tenth of its bond is
        // the employer's, and the order is open again.
        vm.prank(keeper);
        uint256 orderC = rules.fire(id, SPEC);
        vm.startPrank(runner);
        desk.claim(orderC);
        desk.release(orderC);
        vm.stopPrank();
        assertEq(uint8(desk.stateOf(orderC)), uint8(IWorkOrders.State.Open));
        assertEq(rules.reconcile(id, orderC), BOND / 10);
        _booksBalance();

        // The creator may not recall an order somebody holds; the real desk says why.
        vm.prank(challenger);
        desk.claim(orderC);
        vm.prank(user);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        rules.recall(id, orderC);
    }

    /// @dev A runner that registers a job and goes silent forfeits its bond to the employer, which
    /// is the rule: `reconcile` credits it, and the order is open for the next runner.
    function test_hire_aSilentRunnersBondComesToTheRule() public {
        (uint256 id, uint256 orderId) = _firedRule(0);
        uint256 escrowBefore = rules.getRule(id).escrow;
        _runnerRegisters(orderId);
        skip(3 days);
        desk.timeout(orderId);

        assertEq(uint8(desk.stateOf(orderId)), uint8(IWorkOrders.State.Open));
        assertEq(rules.reconcile(id, orderId), BOND);
        assertEq(rules.getRule(id).escrow, escrowBefore + BOND);
        _booksBalance();
    }

    // ------------------------------------------------------------------------------------------
    // The claimed path, for a rule whose creator allowed it
    // ------------------------------------------------------------------------------------------

    /// @dev With the desk's claimed-path flag, a delivery claim nobody challenges for 24 hours is
    /// paid without a receipt, and the change comes back in the callback like any other.
    function test_hire_claimedPath_anUnchallengedClaimIsPaidAndTheChangeReturns() public {
        (uint256 id, uint256 orderId) = _firedRule(3);
        uint256 escrowBefore = rules.getRule(id).escrow;
        _runnerRegisters(orderId);
        vm.prank(runner);
        desk.claimDelivered(orderId, keccak256("the record the runner names"));
        skip(24 hours);
        desk.finalize(orderId);

        IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
        assertEq(uint8(o.state), uint8(IWorkOrders.State.Delivered));
        assertFalse(o.proven, "paid on the runner's word, as the rule's creator accepted");
        assertTrue(o.notified);
        assertEq(rules.getRule(id).escrow, escrowBefore + MAX_PAY - MIN_PAY);
        _booksBalance();
    }

    /// @dev A challenged claim that nothing decides before the delivery deadline refunds the order.
    /// The rule gets its whole escrow back and a tenth of the runner's bond with it.
    function test_hire_claimedPath_anUndecidedDisputeRefundsTheRule() public {
        (uint256 id, uint256 orderId) = _firedRule(1);
        uint256 escrowBefore = rules.getRule(id).escrow;
        _runnerRegisters(orderId);
        vm.prank(runner);
        desk.claimDelivered(orderId, keccak256("the record the runner names"));
        vm.prank(challenger);
        desk.challenge(orderId);
        skip(3 days);
        desk.timeout(orderId);

        assertEq(uint8(desk.stateOf(orderId)), uint8(IWorkOrders.State.Refunded));
        assertEq(rules.reconcile(id, orderId), MAX_PAY + BOND / 10);
        assertEq(rules.getRule(id).escrow, escrowBefore + MAX_PAY + BOND / 10);
        _booksBalance();
    }

    /// @dev Without the flag the real desk refuses a delivery claim outright: only a receipt pays.
    function test_hire_withoutTheFlagOnlyAReceiptPays() public {
        (, uint256 orderId) = _firedRule(0);
        _runnerRegisters(orderId);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ClaimedPathOff.selector);
        desk.claimDelivered(orderId, keccak256("the record the runner names"));
    }
}
