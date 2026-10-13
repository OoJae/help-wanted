// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IWorkEmployer, IWorkOrders} from "../interfaces/IWorkOrders.sol";

/// @title Doorbell: a contract with no owner that hires the swarm when it has been rung enough
/// @notice Anyone calls `ring()`. Every 25th ring, if the Doorbell holds enough IMD, it opens an
/// order on the hire desk for a job written in its own code: a picture of the doorbell of the day.
/// It exists so that a contract employing the swarm can be watched happening, on demand.
///
/// @dev Nobody can change what it orders, what it pays or where its money goes. Its IMD comes from
/// plain transfers by anyone who wants to keep it ringing, and leaves only as the escrow of its
/// own orders. Whatever the desk returns (an unused part of the escrow, a refund, a forfeited
/// bond) lands back in its balance and pays for a later hire. There is no way to withdraw. Its
/// orders never name an arbiter and are never reserved for one runner.
///
/// One thing is chosen when it is deployed and never again: `ALLOW_CLAIMED`, whether its orders
/// accept the desk's bonded-claim path. The choice is made on launch day by whether IdentityMD's
/// on-chain receipts are arriving.
///
/// - Off: an order pays only against an on-chain receipt of a completed job of kind `KIND_HASH`
///   whose objective is the order's header followed by `SPEC`. If `KIND_HASH` is not the kind the
///   swarm writes for this job, or no receipt ever lands, no order is ever paid: each one ends in
///   a refund, the escrow comes back, the next 25th ring orders again, and the IMD stays in the
///   Doorbell for good.
/// - On: a runner may also state, without a receipt, that the job was delivered, and is paid if
///   nobody challenges within the desk's 24-hour window. That keeps the Doorbell working while
///   receipts are late, and it comes with two limits, stated plainly. A claim that misreports,
///   and that nobody challenges in time, is paid: everything the Doorbell holds is open to
///   whoever rings it, takes the order and claims, unless somebody posts the challenge bond each
///   time. And a challenge that nothing decides by the delivery deadline refunds the order even
///   when the claim was true, at no cost to the challenger, so while receipts are late a true
///   claim can be stopped. A receipt of the job decides, for the runner or against it, whenever
///   somebody submits it before the claim has been paid or has run out of time.
///
/// Either way it is a demonstration and should hold small amounts. There is no limit on how often
/// it hires other than its balance: 25 rings and one escrow per order. Whoever funds it funds
/// pictures, and nothing else can be done with the money.
contract Doorbell is IWorkEmployer, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice One order the Doorbell opened.
    struct Hire {
        /// The ring count that opened it. Never zero for a real hire.
        uint64 ring;
        uint40 openedAt;
        /// Set when the desk reports the delivery through `onWorkDelivered`.
        bool delivered;
        bytes16 jobId;
        /// The record hash the desk reported with the delivery. On the claimed path this is the
        /// hash the runner named; the desk's own record of the order is the one to trust.
        bytes32 recordHash;
    }

    /// @notice The job the Doorbell orders, byte for byte as a runner must send it to the swarm.
    /// @dev Printable ASCII with no double quote, no backslash and no space at either end, which
    /// is what the desk requires of a spec.
    string public constant SPEC = "Draw the doorbell of the day. Make one square picture of a single doorbell next to a front "
        "door, in a visual style chosen fresh for today so that no two days look alike. Write the "
        "current UTC date as YYYY-MM-DD in small plain lettering in the lower right corner and put no "
        "other text in the picture. This job was ordered on chain by the HELP WANTED Doorbell, a "
        "contract with no owner that hires the swarm on every 25th ring.";
    /// @notice keccak256 of `SPEC`, the hash the desk stores for each of the Doorbell's orders.
    bytes32 public constant SPEC_HASH = keccak256(bytes(SPEC));

    /// @notice An order is opened on every ring whose count is a multiple of this.
    uint256 public constant RINGS_PER_HIRE = 25;
    /// @notice How long an order waits for a runner. Untaken after that, anyone can have the desk
    /// refund it, and the escrow returns to the Doorbell for the next hire.
    uint32 public constant HIRE_SECS = 2 days;
    /// @notice How long the price takes to rise from `MIN_PAY` to `MAX_PAY`, when they differ.
    uint32 public constant RAMP_SECS = 1 hours;
    /// @notice The longest delivery time the Doorbell can be deployed with. A picture does not
    /// take longer, and the desk refuses orders whose delivery time is far beyond this.
    uint32 public constant MAX_DELIVERY_SECS = 30 days;
    /// @dev The desk's published minimums. The constructor cannot ask the desk, so it checks
    /// against these to refuse a configuration that could never hire.
    uint96 private constant DESK_MIN_BOND = 0.25e18;
    uint32 private constant DESK_MIN_DELIVERY = 3 days;

    /// @notice The IMD token.
    IERC20 public immutable IMD;
    /// @notice The hire desk the Doorbell orders through.
    IWorkOrders public immutable WORK_ORDERS;
    /// @notice keccak256 of the work record's `kind` string for the job the Doorbell orders.
    /// @dev A record's kind is the name of the template the job was opened with. For a picture
    /// that is the swarm's create-image skill, whose records carry `skill:create-image`; a runner
    /// has to open the Doorbell's job with that skill. Nothing on chain can check the value given
    /// here: with `ALLOW_CLAIMED` off, one the swarm never writes means no order can ever be paid.
    bytes32 public immutable KIND_HASH;
    /// @notice Where each order's price starts.
    uint96 public immutable MIN_PAY;
    /// @notice The escrow of each order, and so what the Doorbell must hold on a 25th ring to hire.
    uint96 public immutable MAX_PAY;
    /// @notice What a runner must post to take one of the Doorbell's orders. With `ALLOW_CLAIMED`
    /// on, it is also what somebody must post to challenge a delivery claim.
    uint96 public immutable BOND;
    /// @notice How long a runner has, after registering the job, for a receipt to exist.
    uint32 public immutable DELIVERY_SECS;
    /// @notice Whether the Doorbell's orders accept a bonded delivery claim when there is no
    /// receipt. False means only an on-chain receipt pays. See the contract's notes for what
    /// each setting means for the money it holds.
    bool public immutable ALLOW_CLAIMED;

    /// @notice How many times the Doorbell has been rung.
    uint64 public rings;
    /// @notice How many orders it has opened.
    uint64 public hires;
    /// @notice How many deliveries the desk has reported back.
    uint64 public receipts;
    /// @notice The most recent order it opened. Meaningful once `hires` is above zero.
    uint256 public lastOrderId;
    /// @notice The most recent order reported delivered. Meaningful once `receipts` is above zero.
    uint256 public lastDeliveredOrderId;

    mapping(uint256 orderId => Hire) private _hires;

    /// @notice Somebody rang; `count` is the ring count after this ring.
    event Rang(address indexed ringer, uint256 count);
    /// @notice The ring numbered `count` opened order `orderId` with `escrow` IMD.
    event Hired(uint256 indexed orderId, address indexed ringer, uint256 count, uint256 escrow, uint40 expiresAt);
    /// @notice A 25th ring came while the Doorbell held less than one order's escrow.
    event HireSkipped(uint256 count, uint256 balance, uint256 needed);
    /// @notice The desk reported one of the Doorbell's orders delivered; `receipts` is the new total.
    event Delivered(uint256 indexed orderId, bytes16 jobId, bytes32 recordHash, uint256 receipts);

    /// @notice A constructor address is zero.
    error ZeroAddress();
    /// @notice `kindHash` is zero.
    error KindMissing();
    /// @notice `minPay` is zero or above `maxPay`.
    error BadPriceRange();
    /// @notice `bond` is below the desk's minimum.
    error BondTooLow();
    /// @notice `deliverySecs` is below the desk's minimum.
    error DeliveryTooShort();
    /// @notice `deliverySecs` is above `MAX_DELIVERY_SECS`.
    error DeliveryTooLong();
    /// @notice Only the desk may report a delivery.
    error NotDesk();
    /// @notice The desk reported a delivery for an order the Doorbell did not open.
    error UnknownOrder(uint256 orderId);
    /// @notice The desk reported the same delivery twice.
    error AlreadyDelivered(uint256 orderId);
    /// @notice The desk did not pull exactly `MAX_PAY` when the order was created.
    error DeskPulledWrongAmount(uint256 allowanceLeft);
    /// @notice The desk answered `createOrder` with the id of an order the Doorbell already has.
    error OrderIdReused(uint256 orderId);
    /// @notice The desk does not name the Doorbell as the employer of its new order.
    error NotOurOrder(uint256 orderId);

    /// @param imd The IMD token.
    /// @param workOrders The hire desk.
    /// @param kindHash keccak256 of the `kind` string of the job to order.
    /// @param minPay Where each order's price starts.
    /// @param maxPay Where it ends; also the escrow pulled for each order.
    /// @param bond What a runner must post to take an order.
    /// @param deliverySecs How long a runner has, after registering the job, for a receipt to exist:
    /// 3 to 30 days.
    /// @param allowClaimed Whether orders accept a bonded delivery claim when there is no receipt.
    /// @dev Calls nothing. Reverts on a configuration that could never hire.
    constructor(
        address imd,
        address workOrders,
        bytes32 kindHash,
        uint96 minPay,
        uint96 maxPay,
        uint96 bond,
        uint32 deliverySecs,
        bool allowClaimed
    ) {
        if (imd == address(0) || workOrders == address(0)) revert ZeroAddress();
        if (kindHash == bytes32(0)) revert KindMissing();
        if (minPay == 0 || minPay > maxPay) revert BadPriceRange();
        if (bond < DESK_MIN_BOND) revert BondTooLow();
        if (deliverySecs < DESK_MIN_DELIVERY) revert DeliveryTooShort();
        if (deliverySecs > MAX_DELIVERY_SECS) revert DeliveryTooLong();
        IMD = IERC20(imd);
        WORK_ORDERS = IWorkOrders(workOrders);
        KIND_HASH = kindHash;
        MIN_PAY = minPay;
        MAX_PAY = maxPay;
        BOND = bond;
        DELIVERY_SECS = deliverySecs;
        ALLOW_CLAIMED = allowClaimed;
    }

    /// @notice Rings the Doorbell. Anyone may, as often as they like; every ring is counted.
    /// @return count The ring count after this ring.
    /// @return hired Whether this ring opened an order.
    /// @return orderId The desk's id for that order; meaningful only when `hired`.
    /// @dev On every 25th ring: with at least `MAX_PAY` IMD in the contract, an order is opened;
    /// with less, the ring is still counted and `HireSkipped` says why nothing was hired. If the
    /// desk refuses the order the whole call reverts and the ring is not counted.
    function ring() external nonReentrant returns (uint256 count, bool hired, uint256 orderId) {
        count = ++rings;
        emit Rang(msg.sender, count);
        if (count % RINGS_PER_HIRE != 0) return (count, hired, orderId);

        uint256 balance = IMD.balanceOf(address(this));
        if (balance < MAX_PAY) {
            emit HireSkipped(count, balance, MAX_PAY);
        } else {
            orderId = _hire(count);
            hired = true;
        }
    }

    /// @inheritdoc IWorkEmployer
    /// @dev Only the desk may call, once per order, and only for an order the Doorbell opened. It
    /// adds to the Doorbell's history and moves no money. It never hires: the next order waits for
    /// the next 25th ring.
    function onWorkDelivered(uint256 orderId, bytes16 jobId, bytes32 recordHash) external override {
        if (msg.sender != address(WORK_ORDERS)) revert NotDesk();
        Hire storage h = _hires[orderId];
        if (h.ring == 0) revert UnknownOrder(orderId);
        if (h.delivered) revert AlreadyDelivered(orderId);
        h.delivered = true;
        h.jobId = jobId;
        h.recordHash = recordHash;
        uint256 count = ++receipts;
        lastDeliveredOrderId = orderId;
        emit Delivered(orderId, jobId, recordHash, count);
    }

    /// @notice What the Doorbell recorded about one of its orders. All zero for any other id.
    function hireOf(uint256 orderId) external view returns (Hire memory) {
        return _hires[orderId];
    }

    /// @notice How many more rings until the next 25th ring: 1 to 25.
    function ringsUntilHire() external view returns (uint256) {
        return RINGS_PER_HIRE - (rings % RINGS_PER_HIRE);
    }

    /// @notice Whether the Doorbell holds enough IMD for the next 25th ring to hire.
    function funded() external view returns (bool) {
        return IMD.balanceOf(address(this)) >= MAX_PAY;
    }

    function _hire(uint256 count) private returns (uint256 orderId) {
        uint40 openedAt = SafeCast.toUint40(block.timestamp);
        uint40 expiresAt = openedAt + HIRE_SECS;
        uint8 flags = WORK_ORDERS.FLAG_CALLBACK();
        if (ALLOW_CLAIMED) flags |= WORK_ORDERS.FLAG_ALLOW_CLAIMED();
        IWorkOrders.OrderParams memory order = IWorkOrders.OrderParams({
            kindHash: KIND_HASH,
            minPay: MIN_PAY,
            maxPay: MAX_PAY,
            rampSecs: MIN_PAY == MAX_PAY ? 0 : RAMP_SECS,
            deliverySecs: DELIVERY_SECS,
            expiresAt: expiresAt,
            bond: BOND,
            flags: flags,
            runnerOnly: address(0),
            arbiter: address(0),
            condTarget: address(0),
            condSelector: bytes4(0),
            condArg: bytes32(0),
            condCmp: 0,
            condThreshold: 0
        });

        ++hires;
        IMD.forceApprove(address(WORK_ORDERS), MAX_PAY);
        orderId = WORK_ORDERS.createOrder(order, bytes(SPEC));

        // The allowance was exactly `MAX_PAY`, so a spent allowance means exactly that was pulled.
        uint256 allowanceLeft = IMD.allowance(address(this), address(WORK_ORDERS));
        if (allowanceLeft != 0) revert DeskPulledWrongAmount(allowanceLeft);
        // The callback trusts this record, so the id must be new here and the desk must agree
        // that the Doorbell is the employer.
        Hire storage h = _hires[orderId];
        if (h.ring != 0) revert OrderIdReused(orderId);
        // Only the employer is wanted here: the Doorbell keeps no books of its orders' amounts.
        // slither-disable-next-line unused-return
        (, address employer,,,) = WORK_ORDERS.accountOf(orderId);
        if (employer != address(this)) revert NotOurOrder(orderId);

        h.ring = SafeCast.toUint64(count);
        h.openedAt = openedAt;
        lastOrderId = orderId;
        emit Hired(orderId, msg.sender, count, MAX_PAY, expiresAt);
    }
}
