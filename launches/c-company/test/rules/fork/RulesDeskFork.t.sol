// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {Rules} from "../../../src/rules/Rules.sol";
import {IWorkOrders} from "../../../src/interfaces/IWorkOrders.sol";
import {Mainnet} from "../../../src/interfaces/external/Mainnet.sol";
import {LaunchDoc} from "../../launch/LaunchDoc.sol";
import {RulesDeskScenario} from "../RulesDeskScenario.sol";

/// @dev A HIRE rule against the deployed hire desk, on a mainnet fork.
///
/// The desk belongs to launch B (IdentityMD launch 1573, live since 13 October 2026), and Rules takes
/// its address as a constructor argument. The test reads that address from the manifest in
/// `docs/LAUNCH.md` and runs against the contract that lives there:
///
///     FOUNDRY_PROFILE=fork forge test --match-contract RulesDeskForkTest
///
/// The walk is the one in `RulesDeskScenario`, which every offline run exercises against the
/// stand-in desk and `integration/` against the desk's real source: a rule that watches the real
/// sIMD vault opens real orders with every flag value Rules accepts, withdraws one, lets the others
/// expire, and takes every wei back. The settlement of a rule's order on the live desk, on a receipt
/// written into the real WorkRegistry, is in `test/launch/fork/LiveSiblings.fork.t.sol`.
contract RulesDeskForkTest is RulesDeskScenario, LaunchDoc {
    bool internal ready;
    string internal whyNot;

    function setUp() public {
        // Fails, not skips, if a marker is left in the manifest.
        address deskAddress = _literals().workOrders;
        try vm.createSelectFork(vm.rpcUrl("mainnet")) returns (uint256) {}
        catch Error(string memory reason) {
            whyNot = string.concat("mainnet RPC not reachable: ", reason);
            return;
        } catch {
            whyNot = "mainnet RPC not reachable: the fork could not be created";
            return;
        }
        // A manifest that names a desk with no code is a mistake to stop on, not one to skip past.
        require(deskAddress.code.length != 0, "docs/LAUNCH.md: nothing is deployed at the WorkOrders address");

        scenarioImd = IERC20(Mainnet.IMD);
        scenarioDesk = IWorkOrders(deskAddress);
        scenarioRules = new Rules(Mainnet.IMD, deskAddress);
        deal(Mainnet.IMD, scenarioCreator, SCENARIO_FUNDS);
        vm.prank(scenarioCreator);
        scenarioImd.approve(address(scenarioRules), SCENARIO_FUNDS);
        ready = true;
    }

    function test_fork_rules_hire_walksThroughTheDeployedDesk() public {
        if (!ready) {
            vm.skip(true, whyNot);
            return;
        }
        assertEq(scenarioDesk.IMD(), Mainnet.IMD, "the desk the manifest names is not priced in IMD");

        // WHEN sIMD.totalAssets() >= what it is now: true at once, and it stays true while nothing
        // leaves the vault, which nothing in this test does.
        Rules.Condition memory when;
        when.kind = 1;
        when.cmp = 1;
        when.target = Mainnet.SIMD;
        when.threshold = IERC4626(Mainnet.SIMD).totalAssets();
        when.data = abi.encodeCall(IERC4626.totalAssets, ());
        _walkAHireRuleThroughTheDesk(when);
    }
}
