// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title The IdentityMD Intake, as a paying contract sees it
/// @notice Taken from the verified source on Sourcify (Ethereum mainnet
/// `0xa43e6f75ee006411f79ac1c84120606c2330de82`, version 2). Only the parts a consumer touches, all
/// of which version 1 (`0x1397434cd35e8a9c8ac312a61d3a285eb31dea56`, legacy) has in the same form.
/// Version 2 adds `requestWithFailure`, `failureSelectorOf` and the event `FailureHookSet`, which
/// HELP WANTED does not use and which are not listed here.
interface IIntake {
    struct Callback {
        address target;
        bytes4 selector;
    }

    event Requested(
        bytes32 indexed requestId,
        address indexed payer,
        bytes32 indexed action,
        bytes body,
        address callbackTarget,
        bytes4 callbackSelector,
        address asset,
        uint256 amount
    );
    /// @dev `status`: 0 answered, 1 refused, 2 no answer. `delivered` is false when the callback
    /// reverted, ran out of gas, or there was none.
    event Completed(bytes32 indexed requestId, uint8 status, bytes32 resultHash, string uri, bool delivered);

    function request(bytes32 action, bytes calldata body, Callback calldata callback, address asset, uint256 amount)
        external
        payable
        returns (bytes32 requestId);

    function priceOf(bytes32 action, address asset) external view returns (uint256 amount);

    function callbackGas() external view returns (uint64);

    function requests(bytes32 requestId)
        external
        view
        returns (address payer, address callbackTarget, bytes4 callbackSelector, bool completed);

    function nonce() external view returns (uint256);

    function payTo() external view returns (address);

    function writer() external view returns (address);

    function MAX_BODY_BYTES() external view returns (uint256);

    /// @dev Writer only. Present here so fork tests can play the writer.
    function complete(bytes32 requestId, uint8 status, bytes32 resultHash, string calldata uri, bytes calldata args)
        external;
}
