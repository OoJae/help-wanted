// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {ProofFixtures} from "./utils/ProofFixtures.sol";
import {MockRegistry} from "./utils/Registries.sol";

/// @notice Every real work record under `test/fixtures/proof`, read by the contract and compared
/// with values derived outside Solidity. Runs offline against a stand-in registry; the fork suite
/// repeats the proof against the real one.
/// @dev The records are stored as hexadecimal text. The first test hashes what each one decodes to
/// and compares with the hash in the index, which is the hash IdentityMD's API names the record by
/// and the one the WorkRegistry holds, so the stored bytes are the served bytes or the test fails.
contract WorkProofFixturesTest is ProofFixtures {
    WorkProof internal proof;
    MockRegistry internal registry;

    function setUp() public {
        registry = new MockRegistry();
        proof = new WorkProof(address(registry));
    }

    function test_fixtures_coverTheRequiredSpread() public view {
        string memory index = _index();
        uint256 n = _count(index);
        assertGe(n, 6, "at least six fixtures");

        bool sawReference;
        bool sawWalkedToTheEnd;
        bool sawTooLargeForCalldata;
        bool sawBlocked;
        bool sawSuperseded;
        bytes32[] memory kinds = new bytes32[](n);
        uint256 distinctKinds;
        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);
            assertEq(keccak256(f.record), f.recordHash, f.file);
            assertEq(f.record.length > 0 && f.record[f.record.length - 1] == "}", true, "no trailing newline");
            uint256 k = 0;
            while (k < distinctKinds && kinds[k] != f.kindHash) ++k;
            if (k == distinctKinds) kinds[distinctKinds++] = f.kindHash;
            if (f.jobId == REFERENCE_JOB) {
                sawReference = true;
                assertEq(f.recordHash, REFERENCE_RECEIPT, "the receipt quoted in README.md");
            }
            // A large record whose bulk sorts before `state`: the costliest shape to prove.
            if (f.record.length > 70_000 && f.scanStopsAt * 10 > f.record.length * 9) sawWalkedToTheEnd = true;
            // A record that cannot be sent as calldata at all and has to go through data contracts.
            if (f.record.length > 128 * 1024) sawTooLargeForCalldata = true;
            if (keccak256(bytes(f.state)) == keccak256("blocked")) sawBlocked = true;
            if (!f.isLatest) sawSuperseded = true;
            // What the index calls the latest receipt is the record itself, unless it was superseded.
            assertEq(f.isLatest, f.onChainLatest == f.recordHash, f.file);
        }
        assertTrue(sawReference, "reference job");
        assertTrue(sawWalkedToTheEnd, "a large record walked nearly to its end");
        assertTrue(sawTooLargeForCalldata, "a record above 128 KB");
        assertTrue(sawBlocked, "a job that did not complete");
        assertTrue(sawSuperseded, "a superseded receipt");
        // Records of eighteen job templates are stored. The other two kinds seen on chain
        // (multi_contract and skill:adversarial-review) were seen only in records of 31 and 43 KB
        // that show nothing a stored record does not; the index lists them under `observed` with
        // their hashes (see `selection` there, and the test below).
        assertEq(distinctKinds, 18, "the stored records cover eighteen kinds");
    }

    /// The kind table the hire desk works from: every kind string seen in a work record, stored or
    /// not, is in the index with the hash an order pins for it.
    function test_fixtures_theIndexListsEveryKindObserved() public view {
        string memory index = _index();
        uint256 n = vm.parseJsonUint(index, ".observedCount");
        assertEq(n, 41);
        bytes32[] memory kinds = new bytes32[](n);
        uint256 distinct;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 kind =
                keccak256(bytes(vm.parseJsonString(index, string.concat(".observed[", vm.toString(i), "].kind"))));
            uint256 k = 0;
            while (k < distinct && kinds[k] != kind) ++k;
            if (k == distinct) kinds[distinct++] = kind;
        }
        assertEq(distinct, 20, "twenty kinds observed");
    }

    function test_fixtures_rejectedSubmissionsAreNotNamed() public view {
        // Two real records carry signals for submissions that verification rejected (`value` 0).
        // The expected lists are written out here, not read from the index.
        string memory index = _index();
        uint256 n = _count(index);
        uint256 found;
        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);
            if (f.jobId == 0x8a5d5e50f9724a86ab691442ed0cc957) {
                // Completed. Agent 51746's first attempt was rejected; agent 51620's was accepted.
                (, IWorkProof.Proof memory p) = proof.scan(f.record, 0);
                assertEq(p.stateHash, keccak256("completed"));
                assertEq(p.agentIds.length, 1, "only the accepted agent");
                assertEq(p.agentIds[0], 51620);
                ++found;
            } else if (f.jobId == 0x1199a0441d254b47ae2aaddf0b8ae2de) {
                // Blocked. Six signals; 51091 and 51006 were rejected.
                (, IWorkProof.Proof memory p) = proof.scan(f.record, 0);
                uint256[4] memory accepted = [uint256(51436), 51001, 51434, 51195];
                assertEq(p.agentIds.length, accepted.length);
                for (uint256 k = 0; k < accepted.length; ++k) {
                    assertEq(p.agentIds[k], accepted[k]);
                }
                assertEq(_occurrences(f.record, '"agentId":"51091"'), 1, "the rejected agent is in the record");
                assertEq(_occurrences(f.record, '"agentId":"51006"'), 1, "the rejected agent is in the record");
                ++found;
            }
        }
        assertEq(found, 2, "both records are among the fixtures");
    }

    /// A real record in which one agent has two signals (the first receipt of job 261869d7): the
    /// proof names that agent once. The count of signals is taken from the record's own bytes.
    function test_fixtures_anAgentNamedInTwoSignalsIsNamedOnce() public view {
        string memory index = _index();
        uint256 n = _count(index);
        bool found;
        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);
            if (f.recordHash != 0x96c17e09284ace5cfccd4898888e239377959d46750cb914ca93518be4b5ecdc) continue;
            assertEq(_occurrences(f.record, '"agentId":"51028"'), 2, "two signals name agent 51028");
            assertEq(_occurrences(f.record, '"agentId":"'), 2, "and the record has no other signal");
            (, IWorkProof.Proof memory p) = proof.scan(f.record, 0);
            assertEq(p.agentIds.length, 1, "named once");
            assertEq(p.agentIds[0], 51028);
            found = true;
        }
        assertTrue(found, "the record is among the fixtures");
    }

    /// @dev How many times `needle` occurs in `haystack`.
    function _occurrences(bytes memory haystack, bytes memory needle) internal pure returns (uint256 count) {
        uint256 m = needle.length;
        if (haystack.length < m) return 0;
        bytes32 want = keccak256(needle);
        bytes1 first = needle[0];
        for (uint256 i = 0; i + m <= haystack.length; ++i) {
            if (haystack[i] == first && _sliceHash(haystack, i, m) == want) ++count;
        }
    }

    function test_scan_everyFixtureMatchesTheIndex() public view {
        string memory index = _index();
        uint256 n = _count(index);
        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);

            (bytes16 jobId, IWorkProof.Proof memory p) = proof.scan(f.record, 0);
            assertEq(jobId, f.jobId, f.file);
            assertEq(p.recordHash, f.recordHash, f.file);
            assertEq(p.kindHash, f.kindHash, f.file);
            assertEq(p.kindHash, keccak256(bytes(f.kind)), f.file);
            assertEq(p.stateHash, f.stateHash, f.file);
            assertEq(p.stateHash, keccak256(bytes(f.state)), f.file);
            assertEq(p.headHash, keccak256(""), f.file);
            assertEq(p.specHash, f.objectiveHash, f.file);
            assertEq(p.agentIds, f.agentIds, f.file);
        }
    }

    function test_scan_splitsTheObjectiveAtAnyHeadLen() public {
        string memory index = _index();
        uint256 n = _count(index);
        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);
            uint256 len = f.objectiveRawLen;
            assertEq(_sliceHash(f.record, f.objectiveStart, len), f.objectiveHash, "the index locates the objective");

            uint256[4] memory cuts = [uint256(1), 85, len / 2, len];
            for (uint256 c = 0; c < cuts.length; ++c) {
                uint256 headLen = cuts[c] > len ? len : cuts[c];
                (, IWorkProof.Proof memory p) = proof.scan(f.record, headLen);
                assertEq(p.headHash, _sliceHash(f.record, f.objectiveStart, headLen), f.file);
                assertEq(p.specHash, _sliceHash(f.record, f.objectiveStart + headLen, len - headLen), f.file);
            }

            vm.expectRevert(IWorkProof.HeadTooLong.selector);
            proof.scan(f.record, len + 1);
        }
    }

    function test_prove_everyFixtureAgainstItsReceipt() public {
        string memory index = _index();
        uint256 n = _count(index);
        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);
            registry.set(f.jobId, f.recordHash);

            IWorkProof.Proof memory p = proof.prove(f.jobId, f.record, 0);
            (, IWorkProof.Proof memory scanned) = proof.scan(f.record, 0);
            assertEq(abi.encode(p), abi.encode(scanned), f.file);
            assertEq(p.recordHash, f.recordHash, f.file);
            assertEq(p.agentIds, f.agentIds, f.file);
        }
    }

    function test_prove_oneChangedByteFailsForEveryFixture() public {
        string memory index = _index();
        uint256 n = _count(index);
        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);
            registry.set(f.jobId, f.recordHash);

            // One byte inside the objective, one in the part the scanner never reads, and the last.
            uint256[3] memory at =
                [f.objectiveStart, f.scanStopsAt + (f.record.length - f.scanStopsAt) / 2, f.record.length - 1];
            for (uint256 k = 0; k < at.length; ++k) {
                bytes memory changed = bytes.concat(f.record);
                changed[at[k]] = bytes1(uint8(changed[at[k]]) ^ 0x01);
                vm.expectRevert(
                    abi.encodeWithSelector(IWorkProof.HashMismatch.selector, f.recordHash, keccak256(changed))
                );
                proof.prove(f.jobId, changed, 0);
            }
        }
    }

    function test_prove_supersededReceiptStopsProving() public {
        string memory index = _index();
        uint256 n = _count(index);
        uint256 pairs;
        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);
            if (f.isLatest) continue;
            ++pairs;
            // The registry as it stands on chain: it holds the later receipt for this job.
            registry.set(f.jobId, f.onChainLatest);
            vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, f.onChainLatest, f.recordHash));
            proof.prove(f.jobId, f.record, 0);
        }
        assertGe(pairs, 1, "at least one superseded receipt among the fixtures");
    }

    function test_referenceJob_readsAsTheReadmeDescribes() public {
        Fixture memory f = _reference();
        registry.set(REFERENCE_JOB, REFERENCE_RECEIPT);
        IWorkProof.Proof memory p = proof.prove(REFERENCE_JOB, f.record, 0);
        assertEq(p.recordHash, REFERENCE_RECEIPT);
        assertEq(p.kindHash, keccak256("skill:research-report"));
        assertEq(p.stateHash, keccak256("completed"));
        assertEq(p.agentIds.length, 1);
        assertEq(p.agentIds[0], 52211);
        // The objective starts with the text the job was opened with.
        bytes memory opening = "Design a ";
        (, IWorkProof.Proof memory split) = proof.scan(f.record, opening.length);
        assertEq(split.headHash, keccak256(opening));
    }
}
