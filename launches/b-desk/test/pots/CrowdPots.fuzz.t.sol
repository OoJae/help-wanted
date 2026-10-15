// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {PotsBase} from "./PotsBase.sol";

contract CrowdPotsFuzzTest is PotsBase {
    uint256 internal constant MAX_CROWD = 9;

    address[] internal crowd;

    function setUp() public override {
        super.setUp();
        for (uint256 i; i < MAX_CROWD; ++i) {
            address who = makeAddr(string.concat("crowd", vm.toString(i)));
            crowd.push(who);
            imd.mint(who, type(uint96).max);
            vm.prank(who);
            imd.approve(address(pots), type(uint256).max);
        }
    }

    function _next(uint256 seed) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed)));
    }

    /// @dev Splits `target` between `n` contributors in uneven, mostly unround parts (some may be
    /// zero) and chips them in. Returns each contributor's chip.
    function _crowdfund(uint256 potId, uint256 target, uint256 n, uint256 seed)
        internal
        returns (uint256[] memory chips)
    {
        chips = new uint256[](n);
        uint256 left = target;
        for (uint256 i; i < n; ++i) {
            seed = _next(seed);
            uint256 part = i == n - 1 ? left : bound(seed, 0, left);
            chips[i] = part;
            left -= part;
            if (part != 0) assertEq(_chip(crowd[i], potId, part), part);
        }
    }

    /// @dev Claims for everyone in an order drawn from `seed`, checking each payout as it goes.
    function _claimAllShuffled(uint256 potId, uint256[] memory chips, uint256 raised, uint256 refundable, uint256 seed)
        internal
        returns (uint256 total)
    {
        uint256 n = chips.length;
        uint256[] memory order = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            order[i] = i;
        }
        for (uint256 i = n; i > 1; --i) {
            seed = _next(seed);
            uint256 j = seed % i;
            (order[i - 1], order[j]) = (order[j], order[i - 1]);
        }

        for (uint256 k; k < n; ++k) {
            address who = crowd[order[k]];
            uint256 chip = chips[order[k]];
            uint256 before = imd.balanceOf(who);
            uint256 preview = pots.refundOf(potId, who);
            uint256 paid = _claim(potId, who);

            assertEq(paid, preview, "the view said what the claim would pay");
            assertEq(imd.balanceOf(who) - before, paid, "what was reported is what arrived");
            assertGe(paid, chip * refundable / raised, "never below the rounded-down fair share");
            assertLe(paid, chip * refundable / raised + n, "never more than a few wei above it");
            if (chip == 0) assertEq(paid, 0);
            total += paid;
        }
    }

    function _assertPotIsEmpty(uint256 potId) internal view {
        CrowdPots.Pot memory p = pots.potOf(potId);
        assertEq(p.pool, 0, "nothing left in the pool");
        assertEq(p.chipsLeft, 0, "everyone claimed");
        assertEq(pots.owed(), 0, "nothing owed");
        assertEq(imd.balanceOf(address(pots)), 0, "no dust left behind");
    }

    // ------------------------------------------------------------------------------------------

    /// @dev Whatever the sequence of chips, each is cut to what is missing, the pot never holds
    /// more than its target, and the sum of the chips is what was raised.
    function testFuzz_chipsAreCutAndAddUpToWhatWasRaised(uint96 target, uint96[6] memory amounts, uint8 forMask)
        public
    {
        CrowdPots.Terms memory t = _terms();
        t.target = uint96(bound(target, 1e18, 1_000_000e18));
        t.minPay = t.target;
        uint256 potId = _open(t);

        uint256 raised;
        uint256[] memory credited = new uint256[](MAX_CROWD);
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 0, uint256(t.target) * 2);
            uint256 missing = t.target - raised;
            uint256 expected = amount < missing ? amount : missing;
            address payer = crowd[i];
            uint256 owner = ((forMask >> i) & 1) == 1 ? (i + 3) % MAX_CROWD : i;
            uint256 before = imd.balanceOf(payer);

            assertEq(pots.remaining(potId), missing);
            vm.prank(payer);
            uint256 taken = pots.chipInFor(potId, amount, crowd[owner]);

            assertEq(taken, expected, "cut to what is missing");
            assertEq(before - imd.balanceOf(payer), expected, "and no more is pulled");
            raised += taken;
            credited[owner] += taken;
        }

        uint256 sum;
        for (uint256 i; i < MAX_CROWD; ++i) {
            (uint256 chip,,) = pots.chipOf(potId, crowd[i]);
            assertEq(chip, credited[i]);
            sum += chip;
        }
        assertEq(sum, raised, "the chips add up to what was raised");
        assertEq(pots.potOf(potId).raised, raised);
        assertLe(raised, t.target);
        assertEq(imd.balanceOf(address(pots)), raised);
        assertEq(pots.owed(), raised);
    }

    /// @dev Terms drawn from a little beyond the allowed ranges: whatever `openPot` accepts, the
    /// desk accepts at launch. No pot can fill and then be unable to hire.
    function testFuzz_everyPotThatOpensCanHire(
        uint96 target,
        uint96 minPay,
        uint32 rampSecs,
        uint96 bond,
        uint32 deliverySecs,
        uint32 hireSecs,
        uint32 fundSecs,
        bool allowClaimed,
        uint32 launchAfter
    ) public {
        CrowdPots.Terms memory t;
        t.kind = KIND_TEXT;
        t.allowClaimed = allowClaimed;
        t.target = uint96(bound(target, 0.9e18, 1_000e18));
        t.hireSecs = uint32(bound(hireSecs, 20 hours, 31 days));
        t.fundSecs = uint32(bound(fundSecs, 50 minutes, 31 days));
        t.deliverySecs = uint32(bound(deliverySecs, 3 days - 4 hours, 31 days));
        t.bond = uint96(bound(bond, 0.24e18, uint256(t.target) + 0.1e18));
        if (minPay % 2 == 0) {
            // Half the time a fixed price, so that both shapes of pot are reached often.
            t.minPay = t.target;
        } else {
            t.minPay = uint96(bound(minPay, 0, uint256(t.target) + 0.1e18));
            t.rampSecs = uint32(bound(rampSecs, 0, uint256(t.hireSecs) + 1 hours));
        }

        vm.prank(opener);
        try pots.openPot(t, SPEC, 0) returns (uint256 potId) {
            assertGe(t.target, pots.MIN_TARGET());
            assertTrue(t.minPay != 0 && t.minPay <= t.target);
            assertTrue(t.bond >= desk.MIN_BOND() && t.bond <= t.target);
            assertTrue(t.deliverySecs >= desk.MIN_DELIVERY() && t.deliverySecs <= pots.MAX_DELIVERY_SECS());
            assertTrue(t.hireSecs >= pots.MIN_HIRE_SECS() && t.hireSecs <= pots.MAX_HIRE_SECS());
            assertTrue(t.fundSecs >= pots.MIN_FUND_SECS() && t.fundSecs <= pots.MAX_FUND_SECS());

            _chip(alice, potId, t.target);
            vm.warp(vm.getBlockTimestamp() + bound(launchAfter, 0, uint256(t.fundSecs) + pots.LAUNCH_GRACE()));
            uint256 orderId = _launch(potId);

            IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
            assertEq(o.maxPay, t.target);
            assertEq(o.minPay, t.minPay);
            assertEq(o.rampSecs, t.rampSecs);
            assertEq(o.bond, t.bond);
            assertEq(o.deliverySecs, t.deliverySecs);
            assertEq(o.expiresAt, vm.getBlockTimestamp() + t.hireSecs);
            assertEq(o.runnerOnly, address(0));
            assertEq(o.arbiter, address(0));
            assertEq(o.condTarget, address(0));
            assertEq(o.condCmp, 0);
            assertEq(imd.balanceOf(address(desk)), t.target);
            assertEq(pots.potOfOrder(orderId), potId);
        } catch {
            // Refused at the door: nothing was opened and nothing moved.
            assertEq(pots.potCount(), 0);
        }
    }

    /// @dev The same claim with terms drawn only from inside the allowed ranges, their edges
    /// included, so that every run opens a pot, fills it and reaches `launch`, at any moment up to
    /// the last second a full pot can be launched.
    function testFuzz_everyValidPotHires(
        uint96 target,
        uint96 minPay,
        uint32 rampSecs,
        uint96 bond,
        uint32 deliverySecs,
        uint32 hireSecs,
        uint32 fundSecs,
        bool allowClaimed,
        uint32 launchAfter
    ) public {
        CrowdPots.Terms memory t;
        t.kind = KIND_TEXT;
        t.allowClaimed = allowClaimed;
        t.target = uint96(bound(target, pots.MIN_TARGET(), 1_000_000e18));
        t.hireSecs = uint32(bound(hireSecs, pots.MIN_HIRE_SECS(), pots.MAX_HIRE_SECS()));
        t.fundSecs = uint32(bound(fundSecs, pots.MIN_FUND_SECS(), pots.MAX_FUND_SECS()));
        t.deliverySecs = uint32(bound(deliverySecs, desk.MIN_DELIVERY(), pots.MAX_DELIVERY_SECS()));
        t.bond = uint96(bound(bond, desk.MIN_BOND(), t.target));
        if (minPay % 2 == 0) {
            t.minPay = t.target;
        } else {
            t.minPay = uint96(bound(minPay, 1, uint256(t.target) - 1));
            t.rampSecs = uint32(bound(rampSecs, 1, t.hireSecs));
        }

        uint256 potId = _open(t);
        assertEq(_chip(alice, potId, t.target), t.target);
        vm.warp(vm.getBlockTimestamp() + bound(launchAfter, 0, uint256(t.fundSecs) + pots.LAUNCH_GRACE()));
        uint256 orderId = _launch(potId);

        IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
        assertEq(o.kindHash, KIND);
        assertEq(o.maxPay, t.target);
        assertEq(o.minPay, t.minPay);
        assertEq(o.rampSecs, t.rampSecs);
        assertEq(o.bond, t.bond);
        assertEq(o.deliverySecs, t.deliverySecs);
        assertEq(o.expiresAt, vm.getBlockTimestamp() + t.hireSecs);
        assertEq(o.flags, allowClaimed ? desk.FLAG_CALLBACK() | desk.FLAG_ALLOW_CLAIMED() : desk.FLAG_CALLBACK());
        assertEq(o.runnerOnly, address(0));
        assertEq(o.arbiter, address(0));
        assertEq(o.condTarget, address(0));
        assertEq(o.condCmp, 0);
        assertEq(imd.balanceOf(address(desk)), t.target);
        assertEq(imd.balanceOf(address(pots)), 0);
        assertEq(pots.owed(), 0);
        assertEq(pots.potOfOrder(orderId), potId);

        // And a runner can take the order the pot placed.
        _take(orderId, runner);
        _assertOrderState(orderId, IWorkOrders.State.Claimed);
    }

    /// @dev A pot that never hires gives every contributor exactly their chip, in any order.
    function testFuzz_anExpiredPotRefundsEveryChipExactly(uint96 target, uint96 raise, uint8 crowdSize, uint256 seed)
        public
    {
        CrowdPots.Terms memory t = _terms();
        t.target = uint96(bound(target, 1e18, 1_000_000e18));
        t.minPay = t.target;
        uint256 potId = _open(t);
        // Sometimes full, mostly not.
        uint256 raised = seed % 5 == 0 ? t.target : bound(raise, 1, t.target);
        uint256 n = bound(crowdSize, 1, MAX_CROWD);
        uint256[] memory chips = _crowdfund(potId, raised, n, seed);
        assertEq(pots.potOf(potId).raised, raised);

        // An unfilled pot is refundable right after its deadline; a full one that nobody launched,
        // once the time to launch it has passed too.
        if (raised == t.target) {
            vm.warp(_afterLaunchTime(potId) - 1);
            _assertLiveStage(potId, CrowdPots.Stage.Funding);
            vm.warp(_afterLaunchTime(potId));
        } else {
            vm.warp(pots.potOf(potId).deadline + 1);
        }
        uint256 total = _claimAllShuffled(potId, chips, raised, raised, _next(seed));

        assertEq(total, raised);
        for (uint256 i; i < n; ++i) {
            (, uint256 refunded,) = pots.chipOf(potId, crowd[i]);
            assertEq(refunded, chips[i], "exactly the chip");
            assertEq(imd.balanceOf(crowd[i]), type(uint96).max, "back where they started");
        }
        _assertPotIsEmpty(potId);
    }

    /// @dev A pot that hires: the price is fixed somewhere on a ramp, bonds or shares of bonds may
    /// be forfeited on the way in every manner the desk knows, and the order ends delivered,
    /// expired or in an undecided dispute. Whatever the desk sent back is shared out to the wei,
    /// in any order of claims, and nobody gets less than their rounded-down share.
    function testFuzz_whatTheDeskSendsBackIsSharedExactlyAndFairly(
        uint96 target,
        uint96 minPay,
        uint96 bond,
        uint8 crowdSize,
        uint32 claimAfter,
        uint8 forfeits,
        uint8 ending,
        uint256 seed
    ) public {
        CrowdPots.Terms memory t = _terms();
        t.allowClaimed = true;
        t.target = uint96(bound(target, 1e18, 1_000_000e18));
        t.minPay = uint96(bound(minPay, 1, t.target - 1));
        t.rampSecs = 10 days;
        t.hireSecs = 30 days;
        t.deliverySecs = 3 days;
        t.bond = uint96(bound(bond, 0.25e18, t.target));
        uint256 potId = _open(t);
        uint256 n = bound(crowdSize, 1, MAX_CROWD);
        uint256[] memory chips = _crowdfund(potId, t.target, n, seed);
        uint256 orderId = _launch(potId);

        // Up to three claims that end without a delivery, each leaving bond money with the pot.
        uint256 rounds = forfeits % 4;
        address[3] memory idlers = [runner2, challenger, stranger];
        // What the rules say each ending leaves with the pot, added up here and not asked of the desk.
        uint256 forfeited;
        for (uint256 i; i < rounds; ++i) {
            seed = _next(seed);
            forfeited += _endOneClaimWithoutDelivery(orderId, idlers[i], seed % 5, t.bond);
            assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring), "reopened, still hiring");
        }

        uint256 how = ending % 3;
        if (how == 0) {
            vm.warp(vm.getBlockTimestamp() + bound(claimAfter, 0, 11 days));
            _deliver(orderId);
        } else if (how == 1) {
            vm.warp(pots.potOf(potId).orderExpiresAt);
        } else {
            // A challenged delivery claim that nothing decides by the delivery deadline. The
            // challenger is somebody who has lost no bond on the way: the bond can be as large as
            // the target, and a wallet that forfeited one could not post a second.
            _dispute(orderId, runner, bob);
            vm.warp(vm.getBlockTimestamp() + 3 days);
            forfeited += t.bond / 10;
        }

        // Nobody calls the desk for the pot: reconciling is enough in every case.
        CrowdPots.Stage stage = pots.reconcile(potId);
        assertEq(uint256(stage), uint256(how == 0 ? CrowdPots.Stage.Delivered : CrowdPots.Stage.Refundable));
        (,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(orderId);
        assertEq(escrow, 0);
        assertEq(uint256(spent) + returned, uint256(t.target) + forfeited, "the desk's books add up");
        assertEq(pots.potOf(potId).pool, returned);
        assertEq(imd.balanceOf(address(pots)), returned, "the desk pushed what it reports");

        uint256 total = _claimAllShuffled(potId, chips, t.target, returned, _next(seed));
        assertEq(total, returned, "shared out to the wei");
        _assertPotIsEmpty(potId);
    }

    /// @dev One runner takes the order and loses it again, in one of the five ways a claim can
    /// end without a delivery while the order is still inside its hire window.
    /// @return forfeited What the ending leaves with the pot out of the idler's bond.
    function _endOneClaimWithoutDelivery(uint256 orderId, address idler, uint256 how, uint256 bond)
        internal
        returns (uint256 forfeited)
    {
        forfeited = how == 0 || how == 4 ? bond / 10 : bond;
        if (how == 0) {
            // Gives it back: a tenth of the bond to the pot.
            _take(orderId, idler);
            vm.prank(idler);
            desk.release(orderId);
        } else if (how == 1) {
            // Registers nothing: the whole bond.
            _take(orderId, idler);
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            desk.evict(orderId);
        } else if (how == 2) {
            // Registers a job and no receipt comes: the whole bond.
            _takeAndRegister(orderId, idler);
            vm.warp(vm.getBlockTimestamp() + 3 days);
            desk.timeout(orderId);
        } else if (how == 3) {
            // Claims delivery and a receipt contradicts it before anyone challenged: the whole bond.
            _takeAndRegister(orderId, idler);
            vm.prank(idler);
            desk.claimDelivered(orderId, RECEIPT);
            _reportFailed(orderId, false);
        } else {
            // Claims delivery, is challenged, and a receipt contradicts it: a tenth of the bond to
            // the pot, the rest to the challenger.
            _dispute(orderId, idler, runner);
            _reportFailed(orderId, false);
        }
    }

    /// @dev Two pots settle from one contract. Each pays its own contributors its own money, and
    /// the order in which the two are reconciled and claimed does not matter.
    function testFuzz_twoPotsSettleIndependently(uint96 targetA, uint96 targetB, uint32 claimAfter, uint256 seed)
        public
    {
        CrowdPots.Terms memory a = _rampTerms();
        a.target = uint96(bound(targetA, 5e18, 100_000e18));
        CrowdPots.Terms memory b = _terms();
        b.target = uint96(bound(targetB, 1e18, 100_000e18));
        b.minPay = b.target;

        uint256 potA = _open(a);
        uint256 potB = _open(b);
        uint256[] memory chipsA = _crowdfund(potA, a.target, 4, seed);
        uint256[] memory chipsB = _crowdfund(potB, b.target, 5, _next(seed));
        uint256 orderA = _launch(potA);
        uint256 orderB = _launch(potB);

        // A is delivered somewhere on its ramp; B's runner times out after expiry and forfeits.
        vm.warp(vm.getBlockTimestamp() + bound(claimAfter, 0, 2 days));
        _deliver(orderA);
        vm.warp(pots.potOf(potB).orderExpiresAt - 1);
        _takeAndRegister(orderB, runner2);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        desk.timeout(orderB);

        uint256 backA = _returned(orderA);
        uint256 backB = _returned(orderB);
        assertEq(backB, uint256(b.target) + b.bond);
        assertEq(imd.balanceOf(address(pots)), backA + backB);

        uint256 paidA;
        uint256 paidB;
        if (seed % 2 == 0) {
            paidA = _claimAllShuffled(potA, chipsA, a.target, backA, seed);
            assertEq(imd.balanceOf(address(pots)), backB, "B's money is untouched by A's claims");
            paidB = _claimAllShuffled(potB, chipsB, b.target, backB, seed);
        } else {
            paidB = _claimAllShuffled(potB, chipsB, b.target, backB, seed);
            assertEq(imd.balanceOf(address(pots)), backA, "A's money is untouched by B's claims");
            paidA = _claimAllShuffled(potA, chipsA, a.target, backA, seed);
        }
        assertEq(paidA, backA);
        assertEq(paidB, backB);
        assertEq(imd.balanceOf(address(pots)), 0);
        assertEq(pots.owed(), 0);
    }
}
