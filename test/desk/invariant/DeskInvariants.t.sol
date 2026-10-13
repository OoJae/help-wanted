// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IWorkOrders} from "../../../src/interfaces/IWorkOrders.sol";
import {WorkOrders} from "../../../src/desk/WorkOrders.sol";
import {DeskHandler} from "./DeskHandler.sol";

/// The money rules of the hire desk, checked after every step of random lifecycles.
///
/// W1  the desk's IMD balance equals the live escrows plus the live bonds
/// W2  a job's receipt settles at most one order
/// W3  an order never pays out more than maxPay, and its escrow is accounted for to the wei
/// W4  terminal states, and a finished order's books, never change
/// W5  nothing is paid without a matching receipt, or an unchallenged or arbitrated claim on an
///     order that opted in
/// W6  every bond goes exactly where the rules say (checked per call against the model)
/// W7  `accountOf(id).returned` is every transfer the desk made to the order's employer, no more
///     and no less (checked against the model and against the token's Transfer logs)
///
/// The cast overlaps on purpose: employers run and challenge their own orders, runners challenge
/// their own claims, and a job is given a second receipt with another hash now and then.
///
/// Runs are longer than the project default so that a random sequence has room to take an order
/// through a whole dispute. The settings are given for every profile this file is run under.
/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 200
contract DeskInvariantsTest is Test {
    DeskHandler internal handler;
    WorkOrders internal desk;

    function setUp() public {
        vm.warp(1_760_000_000);
        handler = new DeskHandler();
        desk = handler.desk();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](23);
        selectors[0] = DeskHandler.createOrder.selector;
        selectors[1] = DeskHandler.cancel.selector;
        selectors[2] = DeskHandler.refund.selector;
        selectors[3] = DeskHandler.setCondition.selector;
        selectors[4] = DeskHandler.trigger.selector;
        selectors[5] = DeskHandler.claim.selector;
        selectors[6] = DeskHandler.release.selector;
        selectors[7] = DeskHandler.evict.selector;
        selectors[8] = DeskHandler.register.selector;
        selectors[9] = DeskHandler.land.selector;
        selectors[10] = DeskHandler.settle.selector;
        selectors[11] = DeskHandler.reportFailed.selector;
        selectors[12] = DeskHandler.timeout.selector;
        selectors[13] = DeskHandler.claimDelivered.selector;
        selectors[14] = DeskHandler.challenge.selector;
        selectors[15] = DeskHandler.finalize.selector;
        selectors[16] = DeskHandler.resolve.selector;
        selectors[17] = DeskHandler.stamp.selector;
        selectors[18] = DeskHandler.redeliver.selector;
        selectors[19] = DeskHandler.wrongCaller.selector;
        selectors[20] = DeskHandler.warp.selector;
        selectors[21] = DeskHandler.setPayrollMode.selector;
        selectors[22] = DeskHandler.setBossMode.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// W1.
    function invariant_deskHoldsExactlyWhatItOwes() public view {
        assertEq(handler.imd().balanceOf(address(desk)), handler.owed(), "balance != live escrows + live bonds");
    }

    /// No IMD is created or lost anywhere among the parties.
    function invariant_imdIsConserved() public view {
        assertEq(handler.trackedTotal(), handler.totalMinted());
        assertEq(handler.imd().totalSupply(), handler.totalMinted());
    }

    /// W2.
    function invariant_aJobSettlesAtMostOneOrder() public view {
        uint256 n = handler.jobCount();
        for (uint256 i; i < n; ++i) {
            bytes16 job = handler.jobAt(i);
            assertLe(handler.provenCount(job), 1, "a job was matched twice");
            assertEq(desk.orderOfJob(job), handler.provenFor(job), "orderOfJob and the model disagree");
        }
    }

    /// W3, W4, W5 and W7, order by order.
    function invariant_everyOrderKeepsItsBooks() public view {
        uint256 n = desk.orderCount();
        for (uint256 id = 1; id <= n; ++id) {
            assertEq(handler.orderProblem(id), "", "order rule broken");
        }
    }

    /// W6 and every per-call check of the model: who may call, what state follows, who is paid what.
    function invariant_everyCallMatchedTheModel() public view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }

    /// Payroll never keeps an allowance over the desk's IMD.
    function invariant_noAllowanceIsLeftWithPayroll() public view {
        assertEq(handler.imd().allowance(address(desk), address(handler.payroll())), 0);
    }

    /// A long, fixed sequence through the same handler. Unlike the fuzzed runs it is the same every
    /// time, so it also proves that each path of the state machine is really reached.
    function test_soak_everyPathIsReachedAndEveryRuleHolds() public {
        _soak("help wanted soak", 2500);

        string[32] memory paths = [
            "createOrder",
            "cancel",
            "refund",
            "trigger",
            "claim",
            "claim.employer",
            "release",
            "evict",
            "register",
            "register.used",
            "settle",
            "settle.asserted",
            "settle.disputed",
            "settle.otherHash",
            "failed.swarm",
            "failed.kind",
            "failed.wrongJob",
            "failed.short",
            "failed.asserted",
            "failed.disputed",
            "timeout",
            "timeout.disputed",
            "claimDelivered",
            "challenge",
            "challenge.self",
            "challenge.employer",
            "finalize",
            "resolve.delivered",
            "resolve.refuted",
            "stamp",
            "redeliver",
            "land"
        ];
        emit log_named_uint("orders opened", desk.orderCount());
        emit log_named_uint("orders still live", handler.liveCount());
        for (uint256 i; i < paths.length; ++i) {
            emit log_named_uint(paths[i], handler.hits(bytes32(bytes(paths[i]))));
        }
        for (uint256 i; i < paths.length; ++i) {
            assertGt(handler.hits(bytes32(bytes(paths[i]))), 0, string.concat("never reached: ", paths[i]));
        }
        assertGt(desk.orderCount(), 100);
    }

    /// The same again from another starting point; only the rules are asserted.
    function test_soak_secondSequence() public {
        _soak("a second sequence", 2500);
        assertGt(handler.hits("settle") + handler.hits("finalize"), 10);
    }

    function _soak(string memory seed, uint256 steps) internal {
        for (uint256 i; i < steps; ++i) {
            _step(uint256(keccak256(abi.encode(seed, i))));
            if (i % 500 == 0) _checkAll();
        }
        _checkAll();
    }

    function _step(uint256 r) internal {
        uint256 a = r >> 8;
        uint256 b = uint256(keccak256(abi.encode(r)));
        uint256 roll = r % 100;
        // Keep the book of live orders small: when it is full, clear expired ones instead of adding.
        if (roll < 5 && handler.liveCount() >= 24) roll = 7;
        if (roll < 5) handler.createOrder(a, uint96(b), uint96(b >> 96), uint32(b >> 192), uint96(a >> 100));
        else if (roll < 7) handler.cancel(a);
        else if (roll < 11) handler.refund(a);
        else if (roll < 13) handler.setCondition(a);
        else if (roll < 16) handler.trigger(a);
        else if (roll < 30) handler.claim(a, b);
        else if (roll < 32) handler.release(a);
        else if (roll < 35) handler.evict(a);
        else if (roll < 43) handler.register(a, b);
        else if (roll < 54) handler.land(a, uint8(b));
        else if (roll < 63) handler.settle(a);
        else if (roll < 68) handler.reportFailed(a, b % 2 == 0);
        else if (roll < 72) handler.timeout(a);
        else if (roll < 79) handler.claimDelivered(a, b % 3 != 0);
        else if (roll < 85) handler.challenge(a, b);
        else if (roll < 88) handler.finalize(a);
        else if (roll < 90) handler.resolve(a, b % 2 == 0, b % 3 != 0);
        else if (roll < 92) handler.stamp(a);
        else if (roll < 94) handler.redeliver(a);
        else if (roll < 95) handler.wrongCaller(a);
        else if (roll < 98) handler.warp(a);
        else if (roll < 99) handler.setPayrollMode(uint8(a));
        else handler.setBossMode(a % 2 == 0);
        assertEq(handler.violations(), 0, handler.firstViolation());
    }

    function _checkAll() internal view {
        invariant_deskHoldsExactlyWhatItOwes();
        invariant_imdIsConserved();
        invariant_aJobSettlesAtMostOneOrder();
        invariant_everyOrderKeepsItsBooks();
        invariant_everyCallMatchedTheModel();
        invariant_noAllowanceIsLeftWithPayroll();
    }
}
