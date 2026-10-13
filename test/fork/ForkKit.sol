// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPayroll} from "../../src/interfaces/IPayroll.sol";
import {IWorkRegistry} from "../../src/interfaces/external/IWorkRegistry.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {Receipts} from "../kit/Receipts.sol";
import {RecordMaker} from "../kit/RecordMaker.sol";

/// @dev The part of IdentityMD's WorkRegistry that writes a receipt. The registry's source is not
/// published; this signature was recovered from its live transactions (selector `0x765b59a5`) and
/// is used here only on a fork, by impersonating the address the registry itself names as writer.
interface IWorkRegistryWriter {
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

    function writer() external view returns (address);

    function recordWork(
        bytes16 jobId,
        bytes32 previousHash,
        bytes32 documentHash,
        string calldata uri,
        Signal[] calldata signals
    ) external;
}

/// @dev The launched Payroll beyond `IPayroll`: the views, events and the one error the fork tests
/// read. Taken from the source of HELP WANTED's first launch as deployed; every function here is
/// called on the live contract by `test_fork_payroll_isTheContractTheFirstLaunchCreated`.
interface ILivePayroll is IPayroll {
    /// @dev Running totals in IMD wei. `received` is everything booked as revenue (`pay` and
    /// `book`), `tipsIn` everything pulled through `tip`, `tipsToSeats` the part of the tips that
    /// joined the seat pool (remainders, empty lists, swept tips), `tipsClaimed` what `claimTip` paid.
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

    event Paid(address indexed from, bytes32 indexed memo, uint256 amount);
    event Tipped(address indexed from, uint256 amount, uint256 perAgent, uint256 toSeatPool, uint256[] agentIds);

    error ContractOwnerMustClaim(address owner);

    function ledger() external view returns (Ledger memory);

    /// @dev IMD that arrived by plain transfer and has not been split yet: what `book` would book.
    function unbooked() external view returns (uint256);

    function IMD() external view returns (address);

    function SIMD() external view returns (address);

    function SEATS() external view returns (address);

    function ADAPTER() external view returns (address);

    function QUESTIONS() external view returns (address);

    function MAX_TIP_AGENTS() external view returns (uint256);
}

/// @dev The seat Adapter's one read, and the seat token's.
interface ISeatBinding {
    function bindingOf(uint256 agentId) external view returns (uint8 standard, address tokenContract, uint256 tokenId);
}

interface ISeatOwner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title What the fork tests share
/// @notice A fork of Ethereum mainnet at the latest block, real IMD for the actors, and the one
/// thing no test on a local chain can do: have IdentityMD's real WorkRegistry hold a receipt for a
/// job of ours. The registry accepts receipts from one address, which it names itself
/// (`writer()`). On the fork the tests read that address and act as it, exactly as the real writer
/// would: `recordWork(jobId, previousHash, keccak256(record), uri, [])`. From then on everything is
/// the real thing: the registry's own storage answers `latest(jobId)`, the launch's WorkProof reads
/// the record, the desk pays in real IMD.
///
/// What this shows and what it does not. It shows that our contracts settle against the registry's
/// real code and storage for a record that carries our order header, and pay the live Payroll in
/// real IMD. It does not show a receipt written by the real writer for a job of ours. That the
/// swarm keeps a header byte for byte in a real job's stored objective is shown separately, on the
/// record of one real job (`test/proof/WorkProof.headerJob.t.sol`); that job's receipt was still
/// queued at IdentityMD when this was written (`HeaderJob.fork.t.sol` reports which it finds).
///
/// Every record used is a real work record from `test/fixtures/proof/records` with its job id and
/// objective swapped (`Receipts`), so the bytes WorkProof reads are IdentityMD's own apart from
/// those two members.
abstract contract ForkKit is Receipts {
    IERC20 internal constant IMD = IERC20(Mainnet.IMD);
    IWorkRegistry internal constant REGISTRY = IWorkRegistry(Mainnet.WORK_REGISTRY);
    /// @dev The Payroll contract of HELP WANTED's first launch, live on mainnet since block
    /// 26182869 (13 October 2026). It has no owner and no upgrade path, so its code never changes.
    ILivePayroll internal constant PAYROLL = ILivePayroll(Mainnet.PAYROLL);
    /// @dev keccak256 of that contract's runtime code, as read from mainnet on 13 October 2026
    /// (`cast keccak $(cast code 0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F)`), 11,846 bytes. The
    /// code is the build output of the first launch's source with its constructor arguments set.
    bytes32 internal constant PAYROLL_CODEHASH = 0xa962b0633998d594b2720984ad5f76fce369148592da0762b9d9acf399367236;

    /// @dev The reference job of `README.md`, and its receipt.
    bytes16 internal constant REFERENCE_JOB = 0xe9efec1656f340d3924352c453effc7d;
    bytes32 internal constant REFERENCE_RECEIPT = 0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5;

    bool internal forked;
    /// @dev Who may write receipts, as the registry itself says on the fork.
    address internal registryWriter;
    uint256 private _jobs;

    /// @dev Selects the fork. Returns false, and changes nothing, when the RPC cannot be reached.
    function _fork() internal returns (bool) {
        try vm.createSelectFork(vm.rpcUrl("mainnet")) returns (uint256) {
            // One read through the fork before any test relies on it.
            try IWorkRegistryWriter(Mainnet.WORK_REGISTRY).writer() returns (address w) {
                registryWriter = w;
                forked = Mainnet.WORK_REGISTRY.code.length != 0 && w != address(0);
                // A node that answers but does not hold the first launch's Payroll is not a reason
                // to skip: the tests would not be testing what they say. Fail instead.
                if (forked) require(Mainnet.PAYROLL.code.length != 0, "Payroll has no code on this fork");
                // The helper that builds records was created before the fork was selected and
                // does not exist on it.
                if (forked) recordMaker = new RecordMaker();
            } catch {
                forked = false;
            }
        } catch {
            forked = false;
        }
        return forked;
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true, "mainnet RPC unreachable");
            return;
        }
        _;
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _skip(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    /// @dev Real IMD for an actor, and an allowance for each spender it will use.
    function _fund(address who, uint256 amount, address spender) internal {
        deal(Mainnet.IMD, who, IMD.balanceOf(who) + amount);
        vm.prank(who);
        IMD.approve(spender, type(uint256).max);
    }

    /// @dev A job id no job has: the registry holds nothing for it.
    function _freshJob() internal returns (bytes16 jobId) {
        jobId = bytes16(keccak256(abi.encode("a HELP WANTED fork rehearsal job", ++_jobs, address(this))));
        assertEq(REGISTRY.latest(jobId), bytes32(0), "the job id is not fresh");
    }

    /// @dev The real registry's writer records `record` as the job's receipt, the way it records
    /// every receipt: the hash of the served bytes, chained to the job's previous receipt.
    function _recordWork(bytes16 jobId, bytes memory record) internal returns (bytes32 documentHash) {
        documentHash = keccak256(record);
        bytes32 previous = REGISTRY.latest(jobId);
        string memory uri = string.concat("https://api.imd.fun/work-records/", _hex(documentHash), ".json");
        vm.prank(registryWriter);
        IWorkRegistryWriter(Mainnet.WORK_REGISTRY)
            .recordWork(jobId, previous, documentHash, uri, new IWorkRegistryWriter.Signal[](0));
        assertEq(REGISTRY.latest(jobId), documentHash, "the registry holds the receipt");
    }

    /// @dev A job's second receipt, as IdentityMD writes one when the work is delivered to a
    /// repository: the same record with `previousHash` naming the first receipt and no signals.
    function _secondRecord(bytes memory first) internal view returns (bytes memory) {
        return recordMaker.secondOf(first);
    }

    function _hex(bytes32 word) internal pure returns (string memory) {
        bytes16 digits = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i; i < 32; ++i) {
            out[2 * i] = digits[uint8(word[i]) >> 4];
            out[2 * i + 1] = digits[uint8(word[i]) & 0x0f];
        }
        return string(out);
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }
}
