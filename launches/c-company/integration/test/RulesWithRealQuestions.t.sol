// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IQuestions} from "a-payroll/src/interfaces/IQuestions.sol";
import {OracleAttestation} from "a-payroll/src/questions/OracleAttestation.sol";
import {Rules} from "c-company/src/rules/Rules.sol";
import {MockFeed} from "c-company/test/rules/mocks/MockFeed.sol";
import {Siblings} from "./Siblings.sol";

/// @dev A FEED rule reading the real Questions. Rounds are bought from a funded meter and answered
/// with attestations signed by the fixture's oracle key and delivered through the Intake double's
/// callback, which is the road a real answer takes. The rule sees only what `latest` reports: the
/// newest ANSWERED round.
contract RulesWithRealQuestionsTest is Siblings {
    uint96 internal constant PAY = 2e18;
    uint96 internal constant RULE_TIP = 0.05e18;

    function setUp() public override {
        super.setUp();
        // Somebody funds the feed's meter so that rounds can be bought.
        _fund(alice, feed, 20e18);
    }

    /// @dev WHEN the feed's newest answer <cmp> threshold, no older than `maxAge`, THEN PAY 2 IMD to `heir`.
    function _feedRule(uint8 cmp, uint256 threshold, uint32 maxAge, uint32 maxFires) internal returns (uint256 id) {
        Rules.RuleParams memory p;
        p.when.kind = 2;
        p.when.cmp = cmp;
        p.when.target = address(q);
        p.when.threshold = threshold;
        p.when.feedId = feed;
        p.when.maxAge = maxAge;
        p.action = 2;
        p.pay = Rules.Pay({recipient: heir, amount: PAY});
        p.tip = RULE_TIP;
        p.maxFires = maxFires;
        vm.prank(user);
        id = rules.createRule(p, "", uint96(maxFires) * (PAY + RULE_TIP));
    }

    function _fire(uint256 id) internal {
        vm.prank(keeper);
        rules.fire(id, "");
    }

    function _expectNotMet(uint256 id) internal {
        vm.prank(keeper);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");
    }

    /// @dev The next round of the feed, answered with `value`.
    function _answerNext(uint256 value) internal {
        if (q.roundCount(feed) != 0) vm.roll(vm.getBlockNumber() + CADENCE);
        _answer(feed, abi.encode(value));
    }

    /// @dev One fire per answered round. Before any answer the rule waits; a pending round is not an
    /// answer; an answer that crosses the line fires the rule once; the same answer never fires it
    /// twice; an answer on the wrong side of the line does not fire it; the next one that crosses
    /// does.
    function test_feed_firesOncePerAnsweredRoundOfTheRealFeed() public {
        uint256 id = _feedRule(1, 100, 1 days, 5);
        (bool met, uint256 value, uint64 round) = rules.check(id);
        assertFalse(met);
        assertEq(value, 0);
        assertEq(round, 0);
        _expectNotMet(id);

        // A round is bought and waits for its answer: still nothing to read.
        bytes32 intakeId = _request(feed);
        assertFalse(rules.canFire(id));
        _expectNotMet(id);

        // The oracle's answer arrives through the Intake's callback.
        _deliver(intakeId, 150);
        (met, value, round) = rules.check(id);
        assertTrue(met);
        assertEq(value, 150);
        assertEq(round, 1);
        uint256 before = imd.balanceOf(heir);
        _fire(id);
        assertEq(imd.balanceOf(heir), before + PAY);
        assertEq(rules.getRule(id).lastRound, 1);
        _expectNotMet(id);

        _answerNext(99);
        (met, value, round) = rules.check(id);
        assertFalse(met, "below the line");
        assertEq(value, 99);
        assertEq(round, 2, "a new round all the same");
        _expectNotMet(id);

        _answerNext(100);
        _fire(id);
        assertEq(imd.balanceOf(heir), before + 2 * PAY);
        assertEq(rules.getRule(id).lastRound, 3);
        assertEq(rules.getRule(id).fires, 2);
    }

    /// @dev The oracle signs the pending round's answer and the Intake's writer delivers it.
    function _deliver(bytes32 intakeId, uint256 value) internal {
        OracleAttestation.Attestation memory a = _attestation(feed, abi.encode(value));
        assertTrue(_complete(intakeId, a, _sign(a)), "callback was not delivered");
    }

    /// @dev A round that fails gives the rule nothing new: the real `latest` stays on the last
    /// answered round, which the rule has already fired on.
    function test_feed_aFailedRoundIsNotANewAnswer() public {
        uint256 id = _feedRule(1, 100, 30 days, 5);
        _answerNext(150);
        _fire(id);

        vm.roll(vm.getBlockNumber() + CADENCE);
        _request(feed);
        (, uint256 closableAt) = q.canAbandon(feed);
        vm.warp(closableAt);
        assertTrue(q.abandon(feed));
        assertEq(q.roundCount(feed), 2);
        (,,, uint64 newest,) = q.latest(feed);
        assertEq(newest, 1, "the newest ANSWERED round is still the first");
        (bool met,, uint64 round) = rules.check(id);
        assertFalse(met);
        assertEq(round, 0);
        _expectNotMet(id);
    }

    /// @dev The answer's age is counted from the time the real contract stored it.
    function test_feed_anAnswerOlderThanTheRuleAllowsDoesNotFire() public {
        uint256 id = _feedRule(1, 100, 1 hours, 5);
        _answerNext(150);
        (,,,, uint64 updatedAt) = q.latest(feed);
        assertEq(updatedAt, vm.getBlockTimestamp());

        skip(1 hours);
        assertTrue(rules.canFire(id), "exactly as old as allowed");
        skip(1);
        assertFalse(rules.canFire(id));
        _expectNotMet(id);
    }

    /// @dev A feed id the real contract does not know answers with zeros, not with a revert: the
    /// rule can be written and simply never fires.
    function test_feed_anIdTheRealContractDoesNotKnowNeverFires() public {
        Rules.RuleParams memory p;
        p.when.kind = 2;
        p.when.cmp = 1;
        p.when.target = address(q);
        p.when.feedId = keccak256("nobody made this");
        p.when.maxAge = 1 days;
        p.action = 2;
        p.pay = Rules.Pay({recipient: heir, amount: PAY});
        p.maxFires = 1;
        vm.prank(user);
        uint256 id = rules.createRule(p, "", PAY);
        (bool met, uint256 value, uint64 round) = rules.check(id);
        assertFalse(met);
        assertEq(value, 0);
        assertEq(round, 0);
        _expectNotMet(id);
    }

    /// @dev The read of the real `latest` costs a small part of the 100,000 gas a condition is
    /// offered, from cold.
    function test_feed_theRealReadFitsTheConditionsGas() public {
        uint256 id = _feedRule(1, 100, 1 days, 1);
        _answerNext(150);
        uint256 gasBefore = gasleft();
        (bool met,,) = rules.check(id);
        uint256 used = gasBefore - gasleft();
        assertTrue(met);
        emit log_named_uint("gas: check() of a FEED rule on the real Questions", used);
        assertLt(used, 60_000);
    }

    /// @dev The stand-in feed of the main project answers in the real contract's shape: five words,
    /// with the value first, the round fourth and the time fifth, and five zero words for a feed
    /// with no answer.
    function test_standIn_theMockFeedAnswersInTheRealShape() public {
        MockFeed mock = new MockFeed();
        bytes memory ask = abi.encodeCall(IQuestions.latest, (feed));
        (, bytes memory realNone) = address(q).staticcall(ask);
        (, bytes memory mockNone) = address(mock).staticcall(ask);
        assertEq(realNone.length, 160);
        assertEq(mockNone, realNone, "no answer yet: five zero words from both");

        _answerNext(150);
        (uint256 value,,, uint64 round, uint64 updatedAt) = q.latest(feed);
        mock.set(feed, value, round, updatedAt);
        (, bytes memory real) = address(q).staticcall(ask);
        (, bytes memory mocked) = address(mock).staticcall(ask);
        assertEq(mocked.length, real.length);
        (uint256 v1,,, uint256 r1, uint256 t1) = abi.decode(real, (uint256, uint256, uint256, uint256, uint256));
        (uint256 v2,,, uint256 r2, uint256 t2) = abi.decode(mocked, (uint256, uint256, uint256, uint256, uint256));
        assertEq(v2, v1);
        assertEq(r2, r1);
        assertEq(t2, t1);
    }
}
