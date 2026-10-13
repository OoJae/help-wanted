// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SpecText} from "../../src/desk/SpecText.sol";

contract SpecTextHarness {
    function firstBad(bytes calldata spec) external pure returns (uint256) {
        return SpecText.firstBad(spec);
    }

    /// @dev The same check with other calldata after the spec, so the bytes the word-wide scan reads
    /// past the end of the spec are not zero.
    function firstBadWithTrailer(bytes calldata spec, bytes calldata) external pure returns (uint256) {
        return SpecText.firstBad(spec);
    }
}

contract SpecTextTest is Test {
    SpecTextHarness internal h;
    uint256 internal constant NONE = type(uint256).max;
    uint256 internal constant MAX = 7900;

    function setUp() public {
        h = new SpecTextHarness();
    }

    /// @dev The rules, one byte at a time.
    function _ref(bytes memory spec) internal pure returns (uint256) {
        uint256 len = spec.length;
        if (len == 0) return 0;
        if (len > MAX) return MAX;
        for (uint256 i; i < len; ++i) {
            uint8 c = uint8(spec[i]);
            if (c < 0x20 || c > 0x7e || c == 0x22 || c == 0x5c) return i;
            if (c == 0x20 && (i == 0 || i == len - 1)) return i;
        }
        return NONE;
    }

    function _filled(uint256 len, bytes1 with) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            b[i] = with;
        }
    }

    function _check(bytes memory spec) internal view returns (uint256 at) {
        at = h.firstBad(spec);
        assertEq(at, _ref(spec), "library and reference disagree");
        assertEq(h.firstBadWithTrailer(spec, hex"00225c7f80ff000a"), at, "depends on bytes after the spec");
        assertEq(h.firstBadWithTrailer(spec, _filled(40, 0x22)), at, "depends on bytes after the spec");
    }

    function test_acceptsOrdinaryText() public view {
        assertEq(_check("Audit the repo. Inputs: repoUrl=https://example.org/r; baseCommit=0123abcd"), NONE);
        assertEq(_check("a"), NONE);
        assertEq(_check("!#$%&'()*+,-./0123456789:;<=>?@ABCXYZ[]^_`abcxyz{|}~"), NONE);
    }

    function test_rejectsEmpty() public view {
        assertEq(_check(""), 0);
    }

    function test_lengthLimit() public view {
        assertEq(_check(_filled(MAX, "a")), NONE);
        assertEq(_check(_filled(MAX + 1, "a")), MAX);
        assertEq(_check(_filled(MAX + 1000, "a")), MAX);
        assertEq(_check(_filled(MAX - 1, "a")), NONE);
    }

    function test_rejectsLeadingAndTrailingSpace() public view {
        assertEq(_check(" abc"), 0);
        assertEq(_check("abc "), 3);
        assertEq(_check(" "), 0);
        assertEq(_check("a b"), NONE);
        // Exactly one word of text with a trailing space, and one word plus one byte.
        bytes memory b = _filled(32, "a");
        b[31] = " ";
        assertEq(_check(b), 31);
        b = _filled(33, "a");
        b[32] = " ";
        assertEq(_check(b), 32);
    }

    function test_rejectsQuoteAndBackslash() public view {
        assertEq(_check('say "hi"'), 4);
        assertEq(_check("a\\b"), 1);
    }

    function test_rejectsControlAndHighBytes() public view {
        assertEq(_check("line one\nline two"), 8);
        assertEq(_check("tab\there"), 3);
        assertEq(_check(hex"61007a"), 1);
        assertEq(_check(hex"617f7a"), 1);
        assertEq(_check(hex"61807a"), 1);
        assertEq(_check(hex"61ff7a"), 1);
        assertEq(_check(unicode"café"), 3);
    }

    /// The edges of the allowed range: 0x1F and 0x7F are out, 0x20 (inside the text) and 0x7E are in.
    function test_rangeEdges() public view {
        assertEq(_check(hex"611f61"), 1);
        assertEq(_check(hex"612061"), NONE);
        assertEq(_check(hex"617e61"), NONE);
        assertEq(_check(hex"617f61"), 1);
        assertEq(_check(hex"612161"), NONE);
        assertEq(_check(hex"612361"), NONE);
        assertEq(_check(hex"615b61"), NONE);
        assertEq(_check(hex"615d61"), NONE);
    }

    /// Every one of the 256 byte values, at every position of a spec that spans word boundaries.
    function test_everyByteValueAtEveryPosition() public view {
        uint256 len = 70;
        for (uint256 pos; pos < len; pos += 3) {
            for (uint256 v; v < 256; ++v) {
                bytes memory b = _filled(len, "k");
                b[pos] = bytes1(uint8(v));
                assertEq(h.firstBad(b), _ref(b));
            }
        }
    }

    /// The first offending byte is reported even when later ones exist, across word boundaries.
    function test_reportsTheFirstOfSeveral() public view {
        bytes memory b = _filled(200, "x");
        b[150] = '"';
        b[40] = "\\";
        b[199] = " ";
        assertEq(_check(b), 40);
        b[40] = "x";
        assertEq(_check(b), 150);
        b[150] = "x";
        assertEq(_check(b), 199);
        b[199] = "x";
        assertEq(_check(b), NONE);
    }

    function testFuzz_matchesReferenceOnAnyBytes(bytes memory spec) public view {
        _check(spec);
    }

    /// Mostly valid text with one planted byte: reaches deep positions that random bytes never do.
    function testFuzz_onePlantedByte(uint16 lenSeed, uint16 posSeed, uint8 planted) public view {
        uint256 len = bound(lenSeed, 1, 600);
        uint256 pos = bound(posSeed, 0, len - 1);
        bytes memory b = _filled(len, "m");
        b[pos] = bytes1(planted);
        uint256 at = _check(b);
        bool allowed = planted >= 0x20 && planted <= 0x7e && planted != 0x22 && planted != 0x5c
            && !(planted == 0x20 && (pos == 0 || pos == len - 1));
        assertEq(at, allowed ? NONE : pos);
    }

    /// The check reads 32 bytes at a time. This walks a fault through every position of specs of 1
    /// to 70 bytes, so every offset inside a word, both word boundaries and every length of the
    /// last, partial word are hit.
    function test_findsAFaultAtEveryPositionOfEveryShortLength() public view {
        bytes1[7] memory planted =
            [bytes1('"'), bytes1("\\"), bytes1(0x00), bytes1(0x1F), bytes1(0x7F), bytes1(0x80), bytes1(0xFF)];
        for (uint256 len = 1; len <= 70; ++len) {
            for (uint256 at; at < len; ++at) {
                bytes memory b = _filled(len, "k");
                b[at] = planted[(len + at) % 7];
                assertEq(h.firstBad(b), at);
                assertEq(h.firstBadWithTrailer(b, hex"00225c7fff"), at);
            }
            // And with no fault, whatever follows the spec in calldata is not read as part of it.
            assertEq(h.firstBadWithTrailer(_filled(len, "k"), hex"00225c7fff"), NONE);
        }
    }

    /// One forbidden byte planted anywhere in a spec of up to the longest length is found exactly
    /// where it was planted.
    function testFuzz_findsAPlantedFaultInALongSpec(uint16 lenSeed, uint16 where, uint8 pick) public view {
        uint256 len = bound(lenSeed, 1, MAX);
        uint256 at = bound(where, 0, len - 1);
        bytes memory b = _filled(len, "k");
        bytes1[6] memory planted = [bytes1('"'), bytes1("\\"), bytes1("\n"), bytes1(0x00), bytes1(0x7F), bytes1(0xC3)];
        b[at] = planted[pick % 6];
        assertEq(_check(b), at);
    }

    /// Two forbidden bytes anywhere in a long spec: the one that comes first is reported.
    function testFuzz_reportsTheFirstOfTwoFaultsInALongSpec(
        uint16 lenSeed,
        uint16 a,
        uint16 b,
        uint8 pickA,
        uint8 pickB
    ) public view {
        uint256 len = bound(lenSeed, 2, MAX);
        uint256 first = bound(a, 0, len - 1);
        uint256 second = bound(b, 0, len - 1);
        bytes memory spec = _filled(len, "k");
        bytes1[6] memory planted = [bytes1('"'), bytes1("\\"), bytes1("\n"), bytes1(0x00), bytes1(0x7F), bytes1(0xC3)];
        spec[first] = planted[pickA % 6];
        spec[second] = planted[pickB % 6];
        assertEq(_check(spec), first < second ? first : second);
    }

    function testFuzz_longValidText(uint16 lenSeed, uint256 seed) public view {
        uint256 len = bound(lenSeed, 1, MAX);
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            // 0x23..0x5b and 0x5d..0x7e, never a space, a quote or a backslash.
            uint8 c = uint8(0x23 + uint256(keccak256(abi.encode(seed, i / 32))) % 57);
            b[i] = bytes1(c);
        }
        assertEq(_check(b), NONE);
    }

    /// Accepted text is exactly the text whose JSON string form is itself, which is why the desk
    /// can compare raw hashes: no byte needs escaping, and nothing is trimmed.
    function testFuzz_acceptedTextNeedsNoJsonEscaping(bytes memory spec) public view {
        if (h.firstBad(spec) != NONE) return;
        for (uint256 i; i < spec.length; ++i) {
            uint8 c = uint8(spec[i]);
            assertTrue(c >= 0x20 && c < 0x7f && c != 0x22 && c != 0x5c);
        }
        assertTrue(spec.length >= 1 && spec.length <= MAX);
        assertTrue(spec[0] != " " && spec[spec.length - 1] != " ");
    }
}
