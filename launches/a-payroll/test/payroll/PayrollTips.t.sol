// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Payroll} from "../../src/payroll/Payroll.sol";
import {PayrollSetup} from "./PayrollSetup.sol";
import {RawResponder} from "./mocks/MockSeats.sol";

/// @dev Tips: an equal split over the agents that did a job, paid through the Adapter binding to the
/// owner of the agent's seat, and swept to the seat pool when they have waited 180 to 360 days without
/// becoming claimable.
contract PayrollTipsTest is PayrollSetup {
    event Tipped(address indexed from, uint256 amount, uint256 perAgent, uint256 toSeatPool, uint256[] agentIds);
    event TipClaimed(uint256 indexed agentId, uint256 indexed tokenId, address indexed owner, uint256 amount);
    event TipSwept(uint256 indexed agentId, uint256 amount);

    uint256 internal constant AGENT = 52211;
    uint256 internal constant SEAT = 1998;
    uint256 internal constant DELAY = 180 days;

    function setUp() public override {
        super.setUp();
        adapter.bind(AGENT, address(seats), SEAT);
    }

    /// @dev When a tip that arrived at `arrived` can first be swept: the start of the second 180-day
    /// period after the one it arrived in.
    function ripeAt(uint256 arrived) internal pure returns (uint256) {
        return (arrived / DELAY + 2) * DELAY;
    }

    function now_() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    // ---- tip

    function test_tip_splitsEquallyAndIsNotBookedAsRevenue() public {
        uint256[] memory list = ids(AGENT, 7, 8);
        vm.expectEmit(address(payroll));
        emit Tipped(payer, 9e18, 3e18, 0, list);
        tipTo(list, 9e18);

        assertEq(payroll.tipOwed(AGENT), 3e18);
        assertEq(payroll.tipOwed(7), 3e18);
        assertEq(payroll.tipOwed(8), 3e18);
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.tipsIn, 9e18);
        assertEq(l.received, 0, "a tip is not split 50 / 30 / 20");
        assertEq(l.tipsToSeats, 0);
        (,, uint256 tips,,) = payroll.owed();
        assertEq(tips, 9e18);
        assertBooksBalance();
    }

    function test_tip_remainderJoinsTheSeatPool() public {
        // 2000 seats; give the pool something that divides, plus a remainder from the split.
        tipTo(ids(1, 2, 3), 6_000e18 + 2);
        assertEq(payroll.tipOwed(1), 2_000e18);
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.tipsToSeats, 2);
        assertEq(payroll.seatCarry(), 2);
        (, uint256 seatPool, uint256 tips,,) = payroll.owed();
        assertEq(seatPool, 2);
        assertEq(tips, 6_000e18);
        assertBooksBalance();
    }

    function test_tip_emptyListSendsEverythingToTheSeatPool() public {
        uint256[] memory none = new uint256[](0);
        vm.expectEmit(address(payroll));
        emit Tipped(payer, 4_000e18, 0, 4_000e18, none);
        tipTo(none, 4_000e18);

        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.tipsIn, 4_000e18);
        assertEq(l.tipsToSeats, 4_000e18);
        assertEq(payroll.seatAccrued(), 2e18);
        assertEq(payroll.seatClaimable(0), 2e18);
        (,, uint256 tips,,) = payroll.owed();
        assertEq(tips, 0);
        assertBooksBalance();
    }

    function test_tip_duplicateIdsAreCreditedOncePerMention() public {
        tipTo(ids(5, 5, 6), 9e18);
        assertEq(payroll.tipOwed(5), 6e18);
        assertEq(payroll.tipOwed(6), 3e18);
        assertBooksBalance();
    }

    function test_tip_onlyTheFirstSixteenIdsShare() public {
        uint256[] memory list = new uint256[](20);
        for (uint256 i; i < 20; ++i) {
            list[i] = 100 + i;
        }
        uint256[] memory firstSixteen = new uint256[](16);
        for (uint256 i; i < 16; ++i) {
            firstSixteen[i] = 100 + i;
        }
        vm.expectEmit(address(payroll));
        emit Tipped(payer, 16e18, 1e18, 0, firstSixteen);
        tipTo(list, 16e18);

        assertEq(payroll.tipOwed(100), 1e18);
        assertEq(payroll.tipOwed(115), 1e18);
        assertEq(payroll.tipOwed(116), 0);
        assertEq(payroll.tipOwed(119), 0);
        assertBooksBalance();
    }

    function test_tip_tooSmallToSplitGoesToTheSeatPool() public {
        tipTo(ids(1, 2, 3), 2);
        assertEq(payroll.tipOwed(1), 0);
        assertEq(payroll.ledger().tipsToSeats, 2);
        (uint256 unpaid, uint256 sweepable, uint256 nextSweepableAt) = payroll.tipOf(1);
        assertEq(unpaid + sweepable + nextSweepableAt, 0, "no wait starts for a tip of nothing");
        assertBooksBalance();
    }

    function test_tip_zeroDoesNothing() public {
        vm.recordLogs();
        tipTo(ids(1), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(payroll.ledger().tipsIn, 0);
    }

    /// @dev Whatever the list holds, `tip` takes the money and does not revert.
    function test_tip_acceptsAnyIds() public {
        adapter.setDown(true);
        tipTo(ids(0, type(uint256).max, 1 << 200), 3e18);
        assertEq(payroll.tipOwed(type(uint256).max), 1e18);
        assertEq(payroll.tipOwed(0), 1e18);
    }

    function test_tip_revertsOnlyWhenTheTransferDoes() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        payroll.tip(ids(1), 1e18);
    }

    /// @dev The three ways a tip meets a slot: never tipped, tipped earlier in the same period, and
    /// tipped in an earlier period (the older tranches are aged first). The sum owed is right in each.
    function test_tip_addsUpAcrossPeriods() public {
        tipTo(ids(77), 1e18);
        tipTo(ids(77), 2e18);
        assertEq(payroll.tipOwed(77), 3e18);

        skip(DELAY);
        tipTo(ids(77), 4e18);
        assertEq(payroll.tipOwed(77), 7e18);

        skip(3 * DELAY);
        tipTo(ids(77), 8e18);
        assertEq(payroll.tipOwed(77), 15e18);
        (uint256 unpaid, uint256 sweepable,) = payroll.tipOf(77);
        assertEq(unpaid, 15e18);
        assertEq(sweepable, 7e18, "everything from two or more periods back has waited");
        assertBooksBalance();
    }

    // ---- claimTip

    function test_claimTip_paysTheOwnerOfTheBoundSeat() public {
        tipTo(ids(AGENT), 5e18);
        address owner = seats.ownerOf(SEAT);

        vm.expectEmit(address(payroll));
        emit TipClaimed(AGENT, SEAT, owner, 5e18);
        vm.prank(keeper);
        uint256 paid = payroll.claimTip(AGENT);

        assertEq(paid, 5e18);
        assertEq(imd.balanceOf(owner), 5e18);
        assertEq(imd.balanceOf(keeper), 0);
        assertEq(payroll.tipOwed(AGENT), 0);
        assertEq(payroll.ledger().tipsClaimed, 5e18);
        (uint256 unpaid, uint256 sweepable, uint256 nextSweepableAt) = payroll.tipOf(AGENT);
        assertEq(unpaid + sweepable + nextSweepableAt, 0);
        assertBooksBalance();
    }

    function test_claimTip_paysWhoeverOwnsTheSeatNow() public {
        tipTo(ids(AGENT), 5e18);
        address buyer = makeAddr("buyer");
        seats.setOwner(SEAT, buyer);
        payroll.claimTip(AGENT);
        assertEq(imd.balanceOf(buyer), 5e18);
    }

    /// @dev A claim pays tips of every age at once, including the part that could have been swept.
    function test_claimTip_paysTipsOfEveryAge() public {
        tipTo(ids(AGENT), 1e18);
        skip(DELAY);
        tipTo(ids(AGENT), 2e18);
        skip(DELAY);
        tipTo(ids(AGENT), 4e18);
        (, uint256 sweepable,) = payroll.tipOf(AGENT);
        assertEq(sweepable, 1e18);

        assertEq(payroll.claimTip(AGENT), 7e18);
        assertEq(imd.balanceOf(seats.ownerOf(SEAT)), 7e18);
        assertEq(payroll.tipOwed(AGENT), 0);
        assertBooksBalance();
    }

    function test_claimTip_nothingOwedReturnsZeroWithoutAskingTheAdapter() public {
        adapter.setDown(true);
        assertEq(payroll.claimTip(AGENT), 0);
        assertEq(payroll.claimTip(424242), 0);
    }

    function test_claimTip_revertsForAnUnboundAgent() public {
        tipTo(ids(77), 5e18);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentNotBound.selector, 77));
        payroll.claimTip(77);
        assertEq(payroll.tipOwed(77), 5e18, "the tip waits");
    }

    function test_claimTip_revertsWhenTheAdapterReverts() public {
        tipTo(ids(AGENT), 5e18);
        adapter.setDown(true);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentNotBound.selector, AGENT));
        payroll.claimTip(AGENT);

        adapter.setDown(false);
        assertEq(payroll.claimTip(AGENT), 5e18);
    }

    function test_claimTip_revertsWhenBoundToAnotherToken() public {
        tipTo(ids(88), 5e18);
        adapter.bind(88, address(0x0717E12), 3);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentBoundElsewhere.selector, 88));
        payroll.claimTip(88);
    }

    function test_claimTip_revertsWhenTheTokenIdIsNotASeat() public {
        tipTo(ids(88), 5e18);
        adapter.bind(88, address(seats), SEAT_COUNT);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentBoundElsewhere.selector, 88));
        payroll.claimTip(88);
    }

    function test_claimTip_revertsWhenTheSeatHasNoOwner() public {
        tipTo(ids(AGENT), 5e18);
        seats.setReverting(SEAT, true);
        vm.expectRevert(abi.encodeWithSelector(Payroll.SeatHasNoOwner.selector, SEAT));
        payroll.claimTip(AGENT);
        seats.setReverting(SEAT, false);
        assertEq(payroll.claimTip(AGENT), 5e18);
    }

    /// @dev An Adapter that answers with something other than a clean 96-byte binding.
    function test_claimTip_treatsMalformedAnswersAsNotClaimable() public {
        RawResponder odd = new RawResponder();
        Payroll p = payrollWithAdapter(address(odd));
        vm.prank(payer);
        p.tip(ids(AGENT), 5e18);

        // 64 bytes: too short to be a binding.
        odd.program(abi.encode(uint256(0), address(seats)), false);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentNotBound.selector, AGENT));
        p.claimTip(AGENT);

        // Nothing at all.
        odd.program("", false);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentNotBound.selector, AGENT));
        p.claimTip(AGENT);

        // The seat token's address with stray bits above it is not the seat token.
        odd.program(abi.encode(uint256(0), uint256(1) << 160 | uint160(address(seats)), SEAT), false);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentBoundElsewhere.selector, AGENT));
        p.claimTip(AGENT);

        // A revert carrying 96 bytes of plausible data is still a revert.
        odd.program(abi.encode(uint256(0), address(seats), SEAT), true);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentNotBound.selector, AGENT));
        p.claimTip(AGENT);

        // A clean answer, even a long one, pays.
        odd.program(abi.encode(uint256(0), address(seats), SEAT, uint256(1), uint256(2)), false);
        assertEq(p.claimTip(AGENT), 5e18);
        assertEq(imd.balanceOf(seats.ownerOf(SEAT)), 5e18);
    }

    function test_claimTip_whenTheAdapterHasNoCode() public {
        Payroll p = payrollWithAdapter(address(0xADA));
        vm.prank(payer);
        p.tip(ids(AGENT), 5e18);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentNotBound.selector, AGENT));
        p.claimTip(AGENT);
    }

    // ---- sweepTip: the wait

    function test_sweepTip_movesAnUnboundAgentsTipsToTheSeatPoolOnceTheyHaveWaited() public {
        tipTo(ids(77), 4_000e18);
        uint256 arrived = now_();
        uint256 due = ripeAt(arrived);
        assertGe(due - arrived, 180 days);
        assertLe(due - arrived, 360 days);

        (uint256 unpaid, uint256 sweepable, uint256 nextSweepableAt) = payroll.tipOf(77);
        assertEq(unpaid, 4_000e18);
        assertEq(sweepable, 0);
        assertEq(nextSweepableAt, due);

        vm.warp(due - 1);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipNotSweepableYet.selector, 77, due));
        payroll.sweepTip(77);

        vm.warp(due);
        (, sweepable, nextSweepableAt) = payroll.tipOf(77);
        assertEq(sweepable, 4_000e18);
        assertEq(nextSweepableAt, 0, "nothing else is waiting");

        vm.expectEmit(address(payroll));
        emit TipSwept(77, 4_000e18);
        vm.prank(keeper);
        assertEq(payroll.sweepTip(77), 4_000e18);

        assertEq(payroll.tipOwed(77), 0);
        assertEq(payroll.seatClaimable(0), 2e18, "every seat got an equal part");
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.tipsToSeats, 4_000e18);
        assertEq(l.tipsClaimed, 0);
        assertEq(imd.balanceOf(keeper), 0);
        assertBooksBalance();
    }

    /// @dev The wait is at least 180 days (a tip in the last second of a period) and at most 360 (a tip
    /// in its first second).
    function test_sweepTip_aTipWaitsBetween180And360Days() public {
        uint256 periodStart = (now_() / DELAY + 1) * DELAY;

        vm.warp(periodStart);
        tipTo(ids(1), 1e18);
        vm.warp(periodStart + DELAY - 1);
        tipTo(ids(2), 1e18);

        vm.warp(periodStart + 2 * DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipNotSweepableYet.selector, 1, periodStart + 2 * DELAY));
        payroll.sweepTip(1);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipNotSweepableYet.selector, 2, periodStart + 2 * DELAY));
        payroll.sweepTip(2);

        vm.warp(periodStart + 2 * DELAY);
        assertEq(payroll.sweepTip(1), 1e18, "tipped in the first second: 360 days");
        assertEq(payroll.sweepTip(2), 1e18, "tipped in the last second: 180 days and a second");
    }

    /// @dev Reviewers' finding, as a regression test. Brief, decision 8: tips for agents that stay
    /// unbound for 180 days fall to the seat pool. Before the fix every tip, however small, restarted
    /// the wait of everything owed to the agent, so one wei twice a year held any sum out of the seat
    /// pool for good. Now each tip keeps its own wait.
    function test_sweepTip_oneWeiTipsCannotHoldOlderTipsOutOfTheSeatPool() public {
        uint256 unboundAgent = 77;
        tipTo(ids(unboundAgent), 4_000e18);
        uint256 arrived = now_();

        address stranger = makeAddr("stranger");
        imd.mint(stranger, 5);
        vm.prank(stranger);
        imd.approve(address(payroll), 5);

        for (uint256 i; i < 5; ++i) {
            skip(179 days);
            vm.prank(stranger);
            payroll.tip(ids(unboundAgent), 1);
        }
        assertEq(now_() - arrived, 895 days);
        assertEq(payroll.tipOwed(unboundAgent), 4_000e18 + 5);

        // The 4,000 IMD and the three single wei that have waited their own time go; the two newest
        // wei keep waiting.
        assertEq(payroll.sweepTip(unboundAgent), 4_000e18 + 3);
        assertEq(payroll.tipOwed(unboundAgent), 2);
        assertEq(payroll.ledger().tipsToSeats, 4_000e18 + 3);
        assertBooksBalance();
    }

    /// @dev The same finding in its smallest form: a one-wei tip on the last day does not move the day
    /// the older tip can be swept.
    function test_sweepTip_aLaterTipDoesNotDelayAnEarlierOne() public {
        tipTo(ids(77), 50e18);
        uint256 due = ripeAt(now_());

        vm.warp(due - 1 days);
        tipTo(ids(77), 1);
        uint256 dueOfTheWei = ripeAt(now_());
        assertGt(dueOfTheWei, due);

        vm.warp(due);
        assertEq(payroll.sweepTip(77), 50e18);
        assertEq(payroll.tipOwed(77), 1);

        (, uint256 sweepable, uint256 nextSweepableAt) = payroll.tipOf(77);
        assertEq(sweepable, 0);
        assertEq(nextSweepableAt, dueOfTheWei);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipNotSweepableYet.selector, 77, dueOfTheWei));
        payroll.sweepTip(77);
    }

    /// @dev Only what has waited is moved; newer tips stay owed and are swept in their own time.
    function test_sweepTip_takesOnlyWhatHasWaited() public {
        tipTo(ids(77), 1e18);
        uint256 firstDue = ripeAt(now_());
        skip(DELAY);
        tipTo(ids(77), 2e18);
        uint256 secondDue = ripeAt(now_());
        assertEq(secondDue, firstDue + DELAY);

        vm.warp(firstDue);
        assertEq(payroll.sweepTip(77), 1e18);
        assertEq(payroll.tipOwed(77), 2e18);
        (uint256 unpaid, uint256 sweepable, uint256 nextSweepableAt) = payroll.tipOf(77);
        assertEq(unpaid, 2e18);
        assertEq(sweepable, 0);
        assertEq(nextSweepableAt, secondDue);

        vm.warp(secondDue);
        assertEq(payroll.sweepTip(77), 2e18);
        assertEq(payroll.tipOwed(77), 0);
        assertEq(payroll.sweepTip(77), 0, "nothing left");
        assertEq(payroll.ledger().tipsToSeats, 3e18);
        assertBooksBalance();
    }

    function test_sweepTip_nothingOwedReturnsZero() public {
        skip(400 days);
        assertEq(payroll.sweepTip(77), 0);
    }

    /// @dev Tips at random times, a sweep after each wait. What a sweep moves is exactly the tips whose
    /// own wait is over; each of them waited at least 180 days, and nothing still owed after a sweep
    /// has waited 360.
    function testFuzz_sweepTip_everyTipKeepsItsOwnWait(uint32[6] memory gaps, uint64[6] memory amounts) public {
        uint256[6] memory arrived;
        uint256[6] memory amount;
        bool[6] memory gone;

        for (uint256 i; i < 6; ++i) {
            amount[i] = bound(amounts[i], 1, 1_000e18);
            arrived[i] = now_();
            tipTo(ids(77), amount[i]);
            skip(bound(gaps[i], 1, 250 days));

            uint256 expected;
            uint256 stillOwed;
            uint256 nextDue = type(uint256).max;
            for (uint256 k; k <= i; ++k) {
                if (gone[k]) continue;
                if (ripeAt(arrived[k]) <= now_()) {
                    expected += amount[k];
                } else {
                    stillOwed += amount[k];
                    if (ripeAt(arrived[k]) < nextDue) nextDue = ripeAt(arrived[k]);
                }
            }

            if (expected != 0) {
                assertEq(payroll.sweepTip(77), expected);
                for (uint256 k; k <= i; ++k) {
                    if (gone[k] || ripeAt(arrived[k]) > now_()) continue;
                    gone[k] = true;
                    assertGe(now_() - arrived[k], 180 days, "swept before its own 180 days");
                }
            } else {
                vm.expectRevert(abi.encodeWithSelector(Payroll.TipNotSweepableYet.selector, 77, nextDue));
                payroll.sweepTip(77);
            }
            assertEq(payroll.tipOwed(77), stillOwed);
            for (uint256 k; k <= i; ++k) {
                if (!gone[k]) assertLt(now_() - arrived[k], 360 days, "still owed after 360 days");
            }
        }
        assertBooksBalance();
    }

    function test_sweepTip_afterAClaimANewTipWaitsItsOwnTime() public {
        tipTo(ids(AGENT), 1e18);
        skip(170 days);
        payroll.claimTip(AGENT);

        tipTo(ids(AGENT), 1e18);
        uint256 due = ripeAt(now_());
        adapter.unbind(AGENT);
        vm.warp(due - 1);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipNotSweepableYet.selector, AGENT, due));
        payroll.sweepTip(AGENT);
        vm.warp(due);
        assertEq(payroll.sweepTip(AGENT), 1e18);
    }

    // ---- sweepTip: only what cannot be claimed

    function test_sweepTip_neverTakesATipThatCanBeClaimed() public {
        tipTo(ids(AGENT), 5e18);
        skip(400 days);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipStillClaimable.selector, AGENT, SEAT));
        payroll.sweepTip(AGENT);
        assertEq(payroll.claimTip(AGENT), 5e18);
    }

    function test_sweepTip_agentBoundInTimeKeepsItsTip() public {
        tipTo(ids(77), 5e18);
        vm.warp(ripeAt(now_()) - 1 days);
        adapter.bind(77, address(seats), 12);
        skip(30 days);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipStillClaimable.selector, 77, 12));
        payroll.sweepTip(77);
        assertEq(payroll.claimTip(77), 5e18);
        assertEq(imd.balanceOf(seats.ownerOf(12)), 5e18);
    }

    function test_sweepTip_takesATipBoundToAnotherToken() public {
        tipTo(ids(88), 5e18);
        adapter.bind(88, address(0x0717E12), 3);
        vm.warp(ripeAt(now_()));
        assertEq(payroll.sweepTip(88), 5e18);
        assertBooksBalance();
    }

    /// @dev Reviewers' note, fixed: an agent bound to a seat whose owner the seat token does not name
    /// can never be paid by `claimTip`. After its wait such a tip goes to the seat pool like any
    /// other that cannot be claimed, so it has a way out.
    function test_sweepTip_takesATipBoundToASeatNobodyOwns() public {
        tipTo(ids(AGENT), 4_000e18);
        uint256 due = ripeAt(now_());
        seats.setReverting(SEAT, true);

        vm.expectRevert(abi.encodeWithSelector(Payroll.SeatHasNoOwner.selector, SEAT));
        payroll.claimTip(AGENT);
        vm.warp(due - 1);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipNotSweepableYet.selector, AGENT, due));
        payroll.sweepTip(AGENT);

        vm.warp(due);
        assertEq(payroll.sweepTip(AGENT), 4_000e18);
        assertEq(payroll.tipOwed(AGENT), 0);
        assertEq(payroll.seatClaimable(0), 2e18);
        assertBooksBalance();
    }

    /// @dev While the seat has an owner at the moment of the call, the tip is claimable and stays.
    function test_sweepTip_aSeatThatHasItsOwnerBackKeepsTheTip() public {
        tipTo(ids(AGENT), 5e18);
        seats.setReverting(SEAT, true);
        vm.warp(ripeAt(now_()));
        seats.setReverting(SEAT, false);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipStillClaimable.selector, AGENT, SEAT));
        payroll.sweepTip(AGENT);
        assertEq(payroll.claimTip(AGENT), 5e18);
    }

    // ---- gas given to the reads a sweep or a claim depends on

    /// @dev A caller cannot make a bound agent look unbound by sending little gas: whatever gas the call
    /// is given, a sweep of a claimable tip never goes through.
    function testFuzz_sweepTip_lowGasNeverSweepsABoundAgent(uint256 gasGiven) public {
        gasGiven = bound(gasGiven, 30_000, 400_000);
        tipTo(ids(AGENT), 5e18);
        adapter.setBurn(60_000); // an Adapter that needs a fair part of its allowance
        skip(400 days);

        try payroll.sweepTip{gas: gasGiven}(AGENT) {
            fail();
        } catch {}
        assertEq(payroll.tipOwed(AGENT), 5e18);
        assertEq(payroll.ledger().tipsToSeats, 0);
    }

    /// @dev Nor can a caller make an owned seat look ownerless. The seat token here needs six million
    /// gas to answer, so a read given less runs out of gas and comes back empty-handed, with up to a
    /// 64th of its gas left over for the caller: enough to finish a sweep, were it not for the margin
    /// Payroll demands after a failed read. Whatever gas is sent, a claimable tip is never swept.
    function testFuzz_sweepTip_lowGasNeverMakesAnOwnedSeatLookOwnerless(uint256 gasGiven) public {
        gasGiven = bound(gasGiven, 30_000, 12_000_000);
        // Something already in the seat pool, so that a sweep would need little gas to finish.
        tipTo(new uint256[](0), 2_000e18 + 1);
        tipTo(ids(AGENT), 5e18);
        seats.setBurn(6_000_000);
        skip(400 days);
        uint256 toSeatsBefore = payroll.ledger().tipsToSeats;

        try payroll.sweepTip{gas: gasGiven}(AGENT) {
            fail();
        } catch {}
        assertEq(payroll.tipOwed(AGENT), 5e18);
        assertEq(payroll.ledger().tipsToSeats, toSeatsBefore);

        // With gas to spare the owner is heard and the tip is still not swept, because it can be claimed.
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipStillClaimable.selector, AGENT, SEAT));
        payroll.sweepTip{gas: 20_000_000}(AGENT);
    }

    /// @dev A failed owner read that leaves too little gas to be believed is reported as `GasTooLow`.
    /// Five million gas is not enough for this seat token to answer; the read runs out and about
    /// 77,000 gas is left, which would have been plenty to finish the sweep.
    function test_sweepTip_reportsTooLittleGasAfterAFailedOwnerRead() public {
        tipTo(new uint256[](0), 2_000e18 + 1);
        tipTo(ids(AGENT), 5e18);
        seats.setBurn(6_000_000);
        skip(400 days);
        vm.expectRevert(Payroll.GasTooLow.selector);
        payroll.sweepTip{gas: 5_000_000}(AGENT);
        assertEq(payroll.tipOwed(AGENT), 5e18);
    }

    function test_adapterRead_reportsTooLittleGas() public {
        tipTo(ids(AGENT), 5e18);
        vm.expectRevert(Payroll.GasTooLow.selector);
        payroll.claimTip{gas: 90_000}(AGENT);

        skip(400 days);
        vm.expectRevert(Payroll.GasTooLow.selector);
        payroll.sweepTip{gas: 90_000}(AGENT);
    }

    function test_adapterRead_anAdapterWithinItsAllowanceIsHeard() public {
        tipTo(ids(AGENT), 5e18);
        adapter.setBurn(80_000);
        assertEq(payroll.claimTip(AGENT), 5e18);
    }

    /// @dev The read is capped: an Adapter that needs more than `BINDING_GAS` is treated as silent, for
    /// every caller alike, however much gas the transaction carries.
    function test_adapterRead_anAdapterBeyondItsAllowanceIsNotHeard() public {
        tipTo(ids(AGENT), 5e18);
        adapter.setBurn(150_000);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentNotBound.selector, AGENT));
        payroll.claimTip{gas: 5_000_000}(AGENT);
    }

    function payrollWithAdapter(address adapter_) internal returns (Payroll p) {
        p = new Payroll(
            address(imd),
            address(simd),
            address(seats),
            SEAT_COUNT,
            adapter_,
            address(questions),
            FEED_A,
            FEED_B,
            FEED_C
        );
        vm.prank(payer);
        imd.approve(address(p), type(uint256).max);
    }
}
