// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {stdJson} from "forge-std/StdJson.sol";
import {Doorbell} from "../../src/pots/Doorbell.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {Receipts} from "../kit/Receipts.sol";
import {RegistryStandIn} from "../kit/RegistryStandIn.sol";
import {MockIMD} from "./mocks/MockIMD.sol";

/// @notice The Doorbell on the real desk of this launch, which proves through the real WorkProof.
/// A receipt is the real work record of a picture job (kind `skill:create-image`) carrying the
/// order's header and the Doorbell's own spec. What the Doorbell does when a desk misreports is in
/// `Doorbell.oddDesk.t.sol`.
contract DoorbellTest is Receipts {
    using stdJson for string;

    MockIMD internal imd;
    WorkOrders internal desk;
    WorkProof internal proof;
    Doorbell internal bell;

    address internal payroll;
    address internal ringer = makeAddr("ringer");
    address internal funder = makeAddr("funder");
    address internal runner = makeAddr("runner");
    address internal stranger = makeAddr("stranger");

    /// @dev The kind the swarm writes into the work record of a job opened with its create-image
    /// skill, as a real record shows (`test/fixtures/pots/picture-job.json`).
    bytes32 internal constant KIND = keccak256("skill:create-image");
    uint96 internal constant MIN_PAY = 1e18;
    uint96 internal constant MAX_PAY = 2e18;
    uint96 internal constant BOND = 0.5e18;
    uint32 internal constant DELIVERY = 3 days;
    bytes16 internal constant JOB = 0xe9efec1656f340d3924352c453effc7d;
    bytes32 internal constant RECEIPT = 0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5;
    uint256 internal constant START = 1_760_000_000;
    /// @dev The real record of a picture job (job df6805ee).
    string internal constant PICTURE_FIXTURE = "df6805ee-skill-create-image-7dd1a0a2.hex";

    function setUp() public {
        vm.warp(START);
        imd = new MockIMD();
        registry = new RegistryStandIn();
        payroll = address(new PayrollStandIn(address(imd)));
        // The launch's contracts, in manifest order.
        proof = new WorkProof(address(registry));
        desk = new WorkOrders(address(imd), address(proof), payroll);
        // The Doorbell most tests use accepts delivery claims; `_receiptOnly` builds the other kind.
        bell = new Doorbell(address(imd), address(desk), KIND, MIN_PAY, MAX_PAY, BOND, DELIVERY, true);
        imd.mint(funder, 1_000e18);
        imd.mint(runner, 1_000e18);
        imd.mint(stranger, 1_000e18);
        vm.prank(runner);
        imd.approve(address(desk), type(uint256).max);
        vm.prank(stranger);
        imd.approve(address(desk), type(uint256).max);
    }

    function _fund(uint256 amount) internal {
        vm.prank(funder);
        imd.transfer(address(bell), amount);
    }

    function _ring(uint256 times) internal {
        vm.startPrank(ringer);
        for (uint256 i; i < times; ++i) {
            bell.ring();
        }
        vm.stopPrank();
    }

    /// @dev Funds one order's escrow and rings until the 25th ring has opened it.
    function _hire() internal returns (uint256 orderId) {
        _fund(MAX_PAY);
        _ring(25 - bell.rings() % 25);
        orderId = bell.lastOrderId();
    }

    /// @dev The registry writes the receipt of the order's registered job, a real picture job's
    /// record with the order's header and `spec` as its objective, and anyone settles with it.
    function _settle(uint256 orderId, string memory spec) internal returns (bytes32 receipt) {
        bytes16 jobId = desk.claimOf(orderId).jobId;
        bytes memory record = _recordFrom(PICTURE_FIXTURE, jobId, bytes.concat(desk.headerOf(orderId), bytes(spec)));
        _write(jobId, record);
        desk.settle(orderId, record, new address[](0));
        return keccak256(record);
    }

    function _settle(uint256 orderId) internal returns (bytes32) {
        return _settle(orderId, bell.SPEC());
    }

    /// @dev The desk calling the Doorbell's callback, for tests of the callback alone.
    function _callBack(Doorbell b, uint256 orderId, bytes16 jobId, bytes32 recordHash) internal {
        vm.prank(address(desk));
        b.onWorkDelivered(orderId, jobId, recordHash);
    }

    /// @dev A Doorbell that pays on a receipt only, funded and rung until it has opened an order.
    function _receiptOnly() internal returns (Doorbell strict, uint256 orderId) {
        strict = new Doorbell(address(imd), address(desk), KIND, MIN_PAY, MAX_PAY, BOND, DELIVERY, false);
        vm.prank(funder);
        imd.transfer(address(strict), MAX_PAY);
        vm.startPrank(ringer);
        for (uint256 i; i < 25; ++i) {
            strict.ring();
        }
        vm.stopPrank();
        orderId = strict.lastOrderId();
    }

    // ------------------------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------------------------

    function test_constructor_storesItsConfiguration() public view {
        assertEq(address(bell.IMD()), address(imd));
        assertEq(address(bell.WORK_ORDERS()), address(desk));
        assertEq(bell.KIND_HASH(), KIND);
        assertEq(bell.MIN_PAY(), MIN_PAY);
        assertEq(bell.MAX_PAY(), MAX_PAY);
        assertEq(bell.BOND(), BOND);
        assertEq(bell.DELIVERY_SECS(), DELIVERY);
        assertTrue(bell.ALLOW_CLAIMED());
        assertEq(bell.MAX_DELIVERY_SECS(), 30 days);
        assertEq(bell.RINGS_PER_HIRE(), 25);
        assertEq(bell.HIRE_SECS(), 2 days);
        assertEq(bell.RAMP_SECS(), 1 hours);
        assertEq(bell.rings(), 0);
        assertEq(bell.hires(), 0);
        assertEq(bell.receipts(), 0);
        assertEq(bell.ringsUntilHire(), 25);
        assertFalse(bell.funded());
    }

    function test_constructor_makesNoCall_soItRunsOnAnEmptyChain() public {
        // Neither address has code. A constructor that called them or checked their code would revert.
        Doorbell b = new Doorbell(address(0xA11CE), address(0xB0B), KIND, MIN_PAY, MAX_PAY, BOND, DELIVERY, true);
        assertEq(address(b.WORK_ORDERS()), address(0xB0B));
        b = new Doorbell(address(0xA11CE), address(0xB0B), KIND, MIN_PAY, MAX_PAY, BOND, DELIVERY, false);
        assertFalse(b.ALLOW_CLAIMED());
    }

    /// The launch pipeline passes eight static words, in this order.
    function test_constructor_takesEightStaticArguments_theClaimedPathSwitchLast() public {
        bytes memory args = abi.encode(
            address(imd), address(desk), KIND, uint96(1e18), uint96(2e18), uint96(0.5e18), uint32(4 days), false
        );
        assertEq(args.length, 8 * 32);
        Doorbell b = Doorbell(deployCode("Doorbell.sol:Doorbell", args));
        assertEq(address(b.IMD()), address(imd));
        assertEq(address(b.WORK_ORDERS()), address(desk));
        assertEq(b.KIND_HASH(), KIND);
        assertEq(b.MIN_PAY(), 1e18);
        assertEq(b.MAX_PAY(), 2e18);
        assertEq(b.BOND(), 0.5e18);
        assertEq(b.DELIVERY_SECS(), 4 days);
        assertFalse(b.ALLOW_CLAIMED());

        args = abi.encode(
            address(imd), address(desk), KIND, uint96(1e18), uint96(2e18), uint96(0.5e18), uint32(4 days), true
        );
        assertTrue(Doorbell(deployCode("Doorbell.sol:Doorbell", args)).ALLOW_CLAIMED());
    }

    function test_constructor_acceptsAFixedPriceAndTheDesksMinimums() public {
        Doorbell b =
            new Doorbell(address(imd), address(desk), KIND, 3e18, 3e18, desk.MIN_BOND(), desk.MIN_DELIVERY(), true);
        assertEq(b.MIN_PAY(), b.MAX_PAY());
        b = new Doorbell(address(imd), address(desk), KIND, 3e18, 3e18, desk.MIN_BOND(), 30 days, true);
        assertEq(b.DELIVERY_SECS(), b.MAX_DELIVERY_SECS());
    }

    /// @dev An external call, so that a constructor revert is one call deep. A test that expects
    /// the revert of a `new` written in its own body ends there, and what follows never runs.
    function deployWith(
        address imd_,
        address desk_,
        bytes32 kind,
        uint96 minPay,
        uint96 maxPay,
        uint96 bond,
        uint32 delivery,
        bool allowClaimed
    ) external returns (Doorbell) {
        return new Doorbell(imd_, desk_, kind, minPay, maxPay, bond, delivery, allowClaimed);
    }

    function test_constructor_revertsOnAZeroAddress() public {
        vm.expectRevert(Doorbell.ZeroAddress.selector);
        this.deployWith(address(0), address(desk), KIND, MIN_PAY, MAX_PAY, BOND, DELIVERY, true);
        vm.expectRevert(Doorbell.ZeroAddress.selector);
        this.deployWith(address(imd), address(0), KIND, MIN_PAY, MAX_PAY, BOND, DELIVERY, true);
    }

    function test_constructor_revertsWithoutAKind() public {
        vm.expectRevert(Doorbell.KindMissing.selector);
        this.deployWith(address(imd), address(desk), bytes32(0), MIN_PAY, MAX_PAY, BOND, DELIVERY, true);
    }

    function test_constructor_revertsOnABadPriceRange() public {
        vm.expectRevert(Doorbell.BadPriceRange.selector);
        this.deployWith(address(imd), address(desk), KIND, 0, MAX_PAY, BOND, DELIVERY, true);
        vm.expectRevert(Doorbell.BadPriceRange.selector);
        this.deployWith(address(imd), address(desk), KIND, MAX_PAY + 1, MAX_PAY, BOND, DELIVERY, true);
        vm.expectRevert(Doorbell.BadPriceRange.selector);
        this.deployWith(address(imd), address(desk), KIND, 0, 0, BOND, DELIVERY, true);
    }

    function test_constructor_revertsOnABondOrDeliveryTimeTheDeskWouldRefuse() public {
        vm.expectRevert(Doorbell.BondTooLow.selector);
        this.deployWith(address(imd), address(desk), KIND, MIN_PAY, MAX_PAY, 0.25e18 - 1, DELIVERY, true);
        vm.expectRevert(Doorbell.DeliveryTooShort.selector);
        this.deployWith(address(imd), address(desk), KIND, MIN_PAY, MAX_PAY, BOND, 3 days - 1, true);
        vm.expectRevert(Doorbell.DeliveryTooLong.selector);
        this.deployWith(address(imd), address(desk), KIND, MIN_PAY, MAX_PAY, BOND, 30 days + 1, true);
        // The same call with every value at its bound deploys.
        Doorbell b = this.deployWith(address(imd), address(desk), KIND, 1, 1, 0.25e18, 3 days, false);
        assertEq(b.BOND(), 0.25e18);
    }

    // ------------------------------------------------------------------------------------------
    // The spec held in code
    // ------------------------------------------------------------------------------------------

    function test_spec_passesTheDesksCharacterRules() public {
        bytes memory spec = bytes(bell.SPEC());
        assertGt(spec.length, 0);
        assertLe(spec.length, 7_900);
        // The desk itself takes an order with this text.
        IWorkOrders.OrderParams memory p;
        p.kindHash = KIND;
        p.minPay = 1e18;
        p.maxPay = 1e18;
        p.deliverySecs = 3 days;
        p.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);
        p.bond = 0.25e18;
        vm.startPrank(stranger);
        assertEq(desk.createOrder(p, spec), 1, "the desk accepts the spec");
        vm.stopPrank();
        for (uint256 i; i < spec.length; ++i) {
            uint8 c = uint8(spec[i]);
            assertTrue(c >= 0x20 && c <= 0x7E && c != 0x22 && c != 0x5C, "printable ASCII, no quote, no backslash");
        }
        assertTrue(spec[0] != " " && spec[spec.length - 1] != " ", "no space at either end");
        assertEq(bell.SPEC_HASH(), keccak256(spec));
    }

    /// The kind hash the Doorbell is to be launched with is the kind of a real picture job: the
    /// fixture holds that job's work record as served, and its hash is the job's on-chain receipt
    /// (the fork test reads the registry).
    function test_kind_isTheKindOfARealPictureJobsWorkRecord() public view {
        string memory json = vm.readFile("test/fixtures/pots/picture-job.json");
        // The record is stored as hexadecimal text of the bytes IdentityMD served.
        string memory record = string(vm.parseBytes(vm.readFile(json.readString(".recordFile"))));

        assertEq(bytes(record).length, json.readUint(".recordSize"));
        assertEq(keccak256(bytes(record)), json.readBytes32(".recordHash"), "the record is the one the receipt is for");
        assertEq(vm.parseJsonString(record, ".kind"), "skill:create-image");
        assertEq(vm.parseJsonString(record, ".state"), "completed");
        assertEq(vm.parseJsonString(record, ".jobId"), json.readString(".jobUuid"));
        assertEq(json.readString(".kind"), "skill:create-image");
        assertEq(json.readBytes32(".kindHash"), KIND);
        assertEq(bell.KIND_HASH(), keccak256(bytes(vm.parseJsonString(record, ".kind"))));
    }

    function test_spec_isTheTextPublishedInTheFixtures() public view {
        // Off-chain code reads the Doorbell's job text from the fixture; the two must not drift.
        string memory json = vm.readFile("test/fixtures/pots/specs.json");
        string[] memory valid = json.readStringArray(".validText");
        assertEq(valid[4], bell.SPEC());
    }

    // ------------------------------------------------------------------------------------------
    // ring
    // ------------------------------------------------------------------------------------------

    function test_ring_countsEveryRingAndSaysWhoRang() public {
        vm.expectEmit(address(bell));
        emit Doorbell.Rang(ringer, 1);
        vm.prank(ringer);
        (uint256 count, bool hired, uint256 orderId) = bell.ring();
        assertEq(count, 1);
        assertFalse(hired);
        assertEq(orderId, 0);

        vm.expectEmit(address(bell));
        emit Doorbell.Rang(stranger, 2);
        vm.prank(stranger);
        (count,,) = bell.ring();
        assertEq(count, 2);
        assertEq(bell.rings(), 2);
        assertEq(bell.ringsUntilHire(), 23);
    }

    function test_ring_the25thRingOpensAnOrderWhenTheDoorbellIsFunded() public {
        _fund(MAX_PAY);
        assertTrue(bell.funded());
        _ring(24);
        assertEq(desk.orderCount(), 0, "24 rings hire nobody");
        assertEq(bell.ringsUntilHire(), 1);
        vm.warp(START + 3 hours);

        vm.expectEmit(address(bell));
        emit Doorbell.Rang(stranger, 25);
        vm.expectEmit(address(bell));
        emit Doorbell.Hired(1, stranger, 25, MAX_PAY, uint40(vm.getBlockTimestamp() + 2 days));
        vm.prank(stranger);
        (uint256 count, bool hired, uint256 orderId) = bell.ring();

        assertEq(count, 25);
        assertTrue(hired);
        assertEq(orderId, 1);

        IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
        assertEq(o.kindHash, KIND);
        assertEq(o.minPay, MIN_PAY);
        assertEq(o.maxPay, MAX_PAY);
        assertEq(o.rampSecs, 1 hours);
        assertEq(o.deliverySecs, DELIVERY);
        assertEq(o.expiresAt, vm.getBlockTimestamp() + 2 days);
        assertEq(o.bond, BOND);
        assertEq(o.flags, desk.FLAG_CALLBACK() | desk.FLAG_ALLOW_CLAIMED(), "this Doorbell accepts claims");
        assertEq(o.runnerOnly, address(0), "any runner");
        assertEq(o.arbiter, address(0), "no arbiter");
        assertEq(o.condTarget, address(0), "no condition");
        assertEq(o.condSelector, bytes4(0));
        assertEq(o.condArg, bytes32(0));
        assertEq(o.condCmp, 0);
        assertEq(o.condThreshold, 0);
        assertEq(o.specHash, keccak256(bytes(bell.SPEC())), "the spec held in code, byte for byte");
        assertEq(o.employer, address(bell));

        (IWorkOrders.State state, address employer, uint96 escrow,,) = desk.accountOf(orderId);
        assertEq(uint256(state), uint256(IWorkOrders.State.Open));
        assertEq(employer, address(bell), "the contract is the employer");
        assertEq(escrow, MAX_PAY);

        assertEq(bell.hires(), 1);
        assertEq(bell.lastOrderId(), 1);
        Doorbell.Hire memory h = bell.hireOf(1);
        assertEq(h.ring, 25);
        assertEq(h.openedAt, vm.getBlockTimestamp());
        assertFalse(h.delivered);
        assertEq(imd.balanceOf(address(bell)), 0);
        assertEq(imd.balanceOf(address(desk)), MAX_PAY);
        assertEq(imd.allowance(address(bell), address(desk)), 0, "no allowance is left behind");
        assertEq(bell.ringsUntilHire(), 25);
        assertFalse(bell.funded());
    }

    function test_ring_the25thRingWithoutEnoughMoneyOnlyCountsAndSaysSo() public {
        _fund(MAX_PAY - 1);
        _ring(24);

        vm.expectEmit(address(bell));
        emit Doorbell.Rang(ringer, 25);
        vm.expectEmit(address(bell));
        emit Doorbell.HireSkipped(25, MAX_PAY - 1, MAX_PAY);
        vm.prank(ringer);
        (uint256 count, bool hired, uint256 orderId) = bell.ring();

        assertEq(count, 25);
        assertFalse(hired);
        assertEq(orderId, 0);
        assertEq(bell.rings(), 25);
        assertEq(bell.hires(), 0);
        assertEq(desk.orderCount(), 0);
        assertEq(imd.balanceOf(address(bell)), MAX_PAY - 1, "the money stays for the next time");

        // One more wei arrives. Nothing happens until the next 25th ring.
        _fund(1);
        _ring(24);
        assertEq(bell.hires(), 0, "rings 26 to 49 hire nobody, funded or not");
        _ring(1);
        assertEq(bell.rings(), 50);
        assertEq(bell.hires(), 1);
        assertEq(bell.hireOf(1).ring, 50);
    }

    function test_ring_anEmptyDoorbellStillCounts() public {
        vm.recordLogs();
        _ring(60);
        assertEq(bell.rings(), 60);
        assertEq(bell.hires(), 0);
        // 60 Rang events and two HireSkipped (rings 25 and 50).
        assertEq(vm.getRecordedLogs().length, 62);
    }

    function test_ring_onlyEvery25thRingHires() public {
        _fund(10 * uint256(MAX_PAY));
        _ring(100);
        assertEq(bell.rings(), 100);
        assertEq(bell.hires(), 4);
        assertEq(desk.orderCount(), 4);
        assertEq(bell.lastOrderId(), 4);
        for (uint256 id = 1; id <= 4; ++id) {
            assertEq(bell.hireOf(id).ring, id * 25);
        }
        assertEq(imd.balanceOf(address(bell)), 6 * uint256(MAX_PAY));
    }

    function test_ring_aFixedPriceOrderHasNoRamp() public {
        Doorbell b = new Doorbell(address(imd), address(desk), KIND, 3e18, 3e18, BOND, DELIVERY, true);
        vm.prank(funder);
        imd.transfer(address(b), 3e18);
        for (uint256 i; i < 25; ++i) {
            b.ring();
        }
        assertEq(b.hires(), 1);
        IWorkOrdersRunner.Order memory o = desk.orderOf(b.lastOrderId());
        assertEq(o.minPay, 3e18);
        assertEq(o.maxPay, 3e18);
        assertEq(o.rampSecs, 0);
    }

    // ------------------------------------------------------------------------------------------
    // Money coming back
    // ------------------------------------------------------------------------------------------

    function test_aRefundReturnsToTheBalanceAndPaysForTheNextHire() public {
        uint256 first = _hire();
        assertEq(imd.balanceOf(address(bell)), 0);

        // Nobody takes the order. After two days anyone has the desk refund it.
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(stranger);
        desk.refund(first);
        assertEq(imd.balanceOf(address(bell)), MAX_PAY);
        assertTrue(bell.funded());

        // The same money hires again on the next 25th ring.
        _ring(25);
        assertEq(bell.hires(), 2);
        assertEq(bell.lastOrderId(), 2);
        assertEq(imd.balanceOf(address(bell)), 0);
        assertEq(imd.balanceOf(address(desk)), MAX_PAY);
    }

    function test_theUnusedPartOfTheEscrowComesBack() public {
        uint256 orderId = _hire();
        // Taken at once, at the starting price.
        vm.startPrank(runner);
        desk.claim(orderId);
        desk.register(orderId, JOB);
        vm.stopPrank();

        // The Doorbell is told the hash of the record that was proven.
        bytes memory record =
            _recordFrom(PICTURE_FIXTURE, JOB, bytes.concat(desk.headerOf(orderId), bytes(bell.SPEC())));
        bytes32 receipt = keccak256(record);
        _write(JOB, record);
        vm.expectEmit(address(bell));
        emit Doorbell.Delivered(orderId, JOB, receipt, 1);
        desk.settle(orderId, record, new address[](0));

        assertTrue(desk.orderOf(orderId).notified);
        assertEq(imd.balanceOf(address(bell)), MAX_PAY - MIN_PAY, "what the job did not cost");
        assertEq(bell.receipts(), 1);
        assertEq(bell.lastDeliveredOrderId(), orderId);
        Doorbell.Hire memory h = bell.hireOf(orderId);
        assertTrue(h.delivered);
        assertEq(h.jobId, JOB);
        assertEq(h.recordHash, receipt);
    }

    function test_aForfeitedBondComesBackToo() public {
        uint256 orderId = _hire();
        vm.prank(runner);
        desk.claim(orderId);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        desk.evict(orderId);
        assertEq(imd.balanceOf(address(bell)), BOND, "the bond of a runner that sat on the order");
        assertEq(bell.receipts(), 0);
    }

    // ------------------------------------------------------------------------------------------
    // The claimed path: on or off for good, chosen at deployment
    // ------------------------------------------------------------------------------------------

    function test_claimsOn_theOrderAcceptsAnUnchallengedDeliveryClaim() public {
        uint256 orderId = _hire();
        vm.startPrank(runner);
        desk.claim(orderId);
        desk.register(orderId, JOB);
        desk.claimDelivered(orderId, RECEIPT);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        desk.finalize(orderId);

        assertEq(bell.receipts(), 1);
        assertEq(bell.hireOf(orderId).recordHash, RECEIPT);
    }

    /// What the claimed setting costs when nobody decides a dispute: the order is refunded, and
    /// the runner's forfeited share comes back with the escrow for the next hire.
    function test_claimsOn_anUndecidedDisputeRefundsTheDoorbell_withTheRunnersForfeitedShare() public {
        uint256 orderId = _hire();
        vm.startPrank(runner);
        desk.claim(orderId);
        desk.register(orderId, JOB);
        desk.claimDelivered(orderId, RECEIPT);
        vm.stopPrank();
        vm.prank(stranger);
        desk.challenge(orderId);
        vm.warp(vm.getBlockTimestamp() + DELIVERY);
        desk.timeout(orderId);

        assertEq(uint256(desk.stateOf(orderId)), uint256(IWorkOrders.State.Refunded));
        assertEq(imd.balanceOf(address(bell)), uint256(MAX_PAY) + BOND / 10);
        assertEq(bell.receipts(), 0);
        assertTrue(bell.funded());
    }

    function test_claimsOff_ordersCarryTheCallbackFlagOnly() public {
        (Doorbell strict, uint256 orderId) = _receiptOnly();
        assertFalse(strict.ALLOW_CLAIMED());
        assertEq(strict.hires(), 1);

        IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
        assertEq(o.flags, desk.FLAG_CALLBACK(), "receipt only");
        assertEq(o.kindHash, KIND);
        assertEq(o.maxPay, MAX_PAY);
        assertEq(o.runnerOnly, address(0), "any runner");
        assertEq(o.arbiter, address(0), "no arbiter");
        assertEq(o.condTarget, address(0), "no condition");
        assertEq(o.employer, address(strict));
    }

    function test_claimsOff_aDeliveryClaimIsRefused_andOnlyAReceiptPays() public {
        (Doorbell strict, uint256 orderId) = _receiptOnly();
        vm.startPrank(runner);
        desk.claim(orderId);
        desk.register(orderId, JOB);
        vm.expectRevert(IWorkOrdersRunner.ClaimedPathOff.selector);
        desk.claimDelivered(orderId, RECEIPT);
        vm.stopPrank();
        assertEq(strict.receipts(), 0);

        bytes32 receipt = _settle(orderId, strict.SPEC());
        assertEq(strict.receipts(), 1);
        assertEq(strict.hireOf(orderId).recordHash, receipt);
        assertEq(imd.balanceOf(address(strict)), MAX_PAY - MIN_PAY, "what the job did not cost");
    }

    /// Receipt only, and no receipt ever comes: the order ends in a refund, the runner's bond
    /// comes with it, and the same money orders again. Nothing ever leaves for good.
    function test_claimsOff_withoutAReceiptTheMoneyComesBackAndHiresAgain() public {
        (Doorbell strict, uint256 orderId) = _receiptOnly();
        vm.warp(vm.getBlockTimestamp() + 2 days - 1);
        vm.startPrank(runner);
        desk.claim(orderId);
        desk.register(orderId, JOB);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + DELIVERY);
        desk.timeout(orderId);

        assertEq(uint256(desk.stateOf(orderId)), uint256(IWorkOrders.State.Refunded));
        assertEq(imd.balanceOf(address(strict)), uint256(MAX_PAY) + BOND);
        vm.startPrank(ringer);
        for (uint256 i; i < 25; ++i) {
            strict.ring();
        }
        vm.stopPrank();
        assertEq(strict.hires(), 2);
        assertEq(imd.sentTotal(address(strict)), imd.sent(address(strict), address(desk)), "only ever to the desk");
    }

    function test_aCallbackThatFailedIsCountedOnceWhenTheDeskTriesAgain() public {
        uint256 orderId = _hire();
        vm.startPrank(runner);
        desk.claim(orderId);
        desk.register(orderId, JOB);
        vm.stopPrank();
        vm.mockCallRevert(address(bell), abi.encodeWithSelector(bell.onWorkDelivered.selector), "no callback");
        _settle(orderId);
        vm.clearMockedCalls();
        assertFalse(desk.orderOf(orderId).notified);
        assertEq(bell.receipts(), 0, "the delivery stands on the desk; the Doorbell has not heard of it");

        desk.redeliver(orderId);
        assertEq(bell.receipts(), 1);
        assertTrue(bell.hireOf(orderId).delivered);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.redeliver(orderId);
        assertEq(bell.receipts(), 1);
    }

    // ------------------------------------------------------------------------------------------
    // onWorkDelivered
    // ------------------------------------------------------------------------------------------

    function test_onWorkDelivered_revertsForAnyCallerButTheDesk() public {
        uint256 orderId = _hire();
        vm.expectRevert(Doorbell.NotDesk.selector);
        vm.prank(stranger);
        bell.onWorkDelivered(orderId, JOB, RECEIPT);
        assertEq(bell.receipts(), 0);
    }

    function test_onWorkDelivered_revertsForAnOrderTheDoorbellDidNotOpen() public {
        _hire();
        vm.expectRevert(abi.encodeWithSelector(Doorbell.UnknownOrder.selector, 77));
        _callBack(bell, 77, JOB, RECEIPT);

        // An order somebody else placed on the same desk.
        IWorkOrders.OrderParams memory o;
        o.kindHash = KIND;
        o.minPay = MIN_PAY;
        o.maxPay = MAX_PAY;
        o.deliverySecs = DELIVERY;
        o.bond = BOND;
        o.flags = desk.FLAG_CALLBACK();
        o.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);
        bytes memory spec = bytes(bell.SPEC());
        vm.prank(stranger);
        uint256 foreign = desk.createOrder(o, spec);
        vm.expectRevert(abi.encodeWithSelector(Doorbell.UnknownOrder.selector, foreign));
        _callBack(bell, foreign, JOB, RECEIPT);
        assertEq(bell.receipts(), 0);
    }

    function test_onWorkDelivered_countsEachOrderOnce() public {
        uint256 orderId = _hire();
        _callBack(bell, orderId, JOB, RECEIPT);
        vm.expectRevert(abi.encodeWithSelector(Doorbell.AlreadyDelivered.selector, orderId));
        _callBack(bell, orderId, JOB, bytes32(uint256(1)));
        assertEq(bell.receipts(), 1);
        assertEq(bell.hireOf(orderId).recordHash, RECEIPT, "the first report stands");
    }

    function test_onWorkDelivered_movesNoMoney() public {
        uint256 orderId = _hire();
        _fund(5e18);
        _callBack(bell, orderId, JOB, RECEIPT);
        assertEq(imd.balanceOf(address(bell)), 5e18);
        assertEq(imd.sentTotal(address(bell)), MAX_PAY, "only the escrow ever left");
    }

    function test_onWorkDelivered_arrivesThroughTheDesksGasCappedCall() public {
        uint256 orderId = _hire();
        vm.startPrank(runner);
        desk.claim(orderId);
        desk.register(orderId, JOB);
        vm.stopPrank();
        // As in a real settlement transaction, none of the Doorbell's storage has been touched yet.
        vm.cool(address(bell));
        _settle(orderId);
        assertTrue(desk.orderOf(orderId).notified, "the callback fits in the desk's 150,000 gas");
        assertEq(bell.receipts(), 1);
    }

    function test_onWorkDelivered_usesWellUnderTheDesksAllowance() public {
        uint256 orderId = _hire();
        vm.cool(address(bell));
        vm.prank(address(desk));
        uint256 before = gasleft();
        bell.onWorkDelivered(orderId, JOB, RECEIPT);
        uint256 used = before - gasleft();
        assertLt(used, 100_000, "two thirds of the desk's allowance");
    }

    // ------------------------------------------------------------------------------------------
    // Views and fuzz
    // ------------------------------------------------------------------------------------------

    function test_ringsUntilHire_countsDownFrom25() public {
        for (uint256 i; i < 60; ++i) {
            assertEq(bell.ringsUntilHire(), 25 - i % 25);
            bell.ring();
        }
    }

    /// @dev With no money coming back, the Doorbell hires on each 25th ring for as long as its
    /// balance lasts, and never otherwise.
    function testFuzz_hiresOnEach25thRingWhileTheMoneyLasts(uint16 rings, uint96 funds) public {
        uint256 n = bound(rings, 0, 400);
        uint256 money = bound(funds, 0, 20 * uint256(MAX_PAY));
        if (money != 0) _fund(money);
        _ring(n);

        uint256 byRings = n / 25;
        uint256 byMoney = money / MAX_PAY;
        uint256 expected = byRings < byMoney ? byRings : byMoney;
        assertEq(bell.rings(), n);
        assertEq(bell.hires(), expected);
        assertEq(desk.orderCount(), expected);
        assertEq(imd.balanceOf(address(bell)), money - expected * MAX_PAY);
        assertEq(imd.balanceOf(address(desk)), expected * MAX_PAY);
        assertEq(imd.sentTotal(address(bell)), imd.sent(address(bell), address(desk)), "only ever to the desk");
    }

    /// @dev Any configuration the constructor accepts produces an order the desk accepts, with
    /// the claimed path on or off as it was deployed.
    function testFuzz_everyAcceptedConfigurationCanHire(
        uint96 minPay,
        uint96 maxPay,
        uint96 bond,
        uint32 delivery,
        bool allowClaimed
    ) public {
        maxPay = uint96(bound(maxPay, 0, 1_000e18));
        minPay = uint96(bound(minPay, 0, uint256(maxPay) + 1e18));
        bond = uint96(bound(bond, 0.2e18, 10e18));
        delivery = uint32(bound(delivery, 2 days, 40 days));

        try this.deployWith(address(imd), address(desk), KIND, minPay, maxPay, bond, delivery, allowClaimed) returns (
            Doorbell b
        ) {
            imd.mint(address(b), maxPay);
            for (uint256 i; i < 24; ++i) {
                b.ring();
            }
            (, bool hired,) = b.ring();
            assertTrue(hired);
            IWorkOrdersRunner.Order memory o = desk.orderOf(b.lastOrderId());
            assertEq(o.maxPay, maxPay);
            assertEq(o.flags & desk.FLAG_ALLOW_CLAIMED() != 0, allowClaimed);
            assertEq(o.flags & desk.FLAG_CALLBACK(), desk.FLAG_CALLBACK());
            assertEq(imd.balanceOf(address(b)), 0);
        } catch {
            assertTrue(
                minPay == 0 || minPay > maxPay || bond < 0.25e18 || delivery < 3 days || delivery > 30 days,
                "refused only for a reason the constructor names"
            );
        }
    }
}
