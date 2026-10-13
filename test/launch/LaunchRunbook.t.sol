// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IQuestions} from "../../src/interfaces/IQuestions.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {OracleAttestation} from "../../src/questions/OracleAttestation.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {JobsReport} from "../../src/payroll/JobsReport.sol";
import {Payroll} from "../../src/payroll/Payroll.sol";
import {MockIMD} from "../questions/mocks/MockIMD.sol";
import {MockIntake} from "../questions/mocks/MockIntake.sol";
import {QuestionsHarness} from "../questions/mocks/QuestionsHarness.sol";
import {LaunchKit} from "./LaunchKit.sol";

/// @title The first-day runbook, checked against the code
/// @notice The launch pipeline creates the three contracts and calls nothing afterwards. The three
/// house feeds are created by three ordinary transactions that anyone may send. `docs/LAUNCH.md`
/// carries the exact calldata of each. These tests hold the document against the code:
///
/// - the calldata printed in the document is what the fixtures and the contract's ABI give;
/// - sent by any address to a fresh `Questions`, it creates exactly the three feeds whose ids the
///   manifest hands to `JobsReport` and `Payroll`;
/// - the day the runbook describes after that (fund the meters, ask, be answered, print) goes
///   through in the order written, with the employers feed left out altogether;
/// - the body the document tells an operator to assemble with shell tools before launch is, byte
///   for byte, the body the contract will send for the same window.
///
/// Nothing here sends a transaction or reads a key. `test_runbook_printsTheCalldata` prints the
/// three calldata blobs, so the document can be regenerated after a change to a feed:
/// `forge test --match-test test_runbook_printsTheCalldata -vv`.
contract LaunchRunbookTest is LaunchKit {
    uint256 internal constant PRICE = 0.5e18;
    uint256 internal constant HOUSE_TIP = 0.05e18;

    function setUp() public {
        // The house feeds are about Ethereum mainnet and can only be created there.
        vm.chainId(1);
        vm.roll(26_300_000);
        vm.warp(1_791_800_000);
    }

    function _createFeedCalldata(HouseFeed memory h) internal pure returns (bytes memory) {
        return abi.encodeCall(Questions.createFeed, (h.params, h.qPrefix, h.tail));
    }

    /// @dev The calldata the document carries for one feed.
    function _documented(string memory name) internal view returns (bytes memory) {
        return vm.parseBytes(_block(_doc(), string.concat("createFeed:", name), "text"));
    }

    // ---- the three createFeed calls -------------------------------------------------------------

    /// @notice Prints the calldata of the three `createFeed` calls. It sends nothing.
    function test_runbook_printsTheCalldata() public {
        string[3] memory names = _feedNames();
        for (uint256 i; i < 3; ++i) {
            HouseFeed memory h = _houseFeed(names[i]);
            bytes memory data = _createFeedCalldata(h);
            emit log_named_string("feed", names[i]);
            emit log_named_bytes32("feedId", _recomputedId(h));
            emit log_named_uint("calldata bytes", data.length);
            emit log_named_bytes("createFeed calldata", data);
        }
    }

    /// @notice The calldata written in the document is, byte for byte, what the fixtures give.
    function test_runbook_documentedCalldataIsWhatTheFixturesGive() public view {
        string[3] memory names = _feedNames();
        for (uint256 i; i < 3; ++i) {
            bytes memory want = _createFeedCalldata(_houseFeed(names[i]));
            assertEq(_documented(names[i]), want, string.concat("docs/LAUNCH.md, createFeed:", names[i]));
            assertEq(bytes4(want), Questions.createFeed.selector);
        }
    }

    /// @notice Sent as written, by an address that is nobody in particular, the three calls create
    /// the three feeds the manifest names. Sending one again changes nothing.
    function test_runbook_documentedCalldataCreatesTheManifestFeeds() public {
        Questions q = new Questions(Mainnet.INTAKE, Mainnet.IMD, Mainnet.ORACLE_SIGNER);
        bytes32[3] memory ids = _recomputedIds();
        string[3] memory names = _feedNames();
        address anyone = makeAddr("anyone at all");

        for (uint256 i; i < 3; ++i) {
            assertEq(q.costOf(ids[i]), 0, "a feed nobody has created costs nothing");
            vm.prank(anyone);
            (bool ok, bytes memory out) = address(q).call(_documented(names[i]));
            assertTrue(ok, string.concat("createFeed reverted for ", names[i]));
            assertEq(abi.decode(out, (bytes32)), ids[i], names[i]);
            assertEq(q.feedAt(i), ids[i]);
            assertTrue(q.feedState(ids[i]).exists);
        }
        assertEq(q.feedCount(), 3);

        // A second sender repeating a call gets the same id back and adds no feed.
        (bool again, bytes memory same) = address(q).call(_documented(names[0]));
        assertTrue(again);
        assertEq(abi.decode(same, (bytes32)), ids[0]);
        assertEq(q.feedCount(), 3);

        // What the manifest gives the other two contracts are these ids, in this order.
        (, Entry[] memory entries) = _manifest();
        for (uint256 i; i < 3; ++i) {
            assertEq(bytes32(vm.parseUint(entries[1].args[1 + i])), ids[i]);
            assertEq(bytes32(vm.parseUint(entries[2].args[6 + i])), ids[i]);
        }
    }

    // ---- the first day --------------------------------------------------------------------------

    /// @notice The runbook's first day in the order it is written, on a chain with a stand-in for
    /// the Intake and for IMD (the fork suite runs the same steps against the real ones): the
    /// three contracts are created in manifest order; anyone creates the feeds from the documented
    /// calldata; a wallet funds the two daily meters; each request is a call of its own; the
    /// report prints once the answers are in. The employers feed is left without a meter and
    /// without an answer for the whole day, and the report is complete all the same.
    function test_runbook_firstDayGoesThroughInTheOrderWritten() public {
        (address oracle, uint256 oracleKey) = makeAddrAndKey("first-day oracle signer");
        MockIMD imd = new MockIMD();
        MockIntake intake = new MockIntake(Mainnet.FEE_PAYEE, Mainnet.INTAKE_WRITER);
        intake.setPrice(Mainnet.ORACLE_ACTION, address(imd), PRICE);
        bytes32[3] memory ids = _recomputedIds();
        string[3] memory names = _feedNames();

        // Launch: three creations in manifest order, nothing called afterwards. (The harness is
        // `Questions` with one door added, used in step 3.)
        QuestionsHarness q = new QuestionsHarness(address(intake), address(imd), oracle);
        JobsReport report = new JobsReport(address(q), ids[0], ids[1], ids[2]);
        Payroll payroll = new Payroll(
            address(imd),
            Mainnet.SIMD,
            Mainnet.SEATS,
            Mainnet.SEAT_COUNT,
            Mainnet.SEAT_ADAPTER,
            address(q),
            ids[0],
            ids[1],
            ids[2]
        );

        // Before the feeds exist every part of the launch answers and nothing can be lost: a meter
        // cannot be funded, Payroll places nothing, the report prints nothing.
        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownFeed.selector, ids[0]));
        q.fund(ids[0], 1e18);
        (uint256 placed, uint256 released) = payroll.fundFeeds();
        assertEq(placed + released, 0);
        (uint256 printed, uint256 counted) = report.print();
        assertEq(printed + counted, 0);

        // Step 1: the three createFeed calls.
        for (uint256 i; i < 3; ++i) {
            (bool ok,) = address(q).call(_documented(names[i]));
            assertTrue(ok);
        }

        // Step 2: a wallet funds the two daily meters with one runway each (14 requests).
        address funder = makeAddr("first funder");
        uint256 cost = q.costOf(ids[0]);
        assertEq(cost, PRICE + HOUSE_TIP, "the price plus the house tip");
        uint256 runway = payroll.FEED_RUNWAY_REQUESTS() * cost;
        imd.mint(funder, 2 * runway);
        vm.startPrank(funder);
        imd.approve(address(q), 2 * runway);
        q.fund(ids[0], runway);
        q.fund(ids[1], runway);
        vm.stopPrank();
        // The wallet's IMD is the wallet's: it can take it out again whenever it likes, so Payroll
        // does not count it. Once Payroll has budget it puts a runway of its own on each meter.
        uint256[3] memory needs = payroll.feedShortfalls();
        assertEq(needs[0], runway, "what a wallet put on a meter is not Payroll's runway");
        assertEq(needs[1], runway);

        // Step 3: the first requests, each a transaction of its own, both daily feeds in one block.
        // The contract refuses a second request in one transaction, and a test function can run as
        // one, so the harness ends the transaction between the two: it clears the transient flag,
        // which is all the end of a real transaction does to it.
        address keeper = makeAddr("keeper");
        bytes32[2] memory intakeIds;
        for (uint256 i; i < 2; ++i) {
            (bool ready,,,,) = q.canRequest(ids[i]);
            assertTrue(ready, names[i]);
            vm.prank(keeper);
            intakeIds[i] = q.request(ids[i]);
            _endTransaction(q);
        }
        (bool employersReady, Questions.Blocker why,,,) = q.canRequest(ids[2]);
        assertFalse(employersReady);
        assertEq(uint8(why), uint8(Questions.Blocker.MeterTooLow), "the employers meter was never funded");

        // Step 4: the answers arrive through the Intake's callback.
        vm.roll(vm.getBlockNumber() + 70);
        skip(14 minutes);
        _deliver(q, intake, oracleKey, ids[0], intakeIds[0], abi.encode(uint256(53.5e18)));
        _deliver(q, intake, oracleKey, ids[1], intakeIds[1], abi.encode(uint256(107)));

        // Step 5: anyone prints. The report is complete with no employers answer at all.
        (printed, counted) = report.print();
        assertEq(printed, 1);
        assertEq(counted, 1);
        JobsReport.Print memory first = report.printAt(0);
        assertEq(first.amount, 53.5e18);
        assertEq(first.count, 107, "requested in one block, the count is for the print's own window");
        assertEq(report.summary().streak, 1);
        assertEq(q.roundCount(ids[2]), 0, "the employers feed never asked");
        assertEq(report.crownCount(), 0);

        // The keeper earned one tip per answered round and takes them out when it likes.
        (uint256 earned, uint256 pending) = q.tipsOf(keeper);
        assertEq(earned, 2 * HOUSE_TIP);
        assertEq(pending, 0);
        vm.prank(keeper);
        assertEq(q.collectTips(), 2 * HOUSE_TIP);

        // Whoever funded can take back everything the meters have not spent.
        vm.prank(funder);
        assertEq(q.defund(ids[0], type(uint256).max), runway - cost);
    }

    /// @dev Clears the one-request-per-transaction flag of `Questions` and of the stand-in Intake.
    function _endTransaction(QuestionsHarness q) internal {
        q.newTransaction();
        MockIntake(address(q.INTAKE())).newTransaction();
    }

    /// @dev The Intake's writer completing a request with an answer signed by the test oracle key.
    function _deliver(
        Questions q,
        MockIntake intake,
        uint256 oracleKey,
        bytes32 feedId,
        bytes32 intakeId,
        bytes memory answer
    ) internal {
        Questions.FeedParams memory p = q.feedParams(feedId);
        uint64 round = q.roundCount(feedId);
        OracleAttestation.Attestation memory a;
        a.requestId = bytes32(bytes16(keccak256(abi.encode("first-day oracle request", feedId, round))));
        a.chainId = p.chainId;
        a.answerType = p.answerType;
        a.answer = answer;
        (, a.questionHash, a.blockHash,) = q.roundRequest(feedId, round);
        (,, a.fromBlock, a.toBlock,) = q.roundOf(feedId, round);
        a.panelJobId = bytes32(bytes16(keccak256("first-day panel job")));
        (a.panelSize, a.quorum, a.agreed) = (p.panelSize, p.quorum, p.quorum);
        a.issuedAt = uint64(vm.getBlockTimestamp());
        a.expiresAt = a.issuedAt + p.validFor;

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, q.attestationDigest(a));
        vm.prank(Mainnet.INTAKE_WRITER);
        intake.complete(
            intakeId,
            0,
            keccak256("the attestation document"),
            "uri",
            abi.encode(intakeId, a, abi.encodePacked(r, s, v))
        );
        assertTrue(intake.lastDelivered(), "the callback did not store the answer");
        (IQuestions.RoundStatus status,,,,) = q.roundOf(feedId, round);
        assertTrue(status == IQuestions.RoundStatus.Answered);
    }

    // ---- the body an operator assembles before launch -------------------------------------------

    /// @notice Before launch the team buys one real request per feed from a wallet (see the
    /// document). The document builds each body with shell tools as
    /// `qPrefixHex ‖ "<from>,\"toBlock\":<to>}" ‖ tailHex` and each question hash as the keccak of
    /// `qPrefixHex ‖ "<from>,\"toBlock\":<to>}}"`. This shows that recipe gives the very bytes and
    /// the very hash the contract produces for the same window, for all three feeds, and that the
    /// window the document tells the operator to use is the one the contract asks first.
    function test_proof_shellRecipeGivesTheBodyTheContractSends() public {
        Questions q = new Questions(Mainnet.INTAKE, Mainnet.IMD, Mainnet.ORACLE_SIGNER);
        string[3] memory names = _feedNames();
        string memory doc = _doc();

        for (uint256 i; i < 3; ++i) {
            HouseFeed memory h = _houseFeed(names[i]);
            (bool ok,) = address(q).call(_createFeedCalldata(h));
            assertTrue(ok);

            // What the document's shell lines compute: TO = head - 12, FROM = TO - (BLOCKS - 1),
            // with BLOCKS as the document states it for this feed.
            uint256 blocks = vm.parseUint(_block(doc, string.concat("proof:blocks:", names[i]), "text"));
            uint256 to = vm.getBlockNumber() - 12;
            uint256 from = to - (blocks - 1);
            bytes memory window = bytes(string.concat(vm.toString(from), ',"toBlock":', vm.toString(to), "}"));
            bytes memory shellBody = bytes.concat(h.qPrefix, window, h.tail);
            bytes32 shellHash = keccak256(bytes.concat(h.qPrefix, window, "}"));

            (bytes memory body, bytes32 questionHash, uint64 fromBlock, uint64 toBlock) = q.nextBody(h.feedId);
            assertEq(fromBlock, from, string.concat(names[i], ": first block of the first window"));
            assertEq(toBlock, to, string.concat(names[i], ": last block of the first window"));
            assertEq(shellBody, body, string.concat(names[i], ": body"));
            assertEq(shellHash, questionHash, string.concat(names[i], ": question hash"));
            assertLe(body.length, 16_384, "the Intake refuses a longer body");
        }
    }

    /// @notice The price the document states for a proof request, and the action it buys, are the
    /// ones the feeds were written for.
    function test_proof_statedPriceAndActionAreTheFeeds() public view {
        string memory doc = _doc();
        assertEq(vm.parseUint(_block(doc, "proof:priceWei", "text")), PRICE);
        assertEq(bytes32(vm.parseUint(_block(doc, "proof:action", "text"))), Mainnet.ORACLE_ACTION);
        string[3] memory names = _feedNames();
        for (uint256 i; i < 3; ++i) {
            HouseFeed memory h = _houseFeed(names[i]);
            assertEq(h.params.action, Mainnet.ORACLE_ACTION);
            assertGe(h.params.maxPrice, PRICE, "the stated price is above the feed's cap");
        }
    }
}
