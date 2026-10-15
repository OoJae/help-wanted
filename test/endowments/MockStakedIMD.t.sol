// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {MockIMD} from "./mocks/MockIMD.sol";
import {MockStakedIMD} from "./mocks/MockStakedIMD.sol";

/// @dev The offline tests run against a mock of sIMD, so the mock has to be right. These tests put it in
/// the exact state the real sIMD was in at one mainnet block and compare every conversion with what the
/// real contract answered at that block, then check the hold rules against the verified source.
contract MockStakedIMDTest is Test {
    MockIMD internal imd;
    MockStakedIMD internal simd;
    string internal json;

    address internal whale = makeAddr("whale");
    address internal ann = makeAddr("ann");
    address internal ben = makeAddr("ben");

    function setUp() public {
        vm.roll(26_164_296);
        json = vm.readFile("test/fixtures/endowments/simd-block-26164296.json");
        imd = new MockIMD();
        simd = new MockStakedIMD(address(imd));
        simd.seed(whale, vm.parseJsonUint(json, ".totalSupply"));
        imd.mint(address(simd), vm.parseJsonUint(json, ".totalAssets"));

        imd.mint(ann, 1_000e18);
        vm.prank(ann);
        imd.approve(address(simd), type(uint256).max);
    }

    function test_fixture_totalAssetsIsTheVaultsImdBalance() public view {
        assertEq(vm.parseJsonUint(json, ".totalAssets"), vm.parseJsonUint(json, ".imdBalanceOfSimd"));
        assertEq(simd.totalAssets(), imd.balanceOf(address(simd)));
        assertEq(simd.decimals(), vm.parseJsonUint(json, ".decimals"));
    }

    function test_fixture_depositAndWithdrawPreviewsMatchTheRealVault() public view {
        uint256[] memory assetsIn = vm.parseJsonUintArray(json, ".assetsIn");
        uint256[] memory previewDeposit = vm.parseJsonUintArray(json, ".previewDeposit");
        uint256[] memory previewWithdraw = vm.parseJsonUintArray(json, ".previewWithdraw");
        assertEq(assetsIn.length, 8);
        for (uint256 i = 0; i < assetsIn.length; ++i) {
            assertEq(simd.previewDeposit(assetsIn[i]), previewDeposit[i], "previewDeposit");
            assertEq(simd.convertToShares(assetsIn[i]), previewDeposit[i], "convertToShares");
            assertEq(simd.previewWithdraw(assetsIn[i]), previewWithdraw[i], "previewWithdraw");
        }
    }

    function test_fixture_mintAndRedeemPreviewsMatchTheRealVault() public view {
        uint256[] memory mintIn = vm.parseJsonUintArray(json, ".mintSharesIn");
        uint256[] memory previewMint = vm.parseJsonUintArray(json, ".previewMint");
        for (uint256 i = 0; i < mintIn.length; ++i) {
            assertEq(simd.previewMint(mintIn[i]), previewMint[i], "previewMint");
        }
        uint256[] memory redeemIn = vm.parseJsonUintArray(json, ".redeemSharesIn");
        uint256[] memory previewRedeem = vm.parseJsonUintArray(json, ".previewRedeem");
        for (uint256 i = 0; i < redeemIn.length; ++i) {
            assertEq(simd.previewRedeem(redeemIn[i]), previewRedeem[i], "previewRedeem");
        }
        uint256[] memory convertIn = vm.parseJsonUintArray(json, ".convertSharesIn");
        uint256[] memory convertToAssets = vm.parseJsonUintArray(json, ".convertToAssets");
        for (uint256 i = 0; i < convertIn.length; ++i) {
            assertEq(simd.convertToAssets(convertIn[i]), convertToAssets[i], "convertToAssets");
        }
    }

    function test_depositMintsWhatThePreviewSaid_andWithdrawBurnsWhatThePreviewSaid() public {
        uint256 expectedShares = simd.previewDeposit(100e18);
        vm.prank(ann);
        assertEq(simd.deposit(100e18, ann), expectedShares);
        assertEq(simd.balanceOf(ann), expectedShares);

        vm.roll(vm.getBlockNumber() + 1);
        uint256 expectedBurn = simd.previewWithdraw(40e18);
        vm.prank(ann);
        assertEq(simd.withdraw(40e18, ann, ann), expectedBurn);
        assertEq(simd.balanceOf(ann), expectedShares - expectedBurn);
    }

    function test_hold_aMintBlocksThatHoldersExitInTheSameBlockOnly() public {
        vm.startPrank(ann);
        uint256 shares = simd.deposit(100e18, ann);
        assertEq(simd.lastDepositBlock(ann), vm.getBlockNumber());
        assertEq(simd.maxWithdraw(ann), 0);
        assertEq(simd.maxRedeem(ann), 0);
        vm.expectRevert(MockStakedIMD.WithdrawMoreThanMax.selector);
        simd.withdraw(1e18, ann, ann);
        vm.expectRevert(MockStakedIMD.RedeemMoreThanMax.selector);
        simd.redeem(shares, ann, ann);

        vm.roll(vm.getBlockNumber() + 1);
        assertEq(simd.maxRedeem(ann), shares);
        simd.redeem(shares, ann, ann);
        vm.stopPrank();
    }

    function test_hold_travelsWithATransfer_butNeverBackwards() public {
        vm.prank(ann);
        simd.deposit(100e18, ann);
        vm.roll(vm.getBlockNumber() + 5);

        // An old stamp does not make the receiver's newer one older.
        imd.mint(ben, 10e18);
        vm.startPrank(ben);
        imd.approve(address(simd), type(uint256).max);
        simd.deposit(10e18, ben);
        vm.stopPrank();
        vm.prank(ann);
        simd.transfer(ben, 1);
        assertEq(simd.lastDepositBlock(ben), vm.getBlockNumber());

        // A new stamp is carried to a receiver with an older one.
        vm.prank(ben);
        simd.transfer(ann, 1);
        assertEq(simd.lastDepositBlock(ann), vm.getBlockNumber());
        assertEq(simd.maxWithdraw(ann), 0);
    }

    function test_hold_zeroAmountsStampNothing() public {
        uint256 before = simd.lastDepositBlock(ben);
        vm.startPrank(ann);
        simd.deposit(0, ben);
        simd.deposit(1e18, ann);
        simd.transfer(ben, 0);
        vm.stopPrank();
        assertEq(simd.lastDepositBlock(ben), before);
    }

    function test_plainTransferIsYield_andLoseIsALoss() public {
        uint256 before = simd.convertToAssets(1e24);
        imd.mint(address(simd), simd.totalAssets() / 100);
        uint256 afterYield = simd.convertToAssets(1e24);
        assertGt(afterYield, before);
        simd.lose(simd.totalAssets() / 2);
        assertLt(simd.convertToAssets(1e24), before);
    }

    /// @dev Every move rounds for the vault, so the share price never falls by rounding.
    function testFuzz_priceNeverFallsFromDepositsAndExits(uint256 a, uint256 b) public {
        a = bound(a, 2, 500e18);
        uint256 price = simd.convertToAssets(1e30);
        vm.startPrank(ann);
        simd.deposit(a, ann);
        assertGe(simd.convertToAssets(1e30), price);
        vm.roll(vm.getBlockNumber() + 1);
        // What was just deposited converts back to at most one wei less.
        assertGe(simd.maxWithdraw(ann) + 1, a);
        b = bound(b, 1, simd.maxWithdraw(ann));
        simd.withdraw(b, ann, ann);
        assertGe(simd.convertToAssets(1e30), price);
        simd.redeem(simd.balanceOf(ann), ann, ann);
        assertGe(simd.convertToAssets(1e30), price);
        vm.stopPrank();
    }
}
