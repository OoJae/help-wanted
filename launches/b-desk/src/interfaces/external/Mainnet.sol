// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Ethereum mainnet addresses this launch reads or pays
/// @notice For tests and documentation. Deployed contracts never import this: every address they
/// depend on is a constructor argument written into the launch manifest, so a reader can check
/// each one against the manifest instead of trusting a constant.
library Mainnet {
    address internal constant IMD = 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7;
    /// @dev The staking vault over IMD. Not a dependency of this launch; a fork test reads its
    /// IMD balance as a live value for an order's condition.
    address internal constant SIMD = 0x9Efa934D9fAd4AE28c998a40195646b965a97247;

    /// @dev IdentityMD's WorkRegistry: `latest(bytes16 jobId)` is keccak256 of the job's work record.
    address internal constant WORK_REGISTRY = 0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775;
    /// @dev The address the registry named as its writer on 11, 12 and 13 October 2026. The
    /// registry's admin can appoint another, so the fork tests read `writer()` and do not rely on
    /// this.
    address internal constant WORK_REGISTRY_WRITER = 0x5dA3054201BC7E241875Ac68173e49C269F76D44;

    /// @dev `Payroll` of HELP WANTED's first launch (IdentityMD launch 1531, block 26182869,
    /// 13 October 2026): where the desk sends its fee and its tip. It is the third constructor
    /// argument of `WorkOrders` in this launch's manifest.
    address internal constant PAYROLL = 0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F;
    /// @dev The seat token and the agent-to-seat Adapter that `Payroll` pays tips through. Not
    /// dependencies of this launch; a fork test follows one tip to the seat it belongs to.
    address internal constant SEATS = 0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D;
    address internal constant SEAT_ADAPTER = 0xde152AfB7db5373F34876E1499fbD893A82dD336;

    address internal constant PROJECT_FACTORY = 0xfF03410d0Fe5fa8f7F59F743de35E333D9857120;
    address internal constant LAUNCH_DEPLOYER = 0xcECc29B037f5064fCdF45a5C318F132ef76aA551;
}
