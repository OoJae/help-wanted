// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {stdJson} from "forge-std/StdJson.sol";
import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {Doorbell} from "../../src/pots/Doorbell.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {Receipts} from "../kit/Receipts.sol";
import {RegistryStandIn} from "../kit/RegistryStandIn.sol";
import {MockIMD} from "./mocks/MockIMD.sol";

/// @notice CrowdPots and the Doorbell on the real hire desk, driven the way an outside runner
/// would drive it: through `IWorkOrdersRunner` and nothing else. For every way an order can end,
/// the IMD the desk pushes to the pot must equal what `accountOf().returned` reports, because that
/// figure is all a pot keeps its books from.
///
/// @dev The launch's four contracts are deployed as the manifest has them. Receipts are real work
/// records carrying the order's header, proven by the real WorkProof; only IMD, the registry and
/// Payroll, which are not part of this project, are stand-ins.
contract PotsRealDeskTest is Receipts {
    using stdJson for string;

    MockIMD internal imd;
    WorkProof internal proof;
    IWorkOrdersRunner internal desk;
    CrowdPots internal pots;
    Doorbell internal bell;

    address internal payroll;
    /// @dev The record of the last receipt a test landed.
    bytes internal landed;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal runner = makeAddr("runner");
    address internal runner2 = makeAddr("runner2");
    address internal challenger = makeAddr("challenger");

    bytes internal constant SPEC = "Research report: who paid the IdentityMD swarm this week, and for what?";
    string internal constant KIND = REAL_KIND;
    string internal constant PICTURE_KIND = "skill:create-image";
    bytes32 internal constant PICTURE = keccak256(bytes(PICTURE_KIND));
    /// @dev The real record of a picture job (job df6805ee), whose kind is `skill:create-image`.
    string internal constant PICTURE_FIXTURE = "df6805ee-skill-create-image-7dd1a0a2.hex";
    bytes16 internal constant JOB = 0xe9efec1656f340d3924352c453effc7d;
    bytes32 internal constant RECEIPT = 0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5;
    string internal constant COMPLETED = "completed";
    string internal constant BLOCKED = "blocked";
    uint256 internal constant WALLET = 1_000e18;
    uint256 internal constant TARGET = 10e18 + 3;

    function setUp() public {
        vm.warp(1_760_000_000);
        imd = new MockIMD();
        registry = new RegistryStandIn();
        payroll = address(new PayrollStandIn(address(imd)));
        // The launch's contracts, in manifest order.
        proof = new WorkProof(address(registry));
        desk = IWorkOrdersRunner(address(new WorkOrders(address(imd), address(proof), payroll)));
        pots = new CrowdPots(address(imd), address(desk));
        bell = new Doorbell(address(imd), address(desk), PICTURE, 1e18, 2e18, 0.5e18, 3 days, true);
        address[5] memory who = [alice, bob, runner, runner2, challenger];
        for (uint256 i; i < who.length; ++i) {
            imd.mint(who[i], WALLET);
            vm.startPrank(who[i]);
            imd.approve(address(pots), type(uint256).max);
            imd.approve(address(desk), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------

    function _terms(bool allowClaimed) internal pure returns (CrowdPots.Terms memory) {
        return CrowdPots.Terms({
            kind: KIND,
            target: uint96(TARGET),
            minPay: 4e18,
            rampSecs: 1 days,
            bond: 1e18,
            deliverySecs: 3 days,
            hireSecs: 30 days,
            fundSecs: 3 days,
            allowClaimed: allowClaimed
        });
    }

    /// @dev A pot of 10 IMD and 3 wei: alice 6, bob the rest. Launched at once.
    function _launched(bool allowClaimed) internal returns (uint256 potId, uint256 orderId) {
        vm.prank(alice);
        potId = pots.openPot(_terms(allowClaimed), SPEC, 6e18);
        vm.prank(bob);
        pots.chipIn(potId, 100e18);
        orderId = pots.launch(potId, SPEC);
    }

    function _takeAndRegister(uint256 orderId, address who, bytes16 jobId) internal {
        vm.startPrank(who);
        desk.claim(orderId);
        desk.register(orderId, jobId);
        vm.stopPrank();
    }

    /// @dev The registry writes a receipt for `jobId`: a real work record whose objective is that
    /// of the order's current claim (its header followed by the spec), with the given kind and
    /// final state.
    function _landReceipt(uint256 orderId, bytes16 jobId, string memory kind, bytes memory spec, string memory state)
        internal
    {
        landed = _recordOf(jobId, kind, bytes.concat(desk.headerOf(orderId), spec), state);
        _write(jobId, landed);
    }

    /// @dev Anyone settles the order with the record that was landed.
    function _settle(uint256 orderId) internal {
        desk.settle(orderId, landed, new address[](0));
    }

    function _returned(uint256 orderId) internal view returns (uint256 returned) {
        (,,,, returned) = desk.accountOf(orderId);
    }

    function _state(uint256 orderId) internal view returns (IWorkOrders.State) {
        return desk.stateOf(orderId);
    }

    /// @dev The one thing a pot relies on: what the desk says it sent back is what arrived.
    function _assertPushedWhatItReports(uint256 orderId) internal view {
        assertEq(imd.balanceOf(address(pots)), _returned(orderId), "the desk pushed exactly what it reports");
    }

    function _claimBoth(uint256 potId) internal returns (uint256 total) {
        total = pots.claimRefund(potId, alice) + pots.claimRefund(potId, bob);
        assertEq(imd.balanceOf(address(pots)), 0, "paid out to the wei");
        assertEq(pots.owed(), 0);
    }

    function _ring25(Doorbell b) internal {
        for (uint256 i; i < 25; ++i) {
            b.ring();
        }
    }

    // ------------------------------------------------------------------------------------------
    // What the desk accepts
    // ------------------------------------------------------------------------------------------

    function test_realDesk_namesTheTokenAndMinimumsThePotChecks() public view {
        assertEq(desk.IMD(), address(imd));
        assertEq(desk.MIN_BOND(), 0.25e18);
        assertEq(desk.MIN_DELIVERY(), 3 days);
        assertEq(desk.FLAG_ALLOW_CLAIMED() & desk.FLAG_CALLBACK(), 0, "two different bits");
    }

    function test_realDesk_acceptsAPotAtEveryBound() public {
        CrowdPots.Terms memory t = _terms(false);
        t.target = pots.MIN_TARGET();
        t.minPay = 1;
        t.rampSecs = 1 days;
        t.bond = desk.MIN_BOND();
        t.deliverySecs = desk.MIN_DELIVERY();
        t.hireSecs = pots.MIN_HIRE_SECS();
        t.fundSecs = pots.MIN_FUND_SECS();
        vm.prank(alice);
        uint256 potId = pots.openPot(t, SPEC, t.target);
        // At the last second a full pot can be launched.
        vm.warp(uint256(pots.potOf(potId).deadline) + pots.LAUNCH_GRACE());
        uint256 orderId = pots.launch(potId, SPEC);
        (IWorkOrders.State state, address employer, uint96 escrow,,) = desk.accountOf(orderId);
        assertEq(uint256(state), uint256(IWorkOrders.State.Open));
        assertEq(employer, address(pots));
        assertEq(escrow, t.target);

        t.target = type(uint96).max;
        t.minPay = t.target;
        t.rampSecs = 0;
        t.bond = t.target;
        t.deliverySecs = pots.MAX_DELIVERY_SECS();
        t.hireSecs = pots.MAX_HIRE_SECS();
        t.fundSecs = pots.MAX_FUND_SECS();
        t.allowClaimed = true;
        imd.mint(alice, type(uint96).max);
        vm.prank(alice);
        potId = pots.openPot(t, SPEC, type(uint96).max);
        pots.launch(potId, SPEC);
        assertEq(imd.allowance(address(pots), address(desk)), 0);
    }

    function test_realDesk_acceptsTheLongestSpec() public {
        bytes memory spec = new bytes(7_900);
        for (uint256 i; i < spec.length; ++i) {
            spec[i] = "a";
        }
        vm.prank(alice);
        uint256 potId = pots.openPot(_terms(true), spec, TARGET);
        pots.launch(potId, spec);
        assertLt(vm.lastCallGas().gasTotalUsed, 900_000, "launching the longest spec stays well inside a block");
    }

    /// The pot checks a spec when it opens so that a full pot is never refused at launch. It uses
    /// the desk's own rule (`SpecText`), and this shows the two contracts give the same verdict on
    /// every input, down to the index of the fault.
    function test_realDesk_thePotAndTheDeskGiveTheSameVerdictOnASpec() public {
        imd.mint(alice, 10_000e18);

        string memory json = vm.readFile("test/fixtures/pots/specs.json");
        string[] memory valid = json.readStringArray(".validText");
        bytes[] memory invalid = json.readBytesArray(".invalidHex");
        uint256[] memory invalidAt = json.readUintArray(".invalidAt");
        for (uint256 i; i < valid.length; ++i) {
            (bool accepted,) = _sameVerdict(bytes(valid[i]));
            assertTrue(accepted, "a valid fixture is accepted by both");
        }
        for (uint256 i; i < invalid.length; ++i) {
            (bool accepted, uint256 at) = _sameVerdict(invalid[i]);
            assertFalse(accepted, "an invalid fixture is refused by both");
            assertEq(at, invalidAt[i], "at the byte the fixture names");
        }

        // The length limit, on both sides of it.
        bytes memory longest = new bytes(7_901);
        for (uint256 i; i < longest.length; ++i) {
            longest[i] = "a";
        }
        (bool ok,) = _sameVerdict(longest);
        assertFalse(ok);
        assembly ("memory-safe") {
            mstore(longest, 7900)
        }
        (ok,) = _sameVerdict(longest);
        assertTrue(ok);

        // Generated text of 1 to 96 bytes: printable characters, and in two cases out of three
        // one byte of any value at all, wherever it falls (an end, a word boundary, the middle).
        uint256 acceptedCount;
        uint256 seed = uint256(keccak256("spec rules against the real desk"));
        for (uint256 n; n < 300; ++n) {
            seed = uint256(keccak256(abi.encode(seed)));
            bytes memory spec = new bytes(1 + seed % 96);
            for (uint256 i; i < spec.length; ++i) {
                spec[i] = bytes1(0x20 + uint8(uint256(keccak256(abi.encode(seed, i))) % 95));
            }
            if (seed % 3 != 0) spec[(seed >> 8) % spec.length] = bytes1(uint8(seed >> 16));
            (ok,) = _sameVerdict(spec);
            if (ok) ++acceptedCount;
        }
        assertGt(acceptedCount, 30, "both kinds of text were tried");
        assertLt(acceptedCount, 270);
    }

    /// @dev Asks the pots and the desk about `spec`, requires that they agree (with the same error
    /// at the same byte when they refuse), and says whether it was accepted and, if not, where.
    function _sameVerdict(bytes memory spec) internal returns (bool accepted, uint256 at) {
        bytes memory potWhy;
        vm.prank(alice);
        (accepted, potWhy) = address(pots).call(abi.encodeCall(pots.openPot, (_terms(false), spec, 0)));

        IWorkOrders.OrderParams memory p;
        p.kindHash = keccak256(bytes(KIND));
        p.minPay = 1e18;
        p.maxPay = 1e18;
        p.deliverySecs = 3 days;
        p.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);
        p.bond = 0.25e18;
        vm.prank(alice);
        (bool deskSays, bytes memory deskWhy) = address(desk).call(abi.encodeCall(desk.createOrder, (p, spec)));

        assertEq(accepted, deskSays, "accepted by one and refused by the other");
        if (!accepted) {
            assertEq(bytes4(potWhy), CrowdPots.SpecInvalid.selector);
            assertEq(potWhy, deskWhy, "the same error, at the same byte");
            assembly ("memory-safe") {
                at := mload(add(potWhy, 0x24))
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Every ending of an order: the push equals the report
    // ------------------------------------------------------------------------------------------

    function test_realDesk_releaseEvictAndTimeout_thenAClaimedDelivery() public {
        (uint256 potId, uint256 orderId) = _launched(true);

        // A runner gives the order back: a tenth of its bond.
        vm.startPrank(runner2);
        desk.claim(orderId);
        desk.release(orderId);
        vm.stopPrank();
        assertEq(_returned(orderId), 0.1e18);
        _assertPushedWhatItReports(orderId);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        // A runner registers nothing: the whole bond, and the pot itself has the desk evict it.
        vm.prank(challenger);
        desk.claim(orderId);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Open), "evicted through the pot");
        assertEq(_returned(orderId), 1.1e18);
        _assertPushedWhatItReports(orderId);

        // A runner registers a job and no receipt comes: the whole bond, through the pot again.
        _takeAndRegister(orderId, challenger, bytes16(uint128(7)));
        vm.warp(vm.getBlockTimestamp() + 3 days);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Open), "timed out through the pot");
        assertEq(_returned(orderId), 2.1e18);
        _assertPushedWhatItReports(orderId);
        assertEq(pots.owed(), 0, "nothing is booked while the order can still move");

        // A runner claims delivery, nobody challenges, and the claim is paid after a day.
        _takeAndRegister(orderId, runner, JOB);
        vm.prank(runner);
        desk.claimDelivered(orderId, RECEIPT);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.cool(address(pots));
        desk.finalize(orderId);
        assertEq(pots.potOf(potId).jobId, JOB, "the callback landed on cold storage inside the desk's gas allowance");
        assertEq(pots.potOf(potId).recordHash, RECEIPT);

        (IWorkOrders.State state,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(orderId);
        assertEq(uint256(state), uint256(IWorkOrders.State.Delivered));
        assertEq(escrow, 0);
        assertEq(uint256(spent) + returned, TARGET + 2.1e18, "the target and the three forfeits");
        _assertPushedWhatItReports(orderId);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));
        assertEq(pots.potOf(potId).pool, returned);
        assertEq(_claimBoth(potId), returned);
    }

    function test_realDesk_provenDelivery_theCallbackLandsAndTheBooksAreExact() public {
        (uint256 potId, uint256 orderId) = _launched(false);
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        _takeAndRegister(orderId, runner, JOB);
        _landReceipt(orderId, JOB, KIND, SPEC, COMPLETED);
        vm.cool(address(pots));
        _settle(orderId);

        assertEq(pots.potOf(potId).jobId, JOB);
        assertEq(pots.potOf(potId).recordHash, keccak256(landed), "the receipt's own hash");
        (,,, uint96 spent, uint96 returned) = desk.accountOf(orderId);
        // A quarter of the way up a ramp from 4 IMD to the target.
        assertEq(spent, 4e18 + (TARGET - 4e18) / 4);
        assertEq(uint256(spent) + returned, TARGET);
        _assertPushedWhatItReports(orderId);
        assertEq(_claimBoth(potId), returned);
        assertEq(imd.balanceOf(payroll), (uint256(spent) * 500 + 9_999) / 10_000 * 2, "fee and tip, each rounded up");
    }

    function test_realDesk_anOrderNobodyTakes_isRefundedByOneClaim() public {
        (uint256 potId, uint256 orderId) = _launched(false);
        vm.warp(pots.potOf(potId).orderExpiresAt);
        assertEq(uint256(pots.stageOf(potId)), uint256(CrowdPots.Stage.Refundable), "the view looks one step ahead");
        assertEq(pots.refundOf(potId, alice), 6e18);

        assertEq(pots.claimRefund(potId, alice), 6e18);
        assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Refunded));
        assertEq(pots.claimRefund(potId, bob), 4e18 + 3);
        assertEq(imd.balanceOf(address(pots)), 0);
    }

    /// A runner takes the order just before it expires, registers a job and goes silent. Nobody
    /// calls the desk: the pot's own call to the real desk's `timeout` ends the claim, so one
    /// `claimRefund` is enough.
    function test_realDesk_aSilentRunner_isTimedOutByOneClaim() public {
        (uint256 potId, uint256 orderId) = _launched(false);
        vm.warp(pots.potOf(potId).orderExpiresAt - 1);
        _takeAndRegister(orderId, runner, JOB);

        vm.warp(vm.getBlockTimestamp() + 3 days - 1);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Hiring));
        pots.claimRefund(potId, alice);

        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 paid = pots.claimRefund(potId, alice);
        assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Refunded));
        assertEq(_returned(orderId), TARGET + 1e18, "the escrow and the silent runner's bond");
        assertEq(paid, (TARGET + 1e18) * 6e18 / TARGET);
        assertEq(paid + pots.claimRefund(potId, bob), TARGET + 1e18);
        assertEq(imd.balanceOf(address(pots)), 0);
        assertEq(imd.balanceOf(runner), WALLET - 1e18);
    }

    /// A runner takes a receipt-only order shortly before its hire window closes, registers a job,
    /// and the registry's receipt for that job says it did not complete. Nobody but the runner may
    /// report that receipt, so nobody can free the order sooner; once the hire window has passed
    /// the runner's report refunds the order, and so the pot, with the whole bond returned to the
    /// runner and nothing forfeited (`docs/THREATS.md`, W3 and C2).
    function test_realDesk_aFailedJobsReceiptPastTheHireWindow_refundsThePotWithTheBondReturned() public {
        (uint256 potId, uint256 orderId) = _launched(false);
        uint256 expiresAt = pots.potOf(potId).orderExpiresAt;
        vm.warp(expiresAt - 2 days);
        _takeAndRegister(orderId, runner, JOB);
        _landReceipt(orderId, JOB, KIND, SPEC, BLOCKED);

        // A contributor cannot report the swarm's failure for the runner.
        vm.prank(alice);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.reportFailed(orderId, landed, new address[](0));
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        vm.warp(expiresAt + 1);
        assertLt(vm.getBlockTimestamp(), desk.claimOf(orderId).registeredAt + 3 days, "before the delivery deadline");
        vm.prank(runner);
        desk.reportFailed(orderId, landed, new address[](0));

        assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Refunded));
        assertEq(imd.balanceOf(runner), WALLET, "the whole bond came back");
        assertFalse(desk.barred(orderId, runner));
        assertEq(_returned(orderId), TARGET, "the escrow and no bond");
        _assertPushedWhatItReports(orderId);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));
        assertEq(_claimBoth(potId), TARGET, "the contributors get back exactly what they chipped in");
    }

    /// A `completed` receipt of another kind for a job with the order's own objective can never
    /// settle the order. Anyone may report it, the bond comes back whole and the runner is not
    /// barred, so the same address can take the order again at once and repeat the cycle for as
    /// long as the hire window lasts (`docs/THREATS.md`, W2 and C2).
    function test_realDesk_aWrongKindReceipt_reopensWithTheBondReturned_andTheSameRunnerMayTakeItAgain() public {
        (uint256 potId, uint256 orderId) = _launched(false);
        for (uint256 i = 1; i <= 3; ++i) {
            bytes16 job = bytes16(uint128(0x1000 + i));
            _takeAndRegister(orderId, runner, job);
            _landReceipt(orderId, job, PICTURE_KIND, SPEC, COMPLETED);
            vm.prank(alice);
            desk.reportFailed(orderId, landed, new address[](0));

            assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Open));
            assertEq(imd.balanceOf(runner), WALLET, "the whole bond came back");
            assertFalse(desk.barred(orderId, runner));
            assertEq(_returned(orderId), 0, "nothing forfeited to the pot");
            assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        }
        _assertPushedWhatItReports(orderId);
    }

    function test_realDesk_anIdleRunnerOnAnExpiredOrder_isEvictedByOneClaim() public {
        (uint256 potId, uint256 orderId) = _launched(false);
        vm.warp(pots.potOf(potId).orderExpiresAt - 1);
        vm.prank(runner);
        desk.claim(orderId);
        vm.warp(vm.getBlockTimestamp() + 1 hours);

        assertEq(_claimBoth(potId), TARGET + 1e18);
        assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Refunded));
    }

    // ------------------------------------------------------------------------------------------
    // Disputes on a pot that allows claims
    // ------------------------------------------------------------------------------------------

    function _disputed() internal returns (uint256 potId, uint256 orderId) {
        (potId, orderId) = _launched(true);
        _takeAndRegister(orderId, runner, JOB);
        vm.prank(runner);
        desk.claimDelivered(orderId, RECEIPT);
        vm.prank(challenger);
        desk.challenge(orderId);
        assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Disputed));
    }

    /// Nothing decides the dispute by the delivery deadline: the pot is refunded, the challenger
    /// gets its bond back, and the runner forfeits to the pot what a release would have cost.
    function test_realDesk_anUndecidedDispute_refundsThePotWithTheRunnersForfeitedShare() public {
        (uint256 potId, uint256 orderId) = _disputed();
        vm.warp(vm.getBlockTimestamp() + 3 days);

        // No keeper: the pot has the desk end it.
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));
        assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Refunded));
        assertLt(vm.getBlockTimestamp(), pots.potOf(potId).orderExpiresAt, "long before the hire window ends");
        assertEq(_returned(orderId), TARGET + 0.1e18);
        _assertPushedWhatItReports(orderId);
        assertEq(imd.balanceOf(runner), WALLET - 0.1e18, "a tenth of the 1 IMD bond");
        assertEq(imd.balanceOf(challenger), WALLET, "the challenger loses nothing");
        assertEq(_claimBoth(potId), TARGET + 0.1e18);
    }

    function test_realDesk_aDisputeRefutedByAReceipt_reopensWithTheReleaseShare() public {
        (uint256 potId, uint256 orderId) = _disputed();
        // The registered job's receipt shows it did not complete.
        _landReceipt(orderId, JOB, KIND, SPEC, BLOCKED);
        desk.reportFailed(orderId, landed, new address[](0));

        assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Open));
        assertEq(_returned(orderId), 0.1e18);
        _assertPushedWhatItReports(orderId);
        assertEq(imd.balanceOf(challenger), WALLET + 0.9e18);
        assertEq(imd.balanceOf(runner), WALLET - 1e18);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
    }

    function test_realDesk_aDisputeUpheldByAReceipt_delivers() public {
        (uint256 potId, uint256 orderId) = _disputed();
        _landReceipt(orderId, JOB, KIND, SPEC, COMPLETED);
        _settle(orderId);

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));
        assertEq(_returned(orderId), TARGET - 4e18, "the unused escrow and no bond");
        _assertPushedWhatItReports(orderId);
        assertEq(imd.balanceOf(challenger), WALLET - 1e18);
        assertEq(_claimBoth(potId), TARGET - 4e18);
    }

    /// A receipt of the wrong kind contradicts an unchallenged claim: the whole bond to the pot.
    function test_realDesk_anUnchallengedClaimRefutedByAReceipt_givesThePotTheBond() public {
        (uint256 potId, uint256 orderId) = _launched(true);
        _takeAndRegister(orderId, runner, JOB);
        vm.prank(runner);
        desk.claimDelivered(orderId, RECEIPT);
        _landReceipt(orderId, JOB, "audit", SPEC, COMPLETED);
        desk.reportFailed(orderId, landed, new address[](0));

        assertEq(uint256(_state(orderId)), uint256(IWorkOrders.State.Open));
        assertEq(_returned(orderId), 1e18);
        _assertPushedWhatItReports(orderId);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
    }

    // ------------------------------------------------------------------------------------------
    // The callback
    // ------------------------------------------------------------------------------------------

    function test_realDesk_aCallbackThatFailed_arrivesOnceThroughRedeliver() public {
        (uint256 potId, uint256 orderId) = _launched(false);
        _takeAndRegister(orderId, runner, JOB);
        _landReceipt(orderId, JOB, KIND, SPEC, COMPLETED);
        vm.mockCallRevert(address(pots), abi.encodeWithSelector(pots.onWorkDelivered.selector), "no callback");
        _settle(orderId);
        vm.clearMockedCalls();

        assertEq(pots.potOf(potId).jobId, bytes16(0));
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered), "the money does not wait");
        desk.redeliver(orderId);
        assertEq(pots.potOf(potId).jobId, JOB);
        assertEq(pots.potOf(potId).recordHash, keccak256(landed));
        vm.expectRevert();
        desk.redeliver(orderId);
    }

    // ------------------------------------------------------------------------------------------
    // The Doorbell
    // ------------------------------------------------------------------------------------------

    function test_realDesk_theDoorbellHires_andAnUnchallengedClaimIsReportedBack() public {
        vm.prank(alice);
        imd.transfer(address(bell), 2e18);
        _ring25(bell);
        assertLt(vm.lastCallGas().gasTotalUsed, 600_000, "a hiring ring");
        assertEq(bell.hires(), 1);
        uint256 orderId = bell.lastOrderId();
        (IWorkOrders.State state, address employer, uint96 escrow,,) = desk.accountOf(orderId);
        assertEq(uint256(state), uint256(IWorkOrders.State.Open));
        assertEq(employer, address(bell));
        assertEq(escrow, 2e18);

        _takeAndRegister(orderId, runner, JOB);
        vm.prank(runner);
        desk.claimDelivered(orderId, RECEIPT);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.cool(address(bell));
        desk.finalize(orderId);

        assertEq(bell.receipts(), 1, "the callback landed on cold storage inside the desk's gas allowance");
        assertEq(bell.hireOf(orderId).recordHash, RECEIPT);
        assertEq(imd.balanceOf(address(bell)), 1e18, "taken at the starting price: half the escrow came back");
        assertEq(_returned(orderId), 1e18);
    }

    function test_realDesk_aReceiptOnlyDoorbell_refusesAClaimAndPaysOnAReceipt() public {
        Doorbell strict = new Doorbell(address(imd), address(desk), PICTURE, 1e18, 2e18, 0.5e18, 3 days, false);
        vm.prank(alice);
        imd.transfer(address(strict), 2e18);
        _ring25(strict);
        uint256 orderId = strict.lastOrderId();

        _takeAndRegister(orderId, runner, JOB);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ClaimedPathOff.selector);
        desk.claimDelivered(orderId, RECEIPT);

        // The receipt is the real record of a picture job, with the Doorbell's objective.
        landed = _recordFrom(PICTURE_FIXTURE, JOB, bytes.concat(desk.headerOf(orderId), bytes(strict.SPEC())));
        _write(JOB, landed);
        _settle(orderId);
        assertEq(strict.receipts(), 1);
        assertEq(strict.hireOf(orderId).jobId, JOB);
    }

    function test_realDesk_theDoorbellsRefundPaysForItsNextHire() public {
        vm.prank(alice);
        imd.transfer(address(bell), 2e18);
        _ring25(bell);
        uint256 orderId = bell.lastOrderId();
        vm.warp(vm.getBlockTimestamp() + 2 days);
        desk.refund(orderId);
        assertEq(imd.balanceOf(address(bell)), 2e18);

        _ring25(bell);
        assertEq(bell.hires(), 2);
        assertEq(imd.sentTotal(address(bell)), imd.sent(address(bell), address(desk)), "only ever to the desk");
    }

    function test_realDesk_theDoorbellCountsARedeliveredCallbackOnce() public {
        vm.prank(alice);
        imd.transfer(address(bell), 2e18);
        _ring25(bell);
        uint256 orderId = bell.lastOrderId();
        _takeAndRegister(orderId, runner, JOB);
        vm.prank(runner);
        desk.claimDelivered(orderId, RECEIPT);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.mockCallRevert(address(bell), abi.encodeWithSelector(bell.onWorkDelivered.selector), "no callback");
        desk.finalize(orderId);
        vm.clearMockedCalls();
        assertEq(bell.receipts(), 0);

        desk.redeliver(orderId);
        assertEq(bell.receipts(), 1);
        vm.expectRevert();
        desk.redeliver(orderId);
        assertEq(bell.receipts(), 1);
    }
}
