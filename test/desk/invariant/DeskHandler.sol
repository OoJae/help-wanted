// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {IWorkOrders} from "../../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../../src/interfaces/IWorkOrdersRunner.sol";
import {WorkOrders} from "../../../src/desk/WorkOrders.sol";
import {WorkProof} from "../../../src/proof/WorkProof.sol";
import {MockCondition} from "../mocks/MockCondition.sol";
import {MockEmployer} from "../mocks/MockEmployer.sol";
import {DeskToken} from "../mocks/DeskToken.sol";
import {PayrollStandIn} from "../../kit/PayrollStandIn.sol";
import {Receipts} from "../../kit/Receipts.sol";
import {RegistryStandIn} from "../../kit/RegistryStandIn.sol";

/// @dev Drives the desk through random lifecycles and, for every call that goes through, compares
/// what happened with a small independent model of the rules: who was allowed to do it, and exactly
/// how much IMD each party gained or lost. A mismatch is recorded, never reverted on, so that it
/// survives `fail_on_revert = false`; the invariant contract asserts that nothing was recorded.
///
/// One address may play several parts. A wallet employer may run its own order or challenge the
/// runner on it; a runner may challenge its own claim, itself or through another runner's address.
/// The model adds up what each address is owed over all its parts, so every balance change still
/// has exactly one explanation.
///
/// What the desk actually sent to an order's employer is measured, not modelled: it is read from
/// the token's Transfer logs and compared with `accountOf(id).returned`.
///
/// The desk runs against the real WorkProof. A receipt is a real work record with the members under
/// test swapped (`Receipts`), written to a stand-in for the registry; the handler remembers what it
/// wrote into each record, and the model's expectations follow from that.
contract DeskHandler is Receipts {
    WorkOrders public immutable desk;
    DeskToken public immutable imd;
    WorkProof public immutable proof;
    PayrollStandIn public immutable payroll;
    MockCondition public immutable cond;
    MockEmployer public immutable boss;

    address[] internal employers;
    /// Runners, then the wallet employers (an employer may take its own order).
    address[] internal runners;
    /// Challengers, then the runners, then the wallet employers.
    address[] internal challengers;
    address internal arbiter = makeAddr("inv.arbiter");
    address internal keeper = makeAddr("inv.keeper");
    address[] internal tracked;

    bytes internal constant SPEC = "Count the open orders and report the number. Inputs: scope=open; unit=orders";
    string internal constant KIND = REAL_KIND;
    uint256 internal constant FUNDS = 1_000_000_000e18;
    bytes32 internal constant TRANSFER = keccak256("Transfer(address,address,uint256)");

    // What a landed receipt says.
    uint8 internal constant NOTHING = 0;
    /// This claim's objective, the order's kind, completed.
    uint8 internal constant GOOD = 1;
    /// This claim's objective, the order's kind, not completed.
    uint8 internal constant FAILED = 2;
    /// This claim's objective, completed, another kind.
    uint8 internal constant OTHER_KIND = 3;
    /// This claim's header, another text after it.
    uint8 internal constant OTHER_OBJECTIVE = 4;
    /// An objective too short to hold a header.
    uint8 internal constant SHORT_OBJECTIVE = 5;
    /// This claim's objective, another kind, not completed.
    uint8 internal constant FAILED_OTHER_KIND = 6;

    // --- ghosts -------------------------------------------------------------------------------

    uint256 public violations;
    string public firstViolation;
    uint256 public totalMinted;
    uint256 public jobCounter;

    /// The first terminal state an order was seen in, and its books at that moment.
    mapping(uint256 => uint8) public terminalState;
    mapping(uint256 => bytes32) public terminalBooks;
    /// Set when an order was paid out for a reason the rules allow.
    mapping(uint256 => bool) public justified;
    /// What the model says the desk sent to the order's employer, as its employer.
    mapping(uint256 => uint256) public returnedModel;
    /// What the token's Transfer logs say the desk sent to the order's employer.
    mapping(uint256 => uint256) public returnedMeasured;
    /// The order's employer also acted as its runner or challenger: the logs cannot tell its
    /// parts apart, so only the model is compared for such an order.
    mapping(uint256 => bool) public mixedRoles;
    /// Which order each job was matched to by a receipt.
    mapping(bytes16 => uint256) public provenFor;
    mapping(bytes16 => uint256) public provenCount;
    mapping(uint256 => mapping(address => bool)) internal releasedBy;
    /// When an order's price ramp started (zero: a condition not yet seen true), and how long
    /// runners have held the order since without delivering.
    mapping(uint256 => uint256) internal rampStart;
    mapping(uint256 => uint256) internal heldSecs;

    mapping(bytes16 => uint8) internal landedKind;
    /// The claim whose objective the landed receipt carries (zero for some other objective).
    mapping(bytes16 => bytes32) internal landedFor;
    /// What the landed receipt's record was built from, so that the same bytes can be built again
    /// when it is submitted: its objective, and whether it names agents.
    mapping(bytes16 => bytes) internal landedObjective;
    mapping(bytes16 => bool) internal landedWithAgents;
    bytes16[] internal jobs;

    mapping(bytes32 => uint256) public hits;

    /// Orders that can still change, and the latest delivered ones (which can still be stamped or
    /// have their callback retried). Actions pick from these, so a long run stays cheap.
    uint256[] internal liveIds;
    mapping(uint256 => uint256) internal livePosition;
    uint256[] internal deliveredIds;
    uint256 internal deliveredCount;
    uint256 internal constant DELIVERED_KEPT = 12;

    mapping(address => int256) internal expected;
    uint256[] internal balancesBefore;
    uint256 internal bossCallsBefore;

    constructor() {
        imd = new DeskToken();
        registry = new RegistryStandIn();
        proof = new WorkProof(address(registry));
        payroll = new PayrollStandIn(address(imd));
        cond = new MockCondition();
        desk = new WorkOrders(address(imd), address(proof), address(payroll));
        boss = new MockEmployer(address(desk), address(imd));

        employers.push(makeAddr("inv.employer1"));
        employers.push(makeAddr("inv.employer2"));
        employers.push(address(boss));
        runners.push(makeAddr("inv.runner1"));
        runners.push(makeAddr("inv.runner2"));
        runners.push(makeAddr("inv.runner3"));
        challengers.push(makeAddr("inv.challenger1"));
        challengers.push(makeAddr("inv.challenger2"));

        for (uint256 i; i < employers.length; ++i) {
            _fund(employers[i]);
        }
        for (uint256 i; i < 3; ++i) {
            _fund(runners[i]);
        }
        for (uint256 i; i < 2; ++i) {
            _fund(challengers[i]);
        }
        // The overlaps: runners may challenge, wallet employers may run and challenge.
        for (uint256 i; i < 3; ++i) {
            challengers.push(runners[i]);
        }
        for (uint256 i; i < 2; ++i) {
            runners.push(employers[i]);
            challengers.push(employers[i]);
        }
        tracked.push(arbiter);
        tracked.push(keeper);
        tracked.push(address(payroll));
        tracked.push(address(desk));
        balancesBefore = new uint256[](tracked.length);
    }

    function _fund(address who) internal {
        imd.mint(who, FUNDS);
        totalMinted += FUNDS;
        vm.prank(who);
        imd.approve(address(desk), type(uint256).max);
        tracked.push(who);
    }

    // --- actions ------------------------------------------------------------------------------

    function createOrder(uint256 seed, uint96 minPay, uint96 maxPay, uint32 rampSecs, uint96 bond) external {
        IWorkOrders.OrderParams memory p;
        address employer = employers[seed % employers.length];
        p.kindHash = keccak256(bytes(KIND));
        p.maxPay = uint96(bound(maxPay, 1, 50e18));
        p.minPay = uint96(bound(minPay, 0, p.maxPay));
        p.rampSecs = uint32(bound(rampSecs, 0, 2 days));
        p.deliverySecs = uint32(3 days + (seed >> 8) % 2 days);
        p.expiresAt = uint40(_now() + 2 hours + (seed >> 24) % 12 days);
        p.bond = uint96(bound(bond, 0.25e18, 1e18));
        if ((seed >> 40) % 3 != 0) p.flags |= 1;
        if (employer == address(boss)) p.flags |= 2;
        if ((seed >> 48) % 5 == 0) p.runnerOnly = runners[(seed >> 56) % runners.length];
        if ((seed >> 64) % 3 != 0) p.arbiter = arbiter;
        if ((seed >> 72) % 4 == 0) {
            p.condTarget = address(cond);
            p.condSelector = MockCondition.read.selector;
            p.condCmp = 1;
            p.condThreshold = 1 + (seed >> 80) % 10;
        }

        _begin();
        bool ok;
        if (employer == address(boss)) {
            try boss.open(p, SPEC) {
                ok = true;
            } catch {}
        } else {
            vm.prank(employer);
            try desk.createOrder(p, SPEC) {
                ok = true;
            } catch {}
        }
        if (!ok) return _flag("a well-formed order was refused");
        uint256 id = desk.orderCount();
        _expect(employer, -int256(uint256(p.maxPay)));
        if (p.condTarget == address(0)) rampStart[id] = _now();
        liveIds.push(id);
        livePosition[id] = liveIds.length;
        _end(id);
        _hit("createOrder");
    }

    function cancel(uint256 seed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Open));
        if (!found) return;
        Ctx memory x = _ctx(id);
        _begin();
        bool ok;
        if (x.o.employer == address(boss)) {
            try boss.cancel(id) {
                ok = true;
            } catch {}
        } else {
            ok = _as(x.o.employer, abi.encodeCall(desk.cancel, (id)));
        }
        if (!ok) return _flag("the employer could not cancel an open order");
        _toEmployer(x, x.escrow);
        _mustBe(id, IWorkOrders.State.Cancelled);
        _end(id);
        _hit("cancel");
    }

    function refund(uint256 seed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Open));
        if (!found) return;
        Ctx memory x = _ctx(id);
        _begin();
        bool ok = _as(keeper, abi.encodeCall(desk.refund, (id)));
        if (ok != x.expired) return _flag("refund did not follow the expiry");
        if (!ok) return;
        _toEmployer(x, x.escrow);
        _mustBe(id, IWorkOrders.State.Refunded);
        _end(id);
        _hit("refund");
    }

    function setCondition(uint256 value) external {
        cond.set(value % 12);
    }

    function trigger(uint256 seed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Open));
        if (!found) return;
        Ctx memory x = _ctx(id);
        (, bool holds,) = desk.conditionOf(id);
        _begin();
        bool ok = _as(keeper, abi.encodeCall(desk.trigger, (id)));
        if (ok != (!x.o.condMet && holds)) return _flag("trigger did not follow the condition");
        if (!ok) return;
        if (!desk.orderOf(id).condMet) _flag("trigger did not latch");
        rampStart[id] = _now();
        _end(id);
        _hit("trigger");
    }

    function claim(uint256 seed, uint256 runnerSeed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Open));
        if (!found) return;
        Ctx memory x = _ctx(id);
        // Mostly a runner proper; one time in six a wallet employer takes the order.
        address runner = runners[runnerSeed % 6 == 0 ? 3 + (runnerSeed >> 8) % 2 : (runnerSeed >> 8) % 3];
        (bool met, bool holds,) = desk.conditionOf(id);
        uint256 shown = desk.priceNow(id);
        bool allowed = !x.expired && (x.o.runnerOnly == address(0) || x.o.runnerOnly == runner)
            && !releasedBy[id][runner] && (met || holds);
        _begin();
        bool ok = _as(runner, abi.encodeCall(desk.claim, (id)));
        if (ok != allowed) return _flag("claim did not follow the rules for taking an order");
        if (!ok) return;
        _expect(runner, -int256(x.bond));
        if (rampStart[id] == 0) rampStart[id] = _now();
        IWorkOrdersRunner.Claim memory c = desk.claimOf(id);
        if (c.price != shown) _flag("the claim fixed another price than the one shown");
        if (c.price != _rampPrice(x)) _flag("the price is not the ramp over the time the order spent open");
        if (c.price < x.o.minPay || c.price > x.o.maxPay) _flag("price outside the order's range");
        if (desk.priceNow(id) != c.price) _flag("a held order does not show its claim's price");
        if (desk.orderOf(id).seq != x.o.seq + 1) _flag("claim did not count");
        _mustBe(id, IWorkOrders.State.Claimed);
        _end(id);
        _hit("claim");
        if (runner == x.o.employer) _hit("claim.employer");
    }

    function release(uint256 seed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Claimed));
        if (!found) return;
        Ctx memory x = _ctx(id);
        _begin();
        bool ok = _as(x.c.runner, abi.encodeCall(desk.release, (id)));
        if (ok != (_now() < x.c.claimedAt + 1 hours)) return _flag("release did not follow the claim window");
        if (!ok) return;
        releasedBy[id][x.c.runner] = true;
        uint256 cut = x.bond / 10;
        _expectFree(x, x.bond - cut, cut, 0, false);
        _end(id);
        _hit("release");
    }

    function evict(uint256 seed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Claimed));
        if (!found) return;
        Ctx memory x = _ctx(id);
        _begin();
        bool ok = _as(keeper, abi.encodeCall(desk.evict, (id)));
        if (ok != (_now() >= x.c.claimedAt + 1 hours)) return _flag("evict did not follow the claim window");
        if (!ok) return;
        _expectFree(x, 0, x.bond, 0, false);
        _end(id);
        _hit("evict");
    }

    /// @param copySeed Now and then the runner registers a job id that is already on another order,
    /// instead of a fresh one.
    function register(uint256 seed, uint256 copySeed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Claimed) | _bit(IWorkOrders.State.Registered));
        if (!found) return;
        Ctx memory x = _ctx(id);
        // Most runners register once; a retry is the exception.
        if (x.o.state == IWorkOrders.State.Registered && copySeed % 4 != 1) return;
        bytes16 job;
        if (copySeed % 6 == 0 && jobs.length != 0) {
            job = jobs[(copySeed >> 8) % jobs.length];
        } else {
            job = bytes16(uint128(++jobCounter));
            jobs.push(job);
        }
        _begin();
        bool ok = _as(x.c.runner, abi.encodeCall(desk.register, (id, job)));
        // A job that already settled an order is refused; any other is accepted.
        if (ok != (provenFor[job] == 0)) return _flag("register did not follow the job's history");
        if (!ok) {
            _hit("register.used");
            return;
        }
        IWorkOrdersRunner.Claim memory c = desk.claimOf(id);
        if (x.c.registeredAt != 0 && c.registeredAt != x.c.registeredAt) _flag("a retry moved the delivery clock");
        _mustBe(id, IWorkOrders.State.Registered);
        _end(id);
        _hit("register");
    }

    /// The registry "writes a receipt" for the job an order has registered. Writing again for the
    /// same job replaces the earlier receipt, as the live registry does.
    function land(uint256 seed, uint8 kindSeed) external {
        (bool found, uint256 id) = _pick(
            seed,
            _bit(IWorkOrders.State.Registered) | _bit(IWorkOrders.State.Asserted) | _bit(IWorkOrders.State.Disputed)
                | _bit(IWorkOrders.State.Delivered)
        );
        if (!found) return;
        Ctx memory x = _ctx(id);
        bytes16 job = x.c.jobId;
        // For one job in three the registry never writes a receipt: such orders can only end by a
        // claim, an arbiter or a timeout.
        if (uint128(job) % 3 == 0) return;
        // Mostly good receipts; the rest spread over the ways a receipt can fail to settle.
        uint8 kind = kindSeed % 8 < 4 ? GOOD : uint8(2 + kindSeed % 5);
        bytes memory objective = bytes.concat(desk.headerOf(id), SPEC);
        if (kind == OTHER_OBJECTIVE) objective = bytes.concat(desk.headerOf(id), "Some other job entirely.");
        if (kind == SHORT_OBJECTIVE) objective = "hello world";
        // Two variants of the bytes: the second stands for a receipt that supersedes the first,
        // which names no agents.
        landedKind[job] = kind;
        landedObjective[job] = objective;
        landedWithAgents[job] = kindSeed % 5 != 0;
        _write(job, _landedRecord(job));
        landedFor[job] = kind == OTHER_OBJECTIVE || kind == SHORT_OBJECTIVE ? bytes32(0) : _claimKey(x);
        _hit("land");
    }

    function settle(uint256 seed) external {
        (bool found, uint256 id) = _pick(
            seed,
            _bit(IWorkOrders.State.Registered) | _bit(IWorkOrders.State.Asserted) | _bit(IWorkOrders.State.Disputed)
        );
        if (!found) return;
        Ctx memory x = _ctx(id);
        bytes16 job = x.c.jobId;
        bytes memory record = _landedRecord(job);
        bool disputed = x.o.state == IWorkOrders.State.Disputed;
        // Any receipt that settles pays, whatever hash the runner named in a delivery claim.
        bool allowed = _settles(x) && provenFor[job] == 0;
        _begin();
        _armPayroll(id);
        bool ok = _as(keeper, abi.encodeCall(desk.settle, (id, record, new address[](0))));
        if (ok && !allowed) return _flag("paid without a matching receipt");
        if (!ok && allowed) return _flag("a valid settlement was refused");
        if (!ok) return;
        _expectDelivery(x, disputed ? x.bond * 2 : x.bond);
        _markProven(job, id);
        justified[id] = true;
        if (!desk.orderOf(id).proven) _flag("a settlement by receipt was not marked proven");
        _mustBe(id, IWorkOrders.State.Delivered);
        _end(id);
        if (disputed) _hit("settle.disputed");
        else if (x.o.state == IWorkOrders.State.Asserted) _hit("settle.asserted");
        else _hit("settle");
        if (x.o.state != IWorkOrders.State.Registered && keccak256(record) != x.c.recordHash) _hit("settle.otherHash");
    }

    function reportFailed(uint256 seed, bool asRunner) external {
        (bool found, uint256 id) = _pick(
            seed,
            _bit(IWorkOrders.State.Registered) | _bit(IWorkOrders.State.Asserted) | _bit(IWorkOrders.State.Disputed)
        );
        if (!found) return;
        Ctx memory x = _ctx(id);
        bytes16 job = x.c.jobId;
        address caller = asRunner ? x.c.runner : keeper;
        IWorkOrders.State s = x.o.state;
        uint8 kind = landedKind[job];

        bool sameObjective = kind != NOTHING && landedFor[job] == _claimKey(x);
        bool completed = kind != FAILED && kind != FAILED_OTHER_KIND;
        // Any receipt of the registered job that does not settle the order can be reported.
        bool allowed = kind != NOTHING && !_settles(x);
        // While no delivery was claimed, a correctly opened job that did not complete is the
        // runner's alone to give up.
        bool runnersOwn = s == IWorkOrders.State.Registered && sameObjective && !completed;
        if (runnersOwn && caller != x.c.runner) allowed = false;

        _begin();
        bool ok = _as(caller, abi.encodeCall(desk.reportFailed, (id, _landedRecord(job), new address[](0))));
        if (ok != allowed) return _flag("reportFailed did not follow the receipt");
        if (!ok) return;
        uint256 cut = x.bond / 10;
        if (s == IWorkOrders.State.Disputed) {
            _expectFree(x, 0, cut, x.bond * 2 - cut, false);
            _hit("failed.disputed");
        } else if (s == IWorkOrders.State.Asserted) {
            _expectFree(x, 0, x.bond, 0, false);
            _hit("failed.asserted");
        } else if (sameObjective) {
            _expectFree(x, x.bond, 0, 0, false);
            _hit(completed ? bytes32("failed.kind") : bytes32("failed.swarm"));
        } else {
            _expectFree(x, 0, x.bond, 0, false);
            _hit("failed.wrongJob");
        }
        if (kind == SHORT_OBJECTIVE) _hit("failed.short");
        _end(id);
    }

    function timeout(uint256 seed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Registered) | _bit(IWorkOrders.State.Disputed));
        if (!found) return;
        Ctx memory x = _ctx(id);
        _begin();
        bool ok = _as(keeper, abi.encodeCall(desk.timeout, (id)));
        if (ok != (_now() >= uint256(x.c.registeredAt) + x.o.deliverySecs)) {
            return _flag("timeout did not follow the delivery deadline");
        }
        if (!ok) return;
        if (x.o.state == IWorkOrders.State.Registered) {
            _expectFree(x, 0, x.bond, 0, false);
            _hit("timeout");
        } else {
            // Undecided: the runner is treated as if it had released, the challenger is made whole.
            uint256 cut = x.bond / 10;
            _expectFree(x, x.bond - cut, cut, x.bond, true);
            _hit("timeout.disputed");
        }
        _end(id);
    }

    function claimDelivered(uint256 seed, bool honest) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Registered));
        if (!found) return;
        Ctx memory x = _ctx(id);
        // An honest runner names the record its job will have if it completes.
        bytes32 named = honest
            ? keccak256(
                _recordOf(x.c.jobId, KIND, bytes.concat(desk.headerOf(id), SPEC), "completed", _agents(x.c.jobId))
            )
            : keccak256(abi.encode("not a record", id));
        // The challenge window and a day for a dispute must both fit before the delivery deadline.
        bool allowed = x.o.flags & 1 != 0 && _now() + 48 hours <= uint256(x.c.registeredAt) + x.o.deliverySecs;
        _begin();
        bool ok = _as(x.c.runner, abi.encodeCall(desk.claimDelivered, (id, named)));
        if (ok != allowed) return _flag("claimDelivered did not follow the opt-in and the deadline");
        if (!ok) return;
        _mustBe(id, IWorkOrders.State.Asserted);
        _end(id);
        _hit("claimDelivered");
    }

    function challenge(uint256 seed, uint256 challengerSeed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Asserted));
        if (!found) return;
        Ctx memory x = _ctx(id);
        // Half the time a challenger proper; otherwise anyone, the claim's own runner and the
        // order's employer included.
        address who = challengerSeed % 2 == 0
            ? challengers[(challengerSeed >> 8) % 2]
            : challengerSeed % 8 == 1
                ? x.c.runner
                : challengerSeed % 8 == 3 && x.o.employer != address(boss)
                    ? x.o.employer
                    : challengers[(challengerSeed >> 8) % challengers.length];
        _begin();
        bool ok = _as(who, abi.encodeCall(desk.challenge, (id)));
        if (ok != (_now() < x.c.assertedAt + 24 hours)) return _flag("challenge did not follow the window");
        if (!ok) return;
        _expect(who, -int256(x.bond));
        _mustBe(id, IWorkOrders.State.Disputed);
        _end(id);
        _hit("challenge");
        if (who == x.c.runner) _hit("challenge.self");
        if (who == x.o.employer) _hit("challenge.employer");
    }

    function finalize(uint256 seed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Asserted));
        if (!found) return;
        Ctx memory x = _ctx(id);
        _begin();
        _armPayroll(id);
        bool ok = _as(keeper, abi.encodeCall(desk.finalize, (id)));
        if (ok != (_now() >= x.c.assertedAt + 24 hours)) return _flag("finalize did not follow the window");
        if (!ok) return;
        if (x.o.flags & 1 == 0) _flag("paid on a claim the employer never allowed");
        _expectDelivery(x, x.bond);
        justified[id] = true;
        if (desk.orderOf(id).proven) _flag("an unproven delivery was marked proven");
        _mustBe(id, IWorkOrders.State.Delivered);
        _end(id);
        _hit("finalize");
    }

    function resolve(uint256 seed, bool delivered, bool asArbiter) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Disputed));
        if (!found) return;
        Ctx memory x = _ctx(id);
        address caller = asArbiter ? arbiter : keeper;
        _begin();
        _armPayroll(id);
        bool ok = _as(caller, abi.encodeCall(desk.resolve, (id, delivered)));
        if (ok != (caller == x.o.arbiter)) return _flag("resolve did not follow the arbiter");
        if (!ok) return;
        if (delivered) {
            if (x.o.flags & 1 == 0) _flag("paid on a claim the employer never allowed");
            _expectDelivery(x, x.bond * 2);
            justified[id] = true;
            _mustBe(id, IWorkOrders.State.Delivered);
            _hit("resolve.delivered");
        } else {
            uint256 cut = x.bond / 10;
            _expectFree(x, 0, cut, x.bond * 2 - cut, false);
            _hit("resolve.refuted");
        }
        _end(id);
    }

    function stamp(uint256 seed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Delivered));
        if (!found) return;
        Ctx memory x = _ctx(id);
        bytes16 job = x.c.jobId;
        bool allowed = !x.o.proven && _settles(x) && provenFor[job] == 0;
        _begin();
        bool ok = _as(keeper, abi.encodeCall(desk.stamp, (id, _landedRecord(job), new address[](0))));
        if (ok != allowed) return _flag("stamp did not follow the receipt");
        if (!ok) return;
        _markProven(job, id);
        if (!desk.orderOf(id).proven) _flag("stamp did not mark the order");
        _end(id);
        _hit("stamp");
    }

    function redeliver(uint256 seed) external {
        (bool found, uint256 id) = _pick(seed, _bit(IWorkOrders.State.Delivered));
        if (!found) return;
        Ctx memory x = _ctx(id);
        _begin();
        bool ok = _as(keeper, abi.encodeCall(desk.redeliver, (id)));
        if (ok != (x.o.flags & 2 != 0 && !x.o.notified)) {
            return _flag("redeliver did not follow the callback's status");
        }
        if (!ok) return;
        _checkCallback(x);
        _end(id);
        _hit("redeliver");
    }

    /// Calls each guarded function as somebody who is not allowed to make it; none may go through.
    function wrongCaller(uint256 seed) external {
        uint256 n = desk.orderCount();
        if (n == 0) return;
        uint256 id = 1 + seed % n;
        Ctx memory x = _ctx(id);
        _begin();
        if (_as(keeper, abi.encodeCall(desk.cancel, (id)))) _flag("a stranger cancelled an order");
        if (_as(keeper, abi.encodeCall(desk.release, (id)))) _flag("a stranger released a claim");
        if (_as(keeper, abi.encodeCall(desk.register, (id, bytes16(uint128(1)))))) {
            _flag("a stranger registered a job");
        }
        if (_as(keeper, abi.encodeCall(desk.claimDelivered, (id, bytes32(uint256(1)))))) {
            _flag("a stranger claimed delivery");
        }
        if (x.o.arbiter != keeper && _as(keeper, abi.encodeCall(desk.resolve, (id, true)))) {
            _flag("a stranger resolved a dispute");
        }
        _end(id);
        _hit("wrongCaller");
    }

    function warp(uint256 secs) external {
        vm.warp(_now() + bound(secs, 1 minutes, 36 hours));
        _hit("warp");
    }

    function setPayrollMode(uint8 seed) external {
        PayrollStandIn.Mode[9] memory modes = [
            PayrollStandIn.Mode.Normal,
            PayrollStandIn.Mode.RevertPay,
            PayrollStandIn.Mode.RevertTip,
            PayrollStandIn.Mode.RevertBoth,
            PayrollStandIn.Mode.PullNothing,
            PayrollStandIn.Mode.PullHalf,
            PayrollStandIn.Mode.PullAllInPay,
            PayrollStandIn.Mode.Reenter,
            PayrollStandIn.Mode.BurnGas
        ];
        payroll.setMode(seed % 3 == 0 ? modes[(seed / 3) % modes.length] : PayrollStandIn.Mode.Normal);
    }

    function setBossMode(bool reverts) external {
        boss.setMode(reverts ? MockEmployer.Mode.Revert : MockEmployer.Mode.Record);
    }

    // --- the model ----------------------------------------------------------------------------

    struct Ctx {
        uint256 id;
        IWorkOrdersRunner.Order o;
        IWorkOrdersRunner.Claim c;
        bool expired;
        uint256 bond;
        uint256 escrow;
    }

    function _ctx(uint256 id) internal view returns (Ctx memory x) {
        x.id = id;
        x.o = desk.orderOf(id);
        x.c = desk.claimOf(id);
        x.expired = _now() >= x.o.expiresAt;
        x.bond = x.o.bond;
        x.escrow = x.o.escrow;
    }

    function _claimKey(Ctx memory x) internal pure returns (bytes32) {
        return keccak256(abi.encode(x.id, x.o.seq, x.c.runner));
    }

    /// @dev Does the landed receipt of the order's registered job pay this claim?
    function _settles(Ctx memory x) internal view returns (bool) {
        return landedKind[x.c.jobId] == GOOD && landedFor[x.c.jobId] == _claimKey(x);
    }

    /// @dev 5% and 5% of the price, each rounded up, the tip never more than what is left.
    function _split(uint256 price) internal pure returns (uint256 runnerPay, uint256 fee, uint256 tip) {
        fee = price / 20;
        if (fee * 20 != price) ++fee;
        tip = fee > price - fee ? price - fee : fee;
        runnerPay = price - fee - tip;
    }

    /// @dev What a claim made now fixes: a straight line from `minPay` to `maxPay` over `rampSecs`
    /// of time the order has spent open since its ramp started.
    function _rampPrice(Ctx memory x) internal view returns (uint256) {
        uint256 open = _now() - rampStart[x.id] - heldSecs[x.id];
        if (open >= x.o.rampSecs) return x.o.maxPay;
        return x.o.minPay + uint256(x.o.maxPay - x.o.minPay) * open / x.o.rampSecs;
    }

    function _expectDelivery(Ctx memory x, uint256 bonds) internal {
        (uint256 runnerPay, uint256 fee, uint256 tip) = _split(x.c.price);
        if (x.c.price > x.o.maxPay) _flag("the price exceeds the escrow");
        _expect(x.c.runner, int256(runnerPay + bonds));
        _toEmployer(x, uint256(x.o.maxPay) - x.c.price);
        _expect(address(payroll), int256(fee + tip));
        // Payroll, asked to call back into the desk while it is being paid, must have been refused.
        if (fee != 0 && payroll.mode() == PayrollStandIn.Mode.Reenter && payroll.reenterSucceeded()) {
            _flag("Payroll reached back into the desk during a delivery");
        }
        _checkCallback(x);
    }

    /// @dev After a delivery or a retry: a contract employer that asked to be told was told exactly
    /// once, unless its callback fails, in which case the order stays marked as not told.
    function _checkCallback(Ctx memory x) internal {
        if (x.o.flags & 2 == 0) return;
        bool told = boss.mode() == MockEmployer.Mode.Record;
        if (desk.orderOf(x.id).notified != told) _flag("notified does not say whether the callback went through");
        if (boss.calls() != bossCallsBefore + (told ? 1 : 0)) _flag("the employer was not told exactly once");
    }

    /// @dev A claim that ended without delivery: where the bond money goes, and what becomes of the order.
    function _expectFree(Ctx memory x, uint256 toRunner, uint256 toEmployer, uint256 toChallenger, bool refundNow)
        internal
    {
        bool refunded = refundNow || x.expired;
        _expect(x.c.runner, int256(toRunner));
        if (toChallenger != 0) _expect(x.c.challenger, int256(toChallenger));
        _toEmployer(x, toEmployer + (refunded ? x.escrow : 0));
        // The ramp stood still for as long as the order was held.
        if (!refunded) heldSecs[x.id] += _now() - x.c.claimedAt;
        _mustBe(x.id, refunded ? IWorkOrders.State.Refunded : IWorkOrders.State.Open);
    }

    /// @dev Money the desk sends to the employer as the order's employer: all of it must show in `returned`.
    function _toEmployer(Ctx memory x, uint256 amount) internal {
        _expect(x.o.employer, int256(amount));
        returnedModel[x.id] += amount;
    }

    function _markProven(bytes16 job, uint256 id) internal {
        if (provenFor[job] != 0 && provenFor[job] != id) _flag("one job proved two orders");
        provenFor[job] = id;
        ++provenCount[job];
        if (provenCount[job] > 1) _flag("a job was matched twice");
        if (desk.orderOfJob(job) != id) _flag("orderOfJob does not name the settled order");
    }

    /// @dev Has Payroll, when it is in its re-entering mode, try to have the employer of the order
    /// being paid told about the delivery from inside the payment.
    function _armPayroll(uint256 id) internal {
        payroll.setReenter(address(desk), abi.encodeCall(desk.redeliver, (id)));
    }

    // --- bookkeeping --------------------------------------------------------------------------

    function _begin() internal {
        for (uint256 i; i < tracked.length; ++i) {
            balancesBefore[i] = imd.balanceOf(tracked[i]);
            expected[tracked[i]] = 0;
        }
        bossCallsBefore = boss.calls();
        vm.recordLogs();
        // Drop whatever an earlier action left behind.
        vm.getRecordedLogs();
    }

    function _expect(address who, int256 delta) internal {
        expected[who] += delta;
    }

    /// @dev Compares every tracked balance with the model, adds up what the desk really sent to
    /// the order's employer, then re-checks the touched order.
    function _end(uint256 id) internal {
        int256 others;
        for (uint256 i; i < tracked.length; ++i) {
            if (tracked[i] != address(desk)) others += expected[tracked[i]];
        }
        expected[address(desk)] = -others;
        for (uint256 i; i < tracked.length; ++i) {
            int256 actual = int256(imd.balanceOf(tracked[i])) - int256(balancesBefore[i]);
            if (actual != expected[tracked[i]]) _flag("a balance moved by another amount than the rules say");
        }
        if (imd.balanceOf(arbiter) != 0 || imd.balanceOf(keeper) != 0) _flag("a bystander was paid");
        _measure(id);
        checkOrder(id);
    }

    function _measure(uint256 id) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        address employer = desk.orderOf(id).employer;
        IWorkOrdersRunner.Claim memory c = desk.claimOf(id);
        if (employer == c.runner || employer == c.challenger) mixedRoles[id] = true;
        uint256 sent;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter != address(imd) || log.topics.length != 3 || log.topics[0] != TRANSFER) continue;
            if (log.topics[1] != bytes32(uint256(uint160(address(desk))))) continue;
            if (log.topics[2] != bytes32(uint256(uint160(employer)))) continue;
            sent += abi.decode(log.data, (uint256));
        }
        returnedMeasured[id] += sent;
    }

    /// @dev The per-order rules. Records the first terminal state seen and holds the order to it.
    function checkOrder(uint256 id) public {
        string memory problem = orderProblem(id);
        if (bytes(problem).length != 0) _flag(problem);
        if (terminalState[id] == 0) {
            (IWorkOrders.State s,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
            if (_terminal(s)) {
                terminalState[id] = uint8(s);
                terminalBooks[id] = keccak256(abi.encode(escrow, spent, returned));
                _retire(id, s == IWorkOrders.State.Delivered);
            }
        }
    }

    /// @dev Everything that must be true of one order at any moment; empty when all is well.
    function orderProblem(uint256 id) public view returns (string memory) {
        IWorkOrdersRunner.Order memory o = desk.orderOf(id);
        (IWorkOrders.State s,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
        if (s == IWorkOrders.State.None) return "an order has no state";
        if (spent > o.maxPay) return "an order paid out more than maxPay";
        // `returned` counts every transfer the desk made to the employer for the order.
        if (returned != returnedModel[id]) return "returned is not what the rules say the employer was sent";
        if (!mixedRoles[id] && returned != returnedMeasured[id]) {
            return "returned is not what the desk actually sent the employer";
        }
        if (_terminal(s)) {
            if (escrow != 0) return "a finished order still holds escrow";
            if (s == IWorkOrders.State.Delivered) {
                if (spent != desk.claimOf(id).price) return "spent is not the fixed price";
                if (!justified[id]) return "paid out without a receipt or an allowed claim";
            } else if (spent != 0) {
                return "an order that was not delivered shows money spent";
            }
            // The escrow is accounted for to the wei; anything above it in `returned` is bond money.
            if (uint256(returned) < uint256(o.maxPay) - spent) return "part of the escrow is unaccounted for";
            if (terminalState[id] != 0) {
                if (terminalState[id] != uint8(s)) return "a terminal state changed";
                if (terminalBooks[id] != keccak256(abi.encode(escrow, spent, returned))) {
                    return "a finished order's books changed";
                }
            }
        } else {
            if (terminalState[id] != 0) return "a terminal state changed";
            if (escrow != o.maxPay) return "a live order's escrow is not whole";
            if (spent != 0) return "a live order shows money spent";
        }
        return "";
    }

    function _terminal(IWorkOrders.State s) internal pure returns (bool) {
        return s == IWorkOrders.State.Delivered || s == IWorkOrders.State.Cancelled || s == IWorkOrders.State.Refunded;
    }

    /// @dev What the desk owes right now: every live escrow and every live bond.
    function owed() public view returns (uint256 total) {
        uint256 n = desk.orderCount();
        for (uint256 id = 1; id <= n; ++id) {
            IWorkOrdersRunner.Order memory o = desk.orderOf(id);
            total += o.escrow;
            if (
                o.state == IWorkOrders.State.Claimed || o.state == IWorkOrders.State.Registered
                    || o.state == IWorkOrders.State.Asserted
            ) total += o.bond;
            else if (o.state == IWorkOrders.State.Disputed) total += uint256(o.bond) * 2;
        }
    }

    function trackedTotal() public view returns (uint256 total) {
        for (uint256 i; i < tracked.length; ++i) {
            total += imd.balanceOf(tracked[i]);
        }
    }

    function liveCount() external view returns (uint256) {
        return liveIds.length;
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    function jobAt(uint256 i) external view returns (bytes16) {
        return jobs[i];
    }

    function _mustBe(uint256 id, IWorkOrders.State s) internal {
        if (desk.stateOf(id) != s) _flag("an order ended in another state than the rules say");
    }

    function _retire(uint256 id, bool delivered) internal {
        uint256 position = livePosition[id];
        if (position != 0) {
            uint256 last = liveIds[liveIds.length - 1];
            liveIds[position - 1] = last;
            livePosition[last] = position;
            liveIds.pop();
            livePosition[id] = 0;
        }
        if (delivered) {
            if (deliveredIds.length < DELIVERED_KEPT) deliveredIds.push(id);
            else deliveredIds[deliveredCount % DELIVERED_KEPT] = id;
            ++deliveredCount;
        }
    }

    /// @dev An order whose state is in `mask`, chosen by `seed`.
    function _pick(uint256 seed, uint256 mask) internal view returns (bool found, uint256 id) {
        bool wantsDelivered = mask & _bit(IWorkOrders.State.Delivered) != 0;
        bool deliveredFirst = wantsDelivered && (mask == _bit(IWorkOrders.State.Delivered) || (seed >> 200) % 3 == 0);
        if (deliveredFirst && deliveredIds.length != 0) return (true, deliveredIds[seed % deliveredIds.length]);
        uint256 n = liveIds.length;
        for (uint256 k; k < n; ++k) {
            id = liveIds[(seed % n + k) % n];
            if (mask & (1 << uint8(desk.stateOf(id))) != 0) return (true, id);
        }
        if (wantsDelivered && deliveredIds.length != 0) return (true, deliveredIds[seed % deliveredIds.length]);
        return (false, 0);
    }

    function _bit(IWorkOrders.State s) internal pure returns (uint256) {
        return 1 << uint8(s);
    }

    function _as(address who, bytes memory data) internal returns (bool ok) {
        vm.prank(who);
        (ok,) = address(desk).call(data);
    }

    /// @dev The record of the receipt last landed for `job`, byte for byte as it was written to the
    /// registry, or nothing when no receipt was landed.
    function _landedRecord(bytes16 job) internal view returns (bytes memory) {
        uint8 kind = landedKind[job];
        if (kind == NOTHING) return "";
        return _recordOf(
            job,
            kind == OTHER_KIND || kind == FAILED_OTHER_KIND ? "single" : KIND,
            landedObjective[job],
            kind == FAILED || kind == FAILED_OTHER_KIND ? "blocked" : "completed",
            landedWithAgents[job] ? _agents(job) : new uint256[](0)
        );
    }

    /// @dev The agents a job's first receipt names: none to three, fixed per job.
    function _agents(bytes16 job) internal pure returns (uint256[] memory ids) {
        uint256 seed = uint128(job);
        ids = new uint256[](seed % 4);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = 50_000 + (seed >> (8 * i)) % 100;
        }
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _flag(string memory what) internal {
        if (violations == 0) firstViolation = what;
        ++violations;
    }

    function _hit(bytes32 what) internal {
        ++hits[what];
    }
}
