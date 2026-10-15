// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {IQuestions} from "../../../src/interfaces/IQuestions.sol";
import {IIntake} from "../../../src/interfaces/external/IIntake.sol";
import {ISeats} from "../../../src/interfaces/external/ISeatAdapter.sol";
import {Mainnet} from "../../../src/interfaces/external/Mainnet.sol";
import {OracleAttestation} from "../../../src/questions/OracleAttestation.sol";
import {Questions} from "../../../src/questions/Questions.sol";
import {Payroll} from "../../../src/payroll/Payroll.sol";
import {JobsReport} from "../../../src/payroll/JobsReport.sol";
import {QuestionsHarness} from "../../questions/mocks/QuestionsHarness.sol";

/// @dev The three contracts of launch A wired together as the manifest will wire them (Questions, then
/// JobsReport and Payroll with its address and the three house feed ids), on a fork of Ethereum
/// mainnet, against the real IMD, sIMD, seat token, seat Adapter and Intake. Only the oracle's
/// signature is a test key. The house feeds are read from the Questions area's fixture files, so the
/// feed ids are the ones the launch manifest will carry. Written by a reviewer; kept as the area's
/// end-to-end check.
///
/// Run with `FOUNDRY_PROFILE=fork forge test`. Skips itself when the RPC cannot be reached.
contract LaunchAForkTest is Test {
    string internal constant FEEDS = "test/fixtures/questions/feeds/";

    IIntake internal constant INTAKE = IIntake(Mainnet.INTAKE);
    IERC20 internal constant IMD = IERC20(Mainnet.IMD);
    IERC4626 internal constant SIMD = IERC4626(Mainnet.SIMD);

    bool internal forked;
    QuestionsHarness internal q;
    Payroll internal payroll;
    JobsReport internal report;
    uint256 internal oracleKey;
    bytes32[3] internal feeds;
    uint256[3] internal tips;

    address internal payer = makeAddr("payer");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("mainnet")) returns (uint256) {
            forked = true;
        } catch {
            return;
        }
        address oracle;
        (oracle, oracleKey) = makeAddrAndKey("fork oracle signer");
        q = new QuestionsHarness(Mainnet.INTAKE, Mainnet.IMD, oracle);

        string[3] memory names = ["payrolls", "hires", "employers"];
        for (uint256 i; i < 3; ++i) {
            (Questions.FeedParams memory p, bytes memory qPrefix, bytes memory tail, bytes32 expectedId) =
                _houseFeed(names[i]);
            feeds[i] = q.createFeed(p, qPrefix, tail);
            tips[i] = p.tip;
            assertEq(feeds[i], expectedId, "house feed id");
        }

        report = new JobsReport(address(q), feeds[0], feeds[1], feeds[2]);
        payroll = new Payroll(
            Mainnet.IMD,
            Mainnet.SIMD,
            Mainnet.SEATS,
            Mainnet.SEAT_COUNT,
            Mainnet.SEAT_ADAPTER,
            address(q),
            feeds[0],
            feeds[1],
            feeds[2]
        );

        deal(Mainnet.IMD, payer, 100_000e18);
        vm.prank(payer);
        IMD.approve(address(payroll), type(uint256).max);
    }

    function _houseFeed(string memory name)
        internal
        view
        returns (Questions.FeedParams memory p, bytes memory qPrefix, bytes memory tail, bytes32 feedId)
    {
        string memory j = vm.readFile(string.concat(FEEDS, name, ".json"));
        p.action = vm.parseJsonBytes32(j, ".params.action");
        p.chainId = uint64(vm.parseJsonUint(j, ".params.chainId"));
        p.answerType = uint8(vm.parseJsonUint(j, ".params.answerType"));
        p.panelSize = uint16(vm.parseJsonUint(j, ".params.panelSize"));
        p.quorum = uint16(vm.parseJsonUint(j, ".params.quorum"));
        p.minAgreed = uint16(vm.parseJsonUint(j, ".params.minAgreed"));
        p.validFor = uint32(vm.parseJsonUint(j, ".params.validFor"));
        p.cadenceBlocks = uint32(vm.parseJsonUint(j, ".params.cadenceBlocks"));
        p.maxWindowBlocks = uint32(vm.parseJsonUint(j, ".params.maxWindowBlocks"));
        p.lagBlocks = uint16(vm.parseJsonUint(j, ".params.lagBlocks"));
        p.contiguous = vm.parseJsonBool(j, ".params.contiguous");
        p.pinHash = vm.parseJsonBool(j, ".params.pinHash");
        p.maxPrice = uint96(vm.parseJsonUint(j, ".params.maxPrice"));
        p.tip = uint96(vm.parseJsonUint(j, ".params.tip"));
        qPrefix = vm.parseJsonBytes(j, ".qPrefixHex");
        tail = vm.parseJsonBytes(j, ".tailHex");
        feedId = vm.parseJsonBytes32(j, ".feedId");
    }

    function _ask(bytes32 feedId) internal returns (bytes32 intakeId) {
        q.newTransaction();
        vm.prank(keeper);
        intakeId = q.request(feedId);
    }

    /// @dev The Intake's writer completing a request with an answer signed by the test oracle key.
    function _complete(bytes32 feedId, bytes32 intakeId, bytes memory answer) internal {
        Questions.FeedParams memory p = q.feedParams(feedId);
        uint64 round = q.roundCount(feedId);
        (, bytes32 questionHash, bytes32 blockHash,) = q.roundRequest(feedId, round);
        (,, uint64 fromBlock, uint64 toBlock,) = q.roundOf(feedId, round);
        OracleAttestation.Attestation memory a = OracleAttestation.Attestation({
            requestId: bytes32(bytes16(keccak256(abi.encode("fork oracle request", feedId, round)))),
            chainId: 1,
            questionHash: questionHash,
            answerType: p.answerType,
            answer: answer,
            figure: 0,
            fromBlock: fromBlock,
            toBlock: toBlock,
            blockHash: blockHash,
            panelJobId: bytes32(bytes16(keccak256("fork panel job"))),
            panelSize: p.panelSize,
            quorum: p.quorum,
            agreed: p.quorum,
            issuedAt: uint64(vm.getBlockTimestamp()),
            expiresAt: uint64(vm.getBlockTimestamp()) + p.validFor
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, q.attestationDigest(a));
        bytes memory args = abi.encode(intakeId, a, abi.encodePacked(r, s, v));
        vm.prank(INTAKE.writer());
        INTAKE.complete(intakeId, 0, keccak256("the attestation document"), "uri", args);
        (IQuestions.RoundStatus status,,,,) = q.roundOf(feedId, round);
        assertTrue(status == IQuestions.RoundStatus.Answered, "the live Intake's callback did not store the answer");
    }

    function _meter(bytes32 feedId) internal view returns (uint256 balance) {
        (balance,) = q.meterOf(feedId);
    }

    /// @dev Revenue reaches Payroll; its feed budget tops the real meters up to their runways at the live
    /// Intake price (14 requests for the two daily feeds, 4 for the weekly one); the meters buy real
    /// requests from the live Intake; the answers are printed and crowned; what the meters spent is
    /// replaced and no more; the staker stream reaches sIMD.
    function test_fork_launchAWorksEndToEnd() public {
        if (!forked) {
            vm.skip(true, "mainnet RPC unreachable");
            return;
        }

        vm.prank(payer);
        payroll.pay(1_000e18, bytes32("fork")); // 500 stakers, 300 seats, 200 feeds

        // ---- the feed budget against the live price
        uint256 price = INTAKE.priceOf(Mainnet.ORACLE_ACTION, Mainnet.IMD);
        assertGt(price, 0);
        uint256 expected;
        uint256[3] memory runway = [uint256(14), 14, 4];
        for (uint256 i; i < 3; ++i) {
            uint256 cost = q.costOf(feeds[i]);
            assertEq(cost, price + tips[i]);
            assertLe(cost, payroll.FEED_COST_CAP(), "the live cost is under the cap Payroll assumes");
            expected += runway[i] * cost;
        }
        (uint256 funded, uint256 released) = payroll.fundFeeds();
        assertEq(funded, expected);
        assertEq(released, 0);
        for (uint256 i; i < 3; ++i) {
            assertEq(_meter(feeds[i]), runway[i] * (price + tips[i]));
        }
        assertEq(IMD.allowance(address(payroll), address(q)), 0);
        assertEq(IMD.balanceOf(address(q)), q.totalMetered());
        emit log_named_decimal_uint("IMD placed on the three meters", funded, 18);

        // ---- the meters buy real requests: both daily feeds in the same block, then the weekly one
        bytes32 payrollsId = _ask(feeds[0]);
        bytes32 hiresId = _ask(feeds[1]);
        bytes32 employersId = _ask(feeds[2]);
        // Asking pays nothing: the three tips are set aside until each round has its answer.
        assertEq(IMD.balanceOf(keeper), 0);
        (uint256 earned, uint256 pending) = q.tipsOf(keeper);
        assertEq(earned, 0);
        assertEq(pending, tips[0] + tips[1] + tips[2]);
        assertEq(IMD.balanceOf(address(q)), q.totalMetered() + q.totalTips());
        assertEq(_meter(feeds[0]), 13 * (price + tips[0]));

        vm.roll(vm.getBlockNumber() + 70);
        skip(14 minutes);
        _complete(feeds[0], payrollsId, abi.encode(uint256(53.5e18)));
        _complete(feeds[1], hiresId, abi.encode(uint256(107)));
        // The answer bytes of a real attested address list (oracle request a4d33e90, one entry).
        string memory attested = vm.readFile("test/fixtures/payroll/attested-address-list.json");
        bytes memory list = vm.parseJsonBytes(attested, ".answer");
        _complete(feeds[2], employersId, list);

        // ---- the three answers earned the keeper its three tips
        (earned, pending) = q.tipsOf(keeper);
        assertEq(earned, tips[0] + tips[1] + tips[2]);
        assertEq(pending, 0);
        vm.prank(keeper);
        assertEq(q.collectTips(), tips[0] + tips[1] + tips[2]);
        assertEq(IMD.balanceOf(keeper), tips[0] + tips[1] + tips[2]);
        assertEq(IMD.balanceOf(address(q)), q.totalMetered());

        // ---- the Jobs Report
        (uint256 printed, uint256 counted) = report.print();
        assertEq(printed, 1);
        assertEq(counted, 1);
        JobsReport.Print memory p = report.printAt(0);
        assertEq(p.amount, 53.5e18);
        assertEq(p.count, 107);
        assertEq(p.hiresRound, 1);
        assertEq(uint256(p.toBlock) - p.fromBlock + 1, 7_000);
        assertEq(report.countAt(0).print, 1);
        assertEq(report.totalCount(), 107);
        report.crown(1, list);
        assertEq(report.crownOf(1).first, vm.parseJsonAddress(attested, ".first"));
        assertEq(report.crownOf(1).places, 1);

        // ---- Payroll replaces exactly what the three requests spent
        (funded,) = payroll.fundFeeds();
        assertEq(funded, 3 * price + tips[0] + tips[1] + tips[2]);
        Payroll.Ledger memory l = payroll.ledger();
        assertEq(l.feedsFunded, expected + funded);
        (,,,, uint256 total) = payroll.owed();
        assertEq(IMD.balanceOf(address(payroll)), total, "the balance is exactly what is owed");

        // ---- the staker stream
        skip(1 hours);
        uint256 assetsBefore = SIMD.totalAssets();
        uint256 sent = payroll.drip();
        assertGt(sent, 0);
        assertEq(SIMD.totalAssets(), assetsBefore + sent);
    }

    /// @dev What a seat claim costs against the real IMD and the real seat token: the measurement behind
    /// the 200-id limit of `claimSeats`. A full list at this rate must stay well inside the gas one
    /// transaction may use on mainnet (16,777,216).
    function test_fork_gasOfSeatClaimsAgainstTheRealContracts() public {
        if (!forked) {
            vm.skip(true, "mainnet RPC unreachable");
            return;
        }
        vm.prank(payer);
        payroll.pay(20_000e18, bytes32("fork")); // 3 IMD per seat

        uint256[] memory list = new uint256[](20);
        for (uint256 i; i < 20; ++i) {
            list[i] = 700 + i * 37;
        }
        // A seat held by a contract is skipped when somebody else claims (only that contract may claim
        // for itself), so count the seats in the list that an ordinary wallet holds today.
        uint256 held;
        for (uint256 i; i < 20; ++i) {
            if (ISeats(Mainnet.SEATS).ownerOf(list[i]).code.length == 0) ++held;
        }
        assertGt(held, 0, "at least one seat in the list is held by an ordinary wallet");
        emit log_named_uint("seats in the list held by ordinary wallets", held);

        uint256 g = gasleft();
        uint256 paid = payroll.claimSeats(list);
        uint256 used = g - gasleft();
        assertEq(paid, held * 3e18, "every seat an ordinary wallet holds is paid; the others are skipped");
        emit log_named_uint("claimSeats, 20 real seats, first touch", used);
        emit log_named_uint("per seat", used / 20);
        uint256 fullList = (used / 20) * payroll.MAX_SEATS_PER_CALL();
        emit log_named_uint("a full list of 200 at that rate", fullList);
        assertLt(fullList, 13_000_000, "a full list leaves less than a fifth of one transaction's gas spare");
        assertTrue(ISeats(Mainnet.SEATS).ownerOf(list[0]) != address(0));
    }
}
