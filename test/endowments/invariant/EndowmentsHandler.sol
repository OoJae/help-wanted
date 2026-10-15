// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Endowments} from "../../../src/endowments/Endowments.sol";
import {MockCrowdPots} from "../mocks/MockCrowdPots.sol";
import {MockIMD} from "../mocks/MockIMD.sol";
import {MockQuestions} from "../mocks/MockQuestions.sol";
import {MockStakedIMD} from "../mocks/MockStakedIMD.sol";

/// @dev Drives Endowments the way strangers would: depositors come and go, anyone stakes and harvests,
/// yield arrives by plain transfer, someone else's sIMD lands on the contract and carries a hold with it,
/// a pot's need changes under it, the feed's meter is spent, refilled by somebody else and repriced, and
/// (only when `allowLoss` is set) the vault loses IMD.
///
/// The handler does two things beyond calling: it keeps its own books of who is owed what and of the
/// highest price a stake or harvest ran at, and whenever a call ends in a way the rules do not allow it
/// raises a flag the invariant tests assert is never set.
contract EndowmentsHandler is Test {
    bytes32 internal constant FEED = keccak256("robot-jobs-report");
    uint256 internal constant POT = 7;
    uint256 internal constant SERIES = 8;
    uint256 internal constant MAX_ENDOWMENTS = 7;
    uint256 internal constant ONE_SIMD = 1e24;

    Endowments public immutable endow;
    MockIMD public immutable imd;
    MockStakedIMD public immutable simd;
    MockQuestions public immutable questions;
    MockCrowdPots public immutable pots;
    bool public immutable allowLoss;

    address public recipient = makeAddr("recipient");
    address public heir = makeAddr("heir");
    address public stranger = makeAddr("stranger");
    address public creator = makeAddr("creator");
    address[] public actors;

    // ------------------------------------------------------------------------------ the handler's books

    /// @dev What each actor has put into each endowment and not yet given up.
    mapping(uint256 id => mapping(address actor => uint256)) public owed;
    /// @dev Principal each actor has given up over the whole run, and the IMD they were paid for it.
    mapping(address actor => uint256) public gaveUp;
    mapping(address actor => uint256) public gotBack;
    /// @dev An upper bound on shares that belong to no endowment: split dust and what strangers sent.
    uint256 public strayShareBound;
    /// @dev The highest sIMD price at which the handler saw a stake or a harvest go through.
    uint256 public peak;
    uint256 public stakes;
    uint256 public harvests;
    uint256 public exactWithdrawals;
    uint256 public inKindExits;
    uint256 public shortExits;
    uint256 public losses;

    // ------------------------------------------------------------------------------ flags (must stay unset)

    /// @dev An exact withdrawal was refused in a block with no hold, from an endowment that was whole.
    bool public exactWithdrawalRefused;
    /// @dev A withdrawal paid a different amount than it promised, or more than the principal given up.
    bool public wrongPayment;
    /// @dev An in-kind exit was refused, or handed over shares worth less than the principal given up.
    bool public inKindRefused;
    /// @dev A harvest ran on a short endowment, left an endowment short, or was refused for no reason.
    bool public harvestBroken;
    /// @dev A leaver from a short endowment got more than their proportional part, or left the rest worse off.
    bool public unfairExit;
    /// @dev A short endowment accepted a deposit, or a whole one refused it.
    bool public depositGateBroken;
    /// @dev A stake ran when it was not due, or was refused when it was.
    bool public stakeGateBroken;
    /// @dev A stake or a harvest went through while the price was below one that an earlier one ran at.
    bool public ranBelowPeak;
    /// @dev An endowment read whole and still would not pay some part of a depositor's principal in full.
    bool public wholeNotExact;
    /// @dev A pot harvest took out more than the pot said it still needed.
    bool public potOverfed;
    /// @dev The fallback was paid although the pot was taking chips and had room for all it was sent.
    bool public fallbackPaidNeedlessly;
    /// @dev A meter harvest took out more than the meter had room for under the runway, or left the
    /// meter holding more than the runway.
    bool public meterOverfilled;
    /// @dev A meter endowment was created for a feed with no stated cost, or refused for one that has one.
    bool public meterGateBroken;

    uint256 public meterHarvests;
    /// @dev Meter harvests that were cut to what the meter had room for.
    uint256 public meterHarvestsCut;
    /// @dev Meter harvests refused because the meter had no room worth a harvest.
    uint256 public meterHarvestsWaiting;

    constructor(bool allowLoss_) {
        allowLoss = allowLoss_;
        vm.roll(20_000_000);

        imd = new MockIMD();
        simd = new MockStakedIMD(address(imd));
        // sIMD as it stood at mainnet block 26,164,296.
        simd.seed(makeAddr("whale"), 229085987734110772074526144065);
        imd.mint(address(simd), 1824332924627773926954268);

        questions = new MockQuestions(address(imd));
        questions.addFeed(FEED);
        pots = new MockCrowdPots(address(imd));
        pots.open(POT, 50e18);
        pots.openSeries(SERIES, 30e18);
        endow = new Endowments(address(imd), address(simd), address(questions), address(pots));

        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
        actors.push(makeAddr("dave"));
        for (uint256 i = 0; i < actors.length; ++i) {
            imd.mint(actors[i], 1_000_000_000e18);
            vm.prank(actors[i]);
            imd.approve(address(endow), type(uint256).max);
        }
        imd.mint(creator, 1e18);
        imd.mint(stranger, 1_000e18);
        vm.prank(stranger);
        imd.approve(address(simd), type(uint256).max);

        vm.startPrank(creator);
        imd.approve(address(endow), type(uint256).max);
        endow.createForMeter(FEED);
        endow.createForPot(POT, heir);
        endow.createForRecipient(recipient);
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 1);
    }

    // ------------------------------------------------------------------------------ actions

    function deposit(uint256 actorSeed, uint256 idSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 id = _id(idSeed);
        amount = bound(amount, 1, 2_000_000e18);
        bool whole = endow.isWhole(id);

        vm.prank(actor);
        try endow.deposit(id, amount) {
            if (!whole) depositGateBroken = true;
            owed[id][actor] += amount;
        } catch {
            if (whole) depositGateBroken = true;
        }
    }

    function donate(uint256 actorSeed, uint256 idSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 id = _id(idSeed);
        amount = bound(amount, 1, 1_000e18);
        vm.prank(actor);
        endow.donate(id, amount);
    }

    function create(uint256 kindSeed) external {
        if (endow.endowmentCount() >= MAX_ENDOWMENTS) return;
        vm.startPrank(creator);
        uint256 kind = kindSeed % 4;
        if (kind == 0) {
            // A meter endowment can be created exactly while Questions states a cost for the feed.
            bool live = questions.cost() != 0;
            try endow.createForMeter(FEED) {
                if (!live) meterGateBroken = true;
            } catch {
                if (live) meterGateBroken = true;
            }
        } else if (kind == 1) {
            endow.createForPot(POT, heir);
        } else if (kind == 2) {
            endow.createForRecipient(recipient);
        } else {
            endow.createForPot(SERIES, heir);
        }
        vm.stopPrank();
    }

    /// @dev `hurry` moves to the first block in which a stake is allowed, so batches really happen.
    function stake(bool hurry) external {
        if (hurry && vm.getBlockNumber() < endow.nextStakeBlock()) vm.roll(endow.nextStakeBlock());
        uint256 buffer = endow.pendingTotal();
        uint256 price = simd.convertToAssets(ONE_SIMD);
        // Due when the interval has passed, there is something to stake and the price has not fallen.
        bool due = vm.getBlockNumber() >= endow.nextStakeBlock() && buffer != 0 && price >= peak;
        try endow.stake() {
            if (!due) stakeGateBroken = true;
            if (price < peak) ranBelowPeak = true;
            else peak = price;
            ++stakes;
            // Each endowment can lose under one share-wei to the split of this batch.
            strayShareBound += endow.endowmentCount();
        } catch {
            if (due) stakeGateBroken = true;
        }
    }

    function roll(uint256 blocks) external {
        vm.roll(vm.getBlockNumber() + bound(blocks, 1, 60));
    }

    /// @dev Yield, the way sIMD receives it: a plain transfer of IMD to the vault. Up to 3% at a time.
    function earn(uint256 bps) external {
        imd.mint(address(simd), simd.totalAssets() * bound(bps, 0, 300) / 10_000);
    }

    /// @dev Someone causes a one-block hold on the endowments contract: either by minting sIMD and
    /// sending a little of it over, or by depositing a little into sIMD in the contract's name.
    function strangerSendsShares(uint256 amount, bool inOurName) external {
        amount = bound(amount, 1, 1e12);
        vm.startPrank(stranger);
        if (inOurName) {
            strayShareBound += simd.previewDeposit(amount);
            simd.deposit(amount, address(endow));
        } else {
            simd.deposit(1e15, stranger);
            simd.transfer(address(endow), amount);
            strayShareBound += amount;
        }
        vm.stopPrank();
    }

    function setPot(uint256 needs, bool reverts) external {
        pots.open(POT, bound(needs, 0, 100e18));
        pots.setMode(reverts ? MockCrowdPots.Mode.Reverts : MockCrowdPots.Mode.Normal);
    }

    /// @dev A round of the feed is bought: the meter holds less, so it has room again.
    function meterSpends(uint256 amount) external {
        uint256 held = questions.meterBalance(FEED);
        if (held == 0) return;
        questions.spend(FEED, bound(amount, 1, held));
    }

    /// @dev Somebody else puts IMD of their own on the meter, as anyone may, and takes the room.
    function strangerFundsMeter(uint256 amount) external {
        amount = bound(amount, 1, 20e18);
        vm.startPrank(stranger);
        imd.approve(address(questions), amount);
        questions.fund(FEED, amount);
        vm.stopPrank();
    }

    /// @dev The Intake's price moves, or it stops selling (one time in eight), and with it the runway.
    function repriceFeed(uint256 cost) external {
        questions.setCost(cost % 8 == 0 ? 0 : bound(cost, 0.01e18, 3e18));
    }

    function lose(uint256 bps) external {
        if (!allowLoss) return;
        simd.lose(simd.totalAssets() * bound(bps, 1, 2_500) / 10_000);
        ++losses;
    }

    /// @dev Takes principal back as IMD. From a whole endowment this must pay exactly, and may only be
    /// refused by a hold. From a short one the plain `withdraw` must refuse and `exit` must pay a fair part.
    /// `sameBlock` keeps the call in the current block, where a hold may be active; otherwise it happens
    /// one block later.
    function withdraw(uint256 actorSeed, uint256 idSeed, uint256 amount, bool everything, bool sameBlock) external {
        if (!sameBlock) vm.roll(vm.getBlockNumber() + 1);
        (address actor, uint256 id) = _depositor(actorSeed, idSeed);
        uint256 mine = endow.principalOf(id, actor);
        if (mine == 0) return;
        amount = everything ? mine : bound(amount, 1, mine);

        (uint256 quoted,, bool exact) = endow.quote(id, amount, false);
        (,,, uint256 principal, uint256 buffered,,) = endow.endowment(id);
        uint256 backing = endow.backingOf(id);
        uint256 balance = imd.balanceOf(actor);
        if (!exact && endow.isWhole(id)) wholeNotExact = true;
        bool held = vm.getBlockNumber() == endow.lastStakeBlock()
            || simd.lastDepositBlock(address(endow)) == vm.getBlockNumber();

        if (exact) {
            vm.prank(actor);
            try endow.withdraw(id, amount) {
                if (imd.balanceOf(actor) != balance + amount) wrongPayment = true;
                _settleBooks(id, actor, amount, amount);
                ++exactWithdrawals;
            } catch {
                // The only excuse: sIMD is needed and is holding this contract in this block.
                if (!(held && amount > buffered)) exactWithdrawalRefused = true;
            }
            return;
        }

        vm.prank(actor);
        try endow.withdraw(id, amount) {
            // A short endowment paid in full through the strict door only if its slice happens to be whole.
            if (imd.balanceOf(actor) != balance + amount) wrongPayment = true;
            _settleBooks(id, actor, amount, amount);
            return;
        } catch {}

        vm.prank(actor);
        try endow.exit(id, amount, 0, false) returns (uint256 imdOut, uint256 sharesOut) {
            if (sharesOut != 0 || imdOut != quoted || imd.balanceOf(actor) != balance + imdOut) wrongPayment = true;
            if (imdOut > amount) wrongPayment = true;
            // No more than the leaver's proportional part of what the endowment held.
            if (imdOut > backing * amount / principal + 2) unfairExit = true;
            // Those who stay are covered at least as well as before (two wei of conversion rounding).
            if ((endow.backingOf(id) + 2) * principal < backing * (principal - amount)) unfairExit = true;
            _settleBooks(id, actor, amount, imdOut);
            ++shortExits;
        } catch {
            if (!held) exactWithdrawalRefused = true;
        }
    }

    /// @dev Takes principal back as sIMD shares. No hold can refuse this.
    function exitInKind(uint256 actorSeed, uint256 idSeed, uint256 amount, bool everything) external {
        (address actor, uint256 id) = _depositor(actorSeed, idSeed);
        uint256 mine = endow.principalOf(id, actor);
        if (mine == 0) return;
        amount = everything ? mine : bound(amount, 1, mine);

        (uint256 quotedImd, uint256 quotedShares, bool exact) = endow.quote(id, amount, true);
        uint256 imdBefore = imd.balanceOf(actor);
        uint256 sharesBefore = simd.balanceOf(actor);

        vm.prank(actor);
        try endow.exit(id, amount, exact ? amount : 0, true) returns (uint256 imdOut, uint256 sharesOut) {
            if (imdOut != quotedImd || sharesOut != quotedShares) wrongPayment = true;
            if (imd.balanceOf(actor) != imdBefore + imdOut || simd.balanceOf(actor) != sharesBefore + sharesOut) {
                wrongPayment = true;
            }
            uint256 worth = imdOut + simd.convertToAssets(sharesOut);
            if (exact && worth < amount) inKindRefused = true;
            if (worth > amount + 1) wrongPayment = true;
            _settleBooks(id, actor, amount, imdOut);
            ++inKindExits;
        } catch {
            inKindRefused = true;
        }
    }

    /// @dev What the handler reads for itself before a harvest, without asking the contract what it
    /// would do: what there is to take, and what the target has room for.
    struct Reading {
        bool whole;
        bool held;
        bool isMeter;
        bool potTakes;
        Endowments.Kind kind;
        uint256 expected;
        uint256 targetsHeld;
        uint256 heirHeld;
        uint256 price;
        uint256 yieldNow;
        // A pot endowment: what the pot says it still needs. Zero for the other kinds.
        uint256 potRoom;
        // A meter endowment: the runway at the feed's cost today, what the meter holds, and the room left.
        uint256 meterFull;
        uint256 meterHeld;
        uint256 meterRoom;
    }

    function harvest(uint256 idSeed, bool sameBlock) external {
        _harvest(_id(idSeed), sameBlock);
    }

    /// @dev A harvest aimed at the first meter endowment (id 1), and a deposit into it, so that every
    /// run meets the runway often: a meter is only one endowment in several.
    function harvestMeter(bool sameBlock) external {
        _harvest(1, sameBlock);
    }

    function depositToMeter(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = bound(amount, 1e18, 200_000e18);
        bool whole = endow.isWhole(1);
        vm.prank(actor);
        try endow.deposit(1, amount) {
            if (!whole) depositGateBroken = true;
            owed[1][actor] += amount;
        } catch {
            if (whole) depositGateBroken = true;
        }
    }

    function _harvest(uint256 id, bool sameBlock) internal {
        if (!sameBlock) vm.roll(vm.getBlockNumber() + 1);
        Reading memory r = _read(id);

        try endow.harvest(id) returns (uint256 sent) {
            if (!r.whole || r.expected == 0 || sent != r.expected) harvestBroken = true;
            if (!endow.isWhole(id)) harvestBroken = true;
            if (_targetsHold() != r.targetsHeld + sent) harvestBroken = true;
            if (sent > r.yieldNow) harvestBroken = true;
            if (r.price < peak) ranBelowPeak = true;
            else peak = r.price;
            if (r.potRoom != 0) {
                if (sent > r.potRoom) potOverfed = true;
                if (r.potTakes && imd.balanceOf(heir) != r.heirHeld) fallbackPaidNeedlessly = true;
            }
            if (r.isMeter) {
                uint256 meterNow = questions.meterBalance(FEED);
                if (sent > r.meterRoom || meterNow > r.meterFull) meterOverfilled = true;
                // All of it reached the meter, and it is all the yield or all the room, whichever is less.
                if (meterNow != r.meterHeld + sent) harvestBroken = true;
                if (sent != (r.yieldNow < r.meterRoom ? r.yieldNow : r.meterRoom)) harvestBroken = true;
                ++meterHarvests;
                if (sent < r.yieldNow) ++meterHarvestsCut;
            }
            ++harvests;
        } catch {
            if (r.expected != 0 && !r.held && r.kind != Endowments.Kind.None) harvestBroken = true;
            // Worked out without asking the contract: yield worth a harvest, no hold, no fall in price,
            // and, for a meter, room worth a harvest.
            uint256 least = endow.MIN_HARVEST();
            bool hasRoom = !r.isMeter || r.meterRoom >= least;
            if (r.yieldNow >= least && !r.held && r.price >= peak && hasRoom) harvestBroken = true;
            if (!hasRoom && r.yieldNow >= least) ++meterHarvestsWaiting;
        }
    }

    function _read(uint256 id) internal view returns (Reading memory r) {
        r.whole = endow.isWhole(id);
        r.expected = endow.harvestable(id);
        bytes32 target;
        (r.kind, target,,,,,) = endow.endowment(id);
        r.targetsHeld = _targetsHold();
        r.heirHeld = imd.balanceOf(heir);
        r.held = vm.getBlockNumber() == endow.lastStakeBlock()
            || simd.lastDepositBlock(address(endow)) == vm.getBlockNumber();
        r.price = simd.convertToAssets(ONE_SIMD);
        r.yieldNow = _yieldOf(id);
        r.potRoom = r.kind == Endowments.Kind.Pot ? pots.remaining(uint256(target)) : 0;
        r.potTakes = pots.mode() == MockCrowdPots.Mode.Normal;
        r.isMeter = r.kind == Endowments.Kind.Meter;
        r.meterHeld = questions.meterBalance(FEED);
        r.meterFull = questions.cost() * endow.METER_RUNWAY();
        r.meterRoom = r.meterFull > r.meterHeld ? r.meterFull - r.meterHeld : 0;
    }

    // ------------------------------------------------------------------------------ readers for the tests

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    /// @dev IMD that has reached a target or a fallback.
    function targetsHold() external view returns (uint256) {
        return _targetsHold();
    }

    function _targetsHold() internal view returns (uint256) {
        return imd.balanceOf(recipient) + imd.balanceOf(heir) + imd.balanceOf(address(questions))
            + imd.balanceOf(address(pots));
    }

    /// @dev The yield of `id` beyond its principal and the margin, by the handler's own arithmetic.
    function _yieldOf(uint256 id) internal view returns (uint256) {
        (,,, uint256 principal, uint256 buffered, uint256 shares,) = endow.endowment(id);
        uint256 keep = endow.MARGIN() + (principal > buffered ? simd.previewWithdraw(principal - buffered) : 0);
        return shares > keep ? simd.previewRedeem(shares - keep) : 0;
    }

    function _settleBooks(uint256 id, address actor, uint256 principal, uint256 imdOut) internal {
        owed[id][actor] -= principal;
        gaveUp[actor] += principal;
        gotBack[actor] += imdOut;
    }

    /// @dev Picks an actor and an endowment, moving on from the seeds to the first pair that actually has
    /// principal, so that withdrawals are not wasted on empty positions.
    function _depositor(uint256 actorSeed, uint256 idSeed) internal view returns (address actor, uint256 id) {
        uint256 count = endow.endowmentCount();
        for (uint256 i = 0; i < count; ++i) {
            id = 1 + (idSeed % count + i) % count;
            for (uint256 j = 0; j < actors.length; ++j) {
                actor = actors[(actorSeed % actors.length + j) % actors.length];
                if (endow.principalOf(id, actor) != 0) return (actor, id);
            }
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _id(uint256 seed) internal view returns (uint256) {
        return 1 + seed % endow.endowmentCount();
    }
}
