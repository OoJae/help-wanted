// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev A stand-in for Standing Questions (`Questions`, launch A), which lives in another project. It
/// carries the meter side: `costOf`, `meterOf`, `sharesOf`, `fund`, `fundFor` and `defund`; and
/// `latest`, which answers whatever a test stored with `setLatest`, so that a FEED rule can read a
/// feed at the same address as the meter it funds (`LaunchRunbook.t.sol`).
///
/// The meter follows the real contract line for line, as read from
/// `launches/a-payroll/src/questions/Questions.sol`:
///
/// - `costOf` is zero for an unknown feed and while the Intake is not selling the feed's action;
/// - `fund` and `fundFor` revert `UnknownFeed(feedId)` for an unknown feed and `ZeroAmount` for
///   nothing; `fundFor` reverts `ZeroAddress` for a zero beneficiary before anything else;
/// - what is credited is what arrived; the first funder gets one share per wei, later ones shares
///   at the meter's current worth, rounded down, and a credit of no shares reverts `ZeroShares`;
/// - a meter that rounds spent to exactly zero retires its old shares before the next funding;
/// - `defund` pays a holder's part of the unspent balance, rounded down, and takes everything the
///   caller holds when asked for more.
///
/// What it leaves out: asking, the oracle, rounds and how an answer is checked (an answer is
/// whatever `setLatest` stored), and the rescaling of share counts in a meter that has run for a
/// very long time. A round being bought is the helper `spend`.
///
/// The switches make it fail in ways the real contract cannot, to show what Endowments does then.
contract MockQuestions {
    enum Mode {
        Normal,
        // `fund` reverts.
        Reverts,
        // `fund` pulls one wei less than it was told to.
        TakesLess,
        // `fund` calls back into the funder before pulling.
        CallsBack
    }

    IERC20 public immutable IMD;
    Mode public mode;
    bytes public callback;
    bool public callbackSucceeded;
    bytes public callbackResult;
    /// @dev What a request costs a known feed's meter: the Intake's price plus a keeper tip. Zero stands
    /// for an Intake that is not selling.
    uint256 public cost = 0.51e18;
    /// @dev When set, `costOf` and `meterOf` revert: a Questions that cannot be read.
    bool public viewsRevert;

    mapping(bytes32 => bool) public known;
    mapping(bytes32 => uint256) public meterBalance;
    mapping(bytes32 => uint256) public totalShares;
    mapping(bytes32 => uint256) public meterEpoch;
    mapping(bytes32 => mapping(uint256 => mapping(address => uint256))) private _shares;

    /// @dev The newest answer of a feed, in the shape the real `latest` returns.
    struct Answer {
        uint256 value;
        uint64 fromBlock;
        uint64 toBlock;
        uint64 round;
        uint64 updatedAt;
    }

    mapping(bytes32 => Answer) private _latest;

    event Funded(bytes32 indexed feedId, address indexed funder, uint256 amount, uint256 shares);
    event Defunded(bytes32 indexed feedId, address indexed funder, uint256 shares, uint256 amount);

    // The real contract's errors, with its names and arguments.
    error ZeroAddress();
    error ZeroAmount();
    error UnknownFeed(bytes32 feedId);
    error ZeroShares();
    error NothingToDefund();
    /// @dev Raised by the switches only.
    error Refused();

    constructor(address imd) {
        IMD = IERC20(imd);
    }

    // -------------------------------------------------------------------------------- test switches

    function addFeed(bytes32 feedId) external {
        known[feedId] = true;
    }

    /// @dev The real contract never forgets a feed. This is here so a test can show what a harvest does
    /// if Questions stopped knowing one all the same.
    function forgetFeed(bytes32 feedId) external {
        known[feedId] = false;
    }

    function setCost(uint256 cost_) external {
        cost = cost_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function setCallback(bytes calldata data) external {
        callback = data;
    }

    function setViewsRevert(bool on) external {
        viewsRevert = on;
    }

    /// @dev What `latest` reports for a feed from now on: as if round `round` had been answered with
    /// `value` at `updatedAt`, for a window of 7,000 blocks ending one block before.
    function setLatest(bytes32 feedId, uint256 value, uint64 round, uint64 updatedAt) external {
        // casting to 'uint64' is safe because block numbers stay far below 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 toBlock = uint64(block.number) - 1;
        _latest[feedId] = Answer(value, toBlock - 6_999, toBlock, round, updatedAt);
    }

    /// @dev A round was bought: the meter is worth less and no share is burnt. The IMD goes where the
    /// Intake's fee goes.
    function spend(bytes32 feedId, uint256 amount) external {
        meterBalance[feedId] -= amount;
        IMD.transfer(address(0xFEE5), amount);
    }

    // -------------------------------------------------------------------------------- IQuestions

    function costOf(bytes32 feedId) external view returns (uint256) {
        if (viewsRevert) revert Refused();
        return known[feedId] ? cost : 0;
    }

    function meterOf(bytes32 feedId) external view returns (uint256 balance, uint256 totalShares_) {
        if (viewsRevert) revert Refused();
        return (meterBalance[feedId], totalShares[feedId]);
    }

    function latest(bytes32 feedId)
        external
        view
        returns (uint256 value, uint64 fromBlock, uint64 toBlock, uint64 round, uint64 updatedAt)
    {
        Answer storage a = _latest[feedId];
        return (a.value, a.fromBlock, a.toBlock, a.round, a.updatedAt);
    }

    function sharesOf(bytes32 feedId, address funder) public view returns (uint256) {
        return _shares[feedId][meterEpoch[feedId]][funder];
    }

    function fund(bytes32 feedId, uint256 amount) external returns (uint256 shares) {
        return _fund(feedId, amount, msg.sender);
    }

    function fundFor(bytes32 feedId, uint256 amount, address beneficiary) external returns (uint256 shares) {
        if (beneficiary == address(0)) revert ZeroAddress();
        return _fund(feedId, amount, beneficiary);
    }

    function defund(bytes32 feedId, uint256 shares) external returns (uint256 amount) {
        uint256 mine = sharesOf(feedId, msg.sender);
        if (shares > mine) shares = mine;
        if (shares == 0) revert NothingToDefund();
        amount = Math.mulDiv(shares, meterBalance[feedId], totalShares[feedId]);
        _shares[feedId][meterEpoch[feedId]][msg.sender] = mine - shares;
        totalShares[feedId] -= shares;
        meterBalance[feedId] -= amount;
        emit Defunded(feedId, msg.sender, shares, amount);
        if (amount != 0) IMD.transfer(msg.sender, amount);
    }

    function _fund(bytes32 feedId, uint256 amount, address beneficiary) private returns (uint256 shares) {
        if (!known[feedId]) revert UnknownFeed(feedId);
        if (amount == 0) revert ZeroAmount();
        if (mode == Mode.Reverts) revert Refused();
        if (mode == Mode.CallsBack) {
            (callbackSucceeded, callbackResult) = msg.sender.call(callback);
        }

        uint256 held = IMD.balanceOf(address(this));
        IMD.transferFrom(msg.sender, address(this), mode == Mode.TakesLess ? amount - 1 : amount);
        uint256 received = IMD.balanceOf(address(this)) - held;
        if (received == 0) revert ZeroAmount();

        uint256 balance = meterBalance[feedId];
        uint256 total = totalShares[feedId];
        if (total != 0 && balance == 0) {
            // Spent to exactly zero: the old shares are claims on nothing and are retired.
            meterEpoch[feedId] += 1;
            total = 0;
        }
        shares = total == 0 ? received : Math.mulDiv(received, total, balance);
        if (shares == 0) revert ZeroShares();

        _shares[feedId][meterEpoch[feedId]][beneficiary] += shares;
        totalShares[feedId] = total + shares;
        meterBalance[feedId] = balance + received;
        emit Funded(feedId, beneficiary, received, shares);
    }
}
