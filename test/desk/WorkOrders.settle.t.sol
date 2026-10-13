// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {DeskBase} from "./DeskBase.sol";
import {MockEmployer} from "./mocks/MockEmployer.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";

/// @dev Makes several calls to the desk inside one transaction. Forge runs each call a test makes
/// as a transaction of its own, which would hide a reentrancy lock that is left set: transient
/// storage is cleared between transactions. Calls made from here share one.
contract OneTransaction {
    function run(address target, bytes[] calldata calls) external {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = target.call(calls[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}

/// The proven path: settle, its payouts, Payroll and callback failures, reportFailed, timeout.
contract WorkOrdersSettleTest is DeskBase {
    MockEmployer internal boss;

    function setUp() public override {
        super.setUp();
        boss = new MockEmployer(address(desk), address(imd));
        imd.mint(address(boss), FUNDS);
    }

    function _bossOrder() internal returns (uint256 id) {
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 2;
        id = boss.open(p, SPEC);
        _claim(id, runner);
        _register(id, runner, JOB);
    }

    function _bossOrder2() internal returns (uint256 id) {
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 2;
        id = boss.open(p, SPEC);
        _claim(id, runner);
        _register(id, runner, JOB2);
    }

    // --- settle: the happy path ---------------------------------------------------------------

    function test_settle_paysEveryoneAndRecordsTheJob() public {
        uint256 id = _open();
        vm.warp(START + RAMP / 2); // price 3 IMD
        _claim(id, runner);
        _register(id, runner, JOB);
        bytes memory record = _landGood(id, JOB);
        uint256 price = 3e18;
        uint256 fee = 0.15e18;
        uint256 tip = 0.15e18;

        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Delivered(
            id, JOB, runner, keccak256(record), true, price - fee - tip, fee, tip, MAX_PAY - price, BOND, _agents()
        );
        vm.prank(stranger);
        desk.settle(id, record, _noChunks());

        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(imd.balanceOf(runner), FUNDS + price - fee - tip, "runner");
        assertEq(imd.balanceOf(employer), FUNDS - price, "employer");
        assertEq(imd.balanceOf(address(payroll)), fee + tip, "payroll");
        assertEq(imd.balanceOf(address(desk)), 0, "desk");
        assertEq(imd.balanceOf(stranger), FUNDS, "the caller gets nothing");

        // Payroll was paid through its own functions, with the order id and the agents.
        assertEq(payroll.payCalls(), 1);
        assertEq(payroll.tipCalls(), 1);
        assertEq(payroll.paid(), fee);
        assertEq(payroll.tipped(), tip);
        assertEq(payroll.lastMemo(), bytes32(id));
        assertEq(payroll.lastAgentIds(), _agents());
        assertEq(imd.allowance(address(desk), address(payroll)), 0);

        assertEq(desk.orderOfJob(JOB), id);
        IWorkOrdersRunner.Order memory o = desk.orderOf(id);
        assertTrue(o.proven);
        assertEq(o.escrow, 0);
        assertEq(o.spent, price);
        assertEq(o.returned, MAX_PAY - price);
        assertEq(desk.claimOf(id).recordHash, keccak256(record));
        (,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
        assertEq(uint256(escrow) + spent + returned, MAX_PAY);
    }

    /// The agent list WorkProof read from the record reaches Payroll and the event unchanged, at
    /// its full length of sixteen.
    function test_settle_passesSixteenAgentsToPayroll() public {
        uint256 id = _registered();
        uint256[] memory agents = new uint256[](16);
        for (uint256 i; i < agents.length; ++i) {
            agents[i] = 52_000 + i;
        }
        bytes memory record = _landWith(JOB, KIND, _objective(id), "completed", agents);
        (uint256 runnerPay, uint256 fee, uint256 tip) = _split(MIN_PAY);
        address[] memory none = _noChunks();
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Delivered(
            id, JOB, runner, keccak256(record), true, runnerPay, fee, tip, MAX_PAY - MIN_PAY, BOND, agents
        );
        desk.settle(id, record, none);
        assertEq(payroll.lastAgentIds(), agents);
        assertEq(payroll.tipped(), tip);
    }

    /// A record with no readable agents: the tip still goes to Payroll, with an empty list.
    function test_settle_withNoAgents() public {
        uint256 id = _registered();
        bytes memory record = _landWith(JOB, KIND, _objective(id), "completed", new uint256[](0));
        desk.settle(id, record, _noChunks());
        assertEq(payroll.tipCalls(), 1);
        assertEq(payroll.lastAgentIds().length, 0);
        assertEq(imd.balanceOf(address(payroll)), 0.2e18);
    }

    function test_settle_atFullPriceNothingReturnsToTheEmployer() public {
        uint256 id = _open();
        vm.warp(START + RAMP);
        _claim(id, runner);
        _register(id, runner, JOB);
        desk.settle(id, _landGood(id, JOB), _noChunks());
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY);
        assertEq(desk.orderOf(id).returned, 0);
        assertEq(desk.orderOf(id).spent, MAX_PAY);
    }

    function test_settle_worksFromChunks() public {
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        // The record split over two data contracts, each with the leading zero byte.
        uint256 cut = record.length / 2;
        bytes memory a = new bytes(cut);
        bytes memory b = new bytes(record.length - cut);
        for (uint256 i; i < record.length; ++i) {
            if (i < cut) a[i] = record[i];
            else b[i - cut] = record[i];
        }
        address[] memory chunks = new address[](2);
        chunks[0] = address(0xC0FFEE01);
        chunks[1] = address(0xC0FFEE02);
        vm.etch(chunks[0], bytes.concat(hex"00", a));
        vm.etch(chunks[1], bytes.concat(hex"00", b));

        // With chunks given, the record argument is ignored.
        desk.settle(id, "ignored", chunks);
        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(desk.claimOf(id).recordHash, keccak256(record));
    }

    function test_settle_aRetryJobSettlesAndTheFirstJobDoesNot() public {
        uint256 id = _registered();
        bytes memory first = _landGood(id, JOB);
        _register(id, runner, JOB2);
        // The first job's record is no longer for the registered job.
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, JOB2));
        desk.settle(id, first, _noChunks());
        bytes memory second = _landGood(id, JOB2);
        desk.settle(id, second, _noChunks());
        assertEq(desk.orderOfJob(JOB2), id);
        assertEq(desk.orderOfJob(JOB), 0);
    }

    /// Timeouts are lazy: a receipt that lands after the delivery time still pays, as long as
    /// nobody has called `timeout`.
    function test_settle_aLateReceiptStillSettles() public {
        uint256 id = _registered();
        vm.warp(START + DELIVERY + 30 days);
        desk.settle(id, _landGood(id, JOB), _noChunks());
        _assertState(id, IWorkOrders.State.Delivered);
        _assertSolvent();
    }

    function test_settle_afterTimeoutTheOldReceiptIsWorthless() public {
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        vm.warp(START + DELIVERY);
        desk.timeout(id);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.settle(id, record, _noChunks());
        // Even after the same runner takes the order again: the ticket has moved on.
        _claim(id, runner);
        _register(id, runner, JOB);
        vm.expectRevert(IWorkOrdersRunner.WrongHeader.selector);
        desk.settle(id, record, _noChunks());
    }

    // --- settle: every way it refuses ---------------------------------------------------------

    function test_settle_revertsUnlessAJobIsRegistered() public {
        uint256 id = _open();
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.settle(id, "x", _noChunks());
        _claim(id, runner);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.settle(id, "x", _noChunks());
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.settle(404, "x", _noChunks());
    }

    function test_settle_revertsWithoutAReceipt() public {
        uint256 id = _registered();
        bytes memory unrecorded = _record(JOB);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, JOB));
        desk.settle(id, unrecorded, _noChunks());
    }

    function test_settle_revertsWhenTheBytesAreNotTheReceipt() public {
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        bytes memory spoofed = bytes.concat(record, " ");
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, keccak256(record), keccak256(spoofed)));
        desk.settle(id, spoofed, _noChunks());
    }

    function test_settle_revertsWhenTheJobDidNotComplete() public {
        uint256 id = _registered();
        bytes memory record = _land(id, JOB, KIND, "failed");
        vm.expectRevert(IWorkOrdersRunner.NotCompleted.selector);
        desk.settle(id, record, _noChunks());
        record = _land(id, JOB, KIND, "Completed");
        vm.expectRevert(IWorkOrdersRunner.NotCompleted.selector);
        desk.settle(id, record, _noChunks());
    }

    function test_settle_revertsOnAnotherKind() public {
        uint256 id = _registered();
        bytes memory record = _land(id, JOB, OTHER_KIND, "completed");
        vm.expectRevert(IWorkOrdersRunner.WrongKind.selector);
        desk.settle(id, record, _noChunks());
    }

    function test_settle_revertsOnAnotherSpec() public {
        uint256 id = _registered();
        bytes memory objective =
            bytes.concat(_refHeader(block.chainid, address(desk), id, 1, runner), SPEC, " and more");
        bytes memory record = _landOtherObjective(JOB, objective);
        vm.expectRevert(IWorkOrdersRunner.WrongSpec.selector);
        desk.settle(id, record, _noChunks());
    }

    /// The header must be this claim's: not another runner's, claim's, order's, desk's or chain's.
    function test_settle_revertsOnAnyOtherHeader() public {
        uint256 id = _registered();
        bytes[6] memory headers = [
            _refHeader(block.chainid, address(desk), id, 1, runner2),
            _refHeader(block.chainid, address(desk), id, 2, runner),
            _refHeader(block.chainid, address(desk), id + 1, 1, runner),
            _refHeader(block.chainid, address(0xDE5C), id, 1, runner),
            _refHeader(block.chainid + 1, address(desk), id, 1, runner),
            bytes("[HELP-WANTED order 87a4ceb3cc6bf9ee0fce139b3944d337fe5374fe0f4ce715e185f310cea89571] ")
        ];
        for (uint256 i; i < headers.length; ++i) {
            bytes memory record = _landOtherObjective(JOB, bytes.concat(headers[i], SPEC));
            vm.expectRevert(IWorkOrdersRunner.WrongHeader.selector);
            desk.settle(id, record, _noChunks());
        }
        // And with the right one it goes through.
        desk.settle(id, _landGood(id, JOB), _noChunks());
    }

    /// A job settles at most one order, even if WorkProof were to vouch for it twice.
    function test_settle_revertsWhenTheJobSettledAnotherOrder() public {
        uint256 first = _registered();
        uint256 second = _open();
        _claim(second, runner2);
        _register(second, runner2, JOB);
        desk.settle(first, _landGood(first, JOB), _noChunks());

        // Force the mock to say what the real registry never could: the same job, now with the
        // second order's objective.
        bytes memory record = _landGood(second, JOB);
        vm.expectRevert(IWorkOrdersRunner.JobUsed.selector);
        desk.settle(second, record, _noChunks());
        assertEq(desk.orderOfJob(JOB), first);
        _assertState(second, IWorkOrders.State.Registered);
    }

    function test_settle_twiceReverts() public {
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        desk.settle(id, record, _noChunks());
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.settle(id, record, _noChunks());
    }

    /// If the registry stops answering, WorkProof finds no receipt and nothing settles, but the
    /// order still ends by timeout.
    function test_settle_aDeadRegistryCannotTrapTheEscrow() public {
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        registry.setDown(true);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, JOB));
        desk.settle(id, record, _noChunks());
        vm.warp(START + LIFE);
        desk.timeout(id);
        _assertState(id, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(employer), FUNDS + BOND);
    }

    /// A WorkProof address with no code proves nothing: no receipt can be used either way, and the
    /// order ends by timeout like any other that was not delivered.
    function test_settle_aWorkProofWithNoCodeProvesNothing() public {
        WorkOrders d = new WorkOrders(address(imd), makeAddr("no proof here"), address(payroll));
        vm.prank(employer);
        imd.approve(address(d), type(uint256).max);
        vm.prank(runner);
        imd.approve(address(d), type(uint256).max);
        vm.prank(employer);
        uint256 id = d.createOrder(_params(), SPEC);
        vm.prank(runner);
        d.claim(id);
        vm.prank(runner);
        d.register(id, JOB);
        // The call to an address without code returns nothing, which is not a proof: the desk
        // reverts with no data of its own, for a settlement and for a failure report alike.
        bytes memory record = _record(JOB);
        (bool ok, bytes memory ret) = address(d).call(abi.encodeCall(d.settle, (id, record, _noChunks())));
        assertFalse(ok, "settled on no proof");
        assertEq(ret.length, 0);
        vm.prank(runner);
        (ok, ret) = address(d).call(abi.encodeCall(d.reportFailed, (id, record, _noChunks())));
        assertFalse(ok, "a failure was reported on no proof");
        assertEq(ret.length, 0);
        assertEq(uint8(d.stateOf(id)), uint8(IWorkOrders.State.Registered));
        vm.warp(START + DELIVERY);
        d.timeout(id);
        assertEq(uint8(d.stateOf(id)), uint8(IWorkOrders.State.Open));
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
    }

    // --- settle: the arithmetic ---------------------------------------------------------------

    function testFuzz_settle_thePartsAlwaysSumToThePrice(
        uint96 minPay,
        uint96 maxPay,
        uint32 rampSecs,
        uint32 elapsed,
        uint96 bond
    ) public {
        maxPay = uint96(bound(maxPay, 1, 1_000_000e18));
        minPay = uint96(bound(minPay, 0, maxPay));
        bond = uint96(bound(bond, 0.25e18, 1_000e18));
        elapsed = uint32(bound(elapsed, 0, LIFE - 1));
        imd.mint(employer, maxPay);
        imd.mint(runner, bond);

        IWorkOrders.OrderParams memory p = _params();
        p.minPay = minPay;
        p.maxPay = maxPay;
        p.rampSecs = rampSecs;
        p.bond = bond;
        uint256 id = _open(p);
        vm.warp(START + elapsed);
        _claim(id, runner);
        _register(id, runner, JOB);
        uint256 price = desk.claimOf(id).price;
        bytes memory record = _landGood(id, JOB);

        uint256[3] memory before = [imd.balanceOf(runner), imd.balanceOf(employer), imd.balanceOf(address(payroll))];
        desk.settle(id, record, _noChunks());
        uint256 toRunner = imd.balanceOf(runner) - before[0] - bond;
        uint256 toEmployer = imd.balanceOf(employer) - before[1];
        uint256 toPayroll = imd.balanceOf(address(payroll)) - before[2];

        (uint256 runnerPay, uint256 fee, uint256 tip) = _split(price);
        assertEq(toRunner, runnerPay, "runner pay");
        assertEq(toPayroll, fee + tip, "fee and tip");
        assertEq(toEmployer, maxPay - price, "unused escrow");
        assertEq(toRunner + toPayroll, price, "the parts do not sum to the price");
        assertEq(toRunner + toPayroll + toEmployer, maxPay, "the escrow was not paid out exactly");
        assertLe(price, maxPay, "paid more than was escrowed");
        // The fee side is never short of 5% each, and never more than a wei over.
        assertGe(fee * 10_000, price * 500);
        assertLt(fee * 10_000, price * 500 + 10_000);
        assertLe(tip, fee);
        assertEq(imd.balanceOf(address(desk)), 0, "dust left in the desk");
        IWorkOrdersRunner.Order memory o = desk.orderOf(id);
        assertEq(o.spent, price);
        assertEq(o.returned, maxPay - price);
    }

    /// The smallest prices, where rounding is everything.
    function test_settle_dustPrices() public {
        uint256[8] memory prices = [uint256(0), 1, 2, 19, 20, 21, 39, 41];
        uint256[8] memory fees = [uint256(0), 1, 1, 1, 1, 2, 2, 3];
        uint256[8] memory tips = [uint256(0), 0, 1, 1, 1, 2, 2, 3];
        for (uint256 i; i < prices.length; ++i) {
            IWorkOrders.OrderParams memory p = _params();
            p.minPay = uint96(prices[i]);
            p.maxPay = uint96(prices[i] == 0 ? 1 : prices[i]);
            p.rampSecs = type(uint32).max;
            uint256 id = _open(p);
            _claim(id, runner);
            bytes16 job = bytes16(uint128(1000 + i));
            _register(id, runner, job);
            assertEq(desk.claimOf(id).price, prices[i]);
            uint256 runnerBefore = imd.balanceOf(runner);
            uint256 payrollBefore = imd.balanceOf(address(payroll));
            desk.settle(id, _landGood(id, job), _noChunks());
            assertEq(imd.balanceOf(address(payroll)) - payrollBefore, fees[i] + tips[i], "fee and tip");
            assertEq(imd.balanceOf(runner) - runnerBefore, BOND + prices[i] - fees[i] - tips[i], "runner");
            (uint256 runnerPay, uint256 fee, uint256 tip) = _split(prices[i]);
            assertEq(fee, fees[i]);
            assertEq(tip, tips[i]);
            assertEq(runnerPay + fee + tip, prices[i]);
            _assertSolvent();
        }
    }

    // --- settle: Payroll may fail in any way --------------------------------------------------

    /// @dev Settles a 3 IMD order with Payroll in `mode`. `fallbackAmount` is what must arrive by
    /// plain transfer (zero: no fallback event is expected).
    function _settleWithPayroll(PayrollStandIn.Mode mode, uint256 fallbackAmount) internal returns (uint256 id) {
        payroll.setMode(mode);
        id = _open();
        vm.warp(START + RAMP / 2);
        _claim(id, runner);
        _register(id, runner, JOB);
        bytes memory record = _landGood(id, JOB);
        address[] memory none = _noChunks();
        if (fallbackAmount != 0) {
            vm.expectEmit(address(desk));
            emit IWorkOrdersRunner.PayrollFallback(id, fallbackAmount);
        }
        desk.settle(id, record, none);
        _assertState(id, IWorkOrders.State.Delivered);
        // Whatever Payroll did, the same money went to the same places.
        assertEq(imd.balanceOf(runner), FUNDS + 2.7e18, "runner");
        assertEq(imd.balanceOf(employer), FUNDS - 3e18, "employer");
        assertEq(imd.balanceOf(address(payroll)), 0.3e18, "payroll");
        assertEq(imd.balanceOf(address(desk)), 0, "desk");
        assertEq(imd.allowance(address(desk), address(payroll)), 0, "allowance left behind");
    }

    function test_settle_payrollRevertsInPay() public {
        _settleWithPayroll(PayrollStandIn.Mode.RevertPay, 0.15e18);
        assertEq(payroll.paid(), 0);
        assertEq(payroll.tipped(), 0.15e18);
    }

    function test_settle_payrollRevertsInTip() public {
        _settleWithPayroll(PayrollStandIn.Mode.RevertTip, 0.15e18);
        assertEq(payroll.paid(), 0.15e18);
        assertEq(payroll.tipped(), 0);
    }

    function test_settle_payrollRevertsInBoth() public {
        _settleWithPayroll(PayrollStandIn.Mode.RevertBoth, 0.3e18);
        assertEq(payroll.paid() + payroll.tipped(), 0);
    }

    function test_settle_payrollReturnsWithoutPulling() public {
        _settleWithPayroll(PayrollStandIn.Mode.PullNothing, 0.3e18);
    }

    function test_settle_payrollPullsOnlyPart() public {
        _settleWithPayroll(PayrollStandIn.Mode.PullHalf, 0.15e18);
        assertEq(payroll.paid(), 0.075e18);
        assertEq(payroll.tipped(), 0.075e18);
    }

    /// A Payroll that takes the whole allowance in its first call still ends with exactly fee + tip.
    function test_settle_payrollPullsEverythingInPay() public {
        _settleWithPayroll(PayrollStandIn.Mode.PullAllInPay, 0);
        assertEq(payroll.paid(), 0.3e18);
    }

    function test_settle_payrollBurnsAllItsGas() public {
        payroll.setMode(PayrollStandIn.Mode.BurnGas);
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        uint256 before = gasleft();
        desk.settle{gas: 3_000_000}(id, record, _noChunks());
        uint256 used = before - gasleft();
        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(imd.balanceOf(address(payroll)), 0.2e18);
        // Two capped calls of one million gas each, and the settlement itself.
        assertLt(used, 2_600_000);
        assertGt(used, 2_000_000);
    }

    /// A caller cannot push the fee onto the fallback path by sending too little gas: unless each
    /// Payroll call can be offered its whole allowance, the settlement reverts.
    function test_settle_revertsWhenPayrollCannotBeOfferedItsAllowance() public {
        payroll.setMode(PayrollStandIn.Mode.BurnGas);
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        vm.expectRevert(IWorkOrdersRunner.GasShort.selector);
        desk.settle{gas: 900_000}(id, record, _noChunks());
        // Enough for the first call but not for the second after the first burnt its million.
        vm.expectRevert(IWorkOrdersRunner.GasShort.selector);
        desk.settle{gas: 1_500_000}(id, record, _noChunks());
        _assertState(id, IWorkOrders.State.Registered);

        payroll.setMode(PayrollStandIn.Mode.RevertBoth);
        vm.expectRevert(IWorkOrdersRunner.GasShort.selector);
        desk.settle{gas: 900_000}(id, record, _noChunks());
        _assertState(id, IWorkOrders.State.Registered);
        assertEq(imd.balanceOf(address(payroll)), 0);
    }

    /// The same holds when Payroll is healthy: it is never called on less than its allowance, so
    /// what it does with a payment cannot depend on how much gas the caller chose to send.
    function test_settle_alwaysOffersPayrollItsWholeAllowance() public {
        payroll.setMeter(true);
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        vm.expectRevert(IWorkOrdersRunner.GasShort.selector);
        desk.settle{gas: 600_000}(id, record, _noChunks());

        uint256 successes;
        uint256 shortReverts;
        for (uint256 g = 900_000; g <= 1_800_000; g += 10_000) {
            uint256 snap = vm.snapshotState();
            try desk.settle{gas: g}(id, record, _noChunks()) {
                ++successes;
                // The whole million, less the few hundred gas the mock spends before it looks.
                assertGt(payroll.payGas(), 999_000, "pay was called on less than its allowance");
                assertGt(payroll.tipGas(), 999_000, "tip was called on less than its allowance");
                assertLe(payroll.payGas(), 1_000_000);
                assertLe(payroll.tipGas(), 1_000_000);
                assertEq(imd.balanceOf(address(payroll)), 0.2e18);
            } catch (bytes memory err) {
                assertEq(bytes4(err), IWorkOrdersRunner.GasShort.selector, "failed for another reason than gas");
                ++shortReverts;
                assertEq(payroll.payCalls() + payroll.tipCalls(), 0);
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
        assertGt(shortReverts, 0);
    }

    /// The headroom a caller must supply: gas that is not used comes back, but this much must be
    /// on offer for a plain settlement with a healthy Payroll.
    function test_settle_gasACallerMustSupply() public {
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        uint256 lowest;
        for (uint256 g = 1_000_000; g <= 1_800_000; g += 5_000) {
            uint256 snap = vm.snapshotState();
            try desk.settle{gas: g}(id, record, _noChunks()) {
                lowest = g;
            } catch {}
            vm.revertToState(snap);
            if (lowest != 0) break;
        }
        emit log_named_uint("lowest gas that settles (healthy mock Payroll)", lowest);
        assertGt(lowest, 1_025_000);
        assertLt(lowest, 1_600_000);
    }

    /// A price of one wei has a fee and no tip: Payroll is paid the fee and is not called for a
    /// tip of nothing.
    function test_settle_aZeroTipIsNotAnnounced() public {
        IWorkOrders.OrderParams memory p = _params();
        p.minPay = 1;
        p.maxPay = 1;
        uint256 id = _registered(p);
        desk.settle(id, _landGood(id, JOB), _noChunks());
        assertEq(payroll.payCalls(), 1);
        assertEq(payroll.tipCalls(), 0);
        assertEq(imd.balanceOf(address(payroll)), 1);
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    /// Payroll cannot reach back into the desk while a settlement is under way.
    function test_settle_payrollCannotReenter() public {
        IWorkOrders.OrderParams memory p = _params();
        p.expiresAt = uint40(_now() + 10);
        uint256 other = _open(p);
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        vm.warp(START + 10);
        // `refund(other)` is open to anyone right now; only the lock stops it from inside Payroll.
        payroll.setMode(PayrollStandIn.Mode.Reenter);
        payroll.setReenter(address(desk), abi.encodeCall(desk.refund, (other)));
        desk.settle(id, record, _noChunks());
        assertFalse(payroll.reenterSucceeded());
        _assertState(other, IWorkOrders.State.Open);
        _assertState(id, IWorkOrders.State.Delivered);
        desk.refund(other);
        _assertSolvent();
    }

    /// Nor can it have the employer told about a delivery early, or twice: `redeliver` holds no
    /// lock of its own (the callback must run unlocked) but refuses to run inside a locked call.
    function test_settle_payrollCannotRedeliverMidSettlement() public {
        uint256 id = _bossOrder();
        bytes memory record = _landGood(id, JOB);
        payroll.setMode(PayrollStandIn.Mode.Reenter);
        payroll.setReenter(address(desk), abi.encodeCall(desk.redeliver, (id)));
        vm.expectCall(address(desk), abi.encodeCall(desk.redeliver, (id)));
        desk.settle(id, record, _noChunks());
        assertFalse(payroll.reenterSucceeded(), "the callback was triggered from inside the settlement");
        assertEq(boss.calls(), 1, "the employer was told more than once");
        assertTrue(desk.orderOf(id).notified);
        assertEq(imd.balanceOf(address(payroll)), 0.2e18);
    }

    /// A Payroll address with no code at all: the fee and tip still arrive there.
    function test_settle_payrollWithNoCode() public {
        address nowhere = makeAddr("payroll with no code");
        WorkOrders d = new WorkOrders(address(imd), address(proof), nowhere);
        vm.prank(employer);
        imd.approve(address(d), type(uint256).max);
        vm.prank(runner);
        imd.approve(address(d), type(uint256).max);
        vm.prank(employer);
        uint256 id = d.createOrder(_params(), SPEC);
        vm.prank(runner);
        d.claim(id);
        vm.prank(runner);
        d.register(id, JOB);
        bytes memory record =
            _landOtherObjective(JOB, bytes.concat(_refHeader(block.chainid, address(d), id, 1, runner), SPEC));
        d.settle(id, record, _noChunks());
        assertEq(imd.balanceOf(nowhere), 0.2e18);
        assertEq(imd.balanceOf(address(d)), 0);
        assertEq(imd.allowance(address(d), nowhere), 0);
    }

    // --- settle: the employer callback --------------------------------------------------------

    function test_callback_tellsTheEmployerLast() public {
        uint256 id = _bossOrder();
        bytes memory record = _landGood(id, JOB);
        desk.settle(id, record, _noChunks());
        assertEq(boss.calls(), 1);
        assertEq(boss.lastOrderId(), id);
        assertEq(boss.lastJobId(), JOB);
        assertEq(boss.lastRecordHash(), keccak256(record));
        // It was offered the whole allowance and not more.
        assertLe(boss.gasSeen(), 150_000);
        assertGt(boss.gasSeen(), 149_000);
        assertTrue(desk.orderOf(id).notified);
    }

    function test_callback_notMadeWithoutTheFlag() public {
        IWorkOrders.OrderParams memory p = _params();
        uint256 id = boss.open(p, SPEC);
        _claim(id, runner);
        _register(id, runner, JOB);
        desk.settle(id, _landGood(id, JOB), _noChunks());
        assertEq(boss.calls(), 0);
        assertFalse(desk.orderOf(id).notified);
    }

    function test_callback_aRevertChangesNothing() public {
        uint256 id = _bossOrder();
        boss.setMode(MockEmployer.Mode.Revert);
        bytes memory record = _landGood(id, JOB);
        address[] memory none = _noChunks();
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.CallbackFailed(id);
        desk.settle(id, record, none);
        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(imd.balanceOf(runner), FUNDS + 1.8e18);
        assertEq(boss.calls(), 0);
        assertFalse(desk.orderOf(id).notified);
        _assertSolvent();
    }

    function test_callback_burningAllItsGasChangesNothing() public {
        uint256 id = _bossOrder();
        bytes memory record = _landGood(id, JOB);

        // What the same settlement costs with a callback that behaves.
        uint256 snap = vm.snapshotState();
        uint256 before = gasleft();
        desk.settle(id, record, _noChunks());
        uint256 usedPlain = before - gasleft();
        assertTrue(desk.orderOf(id).notified);
        vm.revertToState(snap);

        boss.setMode(MockEmployer.Mode.BurnGas);
        before = gasleft();
        desk.settle(id, record, _noChunks());
        uint256 used = before - gasleft();
        _assertState(id, IWorkOrders.State.Delivered);
        assertFalse(desk.orderOf(id).notified);
        assertLt(used, usedPlain + desk.CALLBACK_GAS(), "the callback cost more than its allowance");
    }

    function test_callback_aLargeReturnCostsTheDeskNothing() public {
        uint256 id = _bossOrder();
        boss.setMode(MockEmployer.Mode.ReturnBomb);
        bytes memory record = _landGood(id, JOB);
        uint256 before = gasleft();
        desk.settle(id, record, _noChunks());
        uint256 used = before - gasleft();
        assertEq(boss.calls(), 1);
        assertTrue(desk.orderOf(id).notified);
        assertLt(used, 700_000);
    }

    /// The callback really can use what it was promised.
    function test_callback_canUseItsAllowance() public {
        uint256 id = _bossOrder();
        boss.setMode(MockEmployer.Mode.UseGas);
        // 60,000 gas of storage writes (rounded up to the next write) on top of the mock's own
        // bookkeeping: well over 100,000 in all, which only fits if the allowance is really there.
        boss.setGasToUse(60_000);
        desk.settle(id, _landGood(id, JOB), _noChunks());
        assertEq(boss.calls(), 1);
        assertTrue(desk.orderOf(id).notified);
        // And a callback that needs more than the allowance fails without touching the delivery.
        uint256 next = _bossOrder2();
        boss.setGasToUse(140_000);
        desk.settle(next, _landGood(next, JOB2), _noChunks());
        assertEq(boss.calls(), 1);
        assertFalse(desk.orderOf(next).notified);
        _assertState(next, IWorkOrders.State.Delivered);
    }

    /// Everything is final and the lock is released before the callback, so the employer can act
    /// on the desk from inside it: here it withdraws another of its orders.
    function test_callback_mayCallBackIntoTheDesk() public {
        uint256 other = boss.open(_params(), SPEC);
        uint256 id = _bossOrder();
        boss.setMode(MockEmployer.Mode.Reenter);
        boss.setReenter(abi.encodeCall(desk.cancel, (other)));
        desk.settle(id, _landGood(id, JOB), _noChunks());
        assertEq(boss.calls(), 1);
        assertTrue(boss.reenterSucceeded(), "the desk was still locked during the callback");
        _assertState(other, IWorkOrders.State.Cancelled);
        _assertState(id, IWorkOrders.State.Delivered);
        _assertSolvent();
    }

    /// What the allowance does not cover: opening a new order costs about 280,000 gas, more than
    /// the 150,000 a callback gets. An employer that hires again does so in a call of its own; a
    /// callback that tries simply fails, and the delivery stands.
    function test_callback_cannotOpenAnOrderWithinItsAllowance() public {
        uint256 id = _bossOrder();
        boss.setMode(MockEmployer.Mode.Rehire);
        IWorkOrders.OrderParams memory p = _params();
        p.maxPay = 1e18;
        p.minPay = 1e18;
        boss.setRehire(p, "Do it again");
        bytes memory record = _landGood(id, JOB);
        address[] memory none = _noChunks();
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.CallbackFailed(id);
        desk.settle(id, record, none);
        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(boss.calls(), 0);
        assertEq(desk.orderCount(), id);
        assertFalse(desk.orderOf(id).notified);
        _assertSolvent();
    }

    /// The callback can call the desk (the lock is released), but the order it was told about is
    /// final: it cannot be settled, cancelled or redelivered from inside.
    function test_callback_cannotTouchTheDeliveredOrder() public {
        uint256 id = _bossOrder();
        bytes memory record = _landGood(id, JOB);
        boss.setMode(MockEmployer.Mode.Reenter);

        // (The re-entrant settle carries a short stand-in for the record: the callback has 150,000
        // gas, and the order's state is checked before any record is read.)
        bytes[3] memory attempts = [
            abi.encodeCall(desk.settle, (id, "x", _noChunks())),
            abi.encodeCall(desk.cancel, (id)),
            abi.encodeCall(desk.redeliver, (id))
        ];
        for (uint256 i; i < attempts.length; ++i) {
            uint256 snap = vm.snapshotState();
            boss.setReenter(attempts[i]);
            desk.settle(id, record, _noChunks());
            assertEq(boss.calls(), 1);
            assertFalse(boss.reenterSucceeded(), "the callback changed a delivered order");
            assertEq(bytes4(boss.reenterHead()), IWorkOrdersRunner.BadState.selector);
            _assertState(id, IWorkOrders.State.Delivered);
            assertEq(imd.balanceOf(address(desk)), 0);
            vm.revertToState(snap);
        }
    }

    /// A view from inside the callback sees the finished order.
    function test_callback_seesFinalState() public {
        uint256 id = _bossOrder();
        boss.setMode(MockEmployer.Mode.Reenter);
        boss.setReenter(abi.encodeCall(desk.accountOf, (id)));
        desk.settle(id, _landGood(id, JOB), _noChunks());
        assertTrue(boss.reenterSucceeded());
        // Delivered, nothing left in escrow, the price spent and the rest returned.
        bytes memory seen =
            abi.encode(IWorkOrders.State.Delivered, address(boss), uint96(0), MIN_PAY, MAX_PAY - MIN_PAY);
        assertEq(boss.reenterHash(), keccak256(seen));
    }

    function test_callback_anEmployerWithNoCodeIsFine() public {
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 2;
        uint256 id = _registered(p);
        desk.settle(id, _landGood(id, JOB), _noChunks());
        _assertState(id, IWorkOrders.State.Delivered);
    }

    /// @dev An order with a price of zero held by `runner` with JOB registered: delivering it
    /// makes no Payroll call, so the callback's own gas check is the one that decides.
    function _freeBossOrder() internal returns (uint256 id) {
        IWorkOrders.OrderParams memory p = _params();
        p.flags = 2;
        p.minPay = 0;
        p.rampSecs = type(uint32).max;
        id = boss.open(p, SPEC);
        _claim(id, runner);
        _register(id, runner, JOB);
        assertEq(desk.claimOf(id).price, 0);
    }

    /// Whatever gas the caller sends, either the whole settlement reverts or the callback ran with
    /// its whole allowance. There is no amount that settles and starves it.
    function test_callback_cannotBeStarvedByTheCaller() public {
        uint256 id = _freeBossOrder();
        bytes memory record = _landGood(id, JOB);

        // What the mock sees of 150,000 gas when nothing is short.
        uint256 snap = vm.snapshotState();
        desk.settle(id, record, _noChunks());
        uint256 full = boss.gasSeen();
        assertLe(full, 150_000);
        assertGt(full, 149_000);
        vm.revertToState(snap);

        // Coarsely over a wide range, to find where the gas check starts to bite ...
        uint256 lowest = type(uint256).max;
        for (uint256 g = 700_000; g >= 150_000; g -= 5_000) {
            snap = vm.snapshotState();
            try desk.settle{gas: g}(id, record, _noChunks()) {
                lowest = g;
                assertEq(boss.calls(), 1, "settled without the callback");
                assertEq(boss.gasSeen(), full, "the callback was starved");
            } catch {
                assertEq(boss.calls(), 0);
            }
            vm.revertToState(snap);
        }
        assertLt(lowest, 700_000);

        // ... then finely across that boundary. A check that is short by even a few thousand gas
        // (no slack for the storage write and the cold account, say) shows here as a settlement
        // whose callback got less than the whole allowance.
        uint256 shortReverts;
        uint256 successes;
        for (uint256 g = lowest + 3_000; g >= lowest - 12_000; g -= 25) {
            snap = vm.snapshotState();
            try desk.settle{gas: g}(id, record, _noChunks()) {
                ++successes;
                assertEq(boss.calls(), 1, "settled without the callback");
                assertEq(boss.gasSeen(), full, "the callback was starved");
                assertTrue(desk.orderOf(id).notified);
            } catch (bytes memory err) {
                if (bytes4(err) == IWorkOrdersRunner.GasShort.selector) ++shortReverts;
                assertEq(boss.calls(), 0);
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
        assertGt(shortReverts, 0, "the gas check never fired");
    }

    /// The same for a retried callback, where the storage the desk touches first is cold.
    function test_redeliver_cannotStarveTheCallbackEither() public {
        uint256 id = _bossOrder();
        boss.setMode(MockEmployer.Mode.Revert);
        desk.settle(id, _landGood(id, JOB), _noChunks());
        boss.setMode(MockEmployer.Mode.Record);

        uint256 snap = vm.snapshotState();
        desk.redeliver(id);
        uint256 full = boss.gasSeen();
        assertLe(full, 150_000);
        assertGt(full, 149_000);
        vm.revertToState(snap);

        uint256 shortReverts;
        uint256 successes;
        for (uint256 g = 190_000; g >= 150_000; g -= 25) {
            snap = vm.snapshotState();
            try desk.redeliver{gas: g}(id) {
                ++successes;
                assertEq(boss.calls(), 1);
                assertEq(boss.gasSeen(), full, "the callback was starved");
            } catch (bytes memory err) {
                if (bytes4(err) == IWorkOrdersRunner.GasShort.selector) ++shortReverts;
                assertEq(boss.calls(), 0);
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
        assertGt(shortReverts, 0, "the gas check never fired");
    }

    /// With a fee to pay, the Payroll calls ask for far more headroom than the callback does, so
    /// a settlement that got past them always has the callback's allowance to hand.
    function test_callback_alwaysFullAfterPayroll() public {
        uint256 id = _bossOrder();
        bytes memory record = _landGood(id, JOB);
        uint256 snap0 = vm.snapshotState();
        desk.settle(id, record, _noChunks());
        uint256 full = boss.gasSeen();
        vm.revertToState(snap0);
        uint256 successes;
        for (uint256 g = 1_000_000; g <= 1_800_000; g += 10_000) {
            uint256 snap = vm.snapshotState();
            try desk.settle{gas: g}(id, record, _noChunks()) {
                ++successes;
                assertEq(boss.calls(), 1);
                assertEq(boss.gasSeen(), full, "the callback was starved");
            } catch (bytes memory err) {
                assertEq(bytes4(err), IWorkOrdersRunner.GasShort.selector);
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
    }

    // --- redeliver ----------------------------------------------------------------------------

    function test_redeliver_retriesAFailedCallback() public {
        uint256 id = _bossOrder();
        boss.setMode(MockEmployer.Mode.Revert);
        bytes memory record = _landGood(id, JOB);
        desk.settle(id, record, _noChunks());
        assertFalse(desk.orderOf(id).notified);

        // Still failing: nothing changes and it can be tried again.
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.CallbackFailed(id);
        desk.redeliver(id);
        assertFalse(desk.orderOf(id).notified);

        boss.setMode(MockEmployer.Mode.Record);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Redelivered(id);
        vm.prank(stranger);
        desk.redeliver(id);
        assertEq(boss.calls(), 1);
        assertEq(boss.lastOrderId(), id);
        assertEq(boss.lastJobId(), JOB);
        assertEq(boss.lastRecordHash(), keccak256(record));
        assertTrue(desk.orderOf(id).notified);
        assertEq(imd.balanceOf(address(desk)), 0);

        // Once through, never again.
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.redeliver(id);
        assertEq(boss.calls(), 1);
    }

    function test_redeliver_revertsWhenThereIsNothingToRetry() public {
        // Not delivered.
        uint256 id = _bossOrder();
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.redeliver(id);
        // Delivered and told.
        desk.settle(id, _landGood(id, JOB), _noChunks());
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.redeliver(id);
        // Delivered, but the employer never asked to be told.
        uint256 plain = _open();
        _claim(plain, runner);
        _register(plain, runner, JOB2);
        desk.settle(plain, _landGood(plain, JOB2), _noChunks());
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.redeliver(plain);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.redeliver(12345);
    }

    function test_redeliver_needsTheSameGasHeadroom() public {
        uint256 id = _bossOrder();
        boss.setMode(MockEmployer.Mode.Revert);
        desk.settle(id, _landGood(id, JOB), _noChunks());
        boss.setMode(MockEmployer.Mode.Record);
        vm.expectRevert(IWorkOrdersRunner.GasShort.selector);
        desk.redeliver{gas: 120_000}(id);
        desk.redeliver{gas: 400_000}(id);
        assertEq(boss.calls(), 1);
    }

    // --- reportFailed -------------------------------------------------------------------------

    /// The swarm failed a job the runner opened correctly: the runner reports it and is made whole.
    function test_reportFailed_swarmFailureReturnsTheBondToTheRunner() public {
        uint256 id = _registered();
        bytes memory record = _land(id, JOB, KIND, "failed");

        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Failed(id, JOB, keccak256(record));
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.SwarmFailed, BOND, 0, 0, IWorkOrders.State.Open
        );
        vm.prank(runner);
        desk.reportFailed(id, record, _noChunks());

        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner), FUNDS, "the runner lost part of its bond");
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY, "the employer gained from a swarm failure");
        assertEq(desk.orderOf(id).returned, 0);
        assertFalse(desk.barred(id, runner));
        assertEq(desk.orderOfJob(JOB), 0);
        _assertSolvent();
        // It may take the order again, on a new ticket.
        _claim(id, runner);
        assertEq(desk.orderOf(id).seq, 2);
    }

    /// Only the runner decides to give a correctly opened job up: nobody else can end its claim
    /// with a record that is merely not finished, or cut off a retry.
    function test_reportFailed_swarmFailureOnlyTheRunnerMayReport() public {
        uint256 id = _registered();
        bytes memory record = _land(id, JOB, KIND, "failed");
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.reportFailed(id, record, _noChunks());
        vm.prank(employer);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.reportFailed(id, record, _noChunks());
        _assertState(id, IWorkOrders.State.Registered);
    }

    /// Right objective, completed, but filed under another kind than the order's: this job can
    /// never settle the order. Anyone may report it, so the order is free as soon as the receipt
    /// exists; the bond goes back to the runner, because the desk cannot tell a wrong template
    /// from a kind the swarm renamed.
    function test_reportFailed_anotherKindFreesTheOrderForAnyoneAndReturnsTheBond() public {
        uint256 id = _registered();
        bytes memory record = _land(id, JOB, "single", "completed");
        vm.expectRevert(IWorkOrdersRunner.WrongKind.selector);
        desk.settle(id, record, _noChunks());

        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.SwarmFailed, BOND, 0, 0, IWorkOrders.State.Open
        );
        vm.prank(stranger);
        desk.reportFailed(id, record, _noChunks());
        assertEq(imd.balanceOf(runner), FUNDS);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY);
        assertEq(imd.balanceOf(stranger), FUNDS);
        assertFalse(desk.barred(id, runner));
        _assertState(id, IWorkOrders.State.Open);
        _assertSolvent();
    }

    /// Another kind and not completed either: still a job that did not finish, so it stays the
    /// runner's to give up.
    function test_reportFailed_anotherKindThatAlsoFailedIsTheRunnersToReport() public {
        uint256 id = _registered();
        bytes memory record = _land(id, JOB, "single", "blocked");
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.reportFailed(id, record, _noChunks());
        vm.prank(runner);
        desk.reportFailed(id, record, _noChunks());
        assertEq(imd.balanceOf(runner), FUNDS);
        _assertState(id, IWorkOrders.State.Open);
    }

    /// A registered job whose objective is too short to hold a header. WorkProof refuses to split
    /// it after 85 bytes; the desk reads it again unsplit and treats it as what it is: a job for
    /// some other objective.
    function test_reportFailed_aJobWithAShortObjectiveIsAWrongJob() public {
        uint256 id = _registered();
        bytes memory record = _landOtherObjective(JOB, "hello world");
        vm.expectRevert(IWorkProof.HeadTooLong.selector);
        desk.settle(id, record, _noChunks());

        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Failed(id, JOB, keccak256(record));
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.WrongJob, 0, BOND, 0, IWorkOrders.State.Open
        );
        vm.prank(stranger);
        desk.reportFailed(id, record, _noChunks());
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        _assertSolvent();
    }

    /// The objective lengths around a header: 84 bytes (too short to split), exactly 85 (a header
    /// and no spec), and 86. None is this claim's objective, so each is a wrong job.
    function test_reportFailed_objectivesAroundTheHeaderLength() public {
        uint256[4] memory lengths = [uint256(0), 84, 85, 86];
        for (uint256 i; i < lengths.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 id = _registered();
            bytes memory objective = new bytes(lengths[i]);
            for (uint256 k; k < objective.length; ++k) {
                objective[k] = "x";
            }
            bytes memory record = _landOtherObjective(JOB, objective);
            desk.reportFailed(id, record, _noChunks());
            assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
            vm.revertToState(snap);
        }
        // This claim's header with no spec after it is a wrong job too: every spec has a byte.
        uint256 own = _registered();
        bytes memory headerOnly = _landOtherObjective(JOB, desk.headerOf(own));
        vm.expectRevert(IWorkOrdersRunner.WrongSpec.selector);
        desk.settle(own, headerOnly, _noChunks());
        desk.reportFailed(own, headerOnly, _noChunks());
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
    }

    /// Any other failure of WorkProof is passed on as it is, and ends nothing. Each of WorkProof's
    /// own errors is produced here by a receipt the registry really holds for the job, and reaches
    /// the caller of `reportFailed` and of `settle` with its arguments unchanged.
    function test_reportFailed_passesOnWorkProofsOwnErrors() public {
        uint256 id = _registered();
        bytes memory good = _recordOf(JOB, KIND, _objective(id), "failed");

        // The registry holds another document for the job: HashMismatch(expected, got).
        _write(JOB, good);
        bytes memory other = bytes.concat(good, " ");
        bytes memory mismatch =
            abi.encodeWithSelector(IWorkProof.HashMismatch.selector, keccak256(good), keccak256(other));
        _expectBoth(id, other, mismatch);

        // The receipt is of a record that names another job: JobIdMismatch().
        bytes memory forAnotherJob = _recordOf(JOB2, KIND, _objective(id), "failed");
        _write(JOB, forAnotherJob);
        _expectBoth(id, forAnotherJob, abi.encodeWithSelector(IWorkProof.JobIdMismatch.selector));

        // The receipt is of a record under another schema: WrongSchema().
        bytes memory otherSchema = _withMember(good, "schema", '"identitymd-work-v2"');
        _write(JOB, otherSchema);
        _expectBoth(id, otherSchema, abi.encodeWithSelector(IWorkProof.WrongSchema.selector));

        // The receipt is of bytes that are not a work record at all: Malformed(0).
        bytes memory notJson = "not a work record";
        _write(JOB, notJson);
        _expectBoth(id, notJson, abi.encodeWithSelector(IWorkProof.Malformed.selector, uint256(0)));

        // The registry stops answering: NoReceipt(jobId).
        _write(JOB, good);
        registry.setDown(true);
        _expectBoth(id, good, abi.encodeWithSelector(IWorkProof.NoReceipt.selector, JOB));

        _assertState(id, IWorkOrders.State.Registered);
        assertEq(imd.balanceOf(runner), FUNDS - BOND, "nothing was paid or forfeited");
        _assertSolvent();
    }

    /// @dev `reportFailed` (as the runner) and `settle` both revert with exactly `revertData`.
    function _expectBoth(uint256 id, bytes memory record, bytes memory revertData) internal {
        vm.prank(runner);
        vm.expectRevert(revertData);
        desk.reportFailed(id, record, _noChunks());
        vm.expectRevert(revertData);
        desk.settle(id, record, _noChunks());
    }

    /// The runner registered a job with another objective: anyone reports it, the employer gets the bond.
    function test_reportFailed_wrongJobSendsTheBondToTheEmployer() public {
        uint256 id = _registered();
        bytes memory record = _landOtherObjective(JOB, bytes.concat(_refHeader(1, address(desk), id, 1, runner2), SPEC));

        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Failed(id, JOB, keccak256(record));
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.WrongJob, 0, BOND, 0, IWorkOrders.State.Open
        );
        vm.prank(stranger);
        desk.reportFailed(id, record, _noChunks());

        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
        assertEq(imd.balanceOf(stranger), FUNDS);
        assertEq(desk.orderOf(id).returned, BOND);
        _assertSolvent();
    }

    function test_reportFailed_wrongSpecAloneIsAWrongJob() public {
        uint256 id = _registered();
        bytes memory objective = bytes.concat(_refHeader(block.chainid, address(desk), id, 1, runner), "Some other job");
        bytes memory record = _landOtherObjective(JOB, objective);
        desk.reportFailed(id, record, _noChunks());
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
    }

    /// A wrong job is a wrong job whether or not it completed.
    function test_reportFailed_wrongJobThatAlsoFailed() public {
        uint256 id = _registered();
        bytes memory record =
            _landWith(JOB, KIND, bytes.concat(_refHeader(1, address(desk), 999, 1, runner), SPEC), "failed", _agents());
        vm.prank(stranger);
        desk.reportFailed(id, record, _noChunks());
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
    }

    function test_reportFailed_revertsOnAReceiptThatSettles() public {
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.NotFailed.selector);
        desk.reportFailed(id, record, _noChunks());
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.NotFailed.selector);
        desk.reportFailed(id, record, _noChunks());
    }

    function test_reportFailed_revertsWithoutAReceiptOrWithOtherBytes() public {
        uint256 id = _registered();
        bytes memory unrecorded = _record(JOB);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, JOB));
        desk.reportFailed(id, unrecorded, _noChunks());
        bytes memory record = _land(id, JOB, KIND, "failed");
        bytes memory other = bytes.concat(record, "x");
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, keccak256(record), keccak256(other)));
        desk.reportFailed(id, other, _noChunks());
    }

    function test_reportFailed_revertsUnlessAJobIsRegistered() public {
        uint256 id = _open();
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.reportFailed(id, "x", _noChunks());
        _claim(id, runner);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.reportFailed(id, "x", _noChunks());
    }

    /// After the runner registered a retry, the first job's failure no longer concerns the order.
    function test_reportFailed_aRetryShieldsTheClaimFromTheFirstFailure() public {
        uint256 id = _registered();
        bytes memory record = _land(id, JOB, KIND, "failed");
        _register(id, runner, JOB2);
        vm.prank(runner);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, JOB2));
        desk.reportFailed(id, record, _noChunks());
        _assertState(id, IWorkOrders.State.Registered);
        desk.settle(id, _landGood(id, JOB2), _noChunks());
    }

    function test_reportFailed_afterExpiryRefundsTheOrder() public {
        uint256 id = _registered();
        bytes memory record = _land(id, JOB, KIND, "failed");
        vm.warp(START + LIFE);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Refunded(id, MAX_PAY);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.SwarmFailed, BOND, 0, 0, IWorkOrders.State.Refunded
        );
        vm.prank(runner);
        desk.reportFailed(id, record, _noChunks());
        _assertState(id, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(runner), FUNDS);
        assertEq(imd.balanceOf(employer), FUNDS);
        assertEq(desk.orderOf(id).returned, MAX_PAY);
        _assertSolvent();
    }

    function test_reportFailed_worksFromChunks() public {
        uint256 id = _registered();
        bytes memory record = _land(id, JOB, KIND, "blocked");
        address[] memory chunks = new address[](1);
        chunks[0] = address(0xC0FFEE03);
        vm.etch(chunks[0], bytes.concat(hex"00", record));
        vm.prank(runner);
        desk.reportFailed(id, "", chunks);
        _assertState(id, IWorkOrders.State.Open);
    }

    // --- timeout ------------------------------------------------------------------------------

    function test_timeout_afterTheDeliveryTimeTheBondGoesToTheEmployer() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.warp(START + 1000);
        _register(id, runner, JOB);

        vm.warp(START + 1000 + DELIVERY - 1);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.timeout(id);

        vm.warp(START + 1000 + DELIVERY);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.TimedOut, 0, BOND, 0, IWorkOrders.State.Open
        );
        vm.prank(stranger);
        desk.timeout(id);

        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
        assertEq(desk.orderOf(id).returned, BOND);
        assertEq(desk.orderOf(id).escrow, MAX_PAY);
        _assertSolvent();
        // Open again for anyone, the same runner included (a timeout does not bar it).
        assertFalse(desk.barred(id, runner));
        _claim(id, runner);
        assertEq(desk.orderOf(id).seq, 2);
    }

    function test_timeout_afterExpiryRefundsTheOrder() public {
        IWorkOrders.OrderParams memory p = _params();
        p.expiresAt = uint40(START + 1 days);
        uint256 id = _registered(p);
        vm.warp(START + DELIVERY);
        desk.timeout(id);
        _assertState(id, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(employer), FUNDS + BOND);
        assertEq(desk.orderOf(id).returned, MAX_PAY + BOND);
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    function test_timeout_revertsUnlessRegisteredOrDisputed() public {
        uint256 id = _open();
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.timeout(id);
        _claim(id, runner);
        vm.warp(START + 10 days);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.timeout(id);
    }

    function test_timeout_twiceReverts() public {
        uint256 id = _registered();
        vm.warp(START + DELIVERY);
        desk.timeout(id);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.timeout(id);
    }

    // --- nothing leaks through the lock --------------------------------------------------------

    /// Every locked function, called one after another inside a single transaction: if any of
    /// them left the lock set, the next would revert.
    function test_lockIsReleasedAfterEveryCall() public {
        OneTransaction batch = new OneTransaction();
        imd.mint(address(batch), FUNDS);
        vm.prank(address(batch));
        imd.approve(address(desk), type(uint256).max);
        cond.set(10);
        IWorkOrders.OrderParams memory p = _condParams(1, 10);
        p.flags = 1;
        p.arbiter = address(batch);
        // The batch contract is employer, runner, challenger and arbiter at once; orders 1 to 5.
        bytes memory good = _record(JOB);
        bytes[] memory calls = new bytes[](21);
        calls[0] = abi.encodeCall(desk.createOrder, (p, SPEC));
        calls[1] = abi.encodeCall(desk.trigger, (1));
        calls[2] = abi.encodeCall(desk.claim, (1));
        calls[3] = abi.encodeCall(desk.release, (1));
        calls[4] = abi.encodeCall(desk.cancel, (1));
        calls[5] = abi.encodeCall(desk.createOrder, (p, SPEC));
        calls[6] = abi.encodeCall(desk.claim, (2));
        calls[7] = abi.encodeCall(desk.register, (2, JOB));
        calls[8] = abi.encodeCall(desk.claimDelivered, (2, keccak256(good)));
        calls[9] = abi.encodeCall(desk.challenge, (2));
        calls[10] = abi.encodeCall(desk.resolve, (2, true));
        calls[11] = abi.encodeCall(desk.createOrder, (p, SPEC));
        calls[12] = abi.encodeCall(desk.claim, (3));
        calls[13] = abi.encodeCall(desk.register, (3, JOB2));
        calls[14] = abi.encodeCall(desk.claimDelivered, (3, keccak256(good)));
        calls[15] = abi.encodeCall(desk.challenge, (3));
        calls[16] = abi.encodeCall(desk.resolve, (3, false));
        calls[17] = abi.encodeCall(desk.claim, (3));
        calls[18] = abi.encodeCall(desk.register, (3, JOB2));
        calls[19] = abi.encodeCall(desk.createOrder, (p, SPEC));
        calls[20] = abi.encodeCall(desk.cancel, (4));
        batch.run(address(desk), calls);
        _assertState(1, IWorkOrders.State.Cancelled);
        _assertState(2, IWorkOrders.State.Delivered);
        _assertState(3, IWorkOrders.State.Registered);
        _assertState(4, IWorkOrders.State.Cancelled);

        // The receipt-reading functions, again in one transaction: settle, reportFailed, stamp,
        // then the time-bound ones.
        bytes memory record3 = _landGood(3, JOB2);
        bytes memory record2 = _landGood(2, JOB);
        calls = new bytes[](3);
        calls[0] = abi.encodeCall(desk.stamp, (2, record2, _noChunks()));
        calls[1] = abi.encodeCall(desk.settle, (3, record3, _noChunks()));
        calls[2] = abi.encodeCall(desk.createOrder, (p, SPEC));
        batch.run(address(desk), calls);
        assertTrue(desk.orderOf(2).proven);
        _assertState(3, IWorkOrders.State.Delivered);

        // (JOB and JOB2 have settled orders by now, so these two register jobs of their own.)
        uint256 a = _open();
        _claim(a, runner);
        _register(a, runner, bytes16(uint128(0xA)));
        uint256 b = _open();
        _claim(b, runner2);
        uint256 c = _open(_claimedParams());
        _claim(c, runner);
        _register(c, runner, bytes16(uint128(0xC)));
        vm.prank(runner);
        desk.claimDelivered(c, keccak256(good));
        vm.warp(START + LIFE);
        calls = new bytes[](5);
        calls[0] = abi.encodeCall(desk.timeout, (a));
        calls[1] = abi.encodeCall(desk.evict, (b));
        calls[2] = abi.encodeCall(desk.finalize, (c));
        calls[3] = abi.encodeCall(desk.refund, (5));
        calls[4] = abi.encodeCall(desk.redeliver, (c));
        // The last call is refused for its own reason (the order asked for no callback), which
        // shows the calls before it all went through and left the desk unlocked.
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        batch.run(address(desk), calls);
        calls = new bytes[](4);
        calls[0] = abi.encodeCall(desk.timeout, (a));
        calls[1] = abi.encodeCall(desk.evict, (b));
        calls[2] = abi.encodeCall(desk.finalize, (c));
        calls[3] = abi.encodeCall(desk.refund, (5));
        batch.run(address(desk), calls);
        _assertState(a, IWorkOrders.State.Refunded);
        _assertState(b, IWorkOrders.State.Refunded);
        _assertState(c, IWorkOrders.State.Delivered);
        _assertState(5, IWorkOrders.State.Refunded);
        _assertSolvent();
    }

    function test_reentrancyErrorIsTheGuardOne() public {
        // Documented for integrators: a locked call fails with OpenZeppelin's guard error.
        IWorkOrders.OrderParams memory p = _params();
        p.expiresAt = uint40(_now() + 10);
        uint256 other = _open(p);
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        vm.warp(START + 10);
        payroll.setMode(PayrollStandIn.Mode.Reenter);
        payroll.setReenter(address(desk), abi.encodeCall(desk.refund, (other)));
        vm.expectCall(address(desk), abi.encodeCall(desk.refund, (other)));
        desk.settle(id, record, _noChunks());
        assertFalse(payroll.reenterSucceeded());
        assertEq(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector, bytes4(0x3ee5aeb5));
    }
}
