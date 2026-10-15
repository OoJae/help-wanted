// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {PotsBase} from "./PotsBase.sol";

/// @notice A series is a recurring pot: chips sent to its id land in its current round, an
/// ordinary pot, and a new round opens when the last one has stopped collecting.
contract CrowdPotsSeriesTest is PotsBase {
    function _openSeries(CrowdPots.Terms memory t) internal returns (uint256 seriesId) {
        vm.prank(opener);
        seriesId = pots.openSeries(t, SPEC);
    }

    function test_openSeries_storesATemplateThatHoldsNoMoney() public {
        CrowdPots.Terms memory t = _rampTerms();

        vm.expectEmit(address(pots));
        emit CrowdPots.SpecPinned(keccak256(SPEC), SPEC);
        vm.expectEmit(address(pots));
        emit CrowdPots.SeriesOpened(1, opener, keccak256(SPEC), t);
        uint256 seriesId = _openSeries(t);

        assertEq(seriesId, 1, "a series shares the pot id space");
        assertEq(pots.potCount(), 1);
        CrowdPots.Pot memory s = pots.potOf(seriesId);
        assertEq(uint256(s.stage), uint256(CrowdPots.Stage.Series));
        assertEq(s.specHash, keccak256(SPEC));
        assertEq(s.kindHash, KIND);
        assertEq(s.target, t.target);
        assertEq(s.minPay, t.minPay);
        assertEq(s.rampSecs, t.rampSecs);
        assertEq(s.bond, t.bond);
        assertEq(s.deliverySecs, t.deliverySecs);
        assertEq(s.hireSecs, t.hireSecs);
        assertEq(s.fundSecs, t.fundSecs);
        assertEq(s.opener, opener);
        assertEq(s.deadline, 0);
        assertEq(s.raised, 0);
        assertEq(pots.currentRound(seriesId), 0);
        assertEq(pots.remaining(seriesId), t.target, "the next chip would open a round");
    }

    function test_chipIn_toASeries_opensItsFirstRound() public {
        CrowdPots.Terms memory t = _rampTerms();
        uint256 seriesId = _openSeries(t);
        vm.warp(START + 5 days);

        vm.expectEmit(address(pots));
        emit CrowdPots.PotOpened(2, opener, seriesId, keccak256(SPEC), uint40(vm.getBlockTimestamp() + t.fundSecs), t);
        vm.expectEmit(address(pots));
        emit CrowdPots.ChippedIn(2, alice, alice, 3e18, 3e18);
        uint256 taken = _chip(alice, seriesId, 3e18);

        assertEq(taken, 3e18);
        assertEq(pots.potCount(), 2);
        assertEq(pots.currentRound(seriesId), 2);
        CrowdPots.Pot memory round = pots.potOf(2);
        assertEq(uint256(round.stage), uint256(CrowdPots.Stage.Funding));
        assertEq(round.seriesId, seriesId);
        assertEq(round.deadline, vm.getBlockTimestamp() + t.fundSecs, "the round's clock starts with its first chip");
        assertEq(round.raised, 3e18);
        assertEq(round.specHash, keccak256(SPEC));
        assertEq(round.kindHash, KIND);
        assertEq(round.target, t.target);
        assertEq(round.minPay, t.minPay);
        assertEq(round.rampSecs, t.rampSecs);
        assertEq(round.bond, t.bond);
        assertEq(round.deliverySecs, t.deliverySecs);
        assertEq(round.hireSecs, t.hireSecs);
        assertEq(round.fundSecs, t.fundSecs);
        assertEq(round.allowClaimed, t.allowClaimed);
        assertEq(round.opener, opener, "the one who pinned the terms");

        (uint256 inRound,,) = pots.chipOf(2, alice);
        (uint256 inSeries,,) = pots.chipOf(seriesId, alice);
        assertEq(inRound, 3e18);
        assertEq(inSeries, 0, "the series itself holds nothing");
        assertEq(pots.potOf(seriesId).raised, 0);
        assertEq(pots.remaining(seriesId), 7e18);
    }

    function test_chipIn_toASeries_keepsFillingTheSameRoundWhileItCollects() public {
        uint256 seriesId = _openSeries(_terms());
        _chip(alice, seriesId, 3e18);
        _chip(bob, seriesId, 2e18);
        vm.prank(carol);
        pots.chipInFor(seriesId, 1e18, alice);

        assertEq(pots.potCount(), 2);
        assertEq(pots.potOf(2).raised, 6e18);
        (uint256 aliceChip,,) = pots.chipOf(2, alice);
        assertEq(aliceChip, 4e18);
    }

    function test_chipIn_toASeries_isCutToTheRound_andTheRestIsNotCarriedOver() public {
        uint256 seriesId = _openSeries(_terms());
        uint256 taken = _chip(alice, seriesId, 25e18);

        assertEq(taken, 10e18);
        assertEq(imd.balanceOf(alice), WALLET - 10e18);
        assertEq(pots.potCount(), 2, "no second round was opened for the leftover");
        assertEq(pots.remaining(seriesId), 10e18, "the next chip would open one");
    }

    function test_chipIn_toASeries_opensTheNextRoundOnceTheLastIsFull() public {
        uint256 seriesId = _openSeries(_terms());
        _chip(alice, seriesId, 10e18);
        _chip(bob, seriesId, 4e18);

        assertEq(pots.currentRound(seriesId), 3);
        assertEq(pots.potOf(2).raised, 10e18);
        assertEq(pots.potOf(3).raised, 4e18);
        assertEq(pots.potOf(3).seriesId, seriesId);
    }

    function test_chipIn_toASeries_opensTheNextRoundOnceTheLastWasLaunched() public {
        uint256 seriesId = _openSeries(_terms());
        _chip(alice, seriesId, 10e18);
        _launch(2);
        _chip(bob, seriesId, 1e18);
        assertEq(pots.currentRound(seriesId), 3);
        _assertStage(2, CrowdPots.Stage.Hiring);
    }

    /// A round's clock starts with its first chip, whoever sends it and however small. Anyone can
    /// open a round with one wei, and funders that come later have that much less of the round's
    /// time. The wei is locked like any chip; a round that runs out unfilled gives every chip
    /// back, and the next chip sent to the series opens the next round.
    function test_chipIn_toASeries_aOneWeiChipFromAnyoneStartsTheRoundsClock() public {
        CrowdPots.Terms memory t = _terms();
        uint256 seriesId = _openSeries(t);
        vm.warp(START + 3 days);
        assertEq(_chip(carol, seriesId, 1), 1);
        uint256 round = pots.currentRound(seriesId);
        uint256 deadline = pots.potOf(round).deadline;
        assertEq(deadline, START + 3 days + t.fundSecs, "the clock runs from the one-wei chip");

        // A funder that arrives late in the round chips into it, with little time left to fill it.
        vm.warp(deadline);
        assertEq(_chip(alice, seriesId, 3e18), 3e18);
        assertEq(pots.currentRound(seriesId), round);

        // The round runs out; the next chip opens the next round and the first is refundable.
        vm.warp(deadline + 1);
        assertEq(_chip(bob, seriesId, 2e18), 2e18);
        assertEq(pots.currentRound(seriesId), round + 1);
        assertEq(_claim(round, carol), 1);
        assertEq(_claim(round, alice), 3e18);
    }

    function test_chipIn_toASeries_opensTheNextRoundOnceTheLastRanOutOfTime() public {
        CrowdPots.Terms memory t = _terms();
        uint256 seriesId = _openSeries(t);
        _chip(alice, seriesId, 3e18);
        vm.warp(pots.potOf(2).deadline + 1);
        assertEq(pots.remaining(seriesId), t.target);

        _chip(bob, seriesId, 4e18);
        assertEq(pots.currentRound(seriesId), 3);
        assertEq(pots.potOf(3).deadline, vm.getBlockTimestamp() + t.fundSecs);

        // The round that ran out of time gives its chips back.
        assertEq(_claim(2, alice), 3e18);
        assertEq(imd.balanceOf(address(pots)), 4e18);
    }

    /// A chip meant for one particular round goes to that round's own id. If the round has filled
    /// in the meantime it takes nothing, where the same chip sent to the series id opens the next
    /// round and stays there until that round ends.
    function test_chipIn_toARoundsOwnId_neverSpillsIntoTheNextRound() public {
        uint256 seriesId = _openSeries(_terms());
        _chip(alice, seriesId, 6e18);
        uint256 round = pots.currentRound(seriesId);

        // Somebody fills the round one block earlier.
        _chip(carol, round, 4e18);
        assertEq(_chip(bob, round, 5e18), 0, "the round is full: nothing is taken");
        assertEq(imd.balanceOf(bob), WALLET);
        assertEq(pots.currentRound(seriesId), round, "and no new round was opened");
        assertEq(pots.potCount(), 2);

        vm.expectEmit(address(pots));
        emit CrowdPots.ChippedIn(round + 1, bob, bob, 5e18, 5e18);
        assertEq(_chip(bob, seriesId, 5e18), 5e18, "the series id takes it into the next round");
        uint256 next = pots.currentRound(seriesId);
        assertEq(next, round + 1);
        (uint256 inNext,,) = pots.chipOf(next, bob);
        assertEq(inNext, 5e18);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Funding));
        pots.claimRefund(next, bob);
    }

    /// Helper contracts hand `chipInFor` a fixed amount of gas (Endowments gives 500,000). The
    /// dearest chip there is, is the one that opens a new round for a beneficiary nobody has seen.
    function test_chipInFor_theDearestChipFitsInTheGasAHelperHandsOver() public {
        uint256 seriesId = _openSeries(_rampTerms());
        address newcomer = makeAddr("newcomer");

        vm.prank(alice);
        uint256 taken = pots.chipInFor{gas: 500_000}(seriesId, 1e18, newcomer);
        assertEq(taken, 1e18);
        assertLt(vm.lastCallGas().gasTotalUsed, 400_000, "with a fifth to spare");
        assertEq(pots.currentRound(seriesId), 2, "the chip opened the round");

        // A later round costs no more.
        vm.warp(pots.potOf(2).deadline + 1);
        vm.prank(bob);
        taken = pots.chipInFor{gas: 500_000}(seriesId, 1e18, makeAddr("another newcomer"));
        assertEq(taken, 1e18);
        assertLt(vm.lastCallGas().gasTotalUsed, 400_000);
        assertEq(pots.currentRound(seriesId), 3);
    }

    function test_chipIn_ofZeroToASeries_opensNoRound() public {
        uint256 seriesId = _openSeries(_terms());
        assertEq(_chip(alice, seriesId, 0), 0);
        assertEq(pots.potCount(), 1);
        assertEq(pots.currentRound(seriesId), 0);
    }

    function test_chipInFor_toASeries_revertsForABadBeneficiary() public {
        uint256 seriesId = _openSeries(_terms());
        vm.prank(alice);
        vm.expectRevert(CrowdPots.BadBeneficiary.selector);
        pots.chipInFor(seriesId, 1e18, address(0));
        assertEq(pots.potCount(), 1);
    }

    function test_aRoundIsAnOrdinaryPot_fromLaunchToRefund() public {
        uint256 seriesId = _openSeries(_rampTerms());
        _chip(alice, seriesId, 5e18);
        _chip(bob, seriesId, 5e18);
        uint256 round = pots.currentRound(seriesId);
        uint256 orderId = _launch(round);
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        _deliver(orderId);

        assertEq(_claim(round, alice), 1.5e18, "half of the 3 IMD the job did not cost");
        assertEq(_claim(round, bob), 1.5e18);
        assertEq(pots.potOf(round).jobId, JOB);
        assertEq(imd.balanceOf(address(pots)), 0);
    }

    function test_aSeriesIdIsNotAPot() public {
        uint256 seriesId = _openSeries(_terms());
        _chip(alice, seriesId, 10e18);

        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Series));
        pots.launch(seriesId, SPEC);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Series));
        pots.claimRefund(seriesId, alice);
        assertEq(uint256(pots.reconcile(seriesId)), uint256(CrowdPots.Stage.Series));
        _assertLiveStage(seriesId, CrowdPots.Stage.Series);
        assertEq(pots.refundOf(seriesId, alice), 0);

        vm.warp(vm.getBlockTimestamp() + 365 days);
        assertEq(uint256(pots.reconcile(seriesId)), uint256(CrowdPots.Stage.Series), "a series never runs out");
    }

    function test_roundsOfTwoSeriesDoNotMix() public {
        uint256 first = _openSeries(_terms());
        uint256 second = _openSeries(_rampTerms());
        _chip(alice, first, 2e18);
        _chip(bob, second, 3e18);
        _chip(carol, first, 1e18);

        uint256 roundOfFirst = pots.currentRound(first);
        uint256 roundOfSecond = pots.currentRound(second);
        assertTrue(roundOfFirst != roundOfSecond);
        assertEq(pots.potOf(roundOfFirst).raised, 3e18);
        assertEq(pots.potOf(roundOfSecond).raised, 3e18);
        assertEq(pots.potOf(roundOfFirst).seriesId, first);
        assertEq(pots.potOf(roundOfSecond).seriesId, second);
        assertEq(pots.potOf(roundOfSecond).minPay, 4e18);
    }
}
