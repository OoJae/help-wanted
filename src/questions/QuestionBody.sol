// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title The bytes a Standing Question sends, and the hash the oracle signs for them
/// @notice The IdentityMD oracle identifies a question by `questionHash`: keccak-256 of the question
/// written as canonical JSON (keys sorted, no whitespace). The keys are `answerType`, `chainId`,
/// `definitions` (only when the request has any), `evidence` (only when it is `"panel"`), `head`
/// (only when the request has one), `question`, `v` and `window: {fromBlock, toBlock}`. Checked
/// against 23 attested requests in `test/fixtures/questions/requests` and three bodies read back
/// from the Intake's own events.
///
/// `window` sorts last and `fromBlock` sorts before `toBlock`, so everything a feed asks is fixed
/// text except two block numbers near the end. A feed therefore stores two pieces:
///
/// - `qPrefix`: the canonical document up to and including `"window":{"fromBlock":`
/// - `tail`: the rest of the request body, the fields the hash does not cover
///   (`,"panelSize":7,"quorum":5,"validForSeconds":86400}` and the like)
///
/// and each round is
///
///   body         = qPrefix ‖ dec(fromBlock) ‖ `,"toBlock":` ‖ dec(toBlock) ‖ `}` ‖ tail
///   questionHash = keccak256(qPrefix ‖ dec(fromBlock) ‖ `,"toBlock":` ‖ dec(toBlock) ‖ `}}`)
///
/// One stored text gives both the request and the hash the answer must carry, so the contract
/// cannot ask one thing and accept the answer to another.
library QuestionBody {
    /// @dev The Intake refuses a longer body (`Intake.MAX_BODY_BYTES`).
    uint256 internal constant MAX_BODY_BYTES = 16_384;

    /// @dev The most the two block numbers and the text between them can add to a body:
    /// twenty digits each for a uint64, eleven bytes of `,"toBlock":` and the closing brace.
    uint256 internal constant WINDOW_MAX_BYTES = 52;

    /// @dev What every canonical question document ends with before its two block numbers.
    bytes internal constant PREFIX_END = '"v":1,"window":{"fromBlock":';

    /// @dev What the canonical document of a question judged by a panel always holds: the oracle
    /// hashes `evidence` only when it is `"panel"`. A chain-evidence document holds these bytes
    /// only if its definitions happen to have that very key and value.
    bytes18 internal constant PANEL_EVIDENCE = '"evidence":"panel"';

    /// @notice The part the body and the hashed document share: everything up to the brace that
    /// closes `window`.
    function shared(bytes memory qPrefix, uint64 fromBlock, uint64 toBlock) internal pure returns (bytes memory) {
        return
            bytes.concat(
                qPrefix, bytes(Strings.toString(fromBlock)), ',"toBlock":', bytes(Strings.toString(toBlock)), "}"
            );
    }

    /// @notice The request body for one window.
    function body(bytes memory qPrefix, bytes memory tail, uint64 fromBlock, uint64 toBlock)
        internal
        pure
        returns (bytes memory)
    {
        return bytes.concat(shared(qPrefix, fromBlock, toBlock), tail);
    }

    /// @notice The hash the oracle signs for one window of this question.
    function questionHash(bytes memory qPrefix, uint64 fromBlock, uint64 toBlock) internal pure returns (bytes32) {
        return keccak256(bytes.concat(shared(qPrefix, fromBlock, toBlock), "}"));
    }

    /// @notice What a canonical question document for this answer type and chain begins with.
    /// @dev `answerType` and `chainId` sort before every other key the oracle hashes, so a prefix
    /// that begins any other way cannot be the canonical document for the feed's parameters.
    function prefixStart(uint8 answerType, uint256 chainId) internal pure returns (bytes memory) {
        return bytes.concat(
            '{"answerType":"', bytes(answerTypeName(answerType)), '","chainId":', bytes(Strings.toString(chainId)), ","
        );
    }

    /// @notice The protocol's name for an answer type code, as request bodies spell it.
    function answerTypeName(uint8 answerType) internal pure returns (string memory) {
        if (answerType == 0) return "bool";
        if (answerType == 1) return "address";
        if (answerType == 2) return "bytes32";
        if (answerType == 3) return "uint256";
        if (answerType == 4) return "address[]";
        return "bytes32[]";
    }

    function startsWith(bytes calldata text, bytes memory start) internal pure returns (bool) {
        return text.length >= start.length && keccak256(text[:start.length]) == keccak256(start);
    }

    function endsWith(bytes calldata text, bytes memory end) internal pure returns (bool) {
        return text.length >= end.length && keccak256(text[text.length - end.length:]) == keccak256(end);
    }

    /// @notice Whether `text` holds the bytes `"evidence":"panel"` anywhere.
    /// @dev How a panel-evidence question is told from its canonical document. Inside a JSON string
    /// a quote is written `\"`, so these bytes cannot occur in a question's own wording, only as a
    /// key and its value.
    ///
    /// The search looks at each position once: the next eighteen bytes of calldata against the
    /// eighteen wanted. Every position tried lies at least eighteen bytes before the end of `text`,
    /// so nothing outside `text` is ever compared.
    function holdsPanelEvidence(bytes calldata text) internal pure returns (bool found) {
        uint256 n = PANEL_EVIDENCE.length;
        if (text.length < n) return false;
        bytes32 wanted = PANEL_EVIDENCE;
        uint256 spare = 8 * (32 - n);
        assembly ("memory-safe") {
            let at := text.offset
            let end := add(at, add(sub(text.length, n), 1))
            wanted := shr(spare, wanted)
            for {} lt(at, end) { at := add(at, 1) } {
                if eq(shr(spare, calldataload(at)), wanted) {
                    found := 1
                    break
                }
            }
        }
    }

    /// @notice Whether `text` holds `key` followed by exactly the decimal `value` and then a comma
    /// or a closing brace, as in `"quorum":5,`.
    /// @dev A check that the numbers a feed enforces are the numbers its body asks for. It reads
    /// bytes, it does not parse JSON: a feed's creator still answers for the rest of the text.
    function hasNumber(bytes calldata text, bytes memory key, uint256 value) internal pure returns (bool) {
        bytes memory want = bytes.concat(key, bytes(Strings.toString(value)));
        uint256 n = want.length;
        if (text.length <= n) return false;
        bytes32 wanted = keccak256(want);
        bytes1 first = want[0];
        uint256 last = text.length - n;
        for (uint256 i; i < last; ++i) {
            if (text[i] != first) continue;
            bytes1 next = text[i + n];
            if ((next == "," || next == "}") && keccak256(text[i:i + n]) == wanted) return true;
        }
        return false;
    }
}
