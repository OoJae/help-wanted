// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Questions} from "a-payroll/src/questions/Questions.sol";
import {IWorkOrders} from "b-desk/src/interfaces/IWorkOrders.sol";
import {CrowdPots} from "b-desk/src/pots/CrowdPots.sol";
import {Zap} from "c-company/src/rules/Zap.sol";
import {Siblings} from "./Siblings.sol";

/// @dev Zap against the real Questions and the real CrowdPots. The pool is the stand-in of the
/// main project (0.01 ETH buys 3 IMD); the swap itself is tested against the real PoolManager in
/// the main project's fork suite.
contract ZapWithRealSiblingsTest is Siblings {
    // ------------------------------------------------------------------------------------------
    // fundMeter and the real Questions.fundFor
    // ------------------------------------------------------------------------------------------

    /// @dev The meter shares bought through Zap are the caller's on the real contract: Zap holds
    /// none, leaves no allowance, and the caller alone takes the unspent IMD back.
    function test_fundMeter_theSharesAreTheCallersOnTheRealMeter() public {
        vm.prank(user);
        (uint256 imdOut, uint256 shares) = zap.fundMeter{value: 0.01 ether}(feed, 3e18, NO_DEADLINE);
        assertEq(imdOut, 3e18);
        assertEq(shares, 3e18);
        assertEq(q.sharesOf(feed, user), 3e18);
        assertEq(q.sharesOf(feed, address(zap)), 0);
        assertEq(_meter(), 3e18);
        assertEq(imd.allowance(address(zap), address(q)), 0);
        assertEq(imd.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);

        // Zap cannot take it back, and neither can a stranger.
        vm.prank(address(zap));
        vm.expectRevert(Questions.NothingToDefund.selector);
        q.defund(feed, 1);
        vm.prank(heir);
        vm.expectRevert(Questions.NothingToDefund.selector);
        q.defund(feed, 1);

        uint256 before = imd.balanceOf(user);
        vm.prank(user);
        assertEq(q.defund(feed, type(uint256).max), 3e18);
        assertEq(imd.balanceOf(user), before + 3e18);
    }

    /// @dev The real contract's refusal comes through unchanged, and the caller keeps its ETH.
    function test_fundMeter_anUnknownFeedIsRefusedByTheRealContract() public {
        bytes32 unknown = keccak256("nobody made this");
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownFeed.selector, unknown));
        zap.fundMeter{value: 0.01 ether}(unknown, 0, NO_DEADLINE);
        assertEq(user.balance, 100 ether);
    }

    /// @dev After a real request has been bought from the meter, a later funder's shares are minted
    /// at what the meter is worth then, and they too belong to the caller.
    function test_fundMeter_afterARealRoundSharesAreAtTheMetersWorth() public {
        vm.prank(user);
        zap.fundMeter{value: 0.01 ether}(feed, 0, NO_DEADLINE);
        _request(feed);
        uint256 left = _meter();
        assertEq(left, 3e18 - COST, "one request was bought from the meter");

        address second = makeAddr("second funder");
        vm.deal(second, 1 ether);
        vm.prank(second);
        (uint256 imdOut, uint256 shares) = zap.fundMeter{value: 0.01 ether}(feed, 0, NO_DEADLINE);
        assertEq(shares, imdOut * 3e18 / left);
        assertEq(q.sharesOf(feed, second), shares);
        assertEq(q.sharesOf(feed, address(zap)), 0);
    }

    /// @dev A call that is late does not reach the real contracts at all.
    function test_fundMeter_andChipIn_lateCallsNeverReachTheRealContracts() public {
        uint256 potId = pots.openPot(_terms(2e18), SPEC, 0);
        uint256 late = vm.getBlockTimestamp() - 1;
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, late));
        zap.fundMeter{value: 0.01 ether}(feed, 0, late);
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, late));
        zap.chipIn{value: 0.01 ether}(potId, 0, late);
        vm.stopPrank();
        assertEq(_meter(), 0);
        assertEq(pots.remaining(potId), 2e18);
        assertEq(user.balance, 100 ether);
    }

    // ------------------------------------------------------------------------------------------
    // chipIn and the real CrowdPots.chipInFor
    // ------------------------------------------------------------------------------------------

    /// @dev The real pot takes what it needs, books the chip to the caller, and the surplus of the
    /// swap goes back to the caller as IMD in the same call.
    function test_chipIn_theChipIsTheCallersAndTheSurplusComesBack() public {
        uint256 potId = pots.openPot(_terms(2e18), SPEC, 0);
        uint256 before = imd.balanceOf(user);

        vm.prank(user);
        (uint256 imdOut, uint256 chipped) = zap.chipIn{value: 0.01 ether}(potId, 3e18, NO_DEADLINE);

        assertEq(imdOut, 3e18);
        assertEq(chipped, 2e18);
        (uint256 amount,,) = pots.chipOf(potId, user);
        assertEq(amount, 2e18, "the chip is booked to the caller");
        (amount,,) = pots.chipOf(potId, address(zap));
        assertEq(amount, 0, "Zap is not a contributor");
        assertEq(imd.balanceOf(user), before + 1e18, "the surplus came back");
        assertEq(imd.balanceOf(address(zap)), 0);
        assertEq(imd.allowance(address(zap), address(pots)), 0);
        assertEq(pots.remaining(potId), 0);
    }

    /// @dev A real pot that takes nothing answers zero without reverting, whatever the reason: it is
    /// full, it never existed, or its time to collect has run out. Zap then reverts the whole call,
    /// so the caller is not left holding IMD it paid a swap fee to buy.
    function test_chipIn_revertsWhenTheRealPotTakesNothing() public {
        uint256 full = pots.openPot(_terms(2e18), SPEC, 0);
        vm.prank(user);
        zap.chipIn{value: 0.01 ether}(full, 0, NO_DEADLINE);
        uint256 late = pots.openPot(_terms(5e18), SPEC, 0);
        skip(1 days + 1);
        assertEq(pots.remaining(late), 0, "the pot's time to collect is over");
        uint256 ethBefore = user.balance;

        vm.startPrank(user);
        vm.expectRevert(Zap.NothingChipped.selector);
        zap.chipIn{value: 0.01 ether}(full, 0, NO_DEADLINE);
        vm.expectRevert(Zap.NothingChipped.selector);
        zap.chipIn{value: 0.01 ether}(999, 0, NO_DEADLINE);
        vm.expectRevert(Zap.NothingChipped.selector);
        zap.chipIn{value: 0.01 ether}(late, 0, NO_DEADLINE);
        vm.stopPrank();
        assertEq(user.balance, ethBefore);
    }

    /// @dev A chip sent to a series id lands in the series' current round, a pot with an id of its
    /// own, and is the caller's there.
    function test_chipIn_aSeriesIdChipsIntoItsCurrentRound() public {
        uint256 seriesId = pots.openSeries(_terms(5e18), SPEC);
        vm.prank(user);
        (, uint256 chipped) = zap.chipIn{value: 0.01 ether}(seriesId, 0, NO_DEADLINE);
        assertEq(chipped, 3e18);
        uint256 round = pots.currentRound(seriesId);
        assertGt(round, seriesId);
        (uint256 amount,,) = pots.chipOf(round, user);
        assertEq(amount, 3e18);
        assertEq(pots.remaining(seriesId), 2e18);
    }

    /// @dev "Any refund of it belongs to the caller", followed to the end on the real contracts: a
    /// pot filled through Zap hires on the real desk, nobody takes the order, the desk refunds the
    /// pot, and the pot pays the caller. Zap is owed nothing.
    function test_chipIn_aRefundOfTheChipGoesToTheCallerNotToZap() public {
        uint256 potId = pots.openPot(_terms(3e18), SPEC, 0);
        vm.prank(user);
        zap.chipIn{value: 0.01 ether}(potId, 3e18, NO_DEADLINE);
        uint256 orderId = pots.launch(potId, SPEC);
        assertEq(uint8(desk.stateOf(orderId)), uint8(IWorkOrders.State.Open));

        skip(2 days);
        assertEq(pots.refundOf(potId, address(zap)), 0);
        assertEq(pots.refundOf(potId, user), 3e18);
        uint256 before = imd.balanceOf(user);
        assertEq(pots.claimRefund(potId, user), 3e18);
        assertEq(imd.balanceOf(user), before + 3e18);
        assertEq(uint8(pots.stageOf(potId)), uint8(CrowdPots.Stage.Refundable));
        assertEq(imd.balanceOf(address(zap)), 0);
    }
}
