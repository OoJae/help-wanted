// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {DeskBase} from "./DeskBase.sol";
import {Chunks} from "../proof/utils/Chunks.sol";

/// @dev Makes one call from inside a transaction and reports what it used, so that the figure is
/// the call's own execution whether or not the test runner gives each top-level call a transaction
/// of its own. The calldata of the outer transaction is not in the figure.
contract CallMeter {
    function run(address target, bytes calldata data) external returns (uint256 used) {
        bytes memory input = data;
        bool ok;
        assembly ("memory-safe") {
            let before := gas()
            ok := call(gas(), target, 0, add(input, 0x20), mload(input), 0, 0)
            used := sub(before, gas())
            if iszero(ok) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }
}

/// @title What a settlement costs, on real records
/// @notice The desk settles through the launch's real WorkProof. Each record is a real IdentityMD
/// work record with its job id and objective swapped for an order's; its kind, state, agents and
/// bulk are as served. Payroll is the stand-in (the real one belongs to launch A), so its two
/// calls cost less here than they will: the real `pay` and `tip` were measured in launch A's
/// project at about 103,000 and 77,000 to 554,000 gas.
///
/// Run `forge test --match-contract WorkOrdersGasTest -vv` to print the figures. `execution` is
/// the desk call itself; `transaction` adds what the sender pays around it (21,000, the calldata,
/// and the EIP-7623 floor of 10 gas per calldata token), computed, not measured.
contract WorkOrdersGasTest is DeskBase {
    CallMeter internal meter;

    function setUp() public override {
        super.setUp();
        meter = new CallMeter();
    }

    /// @dev An order of `kind` held by `runner` with JOB registered.
    function _registeredOfKind(string memory kind) internal returns (uint256 id) {
        IWorkOrders.OrderParams memory p = _params();
        p.kindHash = keccak256(bytes(kind));
        id = _registered(p);
    }

    /// @dev Lands a stored record as the receipt of the order's job, with this claim's objective.
    function _landFixture(uint256 id, string memory file) internal returns (bytes memory record) {
        record = _recordFrom(file, JOB, _objective(id));
        _write(JOB, record);
    }

    function _settleMeasured(uint256 id, bytes memory record, string memory label) internal returns (uint256 used) {
        bytes memory data = abi.encodeCall(IWorkOrdersRunner.settle, (id, record, _noChunks()));
        used = meter.run(address(desk), data);
        _assertState(id, IWorkOrders.State.Delivered);
        assertTrue(desk.orderOf(id).proven);
        emit log_named_uint(string.concat(label, ": record bytes"), record.length);
        emit log_named_uint(string.concat(label, ": settle, execution"), used);
        emit log_named_uint(string.concat(label, ": settle, transaction"), _txGas(data, used));
    }

    /// @dev What a transaction with this calldata and this execution pays: the standard charge, or
    /// the calldata floor when that is larger.
    function _txGas(bytes memory data, uint256 exec) internal pure returns (uint256) {
        uint256 zeros;
        for (uint256 i; i < data.length; ++i) {
            if (data[i] == 0) ++zeros;
        }
        uint256 nonZeros = data.length - zeros;
        uint256 standard = 21_000 + 4 * zeros + 16 * nonZeros + exec;
        uint256 floor = 21_000 + 10 * (zeros + 4 * nonZeros);
        return standard > floor ? standard : floor;
    }

    /// A small record: the reference research report with the order's objective, one agent.
    function test_gas_settle_aSmallRecord() public {
        uint256 id = _registered();
        bytes memory record = _landGood(id, JOB);
        assertLt(record.length, 8_000);
        uint256 used = _settleMeasured(id, record, "small record");
        assertLt(used, 550_000, "settling a small record");
        assertEq(payroll.lastAgentIds().length, 1);
    }

    /// A large record sent as calldata: the 103 KB record of a contract-project job. Most of its
    /// bulk sorts after `state` and is hashed but not walked.
    function test_gas_settle_aLargeRecord() public {
        uint256 id = _registeredOfKind("skill:build-contract-project");
        bytes memory record = _landFixture(id, "8a5d5e50-skill-build-contract-project-12fd7238.hex");
        assertGt(record.length, 100_000);
        uint256 used = _settleMeasured(id, record, "large record");
        assertLt(used, 700_000, "settling a 100 KB record");
        // The real record names one agent; its other signal records a rejected submission.
        assertEq(payroll.lastAgentIds().length, 1);
        assertEq(payroll.lastAgentIds()[0], 51620);
    }

    /// The costliest real shape: an 88 KB research record whose bulk sorts before `state` and is
    /// walked nearly to the end.
    function test_gas_settle_aRecordWalkedNearlyToItsEnd() public {
        uint256 id = _registeredOfKind("research");
        bytes memory record = _landFixture(id, "bdfb46d4-research-a44d584e.hex");
        assertGt(record.length, 80_000);
        uint256 used = _settleMeasured(id, record, "research record");
        assertLt(used, 1_200_000, "settling the costliest real record");
    }

    /// The same large record through data contracts, as a record above 128 KB would have to go.
    /// Storing the chunks (200 gas per byte, once, in separate transactions) is not in the figure.
    function test_gas_settle_aLargeRecordFromChunks() public {
        uint256 id = _registeredOfKind("skill:build-contract-project");
        bytes memory record = _landFixture(id, "8a5d5e50-skill-build-contract-project-12fd7238.hex");
        address[] memory chunks = Chunks.etch(vm, record, Chunks.MAX_SLICE, uint160(0xC0DE5E7713));
        assertEq(chunks.length, 5);
        bytes memory data = abi.encodeCall(IWorkOrdersRunner.settle, (id, "", chunks));
        uint256 used = meter.run(address(desk), data);
        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(desk.claimOf(id).recordHash, keccak256(record));
        emit log_named_uint("large record, five chunks: settle, execution", used);
        emit log_named_uint("large record, five chunks: settle, transaction", _txGas(data, used));
        assertLt(used, 750_000);
    }

    /// The gas a settlement must be offered is more than it uses: the desk refuses to start a
    /// Payroll call it cannot hand 1,000,000 gas to. This finds the least gas on which a small
    /// settlement goes through, and the same for the costliest real record, and shows the call
    /// fails cleanly just below it.
    function test_gas_settle_whatMustBeOffered() public {
        uint256 small = _registered();
        bytes memory record = _landGood(small, JOB);
        uint256 least = _leastGas(small, record);
        emit log_named_uint("least gas on which a small settlement goes through (to 1,000)", least);
        assertGt(least, 1_300_000, "a settlement went through without room for Payroll's allowance");
        assertLt(least, 1_500_000);
    }

    function test_gas_settle_whatTheCostliestRecordMustBeOffered() public {
        uint256 id = _registeredOfKind("research");
        bytes memory record = _landFixture(id, "bdfb46d4-research-a44d584e.hex");
        uint256 least = _leastGas(id, record);
        emit log_named_uint("least gas on which the costliest real record settles (to 1,000)", least);
        assertGt(least, 1_300_000);
        assertLt(least, 2_200_000);
    }

    /// @dev The least gas, to the nearest thousand, on which `settle` goes through; one thousand
    /// below it the call reverts `GasShort` and the order is untouched.
    function _leastGas(uint256 id, bytes memory record) internal returns (uint256 high) {
        bytes memory data = abi.encodeCall(IWorkOrdersRunner.settle, (id, record, _noChunks()));
        uint256 low = 500_000;
        high = 4_000_000;
        uint256 snap = vm.snapshotState();
        while (high - low > 1_000) {
            uint256 mid = (low + high) / 2;
            (bool ok,) = address(desk).call{gas: mid}(data);
            if (ok) high = mid;
            else low = mid;
            vm.revertToState(snap);
        }
        (bool tooLittle, bytes memory ret) = address(desk).call{gas: low}(data);
        assertFalse(tooLittle);
        assertEq(bytes4(ret), IWorkOrdersRunner.GasShort.selector, "refused up front, not half done");
        _assertState(id, IWorkOrders.State.Registered);
    }
}
