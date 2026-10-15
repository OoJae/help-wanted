// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkOrders} from "./IWorkOrders.sol";

/// @title WorkOrders, the hire desk, as a runner or a keeper sees it
/// @notice Everything you need to earn from the desk without asking anybody. A runner takes an
/// order, buys the job from IdentityMD's swarm with its own wallet, and is paid when the job's
/// work record is proven on chain. A keeper makes the calls that nothing makes by itself (ending
/// what ran out of time, paying what is due) and needs no permission either. There is no list of
/// allowed runners or keepers and no owner who could add one.
///
/// @dev THE RUNNER'S LOOP, in the order the calls are made:
///
/// 1. Find an order. Every order is announced by `OrderOpened`, which carries the full job text
///    (`spec`) and every parameter. Before taking one, check what the desk cannot check for you:
///    that `kindHash` is the keccak256 of a `kind` the swarm writes (a work record's `kind` is the
///    name of the job template, for example `audit` or `skill:research-report`), that the price
///    (`priceNow`) covers the swarm's fee and your gas, and, if the order allows the claimed path,
///    who its `arbiter` is. A conditional order must have been triggered (`conditionOf`), or its
///    condition must hold now.
/// 2. `claim(id)`: you post the order's bond (approve the desk for it first) and the price is
///    fixed. The call returns a ticket; `headerOf(id)` gives the 85 bytes built from it.
/// 3. Open the job with IdentityMD within one hour (`CLAIM_WINDOW`). Its objective must be exactly
///    `headerOf(id)` followed by the order's spec, byte for byte, under the template whose name is
///    the order's kind. The header ties the job to this chain, this desk, this order, this claim
///    and your address, so nobody else's job can be passed off as yours and yours can pay nobody
///    else. If you change your mind inside the hour, `release(id)` costs a tenth of the bond.
/// 4. `register(id, jobId)` with the job's id (the 16 bytes of its UUID) inside that hour. From
///    then on you have the order's `deliverySecs` for a receipt to exist. If the job fails, you
///    may open another and call `register` again; the time does not restart.
/// 5. When IdentityMD has written the job's receipt to its WorkRegistry, fetch the work record
///    from `https://api.imd.fun/work-records/<record hash>.json` and call
///    `settle(id, record, [])` with those bytes exactly as served. You are paid the fixed price
///    less 10% (a 5% fee and a 5% tip for the agents that worked), and your bond comes back, in
///    the same transaction. Anyone may make this call for you. Offer it more gas than it will
///    use: the desk insists on being able to hand 1,000,000 gas to each of its two Payroll calls
///    and refuses (`GasShort`) otherwise. A small record needs about 1.4M to 1.6M gas on offer
///    and uses 0.4M to 0.6M; a record naming sixteen agents never tipped before, or the costliest
///    record seen, needs 1.6M to 2.0M and uses 1.0M to 1.1M (the calldata's own charge comes on
///    top). An ordinary gas estimate finds the figure; what is not used is returned as usual.
///    A record above about 128 KB does not fit in one transaction: store it as data contracts
///    (`0x00` followed by a slice, see `IWorkProof.proveChunks`) and pass their addresses as
///    `chunks`.
///
/// WHEN THE JOB DID NOT WORK OUT. A receipt that shows your objective but a state other than
/// `completed` is the swarm's failure, not yours: `reportFailed(id, record, [])`, which only you
/// may call for it, returns your whole bond and frees the order. Or register a retry job instead.
/// With no settlement by the delivery deadline, anyone may call `timeout(id)` and the bond goes
/// to the employer. Timeouts are lazy: until that call is made, a late receipt still settles.
///
/// WHEN RECEIPTS ARE LATE (orders with `FLAG_ALLOW_CLAIMED` only). After registering, and with at
/// least 48 hours of delivery time left, `claimDelivered(id, recordHash)` states that the job was
/// delivered as the record with that hash (the hash IdentityMD's API lists for the job). If
/// nobody challenges within 24 hours, `finalize(id)` pays you exactly as `settle` does, marked
/// unproven; later anyone can `stamp(id, record, [])` to mark it proven, which moves no money. If
/// somebody does challenge, a receipt that settles the order still pays you, and gives you the
/// challenger's bond as well. A receipt that does not settle it, or the arbiter deciding against
/// you, costs you the bond. With nothing decided by the delivery deadline the employer is
/// refunded and you get back 90% of the bond.
///
/// THE KEEPER'S CALLS, each open to anyone and each refused until it is due:
/// `trigger` (a conditional order whose condition holds), `refund` (an order that expired with
/// nobody holding it), `evict` (a runner that registered no job within the hour), `timeout` (a
/// delivery deadline that passed), `settle` and `stamp` (a receipt exists), `reportFailed` (a
/// receipt that contradicts a claim, or shows another job than the claim's), `challenge` (a
/// delivery claim you can show to be untrue; it needs a bond), `finalize` (a delivery claim
/// nobody challenged) and `redeliver` (an employer callback that failed). None of them pays the
/// keeper anything from the desk; a keeper runs them for an employer, for a runner or for itself.
///
/// WHAT YOU TRUST. The desk has no owner and cannot be changed or paused. What a work record says
/// is decided by WorkProof against IdentityMD's WorkRegistry: if the registry writes no receipt
/// for your job in time, a receipt-only order does not pay and your bond is forfeited at the
/// deadline, so look at how receipts are flowing before you take one (the registry's newest
/// `WorkRecorded` event tells you).
interface IWorkOrdersRunner is IWorkOrders {
    /// @notice Everything the desk stores about an order, apart from its current claim.
    /// @dev `rampFrom` is the moment the price ramp is counted from: creation for an ordinary
    /// order, the moment the condition was first seen true for a conditional one (zero until then),
    /// moved forward by the time runners held the order without delivering, so that only time spent
    /// open raises the price. `escrow` is the IMD still held for the order; `spent` and `returned`
    /// are as in `accountOf`. `seq` counts claims; `proven` is set once a registry receipt has been
    /// matched; `notified` once the employer's callback has run without failing.
    struct Order {
        address employer;
        uint40 expiresAt;
        uint40 rampFrom;
        State state;
        uint8 flags;
        bytes32 kindHash;
        bytes32 specHash;
        uint96 minPay;
        uint96 maxPay;
        uint32 rampSecs;
        uint32 deliverySecs;
        address runnerOnly;
        uint96 bond;
        address arbiter;
        uint96 escrow;
        address condTarget;
        bytes4 condSelector;
        uint8 condCmp;
        bool condMet;
        bool proven;
        bool notified;
        uint32 seq;
        bytes32 condArg;
        uint256 condThreshold;
        uint96 spent;
        uint96 returned;
    }

    /// @notice The current claim of an order (or its last one, once the order is free again).
    /// @dev `price` was fixed when the runner claimed. `recordHash` is the hash the runner stated
    /// on the claimed path, replaced by the receipt's hash once a receipt has been matched.
    struct Claim {
        address runner;
        uint40 claimedAt;
        uint40 registeredAt;
        uint96 price;
        bytes16 jobId;
        address challenger;
        uint40 assertedAt;
        bytes32 recordHash;
    }

    /// @notice Why a claim ended without a delivery.
    enum End {
        /// The runner gave the order back before registering a job: the release share (10%) of the
        /// bond to the employer, the rest back to the runner.
        Released,
        /// No job was registered within the claim window: the bond to the employer.
        Evicted,
        /// No receipt settled the order within the delivery time: the bond to the employer.
        TimedOut,
        /// The receipt shows this claim's objective but no completed work of the order's kind: the
        /// bond goes back to the runner.
        SwarmFailed,
        /// The receipt shows another objective than this claim's: the bond to the employer.
        WrongJob,
        /// A delivery claim was contradicted by a receipt or by the arbiter. Unchallenged: the bond
        /// to the employer. Challenged: the release share of the bond to the employer, the rest to
        /// the challenger together with its own bond.
        Refuted,
        /// A challenged claim reached the delivery deadline undecided: the employer is refunded,
        /// the challenger's bond returned, and the runner is treated as if it had released (the
        /// release share of its bond to the employer, the rest back).
        DisputeExpired
    }

    // ------------------------------------------------------------------------------------------
    // Events: what to watch
    // ------------------------------------------------------------------------------------------

    /// @notice A new order. `spec` is the full job text; the desk itself keeps only its hash.
    event OrderOpened(
        uint256 indexed id,
        address indexed employer,
        bytes32 indexed kindHash,
        bytes32 specHash,
        OrderParams params,
        bytes spec
    );
    /// @notice The order's condition was seen true with `value`; the order can be taken from now on.
    event Triggered(uint256 indexed id, uint256 value);
    /// @notice A runner took the order. `ticket` goes into the header of the job it must open.
    event Claimed(uint256 indexed id, address indexed runner, uint256 seq, uint256 price, uint256 bond, bytes32 ticket);
    /// @notice The runner recorded the swarm job it opened for the order (again for a retry job).
    event Registered(uint256 indexed id, bytes16 indexed jobId);
    /// @notice The runner claimed delivery without a receipt; it can be challenged until `challengeUntil`.
    event DeliveryClaimed(uint256 indexed id, bytes16 indexed jobId, bytes32 recordHash, uint256 challengeUntil);
    /// @notice Somebody posted `bond` against the delivery claim.
    event Challenged(uint256 indexed id, address indexed challenger, uint256 bond);
    /// @notice The order's arbiter decided a disputed claim.
    event Resolved(uint256 indexed id, address indexed arbiter, bool delivered);
    /// @notice A receipt was submitted that does not settle the order.
    event Failed(uint256 indexed id, bytes16 indexed jobId, bytes32 recordHash);
    /// @notice A claim ended without a delivery. The three amounts are where the bond money went
    /// (`toChallenger` includes the challenger's own bond); `next` is the order's new state.
    event ClaimEnded(
        uint256 indexed id,
        address indexed runner,
        End reason,
        uint256 toRunner,
        uint256 toEmployer,
        uint256 toChallenger,
        State next
    );
    /// @notice The order was paid out. `runnerPay + fee + tip` is the fixed price; `toEmployer` is
    /// the unused escrow; `bonds` went to the runner on top (its own, plus a losing challenger's).
    event Delivered(
        uint256 indexed id,
        bytes16 indexed jobId,
        address indexed runner,
        bytes32 recordHash,
        bool proven,
        uint256 runnerPay,
        uint256 fee,
        uint256 tip,
        uint256 toEmployer,
        uint256 bonds,
        uint256[] agentIds
    );
    /// @notice An order paid on an unchallenged or arbitrated claim was later matched to its receipt.
    event Proven(uint256 indexed id, bytes16 indexed jobId, bytes32 recordHash);
    /// @notice The employer withdrew an order nobody held.
    event Cancelled(uint256 indexed id, uint256 toEmployer);
    /// @notice The escrow went back to the employer (expiry, or an undecided dispute).
    event Refunded(uint256 indexed id, uint256 toEmployer);
    /// @notice The employer's `onWorkDelivered` reverted or ran out of gas. The delivery stands, and
    /// anyone may try the callback again with `redeliver`.
    event CallbackFailed(uint256 indexed id);
    /// @notice A callback that had failed went through on a later try.
    event Redelivered(uint256 indexed id);
    /// @notice Payroll did not take all of the fee and tip; `amount` was sent to it by plain transfer.
    event PayrollFallback(uint256 indexed id, uint256 amount);

    // ------------------------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------------------------
    //
    // Besides the errors below, a call can revert with three kinds of error that are not the desk's
    // own. `settle`, `reportFailed` and `stamp` pass on, unchanged, whatever WorkProof reverts with
    // when it turns a record away: the errors of `IWorkProof` (`NoReceipt`, `HashMismatch`,
    // `Malformed`, `MissingKey`, `WrongSchema`, `JobIdMismatch`) and WorkProof's own `BadChunk` and
    // `InsufficientGas`. A call made from inside another call to the desk reverts
    // `ReentrancyGuardReentrantCall()`. A token transfer the token refuses reverts with the
    // token's error or `SafeERC20FailedOperation(address)`.

    /// @notice A constructor argument is the zero address.
    error ZeroAddress();
    /// @notice The order is not in a state that allows this call.
    error BadState();
    /// @notice Only the order's employer may do this.
    error NotEmployer();
    /// @notice Only the runner that holds the order may do this, or the order is reserved for another runner.
    error NotRunner();
    /// @notice Only the order's arbiter may do this (nobody, if the order has none).
    error NotArbiter();
    /// @notice The spec breaks the character rules at byte `at` (see `SpecText`).
    error SpecInvalid(uint256 at);
    /// @notice `maxPay` is zero or `minPay` is above it.
    error PayRange();
    /// @notice `deliverySecs` is under `MIN_DELIVERY`.
    error DeliveryTooShort();
    /// @notice `deliverySecs` is over `MAX_DELIVERY`.
    error DeliveryTooLong();
    /// @notice `bond` is under `MIN_BOND`.
    error BondTooLow();
    /// @notice An unknown flag bit, or `FLAG_COND_ARG` on an order with no condition.
    error BadFlags();
    /// @notice `condCmp` is out of range, or set without a target, or a target without it.
    error BadCondition();
    /// @notice The order's expiry is not in the future.
    error Expired();
    /// @notice The time this call waits for has not come yet.
    error TooEarly();
    /// @notice The time in which this call was possible has passed.
    error TooLate();
    /// @notice The caller released this order before.
    error Barred();
    /// @notice The order's condition does not hold now and has never been seen to hold.
    error ConditionNotMet();
    /// @notice The employer did not allow the claimed path for this order.
    error ClaimedPathOff();
    /// @notice A job id of zero cannot be registered.
    error ZeroJob();
    /// @notice A record hash of zero cannot be claimed.
    error ZeroHash();
    /// @notice This job's receipt already settled another order.
    error JobUsed();
    /// @notice The record's state is not "completed".
    error NotCompleted();
    /// @notice The record's kind is not the order's.
    error WrongKind();
    /// @notice The record's objective does not start with this claim's header.
    error WrongHeader();
    /// @notice The record's objective does not continue with the order's spec.
    error WrongSpec();
    /// @notice The receipt is one that settles the order; use `settle`.
    error NotFailed();
    /// @notice Not enough gas was supplied to give a protected call its full allowance.
    error GasShort();
    /// @notice One more claim could take the order's `returned` figure past what it can hold.
    error BooksFull();

    // ------------------------------------------------------------------------------------------
    // Taking an order
    // ------------------------------------------------------------------------------------------

    /// @notice Records that a conditional order's condition holds now, which opens the order to
    /// runners for good and starts its price ramp. Anyone may call.
    /// @dev Reverts `BadState` when the order is not open, has no condition or is already
    /// triggered, `ConditionNotMet` when the condition does not hold, and `GasShort` unless the
    /// call can hand the condition target its whole `CONDITION_GAS` (send 150,000 gas or more).
    /// `claim` does the same by itself, so a runner need not call this first.
    function trigger(uint256 id) external;

    /// @notice Takes an open order: pulls the order's bond from the caller (approve the desk for
    /// it first), fixes the price at what `priceNow` shows, and starts the hour in which a job must
    /// be registered.
    /// @dev Reverts `BadState` (not open), `Expired`, `NotRunner` (reserved for another runner),
    /// `Barred` (the caller released this order before) and `ConditionNotMet` (a condition that
    /// has never been seen true and is not true now).
    /// @return ticket The value that goes into the job's header; `headerOf(id)` builds the header.
    function claim(uint256 id) external returns (bytes32 ticket);

    /// @notice Gives the order back before a job is registered, inside the claim window only. The
    /// caller gets 90% of its bond, the employer 10%, and the caller may not take this order again.
    /// @dev Only the runner that holds the order. `TooLate` once `CLAIM_WINDOW` has passed.
    function release(uint256 id) external;

    /// @notice Removes a runner that registered no job within the claim window. Anyone may call.
    /// The whole bond goes to the employer and the order is open again, or refunded if it expired.
    /// @dev `TooEarly` inside the window. Lazy: until somebody calls this, the runner can still register.
    function evict(uint256 id) external;

    /// @notice Records the swarm job the runner opened for the order. May be called again, before
    /// the order is settled, to replace the job with a retry.
    /// @dev Only the runner that holds the order. `ZeroJob` for a zero id; `JobUsed` for a job
    /// whose receipt already settled another order. The delivery time runs from the first
    /// registration and a retry does not restart it.
    /// @param jobId The job's UUID as 16 bytes (the 32 hex digits without the dashes).
    function register(uint256 id, bytes16 jobId) external;

    // ------------------------------------------------------------------------------------------
    // Being paid on a receipt
    // ------------------------------------------------------------------------------------------

    /// @notice Pays the order out against the work record of its registered job. Anyone may call.
    /// @dev Reverts with WorkProof's own error unless `record` is the receipt the WorkRegistry
    /// holds for the job, and with `NotCompleted`, `WrongKind`, `WrongHeader`, `WrongSpec` or
    /// `JobUsed` when the record does not settle this claim. `GasShort` unless about 1.25M to
    /// 1.65M gas is on offer beyond what the proof itself uses (the figure moves with what the
    /// first Payroll call spends); unused gas is returned.
    ///
    /// The runner receives the fixed price less the 5% fee and the 5% tip (each rounded up),
    /// together with its bond, and a challenger's bond after a dispute. Any receipt of the
    /// registered job that passes the checks pays, whatever hash a delivery claim named.
    /// @param record The work record exactly as IdentityMD serves it (no trailing newline). Ignored
    /// when `chunks` is not empty.
    /// @param chunks For a record too large for one transaction: data contracts holding it in order.
    function settle(uint256 id, bytes calldata record, address[] calldata chunks) external;

    /// @notice Ends a claim with a receipt of its registered job that does not settle the order.
    /// @dev While the job is only registered: a receipt with this claim's objective that did not
    /// end `completed` may be reported by the runner alone, and returns its whole bond; one that
    /// is `completed` under another kind may be reported by anyone, and also returns the bond; one
    /// with any other objective may be reported by anyone and sends the bond to the employer.
    /// After a delivery claim, any such receipt may be reported by anyone and the runner loses
    /// its bond (to the employer, or shared between the employer and the challenger). `NotFailed`
    /// for a receipt that settles the order. The order is open again afterwards, or refunded if
    /// it has expired.
    function reportFailed(uint256 id, bytes calldata record, address[] calldata chunks) external;

    /// @notice Ends a claim whose delivery time has passed. Anyone may call.
    /// @dev A registered job: the bond goes to the employer and the order is open again, or
    /// refunded if it has expired. A challenged delivery claim that nothing decided: the employer
    /// is refunded, the challenger gets its bond back and the runner 90% of its own. `TooEarly`
    /// before the deadline (`claimOf(id).registeredAt + orderOf(id).deliverySecs`); `BadState` for
    /// an unchallenged delivery claim, which only `finalize`, `settle` or `reportFailed` end.
    function timeout(uint256 id) external;

    // ------------------------------------------------------------------------------------------
    // Being paid on a claim (orders with FLAG_ALLOW_CLAIMED)
    // ------------------------------------------------------------------------------------------

    /// @notice The runner states that its registered job was delivered as the record with this
    /// hash, and opens the 24-hour challenge window.
    /// @dev Only the runner, once per claim. `ClaimedPathOff` on an order without the flag,
    /// `ZeroHash`, and `TooLate` unless `CHALLENGE_WINDOW + DISPUTE_WINDOW` (48 hours) still fit
    /// before the delivery deadline. Name the hash IdentityMD's API lists for the job, so that a
    /// watcher can compare; it plays no part in what a receipt later decides.
    function claimDelivered(uint256 id, bytes32 recordHash) external;

    /// @notice Disputes a delivery claim by posting a bond equal to the runner's (approve the desk
    /// for it first). Anyone may call, once per claim, inside the challenge window.
    /// @dev The challenger wins the runner's bond, less the employer's tenth, if a receipt of the
    /// registered job fails to settle the order or the arbiter decides against the runner. It
    /// loses its own bond to the runner if a receipt settles the order or the arbiter decides for
    /// the runner. With nothing decided by the delivery deadline it gets its bond back. A record
    /// hash that differs from the one the runner named is not by itself a reason to challenge.
    ///
    /// Before posting, read `orderOf(id)`: the bond is held until the dispute ends, at the longest
    /// until `claimOf(id).registeredAt + deliverySecs` (up to 90 days); the order's `arbiter`, if
    /// it has one, decides with no evidence and may be the employer itself; and the employer may
    /// be its own runner, in which case a dispute that nothing decides costs it nothing.
    function challenge(uint256 id) external;

    /// @notice Pays out a delivery claim nobody challenged in time. Anyone may call.
    /// @dev `TooEarly` inside the challenge window; `GasShort` as in `settle`. The order is marked
    /// unproven and the tip goes to Payroll with no agent list, also when a receipt exists by
    /// then: to have the agents named, call `settle` with the record instead.
    function finalize(uint256 id) external;

    /// @notice The order's arbiter decides a disputed claim.
    /// @dev `NotArbiter` for anyone else. True pays the runner as delivered (unproven) and gives
    /// it the challenger's bond; that call needs the gas `settle` needs. False ends the claim
    /// against the runner as a contradicting receipt would.
    function resolve(uint256 id, bool delivered) external;

    /// @notice Marks an order that was paid on a claim as proven, once its receipt exists. Anyone
    /// may call. No money moves.
    /// @dev The same checks as `settle`. `BadState` unless the order is delivered and unproven.
    function stamp(uint256 id, bytes calldata record, address[] calldata chunks) external;

    /// @notice Tries the employer's `onWorkDelivered` again for a delivered order whose callback
    /// failed. Anyone may call. No money moves.
    /// @dev `BadState` unless the order is delivered, asked for a callback and has not had one go
    /// through; `GasShort` unless `CALLBACK_GAS` can be handed over (send 200,000 gas or more).
    function redeliver(uint256 id) external;

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @notice Everything stored about an order. The spec text itself is in its `OrderOpened` event.
    function orderOf(uint256 id) external view returns (Order memory);

    /// @notice The order's current claim. After a claim ended without delivery this still shows
    /// that last claim, until the next runner takes the order.
    function claimOf(uint256 id) external view returns (Claim memory);

    /// @notice What a runner claiming now would be paid in total (fee and tip included). While a
    /// runner holds the order, and once it is delivered, the price that runner's claim fixed.
    function priceNow(uint256 id) external view returns (uint96);

    /// @notice The ticket of the order's current (or last) claim:
    /// `keccak256(abi.encode(chainId, desk, orderId, claimSeq, runner))`.
    function ticketOf(uint256 id) external view returns (bytes32);

    /// @notice The 85 bytes the runner must put at the very start of the swarm job's objective,
    /// directly followed by the spec: `"[help-wanted order "`, the ticket as 64 lowercase hex
    /// digits, `"] "`.
    /// @dev Reverts `BadState` unless a runner holds the order or the order was delivered.
    function headerOf(uint256 id) external view returns (bytes memory);

    /// @notice The status of an order's condition.
    /// @return met True when the order can be taken as far as its condition goes.
    /// @return holdsNow Whether the condition call compares true at this moment.
    /// @return value The word the condition call returned, or zero if it failed.
    function conditionOf(uint256 id) external view returns (bool met, bool holdsNow, uint256 value);

    /// @notice The order a job's receipt was matched for, or zero. Such a job can settle no other order.
    function orderOfJob(bytes16 jobId) external view returns (uint256 orderId);

    /// @notice True once `runner` has released order `orderId`; it may not take that order again.
    function barred(uint256 orderId, address runner) external view returns (bool);

    /// @notice The longest delivery time an order may ask for.
    function MAX_DELIVERY() external view returns (uint32);

    /// @notice The fee, in basis points of the fixed price, sent to Payroll at delivery.
    function FEE_BPS() external view returns (uint256);

    /// @notice The tip, in basis points of the fixed price, sent to Payroll for the agents that worked.
    function TIP_BPS() external view returns (uint256);

    /// @notice The part of the bond, in basis points, a runner loses to the employer when it
    /// releases an order, and at least loses when a challenged claim is not upheld.
    function RELEASE_BPS() external view returns (uint256);

    /// @notice How long a runner may hold an order without registering a job, in seconds.
    function CLAIM_WINDOW() external view returns (uint256);

    /// @notice How long a delivery claim can be challenged, in seconds.
    function CHALLENGE_WINDOW() external view returns (uint256);

    /// @notice The least time a challenged delivery claim has, before the delivery deadline, for a
    /// receipt or the arbiter to decide it, in seconds.
    function DISPUTE_WINDOW() external view returns (uint256);

    /// @notice Gas given to the employer's `onWorkDelivered`.
    function CALLBACK_GAS() external view returns (uint256);

    /// @notice Gas given to an order's condition call.
    function CONDITION_GAS() external view returns (uint256);

    /// @notice Gas given to each of the two Payroll calls made at delivery.
    function PAYROLL_GAS() external view returns (uint256);

    /// @notice Length of the order header at the start of a job's objective: 85.
    function HEADER_LEN() external view returns (uint256);

    /// @notice The contract that checks work records against the IdentityMD WorkRegistry.
    function WORK_PROOF() external view returns (address);

    /// @notice Where fees and tips go.
    function PAYROLL() external view returns (address);
}
