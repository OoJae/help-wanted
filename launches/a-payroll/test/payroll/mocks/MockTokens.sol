// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @dev The two views of a funder that the token reads when a test asks it to look in the middle of
/// a meter top-up: what Payroll says it owes in all, and its `book`.
interface IFunderBooks {
    function owed() external view returns (uint256, uint256, uint256, uint256, uint256 total);

    function book() external returns (uint256);
}

/// @dev A plain 18-decimal ERC-20 that anyone can mint, standing in for IMD.
///
/// It can also be told to disturb one kind of transfer: a pull out of one watched account (Payroll,
/// while the real Questions pulls a meter top-up from it). IMD does none of this. The switches are how
/// the tests reach, with the real Questions in the middle, the three things Payroll must survive
/// during a top-up: less leaving than it offered, a call back into it, and somebody reading its books
/// half way through.
contract MockIMD is ERC20 {
    /// @dev The account whose outgoing pulls are disturbed. Zero: none.
    address public watched;
    /// @dev How much of a pull out of `watched` really moves, in basis points.
    uint256 public takeBps = 10_000;
    /// @dev During a pull out of `watched`, call its `book()` and record whether that was refused.
    bool public reenter;
    bool public reentryBlocked;
    /// @dev During a pull out of `watched`, compare what it says it owes with what it holds, before
    /// and after the tokens move.
    bool public probe;
    uint256 public probes;
    bool public sawFunderUncovered;

    constructor() ERC20("IdentityMD", "IMD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function watch(address account) external {
        watched = account;
    }

    function setTakeBps(uint256 bps) external {
        takeBps = bps;
    }

    function setReenter(bool on) external {
        reenter = on;
    }

    function setProbe(bool on) external {
        probe = on;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (from != watched) return super.transferFrom(from, to, value);

        if (reenter) {
            // Every money-moving entry point of the funder must refuse a nested call.
            try IFunderBooks(from).book() {}
            catch {
                reentryBlocked = true;
            }
        }
        if (probe) _look(from);
        uint256 moved = (value * takeBps) / 10_000;
        _spendAllowance(from, msg.sender, moved);
        _transfer(from, to, moved);
        if (probe) _look(from);
        return true;
    }

    function _look(address funder) private {
        (,,,, uint256 total) = IFunderBooks(funder).owed();
        ++probes;
        if (total > balanceOf(funder)) sawFunderUncovered = true;
    }
}

/// @dev An ERC-4626 over IMD modelled on the mainnet sIMD in the three ways Payroll's design leans on.
/// Its `totalAssets` is its IMD balance, so a plain transfer to it raises the price of every share.
/// Its shares have 24 decimals. And a holder cannot leave in the block it staked in: a deposit or a
/// mint stamps the receiver with the block number, the stamp travels with the shares when they are
/// transferred, and while a holder's stamp is the current block `maxWithdraw` and `maxRedeem` are
/// zero and `withdraw` and `redeem` revert, with the errors the real vault uses.
/// `test/payroll/fork/PayrollFork.t.sol` checks each of these against the real contract.
contract MockSIMD is ERC4626 {
    error RedeemMoreThanMax();
    error WithdrawMoreThanMax();

    /// @dev The block of each holder's last deposit or mint, or of the newest one among the shares
    /// it was sent.
    mapping(address holder => uint256) public lastDepositBlock;

    constructor(IERC20 imd) ERC20("Staked IMD", "sIMD") ERC4626(imd) {}

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return lastDepositBlock[owner] == block.number ? 0 : super.maxWithdraw(owner);
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return lastDepositBlock[owner] == block.number ? 0 : super.maxRedeem(owner);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256) {
        if (assets > maxWithdraw(owner)) revert WithdrawMoreThanMax();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override returns (uint256) {
        if (shares > maxRedeem(owner)) revert RedeemMoreThanMax();
        return super.redeem(shares, receiver, owner);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == address(0)) {
            lastDepositBlock[to] = block.number;
        } else if (to != address(0) && lastDepositBlock[from] > lastDepositBlock[to]) {
            lastDepositBlock[to] = lastDepositBlock[from];
        }
    }
}

/// @dev The same vault without the hold: a holder may stake and leave in one transaction. The real
/// sIMD does not allow that. This exists to show what would follow if it did (docs/THREATS.md, P2).
contract HoldlessSIMD is ERC4626 {
    constructor(IERC20 imd) ERC20("Staked IMD, no hold", "sIMD0") ERC4626(imd) {}

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}

/// @dev An ERC-20 that delivers less than it was asked to move, to check that Payroll books what
/// arrives and not what was requested.
contract ShortfallToken is ERC20 {
    uint256 public immutable KEEP_BPS;

    constructor(uint256 keepBps) ERC20("Shortfall", "SHORT") {
        KEEP_BPS = keepBps;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 kept = (value * KEEP_BPS) / 10_000;
        super._update(from, to, value - kept);
        if (kept != 0) super._update(from, address(0xdead), kept);
    }
}

/// @dev An ERC-20 that lets one chosen spender move tokens without an allowance. IMD does no such
/// thing; this exists only to reach Payroll's last-resort check that a meter top-up took no more than
/// it was offered.
contract LooseToken is ERC20 {
    address public immutable PRIVILEGED;

    constructor(address privileged) ERC20("Loose", "LOOSE") {
        PRIVILEGED = privileged;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal override {
        if (spender != PRIVILEGED) super._spendAllowance(owner, spender, value);
    }
}

/// @dev Answers like a Questions contract whose three meters are empty, and takes one wei more than
/// `fund` was told. Only works with `LooseToken`, which lets it.
contract GreedyQuestions {
    IERC20 public token;

    function setToken(IERC20 token_) external {
        token = token_;
    }

    function costOf(bytes32) external pure returns (uint256) {
        return 1e18;
    }

    function meterOf(bytes32) external pure returns (uint256, uint256) {
        return (0, 0);
    }

    /// @dev Payroll holds nothing on any meter here, so each lacks its whole runway.
    function redeemable(bytes32, address) external pure returns (uint256) {
        return 0;
    }

    function fund(bytes32, uint256 amount) external returns (uint256) {
        token.transferFrom(msg.sender, address(this), amount + 1);
        return amount;
    }
}
