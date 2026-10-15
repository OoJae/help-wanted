// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RecordKit} from "./RecordKit.sol";

/// @notice `RecordKit` behind a contract: the tests call these functions instead of compiling the
/// library into themselves.
///
/// @dev Why a contract. With the IR pipeline, library code that is internal is merged into every
/// function that uses it, and a test function that builds a record and then drives the desk ends
/// up with more live values than the compiler places comfortably. Whether such a function compiled
/// depended on which other files were compiled in the same run. Behind a call, the record code is
/// compiled once, by itself, and a test holds only the call.
///
/// Everything here is pure: bytes in, bytes out.
contract RecordMaker {
    /// @notice `record` with the value of the top-level member `key` replaced by the raw JSON text
    /// `rawValue` (quotes included for a string).
    function withMember(bytes calldata record, string calldata key, bytes calldata rawValue)
        external
        pure
        returns (bytes memory)
    {
        RecordKit.Edit[] memory edits = new RecordKit.Edit[](1);
        edits[0] = RecordKit.Edit(key, rawValue);
        return RecordKit.swap(record, edits);
    }

    /// @notice `base` made into the record of `jobId` with this objective. Its kind, state and
    /// agents stay as IdentityMD wrote them.
    function recordFrom(bytes calldata base, bytes16 jobId, bytes calldata objective)
        external
        pure
        returns (bytes memory)
    {
        RecordKit.Edit[] memory edits = new RecordKit.Edit[](2);
        edits[0] = RecordKit.Edit("jobId", RecordKit.uuid(jobId));
        edits[1] = RecordKit.Edit("objective", RecordKit.str(objective));
        return RecordKit.swap(base, edits);
    }

    /// @notice `base` made into the record of `jobId` with this kind, objective and state. The
    /// agents it names are the base record's own.
    function recordOf(
        bytes calldata base,
        bytes16 jobId,
        string calldata kind,
        bytes calldata objective,
        string calldata state
    ) external pure returns (bytes memory) {
        return RecordKit.swap(base, _four(jobId, kind, objective, state, 4));
    }

    /// @notice The same, naming `agents` (one accepted signal each) instead of the base record's own.
    function recordNaming(
        bytes calldata base,
        bytes16 jobId,
        string calldata kind,
        bytes calldata objective,
        string calldata state,
        uint256[] calldata agents
    ) external pure returns (bytes memory) {
        RecordKit.Edit[] memory edits = _four(jobId, kind, objective, state, 5);
        edits[4] = RecordKit.Edit("signals", RecordKit.signals(agents));
        return RecordKit.swap(base, edits);
    }

    /// @notice A job's second receipt as IdentityMD writes one when the work is delivered to a
    /// repository: the first record with `previousHash` naming it and no signals.
    function secondOf(bytes calldata first) external pure returns (bytes memory) {
        RecordKit.Edit[] memory edits = new RecordKit.Edit[](2);
        edits[0] = RecordKit.Edit("previousHash", abi.encodePacked('"', _hex(keccak256(first)), '"'));
        edits[1] = RecordKit.Edit("signals", "[]");
        return RecordKit.swap(first, edits);
    }

    /// @notice The raw JSON text of a top-level member's value.
    function valueOf(bytes calldata record, string calldata key) external pure returns (bytes memory) {
        return RecordKit.valueOf(record, key);
    }

    function _four(bytes16 jobId, string calldata kind, bytes calldata objective, string calldata state, uint256 n)
        private
        pure
        returns (RecordKit.Edit[] memory edits)
    {
        edits = new RecordKit.Edit[](n);
        edits[0] = RecordKit.Edit("jobId", RecordKit.uuid(jobId));
        edits[1] = RecordKit.Edit("kind", RecordKit.str(bytes(kind)));
        edits[2] = RecordKit.Edit("objective", RecordKit.str(objective));
        edits[3] = RecordKit.Edit("state", RecordKit.str(bytes(state)));
    }

    function _hex(bytes32 word) private pure returns (bytes memory out) {
        bytes16 digits = "0123456789abcdef";
        out = new bytes(64);
        for (uint256 i; i < 32; ++i) {
            out[2 * i] = digits[uint8(word[i]) >> 4];
            out[2 * i + 1] = digits[uint8(word[i]) & 0x0f];
        }
    }
}
