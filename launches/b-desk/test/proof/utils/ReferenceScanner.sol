// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkProof} from "../../../src/interfaces/IWorkProof.sol";

/// @notice A second implementation of `WorkProof.scan`, written to be obviously right instead of
/// cheap: one byte at a time, bounds-checked array reads, no assembly in the parser, no shared code
/// with `JsonScan`. The differential tests feed both the same bytes, valid or mangled, and require
/// the same answer or the same error.
/// @dev It walks strings unit by unit (a backslash consumes the next byte), which is the textbook
/// rule; `JsonScan` looks for quotes and counts the backslashes in front of them. That the two agree
/// on every input the fuzzer finds is the evidence for the parity argument in `JsonScan`.
contract ReferenceScanner {
    bytes internal constant KEY_JOB_ID = "jobId";
    bytes internal constant KEY_KIND = "kind";
    bytes internal constant KEY_OBJECTIVE = "objective";
    bytes internal constant KEY_SCHEMA = "schema";
    bytes internal constant KEY_SIGNALS = "signals";
    bytes internal constant KEY_STATE = "state";
    bytes internal constant SCHEMA = "identitymd-work-v1";
    bytes internal constant AGENT_PREFIX = '{"agentId":"';
    bytes internal constant REJECTED_SUFFIX = ',"value":0}';

    struct Found {
        bytes16 jobId;
        bool hasJobId;
        bool hasKind;
        bool hasObjective;
        bool hasSchema;
        uint256 kindAt;
        uint256 kindLen;
        uint256 objectiveAt;
        uint256 objectiveLen;
        uint256 signalsAt;
        uint256 signalsLen;
        uint256 stateAt;
        uint256 stateLen;
    }

    function scan(bytes calldata record, uint256 headLen)
        external
        pure
        returns (bytes16 jobId, IWorkProof.Proof memory proof)
    {
        bytes memory r = record;
        Found memory f = _topLevel(r);
        if (headLen > f.objectiveLen) revert IWorkProof.HeadTooLong();

        jobId = f.jobId;
        proof.recordHash = keccak256(r);
        proof.kindHash = keccak256(_slice(r, f.kindAt, f.kindLen));
        proof.headHash = keccak256(_slice(r, f.objectiveAt, headLen));
        proof.specHash = keccak256(_slice(r, f.objectiveAt + headLen, f.objectiveLen - headLen));
        proof.stateHash = keccak256(_slice(r, f.stateAt, f.stateLen));
        proof.agentIds = _agentIds(_slice(r, f.signalsAt, f.signalsLen));
    }

    function _topLevel(bytes memory r) internal pure returns (Found memory f) {
        uint256 n = r.length;
        if (n == 0 || r[0] != "{") revert IWorkProof.Malformed(0);
        if (r[n - 1] != "}") revert IWorkProof.Malformed(n - 1);
        if (r[1] == "}") revert IWorkProof.MissingKey();

        uint256 i = 1;
        bytes memory prev = "";
        while (true) {
            // key: at most 31 printable ASCII bytes, no backslash, ended by the first quote
            if (i >= n || r[i] != '"') revert IWorkProof.Malformed(i);
            uint256 keyAt = i + 1;
            uint256 e = keyAt;
            bool valid = false;
            while (e < n && e - keyAt <= 31) {
                bytes1 b = r[e];
                if (b == '"') {
                    valid = e > keyAt;
                    break;
                }
                if (b == "\\" || uint8(b) < 0x20 || uint8(b) > 0x7f) break;
                ++e;
            }
            if (!valid) revert IWorkProof.Malformed(i);
            bytes memory key = _slice(r, keyAt, e - keyAt);
            if (!_less(prev, key)) revert IWorkProof.Malformed(i);
            if (_less(KEY_STATE, key)) revert IWorkProof.MissingKey();
            prev = key;

            i = e + 1;
            if (i >= n || r[i] != ":") revert IWorkProof.Malformed(i);
            ++i;
            if (i >= n) revert IWorkProof.Malformed(n);

            // value
            uint256 v = i;
            bytes1 c = r[v];
            if (c == '"') {
                i = _afterString(r, v);
            } else if (c == "{" || c == "[") {
                i = _afterNested(r, v);
            } else {
                while (_isLiteralByte(r[i])) ++i; // the last byte is `}`, so this stops in bounds
                if (i == v) revert IWorkProof.Malformed(v);
            }

            // capture
            if (_eq(key, KEY_SIGNALS)) {
                if (c == "[") {
                    f.signalsAt = v;
                    f.signalsLen = i - v;
                }
            } else if (
                _eq(key, KEY_JOB_ID) || _eq(key, KEY_KIND) || _eq(key, KEY_OBJECTIVE) || _eq(key, KEY_SCHEMA)
                    || _eq(key, KEY_STATE)
            ) {
                if (c != '"') revert IWorkProof.Malformed(v);
                uint256 at = v + 1;
                uint256 len = i - v - 2;
                if (_eq(key, KEY_JOB_ID)) {
                    (bool ok, bytes16 id) = _uuid(_slice(r, at, len));
                    if (!ok) revert IWorkProof.Malformed(v);
                    f.jobId = id;
                    f.hasJobId = true;
                } else if (_eq(key, KEY_KIND)) {
                    (f.kindAt, f.kindLen, f.hasKind) = (at, len, true);
                } else if (_eq(key, KEY_OBJECTIVE)) {
                    (f.objectiveAt, f.objectiveLen, f.hasObjective) = (at, len, true);
                } else if (_eq(key, KEY_SCHEMA)) {
                    if (!_eq(_slice(r, at, len), SCHEMA)) revert IWorkProof.WrongSchema();
                    f.hasSchema = true;
                } else {
                    if (!(f.hasJobId && f.hasKind && f.hasObjective && f.hasSchema)) revert IWorkProof.MissingKey();
                    (f.stateAt, f.stateLen) = (at, len);
                    return f;
                }
            }

            // separator
            if (i >= n) revert IWorkProof.Malformed(n);
            if (r[i] == "}") revert IWorkProof.MissingKey();
            if (r[i] != ",") revert IWorkProof.Malformed(i);
            ++i;
        }
    }

    /// @dev `at` is on an opening quote; returns the index after the closing one.
    function _afterString(bytes memory r, uint256 at) internal pure returns (uint256 j) {
        uint256 n = r.length;
        j = at + 1;
        while (true) {
            if (j >= n) revert IWorkProof.Malformed(n);
            if (r[j] == "\\") {
                j += 2;
            } else if (r[j] == '"') {
                break;
            } else {
                ++j;
            }
        }
        ++j;
    }

    /// @dev `at` is on `{` or `[`; returns the index after the matching closer.
    function _afterNested(bytes memory r, uint256 at) internal pure returns (uint256) {
        uint256 n = r.length;
        uint256 depth = 0;
        uint256 j = at;
        while (j < n) {
            bytes1 c = r[j];
            if (c == '"') {
                j = _afterString(r, j);
                continue;
            }
            if (c == "{" || c == "[") {
                ++depth;
            } else if (c == "}" || c == "]") {
                --depth;
                if (depth == 0) return j + 1;
            }
            ++j;
        }
        revert IWorkProof.Malformed(n);
    }

    /// @dev The soft parse of `signals`: any surprise gives the empty list.
    function _agentIds(bytes memory s) internal pure returns (uint256[] memory) {
        uint256[] memory none = new uint256[](0);
        if (s.length <= 2) return none;
        uint256[] memory ids = new uint256[](16);
        uint256 count = 0;
        uint256 j = 1;
        while (true) {
            if (!_startsWith(s, j, AGENT_PREFIX)) return none;
            (bool closed, uint256 next) = _softAfterNested(s, j);
            if (!closed || next >= s.length) return none;

            uint256 d = j + AGENT_PREFIX.length;
            uint256 id = 0;
            uint256 digits = 0;
            while (d < s.length && uint8(s[d]) >= 0x30 && uint8(s[d]) <= 0x39) {
                if (digits == 77) return none;
                id = id * 10 + (uint8(s[d]) - 0x30);
                ++digits;
                ++d;
            }
            if (digits == 0 || d >= s.length || s[d] != '"') return none;

            // An element whose last member is `"value":0` records a rejected submission: it is
            // read like any other and then not counted. `d` is on the id's closing quote, so the
            // member has to begin after it.
            bool rejected = next >= d + 1 + REJECTED_SUFFIX.length && _endsWith(s, next, REJECTED_SUFFIX);

            bool known = rejected;
            for (uint256 k = 0; k < count; ++k) {
                if (ids[k] == id) known = true;
            }
            if (!known) {
                ids[count++] = id;
                if (count == 16) return ids;
            }

            if (s[next] == "]" && next + 1 == s.length) break;
            if (s[next] != ",") return none;
            j = next + 1;
        }
        uint256[] memory out = new uint256[](count);
        for (uint256 k = 0; k < count; ++k) {
            out[k] = ids[k];
        }
        return out;
    }

    /// @dev Like `_afterNested`, but reports failure instead of reverting.
    function _softAfterNested(bytes memory s, uint256 at) internal pure returns (bool, uint256) {
        uint256 n = s.length;
        uint256 depth = 0;
        uint256 j = at;
        while (j < n) {
            bytes1 c = s[j];
            if (c == '"') {
                ++j;
                while (true) {
                    if (j >= n) return (false, 0);
                    if (s[j] == "\\") {
                        j += 2;
                    } else if (s[j] == '"') {
                        break;
                    } else {
                        ++j;
                    }
                }
            } else if (c == "{" || c == "[") {
                ++depth;
            } else if (c == "}" || c == "]") {
                if (depth == 0) return (false, 0);
                --depth;
                if (depth == 0) return (true, j + 1);
            }
            ++j;
        }
        return (false, 0);
    }

    function _isLiteralByte(bytes1 b) internal pure returns (bool) {
        uint8 c = uint8(b);
        return c == 0x2b || c == 0x2d || c == 0x2e || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)
            || (c >= 0x61 && c <= 0x7a);
    }

    function _uuid(bytes memory t) internal pure returns (bool, bytes16) {
        if (t.length != 36) return (false, 0);
        uint128 acc = 0;
        for (uint256 i = 0; i < 36; ++i) {
            uint8 c = uint8(t[i]);
            if (i == 8 || i == 13 || i == 18 || i == 23) {
                if (c != 0x2d) return (false, 0);
            } else if (c >= 0x30 && c <= 0x39) {
                acc = (acc << 4) | (c - 0x30);
            } else if (c >= 0x61 && c <= 0x66) {
                acc = (acc << 4) | (c - 0x57);
            } else {
                return (false, 0);
            }
        }
        return (true, bytes16(acc));
    }

    /// @dev Whether the bytes of `s` that end just before index `end` are `suffix`.
    function _endsWith(bytes memory s, uint256 end, bytes memory suffix) internal pure returns (bool) {
        if (end > s.length || suffix.length > end) return false;
        for (uint256 i = 0; i < suffix.length; ++i) {
            if (s[end - suffix.length + i] != suffix[i]) return false;
        }
        return true;
    }

    function _startsWith(bytes memory s, uint256 at, bytes memory prefix) internal pure returns (bool) {
        if (at + prefix.length > s.length) return false;
        for (uint256 i = 0; i < prefix.length; ++i) {
            if (s[at + i] != prefix[i]) return false;
        }
        return true;
    }

    /// @dev Byte order, shorter first when one is a prefix of the other.
    function _less(bytes memory a, bytes memory b) internal pure returns (bool) {
        uint256 n = a.length < b.length ? a.length : b.length;
        for (uint256 i = 0; i < n; ++i) {
            if (a[i] != b[i]) return a[i] < b[i];
        }
        return a.length < b.length;
    }

    function _eq(bytes memory a, bytes memory b) internal pure returns (bool) {
        return a.length == b.length && keccak256(a) == keccak256(b);
    }

    function _slice(bytes memory data, uint256 from, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = data[from + i];
        }
    }
}
