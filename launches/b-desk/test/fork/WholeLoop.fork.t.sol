// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {IWorkRegistry} from "../../src/interfaces/external/IWorkRegistry.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {DeskOnFork} from "./DeskOnFork.sol";
import {ILivePayroll, IWorkRegistryWriter} from "./ForkKit.sol";

/// @title The whole loop against the real WorkRegistry and the live Payroll
/// @notice On a fork of Ethereum mainnet: an employer escrows real IMD on the desk, a runner posts
/// a real bond and registers a job, IdentityMD's real WorkRegistry is given the job's receipt by
/// its own writer (impersonated; see `ForkKit`), and the order is settled through the launch's
/// real WorkProof. Every payout is checked to the wei. The other endings follow the same way: a
/// refund, a timeout, a failed job, a delivery claim paid without a receipt and stamped later, and
/// a dispute decided by a receipt, refuted by one, or left undecided.
///
/// The record of each job is the real record of job e9efec16 (completed, one agent) or of job
/// 9012ff0b (blocked), with the job id and the objective swapped for ours.
///
/// Payroll is the live contract of HELP WANTED's first launch (`Mainnet.PAYROLL`): the desk here
/// is built with its address, as the launch's manifest builds it, and the fee and the tip of every
/// settlement go through its real `pay` and `tip`. What it booked is read back from its own
/// ledger. One test, the last, puts a stand-in in its place, because the live contract cannot be
/// told to take less than it is offered.
///
/// Run with `FOUNDRY_PROFILE=fork forge test`. Every test skips itself when the RPC cannot be reached.
contract WholeLoopForkTest is DeskOnFork {
    // ---- the registry and the central claim -----------------------------------------------------

    /// @notice The claim everything rests on, for a real job: keccak256 of the work record as
    /// IdentityMD serves it equals `WorkRegistry.latest(jobId)`, and the launch's WorkProof reads
    /// that record and says what it holds. The record is the stored copy of
    /// `https://api.imd.fun/work-records/3db99325…b2c5.json`, unchanged.
    function test_fork_centralClaim_theServedRecordOfARealJobHashesToItsReceipt() public onFork {
        bytes memory record = _fixtureRecord(COMPLETED_FIXTURE);
        bytes32 onChain = REGISTRY.latest(REFERENCE_JOB);
        assertTrue(onChain != bytes32(0), "the reference job has a receipt");
        if (onChain != REFERENCE_RECEIPT) {
            // The job was given a newer receipt since the record was stored.
            vm.skip(true, "the reference job has a newer receipt");
            return;
        }
        assertEq(keccak256(record), onChain, "keccak256(served record) == WorkRegistry.latest(jobId)");

        IWorkProof.Proof memory p = proof.prove(REFERENCE_JOB, record, 0);
        assertEq(p.recordHash, onChain);
        assertEq(p.kindHash, keccak256("skill:research-report"));
        assertEq(p.stateHash, keccak256("completed"));
        assertEq(p.agentIds.length, 1);
        assertEq(p.agentIds[0], REAL_AGENT);

        // One byte more, as a trailing newline would be, is another document.
        bytes memory withNewline = bytes.concat(record, "\n");
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, onChain, keccak256(withNewline)));
        proof.prove(REFERENCE_JOB, withNewline, 0);
    }

    /// @notice Who can write a receipt: the address the registry names, and nobody else. A receipt
    /// is chained to the job's previous one, and a document hash is recorded once.
    function test_fork_onlyTheRegistrysWriterRecords() public onFork {
        assertEq(IWorkRegistryWriter.recordWork.selector, bytes4(0x765b59a5), "the selector seen on chain");
        assertEq(IWorkRegistry.latest.selector, bytes4(0xebe9712c));
        emit log_named_address("the registry's writer on this fork", registryWriter);
        emit log_named_address("the writer recorded in Mainnet.sol", Mainnet.WORK_REGISTRY_WRITER);

        bytes16 jobId = _freshJob();
        bytes memory record = _recordOf(jobId, KIND, "A job nobody on any desk ordered.", "completed");
        IWorkRegistryWriter.Signal[] memory none = new IWorkRegistryWriter.Signal[](0);

        vm.prank(stranger);
        vm.expectRevert();
        IWorkRegistryWriter(Mainnet.WORK_REGISTRY).recordWork(jobId, bytes32(0), keccak256(record), "uri", none);
        assertEq(REGISTRY.latest(jobId), bytes32(0));

        bytes32 first = _recordWork(jobId, record);
        assertEq(first, keccak256(record));

        // The same document cannot be recorded twice, and a receipt that does not name the job's
        // latest one as its parent is refused.
        vm.prank(registryWriter);
        vm.expectRevert();
        IWorkRegistryWriter(Mainnet.WORK_REGISTRY).recordWork(jobId, first, first, "uri", none);
        vm.prank(registryWriter);
        vm.expectRevert();
        IWorkRegistryWriter(Mainnet.WORK_REGISTRY).recordWork(jobId, bytes32(0), keccak256("another"), "uri", none);
        assertEq(REGISTRY.latest(jobId), first);

        bytes memory second = _secondRecord(record);
        assertEq(_recordWork(jobId, second), keccak256(second));
    }

    /// @notice IMD moves exactly what it is asked to: 18 decimals, no fee on transfer. The desk's
    /// sums rely on it.
    function test_fork_imdIsThePlainTokenTheDeskAssumes() public onFork {
        assertEq(IERC20Metadata(Mainnet.IMD).decimals(), 18);
        uint256 before = IMD.balanceOf(stranger);
        uint256 fromBefore = IMD.balanceOf(employer);
        vm.prank(employer);
        IMD.transfer(stranger, 1e18 + 7);
        assertEq(IMD.balanceOf(stranger) - before, 1e18 + 7);
        assertEq(fromBefore - IMD.balanceOf(employer), 1e18 + 7);
    }

    // ---- proven ---------------------------------------------------------------------------------

    /// @notice Create, claim, register, receipt, settle: every party's payout, in real IMD.
    function test_fork_loop_provenSettlementPaysEveryParty() public onFork {
        assertEq(block.chainid, 1);
        Balances memory a = _balances();
        Books memory k = _books();

        uint256 id = _open(0);
        assertEq(IMD.balanceOf(address(desk)) - a.desk, MAX_PAY, "the escrow arrived whole");
        bytes16 jobId = _take(id);
        assertEq(desk.priceNow(id), PRICE);
        assertEq(IMD.balanceOf(address(desk)) - a.desk, uint256(MAX_PAY) + BOND);

        // The header carries chain id 1, this desk, this order, the first claim and the runner.
        bytes32 ticket = keccak256(abi.encode(uint256(1), address(desk), id, uint256(1), runner));
        assertEq(desk.ticketOf(id), ticket);
        bytes memory header = desk.headerOf(id);
        assertEq(header.length, 85);
        assertEq(header, abi.encodePacked("[help-wanted order ", _hex(ticket), "] "));

        bytes memory record = _record(id, jobId, "completed");

        // Until the registry holds the job's receipt, nothing settles.
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, jobId));
        desk.settle(id, record, _none());

        bytes32 receipt = _recordWork(jobId, record);

        // Only the exact bytes settle.
        bytes memory changed = bytes.concat(record);
        changed[changed.length - 2] = bytes1(uint8(changed[changed.length - 2]) ^ 0x01);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, receipt, keccak256(changed)));
        desk.settle(id, changed, _none());

        // The live Payroll's own events: the fee labelled with the order, and the tip credited
        // whole to the one agent the real record names.
        vm.expectEmit(Mainnet.PAYROLL);
        emit ILivePayroll.Paid(address(desk), bytes32(id), FEE);
        vm.expectEmit(Mainnet.PAYROLL);
        emit ILivePayroll.Tipped(address(desk), TIP, TIP, 0, _one(REAL_AGENT));
        vm.prank(stranger);
        desk.settle(id, record, _none());

        Balances memory b = _balances();
        assertEq(a.employer - b.employer, PRICE, "the employer paid the fixed price and got the rest back");
        assertEq(b.runner - a.runner, PRICE - FEE - TIP, "the runner: the price less 10%, and its bond back");
        assertEq(b.payroll - a.payroll, FEE + TIP, "Payroll: the fee and the tip");
        assertEq(b.desk, a.desk, "the desk keeps nothing");
        assertEq(b.challenger, a.challenger);
        _assertBooked(k, FEE, TIP, 0);

        _assertState(id, IWorkOrders.State.Delivered);
        (, address who, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
        assertEq(who, employer);
        assertEq(escrow, 0);
        assertEq(spent, PRICE);
        assertEq(returned, MAX_PAY - PRICE, "returned counts the change at settlement");
        assertTrue(desk.orderOf(id).proven);
        assertEq(desk.orderOfJob(jobId), id);
        assertEq(desk.claimOf(id).recordHash, receipt);
        assertEq(REGISTRY.latest(jobId), receipt);

        // The job has settled this order and can settle no other.
        uint256 other = _open(0);
        vm.prank(runner);
        desk.claim(other);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.JobUsed.selector);
        desk.register(other, jobId);
    }

    /// @notice A job that was given a second receipt (as real jobs are when their work is delivered
    /// to a repository) settles on the second, which names no agents: the tip goes to Payroll with
    /// an empty list, which the live Payroll books to its seat pool.
    function test_fork_loop_aSecondReceiptSettlesAndTheTipHasNoAgents() public onFork {
        Balances memory a = _balances();
        Books memory k = _books();
        uint256 id = _open(0);
        bytes16 jobId = _take(id);
        bytes memory first = _record(id, jobId, "completed");
        bytes memory second = _secondRecord(first);
        _recordWork(jobId, first);
        bytes32 latest = _recordWork(jobId, second);

        // The first record is no longer the registry's answer.
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, latest, keccak256(first)));
        desk.settle(id, first, _none());

        // The second receipt names nobody: the live Payroll is handed an empty list.
        vm.expectEmit(Mainnet.PAYROLL);
        emit ILivePayroll.Tipped(address(desk), TIP, 0, TIP, new uint256[](0));
        desk.settle(id, second, _none());
        Balances memory b = _balances();
        assertEq(b.runner - a.runner, PRICE - FEE - TIP);
        assertEq(b.payroll - a.payroll, FEE + TIP);
        _assertBooked(k, FEE, TIP, TIP);
        assertEq(desk.claimOf(id).recordHash, latest);
    }

    // ---- refund, timeout, a failed job ----------------------------------------------------------

    function test_fork_loop_anOrderNobodyTakesIsRefunded() public onFork {
        Balances memory a = _balances();
        uint256 id = _open(0);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.refund(id);
        _skip(30 days);
        vm.prank(stranger);
        desk.refund(id);

        Balances memory b = _balances();
        assertEq(b.employer, a.employer, "the employer is whole");
        assertEq(b.desk, a.desk);
        _assertState(id, IWorkOrders.State.Refunded);
        (,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, 0);
        assertEq(spent, 0);
        assertEq(returned, MAX_PAY);
    }

    /// @notice A runner registers a job and no receipt ever lands: at the delivery deadline anyone
    /// ends the claim, the bond goes to the employer and the order is open again. A second runner
    /// can then take it and be paid.
    function test_fork_loop_aSilentRunnerIsTimedOutAndTheOrderReopens() public onFork {
        Balances memory a = _balances();
        uint256 id = _open(0);
        _take(id);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.timeout(id);
        _skip(DELIVERY);
        vm.prank(stranger);
        desk.timeout(id);

        Balances memory b = _balances();
        assertEq(a.runner - b.runner, BOND, "the runner lost its bond");
        assertEq(b.employer, a.employer - MAX_PAY + BOND, "the employer was paid the bond; the escrow stays");
        _assertState(id, IWorkOrders.State.Open);
        (,, uint96 escrow,, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, MAX_PAY);
        assertEq(returned, BOND, "returned counts the forfeited bond");

        // The price ramp stood still while the first runner held the order, so the next claim
        // fixes the same price the first one did.
        address second = makeAddr("fork loop second runner");
        _fund(second, BOND, address(desk));
        vm.prank(second);
        desk.claim(id);
        bytes16 jobId = _freshJob();
        vm.prank(second);
        desk.register(id, jobId);
        bytes memory record = _record(id, jobId, "completed");
        _recordWork(jobId, record);
        desk.settle(id, record, _none());
        assertEq(desk.claimOf(id).price, PRICE);
        assertEq(IMD.balanceOf(second), PRICE - FEE - TIP + BOND);
        assertEq(IMD.balanceOf(address(desk)), a.desk);
    }

    /// @notice The swarm ends the runner's job "blocked" (the live registry does hold such
    /// receipts): the runner reports it, gets its whole bond back, and the order is open again.
    function test_fork_loop_aBlockedJobFreesTheOrderAndReturnsTheBond() public onFork {
        Balances memory a = _balances();
        uint256 id = _open(0);
        bytes16 jobId = _take(id);
        bytes memory record = _record(id, jobId, "blocked");
        _recordWork(jobId, record);

        vm.expectRevert(IWorkOrdersRunner.NotCompleted.selector);
        desk.settle(id, record, _none());
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.reportFailed(id, record, _none());
        vm.prank(runner);
        desk.reportFailed(id, record, _none());

        Balances memory b = _balances();
        assertEq(b.runner, a.runner, "the runner's bond came back whole");
        assertEq(a.employer - b.employer, MAX_PAY, "the escrow waits for the next runner");
        _assertState(id, IWorkOrders.State.Open);
    }

    // ---- claimed --------------------------------------------------------------------------------

    /// @notice While receipts are late: the runner claims delivery, nobody challenges for 24
    /// hours, the order is paid unproven. When the receipt lands later, anyone stamps the order
    /// proven and no money moves.
    function test_fork_loop_claimedPath_paidUnprovenThenStampedWhenTheReceiptLands() public onFork {
        Balances memory a = _balances();
        Books memory k = _books();
        uint256 id = _open(1);
        bytes16 jobId = _take(id);
        bytes memory record = _record(id, jobId, "completed");

        vm.prank(runner);
        desk.claimDelivered(id, keccak256(record));
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.finalize(id);
        _skip(24 hours);
        vm.prank(stranger);
        desk.finalize(id);

        Balances memory b = _balances();
        assertEq(b.runner - a.runner, PRICE - FEE - TIP);
        assertEq(a.employer - b.employer, PRICE);
        assertEq(b.payroll - a.payroll, FEE + TIP);
        assertEq(b.desk, a.desk);
        // An unproven delivery names no agents: the live Payroll puts the whole tip in its seat pool.
        _assertBooked(k, FEE, TIP, TIP);
        assertFalse(desk.orderOf(id).proven);
        assertEq(desk.orderOfJob(jobId), 0, "an unproven job is tied to nothing yet");

        // No receipt, no stamp.
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, jobId));
        desk.stamp(id, record, _none());

        bytes32 receipt = _recordWork(jobId, record);
        vm.prank(stranger);
        desk.stamp(id, record, _none());
        assertTrue(desk.orderOf(id).proven);
        assertEq(desk.orderOfJob(jobId), id);
        assertEq(desk.claimOf(id).recordHash, receipt);
        Balances memory c = _balances();
        assertEq(c.runner, b.runner, "a stamp moves no money");
        assertEq(c.payroll, b.payroll);
        assertEq(c.desk, b.desk);
    }

    /// @notice An order without the flag has no claimed path at all.
    function test_fork_loop_claimedPathIsOffUnlessTheEmployerAllowedIt() public onFork {
        uint256 id = _open(0);
        _take(id);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ClaimedPathOff.selector);
        desk.claimDelivered(id, keccak256("a record"));
    }

    // ---- disputed -------------------------------------------------------------------------------

    function _disputed() internal returns (uint256 id, bytes16 jobId, bytes memory record) {
        id = _open(1);
        jobId = _take(id);
        record = _record(id, jobId, "completed");
        vm.prank(runner);
        desk.claimDelivered(id, keccak256(record));
        vm.prank(challenger);
        desk.challenge(id);
        _assertState(id, IWorkOrders.State.Disputed);
    }

    /// @notice A challenged claim, then the receipt lands: any valid receipt of the registered job
    /// pays the runner, whatever hash it named, and gives it the challenger's bond.
    function test_fork_loop_dispute_aReceiptPaysTheRunnerAndTheChallengersBond() public onFork {
        Balances memory a = _balances();
        (uint256 id, bytes16 jobId, bytes memory first) = _disputed();
        assertEq(IMD.balanceOf(address(desk)) - a.desk, uint256(MAX_PAY) + 2 * uint256(BOND));

        // The registry ends up holding the job's second receipt, not the one the runner named.
        bytes memory second = _secondRecord(first);
        _recordWork(jobId, first);
        _recordWork(jobId, second);
        vm.prank(challenger);
        vm.expectRevert(IWorkOrdersRunner.NotFailed.selector);
        desk.reportFailed(id, second, _none());

        desk.settle(id, second, _none());
        Balances memory b = _balances();
        assertEq(b.runner - a.runner, PRICE - FEE - TIP + BOND, "pay, its bond, and the challenger's");
        assertEq(a.challenger - b.challenger, BOND);
        assertEq(a.employer - b.employer, PRICE);
        assertEq(b.payroll - a.payroll, FEE + TIP);
        assertEq(b.desk, a.desk);
        _assertState(id, IWorkOrders.State.Delivered);
    }

    /// @notice A challenged claim, then a receipt that shows the job did not complete: the
    /// employer gets the release share of the runner's bond, the challenger the rest with its own,
    /// and the order is open again.
    function test_fork_loop_dispute_aBlockedReceiptRefutesTheClaim() public onFork {
        Balances memory a = _balances();
        uint256 id = _open(1);
        bytes16 jobId = _take(id);
        bytes memory blocked = _record(id, jobId, "blocked");
        // The runner names the hash of a completed record that will never exist.
        bytes32 named = keccak256(_record(id, jobId, "completed"));
        vm.prank(runner);
        desk.claimDelivered(id, named);
        vm.prank(challenger);
        desk.challenge(id);

        _recordWork(jobId, blocked);
        vm.expectRevert(IWorkOrdersRunner.NotCompleted.selector);
        desk.settle(id, blocked, _none());
        vm.prank(stranger);
        desk.reportFailed(id, blocked, _none());

        uint256 cut = uint256(BOND) / 10;
        Balances memory b = _balances();
        assertEq(a.runner - b.runner, BOND, "the runner lost its bond");
        assertEq(
            b.challenger - a.challenger, BOND - cut, "the challenger: its own bond back and the rest of the runner's"
        );
        assertEq(b.employer, a.employer - MAX_PAY + cut, "the employer: the release share");
        _assertState(id, IWorkOrders.State.Open);
        (,, uint96 escrow,, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, MAX_PAY);
        assertEq(returned, cut);
    }

    /// @notice A challenged claim that nothing decides by the delivery deadline: the employer is
    /// refunded, the challenger gets its bond back, and the runner is treated as if it had
    /// released (a tenth of its bond to the employer).
    function test_fork_loop_dispute_undecidedAtTheDeadlineIsARefund() public onFork {
        Balances memory a = _balances();
        (uint256 id,,) = _disputed();
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.timeout(id);
        _skip(DELIVERY);
        vm.prank(stranger);
        desk.timeout(id);

        uint256 cut = uint256(BOND) / 10;
        Balances memory b = _balances();
        assertEq(b.employer - a.employer, cut, "the escrow back, and the release share of the runner's bond");
        assertEq(a.runner - b.runner, cut);
        assertEq(b.challenger, a.challenger, "the challenger is whole");
        assertEq(b.payroll, a.payroll, "no fee on a refund");
        assertEq(b.desk, a.desk);
        _assertState(id, IWorkOrders.State.Refunded);
        (,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, 0);
        assertEq(spent, 0);
        assertEq(returned, uint256(MAX_PAY) + cut, "returned counts the escrow and the bond share");
    }

    // ---- real receipts written for somebody else --------------------------------------------------

    /// @notice A real job that was given two receipts (97804d2b), read from the real registry. The
    /// registry answers with the second, so the first can no longer be proven. No order here asked
    /// for that job, so a runner that registers it has registered a wrong job: anyone reports it
    /// and the employer is paid the bond.
    function test_fork_aRealJobWithTwoReceipts_endsAClaimAsAWrongJob() public onFork {
        bytes16 twice = bytes16(0x97804d2b86b747a6a55834ca31c469d9);
        bytes memory first = _fixtureRecord("97804d2b-single-b57f8912.hex");
        bytes memory second = _fixtureRecord("97804d2b-single-56cfc4e2.hex");
        if (REGISTRY.latest(twice) != keccak256(second)) {
            vm.skip(true, "the job has a newer receipt than the stored one");
            return;
        }
        Balances memory a = _balances();
        IWorkOrders.OrderParams memory p = _params(0);
        p.kindHash = keccak256("single");
        vm.prank(employer);
        uint256 id = desk.createOrder(p, SPEC);
        vm.prank(runner);
        desk.claim(id);
        vm.prank(runner);
        desk.register(id, twice);

        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, keccak256(second), keccak256(first)));
        desk.reportFailed(id, first, _none());
        vm.expectRevert(IWorkOrdersRunner.WrongHeader.selector);
        desk.settle(id, second, _none());
        vm.prank(stranger);
        desk.reportFailed(id, second, _none());

        Balances memory b = _balances();
        _assertState(id, IWorkOrders.State.Open);
        assertEq(b.employer, a.employer - MAX_PAY + BOND, "the employer was paid the bond");
        assertEq(a.runner - b.runner, BOND);
    }

    // ---- conditions on live views -----------------------------------------------------------------

    /// @notice WHEN a receipt exists for a job, THEN hire: an order whose condition is a live call
    /// to the real WorkRegistry. It opens for a job that has a receipt and stays closed for one
    /// that has none.
    function test_fork_condition_readsTheRealWorkRegistry() public onFork {
        bytes32 receipt = REGISTRY.latest(REFERENCE_JOB);
        assertTrue(receipt != bytes32(0));

        IWorkOrders.OrderParams memory p = _params(4);
        p.condTarget = Mainnet.WORK_REGISTRY;
        p.condSelector = IWorkRegistry.latest.selector;
        p.condArg = bytes32(REFERENCE_JOB);
        p.condCmp = 6; // != 0
        vm.prank(employer);
        uint256 withReceipt = desk.createOrder(p, SPEC);
        p.condArg = bytes32(bytes16(keccak256("a job nobody opened")));
        vm.prank(employer);
        uint256 without = desk.createOrder(p, SPEC);

        (bool met, bool holds, uint256 value) = desk.conditionOf(withReceipt);
        assertFalse(met);
        assertTrue(holds);
        assertEq(bytes32(value), receipt, "the desk read the word the registry returns");
        (, holds, value) = desk.conditionOf(without);
        assertFalse(holds);
        assertEq(value, 0);

        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ConditionNotMet.selector);
        desk.claim(without);
        vm.expectRevert(IWorkOrdersRunner.ConditionNotMet.selector);
        desk.trigger(without);

        desk.trigger(withReceipt);
        vm.prank(runner);
        desk.claim(withReceipt);
        _assertState(withReceipt, IWorkOrders.State.Claimed);
    }

    /// @notice A condition on a live token balance: the staking vault holds at least one IMD.
    function test_fork_condition_onALiveBalance() public onFork {
        IWorkOrders.OrderParams memory p = _params(4);
        p.condTarget = Mainnet.IMD;
        p.condSelector = IERC20.balanceOf.selector;
        p.condArg = bytes32(uint256(uint160(Mainnet.SIMD)));
        p.condCmp = 1; // >=
        p.condThreshold = 1e18;
        vm.prank(employer);
        uint256 id = desk.createOrder(p, SPEC);
        (, bool holds, uint256 value) = desk.conditionOf(id);
        assertTrue(holds);
        assertEq(value, IMD.balanceOf(Mainnet.SIMD));
        desk.trigger(id);
        assertTrue(desk.orderOf(id).condMet);
    }

    // ---- a Payroll that takes less than it is offered, with real IMD -------------------------------

    /// @notice The fallback for a Payroll that does not take what it is offered rests on real IMD
    /// behaviour: an allowance that goes down by what was pulled and can be set back to zero. The
    /// live Payroll always takes what it is offered, so for this one test a second desk is built
    /// on a stand-in that takes half of each amount, and then reverts on both calls; the desk sends
    /// the rest itself and the settlement stands. (What the live Payroll does with IMD that reaches
    /// it by plain transfer is in `LivePayroll.fork.t.sol`.)
    function test_fork_payrollThatTakesLessIsSentTheRestByPlainTransfer() public onFork {
        PayrollStandIn payroll = new PayrollStandIn(Mainnet.IMD);
        payrollAt = address(payroll);
        desk = new WorkOrders(Mainnet.IMD, address(proof), address(payroll));
        _fund(employer, 0, address(desk));
        _fund(runner, 0, address(desk));

        Balances memory a = _balances();
        uint256 id = _open(0);
        bytes16 jobId = _take(id);
        bytes memory record = _record(id, jobId, "completed");
        _recordWork(jobId, record);

        payroll.setMode(PayrollStandIn.Mode.PullHalf);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.PayrollFallback(id, (FEE + TIP) / 2);
        desk.settle(id, record, _none());
        Balances memory b = _balances();
        assertEq(b.payroll - a.payroll, FEE + TIP, "exactly the fee and the tip left the desk");
        assertEq(IMD.allowance(address(desk), address(payroll)), 0);
        assertEq(b.desk, a.desk);
        assertEq(b.runner - a.runner, PRICE - FEE - TIP);

        // And a Payroll that reverts on both calls.
        payroll.setMode(PayrollStandIn.Mode.RevertBoth);
        uint256 again = _open(0);
        bytes16 job2 = _take(again);
        bytes memory record2 = _record(again, job2, "completed");
        _recordWork(job2, record2);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.PayrollFallback(again, FEE + TIP);
        desk.settle(again, record2, _none());
        Balances memory c = _balances();
        assertEq(c.payroll - b.payroll, FEE + TIP);
        assertEq(c.desk, a.desk);
        assertEq(
            payroll.book(),
            a.payroll + (FEE + TIP) / 2 + FEE + TIP,
            "what arrived by plain transfer is there to be booked"
        );
    }
}
