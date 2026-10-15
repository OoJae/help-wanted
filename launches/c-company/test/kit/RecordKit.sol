// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice A small canonical-JSON helper for tests: swaps the value of top-level members of a work
/// record and leaves everything else byte for byte as it was.
///
/// @dev A work record is canonical JSON: one object, keys in ascending order, no whitespace. Such a
/// document stays canonical when the value of an existing member is replaced by another value that
/// is itself canonical, because no key moves and no byte outside the value changes. That is all
/// this library does. It lets a test take a real record, as IdentityMD served it, and give it the
/// objective a runner of ours would have sent (the order header and the spec), so that the real
/// WorkProof reads a real record's shape and bulk with our text in it.
///
/// It is test code and deliberately plain: one walk over the top level, a byte at a time, written
/// separately from the hire desk's own scanner so that the two can disagree. Tests reach it through
/// `RecordMaker`, a contract, so that this code is compiled once and not into every test.
///
/// Copied from the hire desk's repository (launch B, `test/kit/RecordKit.sol`); only this comment
/// differs. Here it serves the fork suite, which settles a rule's order on the live desk.
library RecordKit {
    /// @dev One replacement: the member `key` gets the raw JSON text `value` (quotes included for a
    /// string).
    struct Edit {
        string key;
        bytes value;
    }

    bytes16 private constant HEX = "0123456789abcdef";

    /// @dev Where the walk and the copy stand. Kept in memory, not in local variables: the walk has
    /// more of them than the compiler's stack holds comfortably, and whether it fits there depends
    /// on what else is compiled alongside.
    struct Cursor {
        /// Bytes written to the output.
        uint256 written;
        /// Bytes of the record already carried over.
        uint256 copied;
        /// Edits applied so far.
        uint256 applied;
    }

    /// @notice `record` with each edited member's value replaced. Reverts if a key is not a
    /// top-level member of the record, or if the record is not one object.
    function swap(bytes memory record, Edit[] memory edits) internal pure returns (bytes memory out) {
        uint256 n = record.length;
        require(n >= 2 && record[0] == "{" && record[n - 1] == "}", "RecordKit: not an object");

        // Worst case for the output: every edit adds its whole value.
        uint256 room = n;
        for (uint256 e = 0; e < edits.length; ++e) {
            room += edits[e].value.length;
        }
        out = new bytes(room);
        Cursor memory at;

        uint256 i = 1;
        while (true) {
            require(_at(record, i) == 0x22, "RecordKit: key expected");
            uint256 keyStart = i + 1;
            i = _stringEnd(record, i);
            require(_at(record, i + 1) == 0x3a, "RecordKit: colon expected");
            uint256 valueStart = i + 2;
            uint256 keyLen = i - keyStart;
            i = _valueEnd(record, valueStart);
            _applyEdit(out, at, record, edits, keyStart, keyLen, valueStart, i);

            uint8 c = _at(record, i);
            if (c == 0x7d) {
                require(i == n - 1, "RecordKit: bytes after the object");
                break;
            }
            require(c == 0x2c, "RecordKit: comma expected");
            ++i;
        }
        require(at.applied == edits.length, "RecordKit: a key to edit is not in the record");
        uint256 written = _copy(out, at.written, record, at.copied, n - at.copied);
        assembly ("memory-safe") {
            mstore(out, written)
        }
    }

    /// @dev If the member whose key sits at `keyStart` is one to edit: carries over the record up
    /// to its value, writes the new value, and moves the cursor past the old one.
    function _applyEdit(
        bytes memory out,
        Cursor memory at,
        bytes memory record,
        Edit[] memory edits,
        uint256 keyStart,
        uint256 keyLen,
        uint256 valueStart,
        uint256 valueEnd
    ) private pure {
        for (uint256 e = 0; e < edits.length; ++e) {
            if (_same(record, keyStart, keyLen, bytes(edits[e].key))) {
                at.written = _copy(out, at.written, record, at.copied, valueStart - at.copied);
                at.written = _copy(out, at.written, edits[e].value, 0, edits[e].value.length);
                at.copied = valueEnd;
                ++at.applied;
                return;
            }
        }
    }

    /// @notice The raw JSON text of a top-level member's value (quotes included for a string).
    function valueOf(bytes memory record, string memory key) internal pure returns (bytes memory out) {
        uint256 n = record.length;
        require(n >= 2 && record[0] == "{" && record[n - 1] == "}", "RecordKit: not an object");
        uint256 i = 1;
        while (true) {
            uint256 keyStart = i + 1;
            i = _stringEnd(record, i);
            uint256 valueStart = i + 2;
            uint256 valueEnd = _valueEnd(record, valueStart);
            if (_same(record, keyStart, i - keyStart, bytes(key))) {
                out = new bytes(valueEnd - valueStart);
                _copy(out, 0, record, valueStart, valueEnd - valueStart);
                return out;
            }
            i = valueEnd;
            require(_at(record, i) == 0x2c, "RecordKit: no such member");
            ++i;
        }
    }

    // --- values, written the canonical way ----------------------------------------------------

    /// @dev A JSON string for text that needs no escaping (no `"`, no `\`, nothing below 0x20):
    /// the only kind of text the tests put into a record.
    function str(bytes memory plain) internal pure returns (bytes memory) {
        for (uint256 i = 0; i < plain.length; ++i) {
            uint8 c = uint8(plain[i]);
            require(c >= 0x20 && c != 0x22 && c != 0x5c, "RecordKit: text would need escaping");
        }
        return abi.encodePacked('"', plain, '"');
    }

    /// @dev A job id as the JSON string of its lowercase UUID.
    function uuid(bytes16 id) internal pure returns (bytes memory out) {
        out = new bytes(38);
        out[0] = '"';
        uint256 n = 1;
        for (uint256 i = 0; i < 16; ++i) {
            if (i == 4 || i == 6 || i == 8 || i == 10) out[n++] = "-";
            uint8 b = uint8(id[i]);
            out[n++] = HEX[b >> 4];
            out[n++] = HEX[b & 0x0f];
        }
        out[n] = '"';
    }

    /// @dev What follows the agent id in a real signal: the other six members, in canonical order,
    /// for an accepted submission.
    bytes private constant SIGNAL_TAIL =
        '","feedbackHash":"cf3d6ec17c1ac1e69c55794c93041a03104c625b96fe3cb3a96066374c700b19","nodeKey":"work","submissionHash":"070eb28667d2284eab970b884eed740e0d467d143571e2859ca3d9fa3c10534f","tag1":"verification:structural","tag2":"acceptance-v2","value":1}';

    /// @dev A `signals` array naming `agentIds`, one accepted signal each, with the seven members
    /// a real signal has, in their canonical order.
    function signals(uint256[] memory agentIds) internal pure returns (bytes memory out) {
        out = "[";
        for (uint256 i = 0; i < agentIds.length; ++i) {
            if (i != 0) out = bytes.concat(out, ",");
            out = bytes.concat(out, '{"agentId":"', _dec(agentIds[i]), SIGNAL_TAIL);
        }
        out = bytes.concat(out, "]");
    }

    // --- the walk -----------------------------------------------------------------------------

    function _at(bytes memory data, uint256 i) private pure returns (uint8 c) {
        require(i < data.length, "RecordKit: ran off the end");
        assembly ("memory-safe") {
            c := byte(0, mload(add(add(data, 0x20), i)))
        }
    }

    /// @dev `i` is at an opening quote; returns the index of the closing one. The loop is written
    /// in assembly only because records hold kilobytes of text and the tests build thousands of
    /// them; it does what it says a byte at a time: a backslash skips the byte after it, a quote ends.
    function _stringEnd(bytes memory data, uint256 i) private pure returns (uint256 j) {
        require(_at(data, i) == 0x22, "RecordKit: string expected");
        uint256 n = data.length;
        j = i + 1;
        assembly ("memory-safe") {
            let base := add(data, 0x20)
            for {} lt(j, n) {} {
                let c := byte(0, mload(add(base, j)))
                if eq(c, 0x22) { break }
                j := add(j, add(1, eq(c, 0x5c)))
            }
        }
        require(j < n, "RecordKit: ran off the end");
    }

    /// @dev `i` is at the first byte of a value; returns the index one past its last byte.
    function _valueEnd(bytes memory data, uint256 i) private pure returns (uint256 j) {
        uint8 c = _at(data, i);
        if (c == 0x22) return _stringEnd(data, i) + 1;
        j = i;
        if (c == 0x7b || c == 0x5b) {
            uint256 depth = 0;
            while (true) {
                c = _at(data, j);
                if (c == 0x22) {
                    j = _stringEnd(data, j);
                } else if (c == 0x7b || c == 0x5b) {
                    ++depth;
                } else if (c == 0x7d || c == 0x5d) {
                    if (--depth == 0) return j + 1;
                }
                ++j;
            }
        }
        // A number, true, false or null: up to the next comma or the closing brace.
        while (c != 0x2c && c != 0x7d) {
            c = _at(data, ++j);
        }
    }

    function _same(bytes memory data, uint256 from, uint256 len, bytes memory other) private pure returns (bool same) {
        if (len != other.length) return false;
        assembly ("memory-safe") {
            same := eq(keccak256(add(add(data, 0x20), from), len), keccak256(add(other, 0x20), len))
        }
    }

    function _copy(bytes memory to, uint256 at, bytes memory from, uint256 start, uint256 len)
        private
        pure
        returns (uint256)
    {
        require(start + len <= from.length && at + len <= to.length, "RecordKit: copy out of range");
        assembly ("memory-safe") {
            mcopy(add(add(to, 0x20), at), add(add(from, 0x20), start), len)
        }
        return at + len;
    }

    function _dec(uint256 value) private pure returns (bytes memory out) {
        if (value == 0) return "0";
        uint256 digits = 0;
        for (uint256 v = value; v != 0; v /= 10) {
            ++digits;
        }
        out = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) {
            out[--digits] = bytes1(uint8(0x30 + (v % 10)));
        }
    }
}
