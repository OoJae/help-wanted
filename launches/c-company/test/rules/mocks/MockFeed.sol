// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev A Standing Questions stand-in that answers `latest` with whatever a test stored. Only the one
/// read Rules makes is implemented.
contract MockFeed {
    struct Answer {
        uint256 value;
        uint64 fromBlock;
        uint64 toBlock;
        uint64 round;
        uint64 updatedAt;
    }

    mapping(bytes32 => Answer) internal _latest;

    /// @dev A new answered round, stamped now.
    function push(bytes32 feedId, uint256 value) external returns (uint64 round) {
        Answer storage a = _latest[feedId];
        a.value = value;
        a.fromBlock = a.toBlock + 1;
        a.toBlock = uint64(block.number);
        a.round += 1;
        a.updatedAt = uint64(block.timestamp);
        return a.round;
    }

    function set(bytes32 feedId, uint256 value, uint64 round, uint64 updatedAt) external {
        Answer storage a = _latest[feedId];
        a.value = value;
        a.round = round;
        a.updatedAt = updatedAt;
    }

    function latest(bytes32 feedId)
        external
        view
        returns (uint256 value, uint64 fromBlock, uint64 toBlock, uint64 round, uint64 updatedAt)
    {
        Answer storage a = _latest[feedId];
        return (a.value, a.fromBlock, a.toBlock, a.round, a.updatedAt);
    }
}
