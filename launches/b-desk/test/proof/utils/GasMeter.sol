// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Measures what a read-only call costs its caller, the same way whether or not the test
/// runner isolates each top-level call into its own transaction.
contract GasMeter {
    error MeasuredCallReverted(bytes reason);

    /// @return used Gas the call consumed as the caller sees it, with `target` already warm: the
    /// callee's own execution plus the 100 gas a call to a warm account costs. Nothing is copied
    /// back, so the size of the answer does not enter the figure.
    function measure(address target, bytes calldata data) external view returns (uint256 used) {
        bytes memory input = data;
        bool ok;
        assembly ("memory-safe") {
            // Touch the account so the call below is a warm one. The size is used, not discarded:
            // an unused read would be optimized away, leaving the first call of a transaction cold.
            if iszero(extcodesize(target)) { revert(0, 0) }
            let before := gas()
            ok := staticcall(gas(), target, add(input, 0x20), mload(input), 0, 0)
            used := sub(before, gas())
        }
        if (!ok) {
            bytes memory reason;
            assembly ("memory-safe") {
                reason := mload(0x40)
                mstore(reason, returndatasize())
                returndatacopy(add(reason, 0x20), 0, returndatasize())
                mstore(0x40, and(add(add(reason, 0x3f), returndatasize()), not(0x1f)))
            }
            revert MeasuredCallReverted(reason);
        }
    }
}
