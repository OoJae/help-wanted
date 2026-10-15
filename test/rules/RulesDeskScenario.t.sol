// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Rules} from "../../src/rules/Rules.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockDesk} from "./mocks/MockDesk.sol";
import {Gauge} from "./mocks/Targets.sol";
import {RulesDeskScenario} from "./RulesDeskScenario.sol";

/// @dev The desk walk against the area's stand-in desk. It runs offline with every other test, so
/// the walk itself is always compiled and exercised; the fork test runs the same steps against the
/// deployed desk.
contract RulesDeskScenarioTest is RulesDeskScenario {
    function test_scenario_aHireRuleWalksThroughTheStandInDesk() public {
        vm.warp(1_760_000_000);
        MockIMD imd = new MockIMD();
        MockDesk desk = new MockDesk(address(imd));
        Gauge gauge = new Gauge();
        gauge.set(100);

        scenarioImd = IERC20(address(imd));
        scenarioDesk = IWorkOrders(address(desk));
        scenarioRules = new Rules(address(imd), address(desk));
        imd.mint(scenarioCreator, SCENARIO_FUNDS);
        vm.prank(scenarioCreator);
        imd.approve(address(scenarioRules), SCENARIO_FUNDS);

        Rules.Condition memory when;
        when.kind = 1;
        when.cmp = 1;
        when.target = address(gauge);
        when.threshold = 100;
        when.data = abi.encodeCall(gauge.value, ());
        _walkAHireRuleThroughTheDesk(when);
    }
}
