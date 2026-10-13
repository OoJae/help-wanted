// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice A canonical JSON writer in Solidity, for tests: the same rules as IdentityMD's
/// `canonicalize` (keys sorted, no whitespace, strings as `JSON.stringify` writes them, UTF-8 left
/// raw). The differential fuzz test builds records with it and checks the scanner against what the
/// writer knows it wrote.
library CanonicalJson {
    bytes16 private constant HEX = "0123456789abcdef";

    /// @dev What `JSON.stringify` puts between the quotes for the text `s`: `"` and `\` get a
    /// backslash, the five short escapes are used where they exist, other bytes below 0x20 become
    /// `\u00XX`, and everything else (0x7F and all UTF-8 bytes included) is copied as it is.
    function escape(bytes memory s) internal pure returns (bytes memory out) {
        out = new bytes(s.length * 6);
        uint256 n = 0;
        for (uint256 i = 0; i < s.length; ++i) {
            uint8 c = uint8(s[i]);
            if (c == 0x22 || c == 0x5c) {
                out[n++] = "\\";
                out[n++] = bytes1(c);
            } else if (c >= 0x20) {
                out[n++] = bytes1(c);
            } else {
                out[n++] = "\\";
                if (c == 0x08) {
                    out[n++] = "b";
                } else if (c == 0x09) {
                    out[n++] = "t";
                } else if (c == 0x0a) {
                    out[n++] = "n";
                } else if (c == 0x0c) {
                    out[n++] = "f";
                } else if (c == 0x0d) {
                    out[n++] = "r";
                } else {
                    out[n++] = "u";
                    out[n++] = "0";
                    out[n++] = "0";
                    out[n++] = HEX[c >> 4];
                    out[n++] = HEX[c & 0x0f];
                }
            }
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    /// @dev A JSON string for the text `s`.
    function str(bytes memory s) internal pure returns (bytes memory) {
        return abi.encodePacked('"', escape(s), '"');
    }

    /// @dev An array of already-written values.
    function array(bytes[] memory values) internal pure returns (bytes memory out) {
        out = "[";
        for (uint256 i = 0; i < values.length; ++i) {
            out = abi.encodePacked(out, i == 0 ? "" : ",", values[i]);
        }
        out = abi.encodePacked(out, "]");
    }

    /// @dev An object. `keys` are plain text (the writer escapes them); `values` are already
    /// written. Members are emitted in ascending byte order of their keys, and a repeated key is
    /// refused, as it could never come out of a real object.
    function object(bytes[] memory keys, bytes[] memory values) internal pure returns (bytes memory out) {
        require(keys.length == values.length, "keys and values differ in number");
        uint256 n = keys.length;
        uint256[] memory order = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 j = i;
            while (j > 0 && less(keys[i], keys[order[j - 1]])) {
                order[j] = order[j - 1];
                --j;
            }
            order[j] = i;
        }
        out = "{";
        for (uint256 i = 0; i < n; ++i) {
            if (i > 0) require(less(keys[order[i - 1]], keys[order[i]]), "repeated key");
            out = abi.encodePacked(out, i == 0 ? "" : ",", str(keys[order[i]]), ":", values[order[i]]);
        }
        out = abi.encodePacked(out, "}");
    }

    /// @dev Byte order, a prefix before anything it prefixes.
    function less(bytes memory a, bytes memory b) internal pure returns (bool) {
        uint256 n = a.length < b.length ? a.length : b.length;
        for (uint256 i = 0; i < n; ++i) {
            if (a[i] != b[i]) return a[i] < b[i];
        }
        return a.length < b.length;
    }

    /// @dev `id` as the 36 characters of a lowercase UUID.
    function uuid(bytes16 id) internal pure returns (bytes memory out) {
        out = new bytes(36);
        uint256 n = 0;
        for (uint256 i = 0; i < 16; ++i) {
            if (i == 4 || i == 6 || i == 8 || i == 10) out[n++] = "-";
            uint8 b = uint8(id[i]);
            out[n++] = HEX[b >> 4];
            out[n++] = HEX[b & 0x0f];
        }
    }

    /// @dev `value` in decimal.
    function dec(uint256 value) internal pure returns (bytes memory out) {
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

    /// @dev 64 lowercase hex characters.
    function hex64(bytes32 value) internal pure returns (bytes memory out) {
        out = new bytes(64);
        for (uint256 i = 0; i < 32; ++i) {
            uint8 b = uint8(value[i]);
            out[2 * i] = HEX[b >> 4];
            out[2 * i + 1] = HEX[b & 0x0f];
        }
    }
}
