// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev A stand-in for Standing Questions (`Questions`, launch A), which lives in another project,
/// reduced to the one function Zap calls. `fundFor` follows the real contract line for line, as read
/// from `launches/a-payroll/src/questions/Questions.sol`: it reverts `ZeroAddress` for a zero
/// beneficiary, `UnknownFeed(feedId)` for a feed that does not exist and `ZeroAmount` for nothing;
/// it pulls the IMD from the caller and credits what arrived; the first funder gets one share per
/// wei and later ones shares at the meter's current worth, rounded down; a meter that rounds spent
/// to exactly zero retires its old shares first; and a credit of no shares reverts `ZeroShares`.
///
/// The two knobs make it do what the real contract cannot (credit nothing, pull only a part), to
/// show what Zap does then.
contract MockQuestions {
    IERC20 public immutable IMD;

    mapping(bytes32 => bool) public known;
    mapping(bytes32 => uint256) public meterBalance;
    mapping(bytes32 => uint256) public totalShares;
    mapping(bytes32 => uint256) public meterEpoch;
    mapping(bytes32 => mapping(uint256 => mapping(address => uint256))) private _shares;

    /// @dev When set, the IMD is pulled and no shares are credited.
    bool public creditNothing;
    /// @dev The part of `amount` that is pulled, in basis points. 10,000 unless a test says otherwise.
    uint256 public pullBps = 10_000;

    event Funded(bytes32 indexed feedId, address indexed funder, uint256 amount, uint256 shares);
    event FundedFor(
        bytes32 indexed feedId, address indexed payer, address indexed beneficiary, uint256 amount, uint256 shares
    );

    // The real contract's errors, with its names and arguments.
    error ZeroAddress();
    error ZeroAmount();
    error UnknownFeed(bytes32 feedId);
    error ZeroShares();

    constructor(address imd) {
        IMD = IERC20(imd);
    }

    function open(bytes32 feedId) external {
        known[feedId] = true;
    }

    /// @dev A round was bought: the meter is worth less and no share is burnt.
    function spend(bytes32 feedId, uint256 amount) external {
        meterBalance[feedId] -= amount;
        require(IMD.transfer(address(0xFEE5), amount), "transfer");
    }

    function setCreditNothing(bool on) external {
        creditNothing = on;
    }

    function setPullBps(uint256 bps) external {
        pullBps = bps;
    }

    function sharesOf(bytes32 feedId, address funder) external view returns (uint256) {
        return _shares[feedId][meterEpoch[feedId]][funder];
    }

    function meterOf(bytes32 feedId) external view returns (uint256 balance, uint256 totalShares_) {
        return (meterBalance[feedId], totalShares[feedId]);
    }

    function fundFor(bytes32 feedId, uint256 amount, address beneficiary) external returns (uint256 shares) {
        if (beneficiary == address(0)) revert ZeroAddress();
        if (!known[feedId]) revert UnknownFeed(feedId);
        if (amount == 0) revert ZeroAmount();

        uint256 held = IMD.balanceOf(address(this));
        require(IMD.transferFrom(msg.sender, address(this), amount * pullBps / 10_000), "transferFrom");
        uint256 received = IMD.balanceOf(address(this)) - held;
        if (received == 0) revert ZeroAmount();

        uint256 balance = meterBalance[feedId];
        uint256 total = totalShares[feedId];
        if (total != 0 && balance == 0) {
            // Spent to exactly zero: the old shares are claims on nothing and are retired.
            meterEpoch[feedId] += 1;
            total = 0;
        }
        if (creditNothing) {
            meterBalance[feedId] = balance + received;
            return 0;
        }
        shares = total == 0 ? received : Math.mulDiv(received, total, balance);
        if (shares == 0) revert ZeroShares();

        _shares[feedId][meterEpoch[feedId]][beneficiary] += shares;
        totalShares[feedId] = total + shares;
        meterBalance[feedId] = balance + received;
        emit Funded(feedId, beneficiary, received, shares);
        if (beneficiary != msg.sender) emit FundedFor(feedId, msg.sender, beneficiary, received, shares);
    }
}
