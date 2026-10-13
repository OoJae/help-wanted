// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {Receipts} from "../kit/Receipts.sol";
import {RegistryStandIn} from "../kit/RegistryStandIn.sol";
import {MockCondition} from "./mocks/MockCondition.sol";
import {MockEmployer} from "./mocks/MockEmployer.sol";
import {DeskToken} from "./mocks/DeskToken.sol";

/// @dev Shared setup: the desk wired to the real WorkProof of this launch, over a stand-in for
/// IdentityMD's registry, with a stand-in IMD and a stand-in Payroll (neither is part of this
/// project), a cast of funded wallets, and helpers that drive an order to any state. Every receipt
/// is a real work record carrying the order's header (see `Receipts`).
abstract contract DeskBase is Receipts {
    WorkOrders internal desk;
    DeskToken internal imd;
    WorkProof internal proof;
    PayrollStandIn internal payroll;
    MockCondition internal cond;

    address internal employer = makeAddr("employer");
    address internal runner = makeAddr("runner");
    address internal runner2 = makeAddr("runner2");
    address internal challenger = makeAddr("challenger");
    address internal arbiter = makeAddr("arbiter");
    address internal stranger = makeAddr("stranger");

    bytes internal constant SPEC =
        "Audit the repository at the pinned commit and report every finding. Inputs: repoUrl=https://example.org/r; baseCommit=0123abcd";
    /// @dev The kind the completed fixture record really has, so a good receipt needs no kind swap.
    string internal constant KIND = REAL_KIND;
    /// @dev Another kind the swarm writes, for receipts of the wrong kind.
    string internal constant OTHER_KIND = "audit";
    bytes16 internal constant JOB = bytes16(0xe9efec1656f340d3924352c453effc7d);
    bytes16 internal constant JOB2 = bytes16(0x11111111222233334444555555555555);

    uint96 internal constant MIN_PAY = 2e18;
    uint96 internal constant MAX_PAY = 4e18;
    uint96 internal constant BOND = 0.25e18;
    uint32 internal constant RAMP = 1 hours;
    uint32 internal constant DELIVERY = 3 days;
    uint40 internal constant LIFE = 30 days;
    uint256 internal constant START = 1_760_000_000;
    uint256 internal constant FUNDS = 1_000e18;

    function setUp() public virtual {
        vm.warp(START);
        imd = new DeskToken();
        registry = new RegistryStandIn();
        proof = new WorkProof(address(registry));
        payroll = new PayrollStandIn(address(imd));
        cond = new MockCondition();
        desk = new WorkOrders(address(imd), address(proof), address(payroll));
        address[6] memory cast = [employer, runner, runner2, challenger, arbiter, stranger];
        for (uint256 i; i < cast.length; ++i) {
            imd.mint(cast[i], FUNDS);
            vm.prank(cast[i]);
            imd.approve(address(desk), type(uint256).max);
        }
    }

    // --- time ---------------------------------------------------------------------------------

    /// @dev With the IR pipeline the compiler may reuse an earlier `block.timestamp` inside one test
    /// function, so tests read the time through the cheatcode and never from the opcode.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _skip(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    // --- parameters ---------------------------------------------------------------------------

    function _params() internal view returns (IWorkOrders.OrderParams memory p) {
        p.kindHash = keccak256(bytes(KIND));
        p.minPay = MIN_PAY;
        p.maxPay = MAX_PAY;
        p.rampSecs = RAMP;
        p.deliverySecs = DELIVERY;
        p.expiresAt = uint40(_now()) + LIFE;
        p.bond = BOND;
    }

    function _claimedParams() internal view returns (IWorkOrders.OrderParams memory p) {
        p = _params();
        p.flags = 1;
        p.arbiter = arbiter;
    }

    function _condParams(uint8 cmp, uint256 threshold) internal view returns (IWorkOrders.OrderParams memory p) {
        p = _params();
        p.condTarget = address(cond);
        p.condSelector = MockCondition.read.selector;
        p.condCmp = cmp;
        p.condThreshold = threshold;
    }

    // --- driving an order ---------------------------------------------------------------------

    function _open(IWorkOrders.OrderParams memory p) internal returns (uint256 id) {
        vm.prank(employer);
        id = desk.createOrder(p, SPEC);
    }

    function _open() internal returns (uint256) {
        return _open(_params());
    }

    function _claim(uint256 id, address who) internal returns (bytes32 ticket) {
        vm.prank(who);
        ticket = desk.claim(id);
    }

    function _register(uint256 id, address who, bytes16 jobId) internal {
        vm.prank(who);
        desk.register(id, jobId);
    }

    /// @dev An order held by `runner` with JOB registered.
    function _registered(IWorkOrders.OrderParams memory p) internal returns (uint256 id) {
        id = _open(p);
        _claim(id, runner);
        _register(id, runner, JOB);
    }

    function _registered() internal returns (uint256) {
        return _registered(_params());
    }

    /// @dev An order on the claimed path with a delivery claim for `record`.
    function _asserted(bytes memory record) internal returns (uint256 id) {
        id = _registered(_claimedParams());
        vm.prank(runner);
        desk.claimDelivered(id, keccak256(record));
    }

    function _disputed(bytes memory record) internal returns (uint256 id) {
        id = _asserted(record);
        vm.prank(challenger);
        desk.challenge(id);
    }

    /// @dev Drives a fresh order into `s`. For `None` it returns an id that does not exist.
    function _orderIn(IWorkOrders.State s) internal returns (uint256 id) {
        if (s == IWorkOrders.State.None) return desk.orderCount() + 1000;
        if (s == IWorkOrders.State.Open) return _open(_claimedParams());
        if (s == IWorkOrders.State.Cancelled) {
            id = _open(_claimedParams());
            vm.prank(employer);
            desk.cancel(id);
            return id;
        }
        if (s == IWorkOrders.State.Refunded) {
            IWorkOrders.OrderParams memory p = _claimedParams();
            p.expiresAt = uint40(_now() + 1);
            id = _open(p);
            _skip(1);
            desk.refund(id);
            return id;
        }
        if (s == IWorkOrders.State.Claimed) {
            id = _open(_claimedParams());
            _claim(id, runner);
            return id;
        }
        if (s == IWorkOrders.State.Registered) return _registered(_claimedParams());
        if (s == IWorkOrders.State.Asserted) return _asserted(_record(JOB));
        if (s == IWorkOrders.State.Disputed) return _disputed(_record(JOB));
        // Delivered, by proof.
        id = _registered(_claimedParams());
        desk.settle(id, _landGood(id, JOB), _noChunks());
    }

    // --- receipts -----------------------------------------------------------------------------

    /// @dev A record of `jobId` that is not in the registry and was written for no order: the real
    /// fixture with only its job id swapped. For the hash a runner names in a delivery claim, and
    /// for submitting a record the registry does not hold.
    function _record(bytes16 jobId) internal view returns (bytes memory) {
        return _recordOf(jobId, KIND, "A job nobody on this desk ordered.", "completed");
    }

    function _noChunks() internal pure returns (address[] memory) {
        return new address[](0);
    }

    /// @dev The agents a good receipt names: the one the real record names.
    function _agents() internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = REAL_AGENT;
    }

    /// @dev The objective a correct runner sends for the order's current claim.
    function _objective(uint256 id) internal view returns (bytes memory) {
        IWorkOrdersRunner.Order memory o = desk.orderOf(id);
        IWorkOrdersRunner.Claim memory c = desk.claimOf(id);
        return bytes.concat(_refHeader(block.chainid, address(desk), id, o.seq, c.runner), SPEC);
    }

    /// @dev Lands the receipt of a job done exactly as the order asks: the real completed record
    /// with this claim's header and the spec as its objective.
    function _landGood(uint256 id, bytes16 jobId) internal returns (bytes memory record) {
        record = _recordOf(jobId, KIND, _objective(id), "completed");
        _write(jobId, record);
    }

    /// @dev Lands a receipt with this claim's objective under another kind or state.
    function _land(uint256 id, bytes16 jobId, string memory kind, string memory state)
        internal
        returns (bytes memory record)
    {
        record = _recordOf(jobId, kind, _objective(id), state);
        _write(jobId, record);
    }

    /// @dev Lands a completed receipt of the order's kind whose objective is some other text.
    function _landOtherObjective(bytes16 jobId, bytes memory objective) internal returns (bytes memory record) {
        record = _recordOf(jobId, KIND, objective, "completed");
        _write(jobId, record);
    }

    /// @dev Lands a receipt with every part chosen by the test.
    function _landWith(
        bytes16 jobId,
        string memory kind,
        bytes memory objective,
        string memory state,
        uint256[] memory agents
    ) internal returns (bytes memory record) {
        record = _recordOf(jobId, kind, objective, state, agents);
        _write(jobId, record);
    }

    // --- reference implementations ------------------------------------------------------------

    /// @dev The header, written the slow and obvious way, to check the library against.
    function _refHeader(uint256 chainId, address desk_, uint256 orderId, uint256 seq, address runner_)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 ticket = keccak256(abi.encode(chainId, desk_, orderId, seq, runner_));
        return _refHeaderOf(ticket);
    }

    function _refHeaderOf(bytes32 ticket) internal pure returns (bytes memory) {
        bytes16 digits = "0123456789abcdef";
        bytes memory hexChars = new bytes(64);
        for (uint256 i; i < 32; ++i) {
            hexChars[2 * i] = digits[uint8(ticket[i]) >> 4];
            hexChars[2 * i + 1] = digits[uint8(ticket[i]) & 0x0f];
        }
        return abi.encodePacked("[help-wanted order ", hexChars, "] ");
    }

    /// @dev The fee split, written from the rule: 5% and 5%, each rounded up, the rest to the runner.
    function _split(uint256 price) internal pure returns (uint256 runnerPay, uint256 fee, uint256 tip) {
        fee = price * 500 / 10_000;
        if (fee * 10_000 != price * 500) ++fee;
        tip = fee;
        if (tip > price - fee) tip = price - fee;
        runnerPay = price - fee - tip;
    }

    /// @dev The release share of a bond: what `release` costs, and what the employer is paid out of
    /// the runner's bond when a challenged claim is not upheld.
    function _cut(uint256 bond) internal pure returns (uint256) {
        return bond / 10;
    }

    function _state(uint256 id) internal view returns (IWorkOrders.State) {
        return desk.stateOf(id);
    }

    function _assertState(uint256 id, IWorkOrders.State s) internal view {
        assertEq(uint8(desk.stateOf(id)), uint8(s), "state");
    }

    /// @dev The money rule every test can afford to check: the desk holds exactly the live escrows
    /// and the live bonds.
    function _assertSolvent() internal view {
        uint256 owed;
        uint256 n = desk.orderCount();
        for (uint256 id = 1; id <= n; ++id) {
            IWorkOrdersRunner.Order memory o = desk.orderOf(id);
            owed += o.escrow;
            if (
                o.state == IWorkOrders.State.Claimed || o.state == IWorkOrders.State.Registered
                    || o.state == IWorkOrders.State.Asserted
            ) owed += o.bond;
            if (o.state == IWorkOrders.State.Disputed) owed += uint256(o.bond) * 2;
        }
        assertEq(imd.balanceOf(address(desk)), owed, "desk balance != live escrows + live bonds");
    }
}
