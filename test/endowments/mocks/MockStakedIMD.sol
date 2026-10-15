// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev A stand-in for sIMD (`StakedIMD`, verified on Sourcify at 0x9Efa…7247) that follows the real
/// contract's rules, read from its source:
///
/// - Solady ERC-4626 arithmetic with virtual shares and a decimals offset of 6:
///   shares = assets * (totalSupply + 1e6) / (totalAssets + 1), assets the other way round; `deposit` and
///   `redeem` round down, `mint` and `withdraw` round up; no fee.
/// - `totalAssets()` is the vault's IMD balance, so IMD sent to it by plain transfer is yield.
/// - The one-block hold: minting a positive number of shares stamps the receiver with the block number,
///   a positive transfer carries the sender's stamp to the receiver if it is newer, and `withdraw` and
///   `redeem` fail for a holder stamped in the current block. As in the real contract the `max*` views
///   return zero during the hold, so the failure surfaces as `WithdrawMoreThanMax` / `RedeemMoreThanMax`.
///
/// `MockStakedIMD.t.sol` checks the arithmetic against values read from the real contract.
///
/// On top of that it has switches the real contract does not have, for tests only: `lose` removes IMD
/// (a fall in the share price), `setFault` makes it misbehave in one chosen way.
contract MockStakedIMD is ERC20 {
    enum Fault {
        None,
        // `withdraw` and `redeem` send one wei less than they should.
        PaysShort,
        // `withdraw` burns one share more than `previewWithdraw` said.
        BurnsExtra,
        // `deposit` mints one share fewer than `previewDeposit` said.
        MintsFewer,
        // Balances move correctly but the returned numbers are wrong.
        ReportsWrong,
        // `previewDeposit` and `previewWithdraw` answer zero.
        PreviewsZero,
        // `withdraw` and `redeem` burn one share more than they say; everything they report is as previewed.
        BurnsQuietly
    }

    uint256 private constant VIRTUAL_SHARES = 1e6;

    IERC20 private immutable _asset;
    mapping(address => uint256) public lastDepositBlock;
    Fault public fault;
    /// @dev Extra gas `withdraw` and `redeem` burn, for tests about how much gas a caller must bring.
    uint256 public exitCost;

    error DepositMoreThanMax();
    error WithdrawMoreThanMax();
    error RedeemMoreThanMax();
    error SameBlockRedeem();

    event Deposit(address indexed by, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed by, address indexed to, address indexed owner, uint256 assets, uint256 shares);

    constructor(address asset_) ERC20("Staked IMD", "sIMD") {
        _asset = IERC20(asset_);
    }

    // -------------------------------------------------------------------------------- test switches

    /// @dev Mints shares without taking IMD, to put the vault in a chosen state (pair it with an IMD mint).
    function seed(address to, uint256 shares) external {
        _mint(to, shares);
    }

    /// @dev Removes IMD from the vault: every share is now worth less.
    function lose(uint256 assets) external {
        _asset.transfer(address(0xdead), assets);
    }

    function setFault(Fault fault_) external {
        fault = fault_;
    }

    function setExitCost(uint256 exitCost_) external {
        exitCost = exitCost_;
    }

    // -------------------------------------------------------------------------------- ERC-4626 views

    function asset() external view returns (address) {
        return address(_asset);
    }

    function decimals() public pure override returns (uint8) {
        return 24;
    }

    function totalAssets() public view returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, totalSupply() + VIRTUAL_SHARES, totalAssets() + 1);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, totalAssets() + 1, totalSupply() + VIRTUAL_SHARES);
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        if (fault == Fault.PreviewsZero) return 0;
        return convertToShares(assets);
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, totalAssets() + 1, totalSupply() + VIRTUAL_SHARES, Math.Rounding.Ceil);
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        if (fault == Fault.PreviewsZero) return 0;
        return Math.mulDiv(assets, totalSupply() + VIRTUAL_SHARES, totalAssets() + 1, Math.Rounding.Ceil);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return convertToAssets(shares);
    }

    function maxDeposit(address) public pure returns (uint256) {
        return type(uint256).max;
    }

    function maxMint(address) public pure returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address owner) public view returns (uint256) {
        if (block.number == lastDepositBlock[owner]) return 0;
        return convertToAssets(balanceOf(owner));
    }

    function maxRedeem(address owner) public view returns (uint256) {
        if (block.number == lastDepositBlock[owner]) return 0;
        return balanceOf(owner);
    }

    // -------------------------------------------------------------------------------- ERC-4626 moves

    function deposit(uint256 assets, address to) external returns (uint256 shares) {
        if (assets > maxDeposit(to)) revert DepositMoreThanMax();
        shares = convertToShares(assets);
        _asset.transferFrom(msg.sender, address(this), assets);
        _mint(to, fault == Fault.MintsFewer ? shares - 1 : shares);
        emit Deposit(msg.sender, to, assets, shares);
        if (fault == Fault.ReportsWrong) shares = shares - 1;
    }

    function mint(uint256 shares, address to) external returns (uint256 assets) {
        assets = previewMint(shares);
        _asset.transferFrom(msg.sender, address(this), assets);
        _mint(to, shares);
        emit Deposit(msg.sender, to, assets, shares);
    }

    function withdraw(uint256 assets, address to, address owner) external returns (uint256 shares) {
        if (assets > maxWithdraw(owner)) revert WithdrawMoreThanMax();
        shares = Math.mulDiv(assets, totalSupply() + VIRTUAL_SHARES, totalAssets() + 1, Math.Rounding.Ceil);
        if (fault == Fault.BurnsExtra) shares += 1;
        _leave(to, owner, assets, shares);
        if (fault == Fault.ReportsWrong) shares = shares + 1;
    }

    function redeem(uint256 shares, address to, address owner) external returns (uint256 assets) {
        if (shares > maxRedeem(owner)) revert RedeemMoreThanMax();
        assets = convertToAssets(shares);
        _leave(to, owner, assets, shares);
        if (fault == Fault.ReportsWrong) assets = assets == 0 ? 0 : assets - 1;
    }

    function _leave(address to, address owner, uint256 assets, uint256 shares) private {
        if (block.number == lastDepositBlock[owner]) revert SameBlockRedeem();
        uint256 burn = exitCost;
        if (burn != 0) {
            uint256 stop = gasleft() - burn;
            while (gasleft() > stop) {}
        }
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, fault == Fault.BurnsQuietly ? shares + 1 : shares);
        _asset.transfer(to, fault == Fault.PaysShort && assets != 0 ? assets - 1 : assets);
        emit Withdraw(msg.sender, to, owner, assets, shares);
    }

    /// @dev The hold stamp, exactly as `StakedIMD._beforeTokenTransfer` sets it.
    function _update(address from, address to, uint256 value) internal override {
        if (value != 0 && to != address(0)) {
            if (from == address(0)) {
                lastDepositBlock[to] = block.number;
            } else if (lastDepositBlock[from] > lastDepositBlock[to]) {
                lastDepositBlock[to] = lastDepositBlock[from];
            }
        }
        super._update(from, to, value);
    }
}
