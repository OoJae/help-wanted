// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The constructor arguments of launch B that are chosen by us and not taken from the
/// chain: the Doorbell's values, as `docs/LAUNCH.md` proposes them. Every other argument is a
/// mainnet address (`Mainnet.sol`) or a reference to an earlier contract of the launch.
library LaunchValues {
    /// @dev keccak256("skill:create-image"): the kind a picture job's work record carries (the
    /// evidence is `test/fixtures/pots/picture-job.json`).
    bytes32 internal constant BELL_KIND_HASH = 0x7679ff00d2b015b122f4c00147c1004ea6657aada5fff65e72986b90c6869185;
    /// @dev One price, 1 IMD: with the bottom and the top of the range equal, an order's escrow is
    /// its price and nothing is left in the Doorbell after a hire.
    uint96 internal constant BELL_MIN_PAY = 1e18;
    uint96 internal constant BELL_MAX_PAY = 1e18;
    uint96 internal constant BELL_BOND = 0.25e18;
    uint32 internal constant BELL_DELIVERY_SECS = 7 days;
    /// @dev Decided on launch day by whether receipts are arriving; on while they are stalled.
    bool internal constant BELL_ALLOW_CLAIMED = true;
}
