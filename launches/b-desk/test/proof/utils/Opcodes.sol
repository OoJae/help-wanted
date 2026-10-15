// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Counts instructions in compiled code, for tests that pin what a contract can and cannot do.
library Opcodes {
    uint8 internal constant ORIGIN = 0x32;
    uint8 internal constant CODECOPY = 0x39;
    uint8 internal constant EXTCODESIZE = 0x3b;
    uint8 internal constant EXTCODECOPY = 0x3c;
    uint8 internal constant EXTCODEHASH = 0x3f;
    uint8 internal constant SLOAD = 0x54;
    uint8 internal constant SSTORE = 0x55;
    uint8 internal constant TLOAD = 0x5c;
    uint8 internal constant TSTORE = 0x5d;
    uint8 internal constant CREATE = 0xf0;
    uint8 internal constant CALL = 0xf1;
    uint8 internal constant CALLCODE = 0xf2;
    uint8 internal constant DELEGATECALL = 0xf4;
    uint8 internal constant CREATE2 = 0xf5;
    uint8 internal constant STATICCALL = 0xfa;
    uint8 internal constant SELFDESTRUCT = 0xff;

    /// @dev How often `opcode` occurs as an instruction in the first `length` bytes of `code`. The
    /// bytes a PUSH carries are data and are stepped over.
    function count(bytes memory code, uint256 length, uint8 opcode) internal pure returns (uint256 n) {
        require(length <= code.length, "length past the code");
        for (uint256 i = 0; i < length; ++i) {
            uint8 op = uint8(code[i]);
            if (op == opcode) ++n;
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
        }
    }

    function count(bytes memory code, uint8 opcode) internal pure returns (uint256) {
        return count(code, code.length, opcode);
    }
}
