// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev A condition target: views that return a word, and views that fail in different ways.
contract MockCondition {
    error Nope();

    uint256 public value;
    mapping(bytes32 => uint256) public valueOf;
    uint256 internal _writes;

    function set(uint256 value_) external {
        value = value_;
    }

    function setFor(bytes32 key, uint256 value_) external {
        valueOf[key] = value_;
    }

    /// @dev No argument: `condSelector` alone.
    function read() external view returns (uint256) {
        return value;
    }

    /// @dev One argument: `condSelector ++ condArg`.
    function readFor(bytes32 key) external view returns (uint256) {
        return valueOf[key];
    }

    function fails() external pure returns (uint256) {
        revert Nope();
    }

    /// @dev Returns one byte only.
    function short() external pure {
        assembly {
            mstore(0, 0xff00000000000000000000000000000000000000000000000000000000000000)
            return(0, 1)
        }
    }

    /// @dev Returns nothing at all.
    function empty() external pure {}

    /// @dev Returns `value` followed by a lot of padding.
    function big() external view returns (bytes memory) {
        uint256 v = value;
        assembly {
            mstore(0, v)
            return(0, 20000)
        }
    }

    function burns() external pure returns (uint256) {
        uint256 i;
        while (true) {
            unchecked {
                ++i;
            }
        }
        return i;
    }

    /// @dev Not a view: a static call to it must fail.
    function writes() external returns (uint256) {
        return ++_writes;
    }

    /// @dev Uses about `gasToUse` gas of reads before answering 1; the amount comes in the argument.
    function costly(bytes32 gasToUse) external view returns (uint256) {
        uint256 floor = gasleft() - uint256(gasToUse);
        uint256 acc;
        while (gasleft() > floor) {
            acc ^= uint256(keccak256(abi.encode(acc)));
        }
        return 1;
    }
}

/// @dev A data source that refuses to answer on too little gas, the way WorkProof and Payroll do.
contract GasCheckedSource {
    error NotEnoughGas();

    function level() external view returns (uint256) {
        if (gasleft() < 60_000) revert NotEnoughGas();
        return 100;
    }
}

/// @dev A condition target that reads the source and answers zero when the read fails: its answer
/// depends on how much gas it was given.
contract ForgivingCondition {
    GasCheckedSource public immutable SOURCE;

    constructor(GasCheckedSource source) {
        SOURCE = source;
    }

    function reading() external view returns (uint256) {
        try SOURCE.level() returns (uint256 value) {
            return value;
        } catch {
            return 0;
        }
    }
}
