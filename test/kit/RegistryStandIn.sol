// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice A stand-in for IdentityMD's WorkRegistry, which is not part of this project. It answers
/// `latest(bytes16)` the way the real one does: the hash of the job's newest record, or zero.
/// Writing again for a job replaces the hash, as the real registry does for a superseding receipt.
/// The fork suite runs the same paths against the real registry, written to as its real writer.
contract RegistryStandIn {
    error Down();

    mapping(bytes16 jobId => bytes32) internal _latest;
    /// @dev When set, every read reverts: a registry that has stopped answering.
    bool public down;

    function set(bytes16 jobId, bytes32 documentHash) external {
        _latest[jobId] = documentHash;
    }

    function setDown(bool down_) external {
        down = down_;
    }

    function latest(bytes16 jobId) external view returns (bytes32) {
        if (down) revert Down();
        return _latest[jobId];
    }
}
