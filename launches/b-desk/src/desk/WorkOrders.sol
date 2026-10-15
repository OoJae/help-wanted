// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IPayroll} from "../interfaces/IPayroll.sol";
import {IWorkEmployer, IWorkOrders} from "../interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../interfaces/IWorkOrdersRunner.sol";
import {IWorkProof} from "../interfaces/IWorkProof.sol";
import {OrderHeader} from "./OrderHeader.sol";
import {SpecText} from "./SpecText.sol";

/// @title WorkOrders, the hire desk
/// @notice A job board where the employer can be a contract. An employer escrows IMD against a
/// pinned job text (the spec). A runner posts a bond, opens the job with IdentityMD's swarm with the
/// order's header in front of the spec, and registers the job id. The escrow pays out in one of
/// three ways only:
///
/// - Proven: anyone submits the job's work record and WorkProof confirms it is the receipt the
///   IdentityMD WorkRegistry holds for that job, that it ended "completed", and that its objective
///   is exactly this claim's header followed by the order's spec.
/// - Claimed (only if the employer opted in with `FLAG_ALLOW_CLAIMED`): the runner states that the
///   job was delivered, a 24 hour challenge window passes with no challenge, and the order is paid
///   as delivered but marked unproven until someone later stamps it with the receipt.
/// - Arbitrated (only on such an order, and only if the employer named an arbiter): a delivery
///   claim was challenged and the arbiter decided for the runner. Also marked unproven.
///
/// Everything else gives the escrow back to the employer.
///
/// @dev There is no owner, no setter and no pause; the three addresses given at construction never
/// change. What the desk trusts, and how far:
///
/// - WorkProof, and through it IdentityMD's WorkRegistry, decide what a record says. Whoever
///   controls the registry's writer can record a hash for a record of its own making, and so be
///   paid for any order it takes: every escrow a runner can claim is exposed to that key. It is
///   the same party that runs the swarm and already decides what the work was. If WorkProof or
///   the registry stop answering, nothing can be proven and every order ends by timeout or refund.
/// - Payroll receives the fee and the tip. Each of its two calls is offered `PAYROLL_GAS`;
///   whatever it does not take, for any reason, is sent to it by plain transfer. A settlement
///   never waits for it.
/// - The employer's callback and the condition target are untrusted. The first runs last, with a
///   fixed gas allowance, after everything is final. The second is a gas-capped static call that is
///   consulted only until the condition has once been seen true.
///
/// What a runner should check before taking an order, because the desk cannot: that `kindHash` is
/// the kind the swarm writes for the template it will use (a work record's `kind` is the name of
/// the job's template); and, for the claimed path, who the order's arbiter is (an arbiter decides
/// a disputed claim before a receipt does).
///
/// What an employer accepts by setting `FLAG_ALLOW_CLAIMED`, stated plainly:
///
/// - Until a receipt is matched, the job id and the record hash of a delivery claim are the
///   runner's word. An untrue claim that nobody challenges within 24 hours is paid.
/// - A challenge costs the challenger no IMD when nothing decides the dispute: with no receipt
///   and no arbiter decision by the delivery deadline, the employer is refunded and the
///   challenger's bond returned. So while receipts are late, a challenger can keep a true claim
///   from being paid at no cost to itself but gas and the use of its bond until then.
/// - A runner whose challenged claim is not upheld never gets off more cheaply than by `release`:
///   whoever the challenger was, its own second address included, the employer receives at least
///   the release share of the runner's bond.
///
/// An order's arbiter is the answer for an employer who wants neither of the first two. Orders
/// without the flag are untouched by any of this: they pay on a matched receipt or not at all.
///
/// What a challenger accepts by posting its bond: the bond is held until a receipt, the arbiter or
/// the delivery deadline ends the dispute, and that deadline can be 90 days after the job was
/// registered; a dispute that nothing decides returns the bond and pays nothing for the wait; and
/// an order's arbiter decides either way, with no evidence required. An employer may be its own
/// runner and its own arbiter. So a challenger looks at an order's employer, arbiter, bond and
/// deadline first, and defends the orders it has a reason to defend.
///
/// The surface is declared in two interfaces: `IWorkOrders` (what an employer contract compiles
/// against) and `IWorkOrdersRunner` (what a runner or a keeper uses, with the order and claim
/// records, every event and every error). This contract implements both and adds nothing public
/// beyond them.
contract WorkOrders is IWorkOrdersRunner, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @inheritdoc IWorkOrders
    uint8 public constant FLAG_ALLOW_CLAIMED = 1;
    /// @inheritdoc IWorkOrders
    uint8 public constant FLAG_CALLBACK = 2;
    /// @inheritdoc IWorkOrders
    uint8 public constant FLAG_COND_ARG = 4;

    /// @inheritdoc IWorkOrders
    uint96 public constant MIN_BOND = 0.25e18;
    /// @inheritdoc IWorkOrders
    uint32 public constant MIN_DELIVERY = 3 days;
    /// @notice The longest delivery time an order may ask for. One runner's bond can keep an
    /// order's escrow out of reach for the whole delivery time, so a mistaken value must not be
    /// able to make that years.
    uint32 public constant MAX_DELIVERY = 90 days;

    /// @notice The fee, in basis points of the fixed price, sent to Payroll at delivery.
    uint256 public constant FEE_BPS = 500;
    /// @notice The tip, in basis points of the fixed price, sent to Payroll for the agents that worked.
    uint256 public constant TIP_BPS = 500;
    /// @notice The release share: the part of the bond, in basis points, a runner loses to the
    /// employer when it releases an order, and at least loses when a challenged claim is not upheld.
    uint256 public constant RELEASE_BPS = 1000;
    /// @notice How long a runner may hold an order without registering a job.
    uint256 public constant CLAIM_WINDOW = 1 hours;
    /// @notice How long a delivery claim can be challenged.
    uint256 public constant CHALLENGE_WINDOW = 24 hours;
    /// @notice The least time a challenged delivery claim has, before the delivery deadline, for a
    /// receipt or the arbiter to decide it. `claimDelivered` is refused when it would be less.
    uint256 public constant DISPUTE_WINDOW = 24 hours;
    /// @notice Gas given to the employer's `onWorkDelivered`.
    /// @dev Enough to record a delivery, not to open a new order (about 260,000 gas): an employer
    /// contract that hires again does so in a call of its own.
    uint256 public constant CALLBACK_GAS = 150_000;
    /// @notice Gas given to an order's condition call.
    uint256 public constant CONDITION_GAS = 100_000;
    /// @notice Gas given to each of the two Payroll calls made at delivery.
    uint256 public constant PAYROLL_GAS = 1_000_000;
    /// @notice Length of the order header at the start of a job's objective.
    uint256 public constant HEADER_LEN = OrderHeader.LENGTH;

    uint256 private constant BPS = 10_000;
    /// @dev Room for the few operations between a gas check and the call it protects.
    uint256 private constant GAS_SLACK = 10_000;
    bytes32 private constant COMPLETED = keccak256("completed");

    /// @inheritdoc IWorkOrders
    address public immutable IMD;
    /// @notice The contract that checks work records against the IdentityMD WorkRegistry.
    address public immutable WORK_PROOF;
    /// @notice Where fees and tips go.
    address public immutable PAYROLL;

    /// @inheritdoc IWorkOrders
    uint256 public orderCount;

    /// @notice The order a job's receipt was matched for, or zero.
    /// @dev Written only when a receipt is matched (`settle`, `stamp`), never when a job id is
    /// registered or merely claimed as delivered, so registering somebody else's job id cannot
    /// stand in the way of that job's own order. On the claimed path a job id is the runner's word
    /// until then: two unchallenged claims that name the same job id are both paid.
    mapping(bytes16 jobId => uint256 orderId) public orderOfJob;

    /// @notice True once a runner has released an order; it may not take that order again.
    mapping(uint256 orderId => mapping(address runner => bool)) public barred;

    mapping(uint256 orderId => Order) private _orders;
    mapping(uint256 orderId => Claim) private _claims;

    /// @dev Makes no call and checks no code, so it can run on an empty chain; it only refuses a
    /// zero address. An address that is wrong in another way shows on first use: without a real IMD
    /// no order can be funded, and so no money can ever depend on the other two.
    /// @param imd The IMD token.
    /// @param workProof The WorkProof contract of the same launch.
    /// @param payroll The Payroll contract of the earlier launch.
    constructor(address imd, address workProof, address payroll) {
        if (imd == address(0) || workProof == address(0) || payroll == address(0)) revert ZeroAddress();
        IMD = imd;
        WORK_PROOF = workProof;
        PAYROLL = payroll;
    }

    // ------------------------------------------------------------------------------------------
    // Employer
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IWorkOrders
    /// @dev Anyone may call. Reverts when the spec breaks the character rules, when the pay range,
    /// delivery time, bond, expiry, flags or condition fields are out of range, or when the caller
    /// has not approved `p.maxPay` IMD. A conditional order starts closed: see `trigger`.
    function createOrder(OrderParams calldata p, bytes calldata spec) external nonReentrant returns (uint256 id) {
        uint256 at = SpecText.firstBad(spec);
        if (at != SpecText.NONE) revert SpecInvalid(at);
        if (p.maxPay == 0 || p.minPay > p.maxPay) revert PayRange();
        if (p.deliverySecs < MIN_DELIVERY) revert DeliveryTooShort();
        if (p.deliverySecs > MAX_DELIVERY) revert DeliveryTooLong();
        if (p.bond < MIN_BOND) revert BondTooLow();
        if (p.expiresAt <= block.timestamp) revert Expired();
        bool conditional = p.condTarget != address(0);
        if (p.flags > 7 || (!conditional && p.flags & FLAG_COND_ARG != 0)) revert BadFlags();
        if (p.condCmp > 6 || conditional == (p.condCmp == 0)) revert BadCondition();

        id = ++orderCount;
        bytes32 specHash = keccak256(spec);
        _orders[id] = Order({
            employer: msg.sender,
            expiresAt: p.expiresAt,
            rampFrom: conditional ? 0 : _timestamp(),
            state: State.Open,
            flags: p.flags,
            kindHash: p.kindHash,
            specHash: specHash,
            minPay: p.minPay,
            maxPay: p.maxPay,
            rampSecs: p.rampSecs,
            deliverySecs: p.deliverySecs,
            runnerOnly: p.runnerOnly,
            bond: p.bond,
            arbiter: p.arbiter,
            escrow: p.maxPay,
            condTarget: p.condTarget,
            condSelector: p.condSelector,
            condCmp: p.condCmp,
            condMet: !conditional,
            proven: false,
            notified: false,
            seq: 0,
            condArg: p.condArg,
            condThreshold: p.condThreshold,
            spent: 0,
            returned: 0
        });
        emit OrderOpened(id, msg.sender, p.kindHash, specHash, p, spec);
        IERC20(IMD).safeTransferFrom(msg.sender, address(this), p.maxPay);
    }

    /// @inheritdoc IWorkOrders
    /// @dev Only the employer, and only while the order is open. Once a runner holds the order the
    /// employer can no longer withdraw it; if the claim ends without a delivery it becomes open again.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.state != State.Open) revert BadState();
        if (msg.sender != o.employer) revert NotEmployer();
        uint256 escrow = o.escrow;
        o.escrow = 0;
        o.state = State.Cancelled;
        _credit(o, escrow);
        emit Cancelled(id, escrow);
        _send(msg.sender, escrow);
    }

    /// @inheritdoc IWorkOrders
    /// @dev Reverts `TooEarly` before `expiresAt`. An order somebody holds is never refunded here;
    /// it is refunded when its claim ends after the expiry.
    function refund(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.state != State.Open) revert BadState();
        if (block.timestamp < o.expiresAt) revert TooEarly();
        _send(o.employer, _close(id, o, true));
    }

    // ------------------------------------------------------------------------------------------
    // Condition: WHEN a view call crosses a line, THEN hire
    // ------------------------------------------------------------------------------------------

    /// @notice Records that a conditional order's condition holds now, which opens the order to
    /// runners for good and starts its price ramp. Anyone may call.
    /// @dev Reverts `BadState` when the order is not open, has no condition, or is already
    /// triggered; `ConditionNotMet` when the condition call fails, returns fewer than 32 bytes or
    /// compares false; `GasShort` when too little gas is left to offer the target its whole
    /// `CONDITION_GAS`, so that the caller cannot choose how much gas the target answers on.
    ///
    /// One true reading is enough and the condition is never consulted again. An employer should
    /// therefore not point a condition at something a caller can make true for the length of one
    /// transaction (a spot balance, a pool price): whoever can do that can open the order.
    function trigger(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.state != State.Open || o.condMet) revert BadState();
        _latch(id, o);
    }

    // ------------------------------------------------------------------------------------------
    // Runner
    // ------------------------------------------------------------------------------------------

    /// @notice Takes an open order: posts the order's bond, fixes the price at what `priceNow`
    /// shows, and starts the one hour in which a job must be registered.
    /// @dev Reverts when the order is not open (`BadState`), has expired (`Expired`), is reserved
    /// for another runner (`NotRunner`), was released by the caller before (`Barred`), or has a
    /// condition that has never been seen true and is not true now (`ConditionNotMet`, or
    /// `GasShort` as in `trigger`). `BooksFull` cannot happen with amounts of IMD that exist: see
    /// `accountOf`.
    /// @return ticket The value to put in the header of the swarm job (see `headerOf`).
    function claim(uint256 id) external nonReentrant returns (bytes32 ticket) {
        Order storage o = _orders[id];
        if (o.state != State.Open) revert BadState();
        if (block.timestamp >= o.expiresAt) revert Expired();
        address only = o.runnerOnly;
        if (only != address(0) && only != msg.sender) revert NotRunner();
        if (barred[id][msg.sender]) revert Barred();
        if (!o.condMet) _latch(id, o);

        uint96 price = _price(o);
        uint256 bond = o.bond;
        // What keeps `returned` exact: see `_credit`.
        if (uint256(o.returned) + o.escrow + bond > type(uint96).max) revert BooksFull();
        uint256 seq = ++o.seq;
        o.state = State.Claimed;
        _claims[id] = Claim({
            runner: msg.sender,
            claimedAt: _timestamp(),
            registeredAt: 0,
            price: price,
            jobId: 0,
            challenger: address(0),
            assertedAt: 0,
            recordHash: 0
        });
        ticket = OrderHeader.ticket(block.chainid, address(this), id, seq, msg.sender);
        emit Claimed(id, msg.sender, seq, price, bond, ticket);
        IERC20(IMD).safeTransferFrom(msg.sender, address(this), bond);
    }

    /// @notice The runner gives the order back before registering a job. It gets 90% of its bond,
    /// the employer gets 10%, and the runner may not take this order again.
    /// @dev Only inside the claim window (`TooLate` afterwards). Past the window the only ways on
    /// are `register` and `evict`, so a runner that overstays cannot wait for an eviction to appear
    /// and then swap the whole bond for a tenth of it.
    function release(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Claimed) revert BadState();
        if (msg.sender != c.runner) revert NotRunner();
        if (block.timestamp >= c.claimedAt + CLAIM_WINDOW) revert TooLate();
        barred[id][msg.sender] = true;
        uint256 bond = o.bond;
        uint256 cut = _releaseCut(bond);
        _endClaim(id, o, c, End.Released, bond - cut, cut, 0);
    }

    /// @notice Removes a runner that registered no job within the claim window. Anyone may call.
    /// The whole bond goes to the employer.
    /// @dev Lazy: until somebody calls this, the runner can still register.
    function evict(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Claimed) revert BadState();
        if (block.timestamp < c.claimedAt + CLAIM_WINDOW) revert TooEarly();
        _endClaim(id, o, c, End.Evicted, 0, o.bond, 0);
    }

    /// @notice The runner records the swarm job it opened for the order. It may call again, before
    /// the order is settled, to replace the job with a retry.
    /// @dev The delivery time runs from the first registration and a retry does not restart it.
    /// Registering a job id reserves nothing: a job is tied to an order only when its receipt is
    /// matched, so a runner cannot be blocked by somebody registering its job id elsewhere. A job
    /// whose receipt already settled another order is refused (`JobUsed`): it could never settle
    /// this one.
    function register(uint256 id, bytes16 jobId) external nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        State s = o.state;
        if (s != State.Claimed && s != State.Registered) revert BadState();
        if (msg.sender != c.runner) revert NotRunner();
        if (jobId == 0) revert ZeroJob();
        if (orderOfJob[jobId] != 0) revert JobUsed();
        if (s == State.Claimed) {
            o.state = State.Registered;
            c.registeredAt = _timestamp();
        }
        c.jobId = jobId;
        emit Registered(id, jobId);
    }

    // ------------------------------------------------------------------------------------------
    // Proven path
    // ------------------------------------------------------------------------------------------

    /// @notice Pays the order out against the work record of its registered job. Anyone may call.
    /// @dev WorkProof must confirm the record is the WorkRegistry's receipt for the job. The record
    /// must be "completed", of the order's kind, and its objective must be this claim's header
    /// followed by the order's spec. The job must not have settled another order. Nothing else
    /// counts: after a delivery claim, challenged or not, any receipt that passes these checks
    /// pays the runner, whether or not its hash is the one the runner named (a job can be given a
    /// newer receipt, and the registry then answers with that one).
    ///
    /// Out of the fixed price: 5% fee and 5% tip to Payroll (each rounded up to the next wei), the
    /// rest to the runner together with its bond (and the challenger's bond after a dispute). The
    /// escrow above the price returns to the employer. The tip is passed on with the agent ids
    /// WorkProof read from the record; a job's later receipt can carry none, and the tip of a
    /// settlement made after such a receipt goes to Payroll's seat pool instead.
    ///
    /// Gas: `GasShort` unless `PAYROLL_GAS` can be handed to each Payroll call, and, when the
    /// employer asked for a callback, `CALLBACK_GAS` to its `onWorkDelivered`, which is called
    /// last. So the caller cannot make either fail by underfunding it. Gas that is not used is
    /// returned as usual.
    ///
    /// Timeouts are lazy: until somebody calls `timeout`, a late receipt still settles here.
    /// @param record The work record as IdentityMD serves it, byte for byte (the served file has no
    /// trailing newline). Ignored when `chunks` is not empty.
    /// @param chunks For a record too large for one transaction: data contracts holding it in
    /// order (see `IWorkProof.proveChunks`).
    function settle(uint256 id, bytes calldata record, address[] calldata chunks) external {
        _settle(id, record, chunks);
        _notify(id);
    }

    /// @notice Ends a claim with a receipt of its registered job that does not settle the order.
    /// @dev WorkProof must confirm the record is the WorkRegistry's receipt for the job, as in
    /// `settle`. What happens to the runner's bond depends on what the receipt shows and on where
    /// the claim stands.
    ///
    /// While the job is only registered (no delivery was claimed):
    ///
    /// - This claim's objective, but the job did not end "completed": the swarm failed a job the
    ///   runner opened correctly. Only the runner may report this (it decides whether to give up
    ///   or to register a retry, and a job's first receipt need not be its last), and it gets its
    ///   whole bond back. It already lost the swarm's fee; taking its bond for the swarm's failure
    ///   would make honest runners avoid the desk.
    /// - This claim's objective and "completed", but under another kind than the order's: this job
    ///   can never settle the order. Anyone may report it, so the order is free again as soon as
    ///   the receipt exists. The bond goes back to the runner, because the kind is written by the
    ///   swarm from the job's template and the desk cannot tell a runner's wrong template from a
    ///   kind the swarm renamed. A runner that picks a wrong template on purpose pays the swarm's
    ///   fee each time and holds the order only until the receipt lands.
    /// - Any other objective, one too short to hold a header included: the runner registered a
    ///   job that is not this claim's. Anyone may report it and the whole bond goes to the
    ///   employer, as in `timeout`, only sooner.
    ///
    /// After the runner claimed delivery, any receipt of the registered job that does not settle
    /// the order contradicts the claim, and anyone may report it:
    ///
    /// - Unchallenged: the whole bond goes to the employer.
    /// - Challenged: the employer gets the release share of the runner's bond and the challenger
    ///   gets the rest together with its own bond. The employer's share is what keeps a runner
    ///   from saving its bond by challenging its own claim from a second address.
    ///
    /// A receipt that settles the order is never a failure, whatever hash the runner named
    /// (`NotFailed`). In every case the order becomes open again, or is refunded if it has expired.
    ///
    /// One kind of receipt cannot be used here: a record WorkProof cannot read at all (not a
    /// canonical work record of the pinned schema) proves nothing either way, and a claim whose
    /// job has such a record ends by `timeout`.
    function reportFailed(uint256 id, bytes calldata record, address[] calldata chunks) external nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        State s = o.state;
        if (s < State.Registered || s > State.Disputed) revert BadState();
        bytes16 jobId = c.jobId;
        IWorkProof.Proof memory proof = _prove(jobId, record, chunks, true);
        bool sameObjective = proof.headHash == _headHash(id, o, c) && proof.specHash == o.specHash;
        bool completed = proof.stateHash == COMPLETED;
        if (sameObjective && completed && proof.kindHash == o.kindHash) revert NotFailed();

        emit Failed(id, jobId, proof.recordHash);
        uint256 bond = o.bond;
        if (s == State.Disputed) {
            _refute(id, o, c);
        } else if (s == State.Asserted) {
            _endClaim(id, o, c, End.Refuted, 0, bond, 0);
        } else if (sameObjective) {
            if (!completed && msg.sender != c.runner) revert NotRunner();
            _endClaim(id, o, c, End.SwarmFailed, bond, 0, 0);
        } else {
            _endClaim(id, o, c, End.WrongJob, 0, bond, 0);
        }
    }

    /// @notice Ends a claim whose delivery time has passed. Anyone may call.
    /// @dev A registered job with no settlement: the bond goes to the employer and the order becomes
    /// open again, or is refunded if it has expired.
    ///
    /// A challenged delivery claim that neither a receipt nor the arbiter decided: the employer is
    /// refunded for good, the challenger gets its bond back, and the runner is treated as if it
    /// had released the order: the release share of its bond goes to the employer and the rest
    /// back to it. So claiming delivery and having a second address challenge is never cheaper
    /// than releasing.
    ///
    /// An unchallenged delivery claim is not touched by this: it can only be paid (`finalize`,
    /// `settle`) or refuted by a receipt (`reportFailed`).
    function timeout(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        State s = o.state;
        if (s != State.Registered && s != State.Disputed) revert BadState();
        if (block.timestamp < uint256(c.registeredAt) + o.deliverySecs) revert TooEarly();
        uint256 bond = o.bond;
        if (s == State.Registered) {
            _endClaim(id, o, c, End.TimedOut, 0, bond, 0);
        } else {
            uint256 cut = _releaseCut(bond);
            _endClaim(id, o, c, End.DisputeExpired, bond - cut, cut, bond);
        }
    }

    // ------------------------------------------------------------------------------------------
    // Claimed path (only for orders with FLAG_ALLOW_CLAIMED)
    // ------------------------------------------------------------------------------------------

    /// @notice The runner states that its registered job was delivered as the record with this
    /// hash, and opens the 24 hour challenge window.
    /// @dev Only the runner, only once per claim, and only on orders whose employer allowed it.
    /// Reverts `TooLate` unless the challenge window and, after it, the `DISPUTE_WINDOW` both end
    /// by the delivery deadline: the deadline bounds this path too, and a claim that is challenged
    /// in the last second of its window still leaves a receipt or the arbiter a day to decide it.
    ///
    /// The job id and the hash are the runner's word and nothing more until a receipt is matched.
    /// The hash is there so that a watcher can compare it with the records IdentityMD's API lists
    /// for the job (the API lists a record's hash even while its on-chain receipt is queued). It
    /// plays no part in what a receipt later decides. What protects the employer on this path is
    /// the challenge window, not this function.
    function claimDelivered(uint256 id, bytes32 recordHash) external nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Registered) revert BadState();
        if (msg.sender != c.runner) revert NotRunner();
        if (o.flags & FLAG_ALLOW_CLAIMED == 0) revert ClaimedPathOff();
        if (recordHash == 0) revert ZeroHash();
        uint256 until = block.timestamp + CHALLENGE_WINDOW;
        if (until + DISPUTE_WINDOW > uint256(c.registeredAt) + o.deliverySecs) revert TooLate();
        o.state = State.Asserted;
        c.assertedAt = _timestamp();
        c.recordHash = recordHash;
        emit DeliveryClaimed(id, c.jobId, recordHash, until);
    }

    /// @notice Disputes a delivery claim by posting a bond equal to the runner's. Anyone may call,
    /// once per claim, inside the challenge window.
    /// @dev From here only a receipt, the order's arbiter or the delivery deadline ends the claim:
    ///
    /// - A receipt that settles the order (`settle`), or the arbiter deciding for the runner: the
    ///   runner is paid and takes the challenger's bond.
    /// - A receipt of the registered job that does not settle the order (`reportFailed`), or the
    ///   arbiter deciding against the runner: the challenger gets its bond back together with the
    ///   runner's, less the release share, which goes to the employer.
    /// - Neither by the delivery deadline (`timeout`): the challenger gets its bond back and
    ///   nothing more.
    ///
    /// A record hash that differs from the one the runner named is not by itself a reason to
    /// challenge: a job can have more than one record, and any receipt that settles the order pays.
    ///
    /// The bond stays in the desk until one of the three happens: at the longest until the
    /// delivery deadline (`registeredAt + deliverySecs`, up to 90 days after the job was
    /// registered). A claim that names a job with no receipt, on an order with no arbiter, cannot
    /// be decided before then. The first challenge to be mined is the only one: a second caller's
    /// transaction reverts `BadState` and costs it gas alone.
    function challenge(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Asserted) revert BadState();
        if (block.timestamp >= c.assertedAt + CHALLENGE_WINDOW) revert TooLate();
        o.state = State.Disputed;
        c.challenger = msg.sender;
        uint256 bond = o.bond;
        emit Challenged(id, msg.sender, bond);
        IERC20(IMD).safeTransferFrom(msg.sender, address(this), bond);
    }

    /// @notice Pays out a delivery claim nobody challenged in time. Anyone may call.
    /// @dev The order is marked unproven and the tip goes to Payroll with no agent list. The
    /// employer's callback, if any, receives the record hash the runner named. `TooEarly` inside
    /// the challenge window; `GasShort` as in `settle`. This is so even when the job's receipt has
    /// landed by then: whoever wants the tip to name the agents that worked calls `settle` with
    /// the record instead, which pays the same amounts.
    function finalize(uint256 id) external {
        _finalize(id);
        _notify(id);
    }

    /// @notice The order's arbiter decides a disputed claim. Lazy like a late receipt: it can
    /// still decide after the delivery deadline, until somebody calls `timeout`.
    /// @param delivered True pays the runner as delivered (unproven) and gives it the challenger's
    /// bond. False ends the claim as a receipt against the runner would (see `reportFailed`): the
    /// employer gets the release share of the runner's bond, the challenger the rest with its own,
    /// and the order becomes open again, or is refunded if it has expired.
    function resolve(uint256 id, bool delivered) external {
        _resolve(id, delivered);
        if (delivered) _notify(id);
    }

    /// @notice Tries the employer's `onWorkDelivered` again for a delivered order whose callback
    /// failed. Anyone may call. No money moves.
    /// @dev Reverts `BadState` unless the order is delivered, asked for a callback, and has not
    /// had one go through yet; `GasShort` as in `settle`. It cannot be called from inside another
    /// call to the desk (from Payroll during a settlement, say): the callback is only ever made
    /// once everything else is done.
    function redeliver(uint256 id) external {
        if (_reentrancyGuardEntered()) revert ReentrancyGuardReentrantCall();
        Order storage o = _orders[id];
        if (o.state != State.Delivered || o.notified || o.flags & FLAG_CALLBACK == 0) revert BadState();
        _notify(id);
        if (o.notified) emit Redelivered(id);
    }

    /// @notice Marks an order that was paid on a claim as proven, once its receipt exists. Anyone
    /// may call. No money moves.
    /// @dev The same checks as `settle`: any receipt of the registered job that passes them will
    /// do, whatever hash the runner named. The order's record hash becomes the receipt's.
    function stamp(uint256 id, bytes calldata record, address[] calldata chunks) external nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Delivered || o.proven) revert BadState();
        bytes16 jobId = c.jobId;
        IWorkProof.Proof memory proof = _prove(jobId, record, chunks, false);
        _requireSettles(id, o, c, proof);
        orderOfJob[jobId] = id;
        o.proven = true;
        c.recordHash = proof.recordHash;
        emit Proven(id, jobId, proof.recordHash);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IWorkOrders
    function stateOf(uint256 id) external view returns (State) {
        return _orders[id].state;
    }

    /// @inheritdoc IWorkOrders
    /// @dev `returned` is exact: it is the sum of every transfer the desk has made to the employer
    /// for this order as its employer (the escrow at cancel or refund, the unused escrow at
    /// delivery, and every forfeited bond or share of a bond). It never saturates and is never
    /// estimated; `claim` refuses an order (`BooksFull`) before the figure could pass the 96 bits
    /// it is reported in, which takes more than 79 billion IMD. Money the desk pays the same
    /// address in another role (as the order's runner, or as a challenger) is not counted.
    function accountOf(uint256 id)
        external
        view
        returns (State state, address employer, uint96 escrow, uint96 spent, uint96 returned)
    {
        Order storage o = _orders[id];
        return (o.state, o.employer, o.escrow, o.spent, o.returned);
    }

    /// @notice Everything stored about an order. The spec text itself is in its `OrderOpened` event.
    function orderOf(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    /// @notice The order's current claim. After a claim ended without delivery this still shows
    /// that last claim, until the next runner takes the order.
    function claimOf(uint256 id) external view returns (Claim memory) {
        return _claims[id];
    }

    /// @notice What a runner claiming now would be paid in total (fee and tip included): `minPay`
    /// rising in a straight line to `maxPay` over `rampSecs` of time the order has spent open,
    /// counted from creation, or from the trigger for a conditional order (one not yet triggered
    /// shows the price at the start of its ramp).
    /// @dev While a runner holds the order, and once it is delivered, this is the price that
    /// runner's claim fixed. The ramp stands still while the order is held: when a claim ends
    /// without delivery the price goes on from where that claim found it, so holding an order
    /// cannot be used to push its price up. Zero for an unknown order.
    function priceNow(uint256 id) external view returns (uint96) {
        Order storage o = _orders[id];
        State s = o.state;
        return s >= State.Claimed && s <= State.Delivered ? _claims[id].price : _price(o);
    }

    /// @notice The ticket of the order's current (or last) claim.
    function ticketOf(uint256 id) public view returns (bytes32) {
        return OrderHeader.ticket(block.chainid, address(this), id, _orders[id].seq, _claims[id].runner);
    }

    /// @notice The 85 bytes the runner must put at the very start of the swarm job's objective,
    /// directly followed by the spec.
    /// @dev Reverts `BadState` unless a runner holds the order or the order was delivered.
    function headerOf(uint256 id) external view returns (bytes memory) {
        State s = _orders[id].state;
        if (s < State.Claimed || s > State.Delivered) revert BadState();
        return OrderHeader.build(ticketOf(id));
    }

    /// @notice The status of an order's condition.
    /// @dev A reading taken here is only as good as the gas the call was given: the target is
    /// offered at most `CONDITION_GAS`, and less when the caller has less to pass on. `trigger`
    /// and `claim` insist on the whole allowance; this view cannot.
    /// @return met True when the order can be taken as far as its condition goes: it has none, or
    /// it was seen true once.
    /// @return holdsNow Whether the condition call compares true at this moment (true for an order
    /// with no condition).
    /// @return value The word the condition call returned, or zero if it failed.
    function conditionOf(uint256 id) external view returns (bool met, bool holdsNow, uint256 value) {
        Order storage o = _orders[id];
        met = o.condMet;
        if (o.condTarget == address(0)) return (met, met, 0);
        (holdsNow, value) = _condition(o);
    }

    // ------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------

    function _settle(uint256 id, bytes calldata record, address[] calldata chunks) private nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        State s = o.state;
        if (s < State.Registered || s > State.Disputed) revert BadState();
        bytes16 jobId = c.jobId;
        IWorkProof.Proof memory proof = _prove(jobId, record, chunks, false);
        _requireSettles(id, o, c, proof);
        orderOfJob[jobId] = id;
        _deliver(id, o, c, proof.recordHash, true, proof.agentIds);
    }

    function _finalize(uint256 id) private nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Asserted) revert BadState();
        if (block.timestamp < c.assertedAt + CHALLENGE_WINDOW) revert TooEarly();
        _deliver(id, o, c, c.recordHash, false, new uint256[](0));
    }

    function _resolve(uint256 id, bool delivered) private nonReentrant {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Disputed) revert BadState();
        if (msg.sender != o.arbiter) revert NotArbiter();
        emit Resolved(id, msg.sender, delivered);
        if (delivered) _deliver(id, o, c, c.recordHash, false, new uint256[](0));
        else _refute(id, o, c);
    }

    /// @dev Asks WorkProof what the registered job's record says, with the header split off. It
    /// reverts unless the record is the registry's receipt for `jobId`, and its revert is passed on
    /// unchanged. With `anyObjective`, a record whose objective is shorter than a header (WorkProof
    /// answers `HeadTooLong`) is read once more with nothing split off: it is proven like any
    /// other, and its `headHash` is then the hash of nothing, which is no claim's header.
    function _prove(bytes16 jobId, bytes calldata record, address[] calldata chunks, bool anyObjective)
        private
        view
        returns (IWorkProof.Proof memory)
    {
        (bool ok, bytes memory ret) = _askProof(jobId, record, chunks, HEADER_LEN);
        // Only the first four bytes of the revert data are wanted: the error's selector.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (!ok && anyObjective && bytes4(ret) == IWorkProof.HeadTooLong.selector) {
            (ok, ret) = _askProof(jobId, record, chunks, 0);
        }
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return abi.decode(ret, (IWorkProof.Proof));
    }

    function _askProof(bytes16 jobId, bytes calldata record, address[] calldata chunks, uint256 headLen)
        private
        view
        returns (bool ok, bytes memory ret)
    {
        (ok, ret) = WORK_PROOF.staticcall(
            chunks.length == 0
                ? abi.encodeCall(IWorkProof.prove, (jobId, record, headLen))
                : abi.encodeCall(IWorkProof.proveChunks, (jobId, chunks, headLen))
        );
    }

    function _headHash(uint256 id, Order storage o, Claim storage c) private view returns (bytes32) {
        return OrderHeader.hash(OrderHeader.ticket(block.chainid, address(this), id, o.seq, c.runner));
    }

    /// @dev The conditions under which a receipt pays this claim.
    function _requireSettles(uint256 id, Order storage o, Claim storage c, IWorkProof.Proof memory proof) private view {
        if (orderOfJob[c.jobId] != 0) revert JobUsed();
        if (proof.stateHash != COMPLETED) revert NotCompleted();
        if (proof.kindHash != o.kindHash) revert WrongKind();
        if (proof.headHash != _headHash(id, o, c)) revert WrongHeader();
        if (proof.specHash != o.specHash) revert WrongSpec();
    }

    /// @dev Pays a delivered order. State first, then the transfers, then Payroll.
    function _deliver(
        uint256 id,
        Order storage o,
        Claim storage c,
        bytes32 recordHash,
        bool proven,
        uint256[] memory agentIds
    ) private {
        uint96 fixedPrice = c.price;
        uint256 price = fixedPrice;
        // Rounded up, so the fee side never loses a fraction; the runner gets what is left.
        uint256 fee = (price * FEE_BPS + BPS - 1) / BPS;
        uint256 tip = (price * TIP_BPS + BPS - 1) / BPS;
        if (tip > price - fee) tip = price - fee;
        uint256 runnerPay = price - fee - tip;
        uint256 unused = o.escrow - price;
        uint256 bonds = o.state == State.Disputed ? uint256(o.bond) * 2 : o.bond;
        address runner = c.runner;

        o.state = State.Delivered;
        o.proven = proven;
        o.escrow = 0;
        o.spent = fixedPrice;
        _credit(o, unused);
        c.recordHash = recordHash;
        emit Delivered(id, c.jobId, runner, recordHash, proven, runnerPay, fee, tip, unused, bonds, agentIds);

        _send(runner, runnerPay + bonds);
        _send(o.employer, unused);
        _payPayroll(id, fee, tip, agentIds);
    }

    /// @dev Ends a challenged claim against the runner: the release share of its bond to the
    /// employer, the rest to the challenger together with the challenger's own bond.
    function _refute(uint256 id, Order storage o, Claim storage c) private {
        uint256 bond = o.bond;
        uint256 cut = _releaseCut(bond);
        _endClaim(id, o, c, End.Refuted, 0, cut, bond * 2 - cut);
    }

    /// @dev Ends a claim without delivery. This is the only place a bond leaves the desk other than
    /// with a delivery, and each call names exactly where it goes.
    function _endClaim(
        uint256 id,
        Order storage o,
        Claim storage c,
        End reason,
        uint256 toRunner,
        uint256 toEmployer,
        uint256 toChallenger
    ) private {
        address runner = c.runner;
        uint256 back = toEmployer + _close(id, o, reason == End.DisputeExpired);
        if (o.state == State.Open) {
            // Open again: the ramp goes on from where this claim found it. Never past the present,
            // because `rampFrom` was no later than the claim.
            // forge-lint: disable-next-line(unsafe-typecast)
            o.rampFrom += uint40(block.timestamp - c.claimedAt);
        }
        _credit(o, toEmployer);
        emit ClaimEnded(id, runner, reason, toRunner, toEmployer, toChallenger, o.state);
        _send(runner, toRunner);
        _send(c.challenger, toChallenger);
        _send(o.employer, back);
    }

    /// @dev An order nobody holds any more: open again, or refunded when it has expired (or when
    /// `refundNow`). Returns the escrow to send to the employer, already booked as returned.
    function _close(uint256 id, Order storage o, bool refundNow) private returns (uint256 escrow) {
        if (refundNow || block.timestamp >= o.expiresAt) {
            escrow = o.escrow;
            o.escrow = 0;
            o.state = State.Refunded;
            _credit(o, escrow);
            emit Refunded(id, escrow);
        } else {
            o.state = State.Open;
        }
    }

    /// @dev Adds to what the employer got back; called once for every transfer to the employer.
    /// The sum cannot pass its 96 bits. Whenever an order is open, `returned + escrow` fits: that
    /// is true at creation, and `claim` goes ahead only if `returned + escrow + bond` fits. Until
    /// the order is open again or finished, the employer can receive at most that bond and that
    /// escrow. So this addition, though checked, never reverts and never stands in the way of a
    /// payment.
    function _credit(Order storage o, uint256 amount) private {
        // An escrow, a bond or a part of one: each is a uint96.
        // forge-lint: disable-next-line(unsafe-typecast)
        o.returned += uint96(amount);
    }

    function _releaseCut(uint256 bond) private pure returns (uint256) {
        return bond * RELEASE_BPS / BPS;
    }

    function _send(address to, uint256 amount) private {
        if (amount != 0) IERC20(IMD).safeTransfer(to, amount);
    }

    /// @dev Hands the fee and the tip to Payroll. Payroll pulls them through an allowance; whatever
    /// it did not pull, for any reason, is sent by plain transfer (its `book()` picks that up), so
    /// exactly `fee + tip` leaves the desk whatever Payroll does. A tip of zero (a price of one
    /// wei) is not announced.
    function _payPayroll(uint256 id, uint256 fee, uint256 tip, uint256[] memory agentIds) private {
        uint256 total = fee + tip;
        if (total == 0) return;
        IERC20 imd = IERC20(IMD);
        imd.forceApprove(PAYROLL, total);
        _callPayroll(abi.encodeCall(IPayroll.pay, (fee, bytes32(id))));
        if (tip != 0) _callPayroll(abi.encodeCall(IPayroll.tip, (agentIds, tip)));
        uint256 left = imd.allowance(address(this), PAYROLL);
        if (left != 0) {
            imd.forceApprove(PAYROLL, 0);
            imd.safeTransfer(PAYROLL, left);
            emit PayrollFallback(id, left);
        }
    }

    /// @dev Tells the employer, if it asked. Runs after the reentrancy lock is released and after
    /// every state change and payment, so the employer may call back into the desk. The gas check
    /// comes first: an employer contract can rely on its callback having been offered the whole
    /// `CALLBACK_GAS`, whoever sent the transaction.
    function _notify(uint256 id) private {
        Order storage o = _orders[id];
        if (o.flags & FLAG_CALLBACK == 0 || o.notified) return;
        Claim storage c = _claims[id];
        bytes memory data = abi.encodeCall(IWorkEmployer.onWorkDelivered, (id, c.jobId, c.recordHash));
        address employer = o.employer;
        if (gasleft() < CALLBACK_GAS * 64 / 63 + GAS_SLACK) revert GasShort();
        // Set before the call, so a callback that calls `redeliver` on its own order finds nothing to do.
        o.notified = true;
        if (!_call(employer, CALLBACK_GAS, data)) {
            o.notified = false;
            emit CallbackFailed(id);
        }
    }

    /// @dev One Payroll call, always offered the whole `PAYROLL_GAS`: the check comes first, so a
    /// caller cannot push a payment onto the plain-transfer path, or change what Payroll does with
    /// it, by sending too little gas. Whether the call then succeeds does not matter here; what
    /// counts is how much of the allowance it took.
    function _callPayroll(bytes memory data) private {
        if (gasleft() < PAYROLL_GAS * 64 / 63 + GAS_SLACK) revert GasShort();
        _call(PAYROLL, PAYROLL_GAS, data);
    }

    /// @dev A call that may fail without stopping the caller: fixed gas, no return data copied, no
    /// code check on the target.
    function _call(address target, uint256 gasCap, bytes memory data) private returns (bool ok) {
        assembly ("memory-safe") {
            ok := call(gasCap, target, 0, add(data, 0x20), mload(data), 0, 0)
        }
    }

    /// @dev Records a condition that holds now. The answer is kept for good, so the target must
    /// have been offered its whole allowance: with less, some targets answer differently (one that
    /// reads another contract and falls back to zero when that read runs dry, for example).
    function _latch(uint256 id, Order storage o) private {
        if (gasleft() < CONDITION_GAS * 64 / 63 + GAS_SLACK) revert GasShort();
        (bool holds, uint256 value) = _condition(o);
        if (!holds) revert ConditionNotMet();
        o.condMet = true;
        o.rampFrom = _timestamp();
        emit Triggered(id, value);
    }

    /// @dev One gas-capped static call. Anything but a clean return of at least 32 bytes counts as
    /// "does not hold"; only the first word is read, so a large return costs nothing here.
    function _condition(Order storage o) private view returns (bool holds, uint256 value) {
        address target = o.condTarget;
        bytes memory data = o.flags & FLAG_COND_ARG == 0
            ? abi.encodePacked(o.condSelector)
            : abi.encodePacked(o.condSelector, o.condArg);
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(CONDITION_GAS, target, add(data, 0x20), mload(data), 0x00, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            value := mul(ok, mload(0x00))
        }
        if (ok) {
            uint256 cmp = o.condCmp;
            uint256 threshold = o.condThreshold;
            if (cmp == 1) holds = value >= threshold;
            else if (cmp == 2) holds = value <= threshold;
            else if (cmp == 3) holds = value > threshold;
            else if (cmp == 4) holds = value < threshold;
            else if (cmp == 5) holds = value == threshold;
            else holds = value != threshold;
        }
    }

    /// @dev A straight line from `minPay` to `maxPay` over `rampSecs`, rounded down in the employer's
    /// favour. A conditional order that has not been triggered is priced as if it were triggered
    /// now, which is what a claim that latches the condition would fix.
    function _price(Order storage o) private view returns (uint96) {
        uint256 from = o.rampFrom;
        uint256 elapsed = from == 0 ? 0 : block.timestamp - from;
        uint256 rampSecs = o.rampSecs;
        uint256 price = o.maxPay;
        if (elapsed < rampSecs) {
            uint256 minPay = o.minPay;
            price = minPay + (price - minPay) * elapsed / rampSecs;
        }
        // Between `minPay` and `maxPay`, which are both uint96.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint96(price);
    }

    /// @dev The block time as stored in orders and claims. Forty bits hold seconds for some
    /// thirty-four thousand years.
    function _timestamp() private view returns (uint40) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint40(block.timestamp);
    }
}
