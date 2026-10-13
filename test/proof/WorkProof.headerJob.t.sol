// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {MockRegistry} from "./utils/Registries.sol";

/// @notice A real swarm job whose objective begins with a HELP WANTED order header, read by the contract.
/// @dev On 13 October 2026 we bought one research job from IdentityMD (job
/// `e70c56ce-60f0-4c2c-b413-67e5ae37ddce`, template `skill:research-report`) and sent it an objective
/// made of an 85-byte order header followed by a plain question. `test/fixtures/proof/header-job/record.json`
/// is that job's work record exactly as IdentityMD serves it at
/// `https://api.imd.fun/work-records/990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d.json`.
/// It shows what the hire desk depends on: the stored objective keeps the header byte for byte at its
/// start, and the record names the job's template as its kind. When this file was written the receipt
/// for the job was still queued at IdentityMD and not yet in the WorkRegistry, so the registry here is
/// a stand-in; `test/fork/HeaderJob.fork.t.sol` asks the real one.
contract WorkProofHeaderJobTest is Test {
    bytes16 internal constant JOB = bytes16(0xe70c56ce60f04c2cb41367e5ae37ddce);
    bytes32 internal constant RECORD_HASH = 0x990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d;
    string internal constant HEADER =
        "[help-wanted order de7eddaacedc4110cb3ca3388ecec4dae5bda3eae85c721452c078dc71592041] ";
    string internal constant SPEC =
        "Write a one-page plain-language summary of how Uniswap v4 hooks changed what a liquidity pool can do, with three concrete examples and the sources you used.";

    WorkProof internal proof;
    MockRegistry internal registry;
    bytes internal record;

    function setUp() public {
        registry = new MockRegistry();
        proof = new WorkProof(address(registry));
        record = vm.readFileBinary("test/fixtures/proof/header-job/record.json");
    }

    function test_headerJob_theServedBytesHashToTheRecordHash() public view {
        assertEq(keccak256(record), RECORD_HASH);
        assertEq(bytes(HEADER).length, 85);
    }

    function test_headerJob_scanFindsTheHeaderTheSpecTheKindAndTheAgent() public view {
        (bytes16 jobId, IWorkProof.Proof memory p) = proof.scan(record, 85);
        assertEq(jobId, JOB, "job id");
        assertEq(p.recordHash, RECORD_HASH, "record hash");
        assertEq(p.headHash, keccak256(bytes(HEADER)), "the first 85 bytes of the objective are the header");
        assertEq(p.specHash, keccak256(bytes(SPEC)), "the rest of the objective is the spec, unchanged");
        assertEq(p.kindHash, keccak256("skill:research-report"), "the kind is the job's template");
        assertEq(p.stateHash, keccak256("completed"), "state");
        assertEq(p.agentIds.length, 1, "one agent worked");
        assertEq(p.agentIds[0], 52715, "agent id");
    }

    function test_headerJob_provesOnceTheRegistryHoldsItsHash() public {
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, JOB));
        proof.prove(JOB, record, 85);

        registry.set(JOB, RECORD_HASH);
        IWorkProof.Proof memory p = proof.prove(JOB, record, 85);
        assertEq(p.headHash, keccak256(bytes(HEADER)));
        assertEq(p.specHash, keccak256(bytes(SPEC)));
    }

    function test_headerJob_oneChangedByteDoesNotProve() public {
        registry.set(JOB, RECORD_HASH);
        bytes memory altered = record;
        altered[altered.length - 2] = altered[altered.length - 2] == "a" ? bytes1("b") : bytes1("a");
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, RECORD_HASH, keccak256(altered)));
        proof.prove(JOB, altered, 85);
    }
}
