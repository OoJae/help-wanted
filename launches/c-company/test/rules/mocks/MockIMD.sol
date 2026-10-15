// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A plain 18-decimal ERC-20 that anyone can mint, standing in for IMD in offline tests.
contract MockIMD is ERC20 {
    constructor() ERC20("IdentityMD (test)", "IMD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
