// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A plain 18-decimal ERC-20 like IMD: no permit, no hooks, no fee. Anyone may mint in tests.
contract MockIMD is ERC20 {
    constructor() ERC20("Identity.md", "IMD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev An ERC-20 that keeps a tenth of every transfer, to show a meter credits what arrived.
contract TaxedIMD is ERC20 {
    constructor() ERC20("Taxed", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 kept = value / 10;
            super._update(from, address(0xFEE), kept);
            value -= kept;
        }
        super._update(from, to, value);
    }
}
