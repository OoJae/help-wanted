// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title What a contract employer implements to hear that its order was delivered
/// @dev Called last, after every payout, with a fixed gas allowance inside a try. A revert here
/// changes nothing about the settlement. Opt in with `FLAG_CALLBACK`.
interface IWorkEmployer {
    function onWorkDelivered(uint256 orderId, bytes16 jobId, bytes32 recordHash) external;
}

/// @title WorkOrders, the hire desk, as an employer sees it
/// @notice An employer (a wallet or a contract) escrows IMD against a pinned job spec. A bonded
/// runner opens the swarm job; the escrow pays only when the job's work record is proven against
/// IdentityMD's WorkRegistry, or, if the employer opted in, when a bonded delivery claim goes
/// unchallenged. Anything else returns the money to the employer.
///
/// @dev This is the frozen surface other contracts (CrowdPots, the Doorbell, Rules, Zap) compile
/// against. The implementation adds the runner and settlement functions.
interface IWorkOrders {
    enum State {
        None,
        /// Escrowed and waiting for a runner (or for its condition).
        Open,
        /// A runner posted a bond and holds the order for a short exclusive window.
        Claimed,
        /// The runner opened the swarm job and registered its id.
        Registered,
        /// The runner claimed delivery without a receipt; the challenge window is running.
        Asserted,
        /// A delivery claim was challenged; only a receipt (or the order's arbiter) decides it.
        Disputed,
        /// Paid out. Terminal.
        Delivered,
        /// Withdrawn by the employer before any runner took it. Terminal.
        Cancelled,
        /// Expired or timed out; escrow returned. Terminal.
        Refunded
    }

    /// @dev `flags` bits.
    /// FLAG_ALLOW_CLAIMED: the employer accepts the bonded claim path when no receipt is available.
    /// FLAG_CALLBACK: call `IWorkEmployer.onWorkDelivered` on the employer at settlement.
    /// FLAG_COND_ARG: the condition call takes `condArg` as its single argument.
    struct OrderParams {
        /// keccak256 of the work record's `kind` string the employer wants, e.g. keccak256("audit").
        bytes32 kindHash;
        /// The price starts here and rises linearly to `maxPay` over `rampSecs`. A runner's claim
        /// fixes the price at that moment.
        uint96 minPay;
        /// Pulled from the employer at creation. Whatever the fixed price leaves is returned.
        uint96 maxPay;
        uint32 rampSecs;
        /// How long the runner has, after registering the job, for a receipt to exist.
        uint32 deliverySecs;
        /// After this time an order nobody holds can be refunded by anyone.
        uint40 expiresAt;
        /// The bond a runner must post to take the order.
        uint96 bond;
        uint8 flags;
        /// Zero for any runner, or the one address allowed to take the order.
        address runnerOnly;
        /// Zero for none, or the address allowed to decide a disputed claim.
        address arbiter;
        /// Zero for an ordinary order. Otherwise the order can only be taken once
        /// `condTarget.staticcall(condSelector [++ condArg])` has returned a word that compares true
        /// against `condThreshold` under `condCmp`: WHEN that happens, THEN hire.
        address condTarget;
        bytes4 condSelector;
        bytes32 condArg;
        /// 0 none, 1 >=, 2 <=, 3 >, 4 <, 5 ==, 6 !=
        uint8 condCmp;
        uint256 condThreshold;
    }

    /// @notice Opens an order. Pulls `p.maxPay` IMD from the caller, who becomes the employer.
    /// @param spec The job text a runner must send to the swarm, byte for byte, after the order
    /// header. Printable ASCII (0x20 to 0x7E) without `"` or `\`, no leading or trailing space,
    /// 1 to 7,900 bytes.
    function createOrder(OrderParams calldata p, bytes calldata spec) external returns (uint256 id);

    /// @notice The employer withdraws an order nobody has taken.
    function cancel(uint256 id) external;

    /// @notice Anyone returns the escrow of an order that expired with nobody holding it.
    function refund(uint256 id) external;

    function stateOf(uint256 id) external view returns (State);

    /// @notice The money side of one order, for employer contracts that keep their own books.
    /// @param escrow IMD the desk still holds for the order.
    /// @param spent IMD paid out for delivered work (runner, fee and tip together).
    /// @param returned IMD sent back to the employer so far, including any runner bond it was awarded.
    /// Every transfer the desk makes to the employer for this order is counted here, so an employer
    /// contract that holds many orders' money can keep its books from this figure alone.
    function accountOf(uint256 id)
        external
        view
        returns (State state, address employer, uint96 escrow, uint96 spent, uint96 returned);

    function orderCount() external view returns (uint256);

    function FLAG_ALLOW_CLAIMED() external view returns (uint8);

    function FLAG_CALLBACK() external view returns (uint8);

    function FLAG_COND_ARG() external view returns (uint8);

    function MIN_BOND() external view returns (uint96);

    function MIN_DELIVERY() external view returns (uint32);

    function IMD() external view returns (address);
}
