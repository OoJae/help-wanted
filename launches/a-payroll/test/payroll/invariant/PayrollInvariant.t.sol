// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Payroll} from "../../../src/payroll/Payroll.sol";
import {MockIMD, MockSIMD} from "../mocks/MockTokens.sol";
import {MockSeats, MockAdapter} from "../mocks/MockSeats.sol";
import {MockIntake} from "../../questions/mocks/MockIntake.sol";
import {QuestionsRig, Rig} from "../mocks/QuestionsRig.sol";
import {PayrollHandler} from "./PayrollHandler.sol";

using Rig for QuestionsRig;

/// @dev What must hold after any sequence of calls. Seven seats and six agents keep collisions and
/// rounding frequent.
contract PayrollInvariantTest is Test {
    uint256 internal constant SEAT_COUNT = 7;
    uint256 internal constant AGENT_COUNT = 6;
    uint256 internal constant STAKED = 1_000e18;

    MockIMD internal imd;
    MockSIMD internal simd;
    MockSeats internal seats;
    MockAdapter internal adapter;
    QuestionsRig internal questions;
    Payroll internal payroll;
    PayrollHandler internal handler;
    address[4] internal owners;

    function setUp() public {
        vm.warp(1456 * 14 days + 3 days);
        vm.roll(26_000_000);

        imd = new MockIMD();
        simd = new MockSIMD(IERC20(address(imd)));
        seats = new MockSeats(SEAT_COUNT);
        adapter = new MockAdapter();
        // The real Questions, with three feeds planted under fixed ids (see `QuestionsRig`).
        questions = new QuestionsRig(
            address(new MockIntake(address(0x4E0F), address(0x3D3C))), address(imd), makeAddr("oracle signer")
        );
        bytes32[3] memory feeds = [keccak256("feed a"), keccak256("feed b"), keccak256("feed c")];
        for (uint256 i; i < 3; ++i) {
            questions.plant(feeds[i], bytes32(i + 1));
        }
        payroll = new Payroll(
            address(imd),
            address(simd),
            address(seats),
            SEAT_COUNT,
            address(adapter),
            address(questions),
            feeds[0],
            feeds[1],
            feeds[2]
        );

        // The token's fault switches act on pulls out of Payroll and nothing else.
        imd.watch(address(payroll));

        owners = [makeAddr("owner 0"), makeAddr("owner 1"), makeAddr("owner 2"), makeAddr("owner 3")];
        for (uint256 s; s < SEAT_COUNT; ++s) {
            seats.setOwner(s, owners[s % 4]);
        }
        for (uint256 i; i < 3; ++i) {
            questions.setCost(feeds[i], 0.52e18);
        }
        adapter.bind(0, address(seats), 3);
        adapter.bind(1, address(seats), 5);

        address staker = makeAddr("staker");
        imd.mint(staker, STAKED);
        vm.startPrank(staker);
        imd.approve(address(simd), STAKED);
        simd.deposit(STAKED, staker);
        vm.stopPrank();

        handler = new PayrollHandler(payroll, imd, simd, seats, adapter, questions, feeds, owners, staker);

        bytes4[] memory selectors = new bytes4[](20);
        selectors[0] = PayrollHandler.pay.selector;
        selectors[1] = PayrollHandler.transferPlainly.selector;
        selectors[2] = PayrollHandler.book.selector;
        selectors[3] = PayrollHandler.tip.selector;
        selectors[4] = PayrollHandler.drip.selector;
        selectors[5] = PayrollHandler.claimSeat.selector;
        selectors[6] = PayrollHandler.claimSeats.selector;
        selectors[7] = PayrollHandler.claimTip.selector;
        selectors[8] = PayrollHandler.sweepTip.selector;
        selectors[9] = PayrollHandler.fundFeeds.selector;
        selectors[10] = PayrollHandler.wait.selector;
        selectors[11] = PayrollHandler.moveSeat.selector;
        selectors[12] = PayrollHandler.breakSeat.selector;
        selectors[13] = PayrollHandler.bindAgent.selector;
        selectors[14] = PayrollHandler.changeQuestions.selector;
        selectors[15] = PayrollHandler.spendMeter.selector;
        selectors[16] = PayrollHandler.fundMeterAsStranger.selector;
        selectors[17] = PayrollHandler.defundMeterAsStranger.selector;
        selectors[18] = PayrollHandler.emptyVault.selector;
        selectors[19] = PayrollHandler.refillVault.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev received == toStakers + toSeats + toFeeds, and nothing is paid out beyond what was set aside.
    function invariant_theSplitAddsUp() public view {
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.received, l.toStakers + l.toSeats + l.toFeeds, "received != toStakers + toSeats + toFeeds");
        assertLe(l.dripped, l.toStakers, "dripped > toStakers");
        assertLe(l.seatClaimed, l.toSeats + l.tipsToSeats, "seat claims exceed what the pool was given");
        assertLe(l.tipsClaimed + l.tipsToSeats, l.tipsIn, "more tips left than arrived");
        assertLe(l.feedsFunded, l.toFeeds, "feeds funded beyond their budget");
        assertLe(payroll.streamUnvested(), l.toStakers - l.dripped, "more unvested than outstanding");
        (uint256 budget, uint256 old, uint256 due,) = payroll.feedBudget();
        assertLe(old + due, budget, "the old and the due tranche together are larger than the budget");
        assertLe(payroll.feedBudgetOld() + payroll.feedBudgetDue(), budget, "stored tranches larger than the budget");
    }

    /// @dev The IMD balance covers the stream remaining + the unclaimed seat pool + tips owed + the feed
    /// budget, and equals them plus whatever has not been booked yet.
    function invariant_theBalanceCoversEverythingOwed() public view {
        (uint256 stakers, uint256 seatPool, uint256 tips, uint256 feeds, uint256 total) = payroll.owed();
        uint256 balance = imd.balanceOf(address(payroll));
        assertEq(total, stakers + seatPool + tips + feeds);
        assertGe(balance, total, "the balance does not cover what is owed");
        assertEq(balance, total + payroll.unbooked(), "balance != owed + unbooked");
        assertEq(tips, handler.tipsOwed(), "tips owed != the sum over agents");
        assertEq(tips, handler.notedTips(), "tips owed != the tips that arrived and were neither paid nor swept");

        // Every wei that came in is either still here or went out through one of the four exits.
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(
            handler.moneyIn(),
            balance + l.dripped + l.seatClaimed + l.tipsClaimed + l.feedsFunded,
            "money in != balance + money out"
        );
        assertEq(imd.allowance(address(payroll), address(questions)), 0, "an allowance was left on Questions");
    }

    /// @dev Seat accounting: the pool is never overpaid and no seat is ever ahead of its equal share.
    function invariant_noSeatTakesMoreThanItsShare() public view {
        Payroll.Ledger memory l = payroll.ledger();
        uint256 accrued = payroll.seatAccrued();
        assertEq(accrued * SEAT_COUNT + payroll.seatCarry(), l.toSeats + l.tipsToSeats, "accrued + carry != given");
        assertLt(payroll.seatCarry(), SEAT_COUNT);

        uint256 paid;
        for (uint256 s; s < SEAT_COUNT; ++s) {
            uint256 seatPaid = payroll.seatPaid(s);
            assertLe(seatPaid, accrued, "a seat was paid more than accrued to it");
            assertEq(payroll.seatClaimable(s), accrued - seatPaid);
            paid += seatPaid;
        }
        assertEq(paid, l.seatClaimed, "sum of per-seat payments != seatClaimed");
        assertEq(payroll.seatClaimable(SEAT_COUNT), 0);
    }

    /// @dev Money out went where it should: stakers got exactly what was dripped, and each seat owner
    /// holds exactly the seat shares and tips the handler saw paid to them.
    function invariant_everyPayoutReachedItsPayee() public view {
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(handler.reachedStakers(), l.dripped);
        assertEq(
            imd.balanceOf(address(simd)) + handler.vaultOut(),
            STAKED + handler.vaultIn() + l.dripped,
            "sIMD holds something other than its stakes and the drips"
        );

        uint256 held;
        for (uint256 i; i < 4; ++i) {
            assertEq(
                imd.balanceOf(owners[i]), handler.expectedBalance(owners[i]), "an owner holds an unexpected amount"
            );
            held += imd.balanceOf(owners[i]);
        }
        assertEq(held, l.seatClaimed + l.tipsClaimed, "owners hold != seat claims + tip claims");
    }

    /// @dev No call did anything its own before-and-after check disagreed with.
    function invariant_noCallMisbehaved() public view {
        assertEq(handler.broken(), "");
    }
}
