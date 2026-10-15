// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Endowments} from "../../src/endowments/Endowments.sol";
import {EndowmentsBase} from "./EndowmentsBase.sol";

/// @dev Edges of Endowments the other files do not pin: the exact arguments at the stake interval and
/// the pot-id boundary, the views outside their domain, one depositor's withdrawal paid with another's
/// fresh deposit and what that leaves behind, the fate of the creator's seed, and an endowment that
/// everybody has left.
contract EndowmentsEdgesTest is EndowmentsBase {
    // ------------------------------------------------------------------------- boundaries

    function test_stake_theIntervalIsCountedFromTheLastStakeBlock_toTheBlock() public {
        _deposit(alice, recipientId, 10e18);
        _stake();
        uint256 stakedAt = vm.getBlockNumber();
        assertEq(endow.lastStakeBlock(), stakedAt);
        assertEq(endow.nextStakeBlock(), stakedAt + interval);

        _deposit(bob, recipientId, 1e18);
        vm.roll(stakedAt + interval - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Endowments.TooSoon.selector, stakedAt + interval));
        endow.stake();

        vm.roll(stakedAt + interval);
        vm.prank(keeper);
        endow.stake();
        assertEq(endow.lastStakeBlock(), stakedAt + interval);
        assertEq(endow.epoch(), 3);
    }

    function test_createForPot_theNewestPotIsAccepted_theNextIdIsNot() public {
        uint256 newest = pots.potCount();
        pots.open(newest + 3, 5e18);
        newest += 3;
        vm.startPrank(creator);
        uint256 id = endow.createForPot(newest, heir);
        (Endowments.Kind kind, bytes32 target, address beneficiary,,,,) = endow.endowment(id);
        assertEq(uint8(kind), uint8(Endowments.Kind.Pot));
        assertEq(uint256(target), newest);
        assertEq(beneficiary, heir);

        vm.expectRevert(abi.encodeWithSelector(Endowments.UnknownPot.selector, newest + 1));
        endow.createForPot(newest + 1, heir);
        vm.expectRevert(abi.encodeWithSelector(Endowments.UnknownPot.selector, 0));
        endow.createForPot(0, heir);
        vm.stopPrank();
    }

    function test_views_answerZerosOutsideTheirDomain() public {
        _deposit(alice, recipientId, 10e18);
        uint256 principal = _principal(recipientId);

        (uint256 imdOut, uint256 sharesOut, bool exact) = endow.quote(recipientId, 0, false);
        assertEq(imdOut, 0);
        assertEq(sharesOut, 0);
        assertFalse(exact);
        (imdOut, sharesOut, exact) = endow.quote(recipientId, principal + 1, true);
        assertEq(imdOut, 0);
        assertEq(sharesOut, 0);
        assertFalse(exact);
        (imdOut, sharesOut, exact) = endow.quote(recipientId, principal, false);
        assertEq(imdOut, principal);
        assertTrue(exact);

        uint256 unknown = endow.endowmentCount() + 1;
        assertEq(endow.harvestable(unknown), 0);
        assertEq(endow.backingOf(unknown), 0);
        assertTrue(endow.isWhole(unknown));
        (imdOut, sharesOut, exact) = endow.quote(unknown, 1, false);
        assertEq(imdOut, 0);
        assertFalse(exact);
        (uint256 assets, uint256 shares) = endow.epochs(endow.epoch());
        assertEq(assets, 0, "an open epoch has no record yet");
        assertEq(shares, 0);
    }

    // ------------------------------------------------------------------------- the buffer is the endowment's

    /// @dev Alice's principal is staked; Bob's fresh deposit waits in the buffer. Alice's withdrawal is
    /// paid from Bob's IMD without touching the vault, and Bob's principal is then backed by the shares
    /// Alice's deposit bought. Bob gets his principal back to the wei from the vault.
    function test_withdraw_oneDepositorIsPaidWithAnothersFreshDeposit_andTheOtherIsBackedByShares() public {
        _deposit(alice, recipientId, 100e18);
        _stakeAndWait();
        uint256 sharesAfterAlice = _shares(recipientId);

        _deposit(bob, recipientId, 100e18);
        assertEq(_buffered(recipientId), 100e18);
        uint256 vaultImd = imd.balanceOf(address(simd));
        uint256 ourShares = simd.balanceOf(address(endow));

        _withdraw(alice, recipientId, 100e18);
        assertEq(imd.balanceOf(alice), WALLET, "alice short");
        assertEq(imd.balanceOf(address(simd)), vaultImd, "the vault was asked");
        assertEq(simd.balanceOf(address(endow)), ourShares, "shares moved");
        assertEq(_buffered(recipientId), 0);
        assertEq(endow.pendingTotal(), 0);
        assertEq(_principal(recipientId), 100e18);
        assertEq(_shares(recipientId), sharesAfterAlice);
        assertTrue(endow.isWhole(recipientId));

        // Nothing to stake: the buffer went to Alice.
        vm.roll(endow.nextStakeBlock());
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToStake.selector);
        endow.stake();

        _withdraw(bob, recipientId, 100e18);
        assertEq(imd.balanceOf(bob), WALLET, "bob short");
        assertEq(_principal(recipientId), 0);
        assertEq(endow.principalOf(recipientId, alice), 0);
        assertEq(endow.principalOf(recipientId, bob), 0);
        // What is left is the seed and the rounding cushion: nobody's, and headed for the recipient.
        assertGt(_shares(recipientId), 0);
        assertGt(simd.balanceOf(address(endow)), 0);
    }

    // ------------------------------------------------------------------------- the seed

    /// @dev The seed is paid by the creator, is nobody's principal, and is harvested to the target with
    /// the rest of the yield once there is enough of it. The creator cannot get it back.
    function test_seed_isNotRefundable_andIsHarvestedToTheTargetWithTheYield() public {
        uint256 donation = 2 * endow.MIN_HARVEST();
        vm.prank(creator);
        uint256 id = endow.createForRecipient(recipient);
        uint256 creatorAfterSeed = imd.balanceOf(creator);
        assertEq(_buffered(id), seed);
        assertEq(_principal(id), 0);

        vm.prank(stranger);
        endow.donate(id, donation);
        _stakeAndWait();
        assertEq(_principal(id), 0);

        uint256 expected = endow.harvestable(id);
        assertGt(expected, donation, "the seed is not part of the harvest");
        assertLt(expected, donation + seed, "the margin was not kept");
        vm.prank(keeper);
        uint256 paid = endow.harvest(id);
        assertEq(paid, expected);
        assertEq(imd.balanceOf(recipient), paid);
        assertEq(imd.balanceOf(creator), creatorAfterSeed, "the creator got something back");
        assertEq(_shares(id), margin, "exactly the margin stays");
        assertEq(endow.harvestable(id), 0);
    }

    // ------------------------------------------------------------------------- after everybody left

    function test_anEndowmentEverybodyLeft_isWhole_takesDepositsAgain_andIsExactAgain() public {
        _deposit(alice, potId, 50e18);
        _deposit(bob, potId, 25e18);
        _stakeAndWait();
        _yieldBps(100);
        _withdraw(alice, potId, 50e18);
        _withdraw(bob, potId, 25e18);
        assertEq(_principal(potId), 0);
        assertTrue(endow.isWhole(potId));
        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(imd.balanceOf(bob), WALLET);

        // The yield those deposits earned stays with the endowment and goes to the pot.
        uint256 before = imd.balanceOf(address(pots));
        vm.prank(keeper);
        uint256 paid = endow.harvest(potId);
        assertGt(paid, 0);
        assertEq(imd.balanceOf(address(pots)), before + paid);

        // A new depositor starts clean.
        _deposit(carol, potId, 7e18 + 3);
        _stakeAndWait();
        assertEq(_principal(potId), 7e18 + 3);
        _withdraw(carol, potId, 7e18 + 3);
        assertEq(imd.balanceOf(carol), WALLET);
        assertEq(_principal(potId), 0);
    }

    /// @dev Two withdrawals of the same depositor in one block, the second for the rest, are each exact.
    function testFuzz_withdraw_twoPiecesInOneBlockAreExact(uint256 first) public {
        uint256 total = 33e18 + 17;
        first = bound(first, 1, total - 1);
        _deposit(alice, meterId, total);
        _stakeAndWait();
        _withdraw(alice, meterId, first);
        assertEq(imd.balanceOf(alice), WALLET - total + first);
        _withdraw(alice, meterId, total - first);
        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(endow.principalOf(meterId, alice), 0);
        assertTrue(endow.isWhole(meterId));
    }
}
