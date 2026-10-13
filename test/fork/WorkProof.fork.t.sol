// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {IWorkRegistry} from "../../src/interfaces/external/IWorkRegistry.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {ProofFixtures} from "../proof/utils/ProofFixtures.sol";
import {Chunks} from "../proof/utils/Chunks.sol";

/// @notice The fixtures proven against IdentityMD's real WorkRegistry on a fork of mainnet at the
/// latest block. Run with `FOUNDRY_PROFILE=fork forge test`. Every test skips itself when the
/// RPC endpoint cannot be reached.
/// @dev Assertions are relationships, not snapshots: a record proves exactly when the registry's
/// current `latest(jobId)` equals its hash. Should IdentityMD write a newer receipt for one of
/// these jobs, that fixture moves to the "superseded" branch and the suite still holds.
contract WorkProofForkTest is ProofFixtures {
    WorkProof internal proof;
    IWorkRegistry internal constant REGISTRY = IWorkRegistry(Mainnet.WORK_REGISTRY);
    bool internal forked;

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("mainnet")) returns (uint256) {
            // One read through the fork before any test relies on it.
            try REGISTRY.latest(REFERENCE_JOB) returns (bytes32) {
                forked = Mainnet.WORK_REGISTRY.code.length != 0;
            } catch {
                forked = false;
            }
        } catch {
            forked = false;
        }
        if (forked) proof = new WorkProof(Mainnet.WORK_REGISTRY);
    }

    function test_fork_everyFixtureProvesExactlyWhenItIsTheLatestReceipt() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        string memory index = _index();
        uint256 n = _count(index);
        uint256 proven;
        uint256 superseded;
        bool referenceProven;

        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);
            bytes32 latest = REGISTRY.latest(f.jobId);
            assertTrue(latest != bytes32(0), "every fixture's job has a receipt on chain");

            if (latest == f.recordHash) {
                IWorkProof.Proof memory p = proof.prove(f.jobId, f.record, 0);
                assertEq(p.recordHash, f.recordHash, f.file);
                assertEq(p.kindHash, f.kindHash, f.file);
                assertEq(p.stateHash, f.stateHash, f.file);
                assertEq(p.specHash, f.objectiveHash, f.file);
                assertEq(p.agentIds, f.agentIds, f.file);
                ++proven;
                if (f.jobId == REFERENCE_JOB) referenceProven = true;

                // One changed byte, in the part of the record the scanner never reads, fails.
                bytes memory changed = bytes.concat(f.record);
                uint256 at = f.scanStopsAt + (changed.length - f.scanStopsAt) / 2;
                changed[at] = bytes1(uint8(changed[at]) ^ 0x01);
                vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, latest, keccak256(changed)));
                proof.prove(f.jobId, changed, 0);
            } else {
                // The registry has moved on to a later receipt for this job.
                vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, latest, f.recordHash));
                proof.prove(f.jobId, f.record, 0);
                ++superseded;
            }
            // A receipt the index recorded as superseded cannot have become the latest again.
            if (!f.isLatest) assertTrue(latest != f.recordHash, "a superseded receipt is latest again");
        }

        console2.log("fixtures proven against the real registry:", proven);
        console2.log("fixtures superseded on chain:", superseded);
        assertGe(proven, 6, "at least six real records prove against the real registry");
        assertGe(superseded, 1, "at least one fixture is a superseded receipt");
        assertTrue(referenceProven, "the reference job's record proves");
    }

    function test_fork_oneChangedByteAnywhereFailsForTheReferenceJob() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        Fixture memory f = _reference();
        bytes32 latest = REGISTRY.latest(f.jobId);
        if (latest != f.recordHash) {
            vm.skip(true); // superseded since the fixture was taken; the test above covers that case
            return;
        }
        assertEq(latest, REFERENCE_RECEIPT, "the receipt quoted in README.md");

        IWorkProof.Proof memory p = proof.prove(f.jobId, f.record, 0);
        assertEq(p.stateHash, keccak256("completed"));
        assertEq(p.kindHash, keccak256("skill:research-report"));
        assertEq(p.agentIds.length, 1);
        assertEq(p.agentIds[0], 52211);

        // First byte, last byte, inside the objective, inside the record's own job id, and a byte
        // appended.
        uint256 jobIdAt = _indexOf(f.record, '"jobId":"') + 9;
        assertEq(
            _sliceHash(f.record, jobIdAt, 36), keccak256("e9efec16-56f3-40d3-9243-52c453effc7d"), "the job id is there"
        );
        uint256[4] memory positions = [uint256(0), f.record.length - 1, f.objectiveStart + 10, jobIdAt + 3];
        for (uint256 i = 0; i < positions.length; ++i) {
            bytes memory changed = bytes.concat(f.record);
            changed[positions[i]] = bytes1(uint8(changed[positions[i]]) ^ 0x20);
            vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, latest, keccak256(changed)));
            proof.prove(f.jobId, changed, 0);
        }
        bytes memory withNewline = abi.encodePacked(f.record, "\n");
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, latest, keccak256(withNewline)));
        proof.prove(f.jobId, withNewline, 0);

        // The right record under another job's id.
        bytes16 other = bytes16(uint128(f.jobId) ^ 1);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, other));
        proof.prove(other, f.record, 0);
    }

    /// @dev Where `needle` first occurs in `haystack`.
    function _indexOf(bytes memory haystack, bytes memory needle) internal pure returns (uint256) {
        for (uint256 i = 0; i + needle.length <= haystack.length; ++i) {
            if (_sliceHash(haystack, i, needle.length) == keccak256(needle)) return i;
        }
        revert("not found");
    }

    function test_fork_largestRecordProvesThroughChunks() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        string memory index = _index();
        uint256 n = _count(index);
        uint256 largest = type(uint256).max;
        uint256 size;
        for (uint256 i = 0; i < n; ++i) {
            uint256 s = vm.parseJsonUint(index, string.concat(".fixtures[", vm.toString(i), "].size"));
            bool isLatest = vm.parseJsonBool(index, string.concat(".fixtures[", vm.toString(i), "].isLatest"));
            if (isLatest && s > size) (largest, size) = (i, s);
        }
        Fixture memory f = _fixture(index, largest);
        if (REGISTRY.latest(f.jobId) != f.recordHash) {
            vm.skip(true);
            return;
        }
        assertGt(f.record.length, 128 * 1024, "a record too large for one transaction's calldata");

        address[] memory chunks = Chunks.etch(vm, f.record, Chunks.MAX_SLICE, uint160(0xC0DE000000));
        IWorkProof.Proof memory chunked = proof.proveChunks(f.jobId, chunks, 85);
        IWorkProof.Proof memory whole = proof.prove(f.jobId, f.record, 85);
        assertEq(abi.encode(chunked), abi.encode(whole));
        assertEq(chunked.recordHash, f.recordHash);
        assertEq(chunked.agentIds, f.agentIds);

        // Leave one chunk out and the join is another document.
        address[] memory fewer = new address[](chunks.length - 1);
        for (uint256 i = 0; i < fewer.length; ++i) {
            fewer[i] = chunks[i];
        }
        vm.expectPartialRevert(IWorkProof.HashMismatch.selector);
        proof.proveChunks(f.jobId, fewer, 85);
    }

    function test_fork_registryAnswersFarInsideItsGasAllowance() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        // A job that does not exist: the real registry returns zero and does not revert.
        bytes16 unknown = 0x00000000000000000000000000000001;
        assertEq(REGISTRY.latest(unknown), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, unknown));
        proof.prove(unknown, hex"7b7d", 0);

        // What the real `latest` costs, account and storage slot both cold.
        vm.cool(Mainnet.WORK_REGISTRY);
        bytes memory call = abi.encodeCall(IWorkRegistry.latest, (REFERENCE_JOB));
        uint256 before = gasleft();
        (bool ok, bytes memory out) = Mainnet.WORK_REGISTRY.staticcall(call);
        uint256 used = before - gasleft();
        assertTrue(ok);
        assertEq(out.length, 32, "exactly one word");
        console2.log("gas for a cold WorkRegistry.latest call:", used);
        assertLt(used, proof.REGISTRY_GAS() / 4, "the allowance leaves at least fourfold headroom");
    }
}
