// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {OracleAttestationConsumer} from "../../src/questions/OracleAttestation.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {QuestionsFixture} from "./QuestionsFixture.sol";
import {GateTarget} from "./mocks/Oddities.sol";

/// @notice Creating feeds: the content address, what is checked at creation, and the constructor.
contract QuestionsFeedsTest is QuestionsFixture {
    event FeedCreated(
        bytes32 indexed feedId, address indexed creator, Questions.FeedParams params, bytes qPrefix, bytes tail
    );

    function _expectFault(Questions.FeedFault fault) internal {
        vm.expectRevert(abi.encodeWithSelector(Questions.BadFeed.selector, fault));
    }

    function _createWith(Questions.FeedParams memory p, bytes memory prefix, bytes memory tail)
        internal
        returns (bytes32)
    {
        return q.createFeed(p, prefix, tail);
    }

    // ---- constructor --------------------------------------------------------------------------

    function test_constructor_fixesItsThreeAddresses() public view {
        assertEq(address(q.INTAKE()), address(intake));
        assertEq(address(q.IMD()), address(imd));
        assertEq(q.oracleSigner(), oracle);
    }

    function test_constructor_refusesZeroAddresses() public {
        vm.expectRevert(Questions.ZeroAddress.selector);
        new Questions(address(0), address(imd), oracle);
        vm.expectRevert(Questions.ZeroAddress.selector);
        new Questions(address(intake), address(0), oracle);
        vm.expectRevert(OracleAttestationConsumer.ZeroSigner.selector);
        new Questions(address(intake), address(imd), address(0));
    }

    /// @notice The launch pipeline runs constructors on an empty chain: none of the three addresses
    /// needs code, and nothing is called.
    function test_constructor_makesNoCallAndNeedsNoCode() public {
        vm.recordLogs();
        Questions bare = new Questions(address(0xA11CE), address(0xB0B), address(0xC0DE));
        assertEq(address(0xA11CE).code.length, 0);
        assertEq(bare.oracleSigner(), address(0xC0DE));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "only OracleSignerSet");
        assertEq(logs[0].topics[0], keccak256("OracleSignerSet(address)"));
    }

    /// @notice No owner, no setter: the only functions that write are the ones a stranger may call.
    function test_thereIsNoOwnerAndNoSetter() public {
        string[8] memory guesses = [
            "owner()",
            "setOracleSigner(address)",
            "setSigner(address)",
            "setIntake(address)",
            "transferOwnership(address)",
            "setAction(bytes32,bytes)",
            "setPayment(address,uint256)",
            "withdraw(address,address,uint256)"
        ];
        for (uint256 i; i < guesses.length; ++i) {
            (bool ok,) =
                address(q).call(abi.encodeWithSelector(bytes4(keccak256(bytes(guesses[i]))), address(this), 1, 1));
            assertFalse(ok, guesses[i]);
        }
    }

    // ---- createFeed ---------------------------------------------------------------------------

    function test_createFeed_storesTheFeedAndSaysSo() public {
        Questions.FeedParams memory p = _params();
        bytes memory prefix = _prefix("uint256");
        bytes memory tail = _tail(7, 5, 86_400);
        bytes32 expected = keccak256(abi.encode(p, keccak256(prefix), keccak256(tail)));

        vm.expectEmit(address(q));
        emit FeedCreated(expected, alice, p, prefix, tail);
        vm.prank(alice);
        bytes32 feedId = q.createFeed(p, prefix, tail);

        assertEq(feedId, expected);
        assertEq(q.feedIdOf(p, prefix, tail), expected);
        assertEq(q.feedCount(), 1);
        assertEq(q.feedAt(0), feedId);
        assertEq(abi.encode(q.feedParams(feedId)), abi.encode(p));
        (bytes memory storedPrefix, bytes memory storedTail) = q.feedText(feedId);
        assertEq(storedPrefix, prefix);
        assertEq(storedTail, tail);
        Questions.FeedView memory v = q.feedState(feedId);
        assertTrue(v.exists);
        assertEq(v.rounds, 0);
        assertEq(q.roundCount(feedId), 0);
    }

    /// @notice The same feed created again, by anyone, is the same feed: no revert, no change, no event.
    function test_createFeed_twiceIsHarmless() public {
        bytes32 first = _createDefault();
        _fund(alice, first, 3e18);
        vm.recordLogs();
        vm.prank(bob);
        bytes32 second = _createDefault();
        assertEq(second, first);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(q.feedCount(), 1);
        (uint256 balance,) = q.meterOf(first);
        assertEq(balance, 3e18);
    }

    function test_createFeed_idDependsOnEveryPart() public {
        Questions.FeedParams memory p = _params();
        bytes32 base = _createWith(p, _prefix("uint256"), _tail(7, 5, 86_400));

        p.tip += 1;
        bytes32 otherTip = _createWith(p, _prefix("uint256"), _tail(7, 5, 86_400));
        p.tip -= 1;
        p.minAgreed = 4;
        bytes32 otherAgreed = _createWith(p, _prefix("uint256"), _tail(7, 5, 86_400));
        p.minAgreed = 5;
        bytes32 otherTail = _createWith(p, _prefix("uint256"), bytes.concat(',"toleranceBps":5', _tail(7, 5, 86_400)));
        bytes memory otherQuestion = bytes(
            string.concat(
                '{"answerType":"uint256","chainId":',
                vm.toString(vm.getChainId()),
                ',"question":"Another question?","v":1,"window":{"fromBlock":'
            )
        );
        bytes32 otherPrefix = _createWith(p, otherQuestion, _tail(7, 5, 86_400));

        assertTrue(base != otherTip && base != otherAgreed && base != otherTail && base != otherPrefix);
        assertEq(q.feedCount(), 5);
    }

    function testFuzz_feedIdOf_isTheDocumentedHash(
        Questions.FeedParams memory p,
        bytes memory prefix,
        bytes memory tail
    ) public view {
        assertEq(q.feedIdOf(p, prefix, tail), keccak256(abi.encode(p, keccak256(prefix), keccak256(tail))));
    }

    // ---- what createFeed refuses ----------------------------------------------------------------

    function test_createFeed_refusesAZeroAction() public {
        Questions.FeedParams memory p = _params();
        p.action = bytes32(0);
        _expectFault(Questions.FeedFault.Action);
        _create(p);
    }

    function test_createFeed_refusesAnotherChain() public {
        Questions.FeedParams memory p = _params();
        p.chainId = uint64(vm.getChainId() + 1);
        _expectFault(Questions.FeedFault.Chain);
        _create(p);
    }

    function test_createFeed_refusesAnUnknownAnswerType() public {
        Questions.FeedParams memory p = _params();
        p.answerType = 6;
        _expectFault(Questions.FeedFault.AnswerType);
        q.createFeed(p, _prefix("uint256"), _tail(7, 5, 86_400));
    }

    function test_createFeed_refusesBadPanels() public {
        Questions.FeedParams memory p = _params();
        (p.panelSize, p.quorum, p.minAgreed) = (1, 1, 1);
        _expectFault(Questions.FeedFault.Panel);
        _create(p);

        (p.panelSize, p.quorum, p.minAgreed) = (7, 1, 1);
        _expectFault(Questions.FeedFault.Panel);
        _create(p);

        (p.panelSize, p.quorum, p.minAgreed) = (7, 8, 5);
        _expectFault(Questions.FeedFault.Panel);
        _create(p);

        (p.panelSize, p.quorum, p.minAgreed) = (7, 5, 0);
        _expectFault(Questions.FeedFault.Panel);
        _create(p);

        (p.panelSize, p.quorum, p.minAgreed) = (7, 5, 6);
        _expectFault(Questions.FeedFault.Panel);
        _create(p);

        // A panel larger than the protocol seats: every request would be refused and paid for.
        (p.panelSize, p.quorum, p.minAgreed) = (301, 5, 5);
        _expectFault(Questions.FeedFault.Panel);
        _create(p);
        (p.panelSize, p.quorum, p.minAgreed) = (type(uint16).max, 200, 200);
        _expectFault(Questions.FeedFault.Panel);
        _create(p);

        // The edges that are allowed: a panel of two that must be unanimous, a floor of one, and
        // the largest panel the protocol takes.
        (p.panelSize, p.quorum, p.minAgreed) = (2, 2, 2);
        _create(p);
        (p.panelSize, p.quorum, p.minAgreed) = (7, 5, 1);
        _create(p);
        (p.panelSize, p.quorum, p.minAgreed) = (300, 300, 300);
        _create(p);
        assertEq(q.MAX_PANEL_SIZE(), 300);
    }

    function test_createFeed_refusesValidityOutsideTheProtocolsRange() public {
        Questions.FeedParams memory p = _params();
        p.validFor = 59;
        _expectFault(Questions.FeedFault.ValidFor);
        _create(p);
        p.validFor = 30 days + 1;
        _expectFault(Questions.FeedFault.ValidFor);
        _create(p);
        p.validFor = 60;
        _create(p);
        p.validFor = 30 days;
        _create(p);
    }

    function test_createFeed_refusesWindowsThatCannotWork() public {
        Questions.FeedParams memory p = _params();
        p.cadenceBlocks = 0;
        _expectFault(Questions.FeedFault.Window);
        _create(p);

        p = _params();
        p.maxWindowBlocks = 0;
        _expectFault(Questions.FeedFault.Window);
        _create(p);

        // A contiguous feed whose longest window is shorter than its cadence falls behind for good.
        p = _params();
        (p.cadenceBlocks, p.maxWindowBlocks) = (100, 99);
        _expectFault(Questions.FeedFault.Window);
        _create(p);

        // With the two equal it keeps up only while every round is asked in the very block it
        // falls due: one late or failed round and it is behind for good.
        (p.cadenceBlocks, p.maxWindowBlocks) = (100, 100);
        _expectFault(Questions.FeedFault.Window);
        _create(p);

        // One block more is the least room there is to catch up.
        (p.cadenceBlocks, p.maxWindowBlocks) = (100, 101);
        _create(p);

        // The other numbers are fine for a feed that only ever asks about the newest blocks.
        p.contiguous = false;
        (p.cadenceBlocks, p.maxWindowBlocks) = (100, 99);
        _create(p);
        (p.cadenceBlocks, p.maxWindowBlocks) = (100, 100);
        _create(p);
    }

    /// @notice A contiguous feed with any room at all does catch up: asked late, its next window
    /// is longer than a cadence until it ends at the newest block again.
    function test_createFeed_roomAboveTheCadenceIsWhatCatchesUp() public {
        Questions.FeedParams memory p = _params();
        (p.cadenceBlocks, p.maxWindowBlocks) = (100, 110);
        bytes32 id = _create(p);
        _fund(alice, id, 10e18);
        _answer(id, abi.encode(uint256(1)));

        // The second round is asked 25 blocks late. It can make up 10 of them.
        vm.roll(vm.getBlockNumber() + 125);
        _answer(id, abi.encode(uint256(2)));
        (,, uint64 from2, uint64 to2,) = q.roundOf(id, 2);
        assertEq(uint256(to2) - from2 + 1, 110);
        assertEq(vm.getBlockNumber() - LAG - to2, 15, "blocks still to make up");

        // Asked on time from then on, it makes up 10 more and then the last 5.
        vm.roll(vm.getBlockNumber() + 100);
        _answer(id, abi.encode(uint256(3)));
        (,,, uint64 to3,) = q.roundOf(id, 3);
        assertEq(vm.getBlockNumber() - LAG - to3, 5);
        vm.roll(vm.getBlockNumber() + 100);
        _answer(id, abi.encode(uint256(4)));
        (,, uint64 from4, uint64 to4,) = q.roundOf(id, 4);
        assertEq(to4, vm.getBlockNumber() - LAG, "the feed is level with the head again");
        assertEq(from4, to3 + 1);
    }

    function test_createFeed_refusesALagOutsideFiveTo256() public {
        Questions.FeedParams memory p = _params();
        p.lagBlocks = 4;
        _expectFault(Questions.FeedFault.Lag);
        _create(p);
        p.lagBlocks = 257;
        _expectFault(Questions.FeedFault.Lag);
        _create(p);
        p.lagBlocks = 5;
        _create(p);
        p.lagBlocks = 256;
        _create(p);
    }

    function test_createFeed_refusesAZeroPriceCap() public {
        Questions.FeedParams memory p = _params();
        p.maxPrice = 0;
        _expectFault(Questions.FeedFault.Price);
        _create(p);
    }

    /// @notice A keeper is never paid more for asking than the feed is willing to pay for the
    /// answer itself.
    function test_createFeed_refusesATipAboveThePriceCap() public {
        Questions.FeedParams memory p = _params();
        p.tip = p.maxPrice + 1;
        _expectFault(Questions.FeedFault.Tip);
        _create(p);
        p.tip = type(uint96).max;
        _expectFault(Questions.FeedFault.Tip);
        _create(p);

        p.tip = p.maxPrice;
        bytes32 id = _create(p);
        assertEq(q.feedParams(id).tip, p.maxPrice);
        p.tip = 0;
        _create(p);
    }

    function test_createFeed_refusesGateFieldsThatContradict() public {
        GateTarget gate = new GateTarget();
        Questions.FeedParams memory p = _params();

        // No target, but a comparison, a threshold or call data left behind.
        p.gateCmp = 1;
        _expectFault(Questions.FeedFault.Gate);
        _create(p);
        (p.gateCmp, p.gateThreshold) = (0, 1);
        _expectFault(Questions.FeedFault.Gate);
        _create(p);
        (p.gateThreshold, p.gateData) = (0, hex"00");
        _expectFault(Questions.FeedFault.Gate);
        _create(p);

        // A target, but no comparison or one that does not exist.
        p = _params();
        p.gateTarget = address(gate);
        p.gateData = abi.encodeCall(GateTarget.value, ());
        _expectFault(Questions.FeedFault.Gate);
        _create(p);
        p.gateCmp = 7;
        _expectFault(Questions.FeedFault.Gate);
        _create(p);

        // Call data longer than a selector and two words.
        p.gateCmp = 1;
        p.gateData = bytes.concat(abi.encodeCall(GateTarget.plus2, (1, 2)), hex"00");
        assertEq(p.gateData.length, 69);
        _expectFault(Questions.FeedFault.Gate);
        _create(p);

        p.gateData = abi.encodeCall(GateTarget.plus2, (1, 2));
        assertEq(p.gateData.length, 68);
        _create(p);
    }

    function test_createFeed_refusesAPrefixThatIsNotTheFeedsCanonicalDocument() public {
        Questions.FeedParams memory p = _params();
        bytes memory tail = _tail(7, 5, 86_400);

        // The answer type in the text is not the feed's.
        _expectFault(Questions.FeedFault.Prefix);
        q.createFeed(p, _prefix("bool"), tail);

        // The chain in the text is not the feed's.
        bytes memory otherChain =
            bytes('{"answerType":"uint256","chainId":4663,"question":"Q?","v":1,"window":{"fromBlock":');
        _expectFault(Questions.FeedFault.Prefix);
        q.createFeed(p, otherChain, tail);

        // A chain id that only starts like the feed's (31337 against 313370).
        bytes memory longerChain = bytes(
            string.concat(
                '{"answerType":"uint256","chainId":',
                vm.toString(vm.getChainId()),
                '0,"question":"Q?","v":1,"window":{"fromBlock":'
            )
        );
        _expectFault(Questions.FeedFault.Prefix);
        q.createFeed(p, longerChain, tail);

        // Keys in another order: valid JSON, but not the document the oracle hashes.
        bytes memory reordered = bytes(
            string.concat(
                '{"v":1,"answerType":"uint256","chainId":',
                vm.toString(vm.getChainId()),
                ',"question":"Q?","window":{"fromBlock":'
            )
        );
        _expectFault(Questions.FeedFault.Prefix);
        q.createFeed(p, reordered, tail);

        // It does not stop where the block numbers go.
        bytes memory complete = bytes.concat(_prefix("uint256"), "1");
        _expectFault(Questions.FeedFault.Prefix);
        q.createFeed(p, complete, tail);

        _expectFault(Questions.FeedFault.Prefix);
        q.createFeed(p, "", tail);
    }

    function test_createFeed_acceptsEveryAnswerTypeByItsProtocolName() public {
        string[6] memory names = ["bool", "address", "bytes32", "uint256", "address[]", "bytes32[]"];
        for (uint8 t; t < 6; ++t) {
            Questions.FeedParams memory p = _params();
            p.answerType = t;
            q.createFeed(p, _prefix(names[t]), _tail(7, 5, 86_400));
            // Every other name is refused for this code.
            Questions.FeedParams memory other = _params();
            other.answerType = (t + 1) % 6;
            _expectFault(Questions.FeedFault.Prefix);
            q.createFeed(other, _prefix(names[t]), _tail(7, 5, 86_400));
        }
        assertEq(q.feedCount(), 6);
    }

    function test_createFeed_refusesATailThatDisagreesWithTheFeed() public {
        Questions.FeedParams memory p = _params();
        bytes memory prefix = _prefix("uint256");

        // Not shaped like the rest of a JSON object.
        _expectFault(Questions.FeedFault.Tail);
        q.createFeed(p, prefix, "");
        _expectFault(Questions.FeedFault.Tail);
        q.createFeed(p, prefix, bytes('"panelSize":7,"quorum":5,"validForSeconds":86400}'));
        _expectFault(Questions.FeedFault.Tail);
        q.createFeed(p, prefix, bytes(',"panelSize":7,"quorum":5,"validForSeconds":86400'));

        // The body would ask for a panel, a quorum or a validity the callback does not expect.
        _expectFault(Questions.FeedFault.Tail);
        q.createFeed(p, prefix, _tail(9, 5, 86_400));
        _expectFault(Questions.FeedFault.Tail);
        q.createFeed(p, prefix, _tail(7, 4, 86_400));
        _expectFault(Questions.FeedFault.Tail);
        q.createFeed(p, prefix, _tail(7, 5, 3600));

        // A number that only starts like the feed's: quorum 50 is not quorum 5, 864000 is not 86400.
        _expectFault(Questions.FeedFault.Tail);
        q.createFeed(p, prefix, bytes(',"panelSize":70,"quorum":5,"validForSeconds":86400}'));
        _expectFault(Questions.FeedFault.Tail);
        q.createFeed(p, prefix, bytes(',"panelSize":7,"quorum":50,"validForSeconds":86400}'));
        _expectFault(Questions.FeedFault.Tail);
        q.createFeed(p, prefix, bytes(',"panelSize":7,"quorum":5,"validForSeconds":864000}'));

        // A field left out.
        _expectFault(Questions.FeedFault.Tail);
        q.createFeed(p, prefix, bytes(',"panelSize":7,"quorum":5}'));

        // Any order and any extra fields are fine as long as the three numbers are there.
        q.createFeed(
            p,
            prefix,
            bytes(',"validForSeconds":86400,"guards":{"min":"0"},"quorum":5,"evidence":"chain","panelSize":7}')
        );
    }

    function test_createFeed_refusesABodyLongerThanTheIntakeTakes() public {
        Questions.FeedParams memory p = _params();
        bytes memory tail = _tail(7, 5, 86_400);
        bytes memory start =
            bytes(string.concat('{"answerType":"uint256","chainId":', vm.toString(vm.getChainId()), ',"question":"'));
        bytes memory end = '","v":1,"window":{"fromBlock":';
        // 52 bytes are kept back for two block numbers of twenty digits and the text between them.
        uint256 room = 16_384 - 52 - tail.length - start.length - end.length;

        bytes memory longest = bytes.concat(start, _filler(room), end);
        assertEq(longest.length + tail.length + 52, 16_384);
        bytes32 feedId = q.createFeed(p, longest, tail);

        _expectFault(Questions.FeedFault.TooLong);
        q.createFeed(p, bytes.concat(start, _filler(room + 1), end), tail);

        // The longest feed that is accepted really does fit: its body goes through the Intake.
        _fund(alice, feedId, 1e18);
        _request(feedId);
        assertLe(intake.lastBody().length, intake.MAX_BODY_BYTES());
    }

    function _filler(uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = "x";
        }
    }

    /// @notice `checkFeed` and `createFeed` never disagree.
    function testFuzz_checkFeed_saysWhatCreateFeedDoes(
        uint16 panelSize,
        uint16 quorum,
        uint16 minAgreed,
        uint32 validFor,
        uint32 cadence,
        uint32 maxWindow,
        uint16 lag,
        bool contiguous,
        uint96 tip
    ) public {
        Questions.FeedParams memory p = _params();
        // Mostly around the lower edge, sometimes around the upper one.
        p.panelSize = uint16(panelSize % 8 == 0 ? bound(panelSize, 295, 305) : bound(panelSize, 0, 12));
        p.tip = uint96(bound(tip, 0, 2 * uint256(p.maxPrice)));
        p.quorum = uint16(bound(quorum, 0, 12));
        p.minAgreed = uint16(bound(minAgreed, 0, 12));
        p.validFor = uint32(bound(validFor, 0, 40 days));
        p.cadenceBlocks = uint32(bound(cadence, 0, 3));
        p.maxWindowBlocks = uint32(bound(maxWindow, 0, 3));
        p.lagBlocks = uint16(bound(lag, 0, 300));
        p.contiguous = contiguous;
        bytes memory prefix = _prefix("uint256");
        bytes memory tail = _tail(p.panelSize, p.quorum, p.validFor);

        Questions.FeedFault fault = q.checkFeed(p, prefix, tail);
        if (fault == Questions.FeedFault.None) {
            assertEq(q.createFeed(p, prefix, tail), q.feedIdOf(p, prefix, tail));
            assertTrue(q.feedState(q.feedIdOf(p, prefix, tail)).exists);
        } else {
            _expectFault(fault);
            q.createFeed(p, prefix, tail);
        }
    }

    // ---- unknown feeds ------------------------------------------------------------------------

    function test_unknownFeed_readsAsEmptyAndRevertsWhereItMust() public {
        bytes32 nowhere = keccak256("no such feed");
        (uint256 value, uint64 fromBlock, uint64 toBlock, uint64 round, uint64 updatedAt) = q.latest(nowhere);
        assertEq(value + fromBlock + toBlock + round + updatedAt, 0);
        assertEq(q.roundCount(nowhere), 0);
        assertEq(q.costOf(nowhere), 0);
        (uint256 balance, uint256 shares) = q.meterOf(nowhere);
        assertEq(balance + shares, 0);
        assertEq(q.sharesOf(nowhere, alice), 0);
        assertEq(q.redeemable(nowhere, alice), 0);
        Questions.FeedView memory v = q.feedState(nowhere);
        assertFalse(v.exists);
        assertEq(uint8(v.blocker), uint8(Questions.Blocker.UnknownFeed));
        (bool ok, Questions.Blocker why,,,) = q.canRequest(nowhere);
        assertFalse(ok);
        assertEq(uint8(why), uint8(Questions.Blocker.UnknownFeed));

        bytes memory unknown = abi.encodeWithSelector(Questions.UnknownFeed.selector, nowhere);
        vm.expectRevert(unknown);
        q.feedParams(nowhere);
        vm.expectRevert(unknown);
        q.feedText(nowhere);
        vm.expectRevert(unknown);
        q.nextBody(nowhere);
        vm.expectRevert(unknown);
        q.gateOpen(nowhere);
        vm.expectRevert(unknown);
        vm.prank(alice);
        q.fund(nowhere, 1e18);
        vm.expectRevert(unknown);
        vm.prank(alice);
        q.fundFor(nowhere, 1e18, bob);
        vm.expectRevert(unknown);
        q.abandon(nowhere);
        assertFalse(q.canSubmit(nowhere));
        (Questions.AbandonStep step, uint256 closableAt) = q.canAbandon(nowhere);
        assertEq(uint8(step), uint8(Questions.AbandonStep.Wait));
        assertEq(closableAt, 0);
        vm.expectRevert(_blocked(Questions.Blocker.UnknownFeed));
        q.request(nowhere);
    }
}
