// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev A desk that publishes the limits and flags of the frozen `IWorkOrders` interface and nothing
/// beyond it: no `MAX_DELIVERY()`, no fallback. Rules must still be able to write a HIRE rule
/// against such a desk.
contract BareDesk {
    uint8 public constant FLAG_ALLOW_CLAIMED = 1;
    uint8 public constant FLAG_CALLBACK = 2;
    uint8 public constant FLAG_COND_ARG = 4;
    uint96 public constant MIN_BOND = 0.25e18;
    uint32 public constant MIN_DELIVERY = 3 days;
}
