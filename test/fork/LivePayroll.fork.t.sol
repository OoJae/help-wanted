// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {IPayroll} from "../../src/interfaces/IPayroll.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {DeskOnFork} from "./DeskOnFork.sol";
import {ILivePayroll, ISeatBinding, ISeatOwner} from "./ForkKit.sol";

/// @dev Makes one call from inside a transaction and reports what it used: the call's own
/// execution, without the outer transaction's base cost and calldata.
contract ForkCallMeter {
    function run(address target, bytes calldata data) external returns (uint256 used) {
        bytes memory input = data;
        bool ok;
        assembly ("memory-safe") {
            let before := gas()
            ok := call(gas(), target, 0, add(input, 0x20), mload(input), 0, 0)
            used := sub(before, gas())
            if iszero(ok) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }
}

/// @title The desk against the live Payroll
/// @notice `Payroll` is the one contract this launch pays that it does not create: it belongs to
/// HELP WANTED's first launch and has been on Ethereum mainnet since 13 October 2026. These tests
/// run this launch's desk against that contract on a fork, with real IMD:
///
/// - the address in `Mainnet.sol` holds the code that launch deployed, wired to the real IMD;
/// - a settlement's fee is booked by the real `pay` and its tip by the real `tip`, each agent the
///   record names is owed an equal share, and the tip can then be claimed for the seat the agent
///   is bound to, under the launched rule for seats held by a contract;
/// - what a settlement costs with it, and the least gas a sender must offer;
/// - a failure inside Payroll does not block a settlement: the desk sends what was not taken by
///   plain transfer, and the live `book()` then books it;
/// - the stand-in the local tests use books the same amounts as the live contract.
///
/// The live Payroll cannot be made to fail by a caller (its `pay` and `tip` revert only if the
/// IMD transfer does), so the failures here are imposed from outside: its two calls are made to
/// revert with a cheatcode, or its code is replaced on the fork by code that uses every unit of
/// gas it is given. The first leaves the real `book()` in place to show where the money ends up.
///
/// Run with `FOUNDRY_PROFILE=fork forge test`. Every test skips itself when the RPC cannot be reached.
contract LivePayrollForkTest is DeskOnFork {
    ForkCallMeter internal meter;

    /// @dev The gas limit `docs/LAUNCH.md` tells a sender to give `settle`.
    uint256 internal constant SETTLE_GAS_LIMIT = 3_000_000;
    /// @dev Agent ids nobody has been tipped under: far above any id in use.
    uint256 internal constant UNSEEN_AGENT = 9_100_000_000;

    function setUp() public override {
        super.setUp();
        if (forked) meter = new ForkCallMeter();
    }

    // ---- helpers --------------------------------------------------------------------------------

    /// @dev An order with a registered job whose receipt is in the real registry, naming `agents`
    /// (the reference record's own agent when the list is empty).
    function _readyToSettle(uint256[] memory agents) internal returns (uint256 id, bytes memory record) {
        id = _open(0);
        bytes16 jobId = _take(id);
        bytes memory objective = bytes.concat(desk.headerOf(id), SPEC);
        record = agents.length == 0
            ? _recordOf(jobId, KIND, objective, "completed")
            : _recordOf(jobId, KIND, objective, "completed", agents);
        _recordWork(jobId, record);
    }

    function _unseen(uint256 n) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = UNSEEN_AGENT + i;
        }
    }

    function _settleCall(uint256 id, bytes memory record) internal pure returns (bytes memory) {
        return abi.encodeCall(IWorkOrdersRunner.settle, (id, record, new address[](0)));
    }

    /// @dev The least gas, to the nearest thousand, on which this settlement goes through. A
    /// thousand below it the desk refuses up front (`GasShort`) and nothing has changed.
    function _leastGas(uint256 id, bytes memory data) internal returns (uint256 high) {
        uint256 low = 500_000;
        high = 4_000_000;
        uint256 snap = vm.snapshotState();
        while (high - low > 1_000) {
            uint256 mid = (low + high) / 2;
            (bool ok,) = address(desk).call{gas: mid}(data);
            if (ok) high = mid;
            else low = mid;
            vm.revertToState(snap);
        }
        (bool tooLittle, bytes memory ret) = address(desk).call{gas: low}(data);
        assertFalse(tooLittle);
        assertEq(bytes4(ret), IWorkOrdersRunner.GasShort.selector, "refused up front, not half done");
        _assertState(id, IWorkOrders.State.Registered);
    }

    /// @dev Settles on the live Payroll and prints what it used and what had to be offered.
    function _measured(uint256 id, bytes memory record, string memory label)
        internal
        returns (uint256 used, uint256 least)
    {
        bytes memory data = _settleCall(id, record);
        least = _leastGas(id, data);
        vm.recordLogs();
        used = meter.run(address(desk), data);
        _assertState(id, IWorkOrders.State.Delivered);
        assertFalse(_fellBack(), "Payroll took the fee and the tip itself");
        emit log_named_uint(string.concat(label, ": settle, execution"), used);
        emit log_named_uint(string.concat(label, ": least gas to offer (to 1,000)"), least);
        // The desk asks for room to hand each Payroll call its whole allowance, so more must be
        // offered than is used; and the documented limit covers it.
        assertGt(least, 1_300_000, "a settlement went through without room for Payroll's allowance");
        assertGt(least, used, label);
        assertLt(least, SETTLE_GAS_LIMIT, "the documented gas limit does not cover this settlement");
    }

    /// @dev Whether the desk emitted `PayrollFallback` in the logs recorded since `vm.recordLogs`.
    function _fellBack() internal view returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(desk) && logs[i].topics[0] == IWorkOrdersRunner.PayrollFallback.selector) {
                return true;
            }
        }
        return false;
    }

    // ---- the contract ---------------------------------------------------------------------------

    /// @notice The address this launch's manifest gives the desk holds the code HELP WANTED's
    /// first launch deployed, and that code is wired to the real IMD, sIMD, seats and Adapter.
    /// Every view the other tests and the runbook read answers.
    function test_fork_payroll_isTheContractTheFirstLaunchCreated() public onFork {
        assertEq(desk.PAYROLL(), Mainnet.PAYROLL);
        assertEq(Mainnet.PAYROLL.code.length, 11_846, "the runtime code launch 1531 deployed is 11,846 bytes");
        assertEq(Mainnet.PAYROLL.codehash, PAYROLL_CODEHASH, "not the code read from mainnet on 13 October 2026");

        assertEq(PAYROLL.IMD(), Mainnet.IMD);
        assertEq(PAYROLL.SIMD(), Mainnet.SIMD);
        assertEq(PAYROLL.SEATS(), Mainnet.SEATS);
        assertEq(PAYROLL.ADAPTER(), Mainnet.SEAT_ADAPTER);
        assertGt(PAYROLL.QUESTIONS().code.length, 0, "the Questions contract of the same launch");
        assertEq(PAYROLL.MAX_TIP_AGENTS(), 16, "WorkProof names at most as many agents as one tip credits");

        ILivePayroll.Ledger memory l = PAYROLL.ledger();
        emit log_named_uint("Payroll: revenue booked so far", l.received);
        emit log_named_uint("Payroll: tips taken so far", l.tipsIn);
        emit log_named_uint("Payroll: IMD waiting to be booked", PAYROLL.unbooked());
        assertGe(IMD.balanceOf(Mainnet.PAYROLL), PAYROLL.unbooked());
        emit log_named_uint("Payroll: tips owed to agent 52211", PAYROLL.tipOwed(REAL_AGENT));
        emit log_named_uint("Payroll: claimable by seat 0", PAYROLL.seatClaimable(0));
    }

    // ---- pay and tip with real IMD --------------------------------------------------------------

    /// @notice A record that names sixteen agents: the live `tip` credits each one sixteenth of
    /// the tip, and what the division leaves joins the seat pool. The fee is booked as revenue.
    function test_fork_payroll_sixteenAgentsAreEachOwedAnEqualShareOfTheTip() public onFork {
        uint256[] memory agents = _unseen(16);
        (uint256 id, bytes memory record) = _readyToSettle(agents);
        Books memory k = _books();
        uint256[] memory owedBefore = new uint256[](16);
        for (uint256 i; i < 16; ++i) {
            owedBefore[i] = PAYROLL.tipOwed(agents[i]);
        }

        uint256 share = TIP / 16;
        vm.expectEmit(Mainnet.PAYROLL);
        emit ILivePayroll.Paid(address(desk), bytes32(id), FEE);
        vm.expectEmit(Mainnet.PAYROLL);
        emit ILivePayroll.Tipped(address(desk), TIP, share, TIP - 16 * share, agents);
        desk.settle(id, record, _none());

        for (uint256 i; i < 16; ++i) {
            assertEq(PAYROLL.tipOwed(agents[i]) - owedBefore[i], share, "one sixteenth each");
        }
        ILivePayroll.Ledger memory l = PAYROLL.ledger();
        assertEq(l.received - k.ledger.received, FEE);
        assertEq(l.tipsIn - k.ledger.tipsIn, TIP);
        assertEq(l.tipsToSeats - k.ledger.tipsToSeats, TIP - 16 * share);
        assertEq(PAYROLL.unbooked(), k.unbooked, "nothing reached Payroll by plain transfer");
        assertEq(IMD.allowance(address(desk), Mainnet.PAYROLL), 0);
        assertEq(IMD.balanceOf(address(desk)), 0);
    }

    /// @notice The tip of a settlement, followed to where it ends: the agent the reference record
    /// names (52211) is owed it by the live Payroll, and it is paid to whoever owns the seat that
    /// agent is bound to. The launched Payroll lets anyone make that claim for an owner that is an
    /// ordinary wallet; when the owner is a contract, only the owner may (`ContractOwnerMustClaim`).
    /// Which case holds today is read from the chain, and the test follows it.
    function test_fork_payroll_theTipIsPaidToTheOwnerOfTheAgentsSeat() public onFork {
        (uint256 id, bytes memory record) = _readyToSettle(new uint256[](0));
        uint256 owedBefore = PAYROLL.tipOwed(REAL_AGENT);
        desk.settle(id, record, _none());
        uint256 owed = PAYROLL.tipOwed(REAL_AGENT);
        assertEq(owed - owedBefore, TIP, "the tip is owed to the agent the record names");

        address token;
        uint256 tokenId;
        try ISeatBinding(Mainnet.SEAT_ADAPTER).bindingOf(REAL_AGENT) returns (uint8, address t, uint256 seat) {
            token = t;
            tokenId = seat;
        } catch {
            emit log("agent 52211 is not bound to a token today: its tip waits in Payroll");
            return;
        }
        if (token != Mainnet.SEATS) {
            emit log("agent 52211 is bound to something that is not a seat today: its tip waits in Payroll");
            return;
        }
        address owner = ISeatOwner(Mainnet.SEATS).ownerOf(tokenId);
        emit log_named_uint("agent 52211 is bound to seat", tokenId);
        emit log_named_address("whose owner is", owner);
        uint256 ownerBefore = IMD.balanceOf(owner);

        if (owner.code.length != 0 && owner != Mainnet.PAYROLL) {
            emit log("the owner is a contract: nobody else may claim for it");
            vm.prank(stranger);
            vm.expectRevert(abi.encodeWithSelector(ILivePayroll.ContractOwnerMustClaim.selector, owner));
            PAYROLL.claimTip(REAL_AGENT);
            vm.prank(owner);
        } else {
            emit log("the owner is an ordinary wallet: anyone may claim for it");
            vm.prank(stranger);
        }
        uint256 paid = PAYROLL.claimTip(REAL_AGENT);
        assertEq(paid, owed, "everything owed to the agent, this settlement's tip included");
        assertEq(PAYROLL.tipOwed(REAL_AGENT), 0);
        if (owner != Mainnet.PAYROLL) assertEq(IMD.balanceOf(owner) - ownerBefore, owed);
    }

    // ---- gas ------------------------------------------------------------------------------------

    /// @notice What a settlement costs with the live Payroll, and the least gas a sender must
    /// offer. Four cases: the first settlement in the state the fork finds Payroll in (the first it
    /// ever saw, while nothing has been paid in on mainnet) with a record naming one agent; the same
    /// first settlement with a record naming sixteen agents never tipped before, which costs
    /// Payroll's two calls the most; a later one with sixteen more new agents; and a later one with
    /// one agent. Each is inside the 3,000,000 gas `docs/LAUNCH.md` tells a sender to offer for a
    /// small record. The figures move with Payroll's state on the day; the bounds do not.
    function test_fork_payroll_gasOfASettlementWithTheLiveContract() public onFork {
        ILivePayroll.Ledger memory l = PAYROLL.ledger();
        emit log_named_uint("Payroll: revenue booked before this test (0: nothing was ever paid in)", l.received);
        emit log_named_uint("Payroll: tips taken before this test", l.tipsIn);

        // The first settlement with one agent is measured and then undone, so that the next case
        // also meets Payroll as the fork found it.
        uint256 snap = vm.snapshotState();
        (uint256 one, bytes memory record1) = _readyToSettle(new uint256[](0));
        (uint256 usedFirstOne,) = _measured(one, record1, "first settlement, one agent");
        emit log_named_uint("its record: bytes", record1.length);
        vm.revertToState(snap);

        (uint256 sixteen, bytes memory record2) = _readyToSettle(_unseen(16));
        (uint256 usedFirstSixteen,) = _measured(sixteen, record2, "first settlement, sixteen agents never tipped");
        emit log_named_uint("its record: bytes", record2.length);

        uint256[] memory others = new uint256[](16);
        for (uint256 i; i < 16; ++i) {
            others[i] = UNSEEN_AGENT + 100 + i;
        }
        (uint256 third, bytes memory record3) = _readyToSettle(others);
        (uint256 usedLaterSixteen,) = _measured(third, record3, "a later settlement, sixteen agents never tipped");

        (uint256 fourth, bytes memory record4) = _readyToSettle(new uint256[](0));
        (uint256 usedLaterOne,) = _measured(fourth, record4, "a later settlement, one agent");

        // Sixteen new tip records cost more than one, whatever state Payroll is in.
        assertGt(usedFirstSixteen, usedFirstOne);
        assertGt(usedLaterSixteen, usedLaterOne);
        assertLt(usedFirstSixteen, 2_000_000, "the costliest case measured");
    }

    // ---- a failure inside Payroll ---------------------------------------------------------------

    /// @notice Both of Payroll's calls revert: the settlement stands, on the documented gas limit.
    /// The runner and the employer are paid exactly as otherwise, the desk sends the fee and the
    /// tip to Payroll by plain transfer and says so, and leaves no allowance behind. When Payroll
    /// answers again, its real `book()` books what arrived, as revenue: a tip that falls back is
    /// not credited to the agents.
    function test_fork_payroll_bothCallsReverting_theSettlementStandsAndBookPicksUpThePlainTransfer() public onFork {
        Balances memory a = _balances();
        Books memory k = _books();
        (uint256 id, bytes memory record) = _readyToSettle(new uint256[](0));

        vm.mockCallRevert(Mainnet.PAYROLL, abi.encodeWithSelector(IPayroll.pay.selector), "Payroll is down");
        vm.mockCallRevert(Mainnet.PAYROLL, abi.encodeWithSelector(IPayroll.tip.selector), "Payroll is down");
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.PayrollFallback(id, FEE + TIP);
        vm.prank(stranger);
        (bool ok,) = address(desk).call{gas: SETTLE_GAS_LIMIT}(_settleCall(id, record));
        assertTrue(ok, "a failing Payroll blocked the settlement");
        vm.clearMockedCalls();

        Balances memory b = _balances();
        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(b.runner - a.runner, PRICE - FEE - TIP, "the runner: the price less 10%, and its bond back");
        assertEq(a.employer - b.employer, PRICE, "the employer paid the fixed price and no more");
        assertEq(b.payroll - a.payroll, FEE + TIP, "exactly the fee and the tip reached Payroll");
        assertEq(b.desk, a.desk, "the desk keeps nothing");
        assertEq(IMD.allowance(address(desk), Mainnet.PAYROLL), 0, "no allowance is left with Payroll");

        // Nothing was booked while Payroll was failing; all of it waits as a plain transfer.
        Books memory m = _books();
        assertEq(m.ledger.received, k.ledger.received);
        assertEq(m.ledger.tipsIn, k.ledger.tipsIn);
        assertEq(m.unbooked - k.unbooked, FEE + TIP);

        // The real `book()`, callable by anyone, splits it as revenue.
        vm.prank(stranger);
        uint256 booked = PAYROLL.book();
        assertEq(booked, m.unbooked);
        Books memory z = _books();
        assertEq(z.ledger.received - k.ledger.received, m.unbooked, "booked as revenue");
        assertEq(z.ledger.tipsIn, k.ledger.tipsIn, "not as a tip");
        assertEq(z.owedToTheRealAgent, k.owedToTheRealAgent, "so the agent is owed nothing for this job");
        assertEq(z.unbooked, 0);
    }

    /// @notice The worst a contract at Payroll's address could do with the gas it is handed: use
    /// all of it, in both calls. The live code is replaced on the fork by a loop that never ends.
    /// The settlement still goes through on the documented gas limit, at a cost of the two
    /// allowances, and the fee and the tip are sent by plain transfer.
    function test_fork_payroll_burningAllItsGasCannotBlockASettlementOnTheDocumentedLimit() public onFork {
        Balances memory a = _balances();
        (uint256 id, bytes memory record) = _readyToSettle(new uint256[](0));

        // JUMPDEST, PUSH1 0, JUMP: a loop that ends only when the gas does.
        vm.etch(Mainnet.PAYROLL, hex"5b600056");
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.PayrollFallback(id, FEE + TIP);
        vm.prank(stranger);
        uint256 before = gasleft();
        (bool ok,) = address(desk).call{gas: SETTLE_GAS_LIMIT}(_settleCall(id, record));
        uint256 used = before - gasleft();
        assertTrue(ok, "a Payroll that burns its gas blocked the settlement");
        emit log_named_uint("settle with both Payroll calls burning 1,000,000 gas each", used);
        assertGt(used, 2 * desk.PAYROLL_GAS());

        Balances memory b = _balances();
        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(b.runner - a.runner, PRICE - FEE - TIP);
        assertEq(a.employer - b.employer, PRICE);
        assertEq(b.payroll - a.payroll, FEE + TIP);
        assertEq(IMD.allowance(address(desk), Mainnet.PAYROLL), 0);
    }

    // ---- the stand-in against the live contract -------------------------------------------------

    /// @notice The local tests run the desk against `PayrollStandIn`. Here the same payments are
    /// made to the stand-in and to the live Payroll, and what each books is compared: revenue
    /// through `pay`, tips through `tip` for an empty list, one agent, a split with a remainder,
    /// an agent listed twice, more than sixteen agents, an amount too small to split and an amount
    /// of zero, and IMD that arrives by plain transfer and is booked.
    function test_fork_payroll_theStandInBooksWhatTheLiveContractBooks() public onFork {
        PayrollStandIn standIn = new PayrollStandIn(Mainnet.IMD);
        address payer = makeAddr("fork payer");
        _fund(payer, 100e18, Mainnet.PAYROLL);
        _fund(payer, 0, address(standIn));

        // pay
        uint256[3] memory amounts = [uint256(1e18), 7, 0];
        for (uint256 i; i < amounts.length; ++i) {
            uint256 liveBefore = PAYROLL.ledger().received;
            uint256 standInBefore = standIn.paid();
            vm.startPrank(payer);
            PAYROLL.pay(amounts[i], bytes32("compare"));
            standIn.pay(amounts[i], bytes32("compare"));
            vm.stopPrank();
            assertEq(PAYROLL.ledger().received - liveBefore, amounts[i], "live pay");
            assertEq(standIn.paid() - standInBefore, amounts[i], "stand-in pay");
        }

        // tip
        _compareTip(standIn, payer, new uint256[](0), 1e18);
        _compareTip(standIn, payer, _unseen(1), 1e18);
        _compareTip(standIn, payer, _unseen(3), 1e18 + 1);
        uint256[] memory twice = new uint256[](2);
        twice[0] = UNSEEN_AGENT;
        twice[1] = UNSEEN_AGENT;
        _compareTip(standIn, payer, twice, 7);
        _compareTip(standIn, payer, _unseen(17), 1e18);
        _compareTip(standIn, payer, _unseen(3), 2);
        _compareTip(standIn, payer, _unseen(3), 0);

        // a plain transfer, then book(): bring both to nothing waiting first.
        PAYROLL.book();
        standIn.book();
        vm.startPrank(payer);
        IMD.transfer(Mainnet.PAYROLL, 0.3e18);
        IMD.transfer(address(standIn), 0.3e18);
        vm.stopPrank();
        assertEq(PAYROLL.unbooked(), 0.3e18);
        assertEq(PAYROLL.book(), 0.3e18, "live book");
        assertEq(standIn.book(), 0.3e18, "stand-in book");
    }

    /// @dev Sends one tip to both and compares the totals and what each of up to seventeen ids
    /// is owed.
    function _compareTip(PayrollStandIn standIn, address payer, uint256[] memory ids, uint256 amount) internal {
        ILivePayroll.Ledger memory l0 = PAYROLL.ledger();
        uint256 tipped0 = standIn.tipped();
        uint256 toSeats0 = standIn.tipsToSeats();
        uint256[] memory live0 = new uint256[](ids.length);
        uint256[] memory standIn0 = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            live0[i] = PAYROLL.tipOwed(ids[i]);
            standIn0[i] = standIn.tipOwed(ids[i]);
        }

        vm.startPrank(payer);
        PAYROLL.tip(ids, amount);
        standIn.tip(ids, amount);
        vm.stopPrank();

        ILivePayroll.Ledger memory l1 = PAYROLL.ledger();
        assertEq(l1.tipsIn - l0.tipsIn, amount, "live tip");
        assertEq(standIn.tipped() - tipped0, l1.tipsIn - l0.tipsIn, "the same amount taken");
        assertEq(standIn.tipsToSeats() - toSeats0, l1.tipsToSeats - l0.tipsToSeats, "the same part to the seat pool");
        for (uint256 i; i < ids.length; ++i) {
            assertEq(
                standIn.tipOwed(ids[i]) - standIn0[i], PAYROLL.tipOwed(ids[i]) - live0[i], "the same credit for each id"
            );
        }
    }
}
