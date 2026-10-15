// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {ForkKit, ILivePayroll} from "./ForkKit.sol";

/// @title A desk on the fork, built the way the launch builds it
/// @notice What the fork tests of the desk share: this project's `WorkProof` pointed at the real
/// WorkRegistry, a `WorkOrders` built with the real IMD and the address of the live Payroll (the
/// three arguments the launch's manifest gives it), four actors holding real IMD, and the steps
/// of an order's life up to a registered job.
abstract contract DeskOnFork is ForkKit {
    WorkOrders internal desk;
    WorkProof internal proof;
    /// @dev Where the desk under test sends its fee and tip: the live Payroll, except in the one
    /// test that builds a second desk on a stand-in.
    address internal payrollAt = Mainnet.PAYROLL;

    address internal employer = makeAddr("fork loop employer");
    address internal runner = makeAddr("fork loop runner");
    address internal challenger = makeAddr("fork loop challenger");
    address internal stranger = makeAddr("fork loop stranger");

    bytes internal constant SPEC =
        "Write a one-page plain-language summary of how the IdentityMD WorkRegistry records a finished job, with sources. Inputs: length=one page; format=markdown";
    string internal constant KIND = REAL_KIND;
    uint96 internal constant MIN_PAY = 2e18;
    uint96 internal constant MAX_PAY = 4e18;
    uint96 internal constant BOND = 0.25e18;
    uint32 internal constant RAMP = 1 hours;
    uint32 internal constant DELIVERY = 3 days;
    /// @dev Half way up the ramp: (2 + 4) / 2.
    uint256 internal constant PRICE = 3e18;
    uint256 internal constant FEE = 0.15e18;
    uint256 internal constant TIP = 0.15e18;

    struct Balances {
        uint256 employer;
        uint256 runner;
        uint256 challenger;
        uint256 payroll;
        uint256 desk;
    }

    /// @dev The live Payroll's books at one moment.
    struct Books {
        ILivePayroll.Ledger ledger;
        uint256 unbooked;
        uint256 owedToTheRealAgent;
    }

    function setUp() public virtual {
        if (!_fork()) return;
        proof = new WorkProof(Mainnet.WORK_REGISTRY);
        desk = new WorkOrders(Mainnet.IMD, address(proof), Mainnet.PAYROLL);
        _fund(employer, 10 * uint256(MAX_PAY), address(desk));
        _fund(runner, 10 * uint256(BOND), address(desk));
        _fund(challenger, 10 * uint256(BOND), address(desk));
    }

    // ---- helpers --------------------------------------------------------------------------------

    function _balances() internal view returns (Balances memory b) {
        b.employer = IMD.balanceOf(employer);
        b.runner = IMD.balanceOf(runner);
        b.challenger = IMD.balanceOf(challenger);
        b.payroll = IMD.balanceOf(payrollAt);
        b.desk = IMD.balanceOf(address(desk));
    }

    function _books() internal view returns (Books memory k) {
        k.ledger = PAYROLL.ledger();
        k.unbooked = PAYROLL.unbooked();
        k.owedToTheRealAgent = PAYROLL.tipOwed(REAL_AGENT);
    }

    /// @dev What the live Payroll must have booked since `a` for one delivery: the fee as revenue
    /// through `pay`, the tip through `tip`, of which `toSeatPool` joined the seat pool and the
    /// rest is owed to the one agent the reference record names. Nothing came by plain transfer.
    function _assertBooked(Books memory a, uint256 fee, uint256 tip, uint256 toSeatPool) internal view {
        Books memory b = _books();
        assertEq(b.ledger.received - a.ledger.received, fee, "Payroll booked the fee as revenue");
        assertEq(b.ledger.tipsIn - a.ledger.tipsIn, tip, "Payroll took the tip as a tip");
        assertEq(b.ledger.tipsToSeats - a.ledger.tipsToSeats, toSeatPool, "the part of the tip in the seat pool");
        assertEq(b.owedToTheRealAgent - a.owedToTheRealAgent, tip - toSeatPool, "the part owed to the agent");
        assertEq(b.unbooked, a.unbooked, "nothing reached Payroll by plain transfer");
        assertEq(IMD.allowance(address(desk), Mainnet.PAYROLL), 0, "no allowance is left with Payroll");
    }

    function _one(uint256 agentId) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = agentId;
    }

    function _params(uint8 flags) internal view returns (IWorkOrders.OrderParams memory p) {
        p.kindHash = keccak256(bytes(KIND));
        p.minPay = MIN_PAY;
        p.maxPay = MAX_PAY;
        p.rampSecs = RAMP;
        p.deliverySecs = DELIVERY;
        p.expiresAt = uint40(_now() + 30 days);
        p.bond = BOND;
        p.flags = flags;
    }

    function _open(uint8 flags) internal returns (uint256 id) {
        vm.prank(employer);
        id = desk.createOrder(_params(flags), SPEC);
    }

    /// @dev The runner takes the order half way up its price ramp and registers a fresh job.
    function _take(uint256 id) internal returns (bytes16 jobId) {
        _skip(RAMP / 2);
        vm.prank(runner);
        desk.claim(id);
        jobId = _freshJob();
        vm.prank(runner);
        desk.register(id, jobId);
    }

    /// @dev The record of a job done exactly as the order's current claim asks.
    function _record(uint256 id, bytes16 jobId, string memory state) internal view returns (bytes memory) {
        return _recordOf(jobId, KIND, bytes.concat(desk.headerOf(id), SPEC), state);
    }

    function _state(uint256 id) internal view returns (IWorkOrders.State) {
        return desk.stateOf(id);
    }

    function _assertState(uint256 id, IWorkOrders.State want) internal view {
        assertEq(uint8(desk.stateOf(id)), uint8(want), "state");
    }
}
