// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {Receipts} from "../kit/Receipts.sol";
import {RegistryStandIn} from "../kit/RegistryStandIn.sol";
import {MockIMD} from "./mocks/MockIMD.sol";

/// @notice Drives CrowdPots and the real desk through random lives of many pots at once:
/// contributors open pots and series and chip in, anyone launches, runners take orders and give
/// them back, sit on them, time out, deliver, claim delivery and get challenged, time passes,
/// strangers send IMD to the contract for no reason, and refunds are claimed in any order.
/// @dev Every action is steered towards a pot or an order it can act on, so few calls are wasted.
/// The handler keeps its own count of every chip and every refund for the invariants to compare.
/// Receipts are real work records carrying the order's header, proven by the real WorkProof.
contract PotsHandler is Receipts {
    bytes internal constant SPEC = "Research report: who paid the IdentityMD swarm this week, and for what?";
    string internal constant KIND = REAL_KIND;

    MockIMD public immutable imd;
    WorkOrders public immutable desk;
    CrowdPots public immutable pots;

    address[] internal _actors;
    address[] internal _runners;
    address public donor = makeAddr("donor");

    uint256[] internal _potIds;
    uint256[] internal _seriesIds;
    uint256 internal _seen;

    mapping(uint256 potId => uint256) public chipped;
    mapping(uint256 potId => mapping(address => uint256)) public chipGhost;
    mapping(uint256 potId => uint256) public refunded;
    mapping(uint256 potId => mapping(address => uint256)) public refundedTo;
    mapping(address => uint256) public totalRefundedTo;
    uint256 public totalChipped;
    uint256 public totalLaunched;
    uint256 public launches;
    uint256 public donated;
    uint256 public deliveries;
    uint256 public claimsPaid;

    mapping(uint256 potId => CrowdPots.Stage) public stageSeen;
    bool public stageWentBackwards;

    /// @dev The first thing an action saw that should never happen, or empty. It is kept here
    /// rather than asserted on the spot, because a revert inside a handler does not by itself
    /// fail an invariant run; `invariant_noActionSawAnythingWrong` reads it.
    string public violation;

    constructor(MockIMD imd_, WorkOrders desk_, CrowdPots pots_, RegistryStandIn registry_) {
        imd = imd_;
        desk = desk_;
        pots = pots_;
        registry = registry_;
        for (uint256 i; i < 5; ++i) {
            address who = makeAddr(string.concat("contributor", vm.toString(i)));
            _actors.push(who);
            imd.mint(who, 1e30);
            vm.prank(who);
            imd.approve(address(pots), type(uint256).max);
        }
        for (uint256 i; i < 3; ++i) {
            address who = makeAddr(string.concat("runner", vm.toString(i)));
            _runners.push(who);
            imd.mint(who, 1e30);
            vm.prank(who);
            imd.approve(address(desk), type(uint256).max);
        }
        imd.mint(donor, 1e30);
    }

    /// @dev After every action: note new pots and series, and check no pot's stage moved backwards.
    modifier tracked() {
        _;
        uint256 count = pots.potCount();
        for (uint256 id = _seen + 1; id <= count; ++id) {
            if (pots.potOf(id).stage == CrowdPots.Stage.Series) _seriesIds.push(id);
            else _potIds.push(id);
        }
        _seen = count;
        for (uint256 i; i < _potIds.length; ++i) {
            uint256 id = _potIds[i];
            CrowdPots.Stage was = stageSeen[id];
            CrowdPots.Stage current = pots.potOf(id).stage;
            if (!_mayFollow(was, current)) stageWentBackwards = true;
            stageSeen[id] = current;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------------------------------

    function openPot(uint256 seed, uint256 firstChip) external tracked {
        if (_potIds.length >= 24) return;
        seed = _mix(seed);
        CrowdPots.Terms memory t = _terms(seed);
        address opener = _actor(seed >> 16);
        firstChip = seed % 4 == 0 ? bound(firstChip, 0, uint256(t.target) * 2) : 0;
        vm.prank(opener);
        uint256 potId = pots.openPot(t, SPEC, firstChip);
        _noteChip(potId, opener, pots.potOf(potId).raised);
    }

    function openSeries(uint256 seed) external tracked {
        if (_seriesIds.length >= 3) return;
        vm.prank(_actor(seed >> 16));
        pots.openSeries(_terms(seed), SPEC);
    }

    function chip(uint256 potSeed, uint256 actorSeed, uint256 amount, uint256 mode) external tracked {
        mode = _mix(mode);
        actorSeed = _mix(actorSeed);
        address payer = _actor(actorSeed);
        address owner = mode % 3 == 0 ? _actor(actorSeed >> 16) : payer;
        uint256 id;
        if (mode % 4 == 0 && _seriesIds.length != 0) id = _seriesIds[potSeed % _seriesIds.length];
        else id = _pick(potSeed, CrowdPots.Stage.Funding);
        if (id == 0) return;

        // What the chip should be cut to, worked out here from the pot's own fields: what is
        // missing while the pot collects, and nothing once its deadline has passed.
        CrowdPots.Pot memory p = pots.potOf(id);
        uint256 need;
        if (p.stage == CrowdPots.Stage.Series) {
            need = pots.remaining(id);
            amount = mode % 3 == 1 ? need : bound(amount, 0, need * 2);
        } else {
            uint256 missing = uint256(p.target) - p.raised;
            need = vm.getBlockTimestamp() <= p.deadline ? missing : 0;
            _expect(pots.remaining(id) == need, "remaining() disagrees with the pot's own fields");
            // A third of the time exactly what is missing, otherwise anything up to twice that,
            // offered whether or not the pot still collects.
            amount = mode % 3 == 1 ? missing : bound(amount, 0, missing * 2);
        }
        uint256 expected = amount < need ? amount : need;

        uint256 before = imd.balanceOf(payer);
        vm.prank(payer);
        uint256 taken = owner == payer ? pots.chipIn(id, amount) : pots.chipInFor(id, amount, owner);
        _expect(taken == expected, "a chip was not cut to what was missing, or was taken after the deadline");
        _expect(before - imd.balanceOf(payer) == taken, "a chip pulled something other than what it reported");

        uint256 landed = p.stage == CrowdPots.Stage.Series ? pots.currentRound(id) : id;
        _noteChip(landed, owner, taken);
    }

    function launch(uint256 potSeed, uint256 actorSeed) external tracked {
        uint256 n = _potIds.length;
        for (uint256 i; i < n; ++i) {
            uint256 id = _potIds[(potSeed % n + i) % n];
            CrowdPots.Pot memory p = pots.potOf(id);
            // A full pot can be launched until a day after its deadline.
            bool inTime = vm.getBlockTimestamp() <= uint256(p.deadline) + pots.LAUNCH_GRACE();
            if (p.stage != CrowdPots.Stage.Funding || p.raised != p.target || !inTime) continue;
            vm.prank(_actor(actorSeed));
            pots.launch(id, SPEC);
            totalLaunched += p.target;
            ++launches;
            return;
        }
    }

    /// @dev Moves one hiring pot's order along, one to five steps, whichever way its state allows.
    function deskStep(uint256 potSeed, uint256 choice, uint256 who) external tracked {
        _deskSteps(potSeed, choice, who);
    }

    /// @dev The same action under two more names. The fuzzer calls every handler function equally
    /// often, and an order needs several steps to reach its end, so the desk gets three shares.
    function runnerStep(uint256 potSeed, uint256 choice, uint256 who) external tracked {
        _deskSteps(potSeed, choice, who);
    }

    function keeperStep(uint256 potSeed, uint256 choice, uint256 who) external tracked {
        _deskSteps(potSeed, choice, who);
    }

    function _deskSteps(uint256 potSeed, uint256 choice, uint256 who) internal {
        uint256 potId = _pick(potSeed, CrowdPots.Stage.Hiring);
        if (potId == 0) return;
        uint256 orderId = pots.potOf(potId).orderId;
        // The fuzzer favours small and extreme inputs; hashing spreads the choices evenly.
        choice = _mix(choice);
        uint256 steps = 1 + (choice >> 128) % 5;
        for (uint256 i; i < steps; ++i) {
            _deskStep(orderId, choice, who);
            choice = _mix(choice);
            who = _mix(who);
        }
    }

    /// @dev Opens a pot, fills it from one to three contributors and launches it, in one go, so
    /// that a run has many orders in flight at once.
    function fillAndLaunch(uint256 seed, uint256 actorSeed) external tracked {
        if (_potIds.length >= 24) return;
        CrowdPots.Terms memory t = _terms(seed);
        actorSeed = _mix(actorSeed);
        vm.prank(_actor(actorSeed));
        uint256 potId = pots.openPot(t, SPEC, 0);
        uint256 parts = 1 + actorSeed % 3;
        for (uint256 i; i < parts; ++i) {
            actorSeed = _mix(actorSeed);
            address payer = _actor(actorSeed);
            uint256 need = pots.remaining(potId);
            uint256 amount = i == parts - 1 ? need : bound(actorSeed >> 8, 0, need);
            vm.prank(payer);
            _noteChip(potId, payer, pots.chipIn(potId, amount));
        }
        vm.prank(_actor(actorSeed >> 16));
        pots.launch(potId, SPEC);
        totalLaunched += t.target;
        ++launches;
    }

    function _deskStep(uint256 orderId, uint256 choice, uint256 who) internal {
        IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
        IWorkOrdersRunner.Claim memory c = desk.claimOf(orderId);
        IWorkOrders.State s = o.state;

        if (s == IWorkOrders.State.Open) {
            if (vm.getBlockTimestamp() >= o.expiresAt) {
                desk.refund(orderId);
                return;
            }
            address runner = _runners[who % _runners.length];
            if (desk.barred(orderId, runner)) return;
            vm.prank(runner);
            desk.claim(orderId);
        } else if (s == IWorkOrders.State.Claimed) {
            // A runner can give the order back only inside the claim window; after it, the choice
            // to release becomes an eviction.
            bool canRelease = vm.getBlockTimestamp() < uint256(c.claimedAt) + desk.CLAIM_WINDOW();
            if (choice % 6 == 0 && canRelease) {
                vm.prank(c.runner);
                desk.release(orderId);
            } else if (choice % 6 <= 1) {
                _warpTo(uint256(c.claimedAt) + desk.CLAIM_WINDOW());
                desk.evict(orderId);
            } else {
                vm.prank(c.runner);
                desk.register(orderId, bytes16(keccak256(abi.encode(orderId, c.claimedAt))));
            }
        } else if (s == IWorkOrders.State.Registered) {
            uint256 deliverBy = uint256(c.registeredAt) + o.deliverySecs;
            bool canClaim = o.flags & desk.FLAG_ALLOW_CLAIMED() != 0
                && vm.getBlockTimestamp() + desk.CHALLENGE_WINDOW() + desk.DISPUTE_WINDOW() <= deliverBy;
            if (choice % 8 < 2 && canClaim) {
                vm.prank(c.runner);
                desk.claimDelivered(orderId, keccak256(abi.encode("claimed", orderId)));
            } else if (choice % 8 == 2) {
                _warpTo(deliverBy);
                desk.timeout(orderId);
            } else if (choice % 8 == 3) {
                // The swarm failed the runner's own job, which only the runner may report.
                bytes memory failed = _land(orderId, c.jobId, true, "blocked");
                vm.prank(c.runner);
                desk.reportFailed(orderId, failed, new address[](0));
            } else if (choice % 8 == 4) {
                desk.reportFailed(orderId, _land(orderId, c.jobId, false, "completed"), new address[](0));
            } else {
                desk.settle(orderId, _land(orderId, c.jobId, true, "completed"), new address[](0));
                ++deliveries;
            }
        } else if (s == IWorkOrders.State.Asserted) {
            if (choice % 4 == 0 && vm.getBlockTimestamp() < uint256(c.assertedAt) + desk.CHALLENGE_WINDOW()) {
                vm.prank(_runners[who % _runners.length]);
                desk.challenge(orderId);
            } else if (choice % 4 == 1) {
                desk.reportFailed(orderId, _land(orderId, c.jobId, false, "completed"), new address[](0));
            } else if (choice % 4 == 2) {
                desk.settle(orderId, _land(orderId, c.jobId, true, "completed"), new address[](0));
                ++deliveries;
            } else {
                _warpTo(uint256(c.assertedAt) + desk.CHALLENGE_WINDOW());
                desk.finalize(orderId);
                ++deliveries;
            }
        } else if (s == IWorkOrders.State.Disputed) {
            if (choice % 3 == 0) {
                desk.settle(orderId, _land(orderId, c.jobId, true, "completed"), new address[](0));
                ++deliveries;
            } else if (choice % 3 == 1) {
                desk.reportFailed(orderId, _land(orderId, c.jobId, false, "completed"), new address[](0));
            } else {
                _warpTo(uint256(c.registeredAt) + o.deliverySecs);
                desk.timeout(orderId);
            }
        }
    }

    /// @dev The registry writes a receipt for the order's registered job: a real work record with
    /// the current claim's header and the spec as its objective, or with some other objective.
    function _land(uint256 orderId, bytes16 jobId, bool sameObjective, string memory state)
        internal
        returns (bytes memory record)
    {
        bytes memory objective = sameObjective
            ? bytes.concat(desk.headerOf(orderId), SPEC)
            : bytes("A job that no order on this desk asked for.");
        record = _recordOf(jobId, KIND, objective, state);
        _write(jobId, record);
    }

    function reconcile(uint256 potSeed) external tracked {
        uint256 id = _any(potSeed);
        if (id == 0) return;
        CrowdPots.Stage stage = pots.reconcile(id);
        if (stage != CrowdPots.Stage.Hiring) return;

        // No keeper is needed: a pot that is still hiring after `reconcile` has an order on which
        // nothing has run out of time. Whatever had, `reconcile` had the desk end.
        uint256 orderId = pots.potOf(id).orderId;
        IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
        IWorkOrdersRunner.Claim memory c = desk.claimOf(orderId);
        uint256 time = vm.getBlockTimestamp();
        if (o.state == IWorkOrders.State.Open) {
            _expect(time < o.expiresAt, "reconcile left an expired, untaken order open");
        } else if (o.state == IWorkOrders.State.Claimed) {
            _expect(time < uint256(c.claimedAt) + desk.CLAIM_WINDOW(), "reconcile left an idle runner in place");
        } else if (o.state == IWorkOrders.State.Registered || o.state == IWorkOrders.State.Disputed) {
            _expect(time < uint256(c.registeredAt) + o.deliverySecs, "reconcile left an overdue claim in place");
        }
    }

    function claim(uint256 potSeed, uint256 actorSeed) external tracked {
        uint256 id = _claimable(potSeed);
        if (id == 0) return;
        address who = _actor(actorSeed);
        uint256 preview = pots.refundOf(id, who);
        uint256 before = imd.balanceOf(who);
        vm.prank(_actor(actorSeed >> 16));
        uint256 paid = pots.claimRefund(id, who);
        _expect(paid == preview, "refundOf did not say what the claim would pay");
        _expect(imd.balanceOf(who) - before == paid, "a claim did not pay the contributor what it reported");
        _noteRefund(id, who, paid);
    }

    function claimMany(uint256 potSeed) external tracked {
        uint256 id = _claimable(potSeed);
        if (id == 0) return;
        _claimForEveryone(id);
    }

    function donate(uint256 amount) external tracked {
        amount = bound(amount, 1, 50e18);
        vm.prank(donor);
        imd.transfer(address(pots), amount);
        donated += amount;
    }

    function warp(uint256 secs) external tracked {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 2 days));
    }

    /// @dev Not a fuzz target. Lets every deadline pass and claims every refund, so the test can
    /// check that nothing is left behind. Nobody calls the desk for the pots here, with one
    /// exception: an unchallenged delivery claim is finalised, as the runner it pays would do.
    /// Every other order that ran out of time is ended by the claim itself.
    function windDown() external tracked {
        vm.warp(vm.getBlockTimestamp() + 120 days);
        for (uint256 i; i < _potIds.length; ++i) {
            uint256 id = _potIds[i];
            CrowdPots.Pot memory p = pots.potOf(id);
            if (p.stage == CrowdPots.Stage.Hiring && desk.stateOf(p.orderId) == IWorkOrders.State.Asserted) {
                desk.finalize(p.orderId);
            }
            _claimForEveryone(id);
        }
    }

    // ------------------------------------------------------------------------------------------
    // Lookups for the invariants
    // ------------------------------------------------------------------------------------------

    function potIds() external view returns (uint256[] memory) {
        return _potIds;
    }

    function seriesIds() external view returns (uint256[] memory) {
        return _seriesIds;
    }

    function actors() external view returns (address[] memory) {
        return _actors;
    }

    // ------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------

    function _claimForEveryone(uint256 id) internal {
        uint256 n = _actors.length;
        uint256[] memory before = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            before[i] = imd.balanceOf(_actors[i]);
        }
        uint256 total = pots.claimRefunds(id, _actors);
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            uint256 paid = imd.balanceOf(_actors[i]) - before[i];
            _noteRefund(id, _actors[i], paid);
            sum += paid;
        }
        _expect(sum == total, "a batch claim did not pay what it reported");
    }

    function _expect(bool ok, string memory what) internal {
        if (!ok && bytes(violation).length == 0) violation = what;
    }

    function _noteChip(uint256 potId, address owner, uint256 taken) internal {
        if (taken == 0) return;
        chipped[potId] += taken;
        chipGhost[potId][owner] += taken;
        totalChipped += taken;
    }

    function _noteRefund(uint256 potId, address who, uint256 paid) internal {
        if (paid == 0) return;
        refunded[potId] += paid;
        refundedTo[potId][who] += paid;
        totalRefundedTo[who] += paid;
        ++claimsPaid;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[seed % _actors.length];
    }

    function _any(uint256 seed) internal view returns (uint256) {
        return _potIds.length == 0 ? 0 : _potIds[seed % _potIds.length];
    }

    /// @dev The first pot at or after a seeded position whose stored stage is `want`, or zero.
    function _pick(uint256 seed, CrowdPots.Stage want) internal view returns (uint256) {
        uint256 n = _potIds.length;
        for (uint256 i; i < n; ++i) {
            uint256 id = _potIds[(seed % n + i) % n];
            if (pots.potOf(id).stage == want) return id;
        }
        return 0;
    }

    /// @dev The first pot at or after a seeded position that `claimRefund` would accept, or zero.
    function _claimable(uint256 seed) internal view returns (uint256) {
        uint256 n = _potIds.length;
        for (uint256 i; i < n; ++i) {
            uint256 id = _potIds[(seed % n + i) % n];
            CrowdPots.Stage live = pots.stageOf(id);
            if (live == CrowdPots.Stage.Delivered || live == CrowdPots.Stage.Refundable) return id;
        }
        return 0;
    }

    function _mix(uint256 seed) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed)));
    }

    function _warpTo(uint256 time) internal {
        if (vm.getBlockTimestamp() < time) vm.warp(time);
    }

    function _mayFollow(CrowdPots.Stage was, CrowdPots.Stage current) internal pure returns (bool) {
        if (was == current || was == CrowdPots.Stage.None) return true;
        if (was == CrowdPots.Stage.Funding) {
            return current == CrowdPots.Stage.Hiring || current == CrowdPots.Stage.Refundable;
        }
        if (was == CrowdPots.Stage.Hiring) {
            return current == CrowdPots.Stage.Delivered || current == CrowdPots.Stage.Refundable;
        }
        return false;
    }

    function _terms(uint256 seed) internal pure returns (CrowdPots.Terms memory t) {
        t.kind = KIND;
        seed = _mix(seed);
        // Any wei amount, so that shares rarely divide evenly.
        t.target = uint96(bound(seed, 1e18, 400e18));
        seed = _mix(seed);
        t.hireSecs = uint32(bound(seed, 1 days, 30 days));
        t.fundSecs = uint32(bound(seed >> 32, 1 hours, 30 days));
        t.deliverySecs = uint32(bound(seed >> 64, 3 days, 30 days));
        uint256 maxBond = t.target < 5e18 ? t.target : 5e18;
        t.bond = uint96(bound(seed >> 96, 0.25e18, maxBond));
        t.allowClaimed = (seed >> 128) % 2 == 0;
        if ((seed >> 136) % 3 == 0) {
            t.minPay = t.target;
        } else {
            t.minPay = uint96(bound(seed >> 144, 1, uint256(t.target) - 1));
            t.rampSecs = uint32(bound(seed >> 176, 1, t.hireSecs));
        }
    }
}

/// @dev Every handler action is steered so that it cannot revert, and the run is told to fail if
/// one does: a revert would mean a pot or the desk refused something it should have accepted.
/// forge-config: default.invariant.depth = 120
/// forge-config: default.invariant.fail-on-revert = true
contract CrowdPotsInvariantTest is Test {
    MockIMD internal imd;
    WorkOrders internal desk;
    CrowdPots internal pots;
    PotsHandler internal handler;

    function setUp() public {
        vm.warp(1_760_000_000);
        imd = new MockIMD();
        RegistryStandIn registry = new RegistryStandIn();
        // The launch's contracts in manifest order, on the real WorkProof.
        WorkProof proof = new WorkProof(address(registry));
        desk = new WorkOrders(address(imd), address(proof), address(new PayrollStandIn(address(imd))));
        pots = new CrowdPots(address(imd), address(desk));
        handler = new PotsHandler(imd, desk, pots, registry);

        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = PotsHandler.openPot.selector;
        selectors[1] = PotsHandler.openSeries.selector;
        selectors[2] = PotsHandler.chip.selector;
        selectors[3] = PotsHandler.launch.selector;
        selectors[4] = PotsHandler.deskStep.selector;
        selectors[5] = PotsHandler.reconcile.selector;
        selectors[6] = PotsHandler.claim.selector;
        selectors[7] = PotsHandler.claimMany.selector;
        selectors[8] = PotsHandler.donate.selector;
        selectors[9] = PotsHandler.warp.selector;
        selectors[10] = PotsHandler.fillAndLaunch.selector;
        selectors[11] = PotsHandler.runnerStep.selector;
        selectors[12] = PotsHandler.keeperStep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _settled(CrowdPots.Stage stage) internal pure returns (bool) {
        return stage == CrowdPots.Stage.Delivered || stage == CrowdPots.Stage.Refundable;
    }

    /// @dev What a pot got back for its contributors: its own chips if it never hired, otherwise
    /// everything the desk says it returned for the pot's order.
    function _gotBack(CrowdPots.Pot memory p) internal view returns (uint256 returned) {
        if (p.orderId == 0) return p.raised;
        (,,,, returned) = desk.accountOf(p.orderId);
    }

    /// The contract's IMD balance always covers everything booked to contributors.
    function invariant_theBalanceCoversEverythingOwed() public view {
        assertGe(imd.balanceOf(address(pots)), pots.owed());
    }

    /// `owed` is exactly the chips of pots that have not hired plus the unclaimed refunds of settled
    /// pots; and the balance is exactly that, plus what the desk pushed for orders not yet
    /// reconciled, plus what strangers sent. Nothing is unaccounted for and nothing is missing.
    function invariant_theBooksMatchThePotsAndTheBalance() public view {
        uint256[] memory ids = handler.potIds();
        uint256 booked;
        uint256 unbooked;
        for (uint256 i; i < ids.length; ++i) {
            CrowdPots.Pot memory p = pots.potOf(ids[i]);
            if (p.stage == CrowdPots.Stage.Funding) booked += p.raised;
            else if (p.stage == CrowdPots.Stage.Hiring) unbooked += _gotBack(p);
            else booked += p.pool;
        }
        assertEq(pots.owed(), booked, "owed");
        assertEq(imd.balanceOf(address(pots)), booked + unbooked + handler.donated(), "balance");
    }

    /// The sum of a pot's chips equals what it raised, and it never raises more than its target.
    function invariant_chipsAddUpToWhatWasRaised() public view {
        uint256[] memory ids = handler.potIds();
        address[] memory actors = handler.actors();
        for (uint256 i; i < ids.length; ++i) {
            CrowdPots.Pot memory p = pots.potOf(ids[i]);
            uint256 sum;
            for (uint256 a; a < actors.length; ++a) {
                (uint256 amount,,) = pots.chipOf(ids[i], actors[a]);
                assertEq(amount, handler.chipGhost(ids[i], actors[a]), "each chip is credited to its owner");
                sum += amount;
            }
            assertEq(sum, p.raised, "chips == raised");
            assertEq(p.raised, handler.chipped(ids[i]), "raised == what was pulled");
            assertLe(p.raised, p.target, "never above the target");
        }
    }

    /// A pot never refunds more than it got back, and a pot that is not settled refunds nothing.
    function invariant_refundsNeverExceedWhatThePotGotBack() public view {
        uint256[] memory ids = handler.potIds();
        for (uint256 i; i < ids.length; ++i) {
            CrowdPots.Pot memory p = pots.potOf(ids[i]);
            uint256 paid = handler.refunded(ids[i]);
            if (_settled(p.stage)) {
                assertEq(paid + p.pool, _gotBack(p), "refunded + still in the pool == got back");
            } else {
                assertEq(paid, 0, "no refund before the pot is settled");
                assertEq(p.pool, 0);
            }
        }
    }

    /// Nobody can take another contributor's share: every claimer got at least the rounded-down
    /// pro rata share of what the pot got back, exactly their chip when the pot got back exactly
    /// what it raised, and once everyone has claimed the pool is empty to the wei.
    function invariant_everyClaimerGotTheirShare() public view {
        uint256[] memory ids = handler.potIds();
        address[] memory actors = handler.actors();
        for (uint256 i; i < ids.length; ++i) {
            CrowdPots.Pot memory p = pots.potOf(ids[i]);
            if (!_settled(p.stage) || p.raised == 0) continue;
            uint256 gotBack = _gotBack(p);
            uint256 unclaimed;
            for (uint256 a; a < actors.length; ++a) {
                (uint256 amount, uint256 refunded, bool claimed) = pots.chipOf(ids[i], actors[a]);
                assertEq(refunded, handler.refundedTo(ids[i], actors[a]), "the record matches what was paid");
                if (!claimed) {
                    assertEq(refunded, 0);
                    unclaimed += amount;
                    continue;
                }
                assertGe(refunded, amount * gotBack / p.raised, "at least the fair share");
                if (gotBack == p.raised) assertEq(refunded, amount, "exactly the chip");
            }
            assertEq(p.chipsLeft, unclaimed, "chipsLeft is the unclaimed chips");
            if (unclaimed == 0) assertEq(p.pool, 0, "the last claimer took the remainder");
        }
    }

    /// A pot's money can only go to the desk or back to its contributors: every wei that ever left
    /// the contract went to the desk as a launched pot's escrow or to a contributor as a refund.
    function invariant_moneyOnlyLeavesForTheDeskOrContributors() public view {
        address[] memory actors = handler.actors();
        uint256 toContributors;
        for (uint256 a; a < actors.length; ++a) {
            uint256 sent = imd.sent(address(pots), actors[a]);
            assertEq(sent, handler.totalRefundedTo(actors[a]), "a contributor received only refunds");
            toContributors += sent;
        }
        uint256 toDesk = imd.sent(address(pots), address(desk));
        assertEq(toDesk, handler.totalLaunched(), "the desk received exactly the launched targets");
        assertEq(imd.sentTotal(address(pots)), toDesk + toContributors, "and nobody else received anything");
    }

    /// A pot hires at most once, for exactly its target, and its order is its own.
    function invariant_aPotHiresAtMostOnce() public view {
        uint256[] memory ids = handler.potIds();
        uint256 hired;
        for (uint256 i; i < ids.length; ++i) {
            CrowdPots.Pot memory p = pots.potOf(ids[i]);
            if (p.orderId == 0) continue;
            ++hired;
            assertEq(pots.potOfOrder(p.orderId), ids[i]);
            IWorkOrdersRunner.Order memory o = desk.orderOf(p.orderId);
            assertEq(o.employer, address(pots));
            assertEq(o.maxPay, p.target);
            assertEq(p.raised, p.target);
        }
        assertEq(hired, handler.launches());
        assertEq(desk.orderCount(), handler.launches());
    }

    /// Chips were always cut to what was missing, refused after the deadline, and paid for exactly;
    /// every claim paid the contributor what the view had announced.
    function invariant_noActionSawAnythingWrong() public view {
        assertEq(handler.violation(), "");
    }

    /// A pot's stage only moves forward, and a settled pot never changes stage again.
    function invariant_stagesOnlyMoveForward() public view {
        assertFalse(handler.stageWentBackwards());
    }

    /// A series never holds money or chips itself.
    function invariant_aSeriesHoldsNothing() public view {
        uint256[] memory ids = handler.seriesIds();
        for (uint256 i; i < ids.length; ++i) {
            CrowdPots.Pot memory s = pots.potOf(ids[i]);
            assertEq(uint256(s.stage), uint256(CrowdPots.Stage.Series));
            assertEq(s.raised, 0);
            assertEq(s.pool, 0);
            assertEq(s.orderId, 0);
        }
    }

    /// @dev After each run: end every order, pass every deadline, claim every refund. Then nothing
    /// is owed, every pot has given back exactly what it got back, and the only IMD left in the
    /// contract is what strangers sent it. No dust anywhere.
    function afterInvariant() public {
        handler.windDown();
        uint256[] memory ids = handler.potIds();
        for (uint256 i; i < ids.length; ++i) {
            CrowdPots.Pot memory p = pots.potOf(ids[i]);
            assertTrue(_settled(p.stage), "every pot ends settled");
            assertEq(p.pool, 0, "nothing left in any pool");
            assertEq(p.chipsLeft, 0, "every chip claimed");
            assertEq(handler.refunded(ids[i]), _gotBack(p), "each pot gave back exactly what it got back");
        }
        assertEq(pots.owed(), 0, "nothing owed at the end");
        assertEq(imd.balanceOf(address(pots)), handler.donated(), "only stray transfers remain");
    }
}
