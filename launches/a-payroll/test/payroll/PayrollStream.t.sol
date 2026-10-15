// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Payroll} from "../../src/payroll/Payroll.sol";
import {PayrollSetup} from "./PayrollSetup.sol";
import {MockIMD, MockSIMD, HoldlessSIMD} from "./mocks/MockTokens.sol";
import {RawResponder} from "./mocks/MockSeats.sol";

/// @dev A whole visit to a staking vault as one transaction, paid for with somebody else's IMD:
/// borrow, stake, make Payroll drip, leave, repay, keep the difference. Possible only against a vault
/// with no hold on fresh deposits, which the real sIMD is not.
contract LoanedVisit {
    function visit(MockIMD imd, HoldlessSIMD vault, Payroll payroll, address lender, uint256 amount)
        external
        returns (uint256 gain)
    {
        imd.transferFrom(lender, address(this), amount);
        imd.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, address(this));
        payroll.drip();
        uint256 back = vault.redeem(shares, address(this), address(this));
        imd.transfer(lender, amount);
        gain = back - amount;
    }
}

/// @dev The staker stream: vesting over seven days, the weighted end time a booking gives it, and
/// `drip`.
contract PayrollStreamTest is PayrollSetup {
    event Dripped(address indexed caller, uint256 amount, uint256 outstanding);

    uint256 internal constant STREAM = 168e18; // one IMD an hour, exactly

    function setUp() public override {
        super.setUp();
        pay(STREAM * 2); // half of it is the staker stream
    }

    function test_drip_nothingHasVestedInTheBookingBlock() public {
        uint256 before = imd.balanceOf(address(simd));
        assertEq(payroll.drip(), 0);
        assertEq(imd.balanceOf(address(simd)), before);
        (,, uint64 lastDripAt,) = payroll.clock();
        assertEq(lastDripAt, 0, "a drip that sent nothing must not start the ten-minute gap");
    }

    function test_drip_sendsWhatVestedToSIMD() public {
        skip(1 hours);
        uint256 assetsBefore = simd.totalAssets();
        uint256 priceBefore = simd.convertToAssets(1e24);

        vm.expectEmit(address(payroll));
        emit Dripped(keeper, 1e18, STREAM - 1e18);
        vm.prank(keeper);
        uint256 sent = payroll.drip();

        assertEq(sent, 1e18);
        assertEq(simd.totalAssets(), assetsBefore + 1e18, "a plain transfer raises totalAssets");
        assertGt(simd.convertToAssets(1e24), priceBefore, "and with it the price of every share");
        assertEq(payroll.ledger().dripped, 1e18);
        assertEq(imd.balanceOf(keeper), 0, "the caller earns nothing");
        assertBooksBalance();
    }

    function test_drip_revertsInsideTheTenMinuteGap() public {
        skip(1 hours);
        payroll.drip();
        uint256 notBefore = vm.getBlockTimestamp() + 10 minutes;

        skip(10 minutes - 1);
        vm.expectRevert(abi.encodeWithSelector(Payroll.DripTooSoon.selector, notBefore));
        payroll.drip();

        skip(1);
        assertEq(payroll.drip(), uint256(1e18) / 6, "ten minutes of a one-IMD-an-hour stream");
    }

    /// @dev However long nobody calls, one call sends one hour of stream and no more.
    function test_drip_isCappedAtOneHourOfStream() public {
        skip(3 days);
        uint256 cap = payroll.dripCap();
        assertEq(cap, 1e18);
        assertEq(payroll.drip(), cap);

        // The backlog is worked off one capped call at a time, ten minutes apart.
        for (uint256 i; i < 5; ++i) {
            skip(10 minutes);
            assertEq(payroll.drip(), cap);
        }
        assertEq(payroll.ledger().dripped, 6e18);
        assertBooksBalance();
    }

    function test_drip_deliversTheWholeStreamAndNoMore() public {
        uint256 before = imd.balanceOf(address(simd));
        uint256 calls;
        for (uint256 i; i < 400; ++i) {
            skip(1 hours);
            uint256 sent = payroll.drip();
            assertLe(sent, payroll.dripCap());
            if (sent != 0) ++calls;
        }
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.dripped, STREAM, "everything the stakers were owed arrived");
        assertEq(l.dripped, l.toStakers);
        assertEq(imd.balanceOf(address(simd)) - before, STREAM);
        assertEq(calls, 168, "one hour per call: a seven-day stream takes 168 calls");
        (uint256 outstanding,,,,, uint256 dueNow) = payroll.stream();
        assertEq(outstanding, 0);
        assertEq(dueNow, 0);
        assertBooksBalance();
    }

    function test_drip_afterTheStreamEndsTheBacklogStillLeavesInCappedCalls() public {
        skip(30 days);
        uint256 total;
        for (uint256 i; i < 168; ++i) {
            uint256 sent = payroll.drip();
            assertEq(sent, 1e18);
            total += sent;
            skip(10 minutes);
        }
        assertEq(total, STREAM);
        assertEq(payroll.drip(), 0);
    }

    /// @dev A booking does not restart the stream. The money still vesting keeps the time it had left,
    /// the new money gets seven days, and the two end together at the average of the two times,
    /// weighted by the two amounts.
    function test_booking_joinsTheStreamAtTheWeightedEndTime() public {
        skip(84 hours); // half way: 84 IMD vested, 84 not, with 84 hours to go
        pay(2 * 84e18); // 84 more for stakers

        (uint256 outstanding, uint256 unvested, uint256 endsAt, uint256 perDrip,,) = payroll.stream();
        assertEq(outstanding, STREAM + 84e18);
        assertEq(unvested, 84e18 + 84e18, "what had not vested plus the new amount");
        // (84 IMD x 84 h + 84 IMD x 168 h) / 168 IMD = 126 h: half way between the two.
        assertEq(endsAt, vm.getBlockTimestamp() + 126 hours);
        // One hour of the joined stream is 168 / 126 = 1.33 IMD; 1/168 of everything outstanding, the
        // 84 IMD that vested and were not sent included, is 1.5 IMD. The cap is the larger.
        assertEq(perDrip, 1.5e18);

        // The 84 that had vested before the booking is still ready, in capped calls.
        assertEq(payroll.drip(), perDrip);
        assertBooksBalance();
    }

    /// @dev The joint end lies between the old end and seven days from now: the old money is never
    /// rushed and the new money never waits longer than seven days. The old money can be made to
    /// wait longer, up to that ceiling; `test/payroll/audit/AuditReports.t.sol` measures by how much.
    function test_booking_neverPushesTheEndPastSevenDaysOrBeforeTheOldEnd() public {
        (,, uint256 oldEnd,,,) = payroll.stream();
        skip(100 hours);
        pay(2 * 1e18); // 1 IMD for stakers joins 68 still vesting
        (,, uint256 endsAt,,,) = payroll.stream();
        assertGe(endsAt, oldEnd, "the new money left early");
        assertLe(endsAt, vm.getBlockTimestamp() + 7 days, "the new money waits longer than seven days");
        // (68 x 68 h + 1 x 168 h) / 69 = 69.449 h from now, rounded down to the second.
        assertEq(endsAt, vm.getBlockTimestamp() + (uint256(68e18) * 68 hours + 1e18 * 7 days) / 69e18);
    }

    /// @dev A booking much larger than what is still vesting takes close to the full seven days.
    function test_booking_aLargeBookingStillTakesAboutSevenDays() public {
        skip(7 days - 1 hours); // one hour and one IMD of the first stream are left
        pay(2 * 10_000e18);
        (, uint256 unvested, uint256 endsAt,,,) = payroll.stream();
        assertEq(unvested, 10_001e18);
        assertGt(endsAt, vm.getBlockTimestamp() + 7 days - 2 minutes);
        assertLe(endsAt, vm.getBlockTimestamp() + 7 days);
    }

    /// @dev A stream that has run out starts again at a full seven days.
    function test_booking_afterTheStreamEnded_takesSevenDays() public {
        skip(8 days);
        pay(2 * 10e18);
        (, uint256 unvested, uint256 endsAt,,,) = payroll.stream();
        assertEq(unvested, 10e18);
        assertEq(endsAt, vm.getBlockTimestamp() + 7 days);
    }

    /// @dev One wei booked into a running stream moves its end by exactly nothing, at any point of
    /// the stream, and does not lower what one drip may send.
    function test_booking_ofDustDoesNotMoveTheEnd() public {
        (,, uint256 firstEnd, uint256 firstCap,,) = payroll.stream();
        uint256[5] memory waits = [uint256(1), 1 hours, 3 days, 3 days + 22 hours, 59 minutes];
        for (uint256 i; i < waits.length; ++i) {
            skip(waits[i]);
            pay(1);
            (,, uint256 endsAt, uint256 perDrip,,) = payroll.stream();
            assertEq(endsAt, firstEnd, "a booking of one wei moved the end of the stream");
            assertGe(perDrip, firstCap, "a booking of one wei lowered the cap on a drip");
        }
        assertEq(firstEnd - vm.getBlockTimestamp(), 1 minutes - 1, "the checks ran to the last minute");
    }

    /// @dev A booking of one wei just before every drip changes nothing for the stakers: a stream
    /// left alone pays 24 IMD in 24 hourly drips, and so does this one.
    function test_booking_ofDustCannotHoldBackVestedMoney() public {
        uint256 total;
        for (uint256 i; i < 24; ++i) {
            skip(1 hours);
            pay(1);
            total += payroll.drip();
        }
        assertApproxEqAbs(total, 24e18, 1e3, "dust bookings held money back");
        assertBooksBalance();
    }

    /// @dev The reviewers' measurement, now of the fixed rule. Before, every booking spread what had
    /// not vested over a fresh seven days: one booking of a single wei an hour left more than a third
    /// of the money unvested on day 7 and an eighth on day 14. With the weighted end time the same
    /// bookings change nothing: after seven days everything but the dust itself has vested, and with
    /// a drip an hour all of it has reached sIMD.
    function test_booking_hourlyDustDoesNotStretchTheStream() public {
        (,, uint256 firstEnd,,,) = payroll.stream();
        for (uint256 h; h < 7 * 24; ++h) {
            skip(1 hours);
            pay(1);
            payroll.drip();
        }
        assertEq(vm.getBlockTimestamp(), firstEnd);
        (uint256 outstanding, uint256 unvested,,,,) = payroll.stream();
        assertLe(unvested, 168, "more than the dust itself is still unvested after the seven days");
        assertLe(outstanding, 168, "money that vested was not sent");
        Payroll.Ledger memory l = payroll.ledger();
        assertApproxEqAbs(l.dripped, STREAM, 168, "the whole first stream reached sIMD in its seven days");

        // The bookings stop; the last of the dust arrives too.
        skip(7 days);
        for (uint256 i; i < 10 && outstanding != 0; ++i) {
            payroll.drip();
            skip(10 minutes);
            (outstanding,,,,,) = payroll.stream();
        }
        l = payroll.ledger();
        assertEq(l.dripped, l.toStakers, "paid in full");
        assertBooksBalance();
    }

    /// @dev The same with bookings that are not dust: steady fee traffic. Each booking is a seventh
    /// of a day's stream. The end is never more than seven days away, and seven days after the last
    /// booking everything has vested.
    function test_booking_steadyTrafficNeverDelaysMoneyPastSevenDays() public {
        uint256 booked = STREAM;
        for (uint256 h; h < 14 * 24; ++h) {
            skip(1 hours);
            pay(2 * 0.2e18);
            booked += 0.2e18;
            payroll.drip();
            (uint256 owedNow, uint256 notVested, uint256 endsAt,,,) = payroll.stream();
            assertLe(endsAt, vm.getBlockTimestamp() + 7 days);
            assertEq(owedNow, notVested, "a drip an hour did not keep pace with vesting");
        }
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.toStakers, booked);
        // The first stream has long been paid: what is unvested is less than the last seven days brought in.
        (, uint256 unvested,,,,) = payroll.stream();
        assertLt(unvested, uint256(7 * 24) * 0.2e18, "more is unvested than the last seven days brought in");

        skip(7 days);
        (, unvested,,,,) = payroll.stream();
        assertEq(unvested, 0, "money was still vesting seven days after the last booking");
    }

    /// @dev A cap sized for a small new booking must not be put in front of money that vested
    /// earlier and was never sent. Here the whole stream has vested and nobody dripped; then dust is
    /// booked before every drip. The backlog leaves as it would have without the dust: one old cap at
    /// a time, 168 calls.
    function test_booking_ofDustWithABacklogWaitingLeavesItReachable() public {
        skip(8 days);
        pay(1);
        (uint256 outstanding, uint256 unvested, uint256 endsAt, uint256 perDrip,,) = payroll.stream();
        assertEq(outstanding, STREAM + 1);
        assertEq(unvested, 1);
        assertEq(endsAt, vm.getBlockTimestamp() + 7 days);
        assertEq(perDrip, 1e18 + 1, "the cap of the stream the backlog came from, not one sized for the dust");

        uint256 sent;
        for (uint256 i; i < 168; ++i) {
            if (i != 0) pay(1);
            // The cap stays at the old stream's hour for as long as that much is waiting, and covers
            // all of what is waiting once it is less.
            (outstanding, unvested,,,,) = payroll.stream();
            uint256 backlog = outstanding - unvested;
            assertGe(payroll.dripCap(), backlog < 1e18 ? backlog : 1e18, "dust lowered the cap in front of the backlog");
            sent += payroll.drip();
            skip(10 minutes);
        }
        assertGe(sent, STREAM, "the backlog did not leave in the 168 calls it would have taken without the dust");
        (outstanding,,,,,) = payroll.stream();
        assertLe(outstanding, 168, "only dust that has not vested is left");
    }

    /// @dev The last hour of a stream is a backlog like any other. A booking of dust in the very
    /// block the stream ends must not leave that hour behind a cap sized for the dust.
    function test_booking_ofDustAsTheStreamEndsDoesNotTrapItsLastHour() public {
        for (uint256 h; h < 167; ++h) {
            skip(1 hours);
            payroll.drip();
        }
        skip(1 hours); // the stream ends in this block with its last IMD vested and not yet sent
        pay(1);
        assertEq(payroll.dripCap(), 1e18, "the cap in front of the last hour of the stream");
        assertEq(payroll.drip(), 1e18);
        assertEq(payroll.ledger().dripped, STREAM);
    }

    /// @dev The kept cap is cut to the backlog it protects, so a large cap from a large stream does
    /// not outlive that stream's money. After a big stream has been paid out, a small booking sets
    /// a cap of its own size.
    function test_booking_anOldLargeCapDoesNotOutliveItsBacklog() public {
        skip(8 days);
        for (uint256 i; i < 168; ++i) {
            assertEq(payroll.drip(), 1e18);
            skip(10 minutes);
        }
        assertEq(payroll.dripCap(), 1e18, "the cap of the first stream is still standing");
        pay(2 * 1.68e18); // a stream a hundredth the size, with no backlog in front of it
        assertEq(payroll.dripCap(), 0.01e18);

        // And with a small backlog in front, the cap covers the new stream and no old one.
        skip(3 hours); // 0.03 IMD vested and not sent
        pay(2 * 168e18);
        (uint256 outstanding, uint256 unvested,,,,) = payroll.stream();
        assertEq(outstanding - unvested, 0.03e18);
        assertEq(payroll.dripCap(), 1.01e18, "1/168 of the 169.68 IMD now outstanding");
    }

    /// @dev A booking cannot be used to rush the stream: the rate after it is never above the old
    /// rate plus the new amount over seven days. Checked on the amount an hour of the new stream vests.
    function testFuzz_booking_weightedEndIsBetweenTheTwoTimes(uint256 wait, uint256 amount) public {
        wait = bound(wait, 1, 7 days - 1);
        amount = bound(amount, 1, 1_000_000e18);
        skip(wait);
        (, uint256 remaining, uint256 oldEnd,,,) = payroll.stream();
        uint256 timeLeft = oldEnd - vm.getBlockTimestamp();
        pay(amount);
        uint256 added = amount - (amount * 3_000) / 10_000 - (amount * 2_000) / 10_000;

        (, uint256 unvested, uint256 endsAt,,,) = payroll.stream();
        assertEq(unvested, remaining + added);
        uint256 duration = endsAt - vm.getBlockTimestamp();
        assertEq(duration, (remaining * timeLeft + added * 7 days) / (remaining + added), "not the weighted time");
        assertGe(duration, timeLeft, "the money already vesting was rushed");
        assertLe(duration, 7 days, "the new money waits longer than seven days");
        // unvested / duration <= remaining / timeLeft + added / 7 days, cross-multiplied. `duration`
        // is rounded down by less than a second, which the one second added on the right covers.
        assertLe(
            unvested * timeLeft * 7 days,
            (remaining * 7 days + added * timeLeft) * (duration + 1),
            "the stream runs faster than its two parts together"
        );
        // A booking too small to move the end by a second moves it by nothing.
        if (added * (7 days - timeLeft) < remaining + added) assertEq(endsAt, oldEnd);
        assertBooksBalance();
    }

    function test_drip_oneWeiStreamCanBeEmptied() public {
        Payroll p = deployPayroll();
        vm.startPrank(payer);
        imd.approve(address(p), type(uint256).max);
        p.pay(1, bytes32(0));
        vm.stopPrank();
        assertEq(p.dripCap(), 1, "the cap rounds up, so it is never zero while something is owed");
        skip(7 days);
        assertEq(p.drip(), 1);
        assertEq(p.ledger().dripped, 1);
    }

    function test_drip_withNoRevenueSendsNothing() public {
        Payroll p = deployPayroll();
        assertEq(p.drip(), 0);
        skip(1 days);
        assertEq(p.drip(), 0);
    }

    function test_stream_viewAgreesWithDrip() public {
        skip(47 minutes);
        (uint256 outstanding, uint256 unvested,, uint256 perDrip, uint256 nextDripAt, uint256 dueNow) = payroll.stream();
        assertEq(outstanding, STREAM);
        assertEq(perDrip, 1e18);
        assertEq(nextDripAt, 10 minutes);
        assertEq(outstanding - unvested, dueNow);
        assertEq(payroll.drip(), dueNow);

        (,,,, nextDripAt, dueNow) = payroll.stream();
        assertEq(nextDripAt, vm.getBlockTimestamp() + 10 minutes);
        assertEq(dueNow, 0, "nothing is due inside the gap");
    }

    // ---- sIMD misbehaving

    function test_drip_waitsWhileTheVaultHasNoStakers() public {
        MockSIMD empty = new MockSIMD(IERC20(address(imd)));
        Payroll p = new Payroll(
            address(imd),
            address(empty),
            address(seats),
            SEAT_COUNT,
            address(adapter),
            address(questions),
            FEED_A,
            FEED_B,
            FEED_C
        );
        vm.startPrank(payer);
        imd.approve(address(p), type(uint256).max);
        p.pay(336e18, bytes32(0));
        vm.stopPrank();
        skip(2 hours);

        vm.expectRevert(Payroll.StakingVaultNotReady.selector);
        p.drip();
        assertEq(imd.balanceOf(address(empty)), 0, "nothing was sent to a vault nobody holds");

        // Once somebody stakes, the stream pays out and nothing was lost by waiting.
        vm.startPrank(payer);
        imd.approve(address(empty), 10e18);
        empty.deposit(10e18, payer);
        vm.stopPrank();
        assertEq(p.drip(), 1e18);
    }

    function test_drip_revertsWhenTheVaultHasNoCode() public {
        Payroll p = payrollWithVault(address(0xBEEF));
        vm.expectRevert(Payroll.StakingVaultNotReady.selector);
        p.drip();
        assertEq(imd.balanceOf(address(0xBEEF)), 0);
    }

    function test_drip_revertsWhenTheVaultIsOverAnotherAsset() public {
        RawResponder other = new RawResponder();
        other.program(abi.encode(address(0xA55E7)), false);
        Payroll p = payrollWithVault(address(other));
        vm.expectRevert(Payroll.StakingVaultNotReady.selector);
        p.drip();
    }

    function test_drip_revertsWhenTheVaultReverts() public {
        RawResponder broken = new RawResponder();
        broken.program("", true);
        Payroll p = payrollWithVault(address(broken));
        vm.expectRevert(Payroll.StakingVaultNotReady.selector);
        p.drip();
    }

    function test_drip_revertsWhenTheVaultAnswersTooShort() public {
        RawResponder tooShort = new RawResponder();
        tooShort.program(hex"01", false);
        Payroll p = payrollWithVault(address(tooShort));
        vm.expectRevert(Payroll.StakingVaultNotReady.selector);
        p.drip();
    }

    /// @dev A stuck vault stops only the drip: booking and seat claims go on.
    function test_stuckVaultDoesNotBlockTheRestOfPayroll() public {
        RawResponder broken = new RawResponder();
        broken.program("", true);
        Payroll p = payrollWithVault(address(broken));
        vm.prank(payer);
        p.pay(100e18, bytes32(0));
        assertGt(p.claimSeat(3), 0);
        assertEq(p.book(), 0);
    }

    // ---- a visitor to sIMD around the drips
    //
    // Audit job 22624be0, finding 1 (medium), acknowledged and not closed: see docs/AUDITS.md and
    // docs/THREATS.md P2. The test that stood here, `test_shortVisitCollectsAtMostItsShareOfOneDrip`,
    // checked one round trip and stopped. These repeat the visit over the whole stream and state
    // what it adds up to.

    /// @dev One visit takes the visitor's share of one drip, and the cap sets how large a drip is.
    function test_visitor_oneVisitTakesItsShareOfOneCappedDrip() public {
        skip(3 days); // a three-day backlog is waiting
        address visitor = makeAddr("visitor");
        uint256 stake = 1_000e18; // as much as every other staker together
        imd.mint(visitor, stake);

        vm.startPrank(visitor);
        imd.approve(address(simd), stake);
        uint256 shares = simd.deposit(stake, visitor);
        vm.stopPrank();

        uint256 sent = payroll.drip();
        assertEq(sent, payroll.dripCap());

        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(visitor);
        uint256 back = simd.redeem(shares, visitor, visitor);

        uint256 gain = back - stake;
        assertLe(gain, sent / 2, "half the vault, so at most half of the one transfer it attended");
        assertApproxEqAbs(gain, sent / 2, 1e6);
        assertLt(gain, 1e18, "not its half of the 72 IMD that had vested over three days: that takes 72 visits");
    }

    /// @dev The visit, repeated at every drip of a whole stream. The visitor holds as much as every
    /// other staker together, stakes just before each drip (which it makes itself), and leaves one
    /// block later: sIMD does not let it leave sooner. It collects half of the stream, which is its
    /// pro-rata share of every drip it attended and exactly what a staker of its size who had
    /// stayed all week would have received, and not a wei more. The staker who stayed gets the
    /// other half where it would have had everything. Nothing in Payroll prevents this: sIMD pays
    /// whoever holds its shares when IMD arrives.
    function test_visitor_repeatedOverAWholeStreamTakesItsProRataShareAndNoMore() public {
        address visitor = makeAddr("visitor");
        uint256 stake = 1_000e18; // as much as every other staker together
        imd.mint(visitor, stake);
        vm.prank(visitor);
        imd.approve(address(simd), type(uint256).max);
        uint256 stayedBefore = simd.convertToAssets(simd.balanceOf(staker));

        for (uint256 i; i < 168; ++i) {
            skip(1 hours);
            vm.roll(vm.getBlockNumber() + 1);
            uint256 all = imd.balanceOf(visitor);
            vm.prank(visitor);
            uint256 shares = simd.deposit(all, visitor);
            vm.prank(visitor);
            assertEq(payroll.drip(), 1e18);
            if (i == 0) {
                // Not in the block it staked in.
                assertEq(simd.maxRedeem(visitor), 0);
                vm.expectRevert(MockSIMD.RedeemMoreThanMax.selector);
                vm.prank(visitor);
                simd.redeem(shares, visitor, visitor);
            }
            vm.roll(vm.getBlockNumber() + 1);
            vm.prank(visitor);
            simd.redeem(shares, visitor, visitor);
        }

        assertEq(payroll.ledger().dripped, STREAM, "the visitor attended every drip of the stream");
        uint256 gain = imd.balanceOf(visitor) - stake;
        uint256 stayed = simd.convertToAssets(simd.balanceOf(staker)) - stayedBefore;
        emit log_named_decimal_uint("the stream (IMD)", STREAM, 18);
        emit log_named_decimal_uint("the visitor's gain (IMD)", gain, 18);
        emit log_named_decimal_uint("the gain of the staker who stayed (IMD)", stayed, 18);
        assertLe(gain, STREAM / 2, "the visitor took more than its pro-rata share of the stream");
        assertApproxEqAbs(gain, STREAM / 2, 1e6, "the visitor took something other than its pro-rata share");
        assertApproxEqAbs(stayed, STREAM / 2, 1e6, "the staker who stayed was diluted by another amount");
        assertLe(gain + stayed, STREAM);
    }

    /// @dev A staker of the visitor's size who simply stays receives the same: visiting earns no
    /// more than staking, it only needs the capital for two blocks an hour and not all week.
    function test_visitor_aStakerOfTheSameSizeWhoStaysGetsTheSame() public {
        address second = makeAddr("second staker");
        imd.mint(second, 1_000e18);
        vm.startPrank(second);
        imd.approve(address(simd), 1_000e18);
        uint256 shares = simd.deposit(1_000e18, second);
        vm.stopPrank();

        for (uint256 i; i < 168; ++i) {
            skip(1 hours);
            payroll.drip();
        }
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(second);
        uint256 back = simd.redeem(shares, second, second);
        assertApproxEqAbs(back - 1_000e18, STREAM / 2, 1e6);
    }

    /// @dev What the hold is worth. Against a vault without it, the same share of every drip is
    /// taken with IMD borrowed for the length of one transaction: borrow, stake, drip, leave, repay.
    /// The visitor owns nothing before and has nothing in the vault between two blocks, and still
    /// ends with its pro-rata share of every drip: here 1,000 IMD borrowed each time against a
    /// staker whose 1,000 grows with what it keeps, 82.27 of the 168 IMD. The real sIMD refuses
    /// the fourth step (fork suite:
    /// `test_fork_visit_stakeDripLeaveInOneTransactionReverts`), so there a visit needs the visitor's
    /// own IMD, staked across at least one block boundary for every drip.
    function test_visitor_withoutTheHoldTheSameShareNeedsNoCapitalAtAll() public {
        HoldlessSIMD vault = new HoldlessSIMD(IERC20(address(imd)));
        Payroll p = new Payroll(
            address(imd),
            address(vault),
            address(seats),
            SEAT_COUNT,
            address(adapter),
            address(questions),
            FEED_A,
            FEED_B,
            FEED_C
        );
        address stays = makeAddr("staker of the vault without a hold");
        address lender = makeAddr("lender");
        imd.mint(stays, 1_000e18);
        imd.mint(lender, 1_000e18);
        vm.startPrank(stays);
        imd.approve(address(vault), 1_000e18);
        vault.deposit(1_000e18, stays);
        vm.stopPrank();
        vm.startPrank(payer);
        imd.approve(address(p), type(uint256).max);
        p.pay(STREAM * 2, bytes32(0));
        vm.stopPrank();

        LoanedVisit visit = new LoanedVisit();
        vm.prank(lender);
        imd.approve(address(visit), type(uint256).max);
        assertEq(imd.balanceOf(address(visit)), 0, "the visitor owns nothing");

        uint256 total;
        uint256 proRata;
        for (uint256 i; i < 168; ++i) {
            skip(1 hours);
            // C / (S + C) of this drip: the loan against what the staker who stays has in the vault.
            proRata += (uint256(1e18) * 1_000e18) / (vault.totalAssets() + 1_000e18);
            total += visit.visit(imd, vault, p, lender, 1_000e18);
            assertEq(imd.balanceOf(lender), 1_000e18, "the loan was repaid inside the visit");
            assertEq(vault.balanceOf(address(visit)), 0, "nothing of the visitor's is left in the vault");
        }
        assertEq(p.ledger().dripped, STREAM);
        assertEq(imd.balanceOf(address(visit)), total);
        emit log_named_decimal_uint("taken with borrowed IMD and no hold (IMD)", total, 18);
        assertLe(total, proRata, "more than its pro-rata share of each drip");
        assertApproxEqAbs(total, proRata, 1e6, "its pro-rata share of every drip, for the gas of 168 transactions");
        assertGt(total, 82e18, "close to half of the 168 IMD stream");
    }

    /// @dev The same loaned visit against the stand-in that models the real sIMD's hold: it reverts.
    function test_visitor_withTheHoldAStakeDripLeaveTransactionReverts() public {
        address visitor = makeAddr("visitor");
        imd.mint(visitor, 1_000e18);
        skip(1 hours);
        vm.startPrank(visitor);
        imd.approve(address(simd), 1_000e18);
        uint256 shares = simd.deposit(1_000e18, visitor);
        payroll.drip();
        vm.expectRevert(MockSIMD.RedeemMoreThanMax.selector);
        simd.redeem(shares, visitor, visitor);
        vm.expectRevert(MockSIMD.WithdrawMoreThanMax.selector);
        simd.withdraw(1_000e18, visitor, visitor);

        // Handing the shares to another address in the same block does not help: the stamp goes with them.
        address second = makeAddr("second address");
        simd.transfer(second, shares);
        vm.stopPrank();
        assertEq(simd.maxRedeem(second), 0);
        vm.expectRevert(MockSIMD.RedeemMoreThanMax.selector);
        vm.prank(second);
        simd.redeem(shares, second, second);

        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(second);
        assertGt(simd.redeem(shares, second, second), 1_000e18);
    }

    function payrollWithVault(address vault) internal returns (Payroll p) {
        p = new Payroll(
            address(imd),
            vault,
            address(seats),
            SEAT_COUNT,
            address(adapter),
            address(questions),
            FEED_A,
            FEED_B,
            FEED_C
        );
        vm.startPrank(payer);
        imd.approve(address(p), type(uint256).max);
        p.pay(336e18, bytes32(0));
        vm.stopPrank();
        skip(2 hours);
    }
}
