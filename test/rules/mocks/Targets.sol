// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev An ordinary contract with views a rule might watch.
contract Gauge {
    uint256 public value;
    mapping(address => uint256) public balanceOf;

    function set(uint256 v) external {
        value = v;
    }

    function setBalance(address who, uint256 v) external {
        balanceOf[who] = v;
    }

    /// @dev Four arguments: the longest calldata a VIEW condition can store (132 bytes).
    function sum4(uint256 a, uint256 b, uint256 c, uint256 d) external pure returns (uint256) {
        return a + b + c + d;
    }
}

/// @dev A condition target that does whatever a test tells it to, for every call it receives:
/// answer with arbitrary bytes, revert, spin until the gas is gone, or try to write storage.
contract Puppet {
    uint8 public constant ANSWER = 0;
    uint8 public constant REVERT = 1;
    uint8 public constant SPIN = 2;
    uint8 public constant WRITE = 3;

    bytes internal _answer;
    uint8 internal _mode;
    uint256 internal _scribble;

    function puppetSet(uint8 mode, bytes calldata answer) external {
        _mode = mode;
        _answer = answer;
    }

    fallback() external {
        uint8 mode = _mode;
        if (mode == REVERT) revert("no");
        if (mode == SPIN) {
            uint256 i;
            while (true) {
                unchecked {
                    ++i;
                }
            }
        }
        if (mode == WRITE) _scribble += 1;
        bytes memory answer = _answer;
        assembly {
            return(add(answer, 0x20), mload(answer))
        }
    }
}

/// @dev Answers every call with 64 KB whose first word is 100: far more than a condition read wants.
contract Flood {
    fallback() external {
        assembly {
            mstore(0x00, 100)
            return(0x00, 0x10000)
        }
    }
}

/// @dev A target whose answer depends on the gas it is offered: it answers with the gas it has left
/// when it starts. A contract that reads another one and falls back to a default when that read
/// runs dry depends on its gas in the same way, only less visibly. The answer is five words, so it
/// can stand in for a view (first word) and for a feed (value, blocks, round 1, stamped now).
contract GasMeter {
    fallback() external {
        uint256 word = gasleft();
        uint256 stamp = block.timestamp;
        assembly {
            mstore(0x00, word)
            mstore(0x20, 1)
            mstore(0x40, 2)
            mstore(0x60, 1)
            mstore(0x80, stamp)
            return(0x00, 0xa0)
        }
    }
}
