// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Reads compiled code one instruction at a time
/// @notice For the tests that pin what a launched contract cannot do. A launch is refused if any of
/// its contracts can run DELEGATECALL, CALLCODE or SELFDESTRUCT, and the check is made on the code
/// that ends up on chain, not on the source.
///
/// @dev A byte is an instruction only where execution can read it as one. The bytes that follow a
/// PUSH1 to PUSH32 are that instruction's data (an address, a selector, a constant) and are stepped
/// over: a constant that happens to contain the byte 0xf4 is not a DELEGATECALL. The project builds
/// with `bytecode_hash = "none"` and `cbor_metadata = false`, so no metadata trails the code.
library Bytecode {
    uint8 internal constant CALLCODE = 0xf2;
    uint8 internal constant DELEGATECALL = 0xf4;
    uint8 internal constant SELFDESTRUCT = 0xff;

    uint8 internal constant CREATE = 0xf0;
    uint8 internal constant CREATE2 = 0xf5;
    uint8 internal constant ORIGIN = 0x32;

    /// @notice How often `opcode` occurs as an instruction in `code`.
    function count(bytes memory code, uint8 opcode) internal pure returns (uint256 n) {
        uint256 length = code.length;
        for (uint256 i = 0; i < length; ++i) {
            uint8 op = uint8(code[i]);
            if (op == opcode) ++n;
            // PUSH1 (0x60) carries one byte of data, PUSH32 (0x7f) thirty-two.
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
        }
    }

    /// @notice How many of the three instructions a launch forbids occur in `code`.
    function forbidden(bytes memory code) internal pure returns (uint256) {
        return count(code, DELEGATECALL) + count(code, CALLCODE) + count(code, SELFDESTRUCT);
    }

    /// @notice How many instructions `code` has in all, and how many bytes of it are PUSH data.
    function shape(bytes memory code) internal pure returns (uint256 instructions, uint256 pushData) {
        uint256 length = code.length;
        for (uint256 i = 0; i < length; ++i) {
            uint8 op = uint8(code[i]);
            ++instructions;
            if (op >= 0x60 && op <= 0x7f) {
                uint256 carried = op - 0x5f;
                // The last PUSH of a contract may be cut short by the end of the code.
                if (i + carried >= length) carried = length - 1 - i;
                pushData += carried;
                i += carried;
            }
        }
    }
}
