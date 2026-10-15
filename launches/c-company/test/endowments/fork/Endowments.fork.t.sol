// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {Endowments} from "../../../src/endowments/Endowments.sol";
import {Mainnet} from "../../../src/interfaces/external/Mainnet.sol";
import {MockCrowdPots} from "../mocks/MockCrowdPots.sol";
import {MockIMD} from "../mocks/MockIMD.sol";
import {MockQuestions} from "../mocks/MockQuestions.sol";
import {MockStakedIMD} from "../mocks/MockStakedIMD.sol";

/// @dev The parts of the real sIMD that are not in ERC-4626.
interface IStakedIMD {
    function owner() external view returns (address);
    function paused() external view returns (bool);
    function lastDepositBlock(address holder) external view returns (uint256);
}

/// @dev The one Permit2 function that moves tokens on an allowance.
interface IPermit2 {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @dev Endowments against the real IMD and the real sIMD on a fork of mainnet at the latest block.
/// Questions and CrowdPots are stand-ins here, so that a test can make a pot or a meter misbehave
/// and read a meter nobody else funds; the meter and pot endowments against the live Questions and
/// CrowdPots of launches A and B are in `test/launch/fork/LiveSiblings.fork.t.sol`.
///
/// Run with `FOUNDRY_PROFILE=fork forge test`. Every test skips itself if the RPC cannot be
/// reached. Nothing asserts a number that drifts: only relationships. Balances are compared with what
/// an address held when the test began, because an address a test deploys to can already hold dust on
/// mainnet.
contract EndowmentsForkTest is Test {
    bytes32 internal constant FEED = keccak256("robot-jobs-report");
    uint256 internal constant POT = 1;
    uint256 internal constant PRINCIPAL = 1_000e18;
    /// @dev `WithdrawMoreThanMax()` and `RedeemMoreThanMax()`: what the real sIMD answers while it
    /// holds an account.
    bytes4 internal constant WITHDRAW_MORE_THAN_MAX = 0x936941fc;
    bytes4 internal constant REDEEM_MORE_THAN_MAX = 0x4656425a;

    IERC20 internal imd = IERC20(Mainnet.IMD);
    IERC4626 internal simd = IERC4626(Mainnet.SIMD);

    Endowments internal endow;
    MockQuestions internal questions;
    MockCrowdPots internal pots;
    bool internal forked;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    address internal donor = makeAddr("donor");
    address internal stranger = makeAddr("stranger");
    address internal recipient = makeAddr("recipient");
    address internal heir = makeAddr("heir");

    uint256 internal meterId;
    uint256 internal recipientId;
    uint256 internal potId;

    /// @dev What the freshly deployed contract's address already held, before anything was done with it.
    uint256 internal imdDust;
    uint256 internal shareDust;

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("mainnet")) returns (uint256) {
            forked = true;
        } catch {
            return;
        }

        questions = new MockQuestions(Mainnet.IMD);
        questions.addFeed(FEED);
        pots = new MockCrowdPots(Mainnet.IMD);
        pots.open(POT, 1_000_000e18);
        endow = new Endowments(Mainnet.IMD, Mainnet.SIMD, address(questions), address(pots));
        imdDust = imd.balanceOf(address(endow));
        shareDust = simd.balanceOf(address(endow));

        deal(Mainnet.IMD, alice, 10 * PRINCIPAL);
        deal(Mainnet.IMD, bob, 10 * PRINCIPAL);
        vm.prank(alice);
        imd.approve(address(endow), type(uint256).max);
        vm.startPrank(bob);
        imd.approve(address(endow), type(uint256).max);
        meterId = endow.createForMeter(FEED);
        recipientId = endow.createForRecipient(recipient);
        potId = endow.createForPot(POT, heir);
        vm.stopPrank();
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _roll(uint256 blocks) internal {
        vm.roll(vm.getBlockNumber() + blocks);
    }

    function _covered(uint256 id) internal view {
        (,,, uint256 principal, uint256 buffered, uint256 shares,) = endow.endowment(id);
        assertGe(simd.convertToAssets(shares) + buffered, principal, "holdings below principal");
        assertTrue(endow.isWhole(id), "not whole");
    }

    /// @dev Yield the way sIMD really gets it: a plain IMD transfer to the vault.
    function _yieldBps(uint256 bps) internal {
        uint256 amount = simd.totalAssets() * bps / 10_000;
        deal(Mainnet.IMD, donor, amount);
        vm.prank(donor);
        imd.transfer(Mainnet.SIMD, amount);
    }

    /// @dev IMD this contract holds beyond what its address held before the test.
    function _imdHeld() internal view returns (uint256) {
        return imd.balanceOf(address(endow)) - imdDust;
    }

    /// @dev The least gas, to the nearest 500, with which `harvest(id)` goes through.
    function _leastGasFor(uint256 id) internal returns (uint256 hi) {
        uint256 lo = 100_000;
        hi = 2_000_000;
        while (hi - lo > 500) {
            uint256 mid = (lo + hi) / 2;
            uint256 snapshot = vm.snapshotState();
            vm.prank(keeper);
            (bool ok,) = address(endow).call{gas: mid}(abi.encodeCall(Endowments.harvest, (id)));
            vm.revertToState(snapshot);
            if (ok) hi = mid;
            else lo = mid;
        }
    }

    // --------------------------------------------------------------------------------------------

    /// @dev What Endowments was designed around, read from the live contract.
    function test_fork_simdIsWhatTheDesignAssumes() public onFork {
        assertEq(simd.asset(), Mainnet.IMD);
        assertEq(simd.decimals(), 24);
        assertEq(endow.PRICE_UNIT(), 10 ** simd.decimals());
        // Nobody can pause it or sweep it: both need an owner and there is none.
        assertEq(IStakedIMD(Mainnet.SIMD).owner(), address(0));
        assertFalse(IStakedIMD(Mainnet.SIMD).paused());
        // IMD sent to it by plain transfer is everyone's yield.
        assertEq(simd.totalAssets(), imd.balanceOf(Mainnet.SIMD));
        assertEq(simd.maxDeposit(address(endow)), type(uint256).max);

        uint256[4] memory amounts = [uint256(1), 1e12, 1e18, 123_456_789_012_345_678_901];
        for (uint256 i = 0; i < amounts.length; ++i) {
            uint256 x = amounts[i];
            uint256 minted = simd.previewDeposit(x);
            uint256 burned = simd.previewWithdraw(x);
            // No fee either way: taking IMD out costs at most one share-wei more than putting it in gave.
            assertGe(burned, minted);
            assertLe(burned, minted + 1);
            // Rounding is against the caller in both directions, and by less than one IMD-wei.
            assertLe(simd.previewRedeem(minted), x);
            assertGe(simd.previewRedeem(minted) + 1, x);
            assertGe(simd.previewRedeem(burned), x);
            assertGe(simd.previewMint(minted), simd.previewRedeem(minted));
        }
        // One IMD-wei buys at least one share-wei, which is what sizing the margin and the spare in
        // share-wei relies on; the seed alone then puts a new endowment well above `SPARE`.
        assertGe(simd.previewDeposit(1), 1);
        assertGe(simd.previewDeposit(endow.SEED()), 2 * endow.SPARE());
    }

    /// @dev The offline tests use `MockStakedIMD`. Put it in the live vault's state and it must give
    /// the live vault's answers.
    function test_fork_theMockAnswersLikeTheRealVault() public onFork {
        MockIMD mockImd = new MockIMD();
        MockStakedIMD mock = new MockStakedIMD(address(mockImd));
        mock.seed(address(0xBEEF), simd.totalSupply());
        mockImd.mint(address(mock), simd.totalAssets());

        uint256[6] memory amounts = [uint256(1), 999, 1e12, 1e18, 85_000e18, 123_456_789_012_345_678_901_234];
        for (uint256 i = 0; i < amounts.length; ++i) {
            uint256 x = amounts[i];
            assertEq(mock.previewDeposit(x), simd.previewDeposit(x), "previewDeposit");
            assertEq(mock.previewWithdraw(x), simd.previewWithdraw(x), "previewWithdraw");
            assertEq(mock.convertToShares(x), simd.convertToShares(x), "convertToShares");
            uint256 s = x * 1e5;
            assertEq(mock.previewMint(s), simd.previewMint(s), "previewMint");
            assertEq(mock.previewRedeem(s), simd.previewRedeem(s), "previewRedeem");
            assertEq(mock.convertToAssets(s), simd.convertToAssets(s), "convertToAssets");
        }
    }

    /// @dev Deposit, stake, the same-block hold, and the exact principal back with no yield at all.
    function test_fork_depositStakeHold_thenExactPrincipal_withNoYield() public onFork {
        uint256 before = imd.balanceOf(alice);
        vm.prank(alice);
        endow.deposit(recipientId, PRINCIPAL);
        assertEq(imd.balanceOf(alice), before - PRINCIPAL);

        uint256 buffer = endow.pendingTotal();
        assertEq(_imdHeld(), buffer);
        uint256 expectedShares = simd.previewDeposit(buffer);
        uint256 price = simd.convertToAssets(1e24);
        vm.prank(keeper);
        assertEq(endow.stake(), expectedShares);
        assertEq(simd.balanceOf(address(endow)), shareDust + expectedShares);
        assertEq(_imdHeld(), 0);
        assertEq(endow.priceMark(), price);
        _covered(recipientId);

        // The real hold: sIMD stamped this contract in this block and will pay it nothing until the next.
        assertEq(IStakedIMD(Mainnet.SIMD).lastDepositBlock(address(endow)), vm.getBlockNumber());
        assertEq(simd.maxWithdraw(address(endow)), 0);
        assertTrue(endow.vaultHold());
        vm.prank(alice);
        vm.expectRevert(Endowments.HoldActive.selector);
        endow.withdraw(recipientId, PRINCIPAL);

        _roll(1);
        assertFalse(endow.vaultHold());
        assertGe(simd.maxWithdraw(address(endow)), PRINCIPAL);
        vm.prank(alice);
        endow.withdraw(recipientId, PRINCIPAL);
        assertEq(imd.balanceOf(alice), before, "principal did not come back to the wei");
        assertEq(endow.principalOf(recipientId, alice), 0);
        _covered(recipientId);
        // The real vault's own rounding never reads as a fall in its price.
        assertFalse(endow.priceBelowMark());
    }

    /// @dev Our own stake block is no obstacle to leaving in shares, and those shares redeem for at
    /// least the principal one block later.
    function test_fork_inKindExit_inOurOwnStakeBlock() public onFork {
        vm.prank(alice);
        endow.deposit(recipientId, PRINCIPAL);
        vm.prank(keeper);
        endow.stake();

        uint256 expectedShares = simd.previewWithdraw(PRINCIPAL);
        vm.prank(alice);
        (uint256 imdOut, uint256 sharesOut) = endow.exit(recipientId, PRINCIPAL, PRINCIPAL, true);
        assertEq(imdOut, 0);
        assertEq(sharesOut, expectedShares);
        assertEq(simd.balanceOf(alice), expectedShares);
        _covered(recipientId);

        // The hold travelled with the shares.
        assertEq(simd.maxRedeem(alice), 0);
        _roll(1);
        vm.prank(alice);
        assertGe(simd.redeem(sharesOut, alice, alice), PRINCIPAL);
    }

    /// @dev Yield arrives as a plain IMD transfer to sIMD; harvest forwards it and only it; the
    /// principal then comes back to the wei.
    function test_fork_yieldByPlainTransfer_harvest_thenExactPrincipal() public onFork {
        uint256 aliceBefore = imd.balanceOf(alice);
        uint256 bobBefore = imd.balanceOf(bob);
        uint256 recipientBefore = imd.balanceOf(recipient);
        vm.prank(alice);
        endow.deposit(recipientId, PRINCIPAL);
        vm.prank(bob);
        endow.deposit(meterId, PRINCIPAL / 2);
        vm.prank(keeper);
        endow.stake();
        _roll(1);
        assertEq(endow.harvestable(recipientId), 0);

        uint256 priceBefore = simd.convertToAssets(1e24);
        assertLe(endow.priceMark(), priceBefore);
        _yieldBps(100);
        assertGt(simd.convertToAssets(1e24), priceBefore);

        // One percent on 1,000 IMD and on 500 IMD, within a millionth of an IMD.
        uint256 toRecipient = endow.harvestable(recipientId);
        uint256 toMeter = endow.harvestable(meterId);
        assertApproxEqAbs(toRecipient, PRINCIPAL / 100, 1e13);
        assertApproxEqAbs(toMeter, PRINCIPAL / 200, 1e13);

        vm.prank(keeper);
        assertEq(endow.harvest(recipientId), toRecipient);
        // The harvest saw the higher price and recorded it.
        assertGt(endow.priceMark(), priceBefore);
        // The first harvest rounded for the vault, which can move the second by a wei.
        uint256 toMeterNow = endow.harvestable(meterId);
        assertApproxEqAbs(toMeterNow, toMeter, 2);
        vm.prank(keeper);
        assertEq(endow.harvest(meterId), toMeterNow);
        assertEq(imd.balanceOf(recipient), recipientBefore + toRecipient);
        assertEq(questions.meterBalance(FEED), toMeterNow);
        assertEq(_imdHeld(), 0);
        _covered(recipientId);
        _covered(meterId);

        // Nothing more to take, and the principal is all still there.
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(recipientId);

        vm.prank(alice);
        endow.withdraw(recipientId, PRINCIPAL);
        vm.prank(bob);
        endow.withdraw(meterId, PRINCIPAL / 2);
        assertEq(imd.balanceOf(alice), aliceBefore, "alice's principal did not come back to the wei");
        assertEq(imd.balanceOf(bob), bobBefore, "bob's principal did not come back to the wei");
        assertFalse(endow.priceBelowMark());
    }

    /// @dev Someone else deposits one IMD-wei into sIMD in this contract's name: the real vault then
    /// holds this contract for that block. Harvests and IMD withdrawals wait one block; leaving in
    /// shares does not wait at all.
    function test_fork_holdCausedBySomeoneElse_inKindExitStillWorks() public onFork {
        vm.prank(alice);
        endow.deposit(recipientId, PRINCIPAL);
        vm.prank(bob);
        endow.deposit(recipientId, PRINCIPAL);
        vm.prank(keeper);
        endow.stake();
        _roll(1);
        _yieldBps(100);

        deal(Mainnet.IMD, stranger, 1e18);
        vm.startPrank(stranger);
        imd.approve(Mainnet.SIMD, 1);
        simd.deposit(1, address(endow));
        vm.stopPrank();
        assertEq(IStakedIMD(Mainnet.SIMD).lastDepositBlock(address(endow)), vm.getBlockNumber());
        assertTrue(endow.vaultHold());

        vm.prank(alice);
        vm.expectRevert(WITHDRAW_MORE_THAN_MAX);
        endow.withdraw(recipientId, PRINCIPAL);
        vm.prank(keeper);
        vm.expectRevert(REDEEM_MORE_THAN_MAX);
        endow.harvest(recipientId);

        // Out in shares, in the held block.
        vm.prank(alice);
        (uint256 imdOut, uint256 sharesOut) = endow.exit(recipientId, PRINCIPAL, PRINCIPAL, true);
        assertEq(imdOut, 0);
        assertEq(simd.balanceOf(alice), sharesOut);
        assertGe(simd.convertToAssets(sharesOut), PRINCIPAL);
        _covered(recipientId);

        // The hold travelled with the shares; one block later it is over for everyone.
        assertEq(simd.maxRedeem(alice), 0);
        _roll(1);
        uint256 aliceBefore = imd.balanceOf(alice);
        vm.prank(alice);
        uint256 redeemed = simd.redeem(sharesOut, alice, alice);
        assertGe(redeemed, PRINCIPAL);
        assertEq(imd.balanceOf(alice), aliceBefore + redeemed);

        uint256 recipientBefore = imd.balanceOf(recipient);
        vm.prank(keeper);
        uint256 sent = endow.harvest(recipientId);
        assertEq(imd.balanceOf(recipient), recipientBefore + sent);

        uint256 bobBefore = imd.balanceOf(bob);
        vm.prank(bob);
        endow.withdraw(recipientId, PRINCIPAL);
        assertEq(imd.balanceOf(bob), bobBefore + PRINCIPAL);
    }

    /// @dev The pot path with the real token and the real vault. The pot is sent what it still needs
    /// and no more; a harvest needs less gas than the contract's notes say; and at the least gas the
    /// contract accepts, a pot that burns its whole allowance still leaves the fallback paid.
    function test_fork_potHarvest_withTheRealToken_andItsGas() public onFork {
        vm.prank(alice);
        endow.deposit(potId, PRINCIPAL);
        vm.prank(keeper);
        endow.stake();
        _roll(1);
        _yieldBps(100);
        uint256 all = endow.harvestable(potId);
        assertApproxEqAbs(all, PRINCIPAL / 100, 1e13);

        // The pot needs 4 IMD: 4 IMD is taken out, the rest stays staked, the fallback gets nothing.
        uint256 snapshot = vm.snapshotState();
        pots.open(POT, 4e18);
        uint256 potsBefore = imd.balanceOf(address(pots));
        uint256 heirBefore = imd.balanceOf(heir);
        vm.prank(keeper);
        assertEq(endow.harvest(potId), 4e18);
        assertEq(imd.balanceOf(address(pots)), potsBefore + 4e18);
        assertEq(imd.balanceOf(heir), heirBefore);
        assertEq(imd.allowance(address(endow), address(pots)), 0);
        assertEq(_imdHeld(), 0);
        _covered(potId);
        assertApproxEqAbs(endow.harvestable(potId), all - 4e18, 2);
        vm.revertToState(snapshot);

        // The gas a pot harvest needs, measured against the real IMD and sIMD.
        uint256 least = _leastGasFor(potId);
        emit log_named_uint("least call gas for a pot harvest (real IMD and sIMD, mock pot)", least);
        assertGt(least, endow.POT_CALL_GAS());
        assertLt(least, 850_000, "a pot harvest needs more gas than the contract's notes say");

        // At that least gas, a pot that needs (nearly) its whole allowance still gets its chip...
        snapshot = vm.snapshotState();
        pots.setMode(MockCrowdPots.Mode.NeedsGas);
        pots.setMinGas(endow.POT_CALL_GAS() - 1_000);
        vm.prank(keeper);
        (bool ok,) = address(endow).call{gas: least}(abi.encodeCall(Endowments.harvest, (potId)));
        assertTrue(ok);
        assertEq(pots.chipOf(POT, heir), all);
        assertEq(imd.balanceOf(heir), heirBefore);
        vm.revertToState(snapshot);

        // ...and a pot that burns all of it still leaves enough to pay the fallback.
        pots.setMode(MockCrowdPots.Mode.BurnsGas);
        vm.prank(keeper);
        (ok,) = address(endow).call{gas: least}(abi.encodeCall(Endowments.harvest, (potId)));
        assertTrue(ok, "the harvest ran out of gas after the pot burned its allowance");
        assertEq(imd.balanceOf(heir), heirBefore + all);
        assertEq(imd.allowance(address(endow), address(pots)), 0);
        _covered(potId);
    }

    /// @dev sIMD gives Permit2 a standing allowance over every holder's shares. Permit2 itself moves
    /// tokens only on the holder's own approval or signature, and this contract can give neither.
    function test_fork_permit2CannotMoveThisContractsShares() public onFork {
        vm.prank(alice);
        endow.deposit(recipientId, PRINCIPAL);
        vm.prank(keeper);
        endow.stake();
        _roll(1);
        uint256 held = simd.balanceOf(address(endow));
        assertGt(held, shareDust);
        // The standing allowance is real.
        assertEq(IERC20(Mainnet.SIMD).allowance(address(endow), Mainnet.PERMIT2), type(uint256).max);

        vm.prank(stranger);
        vm.expectRevert();
        IPermit2(Mainnet.PERMIT2).transferFrom(address(endow), stranger, 1, Mainnet.SIMD);
        assertEq(simd.balanceOf(address(endow)), held);
    }
}
