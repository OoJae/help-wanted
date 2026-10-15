// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {LaunchDoc} from "../launch/LaunchDoc.sol";
import {RecordMaker} from "./RecordMaker.sol";

/// @dev The live `Questions` of launch A beyond the frozen `IQuestions`: the reads the fork suite
/// makes. Every signature is the launched contract's own.
interface ILiveQuestions {
    function IMD() external view returns (address);
    function latest(bytes32 feedId)
        external
        view
        returns (uint256 value, uint64 fromBlock, uint64 toBlock, uint64 round, uint64 updatedAt);
    function costOf(bytes32 feedId) external view returns (uint256);
    function meterOf(bytes32 feedId) external view returns (uint256 balance, uint256 totalShares);
    function sharesOf(bytes32 feedId, address funder) external view returns (uint256);
    function redeemable(bytes32 feedId, address funder) external view returns (uint256);
}

/// @dev The live hire desk of launch B beyond the frozen `IWorkOrders`: the runner's side and the
/// constants the fork suite reads. Every signature is the launched contract's own.
interface ILiveDesk is IWorkOrders {
    function claim(uint256 id) external returns (bytes32 ticket);
    function register(uint256 id, bytes16 jobId) external;
    function settle(uint256 id, bytes calldata record, address[] calldata chunks) external;
    function headerOf(uint256 id) external view returns (bytes memory);
    function priceNow(uint256 id) external view returns (uint96);
    function MAX_DELIVERY() external view returns (uint32);
    function FEE_BPS() external view returns (uint256);
    function TIP_BPS() external view returns (uint256);
    function WORK_PROOF() external view returns (address);
    function PAYROLL() external view returns (address);
}

/// @dev The live `CrowdPots` of launch B: opening a pot and reading a chip.
interface ILivePots {
    struct Terms {
        string kind;
        uint96 target;
        uint96 minPay;
        uint32 rampSecs;
        uint96 bond;
        uint32 deliverySecs;
        uint32 hireSecs;
        uint32 fundSecs;
        bool allowClaimed;
    }

    function IMD() external view returns (address);
    function WORK_ORDERS() external view returns (address);
    function potCount() external view returns (uint256);
    function remaining(uint256 potId) external view returns (uint256);
    function openPot(Terms calldata terms, bytes calldata spec, uint256 firstChip) external returns (uint256 potId);
    function chipOf(uint256 potId, address contributor)
        external
        view
        returns (uint256 amount, uint256 refunded, bool claimed);
}

/// @dev The live `Payroll` of launch A: the running totals the fork suite reads when an order of a
/// rule is settled. `received` is everything booked as revenue (the desk's fee), `tipsIn`
/// everything taken through `tip`.
interface ILivePayroll {
    struct Ledger {
        uint256 received;
        uint256 toStakers;
        uint256 toSeats;
        uint256 toFeeds;
        uint256 dripped;
        uint256 seatClaimed;
        uint256 tipsIn;
        uint256 tipsClaimed;
        uint256 feedsFunded;
        uint256 tipsToSeats;
        uint256 feedsReleased;
    }

    function ledger() external view returns (Ledger memory);
    function QUESTIONS() external view returns (address);
}

/// @dev IdentityMD's WorkRegistry: the read the desk is paid on, and the write its writer makes.
/// The registry's source is not published; `recordWork` (selector `0x765b59a5`) was recovered from
/// its live transactions by launch B and is used only on a fork, by acting as the address the
/// registry itself names as its writer.
interface IWorkRegistryLive {
    struct Signal {
        uint256 agentId;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    function latest(bytes16 jobId) external view returns (bytes32);
    function writer() external view returns (address);
    function recordWork(
        bytes16 jobId,
        bytes32 previousHash,
        bytes32 documentHash,
        string calldata uri,
        Signal[] calldata signals
    ) external;
}

/// @title The contracts of launches A and B, live, on a fork of mainnet
/// @notice What the fork tests that meet the real `Questions`, `WorkOrders` and `CrowdPots` share:
/// the fork itself, real IMD for the actors, and the one thing no local test can do, which is have
/// IdentityMD's real WorkRegistry hold a receipt for a job of ours. The registry accepts receipts
/// from the one address it names as its writer; on the fork the tests act as that address and
/// record keccak256 of a work record, exactly as the writer does. From then on everything is the
/// launched code: the registry's storage answers `latest`, the live `WorkProof` reads the record,
/// the live desk pays in real IMD and calls the rule back, the live Payroll books the fee and the
/// tip.
///
/// @dev The record is a real one: job e9efec16's work record (7,339 bytes, kind
/// `skill:research-report`, state `completed`, one signal naming agent 52211), as IdentityMD
/// served it from `https://api.imd.fun/work-records/3db99325…b2c5.json`, stored as hexadecimal
/// text in `test/fixtures/rules/records`. A test swaps its job id and its objective (the order's
/// 85-byte header followed by the rule's job text), as a runner's job would carry them; the rest is
/// IdentityMD's bytes. `test_fork_live_theRecordIsTheOneIdentityMDServed` checks the stored bytes
/// against the hash the real registry holds for that job.
///
/// Every test skips itself when the RPC cannot be reached. A reachable node on which any of the
/// three contracts has no code is a failure, not a skip.
abstract contract LiveSiblings is LaunchDoc {
    IERC20 internal constant IMD = IERC20(Mainnet.IMD);
    ILiveQuestions internal constant QUESTIONS = ILiveQuestions(Mainnet.QUESTIONS);
    ILiveDesk internal constant DESK = ILiveDesk(Mainnet.WORK_ORDERS);
    ILivePots internal constant POTS = ILivePots(Mainnet.CROWD_POTS);
    ILivePayroll internal constant PAYROLL = ILivePayroll(Mainnet.PAYROLL);
    IWorkRegistryLive internal constant REGISTRY = IWorkRegistryLive(Mainnet.WORK_REGISTRY);

    /// @dev The reference job, its receipt and the agent its record names.
    bytes16 internal constant REFERENCE_JOB = 0xe9efec1656f340d3924352c453effc7d;
    bytes32 internal constant REFERENCE_RECEIPT = 0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5;
    string internal constant RECORD_FILE = "test/fixtures/rules/records/e9efec16-skill-research-report-3db99325.hex";
    string internal constant RECORD_KIND = "skill:research-report";

    bool internal forked;
    string internal whyNot;
    address internal registryWriter;
    RecordMaker internal recordMaker;
    uint256 private _jobs;

    /// @dev Selects the fork. Returns false, and changes nothing, when the RPC cannot be reached.
    function _selectLiveFork() internal returns (bool) {
        try vm.createSelectFork(vm.rpcUrl("mainnet")) returns (uint256) {}
        catch Error(string memory reason) {
            whyNot = string.concat("mainnet RPC not reachable: ", reason);
            return false;
        } catch {
            whyNot = "mainnet RPC not reachable: the fork could not be created";
            return false;
        }
        require(Mainnet.QUESTIONS.code.length != 0, "Questions has no code on this fork");
        require(Mainnet.WORK_ORDERS.code.length != 0, "WorkOrders has no code on this fork");
        require(Mainnet.CROWD_POTS.code.length != 0, "CrowdPots has no code on this fork");
        registryWriter = REGISTRY.writer();
        require(registryWriter != address(0), "the registry names no writer");
        // Created after the fork is selected: a contract made before it does not exist on it.
        recordMaker = new RecordMaker();
        forked = true;
        return true;
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true, whyNot);
            return;
        }
        _;
    }

    /// @dev Real IMD for an actor, and an allowance for a spender.
    function _fund(address who, uint256 amount, address spender) internal {
        deal(Mainnet.IMD, who, IMD.balanceOf(who) + amount);
        vm.prank(who);
        IMD.approve(spender, type(uint256).max);
    }

    /// @dev Yield the way sIMD receives it: a plain IMD transfer to the vault.
    function _yieldBps(uint256 bps) internal {
        uint256 amount = IERC20(Mainnet.IMD).balanceOf(Mainnet.SIMD) * bps / 10_000;
        address donor = makeAddr("live fork yield");
        deal(Mainnet.IMD, donor, amount);
        vm.prank(donor);
        IMD.transfer(Mainnet.SIMD, amount);
    }

    /// @dev The stored reference record, decoded to the bytes IdentityMD served.
    function _referenceRecord() internal view returns (bytes memory) {
        return vm.parseBytes(vm.readFile(RECORD_FILE));
    }

    /// @dev A job id no job has: the real registry holds nothing for it.
    function _freshJob() internal returns (bytes16 jobId) {
        jobId = bytes16(keccak256(abi.encode("a HELP WANTED launch C fork job", ++_jobs, address(this))));
        assertEq(REGISTRY.latest(jobId), bytes32(0), "the job id is not fresh");
    }

    /// @dev The reference record made into the record of `jobId` for the order's current claim:
    /// the claim's 85 header bytes followed by `spec` as its objective, kind and state as given.
    function _recordFor(uint256 orderId, bytes16 jobId, bytes memory spec) internal view returns (bytes memory) {
        bytes memory objective = bytes.concat(DESK.headerOf(orderId), spec);
        return recordMaker.recordOf(_referenceRecord(), jobId, RECORD_KIND, objective, "completed");
    }

    /// @dev The real registry's writer records `record` as the job's receipt, the way it records
    /// every receipt: the hash of the served bytes, chained to the job's previous receipt.
    function _recordWork(bytes16 jobId, bytes memory record) internal returns (bytes32 documentHash) {
        documentHash = keccak256(record);
        // Read before the prank: the prank applies to the very next call, and an argument's call
        // would take it.
        bytes32 previous = REGISTRY.latest(jobId);
        vm.prank(registryWriter);
        REGISTRY.recordWork(
            jobId,
            previous,
            documentHash,
            "https://api.imd.fun/work-records/launch-c-fork-test.json",
            new IWorkRegistryLive.Signal[](0)
        );
        assertEq(REGISTRY.latest(jobId), documentHash, "the registry holds the receipt");
    }

    /// @dev Opens a pot on the live CrowdPots for one research report: `target` IMD, a fixed price,
    /// the desk's minimum bond, receipt only.
    function _openLivePot(uint96 target) internal returns (uint256 potId) {
        ILivePots.Terms memory t;
        t.kind = RECORD_KIND;
        t.target = target;
        t.minPay = target;
        t.bond = DESK.MIN_BOND();
        t.deliverySecs = DESK.MIN_DELIVERY();
        t.hireSecs = 1 days;
        t.fundSecs = 1 days;
        potId = POTS.openPot(
            t, "Write a one-page plain-language summary of the IMD staking vault's deposits this week, with sources.", 0
        );
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }
}
