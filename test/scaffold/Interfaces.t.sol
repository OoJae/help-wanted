// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {ICrowdPots} from "../../src/interfaces/ICrowdPots.sol";
import {IQuestions} from "../../src/interfaces/IQuestions.sol";
import {IWorkEmployer, IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IDeskLimits} from "../../src/rules/Rules.sol";
import {IMeterFunder} from "../../src/rules/Zap.sol";
import {IPoolManagerLike, IUnlockCallback} from "../../src/rules/v4/IPoolManagerLike.sol";

/// @dev Compiles every interface file of this project and pins the selectors this launch sends to
/// contracts of the two earlier launches and to Uniswap, so a signature that changes is caught at
/// once. `IQuestions` is launch A's file; `IWorkOrders` and `ICrowdPots` are launch B's. The two
/// small interfaces declared beside their only user (`IMeterFunder` in Zap.sol, `IDeskLimits` in
/// Rules.sol) name functions the real contracts have and the frozen files do not list.
contract InterfacesCompileTest is Test {
    function test_whatRulesCallsOnTheDesk() public pure {
        assertEq(
            IWorkOrders.createOrder.selector,
            bytes4(
                keccak256(
                    "createOrder((bytes32,uint96,uint96,uint32,uint32,uint40,uint96,uint8,address,address,address,bytes4,bytes32,uint8,uint256),bytes)"
                )
            )
        );
        assertEq(IWorkOrders.cancel.selector, bytes4(keccak256("cancel(uint256)")));
        assertEq(IWorkOrders.accountOf.selector, bytes4(keccak256("accountOf(uint256)")));
        assertEq(IWorkOrders.MIN_BOND.selector, bytes4(keccak256("MIN_BOND()")));
        assertEq(IWorkOrders.MIN_DELIVERY.selector, bytes4(keccak256("MIN_DELIVERY()")));
        assertEq(IWorkOrders.FLAG_ALLOW_CLAIMED.selector, bytes4(keccak256("FLAG_ALLOW_CLAIMED()")));
        assertEq(IWorkOrders.FLAG_CALLBACK.selector, bytes4(keccak256("FLAG_CALLBACK()")));
        // Outside the frozen file: the desk publishes it as a public constant.
        assertEq(IDeskLimits.MAX_DELIVERY.selector, bytes4(0x503865a9));
        assertEq(IDeskLimits.MAX_DELIVERY.selector, bytes4(keccak256("MAX_DELIVERY()")));
        // What the desk calls on Rules.
        assertEq(IWorkEmployer.onWorkDelivered.selector, bytes4(keccak256("onWorkDelivered(uint256,bytes16,bytes32)")));
    }

    function test_whatEndowmentsAndZapCallOnThePots() public pure {
        assertEq(ICrowdPots.chipInFor.selector, bytes4(keccak256("chipInFor(uint256,uint256,address)")));
        assertEq(ICrowdPots.remaining.selector, bytes4(keccak256("remaining(uint256)")));
        assertEq(ICrowdPots.potCount.selector, bytes4(keccak256("potCount()")));
    }

    function test_whatThisLaunchCallsOnQuestions() public pure {
        // Rules reads a feed's newest answer; Endowments reads a meter and funds it.
        assertEq(IQuestions.latest.selector, bytes4(keccak256("latest(bytes32)")));
        assertEq(IQuestions.costOf.selector, bytes4(keccak256("costOf(bytes32)")));
        assertEq(IQuestions.meterOf.selector, bytes4(keccak256("meterOf(bytes32)")));
        assertEq(IQuestions.fund.selector, bytes4(keccak256("fund(bytes32,uint256)")));
        // Outside the frozen file: Zap funds a meter in the caller's name.
        assertEq(IMeterFunder.fundFor.selector, bytes4(0x0bbc7e6e));
        assertEq(IMeterFunder.fundFor.selector, bytes4(keccak256("fundFor(bytes32,uint256,address)")));
    }

    function test_whatZapCallsOnUniswap() public pure {
        assertEq(IPoolManagerLike.unlock.selector, bytes4(keccak256("unlock(bytes)")));
        assertEq(
            IPoolManagerLike.swap.selector,
            bytes4(keccak256("swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)"))
        );
        assertEq(IPoolManagerLike.settle.selector, bytes4(keccak256("settle()")));
        assertEq(IPoolManagerLike.take.selector, bytes4(keccak256("take(address,address,uint256)")));
        assertEq(IUnlockCallback.unlockCallback.selector, bytes4(keccak256("unlockCallback(bytes)")));
    }

    function test_theAddressesThisLaunchIsGiven() public pure {
        assertEq(Mainnet.IMD, 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7);
        assertEq(Mainnet.SIMD, 0x9Efa934D9fAd4AE28c998a40195646b965a97247);
        assertEq(Mainnet.POOL_MANAGER, 0x000000000004444c5dc75cB358380D2e3dE08A90);
    }
}
