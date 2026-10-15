// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Endowments} from "../../src/endowments/Endowments.sol";
import {Rules} from "../../src/rules/Rules.sol";
import {Zap} from "../../src/rules/Zap.sol";
import {MockCrowdPots} from "../endowments/mocks/MockCrowdPots.sol";
import {MockQuestions} from "../endowments/mocks/MockQuestions.sol";
import {MockStakedIMD} from "../endowments/mocks/MockStakedIMD.sol";
import {MockDesk} from "../rules/mocks/MockDesk.sol";
import {MockIMD} from "../rules/mocks/MockIMD.sol";
import {MockPoolManager} from "../rules/mocks/MockPoolManager.sol";
import {LaunchDoc} from "./LaunchDoc.sol";
import {LaunchManifest} from "./LaunchManifest.sol";

/// @dev What the ProjectFactory does with an `evm_contracts` launch, reduced to its core: every
/// contract is created with CREATE2 in manifest order, in one transaction, with zero ETH, and nothing
/// is called afterwards. The contracts see this factory as `msg.sender`, as they will see the real one.
contract MiniFactory {
    error DeploymentFailed(uint256 index);

    function launch(bytes[] calldata codes, uint256 value) external payable returns (address[] memory out) {
        out = new address[](codes.length);
        for (uint256 i; i < codes.length; ++i) {
            bytes memory code = codes[i];
            address created;
            assembly ("memory-safe") {
                created := create2(value, add(code, 0x20), mload(code), i)
            }
            if (created == address(0)) revert DeploymentFailed(i);
            out[i] = created;
        }
    }
}

/// @title Launch C on a local chain, from the manifest the document carries
/// @notice What the offline launch tests share: the three contracts created in manifest order from
/// the arguments written in `docs/LAUNCH.md`, and stand-ins that can be placed at the six addresses
/// the manifest names, so that each contract can be used through the addresses it was constructed
/// with and nothing else.
///
/// @dev The stand-ins are the ones the unit tests use: a plain token for IMD, a vault put in the
/// state the real sIMD was in at mainnet block 26,164,296, a PoolManager that sells IMD at a fixed
/// rate, and stand-ins for Questions, the hire desk and the crowd pots of the two earlier launches.
/// On this local chain nothing lives at the manifest's addresses, the live ones included, until a
/// test puts a stand-in there. The fork suite meets the real contracts at the same addresses, and
/// `integration/` holds each of the last three stand-ins beside the real contract's source.
abstract contract LaunchBench is LaunchDoc {
    MiniFactory internal factory;
    LaunchManifest.Literals internal lit;

    function _setUpBench() internal {
        factory = new MiniFactory();
        // What the document says. `test_manifest_*` checks that it is what `LaunchManifest.sol` says.
        lit = _literals();
    }

    function _launch() internal returns (Rules rules, Endowments endowments, Zap zap) {
        address[] memory out = factory.launch(LaunchManifest.initcodes(lit), 0);
        return (Rules(out[0]), Endowments(out[1]), Zap(out[2]));
    }

    /// @dev Puts stand-in code at the six addresses of the manifest. Code is copied to the address;
    /// what a stand-in keeps in storage is copied with it.
    function _placeStandIns() internal {
        _place(address(new MockIMD()), lit.imd);
        _place(address(new MockStakedIMD(lit.imd)), lit.simd);
        _place(address(new MockPoolManager(lit.imd)), lit.poolManager);
        _place(address(new MockQuestions(lit.imd)), lit.questions);
        _place(address(new MockDesk(lit.imd)), lit.workOrders);
        _place(address(new MockCrowdPots(lit.imd)), lit.crowdPots);
        // The pool has IMD to sell.
        MockIMD(lit.imd).mint(lit.poolManager, 1_000_000e18);
        // The vault starts as the real one stood at mainnet block 26,164,296.
        MockStakedIMD(lit.simd).seed(makeAddr("whale"), 229085987734110772074526144065);
        MockIMD(lit.imd).mint(lit.simd, 1824332924627773926954268);
    }

    function _place(address from, address to) internal {
        vm.etch(to, from.code);
        vm.copyStorage(from, to);
    }
}
