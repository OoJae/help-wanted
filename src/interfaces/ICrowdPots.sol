// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title CrowdPots, as a contributor or a helper contract sees it
/// @notice Many wallets chip in IMD to commission one swarm job through the hire desk. If the work
/// is not delivered, every chip is refundable pro rata.
///
/// @dev Frozen surface for contracts that chip in on someone's behalf (Zap, Endowments).
interface ICrowdPots {
    /// @notice Adds `amount` IMD from the caller to a pot that is still collecting.
    /// @return taken What was actually pulled: a chip is cut to what the pot still needs.
    function chipIn(uint256 potId, uint256 amount) external returns (uint256 taken);

    /// @notice The same, but the chip (and any refund of it) belongs to `beneficiary`.
    function chipInFor(uint256 potId, uint256 amount, address beneficiary) external returns (uint256 taken);

    /// @notice What the pot still needs before it can hire. Zero when it is full or closed.
    function remaining(uint256 potId) external view returns (uint256);

    function potCount() external view returns (uint256);
}
