// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IWorkEmployer, IWorkOrders} from "../../../src/interfaces/IWorkOrders.sol";

/// @dev A contract employer whose delivery callback the tests can make misbehave.
contract MockEmployer is IWorkEmployer {
    enum Mode {
        /// Records the call.
        Record,
        /// Reverts.
        Revert,
        /// Uses every unit of gas it is given.
        BurnGas,
        /// Opens a new order on the desk from inside the callback.
        Rehire,
        /// Calls back into the desk with `reenterData` and records whether that worked.
        Reenter,
        /// Returns a very large amount of data.
        ReturnBomb,
        /// Writes storage until about `gasToUse` gas is gone, then records the call.
        UseGas
    }

    error CallbackRefused();
    error NotDesk();

    IWorkOrders public immutable DESK;
    IERC20 public immutable IMD;

    Mode public mode;
    uint256 public calls;
    uint256 public lastOrderId;
    bytes16 public lastJobId;
    bytes32 public lastRecordHash;
    uint256 public gasSeen;
    uint256 public gasToUse;
    uint256 public rehiredId;
    bytes public reenterData;
    bool public reenterSucceeded;
    /// @dev The first word and the hash of what the re-entrant call returned (kept small on purpose:
    /// the callback has only 150,000 gas).
    bytes32 public reenterHead;
    bytes32 public reenterHash;
    IWorkOrders.OrderParams internal _rehireParams;
    bytes internal _rehireSpec;
    mapping(uint256 => uint256) internal _sink;

    constructor(address desk, address imd) {
        DESK = IWorkOrders(desk);
        IMD = IERC20(imd);
        IERC20(imd).approve(desk, type(uint256).max);
        // Written once here so that the callback's own bookkeeping overwrites warm, non-zero slots
        // and leaves most of its gas for what a test wants it to do.
        gasSeen = 1;
        lastOrderId = type(uint256).max;
        lastJobId = bytes16(type(uint128).max);
        lastRecordHash = bytes32(type(uint256).max);
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function setGasToUse(uint256 gasToUse_) external {
        gasToUse = gasToUse_;
    }

    function setReenter(bytes calldata data) external {
        reenterData = data;
    }

    function setRehire(IWorkOrders.OrderParams calldata p, bytes calldata spec) external {
        _rehireParams = p;
        _rehireSpec = spec;
    }

    function open(IWorkOrders.OrderParams calldata p, bytes calldata spec) external returns (uint256) {
        return DESK.createOrder(p, spec);
    }

    function cancel(uint256 id) external {
        DESK.cancel(id);
    }

    function onWorkDelivered(uint256 orderId, bytes16 jobId, bytes32 recordHash) external {
        if (msg.sender != address(DESK)) revert NotDesk();
        gasSeen = gasleft();
        Mode m = mode;
        if (m == Mode.Revert) revert CallbackRefused();
        if (m == Mode.BurnGas) {
            uint256 i;
            while (true) {
                unchecked {
                    ++i;
                }
            }
        }
        if (m == Mode.UseGas) {
            uint256 floor = gasleft() - gasToUse;
            uint256 k;
            while (gasleft() > floor) {
                _sink[k] = k + 1;
                unchecked {
                    ++k;
                }
            }
        }
        ++calls;
        lastOrderId = orderId;
        lastJobId = jobId;
        lastRecordHash = recordHash;
        if (m == Mode.Rehire) rehiredId = DESK.createOrder(_rehireParams, _rehireSpec);
        if (m == Mode.Reenter) {
            (bool ok, bytes memory ret) = address(DESK).call(reenterData);
            reenterSucceeded = ok;
            reenterHead = bytes32(ret);
            reenterHash = keccak256(ret);
        }
        if (m == Mode.ReturnBomb) {
            assembly {
                return(0, 60000)
            }
        }
    }
}
