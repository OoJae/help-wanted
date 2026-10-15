// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Payroll, IMeterPosition} from "../../../src/payroll/Payroll.sol";
import {ISeatAdapter} from "../../../src/interfaces/external/ISeatAdapter.sol";
import {MockIMD, MockSIMD} from "../mocks/MockTokens.sol";
import {MockSeats, MockAdapter} from "../mocks/MockSeats.sol";
import {IQuestions} from "../../../src/interfaces/IQuestions.sol";
import {QuestionsRig, Rig} from "../mocks/QuestionsRig.sol";

using Rig for QuestionsRig;

/// @dev Drives Payroll through every public action in random order, with seats changing hands, seats
/// whose owner cannot be read, agents bound, unbound and bound elsewhere, a Questions contract that
/// is at times down, refusing, or taking less than offered, a stranger who funds and defunds the house
/// meters, and an sIMD vault that at times has no stakers.
///
/// The handler checks each call against what it should have done and records the first disagreement in
/// `broken`, because a failed assertion inside a handler would only be swallowed as a revert. It also
/// keeps its own tally of money in, of what each seat owner should have received, and of every tip
/// with the time it arrived, for the invariant contract to compare with the chain.
contract PayrollHandler is Test {
    uint256 public constant SEAT_COUNT = 7;
    uint256 public constant AGENT_COUNT = 6;
    uint256 internal constant TIP_DELAY = 180 days;

    /// @dev One tip credited to one agent, as the handler saw it arrive.
    struct TipNote {
        uint256 at;
        uint256 amount;
    }

    Payroll public immutable payroll;
    MockIMD public immutable imd;
    MockSIMD public immutable simd;
    MockSeats public immutable seats;
    MockAdapter public immutable adapter;
    QuestionsRig public immutable questions;

    bytes32[3] public feeds;
    address[4] public owners;

    /// @dev The first thing a call did that it should not have. Empty while all is well.
    string public broken;
    /// @dev Every IMD that entered Payroll: `pay`, `tip` and plain transfers.
    uint256 public moneyIn;
    /// @dev What sIMD's balance rose by across all drips.
    uint256 public reachedStakers;
    /// @dev What each seat owner should hold, from seat claims and tips.
    mapping(address owner => uint256) public expectedBalance;
    /// @dev What the staker put into and took out of sIMD after set-up.
    uint256 public vaultIn;
    uint256 public vaultOut;
    bool internal questionsDown;
    /// @dev True while a top-up cannot go through whole: Questions is down or refuses `fund`, or the
    /// token moves only half of what a top-up pulls.
    bool internal topUpsDisturbed;

    address internal immutable staker;
    address internal immutable stranger = makeAddr("a stranger who funds meters");

    /// @dev Every tip still owed to an agent, oldest first: `_notes[agent][_head[agent] ...]`.
    mapping(uint256 agent => TipNote[]) internal _notes;
    mapping(uint256 agent => uint256) internal _head;

    constructor(
        Payroll payroll_,
        MockIMD imd_,
        MockSIMD simd_,
        MockSeats seats_,
        MockAdapter adapter_,
        QuestionsRig questions_,
        bytes32[3] memory feeds_,
        address[4] memory owners_,
        address staker_
    ) {
        staker = staker_;
        payroll = payroll_;
        imd = imd_;
        simd = simd_;
        seats = seats_;
        adapter = adapter_;
        questions = questions_;
        feeds = feeds_;
        owners = owners_;
    }

    // ---------------------------------------------------------------------------------------------
    // Money in
    // ---------------------------------------------------------------------------------------------

    function pay(uint256 amount) external {
        amount = bound(amount, 0, 1_000_000e18);
        imd.mint(address(this), amount);
        imd.approve(address(payroll), amount);
        Payroll.Ledger memory a = payroll.ledger();
        payroll.pay(amount, bytes32("handler"));
        Payroll.Ledger memory b = payroll.ledger();
        moneyIn += amount;

        uint256 released = b.feedsReleased - a.feedsReleased;
        if (released != 0) _flag("a booking released feed budget");
        if (b.received - a.received != amount) _flag("pay booked a different amount");
        if (b.toSeats - a.toSeats != (amount * 3_000) / 10_000) _flag("seat share is not 30%");
        if (b.toFeeds + released - a.toFeeds != (amount * 2_000) / 10_000) _flag("feed share is not 20%");
        if (b.toStakers - a.toStakers - released != amount - (amount * 3_000) / 10_000 - (amount * 2_000) / 10_000) {
            _flag("staker share is not the rest");
        }
    }

    function transferPlainly(uint256 amount) external {
        amount = bound(amount, 0, 100_000e18);
        imd.mint(address(payroll), amount);
        moneyIn += amount;
    }

    function book() external {
        uint256 waiting = payroll.unbooked();
        uint256 received = payroll.ledger().received;
        uint256 releasedBefore = payroll.ledger().feedsReleased;
        uint256 booked = payroll.book();
        if (booked != waiting) _flag("book did not book exactly what was waiting");
        if (payroll.ledger().received - received != booked) _flag("book changed received by another amount");
        if (payroll.unbooked() != 0) _flag("something was left unbooked");
        if (payroll.ledger().feedsReleased != releasedBefore) _flag("a booking released feed budget");
    }

    function tip(uint256 amount, uint256 seed, uint8 count) external {
        amount = bound(amount, 0, 100_000e18);
        uint256 n = bound(count, 0, 20);
        uint256[] memory list = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = uint256(keccak256(abi.encode(seed, i))) % AGENT_COUNT;
        }
        imd.mint(address(this), amount);
        imd.approve(address(payroll), amount);
        uint256 before = _tipsOwed() + payroll.ledger().tipsToSeats;
        uint256 received = payroll.ledger().received;
        payroll.tip(list, amount);
        moneyIn += amount;
        if (_tipsOwed() + payroll.ledger().tipsToSeats - before != amount) _flag("a tip was not fully accounted");
        if (payroll.ledger().received != received) _flag("a tip was booked as revenue");

        // The handler's own record: an equal share to each of the first sixteen ids.
        uint256 sharers = n > 16 ? 16 : n;
        uint256 share = sharers == 0 ? 0 : amount / sharers;
        if (share != 0) {
            for (uint256 i; i < sharers; ++i) {
                _notes[list[i]].push(TipNote(vm.getBlockTimestamp(), share));
            }
        }
        for (uint256 a; a < AGENT_COUNT; ++a) {
            if (payroll.tipOwed(a) != _noted(a)) _flag("an agent is owed something other than its tips");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Money out
    // ---------------------------------------------------------------------------------------------

    function drip() external {
        (,,,, uint256 nextDripAt, uint256 dueNow) = payroll.stream();
        uint256 cap = payroll.dripCap();
        uint256 before = imd.balanceOf(address(simd));
        try payroll.drip() returns (uint256 sent) {
            if (vm.getBlockTimestamp() < nextDripAt) _flag("a drip went through inside the ten-minute gap");
            if (sent > cap) _flag("a drip sent more than one hour of stream");
            if (sent != dueNow) _flag("drip and the stream view disagree");
            if (imd.balanceOf(address(simd)) - before != sent) _flag("sIMD did not receive what was dripped");
            reachedStakers += sent;
            if (sent != 0 && simd.totalSupply() == 0) _flag("a drip went to a vault nobody holds");
        } catch {
            // The view never promises what `drip` refuses: when it says something is due, the call
            // goes through. A drip may fail only inside the ten-minute gap, or because sIMD has no
            // stakers while money has vested, and in both cases the view says nothing is due.
            if (dueNow != 0) _flag("drip reverted although the stream view said something was due");
            bool vaultWaits = simd.totalSupply() == 0;
            if (vm.getBlockTimestamp() >= nextDripAt && !vaultWaits) _flag("drip reverted outside the ten-minute gap");
        }
    }

    function claimSeat(uint256 seat) external {
        seat = bound(seat, 0, SEAT_COUNT); // SEAT_COUNT itself is not a seat
        uint256[] memory before = _claimables();
        if (seat == SEAT_COUNT) {
            try payroll.claimSeat(seat) {
                _flag("an id that is not a seat was claimed");
            } catch {}
            return;
        }
        (bool readable, address owner) = _ownerOf(seat);
        uint256 ownerBefore = imd.balanceOf(owner);
        try payroll.claimSeat(seat) returns (uint256 paid) {
            if (paid != before[seat]) _flag("a claim paid something other than the seat's share");
            if (paid != 0 && !readable) _flag("a seat without a readable owner was paid");
            if (readable) {
                if (imd.balanceOf(owner) - ownerBefore != paid) _flag("the seat's owner did not receive the claim");
                expectedBalance[owner] += paid;
            }
        } catch {
            if (readable || before[seat] == 0) _flag("a claim reverted for a seat that could be paid");
        }
        uint256[] memory afterwards = _claimables();
        for (uint256 s; s < SEAT_COUNT; ++s) {
            if (s == seat) {
                if (readable && afterwards[s] != 0) _flag("a paid seat still shows a share");
                if (!readable && afterwards[s] != before[s]) _flag("an unpaid seat lost part of its share");
            } else if (afterwards[s] != before[s]) {
                _flag("a claim moved another seat's share");
            }
        }
    }

    function claimSeats(uint256 seed, uint8 length) external {
        uint256 n = bound(length, 0, 10);
        uint256[] memory list = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = uint256(keccak256(abi.encode(seed, i))) % (SEAT_COUNT + 2); // two ids are not seats
        }

        uint256[] memory before = _claimables();
        uint256[4] memory ownerBefore;
        uint256[4] memory due;
        bool[] memory paidSeat = new bool[](SEAT_COUNT);
        uint256 total;
        for (uint256 i; i < 4; ++i) {
            ownerBefore[i] = imd.balanceOf(owners[i]);
        }
        for (uint256 i; i < n; ++i) {
            uint256 seat = list[i];
            if (seat >= SEAT_COUNT || paidSeat[seat] || before[seat] == 0) continue;
            (bool readable, address owner) = _ownerOf(seat);
            if (!readable) continue;
            paidSeat[seat] = true;
            due[_ownerIndex(owner)] += before[seat];
            total += before[seat];
        }

        uint256 paid = payroll.claimSeats(list);

        if (paid != total) _flag("a batch paid something other than the listed seats' shares");
        for (uint256 i; i < 4; ++i) {
            if (imd.balanceOf(owners[i]) - ownerBefore[i] != due[i]) _flag("a batch paid an owner the wrong amount");
            expectedBalance[owners[i]] += due[i];
        }
        uint256[] memory afterwards = _claimables();
        for (uint256 s; s < SEAT_COUNT; ++s) {
            if (paidSeat[s] ? afterwards[s] != 0 : afterwards[s] != before[s]) {
                _flag("a batch moved a share it should not have");
            }
        }
    }

    function claimTip(uint256 agent) external {
        agent = bound(agent, 0, AGENT_COUNT - 1);
        uint256 owedBefore = payroll.tipOwed(agent);
        (bool claimable, address owner) = _tipPayee(agent);
        uint256 ownerBefore = imd.balanceOf(owner);
        try payroll.claimTip(agent) returns (uint256 paid) {
            if (paid != owedBefore) _flag("a tip claim paid something other than what was owed");
            if (paid != 0) {
                if (!claimable) _flag("a tip was paid without a seat binding");
                if (imd.balanceOf(owner) - ownerBefore != paid) {
                    _flag("the bound seat's owner did not receive the tip");
                }
                if (payroll.tipOwed(agent) != 0) _flag("a paid tip is still owed");
                if (paid != _noted(agent)) _flag("a tip claim paid something other than the agent's tips");
                expectedBalance[owner] += paid;
                _head[agent] = _notes[agent].length;
            }
        } catch {
            if (owedBefore == 0 || claimable) _flag("a tip claim reverted although it could be paid");
            if (payroll.tipOwed(agent) != owedBefore) _flag("a failed tip claim changed what is owed");
        }
    }

    function sweepTip(uint256 agent) external {
        agent = bound(agent, 0, AGENT_COUNT - 1);
        uint256 owedBefore = payroll.tipOwed(agent);
        (bool claimable,) = _tipPayee(agent);
        uint256 poolBefore = payroll.seatAccrued() * SEAT_COUNT + payroll.seatCarry();

        // By the handler's own record: the tips whose wait is over (they arrived two 180-day periods
        // back or more). They are the oldest, so they are the first notes.
        uint256 period = vm.getBlockTimestamp() / TIP_DELAY;
        TipNote[] storage notes = _notes[agent];
        uint256 ripe;
        uint256 firstWaiting = _head[agent];
        while (firstWaiting < notes.length && notes[firstWaiting].at / TIP_DELAY + 2 <= period) {
            ripe += notes[firstWaiting].amount;
            ++firstWaiting;
        }
        (uint256 unpaid, uint256 sweepable,) = payroll.tipOf(agent);
        if (unpaid != owedBefore || sweepable != ripe) _flag("the tip view disagrees with the tips that arrived");

        try payroll.sweepTip(agent) returns (uint256 swept) {
            if (swept != ripe) _flag("a sweep moved something other than the tips that had waited");
            if (swept != 0) {
                if (claimable) _flag("a claimable tip was swept");
                for (uint256 i = _head[agent]; i < firstWaiting; ++i) {
                    if (vm.getBlockTimestamp() - notes[i].at < TIP_DELAY) _flag("a tip was swept before 180 days");
                }
                if (payroll.seatAccrued() * SEAT_COUNT + payroll.seatCarry() - poolBefore != swept) {
                    _flag("a swept tip did not all reach the seat pool");
                }
                _head[agent] = firstWaiting;
            } else if (owedBefore != 0) {
                _flag("a sweep of tips that are owed returned nothing without reverting");
            }
            if (payroll.tipOwed(agent) != owedBefore - swept) _flag("a sweep changed what is owed by another amount");
            for (uint256 i = _head[agent]; i < notes.length; ++i) {
                if (vm.getBlockTimestamp() - notes[i].at >= 2 * TIP_DELAY) {
                    _flag("a tip outlived 360 days and a sweep");
                }
            }
        } catch {
            if (owedBefore == 0) _flag("a sweep of nothing reverted");
            if (ripe != 0 && !claimable) _flag("a sweep reverted although it was due");
            if (payroll.tipOwed(agent) != owedBefore) _flag("a failed sweep changed what is owed");
        }
    }

    function fundFeeds() external {
        (uint256 budget,, uint256 due,) = payroll.feedBudget();
        uint256 metersBefore = _meters();
        uint256 stakersBefore = payroll.ledger().toStakers;
        uint256[3] memory ownBefore = _positions();
        try payroll.fundFeeds() returns (uint256 funded, uint256 released) {
            if (funded + released > budget) _flag("more left the feed budget than it held");
            if (released > due) _flag("more was released than had fallen due");
            if (!questionsDown && _meters() - metersBefore != funded) _flag("meters did not receive what was funded");
            if (payroll.ledger().toStakers - stakersBefore != released) _flag("released budget did not reach stakers");
            if (questionsDown && funded != 0) _flag("an unreachable Questions was funded");
            if (payroll.feedBudgetDue() != 0) _flag("something due was neither placed nor released");
            if (!questionsDown) {
                // Payroll never holds more than one runway on a meter because of a top-up, at a cost
                // of at most 2 IMD a request, whatever anybody else holds there.
                uint256[3] memory own = _positions();
                for (uint256 i; i < 3; ++i) {
                    uint256 runway = (i == 2 ? 4 : 14) * 2e18;
                    if (own[i] > ownBefore[i] && own[i] > runway) _flag("a top-up took Payroll past its runway");
                }
            }
            // The meters come first. When every top-up can go through, budget is released (beyond
            // the wei a proportional split rounds off) only if no meter still lacks anything.
            if (!topUpsDisturbed && released > 2) {
                uint256[3] memory needs = payroll.feedShortfalls();
                if (needs[0] + needs[1] + needs[2] != 0) _flag("budget was released past a meter that lacked it");
            }
        } catch {
            _flag("fundFeeds reverted");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // The world changing around Payroll
    // ---------------------------------------------------------------------------------------------

    /// @dev Mostly days (the stream and the feed fortnights), sometimes months (the tips' 180 days).
    /// At least one block passes too, which ends the hold sIMD puts on whoever staked in this one.
    function wait(uint256 time) external {
        time = bound(time, 1, time % 3 == 0 ? 200 days : 20 days);
        skip(time);
        vm.roll(vm.getBlockNumber() + 1 + time / 12);
    }

    function moveSeat(uint256 seat, uint256 ownerIndex) external {
        seats.setOwner(bound(seat, 0, SEAT_COUNT - 1), owners[ownerIndex % 4]);
    }

    function breakSeat(uint256 seat, bool on) external {
        seats.setReverting(bound(seat, 0, SEAT_COUNT - 1), on);
    }

    function bindAgent(uint256 agent, uint256 mode, uint256 seat) external {
        agent = bound(agent, 0, AGENT_COUNT - 1);
        mode = mode % 4;
        if (mode == 0) adapter.unbind(agent);
        else if (mode == 1) adapter.bind(agent, address(seats), seat % SEAT_COUNT);
        else if (mode == 2) adapter.bind(agent, address(0x0717E12), seat % SEAT_COUNT);
        else adapter.bind(agent, address(seats), SEAT_COUNT + (seat % 3));
    }

    function changeQuestions(uint256 mode, uint256 cost) external {
        mode = mode % 5;
        questionsDown = mode == 1;
        topUpsDisturbed = mode == 1 || mode == 2 || mode == 3;
        // The real Questions is cut off at its address: everything (mode 1) or `fund` alone (mode 2).
        vm.clearMockedCalls();
        if (mode == 1) {
            _refuse(IQuestions.costOf.selector);
            _refuse(IQuestions.meterOf.selector);
            _refuse(IQuestions.sharesOf.selector);
            _refuse(IQuestions.defund.selector);
            _refuse(IMeterPosition.redeemable.selector);
        }
        if (mode == 1 || mode == 2) _refuse(IQuestions.fund.selector);
        // The token disturbs the pull of a top-up: half of it moves (mode 3), or Payroll is called
        // back in the middle of it (mode 4).
        imd.setTakeBps(mode == 3 ? 5_000 : 10_000);
        imd.setReenter(mode == 4);
        if (mode != 1) {
            cost = bound(cost, 0, 3e18);
            for (uint256 i; i < 3; ++i) {
                questions.setCost(feeds[i], cost);
            }
        }
    }

    function _refuse(bytes4 selector) internal {
        vm.mockCallRevert(
            address(questions), abi.encodeWithSelector(selector), abi.encodeWithSelector(QuestionsRig.Down.selector)
        );
    }

    function spendMeter(uint256 feedIndex, uint256 amount) external {
        questions.spend(feeds[feedIndex % 3], bound(amount, 0, 5e18));
    }

    /// @dev Somebody else puts IMD on a house meter. It is not Payroll's runway: Payroll must still
    /// keep a position of its own there (see `fundFeeds` above).
    function fundMeterAsStranger(uint256 feedIndex, uint256 amount) external {
        if (questionsDown) return;
        amount = bound(amount, 1, 30e18);
        imd.mint(stranger, amount);
        vm.startPrank(stranger);
        imd.approve(address(questions), amount);
        try questions.fund(feeds[feedIndex % 3], amount) {} catch {}
        imd.approve(address(questions), 0);
        vm.stopPrank();
    }

    /// @dev And takes some of it back, which must not touch what Payroll holds on the meter.
    function defundMeterAsStranger(uint256 feedIndex, uint256 shares) external {
        if (questionsDown) return;
        bytes32 feed = feeds[feedIndex % 3];
        uint256 held = questions.sharesOf(feed, stranger);
        if (held == 0) return;
        shares = bound(shares, 1, held);
        uint256 metersBefore = _meters();
        uint256 payrollBefore = imd.balanceOf(address(payroll));
        uint256 ownBefore = questions.redeemable(feed, address(payroll));
        vm.prank(stranger);
        uint256 got = questions.defund(feed, shares);
        if (metersBefore - _meters() != got) _flag("a defund moved another amount off the meters");
        if (imd.balanceOf(address(payroll)) != payrollBefore) _flag("a stranger's defund touched Payroll's IMD");
        if (questions.redeemable(feed, address(payroll)) < ownBefore) {
            _flag("a stranger's defund lowered Payroll's position on a meter");
        }
    }

    /// @dev Every staker leaves sIMD: until somebody stakes again the stream must wait in Payroll.
    function emptyVault() external {
        uint256 shares = simd.balanceOf(staker);
        // Nobody leaves in the block they staked in.
        if (shares == 0 || simd.maxRedeem(staker) == 0) return;
        vm.prank(staker);
        vaultOut += simd.redeem(shares, staker, staker);
    }

    function refillVault(uint256 amount) external {
        if (simd.totalSupply() != 0) return;
        amount = bound(amount, 1e18, 1_000e18);
        imd.mint(staker, amount);
        vm.startPrank(staker);
        imd.approve(address(simd), amount);
        simd.deposit(amount, staker);
        vm.stopPrank();
        vaultIn += amount;
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _flag(string memory what) internal {
        if (bytes(broken).length == 0) broken = what;
    }

    function _claimables() internal view returns (uint256[] memory list) {
        list = new uint256[](SEAT_COUNT);
        for (uint256 s; s < SEAT_COUNT; ++s) {
            list[s] = payroll.seatClaimable(s);
        }
    }

    function _tipsOwed() internal view returns (uint256 sum) {
        for (uint256 a; a < AGENT_COUNT; ++a) {
            sum += payroll.tipOwed(a);
        }
    }

    function tipsOwed() external view returns (uint256) {
        return _tipsOwed();
    }

    /// @dev What the handler's record says an agent is owed.
    function _noted(uint256 agent) internal view returns (uint256 sum) {
        TipNote[] storage notes = _notes[agent];
        for (uint256 i = _head[agent]; i < notes.length; ++i) {
            sum += notes[i].amount;
        }
    }

    function notedTips() external view returns (uint256 sum) {
        for (uint256 a; a < AGENT_COUNT; ++a) {
            sum += _noted(a);
        }
    }

    /// @dev What Payroll could take back from each house meter. Zeros while Questions is cut off.
    function _positions() internal view returns (uint256[3] memory own) {
        if (questionsDown) return own;
        for (uint256 i; i < 3; ++i) {
            own[i] = questions.redeemable(feeds[i], address(payroll));
        }
    }

    function _meters() internal view returns (uint256 sum) {
        if (questionsDown) return 0;
        for (uint256 i; i < 3; ++i) {
            (uint256 balance,) = questions.meterOf(feeds[i]);
            sum += balance;
        }
    }

    function _ownerOf(uint256 seat) internal view returns (bool readable, address owner) {
        try seats.ownerOf(seat) returns (address o) {
            return (true, o);
        } catch {
            return (false, address(0));
        }
    }

    function _ownerIndex(address owner) internal view returns (uint256) {
        for (uint256 i; i < 4; ++i) {
            if (owners[i] == owner) return i;
        }
        revert("unknown owner");
    }

    function _seatOf(uint256 agent) internal view returns (bool boundToSeat, uint256 seat) {
        try adapter.bindingOf(agent) returns (ISeatAdapter.Binding memory b) {
            if (b.tokenContract == address(seats) && b.tokenId < SEAT_COUNT) return (true, b.tokenId);
        } catch {}
        return (false, 0);
    }

    function _tipPayee(uint256 agent) internal view returns (bool claimable, address owner) {
        (bool boundToSeat, uint256 seat) = _seatOf(agent);
        if (!boundToSeat) return (false, address(0));
        return _ownerOf(seat);
    }
}
