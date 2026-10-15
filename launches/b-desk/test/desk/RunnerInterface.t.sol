// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {LaunchKit} from "../launch/LaunchKit.sol";
import {DeskBase} from "./DeskBase.sol";

/// @title `IWorkOrdersRunner` against the desk
/// @notice `src/interfaces/IWorkOrdersRunner.sol` is what somebody outside the team compiles
/// against to run a runner or a keeper. These tests show that the file and the deployed desk say
/// the same thing:
///
/// - the desk answers every function selector the interface declares (each selector is found in
///   the dispatcher of the deployed bytecode), and has no function the interface leaves out;
/// - every event and every error the desk can emit or raise is declared in the interface, apart
///   from the two that come from OpenZeppelin's token and lock helpers;
/// - a runner written against the interface alone, with no other file of this project, can find
///   an order from its event, take it, build the job's objective, register the job and be paid,
///   and a keeper can make each of the calls that end what ran out of time.
contract RunnerInterfaceTest is DeskBase, LaunchKit {
    /// @dev The desk as an outsider's code would hold it.
    IWorkOrdersRunner internal r;

    function setUp() public override {
        super.setUp();
        r = IWorkOrdersRunner(address(desk));
    }

    // ---- selectors --------------------------------------------------------------------------------

    function test_runnerInterface_theDeskAnswersEverySelectorInIt() public {
        (string[] memory signatures, bytes4[] memory selectors) = _methods("IWorkOrdersRunner");
        (, bytes4[] memory deskSelectors) = _methods("WorkOrders");
        bytes memory code = address(desk).code;
        assertGt(signatures.length, 40, "the interface was read");
        for (uint256 i; i < signatures.length; ++i) {
            assertTrue(
                _hasSelector(deskSelectors, selectors[i]), string.concat("the desk's ABI has no ", signatures[i])
            );
            assertTrue(
                _pushesSelector(code, selectors[i]),
                string.concat("the deployed desk does not dispatch on the selector of ", signatures[i])
            );
        }

        // The search is not blind: a selector the desk does not have is not found in its code, and
        // a call with it reverts with nothing (the desk has no fallback).
        bytes4 unknown = bytes4(keccak256("notAFunctionOfTheDesk()"));
        assertFalse(_pushesSelector(code, unknown));
        (bool ok, bytes memory ret) = address(desk).call(abi.encodeWithSelector(unknown));
        assertFalse(ok);
        assertEq(ret.length, 0);
    }

    /// @notice The other direction: the desk has no external function the interface does not
    /// declare, so a reader of the interface has seen the whole surface.
    function test_runnerInterface_theDeskHasNothingPublicBeyondIt() public view {
        (string[] memory deskSignatures, bytes4[] memory deskSelectors) = _methods("WorkOrders");
        (string[] memory signatures, bytes4[] memory selectors) = _methods("IWorkOrdersRunner");
        for (uint256 i; i < deskSignatures.length; ++i) {
            assertTrue(
                _hasSelector(selectors, deskSelectors[i]),
                string.concat("the desk has a function the runner interface leaves out: ", deskSignatures[i])
            );
        }
        assertEq(deskSignatures.length, signatures.length);
    }

    /// @notice The thirteen calls a runner or a keeper makes, by the signatures a tool would encode.
    function test_runnerInterface_declaresTheRunnersAndTheKeepersCalls() public view {
        (, bytes4[] memory selectors) = _methods("IWorkOrdersRunner");
        string[24] memory wanted = [
            "claim(uint256)",
            "register(uint256,bytes16)",
            "settle(uint256,bytes,address[])",
            "claimDelivered(uint256,bytes32)",
            "challenge(uint256)",
            "finalize(uint256)",
            "stamp(uint256,bytes,address[])",
            "release(uint256)",
            "evict(uint256)",
            "timeout(uint256)",
            "reportFailed(uint256,bytes,address[])",
            "trigger(uint256)",
            "resolve(uint256,bool)",
            "redeliver(uint256)",
            "refund(uint256)",
            "cancel(uint256)",
            "priceNow(uint256)",
            "headerOf(uint256)",
            "ticketOf(uint256)",
            "conditionOf(uint256)",
            "orderOfJob(bytes16)",
            "barred(uint256,address)",
            "stateOf(uint256)",
            "accountOf(uint256)"
        ];
        for (uint256 i; i < wanted.length; ++i) {
            assertTrue(_hasSelector(selectors, bytes4(keccak256(bytes(wanted[i])))), wanted[i]);
        }
        assertEq(IWorkOrdersRunner.claim.selector, bytes4(keccak256("claim(uint256)")));
        assertEq(IWorkOrdersRunner.settle.selector, bytes4(keccak256("settle(uint256,bytes,address[])")));
    }

    // ---- events and errors ------------------------------------------------------------------------

    /// @notice Every event and error in the desk's ABI is declared in the interface, so a tool
    /// built from the interface alone can decode whatever the desk emits or reverts with. The two
    /// exceptions are OpenZeppelin's: `ReentrancyGuardReentrantCall()` (a nested call into the
    /// desk) and `SafeERC20FailedOperation(address)` (the token refused a transfer).
    function test_runnerInterface_declaresEveryEventAndErrorOfTheDesk() public view {
        string memory deskAbi = _artifact("WorkOrders");
        string memory interfaceAbi = _artifact("IWorkOrdersRunner");
        uint256 events;
        uint256 errors;
        for (uint256 i; vm.keyExistsJson(deskAbi, string.concat(".abi[", vm.toString(i), "]")); ++i) {
            string memory at = string.concat(".abi[", vm.toString(i), "]");
            string memory kind = vm.parseJsonString(deskAbi, string.concat(at, ".type"));
            if (!_same(kind, "event") && !_same(kind, "error")) continue;
            string memory name = vm.parseJsonString(deskAbi, string.concat(at, ".name"));
            if (_same(name, "ReentrancyGuardReentrantCall") || _same(name, "SafeERC20FailedOperation")) continue;
            assertTrue(
                _declares(interfaceAbi, kind, name), string.concat("the interface declares no ", kind, " ", name)
            );
            if (_same(kind, "event")) ++events;
            else ++errors;
        }
        assertEq(events, 16, "the desk's events");
        assertEq(errors, 28, "the desk's own errors");
    }

    function _declares(string memory artifact, string memory kind, string memory name) internal view returns (bool) {
        for (uint256 i; vm.keyExistsJson(artifact, string.concat(".abi[", vm.toString(i), "]")); ++i) {
            string memory at = string.concat(".abi[", vm.toString(i), "]");
            if (!_same(vm.parseJsonString(artifact, string.concat(at, ".type")), kind)) continue;
            if (_same(vm.parseJsonString(artifact, string.concat(at, ".name")), name)) return true;
        }
        return false;
    }

    // ---- a runner written against the interface alone ---------------------------------------------

    /// @notice The runner's loop as the interface's own notes describe it, using nothing but the
    /// interface: find the order in its `OrderOpened` event, read the price, claim, build the
    /// objective from `headerOf` and the event's spec, register the job, and settle with the
    /// record once the registry holds its hash.
    function test_runnerInterface_isEnoughToRunARunner() public {
        vm.recordLogs();
        uint256 id = _open();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // 1. Find the order: the event carries the whole job text and every parameter.
        bytes memory spec;
        IWorkOrders.OrderParams memory params;
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(r) && logs[i].topics[0] == IWorkOrdersRunner.OrderOpened.selector) {
                assertEq(uint256(logs[i].topics[1]), id);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), employer);
                bytes32 specHash;
                (specHash, params, spec) = abi.decode(logs[i].data, (bytes32, IWorkOrders.OrderParams, bytes));
                assertEq(specHash, keccak256(spec));
                found = true;
            }
        }
        assertTrue(found, "OrderOpened was not emitted");
        assertEq(spec, SPEC);
        assertEq(params.kindHash, keccak256(bytes(KIND)), "the kind a runner must open the job under");
        assertEq(uint8(r.stateOf(id)), uint8(IWorkOrders.State.Open));
        (bool met,,) = r.conditionOf(id);
        assertTrue(met, "an order without a condition can be taken");

        // 2. Claim: the bond is pulled, the price is fixed, the ticket comes back.
        uint256 price = r.priceNow(id);
        assertEq(price, params.minPay);
        vm.prank(runner);
        bytes32 ticket = r.claim(id);
        assertEq(ticket, r.ticketOf(id));
        assertEq(ticket, keccak256(abi.encode(block.chainid, address(r), id, uint256(1), runner)));
        IWorkOrdersRunner.Claim memory c = r.claimOf(id);
        assertEq(c.runner, runner);
        assertEq(c.price, price);

        // 3. The objective of the job to open: the 85 header bytes, then the spec.
        bytes memory header = r.headerOf(id);
        assertEq(header.length, r.HEADER_LEN());
        bytes memory objective = bytes.concat(header, spec);

        // 4. Register the job's id inside the claim window.
        vm.prank(runner);
        r.register(id, JOB);
        assertEq(r.claimOf(id).jobId, JOB);

        // 5. The swarm finishes the job and IdentityMD writes its receipt; anyone settles.
        bytes memory record = _recordOf(JOB, KIND, objective, "completed");
        _write(JOB, record);
        uint256 before = imd.balanceOf(runner);
        vm.prank(stranger);
        r.settle(id, record, new address[](0));

        (uint256 runnerPay, uint256 fee, uint256 tip) = _split(price);
        assertEq(imd.balanceOf(runner) - before, runnerPay + params.bond, "the price less 10%, and the bond back");
        assertEq(fee * 10_000, price * r.FEE_BPS());
        assertEq(tip * 10_000, price * r.TIP_BPS());
        assertEq(uint8(r.stateOf(id)), uint8(IWorkOrders.State.Delivered));
        assertEq(r.orderOfJob(JOB), id);
        assertTrue(r.orderOf(id).proven);
    }

    /// @notice The keeper's calls through the interface: each is refused until it is due, then
    /// goes through for any caller.
    function test_runnerInterface_isEnoughToRunAKeeper() public {
        // evict: a runner that registered nothing within the claim window.
        uint256 a = _open();
        _claim(a, runner);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        r.evict(a);
        _skip(r.CLAIM_WINDOW());
        vm.prank(stranger);
        r.evict(a);
        assertEq(uint8(r.stateOf(a)), uint8(IWorkOrders.State.Open));

        // timeout: a registered job with no receipt by the delivery deadline.
        _claim(a, runner2);
        _register(a, runner2, JOB);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        r.timeout(a);
        _skip(r.orderOf(a).deliverySecs);
        vm.prank(stranger);
        r.timeout(a);
        assertEq(uint8(r.stateOf(a)), uint8(IWorkOrders.State.Open));

        // refund: an order that expired with nobody holding it.
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        r.refund(a);
        vm.warp(r.orderOf(a).expiresAt);
        vm.prank(stranger);
        r.refund(a);
        assertEq(uint8(r.stateOf(a)), uint8(IWorkOrders.State.Refunded));

        // finalize: a delivery claim nobody challenged within the window.
        uint256 b = _asserted(_record(JOB2));
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        r.finalize(b);
        _skip(r.CHALLENGE_WINDOW());
        vm.prank(stranger);
        r.finalize(b);
        assertEq(uint8(r.stateOf(b)), uint8(IWorkOrders.State.Delivered));
        assertFalse(r.orderOf(b).proven);
    }
}
