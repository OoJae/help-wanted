// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Builds small hand-made work records for tests, one raw JSON fragment per member, so a
/// test can put anything at all where a value belongs.
library Rec {
    bytes16 internal constant JOB = 0x0123456789abcdef0123456789abcdef;
    string internal constant JOB_UUID = "01234567-89ab-cdef-0123-456789abcdef";
    string internal constant SCHEMA = "identitymd-work-v1";

    /// @dev Each field is the raw JSON text of that member's value (quotes included for strings).
    /// `head` goes right after the opening brace and `tail` right before the closing one; both are
    /// written as they are, so they carry their own commas. An empty `signals` leaves the member out.
    struct Parts {
        string head;
        string jobId;
        string kind;
        string objective;
        string schema;
        string signals;
        string state;
        string tail;
    }

    /// @dev A well-formed record: every test starts here and bends one thing.
    function parts() internal pure returns (Parts memory p) {
        p.head = '"assessments":[],"identity":{"chainId":1},';
        p.jobId = string.concat('"', JOB_UUID, '"');
        p.kind = '"audit"';
        p.objective = '"Check the vault for rounding errors."';
        p.schema = string.concat('"', SCHEMA, '"');
        p.signals = '[{"agentId":"52211","feedbackHash":"ab","value":1}]';
        p.state = '"completed"';
        p.tail = ',"submissions":[],"verification":[]';
    }

    function build(Parts memory p) internal pure returns (bytes memory) {
        bytes memory signals = bytes(p.signals).length == 0 ? bytes("") : abi.encodePacked('"signals":', p.signals, ",");
        return abi.encodePacked(
            "{",
            p.head,
            '"jobId":',
            p.jobId,
            ',"kind":',
            p.kind,
            ',"objective":',
            p.objective,
            ',"schema":',
            p.schema,
            ",",
            signals,
            '"state":',
            p.state,
            p.tail,
            "}"
        );
    }

    /// @dev The default record.
    function minimal() internal pure returns (bytes memory) {
        return build(parts());
    }

    /// @dev `s` wrapped in quotes, with no escaping: the caller writes the raw JSON contents.
    function quoted(string memory s) internal pure returns (string memory) {
        return string.concat('"', s, '"');
    }

    /// @dev `s` without its first and last byte: the contents of a quoted fragment.
    function inner(string memory s) internal pure returns (bytes memory out) {
        bytes memory b = bytes(s);
        out = new bytes(b.length - 2);
        for (uint256 i = 0; i < out.length; ++i) {
            out[i] = b[i + 1];
        }
    }
}
