// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {JsonScan} from "../../../src/proof/JsonScan.sol";

/// @notice Runs `JsonScan` on a record with chosen bytes placed in memory right behind it.
/// @dev The scanner reads memory 32 bytes at a time, so near the end of a record it sees up to 31
/// bytes that are not part of it. Inside `WorkProof` those bytes happen to be zero. Nothing in the
/// library relies on that, and this contract is how the tests show it: here the bytes behind the
/// record are whatever the test passes as `noise`.
contract NoisyMemoryScanner {
    /// @return jobId The record's own job id.
    /// @return kindHash keccak256 of the `kind` contents.
    /// @return objectiveHash keccak256 of the `objective` contents.
    /// @return stateHash keccak256 of the `state` contents.
    /// @return ids What `JsonScan.agentIds` reads from `signals`.
    function scan(bytes calldata record, bytes32 noise)
        external
        pure
        returns (bytes16 jobId, bytes32 kindHash, bytes32 objectiveHash, bytes32 stateHash, uint256[] memory ids)
    {
        bytes memory buf;
        assembly ("memory-safe") {
            buf := mload(0x40)
            mstore(buf, record.length)
            calldatacopy(add(buf, 0x20), record.offset, record.length)
            let end := add(add(buf, 0x20), record.length)
            // The 32 bytes that follow the record's last byte, with no padding in between.
            mstore(end, noise)
            mstore(0x40, and(add(end, 0x3f), not(0x1f)))
        }
        JsonScan.Spans memory s = JsonScan.scan(buf);
        jobId = s.jobId;
        kindHash = _hash(s.kindPtr, s.kindLen);
        objectiveHash = _hash(s.objectivePtr, s.objectiveLen);
        stateHash = _hash(s.statePtr, s.stateLen);
        ids = JsonScan.agentIds(s.signalsPtr, s.signalsLen);
    }

    function _hash(uint256 ptr, uint256 len) private pure returns (bytes32 h) {
        assembly ("memory-safe") {
            h := keccak256(ptr, len)
        }
    }
}
