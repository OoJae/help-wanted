// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {QuestionBody} from "../../src/questions/QuestionBody.sol";
import {CanonicalQuestion} from "./lib/CanonicalQuestion.sol";

/// @title The question-hash rule, checked against what the oracle really signed
/// @notice `test/fixtures/questions/requests` holds 23 attested oracle requests as the protocol's
/// API served them, and `intake/requested.json` three request bodies read back from the Intake's
/// `Requested` events. For each one the canonical document is rebuilt from the raw JSON, handed to
/// the builder `Questions` uses, and the result compared with the attested `questionHash`.
///
/// What the fixtures settled (the rule first given to this project was close but not exact):
/// - `definitions` is part of the document only when the request has it. A request without
///   definitions hashes without the key, not with an empty object.
/// - `head` is part of the document when the request has it. Every list-typed request does.
/// - `guards`, `toleranceBps`, `panelSize`, `quorum`, `validForSeconds`, `consumer` and
///   `allowAmbiguous` are not part of it.
/// - The oracle hashes the text as it was sent, on chain or over HTTP: nothing is trimmed,
///   re-cased or re-encoded, and an `hours` window is hashed as the blocks it was pinned to.
contract QuestionHashFixturesTest is Test {
    string internal constant DIR = "test/fixtures/questions/";

    function _request(string memory id) internal view returns (string memory) {
        return vm.readFile(string.concat(DIR, "requests/", id, ".json"));
    }

    function _rebuild(string memory questionJson, string memory windowJson) internal view returns (bytes32) {
        return QuestionBody.questionHash(
            CanonicalQuestion.prefix(questionJson),
            uint64(vm.parseJsonUint(windowJson, ".window.fromBlock")),
            uint64(vm.parseJsonUint(windowJson, ".window.toBlock"))
        );
    }

    function _is(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /// @notice Every fixture's hash is rebuilt, from the request as the API shows it.
    function test_everyAttestedQuestionHashIsRebuilt() public view {
        string memory index = vm.readFile(string.concat(DIR, "requests/index.json"));
        string[] memory ids = vm.parseJsonStringArray(index, ".ids");
        assertGe(ids.length, 10, "fewer than ten attested requests");
        assertEq(ids.length, vm.parseJsonUint(index, ".count"));
        for (uint256 i; i < ids.length; ++i) {
            string memory json = _request(ids[i]);
            assertEq(vm.parseJsonString(json, ".id"), ids[i]);
            assertEq(vm.parseJsonString(json, ".status"), "attested");
            bytes32 rebuilt = _rebuild(json, json);
            assertEq(rebuilt, vm.parseJsonBytes32(json, ".questionHash"), ids[i]);
            assertEq(rebuilt, vm.parseJsonBytes32(json, ".attestation.questionHash"), ids[i]);
            assertEq(rebuilt, vm.parseJsonBytes32(index, string.concat(".requests[", vm.toString(i), "].questionHash")));
        }
    }

    /// @notice The fixtures cover what the product asks: bool, uint256 and list answers; log-sum,
    /// log-count and log-rank recipes; Ethereum and Robinhood Chain; requests with and without
    /// definitions, with `head`, with guards.
    function test_fixturesCoverEveryShapeTheFeedsUse() public view {
        string memory index = vm.readFile(string.concat(DIR, "requests/index.json"));
        uint256 n = vm.parseJsonUint(index, ".count");
        uint256[10] memory seen;
        for (uint256 i; i < n; ++i) {
            string memory at = string.concat(".requests[", vm.toString(i), "]");
            string memory answerType = vm.parseJsonString(index, string.concat(at, ".answerType"));
            if (_is(answerType, "bool")) seen[0]++;
            if (_is(answerType, "uint256")) seen[1]++;
            if (_is(answerType, "address[]") || _is(answerType, "bytes32[]")) seen[2]++;
            if (_is(vm.parseJsonString(index, string.concat(at, ".evidence")), "chain")) {
                string memory recipe = vm.parseJsonString(index, string.concat(at, ".recipe"));
                if (_is(recipe, "log-sum")) seen[3]++;
                if (_is(recipe, "log-count")) seen[4]++;
                if (_is(recipe, "log-rank")) seen[5]++;
            }
            uint256 chainId = vm.parseJsonUint(index, string.concat(at, ".chainId"));
            if (chainId == 1) seen[6]++;
            if (chainId == 4663) seen[7]++;
            if (!vm.parseJsonBool(index, string.concat(at, ".hasDefinitions"))) seen[8]++;
            if (vm.parseJsonBool(index, string.concat(at, ".hasGuards"))) seen[9]++;
        }
        string[10] memory what = [
            "bool",
            "uint256",
            "list",
            "log-sum",
            "log-count",
            "log-rank",
            "Ethereum",
            "Robinhood Chain",
            "no definitions",
            "guards"
        ];
        for (uint256 k; k < seen.length; ++k) {
            assertGt(seen[k], 0, what[k]);
        }
    }

    /// @notice The same hash comes out of the bytes a payer sent to the Intake on chain: one body a
    /// contract built on Robinhood Chain (a pinned log-sum, the model for the house feeds) and two
    /// sent on Ethereum, one of them with an `hours` window the oracle pinned to blocks itself.
    function test_hashIsRebuiltFromBodiesSentOnChain() public view {
        string memory sent = vm.readFile(string.concat(DIR, "intake/requested.json"));
        uint256 n = vm.parseJsonUint(sent, ".count");
        assertEq(n, 3);
        for (uint256 i; i < n; ++i) {
            string memory at = string.concat(".requests[", vm.toString(i), "]");
            string memory body = vm.parseJsonString(sent, string.concat(at, ".body"));
            assertEq(keccak256(bytes(body)), keccak256(vm.parseJsonBytes(sent, string.concat(at, ".bodyHex"))));
            string memory attested = _request(vm.parseJsonString(sent, string.concat(at, ".oracleRequestId")));
            // The question comes from the on-chain bytes; only the pinned window is the oracle's.
            assertEq(_rebuild(body, attested), vm.parseJsonBytes32(attested, ".questionHash"));
        }
    }

    /// @notice Without the two refinements the rule does not hold: a request with no definitions
    /// does not hash with an empty `definitions` object, and a list request does not hash without
    /// its `head`.
    function test_theRuleNeedsBothRefinements() public view {
        // a4d33e90: an address[] log-rank with head 1 and no definitions.
        string memory json = _request("a4d33e90-1c2c-49bd-a4aa-2d8e3f6570f3");
        assertFalse(vm.keyExistsJson(json, ".definitions"));
        assertEq(vm.parseJsonUint(json, ".head"), 1);
        uint64 fromBlock = uint64(vm.parseJsonUint(json, ".window.fromBlock"));
        uint64 toBlock = uint64(vm.parseJsonUint(json, ".window.toBlock"));
        bytes32 attested = vm.parseJsonBytes32(json, ".questionHash");
        bytes memory start = '{"answerType":"address[]","chainId":1';
        bytes memory end = bytes.concat(
            ',"question":',
            CanonicalQuestion.quote(vm.parseJsonString(json, ".question")),
            ',"v":1,"window":{"fromBlock":'
        );

        assertEq(QuestionBody.questionHash(bytes.concat(start, ',"head":1', end), fromBlock, toBlock), attested);
        assertNotEq(QuestionBody.questionHash(bytes.concat(start, end), fromBlock, toBlock), attested, "without head");
        assertNotEq(
            QuestionBody.questionHash(bytes.concat(start, ',"definitions":{},"head":1', end), fromBlock, toBlock),
            attested,
            "with empty definitions"
        );
    }

    /// @notice The string writer escapes what `JSON.stringify` escapes and nothing else.
    function test_quoteFollowsJsonStringify() public pure {
        assertEq(CanonicalQuestion.quote('a"b'), bytes('"a\\"b"'));
        assertEq(CanonicalQuestion.quote("a\\b"), bytes('"a\\\\b"'));
        assertEq(CanonicalQuestion.quote("a\nb\tc\rd"), bytes('"a\\nb\\tc\\rd"'));
        assertEq(CanonicalQuestion.quote(string(hex"01081f0c")), bytes('"\\u0001\\b\\u001f\\f"'));
        assertEq(CanonicalQuestion.quote(unicode"«¿•–»"), bytes(unicode'"«¿•–»"'));
        assertEq(CanonicalQuestion.quote(""), bytes('""'));
    }
}
