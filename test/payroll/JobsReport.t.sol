// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {JobsReport} from "../../src/payroll/JobsReport.sol";
import {IQuestions} from "../../src/interfaces/IQuestions.sol";
import {QuestionsRig, Rig} from "./mocks/QuestionsRig.sol";
import {JobsReportSetup} from "./JobsReportSetup.sol";

using Rig for QuestionsRig;

/// @dev `print`: turning answered payrolls rounds into prints, and the running figures.
contract JobsReportPrintTest is JobsReportSetup {
    event Printed(
        uint256 indexed index,
        uint64 indexed round,
        uint256 amount,
        uint64 fromBlock,
        uint64 toBlock,
        uint256 total,
        uint256 streak
    );
    event BestDay(uint256 indexed index, uint256 amount);
    event RoundSkipped(bytes32 indexed feedId, uint64 indexed round, JobsReport.SkipReason reason);

    // ---- constructor

    function test_constructor_storesTheFeeds() public view {
        assertEq(address(report.QUESTIONS()), address(q));
        assertEq(report.PAYROLLS_FEED(), PAYROLLS);
        assertEq(report.HIRES_FEED(), HIRES);
        assertEq(report.EMPLOYERS_FEED(), EMPLOYERS);
        assertEq(report.MAX_ROUNDS_PER_CALL(), 8);
    }

    function test_constructor_deploysBeforeQuestionsHasCode() public {
        JobsReport r = new JobsReport(address(0x0E57), PAYROLLS, HIRES, EMPLOYERS);
        assertEq(r.printCount(), 0);
    }

    function test_constructor_revertsOnAZeroQuestions() public {
        vm.expectRevert(JobsReport.ZeroAddress.selector);
        new JobsReport(address(0), PAYROLLS, HIRES, EMPLOYERS);
    }

    function test_constructor_revertsOnARepeatedFeed() public {
        vm.expectRevert(JobsReport.DuplicateFeed.selector);
        new JobsReport(address(q), PAYROLLS, PAYROLLS, EMPLOYERS);
        vm.expectRevert(JobsReport.DuplicateFeed.selector);
        new JobsReport(address(q), PAYROLLS, HIRES, PAYROLLS);
        vm.expectRevert(JobsReport.DuplicateFeed.selector);
        new JobsReport(address(q), PAYROLLS, HIRES, HIRES);
    }

    // ---- print

    function test_print_withNothingToReadChangesNothing() public {
        vm.recordLogs();
        (uint256 printed, uint256 counted) = report.print();
        assertEq(printed + counted, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        (bool exists,,) = report.latestPrint();
        assertFalse(exists);
        JobsReport.Summary memory s = report.summary();
        assertEq(s.prints + s.total + s.counts + s.totalCount + s.streak + s.payrollsRead + s.hiresRead, 0);
        assertEq(s.pairedPrints + s.pairedCounts, 0);
    }

    function test_print_storesAnAnsweredRound() public {
        payrolls(0, 53.5e18);

        vm.expectEmit(address(report));
        emit Printed(0, 1, 53.5e18, first(0), last(0), 53.5e18, 1);
        vm.expectEmit(address(report));
        emit BestDay(0, 53.5e18);
        vm.prank(makeAddr("anyone"));
        (uint256 printed, uint256 counted) = report.print();

        assertEq(printed, 1);
        assertEq(counted, 0);
        JobsReport.Print memory p = report.printAt(0);
        assertEq(p.amount, 53.5e18);
        assertEq(p.count, 0);
        assertEq(p.fromBlock, first(0));
        assertEq(p.toBlock, last(0));
        assertEq(p.payrollsRound, 1);
        assertEq(p.hiresRound, 0);

        (bool exists, uint256 index, JobsReport.Print memory latest) = report.latestPrint();
        assertTrue(exists);
        assertEq(index, 0);
        assertEq(latest.amount, 53.5e18);
        assertEq(report.total(), 53.5e18);

        // A second call has nothing new and prints nothing twice.
        (printed,) = report.print();
        assertEq(printed, 0);
        assertEq(report.printCount(), 1);
    }

    function test_print_stopsAtAPendingRoundAndResumesWhenItIsAnswered() public {
        payrolls(0, 1e18);
        uint64 pending = q.openRound(PAYROLLS, first(1), last(1));
        payrolls(2, 3e18);

        (uint256 printed,) = report.print();
        assertEq(printed, 1, "the round after a pending one is not read ahead of it");
        assertEq(report.summary().payrollsRead, 1);

        q.answer(PAYROLLS, pending, 2e18);
        (printed,) = report.print();
        assertEq(printed, 2);
        assertEq(report.total(), 6e18);
        assertEq(report.summary().streak, 3);
    }

    function test_print_passesOverAFailedRound() public {
        q.pushFailed(PAYROLLS, first(0), last(0));
        payrolls(0, 4e18); // the same window, asked again

        vm.expectEmit(address(report));
        emit RoundSkipped(PAYROLLS, 1, JobsReport.SkipReason.Failed);
        vm.expectEmit(address(report));
        emit Printed(0, 2, 4e18, first(0), last(0), 4e18, 1);
        (uint256 printed,) = report.print();

        assertEq(printed, 1);
        assertEq(report.printAt(0).payrollsRound, 2);
        assertEq(report.summary().payrollsRead, 2);
    }

    function test_print_passesOverAWindowThatIsEmptyOrNotOverYet() public {
        q.pushAnswered(PAYROLLS, 1e18, last(0), first(0)); // from after to
        q.pushAnswered(PAYROLLS, 1e18, first(0), uint64(vm.getBlockNumber())); // ends in the current block
        q.pushAnswered(PAYROLLS, 1e18, first(0), type(uint64).max); // ends in the far future
        payrolls(0, 7e18);

        vm.expectEmit(address(report));
        emit RoundSkipped(PAYROLLS, 1, JobsReport.SkipReason.BadWindow);
        vm.expectEmit(address(report));
        emit RoundSkipped(PAYROLLS, 2, JobsReport.SkipReason.BadWindow);
        vm.expectEmit(address(report));
        emit RoundSkipped(PAYROLLS, 3, JobsReport.SkipReason.BadWindow);
        (uint256 printed,) = report.print();

        assertEq(printed, 1, "a bad window does not hold up the rounds after it");
        assertEq(report.total(), 7e18);
    }

    /// @dev Audit job 22624be0, finding 5 (info), left as it is and written down. The rule above is
    /// the one skip that reads the block of the call: the same round is passed over for good when
    /// `print` is called before its window has ended, and printed when the first call comes after.
    /// Only this rig can show the contract such a round; the real Questions never stores one
    /// (`test_integration_aRealWindowIsAlwaysOverWhenItsAnswerIsPrinted`).
    function test_print_aWindowNotOverYetIsPassedOverForGood() public {
        q.pushAnswered(PAYROLLS, 1e18, first(0), uint64(vm.getBlockNumber() + 5));
        uint256 snapshot = vm.snapshotState();

        vm.expectEmit(address(report));
        emit RoundSkipped(PAYROLLS, 1, JobsReport.SkipReason.BadWindow);
        (uint256 printed,) = report.print();
        assertEq(printed, 0);
        assertEq(report.summary().payrollsRead, 1, "the round is consumed");
        vm.roll(vm.getBlockNumber() + 10);
        (printed,) = report.print();
        assertEq(printed, 0, "a round that was passed over is not read again");
        payrolls(0, 7e18);
        (printed,) = report.print();
        assertEq(printed, 1, "the rounds after it are printed as usual");

        // The first call comes after the window's end instead: the round is printed.
        vm.revertToState(snapshot);
        vm.roll(vm.getBlockNumber() + 10);
        (printed,) = report.print();
        assertEq(printed, 1);
    }

    /// @dev Prints never overlap, so the total never counts a block twice.
    function test_print_neverCountsABlockTwice() public {
        payrolls(0, 5e18);
        q.pushAnswered(PAYROLLS, 9e18, last(0) - 10, last(1)); // starts inside day 0
        q.pushAnswered(PAYROLLS, 5e18, first(0), last(0)); // day 0 again
        q.pushAnswered(PAYROLLS, 9e18, last(0), last(1)); // starts on day 0's last block
        payrolls(1, 6e18);

        vm.expectEmit(address(report));
        emit RoundSkipped(PAYROLLS, 2, JobsReport.SkipReason.Overlap);
        vm.expectEmit(address(report));
        emit RoundSkipped(PAYROLLS, 3, JobsReport.SkipReason.Overlap);
        vm.expectEmit(address(report));
        emit RoundSkipped(PAYROLLS, 4, JobsReport.SkipReason.Overlap);
        (uint256 printed,) = report.print();

        assertEq(printed, 2);
        assertEq(report.total(), 11e18);
        assertEq(report.printAt(1).payrollsRound, 5);
    }

    function test_print_passesOverAnAnswerTooLargeToBeAFigure() public {
        q.pushAnswered(PAYROLLS, uint256(type(uint128).max) + 1, first(0), last(0));
        q.pushAnswered(PAYROLLS, type(uint256).max, first(0), last(0));
        payrolls(0, 2e18);

        vm.expectEmit(address(report));
        emit RoundSkipped(PAYROLLS, 1, JobsReport.SkipReason.OutOfRange);
        (uint256 printed,) = report.print();
        assertEq(printed, 1);
        assertEq(report.total(), 2e18);
    }

    function test_print_acceptsAZeroDay() public {
        payrolls(0, 0);
        (uint256 printed,) = report.print();
        assertEq(printed, 1);
        assertEq(report.bestAmount(), 0, "a day of nothing sets no record");
    }

    function test_print_readsAtMostEightRoundsACall() public {
        for (uint256 day; day < 20; ++day) {
            payrolls(day, 1e18);
        }
        (uint256 printed,) = report.print();
        assertEq(printed, 8);
        (printed,) = report.print();
        assertEq(printed, 8);
        (printed,) = report.print();
        assertEq(printed, 4);
        (printed,) = report.print();
        assertEq(printed, 0);
        assertEq(report.printCount(), 20);
        assertEq(report.total(), 20e18);
        assertEq(report.summary().streak, 20);
    }

    function test_print_skippedRoundsCountAgainstTheEight() public {
        for (uint256 i; i < 8; ++i) {
            q.pushFailed(PAYROLLS, first(0), last(0));
        }
        payrolls(0, 1e18);
        (uint256 printed,) = report.print();
        assertEq(printed, 0);
        assertEq(report.summary().payrollsRead, 8);
        (printed,) = report.print();
        assertEq(printed, 1);
    }

    function test_print_revertsOnlyWhenQuestionsDoes() public {
        payrolls(0, 1e18);
        questionsDown(true);
        vm.expectRevert(QuestionsRig.Down.selector);
        report.print();
        questionsDown(false);
        (uint256 printed,) = report.print();
        assertEq(printed, 1, "nothing was lost while Questions was unreachable");
    }

    // ---- streak

    /// @dev Reviewers' finding, as a regression test. The launch feed's windows tile: each starts one
    /// block after the last answered one, whatever happened in between. A missed day therefore never
    /// shows as a gap, it shows as a longer catch-up window, and the streak used to count straight
    /// through it (it was simply the number of prints). A window longer than a day now ends the run.
    function test_streak_aCatchUpWindowAfterAMissedDayEndsIt() public {
        payrolls(0, 1e18);
        payrolls(1, 1e18);
        payrolls(2, 1e18);
        report.print();
        assertEq(report.summary().streak, 3);

        // Day 3 was missed: the next answer covers days 3 and 4 in one window, with no gap.
        q.pushAnswered(PAYROLLS, 2e18, first(3), last(4));
        vm.expectEmit(address(report));
        emit Printed(3, 4, 2e18, first(3), last(4), 5e18, 0);
        report.print();
        JobsReport.Summary memory s = report.summary();
        assertEq(s.prints, 4);
        assertEq(s.streak, 0, "a catch-up print is not a day in a row");
        assertEq(s.longestStreak, 3);

        payrolls(5, 1e18);
        payrolls(6, 1e18);
        report.print();
        s = report.summary();
        assertEq(s.streak, 2, "a new run starts with the next day-sized print");
        assertEq(s.longestStreak, 3);
    }

    /// @dev The same 7,500-block limit as the best-day record, and inclusive like it.
    function test_streak_windowLengthLimitIsInclusive() public {
        q.pushAnswered(PAYROLLS, 1e18, BASE + 1, BASE + 7_500); // exactly 7,500 blocks
        q.pushAnswered(PAYROLLS, 1e18, BASE + 7_501, BASE + 15_000); // 7,500 again
        report.print();
        assertEq(report.summary().streak, 2);

        q.pushAnswered(PAYROLLS, 1e18, BASE + 15_001, BASE + 22_501); // 7,501 blocks
        report.print();
        assertEq(report.summary().streak, 0);
        assertEq(report.summary().longestStreak, 2);
    }

    /// @dev A feed whose windows do not tile can leave a gap; that breaks the run too.
    function test_streak_countsContiguousPrintsAndResetsOnAGap() public {
        payrolls(0, 1e18);
        payrolls(1, 1e18);
        payrolls(2, 1e18);
        report.print();
        JobsReport.Summary memory s = report.summary();
        assertEq(s.streak, 3);
        assertEq(s.longestStreak, 3);

        payrolls(4, 1e18); // day 3 was never printed
        vm.expectEmit(address(report));
        emit Printed(3, 4, 1e18, first(4), last(4), 4e18, 1);
        report.print();
        s = report.summary();
        assertEq(s.streak, 1);
        assertEq(s.longestStreak, 3);

        payrolls(5, 1e18);
        report.print();
        s = report.summary();
        assertEq(s.streak, 2);
        assertEq(s.longestStreak, 3);
    }

    function test_streak_aWindowThatStartsOneBlockLateBreaksIt() public {
        payrolls(0, 1e18);
        q.pushAnswered(PAYROLLS, 1e18, first(1) + 1, last(1));
        report.print();
        assertEq(report.summary().streak, 1);
        assertEq(report.printCount(), 2);
    }

    // ---- best day

    function test_bestDay_isTheLargestSingleDay() public {
        payrolls(0, 5e18);
        payrolls(1, 9e18);
        payrolls(2, 7e18);
        report.print();
        assertEq(report.bestAmount(), 9e18);
        assertEq(report.bestIndex(), 1);

        // A window covering two days carries more, but it is not a day.
        q.pushAnswered(PAYROLLS, 20e18, first(3), last(4));
        report.print();
        assertEq(report.bestAmount(), 9e18, "a two-day window cannot take the record");
        assertEq(report.total(), 41e18, "it still counts toward the total");
        assertEq(report.summary().streak, 0, "and it ends the run of days");

        payrolls(5, 10e18);
        vm.expectEmit(address(report));
        emit BestDay(4, 10e18);
        report.print();
        assertEq(report.bestIndex(), 4);
        assertEq(report.summary().streak, 1);
    }

    function test_bestDay_windowLengthLimitIsInclusive() public {
        q.pushAnswered(PAYROLLS, 5e18, BASE + 1, BASE + 7_500); // exactly 7,500 blocks
        q.pushAnswered(PAYROLLS, 9e18, BASE + 7_501, BASE + 15_001); // 7,501 blocks
        report.print();
        assertEq(report.bestAmount(), 5e18);
        assertEq(report.bestIndex(), 0);
    }

    function test_bestDay_aTieKeepsTheEarlierDay() public {
        payrolls(0, 5e18);
        payrolls(1, 5e18);
        report.print();
        assertEq(report.bestIndex(), 0);
    }
}

/// @dev The hires feed: every usable answer is recorded as a count of its own, and a count is attached
/// to the print whose window it mostly shares.
contract JobsReportCountsTest is JobsReportSetup {
    event CountRecorded(
        uint256 indexed index, uint64 indexed round, uint256 count, uint64 fromBlock, uint64 toBlock, uint256 totalCount
    );
    event Counted(uint256 indexed index, uint64 indexed round, uint256 count);
    event RoundSkipped(bytes32 indexed feedId, uint64 indexed round, JobsReport.SkipReason reason);

    function test_counts_aCountJoinsThePrintForTheSameWindow() public {
        payrolls(0, 53.5e18);
        hires(0, 107);

        vm.expectEmit(address(report));
        emit CountRecorded(0, 1, 107, first(0), last(0), 107);
        vm.expectEmit(address(report));
        emit Counted(0, 1, 107);
        (uint256 printed, uint256 counted) = report.print();

        assertEq(printed, 1);
        assertEq(counted, 1);
        JobsReport.Print memory p = report.printAt(0);
        assertEq(p.count, 107);
        assertEq(p.hiresRound, 1);
        assertEq(report.totalCount(), 107);

        JobsReport.Count memory c = report.countAt(0);
        assertEq(c.count, 107);
        assertEq(c.fromBlock, first(0));
        assertEq(c.toBlock, last(0));
        assertEq(c.hiresRound, 1);
        assertEq(c.print, 1, "one more than the index of the print it joined");
        assertEq(report.countsRecorded(), 1);
    }

    /// @dev Reviewers' finding, as a regression test. The two feeds are bought by separate
    /// transactions, and each feed's next window starts where its own last one ended. So one hires
    /// request made 60 blocks after the payrolls request shifts every later hires window by 60 blocks
    /// on both edges, for good. The old rule (both edges within 50 blocks) then attached no count ever
    /// again. Here the shift starts on day 1 and stays: every print still gets its count.
    function test_counts_aFeedThatDriftedStillPairsEveryDay() public {
        payrolls(0, 50e18);
        hires(0, 100);
        report.print();
        assertEq(report.printAt(0).hiresRound, 1);

        // Day 1: the hires request came 60 blocks late, so its window ends 60 blocks later.
        payrolls(1, 51e18);
        q.pushAnswered(HIRES, 101, first(1), last(1) + 60);
        report.print();
        // Days 2 to 8: both edges of every hires window sit 60 blocks after the print's.
        uint256 sum = 201;
        for (uint256 day = 2; day <= 8; ++day) {
            payrolls(day, (50 + day) * 1e18);
            hiresShifted(day, 60, 100 + day);
            sum += 100 + day;
            report.print();
        }

        JobsReport.Summary memory s = report.summary();
        assertEq(s.prints, 9);
        assertEq(s.counts, 9);
        assertEq(s.totalCount, sum);
        for (uint256 day; day <= 8; ++day) {
            JobsReport.Print memory p = report.printAt(day);
            assertEq(p.hiresRound, day + 1, "every day has its count");
            assertEq(p.count, 100 + day);
            JobsReport.Count memory c = report.countAt(day);
            assertEq(c.print, day + 1);
            // The count says which blocks it really covers.
            assertEq(c.fromBlock, day < 2 ? first(day) : first(day) + 60);
            assertEq(c.toBlock, day == 0 ? last(0) : last(day) + 60);
        }
    }

    /// @dev A count belongs to the print it shares more than half of the longer window with. Days are
    /// 7,200 blocks here: shifted by 3,599 a count still joins its own day; by 3,601 it joins the next;
    /// by exactly half it joins neither, and is still recorded.
    function test_counts_pairWithThePrintTheyMostlyShare() public {
        for (uint256 day; day < 4; ++day) {
            payrolls(day, 1e18);
        }
        hiresShifted(0, 3_599, 11);
        hiresShifted(1, 3_599, 12);
        report.print();
        assertEq(report.printAt(0).count, 11, "just under half a day late: its own day");
        assertEq(report.printAt(1).count, 12);
        assertEq(report.countAt(0).print, 1);
        assertEq(report.countAt(1).print, 2);
    }

    function test_counts_aShiftOfMoreThanHalfJoinsTheNextDay() public {
        for (uint256 day; day < 3; ++day) {
            payrolls(day, 1e18);
        }
        hiresShifted(0, 3_601, 11);
        hiresShifted(1, 3_601, 12);
        for (uint256 i; i < 3; ++i) {
            report.print();
        }
        assertEq(report.printAt(0).hiresRound, 0, "no count covers most of day 0");
        assertEq(report.printAt(1).count, 11);
        assertEq(report.printAt(2).count, 12);
        assertEq(report.countAt(0).print, 2);
        assertEq(report.countAt(1).print, 3);
    }

    function test_counts_aShiftOfExactlyHalfJoinsNeither() public {
        payrolls(0, 1e18);
        payrolls(1, 1e18);
        payrolls(2, 1e18);
        hiresShifted(0, 3_600, 11);
        hiresShifted(1, 3_600, 12);
        for (uint256 i; i < 3; ++i) {
            report.print();
        }
        for (uint256 day; day < 3; ++day) {
            assertEq(report.printAt(day).hiresRound, 0);
        }
        assertEq(report.countAt(0).print, 0);
        assertEq(report.countAt(1).print, 0);
        assertEq(report.totalCount(), 23, "recorded all the same");
    }

    /// @dev After a missed hires day the next answer covers several days at once. It is nobody's
    /// daily count: it stays in its own series and in the total, and the days after pair as usual.
    function test_counts_aCatchUpCountIsRecordedAndJoinsNoPrint() public {
        payrolls(0, 1e18);
        payrolls(1, 1e18);
        payrolls(2, 1e18);
        payrolls(3, 1e18);
        q.pushAnswered(HIRES, 300, first(0), last(2)); // three days in one window
        hires(3, 104);
        for (uint256 i; i < 2; ++i) {
            report.print();
        }

        assertEq(report.countsRecorded(), 2);
        assertEq(report.totalCount(), 404, "nothing is dropped from the total");
        assertEq(report.countAt(0).print, 0);
        for (uint256 day; day < 3; ++day) {
            assertEq(report.printAt(day).hiresRound, 0);
            assertEq(report.printAt(day).count, 0);
        }
        assertEq(report.printAt(3).count, 104);
        assertEq(report.countAt(1).print, 4);
    }

    /// @dev And the other way round: a two-day print does not take one day's count.
    function test_counts_aLongerPrintDoesNotTakeADaysCount() public {
        q.pushAnswered(PAYROLLS, 9e18, first(0), last(1));
        payrolls(2, 1e18);
        hires(0, 10);
        hires(1, 11);
        hires(2, 12);
        for (uint256 i; i < 2; ++i) {
            report.print();
        }
        assertEq(report.printAt(0).hiresRound, 0, "half of a two-day window is not most of it");
        assertEq(report.printAt(1).count, 12);
        assertEq(report.totalCount(), 33);
    }

    /// @dev Neither feed waits for the other: a hires answer is recorded when it arrives and paired
    /// when its print exists.
    function test_counts_anAnswerThatArrivesFirstIsRecordedThenPaired() public {
        hires(0, 107);
        (uint256 printed, uint256 counted) = report.print();
        assertEq(printed, 0);
        assertEq(counted, 1);
        assertEq(report.summary().hiresRead, 1);
        assertEq(report.totalCount(), 107);
        assertEq(report.countAt(0).print, 0, "its print does not exist yet");

        payrolls(0, 53.5e18);
        vm.expectEmit(address(report));
        emit Counted(0, 1, 107);
        (printed, counted) = report.print();
        assertEq(printed, 1);
        assertEq(counted, 0);
        assertEq(report.printAt(0).count, 107);
        assertEq(report.countAt(0).print, 1);
        assertEq(report.totalCount(), 107, "paired, not counted twice");
    }

    function test_counts_anAnswerThatArrivesLaterIsAttachedThen() public {
        payrolls(0, 53.5e18);
        uint64 pending = q.openRound(HIRES, first(0), last(0));
        (uint256 printed, uint256 counted) = report.print();
        assertEq(printed, 1);
        assertEq(counted, 0);

        q.answer(HIRES, pending, 107);
        (printed, counted) = report.print();
        assertEq(printed, 0);
        assertEq(counted, 1);
        assertEq(report.printAt(0).count, 107);
    }

    function test_counts_aFailedRoundIsPassedOverAndTheRetryCounts() public {
        payrolls(0, 1e18);
        q.pushFailed(HIRES, first(0), last(0));
        hires(0, 9);
        vm.expectEmit(address(report));
        emit RoundSkipped(HIRES, 1, JobsReport.SkipReason.Failed);
        (, uint256 counted) = report.print();
        assertEq(counted, 1);
        assertEq(report.printAt(0).hiresRound, 2);
    }

    /// @dev A day the hires feed missed stays without a count; the next count goes to its own day.
    function test_counts_aMissedDayDoesNotShiftLaterCounts() public {
        payrolls(0, 1e18);
        payrolls(1, 2e18);
        payrolls(2, 3e18);
        hires(1, 21);
        hires(2, 22);
        (uint256 printed, uint256 counted) = report.print();
        assertEq(printed, 3);
        assertEq(counted, 2);
        assertEq(report.printAt(0).hiresRound, 0);
        assertEq(report.printAt(0).count, 0);
        assertEq(report.printAt(1).count, 21);
        assertEq(report.printAt(2).count, 22);
        assertEq(report.totalCount(), 43);
    }

    /// @dev A count for a day that has no print is kept in its own series; it is not lost.
    function test_counts_aCountForADayThatWasNeverPrintedIsStillRecorded() public {
        payrolls(1, 1e18);
        hires(0, 20);
        hires(1, 21);
        (, uint256 counted) = report.print();
        assertEq(counted, 2);
        assertEq(report.printAt(0).count, 21);
        assertEq(report.countAt(0).print, 0);
        assertEq(report.countAt(1).print, 1);
        assertEq(report.totalCount(), 41);
    }

    /// @dev The total never counts a block twice: a second answer for a window already counted is
    /// passed over, like an overlapping payrolls round.
    function test_counts_neverCountABlockTwice() public {
        payrolls(0, 1e18);
        hires(0, 5);
        hires(0, 6); // a second answer for the same window
        q.pushAnswered(HIRES, 7, last(0), last(1)); // starts on the last block already counted
        vm.expectEmit(address(report));
        emit RoundSkipped(HIRES, 2, JobsReport.SkipReason.Overlap);
        vm.expectEmit(address(report));
        emit RoundSkipped(HIRES, 3, JobsReport.SkipReason.Overlap);
        (, uint256 counted) = report.print();
        assertEq(counted, 1);
        assertEq(report.printAt(0).count, 5);
        assertEq(report.totalCount(), 5);
        assertEq(report.summary().hiresRead, 3);
        assertEq(report.countsRecorded(), 1);
    }

    function test_counts_unusableAnswersArePassedOver() public {
        payrolls(0, 1e18);
        q.pushAnswered(HIRES, 5, last(0), first(0)); // empty window
        q.pushAnswered(HIRES, 5, first(0), uint64(vm.getBlockNumber())); // not over yet
        q.pushAnswered(HIRES, uint256(type(uint128).max) + 1, first(0), last(0)); // not a count
        hires(0, 7);

        vm.expectEmit(address(report));
        emit RoundSkipped(HIRES, 1, JobsReport.SkipReason.BadWindow);
        vm.expectEmit(address(report));
        emit RoundSkipped(HIRES, 2, JobsReport.SkipReason.BadWindow);
        vm.expectEmit(address(report));
        emit RoundSkipped(HIRES, 3, JobsReport.SkipReason.OutOfRange);
        (, uint256 counted) = report.print();
        assertEq(counted, 1);
        assertEq(report.printAt(0).count, 7);
        assertEq(report.printAt(0).hiresRound, 4);
        assertEq(report.totalCount(), 7);
    }

    function test_counts_aZeroCountIsACount() public {
        payrolls(0, 0);
        hires(0, 0);
        report.print();
        assertEq(report.printAt(0).hiresRound, 1, "attached, although the figure is zero");
        assertEq(report.countAt(0).print, 1);
    }

    /// @dev Both feeds share the eight rounds of one call; the rest is picked up by the next call.
    function test_counts_shareTheEightRoundsWithPayrolls() public {
        for (uint256 day; day < 6; ++day) {
            payrolls(day, 1e18);
            hires(day, 10 + day);
        }
        (uint256 printed, uint256 counted) = report.print();
        assertEq(printed, 6);
        assertEq(counted, 2);
        (printed, counted) = report.print();
        assertEq(printed, 0);
        assertEq(counted, 4);
        for (uint256 day; day < 6; ++day) {
            assertEq(report.printAt(day).count, 10 + day);
        }
    }

    /// @dev Pairing is bounded too: sixteen steps a call, and a call with no new round still pairs.
    function test_counts_aLongRunOfUncountedPrintsIsWorkedThroughInBoundedSteps() public {
        for (uint256 day; day < 20; ++day) {
            payrolls(day, 1e18);
        }
        hires(19, 77);
        for (uint256 i; i < 3; ++i) {
            report.print();
        }
        assertEq(report.printCount(), 20);
        JobsReport.Summary memory s = report.summary();
        assertEq(s.hiresRead, 1);
        assertEq(s.pairedPrints, 16, "sixteen prints settled without a count in one call");
        assertEq(report.printAt(19).hiresRound, 0);

        report.print();
        assertEq(report.printAt(19).count, 77);
        s = report.summary();
        assertEq(s.pairedPrints, 20);
        assertEq(s.pairedCounts, 1);
    }

    /// @dev What ends up in the report does not depend on when `print` is called: a report printed
    /// after every answer and one printed only at the end hold the same entries.
    function test_counts_theReportIsTheSameWheneverPrintIsCalled() public {
        JobsReport late = new JobsReport(address(q), PAYROLLS, HIRES, EMPLOYERS);

        payrolls(0, 5e18);
        report.print();
        hiresShifted(0, 40, 50);
        report.print();
        hiresShifted(1, 40, 51);
        report.print();
        payrolls(1, 6e18);
        report.print();
        q.pushAnswered(PAYROLLS, 20e18, first(2), last(3));
        report.print();
        hiresShifted(2, 40, 52);
        hiresShifted(3, 40, 53);
        report.print();
        payrolls(4, 7e18);
        hiresShifted(4, 4_000, 54);
        payrolls(5, 8e18);
        report.print();
        report.print();

        for (uint256 i; i < 4; ++i) {
            late.print();
        }

        assertEq(report.printCount(), 5);
        assertEq(late.printCount(), 5);
        assertEq(report.countsRecorded(), 5);
        assertEq(late.countsRecorded(), 5);
        for (uint256 i; i < 5; ++i) {
            assertEq(abi.encode(report.printAt(i)), abi.encode(late.printAt(i)), "print differs");
            assertEq(abi.encode(report.countAt(i)), abi.encode(late.countAt(i)), "count differs");
        }
        assertEq(abi.encode(report.summary()), abi.encode(late.summary()));
        // What the entries are: days 0 and 1 paired, the two-day print with neither of its days'
        // counts, the count shifted by more than half a day with the day after its own.
        assertEq(report.printAt(0).count, 50);
        assertEq(report.printAt(1).count, 51);
        assertEq(report.printAt(2).hiresRound, 0);
        assertEq(report.printAt(3).hiresRound, 0);
        assertEq(report.printAt(4).count, 54);
    }

    /// @dev Brief, section 11, decision 13: the report is complete without the employers feed. `print`
    /// never reads it, so a Questions contract that cannot answer for that feed changes nothing.
    function test_print_neverReadsTheEmployersFeed() public {
        JobsReport r = report;
        feedDown(EMPLOYERS);
        payrolls(0, 53.5e18);
        hires(0, 107);
        payrolls(1, 60e18);
        hires(1, 120);

        (uint256 printed, uint256 counted) = r.print();
        assertEq(printed, 2);
        assertEq(counted, 2);
        JobsReport.Summary memory s = r.summary();
        assertEq(s.total, 113.5e18);
        assertEq(s.totalCount, 227);
        assertEq(s.streak, 2);
        assertEq(s.bestAmount, 60e18);
        assertEq(r.printAt(1).count, 120);
        assertEq(s.crowns, 0);

        // Only `crown` needs that feed, and only `crown` fails without it.
        vm.expectRevert(QuestionsRig.Down.selector);
        r.crown(1, abi.encode(addresses(3)));
    }
}

/// @dev `crown` and the page views.
contract JobsReportCrownTest is JobsReportSetup {
    event EmployersOfTheWeek(
        uint64 indexed round, address first, address second, address third, uint64 fromBlock, uint64 toBlock
    );

    function test_crown_storesTheTopThreeOfTheAttestedList() public {
        address[] memory list = addresses(5);
        bytes memory answer = abi.encode(list);
        uint64 round = employers(answer, 0, 6);

        vm.expectEmit(address(report));
        emit EmployersOfTheWeek(round, list[0], list[1], list[2], first(0), last(6));
        vm.prank(makeAddr("anyone"));
        report.crown(round, answer);

        JobsReport.Crown memory c = report.crownOf(round);
        assertEq(c.first, list[0]);
        assertEq(c.second, list[1]);
        assertEq(c.third, list[2]);
        assertEq(c.fromBlock, first(0));
        assertEq(c.toBlock, last(6));
        assertEq(c.crownedAt, vm.getBlockTimestamp());
        assertEq(c.places, 3);

        (bool exists, uint64 latestRound, JobsReport.Crown memory latest) = report.latestCrown();
        assertTrue(exists);
        assertEq(latestRound, round);
        assertEq(latest.first, list[0]);
        assertEq(report.crownCount(), 1);
        assertEq(report.summary().latestCrownedRound, round);
    }

    /// @dev The answer bytes of a real attested address-list request (oracle request a4d33e90, saved in
    /// test/fixtures/payroll/attested-address-list.json). The oracle cut the signed list to the
    /// request's `head` of one, so one place is filled.
    function test_crown_readsARealAttestedList() public {
        string memory json = vm.readFile("test/fixtures/payroll/attested-address-list.json");
        bytes memory answer = vm.parseJsonBytes(json, ".answer");
        assertEq(keccak256(answer), vm.parseJsonBytes32(json, ".answerKeccak"), "the fixture is intact");
        address[] memory decoded = abi.decode(answer, (address[]));
        assertEq(decoded.length, 1);

        uint64 round = employers(answer, 0, 6);
        report.crown(round, answer);
        JobsReport.Crown memory c = report.crownOf(round);
        assertEq(c.first, vm.parseJsonAddress(json, ".first"));
        assertEq(c.first, decoded[0]);
        assertEq(c.second, address(0));
        assertEq(c.third, address(0));
        assertEq(c.places, 1);
    }

    /// @dev The answer bytes of the request that proved the employers house feed (oracle request
    /// 2cbe6bb3, attested 13 October 2026, saved whole in test/fixtures/questions/proofs): a real
    /// attested list of exactly three addresses, as the feed asks for.
    function test_crown_readsTheRealAttestedListOfThree() public {
        string memory json = vm.readFile("test/fixtures/questions/proofs/employers.oracle.json");
        assertEq(vm.parseJsonString(json, ".status"), "attested");
        bytes memory answer = vm.parseJsonBytes(json, ".attestation.answer");
        address[] memory decoded = abi.decode(answer, (address[]));
        assertEq(decoded.length, 3);

        uint64 round = employers(answer, 0, 6);
        report.crown(round, answer);
        JobsReport.Crown memory c = report.crownOf(round);
        assertEq(c.first, 0x21919137E69ed667aC404c7FcB71B8179b645F46);
        assertEq(c.second, 0x9fAdAB91f6FA03DBd7F4F8a08A338704bAAcf63f);
        assertEq(c.third, 0x7B8C742F2e1eEB3fB2C10d72967Fa6d4a22f0479);
        assertEq(c.first, decoded[0]);
        assertEq(c.second, decoded[1]);
        assertEq(c.third, decoded[2]);
        assertEq(c.places, 3);
    }

    function test_crown_aShortListFillsFewerPlaces() public {
        address[] memory two = addresses(2);
        uint64 r1 = employers(abi.encode(two), 0, 6);
        report.crown(r1, abi.encode(two));
        JobsReport.Crown memory c = report.crownOf(r1);
        assertEq(c.places, 2);
        assertEq(c.second, two[1]);
        assertEq(c.third, address(0));

        address[] memory none = new address[](0);
        uint64 r2 = employers(abi.encode(none), 7, 13);
        report.crown(r2, abi.encode(none));
        c = report.crownOf(r2);
        assertEq(c.places, 0);
        assertEq(c.first, address(0));
        assertGt(c.crownedAt, 0);
    }

    function test_crown_rejectsBytesThatAreNotTheAttestedOnes() public {
        address[] memory list = addresses(5);
        uint64 round = employers(abi.encode(list), 0, 6);

        (list[0], list[1]) = (list[1], list[0]); // the same employers in another order
        vm.expectRevert(abi.encodeWithSelector(JobsReport.AnswerMismatch.selector, round));
        report.crown(round, abi.encode(list));

        vm.expectRevert(abi.encodeWithSelector(JobsReport.AnswerMismatch.selector, round));
        report.crown(round, "");
        assertEq(report.crownCount(), 0);
    }

    function test_crown_needsAnAnsweredRound() public {
        bytes memory answer = abi.encode(addresses(3));
        vm.expectRevert(abi.encodeWithSelector(JobsReport.RoundNotAnswered.selector, 0));
        report.crown(0, answer);
        vm.expectRevert(abi.encodeWithSelector(JobsReport.RoundNotAnswered.selector, 1));
        report.crown(1, answer);

        uint64 pending = q.openRound(EMPLOYERS, first(0), last(6));
        vm.expectRevert(abi.encodeWithSelector(JobsReport.RoundNotAnswered.selector, pending));
        report.crown(pending, answer);

        q.fail(EMPLOYERS, pending);
        vm.expectRevert(abi.encodeWithSelector(JobsReport.RoundNotAnswered.selector, pending));
        report.crown(pending, answer);
    }

    function test_crown_onlyOncePerRound() public {
        bytes memory answer = abi.encode(addresses(3));
        uint64 round = employers(answer, 0, 6);
        report.crown(round, answer);
        vm.expectRevert(abi.encodeWithSelector(JobsReport.AlreadyCrowned.selector, round));
        report.crown(round, answer);
        assertEq(report.crownCount(), 1);
    }

    /// @dev Bytes that were attested but are not an address list end in `BadAnswer`, never in a panic.
    function test_crown_rejectsAttestedBytesThatAreNotAnAddressList() public {
        bytes[] memory bad = new bytes[](6);
        bad[0] = new bytes(63);
        bad[1] = abi.encode(uint256(0x1000), uint256(0)); // offset past the end
        bad[2] = abi.encode(type(uint256).max, uint256(0)); // offset that would overflow
        bad[3] = abi.encode(uint256(0x20), uint256(10), address(1), address(2)); // claims ten, holds two
        bad[4] = abi.encode(uint256(0x20), uint256(1), uint256(1) << 160); // not an address
        bad[5] = abi.encode(uint256(0x20), type(uint256).max); // absurd length

        for (uint256 i; i < bad.length; ++i) {
            uint64 round = employers(bad[i], 0, 6);
            vm.expectRevert(JobsReport.BadAnswer.selector);
            report.crown(round, bad[i]);
        }
        assertEq(report.crownCount(), 0);
    }

    function test_crown_readsAnyValidLayoutOfTheList() public {
        // The same two-address list with its body one word further in than `abi.encode` puts it.
        bytes memory answer = abi.encode(uint256(0x40), uint256(0xdead), uint256(2), address(0xA1), address(0xB2));
        uint64 round = employers(answer, 0, 6);
        report.crown(round, answer);
        JobsReport.Crown memory c = report.crownOf(round);
        assertEq(c.first, address(0xA1));
        assertEq(c.second, address(0xB2));
        assertEq(c.places, 2);
    }

    function test_crown_roundsMayBeCrownedInAnyOrder() public {
        bytes memory week1 = abi.encode(addresses(3));
        bytes memory week2 = abi.encode(addresses(4));
        uint64 r1 = employers(week1, 0, 6);
        uint64 r2 = employers(week2, 7, 13);

        report.crown(r2, week2);
        report.crown(r1, week1);

        (, uint64 latestRound,) = report.latestCrown();
        assertEq(latestRound, r2, "the latest crown is the highest round, not the last call");
        (uint64[] memory rounds, JobsReport.Crown[] memory page) = report.crownsPage(0, 10);
        assertEq(rounds.length, 2);
        assertEq(rounds[0], r2);
        assertEq(rounds[1], r1);
        assertEq(page[1].fromBlock, first(0));
    }

    function test_crown_revertsWhenQuestionsDoes() public {
        bytes memory answer = abi.encode(addresses(3));
        uint64 round = employers(answer, 0, 6);
        questionsDown(true);
        vm.expectRevert(QuestionsRig.Down.selector);
        report.crown(round, answer);
    }

    // ---- views

    function test_views_beforeAnythingExists() public view {
        (bool exists, uint256 index, JobsReport.Print memory p) = report.latestPrint();
        assertFalse(exists);
        assertEq(index + p.amount + p.toBlock, 0);
        (bool crowned, uint64 round, JobsReport.Crown memory c) = report.latestCrown();
        assertFalse(crowned);
        assertEq(round + c.crownedAt, 0);
        assertEq(report.printsPage(0, 10).length, 0);
        assertEq(report.latestPrints(0, 10).length, 0);
        assertEq(report.countsPage(0, 10).length, 0);
        assertEq(report.latestCounts(0, 10).length, 0);
        assertEq(report.countsRecorded(), 0);
        (uint64[] memory rounds,) = report.crownsPage(0, 10);
        assertEq(rounds.length, 0);
        assertEq(report.crownOf(1).crownedAt, 0);
    }

    function test_views_printAtRevertsPastTheEnd() public {
        vm.expectRevert(abi.encodeWithSelector(JobsReport.NoSuchPrint.selector, 0));
        report.printAt(0);
        payrolls(0, 1e18);
        report.print();
        report.printAt(0);
        vm.expectRevert(abi.encodeWithSelector(JobsReport.NoSuchPrint.selector, 1));
        report.printAt(1);
    }

    function test_views_pagesOfTheHistory() public {
        for (uint256 day; day < 10; ++day) {
            payrolls(day, (day + 1) * 1e18);
        }
        report.print();
        report.print();

        JobsReport.Print[] memory page = report.printsPage(2, 3);
        assertEq(page.length, 3);
        assertEq(page[0].amount, 3e18);
        assertEq(page[2].amount, 5e18);

        page = report.printsPage(8, 5);
        assertEq(page.length, 2, "shorter at the end of the history");
        assertEq(page[1].amount, 10e18);
        assertEq(report.printsPage(10, 5).length, 0);
        assertEq(report.printsPage(0, 0).length, 0);

        page = report.latestPrints(0, 3);
        assertEq(page.length, 3);
        assertEq(page[0].amount, 10e18, "newest first");
        assertEq(page[2].amount, 8e18);

        page = report.latestPrints(8, 5);
        assertEq(page.length, 2);
        assertEq(page[0].amount, 2e18);
        assertEq(page[1].amount, 1e18);
        assertEq(report.latestPrints(10, 5).length, 0);
    }

    function test_views_countAtRevertsPastTheEnd() public {
        vm.expectRevert(abi.encodeWithSelector(JobsReport.NoSuchCount.selector, 0));
        report.countAt(0);
        hires(0, 5);
        report.print();
        report.countAt(0);
        vm.expectRevert(abi.encodeWithSelector(JobsReport.NoSuchCount.selector, 1));
        report.countAt(1);
    }

    function test_views_pagesOfTheCounts() public {
        for (uint256 day; day < 10; ++day) {
            hires(day, day + 1);
        }
        report.print();
        report.print();

        JobsReport.Count[] memory page = report.countsPage(2, 3);
        assertEq(page.length, 3);
        assertEq(page[0].count, 3);
        assertEq(page[2].count, 5);
        assertEq(page[2].hiresRound, 5);
        assertEq(report.countsPage(8, 5).length, 2, "shorter at the end");
        assertEq(report.countsPage(10, 5).length, 0);

        page = report.latestCounts(0, 3);
        assertEq(page.length, 3);
        assertEq(page[0].count, 10, "newest first");
        assertEq(page[2].count, 8);
        page = report.latestCounts(8, 5);
        assertEq(page.length, 2);
        assertEq(page[1].count, 1);
        assertEq(report.latestCounts(10, 5).length, 0);
        assertEq(report.countsPage(0, 1_000).length, 10);
    }

    function test_views_aPageHoldsAtMostOneHundred() public {
        for (uint256 day; day < 120; ++day) {
            payrolls(day, 1e18);
        }
        for (uint256 i; i < 15; ++i) {
            report.print();
        }
        assertEq(report.printCount(), 120);
        assertEq(report.printsPage(0, 1_000).length, 100);
        assertEq(report.latestPrints(0, type(uint256).max).length, 100);
        assertEq(report.printsPage(100, 1_000).length, 20);
    }

    function test_views_summaryGathersTheRunningFigures() public {
        payrolls(0, 5e18);
        payrolls(1, 9e18);
        hires(0, 10);
        hires(1, 18);
        report.print();
        bytes memory answer = abi.encode(addresses(3));
        uint64 round = employers(answer, 0, 6);
        report.crown(round, answer);

        JobsReport.Summary memory s = report.summary();
        assertEq(s.prints, 2);
        assertEq(s.total, 14e18);
        assertEq(s.totalCount, 28);
        assertEq(s.bestAmount, 9e18);
        assertEq(s.bestIndex, 1);
        assertEq(s.streak, 2);
        assertEq(s.longestStreak, 2);
        assertEq(s.counts, 2);
        assertEq(s.payrollsRead, 2);
        assertEq(s.hiresRead, 2);
        assertEq(s.pairedPrints, 2);
        assertEq(s.pairedCounts, 2);
        assertEq(s.crowns, 1);
        assertEq(s.latestCrownedRound, round);
    }
}
