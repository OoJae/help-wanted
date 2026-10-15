// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Zap} from "../../src/rules/Zap.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockPots} from "./mocks/MockPots.sol";
import {MockPoolManager} from "./mocks/MockPoolManager.sol";
import {MockQuestions} from "./mocks/MockQuestions.sol";

/// @dev For calls that set no time limit.
uint256 constant NO_DEADLINE = type(uint256).max;

/// @dev A caller that cannot be sent ETH. It passes the ETH it is given on to Zap, and whatever Zap
/// credits or sends is this contract's.
contract Relay {
    function chipIn(Zap zap, uint256 potId, uint256 minOut, uint256 deadline)
        external
        payable
        returns (uint256, uint256)
    {
        return zap.chipIn{value: msg.value}(potId, minOut, deadline);
    }

    function fundMeter(Zap zap, bytes32 feedId, uint256 minOut, uint256 deadline)
        external
        payable
        returns (uint256, uint256)
    {
        return zap.fundMeter{value: msg.value}(feedId, minOut, deadline);
    }

    function buy(Zap zap, uint256 minOut, uint256 deadline) external payable returns (uint256) {
        return zap.buy{value: msg.value}(minOut, deadline);
    }
}

/// @dev Calls Zap in random order with random prices, pool depths, pots, feeds and deadlines, through
/// wallets and through a contract that cannot be sent ETH, and now and then pushes IMD or ETH into
/// Zap from outside or lets time pass. After every call into Zap it checks that Zap kept nothing of
/// the caller's, and that no call ran after its deadline.
contract ZapHandler is Test {
    Zap public immutable zap;
    MockIMD public immutable imd;
    MockPots public immutable pots;
    MockQuestions public immutable questions;
    MockPoolManager public immutable pool;
    Relay public immutable relay;

    /// @dev Three wallets. A fourth caller is `relay`, which a wallet pays to call Zap for it.
    address[3] public users = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    uint256[] public potIds;
    /// @dev The second feed was never opened: funding it is refused.
    bytes32[2] public feedIds = [keccak256("feed:open"), keccak256("feed:never-opened")];

    /// @dev IMD and ETH pushed into Zap from outside and not yet passed on to a caller.
    uint256 public strayImd;
    uint256 public strayEth;
    bool public keptSomethingOfACallers;
    /// @dev Set if a call went through although the block was later than the deadline it carried.
    bool public ranPastItsDeadline;

    uint256 public ethDealtTotal;
    uint256 public ethSpentTotal;
    uint256 public imdBoughtTotal;
    uint256 public chippedTotal;
    uint256 public fundedTotal;
    uint256 public strayImdTotal;
    uint256 public strayEthTotal;
    mapping(bytes32 => uint256) public calls;

    constructor(Zap zap_, MockIMD imd_, MockPots pots_, MockQuestions questions_, MockPoolManager pool_) {
        zap = zap_;
        imd = imd_;
        pots = pots_;
        questions = questions_;
        pool = pool_;
        relay = new Relay();
        potIds.push(pots.open(1_000_000e18));
        questions.open(feedIds[0]);
    }

    function openPot(uint256 needs) external {
        if (potIds.length >= 16) return;
        // From pots a single chip fills to pots that never fill.
        potIds.push(pots.open(bound(uint256(keccak256(abi.encode(needs))), 0, 200_000e18)));
    }

    function setPrice(uint256 rate) external {
        pool.setRate(bound(uint256(keccak256(abi.encode(rate))), 1e16, 5_000e18));
    }

    function setDepth(uint256 fill) external {
        // Mostly deep; otherwise the pool runs dry somewhere below one ETH, or is empty.
        if (fill % 3 != 0) pool.setMaxEthFill(type(uint256).max);
        else pool.setMaxEthFill(fill % 27 == 0 ? 0 : bound(uint256(keccak256(abi.encode(fill))), 1, 1 ether));
    }

    function pushImd(uint256 amount) external {
        amount = bound(amount, 1, 5e18);
        imd.mint(address(zap), amount);
        strayImd += amount;
        strayImdTotal += amount;
    }

    function passTime(uint256 secs) external {
        skip(bound(secs, 1, 1 days));
    }

    function pushEth(uint256 amount) external {
        amount = bound(amount, 1, 0.1 ether);
        vm.deal(address(zap), address(zap).balance + amount);
        strayEth += amount;
        strayEthTotal += amount;
    }

    /// @dev One call the handler is about to make: who pays, whether the relay makes the call for
    /// them, how much ETH goes with it, and the seed the minimum and the deadline are drawn from.
    struct Ask {
        address user;
        bool viaRelay;
        uint256 ethIn;
        uint256 minSeed;
        uint256 poolEthBefore;
    }

    /// @dev How it ended: whether it went through, the IMD the swap produced, and the second figure
    /// the entry point returned (what the pot took, or the meter shares credited).
    struct Answer {
        bool ok;
        uint256 imdOut;
        uint256 second;
    }

    /// @param callerSeed Picks the wallet that pays, and whether it calls Zap itself or through
    /// the relay (one call in four).
    function chipIn(uint256 callerSeed, uint256 potSeed, uint256 ethIn, uint256 minSeed) external {
        Ask memory q = _ask(callerSeed, ethIn, minSeed);
        uint256 potId = potIds[potSeed % potIds.length];
        uint256 potsImdBefore = imd.balanceOf(address(pots));

        Answer memory r = _callChipIn(q, potId);
        if (r.ok) {
            _served(q.viaRelay, q.ethIn, q.poolEthBefore, r.imdOut);
            chippedTotal += r.second;
            if (imd.balanceOf(address(pots)) - potsImdBefore != r.second) keptSomethingOfACallers = true;
            calls["chipIn"]++;
        } else {
            calls["chipIn.reverted"]++;
        }
        _checkZap();
    }

    function fundMeter(uint256 callerSeed, uint256 feedSeed, uint256 ethIn, uint256 minSeed) external {
        Ask memory q = _ask(callerSeed, ethIn, minSeed);
        // The feed that exists nine times in ten.
        bytes32 feedId = feedIds[feedSeed % 10 == 0 ? 1 : 0];
        address owner = q.viaRelay ? address(relay) : q.user;
        uint256 meterImdBefore = imd.balanceOf(address(questions));
        uint256 sharesBefore = questions.sharesOf(feedId, owner);

        Answer memory r = _callFundMeter(q, feedId);
        if (r.ok) {
            _served(q.viaRelay, q.ethIn, q.poolEthBefore, r.imdOut);
            fundedTotal += r.imdOut;
            // The whole of what was bought is on the meter, and the shares are the caller's.
            if (imd.balanceOf(address(questions)) - meterImdBefore != r.imdOut) keptSomethingOfACallers = true;
            if (r.second == 0 || questions.sharesOf(feedId, owner) - sharesBefore != r.second) {
                keptSomethingOfACallers = true;
            }
            calls["fundMeter"]++;
        } else {
            calls["fundMeter.reverted"]++;
        }
        if (questions.sharesOf(feedId, address(zap)) != 0) keptSomethingOfACallers = true;
        _checkZap();
    }

    function buy(uint256 callerSeed, uint256 ethIn, uint256 minSeed) external {
        Ask memory q = _ask(callerSeed, ethIn, minSeed);

        Answer memory r = _callBuy(q);
        if (r.ok) {
            _served(q.viaRelay, q.ethIn, q.poolEthBefore, r.imdOut);
            calls["buy"]++;
        } else {
            calls["buy.reverted"]++;
        }
        _checkZap();
    }

    function _ask(uint256 callerSeed, uint256 ethIn, uint256 minSeed) private returns (Ask memory q) {
        (q.user, q.viaRelay) = _caller(callerSeed);
        q.ethIn = _deal(q.user, ethIn);
        q.minSeed = minSeed;
        q.poolEthBefore = address(pool).balance;
    }

    /// @dev The three calls themselves. The minimum and the deadline are worked out before the
    /// prank, because reading the pool's rate and the clock are calls too.
    function _callChipIn(Ask memory q, uint256 potId) private returns (Answer memory r) {
        uint256 minimum = _minimum(q.ethIn, q.minSeed);
        (uint256 deadline, bool passed) = _deadline(q.minSeed);
        vm.prank(q.user);
        if (q.viaRelay) {
            try relay.chipIn{value: q.ethIn}(zap, potId, minimum, deadline) returns (uint256 a, uint256 b) {
                (r.ok, r.imdOut, r.second) = (true, a, b);
            } catch {}
        } else {
            try zap.chipIn{value: q.ethIn}(potId, minimum, deadline) returns (uint256 a, uint256 b) {
                (r.ok, r.imdOut, r.second) = (true, a, b);
            } catch {}
        }
        if (r.ok && passed) ranPastItsDeadline = true;
    }

    function _callFundMeter(Ask memory q, bytes32 feedId) private returns (Answer memory r) {
        uint256 minimum = _minimum(q.ethIn, q.minSeed);
        (uint256 deadline, bool passed) = _deadline(q.minSeed);
        vm.prank(q.user);
        if (q.viaRelay) {
            try relay.fundMeter{value: q.ethIn}(zap, feedId, minimum, deadline) returns (uint256 a, uint256 b) {
                (r.ok, r.imdOut, r.second) = (true, a, b);
            } catch {}
        } else {
            try zap.fundMeter{value: q.ethIn}(feedId, minimum, deadline) returns (uint256 a, uint256 b) {
                (r.ok, r.imdOut, r.second) = (true, a, b);
            } catch {}
        }
        if (r.ok && passed) ranPastItsDeadline = true;
    }

    function _callBuy(Ask memory q) private returns (Answer memory r) {
        uint256 minimum = _minimum(q.ethIn, q.minSeed);
        (uint256 deadline, bool passed) = _deadline(q.minSeed);
        vm.prank(q.user);
        if (q.viaRelay) {
            try relay.buy{value: q.ethIn}(zap, minimum, deadline) returns (uint256 a) {
                (r.ok, r.imdOut) = (true, a);
            } catch {}
        } else {
            try zap.buy{value: q.ethIn}(minimum, deadline) returns (uint256 a) {
                (r.ok, r.imdOut) = (true, a);
            } catch {}
        }
        if (r.ok && passed) ranPastItsDeadline = true;
    }

    function _caller(uint256 seed) private view returns (address user, bool viaRelay) {
        user = users[seed % 3];
        viaRelay = (seed / 3) % 4 == 0;
    }

    /// @dev The fuzzer favours tiny numbers; spread them so most calls move a real amount, and keep a
    /// share of zero-value and few-wei calls.
    function _deal(address user, uint256 x) private returns (uint256 ethIn) {
        if (x % 10 == 0) ethIn = 0;
        else if (x % 10 == 1) ethIn = x % 1000;
        else ethIn = bound(uint256(keccak256(abi.encode(x))), 1e12, 2 ether);
        vm.deal(user, user.balance + ethIn);
        ethDealtTotal += ethIn;
    }

    /// @dev Usually a minimum the swap can meet, sometimes one it cannot.
    function _minimum(uint256 ethIn, uint256 seed) private view returns (uint256) {
        uint256 fill = pool.maxEthFill();
        uint256 quote = (ethIn < fill ? ethIn : fill) * pool.rate() / 1e18;
        if (seed % 5 == 0) return quote + 1 + seed % 1e18;
        return quote * (seed % 101) / 100;
    }

    /// @dev Mostly no time limit. One seed in seven carries a deadline one second in the past, which
    /// must stop the call, and one in seven carries this very second, which must not. Worked out
    /// before the prank, like the minimum.
    function _deadline(uint256 seed) private returns (uint256 deadline, bool passed) {
        uint256 nowIs = vm.getBlockTimestamp();
        if (seed % 7 == 3) {
            calls["deadline.passed"]++;
            return (nowIs - 1, true);
        }
        if (seed % 7 == 4) {
            calls["deadline.thisSecond"]++;
            return (nowIs, false);
        }
        return (NO_DEADLINE, false);
    }

    /// @dev Bookkeeping for a call that went through. The stray IMD always leaves with it. The stray
    /// ETH leaves with it when the caller can be sent ETH; the relay cannot, and a call through the
    /// relay goes through only when the pool used every wei, so nothing of the relay's stays either.
    function _served(bool viaRelay, uint256 ethIn, uint256 poolEthBefore, uint256 imdOut) private {
        uint256 spent = address(pool).balance - poolEthBefore;
        if (viaRelay) {
            if (spent != ethIn) keptSomethingOfACallers = true;
            calls["relay"]++;
            if (strayEth != 0) calls["relay.pastStrayEth"]++;
        } else {
            strayEth = 0;
        }
        strayImd = 0;
        ethSpentTotal += spent;
        imdBoughtTotal += imdOut;
    }

    /// @dev Whatever a call did, Zap holds only what was pushed in from outside and not yet passed
    /// on: never a wei that a caller sent or bought, and never an allowance.
    function _checkZap() private {
        if (imd.balanceOf(address(zap)) != strayImd || address(zap).balance != strayEth) {
            keptSomethingOfACallers = true;
        }
        if (imd.allowance(address(zap), address(pots)) != 0) keptSomethingOfACallers = true;
        if (imd.allowance(address(zap), address(questions)) != 0) keptSomethingOfACallers = true;
        if (address(relay).balance != 0) keptSomethingOfACallers = true;
    }
}

/// @dev Handler-based invariants for Zap: it never holds a caller's funds between calls.
/// forge-config: default.invariant.depth = 120
contract ZapInvariantTest is Test {
    MockIMD internal imd;
    MockPoolManager internal pool;
    MockPots internal pots;
    MockQuestions internal questions;
    Zap internal zap;
    ZapHandler internal handler;

    function setUp() public {
        imd = new MockIMD();
        pool = new MockPoolManager(address(imd));
        pots = new MockPots(address(imd));
        questions = new MockQuestions(address(imd));
        zap = new Zap(address(imd), address(pool), address(pots), address(questions));
        imd.mint(address(pool), 1_000_000_000e18);
        handler = new ZapHandler(zap, imd, pots, questions, pool);
        targetContract(address(handler));
    }

    /// @dev After every call into Zap, its IMD and ETH balances are zero apart from what somebody
    /// pushed in from outside and no caller has yet been able to take along: IMD leaves with the
    /// next call that goes through, ETH with the next one made by a caller that can be sent ETH.
    /// Zap never holds an allowance or a meter share.
    function invariant_zapKeepsNothingOfACallers() public view {
        assertFalse(handler.keptSomethingOfACallers(), "Zap kept funds, an allowance or shares after a call");
        assertFalse(handler.ranPastItsDeadline(), "a call went through after the deadline it carried");
        assertEq(imd.balanceOf(address(zap)), handler.strayImd());
        assertEq(address(zap).balance, handler.strayEth());
        assertEq(imd.allowance(address(zap), address(pots)), 0);
        assertEq(imd.allowance(address(zap), address(questions)), 0);
    }

    /// @dev Every wei of IMD the pool paid out is in a pot, on a meter or with a caller; every wei of
    /// ETH the pool holds was spent by a caller.
    function invariant_everyWeiIsAccountedFor() public view {
        uint256 withCallers = imd.balanceOf(address(handler.relay()));
        uint256 ethWithUsers;
        for (uint256 i; i < 3; ++i) {
            withCallers += imd.balanceOf(handler.users(i));
            ethWithUsers += handler.users(i).balance;
        }
        assertEq(address(pool).balance, handler.ethSpentTotal());
        assertEq(imd.balanceOf(address(pots)), handler.chippedTotal());
        assertEq(imd.balanceOf(address(questions)), handler.fundedTotal());
        assertEq(
            handler.imdBoughtTotal() + handler.strayImdTotal(),
            imd.balanceOf(address(pots)) + imd.balanceOf(address(questions)) + withCallers + imd.balanceOf(address(zap))
        );
        // The callers were given exactly the ETH they sent. What the pool did not use, and whatever
        // was pushed into Zap from outside, is with them again or waiting for the next call.
        assertEq(
            ethWithUsers + address(zap).balance + handler.ethSpentTotal(),
            handler.ethDealtTotal() + handler.strayEthTotal()
        );
    }

    function invariant_callSummary() public {
        emit log_named_uint("chipIn", handler.calls("chipIn"));
        emit log_named_uint("chipIn reverted", handler.calls("chipIn.reverted"));
        emit log_named_uint("fundMeter", handler.calls("fundMeter"));
        emit log_named_uint("fundMeter reverted", handler.calls("fundMeter.reverted"));
        emit log_named_uint("buy", handler.calls("buy"));
        emit log_named_uint("buy reverted", handler.calls("buy.reverted"));
        emit log_named_uint("served through the relay", handler.calls("relay"));
        emit log_named_uint("  of which with stray ETH waiting in Zap", handler.calls("relay.pastStrayEth"));
        emit log_named_uint("calls that carried a deadline already passed", handler.calls("deadline.passed"));
        emit log_named_uint("calls that carried this very second", handler.calls("deadline.thisSecond"));
    }

    /// @dev A fixed walk through every handler path, so each one is certainly exercised whatever
    /// the random runs choose: every entry point from a wallet and through the relay, stray IMD and
    /// ETH, a pool that runs dry, a feed that does not exist.
    function test_scriptedWalk_everyPathThenEveryInvariant() public {
        // callerSeed 3 is a wallet calling Zap itself; callerSeed 0 is a wallet paying the relay to call.
        handler.chipIn(3, 0, 5, 1);
        handler.fundMeter(3, 1, 5, 1);
        handler.buy(3, 5, 1);
        _allInvariants();

        handler.pushImd(3e18);
        handler.pushEth(7);
        handler.chipIn(0, 0, 5, 1); // through the relay: goes through, the stray ETH stays
        assertEq(handler.strayEth(), 7);
        assertEq(handler.strayImd(), 0);
        handler.fundMeter(0, 1, 5, 1);
        handler.buy(0, 5, 1);
        assertEq(handler.calls("relay.pastStrayEth"), 3);
        _allInvariants();

        handler.buy(3, 5, 1); // a wallet takes the stray ETH along
        assertEq(handler.strayEth(), 0);
        _allInvariants();

        handler.fundMeter(3, 0, 5, 1); // the feed that was never opened
        assertEq(handler.calls("fundMeter.reverted"), 1);
        pool.setMaxEthFill(1e9); // the pool now runs dry long before any amount the handler sends
        handler.buy(0, 5, 1); // through the relay: owed a refund it cannot take
        assertEq(handler.calls("buy.reverted"), 1);
        handler.buy(3, 5, 1); // a wallet takes the refund
        handler.setDepth(1); // deep again
        handler.openPot(1);
        handler.setPrice(1);
        handler.chipIn(3, 1, 5, 5); // a minimum that cannot be met
        _allInvariants();

        assertEq(handler.calls("chipIn"), 2);
        assertEq(handler.calls("fundMeter"), 2);
        assertEq(handler.calls("buy"), 4);
        assertEq(handler.calls("chipIn.reverted"), 1);

        // Deadlines. minSeed 3 carries the second before this one and minSeed 4 this very second.
        handler.passTime(1 hours);
        handler.chipIn(3, 0, 5, 3);
        handler.fundMeter(3, 1, 5, 3);
        handler.buy(3, 5, 3);
        handler.buy(0, 5, 3); // through the relay
        assertEq(handler.calls("chipIn.reverted"), 2);
        assertEq(handler.calls("fundMeter.reverted"), 2);
        assertEq(handler.calls("buy.reverted"), 3);
        handler.chipIn(3, 0, 5, 4);
        handler.fundMeter(3, 1, 5, 4);
        handler.buy(3, 5, 4);
        assertEq(handler.calls("chipIn"), 3);
        assertEq(handler.calls("fundMeter"), 3);
        assertEq(handler.calls("buy"), 5);
        assertEq(handler.calls("deadline.passed"), 4);
        assertEq(handler.calls("deadline.thisSecond"), 3);
        _allInvariants();
    }

    function _allInvariants() internal view {
        invariant_zapKeepsNothingOfACallers();
        invariant_everyWeiIsAccountedFor();
    }
}
