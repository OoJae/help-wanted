// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {Rec} from "./utils/Rec.sol";
import {RecordGen} from "./utils/RecordGen.sol";
import {ReferenceScanner} from "./utils/ReferenceScanner.sol";
import {ProofFixtures} from "./utils/ProofFixtures.sol";

/// @notice Differential tests of the scanner.
///
/// Against the writer: random canonical records, stuffed with decoy members and decoy order headers
/// inside strings and nested values, must be read back exactly as the writer wrote them.
///
/// Against a second reader: the same records, and real ones, after random damage must get the same
/// verdict, down to the error and its position, from the scanner and from a plain byte-at-a-time
/// implementation that shares no code with it.
contract JsonScanFuzzTest is RecordGen, ProofFixtures {
    WorkProof internal proof;
    ReferenceScanner internal ref;

    function setUp() public {
        proof = new WorkProof(address(0xdead));
        ref = new ReferenceScanner();
    }

    function testFuzz_scan_readsBackWhatTheWriterWrote(uint256 seed) public view {
        Truth memory t = _generate(seed);
        uint256 headLen = seed % (t.objectiveRaw.length + 1);

        (bytes16 jobId, IWorkProof.Proof memory p) = proof.scan(t.record, headLen);

        assertEq(jobId, t.jobId, "jobId");
        assertEq(p.recordHash, keccak256(t.record), "recordHash");
        assertEq(p.kindHash, keccak256(t.kindRaw), "kindHash");
        assertEq(p.stateHash, keccak256(t.stateRaw), "stateHash");
        assertEq(p.headHash, _sliceHash(t.objectiveRaw, 0, headLen), "headHash");
        assertEq(p.specHash, _sliceHash(t.objectiveRaw, headLen, t.objectiveRaw.length - headLen), "specHash");
        assertEq(p.agentIds, t.agentIds, "agentIds");
    }

    function testFuzz_scan_headLenPastTheObjectiveReverts(uint256 seed, uint256 excess) public {
        Truth memory t = _generate(seed);
        excess = bound(excess, 1, type(uint128).max);
        vm.expectRevert(IWorkProof.HeadTooLong.selector);
        proof.scan(t.record, t.objectiveRaw.length + excess);
    }

    function testFuzz_scan_agreesWithTheReferenceOnGeneratedRecords(uint256 seed) public view {
        Truth memory t = _generate(seed);
        _assertSameVerdict(t.record, seed % (t.objectiveRaw.length + 2));
    }

    function testFuzz_scan_agreesWithTheReferenceOnDamagedRecords(uint256 seed) public view {
        Truth memory t = _generate(seed);
        Rng memory rng = Rng(~seed);
        bytes memory damaged = _damage(rng, t.record, 1 + _below(rng, 3));
        _assertSameVerdict(damaged, _below(rng, t.objectiveRaw.length + 2));
    }

    function testFuzz_scan_agreesWithTheReferenceOnDamagedRealRecords(uint256 seed) public view {
        // The reference job's record is small enough to damage and rescan a few hundred times.
        Fixture memory f = _reference();
        Rng memory rng = Rng(seed);
        // Aim most of the damage at the part the scanner actually walks.
        bytes memory damaged = f.record;
        uint256 hits = 1 + _below(rng, 2);
        for (uint256 i = 0; i < hits; ++i) {
            uint256 span = _below(rng, 4) == 0 ? damaged.length : f.scanStopsAt;
            damaged = _damageAt(rng, damaged, _below(rng, span));
        }
        _assertSameVerdict(damaged, _below(rng, 100));
    }

    function testFuzz_scan_agreesWithTheReferenceOnEveryPrefix(uint256 seed, uint256 cut) public view {
        Truth memory t = _generate(seed);
        cut = bound(cut, 0, t.record.length);
        bytes memory prefix = new bytes(cut);
        for (uint256 i = 0; i < cut; ++i) {
            prefix[i] = t.record[i];
        }
        _assertSameVerdict(prefix, 0);
    }

    /// @dev Text that is mostly quotation marks and backslashes, properly escaped, in a top-level
    /// string, in nested strings and inside `signals`: every string must be read to its real end.
    /// This is the input the look-ahead after an escaped quote exists for, at whatever lengths and
    /// alignments the fuzzer picks.
    function testFuzz_scan_readsQuoteHeavyTextToItsRealEnd(uint256 seed) public view {
        Rng memory rng = Rng(seed);
        bytes memory objective = _quoteHeavy(rng, 300);
        bytes memory nested = _quoteHeavy(rng, 120);
        bytes memory inSignals = _quoteHeavy(rng, 80);
        Rec.Parts memory p = Rec.parts();
        p.head = string(abi.encodePacked('"identity":{"a":"', nested, '","b":["', inSignals, '"]},'));
        p.objective = string(abi.encodePacked('"', objective, '"'));
        p.signals = string(abi.encodePacked('[{"agentId":"5","nodeKey":"', inSignals, '","value":1}]'));
        p.state = '"blocked"';
        bytes memory record = Rec.build(p);

        uint256 headLen = _below(rng, objective.length + 1);
        (bytes16 jobId, IWorkProof.Proof memory out) = proof.scan(record, headLen);
        assertEq(jobId, Rec.JOB, "jobId");
        assertEq(out.headHash, _sliceHash(objective, 0, headLen), "headHash");
        assertEq(out.specHash, _sliceHash(objective, headLen, objective.length - headLen), "specHash");
        assertEq(out.stateHash, keccak256("blocked"), "stateHash");
        assertEq(out.agentIds.length, 1, "agentIds");
        assertEq(out.agentIds[0], 5, "agentIds");
        _assertSameVerdict(record, headLen);
    }

    /// @dev The same alphabet in no valid arrangement: bare quotes, lone backslashes, brackets. The
    /// record is then whatever it is, and both readers must say the same of it.
    function testFuzz_scan_agreesWithTheReferenceOnQuoteAndBackslashSoup(uint256 seed) public view {
        Rng memory rng = Rng(seed);
        Rec.Parts memory p = Rec.parts();
        p.head = string(abi.encodePacked('"identity":{"a":"', _soup(rng, 70), '"},'));
        p.kind = string(abi.encodePacked('"', _soup(rng, 70), '"'));
        p.objective = string(abi.encodePacked('"', _soup(rng, 120), '"'));
        p.signals = string(abi.encodePacked('[{"agentId":"5","nodeKey":"', _soup(rng, 70), '","value":0}]'));
        _assertSameVerdict(Rec.build(p), _below(rng, 40));
    }

    /// @dev The fuzz tests above mean little if the generator only ever produces one kind of
    /// record, or if damage only ever produces one kind of failure. This counts what a fixed run of
    /// seeds actually exercises.
    function test_generator_exercisesEveryBranchThatMatters() public view {
        uint256[7] memory seen;
        uint256[4] memory outcomes;
        uint256 seeds = 150;
        for (uint256 seed = 1; seed <= seeds; ++seed) {
            // One external call per seed, so that each sample's memory is released when it returns.
            (uint256 flags, uint256[4] memory verdicts) = this.sample(seed);
            for (uint256 bit = 0; bit < seen.length; ++bit) {
                if (flags & (1 << bit) != 0) ++seen[bit];
            }
            for (uint256 k = 0; k < outcomes.length; ++k) {
                outcomes[k] += verdicts[k];
            }
        }
        console2.log("of 150 records: naming agents, with sixteen agents, with a rejected submission");
        console2.log(seen[0], seen[1], seen[6]);
        console2.log("of 600 damaged copies: accepted, Malformed, MissingKey, WrongSchema");
        console2.log(outcomes[0], outcomes[1], outcomes[2], outcomes[3]);
        assertGt(seen[0], 30, "records naming agents");
        assertGt(seen[1], 0, "records with sixteen or more distinct agents");
        assertGt(seen[2], 30, "objectives holding an escaped quote");
        assertGt(seen[3], 30, "objectives opening with an order header");
        assertGt(seen[4], 10, "strings holding a decoy state member");
        assertGt(seen[5], 10, "nested values with decoy keys");
        assertGt(seen[6], 30, "records holding a rejected submission");
        assertGt(outcomes[0], 60, "damaged records that still parse");
        assertGt(outcomes[1], 60, "damaged records refused as malformed");
        assertGt(outcomes[2], 0, "damaged records refused for a missing key");
        assertEq(
            outcomes[0] + outcomes[1] + outcomes[2] + outcomes[3],
            seeds * DAMAGED_COPIES,
            "every outcome is a declared one"
        );
    }

    /// @dev How many separately damaged copies of each generated record `sample` scans.
    uint256 internal constant DAMAGED_COPIES = 4;

    /// @dev What one seed exercises. `flags` is a bit set (see the test above for the meaning of each
    /// bit). `verdicts` counts, over `DAMAGED_COPIES` copies of the record that each took one hit:
    /// still accepted, `Malformed`, `MissingKey`, `WrongSchema`.
    function sample(uint256 seed) external view returns (uint256 flags, uint256[4] memory verdicts) {
        Truth memory t = _generate(seed);
        if (t.agentIds.length > 0) flags |= 1 << 0;
        if (t.agentIds.length == MAX_AGENTS) flags |= 1 << 1;
        if (_has(t.objectiveRaw, '\\"')) flags |= 1 << 2; // an escaped quote in the objective
        if (_has(t.objectiveRaw, "[help-wanted order ")) flags |= 1 << 3;
        if (_has(t.record, '\\"state\\":')) flags |= 1 << 4; // a decoy member inside a string
        if (_has(t.record, '{"state":') || _has(t.record, '"objective":"[help-wanted')) flags |= 1 << 5;
        // Unescaped, these bytes can only be the end of a real `signals` element.
        if (_has(t.record, ',"value":0}')) flags |= 1 << 6;

        Rng memory rng = Rng(~seed);
        for (uint256 copy = 0; copy < DAMAGED_COPIES; ++copy) {
            bytes memory damaged = _damage(rng, bytes.concat(t.record), 1);
            (bool ok, bytes memory out) = address(proof).staticcall(abi.encodeCall(IWorkProof.scan, (damaged, 0)));
            if (ok) {
                ++verdicts[0];
            } else if (bytes4(out) == IWorkProof.Malformed.selector) {
                ++verdicts[1];
            } else if (bytes4(out) == IWorkProof.MissingKey.selector) {
                ++verdicts[2];
            } else if (bytes4(out) == IWorkProof.WrongSchema.selector) {
                ++verdicts[3];
            }
        }
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Escaped text of up to about `maxLen` bytes in which, depending on the draw, between a
    /// quarter and four fifths of the characters are quotation marks, with backslashes among them.
    function _quoteHeavy(Rng memory rng, uint256 maxLen) internal pure returns (bytes memory out) {
        uint256 target = _below(rng, maxLen + 1);
        uint256 density = 4 + 3 * _below(rng, 4);
        while (out.length < target) {
            uint256 roll = _below(rng, 16);
            if (roll < density) {
                out = abi.encodePacked(out, '\\"'); // a quotation mark, as the writer escapes it
            } else if (roll < density + 2) {
                out = abi.encodePacked(out, "\\\\"); // a backslash, likewise
            } else if (roll == 15) {
                out = abi.encodePacked(out, "\\n");
            } else {
                out = abi.encodePacked(out, bytes1(uint8(0x61 + _below(rng, 26))));
            }
        }
    }

    /// @dev Up to `maxLen` raw bytes: quotes (most of them behind a backslash or several),
    /// backslashes, letters and a few brackets, with no care for what they add up to.
    function _soup(Rng memory rng, uint256 maxLen) internal pure returns (bytes memory out) {
        uint256 len = _below(rng, maxLen + 1);
        out = new bytes(len);
        bytes memory alphabet = '"\\\\\\xx]}';
        for (uint256 i = 0; i < len; ++i) {
            out[i] = alphabet[_below(rng, alphabet.length)];
            // Four quotes in five get a backslash in front of them, so strings run on for a while.
            if (out[i] == '"' && i > 0 && _below(rng, 5) != 0) out[i - 1] = "\\";
        }
    }

    /// @dev Whether `needle` (not empty) occurs in `haystack`.
    function _has(bytes memory haystack, bytes memory needle) internal pure returns (bool found) {
        uint256 n = needle.length;
        if (n > haystack.length) return false;
        bytes32 want = keccak256(needle);
        assembly ("memory-safe") {
            let first := byte(0, mload(add(needle, 0x20)))
            let at := add(haystack, 0x20)
            let last := sub(add(at, mload(haystack)), n)
            for {} iszero(gt(at, last)) { at := add(at, 1) } {
                if eq(byte(0, mload(at)), first) {
                    if eq(keccak256(at, n), want) {
                        found := 1
                        break
                    }
                }
            }
        }
    }

    /// @dev Both readers must return the same data, or revert with the same data.
    function _assertSameVerdict(bytes memory record, uint256 headLen) internal view {
        bytes memory call = abi.encodeCall(IWorkProof.scan, (record, headLen));
        (bool okA, bytes memory outA) = address(proof).staticcall(call);
        (bool okB, bytes memory outB) = address(ref).staticcall(call);
        assertEq(okA, okB, "one reader accepted what the other refused");
        assertEq(outA, outB, "the readers disagree");
        // Neither may fail in a way that is not one of the declared errors.
        if (!okA) assertTrue(_isDeclaredError(outA), "undeclared failure");
    }

    function _isDeclaredError(bytes memory data) internal pure returns (bool) {
        if (data.length < 4) return false;
        bytes4 selector = bytes4(data);
        return selector == IWorkProof.Malformed.selector || selector == IWorkProof.MissingKey.selector
            || selector == IWorkProof.WrongSchema.selector || selector == IWorkProof.HeadTooLong.selector;
    }

    function _damage(Rng memory rng, bytes memory data, uint256 hits) internal pure returns (bytes memory) {
        for (uint256 i = 0; i < hits && data.length > 0; ++i) {
            data = _damageAt(rng, data, _below(rng, data.length));
        }
        return data;
    }

    /// @dev One edit at `at`: overwrite, delete, insert, truncate, or repeat a stretch.
    function _damageAt(Rng memory rng, bytes memory data, uint256 at) internal pure returns (bytes memory) {
        if (data.length == 0) return data;
        at = at % data.length;
        uint256 kind = _below(rng, 10);
        bytes1 b = _troublesomeByte(rng);
        if (kind < 4) {
            data[at] = b;
            return data;
        }
        if (kind < 6) return abi.encodePacked(_cut(data, 0, at), _cut(data, at + 1, data.length - at - 1));
        if (kind < 8) return abi.encodePacked(_cut(data, 0, at), b, _cut(data, at, data.length - at));
        if (kind == 8) return _cut(data, 0, at);
        uint256 len = 1 + _below(rng, 40);
        if (at + len > data.length) len = data.length - at;
        return abi.encodePacked(_cut(data, 0, at + len), _cut(data, at, data.length - at));
    }

    function _troublesomeByte(Rng memory rng) internal pure returns (bytes1) {
        bytes memory set = '"\\{}[],: \n0a\x00\x7f\x80\xff';
        if (_below(rng, 4) == 0) return bytes1(uint8(_below(rng, 256)));
        return set[_below(rng, set.length)];
    }

    function _cut(bytes memory data, uint256 from, uint256 len) internal pure returns (bytes memory out) {
        require(from + len <= data.length, "cut out of range");
        out = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(add(data, 0x20), from), len)
        }
    }
}
