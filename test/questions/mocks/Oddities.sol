// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Questions} from "../../../src/questions/Questions.sol";
import {MockIntake} from "./MockIntake.sol";

/// @dev A WHEN gate target that can be made to answer, refuse, mumble or stall.
contract GateTarget {
    enum Mode {
        Answer,
        Revert,
        ShortReturn,
        BurnGas,
        LongReturn
    }

    uint256 public stored;
    Mode public mode;

    function set(uint256 value_) external {
        stored = value_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    /// @dev 4 bytes of call data.
    function value() external view returns (uint256) {
        return _reply(stored);
    }

    /// @dev 36 bytes of call data.
    function plus(uint256 a) external view returns (uint256) {
        return _reply(stored + a);
    }

    /// @dev 68 bytes of call data, the longest a gate may store.
    function plus2(uint256 a, uint256 b) external view returns (uint256) {
        return _reply(stored + a + b);
    }

    function _reply(uint256 word) internal view returns (uint256) {
        Mode m = mode;
        if (m == Mode.Revert) revert("gate says no");
        if (m == Mode.BurnGas) {
            uint256 i;
            while (true) {
                unchecked {
                    ++i;
                }
            }
        }
        if (m == Mode.ShortReturn) {
            assembly {
                mstore(0x00, word)
                return(0x00, 0x1f)
            }
        }
        if (m == Mode.LongReturn) {
            // The first word followed by eight kilobytes nobody should pay to copy.
            assembly {
                mstore(0x00, word)
                return(0x00, 0x2000)
            }
        }
        return word;
    }
}

/// @dev Makes two requests in one transaction, which no test function can otherwise be sure of.
contract DoubleAsker {
    function askTwice(Questions q, bytes32 first, bytes32 second) external {
        q.request(first);
        q.request(second);
    }

    function askOnce(Questions q, bytes32 feedId) external returns (bytes32) {
        return q.request(feedId);
    }
}

/// @dev Buys an Intake request of its own and then presses a feed's `request`, all in one
/// transaction. The protocol's plane serves only the first request of a transaction, so the feed's
/// request is paid for and never served. The feed's tip is set aside for this caller and never
/// becomes its own: the round fails, or somebody else answers it.
contract BundledAsker {
    function buyThenAsk(MockIntake intake, Questions q, bytes32 feedId, bytes32 action, bytes calldata body)
        external
        returns (bytes32 ownId, bytes32 feedRequestId)
    {
        IERC20 imd = q.IMD();
        uint256 price = intake.priceOf(action, address(imd));
        imd.approve(address(intake), price);
        ownId = intake.request(action, body, MockIntake.Callback(address(0), bytes4(0)), address(imd), price);
        feedRequestId = q.request(feedId);
    }
}

/// @dev An Intake that does not behave: for the paths that treat the Intake as untrusted.
contract OddIntake {
    struct Callback {
        address target;
        bytes4 selector;
    }

    enum Read {
        Normal,
        Revert,
        ShortReturn,
        Garbage,
        BurnGas
    }

    uint256 public price = 0.5e18;
    Read public priceMode;
    Read public requestsMode;
    bool public completed;
    bool public fixedId;
    bool public skipPayment;
    /// @dev How much less than the amount named the Intake pulls.
    uint256 public shortBy;
    uint256 public nonce;
    /// @dev A call made back into the payer in the middle of `request`; its revert is passed on.
    bytes public reenterWith;
    address public payTo = address(0x4E0F);

    function setPrice(uint256 price_) external {
        price = price_;
    }

    function setPriceMode(Read mode) external {
        priceMode = mode;
    }

    function setRequestsMode(Read mode) external {
        requestsMode = mode;
    }

    function setCompleted(bool completed_) external {
        completed = completed_;
    }

    function setFixedId(bool fixedId_) external {
        fixedId = fixedId_;
    }

    function setSkipPayment(bool skip) external {
        skipPayment = skip;
    }

    function setShortBy(uint256 shortBy_) external {
        shortBy = shortBy_;
    }

    function setReenterWith(bytes calldata data) external {
        reenterWith = data;
    }

    function priceOf(bytes32, address) external view returns (uint256) {
        _odd(priceMode);
        return price;
    }

    function requests(bytes32) external view returns (address, address, bytes4, bool) {
        Read mode = requestsMode;
        _odd(mode);
        if (mode == Read.Garbage) {
            // A fourth word that is neither true nor false.
            assembly {
                mstore(0x00, 1)
                mstore(0x20, 2)
                mstore(0x40, 3)
                mstore(0x60, 2)
                return(0x00, 0x80)
            }
        }
        return (address(1), address(2), bytes4(0), completed);
    }

    function request(bytes32, bytes calldata, Callback calldata, address asset, uint256 amount)
        external
        payable
        returns (bytes32 requestId)
    {
        if (!fixedId) ++nonce;
        requestId = keccak256(abi.encode("odd intake", nonce));
        if (!skipPayment) IERC20(asset).transferFrom(msg.sender, payTo, amount - shortBy);
        bytes memory data = reenterWith;
        if (data.length != 0) {
            (bool ok, bytes memory why) = msg.sender.call(data);
            if (!ok) {
                assembly {
                    revert(add(why, 0x20), mload(why))
                }
            }
        }
    }

    function _odd(Read mode) internal pure {
        if (mode == Read.Revert) revert("intake says no");
        if (mode == Read.ShortReturn) {
            assembly {
                mstore(0x00, 1)
                return(0x00, 0x1f)
            }
        }
        if (mode == Read.BurnGas) {
            uint256 i;
            while (true) {
                unchecked {
                    ++i;
                }
            }
        }
    }
}

/// @dev A token that takes one percent more from the sender than the transfer says, to show
/// `request` refuses to leave the meters short.
contract GreedyIMD is ERC20 {
    bool public greedy;

    constructor() ERC20("Greedy", "GRD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setGreedy(bool greedy_) external {
        greedy = greedy_;
    }

    function _update(address from, address to, uint256 value_) internal override {
        super._update(from, to, value_);
        if (greedy && from != address(0) && to != address(0)) super._update(from, address(0), value_ / 100);
    }
}
