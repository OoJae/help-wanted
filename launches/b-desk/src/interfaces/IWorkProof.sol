// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title WorkProof: checks a swarm work record against IdentityMD's on-chain receipt
/// @notice Stateless. Anyone, including other builders' contracts, can call it to learn what a job
/// was asked to do, how it ended and which agents worked on it, with nothing trusted beyond the
/// WorkRegistry itself.
///
/// @dev Frozen surface. `record` is the canonical work-record JSON byte for byte as IdentityMD serves it
/// (the served file has no trailing newline; nothing is stripped or added). `headLen` is how many
/// leading bytes of the top-level `objective` string the caller wants hashed separately from the rest
/// (the order header).
interface IWorkProof {
    struct Proof {
        /// @dev keccak256 of the whole record; equal to `WorkRegistry.latest(jobId)`.
        bytes32 recordHash;
        /// @dev keccak256 of the top-level `kind` string's contents.
        bytes32 kindHash;
        /// @dev keccak256 of the first `headLen` raw bytes of the top-level `objective` contents.
        bytes32 headHash;
        /// @dev keccak256 of the rest of the `objective` contents, raw (still JSON-escaped) bytes.
        bytes32 specHash;
        /// @dev keccak256 of the top-level `state` string's contents.
        bytes32 stateHash;
        /// @dev The ERC-8004 agent ids in the top-level `signals`, de-duplicated, at most 16. An
        /// agent whose signals all record a submission that verification rejected (`value` 0) is
        /// left out. Empty when the list cannot be read, and for a job's later, superseding
        /// record, which carries no signals; an empty list never makes a proof fail.
        uint256[] agentIds;
    }

    error NoReceipt(bytes16 jobId);
    error HashMismatch(bytes32 expected, bytes32 got);
    error Malformed(uint256 pos);
    error MissingKey();
    error WrongSchema();
    error JobIdMismatch();
    error HeadTooLong();

    /// @notice Reverts unless `record` is the receipt the WorkRegistry holds for `jobId`.
    function prove(bytes16 jobId, bytes calldata record, uint256 headLen) external view returns (Proof memory);

    /// @notice The same, for a record too large for one transaction, stored across data contracts.
    /// @dev Each chunk is a contract whose code is one `0x00` byte followed by a slice of the record.
    function proveChunks(bytes16 jobId, address[] calldata chunks, uint256 headLen) external view returns (Proof memory);

    /// @notice Parses a record without consulting the registry. For tools and tests; proves nothing.
    function scan(bytes calldata record, uint256 headLen) external pure returns (bytes16 jobId, Proof memory);

    function WORK_REGISTRY() external view returns (address);
}
