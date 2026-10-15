// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Ethereum mainnet addresses this launch reads or pays
/// @notice For tests and documentation. Deployed contracts never import this: every address they
/// depend on is a constructor argument written into the launch manifest, so a reader can check
/// each one against the manifest instead of trusting a constant.
library Mainnet {
    /// @dev The IMD token: 18 decimals, no fee on transfer, no hooks.
    address internal constant IMD = 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7;
    /// @dev The staking vault over IMD (ERC-4626, 24 decimals, no owner). Endowments stakes into it.
    address internal constant SIMD = 0x9Efa934D9fAd4AE28c998a40195646b965a97247;

    /// @dev Uniswap v4's PoolManager. Zap swaps ETH for IMD through it.
    address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    /// @dev Uniswap's StateView lens. Read by the fork tests for the pool's price and depth; no
    /// deployed contract calls it.
    address internal constant STATE_VIEW = 0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227;
    /// @dev Permit2, to which sIMD gives a standing allowance over every holder's shares. A fork
    /// test shows it cannot move the shares Endowments holds.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// @dev IdentityMD's seat Adapter. Not a dependency of this launch: a fork test points a rule's
    /// condition at it as a real contract that reverts for the question asked.
    address internal constant SEAT_ADAPTER = 0xde152AfB7db5373F34876E1499fbD893A82dD336;

    /// @dev IdentityMD's ProjectFactory and the account that calls it for a launch.
    address internal constant PROJECT_FACTORY = 0xfF03410d0Fe5fa8f7F59F743de35E333D9857120;
    address internal constant LAUNCH_DEPLOYER = 0xcECc29B037f5064fCdF45a5C318F132ef76aA551;

    // ---- HELP WANTED's first launch (launch A), IdentityMD launch 1531, 13 October 2026 -----------
    // The factory's `ContractsLaunched` event of that launch names Questions, JobsReport and Payroll,
    // in that order. The rest of what identifies the launch is in `test/kit/EarlierLaunches.sol`; the
    // fork suite reads the event again and checks it against these addresses.
    /// @dev `Questions`: Standing Questions. The third argument of `Endowments` and the fourth of
    /// `Zap` in this launch's manifest.
    address internal constant QUESTIONS = 0xEECE4628ceb091C13393fc64056Be8b8501fD3F6;
    /// @dev `Payroll`, where the hire desk sends its fee and its tip. Not a dependency of this
    /// launch; the fork suite reads its books when an order of a rule is settled.
    address internal constant PAYROLL = 0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F;

    // ---- HELP WANTED's second launch (launch B), IdentityMD launch 1573, 13 October 2026 ----------
    // Its `ContractsLaunched` event names WorkProof, WorkOrders, CrowdPots and the Doorbell, in that
    // order.
    /// @dev `WorkOrders`, the hire desk. The second argument of `Rules` in this launch's manifest.
    address internal constant WORK_ORDERS = 0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2;
    /// @dev `CrowdPots`. The fourth argument of `Endowments` and the third of `Zap`.
    address internal constant CROWD_POTS = 0x8C2FfCdcb103659aa05c772b8F2059868B496EB5;

    // ---- IdentityMD's receipts ------------------------------------------------------------------

    /// @dev IdentityMD's WorkRegistry: `latest(bytes16 jobId)` is keccak256 of the job's work record.
    /// The desk is paid on it, through WorkProof. The fork suite writes a receipt into it by acting
    /// as the writer the registry names (`writer()`), as launch B's fork suite does.
    address internal constant WORK_REGISTRY = 0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775;
}
