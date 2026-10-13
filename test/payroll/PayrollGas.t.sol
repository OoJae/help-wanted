// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {JobsReport} from "../../src/payroll/JobsReport.sol";
import {PayrollSetup} from "./PayrollSetup.sol";
import {QuestionsRig, Rig} from "./mocks/QuestionsRig.sol";

using Rig for QuestionsRig;

/// @dev What the gas tests start from. `setUp` runs as its own transaction and puts the contract in a
/// steady state (every slot already non-zero), so the single call each test measures pays cold-access
/// prices as it would on chain.
abstract contract PayrollGasBase is PayrollSetup {
    uint256 internal constant AGENT = 52211;
    JobsReport internal report;

    function setUp() public virtual override {
        super.setUp();
        setFeedCosts(FEED_COST);
        adapter.bind(AGENT, address(seats), 1998);

        pay(1_000e18);
        tipTo(ids(AGENT, 2, 3), 9e18);
        tipTo(new uint256[](0), 2_000e18);
        skip(2 hours);
        payroll.drip();
        payroll.claimSeat(5);
        payroll.fundFeeds();
        questions.spend(FEED_A, FEED_COST);
        skip(1 hours);
        pay(1_000e18);
        vm.prank(payer);
        imd.transfer(address(payroll), 50e18);

        report = new JobsReport(address(questions), FEED_A, FEED_B, FEED_C);
        questions.pushAnswered(FEED_A, 50e18, 25_000_001, 25_007_200);
        questions.pushAnswered(FEED_B, 100, 25_000_001, 25_007_200);
        report.print();
        questions.pushAnswered(FEED_A, 60e18, 25_007_201, 25_014_400);
        questions.pushAnswered(FEED_B, 120, 25_007_201, 25_014_400);
    }

    function measure(string memory label, uint256 gasBefore, uint256 ceiling) internal {
        uint256 used = gasBefore - gasleft();
        emit log_named_uint(label, used);
        assertLt(used, ceiling, label);
    }

    function sixteen(uint256 firstId) internal pure returns (uint256[] memory list) {
        list = new uint256[](16);
        for (uint256 i; i < 16; ++i) {
            list[i] = firstId + i;
        }
    }
}

/// @dev Gas ceilings for the calls other contracts and keepers make. The ceilings are loose: they
/// exist so that a change which makes `pay` or `tip` much dearer for a settlement is noticed.
///
/// Two of them are commitments to the hire desk (brief, section 11, decision 5). The desk forwards
/// 1,000,000 gas to each of `pay` and `tip`, and Payroll keeps a tip to 16 agents it has never seen
/// under 600,000.
contract PayrollGasTest is PayrollGasBase {
    function test_gas_pay() public {
        vm.prank(payer);
        uint256 g = gasleft();
        payroll.pay(3e18, bytes32("order 12"));
        measure("pay", g, 160_000);
    }

    function test_gas_book() public {
        uint256 g = gasleft();
        payroll.book();
        measure("book", g, 140_000);
    }

    function test_gas_tipToFourKnownAgents() public {
        uint256[] memory list = new uint256[](4);
        (list[0], list[1], list[2], list[3]) = (AGENT, 2, 3, AGENT);
        vm.prank(payer);
        uint256 g = gasleft();
        payroll.tip(list, 4e18);
        measure("tip, 4 ids already owed", g, 130_000);
    }

    /// @dev Decision 5: a tip to 16 agents never seen before stays under 600,000 gas.
    function test_gas_tipToSixteenNewAgents() public {
        uint256[] memory list = sixteen(7_000);
        vm.prank(payer);
        uint256 g = gasleft();
        payroll.tip(list, 16e18);
        measure("tip, 16 new ids", g, 600_000);
    }

    function test_gas_drip() public {
        uint256 g = gasleft();
        payroll.drip();
        measure("drip", g, 120_000);
    }

    function test_gas_claimSeat() public {
        uint256 g = gasleft();
        payroll.claimSeat(6);
        measure("claimSeat", g, 110_000);
    }

    function test_gas_claimTwentySeats() public {
        uint256[] memory list = new uint256[](20);
        for (uint256 i; i < 20; ++i) {
            list[i] = 100 + i;
        }
        uint256 g = gasleft();
        payroll.claimSeats(list);
        measure("claimSeats, 20 seats of 20 owners", g, 1_600_000);
    }

    /// @dev Reviewers' note: a full list must fit one transaction with room to spare. The limit was 256
    /// (14.4 million gas here, against the 16,777,216 one transaction may use on mainnet); it is 200.
    /// Two hundred seats of two hundred owners, none of whom holds IMD yet, is the dearest list.
    function test_gas_claimAFullListOfSeats() public {
        uint256 n = payroll.MAX_SEATS_PER_CALL();
        assertEq(n, 200);
        uint256[] memory list = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = 300 + i;
        }
        uint256 g = gasleft();
        uint256 paid = payroll.claimSeats(list);
        measure("claimSeats, 200 seats of 200 owners", g, 12_500_000);
        assertEq(paid, n * payroll.seatAccrued());
    }

    function test_gas_claimTip() public {
        uint256 g = gasleft();
        payroll.claimTip(AGENT);
        measure("claimTip", g, 130_000);
    }

    function test_gas_fundFeeds() public {
        uint256 g = gasleft();
        payroll.fundFeeds();
        measure("fundFeeds, one meter topped up", g, 260_000);
    }

    function test_gas_print() public {
        uint256 g = gasleft();
        report.print();
        measure("print, one period with its count", g, 300_000);
    }

    function test_gas_crown() public {
        address[] memory list = new address[](10);
        for (uint256 i; i < 10; ++i) {
            list[i] = address(uint160(0xE0000 + i));
        }
        bytes memory answer = abi.encode(list);
        uint64 round = questions.pushAnswered(FEED_C, uint256(keccak256(answer)), 25_000_001, 25_050_400);
        uint256 g = gasleft();
        report.crown(round, answer);
        measure("crown, list of 10", g, 230_000);
    }
}

/// @dev The dearest tip there is: 16 agents who were each tipped in an earlier 180-day period, so every
/// slot must first age its tranches and write a second storage slot. It must fit the 1,000,000 gas the
/// hire desk forwards to `tip` (decision 5).
contract PayrollAgedTipGasTest is PayrollGasBase {
    function setUp() public override {
        super.setUp();
        tipTo(sixteen(8_000), 16e18);
        skip(180 days);
        // A booking in the new period, so the measured call does not also pay for ageing the feed
        // budget: that belongs to `pay`, not to `tip`.
        pay(1e18);
    }

    function test_gas_tipToSixteenAgentsWhoseEarlierTipsMustBeAged() public {
        uint256[] memory list = sixteen(8_000);
        vm.prank(payer);
        uint256 g = gasleft();
        payroll.tip(list, 16e18 + 5);
        measure("tip, 16 ids with tips to age", g, 1_000_000);
        assertEq(payroll.tipOwed(8_000), 2e18);
    }
}

/// @dev The dearest `pay` there is: the first booking after two fortnight boundaries, which also
/// ages the whole waiting feed budget: all of it falls due. It must fit the 1,000,000 gas the hire
/// desk forwards to `pay` (decision 5). A booking releases nothing (audit job be91e8ae, finding 1);
/// the release is `fundFeeds`'s, measured in the second test.
contract PayrollAgeingPayGasTest is PayrollGasBase {
    function setUp() public override {
        super.setUp();
        skip(30 days);
    }

    function test_gas_payThatAlsoAgesTheWaitingFeedBudget() public {
        (uint256 waiting,,,) = payroll.feedBudget();
        assertGt(waiting, 0);
        vm.prank(payer);
        uint256 g = gasleft();
        payroll.pay(3e18, bytes32("order 12"));
        measure("pay, with the feed budget aged", g, 400_000);
        assertEq(payroll.ledger().feedsReleased, 0, "a booking releases nothing");
        assertEq(payroll.feedBudgetDue(), waiting, "the booking did age the budget: all that waited is due");
    }

    /// @dev The dearest `fundFeeds`: a top-up, the ageing step and the release of what is left.
    function test_gas_fundFeedsThatAlsoReleasesTheWaitingFeedBudget() public {
        (uint256 waiting,,,) = payroll.feedBudget();
        uint256 g = gasleft();
        (uint256 funded, uint256 released) = payroll.fundFeeds();
        measure("fundFeeds, one meter topped up and the waiting budget released", g, 400_000);
        assertEq(funded, FEED_COST);
        assertEq(released, waiting - funded);
    }
}

/// @dev The very first calls after launch write many storage slots for the first time. Both must fit
/// the 1,000,000 gas the hire desk forwards, and the first tip to 16 agents the 600,000 of decision 5.
contract PayrollFirstCallGasTest is PayrollSetup {
    function measure(string memory label, uint256 gasBefore, uint256 ceiling) internal {
        uint256 used = gasBefore - gasleft();
        emit log_named_uint(label, used);
        assertLt(used, ceiling, label);
    }

    function test_gas_theFirstPayEver() public {
        vm.prank(payer);
        uint256 g = gasleft();
        payroll.pay(3e18, bytes32("order 1"));
        measure("pay, the first ever", g, 400_000);
    }

    function test_gas_theFirstTipEverToSixteenAgents() public {
        uint256[] memory list = new uint256[](16);
        for (uint256 i; i < 16; ++i) {
            list[i] = 7_000 + i;
        }
        vm.prank(payer);
        uint256 g = gasleft();
        payroll.tip(list, 16e18 + 5);
        measure("tip, the first ever, 16 new ids and a remainder", g, 600_000);
    }

    function test_gas_theFirstBookEver() public {
        vm.prank(payer);
        imd.transfer(address(payroll), 3e18);
        uint256 g = gasleft();
        payroll.book();
        measure("book, the first ever", g, 400_000);
    }
}
