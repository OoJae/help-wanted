// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Endowments} from "../../src/endowments/Endowments.sol";
import {EndowmentsBase} from "./EndowmentsBase.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockStakedIMD} from "./mocks/MockStakedIMD.sol";

/// @dev Money in (deposit, donate, stake) and principal out (withdraw, exit) while sIMD behaves.
contract EndowmentsFlowTest is EndowmentsBase {
    // ------------------------------------------------------------------------------------ deposit

    function test_deposit_recordsPrincipalAndBuffersTheImd() public {
        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Deposited(recipientId, alice, 100e18);
        _deposit(alice, recipientId, 100e18);

        assertEq(endow.principalOf(recipientId, alice), 100e18);
        assertEq(_principal(recipientId), 100e18);
        assertEq(_buffered(recipientId), 100e18 + seed);
        assertEq(_shares(recipientId), 0);
        assertEq(endow.pendingTotal(), 100e18 + 3 * seed);
        assertEq(imd.balanceOf(address(endow)), 100e18 + 3 * seed);
        assertEq(imd.balanceOf(alice), WALLET - 100e18);
        assertEq(endow.backingOf(recipientId), 100e18 + seed);
        _assertCovered(recipientId);
    }

    function test_deposit_addsUpPerDepositorAndPerEndowment() public {
        _deposit(alice, recipientId, 100e18);
        _deposit(bob, recipientId, 40e18);
        _deposit(alice, recipientId, 1);
        _deposit(alice, meterId, 7e18);

        assertEq(endow.principalOf(recipientId, alice), 100e18 + 1);
        assertEq(endow.principalOf(recipientId, bob), 40e18);
        assertEq(endow.principalOf(meterId, alice), 7e18);
        assertEq(endow.principalOf(meterId, bob), 0);
        assertEq(_principal(recipientId), 140e18 + 1);
        assertEq(_principal(meterId), 7e18);
    }

    function test_deposit_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(Endowments.ZeroAmount.selector);
        endow.deposit(recipientId, 0);
    }

    function test_deposit_revertsOnUnknownEndowment() public {
        vm.startPrank(alice);
        vm.expectRevert(Endowments.UnknownEndowment.selector);
        endow.deposit(0, 1e18);
        vm.expectRevert(Endowments.UnknownEndowment.selector);
        endow.deposit(4, 1e18);
        vm.stopPrank();
    }

    function test_deposit_revertsIfTheTokenKeepsPartOfTheTransfer() public {
        imd.setFee(1);
        vm.prank(alice);
        vm.expectRevert(Endowments.TransferMismatch.selector);
        endow.deposit(recipientId, 100e18);
    }

    function test_deposit_revertsWithoutAllowance() public {
        vm.prank(alice);
        imd.approve(address(endow), 0);
        vm.prank(alice);
        vm.expectRevert();
        endow.deposit(recipientId, 1e18);
    }

    // ------------------------------------------------------------------------------------ donate

    function test_donate_addsToTheBufferButIsNobodysPrincipal() public {
        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Donated(recipientId, bob, 5e18);
        vm.prank(bob);
        endow.donate(recipientId, 5e18);

        assertEq(_principal(recipientId), 0);
        assertEq(endow.principalOf(recipientId, bob), 0);
        assertEq(_buffered(recipientId), 5e18 + seed);
        assertEq(endow.pendingTotal(), 5e18 + 3 * seed);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Endowments.OverPrincipal.selector, 0));
        endow.withdraw(recipientId, 1);
    }

    function test_donate_revertsOnZeroAndOnUnknownEndowment() public {
        vm.startPrank(bob);
        vm.expectRevert(Endowments.ZeroAmount.selector);
        endow.donate(recipientId, 0);
        vm.expectRevert(Endowments.UnknownEndowment.selector);
        endow.donate(99, 1e18);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------ stake

    function test_stake_movesTheWholeBufferIntoTheVaultInOneDeposit() public {
        _deposit(alice, recipientId, 100e18);
        _deposit(bob, meterId, 60e18);
        uint256 buffer = endow.pendingTotal();
        uint256 expected = simd.previewDeposit(buffer);

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Staked(1, buffer, expected);
        vm.prank(keeper);
        uint256 booked = endow.stake();

        assertEq(booked, expected);
        assertEq(simd.balanceOf(address(endow)), expected);
        assertEq(imd.balanceOf(address(endow)), 0);
        assertEq(imd.allowance(address(endow), address(simd)), 0);
        assertEq(endow.pendingTotal(), 0);
        assertEq(endow.epoch(), 2);
        assertEq(endow.lastStakeBlock(), vm.getBlockNumber());
        assertEq(endow.nextStakeBlock(), vm.getBlockNumber() + 50);
        (uint256 assets, uint256 shares) = endow.epochs(1);
        assertEq(assets, buffer);
        assertEq(shares, expected);
    }

    function test_stake_splitsTheBatchInProportion_andNeverHandsOutMoreThanWasMinted() public {
        _deposit(alice, recipientId, 100e18);
        _deposit(bob, meterId, 60e18);
        _deposit(carol, potId, 1);
        uint256 buffer = endow.pendingTotal();
        _stake();
        uint256 minted = simd.balanceOf(address(endow));

        uint256 a = _shares(recipientId);
        uint256 b = _shares(meterId);
        uint256 c = _shares(potId);
        assertEq(a, (100e18 + seed) * minted / buffer);
        assertEq(b, (60e18 + seed) * minted / buffer);
        assertEq(c, (1 + seed) * minted / buffer);
        assertLe(a + b + c, minted);
        // The dust the split leaves over is under one share-wei per endowment.
        assertLt(minted - (a + b + c), 3);
        assertEq(_buffered(recipientId) + _buffered(meterId) + _buffered(potId), 0);
        _assertCovered(recipientId);
        _assertCovered(meterId);
        _assertCovered(potId);
    }

    function test_stake_theSplitIsBookedOnTheNextTouch() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        uint256 expected = _shares(recipientId);

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Settled(recipientId, 1, 100e18 + seed, expected);
        _deposit(alice, recipientId, 1e18);

        assertEq(_shares(recipientId), expected);
        assertEq(_buffered(recipientId), 1e18);
        assertEq(endow.pendingTotal(), 1e18);
    }

    function test_stake_anEndowmentLeftAloneForSeveralBatchesKeepsItsOwnSplit() public {
        _deposit(bob, meterId, 60e18);
        _deposit(alice, recipientId, 100e18);
        uint256 buffer = endow.pendingTotal();
        _stakeAndWait();
        (, uint256 firstBatchShares) = endow.epochs(1);
        uint256 expected = (60e18 + seed) * firstBatchShares / buffer;

        // Three more batches, at three other prices, none of them touching the meter endowment.
        for (uint256 i = 0; i < 3; ++i) {
            _yieldBps(150);
            _deposit(alice, recipientId, 10e18 + i);
            _stakeAndWait();
        }
        assertEq(endow.epoch(), 5);
        assertEq(_shares(meterId), expected);

        // The view and the booked state agree once it is touched.
        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Settled(meterId, 1, 60e18 + seed, expected);
        vm.prank(carol);
        endow.donate(meterId, 1);
        assertEq(_shares(meterId), expected);
        assertEq(_buffered(meterId), 1);

        _withdraw(bob, meterId, 60e18);
        assertEq(imd.balanceOf(bob), WALLET);
    }

    function test_stake_revertsInsideTheInterval() public {
        _deposit(alice, recipientId, 100e18);
        _stake();
        uint256 stakedAt = vm.getBlockNumber();
        _deposit(alice, recipientId, 1e18);

        vm.roll(stakedAt + 49);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Endowments.TooSoon.selector, stakedAt + 50));
        endow.stake();

        vm.roll(stakedAt + 50);
        vm.prank(keeper);
        endow.stake();
        assertEq(endow.epoch(), 3);
    }

    function test_stake_revertsWithAnEmptyBuffer() public {
        _stake();
        _roll(50);
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToStake.selector);
        endow.stake();
        // A refused stake does not use up the interval.
        assertEq(endow.epoch(), 2);
    }

    function test_stake_anyoneMayCall() public {
        _deposit(alice, recipientId, 100e18);
        vm.prank(stranger);
        endow.stake();
        assertEq(endow.epoch(), 2);
    }

    /// @dev The constructor cannot ask the vault anything, so the first stake does: an address that is
    /// not a vault over IMD is refused before any IMD is approved to it, and the buffer stays withdrawable.
    function test_stake_revertsIfTheVaultIsNotOverImd() public {
        MockIMD otherToken = new MockIMD();
        MockStakedIMD otherVault = new MockStakedIMD(address(otherToken));
        Endowments wrong = new Endowments(address(imd), address(otherVault), address(questions), address(pots));
        vm.startPrank(alice);
        imd.approve(address(wrong), type(uint256).max);
        uint256 id = wrong.createForRecipient(recipient);
        wrong.deposit(id, 100e18);
        vm.expectRevert(Endowments.WrongVault.selector);
        wrong.stake();
        assertEq(imd.allowance(address(wrong), address(otherVault)), 0);

        wrong.withdraw(id, 100e18);
        vm.stopPrank();
        assertEq(imd.balanceOf(alice), WALLET - seed);
    }

    /// @dev Each stake records sIMD's price if it is the highest seen so far.
    function test_stake_recordsTheHighestPriceSeen() public {
        _deposit(alice, recipientId, 100e18);
        uint256 price = simd.convertToAssets(1e24);
        assertEq(endow.priceMark(), 0);
        assertFalse(endow.priceBelowMark());

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.PriceMarked(price);
        vm.prank(keeper);
        endow.stake();
        assertEq(endow.priceMark(), price);

        // Yield lifts the price; the mark follows at the next stake, and not before.
        _yieldBps(100);
        uint256 higher = simd.convertToAssets(1e24);
        assertGt(higher, price);
        assertEq(endow.priceMark(), price);
        _deposit(alice, recipientId, 1e18);
        _stake();
        assertEq(endow.priceMark(), higher);
        assertFalse(endow.priceBelowMark());
    }

    /// @dev The vault's own rounding never lowers its price, so staking and withdrawing with no yield
    /// in between never trips the mark.
    function test_stake_theVaultsOwnRoundingNeverTripsTheMark() public {
        for (uint256 i = 0; i < 5; ++i) {
            _deposit(alice, recipientId, 7e18 + i * 1e17 + i);
            _stakeAndWait();
            _withdraw(alice, recipientId, 3e18 + i);
            assertFalse(endow.priceBelowMark());
        }
        assertEq(endow.epoch(), 6);
    }

    function test_stake_revertsIfTheVaultMintsFewerSharesThanItPreviewed() public {
        _deposit(alice, recipientId, 100e18);
        simd.setFault(MockStakedIMD.Fault.MintsFewer);
        vm.prank(keeper);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.stake();
    }

    function test_stake_revertsIfTheVaultReportsFewerSharesThanItPreviewed() public {
        _deposit(alice, recipientId, 100e18);
        simd.setFault(MockStakedIMD.Fault.ReportsWrong);
        vm.prank(keeper);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.stake();
    }

    function test_stake_revertsIfTheBatchWouldMintNothing() public {
        _deposit(alice, recipientId, 100e18);
        simd.setFault(MockStakedIMD.Fault.PreviewsZero);
        vm.prank(keeper);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.stake();

        // The refused batch is still in the buffer and alice can still take her money back.
        _withdraw(alice, recipientId, 100e18);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    // ------------------------------------------------------------------------------------ withdraw

    function test_withdraw_fromTheBuffer_isExactAndNeverAsksTheVault() public {
        _deposit(alice, recipientId, 100e18);

        vm.expectCall(address(simd), bytes(""), 0);
        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Withdrawn(recipientId, alice, 40e18, 40e18, 0);
        _withdraw(alice, recipientId, 40e18);

        assertEq(imd.balanceOf(alice), WALLET - 60e18);
        assertEq(endow.principalOf(recipientId, alice), 60e18);
        assertEq(_principal(recipientId), 60e18);
        assertEq(_buffered(recipientId), 60e18 + seed);
        assertEq(endow.pendingTotal(), 60e18 + 3 * seed);
    }

    /// @dev The headline promise, in the hardest case: nothing has been earned, so there is no yield to
    /// hide rounding behind. The seed is what makes this exact.
    function test_withdraw_afterStaking_isExactToTheWei_withNoYieldAtAll() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        assertEq(imd.balanceOf(address(endow)), 0);

        _withdraw(alice, recipientId, 100e18);

        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(endow.principalOf(recipientId, alice), 0);
        assertEq(_principal(recipientId), 0);
        assertEq(imd.balanceOf(address(endow)), 0);
        _assertCovered(recipientId);
    }

    function test_withdraw_oddAmountsAndManyPieces_areEachExact() public {
        uint256 amount = 123_456_789_012_345_678_901;
        _deposit(alice, recipientId, amount);
        _stakeAndWait();

        uint256 before = imd.balanceOf(alice);
        _withdraw(alice, recipientId, 1);
        _withdraw(alice, recipientId, 999);
        _withdraw(alice, recipientId, 3e18 + 7);
        assertEq(imd.balanceOf(alice), before + 1 + 999 + 3e18 + 7);
        _assertCovered(recipientId);

        _withdraw(alice, recipientId, endow.principalOf(recipientId, alice));
        assertEq(imd.balanceOf(alice), WALLET);
    }

    function test_withdraw_usesTheBufferFirst_thenTheVault() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        _deposit(bob, recipientId, 30e18);
        uint256 sharesBefore = simd.balanceOf(address(endow));
        uint256 burn = simd.previewWithdraw(70e18);

        _withdraw(alice, recipientId, 100e18);

        assertEq(imd.balanceOf(alice), WALLET);
        // Bob's 30 left the buffer for alice, so only 70 had to come out of the vault.
        assertEq(simd.balanceOf(address(endow)), sharesBefore - burn);
        assertEq(_buffered(recipientId), 0);
        assertEq(endow.pendingTotal(), 0);
        assertEq(_principal(recipientId), 30e18);
        _assertCovered(recipientId);

        // Bob's principal is now backed by shares, and is just as exact.
        _withdraw(bob, recipientId, 30e18);
        assertEq(imd.balanceOf(bob), WALLET);
    }

    function test_withdraw_inAStakeBlock_revertsHoldActive_andWorksOneBlockLater() public {
        _deposit(alice, recipientId, 100e18);
        _stake();

        vm.prank(alice);
        vm.expectRevert(Endowments.HoldActive.selector);
        endow.withdraw(recipientId, 100e18);

        _roll(1);
        _withdraw(alice, recipientId, 100e18);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    function test_withdraw_inAStakeBlock_stillPaysWhatTheBufferCovers() public {
        _deposit(alice, recipientId, 100e18);
        _stake();
        // Same block, after the stake: this deposit waits in the new buffer.
        _deposit(bob, recipientId, 30e18);

        _withdraw(alice, recipientId, 30e18);
        assertEq(imd.balanceOf(alice), WALLET - 70e18);

        vm.prank(alice);
        vm.expectRevert(Endowments.HoldActive.selector);
        endow.withdraw(recipientId, 1);
    }

    function test_withdraw_whenSomeoneElseCausesAHold_failsWithTheVaultsError_forThatBlockOnly() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        _strangerCausesHold();

        vm.prank(alice);
        vm.expectRevert(MockStakedIMD.WithdrawMoreThanMax.selector);
        endow.withdraw(recipientId, 100e18);

        _roll(1);
        _withdraw(alice, recipientId, 100e18);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    /// @dev The cheapest hold anyone can cause: one IMD-wei deposited into sIMD in this contract's name.
    /// It lasts for that block, and the shares it leaves here belong to no endowment.
    function test_withdraw_whenSomeoneDepositsIntoTheVaultInOurName_waitsOneBlock() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        uint256 booked = _shares(meterId) + _shares(potId) + _shares(recipientId);
        _strangerDepositsInOurName();
        assertTrue(endow.vaultHold());
        assertEq(_shares(meterId) + _shares(potId) + _shares(recipientId), booked);

        vm.prank(alice);
        vm.expectRevert(MockStakedIMD.WithdrawMoreThanMax.selector);
        endow.withdraw(recipientId, 100e18);

        _roll(1);
        assertFalse(endow.vaultHold());
        _withdraw(alice, recipientId, 100e18);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    function test_withdraw_revertsIfTheVaultBurnsMoreThanItSaid() public {
        _deposit(alice, recipientId, 100e18);
        _deposit(bob, recipientId, 100e18);
        _stakeAndWait();
        // Everything the vault reports is right; one share more than that is gone from this contract.
        simd.setFault(MockStakedIMD.Fault.BurnsQuietly);
        vm.prank(alice);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.withdraw(recipientId, 100e18);
    }

    function test_withdraw_revertsOnZero() public {
        _deposit(alice, recipientId, 100e18);
        vm.prank(alice);
        vm.expectRevert(Endowments.ZeroAmount.selector);
        endow.withdraw(recipientId, 0);
    }

    function test_withdraw_revertsOnUnknownEndowment() public {
        vm.prank(alice);
        vm.expectRevert(Endowments.UnknownEndowment.selector);
        endow.withdraw(77, 1);
    }

    function test_withdraw_revertsAboveTheCallersOwnPrincipal() public {
        _deposit(alice, recipientId, 100e18);
        _deposit(bob, recipientId, 500e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.OverPrincipal.selector, 100e18));
        endow.withdraw(recipientId, 100e18 + 1);

        // Carol put nothing in; the creator put in only the seed, which is nobody's principal.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Endowments.OverPrincipal.selector, 0));
        endow.withdraw(recipientId, 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Endowments.OverPrincipal.selector, 0));
        endow.withdraw(recipientId, 1);
    }

    function test_withdraw_principalInOneEndowmentCannotBeTakenFromAnother() public {
        _deposit(alice, recipientId, 100e18);
        _deposit(bob, meterId, 100e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.OverPrincipal.selector, 0));
        endow.withdraw(meterId, 1e18);
    }

    function test_withdraw_revertsIfTheVaultPaysShort() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        simd.setFault(MockStakedIMD.Fault.PaysShort);
        vm.prank(alice);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.withdraw(recipientId, 100e18);
    }

    function test_withdraw_revertsIfTheVaultBurnsMoreThanItPreviewed() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        simd.setFault(MockStakedIMD.Fault.BurnsExtra);
        vm.prank(alice);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.withdraw(recipientId, 100e18);
    }

    function test_withdraw_revertsIfTheVaultReportsMoreBurnedThanItPreviewed() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        simd.setFault(MockStakedIMD.Fault.ReportsWrong);
        vm.prank(alice);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.withdraw(recipientId, 100e18);
    }

    function test_withdraw_revertsIfTheVaultSaysImdLeavesForNoShares() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        simd.setFault(MockStakedIMD.Fault.PreviewsZero);
        vm.prank(alice);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.withdraw(recipientId, 100e18);
    }

    // ------------------------------------------------------------------------------------ exit

    function test_exit_inImd_isTheSameAsWithdrawWhileTheEndowmentIsWhole() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();

        vm.prank(alice);
        (uint256 imdOut, uint256 sharesOut) = endow.exit(recipientId, 100e18, 100e18, false);
        assertEq(imdOut, 100e18);
        assertEq(sharesOut, 0);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    function test_exit_revertsIfTheCallerAsksForMoreThanTheirPrincipalIsWorth() public {
        _deposit(alice, recipientId, 100e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.BelowMinimum.selector, 100e18, 100e18 + 1));
        endow.exit(recipientId, 100e18, 100e18 + 1, false);
    }

    /// @dev The way out that no hold can close: shares instead of IMD, in the stake block itself.
    function test_exit_inKind_worksInTheStakeBlock_andTheSharesAreWorthThePrincipal() public {
        _deposit(alice, recipientId, 100e18);
        _stake();
        uint256 expectedShares = simd.previewWithdraw(100e18);

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Withdrawn(recipientId, alice, 100e18, 0, expectedShares);
        vm.prank(alice);
        (uint256 imdOut, uint256 sharesOut) = endow.exit(recipientId, 100e18, 100e18, true);

        assertEq(imdOut, 0);
        assertEq(sharesOut, expectedShares);
        assertEq(simd.balanceOf(alice), expectedShares);
        assertGe(simd.convertToAssets(expectedShares), 100e18);
        assertEq(endow.principalOf(recipientId, alice), 0);
        _assertCovered(recipientId);

        // The hold came along with the shares: alice redeems from the next block on.
        assertEq(simd.maxRedeem(alice), 0);
        _roll(1);
        vm.prank(alice);
        uint256 redeemed = simd.redeem(expectedShares, alice, alice);
        assertGe(redeemed, 100e18);
        assertEq(imd.balanceOf(alice), WALLET - 100e18 + redeemed);
    }

    function test_exit_inKind_worksWhileSomeoneElseHoldsTheContract() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        _strangerCausesHold();

        vm.prank(alice);
        (, uint256 sharesOut) = endow.exit(recipientId, 100e18, 100e18, true);
        assertEq(simd.balanceOf(alice), sharesOut);
        assertGe(simd.convertToAssets(sharesOut), 100e18);
    }

    function test_exit_inKind_paysTheBufferedPartInImd() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        _deposit(bob, recipientId, 30e18);

        vm.prank(alice);
        (uint256 imdOut, uint256 sharesOut) = endow.exit(recipientId, 100e18, 100e18, true);
        assertEq(imdOut, 30e18);
        assertEq(sharesOut, simd.previewWithdraw(70e18));
        assertEq(imd.balanceOf(alice), WALLET - 70e18);
        _assertCovered(recipientId);
    }

    function test_exit_inKind_revertsIfTheCallerAsksForMoreThanTheSharesAreWorth() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        uint256 worth = simd.convertToAssets(simd.previewWithdraw(100e18));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.BelowMinimum.selector, worth, worth + 1));
        endow.exit(recipientId, 100e18, worth + 1, true);
    }

    function test_exit_revertsOnZeroAndOnUnknownEndowment() public {
        _deposit(alice, recipientId, 100e18);
        vm.startPrank(alice);
        vm.expectRevert(Endowments.ZeroAmount.selector);
        endow.exit(recipientId, 0, 0, true);
        vm.expectRevert(Endowments.UnknownEndowment.selector);
        endow.exit(9, 1, 0, false);
        vm.stopPrank();
    }

    function test_exit_inKind_cannotTakeMoreThanTheCallersPrincipal() public {
        _deposit(alice, recipientId, 100e18);
        _deposit(bob, recipientId, 100e18);
        _stakeAndWait();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.OverPrincipal.selector, 100e18));
        endow.exit(recipientId, 100e18 + 1, 0, true);
    }

    // ------------------------------------------------------------------------------------ views

    function test_quote_matchesWhatWithdrawAndExitPay() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        _deposit(bob, recipientId, 30e18);

        (uint256 imdOut, uint256 sharesOut, bool exact) = endow.quote(recipientId, 100e18, false);
        assertEq(imdOut, 100e18);
        assertEq(sharesOut, 0);
        assertTrue(exact);

        (imdOut, sharesOut, exact) = endow.quote(recipientId, 100e18, true);
        assertEq(imdOut, 30e18);
        assertEq(sharesOut, simd.previewWithdraw(70e18));
        assertTrue(exact);

        (imdOut, sharesOut, exact) = endow.quote(recipientId, 0, false);
        assertEq(imdOut + sharesOut, 0);
        assertFalse(exact);
        (imdOut, sharesOut, exact) = endow.quote(recipientId, 130e18 + 1, false);
        assertEq(imdOut + sharesOut, 0);
        assertFalse(exact);
    }

    function test_vaultHold_reportsAHoldWhoeverCausedIt() public {
        _deposit(alice, recipientId, 100e18);
        // Nothing staked yet: there is nothing for the vault to hold.
        assertFalse(endow.vaultHold());

        _stake();
        assertTrue(endow.vaultHold());
        _roll(1);
        assertFalse(endow.vaultHold());

        _strangerCausesHold();
        assertTrue(endow.vaultHold());
        _roll(1);
        assertFalse(endow.vaultHold());

        _strangerDepositsInOurName();
        assertTrue(endow.vaultHold());
        _roll(1);
        assertFalse(endow.vaultHold());
    }

    function test_nextStakeBlock_followsTheLastStake() public {
        assertEq(endow.nextStakeBlock(), 50);
        _stake();
        assertEq(endow.nextStakeBlock(), vm.getBlockNumber() + interval);
    }

    function test_backingOf_countsBufferAndShares() public {
        _deposit(alice, recipientId, 100e18);
        assertEq(endow.backingOf(recipientId), 100e18 + seed);
        _stakeAndWait();
        _deposit(bob, recipientId, 30e18);
        assertEq(endow.backingOf(recipientId), 30e18 + simd.convertToAssets(_shares(recipientId)));
        assertGe(endow.backingOf(recipientId), 130e18);
    }

    /// @dev What the seed buys: after a batch the endowment holds far more spare share-wei than the few
    /// that rounding can take, and a withdrawal uses up at most one of them.
    function test_cushion_aBatchCostsAtMostTwoShareWei_andAWithdrawalAtMostOne() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        int256 afterFirst = _cushion(recipientId);
        assertGt(afterFirst, int256(margin));

        _deposit(alice, recipientId, 55e18 + 3);
        _stakeAndWait();
        int256 afterSecond = _cushion(recipientId);
        assertGe(afterSecond, afterFirst - 2);

        _withdraw(alice, recipientId, 17e18 + 1);
        assertGe(_cushion(recipientId), afterSecond - 1);
    }
}
