// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {Rec} from "./utils/Rec.sol";
import {Chunks} from "./utils/Chunks.sol";
import {RecordGen} from "./utils/RecordGen.sol";
import {ProofFixtures} from "./utils/ProofFixtures.sol";
import {MockRegistry} from "./utils/Registries.sol";

/// @notice `proveChunks`: a record stored as the code of data contracts must be treated exactly as
/// the same bytes passed to `prove`.
contract WorkProofChunksTest is RecordGen, ProofFixtures {
    WorkProof internal proof;
    MockRegistry internal registry;

    uint160 internal constant CHUNK_BASE = uint160(0xC0FFEE0000);

    function setUp() public {
        registry = new MockRegistry();
        proof = new WorkProof(address(registry));
    }

    // ---------------------------------------------------------------- equivalence with prove

    function testFuzz_proveChunks_equalsProveForAnyChunking(uint256 seed, uint256 pieces) public {
        Truth memory t = _generate(seed);
        registry.set(t.jobId, keccak256(t.record));
        uint256 headLen = seed % (t.objectiveRaw.length + 1);

        // Random cut points, sorted; repeats make empty chunks, which are allowed.
        Rng memory rng = Rng(seed ^ 0x5eed);
        uint256[] memory cuts = new uint256[](bound(pieces, 0, 12));
        for (uint256 i = 0; i < cuts.length; ++i) {
            cuts[i] = _below(rng, t.record.length + 1);
        }
        _sort(cuts);
        address[] memory chunks = Chunks.etchAt(vm, t.record, cuts, CHUNK_BASE);

        IWorkProof.Proof memory whole = proof.prove(t.jobId, t.record, headLen);
        IWorkProof.Proof memory chunked = proof.proveChunks(t.jobId, chunks, headLen);
        assertEq(abi.encode(chunked), abi.encode(whole), "chunked and whole proofs differ");
        assertEq(chunked.agentIds, t.agentIds);
    }

    function testFuzz_proveChunks_failsAsProveFailsOnDamagedBytes(uint256 seed, uint256 at, uint8 flip) public {
        // The registry holds the hash of the damaged bytes, so both paths get as far as the parse,
        // and must then agree on the verdict, error for error.
        Truth memory t = _generate(seed);
        at = bound(at, 0, t.record.length - 1);
        flip = uint8(bound(flip, 1, 255));
        bytes memory damaged = t.record;
        damaged[at] = bytes1(uint8(damaged[at]) ^ flip);
        registry.set(t.jobId, keccak256(damaged));

        address[] memory chunks = Chunks.etch(vm, damaged, 1 + (seed % 700), CHUNK_BASE);
        (bool okWhole, bytes memory outWhole) =
            address(proof).staticcall(abi.encodeCall(IWorkProof.prove, (t.jobId, damaged, 0)));
        (bool okChunked, bytes memory outChunked) =
            address(proof).staticcall(abi.encodeCall(IWorkProof.proveChunks, (t.jobId, chunks, 0)));
        assertEq(okChunked, okWhole);
        assertEq(outChunked, outWhole);
    }

    function test_proveChunks_everyFixtureInCodeSizedChunks() public {
        string memory index = _index();
        uint256 n = _count(index);
        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);
            if (!f.isLatest) continue;
            registry.set(f.jobId, f.recordHash);
            address[] memory chunks = Chunks.etch(vm, f.record, Chunks.MAX_SLICE, CHUNK_BASE + uint160(i) * 100);
            assertEq(chunks.length, (f.record.length + Chunks.MAX_SLICE - 1) / Chunks.MAX_SLICE);

            IWorkProof.Proof memory chunked = proof.proveChunks(f.jobId, chunks, 0);
            assertEq(chunked.recordHash, f.recordHash, f.file);
            assertEq(chunked.kindHash, f.kindHash, f.file);
            assertEq(chunked.stateHash, f.stateHash, f.file);
            assertEq(chunked.specHash, f.objectiveHash, f.file);
            assertEq(chunked.agentIds, f.agentIds, f.file);
        }
    }

    function test_proveChunks_readsContractsDeployedTheOrdinaryWay() public {
        // No cheat codes for the storage: the record is deployed as real data contracts, each within
        // the 24,576-byte code limit, as a runner would do it.
        Fixture memory f = _reference();
        registry.set(f.jobId, f.recordHash);
        uint256 sliceLen = 3000;
        uint256 count = (f.record.length + sliceLen - 1) / sliceLen;
        address[] memory chunks = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            uint256 from = i * sliceLen;
            uint256 len = f.record.length - from < sliceLen ? f.record.length - from : sliceLen;
            chunks[i] = Chunks.deploy(Chunks.slice(f.record, from, len));
            assertEq(chunks[i].code.length, len + 1);
            assertEq(chunks[i].code[0], bytes1(0x00), "a data contract starts with STOP");
            // Calling it does nothing and returns nothing.
            (bool ok, bytes memory out) = chunks[i].call("");
            assertTrue(ok);
            assertEq(out.length, 0);
        }
        IWorkProof.Proof memory chunked = proof.proveChunks(f.jobId, chunks, 85);
        IWorkProof.Proof memory whole = proof.prove(f.jobId, f.record, 85);
        assertEq(abi.encode(chunked), abi.encode(whole));
    }

    function test_proveChunks_aFullSizeDataContractCanBeDeployed() public {
        bytes memory slice = new bytes(Chunks.MAX_SLICE);
        for (uint256 i = 0; i < slice.length; i += 97) {
            slice[i] = bytes1(uint8(i));
        }
        address chunk = Chunks.deploy(slice);
        assertEq(chunk.code.length, 24_576, "exactly the EIP-170 limit");
    }

    // ---------------------------------------------------------------- order and content of chunks

    function test_proveChunks_orderMatters() public {
        bytes memory record = Rec.minimal();
        registry.set(Rec.JOB, keccak256(record));
        address[] memory chunks = Chunks.etch(vm, record, 100, CHUNK_BASE);
        assertGe(chunks.length, 3);
        proof.proveChunks(Rec.JOB, chunks, 0);

        (chunks[0], chunks[1]) = (chunks[1], chunks[0]);
        vm.expectPartialRevert(IWorkProof.HashMismatch.selector);
        proof.proveChunks(Rec.JOB, chunks, 0);
    }

    function test_proveChunks_missingOrRepeatedChunkIsHashMismatch() public {
        bytes memory record = Rec.minimal();
        registry.set(Rec.JOB, keccak256(record));
        address[] memory chunks = Chunks.etch(vm, record, 100, CHUNK_BASE);

        address[] memory fewer = new address[](chunks.length - 1);
        for (uint256 i = 0; i < fewer.length; ++i) {
            fewer[i] = chunks[i];
        }
        vm.expectPartialRevert(IWorkProof.HashMismatch.selector);
        proof.proveChunks(Rec.JOB, fewer, 0);

        address[] memory more = new address[](chunks.length + 1);
        for (uint256 i = 0; i < chunks.length; ++i) {
            more[i] = chunks[i];
        }
        more[chunks.length] = chunks[chunks.length - 1];
        vm.expectPartialRevert(IWorkProof.HashMismatch.selector);
        proof.proveChunks(Rec.JOB, more, 0);
    }

    function test_proveChunks_emptySlicesAreAllowedAnywhere() public {
        bytes memory record = Rec.minimal();
        registry.set(Rec.JOB, keccak256(record));
        address justStop = address(CHUNK_BASE + 5000);
        vm.etch(justStop, hex"00");

        address[] memory real = Chunks.etch(vm, record, 120, CHUNK_BASE);
        address[] memory padded = new address[](real.length * 2 + 1);
        for (uint256 i = 0; i < real.length; ++i) {
            padded[2 * i] = justStop;
            padded[2 * i + 1] = real[i];
        }
        padded[padded.length - 1] = justStop;
        IWorkProof.Proof memory p = proof.proveChunks(Rec.JOB, padded, 0);
        assertEq(p.recordHash, keccak256(record));
    }

    function test_proveChunks_chunkWithoutCodeIsBadChunk() public {
        bytes memory record = Rec.minimal();
        registry.set(Rec.JOB, keccak256(record));
        address[] memory chunks = Chunks.etch(vm, record, 100, CHUNK_BASE);
        chunks[2] = makeAddr("never deployed");
        vm.expectRevert(abi.encodeWithSelector(WorkProof.BadChunk.selector, 2));
        proof.proveChunks(Rec.JOB, chunks, 0);

        chunks[0] = address(0);
        vm.expectRevert(abi.encodeWithSelector(WorkProof.BadChunk.selector, 0));
        proof.proveChunks(Rec.JOB, chunks, 0);
    }

    function test_proveChunks_chunkNotStartingWithZeroIsBadChunk() public {
        bytes memory record = Rec.minimal();
        registry.set(Rec.JOB, keccak256(record));
        address[] memory chunks = Chunks.etch(vm, record, 100, CHUNK_BASE);
        // The same slice without its marker byte: an ordinary contract's code, not a data contract.
        vm.etch(chunks[1], Chunks.slice(record, 100, 100));
        vm.expectRevert(abi.encodeWithSelector(WorkProof.BadChunk.selector, 1));
        proof.proveChunks(Rec.JOB, chunks, 0);

        // This very contract, which has code and is not a data contract.
        chunks[1] = address(proof);
        vm.expectRevert(abi.encodeWithSelector(WorkProof.BadChunk.selector, 1));
        proof.proveChunks(Rec.JOB, chunks, 0);
    }

    function test_proveChunks_noChunksIsAnEmptyRecord() public {
        address[] memory none = new address[](0);
        // The registry holds a receipt: the empty document is not it.
        registry.set(Rec.JOB, keccak256(Rec.minimal()));
        vm.expectRevert(
            abi.encodeWithSelector(IWorkProof.HashMismatch.selector, keccak256(Rec.minimal()), keccak256(""))
        );
        proof.proveChunks(Rec.JOB, none, 0);

        // Even a registry that holds the hash of nothing does not make nothing a record.
        registry.set(Rec.JOB, keccak256(""));
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.Malformed.selector, 0));
        proof.proveChunks(Rec.JOB, none, 0);
    }

    // ---------------------------------------------------------------- the errors of prove, unchanged

    function test_proveChunks_errorsMatchProve() public {
        bytes memory record = Rec.minimal();
        address[] memory chunks = Chunks.etch(vm, record, 64, CHUNK_BASE);

        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, Rec.JOB));
        proof.proveChunks(Rec.JOB, chunks, 0);

        registry.set(Rec.JOB, keccak256("something else"));
        vm.expectRevert(
            abi.encodeWithSelector(IWorkProof.HashMismatch.selector, keccak256("something else"), keccak256(record))
        );
        proof.proveChunks(Rec.JOB, chunks, 0);

        registry.set(Rec.JOB, keccak256(record));
        vm.expectRevert(IWorkProof.HeadTooLong.selector);
        proof.proveChunks(Rec.JOB, chunks, 37);

        bytes16 other = 0x11111111111111111111111111111111;
        registry.set(other, keccak256(record));
        vm.expectRevert(IWorkProof.JobIdMismatch.selector);
        proof.proveChunks(other, chunks, 0);

        try proof.proveChunks{gas: 45_000}(Rec.JOB, chunks, 0) {
            fail();
        } catch (bytes memory reason) {
            // Either the guard speaks, or the gas ran out while the chunks were being read.
            if (reason.length != 0) assertEq(reason, abi.encodeWithSelector(WorkProof.InsufficientGas.selector));
        }
    }

    function test_proveChunks_onlyTheAddressBytesOfAChunkWordCount() public {
        // The chunk list is read straight from calldata and each word is cut down to its low 20
        // bytes. Stray bits above them cannot point the read at any other contract: the same chunk
        // is read and the same proof comes back.
        bytes memory record = Rec.minimal();
        registry.set(Rec.JOB, keccak256(record));
        address[] memory chunks = Chunks.etch(vm, record, 1000, CHUNK_BASE);
        bytes memory call = abi.encodeCall(IWorkProof.proveChunks, (Rec.JOB, chunks, 0));
        (bool ok, bytes memory clean) = address(proof).staticcall(call);
        assertTrue(ok);
        // Offset of the first array element: selector, three head words, the length word.
        call[4 + 4 * 32] = 0x01;
        (bool okDirty, bytes memory dirty) = address(proof).staticcall(call);
        assertTrue(okDirty);
        assertEq(dirty, clean);
    }

    function _sort(uint256[] memory a) internal pure {
        for (uint256 i = 1; i < a.length; ++i) {
            uint256 x = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > x) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = x;
        }
    }
}
