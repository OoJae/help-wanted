// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Payroll} from "../../src/payroll/Payroll.sol";
import {IPayroll} from "../../src/interfaces/IPayroll.sol";
import {PayrollSetup} from "./PayrollSetup.sol";
import {ShortfallToken} from "./mocks/MockTokens.sol";

/// @dev Construction, `pay`, `book`, the 50 / 30 / 20 split and the ledger.
contract PayrollBookingTest is PayrollSetup {
    event Paid(address indexed from, bytes32 indexed memo, uint256 amount);
    event Booked(uint256 amount, uint256 toStakers, uint256 toSeats, uint256 toFeeds);
    event StreamLevelled(uint256 outstanding, uint256 unvested, uint256 endsAt, uint256 dripCap);

    // ---- constructor

    function test_constructor_storesEveryDependency() public view {
        assertEq(address(payroll.IMD()), address(imd));
        assertEq(payroll.SIMD(), address(simd));
        assertEq(payroll.SEATS(), address(seats));
        assertEq(payroll.SEAT_COUNT(), SEAT_COUNT);
        assertEq(payroll.ADAPTER(), address(adapter));
        assertEq(payroll.QUESTIONS(), address(questions));
        assertEq(payroll.FEED_A(), FEED_A);
        assertEq(payroll.FEED_B(), FEED_B);
        assertEq(payroll.FEED_C(), FEED_C);
    }

    function test_constructor_constantsMatchTheBrief() public view {
        assertEq(payroll.SEAT_BPS(), 3_000);
        assertEq(payroll.FEED_BPS(), 2_000);
        assertEq(payroll.STREAM_DURATION(), 7 days);
        assertEq(payroll.DRIP_INTERVAL(), 10 minutes);
        assertEq(payroll.DRIP_WINDOW(), 1 hours);
        assertEq(payroll.MAX_TIP_AGENTS(), 16);
        assertEq(payroll.TIP_SWEEP_DELAY(), 180 days);
        assertEq(payroll.MAX_SEATS_PER_CALL(), 200);
        assertEq(payroll.FEED_RUNWAY_REQUESTS(), 14);
        assertEq(payroll.FEED_C_RUNWAY_REQUESTS(), 4);
        assertEq(payroll.FEED_COST_CAP(), 2e18);
        assertEq(payroll.FEED_BUDGET_PERIOD(), 14 days);
        assertEq(payroll.BINDING_GAS(), 100_000);
    }

    /// @dev The launch pipeline runs constructors on an empty chain: none of the addresses has code.
    function test_constructor_deploysAgainstAddressesWithoutCode() public {
        Payroll p = new Payroll(
            address(0x1001),
            address(0x1002),
            address(0x1003),
            2000,
            address(0x1004),
            address(0x1005),
            bytes32(uint256(1)),
            bytes32(uint256(2)),
            bytes32(uint256(3))
        );
        assertEq(p.SEAT_COUNT(), 2000);
        Payroll.Ledger memory l = p.ledger();
        assertEq(l.received, 0);
    }

    function test_constructor_revertsOnAZeroAddress() public {
        address[5] memory a = [address(1), address(2), address(3), address(4), address(5)];
        for (uint256 i; i < 5; ++i) {
            address[5] memory b = a;
            b[i] = address(0);
            vm.expectRevert(Payroll.ZeroAddress.selector);
            new Payroll(b[0], b[1], b[2], 2000, b[3], b[4], FEED_A, FEED_B, FEED_C);
        }
    }

    function test_constructor_revertsOnZeroSeats() public {
        vm.expectRevert(Payroll.ZeroSeatCount.selector);
        new Payroll(address(1), address(2), address(3), 0, address(4), address(5), FEED_A, FEED_B, FEED_C);
    }

    function test_constructor_revertsOnARepeatedFeed() public {
        vm.expectRevert(Payroll.DuplicateFeed.selector);
        new Payroll(address(1), address(2), address(3), 2000, address(4), address(5), FEED_A, FEED_A, FEED_C);
        vm.expectRevert(Payroll.DuplicateFeed.selector);
        new Payroll(address(1), address(2), address(3), 2000, address(4), address(5), FEED_A, FEED_B, FEED_A);
        vm.expectRevert(Payroll.DuplicateFeed.selector);
        new Payroll(address(1), address(2), address(3), 2000, address(4), address(5), FEED_A, FEED_B, FEED_B);
    }

    // ---- pay

    function test_pay_splitsFiftyThirtyTwenty() public {
        vm.expectEmit(address(payroll));
        emit Paid(payer, bytes32("order 7"), 100e18);
        vm.expectEmit(address(payroll));
        emit StreamLevelled(50e18, 50e18, vm.getBlockTimestamp() + 7 days, uint256(50e18) / 168 + 1);
        vm.expectEmit(address(payroll));
        emit Booked(100e18, 50e18, 30e18, 20e18);

        vm.prank(payer);
        payroll.pay(100e18, bytes32("order 7"));

        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.received, 100e18);
        assertEq(l.toStakers, 50e18);
        assertEq(l.toSeats, 30e18);
        assertEq(l.toFeeds, 20e18);
        assertEq(l.dripped, 0);
        assertEq(imd.balanceOf(address(payroll)), 100e18);

        (uint256 stakers, uint256 seatPool, uint256 tips, uint256 feeds, uint256 total) = payroll.owed();
        assertEq(stakers, 50e18);
        assertEq(seatPool, 30e18);
        assertEq(tips, 0);
        assertEq(feeds, 20e18);
        assertEq(total, 100e18);
        assertEq(payroll.seatAccrued(), uint256(30e18) / SEAT_COUNT);
        assertBooksBalance();
    }

    function test_pay_roundingRemainderGoesToStakers() public {
        // 9 wei: 30% is 2.7 -> 2, 20% is 1.8 -> 1, stakers take the other 6.
        pay(9);
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.toSeats, 2);
        assertEq(l.toFeeds, 1);
        assertEq(l.toStakers, 6);
        assertEq(l.received, 9);
        assertBooksBalance();
    }

    function test_pay_oneWeiIsAllStakers() public {
        pay(1);
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.toStakers, 1);
        assertEq(l.toSeats + l.toFeeds, 0);
        assertBooksBalance();
    }

    function test_pay_zeroDoesNothingAndDoesNotRevert() public {
        vm.recordLogs();
        pay(0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(payroll.ledger().received, 0);
    }

    function test_pay_memoDoesNotChangeTheSplit() public {
        vm.prank(payer);
        payroll.pay(10e18, bytes32("grant"));
        vm.prank(payer);
        payroll.pay(10e18, bytes32(0));
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.toStakers, 10e18);
        assertEq(l.toSeats, 6e18);
        assertEq(l.toFeeds, 4e18);
    }

    function test_pay_revertsWithoutAnAllowance() public {
        address stranger = makeAddr("stranger");
        imd.mint(stranger, 5e18);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(payroll), 0, 5e18)
        );
        payroll.pay(5e18, bytes32(0));
    }

    function test_pay_revertsWithoutTheBalance() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        imd.approve(address(payroll), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, stranger, 0, 5e18));
        payroll.pay(5e18, bytes32(0));
        vm.stopPrank();
    }

    function test_pay_anyoneMayPay() public {
        address stranger = makeAddr("stranger");
        imd.mint(stranger, 5e18);
        vm.startPrank(stranger);
        imd.approve(address(payroll), 5e18);
        payroll.pay(5e18, bytes32("hello"));
        vm.stopPrank();
        assertEq(payroll.ledger().received, 5e18);
    }

    /// @dev What is booked is what arrived: a token that delivers 90% books 90%.
    function test_pay_booksWhatArrivedNotWhatWasAsked() public {
        ShortfallToken token = new ShortfallToken(1_000);
        Payroll p = new Payroll(
            address(token),
            address(simd),
            address(seats),
            SEAT_COUNT,
            address(adapter),
            address(questions),
            FEED_A,
            FEED_B,
            FEED_C
        );
        token.mint(payer, 100e18);
        vm.startPrank(payer);
        token.approve(address(p), 100e18);
        p.pay(100e18, bytes32(0));
        vm.stopPrank();

        Payroll.Ledger memory l = p.ledger();
        assertEq(l.received, 90e18);
        assertEq(token.balanceOf(address(p)), 90e18);
        (,,,, uint256 total) = p.owed();
        assertEq(total, 90e18);
    }

    // ---- book

    function test_book_splitsAPlainTransfer() public {
        vm.prank(payer);
        imd.transfer(address(payroll), 40e18);
        assertEq(payroll.unbooked(), 40e18);
        assertEq(payroll.ledger().received, 0);

        vm.expectEmit(address(payroll));
        emit Booked(40e18, 20e18, 12e18, 8e18);
        vm.prank(keeper);
        uint256 booked = payroll.book();

        assertEq(booked, 40e18);
        assertEq(payroll.unbooked(), 0);
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.received, 40e18);
        assertEq(l.toStakers, 20e18);
        assertEq(l.toSeats, 12e18);
        assertEq(l.toFeeds, 8e18);
        assertBooksBalance();
    }

    function test_book_returnsZeroWhenNothingArrived() public {
        assertEq(payroll.book(), 0);
        pay(10e18);
        vm.recordLogs();
        assertEq(payroll.book(), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(payroll.ledger().received, 10e18);
    }

    function test_book_neverCountsMoneyTwice() public {
        pay(10e18);
        vm.prank(payer);
        imd.transfer(address(payroll), 5e18);
        assertEq(payroll.book(), 5e18);
        assertEq(payroll.book(), 0);
        assertEq(payroll.ledger().received, 15e18);
        assertBooksBalance();
    }

    /// @dev Tips are owed money, not revenue: `book` must not split them.
    function test_book_doesNotBookTips() public {
        tipTo(ids(11, 12), 10e18);
        assertEq(payroll.unbooked(), 0);
        assertEq(payroll.book(), 0);
        assertEq(payroll.ledger().received, 0);
        assertEq(payroll.tipOwed(11), 5e18);
    }

    /// @dev The fallback a fee payer uses when `pay` cannot be called: transfer, and anyone books it.
    function test_book_afterAFailedPayNothingIsLost() public {
        address desk = makeAddr("desk");
        imd.mint(desk, 3e18);
        vm.startPrank(desk);
        // No allowance, so `pay` reverts; the desk falls back to a plain transfer.
        try payroll.pay(3e18, bytes32("order 1")) {
            fail();
        } catch {
            imd.transfer(address(payroll), 3e18);
        }
        vm.stopPrank();
        assertEq(payroll.book(), 3e18);
        assertEq(payroll.ledger().received, 3e18);
        assertBooksBalance();
    }

    // ---- ledger and views

    function test_ledger_startsAtZero() public view {
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(
            l.received + l.toStakers + l.toSeats + l.toFeeds + l.dripped + l.seatClaimed + l.tipsIn + l.tipsClaimed
                + l.feedsFunded + l.tipsToSeats + l.feedsReleased,
            0
        );
        (,,,, uint256 total) = payroll.owed();
        assertEq(total, 0);
        assertEq(payroll.unbooked(), 0);
    }

    function test_ledger_accumulatesOverManyBookings() public {
        uint256 sum;
        for (uint256 i = 1; i <= 25; ++i) {
            uint256 amount = i * 1e17 + i;
            pay(amount);
            sum += amount;
        }
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.received, sum);
        assertEq(l.toStakers + l.toSeats + l.toFeeds, sum);
        assertBooksBalance();
    }

    function test_implementsTheFrozenInterface() public view {
        IPayroll frozen = IPayroll(address(payroll));
        assertEq(frozen.seatClaimable(0), 0);
        assertEq(frozen.tipOwed(0), 0);
    }

    function test_unbookedIgnoresABalanceBelowWhatIsOwed() public {
        pay(10e18);
        // Cannot happen with IMD; forced here to show the view saturates instead of reverting.
        deal(address(imd), address(payroll), 1e18);
        assertEq(payroll.unbooked(), 0);
        assertEq(payroll.book(), 0);
    }

    function test_tokenUsedIsTheConstructorArgument() public view {
        assertEq(address(payroll.IMD()), address(IERC20(address(imd))));
    }
}
