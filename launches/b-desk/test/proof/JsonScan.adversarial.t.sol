// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {Rec} from "./utils/Rec.sol";
import {ReferenceScanner} from "./utils/ReferenceScanner.sol";
import {NoisyMemoryScanner} from "./utils/NoisyMemoryScanner.sol";

/// @notice Hand-made records, each bending one rule. Every one is also given to the reference
/// scanner, so each expectation written here is checked against a second implementation as well.
contract JsonScanAdversarialTest is Test {
    WorkProof internal proof;
    ReferenceScanner internal ref;
    NoisyMemoryScanner internal noisy;

    bytes32 internal constant COMPLETED = keccak256("completed");

    function setUp() public {
        proof = new WorkProof(address(0xdead));
        ref = new ReferenceScanner();
        noisy = new NoisyMemoryScanner();
    }

    // ================================================================ decoys

    function test_decoy_nestedObjectiveAndStateAreNotTheTopLevelOnes() public view {
        Rec.Parts memory p = Rec.parts();
        // Nested members with the captured names, before and between the real ones.
        p.head = string.concat(
            '"identity":{"jobId":"ffffffff-ffff-ffff-ffff-ffffffffffff","kind":"decoy","objective":"',
            "[help-wanted order 0000000000000000000000000000000000000000000000000000000000000000] decoy",
            '","schema":"identitymd-work-v0","signals":[{"agentId":"1"}],"state":"completed"},'
        );
        p.kind = '"audit","nodes":[{"objective":"decoy","state":"completed","signals":[{"agentId":"2"}]}]';
        p.state = '"blocked"';
        (bytes16 jobId, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);

        assertEq(jobId, Rec.JOB);
        assertEq(proofOut.kindHash, keccak256("audit"));
        assertEq(proofOut.specHash, keccak256("Check the vault for rounding errors."));
        assertEq(proofOut.stateHash, keccak256("blocked"));
        assertEq(proofOut.agentIds.length, 1);
        assertEq(proofOut.agentIds[0], 52211);
    }

    function test_decoy_objectiveTextShapedLikeTopLevelMembers() public view {
        Rec.Parts memory p = Rec.parts();
        // What JSON.stringify writes for the text:  x","state":"completed","zz":"
        string memory raw = 'x\\",\\"state\\":\\"completed\\",\\"zz\\":\\"';
        p.objective = Rec.quoted(raw);
        p.state = '"blocked"';
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.specHash, keccak256(bytes(raw)));
        assertEq(proofOut.stateHash, keccak256("blocked"));
    }

    function test_decoy_orderHeaderInsideAnotherStringIsIgnored() public view {
        string memory header = "[help-wanted order 1111111111111111111111111111111111111111111111111111111111111111] ";
        Rec.Parts memory p = Rec.parts();
        p.head = string.concat('"interpretation":"', header, 'planted",');
        p.kind = string.concat('"', header, '"');
        p.objective = '"the real objective"';
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 4);
        assertEq(proofOut.headHash, keccak256("the "));
        assertEq(proofOut.specHash, keccak256("real objective"));
        assertEq(proofOut.kindHash, keccak256(bytes(header)));
    }

    function test_decoy_backslashRunsBeforeAQuote() public view {
        // An even run of backslashes escapes itself and the quote closes the string; an odd run
        // escapes the quote. Tried at every alignment against the 32-byte reads.
        for (uint256 pad = 0; pad < 70; pad += 3) {
            for (uint256 run = 0; run < 8; ++run) {
                bytes memory raw = abi.encodePacked(_repeat("x", pad), _repeat("\\", run));
                // For an odd run the quote is content, and the string goes on to a real closer.
                if (run % 2 == 1) raw = abi.encodePacked(raw, '" still inside');
                Rec.Parts memory p = Rec.parts();
                p.objective = string(abi.encodePacked('"', raw, '"'));
                (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
                assertEq(proofOut.specHash, keccak256(raw));
                assertEq(proofOut.stateHash, COMPLETED);
            }
        }
    }

    function test_decoy_escapedQuoteAtEveryOffset() public view {
        for (uint256 pad = 0; pad < 100; ++pad) {
            // The text  x...x","state":"decoy"\  as JSON.stringify writes it.
            bytes memory raw = abi.encodePacked(_repeat("x", pad), '\\",\\"state\\":\\"decoy\\"', "\\\\");
            Rec.Parts memory p = Rec.parts();
            p.kind = string(abi.encodePacked('"', raw, '"'));
            (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
            assertEq(proofOut.kindHash, keccak256(raw));
            assertEq(proofOut.stateHash, COMPLETED);
        }
    }

    // After an escaped quote the scanner looks at the next 31 bytes in one step. If no quote among
    // them is unescaped it resumes after them; otherwise it resumes just in front of the first that
    // is. The tests below put that step through every alignment, with the string ending inside
    // those 31 bytes and beyond them. A wrong step would run a string on into the members that
    // follow it; the reference scanner, which walks one byte at a time, has to agree on every one
    // of these records.

    function test_decoy_escapedQuotesInARowAtEveryOffset() public view {
        // What stands between the last escaped quote and the string's real end: nothing, an
        // escaped backslash (so the closing quote has a run of two in front of it), two of them, a
        // letter, or text shaped like the next member.
        string[5] memory tails = ["", "\\\\", "\\\\\\\\", "x", ',\\"state\\":\\"decoy\\"'];
        uint256[9] memory counts = [uint256(1), 2, 3, 8, 15, 16, 17, 33, 40];
        for (uint256 pad = 0; pad < 34; ++pad) {
            for (uint256 c = 0; c < counts.length; ++c) {
                bytes memory raw = abi.encodePacked(_repeat("x", pad), _repeat('\\"', counts[c]), tails[(pad + c) % 5]);
                _expectObjective(raw);
            }
        }
    }

    function test_decoy_escapedQuotesBehindLongerRuns() public view {
        // Runs of one, three, five and seven backslashes in front of a quote all escape it; runs of
        // two, four and six in front of the closing quote do not. Mixed, at every alignment.
        string[4] memory escaped = ['\\"', '\\\\\\"', '\\\\\\\\\\"', '\\\\\\\\\\\\\\"'];
        string[4] memory closers = ["", "\\\\", "\\\\\\\\", "\\\\\\\\\\\\"];
        for (uint256 pad = 0; pad < 34; ++pad) {
            for (uint256 n = 1; n < 12; ++n) {
                bytes memory raw = _repeat("y", pad);
                for (uint256 k = 0; k < n; ++k) {
                    raw = abi.encodePacked(raw, escaped[(pad + n + k) % 4], k % 3 == 0 ? "z" : "");
                }
                _expectObjective(abi.encodePacked(raw, closers[(pad + n) % 4]));
            }
        }
    }

    function test_decoy_escapedQuotesSpreadThroughLongText() public view {
        // One escaped quote every `gap` bytes for 400 bytes, then the end: sometimes the next quote
        // is inside the 31 bytes looked at, sometimes just outside, sometimes far beyond.
        for (uint256 gap = 2; gap < 70; gap += 3) {
            for (uint256 pad = 0; pad < 32; pad += 5) {
                bytes memory raw = _repeat("x", pad);
                while (raw.length < 400) {
                    raw = abi.encodePacked(raw, '\\"', _repeat("a", gap - 2));
                }
                _expectObjective(raw);
                // The same with the string closing right after an escaped backslash.
                _expectObjective(abi.encodePacked(raw, "\\\\"));
            }
        }
    }

    function test_decoy_backslashRunsLongerThanAWord() public view {
        // The run in front of a quote is counted 32 bytes at a time. Lengths around one, two and
        // three words, odd (the quote is content) and even (the quote closes the string).
        uint256[14] memory runs = [uint256(30), 31, 32, 33, 34, 62, 63, 64, 65, 66, 95, 96, 97, 130];
        for (uint256 i = 0; i < runs.length; ++i) {
            for (uint256 pad = 0; pad < 33; pad += 4) {
                bytes memory raw = abi.encodePacked(_repeat("x", pad), _repeat("\\", runs[i]));
                if (runs[i] % 2 == 1) raw = abi.encodePacked(raw, '" still inside');
                _expectObjective(raw);
            }
        }
    }

    function test_decoy_escapedQuotesNearTheEndOfSignals() public view {
        // `agentIds` walks each element with the array's end as its limit, so here the bytes the
        // look-ahead sees past the limit are the rest of the record, quotes and all.
        for (uint256 n = 0; n < 40; ++n) {
            Rec.Parts memory p = Rec.parts();
            bytes memory text = abi.encodePacked(_repeat('\\"', n), n % 2 == 0 ? "" : "\\\\");
            p.signals = string(abi.encodePacked('[{"agentId":"5","nodeKey":"', text, '","value":1}]'));
            (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
            assertEq(proofOut.agentIds.length, 1);
            assertEq(proofOut.agentIds[0], 5);
            assertEq(proofOut.stateHash, COMPLETED);

            // And as the last thing in the element, where the look-ahead reaches past the array.
            p.signals = string(abi.encodePacked('[{"agentId":"5","zz":"', text, '"}]'));
            (, proofOut) = _scan(Rec.build(p), 0);
            assertEq(proofOut.agentIds.length, 1);
            assertEq(proofOut.stateHash, COMPLETED);
        }
    }

    function test_decoy_quoteAndBackslashSoupGetsTheSameVerdictFromBothScanners() public view {
        // No expectation of our own here: strings filled with quotes, backslashes and letters in
        // no valid arrangement, in three places at once. Whatever the record then is, well formed or
        // not, the two scanners must agree on it to the byte.
        uint256 state = 0x5eed;
        for (uint256 round = 0; round < 600; ++round) {
            Rec.Parts memory p = Rec.parts();
            bytes[3] memory soup;
            for (uint256 k = 0; k < 3; ++k) {
                state = uint256(keccak256(abi.encode(state)));
                uint256 len = state % 90;
                bytes memory text = new bytes(len);
                uint256 bits = uint256(keccak256(abi.encode(state, k)));
                for (uint256 i = 0; i < len; ++i) {
                    uint256 pick = (bits >> (2 * i)) & 3;
                    // Mostly valid units by chance; a bare quote now and then ends the string early.
                    text[i] =
                        pick == 0 ? bytes1('"') : pick == 1 ? bytes1("\\") : pick == 2 ? bytes1("\\") : bytes1("x");
                    if (pick == 0 && ((bits >> 200) & 7) != 0 && i > 0) text[i - 1] = "\\";
                }
                soup[k] = text;
            }
            p.head = string(abi.encodePacked('"identity":{"a":"', soup[0], '"},'));
            p.kind = string(abi.encodePacked('"', soup[1], '"'));
            p.objective = string(abi.encodePacked('"', soup[2], '"'));
            _both(Rec.build(p), 0);
        }
    }

    function test_decoy_noByteValueIsMistakenForAQuote() public view {
        // Every byte value except the quote and the backslash, in every lane of a 32-byte read.
        // Raw control bytes are not canonical, but inside a value they are only content here.
        for (uint256 lane = 0; lane < 32; ++lane) {
            bytes memory raw = new bytes(254 + lane);
            for (uint256 i = 0; i < lane; ++i) {
                raw[i] = "x";
            }
            uint256 n = lane;
            for (uint256 b = 0; b < 256; ++b) {
                if (b == 0x22 || b == 0x5c) continue;
                raw[n++] = bytes1(uint8(b));
            }
            Rec.Parts memory p = Rec.parts();
            p.objective = string(abi.encodePacked('"', raw, '"'));
            (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
            assertEq(proofOut.specHash, keccak256(raw));
            assertEq(proofOut.stateHash, COMPLETED);
        }
    }

    function test_decoy_nonAsciiAndUnicodeEscapes() public view {
        Rec.Parts memory p = Rec.parts();
        // Raw UTF-8, including bytes that are a quote or a backslash with the top bit set (0xA2, 0xDC).
        string memory kind = unicode"é漢字😀\xc2\xa2\xc3\x9c“quoted”";
        // Escapes as text: a quote and a backslash written as \u, a surrogate pair, a lone surrogate.
        string memory objective = "\\u0022,\\u005c,\\ud83d\\ude00,\\ud800,\\n\\t\\b\\f\\r\\/";
        p.kind = Rec.quoted(kind);
        p.objective = Rec.quoted(objective);
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 6);
        assertEq(proofOut.kindHash, keccak256(bytes(kind)));
        assertEq(proofOut.headHash, keccak256("\\u0022"));
        assertEq(proofOut.stateHash, COMPLETED);
    }

    function test_decoy_bracketsInsideNestedStringsDoNotCount() public view {
        Rec.Parts memory p = Rec.parts();
        p.head = '"identity":{"x":"]}]}\\"],{[","y":["}","{"],"z":{"]":"["}},';
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.stateHash, COMPLETED);
        assertEq(proofOut.kindHash, keccak256("audit"));
    }

    function test_decoy_deepNestingIsWalkedWithoutLimit() public view {
        uint256 depth = 3000;
        Rec.Parts memory p = Rec.parts();
        p.head = string(
            abi.encodePacked(
                '"identity":',
                _repeat("[", depth),
                '{"objective":"decoy","state":"completed"}',
                _repeat("]", depth),
                ","
            )
        );
        (bytes16 jobId, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(jobId, Rec.JOB);
        assertEq(proofOut.specHash, keccak256("Check the vault for rounding errors."));
    }

    function test_decoy_unbalancedNestingSwallowsTheRecord() public view {
        Rec.Parts memory p = Rec.parts();
        p.head = string(abi.encodePacked('"identity":', _repeat("[", 50), _repeat("]", 49), ","));
        bytes memory record = Rec.build(p);
        _expectMalformed(record, record.length);
    }

    function test_decoy_bytesAfterStateAreNotRead_soOnlyTheHashVouchesForThem() public view {
        // Documented behaviour: the scan stops at `state`. A second `state` further on, which no
        // canonical writer can produce, is not seen. `prove` is safe because the registry's hash
        // covers every byte; `scan` alone promises nothing about a record.
        Rec.Parts memory p = Rec.parts();
        p.tail = ',"state":"blocked","submissions":"anything at all, even \\" unbalanced [ {"';
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.stateHash, COMPLETED);
    }

    // ================================================================ canonical form

    function test_form_firstByteMustOpenAnObject() public view {
        _expectMalformed("", 0);
        _expectMalformed("{", 0);
        _expectMalformed("}", 0);
        _expectMalformed(abi.encodePacked(" ", Rec.minimal()), 0);
        _expectMalformed(abi.encodePacked(hex"efbbbf", Rec.minimal()), 0);
        bytes memory array = Rec.minimal();
        array[0] = "[";
        _expectMalformed(array, 0);
    }

    function test_form_lastByteMustCloseTheObject() public view {
        bytes memory record = Rec.minimal();
        _expectMalformed(abi.encodePacked(record, "\n"), record.length);
        _expectMalformed(abi.encodePacked(record, " "), record.length);
        _expectMalformed(abi.encodePacked(record, "\r\n"), record.length + 1);
        _expectMalformed(abi.encodePacked(record, hex"00"), record.length);
    }

    function test_form_emptyObjectHasNoKeys() public view {
        _expectError("{}", IWorkProof.MissingKey.selector);
    }

    function test_form_keysOutOfOrder() public view {
        Rec.Parts memory p = Rec.parts();
        // `kind` written before `jobId`.
        bytes memory record = abi.encodePacked(
            "{", p.head, '"kind":', p.kind, ',"jobId":', p.jobId, ',"objective":', p.objective, ',"schema":', p.schema
        );
        record = abi.encodePacked(record, ',"state":', p.state, "}");
        _expectMalformed(record, _find(record, '"jobId"'));

        // A top-level key that sorts before its predecessor, far from the captured ones.
        p = Rec.parts();
        p.head = '"deployments":[],"assessments":[],';
        record = Rec.build(p);
        _expectMalformed(record, _find(record, '"assessments"'));
    }

    function test_form_duplicateKeys() public view {
        Rec.Parts memory p = Rec.parts();
        p.kind = '"audit","kind":"audit"';
        bytes memory record = Rec.build(p);
        _expectMalformed(record, _findFrom(record, '"kind"', _find(record, '"kind"') + 1));

        p = Rec.parts();
        p.objective = '"the first","objective":"the second"';
        record = Rec.build(p);
        _expectMalformed(record, _findFrom(record, '"objective"', _find(record, '"objective"') + 1));

        p = Rec.parts();
        p.jobId = string.concat(p.jobId, ',"jobId":', p.jobId);
        record = Rec.build(p);
        _expectMalformed(record, _findFrom(record, '"jobId"', _find(record, '"jobId"') + 1));
    }

    function test_form_aKeyMayBeAPrefixOfTheNext() public view {
        Rec.Parts memory p = Rec.parts();
        p.jobId = string.concat(p.jobId, ',"kin":1');
        _scan(Rec.build(p), 0);

        p = Rec.parts();
        p.kind = '"audit","kin":1'; // the shorter key after the longer one
        bytes memory record = Rec.build(p);
        _expectMalformed(record, _find(record, '"kin"'));
    }

    function test_form_whitespaceIsRefusedAtTheTopLevel() public view {
        bytes memory record = Rec.minimal();
        uint256 kindKey = _find(record, '"kind"');

        _expectMalformed(_insert(record, 1, " "), 1); // after the opening brace
        _expectMalformed(_insert(record, kindKey, " "), kindKey); // after a comma
        _expectMalformed(_insert(record, kindKey, "\n"), kindKey);
        _expectMalformed(_insert(record, kindKey + 6, " "), kindKey + 6); // before the colon
        _expectMalformed(_insert(record, kindKey + 7, " "), kindKey + 7); // after the colon
        _expectMalformed(_insert(record, kindKey + 14, " "), kindKey + 14); // before the next comma
    }

    function test_form_separators() public view {
        Rec.Parts memory p = Rec.parts();
        p.head = '"a":1"b":2,';
        bytes memory record = Rec.build(p);
        _expectMalformed(record, _find(record, '"b"'));

        p.head = '"a":1,,"b":2,';
        record = Rec.build(p);
        _expectMalformed(record, _find(record, ',"b"'));

        p.head = '"a":1;"b":2,';
        record = Rec.build(p);
        _expectMalformed(record, _find(record, ';"b"'));

        p.head = '"a"1,';
        record = Rec.build(p);
        _expectMalformed(record, _find(record, '1,"jobId"'));

        p.head = '"a":,';
        record = Rec.build(p);
        _expectMalformed(record, _find(record, ',"jobId"'));

        p.head = '"a",';
        record = Rec.build(p);
        _expectMalformed(record, _find(record, ',"jobId"'));

        // A comma with nothing after it but the closing brace.
        _expectMalformed('{"a":1,}', 7);
        // A value where a key belongs.
        _expectMalformed('{1:"a"}', 1);
        _expectMalformed('{[],"state":"completed"}', 1);
    }

    function test_form_everyTruncationIsRefused() public view {
        bytes memory record = Rec.minimal();
        _scan(record, 0);
        for (uint256 cut = 0; cut < record.length; ++cut) {
            bytes memory prefix = new bytes(cut);
            for (uint256 i = 0; i < cut; ++i) {
                prefix[i] = record[i];
            }
            (bool ok, bytes memory out) = _both(prefix, 0);
            assertFalse(ok, "a truncated record was accepted");
            bytes4 selector = bytes4(out);
            assertTrue(
                selector == IWorkProof.Malformed.selector || selector == IWorkProof.MissingKey.selector,
                "unexpected error for a truncated record"
            );
        }
    }

    function test_form_truncationThatStillEndsInABrace() public view {
        // Cut right after a nested closing brace: the last byte passes, the structure does not.
        bytes memory record = Rec.minimal();
        uint256 cut = _find(record, '},"jobId"') + 1;
        bytes memory prefix = new bytes(cut);
        for (uint256 i = 0; i < cut; ++i) {
            prefix[i] = record[i];
        }
        _expectMalformed(prefix, cut);
    }

    // ================================================================ memory behind the record
    //
    // The scanner reads 32 bytes at a time, so at the end of a record it sees up to 31 bytes of
    // whatever memory holds next. Those bytes must never count. Here they are quotes and
    // backslashes, placed directly behind the record's last byte.

    function test_memory_aStringLeftOpenAtTheEndStaysOpenWhateverLiesBehindTheRecord() public view {
        // The record stops inside its `state` string; the brace that ends it is content. A quote
        // found behind the record would close that string and make the record look complete.
        string[4] memory states = ['"completed', '"comp\\"leted', '"completed\\\\', '"\\"\\"\\"\\"\\"'];
        for (uint256 pad = 0; pad < 40; ++pad) {
            for (uint256 k = 0; k < states.length; ++k) {
                Rec.Parts memory p = Rec.parts();
                p.objective = string(abi.encodePacked('"', _repeat("x", pad), '"'));
                p.state = states[k];
                p.tail = "";
                bytes memory record = Rec.build(p);
                _expectMalformed(record, record.length);
                _expectMalformedBehindNoise(record, record.length);
            }
        }
    }

    function test_memory_aNestedStringOrAKeyLeftOpenAtTheEnd() public view {
        for (uint256 pad = 0; pad < 40; ++pad) {
            // A string inside an array, never closed.
            bytes memory nested = abi.encodePacked('{"assessments":["', _repeat("y", pad), "}");
            _expectMalformed(nested, nested.length);
            _expectMalformedBehindNoise(nested, nested.length);

            // A key never closed: refused where the key begins.
            bytes memory key = abi.encodePacked('{"assessments":[', _repeat("1", pad), '],"kin}');
            uint256 keyAt = key.length - 5;
            _expectMalformed(key, keyAt);
            _expectMalformedBehindNoise(key, keyAt);
        }
    }

    function test_memory_aCompleteRecordReadsTheSameWhateverLiesBehindIt() public view {
        for (uint256 pad = 0; pad < 40; ++pad) {
            Rec.Parts memory p = Rec.parts();
            p.objective = string(abi.encodePacked('"', _repeat("x", pad), '\\"quoted\\" to the end"'));
            p.signals = '[{"agentId":"7","nodeKey":"a\\"b","value":1},{"agentId":"8","value":0}]';
            // Ending the record right after `state` brings the noise within reach of the last
            // search for a closing quote.
            p.tail = "";
            bytes memory record = Rec.build(p);
            (bytes16 jobId, IWorkProof.Proof memory expected) = _scan(record, 0);
            for (uint256 n = 0; n < NOISES; ++n) {
                (bytes16 gotJob, bytes32 kindHash, bytes32 objectiveHash, bytes32 stateHash, uint256[] memory ids) =
                    noisy.scan(record, _noise(n));
                assertEq(gotJob, jobId);
                assertEq(kindHash, expected.kindHash);
                assertEq(objectiveHash, expected.specHash);
                assertEq(stateHash, expected.stateHash);
                assertEq(ids, expected.agentIds);
                assertEq(ids.length, 1);
            }
        }
    }

    // ================================================================ keys

    function test_key_charsetAndLength() public view {
        // 31 bytes is the longest key; it sorts before `assessments`.
        bytes memory key31 = _repeat("a", 31);
        _scan(_withHead(abi.encodePacked('"', key31, '":1,')), 0);
        _expectMalformed(_withHead(abi.encodePacked('"', _repeat("a", 32), '":1,')), 1);
        _expectMalformed(_withHead(abi.encodePacked('"', _repeat("a", 100), '":1,')), 1);

        _expectMalformed(_withHead('"":1,'), 1); // empty
        _expectMalformed(_withHead('"a\\u0062":1,'), 1); // an escape
        _expectMalformed(_withHead('"a\\"b":1,'), 1); // an escaped quote
        _expectMalformed(_withHead('"a\\\\":1,'), 1); // an escaped backslash
        _expectMalformed(_withHead(abi.encodePacked('"a', hex"c3a9", '":1,')), 1); // UTF-8
        _expectMalformed(_withHead(abi.encodePacked('"a', hex"1f", '":1,')), 1); // a control byte
        _expectMalformed(_withHead(abi.encodePacked('"a', hex"00", '":1,')), 1);
        _expectMalformed(_withHead(abi.encodePacked('"a', hex"80", '":1,')), 1);
        _expectMalformed(_withHead(abi.encodePacked('"a', hex"ff", '":1,')), 1);

        // The edges of the allowed range, 0x20 and 0x7F, are keys like any other.
        _scan(_withHead(abi.encodePacked('" ', hex"7f", '":1,')), 0);
    }

    function test_key_escapedSpellingOfACapturedKeyIsNotThatKey() public view {
        // "jobId" decodes to "jobId" in a full JSON parser. Here a key with an escape is refused
        // outright, so the question of whether it counts never arises.
        Rec.Parts memory p = Rec.parts();
        p.head = string.concat(p.head, '"jo\\u0062Id":"ffffffff-ffff-ffff-ffff-ffffffffffff",');
        bytes memory record = Rec.build(p);
        _expectMalformed(record, _find(record, '"jo\\u0062Id"'));
    }

    function test_key_missingRequiredKeys() public view {
        Rec.Parts memory p = Rec.parts();
        bytes memory noJobId = abi.encodePacked(
            "{",
            p.head,
            '"kind":',
            p.kind,
            ',"objective":',
            p.objective,
            ',"schema":',
            p.schema,
            ',"state":',
            p.state,
            "}"
        );
        _expectError(noJobId, IWorkProof.MissingKey.selector);

        bytes memory noKind = abi.encodePacked(
            "{",
            p.head,
            '"jobId":',
            p.jobId,
            ',"objective":',
            p.objective,
            ',"schema":',
            p.schema,
            ',"state":',
            p.state,
            "}"
        );
        _expectError(noKind, IWorkProof.MissingKey.selector);

        bytes memory noObjective = abi.encodePacked(
            "{", p.head, '"jobId":', p.jobId, ',"kind":', p.kind, ',"schema":', p.schema, ',"state":', p.state, "}"
        );
        _expectError(noObjective, IWorkProof.MissingKey.selector);

        bytes memory noSchema = abi.encodePacked(
            "{",
            p.head,
            '"jobId":',
            p.jobId,
            ',"kind":',
            p.kind,
            ',"objective":',
            p.objective,
            ',"state":',
            p.state,
            "}"
        );
        _expectError(noSchema, IWorkProof.MissingKey.selector);

        // No `state`: the scan gives up at the first key that sorts after it, without walking on.
        bytes memory noState = abi.encodePacked(
            "{", p.head, '"jobId":', p.jobId, ',"kind":', p.kind, ',"objective":', p.objective, ',"schema":', p.schema
        );
        _expectError(abi.encodePacked(noState, ',"submissions":[]}'), IWorkProof.MissingKey.selector);
        _expectError(abi.encodePacked(noState, "}"), IWorkProof.MissingKey.selector);
        // `statf` sorts after `state`; `stat` sorts before it and proves nothing.
        _expectError(abi.encodePacked(noState, ',"statf":"completed"}'), IWorkProof.MissingKey.selector);
        _expectError(abi.encodePacked(noState, ',"stat":"completed"}'), IWorkProof.MissingKey.selector);
        // Keys are compared byte for byte: `State` is another key (and sorts before every lowercase one).
        bytes memory capital = abi.encodePacked(
            '{"State":"completed",', p.head, '"jobId":', p.jobId, ',"kind":', p.kind, ',"objective":', p.objective
        );
        _expectError(abi.encodePacked(capital, ',"schema":', p.schema, "}"), IWorkProof.MissingKey.selector);
    }

    // ================================================================ captured values

    function test_value_schemaMustMatchExactly() public view {
        string[8] memory wrong = [
            "identitymd-work-v2",
            "identitymd-work-v1 ",
            " identitymd-work-v1",
            "identitymd-work-v",
            "IDENTITYMD-WORK-V1",
            "",
            "identitymd-work-v10",
            "identitymd-work-v\\u0031"
        ];
        for (uint256 i = 0; i < wrong.length; ++i) {
            Rec.Parts memory p = Rec.parts();
            p.schema = Rec.quoted(wrong[i]);
            _expectError(Rec.build(p), IWorkProof.WrongSchema.selector);
        }
    }

    function test_value_capturedMembersMustBeStrings() public view {
        string[6] memory notStrings = ["1", "null", "true", "[]", "{}", '["completed"]'];
        for (uint256 i = 0; i < notStrings.length; ++i) {
            Rec.Parts memory p = Rec.parts();
            p.jobId = notStrings[i];
            bytes memory record = Rec.build(p);
            _expectMalformed(record, _find(record, '"jobId":') + 8);

            p = Rec.parts();
            p.kind = notStrings[i];
            record = Rec.build(p);
            _expectMalformed(record, _find(record, '"kind":') + 7);

            p = Rec.parts();
            p.objective = notStrings[i];
            record = Rec.build(p);
            _expectMalformed(record, _find(record, '"objective":') + 12);

            p = Rec.parts();
            p.schema = notStrings[i];
            record = Rec.build(p);
            _expectMalformed(record, _find(record, '"schema":') + 9);

            p = Rec.parts();
            p.state = notStrings[i];
            record = Rec.build(p);
            _expectMalformed(record, _find(record, '"state":') + 8);
        }
    }

    function test_value_jobIdMustBeALowercaseUuid() public view {
        string[10] memory wrong = [
            "01234567-89AB-cdef-0123-456789abcdef", // uppercase
            "0123456789abcdef0123456789abcdef", // no dashes
            "01234567-89ab-cdef-0123-456789abcde", // 35 characters
            "01234567-89ab-cdef-0123-456789abcdef0", // 37 characters
            "01234567-89ab-cdef-0123-456789abcdeg", // not hex
            "01234567089ab-cdef-0123-456789abcdef", // a digit where a dash belongs
            "0123456-789ab-cdef-0123-456789abcdef", // a dash one place early
            "01234567-89ab-cdef-0123-456789abcde ", // a space
            "0x234567-89ab-cdef-0123-456789abcdef",
            ""
        ];
        for (uint256 i = 0; i < wrong.length; ++i) {
            Rec.Parts memory p = Rec.parts();
            p.jobId = Rec.quoted(wrong[i]);
            bytes memory record = Rec.build(p);
            _expectMalformed(record, _find(record, '"jobId":') + 8);
        }
        // The extremes parse to the extremes.
        Rec.Parts memory q = Rec.parts();
        q.jobId = '"00000000-0000-0000-0000-000000000000"';
        (bytes16 zero,) = _scan(Rec.build(q), 0);
        assertEq(zero, bytes16(0));
        q.jobId = '"ffffffff-ffff-ffff-ffff-ffffffffffff"';
        (bytes16 ones,) = _scan(Rec.build(q), 0);
        assertEq(ones, bytes16(type(uint128).max));
    }

    function test_value_literalsHoldOnlyLiteralBytes() public view {
        // One byte where a bare literal belongs: accepted exactly for + - . digits and letters.
        for (uint256 b = 0; b < 256; ++b) {
            bytes memory record = _withHead(abi.encodePacked('"a":', bytes1(uint8(b)), ","));
            (bool ok,) = _both(record, 0);
            bool literal = b == 0x2b || b == 0x2d || b == 0x2e || (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a)
                || (b >= 0x61 && b <= 0x7a);
            assertEq(ok, literal, "literal byte class");
        }
        _scan(_withHead('"a":null,"b":true,"c":false,"d":-12.5e+3,"e":1E5,"f":0,'), 0);
        bytes memory spaced = _withHead('"a":nu ll,');
        _expectMalformed(spaced, _find(spaced, " ll"));
        bytes memory quoted = _withHead('"a":nu"ll,');
        _expectMalformed(quoted, _find(quoted, '"ll'));
    }

    function test_value_emptyStringsAreValues() public view {
        Rec.Parts memory p = Rec.parts();
        p.kind = '""';
        p.objective = '""';
        p.state = '""';
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.kindHash, keccak256(""));
        assertEq(proofOut.headHash, keccak256(""));
        assertEq(proofOut.specHash, keccak256(""));
        assertEq(proofOut.stateHash, keccak256(""));
        _expectError2(Rec.build(p), 1, IWorkProof.HeadTooLong.selector);
    }

    // ================================================================ objective split

    function test_split_headerAndSpec() public view {
        string memory header = "[help-wanted order 3f2a000000000000000000000000000000000000000000000000000000000abc] ";
        assertEq(bytes(header).length, 85);
        // The spec ends with the inputs clause in its one agreed form: `Inputs: key=value; key=value`.
        string memory spec = "Audit the vault. Inputs: repoUrl=https://github.com/acme/vault; baseCommit=1a2b3c4";
        Rec.Parts memory p = Rec.parts();
        p.objective = Rec.quoted(string.concat(header, spec));
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 85);
        assertEq(proofOut.headHash, keccak256(bytes(header)));
        assertEq(proofOut.specHash, keccak256(bytes(spec)));
    }

    function test_split_headLenBounds() public view {
        bytes memory record = Rec.minimal();
        uint256 len = bytes("Check the vault for rounding errors.").length;
        (, IWorkProof.Proof memory whole) = _scan(record, len);
        assertEq(whole.headHash, keccak256("Check the vault for rounding errors."));
        assertEq(whole.specHash, keccak256(""));
        _expectError2(record, len + 1, IWorkProof.HeadTooLong.selector);
        _expectError2(record, type(uint256).max, IWorkProof.HeadTooLong.selector);
    }

    function test_split_isOverTheEscapedBytes() public view {
        // The objective text  a"b  is written  a\"b : four bytes, and the split counts those.
        Rec.Parts memory p = Rec.parts();
        p.objective = '"a\\"b"';
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 2);
        assertEq(proofOut.headHash, keccak256("a\\"));
        assertEq(proofOut.specHash, keccak256('"b'));
        _expectError2(Rec.build(p), 5, IWorkProof.HeadTooLong.selector);
    }

    // ================================================================ signals

    function test_signals_absentOrNotAnArrayGivesNoAgents() public view {
        string[8] memory values =
            ["", "null", "[]", '{"agentId":"5"}', '"[{\\"agentId\\":\\"5\\"}]"', "5", "true", "{}"];
        for (uint256 i = 0; i < values.length; ++i) {
            Rec.Parts memory p = Rec.parts();
            p.signals = values[i];
            (bytes16 jobId, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
            assertEq(proofOut.agentIds.length, 0);
            // Nothing else about the proof changes.
            assertEq(jobId, Rec.JOB);
            assertEq(proofOut.stateHash, COMPLETED);
        }
    }

    function test_signals_idsInOrderOfFirstAppearanceWithoutRepeats() public view {
        Rec.Parts memory p = Rec.parts();
        p.signals = string.concat(
            '[{"agentId":"7","value":1},{"agentId":"52211"},{"agentId":"7","nodeKey":"again"},',
            '{"agentId":"0"},{"agentId":"007"},{"agentId":"52211","x":{"y":[1,2,{"z":"}"}]}}]'
        );
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 3);
        assertEq(proofOut.agentIds[0], 7);
        assertEq(proofOut.agentIds[1], 52211);
        assertEq(proofOut.agentIds[2], 0);
    }

    function test_signals_nestedOrQuotedLookalikesAreNotAgents() public view {
        Rec.Parts memory p = Rec.parts();
        p.signals = string.concat(
            '[{"agentId":"1","inner":[{"agentId":"2"}],"note":"},{\\"agentId\\":\\"3\\"}"},',
            '{"agentId":"4","agentId2":"5"}]'
        );
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 2);
        assertEq(proofOut.agentIds[0], 1);
        assertEq(proofOut.agentIds[1], 4);
    }

    function test_signals_stopAtSixteen() public view {
        Rec.Parts memory p = Rec.parts();
        p.signals = _signalList(1, 17, "");
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 16);
        for (uint256 i = 0; i < 16; ++i) {
            assertEq(proofOut.agentIds[i], i + 1);
        }

        // Elements after the sixteenth distinct id are not read, whatever they hold.
        p.signals = _signalList(1, 16, ',{"agentId":17},"junk",[]');
        (, proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 16);

        // Repeats do not use up the allowance.
        p.signals = string.concat(
            '[{"agentId":"9"},{"agentId":"9"},{"agentId":"9"},', _stripBracket(_signalList(1, 16, "")), "]"
        );
        (, proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 16);
        assertEq(proofOut.agentIds[0], 9);
        assertEq(proofOut.agentIds[1], 1);
        assertEq(proofOut.agentIds[9], 10);
        assertEq(proofOut.agentIds[15], 16);
    }

    function test_signals_anElementOfAnotherShapeEmptiesTheList() public view {
        string[16] memory spoilers = [
            '{"agentId":5}', // a number
            '{"agentId":"5a"}',
            '{"agentId":"a5"}',
            '{"agentId":""}',
            '{"agentId":"-5"}',
            '{"agentId":"+5"}',
            '{"agentId":" 5"}',
            '{"agentId":"5 "}',
            '{"agentId":"5.0"}',
            '{"agentId":"0x5"}',
            '{"agentId":null}',
            '{"addedFirst":1,"agentId":"5"}', // a key that sorts before agentId
            '{"agentid":"5"}',
            '["agentId","5"]',
            "5",
            "{}"
        ];
        for (uint256 i = 0; i < spoilers.length; ++i) {
            // First, last and alone.
            string[3] memory lists = [
                string.concat("[", spoilers[i], ',{"agentId":"1"}]'),
                string.concat('[{"agentId":"1"},{"agentId":"2"},', spoilers[i], "]"),
                string.concat("[", spoilers[i], "]")
            ];
            for (uint256 k = 0; k < lists.length; ++k) {
                Rec.Parts memory p = Rec.parts();
                p.signals = lists[k];
                (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
                assertEq(proofOut.agentIds.length, 0, spoilers[i]);
                assertEq(proofOut.stateHash, COMPLETED);
            }
        }
    }

    function test_signals_idLengthLimit() public view {
        // 77 nines: the largest id text accepted. It is below 2**256, so it cannot wrap.
        bytes memory nines = _repeat("9", 77);
        Rec.Parts memory p = Rec.parts();
        p.signals = string(abi.encodePacked('[{"agentId":"', nines, '"}]'));
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 1);
        assertEq(proofOut.agentIds[0], 10 ** 77 - 1);

        // 78 digits, even the largest uint256 itself, are refused instead of risking a wrap.
        p.signals = string(abi.encodePacked('[{"agentId":"', vm.toString(type(uint256).max), '"}]'));
        (, proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 0);
        p.signals = string(abi.encodePacked('[{"agentId":"', _repeat("0", 78), '"}]'));
        (, proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 0);
    }

    function test_signals_arrayPunctuation() public view {
        string[6] memory broken = [
            '[ {"agentId":"1"}]',
            '[{"agentId":"1"} ]',
            '[{"agentId":"1"},]',
            '[{"agentId":"1"};{"agentId":"2"}]',
            '[{"agentId":"1"}{"agentId":"2"}]',
            '[[{"agentId":"1"}]]'
        ];
        for (uint256 i = 0; i < broken.length; ++i) {
            Rec.Parts memory p = Rec.parts();
            p.signals = broken[i];
            (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
            assertEq(proofOut.agentIds.length, 0, broken[i]);
        }
    }

    function test_signals_rejectedSubmissionsAreLeftOut() public view {
        // The shape of a real record (job 8a5d5e50): the first attempt at a node was rejected and
        // carries `value` 0, the second was accepted and carries 1.
        Rec.Parts memory p = Rec.parts();
        p.signals = string.concat(
            '[{"agentId":"51746","feedbackHash":"1c72","nodeKey":"build_contract_project","submissionHash":"a28e",',
            '"tag1":"verification:checks","tag2":"acceptance-v2","value":0},',
            '{"agentId":"51620","feedbackHash":"b500","nodeKey":"build_contract_project","submissionHash":"dc4b",',
            '"tag1":"verification:checks","tag2":"acceptance-v2","value":1}]'
        );
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 1, "the rejected attempt is not named");
        assertEq(proofOut.agentIds[0], 51620);
        assertEq(proofOut.stateHash, COMPLETED);

        // An agent rejected once and accepted once is named, once, whichever came first.
        p.signals = '[{"agentId":"7","value":0},{"agentId":"7","value":1},{"agentId":"8","value":0}]';
        (, proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 1);
        assertEq(proofOut.agentIds[0], 7);
        p.signals = '[{"agentId":"8","value":0},{"agentId":"7","value":1},{"agentId":"7","value":0}]';
        (, proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 1);
        assertEq(proofOut.agentIds[0], 7);

        // Nothing but rejections names nobody, down to the shortest element there can be.
        p.signals = '[{"agentId":"7","value":0},{"agentId":"8","nodeKey":"x","value":0}]';
        (, proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 0);
        p.signals = '[{"agentId":"7","value":0}]';
        (, proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 0);
        assertEq(proofOut.stateHash, COMPLETED);
    }

    function test_signals_onlyALastMemberOfValueZeroIsARejection() public view {
        // Each of these names agent 7. None ends with the member `"value":0`.
        string[16] memory counted = [
            '{"agentId":"7"}',
            '{"agentId":"7","value":1}',
            '{"agentId":"7","value":10}',
            '{"agentId":"7","value":100}',
            '{"agentId":"7","value":-0}',
            '{"agentId":"7","value":0.0}',
            '{"agentId":"7","value":"0"}', // a string
            '{"agentId":"7","value":[0]}',
            '{"agentId":"7","value":{"value":0}}', // the zero belongs to a nested object
            '{"agentId":"7","value":null}',
            '{"agentId":"7","xvalue":0}', // another key that ends the same way
            '{"agentId":"7","Value":0}',
            '{"agentId":"7","value":0,"valueDecimals":0}', // `value` is no longer the last member
            '{"agentId":"7","note":",\\"value\\":0}"}', // the bytes of a rejection, as text
            '{"agentId":"7","note":"x\\\\","value":1}',
            '{"agentId":"7","nodeKey":"value","tag1":"0"}'
        ];
        for (uint256 i = 0; i < counted.length; ++i) {
            Rec.Parts memory p = Rec.parts();
            p.signals = string.concat("[", counted[i], "]");
            (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
            assertEq(proofOut.agentIds.length, 1, counted[i]);
            assertEq(proofOut.agentIds[0], 7, counted[i]);
        }

        // Each of these is a rejection, whatever else the element holds.
        string[6] memory rejected = [
            '{"agentId":"7","value":0}',
            '{"agentId":"7","nodeKey":"x","value":0}',
            '{"agentId":"7","inner":{"value":1},"value":0}',
            '{"agentId":"7","note":",\\"value\\":1}","value":0}',
            '{"agentId":"7","note":"ends with a backslash \\\\","value":0}',
            '{"agentId":"7","list":[{"agentId":"8","value":1}],"value":0}'
        ];
        for (uint256 i = 0; i < rejected.length; ++i) {
            Rec.Parts memory p = Rec.parts();
            p.signals = string.concat("[", rejected[i], ',{"agentId":"9","value":1}]');
            (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
            assertEq(proofOut.agentIds.length, 1, rejected[i]);
            assertEq(proofOut.agentIds[0], 9, rejected[i]);
        }
    }

    function test_signals_aRejectionDoesNotExcuseAnUnreadableElement() public view {
        // An element is read before its value is looked at. One that cannot be read empties the
        // list whether or not it ends like a rejection.
        string[4] memory lists = [
            '[{"agentId":"x","value":0},{"agentId":"1","value":1}]',
            '[{"agentId":"1","value":1},{"agentId":5,"value":0}]',
            '[{"agentId":"1","value":1},{"addedFirst":1,"agentId":"5","value":0}]',
            '[{"agentId":"1","value":1},{"agentId":"","value":0}]'
        ];
        for (uint256 i = 0; i < lists.length; ++i) {
            Rec.Parts memory p = Rec.parts();
            p.signals = lists[i];
            (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
            assertEq(proofOut.agentIds.length, 0, lists[i]);
        }
    }

    function test_signals_rejectionsDoNotUseUpTheSixteen() public view {
        // Twenty rejected agents, then sixteen accepted ones, then one more of each.
        string memory list = "[";
        for (uint256 id = 101; id <= 120; ++id) {
            list = string.concat(list, '{"agentId":"', vm.toString(id), '","value":0},');
        }
        list = string.concat(list, _stripBracket(_signalList(1, 16, "")), ',{"agentId":"17","value":1}]');
        Rec.Parts memory p = Rec.parts();
        p.signals = list;
        (, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(proofOut.agentIds.length, 16);
        for (uint256 i = 0; i < 16; ++i) {
            assertEq(proofOut.agentIds[i], i + 1);
        }
    }

    // ================================================================ helpers

    /// @dev A record whose objective holds exactly `raw` (text already escaped the way the writer
    /// escapes it) must be read back as that, with the members after it where they were.
    function _expectObjective(bytes memory raw) internal view {
        Rec.Parts memory p = Rec.parts();
        p.objective = string(abi.encodePacked('"', raw, '"'));
        p.state = '"blocked"';
        (bytes16 jobId, IWorkProof.Proof memory proofOut) = _scan(Rec.build(p), 0);
        assertEq(jobId, Rec.JOB);
        assertEq(proofOut.specHash, keccak256(raw), "the objective was not read to its real end");
        assertEq(proofOut.stateHash, keccak256("blocked"));
        assertEq(proofOut.agentIds.length, 1);
    }

    uint256 internal constant NOISES = 5;

    /// @dev Thirty-two bytes to put behind a record: quotes, escaped quotes, a quote behind an even
    /// run, backslashes ending in a quote, and a quote in the very last place a read can reach.
    function _noise(uint256 which) internal pure returns (bytes32) {
        if (which == 0) return 0x2222222222222222222222222222222222222222222222222222222222222222;
        if (which == 1) return 0x5c225c225c225c225c225c225c225c225c225c225c225c225c225c225c225c22;
        if (which == 2) return 0x5c5c225c5c225c5c225c5c225c5c225c5c225c5c225c5c225c5c225c5c225c5c;
        if (which == 3) return 0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c2222;
        return 0x7878787878787878787878787878787878787878787878787878787878782278;
    }

    /// @dev `JsonScan`, with each kind of noise behind `record`, must refuse it at `pos`.
    function _expectMalformedBehindNoise(bytes memory record, uint256 pos) internal view {
        for (uint256 n = 0; n < NOISES; ++n) {
            (bool ok, bytes memory out) =
                address(noisy).staticcall(abi.encodeCall(NoisyMemoryScanner.scan, (record, _noise(n))));
            assertFalse(ok, "bytes behind the record were taken for part of it");
            assertEq(out, abi.encodeWithSelector(IWorkProof.Malformed.selector, pos), "Malformed position");
        }
    }

    /// @dev Runs both scanners, requires the same outcome, and returns it.
    function _both(bytes memory record, uint256 headLen) internal view returns (bool ok, bytes memory out) {
        bytes memory call = abi.encodeCall(IWorkProof.scan, (record, headLen));
        (ok, out) = address(proof).staticcall(call);
        (bool refOk, bytes memory refOut) = address(ref).staticcall(call);
        assertEq(ok, refOk, "the reference scanner disagrees on acceptance");
        assertEq(out, refOut, "the reference scanner disagrees on the result");
    }

    function _scan(bytes memory record, uint256 headLen)
        internal
        view
        returns (bytes16 jobId, IWorkProof.Proof memory proofOut)
    {
        (bool ok, bytes memory out) = _both(record, headLen);
        assertTrue(ok, "expected the record to be accepted");
        (jobId, proofOut) = abi.decode(out, (bytes16, IWorkProof.Proof));
        assertEq(proofOut.recordHash, keccak256(record));
    }

    function _expectMalformed(bytes memory record, uint256 pos) internal view {
        (bool ok, bytes memory out) = _both(record, 0);
        assertFalse(ok, "expected Malformed");
        assertEq(out, abi.encodeWithSelector(IWorkProof.Malformed.selector, pos), "Malformed position");
    }

    function _expectError(bytes memory record, bytes4 selector) internal view {
        _expectError2(record, 0, selector);
    }

    function _expectError2(bytes memory record, uint256 headLen, bytes4 selector) internal view {
        (bool ok, bytes memory out) = _both(record, headLen);
        assertFalse(ok, "expected a revert");
        assertEq(out, abi.encodePacked(selector), "error");
    }

    /// @dev The default record with `head` in place of its leading members.
    function _withHead(bytes memory head) internal pure returns (bytes memory) {
        Rec.Parts memory p = Rec.parts();
        p.head = string(head);
        return Rec.build(p);
    }

    function _repeat(bytes memory unit, uint256 times) internal pure returns (bytes memory out) {
        out = new bytes(unit.length * times);
        for (uint256 i = 0; i < times; ++i) {
            for (uint256 j = 0; j < unit.length; ++j) {
                out[i * unit.length + j] = unit[j];
            }
        }
    }

    function _insert(bytes memory data, uint256 at, bytes memory what) internal pure returns (bytes memory) {
        bytes memory before = new bytes(at);
        for (uint256 i = 0; i < at; ++i) {
            before[i] = data[i];
        }
        bytes memory rest = new bytes(data.length - at);
        for (uint256 i = 0; i < rest.length; ++i) {
            rest[i] = data[at + i];
        }
        return abi.encodePacked(before, what, rest);
    }

    function _find(bytes memory haystack, bytes memory needle) internal pure returns (uint256) {
        return _findFrom(haystack, needle, 0);
    }

    function _findFrom(bytes memory haystack, bytes memory needle, uint256 from) internal pure returns (uint256) {
        for (uint256 i = from; i + needle.length <= haystack.length; ++i) {
            bool same = true;
            for (uint256 j = 0; j < needle.length && same; ++j) {
                if (haystack[i + j] != needle[j]) same = false;
            }
            if (same) return i;
        }
        revert("needle not found");
    }

    /// @dev `[{"agentId":"from"},...,{"agentId":"to"}<extra>]`.
    function _signalList(uint256 from, uint256 to, string memory extra) internal pure returns (string memory out) {
        out = "[";
        for (uint256 id = from; id <= to; ++id) {
            out = string.concat(out, id == from ? "" : ",", '{"agentId":"', vm.toString(id), '","value":1}');
        }
        out = string.concat(out, extra, "]");
    }

    /// @dev Drops the leading `[` and the trailing `]` of a list.
    function _stripBracket(string memory list) internal pure returns (string memory) {
        return string(Rec.inner(list));
    }
}
