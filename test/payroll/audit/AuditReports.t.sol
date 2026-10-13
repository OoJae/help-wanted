// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Payroll} from "../../../src/payroll/Payroll.sol";
import {Questions} from "../../../src/questions/Questions.sol";

// Regression tests for the findings of IdentityMD's two audit jobs on commit 5c049e0, judged on
// 13 October 2026: be91e8ae-9f45-495f-a318-60fab672a92e ("report one": 1 medium, 2 low, 1 info) and
// 22624be0-d2da-400e-91c4-51dac0a9a7f5 ("report two": 1 medium, 2 low, 2 info). Each test starts
// from the proof or the reproduction the auditors gave, on the auditors' own fixture: the real
// `Questions`, a plain ERC-20, a plain ERC-4626 vault, and a stand-in Intake that only answers
// `priceOf`. docs/AUDITS.md lists every finding with what was changed and what was left.
//
// Two findings of report two are tested elsewhere, because they need other fixtures: finding 1 (a
// visitor to sIMD around the drips) in test/payroll/PayrollStream.t.sol and, against the real sIMD,
// in test/payroll/fork/PayrollFork.t.sol; finding 5 (a skip rule of the Jobs Report) in
// test/payroll/JobsReport.t.sol and test/payroll/integration/LaunchA.t.sol.

contract ProofIMD is ERC20 {
    constructor() ERC20("IMD", "IMD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ProofVault is ERC4626 {
    constructor(IERC20 asset_) ERC20("sIMD", "sIMD") ERC4626(asset_) {}
}

/// @dev Stands in for the Intake: only `priceOf` is read by `Questions.costOf`.
contract ProofIntake {
    mapping(bytes32 => mapping(address => uint256)) public priceOf;

    function setPrice(bytes32 action, address asset, uint256 amount) external {
        priceOf[action][asset] = amount;
    }
}

contract Nothing {}

/// @dev Report two's reproduction of its finding 2 as one transaction: put a runway on each house
/// meter, call `fundFeeds`, take everything off again.
contract Sandwich {
    function run(Questions questions, Payroll payroll, bytes32[3] calldata feeds, uint256[3] calldata amounts)
        external
        returns (uint256 funded, uint256 released)
    {
        IERC20 imd = questions.IMD();
        imd.approve(address(questions), type(uint256).max);
        for (uint256 i; i < 3; ++i) {
            questions.fund(feeds[i], amounts[i]);
        }
        (funded, released) = payroll.fundFeeds();
        for (uint256 i; i < 3; ++i) {
            questions.defund(feeds[i], type(uint256).max);
        }
    }
}

/// @dev The auditors' fixture for the feed-budget findings: three feeds in the real `Questions`
/// whose action is not sold until a test sets a price, so the budget can be made to wait.
abstract contract AuditBudgetFixture is Test {
    bytes32 internal constant ACTION = bytes32("oracle.request@oracle-1");
    uint256 internal constant COST = 0.52e18;
    uint256 internal constant RUNWAY = 14 * COST;
    uint256 internal constant RUNWAY_C = 4 * COST;
    uint256 internal constant FULL = 2 * RUNWAY + RUNWAY_C;

    ProofIMD internal imd;
    ProofVault internal simd;
    ProofIntake internal intake;
    Questions internal questions;
    Payroll internal payroll;
    bytes32 internal feedA;
    bytes32 internal feedB;
    bytes32 internal feedC;
    address internal payer = makeAddr("payer");
    address internal staker = makeAddr("staker");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        vm.warp(1456 * 14 days + 3 days);
        vm.roll(26_000_000);
        imd = new ProofIMD();
        simd = new ProofVault(IERC20(address(imd)));
        intake = new ProofIntake();
        questions = new Questions(address(intake), address(imd), makeAddr("oracle signer"));
        feedA = _createFeed("payrolls");
        feedB = _createFeed("hires");
        feedC = _createFeed("employers");
        Nothing n = new Nothing();
        payroll = new Payroll(
            address(imd), address(simd), address(n), 2000, address(n), address(questions), feedA, feedB, feedC
        );
        imd.mint(staker, 1e18);
        vm.startPrank(staker);
        imd.approve(address(simd), type(uint256).max);
        simd.deposit(1e18, staker);
        vm.stopPrank();
        imd.mint(payer, 1e30);
        vm.prank(payer);
        imd.approve(address(payroll), type(uint256).max);
        imd.mint(stranger, 100e18);
        vm.prank(stranger);
        imd.approve(address(questions), type(uint256).max);
    }

    function _createFeed(string memory question) internal returns (bytes32) {
        Questions.FeedParams memory p;
        p.action = ACTION;
        p.chainId = uint64(block.chainid);
        p.answerType = 3;
        p.panelSize = 3;
        p.quorum = 2;
        p.minAgreed = 1;
        p.validFor = 3600;
        p.cadenceBlocks = 100;
        p.maxWindowBlocks = 200;
        p.lagBlocks = 12;
        p.pinHash = true;
        p.maxPrice = type(uint96).max;
        bytes memory prefix = bytes.concat(
            '{"answerType":"uint256","chainId":',
            bytes(vm.toString(block.chainid)),
            ',"question":"',
            bytes(question),
            '","v":1,"window":{"fromBlock":'
        );
        bytes memory tail = ',"panelSize":3,"quorum":2,"validForSeconds":3600}';
        return questions.createFeed(p, prefix, tail);
    }

    function _pay(uint256 amount) internal {
        vm.prank(payer);
        payroll.pay(amount, bytes32("x"));
    }

    function _meter(bytes32 feedId) internal view returns (uint256 balance) {
        (balance,) = questions.meterOf(feedId);
    }

    /// @dev Books 200 IMD of feed budget while nothing can be placed, lets it become the old
    /// tranche at the first fortnight boundary, makes the feeds fundable with empty meters, and
    /// stops one second after the second boundary: the old tranche's wait is over.
    function _oldTrancheAtTheSecondBoundary() internal {
        _pay(1_000e18);
        uint256 period = vm.getBlockTimestamp() / 14 days;
        vm.warp((period + 1) * 14 days + 1);
        (, uint256 released) = payroll.fundFeeds();
        assertEq(released, 0, "the first boundary only ages the budget");
        (, uint256 old,,) = payroll.feedBudget();
        assertEq(old, 200e18);

        intake.setPrice(ACTION, address(imd), COST);
        assertEq(questions.costOf(feedA), COST);
        uint256[3] memory needs = payroll.feedShortfalls();
        assertEq(needs[0] + needs[1] + needs[2], FULL, "the meters lack one runway each");

        vm.warp((period + 2) * 14 days + 1);
    }
}

/// @notice Report one, finding 1 (medium): a booking that crossed a fortnight boundary released the
/// old feed tranche to stakers before the meters were served. Fixed: a booking releases nothing.
contract AuditBudgetBoundaryTest is AuditBudgetFixture {
    /// @dev The auditors' proof. It failed on commit 5c049e0 ("the meters were not served before the
    /// old tranche was released: 0 != 16640000000000000000"): a one-wei `pay` that landed before
    /// `fundFeeds` in the first block of the fortnight sent the whole old tranche to the staker
    /// stream and left the three meters empty.
    function test_report1_finding1_aOneWeiBookingAtTheBoundaryDoesNotStarveTheMeters() public {
        _oldTrancheAtTheSecondBoundary();

        _pay(1);
        (uint256 funded,) = payroll.fundFeeds();

        assertEq(funded, FULL, "the meters were not served before the old tranche was released");
        assertEq(_meter(feedA), RUNWAY);
        assertEq(_meter(feedB), RUNWAY);
        assertEq(_meter(feedC), RUNWAY_C);
        assertLe(payroll.ledger().feedsReleased, 200e18 - FULL, "budget the meters needed was released to stakers");
    }

    /// @dev The same through `book`, the other way a booking is made, and with the amounts spelled
    /// out: nothing moves at the booking, the meters get their runways, the rest goes to stakers.
    function test_report1_finding1_aBookingAtTheBoundaryReleasesNothing() public {
        _oldTrancheAtTheSecondBoundary();

        vm.prank(payer);
        imd.transfer(address(payroll), 1);
        assertEq(payroll.book(), 1);
        assertEq(payroll.ledger().feedsReleased, 0, "a booking released feed budget");
        assertEq(payroll.feedBudgetDue(), 200e18, "the old tranche has fallen due and waits for fundFeeds");
        (uint256 total, uint256 old, uint256 releasableNow,) = payroll.feedBudget();
        assertEq(total, 200e18);
        assertEq(old, 0);
        assertEq(releasableNow, 200e18);

        (uint256 funded, uint256 released) = payroll.fundFeeds();
        assertEq(funded, FULL);
        assertEq(released, 200e18 - FULL);
        assertEq(payroll.ledger().feedsReleased, 200e18 - FULL);
        assertEq(payroll.feedBudgetDue(), 0);
    }
}

/// @notice Report one, finding 2, and report two, finding 2 (both low): Payroll sized a meter's
/// shortfall from the pooled meter balance, so IMD somebody else parked there made `fundFeeds`
/// place nothing. Fixed: the shortfall is sized from Payroll's own position on the meter.
contract AuditBudgetParkTest is AuditBudgetFixture {
    /// @dev Report one's proof. It failed on commit 5c049e0 ("Payroll placed nothing because it
    /// counted the stranger's IMD: 0 != 16640000000000000000"): Payroll released all 200 IMD and
    /// the stranger took its whole float back in the next transaction.
    function test_report1_finding2_parkedIMDDoesNotTurnTheOldTrancheIntoStakerStream() public {
        _oldTrancheAtTheSecondBoundary();

        // The stranger parks one runway on each meter in the transaction before fundFeeds.
        vm.startPrank(stranger);
        questions.fund(feedA, RUNWAY);
        questions.fund(feedB, RUNWAY);
        questions.fund(feedC, RUNWAY_C);
        vm.stopPrank();

        (uint256 funded, uint256 released) = payroll.fundFeeds();

        // And takes it all back in the transaction after.
        vm.startPrank(stranger);
        questions.defund(feedA, type(uint256).max);
        questions.defund(feedB, type(uint256).max);
        questions.defund(feedC, type(uint256).max);
        vm.stopPrank();
        assertEq(imd.balanceOf(stranger), 100e18, "the stranger's float came back whole");

        assertEq(funded, FULL, "Payroll placed nothing because it counted the stranger's IMD");
        assertLe(released, 200e18 - FULL, "budget the meters needed went to stakers");
        assertEq(questions.redeemable(feedA, address(payroll)), RUNWAY, "feed A has no runway of Payroll's own");
        assertEq(_meter(feedA) + _meter(feedB) + _meter(feedC), FULL, "the meters are empty after the defund");
    }

    /// @dev Report two's reproduction: fund, `fundFeeds` and defund in one transaction, then once a
    /// day for 29 days. On commit 5c049e0 every call placed nothing, the meters never received a
    /// wei and the whole 40 IMD of budget aged away to the staker stream. Now the first call places
    /// the three runways, and only what the meters left is released when its wait is over.
    function test_report2_finding2_aFundAndDefundAroundFundFeedsChangesNothing() public {
        intake.setPrice(ACTION, address(imd), COST);
        _pay(200e18); // a feed budget of 40 IMD; the three meters are empty
        Sandwich sandwich = new Sandwich();
        vm.prank(stranger);
        imd.transfer(address(sandwich), 100e18);
        bytes32[3] memory feeds = [feedA, feedB, feedC];
        uint256[3] memory amounts = [RUNWAY, RUNWAY, RUNWAY_C];

        (uint256 funded, uint256 released) = sandwich.run(questions, payroll, feeds, amounts);
        assertEq(funded, FULL, "fundFeeds placed nothing inside the sandwich");
        assertEq(released, 0);
        assertEq(imd.balanceOf(address(sandwich)), 100e18, "the stranger's IMD is intact");
        assertEq(_meter(feedA), RUNWAY);
        assertEq(_meter(feedB), RUNWAY);
        assertEq(_meter(feedC), RUNWAY_C);

        uint256 releasedInAll;
        for (uint256 day; day < 29; ++day) {
            vm.warp(vm.getBlockTimestamp() + 1 days);
            (funded, released) = sandwich.run(questions, payroll, feeds, amounts);
            assertEq(funded, 0, "the meters are at Payroll's runway and nothing was spent");
            releasedInAll += released;
        }
        assertEq(releasedInAll, 40e18 - FULL, "only what the meters did not need went to stakers");
        assertEq(_meter(feedA) + _meter(feedB) + _meter(feedC), FULL, "the meters kept their runways");
        assertEq(questions.redeemable(feedA, address(payroll)), RUNWAY);
        assertEq(imd.balanceOf(address(sandwich)), 100e18);
        (,,, uint256 feeds_,) = payroll.owed();
        assertEq(feeds_, 0);
    }
}

/// @notice Report one, finding 3, and report two, finding 3 (both low): a booking delays money that
/// was already vesting, which the contract notice, the `drip` NatSpec and docs/THREATS.md P3 denied.
/// The rule is the brief's decision 2 and is unchanged; the statements were corrected. These tests
/// pin what the rule does, with the auditors' own figures, and the limits that do hold.
/// Also report one, finding 4, and report two, finding 4 (both info): `stream().dueNow`.
contract AuditStreamTest is Test {
    ProofIMD internal imd;
    ProofVault internal simd;
    Payroll internal payroll;
    address internal payer = makeAddr("payer");
    address internal staker = makeAddr("staker");

    function setUp() public {
        vm.warp(1_791_600_000);
        vm.roll(26_000_000);
        imd = new ProofIMD();
        simd = new ProofVault(IERC20(address(imd)));
        payroll = _payroll(address(simd));
    }

    function _payroll(address vault) internal returns (Payroll p) {
        Nothing n = new Nothing();
        p = new Payroll(
            address(imd), vault, address(n), 2000, address(n), address(n), bytes32("a"), bytes32("b"), bytes32("c")
        );
        imd.mint(payer, 1e30);
        vm.prank(payer);
        imd.approve(address(p), type(uint256).max);
    }

    function _stake() internal {
        imd.mint(staker, 1e18);
        vm.startPrank(staker);
        imd.approve(address(simd), type(uint256).max);
        simd.deposit(1e18, staker);
        vm.stopPrank();
    }

    function _pay(uint256 amount) internal {
        vm.prank(payer);
        payroll.pay(amount, bytes32("x"));
    }

    function _unvested() internal view returns (uint256 unvested) {
        (, unvested,,,,) = payroll.stream();
    }

    function _endsAt() internal view returns (uint256 endsAt) {
        (,, endsAt,,,) = payroll.stream();
    }

    /// @dev Report one's proof, with its measured figures asserted instead of the property the
    /// documents used to claim. 100 IMD stream; after 167 hourly drips 0.595 IMD is left with one
    /// hour to go; a booking then adds 10 IMD. By the old end only 0.067 IMD has vested where the
    /// old stream alone owed 0.595, and the end has moved back by 567,424 seconds. The ceiling
    /// holds: seven days after the booking everything has vested, and all of it reaches sIMD.
    function test_report1_finding3_aBookingDelaysMoneyAlreadyVestingUpToSevenDays() public {
        _stake();
        _pay(200e18);
        assertEq(_unvested(), 100e18);
        for (uint256 i = 0; i < 167; ++i) {
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            payroll.drip();
        }
        uint256 oldRemaining = _unvested();
        uint256 oldEnd = _endsAt();
        assertEq(oldRemaining, 595_238_095_238_095_239);
        assertEq(oldEnd - vm.getBlockTimestamp(), 1 hours);

        uint256 bookedAt = vm.getBlockTimestamp();
        _pay(20e18);
        uint256 unvestedAtBooking = _unvested();
        assertEq(unvestedAtBooking, oldRemaining + 10e18);
        assertEq(_endsAt() - oldEnd, 567_424, "the end moved back by 6 days 13 hours 37 minutes");
        assertLe(_endsAt(), bookedAt + 7 days, "the end is more than seven days after the booking");

        vm.warp(oldEnd);
        uint256 vestedByTheOldEnd = unvestedAtBooking - _unvested();
        assertEq(vestedByTheOldEnd, 66_797_292_483_078_019);
        assertLt(vestedByTheOldEnd, oldRemaining, "this booking no longer delays the old money: update the documents");

        vm.warp(bookedAt + 7 days);
        assertEq(_unvested(), 0, "money was still vesting seven days after the booking");
        for (uint256 i = 0; i < 400 && payroll.ledger().dripped != payroll.ledger().toStakers; ++i) {
            payroll.drip();
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
        }
        assertEq(payroll.ledger().dripped, 110e18, "stakers were not paid in full");
    }

    /// @dev Report two's proof, the same way. A booking equal to the remainder, one hour before the
    /// end: 0.014 IMD of the 0.595 that was due has vested by the old end, and the end is 300,600
    /// seconds (three and a half days) later.
    function test_report2_finding3_aBookingEqualToTheRemainderOneHourBeforeTheEnd() public {
        _pay(200e18);
        uint256 end0 = _endsAt();
        vm.warp(end0 - 1 hours);
        uint256 remaining = _unvested();
        assertEq(remaining, 595_238_095_238_095_239);

        _pay(remaining * 2);
        uint256 unvestedAfterBooking = _unvested();
        assertEq(_endsAt() - end0, 300_600);

        vm.warp(end0);
        uint256 vestedSinceBooking = unvestedAfterBooking - _unvested();
        assertEq(vestedSinceBooking, 14_088_475_626_937_165);
        assertLt(vestedSinceBooking, remaining);
    }

    /// @dev When a booking slows the old money, as the documents now state it: the joined stream
    /// vests more slowly than the old one when
    /// timeLeft × (2 × remaining + amount) < 7 days × remaining, unless the booking is too small to
    /// move the end at all. So no booking of any size slows a stream that has half its seven days
    /// or more still to run.
    function testFuzz_report2_finding3_theRuleForWhenABookingSlowsTheOldMoney(uint256 wait, uint256 amount) public {
        wait = bound(wait, 1, 7 days - 1_000);
        amount = bound(amount, 1e12, 1_000_000e18);
        _pay(200e18);
        vm.warp(vm.getBlockTimestamp() + wait);
        uint256 remaining = _unvested();
        uint256 oldEnd = _endsAt();
        uint256 timeLeft = oldEnd - vm.getBlockTimestamp();

        uint256 bookedAt = vm.getBlockTimestamp();
        _pay(amount);
        uint256 added = amount - (amount * 3_000) / 10_000 - (amount * 2_000) / 10_000;
        uint256 unvestedAtBooking = _unvested();
        assertEq(unvestedAtBooking, remaining + added);
        uint256 newEnd = _endsAt();
        assertGe(newEnd, oldEnd, "the old money was rushed");
        assertLe(newEnd, bookedAt + 7 days, "the end is more than seven days after the booking");

        vm.warp(oldEnd);
        uint256 vestedByTheOldEnd = unvestedAtBooking - _unvested();
        uint256 left = timeLeft * (2 * remaining + added);
        uint256 right = 7 days * remaining;
        if (left >= right) {
            assertGe(vestedByTheOldEnd, remaining, "the rule says this booking does not slow the old money");
        } else if (left + (remaining * (remaining + added)) / added + 1 < right) {
            // The second term is what the end time's rounding down to the second can hide: a booking
            // too small to move the end by a second slows nothing.
            assertGt(newEnd, oldEnd);
            assertLt(vestedByTheOldEnd, remaining, "the rule says this booking slows the old money");
        }
        if (2 * timeLeft >= 7 days) assertGe(vestedByTheOldEnd, remaining, "slowed with half the stream to run");

        vm.warp(bookedAt + 7 days);
        assertEq(_unvested(), 0, "money was still vesting seven days after the booking");
    }

    /// @dev Report two's dust case. "One wei moves the end by nothing" holds while at least 604,800
    /// wei are still unvested; against a remainder that is itself dust it does not. Here one wei is
    /// left with 100 seconds to go, one more wei is booked, and the end moves by three and a half
    /// days. What is delayed is one wei.
    function test_report2_finding3_dustAgainstARemainderThatIsDustMovesTheEnd() public {
        _pay(2_000); // 1,000 wei for the stream
        uint256 end0 = _endsAt();
        vm.warp(end0 - 100);
        assertEq(_unvested(), 1);
        _pay(1);
        assertEq(_unvested(), 2);
        assertEq(_endsAt() - end0, 302_350);

        // And with 604,800 wei or more unvested, one wei moves nothing, at any moment of the stream.
        Payroll p = _payroll(address(simd));
        vm.startPrank(payer);
        p.pay(2 * 604_800 * 604_800, bytes32("x")); // one wei a second for seven days, squared
        (,, uint256 end1,,,) = p.stream();
        uint256[4] memory waits = [uint256(1), 3 days, 3 days + 12 hours, 12 hours - 2];
        for (uint256 i; i < waits.length; ++i) {
            vm.warp(vm.getBlockTimestamp() + waits[i]);
            (, uint256 unvested,,,,) = p.stream();
            assertGe(unvested, 604_800);
            p.pay(1, bytes32("x"));
            (,, uint256 endsAt,,,) = p.stream();
            assertEq(endsAt, end1, "one wei moved the end of a stream with 604,800 wei or more unvested");
        }
        vm.stopPrank();
    }

    /// @dev Report one's proof for finding 4, with the assertion turned round. On commit 5c049e0 the
    /// view reported 595,238,095,238,095,238 wei due while `drip` reverted.
    function test_report1_finding4_dueNowIsZeroWhileTheVaultHasNoStakers() public {
        _pay(200e18);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        (uint256 outstanding, uint256 unvested,,,, uint256 dueNow) = payroll.stream();
        assertEq(outstanding - unvested, 595_238_095_238_095_238, "one hour of the stream has vested");
        assertEq(dueNow, 0, "the view reports an amount that drip refuses to send");
        vm.expectRevert(Payroll.StakingVaultNotReady.selector);
        payroll.drip();

        // With a staker the same amount is due and is sent.
        _stake();
        (,,,,, dueNow) = payroll.stream();
        assertEq(dueNow, 595_238_095_238_095_238);
        assertEq(payroll.drip(), dueNow);
    }

    /// @dev Report two's reproduction: sIMD is an address with no code.
    function test_report2_finding4_dueNowIsZeroWhileTheVaultHasNoCode() public {
        Payroll p = _payroll(address(0x51));
        vm.prank(payer);
        p.pay(200e18, bytes32("x"));
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        (uint256 outstanding, uint256 unvested,,,, uint256 dueNow) = p.stream();
        assertGt(outstanding - unvested, 0, "two hours of the stream have vested");
        assertEq(dueNow, 0, "the view reports an amount that drip refuses to send");
        vm.expectRevert(Payroll.StakingVaultNotReady.selector);
        p.drip();
    }
}
