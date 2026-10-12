// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {QuestionsFixture} from "./QuestionsFixture.sol";
import {MockIntake} from "./mocks/MockIntake.sol";
import {TaxedIMD} from "./mocks/MockIMD.sol";
import {QuestionsHarness} from "./mocks/QuestionsHarness.sol";

/// @notice Meters: funding, shares, taking money back, and the arithmetic that keeps a long-lived
/// meter fair and unable to overflow.
contract QuestionsMeterTest is QuestionsFixture {
    event Funded(bytes32 indexed feedId, address indexed funder, uint256 amount, uint256 shares);
    event FundedFor(
        bytes32 indexed feedId, address indexed payer, address indexed beneficiary, uint256 amount, uint256 shares
    );
    event Defunded(bytes32 indexed feedId, address indexed funder, uint256 shares, uint256 amount);
    event SharesRetired(bytes32 indexed feedId, uint32 epoch);
    event SharesRescaled(bytes32 indexed feedId, uint32 rescales);

    bytes32 internal feedId;

    function setUp() public override {
        super.setUp();
        feedId = _createDefault();
    }

    /// @dev A feed that may ask every block and pays no tip, so a test can spend a meter quickly.
    function _fastFeed() internal returns (bytes32) {
        Questions.FeedParams memory p = _params();
        p.cadenceBlocks = 1;
        p.maxWindowBlocks = 1000;
        p.tip = 0;
        return _create(p);
    }

    /// @dev One answered round on a fast feed: spends exactly the Intake price.
    function _spendOnePrice(bytes32 fast) internal {
        vm.roll(vm.getBlockNumber() + 1);
        _answer(fast, abi.encode(uint256(1)));
    }

    function _balance(bytes32 id) internal view returns (uint256 balance) {
        (balance,) = q.meterOf(id);
    }

    function _totalShares(bytes32 id) internal view returns (uint256 shares) {
        (, shares) = q.meterOf(id);
    }

    // ---- fund -----------------------------------------------------------------------------------

    function test_fund_firstFunderGetsOneSharePerWei() public {
        vm.expectEmit(address(q));
        emit Funded(feedId, alice, 3e18, 3e18);
        uint256 shares = _fund(alice, feedId, 3e18);

        assertEq(shares, 3e18);
        assertEq(q.sharesOf(feedId, alice), 3e18);
        (uint256 balance, uint256 total) = q.meterOf(feedId);
        assertEq(balance, 3e18);
        assertEq(total, 3e18);
        assertEq(q.totalMetered(), 3e18);
        assertEq(imd.balanceOf(address(q)), 3e18);
        assertEq(q.redeemable(feedId, alice), 3e18);
    }

    function test_fund_refusesZeroAndUnknownFeeds() public {
        vm.expectRevert(Questions.ZeroAmount.selector);
        vm.prank(alice);
        q.fund(feedId, 0);

        bytes32 nowhere = keccak256("nowhere");
        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownFeed.selector, nowhere));
        vm.prank(alice);
        q.fund(nowhere, 1e18);
    }

    function test_fund_revertsWithoutAllowanceOrBalance() public {
        address carol = makeAddr("carol");
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(q), 0, 1e18));
        vm.prank(carol);
        q.fund(feedId, 1e18);

        vm.prank(carol);
        imd.approve(address(q), 1e18);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, carol, 0, 1e18));
        vm.prank(carol);
        q.fund(feedId, 1e18);
    }

    /// @notice A later funder is not charged for what earlier rounds spent: shares are minted at
    /// what the meter is worth now, and each funder can take back exactly their part.
    function test_fund_afterSpending_mintsAtTheMetersCurrentWorth() public {
        bytes32 fast = _fastFeed();
        _fund(alice, fast, 2e18);
        _spendOnePrice(fast);
        assertEq(_balance(fast), 1.5e18);

        // Bob adds 1.5 IMD to a meter holding 1.5 IMD: he owns half of it.
        uint256 bobShares = _fund(bob, fast, 1.5e18);
        assertEq(bobShares, 2e18);
        assertEq(q.redeemable(fast, alice), 1.5e18);
        assertEq(q.redeemable(fast, bob), 1.5e18);

        // The next round is paid by both, half each.
        _spendOnePrice(fast);
        assertEq(q.redeemable(fast, alice), 1.25e18);
        assertEq(q.redeemable(fast, bob), 1.25e18);
    }

    /// @notice The first-funder rounding problem does not exist here: a one-wei first funder cannot
    /// make a later funder's shares round to nothing, because nothing but `fund` raises a meter.
    function test_fund_firstFunderCannotRoundALaterFunderOut() public {
        _fund(alice, feedId, 1);
        // Alice sends the contract a fortune by plain transfer, the classic way to inflate a share.
        vm.prank(alice);
        imd.transfer(address(q), 500e18);

        uint256 bobShares = _fund(bob, feedId, 1e18);
        assertEq(bobShares, 1e18);
        assertEq(q.redeemable(feedId, bob), 1e18);
        assertEq(q.redeemable(feedId, alice), 1);
        // The plain transfer belongs to no meter.
        assertEq(q.totalMetered(), 1e18 + 1);
        assertEq(imd.balanceOf(address(q)), 501e18 + 1);
    }

    function testFuzz_fund_neverCostsAFunderMoreThanAWei(uint96 first, uint96 second, uint8 spends) public {
        bytes32 fast = _fastFeed();
        uint256 a = bound(first, 1, 1000e18);
        uint256 b = bound(second, 1, 1000e18);
        _fund(alice, fast, a);
        uint256 rounds = bound(spends, 0, 5);
        for (uint256 i; i < rounds && _balance(fast) >= PRICE; ++i) {
            _spendOnePrice(fast);
        }
        uint256 aliceBefore = q.redeemable(fast, alice);
        uint256 shares = _fund(bob, fast, b);
        assertGt(shares, 0);
        assertGe(q.redeemable(fast, bob) + 1, b, "the new funder lost more than a wei");
        assertGe(q.redeemable(fast, alice), aliceBefore, "the earlier funder was diluted");
        (uint256 balance, uint256 total) = q.meterOf(fast);
        assertGe(total, balance, "a share is worth more than a wei");
        assertLe(q.redeemable(fast, alice) + q.redeemable(fast, bob), balance);
    }

    /// @notice What is credited is what arrived, so the meters never claim more than the contract holds.
    function test_fund_creditsWhatActuallyArrived() public {
        TaxedIMD taxed = new TaxedIMD();
        MockIntake taxedIntake = new MockIntake(PAY_TO, WRITER);
        QuestionsHarness taxedQ = new QuestionsHarness(address(taxedIntake), address(taxed), oracle);
        bytes32 id = taxedQ.createFeed(_params(), _prefix("uint256"), _tail(7, 5, 86_400));
        taxed.mint(alice, 10e18);
        vm.startPrank(alice);
        taxed.approve(address(taxedQ), 10e18);
        uint256 shares = taxedQ.fund(id, 10e18);
        vm.stopPrank();

        assertEq(shares, 9e18);
        (uint256 balance,) = taxedQ.meterOf(id);
        assertEq(balance, 9e18);
        assertEq(taxedQ.totalMetered(), taxed.balanceOf(address(taxedQ)));
    }

    function test_fund_refusesAMeterBeyondItsWidth() public {
        imd.mint(alice, uint256(type(uint128).max));
        _fund(alice, feedId, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                SafeCast.SafeCastOverflowedUintDowncast.selector, 128, uint256(type(uint128).max) + 1e18
            )
        );
        vm.prank(alice);
        q.fund(feedId, uint256(type(uint128).max));
    }

    // ---- fundFor --------------------------------------------------------------------------------

    /// @notice `fundFor` is `fund` with one difference: the caller pays and the shares belong to
    /// the beneficiary, who alone can take the IMD back out. It is what a contract uses to fund a
    /// meter on somebody's behalf (Zap, for a user paying with ETH) without holding the shares.
    function test_fundFor_paysFromTheCallerAndCreditsTheBeneficiary() public {
        uint256 aliceBefore = imd.balanceOf(alice);
        uint256 bobBefore = imd.balanceOf(bob);

        // `Funded` names whoever the shares belong to; `FundedFor` adds who paid.
        vm.expectEmit(address(q));
        emit Funded(feedId, bob, 3e18, 3e18);
        vm.expectEmit(address(q));
        emit FundedFor(feedId, alice, bob, 3e18, 3e18);
        vm.prank(alice);
        uint256 shares = q.fundFor(feedId, 3e18, bob);
        assertEq(shares, 3e18, "the first funder of a meter gets one share per wei");

        assertEq(imd.balanceOf(alice), aliceBefore - 3e18);
        assertEq(q.sharesOf(feedId, bob), shares);
        assertEq(q.sharesOf(feedId, alice), 0);
        (uint256 balance, uint256 totalShares) = q.meterOf(feedId);
        assertEq(balance, 3e18);
        assertEq(totalShares, shares);
        assertEq(q.totalMetered(), 3e18);
        assertEq(imd.balanceOf(address(q)), 3e18);

        // The payer holds nothing to take back; the beneficiary takes all of it.
        vm.expectRevert(Questions.NothingToDefund.selector);
        vm.prank(alice);
        q.defund(feedId, type(uint256).max);
        vm.prank(bob);
        assertEq(q.defund(feedId, type(uint256).max), 3e18);
        assertEq(imd.balanceOf(bob), bobBefore + 3e18);
    }

    /// @notice Shares bought for somebody are added to what that somebody already holds, at the
    /// meter's worth at that moment, exactly as `fund` would have added them.
    function test_fundFor_addsToAnExistingPositionAtTheMetersWorth() public {
        _fund(bob, feedId, 2e18);
        _request(feedId); // spends COST, so a share is now worth less than a wei

        (uint256 balance, uint256 totalShares) = q.meterOf(feedId);
        uint256 expected = (1e18 * totalShares) / balance;
        vm.prank(alice);
        uint256 shares = q.fundFor(feedId, 1e18, bob);
        assertEq(shares, expected);
        assertEq(q.sharesOf(feedId, bob), 2e18 + expected);
        assertEq(q.sharesOf(feedId, alice), 0);

        // The same call through `fund` mints the same number of shares for the same money.
        uint256 snapshot = vm.snapshotState();
        (balance, totalShares) = q.meterOf(feedId);
        vm.prank(alice);
        uint256 forBob = q.fundFor(feedId, 0.7e18, bob);
        vm.revertToState(snapshot);
        vm.prank(bob);
        assertEq(q.fund(feedId, 0.7e18), forBob);
    }

    /// @notice Funding for oneself through `fundFor` is plain funding: one event, not two.
    function test_fundFor_oneself_isPlainFunding() public {
        vm.recordLogs();
        vm.prank(alice);
        uint256 shares = q.fundFor(feedId, 1e18, alice);
        assertEq(q.sharesOf(feedId, alice), shares);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 fromQuestions;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(q)) continue;
            ++fromQuestions;
            assertEq(logs[i].topics[0], Funded.selector);
        }
        assertEq(fromQuestions, 1);
    }

    function test_fundFor_refusesWhatFundRefuses_andAZeroBeneficiary() public {
        // Shares minted to the zero address could never be taken back by anyone.
        vm.expectRevert(Questions.ZeroAddress.selector);
        vm.prank(alice);
        q.fundFor(feedId, 1e18, address(0));

        vm.expectRevert(Questions.ZeroAmount.selector);
        vm.prank(alice);
        q.fundFor(feedId, 0, bob);

        bytes32 nowhere = keccak256("nowhere");
        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownFeed.selector, nowhere));
        vm.prank(alice);
        q.fundFor(nowhere, 1e18, bob);

        // The IMD is the caller's: an allowance or a balance of the beneficiary is of no use.
        address carol = makeAddr("carol");
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(q), 0, 1e18));
        vm.prank(carol);
        q.fundFor(feedId, 1e18, alice);
        assertEq(q.totalMetered(), 0);
    }

    /// @notice A beneficiary whose old shares were retired when the meter was spent to nothing is
    /// counted afresh, like any funder.
    function test_fundFor_afterTheMeterWasSpentToZero() public {
        bytes32 fast = _fastFeed();
        _fund(bob, fast, PRICE);
        _spendOnePrice(fast);
        assertEq(q.sharesOf(fast, bob), PRICE);
        assertEq(q.redeemable(fast, bob), 0);

        vm.prank(alice);
        uint256 shares = q.fundFor(fast, 2e18, bob);
        assertEq(shares, 2e18);
        assertEq(q.sharesOf(fast, bob), 2e18, "retired shares were carried into the new count");
        assertEq(q.redeemable(fast, bob), 2e18);
    }

    // ---- defund ---------------------------------------------------------------------------------

    function test_defund_returnsTheSharesPartOfTheMeter() public {
        _fund(alice, feedId, 4e18);
        uint256 before = imd.balanceOf(alice);

        vm.expectEmit(address(q));
        emit Defunded(feedId, alice, 1e18, 1e18);
        vm.prank(alice);
        uint256 amount = q.defund(feedId, 1e18);

        assertEq(amount, 1e18);
        assertEq(imd.balanceOf(alice), before + 1e18);
        assertEq(q.sharesOf(feedId, alice), 3e18);
        assertEq(_balance(feedId), 3e18);
        assertEq(q.totalMetered(), 3e18);
    }

    /// @notice Asking for more than one holds takes everything one holds.
    function test_defund_moreThanHeld_takesEverything() public {
        _fund(alice, feedId, 4e18);
        _fund(bob, feedId, 1e18);
        vm.prank(alice);
        uint256 amount = q.defund(feedId, type(uint256).max);
        assertEq(amount, 4e18);
        assertEq(q.sharesOf(feedId, alice), 0);
        assertEq(q.sharesOf(feedId, bob), 1e18);
        assertEq(_balance(feedId), 1e18);
    }

    function test_defund_withNoShares_reverts() public {
        _fund(alice, feedId, 1e18);
        vm.expectRevert(Questions.NothingToDefund.selector);
        vm.prank(bob);
        q.defund(feedId, 1);
        vm.expectRevert(Questions.NothingToDefund.selector);
        vm.prank(alice);
        q.defund(feedId, 0);
        vm.expectRevert(Questions.NothingToDefund.selector);
        vm.prank(alice);
        q.defund(keccak256("nowhere"), 1);
    }

    /// @notice A funder can always take back their part of what the meter has not spent: while a
    /// round is pending, after failed rounds, whatever the feed is doing.
    function test_defund_isNeverBlockedByTheFeedsState() public {
        _fund(alice, feedId, 2e18);
        _request(feedId);
        assertEq(q.redeemable(feedId, alice), 2e18 - COST);

        vm.prank(alice);
        assertEq(q.defund(feedId, 1e18), (2e18 - COST) / 2);

        // The round fails and its tip comes back onto the meter, to the shares still there.
        skip(6 hours);
        q.abandon(feedId);
        vm.prank(alice);
        uint256 rest = q.defund(feedId, type(uint256).max);
        assertEq(rest, (2e18 - COST) - (2e18 - COST) / 2 + TIP);
        assertEq(_balance(feedId), 0);
        assertEq(q.totalMetered(), 0);
        assertEq(imd.balanceOf(address(q)), 0);
    }

    function test_defund_roundsDownAndLeavesTheDustOnTheMeter() public {
        bytes32 fast = _fastFeed();
        _fund(alice, fast, 1e18);
        _fund(bob, fast, 2e18);
        _spendOnePrice(fast);
        // 2.5 IMD left against 3e18 shares: one share is worth five sixths of a wei.
        vm.prank(alice);
        assertEq(q.defund(fast, 1), 0);
        vm.prank(alice);
        assertEq(q.defund(fast, 7), 5);
        assertEq(q.sharesOf(fast, alice), 1e18 - 8);
        assertEq(_balance(fast), 2.5e18 - 5);
        assertEq(q.totalMetered(), imd.balanceOf(address(q)));
    }

    // ---- a meter spent to nothing ---------------------------------------------------------------

    /// @notice When rounds spend a meter to exactly zero the old shares are claims on nothing. The
    /// next funder starts a fresh count and owns what they put in, all of it.
    function test_spentToZero_oldSharesAreRetired() public {
        bytes32 fast = _fastFeed();
        _fund(alice, fast, PRICE);
        _spendOnePrice(fast);
        assertEq(_balance(fast), 0);
        assertEq(_totalShares(fast), PRICE);
        assertEq(q.redeemable(fast, alice), 0);

        vm.expectEmit(address(q));
        emit SharesRetired(fast, 1);
        vm.expectEmit(address(q));
        emit Funded(fast, bob, 2e18, 2e18);
        _fund(bob, fast, 2e18);

        assertEq(q.sharesOf(fast, alice), 0);
        assertEq(q.sharesOf(fast, bob), 2e18);
        assertEq(q.redeemable(fast, bob), 2e18);
        assertEq(_totalShares(fast), 2e18);
        vm.expectRevert(Questions.NothingToDefund.selector);
        vm.prank(alice);
        q.defund(fast, type(uint256).max);

        // Alice can fund again and is counted in the new epoch like anyone else.
        _fund(alice, fast, 2e18);
        assertEq(q.sharesOf(fast, alice), 2e18);
        assertEq(q.redeemable(fast, alice), 2e18);
    }

    // ---- a meter that lives a long time ---------------------------------------------------------

    /// @dev Funds one price plus `left` wei and spends the price, so the meter is left holding
    /// `left` wei against a share count that grew by a factor of about 2^59.
    function _cycle(bytes32 fast, address who, uint256 left) internal {
        uint256 balance = _balance(fast);
        _fund(who, fast, PRICE + left - balance);
        _spendOnePrice(fast);
        assertEq(_balance(fast), left);
    }

    /// @notice Spending never burns a share, so a meter run close to empty and refilled mints ever
    /// more shares per wei. Before the count can overflow every count is divided by 2^64, and
    /// nobody's part of the meter moves by more than a wei.
    function test_rescale_keepsEveryonesPartAndNeverOverflows() public {
        bytes32 fast = _fastFeed();
        address carol = makeAddr("carol");
        imd.mint(carol, 100e18);
        vm.prank(carol);
        imd.approve(address(q), type(uint256).max);

        // Three cycles leave one wei on the meter against about 2^177 shares.
        _cycle(fast, alice, 1);
        _cycle(fast, alice, 1);
        _cycle(fast, alice, 1);
        (uint256 balance, uint256 total) = q.meterOf(fast);
        assertEq(balance, 1);
        assertGt(total >> 128, 0, "the meter is not yet past 2^128 shares per wei");
        (, uint32 rescales) = q.meterEpochs(fast);
        assertEq(rescales, 0);
        uint256 aliceShares = q.sharesOf(fast, alice);

        // The next funder triggers one rescale.
        vm.expectEmit(address(q));
        emit SharesRescaled(fast, 1);
        _fund(bob, fast, 1e18);

        (, rescales) = q.meterEpochs(fast);
        assertEq(rescales, 1);
        assertEq(q.sharesOf(fast, alice), aliceShares >> 64, "a holder's shares were not divided by 2^64");
        (balance, total) = q.meterOf(fast);
        assertEq(balance, 1e18 + 1);
        assertGe(total, q.sharesOf(fast, alice) + q.sharesOf(fast, bob));
        assertGe(total, balance);
        // Alice owned the single wei on the meter; she still does, and Bob owns what he put in.
        assertEq(q.redeemable(fast, alice), 1);
        assertGe(q.redeemable(fast, bob) + 1, 1e18);

        // A holder whose record predates the rescale can still act on it.
        vm.prank(alice);
        assertEq(q.defund(fast, type(uint256).max), 1);
        assertEq(q.sharesOf(fast, alice), 0);

        // Bob takes his IMD back, and the meter is then run close to empty forty more times by two
        // funders taking turns: nothing overflows, nothing is lost.
        vm.prank(bob);
        assertGe(q.defund(fast, type(uint256).max) + 1, 1e18);
        for (uint256 i; i < 40; ++i) {
            _cycle(fast, i % 2 == 0 ? bob : carol, 1 + (i % 3));
            (balance, total) = q.meterOf(fast);
            assertGe(total, balance);
            assertLe(q.redeemable(fast, bob) + q.redeemable(fast, carol), balance);
            assertEq(q.totalMetered(), imd.balanceOf(address(q)));
        }
        (, rescales) = q.meterEpochs(fast);
        assertGt(rescales, 20, "forty cycles of 2^59 crossed many rescales");

        // Whoever still holds shares can take the meter's last wei out.
        uint256 left = _balance(fast);
        uint256 out;
        address[2] memory holders = [bob, carol];
        for (uint256 i; i < holders.length; ++i) {
            if (q.sharesOf(fast, holders[i]) == 0) continue;
            vm.prank(holders[i]);
            out += q.defund(fast, type(uint256).max);
        }
        assertLe(out, left);
        assertGe(out + 2, left, "more than rounding dust was left behind");
    }

    /// @notice A holder who sleeps through four rescales held a claim worth less than a wei long
    /// before; their record reads as zero and cannot underflow anything.
    function test_rescale_aVeryOldStakeReadsAsZero() public {
        bytes32 fast = _fastFeed();
        _fund(alice, fast, 1);
        for (uint256 i; i < 20; ++i) {
            _cycle(fast, bob, 2);
        }
        (, uint32 rescales) = q.meterEpochs(fast);
        assertGe(rescales, 4);
        assertEq(q.sharesOf(fast, alice), 0);
        assertEq(q.redeemable(fast, alice), 0);
        vm.expectRevert(Questions.NothingToDefund.selector);
        vm.prank(alice);
        q.defund(fast, type(uint256).max);
    }
}
