// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IdentityMD's WorkRegistry, as a reader sees it
/// @notice Ethereum mainnet `0xb6d0a187b050fa5bb0b87033a203f37becf4a775`. The source is not published;
/// these signatures were recovered by exact selector and topic match against live transactions.
interface IWorkRegistry {
    /// @dev topic0 `0xc3e4ffeab3a1fc840bb179d634166017188a59d5df2db3c5f563052a5f6f2f86`.
    event WorkRecorded(bytes16 indexed jobId, bytes32 indexed documentHash, bytes32 previousHash, string uri);

    /// @notice keccak256 of the job's canonical work-record JSON, or zero when the job has no receipt.
    /// @dev Selector `0xebe9712c`. Does not revert for an unknown job.
    function latest(bytes16 jobId) external view returns (bytes32 documentHash);
}
