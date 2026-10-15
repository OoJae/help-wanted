// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Rules} from "../../src/rules/Rules.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";

/// @dev One walk of a HIRE rule through a hire desk, written against the frozen `IWorkOrders` surface
/// and nothing else, so that the same steps can be run against any desk: the area's stand-in in
/// every offline run (`RulesDeskScenario.t.sol`), and launch B's live desk on a fork
/// (`fork/RulesDeskFork.t.sol`). It needs no runner and no receipt: it covers what an employer
/// contract does on its own, which is open, withdraw, wait out an expiry, and take its money back.
abstract contract RulesDeskScenario is Test {
    Rules internal scenarioRules;
    IWorkOrders internal scenarioDesk;
    IERC20 internal scenarioImd;

    address internal scenarioCreator = makeAddr("scenario creator");
    address internal scenarioKeeper = makeAddr("scenario keeper");
    address internal scenarioPasserBy = makeAddr("scenario passer-by");

    bytes internal constant SCENARIO_SPEC =
        "Audit the repository at the pinned commit and report every finding. Inputs: repoUrl=https://example.org/r; baseCommit=0123abcd";
    uint96 internal constant SCENARIO_MAX_PAY = 2e18;
    uint96 internal constant SCENARIO_TIP = 0.01e18;
    uint32 internal constant SCENARIO_TTL = 2 days;
    /// @dev What the creator must hold and have approved to Rules before the walk: four rules.
    uint256 internal constant SCENARIO_FUNDS = 4 * (uint256(SCENARIO_MAX_PAY) + SCENARIO_TIP);

    /// @param when A condition that holds now and keeps holding for the length of the walk.
    function _walkAHireRuleThroughTheDesk(Rules.Condition memory when) internal {
        Rules rules = scenarioRules;
        IWorkOrders desk = scenarioDesk;
        // A freshly deployed contract's address can already hold IMD on a fork.
        uint256 heldBefore = scenarioImd.balanceOf(address(rules));
        uint256 creatorBefore = scenarioImd.balanceOf(scenarioCreator);

        Rules.RuleParams memory p;
        p.when = when;
        p.action = 1;
        p.hire.kindHash = keccak256("audit");
        p.hire.minPay = 1e18;
        p.hire.maxPay = SCENARIO_MAX_PAY;
        p.hire.rampSecs = 1 hours;
        p.hire.deliverySecs = desk.MIN_DELIVERY();
        p.hire.bond = desk.MIN_BOND();
        p.hire.orderTtl = SCENARIO_TTL;
        p.tip = SCENARIO_TIP;
        p.maxFires = 1;

        // Every flag value Rules accepts opens an order on this desk, with Rules as the employer.
        uint256[4] memory ids;
        uint256[4] memory orders;
        for (uint8 flags; flags < 4; ++flags) {
            p.hire.flags = flags;
            vm.prank(scenarioCreator);
            ids[flags] = rules.createRule(p, SCENARIO_SPEC, SCENARIO_MAX_PAY + SCENARIO_TIP);
            assertTrue(rules.canFire(ids[flags]), "the rule is ready to fire");
            vm.prank(scenarioKeeper);
            orders[flags] = rules.fire(ids[flags], SCENARIO_SPEC);

            (IWorkOrders.State state, address employer, uint96 escrow, uint96 spent, uint96 returned) =
                desk.accountOf(orders[flags]);
            assertEq(uint8(state), uint8(IWorkOrders.State.Open), "the order is open");
            assertEq(employer, address(rules), "Rules is the employer");
            assertEq(escrow, SCENARIO_MAX_PAY, "the desk holds the order's whole price");
            assertEq(spent, 0);
            assertEq(returned, 0);
            (uint256 ruleId, uint96 sent, uint96 credited) = rules.orderOf(orders[flags]);
            assertEq(ruleId, ids[flags]);
            assertEq(sent, SCENARIO_MAX_PAY);
            assertEq(credited, 0);
            assertEq(rules.getRule(ids[flags]).escrow, 0, "the rule spent exactly its deposit");
            assertEq(scenarioImd.allowance(address(rules), address(desk)), 0, "no allowance is left behind");
        }
        assertEq(scenarioImd.balanceOf(scenarioKeeper), 4 * uint256(SCENARIO_TIP), "one tip a fire");
        assertEq(scenarioImd.balanceOf(address(rules)), heldBefore, "everything else is on the desk");
        assertEq(rules.totalEscrowed(), 0);

        // The creator withdraws the first order: the desk cancels it and the escrow rejoins the rule.
        vm.prank(scenarioCreator);
        assertEq(rules.recall(ids[0], orders[0]), SCENARIO_MAX_PAY);
        assertEq(uint8(desk.stateOf(orders[0])), uint8(IWorkOrders.State.Cancelled));
        assertEq(rules.getRule(ids[0]).escrow, SCENARIO_MAX_PAY);

        // Nobody takes the others. At the second they expire, anyone may have the desk refund them.
        vm.expectRevert();
        desk.refund(orders[1]);
        skip(SCENARIO_TTL);
        vm.prank(scenarioPasserBy);
        desk.refund(orders[1]);
        assertEq(uint8(desk.stateOf(orders[1])), uint8(IWorkOrders.State.Refunded));
        (,,,, uint96 back) = desk.accountOf(orders[1]);
        assertEq(back, SCENARIO_MAX_PAY, "the desk counts the refund as returned");
        vm.prank(scenarioPasserBy);
        assertEq(rules.reconcile(ids[1], orders[1]), SCENARIO_MAX_PAY);
        assertEq(rules.reconcile(ids[1], orders[1]), 0, "a refund is credited once");
        assertEq(rules.getRule(ids[1]).escrow, SCENARIO_MAX_PAY);

        // A rule cancelled while its order is still out: what the order returns goes to the creator.
        vm.prank(scenarioCreator);
        assertEq(rules.cancel(ids[2]), 0);
        desk.refund(orders[2]);
        uint256 before = scenarioImd.balanceOf(scenarioCreator);
        assertEq(rules.reconcile(ids[2], orders[2]), SCENARIO_MAX_PAY);
        assertEq(scenarioImd.balanceOf(scenarioCreator) - before, SCENARIO_MAX_PAY);

        // The same through recall, which the creator may still use after cancelling. An expired
        // order can no longer be cancelled on the desk, so the last one is refunded and reconciled.
        desk.refund(orders[3]);
        assertEq(rules.reconcile(ids[3], orders[3]), SCENARIO_MAX_PAY);

        // Every wei Rules holds belongs to a rule again, and the creator can take all of it back.
        assertEq(scenarioImd.balanceOf(address(rules)) - heldBefore, rules.totalEscrowed());
        assertEq(rules.totalEscrowed(), 3 * uint256(SCENARIO_MAX_PAY));
        uint256[3] memory live = [ids[0], ids[1], ids[3]];
        for (uint256 i; i < 3; ++i) {
            vm.prank(scenarioCreator);
            assertEq(rules.cancel(live[i]), SCENARIO_MAX_PAY);
        }
        assertEq(scenarioImd.balanceOf(address(rules)), heldBefore);
        assertEq(rules.totalEscrowed(), 0);
        assertEq(
            creatorBefore - scenarioImd.balanceOf(scenarioCreator),
            4 * uint256(SCENARIO_TIP),
            "the walk cost the creator four tips and nothing else"
        );
    }
}
