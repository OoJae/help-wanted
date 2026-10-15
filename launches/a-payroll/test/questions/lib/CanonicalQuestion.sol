// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @title The oracle's canonical question document, rebuilt in a test from raw JSON
/// @notice Written against the rule and not against the contract: it takes a request as the API
/// or the chain shows it (any key order, any extra keys) and writes the document the oracle hashes,
/// up to the point where `QuestionBody` takes over. The fixtures test joins the two and compares
/// the result with what the oracle signed.
///
/// The document: keys sorted; no whitespace; strings as `JSON.stringify` writes them (only `"`,
/// `\` and control characters escaped, everything else raw UTF-8); `definitions` only when the
/// request has it; `evidence` only when it is `"panel"`; `head` only when the request has it.
library CanonicalQuestion {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice The canonical document up to and including `"window":{"fromBlock":`.
    function prefix(string memory json) internal view returns (bytes memory out) {
        out = bytes.concat(
            '{"answerType":',
            quote(vm.parseJsonString(json, ".answerType")),
            ',"chainId":',
            bytes(vm.toString(vm.parseJsonUint(json, ".chainId")))
        );
        if (vm.keyExistsJson(json, ".definitions")) {
            out = bytes.concat(out, ',"definitions":', definitions(json));
        }
        if (vm.keyExistsJson(json, ".evidence")) {
            if (keccak256(bytes(vm.parseJsonString(json, ".evidence"))) == keccak256("panel")) {
                out = bytes.concat(out, ',"evidence":"panel"');
            }
        }
        if (vm.keyExistsJson(json, ".head")) {
            out = bytes.concat(out, ',"head":', bytes(vm.toString(vm.parseJsonUint(json, ".head"))));
        }
        out = bytes.concat(
            out, ',"question":', quote(vm.parseJsonString(json, ".question")), ',"v":1,"window":{"fromBlock":'
        );
    }

    /// @notice The `definitions` object with its keys sorted.
    function definitions(string memory json) internal pure returns (bytes memory out) {
        string[] memory keys = vm.parseJsonKeys(json, ".definitions");
        sort(keys);
        out = "{";
        for (uint256 i; i < keys.length; ++i) {
            string memory value = vm.parseJsonString(json, string.concat(".definitions['", keys[i], "']"));
            out = bytes.concat(out, i == 0 ? bytes("") : bytes(","), quote(keys[i]), ":", quote(value));
        }
        out = bytes.concat(out, "}");
    }

    /// @notice A string as `JSON.stringify` writes it.
    function quote(string memory s) internal pure returns (bytes memory out) {
        bytes memory raw = bytes(s);
        out = '"';
        uint256 run;
        for (uint256 i; i < raw.length; ++i) {
            bytes1 c = raw[i];
            bytes memory escaped;
            if (c == '"') escaped = '\\"';
            else if (c == "\\") escaped = "\\\\";
            else if (c == 0x08) escaped = "\\b";
            else if (c == 0x0c) escaped = "\\f";
            else if (c == "\n") escaped = "\\n";
            else if (c == "\r") escaped = "\\r";
            else if (c == "\t") escaped = "\\t";
            else if (uint8(c) < 0x20) escaped = bytes.concat("\\u00", HEX[uint8(c) >> 4], HEX[uint8(c) & 0x0f]);
            else continue;
            out = bytes.concat(out, slice(raw, run, i), escaped);
            run = i + 1;
        }
        out = bytes.concat(out, slice(raw, run, raw.length), '"');
    }

    bytes16 private constant HEX = "0123456789abcdef";

    function slice(bytes memory data, uint256 start, uint256 end) internal pure returns (bytes memory out) {
        out = new bytes(end - start);
        for (uint256 i = start; i < end; ++i) {
            out[i - start] = data[i];
        }
    }

    /// @dev Byte order, which is JavaScript's `sort()` order for the ASCII keys requests use.
    function sort(string[] memory keys) internal pure {
        for (uint256 i = 1; i < keys.length; ++i) {
            string memory key = keys[i];
            uint256 j = i;
            while (j > 0 && less(bytes(key), bytes(keys[j - 1]))) {
                keys[j] = keys[j - 1];
                --j;
            }
            keys[j] = key;
        }
    }

    function less(bytes memory a, bytes memory b) internal pure returns (bool) {
        uint256 n = a.length < b.length ? a.length : b.length;
        for (uint256 i; i < n; ++i) {
            if (a[i] != b[i]) return a[i] < b[i];
        }
        return a.length < b.length;
    }
}
