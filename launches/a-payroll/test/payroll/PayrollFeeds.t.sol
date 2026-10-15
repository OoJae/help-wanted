// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Payroll} from "../../src/payroll/Payroll.sol";
import {PayrollSetup} from "./PayrollSetup.sol";
import {RawResponder} from "./mocks/MockSeats.sol";
import {LooseToken, GreedyQuestions} from "./mocks/MockTokens.sol";
import {QuestionsRig, Rig} from "./mocks/QuestionsRig.sol";

using Rig for QuestionsRig;

/// @dev The feed budget: topping the three house feeds' meters up to a bounded runway, surviving a
/// Questions contract that misbehaves, and releasing budget that waited too long to the stakers.
///
/// The meters are the real `Questions` contract's. Where a test needs Questions to fail, the real
/// contract is cut off at its address (its calls made to revert) or the token is told to disturb the
/// pull of a top-up; where it needs a contract that breaks Questions' own rules (takes more than it
/// was offered, answers nonsense, has no code), a small double stands at Questions' address, since the
/// real contract cannot be made to do those things.
contract PayrollFeedsTest is PayrollSetup {
    event FeedFunded(bytes32 indexed feedId, uint256 amount);
    event FeedFundingFailed(bytes32 indexed feedId, uint256 amount);
    event FeedBudgetReleased(uint256 amount);
    event FeedBudgetAged(uint256 indexed period, uint256 heldOver);

    /// @dev Fourteen requests for each of the first two feeds, four for the third.
    uint256 internal constant RUNWAY = 14 * FEED_COST; // 7.28 IMD
    uint256 internal constant RUNWAY_C = 4 * FEED_COST; // 2.08 IMD
    uint256 internal constant FULL = 2 * RUNWAY + RUNWAY_C; // 16.64 IMD

    function setUp() public override {
        super.setUp();
        setFeedCosts(FEED_COST);
    }

    function meter(bytes32 feedId) internal view returns (uint256 balance) {
        (balance,) = questions.meterOf(feedId);
    }

    function budget() internal view returns (uint256 total) {
        (total,,,) = payroll.feedBudget();
    }

    function oldTranche() internal view returns (uint256 old) {
        (, old,,) = payroll.feedBudget();
    }

    // ---- topping up

    function test_fundFeeds_topsEachMeterUpToItsRunway() public {
        assertEq(payroll.FEED_RUNWAY_REQUESTS(), 14);
        assertEq(payroll.FEED_C_RUNWAY_REQUESTS(), 4);

        pay(200e18); // 40 IMD of budget
        vm.expectEmit(address(payroll));
        emit FeedFunded(FEED_A, RUNWAY);
        vm.expectEmit(address(payroll));
        emit FeedFunded(FEED_B, RUNWAY);
        vm.expectEmit(address(payroll));
        emit FeedFunded(FEED_C, RUNWAY_C);

        vm.prank(keeper);
        (uint256 funded, uint256 released) = payroll.fundFeeds();

        assertEq(funded, FULL);
        assertEq(released, 0);
        assertEq(meter(FEED_A), RUNWAY);
        assertEq(meter(FEED_B), RUNWAY);
        assertEq(meter(FEED_C), RUNWAY_C, "the slow feed's runway is four of its own requests");
        assertEq(questions.sharesOf(FEED_A, address(payroll)), RUNWAY, "Payroll holds the meter shares");
        assertEq(payroll.ledger().feedsFunded, FULL);
        assertEq(budget(), 40e18 - FULL);
        assertEq(imd.balanceOf(keeper), 0);
        assertBooksBalance();
    }

    function test_fundFeeds_goesNoFurtherThanTheRunway() public {
        pay(200e18);
        payroll.fundFeeds();

        (uint256 funded,) = payroll.fundFeeds();
        assertEq(funded, 0, "full meters take nothing more");

        // One request is bought from feed A: only that much is replaced.
        questions.spend(FEED_A, FEED_COST);
        (funded,) = payroll.fundFeeds();
        assertEq(funded, FEED_COST);
        assertEq(meter(FEED_A), RUNWAY);
        assertBooksBalance();
    }

    /// @dev A budget that cannot cover the first two feeds is shared between them by need, and the
    /// third feed, which the Jobs Report does not need, gets nothing.
    function test_fundFeeds_theFirstTwoFeedsShareAShortBudgetByNeed() public {
        pay(50e18); // 10 IMD of budget against 14.56 the first two lack
        (uint256 funded,) = payroll.fundFeeds();

        assertEq(meter(FEED_A), 5e18);
        assertEq(meter(FEED_B), 5e18);
        assertEq(meter(FEED_C), 0);
        assertEq(funded, 10e18);
        assertEq(budget(), 0);
        assertBooksBalance();
    }

    function test_fundFeeds_unevenNeedsGetTheSameFraction() public {
        // A request of feed A costs half as much, so its runway is half as long in IMD.
        questions.setCost(FEED_A, FEED_COST / 2);

        pay(25e18); // 5 IMD of budget against 3.64 + 7.28 = 10.92 of need
        (uint256 funded,) = payroll.fundFeeds();

        uint256 needAB = RUNWAY / 2 + RUNWAY;
        assertEq(meter(FEED_A), (uint256(5e18) * (RUNWAY / 2)) / needAB);
        assertEq(meter(FEED_B), (uint256(5e18) * RUNWAY) / needAB);
        assertEq(meter(FEED_C), 0);
        assertLe(funded, 5e18);
        assertEq(budget(), 5e18 - funded, "the rounding wei stay in the budget");
        assertBooksBalance();
    }

    /// @dev Reviewers' note, fixed. The third feed (the weekly ranking) used to take a third of a short
    /// budget and fourteen weeks of cover. It now comes after the two feeds the report is printed
    /// from, and takes only what they leave.
    function test_fundFeeds_theThirdFeedTakesOnlyWhatTheFirstTwoLeave() public {
        pay(77.8e18); // 15.56 IMD of budget: the first two feeds' 14.56 and one more
        (uint256 funded,) = payroll.fundFeeds();
        assertEq(meter(FEED_A), RUNWAY);
        assertEq(meter(FEED_B), RUNWAY);
        assertEq(meter(FEED_C), 1e18, "what was left, short of its runway");
        assertEq(funded, 15.56e18);
        assertEq(budget(), 0);

        pay(100e18);
        (funded,) = payroll.fundFeeds();
        assertEq(funded, RUNWAY_C - 1e18, "the rest of its runway, once there is budget");
        assertEq(meter(FEED_C), RUNWAY_C);
        assertBooksBalance();
    }

    /// @dev Audit finding 2 (job be91e8ae), fixed. Payroll used to size a top-up from the meter's
    /// whole balance, so IMD somebody else had put there counted as runway, and this test said so
    /// (it was `test_fundFeeds_countsWhatOthersAlreadyPutOnAMeter` and expected Payroll to add only
    /// 2.28 IMD to the 5 a stranger held). The stranger can take its part out again at any time,
    /// so it is no runway: Payroll now keeps one runway of its own on the meter whatever else is there.
    function test_fundFeeds_doesNotCountWhatOthersPutOnAMeter() public {
        imd.mint(address(this), 5e18);
        imd.approve(address(questions), 5e18);
        questions.fund(FEED_A, 5e18);
        uint256[3] memory needs = payroll.feedShortfalls();
        assertEq(needs[0], RUNWAY, "somebody else's IMD is not Payroll's runway");

        pay(200e18);
        payroll.fundFeeds();
        assertEq(meter(FEED_A), RUNWAY + 5e18);
        assertEq(questions.redeemable(FEED_A, address(payroll)), RUNWAY, "one runway of Payroll's own");
        assertEq(questions.sharesOf(FEED_A, address(payroll)), RUNWAY);

        // The stranger leaves. Payroll's runway is still there and nothing more is needed.
        questions.defund(FEED_A, type(uint256).max);
        assertEq(imd.balanceOf(address(this)), 5e18, "the stranger took out exactly what it put in");
        assertEq(meter(FEED_A), RUNWAY);
        (uint256 funded,) = payroll.fundFeeds();
        assertEq(funded, 0);
        assertBooksBalance();
    }

    /// @dev A request is paid by everyone on the meter in proportion. Payroll replaces its own part
    /// of what was spent and nobody else's.
    function test_fundFeeds_replacesOnlyPayrollsPartOfWhatAMeterSpent() public {
        pay(200e18);
        payroll.fundFeeds();
        // A stranger joins feed A with as much as Payroll holds there, then a request is bought.
        imd.mint(address(this), RUNWAY);
        imd.approve(address(questions), RUNWAY);
        questions.fund(FEED_A, RUNWAY);
        questions.spend(FEED_A, FEED_COST);
        assertEq(questions.redeemable(FEED_A, address(payroll)), RUNWAY - FEED_COST / 2);

        (uint256 funded,) = payroll.fundFeeds();
        assertEq(funded, FEED_COST / 2, "half of the request was Payroll's to replace");
        assertEq(meter(FEED_A), 2 * RUNWAY - FEED_COST / 2);
        assertApproxEqAbs(questions.redeemable(FEED_A, address(payroll)), RUNWAY, 1);

        // The meter's shares are now worth less than a wei each and the pool rounds in its own
        // favour, so a top-up can leave the position one wei short. One wei is not a need: a second
        // call finds nothing to place.
        (funded,) = payroll.fundFeeds();
        assertEq(funded, 0, "a call right after a top-up placed something");
        needs3();
        assertBooksBalance();
    }

    function needs3() internal view {
        uint256[3] memory needs = payroll.feedShortfalls();
        assertEq(needs[0] + needs[1] + needs[2], 0, "a meter Payroll just topped up still shows a need");
    }

    function test_fundFeeds_skipsAFeedQuestionsDoesNotKnow() public {
        questions.unplant(FEED_B);
        pay(200e18);
        (uint256 funded,) = payroll.fundFeeds();
        assertEq(funded, RUNWAY + RUNWAY_C);
        assertEq(meter(FEED_B), 0);
        uint256[3] memory needs = payroll.feedShortfalls();
        assertEq(needs[0] + needs[1] + needs[2], 0);
    }

    /// @dev The same for a feed whose action the Intake does not sell: it costs nothing, so it is
    /// given nothing, and the real `fund` is never asked.
    function test_fundFeeds_skipsAFeedWhoseActionIsNotSold() public {
        questions.setCost(FEED_A, 0);
        pay(200e18);
        (uint256 funded,) = payroll.fundFeeds();
        assertEq(funded, RUNWAY + RUNWAY_C);
        assertEq(meter(FEED_A), 0);
    }

    /// @dev The price is set by the Intake's owner. Whatever it becomes, a top-up assumes at most
    /// `FEED_COST_CAP` per request, so one meter can take at most 28 IMD at a time.
    function test_fundFeeds_capsTheCostItAssumes() public {
        setFeedCosts(1_000e18);
        pay(1_000e18); // 200 IMD of budget
        (uint256 funded,) = payroll.fundFeeds();
        assertEq(meter(FEED_A), 14 * 2e18);
        assertEq(meter(FEED_B), 14 * 2e18);
        assertEq(meter(FEED_C), 4 * 2e18);
        assertEq(funded, 64e18);
        assertEq(budget(), 200e18 - funded);
    }

    function test_fundFeeds_withNoBudgetDoesNothing() public {
        vm.recordLogs();
        (uint256 funded, uint256 released) = payroll.fundFeeds();
        assertEq(funded + released, 0);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_feedShortfalls_reportsWhatEachMeterLacks() public {
        uint256[3] memory needs = payroll.feedShortfalls();
        assertEq(needs[0], RUNWAY);
        assertEq(needs[1], RUNWAY);
        assertEq(needs[2], RUNWAY_C);
        questionsDown(true);
        needs = payroll.feedShortfalls();
        assertEq(needs[0] + needs[1] + needs[2], 0, "an unreachable Questions reads as no need, not as a revert");
    }

    // ---- the books during a top-up

    /// @dev Reviewers' finding, as a regression test. `fundFeeds` used to write its ledger only after
    /// the calls into Questions, so in the middle of a top-up the contract's books said it owed more
    /// IMD than it held. Here `owed()` and the balance are read from inside the real `fund`, just
    /// before and just after it pulls the IMD (the token does the reading), in each of the three
    /// calls: the balance covers what is owed every time.
    function test_fundFeeds_theBalanceCoversWhatIsOwedInTheMiddleOfATopUp() public {
        pay(200e18);
        tipTo(ids(7), 3e18);
        imd.setProbe(true);

        (uint256 funded,) = payroll.fundFeeds();

        assertEq(funded, FULL);
        assertEq(imd.probes(), 6, "two looks in each of three top-ups");
        assertFalse(imd.sawFunderUncovered(), "the books ran ahead of the balance during a top-up");
        assertBooksBalance();
    }

    /// @dev A top-up that Questions refuses, or of which only part leaves, leaves the budget exactly
    /// as if only the part that left had been offered: the same total and the same old tranche.
    function test_fundFeeds_whatDidNotLeaveGoesBackWhereItCameFrom() public {
        setFeedCosts(0);
        pay(100e18);
        vm.warp(START + 11 days);
        pay(100e18); // old tranche 20, fresh 20
        setFeedCosts(FEED_COST);
        assertEq(oldTranche(), 20e18);

        questionsFundDown(true);
        (uint256 funded,) = payroll.fundFeeds();
        assertEq(funded, 0);
        assertEq(budget(), 40e18);
        assertEq(oldTranche(), 20e18, "a refused top-up took nothing out of the old tranche");
        assertEq(payroll.ledger().feedsFunded, 0);

        questionsFundDown(false);
        imd.setTakeBps(2_500);
        (funded,) = payroll.fundFeeds();
        assertEq(funded, FULL / 4);
        assertEq(budget(), 40e18 - FULL / 4);
        assertEq(oldTranche(), 20e18 - FULL / 4, "only what left came out of the old tranche");
        assertEq(payroll.ledger().feedsFunded, FULL / 4);
        assertBooksBalance();
    }

    /// @dev The last-resort check: if more IMD left during a top-up than was approved for it, the whole
    /// call is undone. IMD cannot do this; a token that lets Questions move funds without an allowance
    /// is used to reach the check. Everything else in Payroll keeps working.
    function test_fundFeeds_revertsIfATopUpTakesMoreThanItWasOffered() public {
        GreedyQuestions greedy = new GreedyQuestions();
        LooseToken token = new LooseToken(address(greedy));
        greedy.setToken(IERC20(address(token)));
        Payroll p = new Payroll(
            address(token),
            address(simd),
            address(seats),
            SEAT_COUNT,
            address(adapter),
            address(greedy),
            FEED_A,
            FEED_B,
            FEED_C
        );
        token.mint(payer, 20_100e18);
        vm.startPrank(payer);
        token.approve(address(p), type(uint256).max);
        p.pay(20_000e18, bytes32(0));
        vm.stopPrank();

        vm.expectRevert(Payroll.FeedOverdrawn.selector);
        p.fundFeeds();

        (uint256 total,,,) = p.feedBudget();
        assertEq(total, 4_000e18, "the budget is untouched");
        assertEq(p.ledger().feedsFunded, 0);
        assertEq(token.balanceOf(address(greedy)), 0);
        assertEq(token.allowance(address(p), address(greedy)), 0);

        vm.prank(payer);
        p.pay(100e18, bytes32(0));
        assertEq(p.claimSeat(1), 3e18 + 0.015e18);
        assertEq(p.book(), 0);
    }

    // ---- Questions misbehaving

    /// @dev A Questions contract that reverts everywhere blocks nothing in Payroll.
    function test_questionsDown_blocksNothing() public {
        pay(200e18);
        questionsDown(true);

        (uint256 funded, uint256 released) = payroll.fundFeeds();
        assertEq(funded + released, 0);
        assertEq(budget(), 40e18, "the budget is untouched");

        pay(100e18);
        vm.prank(payer);
        imd.transfer(address(payroll), 1e18);
        assertEq(payroll.book(), 1e18);
        skip(1 hours);
        assertGt(payroll.drip(), 0);
        assertGt(payroll.claimSeat(1), 0);
        adapter.bind(1, address(seats), 1);
        tipTo(ids(1), 1e18);
        assertEq(payroll.claimTip(1), 1e18);
        assertBooksBalance();

        questionsDown(false);
        (funded,) = payroll.fundFeeds();
        assertEq(funded, FULL, "and the budget is still there when Questions comes back");
    }

    function test_questionsFundReverts_keepsTheBudgetAndClearsTheAllowance() public {
        pay(200e18);
        questionsFundDown(true);
        vm.expectEmit(address(payroll));
        emit FeedFundingFailed(FEED_A, RUNWAY);
        vm.expectEmit(address(payroll));
        emit FeedFundingFailed(FEED_B, RUNWAY);
        vm.expectEmit(address(payroll));
        emit FeedFundingFailed(FEED_C, RUNWAY_C);
        (uint256 funded,) = payroll.fundFeeds();

        assertEq(funded, 0);
        assertEq(budget(), 40e18);
        assertEq(payroll.ledger().feedsFunded, 0);
        assertEq(imd.allowance(address(payroll), address(questions)), 0);
        assertBooksBalance();
    }

    /// @dev What counts as spent is what left, not what was offered. Here a quarter of each top-up
    /// leaves Payroll; the real Questions credits its meters with exactly that.
    function test_topUpThatMovesLess_isBookedByWhatLeft() public {
        pay(200e18);
        imd.setTakeBps(2_500);
        (uint256 funded,) = payroll.fundFeeds();
        assertEq(funded, FULL / 4);
        assertEq(meter(FEED_A) + meter(FEED_B) + meter(FEED_C), FULL / 4);
        assertEq(payroll.ledger().feedsFunded, funded);
        assertEq(budget(), 40e18 - funded);
        assertEq(imd.allowance(address(payroll), address(questions)), 0, "the unused allowance is cleared");
        assertBooksBalance();
    }

    function test_questionsWithoutCode_fundsNothing() public {
        Payroll p = payrollWithQuestions(address(0x0E570));
        vm.prank(payer);
        p.pay(200e18, bytes32(0));
        (uint256 funded, uint256 released) = p.fundFeeds();
        assertEq(funded + released, 0);
        (uint256 total,,,) = p.feedBudget();
        assertEq(total, 40e18);
    }

    /// @dev A contract that answers every call with one word: it claims a cost and a low meter, accepts
    /// the `fund` call, and takes nothing. Payroll counts nothing as spent.
    function test_questionsAnswersNonsense_fundsNothing() public {
        RawResponder odd = new RawResponder();
        odd.program(abi.encode(uint256(1e18)), false);
        Payroll p = payrollWithQuestions(address(odd));
        vm.prank(payer);
        p.pay(200e18, bytes32(0));

        vm.expectEmit(address(p));
        emit FeedFundingFailed(FEED_A, 13e18);
        vm.expectEmit(address(p));
        emit FeedFundingFailed(FEED_B, 13e18);
        vm.expectEmit(address(p));
        emit FeedFundingFailed(FEED_C, 3e18);
        (uint256 funded,) = p.fundFeeds();
        assertEq(funded, 0);
        assertEq(p.ledger().feedsFunded, 0);
        assertEq(imd.allowance(address(p), address(odd)), 0);
        assertEq(imd.balanceOf(address(p)), 200e18);

        // Too short an answer reads as "unknown feed".
        odd.program(hex"01", false);
        uint256[3] memory needs = p.feedShortfalls();
        assertEq(needs[0] + needs[1] + needs[2], 0);
    }

    /// @dev A call back into Payroll in the middle of a top-up is refused by the lock. The call is made
    /// from inside the real `fund`, while it pulls the IMD.
    function test_callBackDuringATopUp_isRefused() public {
        pay(200e18);
        vm.prank(payer);
        imd.transfer(address(payroll), 9e18); // something `book` would pick up if the nested call ran
        imd.setReenter(true);

        (uint256 funded,) = payroll.fundFeeds();

        assertTrue(imd.reentryBlocked(), "the nested call reverted");
        assertEq(funded, FULL);
        assertEq(payroll.ledger().received, 200e18, "nothing was booked from inside the top-up");
        assertEq(payroll.unbooked(), 9e18);
        assertBooksBalance();
    }

    // ---- ageing: budget that the meters do not need goes to stakers

    function test_budget_isKeptThroughOneBoundaryAndReleasedAtTheNext() public {
        setFeedCosts(0); // the feeds need nothing, so the budget can only wait
        pay(100e18); // 20 IMD of budget, booked 3 days into a fortnight
        (uint256 total, uint256 old, uint256 releasableNow, uint256 nextReleaseAt) = payroll.feedBudget();
        assertEq(total, 20e18);
        assertEq(old, 0);
        assertEq(releasableNow, 0);
        assertEq(nextReleaseAt, START + 11 days);

        // First boundary: the budget has waited 11 days. It becomes the old tranche; nothing leaves.
        vm.warp(START + 11 days);
        vm.expectEmit(address(payroll));
        emit FeedBudgetAged((START + 11 days) / 14 days, 20e18);
        (, uint256 released) = payroll.fundFeeds();
        assertEq(released, 0);
        (total, old, releasableNow,) = payroll.feedBudget();
        assertEq(total, 20e18);
        assertEq(old, 20e18);
        assertEq(releasableNow, 0);

        // Second boundary: 25 days. Nothing needed it, so it goes to the staker stream.
        vm.warp(START + 25 days);
        (,, releasableNow,) = payroll.feedBudget();
        assertEq(releasableNow, 20e18);
        Payroll.Ledger memory before = payroll.ledger();

        vm.expectEmit(address(payroll));
        emit FeedBudgetAged((START + 25 days) / 14 days, 0);
        vm.expectEmit(address(payroll));
        emit FeedBudgetReleased(20e18);
        vm.prank(keeper);
        (, released) = payroll.fundFeeds();

        assertEq(released, 20e18);
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.toFeeds, before.toFeeds - 20e18);
        assertEq(l.toStakers, before.toStakers + 20e18);
        assertEq(l.feedsReleased, 20e18);
        assertEq(l.toFeeds + l.feedsReleased, 20e18, "the feeds' share as booked is toFeeds + feedsReleased");
        assertEq(l.received, 100e18, "moving budget is not new revenue");
        assertEq(budget(), 0);
        (uint256 outstanding, uint256 unvested, uint256 endsAt,,,) = payroll.stream();
        assertEq(outstanding, 70e18);
        assertEq(unvested, 20e18, "the released budget vests over a fresh seven days");
        assertEq(endsAt, vm.getBlockTimestamp() + 7 days);
        assertBooksBalance();
    }

    /// @dev Audit finding 1 (job be91e8ae), fixed. A booking that crossed a boundary used to release
    /// the old tranche itself, without looking at the meters, and this test said so (it was
    /// `test_budget_ageingRunsInsideABooking` and expected `FeedBudgetReleased` from the third `pay`).
    /// A booking now only sorts the budget into its tranches. What has fallen due waits for
    /// `fundFeeds`, which serves the meters first; it needs nothing from Questions to release.
    function test_budget_aBookingAgesTheBudgetAndReleasesNothing() public {
        questionsDown(true);
        pay(100e18);
        vm.warp(START + 11 days);
        pay(100e18); // rolls: first 20 becomes old, this 20 is fresh
        (uint256 total, uint256 old, uint256 releasableNow,) = payroll.feedBudget();
        assertEq(total, 40e18);
        assertEq(old, 20e18);
        assertEq(releasableNow, 0);

        vm.warp(START + 25 days);
        vm.recordLogs();
        pay(100e18); // rolls again: the oldest 20 falls due, the middle 20 is now old
        assertFalse(_logged(FeedBudgetReleased.selector), "a booking released feed budget");
        (total, old, releasableNow,) = payroll.feedBudget();
        assertEq(total, 60e18, "nothing left the budget");
        assertEq(old, 20e18);
        assertEq(releasableNow, 20e18);
        assertEq(payroll.feedBudgetDue(), 20e18);
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.feedsReleased, 0);
        assertEq(l.toStakers, 150e18);
        assertEq(l.toFeeds, 60e18);

        // Questions is still unreachable. The release does not depend on it.
        vm.expectEmit(address(payroll));
        emit FeedBudgetReleased(20e18);
        (uint256 funded, uint256 released) = payroll.fundFeeds();
        assertEq(funded, 0);
        assertEq(released, 20e18);
        l = payroll.ledger();
        assertEq(l.feedsReleased, 20e18);
        assertEq(l.toStakers, 150e18 + 20e18);
        assertEq(l.toFeeds, 60e18 - 20e18);
        assertEq(payroll.feedBudgetDue(), 0);
        (total, old, releasableNow,) = payroll.feedBudget();
        assertEq(total, 40e18);
        assertEq(old, 20e18);
        assertEq(releasableNow, 0);
        assertBooksBalance();
    }

    /// @dev The same boundary crossed by a booking first or by `fundFeeds` first ends the same way:
    /// the meters hold their runways and only what they left has gone to stakers.
    function test_budget_whoCrossesTheBoundaryFirstDoesNotMatter() public {
        setFeedCosts(0);
        pay(100e18);
        vm.warp(START + 11 days);
        payroll.fundFeeds(); // 20 IMD is now the old tranche
        setFeedCosts(FEED_COST); // the feeds exist now and their meters are empty
        vm.warp(START + 25 days);
        uint256 snapshot = vm.snapshotState();

        (uint256 funded, uint256 released) = payroll.fundFeeds();
        assertEq(funded, FULL);
        assertEq(released, 20e18 - FULL);

        vm.revertToState(snapshot);
        pay(1); // one wei, booked before anybody calls fundFeeds
        assertEq(payroll.ledger().feedsReleased, 0);
        assertEq(payroll.feedBudgetDue(), 20e18);
        (funded, released) = payroll.fundFeeds();
        assertEq(funded, FULL, "the meters were not served out of the tranche that had fallen due");
        assertEq(released, 20e18 - FULL);
        assertEq(meter(FEED_A), RUNWAY);
        assertEq(meter(FEED_B), RUNWAY);
        assertEq(meter(FEED_C), RUNWAY_C);
        assertEq(budget(), 0);

        vm.revertToState(snapshot);
        vm.prank(payer);
        imd.transfer(address(payroll), 1); // or a plain transfer picked up by `book`
        assertEq(payroll.book(), 1);
        assertEq(payroll.ledger().feedsReleased, 0);
        (funded, released) = payroll.fundFeeds();
        assertEq(funded, FULL);
        assertEq(released, 20e18 - FULL);
        assertBooksBalance();
    }

    /// @dev What has fallen due is spent first, then the old tranche, then the fresh one; and what
    /// falls due keeps adding up while nobody calls `fundFeeds`.
    function test_budget_dueIsSpentBeforeOldAndOldBeforeFresh() public {
        setFeedCosts(0);
        pay(10e18); // 2 IMD
        vm.warp(START + 11 days);
        pay(15e18); // 3 IMD; the first 2 are old
        vm.warp(START + 25 days);
        pay(100e18); // 20 IMD; 2 are due, 3 are old
        assertEq(payroll.feedBudgetDue(), 2e18);
        assertEq(oldTranche(), 3e18);
        assertEq(budget(), 25e18);

        setFeedCosts(FEED_COST);
        (uint256 funded, uint256 released) = payroll.fundFeeds(); // 16.64 placed: 2 due, 3 old, 11.64 fresh
        assertEq(funded, FULL);
        assertEq(released, 0, "the meters took all that was due");
        assertEq(payroll.feedBudgetDue(), 0);
        assertEq(oldTranche(), 0);
        assertEq(budget(), 25e18 - FULL);

        // Two boundaries later, with nobody calling in between, all of what is left is due.
        setFeedCosts(0);
        vm.warp(START + 39 days);
        pay(1e18); // 0.2 IMD; the 8.36 left over is now old
        assertEq(payroll.feedBudgetDue(), 0);
        assertEq(oldTranche(), 25e18 - FULL);
        vm.warp(START + 53 days);
        pay(1e18); // 0.2 IMD; 8.36 due, 0.2 old
        vm.warp(START + 67 days);
        pay(1e18); // 0.2 IMD; 8.56 due, 0.2 old
        assertEq(payroll.feedBudgetDue(), 25e18 - FULL + 0.2e18);
        assertEq(oldTranche(), 0.2e18);
        (, released) = payroll.fundFeeds();
        assertEq(released, 25e18 - FULL + 0.2e18);
        assertEq(budget(), 0.4e18);
        assertBooksBalance();
    }

    /// @dev A top-up Questions refuses puts what was due back where it came from, and the same call
    /// then releases it: a meter that cannot be funded does not hold the budget back.
    function test_budget_aRefusedTopUpDoesNotHoldBackWhatIsDue() public {
        setFeedCosts(0);
        pay(100e18);
        vm.warp(START + 25 days);
        setFeedCosts(FEED_COST);
        questionsFundDown(true);

        (uint256 funded, uint256 released) = payroll.fundFeeds();
        assertEq(funded, 0);
        assertEq(released, 20e18, "all of it was due and none of it could be placed");
        assertEq(budget(), 0);
        assertEq(payroll.ledger().feedsFunded, 0);
        assertBooksBalance();
    }

    /// @dev Part of a top-up leaves: only that part comes out of what was due.
    function test_budget_aPartialTopUpTakesOnlyWhatLeftOutOfWhatIsDue() public {
        setFeedCosts(0);
        pay(100e18);
        vm.warp(START + 25 days);
        setFeedCosts(FEED_COST);
        imd.setTakeBps(2_500);

        (uint256 funded, uint256 released) = payroll.fundFeeds();
        assertEq(funded, FULL / 4);
        assertEq(released, 20e18 - FULL / 4);
        assertEq(payroll.ledger().feedsFunded, FULL / 4);
        assertEq(budget(), 0);
        assertBooksBalance();
    }

    function _logged(bytes32 topic) internal view returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(payroll) && logs[i].topics[0] == topic) return true;
        }
        return false;
    }

    function test_budget_aLongSilenceReleasesAllOfIt() public {
        setFeedCosts(0);
        pay(100e18);
        vm.warp(START + 11 days);
        pay(100e18);
        vm.warp(START + 90 days); // several boundaries with no call at all
        (,, uint256 releasableNow,) = payroll.feedBudget();
        assertEq(releasableNow, 40e18);
        (, uint256 released) = payroll.fundFeeds();
        assertEq(released, 40e18);
        assertEq(budget(), 0);
        assertBooksBalance();
    }

    /// @dev At a boundary the meters are served first; only what they leave is released.
    function test_budget_metersAreServedBeforeAnythingIsReleased() public {
        setFeedCosts(0);
        pay(100e18);
        vm.warp(START + 25 days);
        setFeedCosts(FEED_COST); // the feeds exist now and their meters are empty

        (uint256 funded, uint256 released) = payroll.fundFeeds();
        assertEq(funded, FULL, "all three runways, out of budget that was due for release");
        assertEq(released, 20e18 - FULL, "only what the meters left is released");
        assertEq(budget(), 0);
        assertBooksBalance();
    }

    function test_budget_spendingComesOutOfTheOldTrancheFirst() public {
        setFeedCosts(0);
        pay(50e18);
        vm.warp(START + 11 days);
        pay(100e18); // old 10, fresh 20
        setFeedCosts(FEED_COST);

        (uint256 funded,) = payroll.fundFeeds(); // 16.64 needed
        assertEq(funded, FULL);
        (uint256 total, uint256 old,,) = payroll.feedBudget();
        assertEq(total, 30e18 - FULL);
        assertEq(old, 0, "the old tranche went first, so nothing is left to release at the next boundary");

        vm.warp(START + 25 days);
        (, uint256 released) = payroll.fundFeeds();
        assertEq(released, 0);
        (, old,,) = payroll.feedBudget();
        assertEq(old, 30e18 - FULL);
    }

    function test_budget_releasedMoneyReachesStakersThroughTheStream() public {
        setFeedCosts(0);
        pay(100e18);
        vm.warp(START + 25 days);
        payroll.fundFeeds();

        uint256 sentBefore = payroll.ledger().dripped;
        for (uint256 i; i < 400; ++i) {
            skip(1 hours);
            payroll.drip();
        }
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.dripped - sentBefore, 70e18, "the stakers' 50 and the 20 the feeds never needed");
        assertEq(l.dripped, l.toStakers);
        assertBooksBalance();
    }

    function payrollWithQuestions(address questions_) internal returns (Payroll p) {
        p = new Payroll(
            address(imd),
            address(simd),
            address(seats),
            SEAT_COUNT,
            address(adapter),
            questions_,
            FEED_A,
            FEED_B,
            FEED_C
        );
        vm.prank(payer);
        imd.approve(address(p), type(uint256).max);
    }
}
