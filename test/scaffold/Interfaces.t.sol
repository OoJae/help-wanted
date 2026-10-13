// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IWorkRegistry} from "../../src/interfaces/external/IWorkRegistry.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {ICrowdPots} from "../../src/interfaces/ICrowdPots.sol";
import {IPayroll} from "../../src/interfaces/IPayroll.sol";
import {IWorkEmployer, IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";

/// @dev Compiles every interface file of this project and pins the selectors other launches and
/// outside tools encode by hand, so a signature that changes is caught at once. `IPayroll` is
/// launch A's (this project calls `pay` and `tip` and nothing else); `IWorkOrders`, `IWorkProof`
/// and `ICrowdPots` are copied into launch C.
contract InterfacesCompileTest is Test {
    function test_theRegistryAsThisLaunchSeesIt() public pure {
        assertEq(IWorkRegistry.latest.selector, bytes4(0xebe9712c));
        assertEq(
            IWorkRegistry.WorkRecorded.selector, 0xc3e4ffeab3a1fc840bb179d634166017188a59d5df2db3c5f563052a5f6f2f86
        );
        assertEq(Mainnet.WORK_REGISTRY, 0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775);
        assertEq(Mainnet.IMD, 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7);
    }

    function test_theSelectorsOtherLaunchesCompileAgainst() public pure {
        // What the desk calls on Payroll (launch A).
        assertEq(IPayroll.pay.selector, bytes4(keccak256("pay(uint256,bytes32)")));
        assertEq(IPayroll.tip.selector, bytes4(keccak256("tip(uint256[],uint256)")));
        assertEq(IPayroll.book.selector, bytes4(keccak256("book()")));
        // What the desk calls on an employer contract.
        assertEq(IWorkEmployer.onWorkDelivered.selector, bytes4(keccak256("onWorkDelivered(uint256,bytes16,bytes32)")));
        // What launch C calls on this launch.
        assertEq(
            IWorkOrders.createOrder.selector,
            bytes4(
                keccak256(
                    "createOrder((bytes32,uint96,uint96,uint32,uint32,uint40,uint96,uint8,address,address,address,bytes4,bytes32,uint8,uint256),bytes)"
                )
            )
        );
        assertEq(IWorkOrders.accountOf.selector, bytes4(keccak256("accountOf(uint256)")));
        assertEq(ICrowdPots.chipInFor.selector, bytes4(keccak256("chipInFor(uint256,uint256,address)")));
        assertEq(ICrowdPots.remaining.selector, bytes4(keccak256("remaining(uint256)")));
        assertEq(IWorkProof.prove.selector, bytes4(keccak256("prove(bytes16,bytes,uint256)")));
        assertEq(IWorkProof.proveChunks.selector, bytes4(keccak256("proveChunks(bytes16,address[],uint256)")));
        assertEq(IWorkProof.scan.selector, bytes4(keccak256("scan(bytes,uint256)")));
        // What a runner's tool encodes.
        assertEq(IWorkOrdersRunner.claim.selector, bytes4(keccak256("claim(uint256)")));
        assertEq(IWorkOrdersRunner.register.selector, bytes4(keccak256("register(uint256,bytes16)")));
        assertEq(IWorkOrdersRunner.settle.selector, bytes4(keccak256("settle(uint256,bytes,address[])")));
    }
}
