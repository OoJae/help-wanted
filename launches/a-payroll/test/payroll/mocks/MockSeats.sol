// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISeatAdapter} from "../../../src/interfaces/external/ISeatAdapter.sol";

/// @dev The one read Payroll makes of the seat ERC-721. Every id below `minted` has a deterministic
/// default owner, so a 2,000-seat set-up costs nothing; a test can override an owner or make one seat's
/// `ownerOf` revert, as the mainnet token does for an id that does not exist. `setBurn` makes every
/// read use up a chosen amount of gas first, to check that a read cut short by a caller who sent
/// little gas is never taken for a seat without an owner.
contract MockSeats {
    error TokenDoesNotExist();

    uint256 public minted;
    uint256 public burn;
    mapping(uint256 tokenId => address) private _override;
    mapping(uint256 tokenId => bool) public reverting;

    constructor(uint256 minted_) {
        minted = minted_;
    }

    function defaultOwner(uint256 tokenId) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("seat owner", tokenId)))));
    }

    function setMinted(uint256 minted_) external {
        minted = minted_;
    }

    function setOwner(uint256 tokenId, address owner) external {
        _override[tokenId] = owner;
    }

    function setReverting(uint256 tokenId, bool on) external {
        reverting[tokenId] = on;
    }

    function setBurn(uint256 gasToBurn) external {
        burn = gasToBurn;
    }

    function ownerOf(uint256 tokenId) external view returns (address owner) {
        uint256 toBurn = burn;
        if (toBurn != 0) {
            // Uses up `toBurn` gas. Given less than that, it runs out of gas, as a real read would.
            uint256 startedWith = gasleft();
            uint256 spin;
            while (startedWith - gasleft() < toBurn) {
                unchecked {
                    ++spin;
                }
            }
        }
        if (tokenId >= minted || reverting[tokenId]) revert TokenDoesNotExist();
        owner = _override[tokenId];
        if (owner == address(0)) owner = defaultOwner(tokenId);
    }
}

/// @dev The agent-to-seat Adapter. Unbound agents revert `UnknownAgent`, with the same selector as the
/// mainnet contract (0x7b65190b). `setBurn` makes every read use up a chosen amount of gas first, to
/// check Payroll's gas cap on the read.
contract MockAdapter {
    error UnknownAgent(uint256 agentId);

    struct Entry {
        bool bound;
        uint8 standard;
        address tokenContract;
        uint256 tokenId;
    }

    mapping(uint256 agentId => Entry) private _entries;
    uint256 public burn;
    bool public down;

    function bind(uint256 agentId, address tokenContract, uint256 tokenId) external {
        _entries[agentId] = Entry(true, 0, tokenContract, tokenId);
    }

    function unbind(uint256 agentId) external {
        delete _entries[agentId];
    }

    function setBurn(uint256 gasToBurn) external {
        burn = gasToBurn;
    }

    function setDown(bool on) external {
        down = on;
    }

    function bindingOf(uint256 agentId) external view returns (ISeatAdapter.Binding memory) {
        uint256 toBurn = burn;
        if (toBurn != 0) {
            // Runs out of gas (and so reverts) when the caller gave less than `toBurn`.
            uint256 stopAt = gasleft() - toBurn;
            uint256 spin;
            while (gasleft() > stopAt) {
                unchecked {
                    ++spin;
                }
            }
        }
        if (down) revert("adapter down");
        Entry memory e = _entries[agentId];
        if (!e.bound) revert UnknownAgent(agentId);
        return ISeatAdapter.Binding(e.standard, e.tokenContract, e.tokenId);
    }
}

/// @dev Answers every call with the same bytes, or reverts with them. Used to stand in for a dependency
/// that returns short data, stray bits, somebody else's token, or a recorded mainnet answer.
contract RawResponder {
    bytes private _response;
    bool private _reverts;

    function program(bytes calldata response, bool reverts) external {
        _response = response;
        _reverts = reverts;
    }

    fallback() external {
        bytes memory response = _response;
        bool reverts = _reverts;
        assembly {
            if reverts { revert(add(response, 0x20), mload(response)) }
            return(add(response, 0x20), mload(response))
        }
    }
}
