// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CanonicalJson} from "./CanonicalJson.sol";

/// @notice Writes random work records in canonical form and remembers what it put at the top level.
/// @dev Everything a job participant could influence is filled with text built to mislead a careless
/// reader: strings holding quotes, backslashes and brackets, text shaped like top-level members and
/// like order headers, and nested objects whose keys are named `objective`, `state`, `jobId` and so
/// on. The writer escapes all of it the way `JSON.stringify` would, so none of it is at the top
/// level, and the truth returned here says so.
abstract contract RecordGen {
    struct Rng {
        uint256 state;
    }

    /// @dev A generated record and what its top level really holds. The `*Raw` fields are the bytes
    /// between the quotes, as written (escaped).
    struct Truth {
        bytes record;
        bytes16 jobId;
        bytes kindRaw;
        bytes objectiveRaw;
        bytes stateRaw;
        uint256[] agentIds;
    }

    uint256 internal constant MAX_AGENTS = 16;

    function _next(Rng memory rng) internal pure returns (uint256) {
        rng.state = uint256(keccak256(abi.encode(rng.state)));
        return rng.state;
    }

    function _below(Rng memory rng, uint256 n) internal pure returns (uint256) {
        return _next(rng) % n;
    }

    // ---------------------------------------------------------------- the record

    function _generate(uint256 seed) internal pure returns (Truth memory t) {
        Rng memory rng = Rng(seed);

        bytes[] memory keys = new bytes[](32);
        bytes[] memory values = new bytes[](32);
        uint256 n = 0;

        // The five members every record has.
        t.jobId = bytes16(bytes32(_next(rng)));
        (keys[n], values[n]) = (bytes("jobId"), CanonicalJson.str(CanonicalJson.uuid(t.jobId)));
        ++n;

        t.kindRaw = CanonicalJson.escape(_below(rng, 4) == 0 ? _text(rng, 24) : _plainKind(rng));
        (keys[n], values[n]) = (bytes("kind"), abi.encodePacked('"', t.kindRaw, '"'));
        ++n;

        bytes memory objective = _text(rng, 160);
        if (_below(rng, 2) == 0) objective = abi.encodePacked(_header(rng), objective);
        t.objectiveRaw = CanonicalJson.escape(objective);
        (keys[n], values[n]) = (bytes("objective"), abi.encodePacked('"', t.objectiveRaw, '"'));
        ++n;

        (keys[n], values[n]) = (bytes("schema"), bytes('"identitymd-work-v1"'));
        ++n;

        t.stateRaw = CanonicalJson.escape(_stateText(rng));
        (keys[n], values[n]) = (bytes("state"), abi.encodePacked('"', t.stateRaw, '"'));
        ++n;

        // `signals`, sometimes missing or not an array.
        (bool present, bytes memory signals, uint256[] memory ids) = _signals(rng);
        t.agentIds = ids;
        if (present) {
            (keys[n], values[n]) = (bytes("signals"), signals);
            ++n;
        }

        // The rest of the schema, each member present three times in four, with arbitrary values.
        string[18] memory others = [
            "assessments",
            "deployments",
            "fuzz",
            "identity",
            "interpretation",
            "nodes",
            "parentJobId",
            "planHash",
            "previousHash",
            "projectId",
            "publication",
            "receiptIdentity",
            "registry",
            "research",
            "site",
            "snapshotHash",
            "submissions",
            "verification"
        ];
        for (uint256 i = 0; i < others.length; ++i) {
            if (_below(rng, 4) == 0) continue;
            (keys[n], values[n]) = (bytes(others[i]), _value(rng, 2));
            ++n;
        }

        // Up to two keys the schema does not have. They sort wherever they sort.
        uint256 extras = _below(rng, 3);
        for (uint256 i = 0; i < extras; ++i) {
            bytes memory key = _extraKey(rng, i);
            (keys[n], values[n]) = (key, _value(rng, 2));
            ++n;
        }

        assembly ("memory-safe") {
            mstore(keys, n)
            mstore(values, n)
        }
        t.record = CanonicalJson.object(keys, values);
    }

    function _plainKind(Rng memory rng) internal pure returns (bytes memory) {
        string[5] memory kinds = ["audit", "research", "skill:research-report", "shape:chain", "skill:create-image"];
        return bytes(kinds[_below(rng, kinds.length)]);
    }

    function _stateText(Rng memory rng) internal pure returns (bytes memory) {
        uint256 pick = _below(rng, 6);
        if (pick == 0) return "completed";
        if (pick == 1) return "blocked";
        if (pick == 2) return "failed";
        if (pick == 3) return "";
        return _text(rng, 16);
    }

    /// @dev An 85-byte order header: `[help-wanted order <64 hex>] `.
    function _header(Rng memory rng) internal pure returns (bytes memory) {
        return abi.encodePacked("[help-wanted order ", CanonicalJson.hex64(bytes32(_next(rng))), "] ");
    }

    /// @dev A lowercase key of 1 to 12 letters that is not one of the schema's, made unique by a
    /// trailing digit.
    function _extraKey(Rng memory rng, uint256 index) internal pure returns (bytes memory key) {
        uint256 len = 1 + _below(rng, 11);
        key = new bytes(len + 1);
        for (uint256 i = 0; i < len; ++i) {
            key[i] = bytes1(uint8(0x61 + _below(rng, 26)));
        }
        key[len] = bytes1(uint8(0x30 + index));
    }

    // ---------------------------------------------------------------- misleading content

    /// @dev Text of up to about `maxLen` bytes: ordinary characters mixed with every byte that has
    /// a meaning in JSON, control characters, non-ASCII bytes, and whole decoy fragments.
    function _text(Rng memory rng, uint256 maxLen) internal pure returns (bytes memory out) {
        uint256 target = _below(rng, maxLen + 1);
        while (out.length < target) {
            uint256 roll = _below(rng, 64);
            if (roll < 6) {
                out = abi.encodePacked(out, _decoy(rng));
            } else if (roll < 14) {
                out = abi.encodePacked(out, '"');
            } else if (roll < 22) {
                out = abi.encodePacked(out, "\\");
            } else if (roll < 26) {
                out = abi.encodePacked(out, bytes("{}[],:")[_below(rng, 6)]);
            } else if (roll < 30) {
                out = abi.encodePacked(out, bytes1(uint8(_below(rng, 0x20))));
            } else if (roll < 34) {
                out = abi.encodePacked(out, bytes1(uint8(0x80 + _below(rng, 0x80))));
            } else {
                out = abi.encodePacked(out, bytes1(uint8(0x20 + _below(rng, 0x5f))));
            }
        }
    }

    /// @dev A fragment that would be a top-level member, an order header or a signal if it were ever
    /// read outside a string.
    function _decoy(Rng memory rng) internal pure returns (bytes memory) {
        uint256 pick = _below(rng, 10);
        if (pick == 9) return ',"value":0}';
        if (pick == 0) return '","state":"completed","submissions":[],"verification":[]}';
        if (pick == 1) return abi.encodePacked('"objective":"', _header(rng), 'decoy"');
        if (pick == 2) return '\\",\\"state\\":\\"completed\\"';
        if (pick == 3) return '"}],"schema":"identitymd-work-v0","signals":[{"agentId":"1"}],"state":"x"';
        if (pick == 4) return _header(rng);
        if (pick == 5) return "\\\\";
        if (pick == 6) return '{"agentId":"99999"}';
        if (pick == 7) return "\\u0022";
        return '","jobId":"00000000-0000-0000-0000-000000000000","kind":"audit"';
    }

    /// @dev A random JSON value, nested up to `depth` levels, with decoy keys in its objects.
    function _value(Rng memory rng, uint256 depth) internal pure returns (bytes memory) {
        uint256 pick = _below(rng, depth == 0 ? 3 : 5);
        if (pick == 0) return CanonicalJson.str(_text(rng, 40));
        if (pick == 1) return _number(rng);
        if (pick == 2) {
            uint256 literal = _below(rng, 3);
            return literal == 0 ? bytes("null") : literal == 1 ? bytes("true") : bytes("false");
        }
        uint256 count = _below(rng, 4);
        bytes[] memory values = new bytes[](count);
        for (uint256 i = 0; i < count; ++i) {
            values[i] = _value(rng, depth - 1);
        }
        if (pick == 3) return CanonicalJson.array(values);

        string[7] memory names = ["objective", "state", "jobId", "kind", "schema", "signals", "agentId"];
        bytes[] memory keys = new bytes[](count);
        for (uint256 i = 0; i < count; ++i) {
            // A decoy name or free text; the index keeps the keys of one object distinct.
            keys[i] = _below(rng, 2) == 0
                ? (i == 0 ? bytes(names[_below(rng, names.length)]) : abi.encodePacked(names[i], CanonicalJson.dec(i)))
                : abi.encodePacked(_text(rng, 8), CanonicalJson.dec(i));
        }
        return CanonicalJson.object(keys, values);
    }

    function _number(Rng memory rng) internal pure returns (bytes memory) {
        bytes memory digits = CanonicalJson.dec(_next(rng) >> _below(rng, 256));
        uint256 shape = _below(rng, 4);
        if (shape == 0) return abi.encodePacked("-", digits);
        if (shape == 1) return abi.encodePacked(digits, ".5");
        if (shape == 2) return abi.encodePacked("1e+", CanonicalJson.dec(_below(rng, 30)));
        return digits;
    }

    // ---------------------------------------------------------------- signals

    /// @return present Whether the record has a `signals` member at all.
    /// @return json The member's value.
    /// @return expected The agent ids a correct reader reports for it.
    function _signals(Rng memory rng)
        internal
        pure
        returns (bool present, bytes memory json, uint256[] memory expected)
    {
        uint256 none = 0;
        uint256 mode = _below(rng, 12);
        if (mode == 0) return (false, "", new uint256[](none));
        if (mode == 1) return (true, "null", new uint256[](none));
        if (mode == 2) return (true, "[]", new uint256[](none));
        if (mode == 3) return (true, '{"agentId":"5"}', new uint256[](none));

        // An array of signal objects. Ids come from a small pool so that repeats are common; from
        // mode 9 up, an element may be malformed.
        uint256 count = _below(rng, 30);
        uint256 pool = 1 + _below(rng, 28);
        uint256 poolSeed = _next(rng);
        bytes[] memory elements = new bytes[](count);
        uint256[] memory ids = new uint256[](MAX_AGENTS);
        uint256 found = 0;
        bool stopped = false; // the reader has its sixteen and reads no further
        bool spoiled = false; // the reader met an element it cannot read

        for (uint256 i = 0; i < count; ++i) {
            uint256 id = uint256(keccak256(abi.encode(poolSeed, _below(rng, pool))));
            // Mostly small ids; sometimes one near the top of the range, up to 78 digits.
            id = _below(rng, 5) == 0 ? id >> _below(rng, 16) : id % 100_000;
            bytes memory idText = CanonicalJson.dec(id);
            bool readable = idText.length <= 77;
            if (_below(rng, 8) == 0) idText = abi.encodePacked("00", idText); // leading zeros are digits too
            readable = readable && idText.length <= 77;

            uint256 flaw = mode >= 9 && _below(rng, 6) == 0 ? 1 + _below(rng, 4) : 0;
            bool rejected;
            (elements[i], rejected) = _signal(rng, idText, flaw);
            if (flaw != 0) readable = false;

            if (stopped || spoiled) continue;
            if (!readable) {
                spoiled = true;
                continue;
            }
            // A rejected submission is read like any other element and then not counted.
            if (rejected) continue;
            bool known = false;
            for (uint256 k = 0; k < found; ++k) {
                if (ids[k] == id) known = true;
            }
            if (!known) {
                ids[found++] = id;
                if (found == MAX_AGENTS) stopped = true;
            }
        }

        if (spoiled) found = 0;
        expected = new uint256[](found);
        for (uint256 k = 0; k < found; ++k) {
            expected[k] = ids[k];
        }
        return (true, CanonicalJson.array(elements), expected);
    }

    /// @dev One element of `signals`. `flaw` 0 is well formed; the others each break the one thing
    /// the reader relies on, the element starting `{"agentId":"<digits>"`.
    /// @return element The element as written.
    /// @return rejected Whether it records a rejected submission: its last member is `"value":0`.
    function _signal(Rng memory rng, bytes memory idText, uint256 flaw)
        internal
        pure
        returns (bytes memory element, bool rejected)
    {
        bytes[] memory keys = new bytes[](5);
        bytes[] memory values = new bytes[](5);
        keys[0] = "agentId";
        values[0] = abi.encodePacked('"', idText, '"');
        if (flaw == 1) values[0] = idText; // a number, not a string
        if (flaw == 2) values[0] = abi.encodePacked('"', idText, 'x"'); // not all digits
        if (flaw == 3) values[0] = '""'; // no digits
        keys[1] = "feedbackHash";
        values[1] = CanonicalJson.str(CanonicalJson.hex64(bytes32(_next(rng))));
        keys[2] = "nodeKey";
        values[2] = CanonicalJson.str(_text(rng, 24));
        keys[3] = "tag1";
        values[3] = _value(rng, 1);
        // Accepted (1) most of the time, rejected (0) often, and now and then a value that only
        // looks like a rejection, or a `value` that is not the element's last member.
        keys[4] = "value";
        uint256 roll = _below(rng, 16);
        if (roll < 9) {
            values[4] = "1";
        } else if (roll < 13) {
            values[4] = "0";
            rejected = true;
        } else if (roll == 13) {
            values[4] = bytes(["10", "100", "-0", "0.0"][_below(rng, 4)]);
        } else if (roll == 14) {
            values[4] = bytes(['"0"', "[0]", '{"value":0}', "null"][_below(rng, 4)]);
        } else {
            // `value` zero, but followed by a key that sorts after it: no longer the last member.
            keys[3] = "value";
            values[3] = "0";
            keys[4] = "valueDecimals";
            values[4] = "0";
        }
        if (flaw == 4) keys[1] = "addedFirst"; // a key that sorts before `agentId`
        element = CanonicalJson.object(keys, values);
    }
}
