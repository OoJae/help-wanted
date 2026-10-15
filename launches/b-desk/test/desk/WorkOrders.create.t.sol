// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {DeskBase} from "./DeskBase.sol";

/// @dev Creates a contract with CREATE2 and reports the gas that took, measured inside one call.
contract Create2Probe {
    function deploy(bytes memory code, bytes32 salt) external returns (address created, uint256 used) {
        uint256 before = gasleft();
        assembly {
            created := create2(0, add(code, 0x20), mload(code), salt)
        }
        used = before - gasleft();
        require(created != address(0), "creation failed");
    }
}

/// Opening, cancelling and refunding orders, the price ramp, and the views.
contract WorkOrdersCreateTest is DeskBase {
    // --- construction -------------------------------------------------------------------------

    function test_constructorStoresTheThreeAddresses() public view {
        assertEq(desk.IMD(), address(imd));
        assertEq(desk.WORK_PROOF(), address(proof));
        assertEq(desk.PAYROLL(), address(payroll));
        assertEq(desk.orderCount(), 0);
    }

    /// Launch checks run constructors on an empty chain: no call, no code check, no revert.
    function test_constructorRunsAgainstAddressesWithNoCode() public {
        WorkOrders d = new WorkOrders(address(0x1001), address(0x1002), address(0x1003));
        assertEq(d.IMD(), address(0x1001));
        assertEq(d.WORK_PROOF(), address(0x1002));
        assertEq(d.PAYROLL(), address(0x1003));
    }

    function test_constructorRefusesAZeroAddress() public {
        vm.expectRevert(IWorkOrdersRunner.ZeroAddress.selector);
        new WorkOrders(address(0), address(proof), address(payroll));
        vm.expectRevert(IWorkOrdersRunner.ZeroAddress.selector);
        new WorkOrders(address(imd), address(0), address(payroll));
        vm.expectRevert(IWorkOrdersRunner.ZeroAddress.selector);
        new WorkOrders(address(imd), address(proof), address(0));
    }

    function test_constants() public view {
        assertEq(desk.FLAG_ALLOW_CLAIMED(), 1);
        assertEq(desk.FLAG_CALLBACK(), 2);
        assertEq(desk.FLAG_COND_ARG(), 4);
        assertEq(desk.MIN_BOND(), 0.25e18);
        assertEq(desk.MIN_DELIVERY(), 3 days);
        assertEq(desk.MAX_DELIVERY(), 90 days);
        assertEq(desk.DISPUTE_WINDOW(), 24 hours);
        assertEq(desk.FEE_BPS(), 500);
        assertEq(desk.TIP_BPS(), 500);
        assertEq(desk.RELEASE_BPS(), 1000);
        assertEq(desk.CLAIM_WINDOW(), 1 hours);
        assertEq(desk.CHALLENGE_WINDOW(), 24 hours);
        assertEq(desk.CALLBACK_GAS(), 150_000);
        assertEq(desk.CONDITION_GAS(), 100_000);
        assertEq(desk.PAYROLL_GAS(), 1_000_000);
        assertEq(desk.HEADER_LEN(), 85);
    }

    /// The launch pipeline refuses contracts over 24,576 bytes of runtime code and 49,152 of
    /// initcode; this project's own gates are 23,000 and 46,000. Held here so that a change which
    /// crosses them fails the suite and not the launch.
    function test_sizesStayUnderTheLaunchGates() public {
        uint256 runtime = address(desk).code.length;
        uint256 initcode = type(WorkOrders).creationCode.length + 3 * 32;
        emit log_named_uint("runtime bytes", runtime);
        emit log_named_uint("initcode bytes, with the three constructor words", initcode);
        assertLe(runtime, 23_000, "runtime code over the gate");
        assertLe(initcode, 46_000, "initcode over the gate");

        // What creating it costs the way the factory does it (CREATE2 from a contract), without
        // the launch transaction's own calldata charge.
        Create2Probe probe = new Create2Probe();
        bytes memory code =
            abi.encodePacked(type(WorkOrders).creationCode, abi.encode(address(imd), address(proof), address(payroll)));
        (address d, uint256 used) = probe.deploy(code, bytes32("launch B"));
        emit log_named_uint("creation gas (CREATE2, execution only)", used);
        assertEq(d.code.length, runtime);
        assertEq(WorkOrders(d).PAYROLL(), address(payroll));
        assertGt(used, 200 * runtime, "less than the code deposit alone: not a real measurement");
        assertLt(used, 6_000_000);
    }

    /// A desk whose IMD address has no code cannot take any money in.
    function test_wrongImdAddressShowsOnFirstUse() public {
        WorkOrders d = new WorkOrders(address(0x1001), address(proof), address(payroll));
        vm.prank(employer);
        vm.expectRevert();
        d.createOrder(_params(), SPEC);
    }

    // --- createOrder --------------------------------------------------------------------------

    function test_createOrder_storesTheOrderAndPullsMaxPay() public {
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 3;
        p.runnerOnly = runner;
        p.arbiter = arbiter;

        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.OrderOpened(1, employer, p.kindHash, keccak256(SPEC), p, SPEC);
        vm.prank(employer);
        uint256 id = desk.createOrder(p, SPEC);

        assertEq(id, 1);
        assertEq(desk.orderCount(), 1);
        assertEq(imd.balanceOf(address(desk)), MAX_PAY);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY);

        IWorkOrdersRunner.Order memory o = desk.orderOf(id);
        assertEq(o.employer, employer);
        assertEq(o.expiresAt, p.expiresAt);
        assertEq(o.rampFrom, _now());
        assertEq(uint8(o.state), uint8(IWorkOrders.State.Open));
        assertEq(o.flags, 3);
        assertEq(o.kindHash, keccak256(bytes(KIND)));
        assertEq(o.specHash, keccak256(SPEC));
        assertEq(o.minPay, MIN_PAY);
        assertEq(o.maxPay, MAX_PAY);
        assertEq(o.rampSecs, RAMP);
        assertEq(o.deliverySecs, DELIVERY);
        assertEq(o.runnerOnly, runner);
        assertEq(o.bond, BOND);
        assertEq(o.arbiter, arbiter);
        assertEq(o.escrow, MAX_PAY);
        assertEq(o.condTarget, address(0));
        assertTrue(o.condMet);
        assertFalse(o.proven);
        assertFalse(o.notified);
        assertEq(o.seq, 0);
        assertEq(o.spent, 0);
        assertEq(o.returned, 0);

        (IWorkOrders.State s, address e, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
        assertEq(uint8(s), uint8(IWorkOrders.State.Open));
        assertEq(e, employer);
        assertEq(escrow, MAX_PAY);
        assertEq(spent, 0);
        assertEq(returned, 0);
        _assertSolvent();
    }

    function test_createOrder_storesTheConditionAndStartsClosed() public {
        IWorkOrders.OrderParams memory p = _condParams(3, 99);
        p.flags = 4;
        p.condArg = bytes32(uint256(7));
        uint256 id = _open(p);
        IWorkOrdersRunner.Order memory o = desk.orderOf(id);
        assertEq(o.condTarget, address(cond));
        assertEq(o.condSelector, p.condSelector);
        assertEq(o.condCmp, 3);
        assertEq(o.condArg, bytes32(uint256(7)));
        assertEq(o.condThreshold, 99);
        assertFalse(o.condMet);
        assertEq(o.rampFrom, 0);
    }

    function test_createOrder_idsCountFromOne() public {
        assertEq(_open(), 1);
        assertEq(_open(), 2);
        vm.prank(stranger);
        assertEq(desk.createOrder(_params(), SPEC), 3);
        assertEq(desk.orderCount(), 3);
        assertEq(desk.orderOf(3).employer, stranger);
        _assertSolvent();
    }

    function test_createOrder_acceptsTheLongestSpec() public {
        bytes memory spec = new bytes(7900);
        for (uint256 i; i < spec.length; ++i) {
            spec[i] = "s";
        }
        vm.prank(employer);
        uint256 id = desk.createOrder(_params(), spec);
        assertEq(desk.orderOf(id).specHash, keccak256(spec));
    }

    function test_createOrder_revertsOnBadSpec() public {
        _expectSpecInvalid("", 0);
        _expectSpecInvalid(" leading", 0);
        _expectSpecInvalid("trailing ", 8);
        _expectSpecInvalid('a "quoted" word', 2);
        _expectSpecInvalid("back\\slash", 4);
        _expectSpecInvalid("two\nlines", 3);
        _expectSpecInvalid(unicode"naïve", 2);
        _expectSpecInvalid(new bytes(7901), 7900);
    }

    /// The desk accepts exactly the specs the character rules accept, and names the same byte.
    function testFuzz_createOrder_followsTheSpecRules(bytes memory spec, uint16 plantAt, uint8 planted) public {
        // Random bytes are almost never valid text, so half the runs start from valid text with
        // one byte planted in it.
        if (planted % 2 == 0) {
            uint256 len = bound(spec.length, 1, 300);
            spec = new bytes(len);
            for (uint256 i; i < len; ++i) {
                spec[i] = "w";
            }
            spec[bound(plantAt, 0, len - 1)] = bytes1(planted);
        }
        uint256 at = _firstBad(spec);
        vm.prank(employer);
        if (at != type(uint256).max) {
            vm.expectRevert(abi.encodeWithSelector(IWorkOrdersRunner.SpecInvalid.selector, at));
            desk.createOrder(_params(), spec);
        } else {
            uint256 id = desk.createOrder(_params(), spec);
            assertEq(desk.orderOf(id).specHash, keccak256(spec));
        }
    }

    /// @dev The rules, one byte at a time.
    function _firstBad(bytes memory spec) internal pure returns (uint256) {
        uint256 len = spec.length;
        if (len == 0) return 0;
        if (len > 7900) return 7900;
        for (uint256 i; i < len; ++i) {
            uint8 c = uint8(spec[i]);
            if (c < 0x20 || c > 0x7e || c == 0x22 || c == 0x5c) return i;
            if (c == 0x20 && (i == 0 || i == len - 1)) return i;
        }
        return type(uint256).max;
    }

    function _expectSpecInvalid(bytes memory spec, uint256 at) internal {
        IWorkOrders.OrderParams memory p = _params();
        vm.prank(employer);
        vm.expectRevert(abi.encodeWithSelector(IWorkOrdersRunner.SpecInvalid.selector, at));
        desk.createOrder(p, spec);
    }

    function test_createOrder_revertsOnPayRange() public {
        IWorkOrders.OrderParams memory p = _params();
        p.maxPay = 0;
        p.minPay = 0;
        _expectCreateRevert(p, IWorkOrdersRunner.PayRange.selector);
        p = _params();
        p.minPay = p.maxPay + 1;
        _expectCreateRevert(p, IWorkOrdersRunner.PayRange.selector);
        // Equal is fine: a flat price.
        p.minPay = p.maxPay;
        _open(p);
        // And so is a ramp from zero.
        p.minPay = 0;
        _open(p);
    }

    function test_createOrder_revertsOnShortDelivery() public {
        IWorkOrders.OrderParams memory p = _params();
        p.deliverySecs = 3 days - 1;
        _expectCreateRevert(p, IWorkOrdersRunner.DeliveryTooShort.selector);
        p.deliverySecs = 3 days;
        _open(p);
    }

    /// One runner's bond locks the escrow for the whole delivery time, so a mistaken value (a
    /// timestamp where a duration is meant, say) must not be able to make that decades.
    function test_createOrder_revertsOnLongDelivery() public {
        IWorkOrders.OrderParams memory p = _params();
        p.expiresAt = type(uint40).max;
        p.deliverySecs = 90 days + 1;
        _expectCreateRevert(p, IWorkOrdersRunner.DeliveryTooLong.selector);
        p.deliverySecs = uint32(START);
        _expectCreateRevert(p, IWorkOrdersRunner.DeliveryTooLong.selector);
        p.deliverySecs = type(uint32).max;
        _expectCreateRevert(p, IWorkOrdersRunner.DeliveryTooLong.selector);
        p.deliverySecs = 90 days;
        _open(p);
    }

    function test_createOrder_revertsOnLowBond() public {
        IWorkOrders.OrderParams memory p = _params();
        p.bond = 0.25e18 - 1;
        _expectCreateRevert(p, IWorkOrdersRunner.BondTooLow.selector);
        p.bond = 0;
        _expectCreateRevert(p, IWorkOrdersRunner.BondTooLow.selector);
        p.bond = 0.25e18;
        _open(p);
    }

    function test_createOrder_revertsWhenAlreadyExpired() public {
        IWorkOrders.OrderParams memory p = _params();
        p.expiresAt = uint40(_now());
        _expectCreateRevert(p, IWorkOrdersRunner.Expired.selector);
        p.expiresAt = uint40(_now() - 1);
        _expectCreateRevert(p, IWorkOrdersRunner.Expired.selector);
        p.expiresAt = 0;
        _expectCreateRevert(p, IWorkOrdersRunner.Expired.selector);
        p.expiresAt = uint40(_now() + 1);
        _open(p);
    }

    function test_createOrder_revertsOnUnknownFlags() public {
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 8;
        _expectCreateRevert(p, IWorkOrdersRunner.BadFlags.selector);
        p.flags = 255;
        _expectCreateRevert(p, IWorkOrdersRunner.BadFlags.selector);
        // The argument flag means nothing without a condition.
        p.flags = 4;
        _expectCreateRevert(p, IWorkOrdersRunner.BadFlags.selector);
        p.flags = 3;
        _open(p);
    }

    function test_createOrder_revertsOnBadCondition() public {
        IWorkOrders.OrderParams memory p = _condParams(7, 1);
        _expectCreateRevert(p, IWorkOrdersRunner.BadCondition.selector);
        // A target with no comparison.
        p = _condParams(0, 1);
        _expectCreateRevert(p, IWorkOrdersRunner.BadCondition.selector);
        // A comparison with no target.
        p = _params();
        p.condCmp = 1;
        _expectCreateRevert(p, IWorkOrdersRunner.BadCondition.selector);
        for (uint8 cmp = 1; cmp <= 6; ++cmp) {
            _open(_condParams(cmp, 1));
        }
    }

    function test_createOrder_revertsWithoutAllowanceOrBalance() public {
        address poor = makeAddr("poor");
        vm.prank(poor);
        imd.approve(address(desk), type(uint256).max);
        vm.prank(poor);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, poor, 0, MAX_PAY));
        desk.createOrder(_params(), SPEC);

        imd.mint(poor, MAX_PAY);
        vm.prank(poor);
        imd.approve(address(desk), MAX_PAY - 1);
        vm.prank(poor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(desk), MAX_PAY - 1, MAX_PAY
            )
        );
        desk.createOrder(_params(), SPEC);
        assertEq(desk.orderCount(), 0);
    }

    function _expectCreateRevert(IWorkOrders.OrderParams memory p, bytes4 selector) internal {
        vm.prank(employer);
        vm.expectRevert(selector);
        desk.createOrder(p, SPEC);
    }

    // --- cancel -------------------------------------------------------------------------------

    function test_cancel_returnsTheEscrow() public {
        uint256 id = _open();
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Cancelled(id, MAX_PAY);
        vm.prank(employer);
        desk.cancel(id);

        _assertState(id, IWorkOrders.State.Cancelled);
        assertEq(imd.balanceOf(employer), FUNDS);
        assertEq(imd.balanceOf(address(desk)), 0);
        (,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, 0);
        assertEq(spent, 0);
        assertEq(returned, MAX_PAY);
    }

    function test_cancel_onlyTheEmployer() public {
        uint256 id = _open();
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.NotEmployer.selector);
        desk.cancel(id);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.NotEmployer.selector);
        desk.cancel(id);
    }

    function test_cancel_notOnceARunnerHoldsTheOrder() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.prank(employer);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.cancel(id);
    }

    function test_cancel_worksAgainAfterTheClaimEnded() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.prank(runner);
        desk.release(id);
        vm.prank(employer);
        desk.cancel(id);
        _assertState(id, IWorkOrders.State.Cancelled);
        // The escrow and the 10% of the released bond.
        assertEq(imd.balanceOf(employer), FUNDS + BOND / 10);
        _assertSolvent();
    }

    function test_cancel_twiceReverts() public {
        uint256 id = _open();
        vm.prank(employer);
        desk.cancel(id);
        vm.prank(employer);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.cancel(id);
    }

    function test_cancel_worksOnAnExpiredOpenOrder() public {
        uint256 id = _open();
        _skip(LIFE + 1);
        vm.prank(employer);
        desk.cancel(id);
        _assertState(id, IWorkOrders.State.Cancelled);
        assertEq(imd.balanceOf(employer), FUNDS);
    }

    // --- refund -------------------------------------------------------------------------------

    function test_refund_anyoneAfterExpiry() public {
        uint256 id = _open();
        uint256 expiresAt = desk.orderOf(id).expiresAt;

        vm.warp(expiresAt - 1);
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.refund(id);

        vm.warp(expiresAt);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Refunded(id, MAX_PAY);
        vm.prank(stranger);
        desk.refund(id);

        _assertState(id, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(employer), FUNDS);
        assertEq(imd.balanceOf(stranger), FUNDS);
        (,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, 0);
        assertEq(spent, 0);
        assertEq(returned, MAX_PAY);
        _assertSolvent();
    }

    function test_refund_notWhileSomebodyHoldsTheOrder() public {
        uint256 id = _open();
        _claim(id, runner);
        _skip(LIFE + 1);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.refund(id);
    }

    function test_refund_twiceReverts() public {
        uint256 id = _open();
        _skip(LIFE);
        desk.refund(id);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.refund(id);
    }

    function test_refund_unknownOrderReverts() public {
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.refund(77);
    }

    // --- priceNow -----------------------------------------------------------------------------

    function test_priceNow_risesInAStraightLine() public {
        uint256 id = _open();
        assertEq(desk.priceNow(id), MIN_PAY);
        vm.warp(START + RAMP / 4);
        assertEq(desk.priceNow(id), MIN_PAY + (MAX_PAY - MIN_PAY) / 4);
        vm.warp(START + RAMP / 2);
        assertEq(desk.priceNow(id), 3e18);
        vm.warp(START + RAMP - 1);
        assertLt(desk.priceNow(id), MAX_PAY);
        vm.warp(START + RAMP);
        assertEq(desk.priceNow(id), MAX_PAY);
        vm.warp(START + 100 * uint256(RAMP));
        assertEq(desk.priceNow(id), MAX_PAY);
    }

    function test_priceNow_noRampMeansMaxPayAtOnce() public {
        IWorkOrders.OrderParams memory p = _params();
        p.rampSecs = 0;
        uint256 id = _open(p);
        assertEq(desk.priceNow(id), MAX_PAY);
    }

    function test_priceNow_unknownOrderIsZero() public view {
        assertEq(desk.priceNow(5), 0);
    }

    function test_priceNow_conditionalOrderRampsFromItsTrigger() public {
        cond.set(0);
        uint256 id = _open(_condParams(1, 10));
        vm.warp(START + 10 * uint256(RAMP));
        // Not triggered: still at the floor, however long it has waited.
        assertEq(desk.priceNow(id), MIN_PAY);
        cond.set(10);
        desk.trigger(id);
        assertEq(desk.priceNow(id), MIN_PAY);
        _skip(RAMP / 2);
        assertEq(desk.priceNow(id), 3e18);
        _skip(RAMP);
        assertEq(desk.priceNow(id), MAX_PAY);
    }

    /// With no ramp a conditional order pays `maxPay` from its trigger on, and the view says so
    /// beforehand: what `priceNow` shows is always what a claim at that moment fixes.
    function test_priceNow_conditionalOrderWithNoRamp() public {
        IWorkOrders.OrderParams memory p = _condParams(1, 10);
        p.rampSecs = 0;
        uint256 id = _open(p);
        assertEq(desk.priceNow(id), MAX_PAY);
        cond.set(10);
        _claim(id, runner);
        assertEq(desk.claimOf(id).price, MAX_PAY);
    }

    function testFuzz_priceNow_isWhatAClaimFixesOnAConditionalOrder(uint32 rampSecs, uint32 wait, bool triggerFirst)
        public
    {
        IWorkOrders.OrderParams memory p = _condParams(1, 10);
        p.rampSecs = rampSecs;
        p.expiresAt = type(uint40).max;
        uint256 id = _open(p);
        cond.set(10);
        if (triggerFirst) desk.trigger(id);
        vm.warp(START + wait);
        uint256 shown = desk.priceNow(id);
        _claim(id, runner);
        assertEq(desk.claimOf(id).price, shown);
        assertGe(shown, MIN_PAY);
        assertLe(shown, MAX_PAY);
    }

    function test_priceNow_theRampDoesNotRestartAfterAClaimEnds() public {
        uint256 id = _open();
        vm.warp(START + RAMP / 2);
        _claim(id, runner);
        vm.prank(runner);
        desk.release(id);
        assertEq(desk.priceNow(id), 3e18);
        vm.warp(START + RAMP);
        assertEq(desk.priceNow(id), MAX_PAY);
    }

    function test_claimFixesThePrice() public {
        uint256 id = _open();
        vm.warp(START + RAMP / 2);
        _claim(id, runner);
        assertEq(desk.claimOf(id).price, 3e18);
        // While the order is held the view shows what its claim fixed, not a ramp nobody can take.
        vm.warp(START + RAMP * 2);
        assertEq(desk.priceNow(id), 3e18);
        assertEq(desk.claimOf(id).price, 3e18);
        // Delivered: still the price that was paid.
        _register(id, runner, JOB);
        desk.settle(id, _landGood(id, JOB), _noChunks());
        assertEq(desk.priceNow(id), 3e18);
        assertEq(desk.orderOf(id).spent, 3e18);
    }

    /// Only time an order spends open raises its price. A runner that takes an order early and
    /// sits on it does not hand itself, or a second address, a higher price afterwards.
    function test_priceNow_theRampStandsStillWhileARunnerHoldsTheOrder() public {
        uint256 id = _open();
        vm.warp(START + RAMP / 4);
        _claim(id, runner);
        assertEq(desk.priceNow(id), 2.5e18);

        // Far past the end of the ramp, had it kept running.
        vm.warp(START + RAMP / 4 + 10 hours);
        assertEq(desk.priceNow(id), 2.5e18);
        desk.evict(id);
        assertEq(desk.priceNow(id), 2.5e18, "the hold raised the price");
        assertEq(desk.orderOf(id).rampFrom, START + 10 hours);

        // It goes on from where the claim found it.
        _skip(RAMP / 4);
        assertEq(desk.priceNow(id), 3e18);
        _claim(id, runner2);
        assertEq(desk.claimOf(id).price, 3e18);

        // Every way a claim can end and leave the order open does the same.
        _register(id, runner2, JOB);
        _skip(DELIVERY);
        desk.timeout(id);
        assertEq(desk.priceNow(id), 3e18);
        _skip(RAMP / 2);
        assertEq(desk.priceNow(id), MAX_PAY);
    }

    function testFuzz_priceNow_holdingAnOrderNeverRaisesItsPrice(
        uint32 rampSecs,
        uint32 openFor,
        uint32 heldFor,
        uint32 openAgain
    ) public {
        openFor = uint32(bound(openFor, 0, 10 days));
        heldFor = uint32(bound(heldFor, 1 hours, 60 days));
        openAgain = uint32(bound(openAgain, 0, 10 days));
        IWorkOrders.OrderParams memory p = _params();
        p.rampSecs = rampSecs;
        p.expiresAt = type(uint40).max;
        uint256 id = _open(p);

        _skip(openFor);
        uint256 atClaim = desk.priceNow(id);
        assertEq(atClaim, _refPrice(rampSecs, openFor));
        _claim(id, runner);
        _skip(heldFor);
        assertEq(desk.priceNow(id), atClaim, "the price moved while the order was held");
        desk.evict(id);
        assertEq(desk.priceNow(id), atClaim, "the price moved when the order reopened");

        _skip(openAgain);
        uint256 later = desk.priceNow(id);
        assertEq(later, _refPrice(rampSecs, uint256(openFor) + openAgain), "only time spent open counts");
        assertGe(later, atClaim);
        _claim(id, runner2);
        assertEq(desk.claimOf(id).price, later);
    }

    /// @dev The ramp of the default order after `openSecs` seconds spent open.
    function _refPrice(uint256 rampSecs, uint256 openSecs) internal pure returns (uint256) {
        if (openSecs >= rampSecs) return MAX_PAY;
        return MIN_PAY + uint256(MAX_PAY - MIN_PAY) * openSecs / rampSecs;
    }

    function testFuzz_priceRamp(uint96 minPay, uint96 maxPay, uint32 rampSecs, uint40 elapsed, uint40 later) public {
        maxPay = uint96(bound(maxPay, 1, 1_000_000e18));
        minPay = uint96(bound(minPay, 0, maxPay));
        elapsed = uint40(bound(elapsed, 0, 20 * 365 days));
        later = uint40(bound(later, elapsed, 20 * 365 days));

        imd.mint(employer, maxPay);
        IWorkOrders.OrderParams memory p = _params();
        p.minPay = minPay;
        p.maxPay = maxPay;
        p.rampSecs = rampSecs;
        p.expiresAt = type(uint40).max;
        uint256 id = _open(p);

        vm.warp(START + elapsed);
        uint256 price = desk.priceNow(id);
        uint256 expected =
            elapsed >= rampSecs ? maxPay : uint256(minPay) + uint256(maxPay - minPay) * elapsed / rampSecs;
        assertEq(price, expected, "formula");
        assertGe(price, minPay, "below the floor");
        assertLe(price, maxPay, "above what was escrowed");

        // What a claim fixes is what the view showed.
        uint256 snap = vm.snapshotState();
        _claim(id, runner);
        assertEq(desk.claimOf(id).price, price, "claim price");
        vm.revertToState(snap);

        // And the price never falls.
        vm.warp(START + later);
        assertGe(desk.priceNow(id), price, "price fell");
    }

    // --- views --------------------------------------------------------------------------------

    function test_viewsOfAnUnknownOrder() public {
        assertEq(uint8(desk.stateOf(9)), uint8(IWorkOrders.State.None));
        (IWorkOrders.State s, address e, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(9);
        assertEq(uint8(s), 0);
        assertEq(e, address(0));
        assertEq(escrow + spent + returned, 0);
        assertEq(desk.orderOf(9).employer, address(0));
        assertEq(desk.claimOf(9).runner, address(0));
        (bool met, bool holds, uint256 value) = desk.conditionOf(9);
        assertFalse(met);
        assertFalse(holds);
        assertEq(value, 0);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.headerOf(9);
    }

    function test_headerOf_onlyWhileTheOrderHasAHolderOrWasDelivered() public {
        uint256 id = _open();
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.headerOf(id);

        _claim(id, runner);
        bytes memory header = desk.headerOf(id);
        assertEq(header, _refHeader(block.chainid, address(desk), id, 1, runner));

        _register(id, runner, JOB);
        assertEq(desk.headerOf(id), header);

        desk.settle(id, _landGood(id, JOB), _noChunks());
        assertEq(desk.headerOf(id), header);
    }

    function test_headerOf_revertsOnceTheClaimEnded() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.prank(runner);
        desk.release(id);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.headerOf(id);
    }

    function test_headerDependsOnTheChain() public {
        uint256 id = _open();
        _claim(id, runner);
        bytes memory here = desk.headerOf(id);
        vm.chainId(11155111);
        bytes memory there = desk.headerOf(id);
        assertTrue(keccak256(here) != keccak256(there));
        assertEq(there, _refHeader(11155111, address(desk), id, 1, runner));
    }
}
