// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkOrders} from "b-desk/src/interfaces/IWorkOrders.sol";
import {IWorkOrders as IDesk} from "c-company/src/interfaces/IWorkOrders.sol";
import {MockCrowdPots} from "c-company/test/endowments/mocks/MockCrowdPots.sol";
import {MockQuestions as EndowmentsQuestions} from "c-company/test/endowments/mocks/MockQuestions.sol";
import {MockDesk} from "c-company/test/rules/mocks/MockDesk.sol";
import {MockPots} from "c-company/test/rules/mocks/MockPots.sol";
import {MockQuestions as ZapQuestions} from "c-company/test/rules/mocks/MockQuestions.sol";
import {Siblings} from "./Siblings.sol";

/// @dev The main project cannot compile its siblings, so its own tests run Rules, Endowments and Zap
/// against stand-ins. This file holds each stand-in beside the real contract it stands for and
/// drives both with the same calls: the same acceptances, the same refusals with the same bytes,
/// the same amounts taken, the same books. Where a stand-in is deliberately simpler than the real
/// contract, the main project's `docs/THREATS.md` says how.
contract StandInsAgreeTest is Siblings {
    function _both(address real, address standIn, bytes memory data)
        internal
        returns (bool ok, bytes memory out, bool ok2, bytes memory out2)
    {
        (ok, out) = real.call(data);
        (ok2, out2) = standIn.call(data);
    }

    function _sameAnswer(address real, address standIn, bytes memory data, string memory what) internal {
        (bool ok, bytes memory out, bool ok2, bytes memory out2) = _both(real, standIn, data);
        assertEq(ok2, ok, string.concat(what, ": one accepted what the other refused"));
        assertEq(out2, out, string.concat(what, ": the answers differ"));
    }

    function _sameRefusal(address real, address standIn, bytes memory data, string memory what) internal {
        (bool ok, bytes memory out, bool ok2, bytes memory out2) = _both(real, standIn, data);
        assertFalse(ok, string.concat(what, ": the real contract accepted it"));
        assertFalse(ok2, string.concat(what, ": the stand-in accepted it"));
        assertEq(out2, out, string.concat(what, ": the refusals differ"));
    }

    // ------------------------------------------------------------------------------------------
    // The hire desk
    // ------------------------------------------------------------------------------------------

    function _newMockDesk() internal returns (MockDesk mock) {
        mock = new MockDesk(address(imd));
        imd.mint(address(this), 1_000e18);
        imd.approve(address(desk), type(uint256).max);
        imd.approve(address(mock), type(uint256).max);
    }

    function _sameAccount(MockDesk mock, uint256 idMock, uint256 idReal) internal view {
        (, address e1, uint96 a1, uint96 b1, uint96 c1) = mock.accountOf(idMock);
        (, address e2, uint96 a2, uint96 b2, uint96 c2) = desk.accountOf(idReal);
        assertEq(e1, e2, "employer");
        assertEq(a1, a2, "escrow");
        assertEq(b1, b2, "spent");
        assertEq(c1, c2, "returned");
        assertEq(uint8(mock.stateOf(idMock)), uint8(desk.stateOf(idReal)), "state");
    }

    /// @dev The constants Rules reads are the real desk's.
    function test_desk_theStandInPublishesTheRealDesksConstants() public {
        MockDesk mock = _newMockDesk();
        assertEq(mock.FLAG_ALLOW_CLAIMED(), desk.FLAG_ALLOW_CLAIMED());
        assertEq(mock.FLAG_CALLBACK(), desk.FLAG_CALLBACK());
        assertEq(mock.FLAG_COND_ARG(), desk.FLAG_COND_ARG());
        assertEq(mock.MIN_BOND(), desk.MIN_BOND());
        assertEq(mock.MIN_DELIVERY(), desk.MIN_DELIVERY());
        assertEq(mock.MAX_DELIVERY(), desk.MAX_DELIVERY());
        assertEq(mock.CALLBACK_GAS(), desk.CALLBACK_GAS());
        assertEq(mock.IMD(), desk.IMD());
    }

    /// @dev Any order: the stand-in desk and the real desk both accept it, or both refuse it with
    /// the same bytes. Values are drawn mostly from just around each limit.
    function testFuzz_desk_createOrderAgreesWithTheRealDesk(
        uint96 minPay,
        uint96 maxPay,
        uint32 deliverySecs,
        uint96 bond,
        uint40 expiresIn,
        uint8 flags,
        bool conditional,
        uint8 condCmp,
        uint8 specCase
    ) public {
        MockDesk mock = _newMockDesk();
        IWorkOrders.OrderParams memory o;
        o.kindHash = keccak256("audit");
        o.maxPay = uint96(bound(maxPay, 0, 100e18));
        o.minPay = uint96(bound(minPay, 0, 110e18));
        o.deliverySecs = deliverySecs % 3 == 0 ? deliverySecs : uint32(bound(deliverySecs, 3 days - 2, 90 days + 2));
        if (deliverySecs % 5 == 1) o.deliverySecs = uint32(bound(deliverySecs, 3 days - 2, 3 days + 2));
        if (deliverySecs % 5 == 2) o.deliverySecs = uint32(bound(deliverySecs, 90 days - 2, 90 days + 2));
        o.bond = bond % 2 == 0 ? uint96(bound(bond, 0.25e18 - 2, 0.25e18 + 2)) : uint96(bound(bond, 0, 10e18));
        o.expiresAt = uint40(vm.getBlockTimestamp() + bound(expiresIn, 0, 3)) - 1;
        o.flags = flags % 4 == 0 ? flags : flags % 9;
        o.condTarget = conditional ? address(simd) : address(0);
        o.condCmp = condCmp % 9;
        bytes memory spec = [
            bytes("Audit it."),
            bytes(""),
            bytes(" leading"),
            bytes("trailing "),
            bytes('quo"te'),
            bytes("back\\slash"),
            bytes("ok then \x7f"),
            bytes("fine and long enough to cross a word boundary, with a tab\there")
        ][specCase % 8];

        (bool okReal, bytes memory outReal, bool okMock, bytes memory outMock) =
            _both(address(desk), address(mock), abi.encodeCall(IWorkOrders.createOrder, (o, spec)));
        assertEq(okMock, okReal, "one desk accepted what the other refused");
        if (!okReal) {
            assertEq(outMock, outReal, "the two desks refuse with different errors");
            return;
        }
        _sameAccount(mock, abi.decode(outMock, (uint256)), abi.decode(outReal, (uint256)));
    }

    /// @dev Any spec: the position the stand-in names is the real desk's.
    function testFuzz_desk_theStandInNamesTheRealDesksSpecPosition(
        bytes calldata raw,
        uint16 length,
        uint8 planted,
        uint16 at
    ) public {
        MockDesk mock = _newMockDesk();
        IWorkOrders.OrderParams memory o;
        o.maxPay = 1e18;
        o.deliverySecs = 3 days;
        o.bond = 0.25e18;
        o.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);

        bytes memory spec;
        if (length % 3 == 0) {
            spec = raw;
        } else {
            uint256 n = bound(length, 1, 200);
            spec = new bytes(n);
            for (uint256 i; i < n; ++i) {
                spec[i] = bytes1(uint8(0x61 + i % 26));
            }
            spec[at % n] = bytes1(planted);
        }
        (bool okReal, bytes memory outReal, bool okMock, bytes memory outMock) =
            _both(address(desk), address(mock), abi.encodeCall(IWorkOrders.createOrder, (o, spec)));
        assertEq(okMock, okReal);
        if (!okReal) assertEq(outMock, outReal);
    }

    /// @dev Withdrawing and refunding: who may, when, and what the books say afterwards.
    function test_desk_cancelAndRefundAgreeWithTheRealDesk() public {
        MockDesk mock = _newMockDesk();
        IWorkOrders.OrderParams memory o;
        o.kindHash = keccak256("audit");
        o.maxPay = 10e18;
        o.minPay = 4e18;
        o.deliverySecs = 3 days;
        o.bond = 0.25e18;
        o.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);

        // The two desks number their orders alike, so one set of calldata serves both.
        uint256 first = desk.createOrder(o, SPEC);
        assertEq(mock.createOrder(_asMock(o), SPEC), first);
        uint256 second = desk.createOrder(o, SPEC);
        assertEq(mock.createOrder(_asMock(o), SPEC), second);
        _sameAccount(mock, first, first);

        bytes memory cancelFirst = abi.encodeCall(IWorkOrders.cancel, (first));
        bytes memory refundFirst = abi.encodeCall(IWorkOrders.refund, (first));
        bytes memory refundSecond = abi.encodeCall(IWorkOrders.refund, (second));

        // A stranger may not withdraw an order.
        vm.startPrank(user);
        _sameRefusal(address(desk), address(mock), cancelFirst, "a stranger cancels");
        vm.stopPrank();
        // Nobody may refund one before it expires, and an order nobody opened is in no state at all.
        _sameRefusal(address(desk), address(mock), refundFirst, "a refund before the expiry");
        _sameRefusal(address(desk), address(mock), abi.encodeCall(IWorkOrders.cancel, (77)), "cancel of no order");
        _sameRefusal(address(desk), address(mock), abi.encodeCall(IWorkOrders.refund, (77)), "refund of no order");

        _sameAnswer(address(desk), address(mock), cancelFirst, "the employer cancels");
        _sameAccount(mock, first, first);
        _sameRefusal(address(desk), address(mock), cancelFirst, "a second cancel");
        _sameRefusal(address(desk), address(mock), refundFirst, "a refund of a cancelled order");

        skip(1 days - 1);
        _sameRefusal(address(desk), address(mock), refundSecond, "a refund one second early");
        skip(1);
        _sameAnswer(address(desk), address(mock), refundSecond, "a refund at the second of expiry");
        _sameAccount(mock, second, second);
    }

    /// @dev The same order in this project's copy of the frozen struct, which has the same fields.
    function _asMock(IWorkOrders.OrderParams memory o) internal pure returns (IDesk.OrderParams memory) {
        return abi.decode(abi.encode(o), (IDesk.OrderParams));
    }

    // ------------------------------------------------------------------------------------------
    // The crowd pots
    // ------------------------------------------------------------------------------------------

    /// @dev Both pot stand-ins against the real pots: what a pot still needs, what a chip takes, the
    /// refusal for a beneficiary that would strand a refund, an id nobody opened, and a series
    /// whose rounds open one after another.
    function test_pots_theStandInsAgreeWithTheRealPots() public {
        MockPots zapPots = new MockPots(address(imd));
        MockCrowdPots endowPots = new MockCrowdPots(address(imd));
        vm.startPrank(user);
        imd.approve(address(zapPots), type(uint256).max);
        imd.approve(address(endowPots), type(uint256).max);
        vm.stopPrank();

        // ---- a single pot that needs 5
        uint256 real = pots.openPot(_terms(5e18), SPEC, 0);
        uint256 z = zapPots.open(5e18);
        endowPots.open(1, 5e18);
        assertEq(pots.potCount(), 1);
        assertEq(zapPots.potCount(), 1);
        assertEq(endowPots.potCount(), 1);

        uint256[4] memory chips = [uint256(2e18), 0, 4e18, 1e18];
        for (uint256 i; i < 4; ++i) {
            assertEq(zapPots.remaining(z), pots.remaining(real), "remaining (Zap's stand-in)");
            assertEq(endowPots.remaining(1), pots.remaining(real), "remaining (Endowments' stand-in)");
            vm.startPrank(user);
            uint256 taken = pots.chipInFor(real, chips[i], heir);
            assertEq(zapPots.chipInFor(z, chips[i], heir), taken, "taken (Zap's stand-in)");
            assertEq(endowPots.chipInFor(1, chips[i], heir), taken, "taken (Endowments' stand-in)");
            vm.stopPrank();
        }
        (uint256 amount,,) = pots.chipOf(real, heir);
        assertEq(amount, 5e18);
        assertEq(zapPots.chipOf(z, heir), amount);
        assertEq(endowPots.chipOf(1, heir), amount);
        assertEq(pots.remaining(real), 0);
        assertEq(zapPots.remaining(z), 0);
        assertEq(endowPots.remaining(1), 0);

        // ---- an id nobody opened
        assertEq(pots.remaining(50), 0);
        assertEq(zapPots.remaining(50), 0);
        assertEq(endowPots.remaining(50), 0);
        vm.startPrank(user);
        assertEq(pots.chipInFor(50, 1e18, heir), 0);
        assertEq(zapPots.chipInFor(50, 1e18, heir), 0);
        assertEq(endowPots.chipInFor(50, 1e18, heir), 0);
        vm.stopPrank();

        _sameBeneficiaryRefusals(zapPots, endowPots, real, z);
        _sameSeries(zapPots, endowPots);
    }

    /// @dev A beneficiary that would strand a refund: the same error from all three, whatever the pot.
    function _sameBeneficiaryRefusals(MockPots zapPots, MockCrowdPots endowPots, uint256 real, uint256 z) internal {
        vm.startPrank(user);
        (bool ok, bytes memory outReal) = address(pots).call(abi.encodeCall(pots.chipInFor, (real, 1e18, address(0))));
        assertFalse(ok);
        (, bytes memory outZ) = address(zapPots).call(abi.encodeCall(zapPots.chipInFor, (z, 1e18, address(0))));
        (, bytes memory outE) = address(endowPots).call(abi.encodeCall(endowPots.chipInFor, (1, 1e18, address(0))));
        assertEq(outZ, outReal);
        assertEq(outE, outReal);
        (ok, outReal) = address(pots).call(abi.encodeCall(pots.chipInFor, (50, 1e18, address(pots))));
        assertFalse(ok);
        (, outZ) = address(zapPots).call(abi.encodeCall(zapPots.chipInFor, (50, 1e18, address(zapPots))));
        (, outE) = address(endowPots).call(abi.encodeCall(endowPots.chipInFor, (50, 1e18, address(endowPots))));
        assertEq(outZ, outReal);
        assertEq(outE, outReal);
        vm.stopPrank();
    }

    /// @dev A series whose rounds collect 3.
    function _sameSeries(MockPots zapPots, MockCrowdPots endowPots) internal {
        uint256 realSeries = pots.openSeries(_terms(3e18), SPEC);
        uint256 zSeries = zapPots.openSeries(3e18);
        endowPots.openSeries(2, 3e18);
        uint256[6] memory seriesChips = [uint256(0), 1e18, 5e18, 2e18, 3e18, 1];
        for (uint256 i; i < 6; ++i) {
            assertEq(zapPots.remaining(zSeries), pots.remaining(realSeries), "series remaining (Zap's stand-in)");
            assertEq(endowPots.remaining(2), pots.remaining(realSeries), "series remaining (Endowments' stand-in)");
            vm.startPrank(user);
            uint256 taken = pots.chipInFor(realSeries, seriesChips[i], heir);
            assertEq(zapPots.chipInFor(zSeries, seriesChips[i], heir), taken, "series taken (Zap's stand-in)");
            assertEq(endowPots.chipInFor(2, seriesChips[i], heir), taken, "series taken (Endowments' stand-in)");
            vm.stopPrank();
        }
        assertEq(zapPots.remaining(zSeries), pots.remaining(realSeries));
        assertEq(endowPots.remaining(2), pots.remaining(realSeries));
        // Zap's stand-in opens a pot per round, as the real contract does.
        assertEq(zapPots.potCount(), pots.potCount());
        assertEq(zapPots.currentRound(zSeries), pots.currentRound(realSeries));
        (uint256 amount,,) = pots.chipOf(pots.currentRound(realSeries), heir);
        assertEq(zapPots.chipOf(zapPots.currentRound(zSeries), heir), amount);
    }

    // ------------------------------------------------------------------------------------------
    // Standing Questions: the meter
    // ------------------------------------------------------------------------------------------

    EndowmentsQuestions internal endowQ;
    ZapQuestions internal zapQ;

    function _newMockQuestions() internal {
        endowQ = new EndowmentsQuestions(address(imd));
        zapQ = new ZapQuestions(address(imd));
        endowQ.addFeed(feed);
        zapQ.open(feed);
        address[2] memory funders = [user, heir];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(funders[i]);
            imd.approve(address(q), type(uint256).max);
            imd.approve(address(endowQ), type(uint256).max);
            imd.approve(address(zapQ), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _sameMeter() internal view {
        (uint256 balance, uint256 total) = q.meterOf(feed);
        (uint256 b1, uint256 t1) = endowQ.meterOf(feed);
        (uint256 b2, uint256 t2) = zapQ.meterOf(feed);
        assertEq(b1, balance, "meter balance (Endowments' stand-in)");
        assertEq(t1, total, "meter shares (Endowments' stand-in)");
        assertEq(b2, balance, "meter balance (Zap's stand-in)");
        assertEq(t2, total, "meter shares (Zap's stand-in)");
    }

    /// @dev The refusals of `fund` and `fundFor` carry the real contract's bytes, in its order.
    function test_questions_theStandInsRefuseAsTheRealContractDoes() public {
        _newMockQuestions();
        endowQ.setCost(q.costOf(feed));
        assertEq(endowQ.costOf(feed), q.costOf(feed));
        bytes32 unknown = keccak256("nobody made this");
        assertEq(q.costOf(unknown), 0);
        assertEq(endowQ.costOf(unknown), 0);
        (uint256 balance, uint256 total) = q.meterOf(unknown);
        (uint256 b1, uint256 t1) = endowQ.meterOf(unknown);
        assertEq(balance + total + b1 + t1, 0, "an unknown feed's meter reads as zeros, without a revert");

        bytes[4] memory bad = [
            abi.encodeCall(q.fundFor, (feed, 1e18, address(0))),
            abi.encodeCall(q.fundFor, (unknown, 1e18, heir)),
            abi.encodeCall(q.fundFor, (feed, 0, heir)),
            abi.encodeCall(q.fundFor, (unknown, 0, address(0)))
        ];
        vm.startPrank(user);
        for (uint256 i; i < 4; ++i) {
            _sameRefusal(address(q), address(endowQ), bad[i], "fundFor (Endowments' stand-in)");
            _sameRefusal(address(q), address(zapQ), bad[i], "fundFor (Zap's stand-in)");
        }
        _sameRefusal(address(q), address(endowQ), abi.encodeCall(q.fund, (unknown, 1e18)), "fund of an unknown feed");
        _sameRefusal(address(q), address(endowQ), abi.encodeCall(q.fund, (feed, 0)), "fund of nothing");
        _sameRefusal(address(q), address(endowQ), abi.encodeCall(q.defund, (feed, 1)), "defund with no shares");
        vm.stopPrank();
    }

    /// @dev Shares on the real meter and on both stand-ins, through a first funding, a real round
    /// bought, a second funding at the meter's new worth, and a funder leaving.
    function test_questions_theStandInsMintAndRedeemAsTheRealMeterDoes() public {
        _newMockQuestions();
        vm.startPrank(user);
        uint256 s = q.fundFor(feed, 3e18, heir);
        assertEq(endowQ.fundFor(feed, 3e18, heir), s);
        assertEq(zapQ.fundFor(feed, 3e18, heir), s);
        vm.stopPrank();
        _sameMeter();

        // A real request is bought; the stand-ins are told what it cost the meter.
        _request(feed);
        (uint256 balance,) = q.meterOf(feed);
        assertEq(balance, 3e18 - COST);
        endowQ.spend(feed, COST);
        zapQ.spend(feed, COST);
        _sameMeter();

        vm.startPrank(user);
        s = q.fund(feed, 1e18 + 7);
        assertEq(endowQ.fund(feed, 1e18 + 7), s);
        assertEq(zapQ.fundFor(feed, 1e18 + 7, user), s);
        vm.stopPrank();
        _sameMeter();
        assertEq(endowQ.sharesOf(feed, user), q.sharesOf(feed, user));
        assertEq(zapQ.sharesOf(feed, user), q.sharesOf(feed, user));
        assertEq(endowQ.sharesOf(feed, heir), q.sharesOf(feed, heir));
        assertEq(zapQ.sharesOf(feed, heir), q.sharesOf(feed, heir));

        vm.startPrank(heir);
        uint256 out = q.defund(feed, 1e18);
        assertEq(endowQ.defund(feed, 1e18), out);
        out = q.defund(feed, type(uint256).max);
        assertEq(endowQ.defund(feed, type(uint256).max), out);
        vm.stopPrank();
        (balance,) = q.meterOf(feed);
        (uint256 b2, uint256 t2) = endowQ.meterOf(feed);
        (, uint256 total) = q.meterOf(feed);
        assertEq(b2, balance);
        assertEq(t2, total);
    }

    /// @dev A meter spent to exactly zero: the real contract retires the old shares before the next
    /// funding, and so do the stand-ins.
    function test_questions_aMeterSpentToZeroRetiresItsSharesOnAllThree() public {
        _newMockQuestions();
        vm.startPrank(user);
        q.fund(feed, COST);
        endowQ.fund(feed, COST);
        zapQ.fundFor(feed, COST, user);
        vm.stopPrank();
        _request(feed);
        endowQ.spend(feed, COST);
        zapQ.spend(feed, COST);
        _sameMeter();
        (uint256 balance,) = q.meterOf(feed);
        assertEq(balance, 0);

        vm.startPrank(heir);
        imd.mint(heir, 10e18);
        uint256 s = q.fund(feed, 2e18);
        assertEq(s, 2e18, "a fresh start: one share per wei");
        assertEq(endowQ.fund(feed, 2e18), s);
        assertEq(zapQ.fundFor(feed, 2e18, heir), s);
        vm.stopPrank();
        _sameMeter();
        assertEq(q.sharesOf(feed, user), 0);
        assertEq(endowQ.sharesOf(feed, user), 0);
        assertEq(zapQ.sharesOf(feed, user), 0);
    }
}
