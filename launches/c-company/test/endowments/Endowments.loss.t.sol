// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Endowments} from "../../src/endowments/Endowments.sol";
import {EndowmentsBase} from "./EndowmentsBase.sol";
import {MockStakedIMD} from "./mocks/MockStakedIMD.sol";

/// @dev What happens if sIMD's share price falls. It cannot by sIMD's own rules; the mock is made to
/// lose IMD so the tests can show that a loss is shared, that nobody can leave with someone else's part,
/// and that staking and harvesting stop.
contract EndowmentsLossTest is EndowmentsBase {
    function _twoDepositorsThenLoss(uint256 lossBps) internal {
        _deposit(alice, recipientId, 100e18);
        _deposit(bob, recipientId, 100e18);
        _stakeAndWait();
        _loseBps(lossBps);
    }

    /// @dev Alice (2 IMD) and bob (1 IMD) are staked, the vault loses a tenth, and yield then brings the
    /// endowment back to exactly `target` share-wei more than its principal needs.
    function _lossMadeGoodTo(uint256 target) internal {
        _deposit(alice, recipientId, 2e18);
        _deposit(bob, recipientId, 1e18);
        _stakeAndWait();
        _loseBps(1_000);
        assertLt(_cushion(recipientId), 0, "setup: the loss did not make the endowment short");
        _recoverToSpare(recipientId, target);
    }

    // ------------------------------------------------------------------------------------ short

    function test_loss_makesTheEndowmentShort() public {
        _twoDepositorsThenLoss(5_000);
        assertFalse(endow.isWhole(recipientId));
        assertApproxEqAbs(endow.backingOf(recipientId), 100e18, 1e13);
        assertLt(_cushion(recipientId), 0);
    }

    function test_loss_withdrawRefusesToPayLessThanWasAsked() public {
        _twoDepositorsThenLoss(5_000);
        (uint256 wouldPay,, bool exact) = endow.quote(recipientId, 100e18, false);
        assertFalse(exact);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.BelowMinimum.selector, wouldPay, 100e18));
        endow.withdraw(recipientId, 100e18);
        assertEq(endow.principalOf(recipientId, alice), 100e18);
    }

    /// @dev The first to leave gets half of what is there, not all of what they are owed.
    function test_loss_isSharedProRata_theFirstToLeaveCannotTakeEverything() public {
        _twoDepositorsThenLoss(5_000);
        uint256 backing = endow.backingOf(recipientId);

        vm.prank(alice);
        (uint256 alicePaid,) = endow.exit(recipientId, 100e18, 0, false);
        assertLe(alicePaid, backing / 2 + 1);
        assertApproxEqAbs(alicePaid, 50e18, 1e13);
        assertEq(imd.balanceOf(alice), WALLET - 100e18 + alicePaid);
        // Her claim is settled in full: nothing is owed to her later.
        assertEq(endow.principalOf(recipientId, alice), 0);
        assertEq(_principal(recipientId), 100e18);

        vm.prank(bob);
        (uint256 bobPaid,) = endow.exit(recipientId, 100e18, 0, false);
        assertApproxEqAbs(bobPaid, alicePaid, 2);
        assertGe(bobPaid + 1, alicePaid);
        assertEq(_principal(recipientId), 0);
    }

    function test_loss_partialExitsLeaveTheRestNoWorseOff() public {
        _twoDepositorsThenLoss(3_000);
        uint256 backingBefore = endow.backingOf(recipientId);

        vm.prank(alice);
        (uint256 paid,) = endow.exit(recipientId, 40e18, 0, false);
        // 40 of 200 is a fifth of the claims, so at most a fifth of what is there.
        assertLe(paid, backingBefore / 5 + 1);
        assertApproxEqAbs(paid, 28e18, 1e13);
        // What remains covers the remaining claims at least as well as before.
        uint256 backingAfter = endow.backingOf(recipientId);
        assertGe((backingAfter + 2) * 200e18, backingBefore * 160e18);
        assertEq(endow.principalOf(recipientId, alice), 60e18);
    }

    function test_loss_exitRespectsTheCallersMinimum() public {
        _twoDepositorsThenLoss(5_000);
        (uint256 wouldPay,,) = endow.quote(recipientId, 100e18, false);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.BelowMinimum.selector, wouldPay, wouldPay + 1));
        endow.exit(recipientId, 100e18, wouldPay + 1, false);

        vm.prank(alice);
        (uint256 paid,) = endow.exit(recipientId, 100e18, wouldPay, false);
        assertEq(paid, wouldPay);
    }

    /// @dev The pooled model, stated in the contract's notes: a deposit still waiting in the buffer
    /// shares in a loss on what its endowment had already staked.
    function test_loss_bufferedImdIsSharedInTheSameProportion() public {
        // Alice is staked; bob's deposit is still in the buffer when the loss lands.
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        _deposit(bob, recipientId, 100e18);
        _loseBps(5_000);
        assertApproxEqAbs(endow.backingOf(recipientId), 150e18, 1e13);

        (uint256 quoted,, bool exact) = endow.quote(recipientId, 100e18, false);
        assertFalse(exact);
        vm.prank(alice);
        (uint256 alicePaid,) = endow.exit(recipientId, 100e18, 0, false);
        assertEq(alicePaid, quoted);
        assertApproxEqAbs(alicePaid, 75e18, 1e13);
        // Half the buffer and half the shares went; half of each is left for bob.
        assertEq(_buffered(recipientId), 50e18);
        assertEq(endow.pendingTotal(), 50e18);

        vm.prank(bob);
        (uint256 bobPaid,) = endow.exit(recipientId, 100e18, 0, false);
        assertApproxEqAbs(bobPaid, alicePaid, 2);
    }

    function test_loss_inKindExitHandsOverTheSameSliceInShares() public {
        _twoDepositorsThenLoss(5_000);
        uint256 shares = _shares(recipientId);

        vm.prank(alice);
        (uint256 imdOut, uint256 sharesOut) = endow.exit(recipientId, 100e18, 0, true);
        assertEq(imdOut, 0);
        assertEq(sharesOut, shares / 2);
        assertEq(simd.balanceOf(alice), shares / 2);
        assertEq(_shares(recipientId), shares - shares / 2);
    }

    function test_loss_inKindExitRespectsTheCallersMinimum() public {
        _twoDepositorsThenLoss(5_000);
        uint256 worth = simd.convertToAssets(_shares(recipientId) / 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.BelowMinimum.selector, worth, 100e18));
        endow.exit(recipientId, 100e18, 100e18, true);
    }

    function test_loss_noNewDepositsWhileShort() public {
        _twoDepositorsThenLoss(100);
        vm.prank(carol);
        vm.expectRevert(Endowments.EndowmentShort.selector);
        endow.deposit(recipientId, 10e18);

        // Another endowment that was never staked is untouched by the loss and still takes deposits.
        vm.prank(creator);
        uint256 fresh = endow.createForRecipient(recipient);
        _deposit(carol, fresh, 10e18);
        _withdraw(carol, fresh, 10e18);
        assertEq(imd.balanceOf(carol), WALLET);
    }

    function test_loss_harvestTakesNothingFromAShortEndowment() public {
        _deposit(alice, recipientId, 1_000e18);
        _stakeAndWait();
        _yieldBps(100);
        assertGt(endow.harvestable(recipientId), 0);

        // The loss is bigger than the yield that had built up.
        _loseBps(500);
        assertEq(endow.harvestable(recipientId), 0);
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(recipientId);
        assertEq(imd.balanceOf(recipient), 0);
    }

    function test_loss_yieldMakesAShortEndowmentWholeAgain() public {
        _twoDepositorsThenLoss(1_000);
        assertFalse(endow.isWhole(recipientId));

        // The price has to climb back by a ninth to undo a tenth lost.
        _yieldBps(1_200);
        assertTrue(endow.isWhole(recipientId));
        _withdraw(alice, recipientId, 100e18);
        _withdraw(bob, recipientId, 100e18);
        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(imd.balanceOf(bob), WALLET);
    }

    function test_loss_aDonationMakesAShortEndowmentWholeAgain() public {
        _twoDepositorsThenLoss(1_000);
        uint256 shortfall = 200e18 - endow.backingOf(recipientId);

        vm.prank(carol);
        endow.donate(recipientId, shortfall + 1e12);
        assertTrue(endow.isWhole(recipientId));

        // Buffer first, then shares: both depositors are paid in full again.
        _withdraw(alice, recipientId, 100e18);
        _withdraw(bob, recipientId, 100e18);
        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(imd.balanceOf(bob), WALLET);
    }

    function test_loss_totalLossPaysNothingButStillLetsDepositorsClose() public {
        _twoDepositorsThenLoss(10_000);
        uint256 shares = _shares(recipientId);
        uint256 held = simd.balanceOf(address(endow));
        vm.prank(alice);
        (uint256 imdOut, uint256 sharesOut) = endow.exit(recipientId, 100e18, 0, false);
        assertEq(imdOut, 0);
        assertEq(sharesOut, 0);
        assertEq(endow.principalOf(recipientId, alice), 0);
        // Shares that would redeem for nothing are not burned for nothing: they stay with those who stay.
        assertEq(_shares(recipientId), shares);
        assertEq(simd.balanceOf(address(endow)), held);
    }

    /// @dev Leaving at a loss while the vault is holding this contract: the IMD exit waits for the next
    /// block, the in-kind exit does not wait at all. The hold here is one someone else caused; after a
    /// fall this contract no longer stakes, so it cannot cause one itself (see the price tests below).
    function test_loss_whileTheVaultHoldsTheContract_theImdExitWaitsButTheInKindExitDoesNot() public {
        _twoDepositorsThenLoss(5_000);
        _strangerCausesHold();

        vm.prank(alice);
        vm.expectRevert(MockStakedIMD.RedeemMoreThanMax.selector);
        endow.exit(recipientId, 100e18, 0, false);

        vm.prank(alice);
        (, uint256 sharesOut) = endow.exit(recipientId, 100e18, 0, true);
        assertGt(sharesOut, 0);

        _roll(1);
        vm.prank(bob);
        (uint256 imdOut,) = endow.exit(recipientId, 100e18, 0, false);
        assertApproxEqAbs(imdOut, 50e18, 1e13);
    }

    // ------------------------------------------------------------------------------------ the price mark

    /// @dev From both reviews: after a fall in sIMD's price nothing used to stop. An endowment whose
    /// unharvested yield was bigger than the fall stayed whole and kept paying that yield out, and
    /// `stake` kept moving fresh deposits into the vault. Now both stop while the price is below the
    /// highest one either of them has seen, and the yield that is kept covers a second fall.
    function test_priceFall_stakeAndHarvestStop_andTheYieldKeptCoversASecondFall() public {
        _deposit(alice, recipientId, 1_000e18);
        _stakeAndWait();
        _yieldBps(300);
        // A later batch (bob's, in another endowment) is staked: the contract has now seen the price 3% up.
        _deposit(bob, meterId, 1e18);
        _stakeAndWait();
        uint256 mark = endow.priceMark();
        assertApproxEqAbs(mark, simd.convertToAssets(1e24), 1);

        _loseBps(100);
        uint256 price = simd.convertToAssets(1e24);
        assertLt(price, mark);
        assertTrue(endow.priceBelowMark());
        // Still whole, with about 2% on top of its principal.
        assertTrue(endow.isWhole(recipientId));
        assertApproxEqAbs(endow.backingOf(recipientId), 1_019_70e16, 1e16);

        // No harvest, although the endowment holds yield.
        assertEq(endow.harvestable(recipientId), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Endowments.PriceFell.selector, price, mark));
        endow.harvest(recipientId);
        assertEq(imd.balanceOf(recipient), 0);

        // No stake either: carol's deposit (into an endowment the fall did not touch) stays IMD in the buffer.
        _deposit(carol, potId, 50e18);
        _roll(interval);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Endowments.PriceFell.selector, price, mark));
        endow.stake();
        assertEq(endow.pendingTotal(), 50e18);
        assertEq(endow.priceMark(), mark);

        // A second fall. The yield that was not paid out absorbs it: principal is still covered and
        // alice is still paid to the wei.
        _loseBps(150);
        assertTrue(endow.isWhole(recipientId));
        _withdraw(alice, recipientId, 1_000e18);
        assertEq(imd.balanceOf(alice), WALLET);
        // Carol's buffered deposit never went near the vault.
        _withdraw(carol, potId, 50e18);
        assertEq(imd.balanceOf(carol), WALLET);
    }

    function test_priceFall_bothResumeOnceThePriceIsBack() public {
        _deposit(alice, recipientId, 1_000e18);
        _stakeAndWait();
        uint256 mark = endow.priceMark();
        _loseBps(200);
        _deposit(bob, potId, 10e18);
        _roll(interval);
        uint256 fallen = simd.convertToAssets(1e24);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Endowments.PriceFell.selector, fallen, mark));
        endow.stake();

        // Yield lifts the price past the mark again: 0.98 x 1.03 is a little over 1.
        _yieldBps(300);
        assertFalse(endow.priceBelowMark());
        assertEq(endow.priceMark(), mark);
        vm.prank(keeper);
        endow.stake();
        assertGt(endow.priceMark(), mark);
        assertEq(endow.pendingTotal(), 0);

        _roll(1);
        uint256 expected = endow.harvestable(recipientId);
        assertApproxEqAbs(expected, 9_40e16, 1e16);
        vm.prank(keeper);
        endow.harvest(recipientId);
        assertEq(imd.balanceOf(recipient), expected);
        _assertCovered(recipientId);
    }

    /// @dev The price exactly at the mark is not a fall.
    function test_priceFall_thePriceAtTheMarkIsNotAFall() public {
        _deposit(alice, recipientId, 1_000e18);
        _stakeAndWait();
        // Nothing was earned or lost: one whole sIMD converts to the same IMD-wei as when it was marked.
        assertEq(simd.convertToAssets(1e24), endow.priceMark());
        assertFalse(endow.priceBelowMark());
        _deposit(alice, recipientId, 1e18);
        _stake();
        assertEq(endow.epoch(), 3);
        _roll(1);
        _yieldBps(100);
        vm.prank(keeper);
        endow.harvest(recipientId);
    }

    /// @dev The limit of the mark, stated in the contract's notes: it only knows the prices `stake` and
    /// `harvest` were run at. Here the price rises 3% and falls 1% with neither of them run in between,
    /// so the fall is not seen. The other rule still holds: the harvest takes only what is beyond the
    /// principal at the price of the moment, and the principal comes back to the wei.
    function test_priceFall_thatNoStakeOrHarvestSaw_eatsYieldFirstAndNeverPrincipal() public {
        _deposit(alice, recipientId, 1_000e18);
        _stakeAndWait();
        _yieldBps(300);
        uint256 before = endow.harvestable(recipientId);
        _loseBps(100);
        assertFalse(endow.priceBelowMark());

        assertTrue(endow.isWhole(recipientId));
        uint256 afterLoss = endow.harvestable(recipientId);
        assertLt(afterLoss, before);
        vm.prank(keeper);
        endow.harvest(recipientId);
        _assertCovered(recipientId);
        _withdraw(alice, recipientId, 1_000e18);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    /// @dev After a fall deposits into a whole endowment are still taken. They wait in the buffer as
    /// IMD and come back as IMD, with the vault having no say.
    function test_priceFall_aNewDepositWaitsInTheBufferAndComesBackToTheWei() public {
        _twoDepositorsThenLoss(2_000);
        vm.prank(creator);
        uint256 fresh = endow.createForRecipient(recipient);
        _deposit(carol, fresh, 77e18);
        _roll(interval);
        vm.prank(keeper);
        vm.expectRevert();
        endow.stake();

        vm.expectCall(address(simd), bytes(""), 0);
        _withdraw(carol, fresh, 77e18);
        assertEq(imd.balanceOf(carol), WALLET);
    }

    // ------------------------------------------------------------------------------------ no spare

    /// @dev From the review. After a loss is made good an endowment can be covered with nothing to
    /// spare. It used to read whole and take deposits in that state; it does neither now.
    function test_spare_none_isCoveredButNotWhole_andTakesNoDeposit() public {
        _lossMadeGoodTo(0);
        // Covered: the principal is all there.
        assertGe(endow.backingOf(recipientId), 3e18);
        assertEq(_cushion(recipientId), 0);
        assertFalse(endow.isWhole(recipientId));
        assertEq(endow.harvestable(recipientId), 0);

        vm.prank(carol);
        vm.expectRevert(Endowments.EndowmentShort.selector);
        endow.deposit(recipientId, 5e18);

        // Both depositors still get out: the first to within three wei, the last one in full.
        vm.prank(alice);
        (uint256 alicePaid,) = endow.exit(recipientId, 2e18, 2e18 - 3, false);
        assertLe(alicePaid, 2e18);
        assertGe(_cushion(recipientId), 0);
        _withdraw(bob, recipientId, 1e18);
        assertEq(imd.balanceOf(bob), WALLET);
    }

    /// @dev The line is drawn to the share-wei: one below `SPARE` is not whole, `SPARE` is.
    function test_spare_theLineIsExactlyAtSpare() public {
        uint256 snapshot = vm.snapshotState();
        _lossMadeGoodTo(spare - 1);
        assertFalse(endow.isWhole(recipientId));
        vm.prank(carol);
        vm.expectRevert(Endowments.EndowmentShort.selector);
        endow.deposit(recipientId, 5e18);
        vm.revertToState(snapshot);

        _lossMadeGoodTo(spare);
        assertTrue(endow.isWhole(recipientId));
        _deposit(carol, recipientId, 5e18);
        assertEq(endow.principalOf(recipientId, carol), 5e18);
        // A tiny gift is all it takes to open a closed gate again.
        vm.revertToState(snapshot);
        _lossMadeGoodTo(0);
        vm.prank(stranger);
        endow.donate(recipientId, 5e6);
        assertTrue(endow.isWhole(recipientId));
    }

    /// @dev From the review (design rule E3, and what `isWhole` promises): while `isWhole(id)` is true
    /// and no hold is active, any part of a depositor's own principal is paid by `withdraw`. With no
    /// spare at all roughly every second amount below was refused by one wei.
    function test_spare_whileWhole_anyPartOfOnesPrincipalIsPaid() public {
        _lossMadeGoodTo(spare);
        assertTrue(endow.isWhole(recipientId));
        assertFalse(endow.vaultHold(), "setup: a hold is active");

        for (uint256 i = 0; i < 16; ++i) {
            uint256 amount = 1e18 + i;
            uint256 snapshot = vm.snapshotState();
            uint256 before = imd.balanceOf(alice);
            _withdraw(alice, recipientId, amount);
            assertEq(imd.balanceOf(alice), before + amount);
            assertGe(_cushion(recipientId), int256(spare) - 1);
            vm.revertToState(snapshot);
        }
    }

    /// @dev With nothing to spare, splitting the principal in two can cost a share-wei that is not
    /// there. Such a withdrawal must be refused: paying it in full would leave the other depositors a
    /// share-wei short. Every amount below is either paid exactly with the others still covered, or
    /// refused by `withdraw` and paid by `exit` to within three wei, again with the others covered.
    function test_spare_none_noWithdrawalLeavesTheOthersAShareWeiShort() public {
        _lossMadeGoodTo(0);
        // Two more IMD-wei of yield: still nothing to spare, but the need is no longer a hair under a
        // whole share-wei, so that some of the amounts below split without a remainder and some do not.
        _yield(2);
        assertEq(_cushion(recipientId), 0);
        assertFalse(endow.isWhole(recipientId));
        uint256 paid;
        uint256 refused;
        for (uint256 i = 0; i < 32; ++i) {
            uint256 amount = 1e18 + i;
            uint256 snapshot = vm.snapshotState();
            uint256 before = imd.balanceOf(alice);
            vm.prank(alice);
            try endow.withdraw(recipientId, amount) {
                ++paid;
                assertEq(imd.balanceOf(alice), before + amount);
            } catch (bytes memory reason) {
                ++refused;
                assertEq(bytes4(reason), Endowments.BelowMinimum.selector);
                vm.prank(alice);
                (uint256 out,) = endow.exit(recipientId, amount, amount - 3, false);
                assertLe(out, amount);
                assertEq(imd.balanceOf(alice), before + out);
            }
            assertGe(_cushion(recipientId), 0, "a withdrawal left the other depositors short");
            vm.revertToState(snapshot);
        }
        assertGt(paid, 0, "no amount was paid in full");
        assertGt(refused, 0, "no amount was refused");
    }

    /// @dev From the review: "a deposit the gate accepts comes back to the wei". An endowment that has
    /// only just enough to spare takes carol's deposit, it is staked (which costs the endowment up to
    /// two share-wei), and it still comes back exactly, as does everyone else's.
    ///
    /// Getting an endowment to that point with the price back at its mark takes a detour: a large
    /// depositor leaves at a loss and takes her part of the seed's shares with her, so that when the
    /// price has recovered the small depositor's endowment has only a sliver of spare left.
    function test_spare_aDepositTheGateAccepts_isStakedAndComesBackToTheWei() public {
        _deposit(alice, recipientId, 1_000_000e18);
        _deposit(bob, recipientId, 1e18);
        _stakeAndWait();
        _loseBps(1_000);
        vm.prank(alice);
        endow.exit(recipientId, 1_000_000e18, 0, false);

        // One share-wei short of the line: carol is refused.
        uint256 snapshot = vm.snapshotState();
        _recoverToSpare(recipientId, spare - 1);
        assertFalse(endow.priceBelowMark(), "setup: the price is not back at the mark");
        vm.prank(carol);
        vm.expectRevert(Endowments.EndowmentShort.selector);
        endow.deposit(recipientId, 5e18);
        vm.revertToState(snapshot);

        // Exactly on the line: carol is taken in, staked and paid back to the wei.
        _recoverToSpare(recipientId, spare);
        assertFalse(endow.priceBelowMark(), "setup: the price is not back at the mark");
        _deposit(carol, recipientId, 5e18);
        _stakeAndWait();
        assertFalse(endow.vaultHold(), "setup: a hold is active");
        assertEq(_buffered(recipientId), 0);
        assertGe(_cushion(recipientId), int256(spare) - 2, "a batch cost more than two share-wei");

        _withdraw(carol, recipientId, 2e18 + 1);
        _withdraw(carol, recipientId, 3e18 - 1);
        assertEq(imd.balanceOf(carol), WALLET, "carol's deposit did not come back to the wei");
        _withdraw(bob, recipientId, 1e18);
        assertEq(imd.balanceOf(bob), WALLET);
    }
}
