// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWorkEmployer, IWorkOrders} from "../../../src/interfaces/IWorkOrders.sol";

/// @notice The plain half of `OddDesk` below: a small desk that honours the meaning of
/// `IWorkOrders` (the states, the `accountOf` numbers, money pushed to the employer, the gas-capped
/// callback after delivery), so that `OddDesk` can then break one thing at a time.
///
/// @dev It is not how CrowdPots and the Doorbell are tested. Every test of what they do runs
/// against the real desk and the real WorkProof of this launch (`PotsBase`, `Doorbell.t.sol`). This
/// contract exists only as the base of `OddDesk`, for the handful of tests that need a desk which
/// misreports: the real desk is immutable code and cannot be made to.
///
/// It follows the real desk's rules for the state machine and the money. It does not check work
/// records (the caller of `settle` and `reportFailed` says what a receipt would have shown), and
/// it has no conditions and no arbiter.
contract MockWorkOrders is IWorkOrders {
    using SafeERC20 for IERC20;

    struct Order {
        address employer;
        uint40 expiresAt;
        /// The moment the price ramp is counted from: creation, moved forward by the time runners
        /// held the order without delivering.
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
        uint96 spent;
        uint96 returned;
    }

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

    uint8 public constant override FLAG_ALLOW_CLAIMED = 1;
    uint8 public constant override FLAG_CALLBACK = 2;
    uint8 public constant override FLAG_COND_ARG = 4;
    uint96 public constant override MIN_BOND = 0.25e18;
    uint32 public constant override MIN_DELIVERY = 3 days;
    uint32 public constant MAX_DELIVERY = 90 days;

    uint256 public constant FEE_BPS = 500;
    uint256 public constant TIP_BPS = 500;
    uint256 public constant RELEASE_BPS = 1000;
    uint256 public constant CLAIM_WINDOW = 1 hours;
    uint256 public constant CHALLENGE_WINDOW = 24 hours;
    uint256 public constant DISPUTE_WINDOW = 24 hours;
    uint256 public constant CALLBACK_GAS = 150_000;
    uint256 internal constant BPS = 10_000;

    address public immutable override IMD;
    address public immutable PAYROLL;

    uint256 public override orderCount;
    mapping(uint256 => Order) internal _orders;
    mapping(uint256 => Claim) internal _claims;
    /// @dev A runner that released an order may not take it again, as on the real desk.
    mapping(uint256 => mapping(address => bool)) public barred;
    /// @dev The order a job's receipt settled, as on the real desk: a job settles one order only.
    mapping(bytes16 => uint256) public orderOfJob;
    /// @dev True once the employer's callback has gone through for the order.
    mapping(uint256 => bool) public notified;

    /// @dev What the last `createOrder` was given, for tests that check an employer's parameters.
    OrderParams internal lastParams;
    bytes public lastSpec;
    address public lastCreator;
    /// @dev True while the order's last callback attempt failed.
    mapping(uint256 => bool) public callbackFailed;
    /// @dev Sum of all bond money the desk has pushed to employers, for conservation checks.
    uint256 public bondsToEmployers;

    event OrderOpened(uint256 indexed id, address indexed employer, bytes spec);
    event CallbackFailed(uint256 indexed id);

    error BadState();
    error NotEmployer();
    error NotRunner();
    error SpecInvalid(uint256 at);
    error PayRange();
    error DeliveryTooShort();
    error DeliveryTooLong();
    error BondTooLow();
    error BadFlags();
    error BadCondition();
    error Expired();
    error TooEarly();
    error TooLate();
    error ClaimedPathOff();
    error Barred();
    error ZeroJob();
    error ZeroHash();
    error JobUsed();
    error GasShort();
    error BooksFull();

    constructor(address imd, address payroll) {
        IMD = imd;
        PAYROLL = payroll;
    }

    // --- employer ---

    function createOrder(OrderParams calldata p, bytes calldata spec) public virtual override returns (uint256 id) {
        uint256 at = firstBad(spec);
        if (at != type(uint256).max) revert SpecInvalid(at);
        if (p.maxPay == 0 || p.minPay > p.maxPay) revert PayRange();
        if (p.deliverySecs < MIN_DELIVERY) revert DeliveryTooShort();
        if (p.deliverySecs > MAX_DELIVERY) revert DeliveryTooLong();
        if (p.bond < MIN_BOND) revert BondTooLow();
        if (p.expiresAt <= block.timestamp) revert Expired();
        if (p.flags > 3) revert BadFlags();
        if (p.condTarget != address(0) || p.condCmp != 0) revert BadCondition();

        id = ++orderCount;
        _orders[id] = Order({
            employer: msg.sender,
            expiresAt: p.expiresAt,
            rampFrom: uint40(block.timestamp),
            state: State.Open,
            flags: p.flags,
            kindHash: p.kindHash,
            specHash: keccak256(spec),
            minPay: p.minPay,
            maxPay: p.maxPay,
            rampSecs: p.rampSecs,
            deliverySecs: p.deliverySecs,
            runnerOnly: p.runnerOnly,
            bond: p.bond,
            arbiter: p.arbiter,
            escrow: p.maxPay,
            spent: 0,
            returned: 0
        });
        lastParams = p;
        lastSpec = spec;
        lastCreator = msg.sender;
        emit OrderOpened(id, msg.sender, spec);
        IERC20(IMD).safeTransferFrom(msg.sender, address(this), p.maxPay);
    }

    function cancel(uint256 id) external override {
        Order storage o = _orders[id];
        if (o.state != State.Open) revert BadState();
        if (msg.sender != o.employer) revert NotEmployer();
        uint96 escrow = o.escrow;
        o.escrow = 0;
        o.state = State.Cancelled;
        o.returned += escrow;
        _send(msg.sender, escrow);
    }

    function refund(uint256 id) public virtual override {
        Order storage o = _orders[id];
        if (o.state != State.Open) revert BadState();
        if (block.timestamp < o.expiresAt) revert TooEarly();
        _send(o.employer, _close(o, true));
    }

    // --- runner ---

    function claim(uint256 id) external {
        Order storage o = _orders[id];
        if (o.state != State.Open) revert BadState();
        if (block.timestamp >= o.expiresAt) revert Expired();
        if (o.runnerOnly != address(0) && o.runnerOnly != msg.sender) revert NotRunner();
        if (barred[id][msg.sender]) revert Barred();
        if (uint256(o.returned) + o.escrow + o.bond > type(uint96).max) revert BooksFull();
        o.state = State.Claimed;
        _claims[id] = Claim({
            runner: msg.sender,
            claimedAt: uint40(block.timestamp),
            registeredAt: 0,
            price: _price(o),
            jobId: 0,
            challenger: address(0),
            assertedAt: 0,
            recordHash: 0
        });
        IERC20(IMD).safeTransferFrom(msg.sender, address(this), o.bond);
    }

    /// @dev Only inside the claim window, as on the real desk: afterwards the runner can only
    /// register or be evicted.
    function release(uint256 id) external {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Claimed) revert BadState();
        if (msg.sender != c.runner) revert NotRunner();
        if (block.timestamp >= c.claimedAt + CLAIM_WINDOW) revert TooLate();
        barred[id][msg.sender] = true;
        uint256 cut = _releaseCut(o.bond);
        _endClaim(o, c, o.bond - cut, cut, 0, false);
    }

    function evict(uint256 id) public virtual {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Claimed) revert BadState();
        if (block.timestamp < c.claimedAt + CLAIM_WINDOW) revert TooEarly();
        _endClaim(o, c, 0, o.bond, 0, false);
    }

    function register(uint256 id, bytes16 jobId) external {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Claimed && o.state != State.Registered) revert BadState();
        if (msg.sender != c.runner) revert NotRunner();
        if (jobId == 0) revert ZeroJob();
        if (orderOfJob[jobId] != 0) revert JobUsed();
        if (o.state == State.Claimed) {
            o.state = State.Registered;
            c.registeredAt = uint40(block.timestamp);
        }
        c.jobId = jobId;
    }

    /// @dev Stands for `settle` with a receipt that proves completed work of the right kind and
    /// objective. Anyone may call, as on the real desk. After a delivery claim, challenged or not,
    /// such a receipt pays the runner whatever hash it named.
    function settle(uint256 id, bytes32 recordHash) external {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state < State.Registered || o.state > State.Disputed) revert BadState();
        if (orderOfJob[c.jobId] != 0) revert JobUsed();
        orderOfJob[c.jobId] = id;
        _deliver(o, c, recordHash);
        _notify(id);
    }

    /// @dev Stands for `reportFailed` with a receipt that does not settle the order.
    /// `sameObjective` says whether the receipt showed this claim's own objective (the swarm failed
    /// the job: bond back to the runner, who alone may report it) or another one (bond to the
    /// employer). After a delivery claim any such receipt contradicts the claim: unchallenged, the
    /// whole bond goes to the employer; challenged, the employer gets the release share and the
    /// challenger the rest with its own bond.
    function reportFailed(uint256 id, bool sameObjective) external {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        State s = o.state;
        if (s < State.Registered || s > State.Disputed) revert BadState();
        uint256 bond = o.bond;
        if (s == State.Disputed) {
            uint256 cut = _releaseCut(bond);
            _endClaim(o, c, 0, cut, bond * 2 - cut, false);
        } else if (s == State.Asserted) {
            _endClaim(o, c, 0, bond, 0, false);
        } else if (sameObjective) {
            if (msg.sender != c.runner) revert NotRunner();
            _endClaim(o, c, bond, 0, 0, false);
        } else {
            _endClaim(o, c, 0, bond, 0, false);
        }
    }

    /// @dev A registered job past its delivery time: the bond to the employer, the order open again
    /// or refunded. A challenged claim that nothing decided: the employer is refunded for good, the
    /// challenger gets its bond back, and the runner is treated as if it had released the order.
    function timeout(uint256 id) public virtual {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        State s = o.state;
        if (s != State.Registered && s != State.Disputed) revert BadState();
        if (block.timestamp < uint256(c.registeredAt) + o.deliverySecs) revert TooEarly();
        uint256 bond = o.bond;
        if (s == State.Registered) {
            _endClaim(o, c, 0, bond, 0, false);
        } else {
            uint256 cut = _releaseCut(bond);
            _endClaim(o, c, bond - cut, cut, bond, true);
        }
    }

    function claimDelivered(uint256 id, bytes32 recordHash) external {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Registered) revert BadState();
        if (msg.sender != c.runner) revert NotRunner();
        if (o.flags & FLAG_ALLOW_CLAIMED == 0) revert ClaimedPathOff();
        if (recordHash == 0) revert ZeroHash();
        if (block.timestamp + CHALLENGE_WINDOW + DISPUTE_WINDOW > uint256(c.registeredAt) + o.deliverySecs) {
            revert TooLate();
        }
        o.state = State.Asserted;
        c.assertedAt = uint40(block.timestamp);
        c.recordHash = recordHash;
    }

    function challenge(uint256 id) external {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Asserted) revert BadState();
        if (block.timestamp >= c.assertedAt + CHALLENGE_WINDOW) revert TooLate();
        o.state = State.Disputed;
        c.challenger = msg.sender;
        IERC20(IMD).safeTransferFrom(msg.sender, address(this), o.bond);
    }

    function finalize(uint256 id) external {
        Order storage o = _orders[id];
        Claim storage c = _claims[id];
        if (o.state != State.Asserted) revert BadState();
        if (block.timestamp < c.assertedAt + CHALLENGE_WINDOW) revert TooEarly();
        _deliver(o, c, c.recordHash);
        _notify(id);
    }

    /// @dev Tries the employer's callback again for a delivered order whose callback failed.
    function redeliver(uint256 id) external {
        Order storage o = _orders[id];
        if (o.state != State.Delivered || notified[id] || o.flags & FLAG_CALLBACK == 0) revert BadState();
        _notify(id);
    }

    // --- views ---

    function stateOf(uint256 id) external view override returns (State) {
        return _orders[id].state;
    }

    function accountOf(uint256 id)
        public
        view
        virtual
        override
        returns (State state, address employer, uint96 escrow, uint96 spent, uint96 returned)
    {
        Order storage o = _orders[id];
        return (o.state, o.employer, o.escrow, o.spent, o.returned);
    }

    function lastOrderParams() external view returns (OrderParams memory) {
        return lastParams;
    }

    function orderOf(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    function claimOf(uint256 id) external view returns (Claim memory) {
        return _claims[id];
    }

    /// @dev The price a claim made now would fix, or the price the current claim fixed.
    function priceNow(uint256 id) external view returns (uint96) {
        Order storage o = _orders[id];
        State s = o.state;
        return s >= State.Claimed && s <= State.Delivered ? _claims[id].price : _price(o);
    }

    /// @dev The desk's character rules, written here independently of `SpecRules` so the two can
    /// be compared. Returns the index of the first fault, or the maximum uint when there is none.
    function firstBad(bytes calldata spec) public pure returns (uint256) {
        if (spec.length == 0) return 0;
        if (spec.length > 7900) return 7900;
        if (spec[0] == " ") return 0;
        for (uint256 i; i < spec.length; ++i) {
            uint8 c = uint8(spec[i]);
            if (c < 32 || c > 126 || c == 34 || c == 92) return i;
        }
        if (spec[spec.length - 1] == " ") return spec.length - 1;
        return type(uint256).max;
    }

    // --- internals ---

    /// @dev A straight line from `minPay` to `maxPay` over `rampSecs` of time spent open.
    function _price(Order storage o) internal view returns (uint96) {
        uint256 elapsed = block.timestamp - o.rampFrom;
        if (elapsed >= o.rampSecs) return o.maxPay;
        return uint96(o.minPay + uint256(o.maxPay - o.minPay) * elapsed / o.rampSecs);
    }

    function _releaseCut(uint256 bond) internal pure returns (uint256) {
        return bond * RELEASE_BPS / BPS;
    }

    function _deliver(Order storage o, Claim storage c, bytes32 recordHash) internal {
        uint256 price = c.price;
        uint256 fee = (price * FEE_BPS + BPS - 1) / BPS;
        uint256 tip = (price * TIP_BPS + BPS - 1) / BPS;
        if (tip > price - fee) tip = price - fee;
        uint256 unused = o.escrow - price;
        uint256 bonds = o.state == State.Disputed ? uint256(o.bond) * 2 : o.bond;

        o.state = State.Delivered;
        o.escrow = 0;
        o.spent = uint96(price);
        o.returned += uint96(unused);
        c.recordHash = recordHash;

        _send(c.runner, price - fee - tip + bonds);
        _send(o.employer, unused);
        _send(PAYROLL, fee + tip);
    }

    function _endClaim(
        Order storage o,
        Claim storage c,
        uint256 toRunner,
        uint256 toEmployer,
        uint256 toChallenger,
        bool refundNow
    ) internal {
        uint256 back = toEmployer + _close(o, refundNow);
        // Open again: the ramp goes on from where this claim found it.
        if (o.state == State.Open) o.rampFrom += uint40(block.timestamp - c.claimedAt);
        o.returned += uint96(toEmployer);
        bondsToEmployers += toEmployer;
        _send(c.runner, toRunner);
        _send(c.challenger, toChallenger);
        _send(o.employer, back);
    }

    /// @dev An order nobody holds: open again, or refunded when it has expired or `refundNow`.
    function _close(Order storage o, bool refundNow) internal returns (uint256 escrow) {
        if (refundNow || block.timestamp >= o.expiresAt) {
            escrow = o.escrow;
            o.escrow = 0;
            o.state = State.Refunded;
            o.returned += uint96(escrow);
        } else {
            o.state = State.Open;
        }
    }

    function _send(address to, uint256 amount) internal {
        if (amount != 0) IERC20(IMD).safeTransfer(to, amount);
    }

    function _notify(uint256 id) internal {
        Order storage o = _orders[id];
        if (o.flags & FLAG_CALLBACK == 0 || notified[id]) return;
        Claim storage c = _claims[id];
        if (gasleft() < CALLBACK_GAS * 64 / 63 + 10_000) revert GasShort();
        // A raw call, as on the real desk: fixed gas, no code check on the employer.
        notified[id] = true;
        (bool ok,) = o.employer.call{gas: CALLBACK_GAS}(
            abi.encodeCall(IWorkEmployer.onWorkDelivered, (id, c.jobId, c.recordHash))
        );
        callbackFailed[id] = !ok;
        if (!ok) {
            notified[id] = false;
            emit CallbackFailed(id);
        }
    }
}

/// @notice A desk that breaks its own interface in ways a test switches on, to show that an
/// employer contract fails safe when the desk's answers and the money disagree.
contract OddDesk is MockWorkOrders {
    using SafeERC20 for IERC20;

    bool public rejectOrders;
    bool public reuseLastId;
    uint96 public pullShortBy;
    address public reportEmployer;
    uint96 public overReportBy;
    bool public refundReverts;
    bool public upkeepReverts;
    address public reenterTarget;
    bytes public reenterData;
    bool public reenterOk;
    bytes public reenterResult;

    error Rejected();

    constructor(address imd, address payroll) MockWorkOrders(imd, payroll) {}

    function setRejectOrders(bool on) external {
        rejectOrders = on;
    }

    function setReuseLastId(bool on) external {
        reuseLastId = on;
    }

    function setPullShortBy(uint96 amount) external {
        pullShortBy = amount;
    }

    function setReportEmployer(address employer) external {
        reportEmployer = employer;
    }

    function setOverReportBy(uint96 amount) external {
        overReportBy = amount;
    }

    function setRefundReverts(bool on) external {
        refundReverts = on;
    }

    /// @dev Makes `evict` and `timeout` revert whatever the order's state.
    function setUpkeepReverts(bool on) external {
        upkeepReverts = on;
    }

    /// @dev Makes `createOrder` call `target` with `data` before doing anything else.
    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    /// @dev The desk calling an employer's callback for an order of its choosing.
    function callBack(address employer, uint256 orderId, bytes16 jobId, bytes32 recordHash) external {
        IWorkEmployer(employer).onWorkDelivered(orderId, jobId, recordHash);
    }

    function createOrder(OrderParams calldata p, bytes calldata spec) public override returns (uint256 id) {
        if (rejectOrders) revert Rejected();
        if (reenterTarget != address(0)) {
            (reenterOk, reenterResult) = reenterTarget.call(reenterData);
        }
        if (reuseLastId) {
            IERC20(IMD).safeTransferFrom(msg.sender, address(this), p.maxPay);
            return orderCount;
        }
        if (pullShortBy != 0) {
            id = ++orderCount;
            _orders[id].employer = msg.sender;
            _orders[id].state = State.Open;
            _orders[id].escrow = p.maxPay - pullShortBy;
            IERC20(IMD).safeTransferFrom(msg.sender, address(this), p.maxPay - pullShortBy);
            return id;
        }
        return super.createOrder(p, spec);
    }

    function refund(uint256 id) public override {
        if (refundReverts) revert Rejected();
        super.refund(id);
    }

    function evict(uint256 id) public override {
        if (upkeepReverts) revert Rejected();
        super.evict(id);
    }

    function timeout(uint256 id) public override {
        if (upkeepReverts) revert Rejected();
        super.timeout(id);
    }

    function accountOf(uint256 id)
        public
        view
        override
        returns (State state, address employer, uint96 escrow, uint96 spent, uint96 returned)
    {
        (state, employer, escrow, spent, returned) = super.accountOf(id);
        if (reportEmployer != address(0)) employer = reportEmployer;
        returned += overReportBy;
    }
}
