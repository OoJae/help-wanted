// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A stand-in for IMD: 18 decimals, no hooks, anyone may mint. It has two switches the real IMD
/// does not have, so the tests can show what Endowments does if a token misbehaved: `setFee` makes it
/// keep a part of every transfer, and `take` lets any caller pull tokens out of any account with no
/// allowance at all.
contract MockIMD is ERC20 {
    uint256 public feeBps;

    constructor() ERC20("IdentityMD", "IMD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFee(uint256 bps) external {
        feeBps = bps;
    }

    function take(address from, uint256 amount) external {
        _transfer(from, msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (feeBps != 0 && from != address(0) && to != address(0)) {
            uint256 fee = value * feeBps / 10_000;
            super._update(from, address(0xFEE), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}
