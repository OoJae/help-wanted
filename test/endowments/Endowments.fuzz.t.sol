// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Endowments} from "../../src/endowments/Endowments.sol";
import {EndowmentsBase} from "./EndowmentsBase.sol";

/// @dev The arithmetic, for any amounts and any share price the fuzzer picks.
contract EndowmentsFuzzTest is EndowmentsBase {
    uint256 internal constant MAX_DEPOSIT = 4_000_000e18;

    /// @dev Deposit, stake, any yield from none to 20%, then take everything back in two pieces.
    function testFuzz_principalComesBackToTheWei(uint256 amount, uint256 yieldBps, uint256 firstPiece) public {
        amount = bound(amount, 1, MAX_DEPOSIT);
        yieldBps = bound(yieldBps, 0, 2_000);
        firstPiece = bound(firstPiece, 1, amount);

        _deposit(alice, recipientId, amount);
        _stakeAndWait();
        _yieldBps(yieldBps);

        _withdraw(alice, recipientId, firstPiece);
        assertEq(imd.balanceOf(alice), WALLET - amount + firstPiece);
        _assertCovered(recipientId);

        if (firstPiece < amount) _withdraw(alice, recipientId, amount - firstPiece);
        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(_principal(recipientId), 0);
        _assertCovered(recipientId);
    }

    /// @dev Three depositors over two batches, leaving in an order the fuzzer picks. Each one gets
    /// exactly their own money, whoever goes first.
    function testFuzz_everyDepositorGetsExactlyTheirOwn(uint256 a, uint256 b, uint256 c, uint256 order) public {
        a = bound(a, 1, MAX_DEPOSIT);
        b = bound(b, 1, MAX_DEPOSIT);
        c = bound(c, 1, MAX_DEPOSIT);

        _deposit(alice, recipientId, a);
        _deposit(bob, recipientId, b);
        _stakeAndWait();
        _deposit(carol, recipientId, c);
        _stakeAndWait();
        _assertCovered(recipientId);

        address[3] memory who = [alice, bob, carol];
        uint256[3] memory owed = [a, b, c];
        uint256 start = order % 3;
        for (uint256 i = 0; i < 3; ++i) {
            uint256 k = (start + i * (1 + (order / 3) % 2)) % 3;
            // Nobody can reach past their own principal into someone else's.
            vm.prank(who[k]);
            vm.expectRevert(abi.encodeWithSelector(Endowments.OverPrincipal.selector, owed[k]));
            endow.withdraw(recipientId, owed[k] + 1);

            _withdraw(who[k], recipientId, owed[k]);
            assertEq(imd.balanceOf(who[k]), WALLET);
            _assertCovered(recipientId);
        }
        assertEq(_principal(recipientId), 0);
    }

    /// @dev A batch is split between endowments rounded down: the parts never add up to more than was
    /// minted, the leftover is under one share-wei each, and every endowment still covers its principal.
    function testFuzz_batchSplitNeverExceedsWhatWasMinted(uint256 a, uint256 b, uint256 c) public {
        a = bound(a, 1, MAX_DEPOSIT);
        b = bound(b, 1, MAX_DEPOSIT);
        c = bound(c, 1, MAX_DEPOSIT);
        _deposit(alice, recipientId, a);
        _deposit(bob, meterId, b);
        _deposit(carol, potId, c);
        _stake();

        uint256 minted = simd.balanceOf(address(endow));
        uint256 booked = _shares(recipientId) + _shares(meterId) + _shares(potId);
        assertLe(booked, minted);
        assertLt(minted - booked, 3);
        _assertCovered(recipientId);
        _assertCovered(meterId);
        _assertCovered(potId);
    }

    /// @dev Whatever was earned, a harvest sends no more than the yield and leaves the principal covered
    /// and withdrawable in full.
    function testFuzz_harvestNeverTakesPrincipal(uint256 amount, uint256 yieldBps) public {
        amount = bound(amount, 1, MAX_DEPOSIT);
        yieldBps = bound(yieldBps, 0, 5_000);
        _deposit(alice, recipientId, amount);
        _stakeAndWait();

        uint256 assetsBefore = simd.totalAssets();
        _yieldBps(yieldBps);
        uint256 earned = (amount + seed) * (simd.totalAssets() - assetsBefore) / assetsBefore;

        uint256 expected = endow.harvestable(recipientId);
        if (expected == 0) {
            vm.prank(keeper);
            vm.expectRevert(Endowments.NothingToHarvest.selector);
            endow.harvest(recipientId);
        } else {
            vm.prank(keeper);
            endow.harvest(recipientId);
            assertEq(imd.balanceOf(recipient), expected);
            // The yield on the principal and on the seed, plus the seed itself, bounds what can leave.
            assertLe(expected, earned + seed + 1);
        }
        _assertCovered(recipientId);

        _withdraw(alice, recipientId, amount);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    /// @dev Many rounds with no yield at all. Rounding costs an endowment at most two share-wei per
    /// batch and one per withdrawal, which is what the margin is sized against, and every withdrawal on
    /// the way is still exact.
    function testFuzz_roundingWearIsBounded(uint256 seedA, uint8 rounds) public {
        rounds = uint8(bound(rounds, 1, 6));
        _deposit(bob, recipientId, 1e18);
        _stakeAndWait();
        int256 cushion = _cushion(recipientId);

        for (uint256 i = 0; i < rounds; ++i) {
            uint256 amount = bound(uint256(keccak256(abi.encode(seedA, i))), 1, MAX_DEPOSIT / 8);
            uint256 piece = bound(uint256(keccak256(abi.encode(seedA, i, "piece"))), 1, amount);
            _deposit(alice, recipientId, amount);
            _stakeAndWait();
            assertGe(_cushion(recipientId), cushion - 2, "batch cost more than two share-wei");
            cushion = _cushion(recipientId);

            _withdraw(alice, recipientId, piece);
            assertGe(_cushion(recipientId), cushion - 1, "withdrawal cost more than one share-wei");
            cushion = _cushion(recipientId);
            if (piece < amount) {
                _withdraw(alice, recipientId, amount - piece);
                assertGe(_cushion(recipientId), cushion - 1, "withdrawal cost more than one share-wei");
                cushion = _cushion(recipientId);
            }
            assertEq(imd.balanceOf(alice), WALLET);
        }
        assertGt(cushion, int256(margin));
        _withdraw(bob, recipientId, 1e18);
        assertEq(imd.balanceOf(bob), WALLET);
    }

    /// @dev Leaving in shares: they are worth the principal given up (and not a wei more at today's
    /// price), and what stays behind is still covered.
    function testFuzz_inKindExitIsWorthThePrincipal(uint256 a, uint256 b, uint256 yieldBps) public {
        a = bound(a, 1, MAX_DEPOSIT);
        b = bound(b, 1, MAX_DEPOSIT);
        yieldBps = bound(yieldBps, 0, 2_000);
        _deposit(alice, recipientId, a);
        _deposit(bob, recipientId, b);
        _stake();
        _yieldBps(yieldBps);

        // Still the stake block: IMD cannot come out of the vault, shares can change hands.
        vm.prank(alice);
        (uint256 imdOut, uint256 sharesOut) = endow.exit(recipientId, a, a, true);
        assertEq(imdOut, 0);
        uint256 worth = simd.convertToAssets(sharesOut);
        assertGe(worth, a);
        assertLe(worth, a + 1);
        _assertCovered(recipientId);

        _roll(1);
        _withdraw(bob, recipientId, b);
        assertEq(imd.balanceOf(bob), WALLET);
    }

    /// @dev `quote` is the same arithmetic as the real thing, whole or short.
    function testFuzz_quoteMatchesExit(uint256 a, uint256 take, uint256 lossBps, bool inKind) public {
        a = bound(a, 1e18, MAX_DEPOSIT);
        take = bound(take, 1, a);
        lossBps = bound(lossBps, 0, 9_000);
        _deposit(alice, recipientId, a);
        _stakeAndWait();
        _deposit(bob, recipientId, a / 3 + 1);
        _loseBps(lossBps);

        (uint256 quotedImd, uint256 quotedShares, bool exact) = endow.quote(recipientId, take, inKind);
        assertEq(exact, lossBps == 0);
        vm.prank(alice);
        (uint256 imdOut, uint256 sharesOut) = endow.exit(recipientId, take, 0, inKind);
        assertEq(imdOut, quotedImd);
        assertEq(sharesOut, quotedShares);
        if (exact && !inKind) assertEq(imdOut, take);
    }

    /// @dev After a fall in the share price two depositors who both leave are paid in proportion to
    /// what they put in, whoever goes first, and together no more than was there.
    function testFuzz_lossIsSharedInProportion(uint256 a, uint256 b, uint256 lossBps, bool bobFirst) public {
        a = bound(a, 1e18, MAX_DEPOSIT);
        b = bound(b, 1e18, MAX_DEPOSIT);
        lossBps = bound(lossBps, 1, 9_900);
        _deposit(alice, recipientId, a);
        _deposit(bob, recipientId, b);
        _stakeAndWait();
        _loseBps(lossBps);
        assertFalse(endow.isWhole(recipientId));
        uint256 backing = endow.backingOf(recipientId);

        (address first, uint256 firstOwed, address second, uint256 secondOwed) =
            bobFirst ? (bob, b, alice, a) : (alice, a, bob, b);
        vm.prank(first);
        (uint256 firstPaid,) = endow.exit(recipientId, firstOwed, 0, false);
        vm.prank(second);
        (uint256 secondPaid,) = endow.exit(recipientId, secondOwed, 0, false);

        assertLt(firstPaid, firstOwed);
        assertLt(secondPaid, secondOwed);
        assertLe(firstPaid + secondPaid, backing + 1);
        // Same fraction of what each was owed, to within rounding.
        assertApproxEqRel(firstPaid * 1e18 / firstOwed, secondPaid * 1e18 / secondOwed, 1e9);
        // Going first is no advantage: the one who waited did at least as well per IMD owed.
        assertGe((secondPaid + 1) * firstOwed, firstPaid * secondOwed);
    }

    /// @dev A pot endowment's harvest, for any principal, yield and need: a pot that needs something is
    /// sent that much and no more, with nothing to the fallback; a pot that needs nothing leaves the
    /// whole yield to the fallback. Either way principal stays covered and comes back to the wei.
    function testFuzz_potHarvestTakesOutNoMoreThanThePotNeeds(uint256 amount, uint256 yieldBps, uint256 needs) public {
        amount = bound(amount, 1e18, MAX_DEPOSIT);
        yieldBps = bound(yieldBps, 1, 2_000);
        _deposit(alice, potId, amount);
        _stakeAndWait();
        _yieldBps(yieldBps);

        // With a pot that could take anything, the view shows the whole yield.
        pots.open(POT, type(uint256).max);
        uint256 all = endow.harvestable(potId);
        needs = bound(needs, 0, 2 * all + 1);
        pots.open(POT, needs);

        if (all == 0) {
            vm.prank(keeper);
            vm.expectRevert(Endowments.NothingToHarvest.selector);
            endow.harvest(potId);
            return;
        }
        uint256 expected = endow.harvestable(potId);
        assertEq(expected, needs == 0 || needs >= all ? all : needs);

        vm.prank(keeper);
        uint256 sent = endow.harvest(potId);
        assertEq(sent, expected);
        if (needs == 0) {
            assertEq(imd.balanceOf(heir), all);
            assertEq(pots.chipOf(POT, heir), 0);
        } else {
            assertEq(imd.balanceOf(heir), 0);
            assertEq(pots.chipOf(POT, heir), sent);
            assertLe(sent, needs);
        }
        assertEq(imd.balanceOf(address(endow)), 0);
        assertEq(imd.allowance(address(endow), address(pots)), 0);
        _assertCovered(potId);
        assertGe(_cushion(potId), int256(margin));

        _withdraw(alice, potId, amount);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    /// @dev After a loss is made good to anywhere between no spare and twice `SPARE`: the endowment
    /// reads whole exactly from `SPARE` up, takes a deposit exactly when it reads whole, pays any part
    /// of a depositor's principal in full while it does, and never lets a withdrawal leave the others
    /// uncovered whether it does or not.
    function testFuzz_theGateOpensExactlyAtSpare_andWholeMeansPaidInFull(uint256 target, uint256 piece) public {
        target = bound(target, 0, 2 * spare);
        piece = bound(piece, 4, 2e18);
        _deposit(alice, recipientId, 2e18);
        _deposit(bob, recipientId, 1e18);
        _stakeAndWait();
        _loseBps(1_000);
        _recoverToSpare(recipientId, target);

        bool whole = endow.isWhole(recipientId);
        assertEq(whole, target >= spare);

        if (whole) {
            _deposit(carol, recipientId, 1e18);
            _withdraw(carol, recipientId, 1e18);
            assertEq(imd.balanceOf(carol), WALLET);
            _withdraw(alice, recipientId, piece);
            assertEq(imd.balanceOf(alice), WALLET - 2e18 + piece);
        } else {
            vm.prank(carol);
            vm.expectRevert(Endowments.EndowmentShort.selector);
            endow.deposit(recipientId, 1e18);

            vm.prank(alice);
            try endow.withdraw(recipientId, piece) {
                assertEq(imd.balanceOf(alice), WALLET - 2e18 + piece);
            } catch {
                // Refused only with nothing to spare at all, and then paid to within three wei.
                assertEq(target, 0);
                vm.prank(alice);
                (uint256 out,) = endow.exit(recipientId, piece, piece - 3, false);
                assertLe(out, piece);
            }
        }
        assertGe(_cushion(recipientId), 0, "a withdrawal left the other depositors uncovered");
    }

    /// @dev A deposit that never left the buffer comes back without the vault having any say, even when
    /// other endowments are staked and the vault has lost value.
    function testFuzz_unstakedEndowmentIsUntouchedByTheVault(uint256 amount, uint256 lossBps) public {
        amount = bound(amount, 1, MAX_DEPOSIT);
        lossBps = bound(lossBps, 0, 10_000);
        _deposit(bob, recipientId, 10e18);
        _stakeAndWait();

        vm.prank(creator);
        uint256 fresh = endow.createForRecipient(recipient);
        _deposit(alice, fresh, amount);
        _loseBps(lossBps);

        _withdraw(alice, fresh, amount);
        assertEq(imd.balanceOf(alice), WALLET);
    }
}
