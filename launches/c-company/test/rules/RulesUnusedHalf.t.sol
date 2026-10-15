// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {Rules} from "../../src/rules/Rules.sol";
import {RulesBase} from "./RulesBase.sol";

/// @title The action half a rule does not use
/// @notice IdentityMD's reviewers raised this before the launch (`docs/AUDITS.md`, row 7; `docs/THREATS.md`
/// R11). `createRule` refuses condition fields a rule does not use, and job text on a PAY rule
/// (`test_createRule_pay_refusesASpec`), but not the unused half of the action: a HIRE rule may be
/// created with a PAY half, and a PAY rule with a HIRE half. The stored rule has only its own half,
/// while `RuleCreated` publishes the caller's whole parameters, the unused half included. No money
/// moves on that half. The code was not changed for it. These tests pin what it does.
contract RulesUnusedHalfTest is RulesBase {
    uint96 internal constant DEPOSIT = 50e18;

    /// @dev Creates `p` as the creator and returns the parameters `RuleCreated` published for it.
    function _createAndReadEvent(Rules.RuleParams memory p, bytes memory spec)
        internal
        returns (uint256 id, Rules.RuleParams memory published)
    {
        vm.recordLogs();
        vm.prank(creator);
        id = rules.createRule(p, spec, DEPOSIT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found = 0;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(rules) && logs[i].topics[0] == Rules.RuleCreated.selector) {
                assertEq(uint256(logs[i].topics[1]), id);
                bytes memory publishedSpec;
                uint256 deposit;
                (published, publishedSpec, deposit) = abi.decode(logs[i].data, (Rules.RuleParams, bytes, uint256));
                assertEq(publishedSpec, spec);
                assertEq(deposit, DEPOSIT);
                ++found;
            }
        }
        assertEq(found, 1, "one RuleCreated");
    }

    /// @dev A HIRE rule created with a PAY half naming a recipient. `RuleCreated` carries that recipient
    /// and amount; `getRule` shows no PAY half; firing opens the order and pays the recipient nothing.
    function test_createRule_aHireRuleWithAPayHalf_publishesTheHalfInRuleCreated_butNeverPaysIt() public {
        Rules.RuleParams memory p = _hireParams(_viewCond(1, 100), 0, 1);
        p.pay = Rules.Pay({recipient: payee, amount: 7e18});
        (uint256 id, Rules.RuleParams memory published) = _createAndReadEvent(p, SPEC);

        // The event carries the PAY half the rule does not use, as well as its own HIRE half.
        assertEq(published.action, rules.ACT_HIRE());
        assertEq(published.pay.recipient, payee, "the event names a PAY recipient");
        assertEq(published.pay.amount, 7e18, "and a PAY amount");
        assertEq(published.hire.maxPay, MAX_PAY);

        // The stored rule has only its own half.
        Rules.Rule memory r = rules.getRule(id);
        assertEq(r.pay.recipient, address(0), "no PAY half is stored");
        assertEq(r.pay.amount, 0);
        assertEq(r.hire.maxPay, MAX_PAY);
        assertEq(rules.costOf(id), uint256(MAX_PAY) + TIP);

        // Firing opens the order. The recipient of the unused half is paid nothing.
        gauge.set(100);
        uint256 orderId = _fire(id);
        assertEq(orderId, 1);
        assertEq(desk.orderCount(), 1);
        assertEq(imd.balanceOf(payee), 0, "no money moved on the PAY half");
        assertEq(imd.balanceOf(address(desk)), MAX_PAY);
        assertEq(imd.balanceOf(keeper), TIP);
        assertEq(imd.balanceOf(address(rules)), DEPOSIT - MAX_PAY - TIP);
    }

    /// @dev A PAY rule created with a HIRE half. `RuleCreated` carries the order terms; `getRule` shows
    /// no HIRE half and no spec; firing pays the recipient and opens no order.
    function test_createRule_aPayRuleWithAHireHalf_publishesTheHalfInRuleCreated_butNeverHires() public {
        Rules.RuleParams memory p = _payParams(_viewCond(1, 100), 0, 1);
        p.hire = _hire();
        (uint256 id, Rules.RuleParams memory published) = _createAndReadEvent(p, "");

        // The event carries the HIRE half the rule does not use, as well as its own PAY half.
        assertEq(published.action, rules.ACT_PAY());
        assertEq(published.hire.kindHash, KIND_AUDIT, "the event carries order terms");
        assertEq(published.hire.maxPay, MAX_PAY);
        assertEq(published.hire.orderTtl, 14 days);
        assertEq(published.pay.recipient, payee);
        assertEq(published.pay.amount, PAY_AMOUNT);

        // The stored rule has only its own half.
        Rules.Rule memory r = rules.getRule(id);
        assertEq(r.hire.kindHash, bytes32(0), "no HIRE half is stored");
        assertEq(r.hire.maxPay, 0);
        assertEq(r.specHash, bytes32(0));
        assertEq(r.pay.recipient, payee);
        assertEq(rules.costOf(id), uint256(PAY_AMOUNT) + TIP);

        // Firing pays the recipient. No order is opened.
        gauge.set(100);
        assertEq(_fire(id), 0);
        assertEq(desk.orderCount(), 0, "no money moved on the HIRE half");
        assertEq(imd.balanceOf(address(desk)), 0);
        assertEq(imd.balanceOf(payee), PAY_AMOUNT);
        assertEq(imd.balanceOf(keeper), TIP);
        assertEq(imd.balanceOf(address(rules)), DEPOSIT - PAY_AMOUNT - TIP);
    }
}
