// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title A stand-in for IdentityMD's WorkRegistry, for the bots' integration test
/// @notice It answers `latest(bytes16 jobId)` with the hash last recorded for a job, or zero, and
/// emits `WorkRecorded` when a hash is recorded, with the event shape the real registry has. That
/// is everything WorkProof, the runner and the keeper read of it.
///
/// It has no constructor, so the test can place its code at the registry's mainnet address on a
/// local node (the runner reads the registry at that address and nowhere else). The first caller
/// of `setWriter` names the writer, once; the test plays that writer.
contract StandInWorkRegistry {
    address public writer;
    mapping(bytes16 jobId => bytes32 documentHash) public latest;

    event WorkRecorded(bytes16 indexed jobId, bytes32 indexed documentHash, bytes32 previousHash, string uri);

    error WriterAlreadySet();
    error NotWriter();

    /// @notice Test set-up: names the writer. Only once.
    function setWriter(address writer_) external {
        if (writer != address(0)) revert WriterAlreadySet();
        writer = writer_;
    }

    /// @notice The writer records a job's work-record hash. A second call for the same job
    /// supersedes the first, as a second receipt does on mainnet.
    function record(bytes16 jobId, bytes32 documentHash, string calldata uri) external {
        if (msg.sender != writer) revert NotWriter();
        emit WorkRecorded(jobId, documentHash, latest[jobId], uri);
        latest[jobId] = documentHash;
    }
}
