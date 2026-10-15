// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ICrowdPots} from "../interfaces/ICrowdPots.sol";
import {IPoolManagerLike, IUnlockCallback, PoolKey, SwapParams} from "./v4/IPoolManagerLike.sol";

/// @title The one Standing Questions function Zap calls
/// @dev `Questions.fundFor` is `IQuestions.fund` with one difference: the meter shares belong to
/// `beneficiary`, not to the caller. The Questions contract has it; the frozen `IQuestions` file
/// does not list it, so it is declared here.
interface IMeterFunder {
    /// @notice Adds `amount` IMD, pulled from the caller, to a feed's meter and credits the meter
    /// shares to `beneficiary`.
    function fundFor(bytes32 feedId, uint256 amount, address beneficiary) external returns (uint256 shares);
}

/// @title Zap: pay with ETH
/// @notice HELP WANTED is priced in IMD. Zap lets somebody who holds only ETH take part in one
/// transaction: it swaps the ETH sent with the call for IMD on the Uniswap v4 ETH/IMD pool, with
/// the caller's own minimum, and then chips the IMD into a crowd pot in the caller's name, funds a
/// feed's meter in the caller's name, or hands the IMD to the caller.
///
/// There is no owner and no setter, and Zap keeps nothing of a caller's: when a call ends, every
/// wei of IMD it bought has gone to the pot, to the meter or to the caller, and every wei of ETH the
/// pool did not use is back with the caller.
///
/// @dev What a reader should know:
///
/// - The pool is fixed in code: native ETH against IMD, fee 10000 (1%), tick spacing 200, no hook
///   contract. `POOL_ID` is its Uniswap v4 id.
/// - Price protection is the caller's own, in two parts. `minImdOut` is the least IMD the swap
///   must produce: a caller who passes zero accepts any price, and a transaction can be reordered
///   around, so pages should quote and pass a real minimum. `deadline` is the last second at which
///   the call may still run: a transaction that waits longer than its sender meant it to reverts
///   instead of swapping at a price quoted long ago. A caller who wants no time limit passes
///   `type(uint256).max`.
/// - The whole of the ETH sent is swapped before the pot is asked what it still needs. If the pot
///   needs less than the swap produced, the surplus goes back to the caller in the same call, as
///   IMD, not as ETH. Pages should size the ETH from `ICrowdPots.remaining`.
/// - What the caller pays for belongs to the caller: a chip (and any refund of it) through
///   `chipInFor`, meter shares through `fundFor`. Zap is never a contributor or a funder itself.
/// - Zap does not open orders. The hire desk makes whoever calls `createOrder` the employer, and
///   the employer is who gets the refund, the change and the callback; that must be the person
///   who paid. `buy` hands them the IMD instead, and they open the order in their own name.
/// - Zap cannot be sent ETH, but ETH can still be forced into an address, and anyone can transfer
///   IMD to it. Whatever arrives that way is passed to the next caller that can take it.
contract Zap is IUnlockCallback, ReentrancyGuardTransient {
    // Each entry point reports what its swap produced and what the pot or the meter then took, and
    // those figures exist only after the calls that produce them. All three hold the same transient
    // lock, so no call into this contract can run in between and put the events out of order. The
    // lint cannot see the lock.
    // forge-lint: disable-start(reentrancy-events)

    using SafeERC20 for IERC20;

    /// @notice The pool's liquidity-provider fee, in hundredths of a basis point.
    uint24 public constant POOL_FEE = 10_000;
    /// @notice The pool's tick spacing.
    int24 public constant POOL_TICK_SPACING = 200;

    /// @dev One above Uniswap's lowest price: the swap may move the price as far as it must, and the
    /// caller's minimum decides whether the result is acceptable.
    uint160 private constant PRICE_LIMIT = 4295128739 + 1;

    /// @notice The IMD token the ETH is swapped for.
    IERC20 public immutable IMD;
    /// @notice The Uniswap v4 PoolManager the swap goes through.
    IPoolManagerLike public immutable POOL_MANAGER;
    /// @notice The crowd pots `chipIn` chips into.
    ICrowdPots public immutable CROWD_POTS;
    /// @notice The Standing Questions contract whose meters `fundMeter` funds.
    IMeterFunder public immutable QUESTIONS;
    /// @notice The Uniswap v4 id of the ETH/IMD pool: `keccak256(abi.encode(poolKey()))`.
    bytes32 public immutable POOL_ID;

    /// @notice `caller` spent `ethSpent` wei, which bought `imdOut` IMD; `chipped` of it went into pot
    /// `potId` in the caller's name and the rest was sent to the caller.
    event ChippedIn(address indexed caller, uint256 indexed potId, uint256 ethSpent, uint256 imdOut, uint256 chipped);
    /// @notice `caller` spent `ethSpent` wei, which bought `imdOut` IMD for the meter of feed
    /// `feedId`; `caller` was credited `shares` meter shares, and any IMD the meter did not take was
    /// sent to the caller.
    event MeterFunded(address indexed caller, bytes32 indexed feedId, uint256 ethSpent, uint256 imdOut, uint256 shares);
    /// @notice `caller` spent `ethSpent` wei and was sent `imdOut` IMD.
    event Bought(address indexed caller, uint256 ethSpent, uint256 imdOut);

    /// @notice A constructor argument is the zero address.
    error ZeroAddress();
    /// @notice The call carried no ETH to swap.
    error NoEth();
    /// @notice The call ran after the last second the caller allowed for it.
    error DeadlinePassed(uint256 deadline);
    /// @notice The swap produced nothing, or less than the caller's minimum.
    error TooLittleOut(uint256 imdOut, uint256 minImdOut);
    /// @notice The pot took nothing: it is full, closed or unknown.
    error NothingChipped();
    /// @notice The meter credited no shares for the IMD.
    error NothingFunded();
    /// @notice Only the PoolManager may call the swap callback.
    error NotPoolManager();
    /// @notice The manager reported a swap result of the wrong sign, used more ETH than it was
    /// offered, or did not count the ETH it was paid.
    error UnexpectedDelta();
    /// @notice The caller could not receive its unspent ETH.
    error EthRefundFailed();

    /// @param imd The IMD token.
    /// @param poolManager The Uniswap v4 PoolManager.
    /// @param crowdPots The crowd pots contract.
    /// @param questions The Standing Questions contract.
    /// @dev Makes no external call. The pool id is computed from the arguments.
    constructor(address imd, address poolManager, address crowdPots, address questions) {
        if (imd == address(0) || poolManager == address(0) || crowdPots == address(0) || questions == address(0)) {
            revert ZeroAddress();
        }
        IMD = IERC20(imd);
        POOL_MANAGER = IPoolManagerLike(poolManager);
        CROWD_POTS = ICrowdPots(crowdPots);
        QUESTIONS = IMeterFunder(questions);
        POOL_ID = keccak256(abi.encode(_poolKey(imd)));
    }

    /// @notice The pool Zap swaps on.
    function poolKey() external view returns (PoolKey memory) {
        return _poolKey(address(IMD));
    }

    /// @notice Swaps the ETH sent with the call for IMD and chips it into pot `potId`. The chip, and
    /// any refund of it, belongs to the caller. Anyone may call.
    /// @dev A pot takes only what it still needs; the surplus IMD is sent to the caller, as is any
    /// ETH the pool could not use. Reverts when the deadline has passed, when no ETH is sent, when
    /// the swap yields less than `minImdOut`, when the pot takes nothing, or when the caller cannot
    /// receive an ETH refund it is owed.
    /// @param potId The pot to chip into. A series id chips into the series' current round.
    /// @param minImdOut The least IMD the swap must produce.
    /// @param deadline The last block timestamp at which the call may run.
    /// @return imdOut The IMD the swap produced.
    /// @return chipped The part of it the pot took. The caller was sent `imdOut - chipped`.
    function chipIn(uint256 potId, uint256 minImdOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 imdOut, uint256 chipped)
    {
        uint256 ethSpent;
        (ethSpent, imdOut) = _swap(minImdOut, deadline);

        IMD.forceApprove(address(CROWD_POTS), imdOut);
        chipped = CROWD_POTS.chipInFor(potId, imdOut, msg.sender);
        if (chipped == 0) revert NothingChipped();
        // A pot that needed less leaves part of the approval unused; no allowance outlives the call.
        IMD.forceApprove(address(CROWD_POTS), 0);

        emit ChippedIn(msg.sender, potId, ethSpent, imdOut, chipped);
        _returnEverything(ethSpent);
    }

    /// @notice Swaps the ETH sent with the call for IMD and adds it to the meter of feed `feedId`.
    /// The meter shares, and so the right to take the unspent part back, belong to the caller.
    /// Anyone may call.
    /// @dev Reverts when the deadline has passed, when no ETH is sent, when the swap yields less
    /// than `minImdOut`, when the Questions contract refuses the funding (an unknown feed, for
    /// example) or credits no shares, or when the caller cannot receive an ETH refund it is owed.
    /// Any IMD the meter did not take is sent to the caller, as is any ETH the pool could not use.
    /// @param feedId The feed whose meter to fund.
    /// @param minImdOut The least IMD the swap must produce.
    /// @param deadline The last block timestamp at which the call may run.
    /// @return imdOut The IMD the swap produced.
    /// @return shares The meter shares credited to the caller.
    function fundMeter(bytes32 feedId, uint256 minImdOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 imdOut, uint256 shares)
    {
        uint256 ethSpent;
        (ethSpent, imdOut) = _swap(minImdOut, deadline);

        IMD.forceApprove(address(QUESTIONS), imdOut);
        shares = QUESTIONS.fundFor(feedId, imdOut, msg.sender);
        if (shares == 0) revert NothingFunded();
        // No allowance outlives the call, whatever the meter pulled.
        IMD.forceApprove(address(QUESTIONS), 0);

        emit MeterFunded(msg.sender, feedId, ethSpent, imdOut, shares);
        _returnEverything(ethSpent);
    }

    /// @notice Swaps the ETH sent with the call for IMD and sends the IMD to the caller. Anyone
    /// may call.
    /// @dev The step before opening an order on the hire desk in the caller's own name. Reverts
    /// when the deadline has passed, when no ETH is sent, when the swap yields less than
    /// `minImdOut`, or when the caller cannot receive an ETH refund it is owed.
    /// @param minImdOut The least IMD the swap must produce.
    /// @param deadline The last block timestamp at which the call may run.
    /// @return imdOut The IMD the swap produced.
    function buy(uint256 minImdOut, uint256 deadline) external payable nonReentrant returns (uint256 imdOut) {
        uint256 ethSpent;
        (ethSpent, imdOut) = _swap(minImdOut, deadline);
        emit Bought(msg.sender, ethSpent, imdOut);
        _returnEverything(ethSpent);
    }

    /// @notice The PoolManager's callback during a swap. Only the PoolManager may call, and it calls
    /// only the contract that asked it to unlock, so this runs only inside `chipIn`, `fundMeter`
    /// and `buy`.
    /// @dev Swaps exactly the ETH named in `data` (or as much of it as the pool can use), pays the
    /// ETH owed and collects the IMD. Returns `abi.encode(ethSpent, imdOut)`.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        uint256 ethIn = abi.decode(data, (uint256));

        int256 delta = POOL_MANAGER.swap(
            _poolKey(address(IMD)),
            // casting to 'int256' is safe because `ethIn` is the ETH sent with one call, far below 2^255
            // forge-lint: disable-next-line(unsafe-typecast)
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: PRICE_LIMIT}),
            ""
        );
        // Upper half: ETH, which Zap owes (zero or negative). Lower half: IMD, owed to Zap.
        // casting to 'int128' is safe because each half of the packed word is a 128-bit amount
        // forge-lint: disable-next-line(unsafe-typecast)
        int128 eth = int128(delta >> 128);
        // forge-lint: disable-next-line(unsafe-typecast)
        int128 imd = int128(delta);
        if (eth > 0 || imd < 0) revert UnexpectedDelta();
        // casting to 'uint256' is safe because the signs were checked on the line above
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 ethSpent = uint256(-int256(eth));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 imdOut = uint256(int256(imd));
        // The swap was told the exact amount to sell. Paying more than the caller sent would have
        // to come out of ETH that is not the caller's.
        if (ethSpent > ethIn) revert UnexpectedDelta();

        if (ethSpent != 0 && POOL_MANAGER.settle{value: ethSpent}() != ethSpent) revert UnexpectedDelta();
        if (imdOut != 0) POOL_MANAGER.take(address(IMD), address(this), imdOut);
        return abi.encode(ethSpent, imdOut);
    }

    /// @dev Swaps all of `msg.value` and checks the result against the caller's minimum, after
    /// making sure the call is not running later than the caller allowed. `ethSpent` is never more
    /// than `msg.value`.
    function _swap(uint256 minImdOut, uint256 deadline) private returns (uint256 ethSpent, uint256 imdOut) {
        // A time limit in seconds chosen by the caller; a block's timestamp is exact enough for it.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert DeadlinePassed(deadline);
        if (msg.value == 0) revert NoEth();
        (ethSpent, imdOut) = abi.decode(POOL_MANAGER.unlock(abi.encode(msg.value)), (uint256, uint256));
        if (imdOut == 0 || imdOut < minImdOut) revert TooLittleOut(imdOut, minImdOut);
    }

    /// @dev Ends a call by sending the caller every wei of IMD and ETH this contract holds. Whole
    /// balances, not computed remainders: anything that reached this contract by other means goes
    /// out with the next call instead of collecting here. ETH goes last, when no state is left to
    /// change.
    ///
    /// Only the caller's own unspent ETH has to arrive. A caller that takes no ETH (a contract with
    /// no `receive`) and is owed none must not be stopped by ETH somebody else forced in: that ETH
    /// then waits for the next caller.
    ///
    /// Slither reads the ETH transfer below as one to an address of the caller's choosing. The
    /// address is the caller itself, and the ETH is what the caller sent and the pool did not use,
    /// plus whatever was forced in from outside: this contract holds nobody's ETH between calls.
    // slither-disable-next-line arbitrary-send-eth
    function _returnEverything(uint256 ethSpent) private {
        uint256 imdLeft = IMD.balanceOf(address(this));
        if (imdLeft != 0) IMD.safeTransfer(msg.sender, imdLeft);
        uint256 ethLeft = address(this).balance;
        if (ethLeft != 0) {
            (bool ok,) = msg.sender.call{value: ethLeft}("");
            if (!ok && ethSpent != msg.value) revert EthRefundFailed();
        }
    }

    function _poolKey(address imd) private pure returns (PoolKey memory) {
        // Native ETH is the zero address, which sorts below every token: ETH is always currency0.
        return PoolKey({
            currency0: address(0), currency1: imd, fee: POOL_FEE, tickSpacing: POOL_TICK_SPACING, hooks: address(0)
        });
    }

    // forge-lint: disable-end(reentrancy-events)
}
