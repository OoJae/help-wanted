// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManagerLike, IUnlockCallback, PoolKey, SwapParams} from "../../../src/rules/v4/IPoolManagerLike.sol";

/// @dev A PoolManager stand-in that keeps Uniswap v4's discipline: nothing works while it is locked,
/// a swap only records what the caller owes and is owed, and `unlock` reverts unless both amounts are
/// back to zero when the callback returns. The price is a fixed rate a test sets; `maxEthFill` makes
/// the pool run dry part way through, as a real pool does when it reaches the price limit.
contract MockPoolManager is IPoolManagerLike {
    IERC20 public immutable IMD;
    /// @dev IMD wei paid per wei of ETH, scaled by 1e18.
    uint256 public rate = 300e18;
    uint256 public maxEthFill = type(uint256).max;
    bool public flipSigns;
    bool public undercountSettle;
    /// @dev Wei of ETH the swap uses beyond the amount it was told to sell.
    uint256 public overspendBy;

    bytes32 public expectedPoolId;
    address public locker;
    int256 public ethDelta;
    int256 public imdDelta;

    error ManagerLocked();
    error AlreadyUnlocked();
    error CurrencyNotSettled();
    error PoolNotInitialized();
    error UnsupportedSwap();

    constructor(address imd) {
        IMD = IERC20(imd);
        expectedPoolId = keccak256(
            abi.encode(
                PoolKey({currency0: address(0), currency1: imd, fee: 10_000, tickSpacing: 200, hooks: address(0)})
            )
        );
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function setMaxEthFill(uint256 m) external {
        maxEthFill = m;
    }

    function setFlipSigns(bool on) external {
        flipSigns = on;
    }

    function setUndercountSettle(bool on) external {
        undercountSettle = on;
    }

    function setOverspendBy(uint256 by) external {
        overspendBy = by;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        if (locker != address(0)) revert AlreadyUnlocked();
        locker = msg.sender;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        if (ethDelta != 0 || imdDelta != 0) revert CurrencyNotSettled();
        locker = address(0);
    }

    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata) external returns (int256) {
        if (msg.sender != locker) revert ManagerLocked();
        if (keccak256(abi.encode(key)) != expectedPoolId) revert PoolNotInitialized();
        // Only what Zap does: ETH in, exact input, price limit at the bottom of the range.
        if (!params.zeroForOne || params.amountSpecified >= 0 || params.sqrtPriceLimitX96 != 4295128740) {
            revert UnsupportedSwap();
        }
        uint256 ethIn = uint256(-params.amountSpecified);
        if (ethIn > maxEthFill) ethIn = maxEthFill;
        ethIn += overspendBy;
        uint256 imdOut = ethIn * rate / 1e18;
        ethDelta -= int256(ethIn);
        imdDelta += int256(imdOut);
        int256 eth = -int256(ethIn);
        int256 imd = int256(imdOut);
        if (flipSigns) (eth, imd) = (-eth, -imd);
        return (eth << 128) | (imd & int256(uint256(type(uint128).max)));
    }

    function settle() external payable returns (uint256 paid) {
        if (msg.sender != locker) revert ManagerLocked();
        ethDelta += int256(msg.value);
        return undercountSettle ? msg.value - 1 : msg.value;
    }

    function take(address currency, address to, uint256 amount) external {
        if (msg.sender != locker) revert ManagerLocked();
        require(currency == address(IMD), "currency");
        imdDelta -= int256(amount);
        require(IMD.transfer(to, amount), "transfer");
    }
}
