// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Payroll} from "../../src/payroll/Payroll.sol";
import {PayrollSetup} from "./PayrollSetup.sol";

/// @dev Fuzz tests of the arithmetic: the split, the tip split, the stream and the feed top-up.
contract PayrollFuzzTest is PayrollSetup {
    function testFuzz_split_isExactAndFavoursStakers(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000e18);
        pay(amount);
        Payroll.Ledger memory l = payroll.ledger();

        assertEq(l.toSeats, (amount * 3_000) / 10_000);
        assertEq(l.toFeeds, (amount * 2_000) / 10_000);
        assertEq(l.toStakers, amount - l.toSeats - l.toFeeds);
        assertEq(l.toStakers + l.toSeats + l.toFeeds, amount, "no wei created or lost");
        assertGe(l.toStakers * 2, amount, "stakers get at least half");
        assertLe(l.toStakers - amount / 2, 2, "and at most the rounding remainder on top");
        assertBooksBalance();
    }

    function testFuzz_split_holdsOverManyBookings(uint96[8] memory amounts) public {
        uint256 sum;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 0, 10_000_000e18);
            pay(amount);
            sum += amount;
        }
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.received, sum);
        assertEq(l.toStakers + l.toSeats + l.toFeeds, sum);
        assertBooksBalance();
    }

    function testFuzz_book_splitsExactlyLikePay(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000e18);
        uint256 snapshot = vm.snapshotState();
        pay(amount);
        Payroll.Ledger memory viaPay = payroll.ledger();
        vm.revertToState(snapshot);

        vm.prank(payer);
        imd.transfer(address(payroll), amount);
        assertEq(payroll.book(), amount);
        Payroll.Ledger memory viaBook = payroll.ledger();

        assertEq(viaBook.toStakers, viaPay.toStakers);
        assertEq(viaBook.toSeats, viaPay.toSeats);
        assertEq(viaBook.toFeeds, viaPay.toFeeds);
    }

    function testFuzz_tip_conservesEveryWei(uint256 amount, uint8 count, uint256 seed) public {
        amount = bound(amount, 1, 1_000_000e18);
        uint256 n = bound(count, 0, 24);
        uint256[] memory list = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            // A small id space, so duplicates are common.
            list[i] = uint256(keccak256(abi.encode(seed, i))) % 10;
        }
        tipTo(list, amount);

        uint256 credited;
        for (uint256 id; id < 10; ++id) {
            credited += payroll.tipOwed(id);
        }
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.tipsIn, amount);
        assertEq(credited + l.tipsToSeats, amount, "credited to agents + sent to the seat pool == tip");
        uint256 sharers = n > 16 ? 16 : n;
        if (sharers != 0) {
            assertEq(credited, (amount / sharers) * sharers);
            assertLt(l.tipsToSeats, sharers, "only the remainder of the split reaches the pool");
        }
        assertBooksBalance();
    }

    /// @dev Bookings, waits and drips in any order: no drip exceeds the cap, the total never exceeds
    /// what stakers were given, and with enough time everything arrives.
    function testFuzz_stream_paysEverythingAndNeverMoreThanTheCap(uint96[6] memory amounts, uint32[6] memory waits)
        public
    {
        for (uint256 i; i < 6; ++i) {
            pay(bound(amounts[i], 0, 1_000_000e18));
            skip(bound(waits[i], 0, 10 days));
            (,,,, uint256 nextDripAt, uint256 dueNow) = payroll.stream();
            if (vm.getBlockTimestamp() >= nextDripAt) {
                uint256 cap = payroll.dripCap();
                uint256 sent = payroll.drip();
                assertEq(sent, dueNow);
                assertLe(sent, cap);
            }
            Payroll.Ledger memory l = payroll.ledger();
            assertLe(l.dripped, l.toStakers);
            assertLe(payroll.streamUnvested(), l.toStakers - l.dripped);
        }

        skip(8 days);
        for (uint256 i; i < 170; ++i) {
            payroll.drip();
            skip(10 minutes);
        }
        Payroll.Ledger memory end = payroll.ledger();
        assertEq(end.dripped, end.toStakers, "168 capped calls after the stream ends deliver all of it");
        assertBooksBalance();
    }

    function testFuzz_feeds_neverFundBeyondTheRunwayOrTheBudget(uint256 revenue, uint256 cost, uint64[3] memory held)
        public
    {
        revenue = bound(revenue, 0, 100_000e18);
        cost = bound(cost, 0, 10e18);
        setFeedCosts(cost);
        bytes32[3] memory feeds = [FEED_A, FEED_B, FEED_C];
        uint256[3] memory before;
        for (uint256 i; i < 3; ++i) {
            before[i] = bound(held[i], 0, 40e18);
            if (before[i] != 0) {
                imd.mint(address(this), before[i]);
                imd.approve(address(questions), before[i]);
                questions.fund(feeds[i], before[i]);
            }
        }
        pay(revenue);
        uint256 budget = payroll.ledger().toFeeds;

        (uint256 funded,) = payroll.fundFeeds();

        // What somebody else holds on a meter is not Payroll's runway (audit job be91e8ae, finding
        // 2): Payroll places up to one runway of its own on each meter, whatever `before` is.
        uint256 assumed = cost > 2e18 ? 2e18 : cost;
        uint256 placed;
        uint256[3] memory got;
        for (uint256 i; i < 3; ++i) {
            // Fourteen requests for the first two feeds, four for the third.
            uint256 target = (i == 2 ? 4 : 14) * assumed;
            (uint256 balance,) = questions.meterOf(feeds[i]);
            got[i] = balance - before[i];
            assertLe(got[i], target, "Payroll placed more than one runway on a meter");
            assertEq(questions.redeemable(feeds[i], address(payroll)), got[i], "Payroll's position is what it placed");
            assertEq(questions.redeemable(feeds[i], address(this)), before[i], "the other funder's part moved");
            placed += got[i];
        }
        assertEq(placed, funded);
        assertLe(funded, budget);

        // The third feed is served only when the first two were offered everything they lacked.
        uint256 lackA = 14 * assumed;
        uint256 lackB = 14 * assumed;
        if (lackA + lackB > budget) {
            assertEq(got[2], 0, "the third feed took budget the first two still needed");
            assertEq(got[0], (budget * lackA) / (lackA + lackB));
            assertEq(got[1], (budget * lackB) / (lackA + lackB));
        } else {
            assertEq(got[0], lackA);
            assertEq(got[1], lackB);
            uint256 lackC = 4 * assumed;
            assertEq(got[2], lackC > budget - lackA - lackB ? budget - lackA - lackB : lackC);
        }
        assertBooksBalance();
    }

    /// @dev Budget is released only after it has waited at least one full fortnight, and never later
    /// than the second boundary after it was booked.
    function testFuzz_feedBudget_waitsBetweenOneAndTwoFortnights(uint96 amount, uint32 wait) public {
        uint256 revenue = bound(amount, 10, 1_000_000e18);
        uint256 waited = bound(wait, 0, 60 days);
        pay(revenue);
        uint256 budget = payroll.ledger().toFeeds;
        uint256 bookedIn = vm.getBlockTimestamp() / 14 days;

        skip(waited);
        (, uint256 released) = payroll.fundFeeds(); // costs are zero: nothing can be placed
        uint256 boundaries = vm.getBlockTimestamp() / 14 days - bookedIn;

        if (boundaries >= 2) {
            assertEq(released, budget);
            assertGe(waited, 14 days);
        } else {
            assertEq(released, 0);
            assertLt(waited, 28 days);
        }
        assertBooksBalance();
    }
}

/// @dev Seat accounting with seven seats, where almost nothing divides evenly.
contract PayrollSeatFuzzTest is PayrollSetup {
    function seatCount() internal pure override returns (uint256) {
        return 7;
    }

    /// @dev Any mix of bookings, tips to the pool and claims: every seat is paid exactly what accrued to
    /// it, the pool is never overpaid, and the only money left behind is the carry.
    function testFuzz_seatPool_paysEachSeatExactlyItsShare(uint64[10] memory amounts, uint8[10] memory picks) public {
        uint256[7] memory paid;
        uint256 given;
        for (uint256 i; i < 10; ++i) {
            uint256 amount = bound(amounts[i], 0, 1_000e18);
            if (picks[i] % 3 == 0) {
                tipTo(new uint256[](0), amount); // straight to the seat pool
                given += amount;
            } else {
                pay(amount);
                given += (amount * 3_000) / 10_000;
            }
            uint256 seat = picks[i] % 7;
            uint256 claimable = payroll.seatClaimable(seat);
            uint256 before = imd.balanceOf(seats.ownerOf(seat));
            assertEq(payroll.claimSeat(seat), claimable);
            assertEq(imd.balanceOf(seats.ownerOf(seat)) - before, claimable);
            paid[seat] += claimable;

            uint256 accrued = payroll.seatAccrued();
            assertEq(accrued * 7 + payroll.seatCarry(), given, "accrued to all seats + carry == given to the pool");
            assertEq(paid[seat], accrued, "a seat that just claimed has had exactly what accrued to it");
            for (uint256 s; s < 7; ++s) {
                assertLe(paid[s], accrued, "no seat is ever ahead of its share");
                assertEq(payroll.seatPaid(s), paid[s]);
            }
        }
        uint256 sum;
        for (uint256 s; s < 7; ++s) {
            sum += paid[s];
        }
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.seatClaimed, sum);
        assertLe(sum, given);
        assertBooksBalance();
    }

    function testFuzz_seat_claimsDoNotMoveAnotherSeatsShare(uint64 amount, uint8 a, uint8 b, uint8 repeats) public {
        uint256 seatA = a % 7;
        uint256 seatB = b % 7;
        vm.assume(seatA != seatB);
        pay(bound(amount, 1, 1_000_000e18));
        uint256 shareOfB = payroll.seatClaimable(seatB);
        uint256 balanceOfB = imd.balanceOf(seats.ownerOf(seatB));

        uint256 claimedByA;
        for (uint256 i; i < uint256(repeats % 5) + 1; ++i) {
            claimedByA += payroll.claimSeat(seatA);
            claimedByA += payroll.claimSeats(ids(seatA, seatA, seatA));
        }
        assertEq(claimedByA, shareOfB, "seat A was paid one share, however often it claimed");
        assertEq(payroll.seatClaimable(seatB), shareOfB);
        assertEq(imd.balanceOf(seats.ownerOf(seatB)), balanceOfB);
    }
}
