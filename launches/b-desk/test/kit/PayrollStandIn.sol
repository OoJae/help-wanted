// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPayroll} from "../../src/interfaces/IPayroll.sol";

/// @notice A stand-in for Payroll, for the tests that run on a local chain. The real Payroll is
/// the contract HELP WANTED's first launch created on Ethereum mainnet
/// (`0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F`, `Mainnet.PAYROLL`); its source is that launch's
/// repository, not this one, so it cannot be compiled here. The fork suite runs the desk against
/// the live contract.
///
/// @dev In `Normal` mode it does what the launched Payroll does with the two calls the desk makes
/// (its `src/payroll/Payroll.sol`, as deployed):
///
/// - `pay(amount, memo)` pulls `amount` from the caller and books it as revenue; a zero amount
///   moves nothing.
/// - `tip(agentIds, amount)` pulls `amount` and shares it equally between the first 16 ids (an id
///   listed twice is credited twice); what the equal split leaves over, and the whole tip when the
///   list is empty or the amount is too small to give each id one wei, joins the seat pool. The
///   ids are not checked.
/// - `book()` counts IMD that arrived by plain transfer, which is where the desk's fallback sends
///   what Payroll did not pull.
///
/// `test_fork_payroll_theStandInBooksWhatTheLiveContractBooks` (fork suite) sends the same tips to
/// this stand-in and to the live contract and compares what each credits.
///
/// It keeps none of the real contract's later life (the staker stream, seat and tip claims, the
/// feed budget): the desk never touches those, and the claim functions below are empty. For the
/// record, in the launched contract a claim pays the seat's owner, anyone may make it for an
/// owner that is an ordinary wallet, and an owner that is a contract must make it itself
/// (`ContractOwnerMustClaim`). The other modes break the stand-in in every way the desk must
/// survive.
contract PayrollStandIn is IPayroll {
    enum Mode {
        /// Pulls what it is asked to.
        Normal,
        /// `pay` reverts.
        RevertPay,
        /// `tip` reverts.
        RevertTip,
        /// Both revert.
        RevertBoth,
        /// Both return without pulling anything.
        PullNothing,
        /// Both pull half of what they were asked to.
        PullHalf,
        /// Both use every unit of gas they are given.
        BurnGas,
        /// `pay` tries to call back into the desk.
        Reenter,
        /// `pay` pulls the fee and the tip in one go; `tip` then finds nothing left to pull.
        PullAllInPay
    }

    error PayrollDown();

    /// @dev As in the real Payroll.
    uint256 public constant MAX_TIP_AGENTS = 16;

    IERC20 public immutable IMD;

    Mode public mode;
    uint256 public payCalls;
    uint256 public tipCalls;
    /// @dev IMD pulled through `pay`, and through `tip`.
    uint256 public paid;
    uint256 public tipped;
    /// @dev IMD counted by `book()`: what arrived by plain transfer.
    uint256 public booked;
    /// @dev The part of the tips that went to the seat pool.
    uint256 public tipsToSeats;
    bytes32 public lastMemo;
    uint256[] internal _lastAgentIds;
    mapping(uint256 agentId => uint256) internal _tipOwed;
    address public reenterTarget;
    bytes public reenterData;
    bool public reenterSucceeded;
    /// @dev The gas each call arrived with, when asked to keep it (`setMeter`).
    bool public meter;
    uint256 public payGas;
    uint256 public tipGas;

    constructor(address imd) {
        IMD = IERC20(imd);
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function setMeter(bool meter_) external {
        meter = meter_;
    }

    function lastAgentIds() external view returns (uint256[] memory) {
        return _lastAgentIds;
    }

    function pay(uint256 amount, bytes32 memo) external {
        uint256 arrivedWith = gasleft();
        if (meter) payGas = arrivedWith;
        Mode m = mode;
        if (m == Mode.RevertPay || m == Mode.RevertBoth) revert PayrollDown();
        if (m == Mode.BurnGas) _burn();
        ++payCalls;
        lastMemo = memo;
        if (m == Mode.Reenter) {
            (bool ok,) = reenterTarget.call(reenterData);
            reenterSucceeded = ok;
        }
        uint256 take = _take(m, amount);
        if (m == Mode.PullAllInPay) take = IMD.allowance(msg.sender, address(this));
        if (take != 0) IMD.transferFrom(msg.sender, address(this), take);
        paid += take;
    }

    function tip(uint256[] calldata agentIds, uint256 amount) external {
        uint256 arrivedWith = gasleft();
        if (meter) tipGas = arrivedWith;
        Mode m = mode;
        if (m == Mode.RevertTip || m == Mode.RevertBoth) revert PayrollDown();
        if (m == Mode.BurnGas) _burn();
        ++tipCalls;
        _lastAgentIds = agentIds;
        uint256 take = _take(m, amount);
        if (m == Mode.PullAllInPay) take = 0;
        if (take != 0) IMD.transferFrom(msg.sender, address(this), take);
        tipped += take;

        // The real split: equal shares for the first sixteen ids, the remainder to the seat pool.
        uint256 n = agentIds.length > MAX_TIP_AGENTS ? MAX_TIP_AGENTS : agentIds.length;
        uint256 perAgent = n == 0 ? 0 : take / n;
        for (uint256 i; i < n; ++i) {
            _tipOwed[agentIds[i]] += perAgent;
        }
        tipsToSeats += take - perAgent * n;
    }

    /// @dev What arrived by plain transfer since the last call: the balance above everything
    /// pulled or booked so far.
    function book() external returns (uint256 amount) {
        amount = IMD.balanceOf(address(this)) - paid - tipped - booked;
        booked += amount;
    }

    function tipOwed(uint256 agentId) external view returns (uint256) {
        return _tipOwed[agentId];
    }

    function _take(Mode m, uint256 amount) internal pure returns (uint256) {
        if (m == Mode.PullNothing) return 0;
        if (m == Mode.PullHalf) return amount / 2;
        return amount;
    }

    function _burn() internal pure {
        uint256 i;
        while (true) {
            unchecked {
                ++i;
            }
        }
    }

    function drip() external pure returns (uint256) {
        return 0;
    }

    function claimSeat(uint256) external pure returns (uint256) {
        return 0;
    }

    function claimSeats(uint256[] calldata) external pure returns (uint256) {
        return 0;
    }

    function claimTip(uint256) external pure returns (uint256) {
        return 0;
    }

    function seatClaimable(uint256) external pure returns (uint256) {
        return 0;
    }
}
