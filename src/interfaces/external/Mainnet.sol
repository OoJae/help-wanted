// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Ethereum mainnet addresses HELP WANTED reads or pays
/// @notice For tests, scripts and documentation. Deployed contracts never import this: every address
/// they depend on is a constructor argument written into the launch manifest, so a reader can check
/// each one against the manifest instead of trusting a constant.
library Mainnet {
    address internal constant IMD = 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7;
    address internal constant SIMD = 0x9Efa934D9fAd4AE28c998a40195646b965a97247;
    address internal constant SEATS = 0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D;
    uint256 internal constant SEAT_COUNT = 2000;

    address internal constant INTAKE = 0x1397434cd35e8a9C8aC312A61D3A285EB31dea56;
    address internal constant INTAKE_WRITER = 0x3d3C0Df7C1a17d384545e9D7C8228897bD9625CB;
    address internal constant INTAKE_DELIVERY = 0xCE0E6a670AA75E161d02aca3C7F00B94cA428CCb;
    address internal constant ORACLE_SIGNER = 0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982;
    /// @dev `bytes32("oracle.request@oracle-1")`: the UTF-8 bytes right-padded with zeros, not a hash.
    bytes32 internal constant ORACLE_ACTION = 0x6f7261636c652e72657175657374406f7261636c652d31000000000000000000;
    /// @dev Where every paid action's fee lands; the Robot Jobs Report counts transfers to it.
    address internal constant FEE_PAYEE = 0x4e0fA57Bde726079356537E2F34d671E9F41ADbc;

    address internal constant SEAT_ADAPTER = 0xde152AfB7db5373F34876E1499fbD893A82dD336;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    address internal constant PROJECT_FACTORY = 0xfF03410d0Fe5fa8f7F59F743de35E333D9857120;
    address internal constant LAUNCH_DEPLOYER = 0xcECc29B037f5064fCdF45a5C318F132ef76aA551;

    address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant UNIVERSAL_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
    address internal constant V4_QUOTER = 0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203;
    address internal constant STATE_VIEW = 0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
}
