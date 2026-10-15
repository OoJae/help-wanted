// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Endowments} from "../../src/endowments/Endowments.sol";
import {Rules} from "../../src/rules/Rules.sol";
import {Zap} from "../../src/rules/Zap.sol";
import {EndowmentsBase} from "../endowments/EndowmentsBase.sol";
import {MockDesk} from "./mocks/MockDesk.sol";
import {MockPoolManager} from "./mocks/MockPoolManager.sol";
import {Gauge} from "./mocks/Targets.sol";

/// @dev One transaction that first calls `target` (a `harvest` or a `fire`) and then `Zap.buy`, and
/// keeps whatever both of them pay it. It can take no ETH back, and the pool uses all it sends.
contract CallThenBuy {
    function run(Zap zap, address target, bytes calldata data) external payable returns (uint256 bought) {
        (bool ok, bytes memory why) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(why, 0x20), mload(why))
            }
        }
        bought = zap.buy{value: msg.value}(0, type(uint256).max);
    }
}

/// @title Zap named as a payee by the other two contracts of launch C
/// @notice IdentityMD's reviewers raised this before the launch (`docs/AUDITS.md`, row 5; `docs/THREATS.md`
/// Z4). Neither Endowments nor Rules refuses Zap's address: an endowment may name it as its recipient
/// or its fallback beneficiary, and a PAY rule may name it as its recipient. Zap ends every call by
/// sending its caller the whole of its IMD balance, so what they pay it goes to whoever calls Zap
/// next, and the caller of `harvest` or `fire` can be that caller in the same transaction. Only yield,
/// or the PAY amount, reaches Zap this way: never a depositor's principal, and never more of a rule's
/// escrow than its fires spend. The code was not changed for it. These tests pin what it does.
contract ZapAsPayeeTest is EndowmentsBase {
    uint256 internal constant PRINCIPAL = 1_000e18;
    /// @dev At the mock pool's rate of 300 IMD per ETH, 0.01 ETH buys 3 IMD.
    uint256 internal constant ETH_IN = 0.01 ether;
    uint256 internal constant BOUGHT = 3e18;
    uint96 internal constant PAY = 2e18;
    uint96 internal constant TIP = 0.05e18;

    MockPoolManager internal pool;
    Zap internal zap;
    Rules internal rules;
    Gauge internal gauge;
    CallThenBuy internal taker;

    address internal nextCaller = makeAddr("next Zap caller");
    address internal sender = makeAddr("sender of the one transaction");

    function setUp() public override {
        super.setUp();
        pool = new MockPoolManager(address(imd));
        imd.mint(address(pool), 10_000_000e18);
        zap = new Zap(address(imd), address(pool), address(pots), address(questions));
        rules = new Rules(address(imd), address(new MockDesk(address(imd))));
        gauge = new Gauge();
        taker = new CallThenBuy();
        vm.prank(creator);
        imd.approve(address(rules), type(uint256).max);
        vm.deal(nextCaller, 1 ether);
        vm.deal(sender, 1 ether);
    }

    /// @dev The next caller of Zap buys 0.01 ETH of IMD and is sent that and everything Zap held. Zap's
    /// own event reports only what the swap produced.
    function _nextCallerBuys(uint256 waiting) internal {
        assertEq(imd.balanceOf(address(zap)), waiting, "the payment waits in Zap");
        uint256 before = imd.balanceOf(nextCaller);
        vm.expectEmit(true, true, true, true, address(zap));
        emit Zap.Bought(nextCaller, ETH_IN, BOUGHT);
        vm.prank(nextCaller);
        assertEq(zap.buy{value: ETH_IN}(0, type(uint256).max), BOUGHT, "buy reports only the swap");
        assertEq(imd.balanceOf(nextCaller) - before, BOUGHT + waiting, "the next caller took the payment");
        assertEq(imd.balanceOf(address(zap)), 0);
    }

    /// @dev Endowments accepts Zap as a recipient. Each harvest is sent to Zap, where it waits for the
    /// next caller of Zap, and the caller of `harvest` can be that caller in the same transaction. The
    /// depositor's principal is not touched: it comes back to the wei.
    function test_harvest_aRecipientEndowmentNamingZap_paysZap_andTheNextZapCallerTakesTheYield() public {
        vm.prank(creator);
        uint256 id = endow.createForRecipient(address(zap));
        (Endowments.Kind kind,, address beneficiary,,,,) = endow.endowment(id);
        assertEq(uint8(kind), uint8(Endowments.Kind.Recipient));
        assertEq(beneficiary, address(zap), "Zap is accepted as a recipient");

        _deposit(alice, id, PRINCIPAL);
        _stakeAndWait();

        // A keeper harvests. The yield waits in Zap, and the next caller of Zap takes it.
        _yieldBps(100);
        uint256 first = endow.harvestable(id);
        assertApproxEqAbs(first, 10e18, 1e13, "setup: about 1% of the principal");
        vm.prank(keeper);
        assertEq(endow.harvest(id), first);
        assertEq(imd.balanceOf(keeper), 0, "the keeper is paid nothing");
        _nextCallerBuys(first);

        // One transaction harvests and then calls Zap, and keeps the whole harvest.
        _yieldBps(100);
        uint256 second = endow.harvestable(id);
        assertGt(second, endow.MIN_HARVEST());
        vm.expectEmit(true, true, false, false, address(endow));
        emit Endowments.Harvested(id, address(taker), 0, 0);
        vm.expectEmit(true, true, true, true, address(zap));
        emit Zap.Bought(address(taker), ETH_IN, BOUGHT);
        vm.prank(sender);
        taker.run{value: ETH_IN}(zap, address(endow), abi.encodeCall(Endowments.harvest, (id)));
        assertEq(imd.balanceOf(address(taker)), BOUGHT + second, "the caller of harvest took the harvest");
        assertEq(imd.balanceOf(address(zap)), 0);
        assertEq(_harvested(id), first + second, "Endowments counts both as sent to the recipient");

        // Only yield went that way.
        _withdraw(alice, id, PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET, "the principal comes back to the wei");
    }

    /// @dev Endowments accepts Zap as a pot endowment's fallback beneficiary. Once the pot needs nothing,
    /// every harvest is paid to the fallback, which here is Zap, and the next caller of Zap takes it.
    function test_harvest_aPotEndowmentWhoseFallbackIsZap_paysZapOnceThePotNeedsNothing_andTheNextZapCallerTakesIt()
        public
    {
        vm.prank(creator);
        uint256 id = endow.createForPot(POT, address(zap));
        (Endowments.Kind kind, bytes32 target, address beneficiary,,,,) = endow.endowment(id);
        assertEq(uint8(kind), uint8(Endowments.Kind.Pot));
        assertEq(uint256(target), POT);
        assertEq(beneficiary, address(zap), "Zap is accepted as a fallback beneficiary");

        _deposit(alice, id, PRINCIPAL);
        _stakeAndWait();
        _yieldBps(100);
        // The pot fills by other means and needs nothing more.
        pots.open(POT, 0);
        uint256 yield = endow.harvestable(id);
        assertApproxEqAbs(yield, 10e18, 1e13, "setup: about 1% of the principal");

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.FallbackPaid(id, address(zap), yield);
        vm.prank(keeper);
        assertEq(endow.harvest(id), yield);
        assertEq(pots.chipOf(POT, address(zap)), 0, "the pot took nothing");
        _nextCallerBuys(yield);

        _withdraw(alice, id, PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET, "the principal comes back to the wei");
    }

    /// @dev Rules accepts Zap as a PAY rule's recipient. Each fire sends the PAY amount to Zap, where it
    /// waits for the next caller of Zap, and whoever fires the rule can be that caller in the same
    /// transaction, taking the tip and the payment. The rest of the escrow stays the creator's.
    function test_fire_aPayRuleNamingZap_paysZap_andTheNextZapCallerTakesThePayment() public {
        Rules.RuleParams memory p;
        p.when.kind = rules.COND_VIEW();
        p.when.cmp = rules.CMP_GE();
        p.when.target = address(gauge);
        p.when.threshold = 100;
        p.when.data = abi.encodeCall(gauge.value, ());
        p.action = rules.ACT_PAY();
        p.pay = Rules.Pay({recipient: address(zap), amount: PAY});
        p.tip = TIP;
        p.maxFires = 2;
        uint96 deposit = 10e18;
        vm.prank(creator);
        uint256 id = rules.createRule(p, "", deposit);
        assertEq(rules.getRule(id).pay.recipient, address(zap), "Zap is accepted as a recipient");
        gauge.set(100);

        // A keeper fires and is paid the tip. The payment waits in Zap, and the next caller takes it.
        vm.prank(keeper);
        rules.fire(id, "");
        assertEq(imd.balanceOf(keeper), TIP);
        _nextCallerBuys(PAY);

        // One transaction fires and then calls Zap, and keeps the tip and the payment.
        vm.expectEmit(true, true, true, true, address(rules));
        emit Rules.Fired(id, address(taker), 2, 100, 0, 0, PAY, TIP);
        vm.expectEmit(true, true, true, true, address(zap));
        emit Zap.Bought(address(taker), ETH_IN, BOUGHT);
        vm.prank(sender);
        taker.run{value: ETH_IN}(zap, address(rules), abi.encodeCall(Rules.fire, (id, "")));
        assertEq(imd.balanceOf(address(taker)), BOUGHT + PAY + TIP, "the firer took the tip and the payment");
        assertEq(imd.balanceOf(address(zap)), 0);

        // Each fire spent one fire's cost. What is left is the creator's.
        uint256 left = deposit - 2 * (uint256(PAY) + TIP);
        assertEq(uint256(rules.getRule(id).escrow), left);
        uint256 before = imd.balanceOf(creator);
        vm.prank(creator);
        assertEq(rules.cancel(id), left);
        assertEq(imd.balanceOf(creator) - before, left);
    }
}
