// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Endowments} from "../../src/endowments/Endowments.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {Rules} from "../../src/rules/Rules.sol";
import {Zap} from "../../src/rules/Zap.sol";

/// @title Launch C's manifest, as data the tests can deploy from
/// @notice The launch pipeline deploys an `evm_contracts` launch from a manifest: the contracts in
/// order, each with its constructor arguments as static words. This library is that manifest for
/// launch C as code, so that the offline launch test and the rehearsal through the real
/// ProjectFactory build exactly the same bytes. `docs/LAUNCH.md` carries the same manifest as a JSON
/// block for a person to read; the launch tests read that block (`LaunchDoc.sol`) and fail when the
/// two differ.
///
/// @dev Order and arguments:
///
/// | # | Contract     | Constructor arguments                     |
/// |---|--------------|-------------------------------------------|
/// | 0 | `Rules`      | `imd`, `workOrders`                       |
/// | 1 | `Endowments` | `imd`, `simd`, `questions`, `crowdPots`   |
/// | 2 | `Zap`        | `imd`, `poolManager`, `crowdPots`, `questions` |
///
/// No contract of this launch refers to another, so the manifest has no `$contract:` reference and
/// no `$owner`: every argument is a literal address.
library LaunchManifest {
    /// @dev The values of the six literals the manifest carries.
    struct Literals {
        address imd;
        address simd;
        address poolManager;
        address questions;
        address workOrders;
        address crowdPots;
    }

    uint256 internal constant CONTRACTS = 3;

    // IdentityMD's token and staking vault, and Uniswap's v4 PoolManager, on Ethereum mainnet. Each
    // can be checked against the protocol's and Uniswap's published addresses.
    address internal constant IMD = Mainnet.IMD;
    address internal constant SIMD = Mainnet.SIMD;
    address internal constant POOL_MANAGER = Mainnet.POOL_MANAGER;

    // The contracts of HELP WANTED's two earlier launches, live on mainnet since 13 October 2026:
    //
    //   QUESTIONS    launch A (IdentityMD launch 1531), contract `Questions`
    //   WORK_ORDERS  launch B (IdentityMD launch 1573), contract `WorkOrders`
    //   CROWD_POTS   launch B (IdentityMD launch 1573), contract `CrowdPots`
    //
    // `docs/LAUNCH.md` writes the same three addresses into its manifest; the launch tests read
    // them from there and fail if they differ from these. The fork suite checks that each is the
    // address the factory's `ContractsLaunched` event of that launch names, and that code lives there.
    address internal constant QUESTIONS = Mainnet.QUESTIONS;
    address internal constant WORK_ORDERS = Mainnet.WORK_ORDERS;
    address internal constant CROWD_POTS = Mainnet.CROWD_POTS;

    /// @notice The manifest's literals as they stand in this file.
    function literals() internal pure returns (Literals memory v) {
        v.imd = IMD;
        v.simd = SIMD;
        v.poolManager = POOL_MANAGER;
        v.questions = QUESTIONS;
        v.workOrders = WORK_ORDERS;
        v.crowdPots = CROWD_POTS;
    }

    /// @notice The contract's name in the manifest: a Solidity identifier of at most 32 characters.
    function name(uint256 index) internal pure returns (string memory) {
        if (index == 0) return "Rules";
        if (index == 1) return "Endowments";
        return "Zap";
    }

    /// @notice The name as the ProjectFactory takes it: ASCII, padded with zeros on the right.
    function nameWord(uint256 index) internal pure returns (bytes32) {
        return bytes32(bytes(name(index)));
    }

    /// @notice How many constructor arguments the contract takes. The launch allows at most 16.
    function argumentCount(uint256 index) internal pure returns (uint256) {
        return index == 0 ? 2 : 4;
    }

    /// @notice The contract's creation code without its arguments.
    function creationCode(uint256 index) internal pure returns (bytes memory) {
        if (index == 0) return type(Rules).creationCode;
        if (index == 1) return type(Endowments).creationCode;
        return type(Zap).creationCode;
    }

    /// @notice The constructor arguments, encoded as the factory appends them: one word each.
    function arguments(uint256 index, Literals memory v) internal pure returns (bytes memory) {
        if (index == 0) return abi.encode(v.imd, v.workOrders);
        if (index == 1) return abi.encode(v.imd, v.simd, v.questions, v.crowdPots);
        return abi.encode(v.imd, v.poolManager, v.crowdPots, v.questions);
    }

    /// @notice What the factory deploys: the creation code followed by the arguments.
    function initcode(uint256 index, Literals memory v) internal pure returns (bytes memory) {
        return bytes.concat(creationCode(index), arguments(index, v));
    }

    /// @notice All three, in manifest order.
    function initcodes(Literals memory v) internal pure returns (bytes[] memory codes) {
        codes = new bytes[](CONTRACTS);
        for (uint256 i; i < CONTRACTS; ++i) {
            codes[i] = initcode(i, v);
        }
    }
}
