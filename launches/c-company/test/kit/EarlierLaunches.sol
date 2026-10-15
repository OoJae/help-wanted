// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title The two earlier launches of HELP WANTED, as IdentityMD's ProjectFactory recorded them
/// @notice For tests and documentation. The contracts of the two launches that this launch depends
/// on, or reads, are in `src/interfaces/external/Mainnet.sol`; this library holds the rest of what
/// identifies the two launches: IdentityMD's launch number, the one transaction of each and its
/// block, the contracts of each that this launch does not touch, and the ids of the two daily feeds
/// launch A's `Questions` answers. The fork suite reads each launch's
/// transaction again and checks the factory's `ContractsLaunched` event in it against `Mainnet.sol`
/// (`test_fork_manifest_theEarlierLaunchesAreTheOnesTheFactoryRecorded`).
library EarlierLaunches {
    /// @dev Launch A (`Questions`, `JobsReport`, `Payroll`), 13 October 2026.
    uint64 internal constant LAUNCH_A = 1531;
    bytes32 internal constant LAUNCH_A_TX = 0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58;
    uint256 internal constant LAUNCH_A_BLOCK = 26_182_869;
    /// @dev Launch A's second contract, between `Mainnet.QUESTIONS` and `Mainnet.PAYROLL`.
    address internal constant JOBS_REPORT = 0x58963B57E179f7fE4E95090C21E8e9D75353BCE4;

    /// @dev Launch B (`WorkProof`, `WorkOrders`, `CrowdPots`, the Doorbell), 13 October 2026.
    uint64 internal constant LAUNCH_B = 1573;
    bytes32 internal constant LAUNCH_B_TX = 0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c;
    uint256 internal constant LAUNCH_B_BLOCK = 26_184_581;
    /// @dev Launch B's first and fourth contracts, around `Mainnet.WORK_ORDERS` and
    /// `Mainnet.CROWD_POTS`.
    address internal constant WORK_PROOF = 0xB268297dB06985ba0b806Ba97BcB90364b137469;
    address internal constant DOORBELL = 0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb;

    /// @dev The ids of launch A's two daily house feeds on `Questions`: the IMD paid to the swarm's
    /// fee payee per 7,000 blocks (payrolls), and the number of such transfers (hires).
    bytes32 internal constant PAYROLLS_FEED = 0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61;
    bytes32 internal constant HIRES_FEED = 0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d;
}
