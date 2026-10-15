// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {Receipts} from "../kit/Receipts.sol";
import {RegistryStandIn} from "../kit/RegistryStandIn.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockWorkOrders} from "./mocks/OddDesk.sol";

/// @notice A contributor that is a contract and has no functions at all: it cannot call anything,
/// it can only hold IMD.
contract Inert {}

/// @dev What every CrowdPots test shares whatever desk it runs against: the token, the actors, the
/// terms and the helpers that only touch CrowdPots itself.
abstract contract PotsActors is Receipts {
    MockIMD internal imd;
    CrowdPots internal pots;

    address internal opener = makeAddr("opener");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal runner = makeAddr("runner");
    address internal runner2 = makeAddr("runner2");
    address internal challenger = makeAddr("challenger");
    address internal stranger = makeAddr("stranger");

    bytes internal constant SPEC =
        "Audit the contracts in github.com/example/vault at commit 1f3a9c for loss of funds. Report every finding with a severity.";
    /// @dev The kind a pot names, in text and as the hash the desk pins. It is the kind of the real
    /// record the tests settle with, so a good receipt needs no kind swap.
    string internal constant KIND_TEXT = REAL_KIND;
    bytes32 internal constant KIND = keccak256(bytes(KIND_TEXT));
    /// @dev A real swarm job and the receipt IdentityMD's WorkRegistry holds for it
    /// (`test/fixtures/pots/real-receipt.json`).
    bytes16 internal constant JOB = 0xe9efec1656f340d3924352c453effc7d;
    bytes32 internal constant RECEIPT = 0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5;
    uint256 internal constant START = 1_760_000_000;
    uint256 internal constant WALLET = 1_000_000e18;

    /// @dev The desk the pots were deployed with, as an employer contract sees it.
    function _desk() internal view virtual returns (IWorkOrders);

    function _fundActors() internal {
        address[8] memory who = [opener, alice, bob, carol, runner, runner2, challenger, stranger];
        for (uint256 i; i < who.length; ++i) {
            imd.mint(who[i], WALLET);
            vm.startPrank(who[i]);
            imd.approve(address(pots), type(uint256).max);
            imd.approve(address(_desk()), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @dev A fixed-price pot: 10 IMD, 1 IMD bond, proven path only.
    function _terms() internal pure returns (CrowdPots.Terms memory) {
        return CrowdPots.Terms({
            kind: KIND_TEXT,
            target: 10e18,
            minPay: 10e18,
            rampSecs: 0,
            bond: 1e18,
            deliverySecs: 7 days,
            hireSecs: 7 days,
            fundSecs: 3 days,
            allowClaimed: false
        });
    }

    /// @dev The same pot with a price that rises from 4 to 10 IMD over one day.
    function _rampTerms() internal pure returns (CrowdPots.Terms memory t) {
        t = _terms();
        t.minPay = 4e18;
        t.rampSecs = 1 days;
    }

    function _open(CrowdPots.Terms memory t) internal returns (uint256 potId) {
        vm.prank(opener);
        potId = pots.openPot(t, SPEC, 0);
    }

    function _chip(address who, uint256 potId, uint256 amount) internal returns (uint256 taken) {
        vm.prank(who);
        taken = pots.chipIn(potId, amount);
    }

    /// @dev Opens a pot and fills it: alice half, bob three tenths, carol the rest.
    function _filled(CrowdPots.Terms memory t) internal returns (uint256 potId) {
        potId = _open(t);
        uint256 half = uint256(t.target) / 2;
        uint256 threeTenths = uint256(t.target) * 3 / 10;
        _chip(alice, potId, half);
        _chip(bob, potId, threeTenths);
        _chip(carol, potId, t.target - half - threeTenths);
    }

    function _launch(uint256 potId) internal returns (uint256 orderId) {
        vm.prank(stranger);
        orderId = pots.launch(potId, SPEC);
    }

    function _launched(CrowdPots.Terms memory t) internal returns (uint256 potId, uint256 orderId) {
        potId = _filled(t);
        orderId = _launch(potId);
    }

    /// @dev The job a runner registers for an order: the real job of the fixture for the first
    /// order, and one of its own for every other, because a job can settle one order only.
    function _jobOf(uint256 orderId) internal pure returns (bytes16) {
        return orderId == 1 ? JOB : bytes16(keccak256(abi.encode("job", orderId)));
    }

    /// @dev The first second at which a pot that filled but was never launched is refundable.
    function _afterLaunchTime(uint256 potId) internal view returns (uint256) {
        return uint256(pots.potOf(potId).deadline) + pots.LAUNCH_GRACE() + 1;
    }

    function _stage(uint256 potId) internal view returns (CrowdPots.Stage) {
        return pots.potOf(potId).stage;
    }

    function _returned(uint256 orderId) internal view returns (uint256 returned) {
        (,,,, returned) = _desk().accountOf(orderId);
    }

    function _claim(uint256 potId, address who) internal returns (uint256 paid) {
        vm.prank(stranger);
        paid = pots.claimRefund(potId, who);
    }

    function _assertStage(uint256 potId, CrowdPots.Stage want) internal view {
        assertEq(uint256(pots.potOf(potId).stage), uint256(want), "stored stage");
    }

    function _assertLiveStage(uint256 potId, CrowdPots.Stage want) internal view {
        assertEq(uint256(pots.stageOf(potId)), uint256(want), "live stage");
    }

    function _assertOrderState(uint256 orderId, IWorkOrders.State want) internal view {
        assertEq(uint256(_desk().stateOf(orderId)), uint256(want), "order state");
    }
}

/// @dev Shared setup for the CrowdPots tests: the pots on the real desk of this launch, which
/// proves through the real WorkProof. Only what lies outside this project is a stand-in: IMD, the
/// registry and Payroll. Every receipt is a real work record carrying the order's header.
abstract contract PotsBase is PotsActors {
    WorkOrders internal desk;
    WorkProof internal proof;
    PayrollStandIn internal payrollStandIn;
    /// @dev Where the desk sends its fee and tip.
    address internal payroll;
    /// @dev The hash of the last record `_settle` proved.
    bytes32 internal lastReceipt;

    function setUp() public virtual {
        vm.warp(START);
        imd = new MockIMD();
        registry = new RegistryStandIn();
        payrollStandIn = new PayrollStandIn(address(imd));
        payroll = address(payrollStandIn);
        // The launch's contracts, in manifest order.
        proof = new WorkProof(address(registry));
        desk = new WorkOrders(address(imd), address(proof), payroll);
        pots = new CrowdPots(address(imd), address(desk));
        _fundActors();
    }

    function _desk() internal view override returns (IWorkOrders) {
        return desk;
    }

    function _take(uint256 orderId, address who) internal {
        vm.prank(who);
        desk.claim(orderId);
    }

    function _register(uint256 orderId, address who) internal {
        vm.prank(who);
        desk.register(orderId, _jobOf(orderId));
    }

    function _takeAndRegister(uint256 orderId, address who) internal {
        _take(orderId, who);
        _register(orderId, who);
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }

    /// @dev The record of the order's registered job, done as asked: the real completed record
    /// with the current claim's header and the pot's spec as its objective.
    function _goodRecord(uint256 orderId) internal view returns (bytes memory) {
        return
            _recordOf(desk.claimOf(orderId).jobId, KIND_TEXT, bytes.concat(desk.headerOf(orderId), SPEC), "completed");
    }

    /// @dev The registry writes the job's receipt and anyone settles the order with the record.
    function _settle(uint256 orderId) internal returns (bytes32 receipt) {
        bytes memory record = _goodRecord(orderId);
        _write(desk.claimOf(orderId).jobId, record);
        desk.settle(orderId, record, _none());
        receipt = keccak256(record);
        lastReceipt = receipt;
    }

    /// @dev A receipt lands that does not settle the order, and is reported. `sameObjective`: the
    /// swarm failed the runner's own job (a blocked record with the claim's objective), which only
    /// the runner may report while the job is merely registered. Otherwise the registered job was
    /// for something else (a completed record with another objective), which anyone may report.
    function _reportFailed(uint256 orderId, bool sameObjective) internal {
        IWorkOrdersRunner.Claim memory c = desk.claimOf(orderId);
        bytes memory record = sameObjective
            ? _recordOf(c.jobId, KIND_TEXT, bytes.concat(desk.headerOf(orderId), SPEC), "blocked")
            : _recordOf(c.jobId, KIND_TEXT, "A job that no order on this desk asked for.", "completed");
        _write(c.jobId, record);
        vm.prank(sameObjective ? c.runner : stranger);
        desk.reportFailed(orderId, record, _none());
    }

    /// @dev A runner takes the order, registers the job, and the receipt settles it.
    function _deliver(uint256 orderId) internal {
        _takeAndRegister(orderId, runner);
        _settle(orderId);
    }

    /// @dev A runner takes the order, registers a job, claims delivery without a receipt, and
    /// somebody challenges the claim.
    function _dispute(uint256 orderId, address who, address by) internal {
        _takeAndRegister(orderId, who);
        vm.prank(who);
        desk.claimDelivered(orderId, RECEIPT);
        vm.prank(by);
        desk.challenge(orderId);
    }
}

/// @dev The same pots against a desk that can be made to break its own interface (`OddDesk`). The
/// real desk does none of that, so the checks CrowdPots makes on the desk's answers can only be
/// reached this way. Nothing else is tested here.
abstract contract OddDeskBase is PotsActors {
    MockWorkOrders internal desk;
    address internal payroll = makeAddr("payroll");

    function setUp() public virtual {
        vm.warp(START);
        imd = new MockIMD();
        desk = _newDesk();
        pots = new CrowdPots(address(imd), address(desk));
        _fundActors();
    }

    function _newDesk() internal virtual returns (MockWorkOrders);

    function _desk() internal view override returns (IWorkOrders) {
        return desk;
    }

    function _take(uint256 orderId, address who) internal {
        vm.prank(who);
        desk.claim(orderId);
    }

    function _takeAndRegister(uint256 orderId, address who) internal {
        _take(orderId, who);
        vm.prank(who);
        desk.register(orderId, _jobOf(orderId));
    }

    function _deliver(uint256 orderId) internal {
        _takeAndRegister(orderId, runner);
        desk.settle(orderId, RECEIPT);
    }
}
