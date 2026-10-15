// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {Endowments} from "../../src/endowments/Endowments.sol";
import {EndowmentsBase} from "./EndowmentsBase.sol";
import {MockCrowdPots} from "./mocks/MockCrowdPots.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockQuestions} from "./mocks/MockQuestions.sol";
import {MockStakedIMD} from "./mocks/MockStakedIMD.sol";

/// @dev Harvest: only yield leaves, and it reaches the target the endowment was created with.
contract EndowmentsHarvestTest is EndowmentsBase {
    uint256 internal constant PRINCIPAL = 1_000e18;
    uint256 internal constant SERIES = 9;

    /// @dev Alice endows `id` with 1,000 IMD, it is staked, and the vault then earns 1%.
    function _endowAndEarn(uint256 id) internal returns (uint256 harvestable) {
        _deposit(alice, id, PRINCIPAL);
        _stakeAndWait();
        _yieldBps(100);
        harvestable = endow.harvestable(id);
        // 1% of 1,000 IMD, less rounding and the margin, plus the seed's own crumbs.
        assertApproxEqAbs(harvestable, 10e18, 1e13);
    }

    /// @dev The whole yield of `id` as the contract counts it, before any cut to what a pot needs.
    function _yieldOf(uint256 id) internal view returns (uint256) {
        (,,, uint256 principal, uint256 buffered, uint256 shares,) = endow.endowment(id);
        uint256 keep = margin + (principal > buffered ? simd.previewWithdraw(principal - buffered) : 0);
        return shares > keep ? simd.previewRedeem(shares - keep) : 0;
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

    // ------------------------------------------------------------------------------------ recipient

    function test_harvest_sendsOnlyTheYieldToTheRecipient() public {
        uint256 expected = _endowAndEarn(recipientId);
        uint256 shares = _shares(recipientId);
        uint256 keep = margin + simd.previewWithdraw(PRINCIPAL);

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Harvested(recipientId, keeper, shares - keep, expected);
        vm.prank(keeper);
        uint256 sent = endow.harvest(recipientId);

        assertEq(sent, expected);
        assertEq(imd.balanceOf(recipient), expected);
        assertEq(_harvested(recipientId), expected);
        assertEq(_shares(recipientId), keep);
        assertEq(_principal(recipientId), PRINCIPAL);
        assertEq(imd.balanceOf(address(endow)), 0);
        _assertCovered(recipientId);
        // The margin is left on top of what the principal needs. A few share-wei more in practice: the
        // redemption rounded for the vault, and this endowment owns a little of the vault.
        assertGe(_cushion(recipientId), int256(margin));
        assertLe(_cushion(recipientId), int256(margin) + 1_000);
    }

    function test_harvest_thenThePrincipalStillComesBackToTheWei() public {
        _endowAndEarn(recipientId);
        vm.prank(keeper);
        endow.harvest(recipientId);

        _withdraw(alice, recipientId, PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(_principal(recipientId), 0);
    }

    function test_harvest_twiceInARow_theSecondFindsNothing() public {
        _endowAndEarn(recipientId);
        vm.startPrank(keeper);
        endow.harvest(recipientId);
        assertEq(endow.harvestable(recipientId), 0);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(recipientId);
        vm.stopPrank();
    }

    function test_harvest_anyoneMayCall_andTheCallerGetsNothing() public {
        uint256 expected = _endowAndEarn(recipientId);
        uint256 before = imd.balanceOf(stranger);
        vm.prank(stranger);
        endow.harvest(recipientId);
        assertEq(imd.balanceOf(stranger), before);
        assertEq(imd.balanceOf(recipient), expected);
    }

    /// @dev The gas reserve is for the pot call only; other targets are not asked for it.
    function test_harvest_recipientAndMeterNeedNoGasReserve() public {
        uint256 expected = _endowAndEarn(recipientId);
        vm.prank(keeper);
        endow.harvest{gas: 300_000}(recipientId);
        assertEq(imd.balanceOf(recipient), expected);
    }

    function test_harvest_revertsWhenNothingWasEarned() public {
        _deposit(alice, recipientId, PRINCIPAL);
        _stakeAndWait();
        assertEq(endow.harvestable(recipientId), 0);
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(recipientId);
    }

    function test_harvest_revertsBelowTheMinimum() public {
        _deposit(alice, recipientId, PRINCIPAL);
        _stakeAndWait();
        // Enough yield to be worth something, not enough to be worth a harvest.
        _yield(simd.totalAssets() / 10_000_000);
        assertEq(endow.harvestable(recipientId), 0);
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(recipientId);
    }

    function test_harvest_revertsOnUnknownEndowment() public {
        vm.prank(keeper);
        vm.expectRevert(Endowments.UnknownEndowment.selector);
        endow.harvest(55);
    }

    function test_harvest_revertsInAStakeBlock() public {
        _endowAndEarn(recipientId);
        _deposit(bob, meterId, 1e18);
        _stake();
        vm.prank(keeper);
        vm.expectRevert(Endowments.HoldActive.selector);
        endow.harvest(recipientId);

        _roll(1);
        vm.prank(keeper);
        endow.harvest(recipientId);
    }

    /// @dev A hold someone else caused stops a harvest for that block, with the vault's own error. There
    /// is no way round it for a harvest (a depositor has `exit` in kind); it ends with the block.
    function test_harvest_whenSomeoneElseCausesAHold_failsWithTheVaultsError_forThatBlockOnly() public {
        uint256 expected = _endowAndEarn(recipientId);
        _strangerDepositsInOurName();

        vm.prank(keeper);
        vm.expectRevert(MockStakedIMD.RedeemMoreThanMax.selector);
        endow.harvest(recipientId);
        assertEq(_harvested(recipientId), 0);

        _roll(1);
        vm.prank(keeper);
        // The stranger's wei rounded for the vault, which can move the amount by a wei.
        assertApproxEqAbs(endow.harvest(recipientId), expected, 2);
    }

    function test_harvest_leavesBufferedPrincipalAlone() public {
        uint256 expected = _endowAndEarn(recipientId);
        _deposit(bob, recipientId, 500e18);
        assertEq(endow.harvestable(recipientId), expected);

        vm.prank(keeper);
        endow.harvest(recipientId);
        assertEq(imd.balanceOf(recipient), expected);
        assertEq(_buffered(recipientId), 500e18);
        _assertCovered(recipientId);

        _withdraw(bob, recipientId, 500e18);
        _withdraw(alice, recipientId, PRINCIPAL);
        assertEq(imd.balanceOf(bob), WALLET);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    function test_harvest_aDonationIsPaidOutAsYield() public {
        vm.prank(bob);
        endow.donate(recipientId, 5e18);
        _stakeAndWait();

        uint256 expected = endow.harvestable(recipientId);
        assertApproxEqAbs(expected, 5e18 + seed, 1e8);
        vm.prank(keeper);
        endow.harvest(recipientId);
        assertEq(imd.balanceOf(recipient), expected);
    }

    function test_harvest_twoEndowmentsWithTheSamePrincipalEarnTheSame() public {
        _deposit(alice, recipientId, PRINCIPAL);
        _deposit(bob, meterId, PRINCIPAL);
        _stakeAndWait();
        // Little enough that the meter has room for all of it.
        _yieldBps(100);
        assertApproxEqAbs(endow.harvestable(recipientId), endow.harvestable(meterId), 1);
        assertApproxEqAbs(endow.harvestable(recipientId), 10e18, 1e13);
    }

    /// @dev A harvest records sIMD's price if it is the highest seen so far.
    function test_harvest_recordsTheHighestPriceSeen() public {
        _endowAndEarn(recipientId);
        uint256 atStake = endow.priceMark();
        uint256 price = simd.convertToAssets(1e24);
        assertGt(price, atStake);

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.PriceMarked(price);
        vm.prank(keeper);
        endow.harvest(recipientId);
        assertEq(endow.priceMark(), price);
    }

    function test_harvest_revertsIfTheVaultPaysShort() public {
        _endowAndEarn(recipientId);
        simd.setFault(MockStakedIMD.Fault.PaysShort);
        vm.prank(keeper);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.harvest(recipientId);
    }

    function test_harvest_revertsIfTheVaultReportsLessThanItPreviewed() public {
        _endowAndEarn(recipientId);
        simd.setFault(MockStakedIMD.Fault.ReportsWrong);
        vm.prank(keeper);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.harvest(recipientId);
    }

    /// @dev The vault reports and pays exactly what it previewed but burns one share more. Only the
    /// check of this contract's own share balance can see that; without it the endowments' books would
    /// claim a share the contract no longer holds.
    function test_harvest_revertsIfTheVaultBurnsMoreThanItSaid() public {
        _endowAndEarn(recipientId);
        simd.setFault(MockStakedIMD.Fault.BurnsQuietly);
        vm.prank(keeper);
        vm.expectRevert(Endowments.VaultMismatch.selector);
        endow.harvest(recipientId);
    }

    // ------------------------------------------------------------------------------------ meter

    function test_harvest_meter_fundsTheFeedsMeter() public {
        uint256 expected = _endowAndEarn(meterId);

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.MeterFunded(meterId, FEED, expected, expected);
        vm.prank(keeper);
        endow.harvest(meterId);

        assertEq(questions.meterBalance(FEED), expected);
        assertEq(imd.balanceOf(address(questions)), expected);
        assertEq(questions.sharesOf(FEED, address(endow)), expected);
        assertEq(imd.allowance(address(endow), address(questions)), 0);
        assertEq(imd.balanceOf(address(endow)), 0);
        _assertCovered(meterId);
    }

    function test_harvest_meter_ifFundRevertsTheYieldStaysStaked() public {
        uint256 expected = _endowAndEarn(meterId);
        uint256 sharesBefore = _shares(meterId);
        questions.setMode(MockQuestions.Mode.Reverts);

        vm.prank(keeper);
        vm.expectRevert(MockQuestions.Refused.selector);
        endow.harvest(meterId);

        assertEq(_shares(meterId), sharesBefore);
        assertEq(endow.harvestable(meterId), expected);
        assertEq(_harvested(meterId), 0);

        // Principal does not depend on the meter working.
        _withdraw(alice, meterId, PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET);

        // And the yield is still there for when it does.
        questions.setMode(MockQuestions.Mode.Normal);
        vm.prank(keeper);
        endow.harvest(meterId);
        assertApproxEqAbs(questions.meterBalance(FEED), expected, 2);
    }

    /// @dev Creation refuses an id that is not a feed (see the create tests). If Questions stopped
    /// knowing the feed later all the same, which the real one cannot do, it would state no cost for
    /// it: the meter then has no room, nothing is harvested, the yield waits and the principal still
    /// leaves in full.
    function test_harvest_meter_ifTheFeedWereEverUnknownTheYieldStaysStaked() public {
        _endowAndEarn(meterId);
        questions.forgetFeed(FEED);
        assertEq(endow.harvestable(meterId), 0);
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(meterId);
        _withdraw(alice, meterId, PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    function test_harvest_meter_revertsIfTheMeterPullsLessThanItWasSent() public {
        _endowAndEarn(meterId);
        questions.setMode(MockQuestions.Mode.TakesLess);
        vm.prank(keeper);
        vm.expectRevert(Endowments.TargetMismatch.selector);
        endow.harvest(meterId);
    }

    function test_harvest_meter_aCallBackIntoEndowmentsIsRefused() public {
        uint256 expected = _endowAndEarn(meterId);
        questions.setMode(MockQuestions.Mode.CallsBack);
        questions.setCallback(abi.encodeCall(Endowments.harvest, (meterId)));

        vm.prank(keeper);
        endow.harvest(meterId);

        assertFalse(questions.callbackSucceeded());
        assertEq(
            questions.callbackResult(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(questions.meterBalance(FEED), expected);
    }

    // ------------------------------------------------------------------------------------ meter runway

    /// @dev What thirty requests cost the feed's meter in these tests: 30 x 0.51 IMD.
    uint256 internal constant RUNWAY = 15.3e18;

    /// @dev Alice endows the meter with 10,000 IMD, it is staked, and the vault earns 1%: about 100 IMD
    /// of yield, several runways' worth.
    function _endowMeterRichly() internal returns (uint256 yield) {
        _deposit(alice, meterId, 10 * PRINCIPAL);
        _stakeAndWait();
        _yieldBps(100);
        yield = _yieldOf(meterId);
        assertApproxEqAbs(yield, 100e18, 1e14);
    }

    function test_runway_isThirtyRequests() public view {
        assertEq(endow.METER_RUNWAY(), 30);
        assertEq(questions.cost() * endow.METER_RUNWAY(), RUNWAY);
    }

    /// @dev The yield is worth far more than thirty requests. The harvest tops the meter up to exactly
    /// thirty requests and the rest stays staked: no IMD is left in this contract, the endowment keeps
    /// the shares, and its depositors are covered by more than before.
    function test_runway_aHarvestFillsTheMeterToThirtyRequestsAndNoFurther() public {
        uint256 yield = _endowMeterRichly();
        assertEq(endow.harvestable(meterId), RUNWAY);
        uint256 sharesBefore = _shares(meterId);

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Harvested(meterId, keeper, simd.previewWithdraw(RUNWAY), RUNWAY);
        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.MeterFunded(meterId, FEED, RUNWAY, RUNWAY);
        vm.prank(keeper);
        uint256 sent = endow.harvest(meterId);

        assertEq(sent, RUNWAY);
        assertEq(questions.meterBalance(FEED), RUNWAY, "the meter holds exactly thirty requests");
        assertEq(_harvested(meterId), RUNWAY);
        assertEq(_shares(meterId), sharesBefore - simd.previewWithdraw(RUNWAY));
        assertEq(imd.balanceOf(address(endow)), 0, "nothing is left lying in the contract");
        assertEq(imd.allowance(address(endow), address(questions)), 0);
        // The rest of the yield is still the endowment's, staked.
        assertApproxEqAbs(_yieldOf(meterId), yield - RUNWAY, 2);
        assertGt(_cushion(meterId), int256(margin) + int256(simd.previewDeposit(80e18)));
        _assertCovered(meterId);
    }

    /// @dev A full meter takes nothing, however much yield is waiting. When a request has been bought,
    /// the next harvest replaces exactly what was spent.
    function test_runway_aFullMeterWaitsUntilARequestIsBought() public {
        _endowMeterRichly();
        vm.startPrank(keeper);
        endow.harvest(meterId);

        assertEq(endow.harvestable(meterId), 0);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(meterId);

        questions.spend(FEED, 0.51e18);
        assertEq(endow.harvestable(meterId), 0.51e18);
        assertEq(endow.harvest(meterId), 0.51e18);
        assertEq(questions.meterBalance(FEED), RUNWAY);

        // Three requests later, the same again.
        questions.spend(FEED, 3 * 0.51e18);
        assertEq(endow.harvest(meterId), 3 * 0.51e18);
        assertEq(questions.meterBalance(FEED), RUNWAY);
        vm.stopPrank();
        assertEq(_harvested(meterId), RUNWAY + 4 * 0.51e18);
    }

    /// @dev The line itself. With room for exactly the yield, all of it goes and by the share count,
    /// as before. With room for one wei less, the harvest is that one wei smaller.
    function test_runway_atTheLine_roomForAllOfItAndRoomForOneWeiLess() public {
        _deposit(alice, meterId, PRINCIPAL);
        _stakeAndWait();
        _yieldBps(100);
        uint256 yield = _yieldOf(meterId); // about 10 IMD, under the runway
        vm.prank(stranger);
        imd.approve(address(questions), type(uint256).max);

        // Somebody else holds part of the meter, leaving room for exactly the yield.
        vm.prank(stranger);
        questions.fund(FEED, RUNWAY - yield);
        assertEq(endow.harvestable(meterId), yield);
        uint256 snapshot = vm.snapshotState();
        vm.prank(keeper);
        assertEq(endow.harvest(meterId), yield);
        assertEq(questions.meterBalance(FEED), RUNWAY);
        assertEq(_cushion(meterId) / 1_000, int256(margin) / 1_000, "all of the yield left: only the margin stays");
        vm.revertToState(snapshot);

        // One wei more on the meter: room for one wei less than the yield.
        vm.prank(stranger);
        questions.fund(FEED, 1);
        assertEq(endow.harvestable(meterId), yield - 1);
        vm.prank(keeper);
        assertEq(endow.harvest(meterId), yield - 1);
        assertEq(questions.meterBalance(FEED), RUNWAY, "never a wei above the runway");
        _assertCovered(meterId);
    }

    /// @dev Room for less than the smallest harvest is no room: the yield waits. Room for exactly the
    /// smallest harvest is taken.
    function test_runway_roomBelowTheSmallestHarvestIsNotTaken() public {
        _endowMeterRichly();
        uint256 least = endow.MIN_HARVEST();
        vm.startPrank(stranger);
        imd.approve(address(questions), type(uint256).max);
        questions.fund(FEED, RUNWAY - least + 1);
        vm.stopPrank();

        assertEq(endow.harvestable(meterId), 0);
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(meterId);

        questions.spend(FEED, 1);
        assertEq(endow.harvestable(meterId), least);
        vm.prank(keeper);
        assertEq(endow.harvest(meterId), least);
        assertEq(questions.meterBalance(FEED), RUNWAY);
    }

    /// @dev Anyone may fund a meter. One that somebody else has filled, or overfilled, takes nothing
    /// from the endowment, whose yield stays staked; its depositors still leave with every wei.
    function test_runway_aMeterSomeoneElseFilledTakesNothing() public {
        uint256 yield = _endowMeterRichly();
        vm.startPrank(stranger);
        imd.approve(address(questions), type(uint256).max);
        questions.fund(FEED, RUNWAY + 40e18);
        vm.stopPrank();

        assertEq(endow.harvestable(meterId), 0);
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(meterId);
        assertEq(_harvested(meterId), 0);
        assertEq(_yieldOf(meterId), yield);

        _withdraw(alice, meterId, 10 * PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    /// @dev The room on a meter is read from the meter's whole balance, which anyone can raise and
    /// lower. A stranger who funds the meter to its runway around somebody else's harvest, and takes
    /// the IMD back after it, makes that harvest send nothing (or less); the yield stays staked and
    /// the next harvest sends it. Nothing is lost and nothing reaches the stranger, who pays the
    /// meter's rounding and the gas. Sizing from the endowment's own meter shares instead would let
    /// several endowments, or other funders, lift a meter past the runway the rule exists to keep.
    function test_runway_aFundAndDefundAroundAHarvestOnlyDelaysTheYield() public {
        uint256 yield = _endowMeterRichly();
        uint256 strangerBefore = imd.balanceOf(stranger);
        vm.startPrank(stranger);
        imd.approve(address(questions), type(uint256).max);
        uint256 shares = questions.fund(FEED, RUNWAY);
        vm.stopPrank();

        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(meterId);
        vm.prank(stranger);
        questions.defund(FEED, shares);
        assertLe(imd.balanceOf(stranger), strangerBefore, "the stranger gains nothing");
        assertEq(_yieldOf(meterId), yield, "the yield is all still staked");

        vm.prank(keeper);
        assertEq(endow.harvest(meterId), RUNWAY, "the next harvest sends it");
        assertEq(questions.meterBalance(FEED), RUNWAY);
        _withdraw(alice, meterId, 10 * PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    /// @dev A harvest sends a recipient endowment's yield to the recipient whoever calls it, and that
    /// includes a contract that has no way to move IMD on: its creator chose it, and nothing in this
    /// contract can tell. The depositors' principal is not touched; the yield is the recipient's.
    function test_harvest_paysARecipientContractThatCannotMoveIMD_becauseItsCreatorChoseIt() public {
        MockCrowdPots holdsForever = new MockCrowdPots(address(imd));
        vm.prank(creator);
        uint256 id = endow.createForRecipient(address(holdsForever));
        _deposit(alice, id, PRINCIPAL);
        _stakeAndWait();
        _yieldBps(100);
        uint256 yield = endow.harvestable(id);
        assertGt(yield, 0);
        vm.prank(stranger);
        assertEq(endow.harvest(id), yield);
        assertEq(imd.balanceOf(address(holdsForever)), yield, "the yield sits with the recipient the creator named");
        _withdraw(alice, id, PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET, "the principal came back to the wei");
    }

    /// @dev The runway is counted at the feed's cost today. A dearer request makes room; a cheaper one
    /// takes it away; and while Questions states no cost at all (the Intake is not selling, or asks more
    /// than the feed allows) there is none.
    function test_runway_followsTheFeedsCost() public {
        _endowMeterRichly();
        vm.startPrank(keeper);
        endow.harvest(meterId);
        assertEq(questions.meterBalance(FEED), RUNWAY);

        questions.setCost(0.61e18);
        assertEq(endow.harvestable(meterId), 3e18);
        assertEq(endow.harvest(meterId), 3e18);
        assertEq(questions.meterBalance(FEED), 30 * 0.61e18);

        questions.setCost(0.51e18);
        assertEq(endow.harvestable(meterId), 0);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(meterId);

        questions.spend(FEED, 10e18);
        questions.setCost(0);
        assertEq(endow.harvestable(meterId), 0, "a meter that cannot spend is not topped up");
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(meterId);

        questions.setCost(0.51e18);
        assertEq(endow.harvest(meterId), RUNWAY - (30 * 0.61e18 - 10e18));
        assertEq(questions.meterBalance(FEED), RUNWAY);
        vm.stopPrank();
    }

    /// @dev A cost so large that thirty of them do not fit a word is still only a very large runway.
    function test_runway_anAbsurdCostDoesNotOverflow() public {
        uint256 yield = _endowMeterRichly();
        questions.setCost(type(uint256).max / 7);
        assertEq(endow.harvestable(meterId), yield);
        vm.prank(keeper);
        assertEq(endow.harvest(meterId), yield);
    }

    /// @dev If Questions cannot be read, a meter harvest reverts with whatever Questions said and the
    /// yield stays staked. Nothing else depends on it: principal leaves in full, and so does the yield
    /// of other endowments.
    function test_runway_ifQuestionsCannotBeReadTheYieldStaysStaked() public {
        _endowMeterRichly();
        _deposit(bob, recipientId, PRINCIPAL);
        questions.setViewsRevert(true);

        vm.expectRevert(MockQuestions.Refused.selector);
        endow.harvestable(meterId);
        vm.prank(keeper);
        vm.expectRevert(MockQuestions.Refused.selector);
        endow.harvest(meterId);
        assertEq(_harvested(meterId), 0);

        assertTrue(endow.isWhole(meterId));
        (,,, uint256 principal,,,) = endow.endowment(meterId);
        assertEq(principal, 10 * PRINCIPAL);
        _withdraw(alice, meterId, 10 * PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET);
        _withdraw(bob, recipientId, PRINCIPAL);

        questions.setViewsRevert(false);
        vm.prank(keeper);
        assertEq(endow.harvest(meterId), RUNWAY);
    }

    /// @dev The runway is a rule for meters only. A recipient endowment with the same yield sends all
    /// of it, whatever any meter holds.
    function test_runway_doesNotApplyToOtherKinds() public {
        _deposit(alice, recipientId, 10 * PRINCIPAL);
        _stakeAndWait();
        _yieldBps(100);
        uint256 yield = _yieldOf(recipientId);
        assertGt(yield, RUNWAY);
        vm.prank(keeper);
        assertEq(endow.harvest(recipientId), yield);
    }

    /// @dev After a partial harvest the principal still comes back to the wei, in pieces.
    function test_runway_afterAPartialHarvestThePrincipalComesBackToTheWei() public {
        _endowMeterRichly();
        _deposit(bob, meterId, 777e18 + 1);
        _stakeAndWait();
        vm.prank(keeper);
        endow.harvest(meterId);

        _withdraw(alice, meterId, 1);
        _withdraw(bob, meterId, 777e18 + 1);
        _withdraw(alice, meterId, 10 * PRINCIPAL - 1);
        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(imd.balanceOf(bob), WALLET);
        assertEq(_principal(meterId), 0);
        assertTrue(endow.isWhole(meterId));
    }

    /// @dev Any principal, yield, cost and earlier meter balance: a harvest sends the lesser of the yield
    /// and the room, the meter never ends above thirty requests unless it was there already, and the
    /// endowment stays whole with at least the margin to spare.
    function testFuzz_runway_neverLiftsTheMeterAboveThirtyRequests(
        uint256 principal,
        uint256 yieldBps,
        uint256 cost,
        uint256 alreadyOnTheMeter
    ) public {
        principal = bound(principal, 1e18, 5_000_000e18);
        yieldBps = bound(yieldBps, 1, 2_000);
        cost = bound(cost, 0, 4e18);
        alreadyOnTheMeter = bound(alreadyOnTheMeter, 0, 200e18);

        _deposit(alice, meterId, principal);
        _stakeAndWait();
        _yieldBps(yieldBps);
        questions.setCost(cost);
        if (alreadyOnTheMeter != 0) {
            vm.startPrank(stranger);
            imd.approve(address(questions), alreadyOnTheMeter);
            questions.fund(FEED, alreadyOnTheMeter);
            vm.stopPrank();
        }

        uint256 yield = _yieldOf(meterId);
        uint256 full = cost * 30;
        uint256 room = full > alreadyOnTheMeter ? full - alreadyOnTheMeter : 0;
        uint256 least = endow.MIN_HARVEST();
        uint256 expected = yield < least || room < least ? 0 : (yield < room ? yield : room);
        assertEq(endow.harvestable(meterId), expected);

        vm.prank(keeper);
        if (expected == 0) {
            vm.expectRevert(Endowments.NothingToHarvest.selector);
            endow.harvest(meterId);
            return;
        }
        assertEq(endow.harvest(meterId), expected);
        assertEq(questions.meterBalance(FEED), alreadyOnTheMeter + expected);
        assertLe(questions.meterBalance(FEED), full > alreadyOnTheMeter ? full : alreadyOnTheMeter);
        assertEq(imd.balanceOf(address(endow)), 0);
        assertGe(_cushion(meterId), int256(margin));
        _assertCovered(meterId);

        _withdraw(alice, meterId, principal);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    // ------------------------------------------------------------------------------------ pot

    function test_harvest_pot_chipsInForTheFallbackBeneficiary() public {
        uint256 expected = _endowAndEarn(potId);

        vm.prank(keeper);
        endow.harvest(potId);

        assertEq(pots.chipOf(POT, heir), expected);
        assertEq(pots.remaining(POT), POT_NEEDS - expected);
        assertEq(imd.balanceOf(address(pots)), expected);
        assertEq(imd.balanceOf(heir), 0);
        assertEq(imd.allowance(address(endow), address(pots)), 0);
        assertEq(imd.balanceOf(address(endow)), 0);
        _assertCovered(potId);
    }

    /// @dev From the review: a harvest used to offer the pot everything and send whatever it did not
    /// need to the fallback beneficiary, so whoever chipped in just before a harvest decided how much
    /// of the yield reached the pot. Now a pot that needs something is sent no more than it needs, and
    /// the rest stays staked. Only once the pot takes nothing at all does the fallback get the yield.
    function test_harvest_pot_takesOutOnlyWhatThePotStillNeeds_andTheRestStaysStaked() public {
        uint256 all = _endowAndEarn(potId);
        pots.open(POT, 4e18);
        assertEq(endow.harvestable(potId), 4e18);
        uint256 sharesBefore = _shares(potId);
        uint256 cost = simd.previewWithdraw(4e18);

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Harvested(potId, keeper, cost, 4e18);
        vm.prank(keeper);
        uint256 sent = endow.harvest(potId);

        assertEq(sent, 4e18);
        assertEq(pots.chipOf(POT, heir), 4e18);
        assertEq(imd.balanceOf(heir), 0, "the fallback was paid although the pot took everything it was sent");
        assertEq(_shares(potId), sharesBefore - cost);
        assertEq(_harvested(potId), 4e18);
        assertEq(imd.allowance(address(endow), address(pots)), 0);
        assertEq(imd.balanceOf(address(endow)), 0);
        _assertCovered(potId);
        assertGe(_cushion(potId), int256(margin));

        // The pot is full now and takes no more chips: what stayed staked goes to the fallback.
        uint256 rest = endow.harvestable(potId);
        assertApproxEqAbs(rest, all - 4e18, 2);
        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.FallbackPaid(potId, heir, rest);
        vm.prank(keeper);
        endow.harvest(potId);
        assertEq(imd.balanceOf(heir), rest);
        assertEq(pots.chipOf(POT, heir), 4e18);
        assertEq(imd.allowance(address(endow), address(pots)), 0);
        assertEq(_harvested(potId), 4e18 + rest);
        _assertCovered(potId);

        _withdraw(alice, potId, PRINCIPAL);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    /// @dev A series always needs something: its current round's rest, or a whole new round. So its
    /// endowment's yield funds round after round, and the fallback beneficiary is never paid directly.
    function test_harvest_pot_aSeriesIsFundedRoundAfterRound() public {
        pots.openSeries(SERIES, 6e18);
        // Opening a round costs the real CrowdPots about 240,000 gas; the mock burns as much.
        pots.setRoundCost(240_000);
        vm.prank(creator);
        uint256 id = endow.createForPot(SERIES, heir);
        _deposit(alice, id, PRINCIPAL);
        _stakeAndWait();
        _yieldBps(100);
        uint256 all = _yieldOf(id);
        assertApproxEqAbs(all, 10e18, 1e13);

        assertEq(endow.harvestable(id), 6e18);
        vm.prank(keeper);
        assertEq(endow.harvest(id), 6e18);
        assertEq(pots.rounds(SERIES), 1);
        assertEq(pots.chipOf(SERIES, heir), 6e18);
        assertEq(imd.balanceOf(heir), 0);

        // The first round is full; the next chip opens the second, which takes what stayed staked.
        uint256 rest = endow.harvestable(id);
        assertApproxEqAbs(rest, all - 6e18, 2);
        vm.prank(keeper);
        assertEq(endow.harvest(id), rest);
        assertEq(pots.rounds(SERIES), 2);
        assertEq(pots.chipOf(SERIES, heir), 6e18 + rest);
        assertEq(pots.remaining(SERIES), 6e18 - rest);
        assertEq(imd.balanceOf(heir), 0, "a series' yield went to the fallback");
        assertEq(imd.balanceOf(address(endow)), 0);
        _assertCovered(id);
    }

    /// @dev The contract's sizes assume a share-wei is worth less than an IMD-wei. Here the vault is put
    /// where one share-wei is worth about 10,000 IMD-wei, far beyond anything sIMD's price is expected to
    /// reach, to show what still holds there: the seed is then too small to count as spare, so the
    /// endowment takes no second deposit until it has earned something, but a pot is still sent exactly
    /// what it needs with not a wei left behind in this contract, and principal still comes back to the wei.
    function test_harvest_pot_whenAShareWeiIsWorthThousandsOfImdWei_theAmountsAreStillExact() public {
        MockIMD token = new MockIMD();
        MockStakedIMD vault = new MockStakedIMD(address(token));
        vault.seed(whale, 1e20);
        token.mint(address(vault), 1e24);
        assertEq(vault.convertToAssets(1), 9_999);
        MockCrowdPots somePots = new MockCrowdPots(address(token));
        somePots.open(1, 1_000_000e18);
        Endowments other = new Endowments(address(token), address(vault), address(questions), address(somePots));

        token.mint(alice, 2_000_000e18);
        vm.startPrank(alice);
        token.approve(address(other), type(uint256).max);
        uint256 id = other.createForPot(1, heir);
        other.deposit(id, 1_000_000e18);
        other.stake();
        vm.stopPrank();
        _roll(1);
        // Covered, but the seed bought far fewer than `SPARE` share-wei.
        assertGe(other.backingOf(id), 1_000_000e18);
        assertFalse(other.isWhole(id));

        token.mint(address(vault), vault.totalAssets() / 100);
        assertTrue(other.isWhole(id));
        uint256 needs = 4e18 + 1_234;
        somePots.open(1, needs);
        assertEq(other.harvestable(id), needs);

        vm.prank(keeper);
        assertEq(other.harvest(id), needs);
        assertEq(somePots.chipOf(1, heir), needs);
        assertEq(token.balanceOf(heir), 0);
        // Taken out as an exact amount of IMD: redeeming the same shares would have paid a little more
        // than the pot needs, and the difference would belong to nobody.
        assertEq(token.balanceOf(address(other)), 0, "IMD was left behind in the contract");
        assertTrue(other.isWhole(id));

        vm.prank(alice);
        other.withdraw(id, 1_000_000e18);
        assertEq(token.balanceOf(alice), 2_000_000e18 - seed);
    }

    function test_harvest_pot_aPotThatNeedsOneWeiIsSentOneWei() public {
        _endowAndEarn(potId);
        pots.open(POT, 1);
        assertEq(endow.harvestable(potId), 1);
        vm.prank(keeper);
        assertEq(endow.harvest(potId), 1);
        assertEq(pots.chipOf(POT, heir), 1);
        assertEq(imd.balanceOf(heir), 0);
        _assertCovered(potId);
    }

    /// @dev A pot that needs exactly the yield, or more, is offered all of it: nothing is held back.
    function test_harvest_pot_aPotThatNeedsAtLeastTheYieldGetsAllOfIt() public {
        uint256 all = _endowAndEarn(potId);
        pots.open(POT, all);
        assertEq(endow.harvestable(potId), all);
        vm.prank(keeper);
        assertEq(endow.harvest(potId), all);
        assertEq(pots.chipOf(POT, heir), all);
        assertEq(pots.remaining(POT), 0);
        assertGe(_cushion(potId), int256(margin));
        assertLe(_cushion(potId), int256(margin) + 1_000);
    }

    function test_harvest_pot_aFullPotSendsEverythingToTheFallback() public {
        pots.open(POT, 0);
        uint256 expected = _endowAndEarn(potId);
        vm.prank(keeper);
        endow.harvest(potId);
        assertEq(imd.balanceOf(heir), expected);
        assertEq(imd.balanceOf(address(pots)), 0);
    }

    function test_harvest_pot_aRevertingPotSendsEverythingToTheFallback() public {
        pots.setMode(MockCrowdPots.Mode.Reverts);
        uint256 expected = _endowAndEarn(potId);
        vm.prank(keeper);
        endow.harvest(potId);
        assertEq(imd.balanceOf(heir), expected);
        assertEq(imd.allowance(address(endow), address(pots)), 0);
    }

    /// @dev If the pot cannot say what it needs, the harvest falls back to offering it everything: the
    /// pot takes what it needs and the fallback gets the rest. Each way the question can fail is tried.
    function test_harvest_pot_ifThePotCannotBeAskedItIsOfferedEverything() public {
        MockCrowdPots.ViewMode[5] memory failures = [
            MockCrowdPots.ViewMode.Reverts,
            MockCrowdPots.ViewMode.BurnsGas,
            MockCrowdPots.ViewMode.ReturnsShort,
            MockCrowdPots.ViewMode.ReturnsHuge,
            MockCrowdPots.ViewMode.RevertsWithWord
        ];
        uint256 all = _endowAndEarn(potId);
        pots.open(POT, 4e18);
        // What a failed call leaves behind must not be read as an answer, even when it looks like one.
        pots.setFixedRoom(3e18);
        for (uint256 i = 0; i < failures.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            pots.setViewMode(failures[i]);
            assertEq(endow.harvestable(potId), all);

            vm.prank(keeper);
            assertEq(endow.harvest{gas: 1_000_000}(potId), all);
            assertEq(pots.chipOf(POT, heir), 4e18);
            assertEq(imd.balanceOf(heir), all - 4e18);
            assertEq(imd.allowance(address(endow), address(pots)), 0);
            assertEq(imd.balanceOf(address(endow)), 0);
            _assertCovered(potId);
            vm.revertToState(snapshot);
        }
    }

    /// @dev A pot that says it needs something and then takes nothing can misdirect only what it asked
    /// for: that much goes to the fallback, the rest stays staked.
    function test_harvest_pot_aPotThatAsksAndThenTakesNothingMovesOnlyWhatItAskedFor() public {
        uint256 all = _endowAndEarn(potId);
        pots.setViewMode(MockCrowdPots.ViewMode.Fixed);
        pots.setFixedRoom(3e18);
        pots.setMode(MockCrowdPots.Mode.Reverts);

        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.FallbackPaid(potId, heir, 3e18);
        vm.prank(keeper);
        assertEq(endow.harvest(potId), 3e18);
        assertEq(imd.balanceOf(heir), 3e18);
        assertEq(imd.allowance(address(endow), address(pots)), 0);
        assertApproxEqAbs(endow.backingOf(potId), PRINCIPAL + all - 3e18, 1e13);
        _assertCovered(potId);
    }

    function test_harvest_pot_aPotThatBurnsItsGasCannotStopTheHarvest() public {
        pots.setMode(MockCrowdPots.Mode.BurnsGas);
        uint256 expected = _endowAndEarn(potId);
        vm.prank(keeper);
        endow.harvest{gas: 1_000_000}(potId);
        assertEq(imd.balanceOf(heir), expected);
    }

    function test_harvest_pot_aPotThatReturnsHugeDataCannotStopTheHarvest() public {
        pots.setMode(MockCrowdPots.Mode.ReturnsHuge);
        uint256 expected = _endowAndEarn(potId);
        vm.prank(keeper);
        endow.harvest{gas: 1_000_000}(potId);
        assertEq(imd.balanceOf(heir), expected);
    }

    /// @dev Code cannot vanish from an address any more, but the harvest does not depend on that: with
    /// nothing at the pots' address both calls come back empty and the fallback is paid.
    function test_harvest_pot_noCodeAtThePotsAddressSendsEverythingToTheFallback() public {
        uint256 expected = _endowAndEarn(potId);
        vm.etch(address(pots), "");

        assertEq(endow.harvestable(potId), expected);
        vm.prank(keeper);
        endow.harvest(potId);
        assertEq(imd.balanceOf(heir), expected);
        assertEq(imd.allowance(address(endow), address(pots)), 0);
    }

    /// @dev The pot may never take more than it was offered: anything beyond the harvest in this
    /// contract is depositors' buffered principal. The real IMD cannot be moved without an allowance;
    /// the mock token is told to allow it so that the check has something to catch.
    function test_harvest_pot_revertsIfThePotTakesMoreThanItWasOffered() public {
        _endowAndEarn(potId);
        _deposit(bob, potId, 5e18);
        pots.setMode(MockCrowdPots.Mode.TakesMore);

        vm.prank(keeper);
        vm.expectRevert(Endowments.TargetMismatch.selector);
        endow.harvest(potId);
        assertEq(imd.balanceOf(address(endow)), 5e18);
        assertEq(_buffered(potId), 5e18);
    }

    /// @dev A caller who gives too little gas could make the pot call fail and so push the yield to the
    /// fallback. The harvest refuses to run like that.
    function test_harvest_pot_revertsWhenThePotCallCouldNotGetItsGas() public {
        _endowAndEarn(potId);
        vm.prank(keeper);
        vm.expectRevert(Endowments.LowGas.selector);
        endow.harvest{gas: 600_000}(potId);
        assertEq(imd.balanceOf(heir), 0);
    }

    /// @dev The gas is asked for before the pot is asked anything, so the answer is `LowGas` even when
    /// there turns out to be nothing to harvest.
    function test_harvest_pot_lowGasIsRefusedBeforeThePotIsAsked() public {
        _deposit(alice, potId, PRINCIPAL);
        _stakeAndWait();
        assertEq(endow.harvestable(potId), 0);

        vm.prank(keeper);
        vm.expectRevert(Endowments.LowGas.selector);
        endow.harvest{gas: 600_000}(potId);
        vm.prank(keeper);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest{gas: 900_000}(potId);
    }

    function test_harvest_pot_withEnoughGasThePotGetsItsChip() public {
        uint256 expected = _endowAndEarn(potId);
        vm.prank(keeper);
        endow.harvest{gas: 850_000}(potId);
        assertEq(pots.chipOf(POT, heir), expected);
        assertEq(imd.balanceOf(heir), 0);
    }

    /// @dev Tries every gas amount in a range against a pot that refuses unless it is really handed
    /// (nearly) its whole allowance. Each call must either revert or leave the pot with its chip; a call
    /// that goes through and pays the fallback instead means the caller starved the pot.
    function _assertNoGasAmountStarvesThePot(uint256 from, uint256 to) internal {
        uint256 expected = endow.harvestable(potId);
        pots.setMode(MockCrowdPots.Mode.NeedsGas);
        pots.setMinGas(endow.POT_CALL_GAS() - 1_000);

        uint256 firstOk;
        uint256 refused;
        for (uint256 gasGiven = from; gasGiven <= to; gasGiven += 1_000) {
            uint256 snapshot = vm.snapshotState();
            vm.prank(keeper);
            (bool ok, bytes memory answer) =
                address(endow).call{gas: gasGiven}(abi.encodeCall(Endowments.harvest, (potId)));
            if (ok) {
                if (firstOk == 0) firstOk = gasGiven;
                assertEq(pots.chipOf(POT, heir), expected, "the harvest went through with the pot call starved");
                assertEq(imd.balanceOf(heir), 0, "the fallback was paid");
                assertGe(pots.gasSeen(), endow.POT_CALL_GAS() - 1_000);
            } else {
                ++refused;
                // Refused by this contract's own rule, not by running out part-way.
                if (answer.length != 0) assertEq(bytes4(answer), Endowments.LowGas.selector);
            }
            vm.revertToState(snapshot);
        }
        assertGt(firstOk, 0, "no gas amount in the range let the harvest through");
        assertGt(refused, 0, "no gas amount in the range was refused");
    }

    /// @dev From the review: the gas rule as a property. Whatever gas a caller picks, the harvest either
    /// reverts or the pot got its chip; there is no amount at which it goes through and pays the
    /// fallback instead.
    function test_harvest_pot_noGasAmountPushesTheHarvestToTheFallback() public {
        _endowAndEarn(potId);
        _assertNoGasAmountStarvesThePot(560_000, 900_000);
    }

    /// @dev The same with a vault that uses a great deal of gas on the way out. The pot's allowance is
    /// checked after the vault has been paid for, so it does not depend on what the vault costs.
    function test_harvest_pot_noGasAmountPushesTheHarvestToTheFallback_howeverMuchGasTheVaultUses() public {
        _endowAndEarn(potId);
        simd.setExitCost(200_000);
        _assertNoGasAmountStarvesThePot(700_000, 1_100_000);
    }

    /// @dev The other half of the gas rule: at the least gas the rule lets through, a pot that burns
    /// its whole allowance still leaves enough for the fallback to be paid.
    function test_harvest_pot_atTheLeastGasAllowed_aPotThatBurnsEverythingStillLeavesTheFallbackPaid() public {
        uint256 expected = _endowAndEarn(potId);
        uint256 least = _leastGasFor(potId);
        assertGt(least, endow.POT_CALL_GAS());
        pots.setMode(MockCrowdPots.Mode.BurnsGas);

        for (uint256 extra = 0; extra <= 4_000; extra += 500) {
            uint256 snapshot = vm.snapshotState();
            vm.prank(keeper);
            (bool ok,) = address(endow).call{gas: least + extra}(abi.encodeCall(Endowments.harvest, (potId)));
            assertTrue(ok, "the harvest ran out of gas after the pot burned its allowance");
            assertEq(imd.balanceOf(heir), expected);
            assertEq(imd.allowance(address(endow), address(pots)), 0);
            vm.revertToState(snapshot);
        }
    }

    function test_harvest_pot_aCallBackIntoEndowmentsIsRefused() public {
        uint256 expected = _endowAndEarn(potId);
        pots.setMode(MockCrowdPots.Mode.CallsBack);
        pots.setCallback(abi.encodeCall(Endowments.withdraw, (potId, 1)));

        vm.prank(keeper);
        endow.harvest(potId);

        assertFalse(pots.callbackSucceeded());
        assertEq(
            pots.callbackResult(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(pots.chipOf(POT, heir), expected);
    }
}
