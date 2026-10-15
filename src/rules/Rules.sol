// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IQuestions} from "../interfaces/IQuestions.sol";
import {IWorkEmployer, IWorkOrders} from "../interfaces/IWorkOrders.sol";

/// @title A limit the hire desk publishes beside the frozen `IWorkOrders` surface
/// @dev Rules reads it when a HIRE rule is written, if the desk has it (see `Rules.createRule`).
interface IDeskLimits {
    /// @notice The longest delivery time the desk accepts for an order, in seconds.
    // forge-lint: disable-next-line(mixed-case-function)
    function MAX_DELIVERY() external view returns (uint32);
}

/// @title Rules ("Say When"): standing sentences that hire or pay when a line is crossed
/// @notice A rule is one sentence: WHEN a condition is true, THEN act, paid from the rule's own
/// escrow. The condition is either a view call on any contract (VIEW) or the newest answer of a
/// Standing Question (FEED). The action is either an order on the HELP WANTED hire desk (HIRE) or a
/// fixed IMD payment (PAY). Everything about a rule is fixed when it is created. Anyone may fire a
/// rule whose condition holds, and is paid the tip its creator set for doing so.
///
/// There is no owner, no setter and nothing to upgrade. The only privileged party in a rule is its
/// creator, who can cancel it and take back what it has not spent.
///
/// @dev What a reader should know before trusting a rule:
///
/// - A rule's creator chooses the condition. A condition that somebody can make true for the length
///   of one transaction (a spot balance, a spot price) will be made true by whoever wants the tip.
///   What that caller can gain is bounded by the rule itself: the tip, and an action whose order
///   terms or recipient were fixed by the creator.
/// - A condition target is untrusted. It is read with a gas-capped `staticcall`; if it reverts,
///   runs out of gas or answers with too few bytes, the rule simply does not fire. `fire` first
///   makes sure the target can be offered the whole allowance, so whoever fires a rule cannot
///   choose how much gas its condition is answered on.
/// - Rules holds many rules' IMD in one balance. `totalEscrowed` is the sum of every rule's escrow
///   and never exceeds that balance, whatever the desk reports; a rule can spend only its own escrow.
/// - Money a rule sent to the desk comes back through `reconcile`, which reads the amount from the
///   desk's own books (`IWorkOrders.accountOf(orderId).returned`), never from a change in balance.
///   The desk guarantees that this figure counts every IMD transfer it makes to the employer for
///   that order, each exactly once, and Rules relies on it. The balance check in `reconcile` only
///   keeps the escrows already booked within what the contract holds. It cannot tell one order's
///   return from another's: if the desk's books ever showed more for an order than the desk sent,
///   that order's rule could be credited out of IMD the desk returned for another rule's order and
///   that nobody has reconciled yet.
/// - IMD that reaches this contract any other way (a transfer by mistake) belongs to no rule. No
///   function pays it out, so with a desk that keeps its books as it promises it stays here.
/// - A HIRE rule's creator decides, once, the terms of every order the rule opens, including
///   whether the desk may pay a runner's unchallenged delivery claim without a receipt (see
///   `Hire.flags`). This contract never challenges a claim and never arbitrates one.
contract Rules is IWorkEmployer, ReentrancyGuardTransient {
    // Every function that changes state holds the same transient lock, so no call into this
    // contract can run between an external call and the event that follows it. `RuleCreated` comes
    // after static reads of the desk's limits; `Fired` and `Reconciled` report an order id or an
    // amount that only the desk can state. The lint cannot see the lock.
    // forge-lint: disable-start(reentrancy-events)

    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------------------------
    // Vocabulary
    // ------------------------------------------------------------------------------------------

    /// @notice Condition kind: call `target` with stored calldata and compare the first word returned.
    uint8 public constant COND_VIEW = 1;
    /// @notice Condition kind: compare the newest answer of a Standing Question feed.
    uint8 public constant COND_FEED = 2;

    /// @notice Action: open an order on the hire desk with this contract as the employer.
    uint8 public constant ACT_HIRE = 1;
    /// @notice Action: send a fixed amount of IMD to a fixed recipient.
    uint8 public constant ACT_PAY = 2;

    /// @notice Comparison: the value read is greater than or equal to the threshold. The six
    /// comparisons are numbered as the hire desk numbers them, and all are unsigned.
    uint8 public constant CMP_GE = 1;
    /// @notice Comparison: the value read is less than or equal to the threshold.
    uint8 public constant CMP_LE = 2;
    /// @notice Comparison: the value read is greater than the threshold.
    uint8 public constant CMP_GT = 3;
    /// @notice Comparison: the value read is less than the threshold.
    uint8 public constant CMP_LT = 4;
    /// @notice Comparison: the value read equals the threshold.
    uint8 public constant CMP_EQ = 5;
    /// @notice Comparison: the value read differs from the threshold.
    uint8 public constant CMP_NE = 6;

    /// @notice The most gas a condition read may use.
    uint256 public constant COND_GAS = 100_000;
    /// @notice The longest calldata a VIEW condition may store: a selector and four words.
    uint256 public constant MAX_COND_DATA = 132;
    /// @notice The longest job spec the hire desk accepts.
    uint256 public constant MAX_SPEC = 7_900;

    /// @dev What `fire` must have in hand when it reads the condition. A call can pass on at most
    /// 63/64 of the gas at hand, so this is `COND_GAS` scaled up by 64/63, plus room for what is
    /// charged between the check and the call: reaching a target for the first time in a
    /// transaction (2,600 gas today) and a few operations. The room is several times that, in case
    /// those prices are ever raised.
    uint256 private constant COND_GAS_FLOOR = COND_GAS * 64 / 63 + 20_000;

    /// @dev One byte value repeated 32 times, for testing a whole word of a spec at once.
    uint256 private constant SWAR_ONES = 0x0101010101010101010101010101010101010101010101010101010101010101;
    uint256 private constant SWAR_TOPS = 0x8080808080808080808080808080808080808080808080808080808080808080;
    uint256 private constant SWAR_60S = 0x6060606060606060606060606060606060606060606060606060606060606060;
    uint256 private constant SWAR_7FS = 0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f;
    /// @dev `"` (0x22) and `\` (0x5c), the two printable characters a spec may not contain.
    uint256 private constant SWAR_QUOTES = 0x2222222222222222222222222222222222222222222222222222222222222222;
    uint256 private constant SWAR_BACKSLASHES = 0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c;
    /// @dev The letter `a` (0x61), used to fill the part of the last word that lies beyond the spec.
    uint256 private constant SWAR_LETTERS = 0x6161616161616161616161616161616161616161616161616161616161616161;

    /// @notice Where a rule stands. `Exhausted` means it has fired as often as its creator allowed.
    enum Status {
        None,
        Armed,
        Exhausted,
        Cancelled
    }

    /// @notice The WHEN half of a rule.
    struct Condition {
        /// @dev `COND_VIEW` or `COND_FEED`.
        uint8 kind;
        /// @dev `CMP_GE` to `CMP_NE`: the condition holds when `value <cmp> threshold`.
        uint8 cmp;
        /// @dev FEED only: the answer must be no older than this many seconds. Zero for VIEW.
        uint32 maxAge;
        /// @dev VIEW: the contract to read. FEED: the Standing Questions deployment that owns the
        /// feed. A rule names its own feed source, so a later Questions deployment needs no new Rules.
        address target;
        uint256 threshold;
        /// @dev FEED only. Zero for VIEW.
        bytes32 feedId;
        /// @dev VIEW only: the exact calldata to send, at most `MAX_COND_DATA` bytes. Usually a
        /// selector and up to four words; it may be empty, for a target that answers plain calls.
        /// Must be empty for FEED.
        bytes data;
    }

    /// @notice The terms of the order a HIRE rule opens each time it fires.
    /// @dev The same fields as `IWorkOrders.OrderParams`, with two differences. The order's expiry is
    /// given as a lifetime, because a rule may fire long after it was written. And the order carries
    /// no condition of its own: the rule was the condition.
    struct Hire {
        bytes32 kindHash;
        uint96 minPay;
        /// @dev What each fire takes from the rule's escrow for the order.
        uint96 maxPay;
        uint32 rampSecs;
        uint32 deliverySecs;
        uint96 bond;
        address runnerOnly;
        address arbiter;
        /// @dev The desk's flag bits for the order. Only `FLAG_ALLOW_CLAIMED` and `FLAG_CALLBACK` may
        /// be set; the desk's third bit belongs to conditional orders, which a rule never opens.
        ///
        /// With `FLAG_CALLBACK` a delivered order's change returns to the rule inside the
        /// settlement, through `onWorkDelivered`. With `FLAG_ALLOW_CLAIMED` the creator accepts the
        /// desk's claimed path for every order of the rule: a runner's bonded delivery claim that
        /// nobody challenges within the desk's challenge window is paid without a receipt, and a
        /// challenged claim that nothing decides before the order's deadline is refunded. A creator
        /// who wants a say in a disputed claim names an `arbiter`.
        uint8 flags;
        /// @dev The order expires this many seconds after the fire that opened it.
        uint32 orderTtl;
    }

    /// @notice The terms of a PAY rule: each fire sends `amount` IMD to `recipient`.
    struct Pay {
        address recipient;
        uint96 amount;
    }

    /// @notice Everything a creator decides. Nothing here can be changed later.
    struct RuleParams {
        Condition when;
        /// @dev `ACT_HIRE` or `ACT_PAY`. Only the matching one of `hire` and `pay` is read and stored.
        uint8 action;
        Hire hire;
        Pay pay;
        /// @dev IMD paid from the escrow to whoever fires the rule, each time.
        uint96 tip;
        /// @dev The least time between two fires, in seconds. Zero allows fires back to back.
        uint32 cooldown;
        /// @dev How many times the rule may fire in all. At least 1.
        uint32 maxFires;
    }

    /// @notice A rule as stored.
    struct Rule {
        address creator;
        uint96 tip;
        uint8 action;
        bool cancelled;
        uint32 cooldown;
        uint32 maxFires;
        /// @dev IMD this rule can still spend. Held by this contract.
        uint96 escrow;
        uint32 fires;
        uint40 lastFiredAt;
        /// @dev FEED only: the feed round the rule last fired on. A rule fires once per round at most.
        uint64 lastRound;
        /// @dev HIRE only: keccak256 of the job spec every order of this rule must carry.
        bytes32 specHash;
        Condition when;
        Hire hire;
        Pay pay;
    }

    /// @dev Ties a desk order to the rule that paid for it.
    struct OrderLink {
        uint64 ruleId;
        /// @dev What the desk pulled for the order.
        uint96 sent;
        /// @dev How much of the desk's `returned` figure has been handed back to the rule so far.
        uint96 credited;
    }

    // ------------------------------------------------------------------------------------------
    // Events and errors
    // ------------------------------------------------------------------------------------------

    /// @notice A rule was created. `spec` is the job text a HIRE rule's orders carry; whoever fires
    /// the rule must supply the same bytes, so they are published here once.
    event RuleCreated(uint256 indexed id, address indexed creator, RuleParams params, bytes spec, uint256 deposit);
    /// @notice A rule fired. `value` is the word the condition read, `round` the feed round it read it
    /// from (zero for VIEW), `orderId` the order a HIRE rule opened (zero for PAY), `spent` what the
    /// action took from the escrow and `tip` what the caller was paid.
    event Fired(
        uint256 indexed id,
        address indexed caller,
        uint32 fireNumber,
        uint256 value,
        uint64 round,
        uint256 orderId,
        uint256 spent,
        uint256 tip
    );
    /// @notice `from` added `amount` IMD to the rule's escrow.
    event ToppedUp(uint256 indexed id, address indexed from, uint256 amount);
    /// @notice The creator ended the rule and was sent `refund` IMD, all its escrow held.
    event RuleCancelled(uint256 indexed id, uint256 refund);
    /// @notice `amount` IMD the desk returned for `orderId` was handed back: to the rule's escrow, or,
    /// when `toCreator` is true because the rule is cancelled, straight to its creator.
    event Reconciled(uint256 indexed id, uint256 indexed orderId, uint256 amount, bool toCreator);
    /// @notice The creator withdrew an order nobody had taken.
    event Recalled(uint256 indexed id, uint256 indexed orderId);
    /// @notice The desk reported that one of a rule's orders was delivered.
    event WorkDelivered(uint256 indexed id, uint256 indexed orderId, bytes16 jobId, bytes32 recordHash);

    /// @notice An address that must be set is the zero address.
    error ZeroAddress();
    /// @notice A top-up of nothing.
    error ZeroAmount();
    /// @notice The condition kind is neither `COND_VIEW` nor `COND_FEED`.
    error BadCondition();
    /// @notice The comparison is not one of `CMP_GE` to `CMP_NE`.
    error BadComparison();
    /// @notice A VIEW condition's calldata is longer than `MAX_COND_DATA`.
    error BadConditionData();
    /// @notice The action is neither `ACT_HIRE` nor `ACT_PAY`.
    error BadAction();
    /// @notice A PAY amount of zero, or a HIRE price range that is empty or upside down.
    error BadPay();
    /// @notice A PAY rule's recipient is the zero address or this contract.
    error BadRecipient();
    /// @notice A FEED condition needs a maximum age.
    error ZeroMaxAge();
    /// @notice A rule must be allowed to fire at least once.
    error ZeroFires();
    /// @notice A HIRE rule's orders need a lifetime.
    error ZeroTtl();
    /// @notice A field that does not apply to the chosen condition or action was filled in.
    error FieldNotUsed();
    /// @notice The spec breaks the desk's character rules. `at` is what the desk itself reports: 0
    /// for an empty spec, `MAX_SPEC` for one that is too long, otherwise the lowest index of a byte
    /// that is not allowed where it stands.
    error SpecInvalid(uint256 at);
    /// @notice The order's bond or delivery time is below what the desk accepts.
    error BelowDeskMinimum();
    /// @notice The order's delivery time is above what the desk accepts.
    error AboveDeskMaximum();
    /// @notice `Hire.flags` sets a bit other than `FLAG_ALLOW_CLAIMED` and `FLAG_CALLBACK`.
    error BadFlags();
    /// @notice One fire would cost more than an escrow can ever hold, so the rule could never fire.
    error CostTooHigh();
    /// @notice No rule has this id.
    error UnknownRule(uint256 id);
    /// @notice The rule was cancelled by its creator.
    error RuleIsCancelled(uint256 id);
    /// @notice The rule has fired as often as its creator allowed.
    error RuleExhausted(uint256 id);
    /// @notice The rule fired too recently; it can fire again at `readyAt`.
    error CoolingDown(uint256 readyAt);
    /// @notice The condition is false, or could not be read. Either way the rule does not fire.
    error ConditionNotMet();
    /// @notice Too little gas was supplied to offer the condition target its whole allowance.
    error GasShort();
    /// @notice The rule's escrow does not cover one fire: the action's amount plus the tip.
    error EscrowShort(uint256 needed, uint256 held);
    /// @notice The spec supplied to `fire` is not the text the rule pinned.
    error WrongSpec();
    /// @notice Only the rule's creator may do this.
    error NotCreator();
    /// @notice Only the hire desk may call the delivery callback.
    error NotDesk();
    /// @notice The order was not opened by this rule, or the desk does not list this contract as
    /// its employer.
    error NotThisRulesOrder(uint256 id, uint256 orderId);
    /// @notice The desk took something other than the order's `maxPay`.
    error DeskPulledWrongAmount();
    /// @notice The desk returned an order id this contract already knows.
    error OrderAlreadyLinked(uint256 orderId);
    /// @notice The desk's books say more came back than this contract holds unassigned.
    error ReturnNotReceived(uint256 orderId);

    // ------------------------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------------------------

    /// @notice The IMD token: what every rule is funded with, pays in and tips in.
    IERC20 public immutable IMD;
    /// @notice The hire desk every HIRE rule opens its orders on.
    IWorkOrders public immutable WORK_ORDERS;

    /// @notice How many rules exist. Ids count from 1.
    uint256 public ruleCount;
    /// @notice The sum of every rule's escrow. Never more than this contract's IMD balance.
    uint256 public totalEscrowed;

    mapping(uint256 id => Rule) private _rules;
    mapping(uint256 orderId => OrderLink) private _orders;

    /// @param imd The IMD token.
    /// @param workOrders The hire desk.
    /// @dev Makes no external call: the desk is first touched when a HIRE rule is created.
    constructor(address imd, address workOrders) {
        if (imd == address(0) || workOrders == address(0)) revert ZeroAddress();
        IMD = IERC20(imd);
        WORK_ORDERS = IWorkOrders(workOrders);
    }

    // ------------------------------------------------------------------------------------------
    // Creating, funding and ending a rule
    // ------------------------------------------------------------------------------------------

    /// @notice Creates a rule and escrows `deposit` IMD for it. The caller becomes its creator.
    /// @dev The caller must have approved this contract for `deposit`. The deposit may be less than
    /// one fire costs, or zero: the rule then waits for `topUp`.
    ///
    /// A HIRE rule is checked here against everything the desk checks when an order is opened and
    /// that can be known today: the spec against the desk's character rules (printable ASCII without
    /// `"` or `\`, no leading or trailing space, 1 to 7,900 bytes), the bond and the delivery time
    /// against the desk's limits, and the flags against the two bits an order without a condition
    /// may carry. A rule that is accepted can therefore open its order when the day comes. The desk
    /// still has the last word when the rule fires.
    ///
    /// Reverts when a field is out of range or filled in where it does not apply, when one fire
    /// would cost more than an escrow can hold, when the caller has not approved `deposit`, and,
    /// for a HIRE rule, when the desk cannot be read.
    /// @param p The rule. Fields that do not apply to the chosen condition must be left empty.
    /// @param spec HIRE: the job text of every order the rule opens. PAY: must be empty.
    /// @param deposit IMD to pull from the caller into the rule's escrow.
    /// @return id The new rule's id.
    function createRule(RuleParams calldata p, bytes calldata spec, uint96 deposit)
        external
        nonReentrant
        returns (uint256 id)
    {
        Condition calldata c = p.when;
        if (c.target == address(0)) revert ZeroAddress();
        if (c.cmp < CMP_GE || c.cmp > CMP_NE) revert BadComparison();
        if (p.maxFires == 0) revert ZeroFires();
        if (c.kind == COND_VIEW) {
            if (c.data.length > MAX_COND_DATA) revert BadConditionData();
            if (c.feedId != bytes32(0) || c.maxAge != 0) revert FieldNotUsed();
        } else if (c.kind == COND_FEED) {
            if (c.maxAge == 0) revert ZeroMaxAge();
            if (c.data.length != 0) revert FieldNotUsed();
        } else {
            revert BadCondition();
        }

        uint256 spend = 0;
        if (p.action == ACT_HIRE) {
            Hire calldata h = p.hire;
            if (h.maxPay == 0 || h.minPay > h.maxPay) revert BadPay();
            if (h.orderTtl == 0) revert ZeroTtl();
            _requireDeskSpec(spec);
            _requireDeskTerms(h);
            spend = h.maxPay;
        } else if (p.action == ACT_PAY) {
            if (p.pay.recipient == address(0) || p.pay.recipient == address(this)) revert BadRecipient();
            if (p.pay.amount == 0) revert BadPay();
            if (spec.length != 0) revert FieldNotUsed();
            spend = p.pay.amount;
        } else {
            revert BadAction();
        }
        // An escrow is a uint96. A fire that costs more than that could never be paid for.
        if (spend + p.tip > type(uint96).max) revert CostTooHigh();

        id = ++ruleCount;
        Rule storage r = _rules[id];
        r.creator = msg.sender;
        r.tip = p.tip;
        r.action = p.action;
        r.cooldown = p.cooldown;
        r.maxFires = p.maxFires;
        r.escrow = deposit;
        r.when = c;
        if (p.action == ACT_HIRE) {
            r.hire = p.hire;
            r.specHash = keccak256(spec);
        } else {
            r.pay = p.pay;
        }
        totalEscrowed += deposit;

        emit RuleCreated(id, msg.sender, p, spec, deposit);
        if (deposit != 0) IMD.safeTransferFrom(msg.sender, address(this), deposit);
    }

    /// @notice Adds `amount` IMD to a rule's escrow. Anyone may call.
    /// @dev The caller must have approved this contract. Money added by somebody other than the
    /// creator is a gift to the rule: what the rule does not spend goes to its creator on `cancel`.
    /// Reverts for a rule that does not exist or is cancelled.
    function topUp(uint256 id, uint96 amount) external nonReentrant {
        Rule storage r = _rules[id];
        if (r.creator == address(0)) revert UnknownRule(id);
        if (r.cancelled) revert RuleIsCancelled(id);
        if (amount == 0) revert ZeroAmount();
        r.escrow += amount;
        totalEscrowed += amount;
        emit ToppedUp(id, msg.sender, amount);
        IMD.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Ends a rule for good and sends its unspent escrow to its creator. Creator only.
    /// @dev Orders the rule already opened stay on the desk. Whatever they return later is sent to
    /// the creator by `reconcile`, and the creator can withdraw an untaken one with `recall`.
    /// @return refund The IMD sent to the creator.
    function cancel(uint256 id) external nonReentrant returns (uint256 refund) {
        Rule storage r = _rules[id];
        if (msg.sender != r.creator) revert NotCreator();
        if (r.cancelled) revert RuleIsCancelled(id);
        refund = r.escrow;
        r.cancelled = true;
        r.escrow = 0;
        totalEscrowed -= refund;
        emit RuleCancelled(id, refund);
        if (refund != 0) IMD.safeTransfer(msg.sender, refund);
    }

    // ------------------------------------------------------------------------------------------
    // Firing
    // ------------------------------------------------------------------------------------------

    /// @notice Fires a rule whose condition holds: opens its order or makes its payment, and pays the
    /// caller the rule's tip. Anyone may call.
    /// @dev Reverts, changing nothing, when the rule is cancelled or has used up its fires, when its
    /// cooldown has not passed, when the condition is false or cannot be read, when the escrow does
    /// not cover the action plus the tip, or, for a HIRE rule, when `spec` is not the pinned text or
    /// the desk refuses the order. `canFire` answers every one of those that does not depend on
    /// `spec` or on the desk, without sending anything.
    ///
    /// Also reverts `GasShort` unless the condition target can be offered the whole of `COND_GAS`.
    /// Some targets answer differently on less (one that reads another contract and falls back to
    /// zero when that read runs dry, for example), and the answer decides whether money moves. So
    /// the call needs about 122,000 gas in hand at that point, whatever the read then uses.
    /// @param id The rule.
    /// @param spec HIRE: the rule's job text, exactly as published in `RuleCreated`. PAY: ignored.
    /// @return orderId The order opened on the desk, or zero for a PAY rule.
    function fire(uint256 id, bytes calldata spec) external nonReentrant returns (uint256 orderId) {
        Rule storage r = _rules[id];
        if (r.creator == address(0)) revert UnknownRule(id);
        if (r.cancelled) revert RuleIsCancelled(id);
        uint32 fires = r.fires;
        if (fires >= r.maxFires) revert RuleExhausted(id);
        if (fires != 0) {
            uint256 readyAt = uint256(r.lastFiredAt) + r.cooldown;
            // A cooldown counted in seconds; the few seconds a block producer can shift do not matter.
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp < readyAt) revert CoolingDown(readyAt);
        }
        (bool met, uint256 value, uint64 round) = _check(r, true);
        if (!met) revert ConditionNotMet();

        uint8 action = r.action;
        uint96 spend = action == ACT_HIRE ? r.hire.maxPay : r.pay.amount;
        uint96 tip = r.tip;
        uint256 cost = uint256(spend) + tip;
        uint256 held = r.escrow;
        if (held < cost) revert EscrowShort(cost, held);

        // casting to 'uint96' is safe because the difference is no more than `held`, read from a uint96
        // forge-lint: disable-next-line(unsafe-typecast)
        r.escrow = uint96(held - cost);
        r.fires = fires + 1;
        // casting to 'uint40' is safe because block timestamps stay below 2^40 for tens of thousands of years
        // forge-lint: disable-next-line(unsafe-typecast)
        r.lastFiredAt = uint40(block.timestamp);
        if (round != 0) r.lastRound = round;
        totalEscrowed -= cost;

        if (action == ACT_HIRE) {
            orderId = _hire(id, r, spec, spend);
        } else {
            IMD.safeTransfer(r.pay.recipient, spend);
        }
        if (tip != 0) IMD.safeTransfer(msg.sender, tip);
        emit Fired(id, msg.sender, fires + 1, value, round, orderId, spend, tip);
    }

    // ------------------------------------------------------------------------------------------
    // Money coming back from the desk
    // ------------------------------------------------------------------------------------------

    /// @notice Hands back to a rule whatever the desk has returned for one of its orders since the
    /// last call: a refund, a cancelled order's escrow, the change from a delivered one, a bond the
    /// desk awarded the employer. Anyone may call, any number of times.
    /// @dev The amount is the desk's own `returned` figure for the order, less what was already
    /// handed back. If the rule is cancelled the money goes to its creator; otherwise it rejoins the
    /// rule's escrow. Reverts when `orderId` is not an order of rule `id`.
    /// @return amount The IMD handed back by this call. Zero when there was nothing new.
    function reconcile(uint256 id, uint256 orderId) external nonReentrant returns (uint256 amount) {
        return _reconcile(id, orderId);
    }

    /// @notice Withdraws from the desk an order of this rule that no runner has taken, and hands its
    /// escrow back as `reconcile` does. Creator only.
    /// @dev The desk decides whether the order can still be withdrawn; if not, this reverts with the
    /// desk's error. An order that has expired needs no creator: anyone may call the desk's `refund`
    /// and then `reconcile`.
    ///
    /// The books are written after the call to the desk because the amount is the desk's to state:
    /// it is read from `accountOf` once the desk has cancelled the order. The lock keeps every other
    /// function that changes state out in between. A view read during the desk's call shows the
    /// return as not yet handed back, which is what it is.
    /// @return amount The IMD handed back.
    // slither-disable-next-line reentrancy-no-eth
    function recall(uint256 id, uint256 orderId) external nonReentrant returns (uint256 amount) {
        if (msg.sender != _rules[id].creator) revert NotCreator();
        if (_orders[orderId].ruleId != id) revert NotThisRulesOrder(id, orderId);
        emit Recalled(id, orderId);
        WORK_ORDERS.cancel(orderId);
        return _reconcile(id, orderId);
    }

    /// @notice The desk's delivery callback: records the delivery and hands the order's change back
    /// to its rule. Only the desk may call.
    /// @dev Reached only by orders whose rule set the desk's `FLAG_CALLBACK`. The desk calls it inside
    /// a `try` after every payout, so nothing here can undo a settlement. An order this contract does
    /// not know is ignored.
    function onWorkDelivered(uint256 orderId, bytes16 jobId, bytes32 recordHash) external nonReentrant {
        if (msg.sender != address(WORK_ORDERS)) revert NotDesk();
        uint256 id = _orders[orderId].ruleId;
        if (id == 0) return;
        emit WorkDelivered(id, orderId, jobId, recordHash);
        _reconcile(id, orderId);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @notice A rule exactly as stored. All zeros for an id that does not exist.
    function getRule(uint256 id) external view returns (Rule memory) {
        return _rules[id];
    }

    /// @notice Where a rule stands.
    function statusOf(uint256 id) external view returns (Status) {
        Rule storage r = _rules[id];
        if (r.creator == address(0)) return Status.None;
        if (r.cancelled) return Status.Cancelled;
        return r.fires >= r.maxFires ? Status.Exhausted : Status.Armed;
    }

    /// @notice Reads a rule's condition now.
    /// @dev A reading taken here is only as good as the gas the call was given: the target is
    /// offered at most `COND_GAS`, and less when the caller has less to pass on. `fire` insists on
    /// the whole allowance; a view cannot.
    /// @return met True when the condition holds: the read succeeded and compares true and, for a
    /// FEED rule, the answer is fresh enough and from a later round than the rule last fired on.
    /// @return value The word the condition read. Zero when the read failed.
    /// @return round FEED only: the round of the answer, when the answer is fresh enough and newer
    /// than the last one fired on. Otherwise zero.
    function check(uint256 id) external view returns (bool met, uint256 value, uint64 round) {
        return _check(_rules[id], false);
    }

    /// @notice What one fire takes from the rule's escrow: the action's amount plus the tip.
    function costOf(uint256 id) external view returns (uint256) {
        return _costOf(_rules[id]);
    }

    /// @notice True when `fire` would pass every check this contract makes itself, given enough
    /// gas. For a HIRE rule the desk can still refuse the order.
    /// @dev The condition is read as `check` reads it, with the same caveat about gas.
    function canFire(uint256 id) external view returns (bool) {
        Rule storage r = _rules[id];
        if (r.creator == address(0) || r.cancelled || r.fires >= r.maxFires) return false;
        // forge-lint: disable-next-line(block-timestamp)
        if (r.fires != 0 && block.timestamp < uint256(r.lastFiredAt) + r.cooldown) return false;
        if (r.escrow < _costOf(r)) return false;
        (bool met,,) = _check(r, false);
        return met;
    }

    /// @notice Which rule opened a desk order, what the desk pulled for it, and how much of what the
    /// desk returned has been handed back. Zeros for an order this contract did not open.
    function orderOf(uint256 orderId) external view returns (uint256 ruleId, uint96 sent, uint96 credited) {
        OrderLink storage l = _orders[orderId];
        return (l.ruleId, l.sent, l.credited);
    }

    // ------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------

    function _costOf(Rule storage r) private view returns (uint256) {
        return uint256(r.action == ACT_HIRE ? r.hire.maxPay : r.pay.amount) + r.tip;
    }

    /// @dev Opens the rule's order. The rule's escrow was already reduced by `maxPay`.
    function _hire(uint256 id, Rule storage r, bytes calldata spec, uint96 maxPay) private returns (uint256 orderId) {
        if (keccak256(spec) != r.specHash) revert WrongSpec();
        Hire storage h = r.hire;
        // The order's own condition fields are zero: the rule was the condition.
        IWorkOrders.OrderParams memory o = IWorkOrders.OrderParams({
            kindHash: h.kindHash,
            minPay: h.minPay,
            maxPay: maxPay,
            rampSecs: h.rampSecs,
            deliverySecs: h.deliverySecs,
            // casting to 'uint40' is safe because a block timestamp plus a 32-bit lifetime stays far below 2^40
            // forge-lint: disable-next-line(unsafe-typecast)
            expiresAt: uint40(block.timestamp + h.orderTtl),
            bond: h.bond,
            flags: h.flags,
            runnerOnly: h.runnerOnly,
            arbiter: h.arbiter,
            condTarget: address(0),
            condSelector: bytes4(0),
            condArg: bytes32(0),
            condCmp: 0,
            condThreshold: 0
        });

        uint256 balanceBefore = IMD.balanceOf(address(this));
        IMD.forceApprove(address(WORK_ORDERS), maxPay);
        orderId = WORK_ORDERS.createOrder(o, spec);
        // The rule was charged exactly `maxPay`, so the desk must have taken exactly that. Anything
        // else would leave this rule's books and the shared balance apart.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (IMD.balanceOf(address(this)) + maxPay != balanceBefore) revert DeskPulledWrongAmount();

        OrderLink storage l = _orders[orderId];
        if (l.ruleId != 0) revert OrderAlreadyLinked(orderId);
        // casting to 'uint64' is safe because rule ids are a counter that goes up by one per rule
        // forge-lint: disable-next-line(unsafe-typecast)
        l.ruleId = uint64(id);
        l.sent = maxPay;
    }

    function _reconcile(uint256 id, uint256 orderId) private returns (uint256 amount) {
        OrderLink storage l = _orders[orderId];
        if (id == 0 || l.ruleId != id) revert NotThisRulesOrder(id, orderId);

        // Of the five figures the desk reports, only the employer and `returned` are needed here.
        // slither-disable-start unused-return
        // forge-lint: disable-next-line(unused-return)
        (, address employer,,, uint96 returned) = WORK_ORDERS.accountOf(orderId);
        // slither-disable-end unused-return
        // The desk must agree that the order is this contract's before its figure is believed.
        if (employer != address(this)) revert NotThisRulesOrder(id, orderId);
        uint96 seen = l.credited;
        if (returned <= seen) return 0;
        uint96 fresh = returned - seen;
        amount = fresh;

        // The amount comes from the desk's books. The balance is only a ceiling: no rule is ever
        // credited with IMD that is not here and unassigned, so the rules' escrows can never add up
        // to more than this contract holds, whatever the desk reports. The ceiling cannot say which
        // order unassigned IMD came back for; that rests on the desk's `returned` being what it sent.
        if (IMD.balanceOf(address(this)) < totalEscrowed + amount) revert ReturnNotReceived(orderId);
        l.credited = returned;

        Rule storage r = _rules[id];
        if (r.cancelled) {
            emit Reconciled(id, orderId, amount, true);
            IMD.safeTransfer(r.creator, amount);
        } else {
            // `Reconciled`, two lines down, is the event for this change.
            // forge-lint: disable-next-line(missing-events-access-control)
            r.escrow += fresh;
            totalEscrowed += amount;
            emit Reconciled(id, orderId, amount, false);
        }
    }

    /// @dev The desk's limits for an order's terms, checked when the rule is written for the same
    /// reason as the spec: a rule that is accepted must be able to open its order.
    function _requireDeskTerms(Hire calldata h) private view {
        IWorkOrders desk = WORK_ORDERS;
        if (h.bond < desk.MIN_BOND() || h.deliverySecs < desk.MIN_DELIVERY()) revert BelowDeskMinimum();
        // The desk also caps the delivery time. That limit is not part of the frozen interface, so
        // it is honoured when the desk publishes it and passed over when it does not.
        (bool published, uint256 maxDelivery) =
            _readWord(address(desk), abi.encodeCall(IDeskLimits.MAX_DELIVERY, ()), false);
        if (published && h.deliverySecs > maxDelivery) revert AboveDeskMaximum();
        // A rule's orders carry no condition, so of the desk's flag bits only these two can be set.
        if (h.flags & ~(desk.FLAG_ALLOW_CLAIMED() | desk.FLAG_CALLBACK()) != 0) revert BadFlags();
    }

    /// @dev Reads a rule's condition. Never reverts because of what the target does. With `whole`
    /// set it reverts `GasShort` unless the target can be offered all of `COND_GAS`.
    function _check(Rule storage r, bool whole) private view returns (bool met, uint256 value, uint64 round) {
        Condition storage c = r.when;
        uint8 kind = c.kind;
        if (kind == COND_VIEW) {
            bool ok;
            (ok, value) = _readWord(c.target, c.data, whole);
            if (ok) met = _compare(value, c.cmp, c.threshold);
        } else if (kind == COND_FEED) {
            uint256 rawRound;
            uint256 updatedAt;
            (value, rawRound, updatedAt) = _readFeed(c.target, c.feedId, whole);
            // One fire per answer: the round must be newer than the one the rule last fired on.
            bool isNew = rawRound > r.lastRound;
            // An answer stamped in the future is not an answer; an old one is no longer news. Ages
            // are in seconds, set by the creator, and far coarser than a block producer's leeway.
            // forge-lint: disable-next-line(block-timestamp)
            bool isFresh = updatedAt <= block.timestamp && block.timestamp - updatedAt <= c.maxAge;
            if (isNew && isFresh) {
                // casting to 'uint64' is safe because `_readFeed` zeroes a round that does not fit
                // forge-lint: disable-next-line(unsafe-typecast)
                round = uint64(rawRound);
                met = _compare(value, c.cmp, c.threshold);
            }
        }
    }

    /// @dev Calls `target` with `data` under the gas cap and returns the first word of the answer.
    /// `ok` is false, and `word` zero, when the call fails or answers with fewer than 32 bytes.
    /// With `whole` set, reverts `GasShort` when too little gas is at hand to offer the whole cap.
    function _readWord(address target, bytes memory data, bool whole) private view returns (bool ok, uint256 word) {
        if (whole && gasleft() < COND_GAS_FLOOR) revert GasShort();
        // The answer is written to the scratch word only, so a long return is never copied.
        assembly ("memory-safe") {
            ok := staticcall(COND_GAS, target, add(data, 0x20), mload(data), 0x00, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            word := mul(ok, mload(0x00))
        }
    }

    /// @dev Reads `IQuestions(source).latest(feedId)` under the gas cap. `latest` returns five words:
    /// value, fromBlock, toBlock, round, updatedAt. They are read into unallocated memory and decoded
    /// by hand, so a source that answers with out-of-range words gives an unusable answer instead of
    /// reverting the decoder. An unusable answer (failed call, short return, no round yet, a round
    /// that does not fit 64 bits) is reported as all zeros. With `whole` set, reverts `GasShort`
    /// when too little gas is at hand to offer the whole cap.
    function _readFeed(address source, bytes32 feedId, bool whole)
        private
        view
        returns (uint256 value, uint256 round, uint256 updatedAt)
    {
        bytes memory data = abi.encodeCall(IQuestions.latest, (feedId));
        if (whole && gasleft() < COND_GAS_FLOOR) revert GasShort();
        assembly ("memory-safe") {
            let out := mload(0x40)
            let ok := staticcall(COND_GAS, source, add(data, 0x20), mload(data), out, 0xa0)
            ok := and(ok, gt(returndatasize(), 0x9f))
            round := mload(add(out, 0x60))
            ok := and(ok, and(gt(round, 0), lt(round, 0x10000000000000000)))
            value := mul(ok, mload(out))
            round := mul(ok, round)
            updatedAt := mul(ok, mload(add(out, 0x80)))
        }
    }

    function _compare(uint256 value, uint8 cmp, uint256 threshold) private pure returns (bool) {
        if (cmp == CMP_GE) return value >= threshold;
        if (cmp == CMP_LE) return value <= threshold;
        if (cmp == CMP_GT) return value > threshold;
        if (cmp == CMP_LT) return value < threshold;
        if (cmp == CMP_EQ) return value == threshold;
        return value != threshold;
    }

    /// @dev The desk's rules for a spec, checked when the rule is written so that a rule which is
    /// accepted is not left unable to hire. Reverts with the position the desk itself would report:
    /// the lowest index of a byte that is not allowed where it stands. A space at the end is the
    /// highest index there is, so it is reported only when nothing else is at fault.
    function _requireDeskSpec(bytes calldata spec) private pure {
        uint256 n = spec.length;
        if (n == 0) revert SpecInvalid(0);
        if (n > MAX_SPEC) revert SpecInvalid(MAX_SPEC);
        if (spec[0] == 0x20) revert SpecInvalid(0);
        uint256 at = _firstRefusedByte(spec);
        if (at != n) revert SpecInvalid(at);
        if (spec[n - 1] == 0x20) revert SpecInvalid(n - 1);
    }

    /// @dev The position of the first byte outside the desk's alphabet (0x20 to 0x7e, without `"`
    /// and `\`), or `spec.length` when every byte is allowed.
    ///
    /// Reads 32 bytes at a time, because a spec can be 7,900 bytes long and a byte-by-byte loop costs
    /// a few hundred gas per byte. All 32 bytes of a word are tested at once with carry-free
    /// arithmetic on the whole word. For a byte `b` below 0x80:
    ///   `b + 0x60` has its top bit set exactly when `b >= 0x20`;
    ///   `b + 0x01` has its top bit set exactly when `b == 0x7f`;
    ///   `(b ^ c) + 0x7f` has its top bit set exactly when `b != c`.
    /// None of those sums leaves its own byte. If some byte is 0x80 or above the sums may spill into
    /// their neighbours, but then the word is already refused for that byte. Only a refused word is
    /// walked byte by byte, to find the position.
    function _firstRefusedByte(bytes calldata spec) private pure returns (uint256 at) {
        uint256 n = spec.length;
        at = n;
        assembly ("memory-safe") {
            for { let i := 0 } lt(i, n) { i := add(i, 0x20) } {
                let w := calldataload(add(spec.offset, i))
                let left := sub(n, i)
                if lt(left, 0x20) {
                    // The last word runs past the spec. Whatever lies beyond it is not part of the
                    // spec: replace those bytes with a letter, which is always allowed.
                    let beyond := shl(3, sub(0x20, left))
                    w := or(shl(beyond, shr(beyond, w)), shr(shl(3, left), SWAR_LETTERS))
                }
                let below80AndNot7f := iszero(and(or(w, add(w, SWAR_ONES)), SWAR_TOPS))
                let atLeast20 := add(w, SWAR_60S)
                let notQuote := add(xor(w, SWAR_QUOTES), SWAR_7FS)
                let notBackslash := add(xor(w, SWAR_BACKSLASHES), SWAR_7FS)
                let restAllowed := eq(and(and(atLeast20, and(notQuote, notBackslash)), SWAR_TOPS), SWAR_TOPS)
                if iszero(and(below80AndNot7f, restAllowed)) {
                    for { let j := 0 } lt(j, 0x20) { j := add(j, 1) } {
                        let b := byte(j, w)
                        if or(or(lt(b, 0x20), gt(b, 0x7e)), or(eq(b, 0x22), eq(b, 0x5c))) {
                            at := add(i, j)
                            break
                        }
                    }
                    break
                }
            }
        }
    }

    // forge-lint: disable-end(reentrancy-events)
}
