// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {QuestionBody} from "../../src/questions/QuestionBody.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {QuestionsFixture} from "./QuestionsFixture.sol";

/// @dev Gives the library's calldata helpers an external face.
contract QuestionBodyHarness {
    function startsWith(bytes calldata text, bytes memory start) external pure returns (bool) {
        return QuestionBody.startsWith(text, start);
    }

    function endsWith(bytes calldata text, bytes memory end) external pure returns (bool) {
        return QuestionBody.endsWith(text, end);
    }

    function hasNumber(bytes calldata text, bytes memory key, uint256 value) external pure returns (bool) {
        return QuestionBody.hasNumber(text, key, value);
    }

    function holdsPanelEvidence(bytes calldata text) external pure returns (bool) {
        return QuestionBody.holdsPanelEvidence(text);
    }
}

/// @dev Hands the library a slice of a longer piece of call data, so that what lies just outside the
/// slice is known.
contract TextSlicer {
    function holds(bytes calldata all, uint256 start, uint256 end) external pure returns (bool) {
        return QuestionBody.holdsPanelEvidence(all[start:end]);
    }
}

/// @notice The body builder against a reference written another way, and the small text checks
/// `createFeed` leans on.
contract QuestionBodyTest is QuestionsFixture {
    QuestionBodyHarness internal lib = new QuestionBodyHarness();

    /// @dev A decimal writer that shares nothing with the one the contract uses: digits are peeled
    /// off the low end into a fixed buffer.
    function _dec(uint256 value) internal pure returns (bytes memory out) {
        if (value == 0) return "0";
        bytes memory buffer = new bytes(78);
        uint256 at = buffer.length;
        while (value != 0) {
            buffer[--at] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        out = new bytes(buffer.length - at);
        for (uint256 i; i < out.length; ++i) {
            out[i] = buffer[at + i];
        }
    }

    function _referenceBody(bytes memory prefix, bytes memory tail, uint64 fromBlock, uint64 toBlock)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(prefix, _dec(fromBlock), ',"toBlock":', _dec(toBlock), "}", tail);
    }

    function _referenceHash(bytes memory prefix, uint64 fromBlock, uint64 toBlock) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(prefix, _dec(fromBlock), ',"toBlock":', _dec(toBlock), "}}"));
    }

    function testFuzz_builderMatchesTheReference(
        bytes memory prefix,
        bytes memory tail,
        uint64 fromBlock,
        uint64 toBlock
    ) public pure {
        bytes memory body = QuestionBody.body(prefix, tail, fromBlock, toBlock);
        assertEq(body, _referenceBody(prefix, tail, fromBlock, toBlock));
        assertEq(QuestionBody.questionHash(prefix, fromBlock, toBlock), _referenceHash(prefix, fromBlock, toBlock));
        // The body and the hashed document share everything up to the brace that closes `window`.
        bytes memory shared = QuestionBody.shared(prefix, fromBlock, toBlock);
        assertEq(body, bytes.concat(shared, tail));
        assertEq(QuestionBody.questionHash(prefix, fromBlock, toBlock), keccak256(bytes.concat(shared, "}")));
        assertLe(body.length, prefix.length + tail.length + QuestionBody.WINDOW_MAX_BYTES);
    }

    function test_builder_edges() public pure {
        bytes memory prefix = '{"window":{"fromBlock":';
        assertEq(QuestionBody.body(prefix, ',"x":1}', 0, 0), bytes('{"window":{"fromBlock":0,"toBlock":0},"x":1}'));
        assertEq(QuestionBody.body(prefix, "", 9, 10), bytes('{"window":{"fromBlock":9,"toBlock":10}'));
        assertEq(
            QuestionBody.body("", "", type(uint64).max, type(uint64).max),
            bytes('18446744073709551615,"toBlock":18446744073709551615}')
        );
        // The two block numbers and the text between them never add more than the bytes kept back.
        assertEq(QuestionBody.body("", "", type(uint64).max, type(uint64).max).length, QuestionBody.WINDOW_MAX_BYTES);
        assertEq(
            QuestionBody.questionHash(prefix, 26157228, 26164227),
            keccak256('{"window":{"fromBlock":26157228,"toBlock":26164227}}')
        );
    }

    /// @notice Through the contract: whatever the question says and whichever block it is asked
    /// in, the body is the reference body, it is valid JSON, and it carries the window and the
    /// numbers the feed enforces.
    function testFuzz_contractSendsTheReferenceBody(uint256 textSeed, uint32 blockSeed, uint8 length, bool contiguous)
        public
    {
        Questions.FeedParams memory p = _params();
        p.contiguous = contiguous;
        bytes memory question = new bytes(bound(length, 1, 200));
        for (uint256 i; i < question.length; ++i) {
            // Printable ASCII without the two characters JSON escapes.
            uint8 c = uint8(32 + (uint256(keccak256(abi.encode(textSeed, i))) % 95));
            question[i] = (c == 0x22 || c == 0x5c) ? bytes1("?") : bytes1(c);
        }
        bytes memory prefix = bytes.concat(
            '{"answerType":"uint256","chainId":',
            bytes(vm.toString(vm.getChainId())),
            ',"question":"',
            question,
            '","v":1,"window":{"fromBlock":'
        );
        bytes memory tail = _tail(7, 5, 86_400);
        bytes32 id = q.createFeed(p, prefix, tail);
        _fund(alice, id, 1e18);

        vm.roll(bound(blockSeed, LAG + 1, type(uint32).max));
        (bytes memory body, bytes32 questionHash, uint64 fromBlock, uint64 toBlock) = q.nextBody(id);
        assertEq(toBlock, vm.getBlockNumber() - LAG);
        assertEq(body, _referenceBody(prefix, tail, fromBlock, toBlock));
        assertEq(questionHash, _referenceHash(prefix, fromBlock, toBlock));

        _request(id);
        assertEq(intake.lastBody(), body);
        (, bytes32 pinned,,) = q.roundRequest(id, 1);
        assertEq(pinned, questionHash);

        string memory json = string(body);
        assertEq(vm.parseJsonUint(json, ".window.fromBlock"), fromBlock);
        assertEq(vm.parseJsonUint(json, ".window.toBlock"), toBlock);
        assertEq(vm.parseJsonUint(json, ".chainId"), vm.getChainId());
        assertEq(vm.parseJsonUint(json, ".panelSize"), 7);
        assertEq(vm.parseJsonUint(json, ".quorum"), 5);
        assertEq(vm.parseJsonUint(json, ".validForSeconds"), 86_400);
        assertEq(vm.parseJsonString(json, ".answerType"), "uint256");
        assertEq(bytes(vm.parseJsonString(json, ".question")), question);
    }

    // ---- the checks createFeed leans on ---------------------------------------------------------

    function test_prefixStart_isCanonicalForEveryType() public pure {
        assertEq(QuestionBody.prefixStart(0, 1), bytes('{"answerType":"bool","chainId":1,'));
        assertEq(QuestionBody.prefixStart(1, 4663), bytes('{"answerType":"address","chainId":4663,'));
        assertEq(QuestionBody.prefixStart(2, 1), bytes('{"answerType":"bytes32","chainId":1,'));
        assertEq(QuestionBody.prefixStart(3, 11155111), bytes('{"answerType":"uint256","chainId":11155111,'));
        assertEq(QuestionBody.prefixStart(4, 1), bytes('{"answerType":"address[]","chainId":1,'));
        assertEq(QuestionBody.prefixStart(5, 8453), bytes('{"answerType":"bytes32[]","chainId":8453,'));
    }

    function test_startsWith_endsWith() public view {
        assertTrue(lib.startsWith("abcdef", "abc"));
        assertTrue(lib.startsWith("abc", "abc"));
        assertTrue(lib.startsWith("abc", ""));
        assertFalse(lib.startsWith("ab", "abc"));
        assertFalse(lib.startsWith("abd", "abc"));
        assertTrue(lib.endsWith("abcdef", "def"));
        assertTrue(lib.endsWith("def", "def"));
        assertFalse(lib.endsWith("ef", "def"));
        assertFalse(lib.endsWith("deg", "def"));
    }

    function test_holdsPanelEvidence_findsTheBytesAnywhere() public view {
        assertEq(bytes.concat(QuestionBody.PANEL_EVIDENCE), bytes('"evidence":"panel"'));
        // Where the canonical document of a panel question has it: after `chainId`, or after the
        // definitions when there are any.
        assertTrue(lib.holdsPanelEvidence('{"answerType":"bool","chainId":1,"evidence":"panel","question":"Q?"'));
        assertTrue(lib.holdsPanelEvidence('{"chainId":1,"definitions":{"a":"b"},"evidence":"panel","head":3,'));
        // Alone, at the very start and at the very end.
        assertTrue(lib.holdsPanelEvidence('"evidence":"panel"'));
        assertTrue(lib.holdsPanelEvidence('"evidence":"panel",'));
        assertTrue(lib.holdsPanelEvidence(',"evidence":"panel"'));
        // Chain evidence, near misses, a text one byte short, and an empty text.
        assertFalse(lib.holdsPanelEvidence('{"answerType":"bool","chainId":1,"question":"Q?"'));
        assertFalse(lib.holdsPanelEvidence(',"evidence":"chain",'));
        assertFalse(lib.holdsPanelEvidence('"evidence":"panel'));
        assertFalse(lib.holdsPanelEvidence('evidence":"panel"'));
        assertFalse(lib.holdsPanelEvidence('"evidence": "panel"'));
        assertFalse(lib.holdsPanelEvidence('"evidence":"panels'));
        assertFalse(lib.holdsPanelEvidence('"Evidence":"panel"'));
        assertFalse(lib.holdsPanelEvidence(""));
        // Inside a question's own wording the quotes are escaped, so the bytes are not there.
        assertFalse(lib.holdsPanelEvidence('"question":"Is \\"evidence\\":\\"panel\\" set?"'));
    }

    /// @notice Against a search written another way, with the bytes spliced in or not, and with
    /// one of them changed.
    function testFuzz_holdsPanelEvidence_matchesAPlainSearch(
        bytes memory before,
        bytes memory rest,
        bool splice,
        uint8 bend
    ) public view {
        bytes memory needle = bytes.concat(QuestionBody.PANEL_EVIDENCE);
        if (bend < needle.length) needle[bend] = bytes1(uint8(needle[bend]) ^ 0x01);
        bytes memory text = splice ? bytes.concat(before, needle, rest) : bytes.concat(before, rest);
        bool expected = _plainSearch(text, bytes.concat(QuestionBody.PANEL_EVIDENCE));
        assertEq(lib.holdsPanelEvidence(text), expected);
        if (splice && bend >= needle.length) assertTrue(expected);
    }

    /// @notice Nothing outside the text is ever compared: the wanted bytes right after the text in
    /// the call data, or straddling its end, are not found.
    function test_holdsPanelEvidence_readsNothingPastTheText() public {
        bytes memory panel = bytes.concat(QuestionBody.PANEL_EVIDENCE);
        bytes memory all = bytes.concat("0123456789", panel, "0123456789");
        TextSlicer slicer = new TextSlicer();
        // The whole of it holds the bytes; every slice that ends before their last byte does not.
        assertTrue(slicer.holds(all, 0, all.length));
        assertTrue(slicer.holds(all, 10, 28));
        assertTrue(slicer.holds(all, 0, 28));
        for (uint256 end; end < 28; ++end) {
            assertFalse(slicer.holds(all, 0, end));
        }
        // And every slice that starts after their first byte.
        for (uint256 start = 11; start <= all.length; ++start) {
            assertFalse(slicer.holds(all, start, all.length));
        }
    }

    /// @dev A search that shares nothing with the library's: byte by byte.
    function _plainSearch(bytes memory text, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || text.length < needle.length) return false;
        for (uint256 i; i + needle.length <= text.length; ++i) {
            uint256 k;
            while (k < needle.length && text[i + k] == needle[k]) ++k;
            if (k == needle.length) return true;
        }
        return false;
    }

    function test_hasNumber_wantsTheWholeNumber() public view {
        bytes memory text = ',"panelSize":7,"quorum":5,"validForSeconds":86400}';
        assertTrue(lib.hasNumber(text, '"panelSize":', 7));
        assertTrue(lib.hasNumber(text, '"quorum":', 5));
        assertTrue(lib.hasNumber(text, '"validForSeconds":', 86_400));
        // A number that is a prefix or a suffix of the one in the text is not it.
        assertFalse(lib.hasNumber(text, '"validForSeconds":', 8640));
        assertFalse(lib.hasNumber(text, '"validForSeconds":', 864_000));
        assertFalse(lib.hasNumber(text, '"validForSeconds":', 6400));
        assertFalse(lib.hasNumber(text, '"panelSize":', 70));
        assertFalse(lib.hasNumber(text, '"quorum":', 0));
        // A key that is not there, a text too short to hold it, and a number with nothing after it.
        assertFalse(lib.hasNumber(text, '"head":', 3));
        assertFalse(lib.hasNumber("", '"quorum":', 5));
        assertFalse(lib.hasNumber('"quorum":5', '"quorum":', 5));
        // The key may come more than once; one exact match is enough.
        assertTrue(lib.hasNumber(',"quorum":50,"quorum":5}', '"quorum":', 5));
        assertTrue(lib.hasNumber(',"quorum":0}', '"quorum":', 0));
    }

    function testFuzz_hasNumber_matchesOnlyTheSameNumber(uint256 written, uint256 asked, bool closing) public view {
        bytes memory text = bytes.concat(',"quorum":', _dec(written), closing ? bytes("}") : bytes(',"x":1}'));
        assertEq(lib.hasNumber(text, '"quorum":', asked), written == asked);
    }
}
