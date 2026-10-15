// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Doorbell} from "../../src/pots/Doorbell.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {Receipts} from "../kit/Receipts.sol";
import {RegistryStandIn} from "../kit/RegistryStandIn.sol";
import {MockIMD} from "./mocks/MockIMD.sol";

/// @notice Rings the Doorbell, sends it money, lets time pass and moves its orders through the
/// real desk in every way an order can go. Receipts are the real record of a picture job carrying
/// the order's header, proven by the real WorkProof.
contract DoorbellHandler is Receipts {
    /// @dev The real record of a picture job (job df6805ee), kind `skill:create-image`.
    string internal constant PICTURE_FIXTURE = "df6805ee-skill-create-image-7dd1a0a2.hex";

    MockIMD public immutable imd;
    WorkOrders public immutable desk;
    Doorbell public immutable bell;

    address[] internal _runners;
    address internal _funder = makeAddr("funder");

    uint256 public rang;
    uint256 public funded;
    uint256 public deliveries;

    constructor(MockIMD imd_, WorkOrders desk_, Doorbell bell_, RegistryStandIn registry_) {
        imd = imd_;
        desk = desk_;
        bell = bell_;
        registry = registry_;
        for (uint256 i; i < 3; ++i) {
            address who = makeAddr(string.concat("runner", vm.toString(i)));
            _runners.push(who);
            imd.mint(who, 1e30);
            vm.prank(who);
            imd.approve(address(desk), type(uint256).max);
        }
        imd.mint(_funder, 1e30);
    }

    function ring(uint256 times, uint256 who) external {
        times = bound(times, 1, 30);
        vm.startPrank(address(uint160(bound(who, 1000, 2000))));
        for (uint256 i; i < times; ++i) {
            bell.ring();
        }
        vm.stopPrank();
        rang += times;
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 1, 3 * uint256(bell.MAX_PAY()));
        vm.prank(_funder);
        imd.transfer(address(bell), amount);
        funded += amount;
    }

    function warp(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 2 days));
    }

    /// @dev Moves one of the Doorbell's orders along whichever way its state allows.
    function deskStep(uint256 orderSeed, uint256 choice, uint256 who) external {
        uint256 count = desk.orderCount();
        if (count == 0) return;
        uint256 orderId = 1 + orderSeed % count;
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
            if (choice % 4 == 0 && canRelease) {
                vm.prank(c.runner);
                desk.release(orderId);
            } else if (choice % 4 <= 1) {
                _warpTo(uint256(c.claimedAt) + desk.CLAIM_WINDOW());
                desk.evict(orderId);
            } else {
                vm.prank(c.runner);
                desk.register(orderId, bytes16(keccak256(abi.encode(orderId, c.claimedAt))));
            }
        } else if (s == IWorkOrders.State.Registered) {
            uint256 deliverBy = uint256(c.registeredAt) + o.deliverySecs;
            bool canClaim = vm.getBlockTimestamp() + desk.CHALLENGE_WINDOW() + desk.DISPUTE_WINDOW() <= deliverBy;
            if (choice % 5 == 0 && canClaim) {
                vm.prank(c.runner);
                desk.claimDelivered(orderId, keccak256(abi.encode("claimed", orderId)));
            } else if (choice % 5 == 1) {
                _warpTo(deliverBy);
                desk.timeout(orderId);
            } else if (choice % 5 == 2) {
                // The swarm failed the runner's own job, which only the runner may report.
                bytes memory failed = _land(orderId, c.jobId, true, false);
                vm.prank(c.runner);
                desk.reportFailed(orderId, failed, new address[](0));
            } else {
                desk.settle(orderId, _land(orderId, c.jobId, true, true), new address[](0));
                ++deliveries;
            }
        } else if (s == IWorkOrders.State.Asserted) {
            if (choice % 3 == 0 && vm.getBlockTimestamp() < uint256(c.assertedAt) + desk.CHALLENGE_WINDOW()) {
                vm.prank(_runners[who % _runners.length]);
                desk.challenge(orderId);
            } else if (choice % 3 == 1) {
                desk.reportFailed(orderId, _land(orderId, c.jobId, false, true), new address[](0));
            } else {
                _warpTo(uint256(c.assertedAt) + desk.CHALLENGE_WINDOW());
                desk.finalize(orderId);
                ++deliveries;
            }
        } else if (s == IWorkOrders.State.Disputed) {
            if (choice % 3 == 0) {
                desk.settle(orderId, _land(orderId, c.jobId, true, true), new address[](0));
                ++deliveries;
            } else if (choice % 3 == 1) {
                desk.reportFailed(orderId, _land(orderId, c.jobId, false, true), new address[](0));
            } else {
                _warpTo(uint256(c.registeredAt) + o.deliverySecs);
                desk.timeout(orderId);
            }
        }
    }

    /// @dev The registry writes a receipt for the order's registered job. Completed, with the
    /// current claim's objective: the real picture record with only its job id and objective
    /// swapped. Otherwise a blocked record with that objective, or a completed one written for
    /// some other objective.
    function _land(uint256 orderId, bytes16 jobId, bool sameObjective, bool completed)
        internal
        returns (bytes memory record)
    {
        bytes memory objective = sameObjective
            ? bytes.concat(desk.headerOf(orderId), bytes(bell.SPEC()))
            : bytes("A job that no order on this desk asked for.");
        record = completed
            ? _recordFrom(PICTURE_FIXTURE, jobId, objective)
            : _recordOf(jobId, "skill:create-image", objective, "blocked");
        _write(jobId, record);
    }

    function _warpTo(uint256 time) internal {
        if (vm.getBlockTimestamp() < time) vm.warp(time);
    }
}

/// @dev Every handler action is steered so that it cannot revert, and the run is told to fail if
/// one does.
/// forge-config: default.invariant.depth = 120
/// forge-config: default.invariant.fail-on-revert = true
contract DoorbellInvariantTest is Test {
    MockIMD internal imd;
    WorkOrders internal desk;
    Doorbell internal bell;
    DoorbellHandler internal handler;

    uint96 internal constant MIN_PAY = 1e18;
    uint96 internal constant MAX_PAY = 2.5e18;

    function setUp() public {
        vm.warp(1_760_000_000);
        imd = new MockIMD();
        RegistryStandIn registry = new RegistryStandIn();
        // The launch's contracts in manifest order, on the real WorkProof.
        WorkProof proof = new WorkProof(address(registry));
        desk = new WorkOrders(address(imd), address(proof), address(new PayrollStandIn(address(imd))));
        // The claimed path is on, so that orders pass through every state the desk has.
        bell = new Doorbell(
            address(imd), address(desk), keccak256("skill:create-image"), MIN_PAY, MAX_PAY, 0.5e18, 3 days, true
        );
        handler = new DoorbellHandler(imd, desk, bell, registry);

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = DoorbellHandler.ring.selector;
        selectors[1] = DoorbellHandler.fund.selector;
        selectors[2] = DoorbellHandler.warp.selector;
        selectors[3] = DoorbellHandler.deskStep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Every ring is counted, and an order is opened on a 25th ring or not at all.
    function invariant_everyRingIsCountedAndOnly25thRingsHire() public view {
        assertEq(bell.rings(), handler.rang());
        uint256 hires = bell.hires();
        assertLe(hires, handler.rang() / 25);
        assertEq(desk.orderCount(), hires, "every order on this desk is the Doorbell's");
        if (hires != 0) assertEq(bell.lastOrderId(), hires);
        for (uint256 id = 1; id <= hires; ++id) {
            Doorbell.Hire memory h = bell.hireOf(id);
            assertTrue(h.ring != 0 && h.ring % 25 == 0, "opened by a 25th ring");
            IWorkOrdersRunner.Order memory o = desk.orderOf(id);
            assertEq(o.employer, address(bell));
            assertEq(o.maxPay, MAX_PAY);
        }
    }

    /// The Doorbell's IMD only ever leaves as the escrow of its own orders.
    function invariant_moneyOnlyLeavesForTheDesk() public view {
        uint256 toDesk = imd.sent(address(bell), address(desk));
        assertEq(imd.sentTotal(address(bell)), toDesk);
        assertEq(toDesk, uint256(bell.hires()) * MAX_PAY);
    }

    /// What it holds is what it was sent, plus what the desk returned, minus the escrows it posted.
    function invariant_theBalanceIsFullyExplained() public view {
        uint256 returned;
        uint256 hires = bell.hires();
        for (uint256 id = 1; id <= hires; ++id) {
            (,,,, uint96 back) = desk.accountOf(id);
            returned += back;
        }
        assertEq(imd.balanceOf(address(bell)), handler.funded() + returned - hires * MAX_PAY);
    }

    /// Every delivery the desk made was reported to the Doorbell exactly once.
    function invariant_everyDeliveryIsRecordedOnce() public view {
        assertEq(bell.receipts(), handler.deliveries());
        uint256 delivered;
        uint256 hires = bell.hires();
        for (uint256 id = 1; id <= hires; ++id) {
            bool isDelivered = desk.stateOf(id) == IWorkOrders.State.Delivered;
            assertEq(desk.orderOf(id).notified, isDelivered, "the callback never fails");
            assertEq(bell.hireOf(id).delivered, isDelivered);
            if (isDelivered) ++delivered;
        }
        assertEq(delivered, bell.receipts());
    }
}
