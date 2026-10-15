// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @notice Stores a record the way `WorkProof.proveChunks` expects to find it: as the code of data
/// contracts, each one `0x00` followed by a slice.
library Chunks {
    /// @dev EIP-170 caps deployed code at 24,576 bytes; one of them is the leading `0x00`.
    uint256 internal constant MAX_SLICE = 24_575;

    /// @dev Places the slices as code at consecutive addresses from `firstAddress`, without paying
    /// for a deployment. For tests that only care about what `proveChunks` reads.
    function etch(Vm vm, bytes memory record, uint256 sliceLen, uint160 firstAddress)
        internal
        returns (address[] memory chunks)
    {
        uint256 n = record.length == 0 ? 0 : (record.length + sliceLen - 1) / sliceLen;
        chunks = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 from = i * sliceLen;
            uint256 len = record.length - from < sliceLen ? record.length - from : sliceLen;
            chunks[i] = address(firstAddress + uint160(i));
            vm.etch(chunks[i], abi.encodePacked(bytes1(0x00), slice(record, from, len)));
        }
    }

    /// @dev Places slices cut at the given offsets (ascending, each within the record). A slice may
    /// be empty, which leaves a chunk holding only its `0x00`.
    function etchAt(Vm vm, bytes memory record, uint256[] memory cuts, uint160 firstAddress)
        internal
        returns (address[] memory chunks)
    {
        chunks = new address[](cuts.length + 1);
        uint256 from = 0;
        for (uint256 i = 0; i <= cuts.length; ++i) {
            uint256 to = i == cuts.length ? record.length : cuts[i];
            chunks[i] = address(firstAddress + uint160(i));
            vm.etch(chunks[i], abi.encodePacked(bytes1(0x00), slice(record, from, to - from)));
            from = to;
        }
    }

    /// @dev Really deploys one data contract holding `data` behind a `0x00`, the way a runner would.
    /// The creation code copies everything after its own 10 bytes into memory and returns it:
    /// PUSH2 size, DUP1, PUSH1 10, RETURNDATASIZE (zero), CODECOPY, RETURNDATASIZE, RETURN.
    function deploy(bytes memory data) internal returns (address chunk) {
        uint256 size = data.length + 1;
        require(size <= MAX_SLICE + 1, "slice too large for one contract");
        bytes memory initcode = abi.encodePacked(hex"61", uint16(size), hex"80600a3d393df3", bytes1(0x00), data);
        assembly ("memory-safe") {
            chunk := create(0, add(initcode, 0x20), mload(initcode))
        }
        require(chunk != address(0), "chunk deployment failed");
    }

    function slice(bytes memory data, uint256 from, uint256 len) internal pure returns (bytes memory out) {
        require(from + len <= data.length, "slice out of range");
        out = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(add(data, 0x20), from), len)
        }
    }
}
