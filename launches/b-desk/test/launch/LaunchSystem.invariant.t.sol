// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {Doorbell} from "../../src/pots/Doorbell.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {LaunchValues} from "../kit/LaunchValues.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {Receipts} from "../kit/Receipts.sol";
import {RegistryStandIn} from "../kit/RegistryStandIn.sol";
import {MockIMD} from "../pots/mocks/MockIMD.sol";
import {LaunchKit} from "./LaunchKit.sol";

/// @notice Drives the whole launch at once: the Doorbell is funded and rung, pots open, fill and
/// launch, wallets open orders of their own, and every order on the desk, whoever its employer
/// is, is moved along whichever way its state allows. Receipts are real work records carrying the
/// order's header, proven by the launch's own WorkProof. Every action is steered so that it does
/// not revert; one that does is counted and fails the run.
contract LaunchSystemHandler is Receipts {
    string internal constant PICTURE_FIXTURE = "df6805ee-skill-create-image-7dd1a0a2.hex";
    bytes internal constant POT_SPEC =
        "Write a two-page plain-language report on who paid the IdentityMD swarm in the last seven days and for what, with every figure sourced to a transaction.";
    bytes internal constant WALLET_SPEC =
        "Audit the contracts in github.com/example/vault at commit 1f3a9c for loss of funds.";

    MockIMD public immutable imd;
    WorkOrders public immutable desk;
    CrowdPots public immutable pots;
    Doorbell public immutable bell;

    address[] internal _runners;
    address[] internal _funders;
    address[] internal _employers;
    address[] public tracked;
    uint256[] internal _potIds;
    uint256[] internal _potOrderIds;

    uint256 public funded;
    uint256 public rang;
    uint256 public walletOrders;
    uint256 public potsLaunched;
    uint256 public totalMinted;
    uint256 public unexpectedReverts;
    string public firstUnexpected;
    /// @dev How many claims ended by a receipt that returned the bond whole (`docs/THREATS.md`,
    /// W2 and W3), and how many of those ended a pot in a refund with nothing forfeited (C2).
    uint256 public bondsReturnedWhole;
    uint256 public potsEndedWithNoBondForfeited;

    mapping(uint256 orderId => address) public employerOf;
    mapping(uint256 potId => bool) public launched;
    /// @dev How often each desk path was taken and went through.
    mapping(bytes32 => uint256) public hits;

    constructor(WorkOrders desk_, CrowdPots pots_, Doorbell bell_) {
        imd = MockIMD(Mainnet.IMD);
        registry = RegistryStandIn(Mainnet.WORK_REGISTRY);
        desk = desk_;
        pots = pots_;
        bell = bell_;
        for (uint256 i; i < 3; ++i) {
            _runners.push(_fund(string.concat("runner", vm.toString(i))));
            _funders.push(_fund(string.concat("funder", vm.toString(i))));
            _employers.push(_fund(string.concat("employer", vm.toString(i))));
        }
        tracked.push(address(desk));
        tracked.push(address(pots));
        tracked.push(address(bell));
        tracked.push(Mainnet.PAYROLL);
        tracked.push(desk.WORK_PROOF());
    }

    function _fund(string memory name) internal returns (address who) {
        who = makeAddr(name);
        imd.mint(who, 1e24);
        totalMinted += 1e24;
        vm.startPrank(who);
        imd.approve(address(desk), type(uint256).max);
        imd.approve(address(pots), type(uint256).max);
        vm.stopPrank();
        tracked.push(who);
    }

    // ---- the Doorbell --------------------------------------------------------------------------------

    function fundBell(uint256 amount, uint256 who) external {
        amount = bound(amount, 1, 3 * uint256(bell.MAX_PAY()));
        vm.prank(_funders[who % _funders.length]);
        imd.transfer(address(bell), amount);
        funded += amount;
    }

    function ring(uint256 times, uint256 who) external {
        times = bound(times, 1, 30);
        address ringer = _funders[who % _funders.length];
        for (uint256 i; i < times; ++i) {
            vm.prank(ringer);
            try bell.ring() returns (uint256, bool hired, uint256 orderId) {
                if (hired) employerOf[orderId] = address(bell);
            } catch {
                _unexpected("ring reverted");
            }
        }
        rang += times;
    }

    // ---- the pots -------------------------------------------------------------------------------------

    function openPot(uint256 seed, uint256 who) external {
        // At most six pots collecting or hiring at once, so that chips fill them.
        uint256 live;
        for (uint256 i; i < _potIds.length; ++i) {
            CrowdPots.Stage s = pots.potOf(_potIds[i]).stage;
            if (s == CrowdPots.Stage.Funding || s == CrowdPots.Stage.Hiring) ++live;
        }
        if (live >= 6) return;
        CrowdPots.Terms memory t;
        t.kind = REAL_KIND;
        t.target = uint96(bound(seed, 1e18, 5e18));
        t.minPay = seed % 3 == 0 ? uint96(uint256(t.target) / 2) : t.target;
        t.rampSecs = t.minPay == t.target ? 0 : uint32(bound(seed >> 8, 1, 1 days));
        t.bond = uint96(bound(seed >> 16, 0.25e18, 1e18));
        t.deliverySecs = uint32(bound(seed >> 32, 3 days, 7 days));
        t.hireSecs = uint32(bound(seed >> 48, 1 days, 3 days));
        t.fundSecs = uint32(bound(seed >> 64, 1 days, 30 days));
        t.allowClaimed = (seed >> 80) % 2 == 0;
        vm.prank(_employers[who % _employers.length]);
        try pots.openPot(t, POT_SPEC, 0) returns (uint256 potId) {
            _potIds.push(potId);
        } catch {
            _unexpected("openPot reverted");
        }
    }

    function chip(uint256 potSeed, uint256 who, uint256 amount) external {
        if (_potIds.length == 0) return;
        uint256 potId = _potIds[potSeed % _potIds.length];
        CrowdPots.Pot memory p = pots.potOf(potId);
        if (p.stage != CrowdPots.Stage.Funding || vm.getBlockTimestamp() > p.deadline) return;
        uint256 remaining = uint256(p.target) - p.raised;
        if (remaining == 0) return;
        // Half the chips fill the pot outright, and half of those launch it in the same breath,
        // as a funder that completes a pot would: time in these runs moves in days.
        bool fills = amount % 2 == 0;
        bool launches = fills && (amount >> 8) % 2 == 0;
        amount = fills ? remaining : bound(amount, 1, remaining);
        address funder = _funders[who % _funders.length];
        vm.prank(funder);
        try pots.chipIn(potId, amount) {}
        catch {
            _unexpected("chipIn reverted");
            return;
        }
        if (launches) _launch(potId, funder);
    }

    function _launch(uint256 potId, address who) internal {
        vm.prank(who);
        try pots.launch(potId, POT_SPEC) returns (uint256 orderId) {
            employerOf[orderId] = address(pots);
            _potOrderIds.push(orderId);
            launched[potId] = true;
            ++potsLaunched;
        } catch {
            _unexpected("launch reverted");
        }
    }

    function launchPot(uint256 potSeed, uint256 who) external {
        if (_potIds.length == 0) return;
        uint256 potId = _potIds[potSeed % _potIds.length];
        CrowdPots.Pot memory p = pots.potOf(potId);
        if (p.stage != CrowdPots.Stage.Funding || p.raised != p.target) return;
        if (vm.getBlockTimestamp() > uint256(p.deadline) + pots.LAUNCH_GRACE()) return;
        _launch(potId, _funders[who % _funders.length]);
    }

    function reconcile(uint256 potSeed) external {
        if (_potIds.length == 0) return;
        uint256 potId = _potIds[potSeed % _potIds.length];
        try pots.reconcile(potId) {}
        catch {
            _unexpected("reconcile reverted");
        }
    }

    function claimRefund(uint256 potSeed, uint256 who) external {
        if (_potIds.length == 0) return;
        uint256 potId = _potIds[potSeed % _potIds.length];
        CrowdPots.Stage s = pots.stageOf(potId);
        if (s != CrowdPots.Stage.Delivered && s != CrowdPots.Stage.Refundable) return;
        address contributor = _funders[who % _funders.length];
        (uint256 chipped,, bool claimed) = pots.chipOf(potId, contributor);
        if (chipped == 0 || claimed) return;
        try pots.claimRefund(potId, contributor) {}
        catch {
            _unexpected("claimRefund reverted");
        }
    }

    // ---- a wallet's order ------------------------------------------------------------------------------

    function walletOrder(uint256 seed, uint256 who) external {
        if (walletOrders >= 40) return;
        IWorkOrders.OrderParams memory p;
        p.kindHash = keccak256(bytes(REAL_KIND));
        p.maxPay = uint96(bound(seed, 1e18, 4e18));
        p.minPay = p.maxPay;
        p.deliverySecs = uint32(bound(seed >> 16, 3 days, 10 days));
        p.expiresAt = uint40(vm.getBlockTimestamp() + bound(seed >> 32, 2 hours, 5 days));
        p.bond = uint96(bound(seed >> 48, 0.25e18, 1e18));
        if ((seed >> 64) % 2 == 0) p.flags = desk.FLAG_ALLOW_CLAIMED();
        address employer = _employers[who % _employers.length];
        vm.prank(employer);
        try desk.createOrder(p, WALLET_SPEC) returns (uint256 orderId) {
            employerOf[orderId] = employer;
            ++walletOrders;
        } catch {
            _unexpected("createOrder reverted");
        }
    }

    // ---- the desk, for every order whoever opened it ---------------------------------------------------

    function warp(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 2 days));
    }

    function deskStep(uint256 orderSeed, uint256 choice, uint256 who) external {
        uint256 count = desk.orderCount();
        if (count == 0) return;
        // The first order that can still move, starting from a random one and wrapping around.
        // A third of the time the start is a pot's order, which are few among a wallet's and the
        // Doorbell's, so that every ending the desk allows is reached on a pot too.
        uint256 orderId = 1 + orderSeed % count;
        if (orderSeed % 3 == 0 && _potOrderIds.length > 0) {
            orderId = _potOrderIds[(orderSeed / 3) % _potOrderIds.length];
        }
        for (uint256 tries; tries < count; ++tries) {
            IWorkOrders.State live = desk.stateOf(orderId);
            if (live != IWorkOrders.State.None && live < IWorkOrders.State.Delivered) break;
            orderId = orderId % count + 1;
        }
        IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
        IWorkOrdersRunner.Claim memory c = desk.claimOf(orderId);
        IWorkOrders.State s = o.state;
        address runner = _runners[who % _runners.length];

        if (s == IWorkOrders.State.Open) {
            if (vm.getBlockTimestamp() >= o.expiresAt) {
                _call(abi.encodeCall(desk.refund, (orderId)), address(0), "refund");
            } else if (choice % 7 == 0 && o.employer != address(bell) && o.employer != address(pots)) {
                _call(abi.encodeCall(desk.cancel, (orderId)), o.employer, "cancel");
            } else if (!desk.barred(orderId, runner)) {
                _call(abi.encodeCall(desk.claim, (orderId)), runner, "claim");
            }
        } else if (s == IWorkOrders.State.Claimed) {
            bool canRelease = vm.getBlockTimestamp() < uint256(c.claimedAt) + desk.CLAIM_WINDOW();
            if (choice % 4 == 0 && canRelease) {
                _call(abi.encodeCall(desk.release, (orderId)), c.runner, "release");
            } else if (choice % 4 <= 1) {
                _warpTo(uint256(c.claimedAt) + desk.CLAIM_WINDOW());
                _call(abi.encodeCall(desk.evict, (orderId)), address(0), "evict");
            } else {
                bytes16 job = bytes16(keccak256(abi.encode(orderId, c.claimedAt, o.seq)));
                _call(abi.encodeCall(desk.register, (orderId, job)), c.runner, "register");
            }
        } else if (s == IWorkOrders.State.Registered) {
            uint256 deliverBy = uint256(c.registeredAt) + o.deliverySecs;
            bool claimsAllowed = o.flags & desk.FLAG_ALLOW_CLAIMED() != 0;
            bool canClaim = vm.getBlockTimestamp() + desk.CHALLENGE_WINDOW() + desk.DISPUTE_WINDOW() <= deliverBy;
            if (choice % 7 == 0 && claimsAllowed && canClaim) {
                bytes32 named = keccak256(abi.encode("claimed", orderId));
                _call(abi.encodeCall(desk.claimDelivered, (orderId, named)), c.runner, "claimDelivered");
            } else if (choice % 7 == 1) {
                _warpTo(deliverBy);
                _call(abi.encodeCall(desk.timeout, (orderId)), address(0), "timeout");
            } else if (choice % 7 == 2) {
                // The job did not complete: only the runner may say so, and its bond comes back whole.
                // Half the time, when the order's expiry comes before the delivery deadline, the
                // runner waits it out first: the report then refunds the order (and ends a pot) with
                // nothing forfeited (`docs/THREATS.md`, C2).
                if ((choice >> 8) % 2 == 0 && o.expiresAt < deliverBy) _warpTo(o.expiresAt);
                bytes memory failed = _land(orderId, o.employer, c.jobId, true, false);
                _reportWithBondBack(orderId, o, c, failed, c.runner, runner, "reportFailed");
            } else if (choice % 7 == 3) {
                // Completed under another kind, with the order's own objective: anyone may report
                // it, the bond comes back whole and the runner is not barred (`docs/THREATS.md`, W2).
                bytes memory other = _landOtherKind(orderId, o.employer, c.jobId);
                _reportWithBondBack(orderId, o, c, other, address(0), runner, "reportFailed.wrongKind");
            } else if (choice % 7 == 4) {
                // A job that is not this claim's: anyone may report it and the bond goes to the employer.
                bytes memory wrong = _land(orderId, o.employer, c.jobId, false, true);
                uint256 returnedBefore = _returnedOf(orderId);
                uint256 runnerBefore = imd.balanceOf(c.runner);
                if (_call(
                        abi.encodeCall(desk.reportFailed, (orderId, wrong, _none())),
                        address(0),
                        "reportFailed.wrongJob"
                    )) {
                    if (imd.balanceOf(c.runner) != runnerBefore) {
                        _unexpected("wrong job: the runner got something back");
                    }
                    if (_returnedOf(orderId) < returnedBefore + o.bond) {
                        _unexpected("wrong job: bond not credited to employer");
                    }
                }
            } else {
                bytes memory good = _land(orderId, o.employer, c.jobId, true, true);
                _call(abi.encodeCall(desk.settle, (orderId, good, _none())), address(0), "settle");
            }
        } else if (s == IWorkOrders.State.Asserted) {
            if (choice % 3 == 0 && vm.getBlockTimestamp() < uint256(c.assertedAt) + desk.CHALLENGE_WINDOW()) {
                _call(abi.encodeCall(desk.challenge, (orderId)), runner, "challenge");
            } else if (choice % 3 == 1) {
                bytes memory wrong = _land(orderId, o.employer, c.jobId, false, true);
                _call(abi.encodeCall(desk.reportFailed, (orderId, wrong, _none())), address(0), "reportFailed.asserted");
            } else {
                _warpTo(uint256(c.assertedAt) + desk.CHALLENGE_WINDOW());
                _call(abi.encodeCall(desk.finalize, (orderId)), address(0), "finalize");
            }
        } else if (s == IWorkOrders.State.Disputed) {
            if (choice % 3 == 0) {
                bytes memory good = _land(orderId, o.employer, c.jobId, true, true);
                _call(abi.encodeCall(desk.settle, (orderId, good, _none())), address(0), "settle.disputed");
            } else if (choice % 3 == 1) {
                bytes memory wrong = _land(orderId, o.employer, c.jobId, false, true);
                _call(abi.encodeCall(desk.reportFailed, (orderId, wrong, _none())), address(0), "reportFailed.disputed");
            } else {
                _warpTo(uint256(c.registeredAt) + o.deliverySecs);
                _call(abi.encodeCall(desk.timeout, (orderId)), address(0), "timeout.disputed");
            }
        }
    }

    // ---- views for the invariants -----------------------------------------------------------------------

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

    function trackedCount() external view returns (uint256) {
        return tracked.length;
    }

    function potIds() external view returns (uint256[] memory) {
        return _potIds;
    }

    function funders() external view returns (address[] memory) {
        return _funders;
    }

    // ---- helpers ----------------------------------------------------------------------------------------

    function _call(bytes memory data, address as_, string memory what) internal returns (bool ok) {
        if (as_ != address(0)) vm.prank(as_);
        (ok,) = address(desk).call(data);
        if (!ok) _unexpected(what);
        else ++hits[bytes32(bytes(what))];
    }

    /// @dev The two endings of `reportFailed` that return the bond whole: a receipt with the
    /// order's own objective that is not `completed` (only the runner may report it) or that is
    /// `completed` under another kind (anyone may). Checks what `docs/THREATS.md` W2, W3 and C2
    /// say of them: the runner's balance rises by exactly the bond, the employer is credited
    /// nothing but the escrow when the order has expired, the runner is not barred, and the order
    /// is open again or refunded, never anything else. A stranger reporting the failed job is
    /// refused (`NotRunner`), and a report that passes is counted so the soak test knows the path
    /// was walked.
    function _reportWithBondBack(
        uint256 orderId,
        IWorkOrdersRunner.Order memory o,
        IWorkOrdersRunner.Claim memory c,
        bytes memory record,
        address as_,
        address stranger,
        string memory what
    ) internal {
        bytes memory data = abi.encodeCall(desk.reportFailed, (orderId, record, _none()));
        if (as_ == c.runner && stranger != c.runner) {
            vm.prank(stranger);
            (bool strangerOk,) = address(desk).call(data);
            if (strangerOk) _unexpected("a stranger reported the runner's failed job");
        }
        uint256 runnerBefore = imd.balanceOf(c.runner);
        uint256 employerBefore = imd.balanceOf(o.employer);
        uint256 returnedBefore = _returnedOf(orderId);
        bool expired = vm.getBlockTimestamp() >= o.expiresAt;
        if (!_call(data, as_, what)) return;
        ++bondsReturnedWhole;
        IWorkOrders.State ended = desk.stateOf(orderId);
        if (imd.balanceOf(c.runner) != runnerBefore + o.bond) {
            _unexpected(string.concat(what, ": bond not returned whole"));
        }
        if (desk.barred(orderId, c.runner)) _unexpected(string.concat(what, ": runner barred"));
        uint256 returnedNow = _returnedOf(orderId);
        uint256 credited = returnedNow >= returnedBefore ? returnedNow - returnedBefore : type(uint256).max;
        if (expired) {
            if (ended != IWorkOrders.State.Refunded) _unexpected(string.concat(what, ": expired order not refunded"));
            if (credited != o.escrow) _unexpected(string.concat(what, ": refund credited != escrow"));
            if (imd.balanceOf(o.employer) != employerBefore + o.escrow) {
                _unexpected(string.concat(what, ": refund sent != escrow"));
            }
            if (o.employer == address(pots)) ++potsEndedWithNoBondForfeited;
        } else {
            if (ended != IWorkOrders.State.Open) _unexpected(string.concat(what, ": order not open again"));
            if (credited != 0) _unexpected(string.concat(what, ": employer credited on a bond-back ending"));
            if (imd.balanceOf(o.employer) != employerBefore) _unexpected(string.concat(what, ": employer paid"));
        }
    }

    function _returnedOf(uint256 orderId) internal view returns (uint256 returned) {
        (,,,, returned) = desk.accountOf(orderId);
    }

    function _unexpected(string memory what) internal {
        if (unexpectedReverts == 0) firstUnexpected = what;
        ++unexpectedReverts;
    }

    /// @dev The registry writes a receipt for the order's registered job: the right kind for its
    /// employer (a picture for the Doorbell, a research report for everyone else), completed with
    /// the claim's own objective, or blocked, or completed for some other objective.
    function _land(uint256 orderId, address employer, bytes16 jobId, bool sameObjective, bool completed)
        internal
        returns (bytes memory record)
    {
        bytes memory spec =
            employer == address(bell) ? bytes(bell.SPEC()) : employer == address(pots) ? POT_SPEC : WALLET_SPEC;
        bytes memory objective = sameObjective
            ? bytes.concat(desk.headerOf(orderId), spec)
            : bytes("A job that no order on this desk asked for.");
        if (employer == address(bell)) {
            record = completed
                ? _recordFrom(PICTURE_FIXTURE, jobId, objective)
                : _recordOf(jobId, "skill:create-image", objective, "blocked");
        } else {
            record = _recordOf(jobId, REAL_KIND, objective, completed ? "completed" : "blocked");
        }
        _write(jobId, record);
    }

    /// @dev The registry writes a `completed` receipt for the registered job with the order's own
    /// objective but under the other kind: a research report for a Doorbell order, a picture for
    /// everyone else. Such a receipt can never settle the order.
    function _landOtherKind(uint256 orderId, address employer, bytes16 jobId) internal returns (bytes memory record) {
        bytes memory spec =
            employer == address(bell) ? bytes(bell.SPEC()) : employer == address(pots) ? POT_SPEC : WALLET_SPEC;
        bytes memory objective = bytes.concat(desk.headerOf(orderId), spec);
        record = employer == address(bell)
            ? _recordOf(jobId, REAL_KIND, objective, "completed")
            : _recordFrom(PICTURE_FIXTURE, jobId, objective);
        _write(jobId, record);
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _warpTo(uint256 time) internal {
        if (vm.getBlockTimestamp() < time) vm.warp(time);
    }
}

/// @title The whole launch under random call sequences
/// @notice The four contracts are created from the manifest in `docs/LAUNCH.md`, word for word,
/// with the three mainnet dependencies stood in for at their real addresses (a plain token at IMD's,
/// a registry at the WorkRegistry's, a Payroll at launch 1531's). Then everything that can hold or
/// move IMD is driven at once, and after every call:
///
/// - the desk holds exactly the escrows and bonds of its live orders;
/// - no IMD is created or lost among every party;
/// - the Doorbell's IMD leaves only as the escrow of its own orders, one `MAX_PAY` per hire;
/// - CrowdPots' balance covers what it has booked to contributors, and its IMD leaves only for the
///   desk or for contributors;
/// - no allowance is left behind by any of the three contracts;
/// - WorkProof never holds IMD, and every order's employer is who the model says;
/// - a receipt that shows the swarm did not complete the order's own job, or ran it under another
///   kind, returns the bond whole and credits the employer nothing but an expired order's escrow,
///   while a job that is not the order's forfeits the bond to the employer (the handler checks
///   each such report as it is made; `docs/THREATS.md`, W2, W3 and C2).
///
/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 120
/// forge-config: default.invariant.fail-on-revert = false
contract LaunchSystemInvariantTest is LaunchKit, Receipts {
    WorkProof internal proof;
    WorkOrders internal desk;
    CrowdPots internal pots;
    Doorbell internal bell;
    LaunchSystemHandler internal handler;
    MockIMD internal imd;

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.chainId(1);
        // The three outside contracts, stood in for at the addresses the manifest names.
        vm.etch(Mainnet.IMD, address(new MockIMD()).code);
        vm.etch(Mainnet.WORK_REGISTRY, address(new RegistryStandIn()).code);
        vm.etch(Mainnet.PAYROLL, address(new PayrollStandIn(Mainnet.IMD)).code);
        imd = MockIMD(Mainnet.IMD);
        registry = RegistryStandIn(Mainnet.WORK_REGISTRY);

        (address[] memory made,,) = _createFromManifest();
        proof = WorkProof(made[0]);
        desk = WorkOrders(made[1]);
        pots = CrowdPots(made[2]);
        bell = Doorbell(made[3]);
        handler = new LaunchSystemHandler(desk, pots, bell);

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = LaunchSystemHandler.fundBell.selector;
        selectors[1] = LaunchSystemHandler.ring.selector;
        selectors[2] = LaunchSystemHandler.openPot.selector;
        selectors[3] = LaunchSystemHandler.chip.selector;
        selectors[4] = LaunchSystemHandler.launchPot.selector;
        selectors[5] = LaunchSystemHandler.reconcile.selector;
        selectors[6] = LaunchSystemHandler.claimRefund.selector;
        selectors[7] = LaunchSystemHandler.walletOrder.selector;
        selectors[8] = LaunchSystemHandler.warp.selector;
        selectors[9] = LaunchSystemHandler.deskStep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_theDeskHoldsExactlyWhatItOwes() public view {
        assertEq(imd.balanceOf(address(desk)), handler.owed(), "desk balance != live escrows + live bonds");
    }

    function invariant_imdIsConserved() public view {
        assertEq(handler.trackedTotal(), handler.totalMinted(), "IMD appeared or vanished");
        assertEq(imd.totalSupply(), handler.totalMinted());
    }

    function invariant_theDoorbellsMoneyLeavesOnlyAsItsOwnEscrow() public view {
        uint256 toDesk = imd.sent(address(bell), address(desk));
        assertEq(imd.sentTotal(address(bell)), toDesk, "the Doorbell paid somebody other than the desk");
        assertEq(toDesk, uint256(bell.hires()) * LaunchValues.BELL_MAX_PAY);
        assertLe(bell.hires(), handler.rang() / bell.RINGS_PER_HIRE());
        assertEq(bell.rings(), handler.rang());
        uint256 returned;
        uint256 n = desk.orderCount();
        for (uint256 id = 1; id <= n; ++id) {
            if (handler.employerOf(id) != address(bell)) continue;
            (,,,, uint96 back) = desk.accountOf(id);
            returned += back;
            assertEq(desk.orderOf(id).employer, address(bell));
            assertEq(desk.orderOf(id).maxPay, LaunchValues.BELL_MAX_PAY);
            assertEq(desk.orderOf(id).bond, LaunchValues.BELL_BOND);
        }
        assertEq(imd.balanceOf(address(bell)), handler.funded() + returned - bell.hires() * LaunchValues.BELL_MAX_PAY);
    }

    function invariant_thePotsCoverWhatTheyOweAndPayOnlyTheDeskOrContributors() public view {
        assertGe(imd.balanceOf(address(pots)), pots.owed(), "CrowdPots holds less than it booked");
        uint256 toContributors;
        address[] memory funders = handler.funders();
        for (uint256 i; i < funders.length; ++i) {
            toContributors += imd.sent(address(pots), funders[i]);
        }
        assertEq(imd.sentTotal(address(pots)), imd.sent(address(pots), address(desk)) + toContributors);
        uint256[] memory ids = handler.potIds();
        uint256 launchedCount;
        for (uint256 i; i < ids.length; ++i) {
            CrowdPots.Pot memory p = pots.potOf(ids[i]);
            assertLe(p.raised, p.target);
            if (handler.launched(ids[i])) {
                ++launchedCount;
                assertEq(desk.orderOf(p.orderId).employer, address(pots));
                assertEq(desk.orderOf(p.orderId).maxPay, p.target);
            }
        }
        assertEq(launchedCount, handler.potsLaunched());
    }

    function invariant_everyOrderHasTheEmployerTheModelSays() public view {
        uint256 n = desk.orderCount();
        assertEq(n, bell.hires() + handler.potsLaunched() + handler.walletOrders(), "an order nobody opened");
        for (uint256 id = 1; id <= n; ++id) {
            assertEq(desk.orderOf(id).employer, handler.employerOf(id));
        }
    }

    function invariant_noAllowanceIsLeftBehind() public view {
        assertEq(imd.allowance(address(desk), Mainnet.PAYROLL), 0, "the desk left Payroll an allowance");
        assertEq(imd.allowance(address(bell), address(desk)), 0, "the Doorbell left the desk an allowance");
        assertEq(imd.allowance(address(pots), address(desk)), 0, "CrowdPots left the desk an allowance");
        assertEq(imd.balanceOf(address(proof)), 0, "WorkProof holds IMD");
    }

    function invariant_noSteeredActionReverted() public view {
        assertEq(handler.unexpectedReverts(), 0, handler.firstUnexpected());
    }

    /// @notice A long fixed sequence through the same handler, so that the random runs above are
    /// known to reach what they claim to check: the Doorbell hires, pots launch and refund, wallet
    /// orders are taken, and orders end every way the desk allows. Every invariant is checked along
    /// the way.
    function test_soak_theWholeLaunchReachesEveryPathAndKeepsEveryRule() public {
        for (uint256 i; i < 2500; ++i) {
            uint256 r = uint256(keccak256(abi.encode("launch B soak", i)));
            uint256 a = r >> 8;
            uint256 b = uint256(keccak256(abi.encode(r)));
            uint256 roll = r % 100;
            if (roll < 8) handler.fundBell(a, b);
            else if (roll < 20) handler.ring(a, b);
            else if (roll < 25) handler.openPot(a, b);
            else if (roll < 35) handler.chip(a, b, b >> 128);
            else if (roll < 42) handler.launchPot(a, b);
            else if (roll < 47) handler.reconcile(a);
            else if (roll < 54) handler.claimRefund(a, b);
            else if (roll < 60) handler.walletOrder(a, b);
            else if (roll < 68) handler.warp(a);
            else handler.deskStep(a, b, b >> 64);
            if (i % 250 == 0) _checkAll();
        }
        _checkAll();

        emit log_named_uint("rings", bell.rings());
        emit log_named_uint("hires", bell.hires());
        emit log_named_uint("deliveries reported to the Doorbell", bell.receipts());
        emit log_named_uint("pots launched", handler.potsLaunched());
        emit log_named_uint("wallet orders", handler.walletOrders());
        emit log_named_uint("orders on the desk", desk.orderCount());
        assertGt(bell.hires(), 0, "the Doorbell never hired");
        assertGt(bell.receipts(), 0, "no Doorbell order was ever delivered");
        assertGt(handler.potsLaunched(), 0, "no pot ever launched");
        assertGt(handler.walletOrders(), 0, "no wallet ever ordered");

        string[14] memory paths = [
            "refund",
            "cancel",
            "claim",
            "release",
            "evict",
            "register",
            "claimDelivered",
            "timeout",
            "reportFailed",
            "reportFailed.wrongKind",
            "reportFailed.wrongJob",
            "settle",
            "challenge",
            "finalize"
        ];
        for (uint256 i; i < paths.length; ++i) {
            emit log_named_uint(paths[i], handler.hits(bytes32(bytes(paths[i]))));
        }
        // How the disputes ended is logged; which ending a given sequence reaches is chance.
        emit log_named_uint("settle.disputed", handler.hits("settle.disputed"));
        emit log_named_uint("reportFailed.disputed", handler.hits("reportFailed.disputed"));
        emit log_named_uint("timeout.disputed", handler.hits("timeout.disputed"));
        emit log_named_uint("claims ended with the bond returned whole", handler.bondsReturnedWhole());
        emit log_named_uint("pots refunded by such an ending", handler.potsEndedWithNoBondForfeited());
        assertEq(
            handler.bondsReturnedWhole(),
            handler.hits("reportFailed") + handler.hits("reportFailed.wrongKind"),
            "a bond-back ending was counted that was not reported"
        );
        for (uint256 i; i < paths.length; ++i) {
            assertGt(handler.hits(bytes32(bytes(paths[i]))), 0, string.concat("never reached: ", paths[i]));
        }
        assertGt(
            handler.hits("settle.disputed") + handler.hits("reportFailed.disputed") + handler.hits("timeout.disputed"),
            0,
            "no dispute ever ended"
        );
        // Pots reached an ending, and at least one contributor was paid. Whether a given fixed
        // sequence delivers a pot's order or refunds it is chance; both counts are logged.
        uint256[] memory ids = handler.potIds();
        uint256 delivered;
        uint256 refundable;
        for (uint256 i; i < ids.length; ++i) {
            CrowdPots.Stage s = pots.stageOf(ids[i]);
            if (s == CrowdPots.Stage.Delivered) ++delivered;
            if (s == CrowdPots.Stage.Refundable) ++refundable;
        }
        emit log_named_uint("pots delivered", delivered);
        emit log_named_uint("pots refundable", refundable);
        assertGt(delivered + refundable, 0, "no pot ever ended");
        uint256 paidOut;
        address[] memory funders = handler.funders();
        for (uint256 i; i < funders.length; ++i) {
            paidOut += imd.sent(address(pots), funders[i]);
        }
        assertGt(paidOut, 0, "no contributor was ever refunded");
    }

    /// @notice The ending the random runs seldom reach on a pot, driven by hand on the
    /// manifest-made contracts: the runbook's first pot opened receipt-only, filled and launched;
    /// a runner takes the order an hour before its hire window closes, registers a job, and the
    /// registry's receipt says the job did not complete. Nobody but the runner may report that
    /// receipt, so the order cannot be freed sooner; once the window has passed, the runner's own
    /// report refunds the order and so the pot, with the whole bond back and nothing forfeited
    /// (`docs/THREATS.md`, W3 and C2). The desk still holds exactly what it owes afterwards, and
    /// the contributors get back exactly what they chipped in.
    function test_launch_aReceiptOnlyPotIsRefundedByTheRunnersOwnFailedReceipt_withNoBondForfeited() public {
        (CrowdPots.Terms memory t, bytes memory spec) = _firstPot();
        t.allowClaimed = false;
        address opener = makeAddr("opener");
        address funder = makeAddr("late funder");
        address runner = makeAddr("honest runner");
        address stranger = makeAddr("stranger");
        imd.mint(opener, t.target);
        imd.mint(funder, t.target);
        imd.mint(runner, t.bond);
        vm.startPrank(opener);
        imd.approve(address(pots), type(uint256).max);
        uint256 potId = pots.openPot(t, spec, 1);
        vm.stopPrank();
        vm.startPrank(funder);
        imd.approve(address(pots), type(uint256).max);
        pots.chipIn(potId, t.target - 1);
        uint256 orderId = pots.launch(potId, spec);
        vm.stopPrank();
        uint256 expiresAt = pots.potOf(potId).orderExpiresAt;
        assertEq(expiresAt, desk.orderOf(orderId).expiresAt);

        vm.warp(expiresAt - 1 hours);
        bytes16 job = bytes16(keccak256("the first pot's job"));
        vm.startPrank(runner);
        imd.approve(address(desk), t.bond);
        desk.claim(orderId);
        desk.register(orderId, job);
        vm.stopPrank();
        assertEq(imd.balanceOf(runner), 0, "the bond is posted");
        bytes memory blocked = _recordOf(job, REAL_KIND, bytes.concat(desk.headerOf(orderId), spec), "blocked");
        _write(job, blocked);

        // Nobody else may end it, before or after the window; `timeout` is a week away.
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.reportFailed(orderId, blocked, new address[](0));
        vm.warp(expiresAt);
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.reportFailed(orderId, blocked, new address[](0));
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.timeout(orderId);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring), "held past its window");

        vm.prank(runner);
        desk.reportFailed(orderId, blocked, new address[](0));
        assertEq(uint256(desk.stateOf(orderId)), uint256(IWorkOrders.State.Refunded));
        assertEq(imd.balanceOf(runner), t.bond, "the whole bond came back");
        assertFalse(desk.barred(orderId, runner));
        (,,,, uint96 returned) = desk.accountOf(orderId);
        assertEq(returned, t.target, "the escrow and not one wei of bond");
        assertEq(imd.balanceOf(address(desk)), handler.owed(), "the desk holds exactly what it owes");

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));
        assertEq(pots.claimRefund(potId, opener), 1);
        assertEq(pots.claimRefund(potId, funder), t.target - 1);
        assertEq(imd.balanceOf(opener) + imd.balanceOf(funder), 2 * uint256(t.target), "exactly the chips, no more");
        assertEq(imd.balanceOf(address(pots)), pots.owed(), "nothing stranded in the pots");
    }

    function _checkAll() internal view {
        invariant_theDeskHoldsExactlyWhatItOwes();
        invariant_imdIsConserved();
        invariant_theDoorbellsMoneyLeavesOnlyAsItsOwnEscrow();
        invariant_thePotsCoverWhatTheyOweAndPayOnlyTheDeskOrContributors();
        invariant_everyOrderHasTheEmployerTheModelSays();
        invariant_noAllowanceIsLeftBehind();
        invariant_noSteeredActionReverted();
    }
}
