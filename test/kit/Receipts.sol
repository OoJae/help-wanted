// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {RecordMaker} from "./RecordMaker.sol";
import {RegistryStandIn} from "./RegistryStandIn.sol";

/// @notice Work records for tests that run the desk against the real WorkProof.
///
/// @dev Every record a test hands to the desk is a real IdentityMD work record from
/// `test/fixtures/proof/records` with a few top-level members swapped (`RecordKit`, reached
/// through the `RecordMaker` contract): the job id,
/// the objective (so that it carries the order header and the spec a runner of ours would have
/// sent) and, where a test needs another one, the kind, the state or the agents named. The rest of
/// the record, which is nearly all of it, is as IdentityMD served it. The receipt is then written
/// to the registry stand-in the way the real registry holds it: keccak256 of the record's bytes.
/// Nothing tells WorkProof what the record says; it has to read it.
abstract contract Receipts is Test {
    RegistryStandIn internal registry;
    /// @dev Builds the records. Created with the test contract; a test that switches to a fork
    /// creates it again there.
    RecordMaker internal recordMaker = new RecordMaker();

    string private constant RECORDS = "test/fixtures/proof/records/";
    /// @dev The reference job's record (job e9efec16): kind `skill:research-report`, state
    /// `completed`, one signal naming agent 52211.
    string internal constant COMPLETED_FIXTURE = "e9efec16-skill-research-report-3db99325.hex";
    /// @dev A real audit that ended `blocked` (job 9012ff0b), with no signals.
    string internal constant BLOCKED_FIXTURE = "9012ff0b-audit-c31895f6.hex";
    /// @dev The kind and the one agent of the completed fixture, unchanged.
    string internal constant REAL_KIND = "skill:research-report";
    uint256 internal constant REAL_AGENT = 52211;

    /// @dev A stored record, decoded to the bytes IdentityMD served.
    function _fixtureRecord(string memory file) internal view returns (bytes memory) {
        return vm.parseBytes(vm.readFile(string.concat(RECORDS, file)));
    }

    /// @dev A real record made into the record of `jobId`: a completed one when `state` is
    /// "completed", a blocked one otherwise, with the job id, kind, objective and state set. The
    /// agents it names are the fixture's own.
    function _recordOf(bytes16 jobId, string memory kind, bytes memory objective, string memory state)
        internal
        view
        returns (bytes memory)
    {
        return recordMaker.recordOf(_base(state), jobId, kind, objective, state);
    }

    /// @dev The same, naming `agents` (one accepted signal each) instead of the fixture's own.
    function _recordOf(
        bytes16 jobId,
        string memory kind,
        bytes memory objective,
        string memory state,
        uint256[] memory agents
    ) internal view returns (bytes memory) {
        return recordMaker.recordNaming(_base(state), jobId, kind, objective, state, agents);
    }

    /// @dev The same from a stored record of the caller's choice, with only the job id and the
    /// objective swapped: its kind, state and agents stay as IdentityMD wrote them.
    function _recordFrom(string memory file, bytes16 jobId, bytes memory objective)
        internal
        view
        returns (bytes memory)
    {
        return recordMaker.recordFrom(_fixtureRecord(file), jobId, objective);
    }

    /// @dev `record` with one top-level member given another raw JSON value.
    function _withMember(bytes memory record, string memory key, bytes memory rawValue)
        internal
        view
        returns (bytes memory)
    {
        return recordMaker.withMember(record, key, rawValue);
    }

    /// @dev The registry writes (or replaces) the job's receipt.
    function _write(bytes16 jobId, bytes memory record) internal {
        registry.set(jobId, keccak256(record));
    }

    function _base(string memory state) private view returns (bytes memory) {
        return _fixtureRecord(keccak256(bytes(state)) == keccak256("completed") ? COMPLETED_FIXTURE : BLOCKED_FIXTURE);
    }
}
