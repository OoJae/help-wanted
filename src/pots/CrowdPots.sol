// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICrowdPots} from "../interfaces/ICrowdPots.sol";
import {IWorkEmployer, IWorkOrders} from "../interfaces/IWorkOrders.sol";
import {SpecText} from "../desk/SpecText.sol";

/// @title The two desk functions that end a claim which has run out of time
/// @dev They belong to the desk's implementation and are not in the frozen `IWorkOrders`, so
/// CrowdPots declares them here. Anyone may call either one, and the desk refuses a call that
/// comes too early.
interface IDeskUpkeep {
    /// @notice Removes a runner that registered no job within the desk's claim window. Its bond
    /// goes to the employer and the order is open again, or refunded if it has expired.
    function evict(uint256 id) external;

    /// @notice Ends a claim whose delivery time has passed with nothing settled. A registered job:
    /// the bond goes to the employer and the order is open again, or refunded if it has expired. A
    /// challenged delivery claim that nothing decided: the order is refunded.
    function timeout(uint256 id) external;
}

/// @title CrowdPots: many wallets commission one swarm job together
/// @notice Anyone opens a pot for a pinned job spec, a target amount and a deadline. Wallets chip
/// in IMD. When the target is met, anyone calls `launch` and the pot becomes the employer of one
/// order on the hire desk for the whole amount. If the deadline passes first, or the order ends
/// without delivery, every chip is refundable pro rata, together with anything extra the desk sent
/// back (a runner's forfeited bond). If the work is delivered for less than was raised, the
/// difference is refundable pro rata too.
///
/// There is no owner, no fee and no setter. A pot's money can leave this contract in two ways
/// only: to the desk as the escrow of the pot's own order, or back to the pot's contributors.
///
/// @dev How contributors are protected from the person who opened the pot:
/// - Every order parameter the opener chooses is in `Terms`, fixed and published when the pot
///   opens, and bounded so that money cannot be parked for long: at most 30 days of collecting,
///   one more day in which a pot that filled can still be launched, 30 days waiting for a runner,
///   and, once a runner has taken the order, the desk's one-hour claim window and 30 days for
///   delivery. Each of these ends when somebody makes the call that ends it; `reconcile` makes
///   every one of them (see below).
/// - What a contributor cannot judge is not offered at all. A pot's order never names a single
///   allowed runner, never has an arbiter and never carries a condition, so any bonded runner may
///   take it and only a receipt (or, where the pot allowed it, an unchallenged bonded claim) pays.
/// - The opener has no rights after opening. Launching, reconciling and refunding are open to all.
///
/// How the books are kept: one contract holds many pots' IMD, so a pot never infers anything from
/// a balance change. It learns how its order ended from the desk's `accountOf` view, and keeps the
/// job id and record hash the desk reports through `onWorkDelivered`. `owed` is the running total
/// of everything booked to contributors; the contract's IMD balance is never below it.
///
/// Nothing on the desk ends by itself: an order that ran out of time stays as it is until somebody
/// calls the desk. `reconcile` and `claimRefund` make those calls for the pot's order (`refund`,
/// `evict`, `timeout`), so a contributor needs neither a keeper nor any knowledge of the desk. The
/// one call they do not make is `finalize`, which pays a runner whose delivery claim nobody
/// challenged: that is left to the runner, who has every reason to make it.
///
/// Trust: this contract relies on the desk it was deployed with to report `accountOf` honestly
/// and to push what it reports. Both are immutable code from the same launch. As a second line, a
/// settlement that would book more than the contract holds reverts (`DeskShortfall`) instead of
/// borrowing from other pots.
///
/// What is not checked on chain, and a contributor should look at before chipping in:
/// - That the pot's kind is one the swarm really writes for the job described. Every pot names its
///   kind in text (`Terms.kind`, published in the opening event and readable through `kindOf`),
///   and the desk pins the hash of that text. A pot with a kind no work record carries can never
///   be paid on a receipt: one whose kind the reader does not know as one of the swarm's job
///   templates deserves no chips.
/// - Whether the pot allows the bonded-claim path, and what that means (`Terms.allowClaimed`).
/// - The size of the bond next to the target. The bond is the most a runner loses by taking the
///   order and not delivering, and it loses all of it by letting the order time out. It loses
///   none of it when the registered job's receipt shows that the swarm did not complete the job
///   or ran it under another kind: the desk then returns the bond whole, bars nobody, and the
///   order is open again, or refunded if its hire window has passed. So a runner can leave the
///   order, or end a pot whose hire window has passed, for the price of one swarm job and gas
///   (`docs/THREATS.md`, W2, W3 and C2). A larger bond makes a stall dearer, and it also makes
///   the order harder to take and, on the claimed path, a delivery claim harder to challenge,
///   since a challenger posts the same amount.
///
/// Reentrancy and events: every function that moves money holds a transient lock, and the only
/// contracts ever called are the two fixed at construction, IMD and the desk. Some events are
/// emitted after a call to the desk because what they report is only known then (an order id, how
/// an order ended); with the lock held, none of this contract's functions that move money can run
/// in between.
contract CrowdPots is ICrowdPots, IWorkEmployer, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum Stage {
        None,
        /// Collecting chips, or full and waiting for someone to call `launch`.
        Funding,
        /// The pot is the employer of one order on the desk.
        Hiring,
        /// The order was delivered. Whatever the desk sent back is refundable pro rata.
        Delivered,
        /// The pot did not hire in time, or its order ended without delivery. Every chip is
        /// refundable pro rata, with anything extra the desk sent back.
        Refundable,
        /// Not a pot but a series: a standing template that opens one ordinary pot after another.
        Series
    }

    /// @notice Everything about the eventual order that a pot's opener chooses. Fixed when the pot
    /// opens, so contributors see all of it before they chip in.
    struct Terms {
        /// The `kind` string the job's work record must carry, as text, for example `audit` or
        /// `skill:research-report`: the name of the swarm template the runner must open the job
        /// with. Its keccak256 is what the pot stores and what the desk pins for the order. 1 to
        /// `MAX_KIND_LENGTH` bytes under the character rules of a spec (`SpecText`), so that the
        /// text and what a work record holds between its quotes are the same bytes. Nothing on
        /// chain can tell whether the swarm writes that kind for the job described.
        string kind;
        /// What the pot collects. It becomes the order's `maxPay`, the most the job can cost.
        uint96 target;
        /// The order's price starts here and rises to `target` over `rampSecs`. A runner's claim
        /// fixes the price; what it leaves of the target comes back to the contributors.
        uint96 minPay;
        /// Zero when `minPay` equals `target`; otherwise 1 to `hireSecs`.
        uint32 rampSecs;
        /// What a runner must post to take the order. It is forfeited to the pot, and so to its
        /// contributors, if the runner lets the order time out, registers a job that is not the
        /// order's, or claims a delivery that a receipt contradicts. It comes back to the runner
        /// whole when the registered job's receipt shows the swarm did not complete the job or
        /// ran it under another kind (the desk's rules W2 and W3 in `docs/THREATS.md`). Between
        /// the desk's minimum and `target`.
        uint96 bond;
        /// How long a runner has, after registering the job, for a receipt to exist.
        uint32 deliverySecs;
        /// How long the order waits for a runner after `launch`. Untaken after that, it is refunded.
        uint32 hireSecs;
        /// How long the pot collects chips, counted from the moment it opens.
        uint32 fundSecs;
        /// Whether the order accepts the desk's bonded-claim path: a runner states, without a
        /// receipt, that the job was delivered, and is paid if nobody challenges the claim within
        /// the desk's 24-hour window. False means only an on-chain receipt pays.
        ///
        /// What the contributors of a pot that sets this accept, stated plainly:
        /// - A claim that misreports, and that nobody challenges in time, is paid. Somebody has to
        ///   watch the order and post the challenge bond (equal to the runner's).
        /// - A challenge that nothing decides refunds the order, even when the claim was true:
        ///   with no receipt by the delivery deadline the escrow comes back to the pot and the
        ///   challenger loses nothing. While IdentityMD's receipts are late, a challenger can stop
        ///   a true claim from being paid.
        /// - That refund ends the pot, because a pot hires once. One party with two addresses can
        ///   bring it about (claim delivery, challenge itself, wait out the delivery time) for a
        ///   tenth of the bond, whatever is left of the hire window. On a receipt-only pot the
        ///   same stall by silence costs the whole bond and the order is open again afterwards;
        ///   but a runner whose registered job has a receipt that does not complete, or that is
        ///   of another kind, leaves with its whole bond, and once the hire window has passed
        ///   that ending refunds the pot and ends it, for the price of one swarm job.
        ///
        /// The desk's answer to the first two is an arbiter, and a pot cannot name one, because
        /// contributors could not judge it. A receipt of the job decides, for the runner or against
        /// it, whenever somebody submits it before the claim has been paid or has run out of time.
        bool allowClaimed;
    }

    /// @notice One pot as stored. `stage` moves lazily: see `stageOf` for the current answer.
    struct Pot {
        bytes32 specHash;
        /// keccak256 of the kind text the opener named; `kindOf` gives the text back.
        bytes32 kindHash;
        uint96 target;
        /// Sum of every chip. Never above `target`; never changes after `launch`.
        uint96 raised;
        /// Last second at which the pot accepts chips. A pot that is full by then can be launched
        /// for `LAUNCH_GRACE` longer; one that is not is refundable from the next second.
        uint40 deadline;
        Stage stage;
        bool allowClaimed;
        uint96 minPay;
        uint96 bond;
        uint32 rampSecs;
        uint32 deliverySecs;
        address opener;
        uint32 hireSecs;
        uint32 fundSecs;
        /// Once settled: IMD still waiting to be claimed by this pot's contributors.
        uint96 pool;
        /// Once settled: the chips whose owners have not claimed yet.
        uint96 chipsLeft;
        /// The `expiresAt` the pot gave its order.
        uint40 orderExpiresAt;
        /// The series this pot is a round of, or zero.
        uint64 seriesId;
        /// The job the desk reported as delivered, or zero.
        bytes16 jobId;
        /// The pot's order on the desk. Meaningful from `Stage.Hiring` on.
        uint256 orderId;
        /// The record hash the desk reported with the delivery, or zero. It stays zero if the
        /// desk's callback never arrived, and on the claimed path it is the hash the runner named,
        /// which the desk replaces in its own books if the order is later matched to its receipt.
        /// The desk's record of the order is the one to trust; this is a copy for convenience.
        bytes32 recordHash;
    }

    /// @notice One contributor's stake in one pot.
    struct Chip {
        uint96 amount;
        /// What `claimRefund` paid this contributor. Meaningful once `claimed`.
        uint96 refunded;
        bool claimed;
    }

    /// @notice Below this a pot could not pay for a swarm job at all: the swarm's own fee is 0.5 IMD.
    uint96 public constant MIN_TARGET = 1e18;
    /// @notice The shortest time a pot may collect chips.
    uint32 public constant MIN_FUND_SECS = 1 hours;
    /// @notice The longest time a pot may collect chips.
    uint32 public constant MAX_FUND_SECS = 30 days;
    /// @notice How long after its deadline a pot that filled in time can still be launched. A pot
    /// can fill in its very last second; without this it could then never hire.
    uint32 public constant LAUNCH_GRACE = 1 days;
    /// @notice The shortest time a pot's order may wait for a runner.
    uint32 public constant MIN_HIRE_SECS = 1 days;
    /// @notice The longest time a pot's order may wait for a runner.
    uint32 public constant MAX_HIRE_SECS = 30 days;
    /// @notice The longest delivery time a pot may give a runner. The shortest is the desk's own.
    uint32 public constant MAX_DELIVERY_SECS = 30 days;
    /// @notice The longest kind text a pot may name, in bytes.
    uint256 public constant MAX_KIND_LENGTH = 64;

    /// @notice The IMD token.
    IERC20 public immutable IMD;
    /// @notice The hire desk every pot orders through.
    IWorkOrders public immutable WORK_ORDERS;

    /// @notice Pots and series opened so far. Ids run from 1 to `potCount`; id 0 never exists.
    uint256 public override potCount;

    /// @notice IMD booked to contributors: the chips of pots that have not hired, plus every
    /// settled pot's unclaimed refunds. `IMD.balanceOf(this) >= owed` always holds; the balance
    /// can be higher by what the desk pushed for orders not yet reconciled and by stray transfers.
    uint256 public owed;

    /// @notice The pot whose order this is, or zero if the order is not a pot's.
    mapping(uint256 orderId => uint256 potId) public potOfOrder;

    /// @notice The pot most recently opened for a series, or zero before its first chip.
    mapping(uint256 seriesId => uint256 potId) public currentRound;

    mapping(uint256 potId => Pot) private _pots;
    mapping(uint256 potId => mapping(address contributor => Chip)) private _chips;
    mapping(bytes32 kindHash => string) private _kinds;

    /// @notice The text behind a spec hash, published once so anyone can read what a pot will order.
    event SpecPinned(bytes32 indexed specHash, bytes spec);
    /// @notice A pot opened. `seriesId` is zero for a one-off pot, or the series this is a round of.
    /// `terms` carries the job kind as text.
    event PotOpened(
        uint256 indexed potId,
        address indexed opener,
        uint256 indexed seriesId,
        bytes32 specHash,
        uint40 deadline,
        Terms terms
    );
    /// @notice A series opened, with its job kind as text in `terms`. Its rounds are announced by
    /// `PotOpened` as chips arrive.
    event SeriesOpened(uint256 indexed seriesId, address indexed opener, bytes32 indexed specHash, Terms terms);
    /// @notice `payer` put `amount` into the pot for `beneficiary`; `raised` is the pot's new total.
    /// For a chip sent to a series id, `potId` is the round that took it.
    event ChippedIn(
        uint256 indexed potId, address indexed beneficiary, address indexed payer, uint256 amount, uint256 raised
    );
    /// @notice The pot reached its target and can be launched by anyone.
    event PotFilled(uint256 indexed potId, uint256 raised);
    /// @notice The pot became the employer of order `orderId` on the desk, for `amount`.
    event PotLaunched(
        uint256 indexed potId, uint256 indexed orderId, address indexed launcher, uint256 amount, uint40 orderExpiresAt
    );
    /// @notice The desk reported the pot's order as delivered.
    event WorkDelivered(uint256 indexed potId, uint256 indexed orderId, bytes16 jobId, bytes32 recordHash);
    /// @notice The pot's books are final. `spent` is what the desk paid for delivered work and
    /// `refundable` is what the pot's contributors now share.
    event PotSettled(uint256 indexed potId, Stage stage, uint256 spent, uint256 refundable);
    /// @notice `contributor` was paid their share of what the pot had to give back (possibly zero).
    event RefundPaid(uint256 indexed potId, address indexed contributor, uint256 amount);

    /// @notice A constructor argument is the zero address.
    error ZeroAddress();
    /// @notice The desk this contract was deployed with escrows a different token.
    error DeskTokenMismatch();
    /// @notice The kind text is empty.
    error KindMissing();
    /// @notice The kind text is longer than `MAX_KIND_LENGTH`.
    error KindTooLong();
    /// @notice The spec, or the kind text, breaks the desk's character rules at byte `at`: the
    /// lowest index of a byte that is not allowed where it stands (see `SpecText`). An empty text
    /// reports 0 and a spec that is too long reports the index of the first byte over the limit.
    error SpecInvalid(uint256 at);
    /// @notice `target` is below `MIN_TARGET`.
    error TargetTooSmall();
    /// @notice `minPay` must be 1 wei to `target`; `rampSecs` must be zero when they are equal and
    /// 1 to `hireSecs` otherwise.
    error BadPriceRamp();
    /// @notice `bond` must be between the desk's minimum and `target`.
    error BondOutOfRange();
    /// @notice `deliverySecs` must be between the desk's minimum and `MAX_DELIVERY_SECS`.
    error DeliveryOutOfRange();
    /// @notice `hireSecs` must be between `MIN_HIRE_SECS` and `MAX_HIRE_SECS`.
    error HireWindowOutOfRange();
    /// @notice `fundSecs` must be between `MIN_FUND_SECS` and `MAX_FUND_SECS`.
    error FundingWindowOutOfRange();
    /// @notice A chip cannot belong to the zero address or to this contract.
    error BadBeneficiary();
    /// @notice The pot is at stage `have`, which does not allow this call.
    error WrongStage(Stage have);
    /// @notice The pot has not reached its target; `missing` is what it still needs.
    error NotFull(uint256 missing);
    /// @notice The time in which the pot could be launched has passed.
    error PastDeadline();
    /// @notice The text passed to `launch` is not the spec the pot pinned.
    error WrongSpec();
    /// @notice Only the desk may report a delivery.
    error NotDesk();
    /// @notice The desk reported a delivery for an order no pot placed.
    error UnknownOrder(uint256 orderId);
    /// @notice The desk did not pull exactly the pot's target when the order was created.
    error DeskPulledWrongAmount(uint256 allowanceLeft);
    /// @notice The desk answered `createOrder` with the id of an order a pot already has.
    error OrderIdReused(uint256 orderId);
    /// @notice The desk does not name this contract as the employer of the pot's order.
    error NotOurOrder(uint256 orderId);
    /// @notice The desk reports having returned more than this contract holds unbooked.
    error DeskShortfall(uint256 owed, uint256 held);

    /// @param imd The IMD token.
    /// @param workOrders The hire desk every pot orders through.
    /// @dev Stores the two addresses and calls nothing. The desk is checked when a pot opens.
    constructor(address imd, address workOrders) {
        if (imd == address(0) || workOrders == address(0)) revert ZeroAddress();
        IMD = IERC20(imd);
        WORK_ORDERS = IWorkOrders(workOrders);
    }

    // ------------------------------------------------------------------------------------------
    // Opening
    // ------------------------------------------------------------------------------------------

    /// @notice Opens a pot. Anyone may; the opener gets no rights over it.
    /// @param terms The order the pot will place if it fills, the job kind in text included. See
    /// `Terms` for each bound. The whole of it is published in `PotOpened`.
    /// @param spec The job text, byte for byte as a runner must send it to the swarm. It has to
    /// pass the desk's character rules (`SpecText`); only its hash is stored, and the text is
    /// published in `SpecPinned`.
    /// @param firstChip IMD the opener chips in at once (needs an allowance), or zero.
    /// @return potId The new pot's id.
    /// @dev Reverts if a term is out of bounds, if the spec breaks the rules, or if the desk does
    /// not answer its own constants (a desk address without code).
    function openPot(Terms calldata terms, bytes calldata spec, uint256 firstChip)
        external
        nonReentrant
        returns (uint256 potId)
    {
        (bytes32 kindHash, bytes32 specHash) = _pin(terms, spec);
        potId = _create(terms, kindHash, specHash, msg.sender, 0);
        if (firstChip != 0) _chip(potId, firstChip, msg.sender);
    }

    /// @notice Opens a series: a recurring pot, such as a daily commission. A series holds no
    /// money. A chip sent to its id lands in its current round, an ordinary pot with these terms
    /// that collects for `terms.fundSecs` from its first chip, whoever sends it; when that round
    /// stops collecting (full, launched or out of time) the next chip opens the next round.
    /// @dev A series shares the pot id space so that helpers written against `ICrowdPots` can fund
    /// a recurring job with `chipInFor(seriesId, ...)` and nothing else. It cannot be closed, and
    /// needs no closing: nobody is obliged to chip in.
    ///
    /// The series id is for standing funders, who mean "the next round, whichever it is". A chip
    /// meant for one particular round should be sent to that round's own id (`currentRound`): if
    /// the round has filled or run out in the meantime, such a chip takes nothing, where the same
    /// chip sent to the series id would open the next round and stay there until that round ends.
    /// A round's time to collect runs from its first chip, whoever sends it and however small:
    /// anyone can start a round's clock with one wei.
    /// @return seriesId The id to pass to `chipIn` and `chipInFor`.
    function openSeries(Terms calldata terms, bytes calldata spec) external returns (uint256 seriesId) {
        (bytes32 kindHash, bytes32 specHash) = _pin(terms, spec);
        seriesId = ++potCount;
        Pot storage s = _pots[seriesId];
        _writeTerms(s, terms, kindHash, specHash, msg.sender);
        s.stage = Stage.Series;
        emit SeriesOpened(seriesId, msg.sender, specHash, terms);
    }

    // ------------------------------------------------------------------------------------------
    // Chipping in
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ICrowdPots
    /// @dev Needs an IMD allowance for at least what is taken. Never reverts because a pot is
    /// full, launched, out of time or unknown: it takes nothing and returns zero, so a helper
    /// contract can call it blindly and keep what was not taken. A chip cannot be withdrawn while
    /// the pot is collecting; it comes back through `claimRefund` if the pot does not deliver.
    ///
    /// With a series id the chip goes to the series' current round and opens the next round when
    /// the last one has stopped collecting; the `ChippedIn` event names the round that took it.
    /// To fund one particular round and nothing after it, pass that round's own id.
    function chipIn(uint256 potId, uint256 amount) external override nonReentrant returns (uint256 taken) {
        taken = _chip(potId, amount, msg.sender);
    }

    /// @inheritdoc ICrowdPots
    /// @dev The caller pays; `beneficiary` owns the chip and receives any refund of it. Reverts
    /// with `BadBeneficiary` for the zero address and for this contract, where a refund would be
    /// stranded. Everything said on `chipIn` applies, series ids included.
    function chipInFor(uint256 potId, uint256 amount, address beneficiary)
        external
        override
        nonReentrant
        returns (uint256 taken)
    {
        taken = _chip(potId, amount, beneficiary);
    }

    // ------------------------------------------------------------------------------------------
    // Hiring
    // ------------------------------------------------------------------------------------------

    // The desk's id for the new order is known only once the desk has answered, so the two writes
    // that record it come after that call. This function, and every other one that moves money,
    // holds the contract's transient lock, and the only contracts called are IMD and the desk.
    // slither-disable-start reentrancy-no-eth
    /// @notice Turns a full pot into an order on the desk for the whole amount. Anyone may call,
    /// once per pot, from the moment the pot is full until `LAUNCH_GRACE` after its deadline.
    /// @param spec The pot's pinned spec text (the pot stores only its hash).
    /// @return orderId The desk's id for the pot's order.
    /// @dev The order is built from the pot's terms and nothing else: no single allowed runner, no
    /// arbiter, no condition, a callback to this contract. Reverts if the pot is not full, not
    /// collecting any more, or if the desk refuses the order; a refused launch changes nothing and
    /// the chips stay refundable once the time to launch has passed.
    function launch(uint256 potId, bytes calldata spec) external nonReentrant returns (uint256 orderId) {
        Pot storage p = _pots[potId];
        if (p.stage != Stage.Funding) revert WrongStage(p.stage);
        uint96 amount = p.target;
        if (p.raised != amount) revert NotFull(amount - p.raised);
        if (block.timestamp > uint256(p.deadline) + LAUNCH_GRACE) revert PastDeadline();
        if (keccak256(spec) != p.specHash) revert WrongSpec();

        uint40 expiresAt = SafeCast.toUint40(block.timestamp) + p.hireSecs;
        p.stage = Stage.Hiring;
        p.orderExpiresAt = expiresAt;
        owed -= amount;

        uint8 flags = WORK_ORDERS.FLAG_CALLBACK();
        if (p.allowClaimed) flags |= WORK_ORDERS.FLAG_ALLOW_CLAIMED();
        IWorkOrders.OrderParams memory order = IWorkOrders.OrderParams({
            kindHash: p.kindHash,
            minPay: p.minPay,
            maxPay: amount,
            rampSecs: p.rampSecs,
            deliverySecs: p.deliverySecs,
            expiresAt: expiresAt,
            bond: p.bond,
            flags: flags,
            runnerOnly: address(0),
            arbiter: address(0),
            condTarget: address(0),
            condSelector: bytes4(0),
            condArg: bytes32(0),
            condCmp: 0,
            condThreshold: 0
        });

        IMD.forceApprove(address(WORK_ORDERS), amount);
        orderId = WORK_ORDERS.createOrder(order, spec);

        // The allowance was exactly the target, so a spent allowance means the desk pulled exactly
        // the target: no balance arithmetic, which other pots' money would blur.
        uint256 allowanceLeft = IMD.allowance(address(this), address(WORK_ORDERS));
        if (allowanceLeft != 0) revert DeskPulledWrongAmount(allowanceLeft);
        // From here on the pot reads this order's account, so the id must be new to this contract
        // and the desk must agree that this contract is the employer.
        if (potOfOrder[orderId] != 0) revert OrderIdReused(orderId);
        // Only the employer is wanted here; the order's amounts are read when it has ended.
        // slither-disable-next-line unused-return
        (, address employer,,,) = WORK_ORDERS.accountOf(orderId);
        if (employer != address(this)) revert NotOurOrder(orderId);

        potOfOrder[orderId] = potId;
        p.orderId = orderId;
        emit PotLaunched(potId, orderId, msg.sender, amount, expiresAt);
    }

    // slither-disable-end reentrancy-no-eth

    /// @inheritdoc IWorkEmployer
    /// @dev Only the desk may call, and only for an order a pot placed. It records the job id and
    /// the record hash and moves no money: the amounts are read from the desk in `reconcile`, so a
    /// callback that fails or never arrives costs the contributors nothing. It hires nothing
    /// either; the desk's gas allowance for this call would not cover a new order.
    function onWorkDelivered(uint256 orderId, bytes16 jobId, bytes32 recordHash) external override {
        if (msg.sender != address(WORK_ORDERS)) revert NotDesk();
        uint256 potId = potOfOrder[orderId];
        if (potId == 0) revert UnknownOrder(orderId);
        Pot storage p = _pots[potId];
        p.jobId = jobId;
        p.recordHash = recordHash;
        emit WorkDelivered(potId, orderId, jobId, recordHash);
    }

    // ------------------------------------------------------------------------------------------
    // Settling and refunding
    // ------------------------------------------------------------------------------------------

    /// @notice Brings a pot's books up to date. Anyone may call; `claimRefund` does it by itself.
    /// @return stage The pot's stage afterwards.
    /// @dev A pot that did not hire in time (unfilled at its deadline, or full and not launched
    /// within `LAUNCH_GRACE` after it) becomes `Refundable` for what it raised. A hiring pot asks
    /// the desk how its order stands: delivered makes it `Delivered`, cancelled or refunded makes
    /// it `Refundable`, and in both cases the refundable amount is what the desk says it sent back
    /// over the order's whole life, forfeited bonds included. An order that has been released,
    /// evicted or timed out any number of times is simply still hiring.
    ///
    /// Before it reads the desk, this makes the one call on the desk that the order's state may
    /// be waiting for, because nothing there ends by itself:
    /// - open and past its expiry: `refund`, which returns the escrow;
    /// - held by a runner that registered no job: `evict`, good once the desk's claim window has
    ///   passed (the runner's bond comes to the pot);
    /// - a registered job, or a challenged delivery claim: `timeout`, good once the delivery time
    ///   has passed (a registered job forfeits the bond to the pot; an undecided challenge refunds
    ///   the order). A receipt that lands after such a timeout no longer pays that runner.
    /// The desk refuses each of these when it comes too early, and a refusal is not an error here:
    /// the pot is then simply still hiring. A delivery claim nobody challenged is paid by
    /// `finalize` on the desk, which is left to the runner.
    ///
    /// Reverts with `DeskShortfall` if the desk reports more than this contract holds unbooked.
    function reconcile(uint256 potId) external nonReentrant returns (Stage stage) {
        stage = _reconcile(potId, _pots[potId]);
    }

    // Both functions below first have the desk end what ran out of time (`_reconcile`), and only
    // then book and pay: what the desk sent back is not known before that call. Both hold the
    // contract's transient lock, and the desk is the launch's own fixed code.
    // slither-disable-start reentrancy-no-eth
    /// @notice Pays `contributor` their share of what a settled pot has to give back. Anyone may
    /// call for anyone: the money only ever goes to the contributor, which is how a contributor
    /// that is a contract and cannot call this itself still gets paid. A chip cannot be moved to
    /// another address, so whoever makes the call chooses when the refund is paid and nothing
    /// else; a contract that keeps books of its own reads what it was paid from `chipOf`.
    /// @return paid IMD sent. Zero if the contributor has no chip, has claimed already, or the
    /// order was delivered at the full price with nothing sent back.
    /// @dev It first does what `reconcile` does, calls on the desk included, so one call is enough
    /// after a runner went silent on an expired order. The share is `pool * chip / chipsLeft`,
    /// taken from what is left at that moment. Each claimer gets at least the rounded-down pro
    /// rata share of the original amount, and the last one gets everything that remains, so the
    /// pot pays out to the wei. Reverts with `WrongStage` while the pot is still collecting or
    /// hiring; nothing done on the way, a call on the desk included, survives that revert.
    function claimRefund(uint256 potId, address contributor) external nonReentrant returns (uint256 paid) {
        Pot storage p = _settled(potId);
        paid = _pay(potId, p, contributor);
    }

    /// @notice `claimRefund` for several contributors of one pot. The caller chooses the list and
    /// pays the gas for its length; addresses with nothing to claim are skipped.
    /// @return paid IMD sent in total.
    /// @dev The loop runs over the caller's own list and over nothing stored, so its length costs
    /// only the caller. No pot depends on it: every contributor can always be paid alone with
    /// `claimRefund`, however many contributors a pot has.
    function claimRefunds(uint256 potId, address[] calldata contributors) external nonReentrant returns (uint256 paid) {
        Pot storage p = _settled(potId);
        for (uint256 i; i < contributors.length; ++i) {
            paid += _pay(potId, p, contributors[i]);
        }
    }

    // slither-disable-end reentrancy-no-eth

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ICrowdPots
    /// @dev For a series: what its current round still needs, or the full target when the next
    /// chip would open a new round.
    function remaining(uint256 potId) external view override returns (uint256) {
        Pot storage p = _pots[potId];
        if (p.stage != Stage.Series) return _remaining(p);
        uint256 round = currentRound[potId];
        if (round != 0) {
            uint256 need = _remaining(_pots[round]);
            if (need != 0) return need;
        }
        return p.target;
    }

    /// @notice The pot as stored, terms included. `stage` here can lag: see `stageOf`.
    function potOf(uint256 potId) external view returns (Pot memory) {
        return _pots[potId];
    }

    /// @notice The pot's stage as `reconcile` would leave it now: a pot that ran out of time to
    /// hire reads `Refundable`, and a hiring pot reads `Delivered` or `Refundable` once the desk
    /// says so.
    /// @dev It looks one step ahead for an order that expired with nobody holding it: `reconcile`
    /// has the desk refund such an order, so the pot already reads `Refundable` here. It cannot
    /// look ahead for an order a runner still holds past its time, because the frozen desk
    /// interface does not show when a claim runs out: such a pot reads `Hiring` until `reconcile`
    /// or `claimRefund` has had the desk end the claim.
    function stageOf(uint256 potId) external view returns (Stage stage) {
        (stage,,) = _peek(_pots[potId], true);
    }

    /// @notice A contributor's chip in a pot, and what was refunded for it.
    function chipOf(uint256 potId, address contributor)
        external
        view
        returns (uint256 amount, uint256 refunded, bool claimed)
    {
        Chip storage c = _chips[potId][contributor];
        return (c.amount, c.refunded, c.claimed);
    }

    /// @notice What `claimRefund(potId, contributor)` would pay if it were called now.
    /// @dev Like `stageOf`, it counts on the desk refunding an order that expired untaken, and
    /// reads zero for an order a runner still holds past its time, although `claimRefund` may then
    /// end that claim and pay. A simulated call of `claimRefund` gives the exact figure.
    function refundOf(uint256 potId, address contributor) external view returns (uint256) {
        Pot storage p = _pots[potId];
        (Stage stage, uint256 pool,) = _peek(p, true);
        if (stage != Stage.Delivered && stage != Stage.Refundable) return 0;
        Chip storage c = _chips[potId][contributor];
        if (c.claimed || c.amount == 0) return 0;
        // A pot whose stored stage lags has paid nobody yet, so every chip is still unclaimed.
        uint256 chipsLeft = p.stage == stage ? p.chipsLeft : p.raised;
        return pool * c.amount / chipsLeft;
    }

    /// @notice The kind text behind a kind hash (`potOf(potId).kindHash`), as the pot's opener
    /// wrote it, or an empty string if no pot or series has named that kind.
    /// @dev This says what a hash stands for, not that the swarm writes such a kind: a reader
    /// still has to know the swarm's job templates.
    function kindOf(bytes32 kindHash) external view returns (string memory) {
        return _kinds[kindHash];
    }

    // ------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------

    /// @dev Checks the terms against this contract's bounds and the desk's own minimums, checks the
    /// kind and the spec, keeps the kind's text for `kindOf`, and publishes the spec's text.
    function _pin(Terms calldata t, bytes calldata spec) private returns (bytes32 kindHash, bytes32 specHash) {
        bytes calldata kind = bytes(t.kind);
        if (kind.length == 0) revert KindMissing();
        if (kind.length > MAX_KIND_LENGTH) revert KindTooLong();
        _checkText(kind);
        if (t.target < MIN_TARGET) revert TargetTooSmall();
        if (t.hireSecs < MIN_HIRE_SECS || t.hireSecs > MAX_HIRE_SECS) revert HireWindowOutOfRange();
        if (t.fundSecs < MIN_FUND_SECS || t.fundSecs > MAX_FUND_SECS) revert FundingWindowOutOfRange();
        if (t.minPay == 0 || t.minPay > t.target) revert BadPriceRamp();
        if (t.minPay == t.target ? t.rampSecs != 0 : (t.rampSecs == 0 || t.rampSecs > t.hireSecs)) {
            revert BadPriceRamp();
        }
        // First use of the desk: a pot must not open against a desk that escrows another token, or
        // with a bond or delivery time the desk would refuse at launch.
        if (WORK_ORDERS.IMD() != address(IMD)) revert DeskTokenMismatch();
        if (t.bond < WORK_ORDERS.MIN_BOND() || t.bond > t.target) revert BondOutOfRange();
        if (t.deliverySecs < WORK_ORDERS.MIN_DELIVERY() || t.deliverySecs > MAX_DELIVERY_SECS) {
            revert DeliveryOutOfRange();
        }
        _checkText(spec);
        kindHash = keccak256(kind);
        // Stored once per kind, so that a round of a series can publish the text again and anyone
        // can read what a pot's `kindHash` stands for.
        if (bytes(_kinds[kindHash]).length == 0) _kinds[kindHash] = t.kind;
        specHash = keccak256(spec);
        emit SpecPinned(specHash, spec);
    }

    /// @dev Reverts unless `text` is text the desk accepts as a spec. The rule is the desk's own
    /// code (`SpecText`), so a pot can never pin a spec its order would be refused for.
    function _checkText(bytes calldata text) private pure {
        uint256 at = SpecText.firstBad(text);
        if (at != SpecText.NONE) revert SpecInvalid(at);
    }

    function _writeTerms(Pot storage p, Terms memory t, bytes32 kindHash, bytes32 specHash, address opener) private {
        p.specHash = specHash;
        p.kindHash = kindHash;
        p.target = t.target;
        p.allowClaimed = t.allowClaimed;
        p.minPay = t.minPay;
        p.bond = t.bond;
        p.rampSecs = t.rampSecs;
        p.deliverySecs = t.deliverySecs;
        p.opener = opener;
        p.hireSecs = t.hireSecs;
        p.fundSecs = t.fundSecs;
    }

    function _termsOf(Pot storage p) private view returns (Terms memory) {
        return Terms({
            kind: _kinds[p.kindHash],
            target: p.target,
            minPay: p.minPay,
            rampSecs: p.rampSecs,
            bond: p.bond,
            deliverySecs: p.deliverySecs,
            hireSecs: p.hireSecs,
            fundSecs: p.fundSecs,
            allowClaimed: p.allowClaimed
        });
    }

    function _create(Terms memory t, bytes32 kindHash, bytes32 specHash, address opener, uint256 seriesId)
        private
        returns (uint256 potId)
    {
        potId = ++potCount;
        Pot storage p = _pots[potId];
        _writeTerms(p, t, kindHash, specHash, opener);
        uint40 deadline = SafeCast.toUint40(block.timestamp) + t.fundSecs;
        p.deadline = deadline;
        p.stage = Stage.Funding;
        if (seriesId != 0) p.seriesId = SafeCast.toUint64(seriesId);
        emit PotOpened(potId, opener, seriesId, specHash, deadline, t);
    }

    /// @dev The round of a series that takes the next chip, opened here if the last one has
    /// stopped collecting.
    function _round(uint256 seriesId, Pot storage s) private returns (uint256 potId) {
        potId = currentRound[seriesId];
        if (potId != 0 && _remaining(_pots[potId]) != 0) return potId;
        potId = _create(_termsOf(s), s.kindHash, s.specHash, s.opener, seriesId);
        currentRound[seriesId] = potId;
    }

    function _remaining(Pot storage p) private view returns (uint256) {
        if (p.stage != Stage.Funding || block.timestamp > p.deadline) return 0;
        return p.target - p.raised;
    }

    function _chip(uint256 potId, uint256 amount, address beneficiary) private returns (uint256 taken) {
        if (beneficiary == address(0) || beneficiary == address(this)) revert BadBeneficiary();
        Pot storage p = _pots[potId];
        if (p.stage == Stage.Series) {
            if (amount == 0) return 0;
            potId = _round(potId, p);
            p = _pots[potId];
        }
        uint256 need = _remaining(p);
        taken = amount < need ? amount : need;
        if (taken == 0) return 0;

        // `taken` is at most what the pot still needs, which fits 96 bits like the target itself.
        uint96 chip = SafeCast.toUint96(taken);
        uint96 raised = p.raised + chip;
        p.raised = raised;
        _chips[potId][beneficiary].amount += chip;
        owed += taken;
        emit ChippedIn(potId, beneficiary, msg.sender, taken, raised);
        if (raised == p.target) emit PotFilled(potId, raised);

        IMD.safeTransferFrom(msg.sender, address(this), taken);
    }

    /// @dev What `_reconcile` would make of the pot, without changing anything. `pool` is what the
    /// contributors share (or still share) and `spent` what the desk paid for delivered work.
    /// @param lookAhead For views only: also count an order that expired untaken as refunded, with
    /// the escrow the desk still holds for it. Books are never written from that forecast.
    function _peek(Pot storage p, bool lookAhead) private view returns (Stage stage, uint256 pool, uint256 spent) {
        stage = p.stage;
        if (stage == Stage.Funding) {
            // An unfilled pot is over at its deadline, and no chip can fill it afterwards. A full
            // one can still be launched for a while, so that a pot filled at the last moment is
            // not refunded for want of one more block.
            uint256 raised = p.raised;
            uint256 last = raised == p.target ? uint256(p.deadline) + LAUNCH_GRACE : p.deadline;
            if (block.timestamp > last) return (Stage.Refundable, raised, 0);
        } else if (stage == Stage.Hiring) {
            uint256 orderId = p.orderId;
            (IWorkOrders.State state, address employer, uint96 escrow, uint96 spent_, uint96 returned) =
                WORK_ORDERS.accountOf(orderId);
            if (employer != address(this)) revert NotOurOrder(orderId);
            // `returned` is everything the desk pushed to this contract for the order, from its
            // creation to its end. It is read once, here, when the order can no longer move.
            if (state == IWorkOrders.State.Delivered) return (Stage.Delivered, returned, spent_);
            if (state == IWorkOrders.State.Cancelled || state == IWorkOrders.State.Refunded) {
                return (Stage.Refundable, returned, spent_);
            }
            if (lookAhead && state == IWorkOrders.State.Open && block.timestamp >= p.orderExpiresAt) {
                return (Stage.Refundable, uint256(returned) + escrow, spent_);
            }
        } else {
            pool = p.pool;
        }
    }

    /// @dev Makes the call on the desk that the pot's order may be waiting for. Each is a call
    /// anyone may make; the desk refuses it while the time has not run out, and its money, if it
    /// goes through, is pushed to this contract and booked later from `accountOf`, like all else.
    /// A refusal, for whatever reason, leaves the order as it was.
    function _endWhatRanOut(Pot storage p) private {
        uint256 orderId = p.orderId;
        IWorkOrders.State state = WORK_ORDERS.stateOf(orderId);
        if (state == IWorkOrders.State.Open) {
            if (block.timestamp >= p.orderExpiresAt) {
                try WORK_ORDERS.refund(orderId) {} catch {}
            }
        } else if (state == IWorkOrders.State.Claimed) {
            try IDeskUpkeep(address(WORK_ORDERS)).evict(orderId) {} catch {}
        } else if (state == IWorkOrders.State.Registered || state == IWorkOrders.State.Disputed) {
            try IDeskUpkeep(address(WORK_ORDERS)).timeout(orderId) {} catch {}
        }
    }

    // The pot's books are written from what the desk reports after the desk has been asked to end
    // the order, never before: the order of the two is the point. Every caller holds the lock.
    // slither-disable-start reentrancy-no-eth
    function _reconcile(uint256 potId, Pot storage p) private returns (Stage stage) {
        stage = p.stage;
        // Saves the contributors a separate transaction on the desk, and the need to know it.
        if (stage == Stage.Hiring) _endWhatRanOut(p);

        (Stage live, uint256 pool, uint256 spent) = _peek(p, false);
        if (live == stage) return stage;

        p.stage = live;
        p.pool = SafeCast.toUint96(pool);
        p.chipsLeft = p.raised;
        if (stage == Stage.Hiring) {
            // The chips left for the desk at launch; what the desk sent back is booked now. If the
            // desk claims more than is here unbooked, stop: paying it would use other pots' money.
            uint256 newOwed = owed + pool;
            owed = newOwed;
            uint256 held = IMD.balanceOf(address(this));
            if (held < newOwed) revert DeskShortfall(newOwed, held);
        }
        emit PotSettled(potId, live, spent, pool);
        return live;
    }
    // slither-disable-end reentrancy-no-eth

    function _settled(uint256 potId) private returns (Pot storage p) {
        p = _pots[potId];
        Stage stage = _reconcile(potId, p);
        if (stage != Stage.Delivered && stage != Stage.Refundable) revert WrongStage(stage);
    }

    function _pay(uint256 potId, Pot storage p, address contributor) private returns (uint256 paid) {
        Chip storage c = _chips[potId][contributor];
        uint96 amount = c.amount;
        if (amount == 0 || c.claimed) return 0;

        uint96 pool = p.pool;
        uint96 chipsLeft = p.chipsLeft;
        // Rounds down against the claimer and leaves the remainder in the pool for those still to
        // claim; the last claimer's chip equals `chipsLeft`, so the last claim empties the pool.
        // The share cannot exceed the pool, because the chip cannot exceed `chipsLeft`.
        uint96 share = SafeCast.toUint96(uint256(pool) * amount / chipsLeft);

        c.claimed = true;
        c.refunded = share;
        p.pool = pool - share;
        p.chipsLeft = chipsLeft - amount;
        owed -= share;
        emit RefundPaid(potId, contributor, share);

        if (share != 0) IMD.safeTransfer(contributor, share);
        return share;
    }
}
