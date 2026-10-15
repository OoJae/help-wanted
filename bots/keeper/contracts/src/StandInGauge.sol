// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title A number anyone can read and the test can set, for conditions in the integration test
/// @notice A rule's VIEW condition and an order's condition both read one word from a contract and
/// compare it with a line. This is the simplest such contract: `level()` returns what was last set.
contract StandInGauge {
    uint256 public level;

    event LevelSet(uint256 level);

    function set(uint256 level_) external {
        level = level_;
        emit LevelSet(level_);
    }
}
