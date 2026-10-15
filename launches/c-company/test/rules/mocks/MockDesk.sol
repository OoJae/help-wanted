// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IWorkEmployer, IWorkOrders} from "../../../src/interfaces/IWorkOrders.sol";

/// @dev A stand-in for the hire desk (`WorkOrders`, launch B), which lives in another project. It
/// keeps the books the frozen interface describes (`escrow`, `spent`, `returned` per order) and
/// moves real tokens, so tests can follow every wei.
///
/// The employer's side follows the real desk line for line, as read from
/// `launches/b-desk/src/desk/WorkOrders.sol`: `createOrder` makes the same checks in the same order
/// and reverts with the same errors and the same error data (`SpecInvalid(at)`, `PayRange`,
/// `DeliveryTooShort`, `DeliveryTooLong`, `BondTooLow`, `Expired`, `BadFlags`, `BadCondition`);
/// `cancel` checks the state before the caller (`BadState`, then `NotEmployer`); `refund` opens at
/// the very second of the expiry (`BadState`, `TooEarly`); the constants are the desk's. The spec
/// rule is written here byte by byte, independently of the word-at-a-time check in Rules, so the
/// two can be compared.
///
/// The runner's side is collapsed into test helpers (`deliver`, `awardBond`). The knobs at the
/// bottom make it misreport on purpose, to show what Rules does with a desk that gets its books
/// wrong; the real desk has none of them.
contract MockDesk is IWorkOrders {
    using SafeERC20 for IERC20;

    uint8 public constant FLAG_ALLOW_CLAIMED = 1;
    uint8 public constant FLAG_CALLBACK = 2;
    uint8 public constant FLAG_COND_ARG = 4;
    uint96 public constant MIN_BOND = 0.25e18;
    uint32 public constant MIN_DELIVERY = 3 days;
    /// @dev Not part of the frozen interface; the real desk publishes it the same way.
    uint32 public constant MAX_DELIVERY = 90 days;
    uint256 public constant CALLBACK_GAS = 150_000;
    /// @dev Where money paid for delivered work goes (runner, fee and tip together).
    address public constant SINK = address(0xFEE5);

    struct Order {
        State state;
        address employer;
        uint96 escrow;
        uint96 spent;
        uint96 returned;
        bytes32 specHash;
        OrderParams params;
    }

    address public immutable IMD;
    uint256 public orderCount;
    mapping(uint256 => Order) internal _orders;

    // Knobs for a desk that misreports.
    uint96 public pullShortBy;
    bool public reuseLastId;
    mapping(uint256 => uint96) public overReport;
    mapping(uint256 => address) public employerOverride;
    /// @dev When set, `createOrder` and `cancel` call their caller back with these bytes first, and
    /// fail if that call fails: a desk that tries to re-enter its employer.
    bytes public callBack;

    /// @dev What `firstBad` returns for a spec that breaks no rule, as in the desk's `SpecText`.
    uint256 public constant NONE = type(uint256).max;
    uint256 public constant MAX_SPEC = 7900;

    event CallbackFailed(uint256 indexed id);

    // The real desk's errors, with its names and arguments.
    error BadState();
    error NotEmployer();
    error SpecInvalid(uint256 at);
    error PayRange();
    error DeliveryTooShort();
    error DeliveryTooLong();
    error BondTooLow();
    error BadFlags();
    error BadCondition();
    error Expired();
    error TooEarly();
    /// @dev The helper `deliver` was given a price above the escrow. Not an error of the real desk.
    error HelperMisused();

    constructor(address imd) {
        IMD = imd;
    }

    // ---- the frozen surface ----

    function createOrder(OrderParams calldata p, bytes calldata spec) external returns (uint256 id) {
        _callBack();
        // The real desk's checks, in its order.
        uint256 at = firstBad(spec);
        if (at != NONE) revert SpecInvalid(at);
        if (p.maxPay == 0 || p.minPay > p.maxPay) revert PayRange();
        if (p.deliverySecs < MIN_DELIVERY) revert DeliveryTooShort();
        if (p.deliverySecs > MAX_DELIVERY) revert DeliveryTooLong();
        if (p.bond < MIN_BOND) revert BondTooLow();
        if (p.expiresAt <= block.timestamp) revert Expired();
        bool conditional = p.condTarget != address(0);
        if (p.flags > 7 || (!conditional && p.flags & FLAG_COND_ARG != 0)) revert BadFlags();
        if (p.condCmp > 6 || conditional == (p.condCmp == 0)) revert BadCondition();
        IERC20(IMD).safeTransferFrom(msg.sender, address(this), p.maxPay - pullShortBy);
        if (reuseLastId && orderCount != 0) return orderCount;
        id = ++orderCount;
        Order storage o = _orders[id];
        o.state = State.Open;
        o.employer = msg.sender;
        o.escrow = p.maxPay - pullShortBy;
        o.specHash = keccak256(spec);
        o.params = p;
    }

    function cancel(uint256 id) external {
        _callBack();
        Order storage o = _orders[id];
        if (o.state != State.Open) revert BadState();
        if (msg.sender != o.employer) revert NotEmployer();
        o.state = State.Cancelled;
        _giveBack(o, o.escrow);
    }

    function refund(uint256 id) external {
        Order storage o = _orders[id];
        if (o.state != State.Open) revert BadState();
        // As on the real desk: refundable from the very second of the expiry.
        if (block.timestamp < o.params.expiresAt) revert TooEarly();
        o.state = State.Refunded;
        _giveBack(o, o.escrow);
    }

    function stateOf(uint256 id) external view returns (State) {
        return _orders[id].state;
    }

    function accountOf(uint256 id)
        external
        view
        returns (State state, address employer, uint96 escrow, uint96 spent, uint96 returned)
    {
        Order storage o = _orders[id];
        employer = employerOverride[id] == address(0) ? o.employer : employerOverride[id];
        return (o.state, employer, o.escrow, o.spent, o.returned + overReport[id]);
    }

    // ---- what the real desk does through runners, collapsed for tests ----

    /// @dev Settles an open order at `price`: the price leaves for good, the rest of the escrow goes
    /// back to the employer, and the employer hears about it if it asked to.
    function deliver(uint256 id, uint96 price, bytes16 jobId) external {
        Order storage o = _orders[id];
        if (o.state != State.Open) revert BadState();
        if (price > o.escrow) revert HelperMisused();
        o.state = State.Delivered;
        o.spent = price;
        uint96 change = o.escrow - price;
        o.escrow = change;
        if (price != 0) IERC20(IMD).safeTransfer(SINK, price);
        _giveBack(o, change);
        if (o.params.flags & FLAG_CALLBACK != 0) {
            try IWorkEmployer(o.employer).onWorkDelivered{gas: CALLBACK_GAS}(
                id, jobId, keccak256(abi.encode(id, jobId))
            ) {}
            catch {
                emit CallbackFailed(id);
            }
        }
    }

    /// @dev A runner's bond awarded to the employer while the order stays open. The caller supplies it.
    function awardBond(uint256 id, uint96 amount) external {
        Order storage o = _orders[id];
        if (o.state != State.Open) revert BadState();
        o.returned += amount;
        IERC20(IMD).safeTransferFrom(msg.sender, o.employer, amount);
    }

    /// @dev The desk's spec rule and the position it reports, written one byte at a time and
    /// independently of Rules so the two can be compared. `NONE` for a spec that breaks no rule;
    /// 0 for an empty one; `MAX_SPEC` for one that is too long; otherwise the lowest index of a byte
    /// that is not allowed where it stands (a space at the end is the highest index there is, so it
    /// is named only when nothing else is at fault).
    function firstBad(bytes calldata spec) public pure returns (uint256) {
        uint256 n = spec.length;
        if (n == 0) return 0;
        if (n > MAX_SPEC) return MAX_SPEC;
        if (uint8(spec[0]) == 32) return 0;
        for (uint256 i = 0; i < n; i++) {
            uint8 ch = uint8(spec[i]);
            if (ch < 32 || ch >= 127 || ch == 34 || ch == 92) return i;
        }
        if (uint8(spec[n - 1]) == 32) return n - 1;
        return NONE;
    }

    function specOk(bytes calldata spec) public pure returns (bool) {
        return firstBad(spec) == NONE;
    }

    function paramsOf(uint256 id) external view returns (OrderParams memory) {
        return _orders[id].params;
    }

    function specHashOf(uint256 id) external view returns (bytes32) {
        return _orders[id].specHash;
    }

    // ---- knobs ----

    function setPullShortBy(uint96 by) external {
        pullShortBy = by;
    }

    function setReuseLastId(bool on) external {
        reuseLastId = on;
    }

    function setOverReport(uint256 id, uint96 extra) external {
        overReport[id] = extra;
    }

    function setEmployerOverride(uint256 id, address who) external {
        employerOverride[id] = who;
    }

    function setCallBack(bytes calldata data) external {
        callBack = data;
    }

    function _callBack() private {
        bytes memory data = callBack;
        if (data.length == 0) return;
        (bool ok, bytes memory why) = msg.sender.call(data);
        if (!ok) {
            assembly {
                revert(add(why, 0x20), mload(why))
            }
        }
    }

    function _giveBack(Order storage o, uint96 amount) private {
        o.escrow -= amount;
        o.returned += amount;
        if (amount != 0) IERC20(IMD).safeTransfer(o.employer, amount);
    }
}
