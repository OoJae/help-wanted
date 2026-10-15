// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Standing Questions, as a reader or a funder sees them
/// @notice A feed is one question the contract keeps buying from the IdentityMD oracle. This is the
/// frozen surface other contracts (the Jobs Report, Payroll, Rules, Endowments) compile against. The
/// implementation adds the parts only it needs: creating feeds, asking, the oracle callback.
interface IQuestions {
    /// @dev A round is one purchased answer. `Failed` means the round was paid for and no usable
    /// answer arrived. What is asked next depends on the feed. A feed whose windows tile, and that
    /// already has an answer, starts its next window at the same block and ends it at a newer one,
    /// so no block is skipped. Any other feed asks about the newest blocks, and the failed round's
    /// own blocks are not asked about again. A reader takes each figure's period from the round's
    /// own `fromBlock` and `toBlock`.
    enum RoundStatus {
        None,
        Pending,
        Answered,
        Failed
    }

    /// @notice The newest answered round of a feed. Zeros when the feed has no answer yet.
    /// @param value The answer as one word. bool is 0 or 1, an address is its uint160, bytes32 and
    /// uint256 are themselves. For the list types it is `uint256(keccak256(answer))`, where `answer`
    /// is the attestation's `answer` bytes, so a reader can check a list it is handed.
    /// @param round Counts from 1.
    /// @param updatedAt The block timestamp the answer was stored at.
    function latest(bytes32 feedId)
        external
        view
        returns (uint256 value, uint64 fromBlock, uint64 toBlock, uint64 round, uint64 updatedAt);

    function roundOf(bytes32 feedId, uint64 round)
        external
        view
        returns (RoundStatus status, uint256 value, uint64 fromBlock, uint64 toBlock, uint64 updatedAt);

    /// @notice How many rounds the feed has opened, answered or not.
    function roundCount(bytes32 feedId) external view returns (uint64);

    /// @notice What the next request would cost the meter right now: the live Intake price plus the
    /// feed's keeper tip. The tip is set aside when the request is made, is paid out only for an
    /// answered round, and goes back to the meter if the round ends without an answer. Zero for an
    /// unknown feed, and while no request can be bought: the Intake does not sell the feed's action
    /// for IMD, its price cannot be read, or the price is above the feed's own cap.
    function costOf(bytes32 feedId) external view returns (uint256);

    /// @notice Adds IMD to a feed's meter. Pulls `amount` from the caller and mints meter shares.
    function fund(bytes32 feedId, uint256 amount) external returns (uint256 shares);

    /// @notice Burns meter shares and returns their part of what the meter has not spent.
    function defund(bytes32 feedId, uint256 shares) external returns (uint256 amount);

    function meterOf(bytes32 feedId) external view returns (uint256 balance, uint256 totalShares);

    function sharesOf(bytes32 feedId, address funder) external view returns (uint256);
}
