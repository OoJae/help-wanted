// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IdentityMD's agent-to-seat Adapter, as a reader sees it
/// @notice Ethereum mainnet proxy `0xde152afb7db5373f34876e1499fbd893a82dd336`. It is upgradeable by its
/// owner, so callers treat every answer as untrusted: low-level staticcall, length check, token check.
interface ISeatAdapter {
    struct Binding {
        uint8 standard;
        address tokenContract;
        uint256 tokenId;
    }

    /// @dev Reverts `UnknownAgent(agentId)` for an agent that is not bound to a token.
    function bindingOf(uint256 agentId) external view returns (Binding memory);
}

/// @title The one ERC-721 read the seat payouts need
interface ISeats {
    function ownerOf(uint256 tokenId) external view returns (address);
}
