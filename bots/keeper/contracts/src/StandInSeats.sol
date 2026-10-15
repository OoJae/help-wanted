// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title The seat token and the seat Adapter, reduced to what Payroll reads
/// @notice Stand-ins for the keeper's integration test. `StandInSeats` names an owner per token id
/// and reverts for a seat nobody holds, as the real token does. `StandInAdapter` says which seat
/// an agent is bound to and reverts `UnknownAgent` for one that is bound to nothing.
contract StandInSeats {
    mapping(uint256 => address) private _owners;

    error NoSuchSeat(uint256 tokenId);

    function setOwner(uint256 tokenId, address owner) external {
        _owners[tokenId] = owner;
    }

    function ownerOf(uint256 tokenId) external view returns (address owner) {
        owner = _owners[tokenId];
        if (owner == address(0)) revert NoSuchSeat(tokenId);
    }
}

contract StandInAdapter {
    struct Binding {
        uint8 standard;
        address tokenContract;
        uint256 tokenId;
    }

    mapping(uint256 => Binding) private _bindings;

    error UnknownAgent(uint256 agentId);

    function bind(uint256 agentId, address tokenContract, uint256 tokenId) external {
        _bindings[agentId] = Binding(0, tokenContract, tokenId);
    }

    function bindingOf(uint256 agentId) external view returns (Binding memory binding) {
        binding = _bindings[agentId];
        if (binding.tokenContract == address(0)) revert UnknownAgent(agentId);
    }
}
