// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The identity of a Uniswap v4 pool. A pool's id is `keccak256(abi.encode(key))`.
/// @dev v4-core wraps `currency0`, `currency1` and `hooks` in its own types; on the wire each is a
/// plain address, which is how they are written here. Native ETH is the zero address, so in a pool
/// with ETH on one side ETH is always `currency0`.
struct PoolKey {
    address currency0;
    address currency1;
    /// @dev The liquidity providers' fee in hundredths of a basis point (10000 is 1%).
    uint24 fee;
    int24 tickSpacing;
    /// @dev Zero for a pool without a hook contract.
    address hooks;
}

/// @notice What to swap.
struct SwapParams {
    /// @dev True to sell `currency0` for `currency1`.
    bool zeroForOne;
    /// @dev Negative for an exact amount in, positive for an exact amount out.
    int256 amountSpecified;
    /// @dev The swap stops when the pool's price reaches this value, filled or not.
    uint160 sqrtPriceLimitX96;
}

/// @title The Uniswap v4 PoolManager, as a contract that only swaps sees it
/// @notice Ethereum mainnet `0x000000000004444c5dc75cB358380D2e3dE08A90`. Only the four calls a
/// single swap needs, written out here because v4-core is not vendored into this project. The
/// selectors are checked against the live contract by the fork tests.
interface IPoolManagerLike {
    /// @notice Opens the manager for the caller and calls `unlockCallback(data)` back on it. Every
    /// amount the caller owes or is owed must be back to zero when the callback returns, or the
    /// whole call reverts.
    function unlock(bytes calldata data) external returns (bytes memory result);

    /// @notice Swaps inside an unlocked manager. Moves no tokens: it only records what the caller
    /// now owes and is owed.
    /// @return swapDelta Two signed 128-bit amounts packed into one word, `currency0` in the upper
    /// half and `currency1` in the lower. Negative means the caller owes the manager.
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (int256 swapDelta);

    /// @notice Pays what the caller owes. Sent with ETH, it pays an ETH debt of `msg.value`.
    function settle() external payable returns (uint256 paid);

    /// @notice Sends `amount` of `currency` that the manager owes the caller to `to`.
    function take(address currency, address to, uint256 amount) external;
}

/// @title The callback `IPoolManagerLike.unlock` makes on its caller
interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory result);
}

/// @title The two reads of Uniswap's StateView lens that describe a pool's price and depth
/// @notice Ethereum mainnet `0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227`. Used by tests and pages, never
/// by a deployed contract.
interface IStateViewLike {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);

    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}
