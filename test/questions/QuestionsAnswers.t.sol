// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IQuestions} from "../../src/interfaces/IQuestions.sol";
import {OracleAttestation, OracleAttestationConsumer} from "../../src/questions/OracleAttestation.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {QuestionsFixture} from "./QuestionsFixture.sol";
import {OddIntake} from "./mocks/Oddities.sol";
import {QuestionsHarness} from "./mocks/QuestionsHarness.sol";

/// @notice The callback and `submit`: every case the protocol's oracle-consumer guide lists (wrong
/// sender, unknown or settled id, expired, tampered, replayed, a "no" answer, the 200,000 gas
/// stipend) and every check this contract adds on top.
contract QuestionsAnswersTest is QuestionsFixture {
    event RoundAnswered(
        bytes32 indexed feedId,
        uint64 indexed round,
        bytes32 indexed oracleRequestId,
        uint256 value,
        uint256 figure,
        uint16 agreed,
        bytes32 panelJobId,
        address deliveredBy
    );
    event AnswerRevealed(bytes32 indexed feedId, uint64 indexed round, bytes answer);

    bytes32 internal feedId;

    function setUp() public override {
        super.setUp();
        feedId = _createDefault();
        _fund(alice, feedId, 100e18);
    }

    /// @dev A feed of another answer type, funded, with a pending round.
    function _pendingFeed(uint8 answerType) internal returns (bytes32 id, bytes32 intakeId) {
        Questions.FeedParams memory p = _params();
        p.answerType = answerType;
        id = _create(p);
        _fund(alice, id, 10e18);
        intakeId = _request(id);
    }

    function _assertStillPending(bytes32 id, OracleAttestation.Attestation memory a) internal view {
        assertEq(uint8(_status(id, q.roundCount(id))), uint8(IQuestions.RoundStatus.Pending));
        assertTrue(q.feedState(id).pending);
        assertFalse(q.consumed(a.requestId), "a refused attestation was marked used");
        assertFalse(q.usedBy(a.requestId, id), "a refused attestation was marked used by the feed");
    }

    /// @dev Delivers through the Intake, which swallows the revert, then again directly to read it.
    function _expectRefused(bytes32 id, bytes32 intakeId, OracleAttestation.Attestation memory a, bytes memory why)
        internal
    {
        bytes memory signature = _sign(a);
        vm.expectRevert(why);
        _callback(intakeId, a, signature);
        _assertStillPending(id, a);
    }

    // ---- the happy path -------------------------------------------------------------------------

    function test_callback_storesTheAnswer() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(123_456e18)));
        a.figure = 77;
        a.agreed = 6;
        bytes memory signature = _sign(a);
        skip(14 minutes);

        vm.expectEmit(address(q));
        emit RoundAnswered(feedId, 1, a.requestId, 123_456e18, 77, 6, a.panelJobId, address(intake));
        assertTrue(_complete(intakeId, a, signature));

        (uint256 value, uint64 fromBlock, uint64 toBlock, uint64 round, uint64 updatedAt) = q.latest(feedId);
        assertEq(value, 123_456e18);
        assertEq(fromBlock, a.fromBlock);
        assertEq(toBlock, a.toBlock);
        assertEq(round, 1);
        assertEq(updatedAt, vm.getBlockTimestamp());
        (IQuestions.RoundStatus status, uint256 roundValue,,, uint64 roundUpdatedAt) = q.roundOf(feedId, 1);
        assertEq(uint8(status), uint8(IQuestions.RoundStatus.Answered));
        assertEq(roundValue, value);
        assertEq(roundUpdatedAt, updatedAt);
        assertTrue(q.consumed(a.requestId));
        assertTrue(q.usedBy(a.requestId, feedId));
        assertEq(q.feedOfRequest(intakeId), bytes32(0));
        Questions.FeedView memory v = q.feedState(feedId);
        assertFalse(v.pending);
        assertEq(v.pendingRequestId, bytes32(0));
        assertEq(v.latestRound, 1);
        assertEq(v.lastToBlock, a.toBlock);
        assertEq(v.failStreak, 0);
    }

    /// @notice A "no" is an answer: stored as zero in an answered round, never a revert.
    function test_callback_aNoIsStoredNotReverted() public {
        (bytes32 id, bytes32 intakeId) = _pendingFeed(OracleAttestation.ANSWER_BOOL);
        OracleAttestation.Attestation memory a = _attestation(id, abi.encode(false));
        assertTrue(_complete(intakeId, a, _sign(a)), "a no made the callback revert");
        (uint256 value,,, uint64 round, uint64 updatedAt) = q.latest(id);
        assertEq(value, 0);
        assertEq(round, 1);
        assertEq(updatedAt, vm.getBlockTimestamp());
        assertEq(uint8(_status(id, 1)), uint8(IQuestions.RoundStatus.Answered));

        // And a "yes" in the next round is one.
        vm.roll(vm.getBlockNumber() + CADENCE);
        _answer(id, abi.encode(true));
        (value,,, round,) = q.latest(id);
        assertEq(value, 1);
        assertEq(round, 2);
    }

    function test_callback_aZeroSumIsStoredNotReverted() public {
        _answer(feedId, abi.encode(uint256(0)));
        (uint256 value,,, uint64 round,) = q.latest(feedId);
        assertEq(value, 0);
        assertEq(round, 1);
    }

    /// @notice Every answer type becomes one word, as `IQuestions.latest` defines it.
    function test_callback_everyAnswerTypeBecomesOneWord() public {
        address who = address(0xD79248e9e0F83a30a58fE020Fdc4B6Bd74aF26ea);
        bytes32 word = keccak256("a bytes32 answer");
        address[] memory addresses = new address[](3);
        (addresses[0], addresses[1], addresses[2]) = (alice, bob, keeper);
        bytes32[] memory words = new bytes32[](2);
        (words[0], words[1]) = (word, bytes32(uint256(1)));

        bytes[6] memory answers = [
            abi.encode(true),
            abi.encode(who),
            abi.encode(word),
            abi.encode(uint256(42)),
            abi.encode(addresses),
            abi.encode(words)
        ];
        uint256[6] memory expected = [
            uint256(1),
            uint256(uint160(who)),
            uint256(word),
            42,
            uint256(keccak256(abi.encode(addresses))),
            uint256(keccak256(abi.encode(words)))
        ];
        for (uint8 t; t < 6; ++t) {
            (bytes32 id, bytes32 intakeId) = _pendingFeed(t);
            OracleAttestation.Attestation memory a = _attestation(id, answers[t]);
            assertTrue(_complete(intakeId, a, _sign(a)));
            (uint256 value,,,,) = q.latest(id);
            assertEq(value, expected[t]);
        }
    }

    /// @notice An empty list is an answer too.
    function test_callback_anEmptyListIsStored() public {
        (bytes32 id, bytes32 intakeId) = _pendingFeed(OracleAttestation.ANSWER_ADDRESS_LIST);
        bytes memory empty = abi.encode(new address[](0));
        OracleAttestation.Attestation memory a = _attestation(id, empty);
        assertTrue(_complete(intakeId, a, _sign(a)));
        (uint256 value,,, uint64 round,) = q.latest(id);
        assertEq(value, uint256(keccak256(empty)));
        assertEq(round, 1);
    }

    // ---- who may deliver, and for what ----------------------------------------------------------

    function test_callback_fromAnyoneButTheIntake_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        bytes memory signature = _sign(a);
        address[3] memory callers = [alice, WRITER, oracle];
        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(Questions.NotTheIntake.selector);
            vm.prank(callers[i]);
            q.onOracleResult(intakeId, a, signature);
        }
        _assertStillPending(feedId, a);
    }

    function test_callback_forAnUnknownId_reverts() public {
        _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        bytes memory signature = _sign(a);
        bytes32 unknown = keccak256("never asked");
        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownRequest.selector, unknown));
        _callback(unknown, a, signature);
        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownRequest.selector, bytes32(0)));
        _callback(bytes32(0), a, signature);
        _assertStillPending(feedId, a);
    }

    /// @notice A request that was answered cannot be answered again, with the same attestation or
    /// with a fresh one.
    function test_callback_forASettledId_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        bytes memory signature = _sign(a);
        OracleAttestation.Attestation memory second = _attestation(feedId, abi.encode(uint256(2)));
        bytes memory secondSignature = _sign(second);
        assertTrue(_complete(intakeId, a, signature));

        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownRequest.selector, intakeId));
        _callback(intakeId, a, signature);
        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownRequest.selector, intakeId));
        _callback(intakeId, second, secondSignature);
        (uint256 value,,,,) = q.latest(feedId);
        assertEq(value, 1);
    }

    function test_callback_afterAbandon_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        bytes memory signature = _sign(a);
        skip(abandonAfterSilence);
        q.abandon(feedId);
        // The late answer is refused by the callback, so the Intake records it as not delivered.
        assertFalse(_complete(intakeId, a, signature));
        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownRequest.selector, intakeId));
        _callback(intakeId, a, signature);
        assertEq(uint8(_status(feedId, 1)), uint8(IQuestions.RoundStatus.Failed));
        assertFalse(q.consumed(a.requestId));
    }

    // ---- the attestation itself -----------------------------------------------------------------

    function test_callback_expired_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        bytes memory signature = _sign(a);
        vm.warp(a.expiresAt);
        // The last second it is valid for.
        uint256 snapshot = vm.snapshotState();
        _callback(intakeId, a, signature);
        vm.revertToState(snapshot);

        vm.warp(uint256(a.expiresAt) + 1);
        vm.expectRevert(abi.encodeWithSelector(OracleAttestationConsumer.AttestationExpired.selector, a.expiresAt));
        _callback(intakeId, a, signature);
        assertFalse(_complete(intakeId, a, signature));
        _assertStillPending(feedId, a);
    }

    function test_callback_issuedInTheFuture_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        a.issuedAt = uint64(vm.getBlockTimestamp() + 5 minutes + 1);
        a.expiresAt = a.issuedAt + 1 days;
        _expectRefused(
            feedId,
            intakeId,
            a,
            abi.encodeWithSelector(OracleAttestationConsumer.AttestationNotYetValid.selector, a.issuedAt)
        );
        // Five minutes of clock difference are tolerated.
        a.issuedAt = uint64(vm.getBlockTimestamp() + 5 minutes);
        _callback(intakeId, a, _sign(a));
    }

    /// @notice Any field changed after signing breaks the signature.
    function test_callback_tampered_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory signed = _attestation(feedId, abi.encode(uint256(1)));
        bytes memory signature = _sign(signed);

        for (uint256 field; field < 15; ++field) {
            OracleAttestation.Attestation memory a = _copy(signed);
            if (field == 0) a.requestId = bytes32(uint256(a.requestId) + 1);
            if (field == 1) a.chainId += 1;
            if (field == 2) a.questionHash = bytes32(uint256(a.questionHash) ^ 1);
            if (field == 3) a.answerType = OracleAttestation.ANSWER_BYTES32;
            if (field == 4) a.answer = abi.encode(uint256(2));
            if (field == 5) a.figure += 1;
            if (field == 6) a.fromBlock -= 1;
            if (field == 7) a.toBlock -= 1;
            if (field == 8) a.blockHash = bytes32(uint256(a.blockHash) ^ 1);
            if (field == 9) a.panelJobId = bytes32(uint256(a.panelJobId) + 1);
            if (field == 10) a.panelSize += 1;
            if (field == 11) a.quorum += 1;
            if (field == 12) a.agreed += 1;
            if (field == 13) a.issuedAt -= 1;
            if (field == 14) a.expiresAt += 1;
            vm.expectRevert(OracleAttestationConsumer.BadSignature.selector);
            _callback(intakeId, a, signature);
        }
        assertFalse(_complete(intakeId, _tampered(signed), signature));
        _assertStillPending(feedId, signed);

        // A signature that is not one, and one cut short.
        vm.expectRevert(OracleAttestationConsumer.BadSignature.selector);
        _callback(intakeId, signed, hex"");
        bytes memory bent = bytes.concat(signature);
        bent[40] = bytes1(uint8(bent[40]) ^ 1);
        vm.expectRevert(OracleAttestationConsumer.BadSignature.selector);
        _callback(intakeId, signed, bent);

        // Untouched, it is accepted.
        _callback(intakeId, signed, signature);
    }

    function _copy(OracleAttestation.Attestation memory a)
        internal
        pure
        returns (OracleAttestation.Attestation memory)
    {
        return abi.decode(abi.encode(a), (OracleAttestation.Attestation));
    }

    function _tampered(OracleAttestation.Attestation memory a)
        internal
        pure
        returns (OracleAttestation.Attestation memory b)
    {
        b = _copy(a);
        b.answer = abi.encode(uint256(999));
    }

    function test_callback_signedByAnotherKey_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        (, uint256 otherKey) = makeAddrAndKey("not the oracle");
        bytes memory signature = _signWith(otherKey, a);
        vm.expectRevert(OracleAttestationConsumer.BadSignature.selector);
        _callback(intakeId, a, signature);
        _assertStillPending(feedId, a);
    }

    /// @notice A signature made for another consumer, or for this one on another chain, says
    /// nothing here: the domain is this contract on this chain.
    function test_callback_signedForAnotherConsumerOrChain_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        bytes memory signature = _sign(a);

        // The same contract after the chain id changed under it.
        assertEq(vm.getChainId(), 31_337);
        vm.chainId(31_338);
        vm.expectRevert(OracleAttestationConsumer.BadSignature.selector);
        _callback(intakeId, a, signature);
        vm.chainId(31_337);

        // A second Questions, same code, same signer: its digest for the same attestation differs.
        Questions twin = new Questions(address(intake), address(imd), oracle);
        assertTrue(twin.attestationDigest(a) != q.attestationDigest(a));
        _callback(intakeId, a, signature);
    }

    /// @notice An attestation answers one round of a feed. Presented for a later round of the same
    /// feed it is refused before anything else about it is looked at.
    function test_callback_replayed_reverts() public {
        Questions.FeedParams memory p = _params();
        p.contiguous = false;
        (p.cadenceBlocks, p.maxWindowBlocks) = (1, 50);
        bytes32 id = _create(p);
        _fund(alice, id, 10e18);

        bytes32 first = _request(id);
        OracleAttestation.Attestation memory a = _attestation(id, abi.encode(uint256(1)));
        bytes memory signature = _sign(a);
        assertTrue(_complete(first, a, signature));

        vm.roll(vm.getBlockNumber() + 1);
        bytes32 second = _request(id);
        vm.expectRevert(abi.encodeWithSelector(OracleAttestationConsumer.AlreadyConsumed.selector, a.requestId));
        _callback(second, a, signature);
        assertFalse(_complete(second, a, signature));
        assertEq(uint8(_status(id, 2)), uint8(IQuestions.RoundStatus.Pending));
        (uint256 value,,, uint64 round,) = q.latest(id);
        assertEq(value, 1);
        assertEq(round, 1);

        // Nor through `submit`, which is open now that the Intake has completed the second request.
        assertTrue(q.canSubmit(id));
        vm.expectRevert(abi.encodeWithSelector(OracleAttestationConsumer.AlreadyConsumed.selector, a.requestId));
        q.submit(id, a, signature);
        assertTrue(q.usedBy(a.requestId, id));
    }

    // ---- what the answer must match -------------------------------------------------------------

    function test_callback_aboutAnotherChain_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        a.chainId = 4663;
        _expectRefused(
            feedId, intakeId, a, abi.encodeWithSelector(Questions.WrongChain.selector, vm.getChainId(), 4663)
        );
    }

    /// @notice A pinned feed takes only the answer to its own question, whoever paired it.
    function test_callback_toAnotherQuestion_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        bytes32 asked = a.questionHash;
        a.questionHash = keccak256("another question");
        _expectRefused(
            feedId, intakeId, a, abi.encodeWithSelector(Questions.WrongQuestion.selector, asked, a.questionHash)
        );
    }

    /// @notice A feed that does not pin its question trusts the Intake's pairing for the question
    /// and still checks everything else.
    function test_callback_unpinnedFeed_ignoresTheQuestionHashOnly() public {
        Questions.FeedParams memory p = _params();
        p.pinHash = false;
        bytes32 id = _create(p);
        _fund(alice, id, 10e18);
        bytes32 intakeId = _request(id);

        OracleAttestation.Attestation memory a = _attestation(id, abi.encode(uint256(5)));
        a.questionHash = keccak256("a hash this contract could not have built");
        a.toBlock += 1;
        _expectRefused(id, intakeId, a, abi.encodeWithSelector(Questions.WrongWindow.selector, a.fromBlock, a.toBlock));
        a.toBlock -= 1;
        assertTrue(_complete(intakeId, a, _sign(a)));
        (uint256 value,,,,) = q.latest(id);
        assertEq(value, 5);
    }

    function test_callback_forAnotherWindow_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        a.fromBlock += 1;
        _expectRefused(
            feedId, intakeId, a, abi.encodeWithSelector(Questions.WrongWindow.selector, a.fromBlock, a.toBlock)
        );
        a.fromBlock -= 1;
        a.toBlock += 1;
        _expectRefused(
            feedId, intakeId, a, abi.encodeWithSelector(Questions.WrongWindow.selector, a.fromBlock, a.toBlock)
        );
    }

    function test_callback_ofAnotherType_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(true));
        a.answerType = OracleAttestation.ANSWER_BOOL;
        _expectRefused(
            feedId,
            intakeId,
            a,
            abi.encodeWithSelector(
                OracleAttestationConsumer.WrongAnswerType.selector,
                OracleAttestation.ANSWER_UINT256,
                OracleAttestation.ANSWER_BOOL
            )
        );
    }

    /// @notice The panel and the quorum must be at least what the feed asked for.
    function test_callback_fromASmallerPanel_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        a.panelSize = 6;
        _expectRefused(feedId, intakeId, a, abi.encodeWithSelector(Questions.PanelTooSmall.selector, 6, 5));
        a.panelSize = 7;
        (a.quorum, a.agreed) = (4, 4);
        _expectRefused(feedId, intakeId, a, abi.encodeWithSelector(Questions.PanelTooSmall.selector, 7, 4));
        // A larger panel and a higher quorum than asked are fine.
        (a.panelSize, a.quorum, a.agreed) = (30, 20, 20);
        _callback(intakeId, a, _sign(a));
    }

    /// @notice A feed created with `minAgreed == quorum` takes only what the panel itself agreed
    /// on: `agreed >= quorum`, as signed.
    function test_callback_strictFeed_needsAgreedAtLeastTheSignedQuorum() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        a.agreed = 4;
        _expectRefused(feedId, intakeId, a, abi.encodeWithSelector(Questions.NotEnoughAgreed.selector, 4, 5));

        // The quorum that counts is the attestation's, when it is higher than the feed's.
        (a.panelSize, a.quorum, a.agreed) = (9, 7, 6);
        _expectRefused(feedId, intakeId, a, abi.encodeWithSelector(Questions.NotEnoughAgreed.selector, 6, 7));

        a.agreed = 7;
        _callback(intakeId, a, _sign(a));
    }

    /// @notice A feed created with a lower `minAgreed` also takes a chain-evidence answer the
    /// oracle settled by rerunning the recipe when the members' answers split, down to its own
    /// floor and no further.
    function test_callback_lenientFeed_takesARerunSettledAnswerDownToItsFloor() public {
        Questions.FeedParams memory p = _params();
        p.minAgreed = 3;
        bytes32 id = _create(p);
        _fund(alice, id, 10e18);
        bytes32 intakeId = _request(id);

        OracleAttestation.Attestation memory a = _attestation(id, abi.encode(uint256(1)));
        a.agreed = 2;
        _expectRefused(id, intakeId, a, abi.encodeWithSelector(Questions.NotEnoughAgreed.selector, 2, 3));
        a.agreed = 3;
        assertTrue(_complete(intakeId, a, _sign(a)));
        assertEq(uint8(_status(id, 1)), uint8(IQuestions.RoundStatus.Answered));
    }

    /// @notice The closing block's hash must be the one this chain had when the round was opened:
    /// an answer computed on a branch that is not this chain's is refused.
    function test_callback_withAnotherBlockHash_reverts() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        bytes32 pinned = a.blockHash;
        assertEq(pinned, _blockhash(a.toBlock));
        a.blockHash = keccak256("a block this chain never had");
        _expectRefused(
            feedId, intakeId, a, abi.encodeWithSelector(Questions.WrongBlockHash.selector, pinned, a.blockHash)
        );

        // The pin does not depend on when the answer arrives: long after BLOCKHASH has forgotten
        // the block, the same answer with the right hash is still checked and accepted.
        a.blockHash = pinned;
        a.expiresAt += 30 days;
        vm.roll(vm.getBlockNumber() + 50_000);
        assertEq(_blockhash(a.toBlock), bytes32(0));
        _callback(intakeId, a, _sign(a));
    }

    function test_callback_malformedAnswers_revert() public {
        // A bool that is neither 0 nor 1.
        (bytes32 id, bytes32 intakeId) = _pendingFeed(OracleAttestation.ANSWER_BOOL);
        OracleAttestation.Attestation memory a = _attestation(id, abi.encode(uint256(2)));
        _expectRefused(id, intakeId, a, abi.encodeWithSelector(Questions.MalformedAnswer.selector));

        // An address with bits above the 160th.
        (id, intakeId) = _pendingFeed(OracleAttestation.ANSWER_ADDRESS);
        a = _attestation(id, abi.encode(uint256(type(uint160).max) + 1));
        _expectRefused(id, intakeId, a, abi.encodeWithSelector(Questions.MalformedAnswer.selector));
        a = _attestation(id, abi.encode(uint256(type(uint160).max)));
        _callback(intakeId, a, _sign(a));

        // A single-word type whose answer is not one word.
        bytes32 uintIntake = _request(feedId);
        a = _attestation(feedId, hex"");
        _expectRefused(feedId, uintIntake, a, abi.encodeWithSelector(Questions.MalformedAnswer.selector));
        a = _attestation(feedId, abi.encode(uint256(1), uint256(2)));
        _expectRefused(feedId, uintIntake, a, abi.encodeWithSelector(Questions.MalformedAnswer.selector));
        a = _attestation(feedId, abi.encodePacked(uint248(1)));
        _expectRefused(feedId, uintIntake, a, abi.encodeWithSelector(Questions.MalformedAnswer.selector));
    }

    // ---- the gas stipend ------------------------------------------------------------------------

    /// @notice The callback runs to the end inside the Intake's 200,000 gas, and inside much less:
    /// it still fits if the Intake's owner lowers the stipend to 140,000.
    function test_callback_fitsTheStipend_evenALoweredOne() public {
        assertEq(intake.callbackGas(), 200_000);
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        assertTrue(_complete(intakeId, a, _sign(a)));
        assertLt(intake.lastCallbackGasUsed(), 140_000);

        intake.setCallbackGas(140_000);
        vm.roll(vm.getBlockNumber() + CADENCE);
        intakeId = _request(feedId);
        a = _attestation(feedId, abi.encode(uint256(2)));
        assertTrue(_complete(intakeId, a, _sign(a)), "the callback needs more than 140,000 gas");
    }

    /// @notice The writer cannot starve the callback: the Intake refuses to try with too little gas.
    function test_callback_theIntakeRefusesToStarveIt() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        bytes memory args = abi.encode(intakeId, a, _sign(a));
        vm.prank(WRITER);
        (bool ok,) =
            address(intake).call{gas: 150_000}(abi.encodeCall(intake.complete, (intakeId, 0, bytes32(0), "", args)));
        assertFalse(ok);
        (,,, bool completed) = intake.requests(intakeId);
        assertFalse(completed);
        _assertStillPending(feedId, a);
    }

    // ---- submit ---------------------------------------------------------------------------------

    /// @dev A pinned yes/no feed whose question a panel judges, funded, with a pending round.
    function _pendingPanelFeed() internal returns (bytes32 id, bytes32 intakeId) {
        Questions.FeedParams memory p = _params();
        p.answerType = OracleAttestation.ANSWER_BOOL;
        bytes memory prefix = bytes(
            string.concat(
                '{"answerType":"bool","chainId":',
                vm.toString(vm.getChainId()),
                ',"evidence":"panel","question":"Was the delivery good enough?","v":1,"window":{"fromBlock":'
            )
        );
        id = q.createFeed(p, prefix, ',"panelSize":7,"quorum":5,"validForSeconds":86400}');
        _fund(alice, id, 10e18);
        intakeId = _request(id);
    }

    /// @notice When the callback ran out of gas the answer is not lost: anyone hands it in.
    function test_submit_deliversAnAnswerTheCallbackMissed() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(321)));
        bytes memory signature = _sign(a);
        assertFalse(q.canSubmit(feedId));
        intake.setCallbackGas(40_000);
        assertFalse(_complete(intakeId, a, signature), "the callback fitted in 40,000 gas");
        _assertStillPending(feedId, a);
        assertTrue(q.canSubmit(feedId));

        vm.expectEmit(address(q));
        emit RoundAnswered(feedId, 1, a.requestId, 321, 0, 5, a.panelJobId, bob);
        vm.prank(bob);
        q.submit(feedId, a, signature);

        (uint256 value,,, uint64 round,) = q.latest(feedId);
        assertEq(value, 321);
        assertEq(round, 1);
        assertTrue(q.consumed(a.requestId));
        assertTrue(q.usedBy(a.requestId, feedId));
        assertEq(q.feedOfRequest(intakeId), bytes32(0));
        assertFalse(q.feedState(feedId).pending);
        assertFalse(q.canSubmit(feedId));

        // Once only.
        vm.expectRevert(abi.encodeWithSelector(Questions.NoPendingRound.selector, feedId));
        q.submit(feedId, a, signature);
    }

    /// @notice The callback goes first. Until the Intake has completed the feed's own request,
    /// and for thirty minutes if it has not, nobody can hand anything in: not the answer the meter
    /// paid for, and not an answer to the same question that somebody bought for themselves and
    /// addressed to this contract.
    function test_submit_beforeTheIntakeHasCompletedTheRequest_reverts() public {
        bytes32 intakeId = _request(feedId);
        uint256 askedAt = vm.getBlockTimestamp();
        OracleAttestation.Attestation memory paidFor = _attestation(feedId, abi.encode(uint256(100)));
        OracleAttestation.Attestation memory bought = _attestation(feedId, abi.encode(uint256(999)));
        bytes memory paidForSignature = _sign(paidFor);
        bytes memory boughtSignature = _sign(bought);
        assertTrue(paidFor.requestId != bought.requestId);
        bytes memory tooEarly = abi.encodeWithSelector(Questions.SubmitTooEarly.selector, askedAt + submitAfterSilence);

        assertFalse(q.canSubmit(feedId));
        vm.expectRevert(tooEarly);
        vm.prank(bob);
        q.submit(feedId, bought, boughtSignature);
        vm.expectRevert(tooEarly);
        q.submit(feedId, paidFor, paidForSignature);
        // Still closed half way through the wait, and to its last second, for both answers.
        skip(submitAfterSilence / 2);
        assertFalse(q.canSubmit(feedId));
        skip(submitAfterSilence - submitAfterSilence / 2 - 1);
        assertEq(vm.getBlockTimestamp(), askedAt + submitAfterSilence - 1);
        assertFalse(q.canSubmit(feedId));
        vm.expectRevert(tooEarly);
        vm.prank(bob);
        q.submit(feedId, bought, boughtSignature);
        vm.expectRevert(tooEarly);
        q.submit(feedId, paidFor, paidForSignature);
        _assertStillPending(feedId, bought);

        // The answer the meter paid for is the one that is stored.
        assertTrue(_complete(intakeId, paidFor, paidForSignature));
        (uint256 value,,, uint64 round,) = q.latest(feedId);
        assertEq(round, 1);
        assertEq(value, 100);
        vm.expectRevert(abi.encodeWithSelector(Questions.NoPendingRound.selector, feedId));
        vm.prank(bob);
        q.submit(feedId, bought, boughtSignature);
    }

    /// @notice A request the Intake never completes does not leave its round to fail: thirty
    /// minutes after it was made, and not one second sooner, anyone who holds an answer to the same
    /// question about the same blocks, signed for this contract, can hand it in. The round is
    /// answered and the cadence stays as it was. What the Intake delivers afterwards, if it ever
    /// does, finds the round settled.
    function test_submit_opensThirtyMinutesAfterARequestTheIntakeNeverCompleted() public {
        bytes32 intakeId = _request(feedId);
        uint256 askedAt = vm.getBlockTimestamp();
        uint256 askedBlock = vm.getBlockNumber();
        assertEq(q.SUBMIT_AFTER_SILENCE(), 30 minutes);
        assertLt(q.SUBMIT_AFTER_SILENCE(), q.ABANDON_AFTER_SILENCE());
        // Bought from the oracle for this contract by whoever wants the round answered. The oracle
        // signs within minutes; the answer then waits for the half hour to be over.
        skip(2 minutes);
        OracleAttestation.Attestation memory bought = _attestation(feedId, abi.encode(uint256(42)));
        bytes memory signature = _sign(bought);

        // One second before the boundary: closed.
        skip(submitAfterSilence - 2 minutes - 1);
        vm.roll(askedBlock + submitAfterSilence / 12 - 1);
        assertEq(vm.getBlockTimestamp(), askedAt + submitAfterSilence - 1);
        assertFalse(q.canSubmit(feedId));
        vm.expectRevert(abi.encodeWithSelector(Questions.SubmitTooEarly.selector, askedAt + submitAfterSilence));
        vm.prank(bob);
        q.submit(feedId, bought, signature);

        // At the boundary: open, with the Intake still silent.
        skip(1);
        vm.roll(askedBlock + submitAfterSilence / 12);
        assertEq(vm.getBlockTimestamp(), askedAt + submitAfterSilence);
        (,,, bool completed) = intake.requests(intakeId);
        assertFalse(completed);
        assertTrue(q.canSubmit(feedId));
        vm.expectEmit(address(q));
        emit RoundAnswered(feedId, 1, bought.requestId, 42, 0, 5, bought.panelJobId, bob);
        vm.prank(bob);
        q.submit(feedId, bought, signature);

        (uint256 value,,, uint64 round,) = q.latest(feedId);
        assertEq(round, 1);
        assertEq(value, 42);
        Questions.FeedView memory v = q.feedState(feedId);
        assertEq(v.failStreak, 0);
        assertEq(v.nextRequestBlock, askedBlock + CADENCE);
        assertEq(q.feedOfRequest(intakeId), bytes32(0));

        // A late delivery for the same request is refused by the callback: the round is settled.
        OracleAttestation.Attestation memory late = _attestation(feedId, abi.encode(uint256(42)));
        assertFalse(_complete(intakeId, late, _sign(late)));
        (value,,, round,) = q.latest(feedId);
        assertEq(round, 1);
        assertEq(value, 42);
    }

    /// @notice A request the Intake completed without an answer (refused, or a panel that did not
    /// agree) opens `submit` too: an answer to the same question about the same blocks, signed for
    /// this contract, is taken from whoever has one.
    function test_submit_afterARequestThatEndedWithoutAnAnswer() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(55)));
        bytes memory signature = _sign(a);
        _completeWithoutAnswer(intakeId, 2);
        assertTrue(q.canSubmit(feedId));
        vm.prank(bob);
        q.submit(feedId, a, signature);
        (uint256 value,,, uint64 round,) = q.latest(feedId);
        assertEq(round, 1);
        assertEq(value, 55);
    }

    /// @notice A feed whose question a panel judges takes answers from the Intake only. Two panels
    /// can judge one question differently, and nothing on chain says which attestation answers the
    /// request the meter paid for, so `submit` would let whoever calls it choose. It stays closed
    /// before the Intake completes the request and after, even when the callback was missed.
    function test_submit_isNotForAQuestionAPanelJudges() public {
        (bytes32 id, bytes32 intakeId) = _pendingPanelFeed();
        OracleAttestation.Attestation memory paidFor = _attestation(id, abi.encode(false));
        OracleAttestation.Attestation memory bought = _attestation(id, abi.encode(true));
        bytes memory paidForSignature = _sign(paidFor);
        bytes memory boughtSignature = _sign(bought);

        vm.expectRevert(Questions.SubmitNotForPanelEvidence.selector);
        vm.prank(bob);
        q.submit(id, bought, boughtSignature);

        _completeWithMissedCallback(intakeId, paidFor, paidForSignature);
        assertFalse(q.canSubmit(id));
        vm.expectRevert(Questions.SubmitNotForPanelEvidence.selector);
        vm.prank(bob);
        q.submit(id, bought, boughtSignature);
        vm.expectRevert(Questions.SubmitNotForPanelEvidence.selector);
        q.submit(id, paidFor, paidForSignature);
        _assertStillPending(id, bought);
    }

    /// @notice The same feed is answered through the Intake like any other.
    function test_callback_answersAQuestionAPanelJudges() public {
        (bytes32 id, bytes32 intakeId) = _pendingPanelFeed();
        OracleAttestation.Attestation memory a = _attestation(id, abi.encode(false));
        assertTrue(_complete(intakeId, a, _sign(a)));
        (uint256 value,,, uint64 round,) = q.latest(id);
        assertEq(round, 1);
        assertEq(value, 0);
    }

    /// @notice What marks a question as judged by a panel is its canonical document, which then
    /// holds `"evidence":"panel"`. The same words inside the question's own text are escaped there
    /// and do not count.
    function test_submit_panelEvidenceIsReadFromTheDocumentNotTheWording() public {
        Questions.FeedParams memory p = _params();
        bytes memory prefix = bytes(
            string.concat(
                '{"answerType":"uint256","chainId":',
                vm.toString(vm.getChainId()),
                ',"question":"How often does \\"evidence\\":\\"panel\\" occur in the window?",',
                '"v":1,"window":{"fromBlock":'
            )
        );
        bytes32 id = q.createFeed(p, prefix, _tail(7, 5, 86_400));
        _fund(alice, id, 10e18);
        bytes32 intakeId = _request(id);
        OracleAttestation.Attestation memory a = _attestation(id, abi.encode(uint256(3)));
        bytes memory signature = _sign(a);
        _completeWithMissedCallback(intakeId, a, signature);
        assertTrue(q.canSubmit(id));
        q.submit(id, a, signature);
        (uint256 value,,,,) = q.latest(id);
        assertEq(value, 3);
    }

    function test_submit_appliesEveryCheckTheCallbackDoes() public {
        bytes32 intakeId = _request(feedId);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(1)));
        bytes memory signature = _sign(a);
        _completeWithoutAnswer(intakeId, 2);

        OracleAttestation.Attestation memory bad = _copy(a);
        bad.answer = abi.encode(uint256(2));
        vm.expectRevert(OracleAttestationConsumer.BadSignature.selector);
        q.submit(feedId, bad, signature);

        bad = _copy(a);
        bad.questionHash = keccak256("another question");
        bytes memory badSignature = _sign(bad);
        vm.expectRevert(abi.encodeWithSelector(Questions.WrongQuestion.selector, a.questionHash, bad.questionHash));
        q.submit(feedId, bad, badSignature);

        bad = _copy(a);
        bad.toBlock -= 1;
        badSignature = _sign(bad);
        vm.expectRevert(abi.encodeWithSelector(Questions.WrongWindow.selector, bad.fromBlock, bad.toBlock));
        q.submit(feedId, bad, badSignature);

        bad = _copy(a);
        bad.panelSize = 6;
        badSignature = _sign(bad);
        vm.expectRevert(abi.encodeWithSelector(Questions.PanelTooSmall.selector, 6, 5));
        q.submit(feedId, bad, badSignature);

        bad = _copy(a);
        bad.agreed = 4;
        badSignature = _sign(bad);
        vm.expectRevert(abi.encodeWithSelector(Questions.NotEnoughAgreed.selector, 4, 5));
        q.submit(feedId, bad, badSignature);

        bad = _copy(a);
        bad.blockHash = keccak256("another fork");
        badSignature = _sign(bad);
        vm.expectRevert(abi.encodeWithSelector(Questions.WrongBlockHash.selector, a.blockHash, bad.blockHash));
        q.submit(feedId, bad, badSignature);

        vm.warp(uint256(a.expiresAt) + 1);
        vm.expectRevert(abi.encodeWithSelector(OracleAttestationConsumer.AttestationExpired.selector, a.expiresAt));
        q.submit(feedId, a, signature);
        _assertStillPending(feedId, a);
    }

    /// @notice `submit` is only for feeds that pin their question. Without the pin nothing ties an
    /// attestation to this feed's question, so only the Intake may pair them.
    function test_submit_needsAPinnedQuestion() public {
        Questions.FeedParams memory p = _params();
        p.pinHash = false;
        bytes32 id = _create(p);
        _fund(alice, id, 10e18);
        bytes32 intakeId = _request(id);
        OracleAttestation.Attestation memory a = _attestation(id, abi.encode(uint256(1)));
        bytes memory signature = _sign(a);

        vm.expectRevert(Questions.SubmitNeedsPinnedQuestion.selector);
        q.submit(id, a, signature);
        // Not after the Intake completed the request and the callback was missed, either.
        _completeWithMissedCallback(intakeId, a, signature);
        assertFalse(q.canSubmit(id));
        vm.expectRevert(Questions.SubmitNeedsPinnedQuestion.selector);
        q.submit(id, a, signature);
    }

    function test_submit_withoutAPendingRoundOrAFeed_reverts() public {
        OracleAttestation.Attestation memory a;
        vm.expectRevert(abi.encodeWithSelector(Questions.NoPendingRound.selector, feedId));
        q.submit(feedId, a, "");
        bytes32 nowhere = keccak256("nowhere");
        vm.expectRevert(abi.encodeWithSelector(Questions.UnknownFeed.selector, nowhere));
        q.submit(nowhere, a, "");
        assertFalse(q.canSubmit(nowhere));
    }

    /// @notice An Intake whose `requests` getter cannot be read counts as not having completed
    /// anything: `submit` stays closed for the thirty minutes and then opens, so a missed callback
    /// can still be made good on an Intake that no longer answers.
    function test_submit_withAnIntakeThatCannotBeRead_waitsTheThirtyMinutes() public {
        OddIntake odd = new OddIntake();
        QuestionsHarness oddQ = new QuestionsHarness(address(odd), address(imd), oracle);
        bytes32 id = oddQ.createFeed(_params(), _prefix("uint256"), _tail(7, 5, 86_400));
        vm.startPrank(alice);
        imd.approve(address(oddQ), type(uint256).max);
        oddQ.fund(id, 5e18);
        vm.stopPrank();
        oddQ.newTransaction();
        oddQ.request(id);
        uint256 askedAt = vm.getBlockTimestamp();
        OracleAttestation.Attestation memory a;

        odd.setCompleted(true);
        OddIntake.Read[4] memory modes =
            [OddIntake.Read.Revert, OddIntake.Read.ShortReturn, OddIntake.Read.Garbage, OddIntake.Read.BurnGas];
        for (uint256 i; i < modes.length; ++i) {
            odd.setRequestsMode(modes[i]);
            assertFalse(oddQ.canSubmit(id));
            vm.expectRevert(abi.encodeWithSelector(Questions.SubmitTooEarly.selector, askedAt + submitAfterSilence));
            oddQ.submit(id, a, "");
        }
        // With a getter that answers "completed" it is open at once.
        odd.setRequestsMode(OddIntake.Read.Normal);
        assertTrue(oddQ.canSubmit(id));

        // With one that does not, it opens when the thirty minutes are up, in every mode, and is
        // closed in every mode one second sooner.
        skip(submitAfterSilence - 1);
        for (uint256 i; i < modes.length; ++i) {
            odd.setRequestsMode(modes[i]);
            assertFalse(oddQ.canSubmit(id));
            vm.expectRevert(abi.encodeWithSelector(Questions.SubmitTooEarly.selector, askedAt + submitAfterSilence));
            oddQ.submit(id, a, "");
        }
        skip(1);
        for (uint256 i; i < modes.length; ++i) {
            odd.setRequestsMode(modes[i]);
            uint256 before = gasleft();
            assertTrue(oddQ.canSubmit(id));
            assertLt(before - gasleft(), 200_000, "the read was given more than its cap");
        }
        // The answer is then checked like any other: an empty one is refused for what it is.
        vm.expectRevert(abi.encodeWithSelector(OracleAttestationConsumer.AttestationExpired.selector, 0));
        oddQ.submit(id, a, "");
    }

    /// @notice The answer to one feed's question cannot be handed to another feed, even one asking
    /// about the same blocks with the same panel: the question hash differs.
    function test_submit_anAnswerToAnotherFeed_reverts() public {
        Questions.FeedParams memory p = _params();
        bytes memory otherQuestion = bytes(
            string.concat(
                '{"answerType":"uint256","chainId":',
                vm.toString(vm.getChainId()),
                ',"question":"How many in the window?","v":1,"window":{"fromBlock":'
            )
        );
        bytes32 other = q.createFeed(p, otherQuestion, _tail(7, 5, 86_400));
        _fund(alice, other, 10e18);

        bytes32 intakeId = _request(feedId);
        bytes32 otherIntakeId = _request(other);
        (,, uint64 fromA, uint64 toA,) = q.roundOf(feedId, 1);
        (,, uint64 fromB, uint64 toB,) = q.roundOf(other, 1);
        assertEq(fromA, fromB);
        assertEq(toA, toB);

        // Both requests ended without an answer, so `submit` is open on both feeds.
        _completeWithoutAnswer(intakeId, 2);
        _completeWithoutAnswer(otherIntakeId, 2);
        OracleAttestation.Attestation memory a = _attestation(feedId, abi.encode(uint256(7)));
        bytes memory signature = _sign(a);
        (, bytes32 otherHash,,) = q.roundRequest(other, 1);
        vm.expectRevert(abi.encodeWithSelector(Questions.WrongQuestion.selector, otherHash, a.questionHash));
        q.submit(other, a, signature);

        q.submit(feedId, a, signature);
        (uint256 value,,,,) = q.latest(feedId);
        assertEq(value, 7);
        assertEq(uint8(_status(other, 1)), uint8(IQuestions.RoundStatus.Pending));
        assertFalse(q.usedBy(a.requestId, other));
    }

    // ---- reveal ---------------------------------------------------------------------------------

    function test_reveal_publishesTheListBehindARound() public {
        (bytes32 id, bytes32 intakeId) = _pendingFeed(OracleAttestation.ANSWER_ADDRESS_LIST);
        address[] memory top = new address[](3);
        (top[0], top[1], top[2]) = (alice, bob, keeper);
        bytes memory answer = abi.encode(top);

        vm.expectRevert(Questions.NothingToReveal.selector);
        q.reveal(id, 1, answer);

        OracleAttestation.Attestation memory a = _attestation(id, answer);
        assertTrue(_complete(intakeId, a, _sign(a)));

        vm.expectEmit(address(q));
        emit AnswerRevealed(id, 1, answer);
        vm.prank(bob);
        q.reveal(id, 1, answer);

        // A reader can check a list it is handed against the stored word, as the Jobs Report does.
        (uint256 value,,,,) = q.latest(id);
        assertEq(value, uint256(keccak256(answer)));
        assertEq(abi.decode(answer, (address[]))[1], bob);

        (top[0], top[1]) = (bob, alice);
        vm.expectRevert(Questions.WrongAnswerBytes.selector);
        q.reveal(id, 1, abi.encode(top));
        vm.expectRevert(Questions.NothingToReveal.selector);
        q.reveal(id, 2, answer);
    }

    function test_reveal_isOnlyForListFeeds() public {
        _answer(feedId, abi.encode(uint256(5)));
        vm.expectRevert(Questions.NothingToReveal.selector);
        q.reveal(feedId, 1, abi.encode(uint256(5)));
    }
}
