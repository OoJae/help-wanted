// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Questions} from "a-payroll/src/questions/Questions.sol";
import {CrowdPots} from "b-desk/src/pots/CrowdPots.sol";
import {Endowments} from "c-company/src/endowments/Endowments.sol";
import {Siblings} from "./Siblings.sol";

/// @dev Endowments against the real Questions (its meter, its cost, a real round bought and a real
/// round failed) and the real CrowdPots (single pots, series, a pot out of time). The vault is the
/// stand-in of the main project, put in the state the real sIMD was in; the real vault is met in
/// the main project's fork suite.
contract EndowmentsWithRealSiblingsTest is Siblings {
    uint256 internal constant RUNWAY_REQUESTS = 30;

    /// @dev A meter endowment for the fixture's feed with 100,000 IMD staked and 1% of yield: about
    /// 1,000 IMD, many times thirty requests.
    function _richMeterEndowment() internal returns (uint256 id) {
        vm.startPrank(user);
        id = endow.createForMeter(feed);
        endow.deposit(id, 100_000e18);
        vm.stopPrank();
        _stakeAndWait();
        _yieldBps(100);
    }

    // ------------------------------------------------------------------------------------------
    // A meter endowment and the real meter
    // ------------------------------------------------------------------------------------------

    /// @dev Creation asks the real contract what a request costs: a feed that exists and can be
    /// bought is accepted, an id nobody created is not.
    function test_createForMeter_asksTheRealQuestionsForTheFeedsCost() public {
        assertEq(q.costOf(feed), COST);
        assertEq(endow.METER_RUNWAY(), RUNWAY_REQUESTS);
        bytes32 unknown = keccak256("nobody made this");
        assertEq(q.costOf(unknown), 0);
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(Endowments.FeedNotLive.selector, unknown));
        endow.createForMeter(unknown);
        uint256 id = endow.createForMeter(feed);
        vm.stopPrank();
        (Endowments.Kind kind, bytes32 target,,,,,) = endow.endowment(id);
        assertEq(uint8(kind), uint8(Endowments.Kind.Meter));
        assertEq(target, feed);
    }

    /// @dev The runway on the real meter: a harvest lifts it to thirty requests at the real
    /// `costOf` and no further; the meter shares are Endowments' and stay there; a real request
    /// makes room for exactly what it cost; and the principal still leaves to the wei.
    function test_meter_aHarvestTopsTheRealMeterUpToThirtyRequests() public {
        uint256 id = _richMeterEndowment();
        uint256 runway = RUNWAY_REQUESTS * COST;

        assertEq(endow.harvestable(id), runway);
        assertEq(endow.harvest(id), runway);
        assertEq(_meter(), runway, "the real meter holds exactly thirty requests");
        assertEq(q.sharesOf(feed, address(endow)), runway, "the first funder's shares, one per wei");
        assertEq(imd.allowance(address(endow), address(q)), 0);
        assertEq(imd.balanceOf(address(endow)), 0);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(id);

        // A real round is bought from the meter: the price goes to the Intake and the tip is set
        // aside for the keeper, so the meter is one request's cost lighter.
        _request(feed);
        assertEq(_meter(), runway - COST);
        assertEq(endow.harvestable(id), COST);
        assertEq(endow.harvest(id), COST);
        assertEq(_meter(), runway);

        uint256 before = imd.balanceOf(user);
        vm.prank(user);
        endow.withdraw(id, 100_000e18);
        assertEq(imd.balanceOf(user), before + 100_000e18);
    }

    /// @dev The runway follows the real cost. A dearer Intake makes room; an Intake that stops
    /// selling, or asks more than the feed's own limit, leaves none, and no new meter endowment can
    /// be created for the feed while that lasts.
    function test_meter_theRunwayFollowsTheRealCost() public {
        uint256 id = _richMeterEndowment();
        endow.harvest(id);
        uint256 runway = RUNWAY_REQUESTS * COST;

        intake.setPrice(ACTION, address(imd), 0.7e18);
        assertEq(q.costOf(feed), 0.7e18 + TIP);
        assertEq(endow.harvest(id), RUNWAY_REQUESTS * (0.7e18 + TIP) - runway);
        assertEq(_meter(), RUNWAY_REQUESTS * (0.7e18 + TIP));

        intake.setPrice(ACTION, address(imd), 0);
        assertEq(q.costOf(feed), 0, "the Intake is not selling");
        // Nothing can be bought, so nothing leaves the meter either.
        _expectNoRequest(Questions.Blocker.NotSold);
        assertEq(endow.harvestable(id), 0);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(id);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Endowments.FeedNotLive.selector, feed));
        endow.createForMeter(feed);

        // The fixture's feed accepts a price of at most 1 IMD.
        intake.setPrice(ACTION, address(imd), 1e18 + 1);
        assertEq(q.costOf(feed), 0, "the price is above the feed's own limit");
        _expectNoRequest(Questions.Blocker.PriceAboveCap);
        assertEq(endow.harvestable(id), 0);
    }

    /// @dev The real contract refuses a request, for the reason named.
    function _expectNoRequest(Questions.Blocker why) internal {
        q.newTransaction();
        intake.newTransaction();
        vm.prank(keeper);
        vm.expectRevert(_blocked(why));
        q.request(feed);
    }

    /// @dev Anyone may fund the real meter. One that somebody else has filled past the runway takes
    /// nothing from the endowment: the yield stays staked.
    function test_meter_aMeterSomeoneElseFilledTakesNothing() public {
        uint256 id = _richMeterEndowment();
        vm.prank(alice);
        q.fund(feed, RUNWAY_REQUESTS * COST + 5e18);

        assertEq(endow.harvestable(id), 0);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(id);
        (,,,,,, uint256 harvested) = endow.endowment(id);
        assertEq(harvested, 0);
    }

    /// @dev A limit of the runway, on the real contract. The runway bounds what a HARVEST adds. The
    /// real Questions gives a failed round's keeper tip back to the meter, and that can leave a
    /// meter the endowment had already topped up a tip above thirty requests. The endowment then
    /// waits until a request has been bought.
    function test_meter_aTipReturnedByAFailedRoundCanLeaveTheMeterAboveTheRunway() public {
        uint256 id = _richMeterEndowment();
        uint256 runway = RUNWAY_REQUESTS * COST;
        endow.harvest(id);

        _request(feed);
        assertEq(endow.harvest(id), COST, "the pending round's cost is replaced");
        assertEq(_meter(), runway);

        // Nobody answers. Once the wait Questions reports has passed (the silence allowance plus the
        // answer's validity), anyone closes the round and its tip returns to the meter.
        (, uint256 closableAt) = q.canAbandon(feed);
        vm.warp(closableAt);
        assertTrue(q.abandon(feed));
        assertEq(_meter(), runway + TIP, "a tip above the runway, put there by Questions, not by a harvest");
        assertEq(endow.harvestable(id), 0);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endow.harvest(id);

        // The next request is bought (the cadence has doubled after the failure) and there is room again.
        vm.roll(vm.getBlockNumber() + 2 * uint256(CADENCE));
        _request(feed);
        assertEq(_meter(), runway + TIP - COST);
        assertEq(endow.harvest(id), COST - TIP);
        assertEq(_meter(), runway);
    }

    /// @dev Harvested yield becomes meter shares that only Endowments holds, and nothing in
    /// Endowments redeems them: a real funder beside it takes back its own part and no more.
    function test_meter_harvestedYieldStaysOnTheMeter() public {
        uint256 id = _richMeterEndowment();
        vm.prank(alice);
        q.fund(feed, 5e18);
        uint256 sent = endow.harvest(id);
        assertEq(sent, RUNWAY_REQUESTS * COST - 5e18);
        assertEq(q.redeemable(feed, address(endow)), sent);

        uint256 before = imd.balanceOf(alice);
        vm.prank(alice);
        assertEq(q.defund(feed, type(uint256).max), 5e18);
        assertEq(imd.balanceOf(alice), before + 5e18);
        assertEq(_meter(), sent, "what the endowment harvested is still on the meter");
    }

    // ------------------------------------------------------------------------------------------
    // A pot endowment and the real pots
    // ------------------------------------------------------------------------------------------

    function _potEndowment(uint256 potId) internal returns (uint256 id) {
        vm.startPrank(user);
        id = endow.createForPot(potId, heir);
        endow.deposit(id, 10_000e18);
        vm.stopPrank();
    }

    /// @dev Creation asks the real contract whether the pot exists.
    function test_createForPot_needsAPotTheRealContractHasOpened() public {
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(Endowments.UnknownPot.selector, 1));
        endow.createForPot(1, heir);
        vm.stopPrank();
        uint256 potId = pots.openPot(_terms(4e18), SPEC, 0);
        vm.startPrank(user);
        endow.createForPot(potId, heir);
        vm.expectRevert(abi.encodeWithSelector(Endowments.UnknownPot.selector, potId + 1));
        endow.createForPot(potId + 1, heir);
        vm.stopPrank();
    }

    /// @dev A single real pot: the harvest takes out what the pot still needs and chips it in for
    /// the fallback beneficiary; once the pot is full, the yield goes to the beneficiary itself.
    function test_pot_theRealPotIsFilledAndThenTheFallbackIsPaid() public {
        uint256 potId = pots.openPot(_terms(4e18), SPEC, 0);
        uint256 id = _potEndowment(potId);
        _stakeAndWait();
        _yieldBps(100);

        assertEq(endow.harvest(id), 4e18);
        assertEq(pots.remaining(potId), 0);
        (uint256 chip,,) = pots.chipOf(potId, heir);
        assertEq(chip, 4e18, "the chip is the fallback beneficiary's");
        assertEq(imd.balanceOf(heir), 0, "nothing was paid past the pot");
        assertEq(imd.allowance(address(endow), address(pots)), 0);

        uint256 rest = endow.harvestable(id);
        assertGt(rest, 0);
        assertEq(endow.harvest(id), rest);
        assertEq(imd.balanceOf(heir), rest, "a full pot takes nothing: the fallback is paid");
    }

    /// @dev A real series is funded round after round, each harvest opening the next round, which
    /// is the costliest thing the pot call does. The fallback beneficiary is not paid directly.
    function test_pot_aRealSeriesIsFundedRoundAfterRound() public {
        uint256 seriesId = pots.openSeries(_terms(6e18), SPEC);
        uint256 id = _potEndowment(seriesId);
        _stakeAndWait();
        _yieldBps(100);

        uint256 potsBefore = pots.potCount();
        assertEq(endow.harvest(id), 6e18);
        assertEq(endow.harvest(id), 6e18);
        assertEq(pots.potCount(), potsBefore + 2, "each harvest opened a round of its own");
        assertEq(imd.balanceOf(heir), 0);
        (uint256 chip,,) = pots.chipOf(pots.currentRound(seriesId), heir);
        assertEq(chip, 6e18);
    }

    /// @dev Only the real pots have a time limit for collecting. A pot whose time has run out needs
    /// nothing and takes nothing, so the whole harvest goes to the fallback beneficiary.
    function test_pot_aRealPotOutOfTimePaysTheFallback() public {
        uint256 potId = pots.openPot(_terms(4e18), SPEC, 0);
        uint256 id = _potEndowment(potId);
        _stakeAndWait();
        _yieldBps(100);
        skip(1 days + 1);
        assertEq(pots.remaining(potId), 0);

        uint256 all = endow.harvestable(id);
        assertGt(all, 4e18);
        assertEq(endow.harvest(id), all);
        assertEq(imd.balanceOf(heir), all);
        (uint256 chip,,) = pots.chipOf(potId, heir);
        assertEq(chip, 0);
    }

    /// @dev The gas rule with the real pots. A pot harvest is refused below the floor that lets the
    /// pot be handed its whole allowance, and the real contract's costliest chip (one that opens a
    /// new round of a series) fits inside that allowance with room to spare.
    function test_pot_theGasFloorAndWhatTheRealPotUses() public {
        uint256 seriesId = pots.openSeries(_terms(6e18), SPEC);
        uint256 id = _potEndowment(seriesId);
        _stakeAndWait();
        _yieldBps(100);

        vm.expectRevert(Endowments.LowGas.selector);
        endow.harvest{gas: 600_000}(id);

        uint256 gasBefore = gasleft();
        endow.harvest{gas: 900_000}(id);
        uint256 used = gasBefore - gasleft();
        emit log_named_uint("gas: pot harvest that opens a round of a real series", used);
        assertLt(used, 700_000);

        // The chip alone, as the pot contract runs it for any caller, offered no more gas than
        // Endowments hands it. The harvest above filled a round, so the first chip opens the next.
        uint256 allowance = endow.POT_CALL_GAS();
        vm.prank(user);
        gasBefore = gasleft();
        uint256 taken = pots.chipInFor{gas: allowance}(seriesId, 5e18, heir);
        used = gasBefore - gasleft();
        assertEq(taken, 5e18);
        emit log_named_uint("gas: the real chipInFor that opens a round", used);
        assertLt(used, allowance, "the pot's allowance covers its costliest chip");
        vm.prank(user);
        gasBefore = gasleft();
        taken = pots.chipInFor{gas: allowance}(seriesId, 1e18, heir);
        used = gasBefore - gasleft();
        assertEq(taken, 1e18);
        emit log_named_uint("gas: the real chipInFor into a round that is open", used);
    }

    /// @dev The errors the stand-ins of the main project copy are the real contracts' own.
    function test_theRealContractsRefuseAsTheStandInsSay() public {
        vm.startPrank(user);
        vm.expectRevert(CrowdPots.BadBeneficiary.selector);
        pots.chipInFor(1, 1e18, address(0));
        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownFeed.selector, bytes32(uint256(1))));
        q.fund(bytes32(uint256(1)), 1e18);
        vm.expectRevert(Questions.ZeroAmount.selector);
        q.fund(feed, 0);
        vm.stopPrank();
    }
}
