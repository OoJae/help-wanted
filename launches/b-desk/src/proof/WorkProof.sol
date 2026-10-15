// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkProof} from "../interfaces/IWorkProof.sol";
import {JsonScan} from "./JsonScan.sol";

/// @title WorkProof: checks a swarm work record against IdentityMD's on-chain receipt
/// @notice IdentityMD's WorkRegistry stores, for each job its swarm finishes, the keccak256 of the
/// job's work record: a JSON document saying what was asked, how it ended and which agents worked.
/// Hand this contract the record and it answers one question: is this the document the registry
/// holds for that job, and if so, what does it say? Anyone may call it, from a wallet or from
/// another contract. It keeps no state, has no owner, holds no money and never changes.
///
/// @dev WHAT A PROOF MEANS. `prove` returns only if both of these hold:
///   1. `keccak256(record)` equals `WorkRegistry.latest(jobId)`, read at call time and non-zero;
///   2. the record's top level, as far as its `state` member, has the canonical form IdentityMD
///      writes (the rules are in `JsonScan`), with its own `jobId` naming the same job and its
///      `schema` equal to `identitymd-work-v1`.
/// The hashes it returns are taken over the record's top-level `kind`, `objective` and `state`
/// strings. Why those cannot be planted by anyone but the registry's writer is argued in `JsonScan`.
///
/// WHAT IT DOES NOT MEAN.
///   - That the work is good. A proof says "IdentityMD recorded this document for this job".
///   - That the job ran on the inputs a caller has in mind. A proof binds three things: the template
///     name (`kind`), the objective text and the final state. The other things a job is opened with
///     (a repository and commit, the steps of a plan, a rubric, the size and quorum of a panel) are
///     not top-level members of the record, and nothing here speaks for them: a job whose objective
///     names one repository can have been pointed at another, and for a plan `kind` is only the
///     plan's shape. A caller that pays on a proof pays for "a job of this kind, with this objective,
///     that ended in this state", and should choose kinds and word objectives so that this is enough.
///   - That the registry's writer is beyond question. Whoever controls the writer can record a hash
///     for any document. On 11 October 2026 the writer was
///     0x5dA3054201BC7E241875Ac68173e49C269F76D44, and the registry's admin, an ordinary account at
///     0x047F606fD5b2BaA5f5C6c4aB8958E45CB6B054B7, could appoint another writer (`setWriter`) or
///     another admin (`setAdmin`). The registry's code holds no delegate call, so what `latest` does
///     cannot be swapped from under this contract; who may write receipts can.
///   - That it stays true. `latest` holds one hash per job, so a job that is given a newer receipt
///     stops proving the older record.
///   - That every future record will be readable. The form checked in point 2 is the form records
///     had in October 2026. If the writer changes it while keeping the schema string, records
///     written from then on are `Malformed` here; this contract cannot be changed, so proving them
///     would take a newly deployed one.
///
/// THE REGISTRY IS TREATED AS UNTRUSTED CODE. Its source is not published. It is called with a fixed
/// gas allowance, read-only, and its answer counts only if it is exactly one non-zero word. Any other
/// outcome (a revert, no code, a short or long answer, running out of its allowance) is `NoReceipt`.
/// There is no path on which a broken registry makes a proof pass.
///
/// WHAT THE LIVE REGISTRY HAS BEEN SEEN TO DO (October 2026; the fixtures under `test/fixtures/proof`
/// are the evidence). It holds receipts for jobs that ended `blocked` as well as `completed`, so
/// callers must look at `stateHash`. Some jobs were given a second receipt when their work was
/// delivered to a repository, and `latest` then holds the second. The served record file has no
/// trailing newline.
///
/// WHICH AGENTS A PROOF NAMES. `agentIds` lists the agents in the record's `signals`, each once,
/// leaving out any whose signals all record a submission that verification rejected (`value` 0), so
/// that a caller who rewards the listed agents does not reward a rejected attempt. The list can be
/// empty for a job agents did work on. Four of the five `blocked` records examined carry no signals.
/// And a second receipt carries none either: once a job has one, the record that proves names no
/// agent, while the first record, which does, is no longer `latest` and is not accepted here. (The
/// registry still knows that record's hash, through `receipts(bytes32)`; reading the agents from it
/// is left to a later verifier.) An empty list never makes a proof fail.
///
/// COST. The record is copied and hashed once; the scan then walks only as far as `state`. Measured
/// on real records: about 110,000 gas for a 7 KB research report, about 250,000 for an 86 KB audit,
/// about 700,000 for an 88 KB `research` record, whose bulk sorts before `state` and has to be
/// walked. Sent as calldata, a record is charged at least 10 gas per calldata token (EIP-7623), which
/// for most records is more than the ordinary calldata charge plus this execution.
/// The cost follows a record's shape as well as its size. Text is cheap whatever it holds (4 to 20
/// gas a byte), so what job participants write adds to the cost by its length and in no other way.
/// Structure is not: between strings the walk costs up to about 200 gas a byte, so a record with 80 to 100 KB of
/// nothing but brackets or tiny strings ahead of `state` would need more gas than one transaction
/// may use (16,777,216), through either entry point, and could not be proven at all. Only the writer
/// decides a record's structure. The longest stretch walked in any record examined is 88 KB, nearly
/// all of it text, for under 700,000 gas.
/// A record above about 128 KB does not fit in one transaction's calldata. It has to be stored
/// first as data contracts for `proveChunks`, at 200 gas per byte of code: 13 contracts and about
/// 64M gas, spread over several transactions, for the largest record among the fixtures (318 KB),
/// against about 575,000 gas for the proof itself.
contract WorkProof is IWorkProof {
    /// @notice A chunk passed to `proveChunks` has no code, or its code does not begin with `0x00`.
    /// @param index The position of that chunk in the `chunks` argument.
    error BadChunk(uint256 index);

    /// @notice The call arrived with too little gas to give the registry its full allowance.
    /// @dev Raised before the registry is called, so that `NoReceipt` can never be manufactured by
    /// sending a deliberately small amount of gas for a job that does have a receipt. (The other way
    /// to make an inner call fail, the 1,024-frame depth limit, is out of reach: with one 64th of the
    /// gas held back at every frame, nothing is left to forward long before that depth.)
    error InsufficientGas();

    /// @inheritdoc IWorkProof
    address public immutable WORK_REGISTRY;

    /// @notice Gas given to the registry's `latest(bytes16)`.
    /// @dev The live registry answers in about 2,800 gas (one cold storage read; about 5,500 with
    /// the cold account). The allowance leaves room for a costlier implementation while bounding
    /// what an unexpected one can burn.
    uint256 public constant REGISTRY_GAS = 50_000;

    /// @dev Gas that must be on hand before the registry call so that the 63/64 rule still leaves the
    /// callee `REGISTRY_GAS`: 50,000 * 64 / 63 is 50,794, plus 2,600 for a cold account and a margin
    /// for the instructions in between.
    uint256 private constant REGISTRY_GAS_FLOOR = 56_000;

    /// @dev `latest(bytes16)`.
    uint256 private constant LATEST_SELECTOR = 0xebe9712c00000000000000000000000000000000000000000000000000000000;

    /// @param workRegistry IdentityMD's WorkRegistry. It is not called or inspected here (the launch
    /// pipeline runs constructors on an empty chain); it is checked on every use instead. An address
    /// with no code makes every `prove` revert `NoReceipt`.
    /// There is no zero-address test on purpose: a registry that is not there fails safe.
    // forge-lint: disable-next-line(missing-zero-check)
    constructor(address workRegistry) {
        WORK_REGISTRY = workRegistry;
    }

    /// @inheritdoc IWorkProof
    /// @dev Anyone may call. `record` must be the exact bytes the registry's hash was taken over: the
    /// file served at `https://api.imd.fun/work-records/<hash>.json`, byte for byte, nothing appended.
    ///
    /// `headLen` splits the objective for callers that put a fixed header in front of their own text
    /// (the hire desk passes 85). `headHash` and `specHash` are taken over the bytes as they sit in
    /// the record, still JSON-escaped. A caller that compares `headHash` with the hash of plain text
    /// holding no `"` and no `\` learns that the objective really starts with that text, and that the
    /// split falls on a character boundary, because such text is written to JSON unchanged.
    ///
    /// Reverts: `InsufficientGas` (send more gas), `NoReceipt` (the registry holds nothing usable for
    /// this job), `HashMismatch` (it holds a different document), `Malformed`, `MissingKey`,
    /// `WrongSchema` (the document is not a canonical v1 work record), `JobIdMismatch` (the record
    /// names another job) and `HeadTooLong` (`headLen` exceeds the objective's length).
    function prove(bytes16 jobId, bytes calldata record, uint256 headLen) external view returns (Proof memory) {
        return _prove(jobId, record, headLen);
    }

    /// @inheritdoc IWorkProof
    /// @dev Anyone may call. For records too large to send as calldata in one transaction: the record
    /// is first stored as the code of one or more data contracts, each holding `0x00` (so the contract
    /// can never run) followed by the next slice. The slices are read in the order given, joined, and
    /// from there on treated exactly as `prove` treats its `record`. The chunks need no trust: if they
    /// do not join into the registered document the hash check fails like any other wrong record.
    /// Reverts as `prove` does, and `BadChunk(index)` when a chunk has no code or no leading `0x00`.
    function proveChunks(bytes16 jobId, address[] calldata chunks, uint256 headLen)
        external
        view
        returns (Proof memory)
    {
        return _prove(jobId, _join(chunks), headLen);
    }

    /// @inheritdoc IWorkProof
    /// @dev Anyone may call. Returns what `prove` would return for these bytes, plus the job id the
    /// record itself states, without asking the registry anything: `recordHash` is simply the hash of
    /// what was passed in. Only the part of the record up to its `state` member is examined (and its
    /// last byte), so a result here says nothing about the bytes after that. Reverts `Malformed`,
    /// `MissingKey`, `WrongSchema` and `HeadTooLong` as `prove` does.
    function scan(bytes calldata record, uint256 headLen) external pure returns (bytes16 jobId, Proof memory proof) {
        bytes memory buf = record;
        return _read(buf, keccak256(buf), headLen);
    }

    /// @dev The registry check, then the parse. The hash is compared first: it is the cheap test, and
    /// a wrong document should be turned away before anything in it is read.
    function _prove(bytes16 jobId, bytes memory record, uint256 headLen) private view returns (Proof memory proof) {
        bytes32 got = keccak256(record);
        bytes32 expected = _receipt(jobId);
        if (expected != got) revert HashMismatch(expected, got);

        bytes16 stated;
        (stated, proof) = _read(record, got, headLen);
        // The registry is keyed by job, so a matching hash already ties the bytes to `jobId`. The
        // record's own `jobId` is checked as well, so that a proof never rests on that key alone.
        if (stated != jobId) revert JobIdMismatch();
    }

    /// @dev Reads `WorkRegistry.latest(jobId)` defensively. Returns a non-zero hash or reverts.
    function _receipt(bytes16 jobId) private view returns (bytes32 expected) {
        if (gasleft() < REGISTRY_GAS_FLOOR) revert InsufficientGas();
        address registry = WORK_REGISTRY;
        bool ok;
        assembly ("memory-safe") {
            // Calldata is built in scratch space: 4 selector bytes, then the id left-aligned in its
            // word with the low 16 bytes cleared, as the ABI encodes a bytes16.
            mstore(0x00, LATEST_SELECTOR)
            mstore(0x04, and(jobId, shl(128, 0xffffffffffffffffffffffffffffffff)))
            // At most 32 bytes are copied back, so a huge answer cannot be made to cost memory. The
            // answer counts only when the call succeeded and returned exactly one word. The size is
            // read in a statement of its own: Yul evaluates arguments right to left, so folding it
            // into the line above would read the size before the call was made.
            ok := staticcall(REGISTRY_GAS, registry, 0x00, 0x24, 0x00, 0x20)
            ok := and(ok, eq(returndatasize(), 0x20))
            expected := mload(0x00)
        }
        if (!ok || expected == bytes32(0)) revert NoReceipt(jobId);
    }

    /// @dev Parses `record` and builds the proof around the given record hash.
    function _read(bytes memory record, bytes32 recordHash, uint256 headLen)
        private
        pure
        returns (bytes16 jobId, Proof memory proof)
    {
        JsonScan.Spans memory s = JsonScan.scan(record);
        if (headLen > s.objectiveLen) revert HeadTooLong();

        jobId = s.jobId;
        proof.recordHash = recordHash;
        proof.kindHash = _hash(s.kindPtr, s.kindLen);
        proof.headHash = _hash(s.objectivePtr, headLen);
        unchecked {
            // `headLen <= objectiveLen` was checked above.
            proof.specHash = _hash(s.objectivePtr + headLen, s.objectiveLen - headLen);
        }
        proof.stateHash = _hash(s.statePtr, s.stateLen);
        proof.agentIds = JsonScan.agentIds(s.signalsPtr, s.signalsLen);
    }

    /// @dev keccak256 of `len` bytes of memory at `ptr`.
    function _hash(uint256 ptr, uint256 len) private pure returns (bytes32 h) {
        assembly ("memory-safe") {
            h := keccak256(ptr, len)
        }
    }

    /// @dev Joins the data contracts' code, minus each leading `0x00`, into one buffer.
    /// The caller pays for every byte copied, so the list needs no cap of its own: a call that names
    /// more code than it can afford to read simply runs out of gas, and nothing is stored either way.
    /// Only the low 20 bytes of each list entry are used as the address, so stray high bits in the
    /// calldata cannot select any other contract.
    function _join(address[] calldata chunks) private view returns (bytes memory record) {
        uint256 n = chunks.length;
        uint256 bad = type(uint256).max;
        assembly ("memory-safe") {
            record := mload(0x40)
            let dst := add(record, 0x20)
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let chunk := shr(96, shl(96, calldataload(add(chunks.offset, shl(5, i)))))
                let size := extcodesize(chunk)
                // The marker byte is read into scratch space; a chunk without code leaves it non-zero.
                mstore(0x00, not(0))
                extcodecopy(chunk, 0x00, 0, lt(0, size))
                if byte(0, mload(0x00)) {
                    bad := i
                    break
                }
                let len := sub(size, 1)
                extcodecopy(chunk, dst, 1, len)
                dst := add(dst, len)
            }
            mstore(record, sub(sub(dst, record), 0x20))
            // Claim the buffer, rounded up to a whole word.
            mstore(0x40, and(add(dst, 0x1f), not(0x1f)))
        }
        if (bad != type(uint256).max) revert BadChunk(bad);
    }
}
