// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A plain 18-decimal ERC-20 standing in for IMD: no hooks, no fee on transfer, no permit.
/// @dev It also keeps a ledger of who sent how much to whom, so a test can state "this contract's
/// money only ever went to these addresses" without replaying events.
contract MockIMD is ERC20 {
    mapping(address from => mapping(address to => uint256)) public sent;
    mapping(address from => uint256) public sentTotal;

    constructor() ERC20("IdentityMD", "IMD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        sent[from][to] += value;
        sentTotal[from] += value;
    }
}

/// @notice A token that calls a target back in the middle of every transfer. IMD does not do this;
/// the tests use it to show that the reentrancy lock holds even if a token did.
contract CallbackToken is ERC20 {
    address public target;
    bytes public payload;
    bool public lastCallOk;
    bytes public lastCallResult;
    bool private _inside;

    constructor() ERC20("Callback", "CB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0) && !_inside) {
            _inside = true;
            (lastCallOk, lastCallResult) = target.call(payload);
            _inside = false;
        }
    }
}
