// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Stand-ins for the WorkRegistry: one that behaves, and several that do not.

/// @dev Answers `latest(bytes16)` the way the real registry does: the stored hash, or zero.
contract MockRegistry {
    mapping(bytes16 => bytes32) public latest;

    function set(bytes16 jobId, bytes32 documentHash) external {
        latest[jobId] = documentHash;
    }
}

/// @dev Reverts on every call.
contract RevertingRegistry {
    error Nope();

    fallback() external {
        revert Nope();
    }
}

/// @dev Reverts, and puts exactly one word in its revert data: the word a caller that looked only
/// at the size of the answer, and not at whether the call succeeded, would take for a receipt.
contract RevertsWithOneWordRegistry {
    bytes32 internal immutable WORD;

    constructor(bytes32 word) {
        WORD = word;
    }

    fallback() external {
        bytes32 word = WORD;
        assembly {
            mstore(0x00, word)
            revert(0x00, 0x20)
        }
    }
}

/// @dev Succeeds and returns no data.
contract SilentRegistry {
    fallback() external {}
}

/// @dev Answers only a call that is exactly what the ABI prescribes for `latest(bytes16)`: the
/// selector and one word whose low sixteen bytes are zero, 36 bytes in all. Anything else reverts.
contract ExactCallRegistry {
    bytes32 internal immutable WORD;

    constructor(bytes32 word) {
        WORD = word;
    }

    fallback() external {
        bytes32 word = WORD;
        assembly {
            if iszero(eq(calldatasize(), 0x24)) { revert(0, 0) }
            if iszero(eq(shr(224, calldataload(0)), 0xebe9712c)) { revert(0, 0) }
            if shl(128, calldataload(4)) { revert(0, 0) }
            mstore(0x00, word)
            return(0x00, 0x20)
        }
    }
}

/// @dev Returns `size` bytes whose first word is `word`, whatever is asked. With `size` 32 it is a
/// registry that gives the same answer for every job.
contract FixedAnswerRegistry {
    bytes32 internal immutable WORD;
    uint256 internal immutable SIZE;

    constructor(bytes32 word, uint256 size) {
        WORD = word;
        SIZE = size;
    }

    fallback() external {
        bytes32 word = WORD;
        uint256 size = SIZE;
        assembly {
            mstore(0x00, word)
            mstore(0x20, 0)
            return(0x00, size)
        }
    }
}

/// @dev Never returns: spends whatever gas it is given.
contract SpinningRegistry {
    fallback() external {
        while (true) {}
    }
}

/// @dev Tries to write storage, which a read-only call forbids.
contract WritingRegistry {
    uint256 internal counter;

    fallback() external {
        ++counter;
        bytes32 word = bytes32(uint256(1));
        assembly {
            mstore(0x00, word)
            return(0x00, 0x20)
        }
    }
}

/// @dev Gives the right answer after spending close to `burn` gas first. For checking that a caller
/// cannot turn a present receipt into `NoReceipt` by choosing how much gas to send.
contract SlowRegistry {
    mapping(bytes16 => bytes32) internal hashes;
    uint256 internal immutable BURN;

    constructor(uint256 burn) {
        BURN = burn;
    }

    function set(bytes16 jobId, bytes32 documentHash) external {
        hashes[jobId] = documentHash;
    }

    function latest(bytes16 jobId) external view returns (bytes32) {
        uint256 stopAt = gasleft() - BURN;
        uint256 sink;
        while (gasleft() > stopAt) {
            unchecked {
                ++sink;
            }
        }
        return hashes[jobId];
    }
}
