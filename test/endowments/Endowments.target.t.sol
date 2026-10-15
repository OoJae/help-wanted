// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Endowments} from "../../src/endowments/Endowments.sol";
import {EndowmentsBase} from "./EndowmentsBase.sol";

/// @title A pot endowment whose pot already needs nothing when it is created
/// @notice IdentityMD's reviewers raised this before the launch (`docs/AUDITS.md`, row 6; `docs/THREATS.md`
/// E9, with E6). Of the pot, `createForPot` checks only that it exists. A pot that exists but already
/// needs nothing is accepted, where `createForMeter` refuses a feed Questions states no cost for. The
/// code was not changed for it. This test pins what it does.
contract EndowmentsTargetTest is EndowmentsBase {
    uint256 internal constant PRINCIPAL = 1_000e18;
    /// @dev A pot that exists and needs nothing. In CrowdPots (launch B) `remaining` is zero for a pot
    /// that is full, launched or out of time. Here a pot opened with nothing to collect stands for all three.
    uint256 internal constant DONE_POT = 11;

    /// @dev The pot is accepted and named as the target in `Created`, but it takes no chip. Every
    /// harvest goes to the fallback beneficiary. The depositor's principal is not touched.
    function test_createForPot_acceptsAPotThatNeedsNothing_andEveryHarvestGoesToTheFallback() public {
        pots.open(DONE_POT, 0);
        assertEq(pots.potCount(), DONE_POT, "setup: the pot exists");
        assertEq(pots.remaining(DONE_POT), 0, "setup: the pot needs nothing");

        // The matching case for a meter, a feed that cannot be asked, is refused.
        uint256 cost = questions.costOf(FEED);
        questions.setCost(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.FeedNotLive.selector, FEED));
        endow.createForMeter(FEED);
        questions.setCost(cost);

        // The pot is accepted, and `Created` names it as the target.
        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Created(4, Endowments.Kind.Pot, bytes32(DONE_POT), heir, alice);
        vm.prank(alice);
        uint256 id = endow.createForPot(DONE_POT, heir);
        (Endowments.Kind kind, bytes32 target, address beneficiary,,,,) = endow.endowment(id);
        assertEq(uint8(kind), uint8(Endowments.Kind.Pot));
        assertEq(uint256(target), DONE_POT);
        assertEq(beneficiary, heir);

        _deposit(bob, id, PRINCIPAL);
        _stakeAndWait();

        // Every harvest goes, whole, to the fallback beneficiary. The pot is offered it and takes nothing.
        uint256 paid = 0;
        for (uint256 i = 0; i < 2; ++i) {
            _yieldBps(100);
            uint256 yield = endow.harvestable(id);
            assertGt(yield, endow.MIN_HARVEST(), "setup: a yield worth harvesting");
            vm.expectEmit(true, true, true, true, address(endow));
            emit Endowments.FallbackPaid(id, heir, yield);
            vm.prank(keeper);
            assertEq(endow.harvest(id), yield);
            paid += yield;
            assertEq(imd.balanceOf(heir), paid, "the fallback beneficiary was paid the whole harvest");
            assertEq(pots.chipOf(DONE_POT, heir), 0, "no chip was made");
            assertEq(imd.balanceOf(address(pots)), 0, "the pot holds nothing");
        }
        assertEq(_harvested(id), paid);

        _withdraw(bob, id, PRINCIPAL);
        assertEq(imd.balanceOf(bob), WALLET, "the principal comes back to the wei");
    }
}
