// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Endowments} from "../../src/endowments/Endowments.sol";
import {EndowmentsBase} from "./EndowmentsBase.sol";
import {MockStakedIMD} from "./mocks/MockStakedIMD.sol";

/// @title The two findings of the launch audit, reproduced as they were reported
/// @notice IdentityMD's audit of this code as it arrived for launch C raised two low findings against
/// `Endowments` (`ADAPTATION.md`). Both are limits the design accepts and `docs/THREATS.md` records (E3,
/// E5, E12), and neither changed the code. Each is pinned here, step for step as the auditor wrote it,
/// so that the behaviour is on record and a later change to it is noticed.
contract EndowmentsAuditTest is EndowmentsBase {
    uint256 internal constant PRINCIPAL = 100e18;

    /// @dev Finding fb892c57: a stranger who deposits one IMD-wei into sIMD in this contract's name in
    /// every block keeps the vault's one-block hold on it for as long as they pay the gas. While it lasts
    /// `harvest` and an IMD withdrawal that needs the vault revert with the vault's own error, not
    /// `HoldActive`, which only reports this contract's own stake block. No principal is at risk: `exit`
    /// in kind works in every one of those blocks, and the first block without the deposit pays the
    /// yield and the principal as before. Kept as it is: the hold is sIMD's rule (THREATS.md E3).
    function test_audit_aStrangerCanHoldTheVaultEveryBlock_andOnlyTheInKindExitIsOpen() public {
        _deposit(alice, recipientId, PRINCIPAL);
        _stakeAndWait();
        _yieldBps(100);
        uint256 expected = endow.harvestable(recipientId);
        assertGt(expected, 0, "setup: nothing to harvest");
        assertFalse(endow.vaultHold(), "setup: no hold before the stranger acts");

        for (uint256 i = 0; i < 5; ++i) {
            _strangerDepositsInOurName();
            assertTrue(endow.vaultHold(), "the stranger's wei stamps this contract for the block");

            // `harvestable` does not look at the hold and still reports the yield.
            assertEq(endow.harvestable(recipientId), expected);
            vm.prank(keeper);
            vm.expectRevert(MockStakedIMD.RedeemMoreThanMax.selector);
            endow.harvest(recipientId);
            assertEq(_harvested(recipientId), 0, "no yield reached the recipient");

            vm.prank(alice);
            vm.expectRevert(MockStakedIMD.WithdrawMoreThanMax.selector);
            endow.withdraw(recipientId, 1e18);

            // The only door open in a held block: shares worth the principal, in any block.
            (uint256 imdOut, uint256 sharesOut, bool exact) = endow.quote(recipientId, 1e18, true);
            assertTrue(exact);
            assertEq(imdOut, 0);
            assertGt(sharesOut, 0);
            vm.prank(alice);
            (uint256 paidImd, uint256 paidShares) = endow.exit(recipientId, 1e18, 1e18, true);
            assertEq(paidImd, 0);
            assertEq(paidShares, sharesOut);
            assertGe(simd.convertToAssets(paidShares), 1e18, "the shares are worth the principal given up");

            _roll(1);
        }

        // The first block in which the stranger does not pay: everything flows again.
        assertFalse(endow.vaultHold());
        vm.prank(keeper);
        uint256 sent = endow.harvest(recipientId);
        // Five in-kind exits each rounded a share-wei against the endowment, and the stranger's wei
        // rounded for the vault; neither moves the harvest by more than a few IMD-wei.
        assertApproxEqAbs(sent, expected, 10);
        assertEq(imd.balanceOf(recipient), sent);

        uint256 left = endow.principalOf(recipientId, alice);
        assertEq(left, PRINCIPAL - 5e18);
        _withdraw(alice, recipientId, left);
        assertEq(imd.balanceOf(alice), WALLET - 5e18, "the rest of the principal comes back to the wei");
        _assertCovered(recipientId);
    }

    /// @dev Finding 04444071: a meter endowment's yield has one exit, `harvest` into the feed's meter,
    /// and that exit is shut while Questions states no cost for the feed (the Intake no longer sells its
    /// action, or asks more than the feed's cap). The yield that accrued before and after that moment
    /// stays staked in this contract, even once the last depositor has taken their principal, and
    /// nothing else can move it. It leaves only once the feed is sold again. Kept as it is: a meter
    /// endowment has no fallback by design, so that no address other than the feed's meter can ever be
    /// paid its yield (THREATS.md E5, E12; `ADAPTATION.md`).
    function test_audit_aMeterEndowmentsYieldWaitsForAsLongAsTheFeedIsNotSold() public {
        uint256 cost = questions.costOf(FEED);
        assertGt(cost, 0, "setup: the feed is priced at creation");
        _deposit(alice, meterId, PRINCIPAL);
        _stakeAndWait();
        _yieldBps(100);
        uint256 yield = endow.harvestable(meterId);
        assertApproxEqAbs(yield, 1e18, 1e13, "setup: about one IMD of yield");

        // The Intake stops selling the feed's action.
        questions.setCost(0);
        assertEq(endow.harvestable(meterId), 0);
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(meterId);

        // The principal is untouched by this: the last depositor leaves to the wei.
        _withdraw(alice, meterId, PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET);
        (,,, uint256 principal,, uint256 shares,) = endow.endowment(meterId);
        assertEq(principal, 0);
        assertGt(shares, 0);
        assertApproxEqAbs(simd.convertToAssets(shares), yield, 1e13, "the yield is still staked");

        // Nothing else can reach those shares: the yield waits, for as long as the feed is not sold.
        _roll(1_000);
        _yieldBps(100);
        assertEq(endow.harvestable(meterId), 0);
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(meterId);
        assertEq(questions.meterBalance(FEED), 0, "nothing reached the meter");

        // The one way out: the feed is sold again, and the next harvest sends the yield where the
        // endowment's creator fixed it.
        questions.setCost(cost);
        uint256 sent = endow.harvestable(meterId);
        assertGt(sent, yield);
        vm.prank(keeper);
        assertEq(endow.harvest(meterId), sent);
        assertEq(questions.meterBalance(FEED), sent);
    }
}
