// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Payroll} from "../../src/payroll/Payroll.sol";
import {PayrollSetup} from "./PayrollSetup.sol";

/// @dev Forty-five days of ordinary life in one test: fees and tips arrive, a keeper drips, tops up the
/// feeds and claims for seat owners, the feeds spend their meters. At the end every figure must agree.
contract PayrollScenarioTest is PayrollSetup {
    uint256 internal constant AGENT = 52211;
    uint256 internal constant SEAT = 1998;

    function test_scenario_fortyFiveDays() public {
        setFeedCosts(FEED_COST);
        adapter.bind(AGENT, address(seats), SEAT);
        uint256 stakedBefore = imd.balanceOf(address(simd));
        uint256 priceBefore = simd.convertToAssets(1e24);

        uint256 paidIn;
        uint256 tipped;
        uint256[] memory someSeats = new uint256[](40);
        for (uint256 i; i < 40; ++i) {
            someSeats[i] = i * 50;
        }

        for (uint256 day; day < 45; ++day) {
            // Three settlements a day: a fee through `pay`, a tip, and one fee that arrives as a plain
            // transfer because its `pay` call could not be made.
            pay(40e18 + day);
            pay(25e18);
            vm.prank(payer);
            imd.transfer(address(payroll), 15e18);
            paidIn += 80e18 + day;
            tipTo(ids(AGENT, 900 + day % 3), 4e18);
            tipped += 4e18;

            for (uint256 quarter; quarter < 4; ++quarter) {
                skip(6 hours);
                payroll.book();
                payroll.drip();
            }

            // The two daily feeds buy an answer each; the weekly one buys one a week.
            questions.spend(FEED_A, FEED_COST);
            questions.spend(FEED_B, FEED_COST);
            if (day % 7 == 0) questions.spend(FEED_C, FEED_COST);
            payroll.fundFeeds();
            for (uint256 f; f < 3; ++f) {
                // Fourteen requests for the two daily feeds, four for the weekly one.
                uint256 runway = (f == 2 ? 4 : 14) * FEED_COST;
                (uint256 balance,) = questions.meterOf([FEED_A, FEED_B, FEED_C][f]);
                assertLe(balance, runway, "a meter is never above its runway");
                // The first day's budget (16 IMD) covers the two daily meters (14.56) and leaves the
                // weekly one short; after that every meter is back at its runway each day.
                if (day != 0 || f != 2) assertEq(balance, runway);
            }

            if (day % 5 == 4) payroll.claimSeats(someSeats);
            payroll.claimTip(AGENT);
            assertBooksBalance();
        }

        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.received, paidIn);
        assertEq(l.tipsIn, tipped);
        assertEq(l.tipsClaimed, 45 * 2e18, "the bound agent's half of every tip reached its seat's owner");
        assertEq(imd.balanceOf(seats.ownerOf(SEAT)), l.tipsClaimed + payroll.seatPaid(SEAT));
        assertEq(payroll.tipOwed(900) + payroll.tipOwed(901) + payroll.tipOwed(902), 45 * 2e18, "the rest waits");

        // The feeds used about 1.1 IMD a day of a budget that grew by 16: the surplus went to stakers.
        uint256 onMeters;
        for (uint256 f; f < 3; ++f) {
            (uint256 balance,) = questions.meterOf([FEED_A, FEED_B, FEED_C][f]);
            onMeters += balance;
        }
        assertEq(l.feedsFunded, onMeters + imd.balanceOf(address(0xdead)), "funded == still on meters + spent");
        assertGt(l.feedsReleased, 0, "budget the meters never needed was released");
        // 20% of revenue, each of the 135 bookings rounded down by less than a wei.
        assertLe(l.toFeeds + l.feedsReleased, paidIn / 5);
        assertGe(l.toFeeds + l.feedsReleased + 135, paidIn / 5);
        (uint256 budget,,,) = payroll.feedBudget();
        assertLe(budget, 28 * 16.01e18, "no more than two fortnights of budget is ever held back");

        // Give the stream time to finish, then everything owed to stakers has arrived.
        skip(8 days);
        for (uint256 i; i < 170; ++i) {
            payroll.drip();
            skip(10 minutes);
        }
        l = payroll.ledger();
        assertEq(l.dripped, l.toStakers);
        assertEq(imd.balanceOf(address(simd)) - stakedBefore, l.dripped);
        assertGt(simd.convertToAssets(1e24), priceBefore);
        assertGe(l.toStakers, paidIn / 2, "stakers got at least their half");
        assertBooksBalance();
    }
}
