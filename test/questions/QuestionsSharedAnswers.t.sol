// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IQuestions} from "../../src/interfaces/IQuestions.sol";
import {OracleAttestation, OracleAttestationConsumer} from "../../src/questions/OracleAttestation.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {QuestionsFixture} from "./QuestionsFixture.sol";

/// @dev Creates, funds and asks a copy of another feed's question in one transaction, so the copy's
/// window can be made to end at the block the first feed's window ends at, whatever block this runs in.
contract TwinOpener {
    function open(
        Questions q,
        bytes32 firstFeed,
        Questions.FeedParams memory p,
        bytes memory qPrefix,
        bytes memory tail,
        uint256 amount
    ) external returns (bytes32 twin) {
        uint64 round = q.roundCount(firstFeed);
        (,, uint64 fromBlock, uint64 toBlock,) = q.roundOf(firstFeed, round);
        p.contiguous = false;
        p.cadenceBlocks = 1;
        p.maxWindowBlocks = uint32(toBlock - fromBlock + 1);
        p.lagBlocks = uint16(block.number - toBlock);
        twin = q.createFeed(p, qPrefix, tail);
        q.IMD().approve(address(q), amount);
        q.fund(twin, amount);
        q.request(twin);
    }
}

/// @title Two feeds that ask the same question about the same blocks
/// @notice Anyone may create a feed. A second feed that stores the same question prefix asks the
/// same question, and with `contiguous == false`, a chosen `maxWindowBlocks` and a chosen
/// `lagBlocks` it can be made to ask about exactly the window a first feed has pending, up to 244
/// blocks later. Both rounds then carry the same question hash, window and closing block hash, and
/// the oracle's attestation for the first feed is public as soon as it is signed, before the
/// Intake's writer has delivered it.
///
/// So the mark that says "this attestation was used" is kept per feed. With one mark for the whole
/// contract, whoever opened the second feed could hand the first feed's answer to it and leave the
/// first feed, which paid for that answer, unable to take it: its round would fail, its meter would
/// have paid for nothing, and its cadence would double. These tests hold that this cannot happen.
contract QuestionsSharedAnswersTest is QuestionsFixture {
    bytes32 internal feedId;
    bytes32 internal intakeId;

    function setUp() public override {
        super.setUp();
        feedId = _createDefault();
        _fund(alice, feedId, 10e18);
        intakeId = _request(feedId);
        // Three blocks later somebody opens a twin: the same question about the same blocks.
        vm.roll(vm.getBlockNumber() + 3);
    }

    /// @dev Opens the twin with the smallest panel a feed may ask for and no tip, and returns the
    /// Intake's id of the twin's own request.
    function _openTwin() internal returns (bytes32 twin, bytes32 twinIntakeId) {
        TwinOpener opener = new TwinOpener();
        imd.mint(address(opener), PRICE);
        Questions.FeedParams memory p = _params();
        (p.panelSize, p.quorum, p.minAgreed, p.tip) = (2, 2, 1, 0);
        q.newTransaction();
        intake.newTransaction();
        twin = opener.open(q, feedId, p, _prefix("uint256"), _tail(2, 2, 86_400), PRICE);
        twinIntakeId = q.feedState(twin).pendingRequestId;

        assertTrue(twin != feedId);
        (, bytes32 hashA, bytes32 closingA,) = q.roundRequest(feedId, 1);
        (, bytes32 hashB, bytes32 closingB,) = q.roundRequest(twin, 1);
        (,, uint64 fromA, uint64 toA,) = q.roundOf(feedId, 1);
        (,, uint64 fromB, uint64 toB,) = q.roundOf(twin, 1);
        assertEq(hashA, hashB, "the twin did not ask the same question");
        assertEq(fromA, fromB);
        assertEq(toA, toB);
        assertEq(closingA, closingB);
    }

    /// @dev The twin's own request ends without an answer, as a request does whose body the oracle
    /// refuses (an opener can see to that with one unknown key in the tail). The Intake marks it
    /// completed and calls nothing, which opens `submit` on the twin.
    function _openTwinWhoseRequestWasRefused() internal returns (bytes32 twin) {
        bytes32 twinIntakeId;
        (twin, twinIntakeId) = _openTwin();
        _completeWithoutAnswer(twinIntakeId, 1);
        assertTrue(q.canSubmit(twin));
    }

    /// @notice A feed that paid for an answer gets it when the Intake delivers it, whatever anybody
    /// did with the same attestation on another feed in the meantime.
    function test_anAnswerUsedOnATwinStillReachesTheFeedThatPaidForIt() public {
        bytes32 twin = _openTwinWhoseRequestWasRefused();

        // The oracle answers the first feed's request. The signed attestation can be read from the
        // protocol's API before the Intake's writer has put it on chain.
        skip(14 minutes);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(53.5e18)));
        bytes memory signature = _sign(a);

        // The twin's opener hands it to the twin first, which is allowed: it answers the twin's
        // question too.
        vm.prank(bob);
        q.submit(twin, a, signature);
        assertEq(uint8(_status(twin, 1)), uint8(IQuestions.RoundStatus.Answered));
        assertTrue(q.usedBy(a.requestId, twin));
        assertFalse(q.usedBy(a.requestId, feedId));
        assertTrue(q.consumed(a.requestId));

        // The Intake now delivers the answer the first feed paid for, and it is taken.
        assertTrue(_complete(intakeId, a, signature), "the feed that paid for the answer was refused it");
        (uint256 value,,, uint64 round,) = q.latest(feedId);
        assertEq(round, 1);
        assertEq(value, 53.5e18);
        assertEq(uint8(_status(feedId, 1)), uint8(IQuestions.RoundStatus.Answered));
        assertTrue(q.usedBy(a.requestId, feedId));
        assertEq(q.feedState(feedId).failStreak, 0);
        (uint256 twinValue,,,,) = q.latest(twin);
        assertEq(twinValue, value, "one attestation, one answer, on both feeds");
    }

    /// @notice The same, when the first feed's callback did not run (the Intake's owner lowered the
    /// stipend): `submit` is the way to hand the answer in, and it still works after the
    /// attestation was used on a twin.
    function test_submitStillRescuesTheFeedThatPaidAfterATwinUsedTheAnswer() public {
        bytes32 twin = _openTwinWhoseRequestWasRefused();
        skip(14 minutes);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(7)));
        bytes memory signature = _sign(a);
        vm.prank(bob);
        q.submit(twin, a, signature);

        _completeWithMissedCallback(intakeId, a, signature);
        vm.prank(alice);
        q.submit(feedId, a, signature);
        (uint256 value,,, uint64 round,) = q.latest(feedId);
        assertEq(round, 1, "the answer the feed paid for could not be handed in");
        assertEq(value, 7);
    }

    /// @notice The other order: the feed that paid is answered first, and the twin may then use the
    /// same attestation for its own round. Neither takes anything from the other.
    function test_aTwinMayUseAnAnswerAfterTheFeedThatPaidForIt() public {
        bytes32 twin = _openTwinWhoseRequestWasRefused();
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(11)));
        bytes memory signature = _sign(a);
        assertTrue(_complete(intakeId, a, signature));

        q.submit(twin, a, signature);
        (uint256 value,,, uint64 round,) = q.latest(twin);
        assertEq(round, 1);
        assertEq(value, 11);
    }

    /// @notice Once per feed, though: neither feed takes the same attestation for a second round.
    function test_anAttestationAnswersEachFeedOnce() public {
        bytes32 twin = _openTwinWhoseRequestWasRefused();
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(11)));
        bytes memory signature = _sign(a);
        assertTrue(_complete(intakeId, a, signature));
        q.submit(twin, a, signature);

        bytes memory used = abi.encodeWithSelector(OracleAttestationConsumer.AlreadyConsumed.selector, a.requestId);
        // The twin may ask every block. Its next round is refused the attestation, by callback and
        // by `submit`.
        vm.roll(vm.getBlockNumber() + 1);
        imd.mint(address(this), PRICE);
        imd.approve(address(q), PRICE);
        q.fund(twin, PRICE);
        bytes32 twinSecond = _request(twin);
        vm.expectRevert(used);
        _callback(twinSecond, a, signature);
        _completeWithoutAnswer(twinSecond, 2);
        vm.expectRevert(used);
        q.submit(twin, a, signature);

        // And so is the first feed's next round.
        vm.roll(vm.getBlockNumber() + CADENCE);
        bytes32 second = _request(feedId);
        vm.expectRevert(used);
        _callback(second, a, signature);
        _completeWithoutAnswer(second, 2);
        vm.expectRevert(used);
        q.submit(feedId, a, signature);
        assertEq(uint8(_status(feedId, 2)), uint8(IQuestions.RoundStatus.Pending));
        assertEq(uint8(_status(twin, 2)), uint8(IQuestions.RoundStatus.Pending));
    }

    /// @notice A twin whose own request is still open cannot take the answer early: `submit` waits
    /// for the Intake on every feed, so a copy cannot be answered at the first feed's expense
    /// before its own request has ended.
    function test_aTwinCannotTakeTheAnswerBeforeItsOwnRequestHasEnded() public {
        (bytes32 twin, bytes32 twinIntakeId) = _openTwin();
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(11)));
        bytes memory signature = _sign(a);
        assertFalse(q.canSubmit(twin));
        (,,, bool twinCompleted) = intake.requests(twinIntakeId);
        assertFalse(twinCompleted);
        vm.expectRevert(abi.encodeWithSelector(Questions.SubmitTooEarly.selector, vm.getBlockTimestamp() + 2 hours));
        vm.prank(bob);
        q.submit(twin, a, signature);

        assertTrue(_complete(intakeId, a, signature));
        (uint256 value,,,,) = q.latest(feedId);
        assertEq(value, 11);
        assertEq(uint8(_status(twin, 1)), uint8(IQuestions.RoundStatus.Pending));
    }

    /// @notice A twin with a larger panel than the answer came from does not get it: each feed
    /// applies its own panel floor to a shared answer.
    function test_aTwinAppliesItsOwnPanelFloorToASharedAnswer() public {
        TwinOpener opener = new TwinOpener();
        imd.mint(address(opener), PRICE);
        Questions.FeedParams memory p = _params();
        (p.panelSize, p.quorum, p.minAgreed, p.tip) = (30, 20, 20, 0);
        q.newTransaction();
        intake.newTransaction();
        bytes32 twin = opener.open(q, feedId, p, _prefix("uint256"), _tail(30, 20, 86_400), PRICE);
        _completeWithoutAnswer(q.feedState(twin).pendingRequestId, 1);

        // The first feed's answer comes from a panel of 7 with a quorum of 5.
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(11)));
        bytes memory signature = _sign(a);
        vm.expectRevert(abi.encodeWithSelector(Questions.PanelTooSmall.selector, 7, 5));
        q.submit(twin, a, signature);
        assertFalse(q.usedBy(a.requestId, twin));
        assertTrue(_complete(intakeId, a, signature));
    }
}
