// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";

/// @title A test double of the IdentityMD Intake
/// @notice `request` and `complete` follow the verified source line for line where a consumer can
/// tell the difference: the same request id, the same payment, the same gas rule for the callback
/// (a fixed stipend, refused when the writer sends too little, the outcome recorded and never
/// passed on). The owner functions are open so a test can move the price and the stipend.
///
/// The lines are version 1's. Version 2, which the launch names, has the same `request` and the
/// same `requests` getter, and its `complete` does the same for a request made with plain
/// `request`, the only kind `Questions` makes: the callback on status 0, no call at all on status 1
/// or 2 (no failure function was named). What version 2 adds, `requestWithFailure`, is not here;
/// the fork suite runs against the live version 2 contract.
///
/// One thing the real contract does not do is done by the protocol's plane, which reads its events:
/// only the first request of a transaction is served. The contract takes them all. The mock does the
/// same and records which requests were not the first of their transaction, so a test can show
/// which ones the plane would leave unserved.
contract MockIntake {
    using SafeERC20 for IERC20;
    using TransientSlot for *;

    struct Callback {
        address target;
        bytes4 selector;
    }

    struct Request {
        address payer;
        address callbackTarget;
        bytes4 callbackSelector;
        bool completed;
    }

    uint256 public constant MAX_BODY_BYTES = 16_384;
    uint256 internal constant CALLBACK_RESERVE = 20_000;

    error ActionNotSold(bytes32 action, address asset);
    error PriceNotMet(uint256 price, uint256 amount);
    error EmptyBody();
    error BodyTooLong(uint256 length);
    error UnknownRequest(bytes32 requestId);
    error AlreadyCompleted(bytes32 requestId);
    error NotWriter();
    error CallbackGasShort(uint256 needed, uint256 left);

    event Requested(
        bytes32 indexed requestId,
        address indexed payer,
        bytes32 indexed action,
        bytes body,
        address callbackTarget,
        bytes4 callbackSelector,
        address asset,
        uint256 amount
    );
    event Completed(bytes32 indexed requestId, uint8 status, bytes32 resultHash, string uri, bool delivered);

    address public payTo;
    address public writer;
    uint64 public callbackGas = 200_000;
    mapping(bytes32 action => mapping(address asset => uint256 amount)) public priceOf;
    mapping(bytes32 requestId => Request) public requests;
    uint256 public nonce;

    /// @dev Requests made after another one in the same transaction: the plane never serves these.
    mapping(bytes32 requestId => bool) public notFirstInTransaction;
    bytes32 internal constant ASKED_SLOT = keccak256("mock-intake.asked-this-transaction");

    /// @dev What the last request carried, for tests that compare bytes.
    bytes public lastBody;
    bytes32 public lastRequestId;
    bytes32 public lastAction;
    uint256 public lastAmount;
    /// @dev What the last callback did and what it cost the stipend.
    bool public lastDelivered;
    uint256 public lastCallbackGasUsed;

    constructor(address payTo_, address writer_) {
        payTo = payTo_;
        writer = writer_;
    }

    function setPrice(bytes32 action, address asset, uint256 amount) external {
        priceOf[action][asset] = amount;
    }

    function setCallbackGas(uint64 gas) external {
        callbackGas = gas;
    }

    /// @dev A Foundry test function can run as one transaction. This ends it for the record above,
    /// which is all the end of a real transaction does to a transient slot.
    function newTransaction() external {
        ASKED_SLOT.asBoolean().tstore(false);
    }

    function request(bytes32 action, bytes calldata body, Callback calldata callback, address asset, uint256 amount)
        external
        payable
        returns (bytes32 requestId)
    {
        uint256 price = priceOf[action][asset];
        if (price == 0) revert ActionNotSold(action, asset);
        if (amount < price) revert PriceNotMet(price, amount);
        if (body.length == 0) revert EmptyBody();
        if (body.length > MAX_BODY_BYTES) revert BodyTooLong(body.length);
        requestId = keccak256(abi.encode(block.chainid, address(this), ++nonce));
        requests[requestId] = Request(msg.sender, callback.target, callback.selector, false);
        if (ASKED_SLOT.asBoolean().tload()) notFirstInTransaction[requestId] = true;
        ASKED_SLOT.asBoolean().tstore(true);
        IERC20(asset).safeTransferFrom(msg.sender, payTo, amount);
        (lastBody, lastRequestId, lastAction, lastAmount) = (body, requestId, action, amount);
        emit Requested(requestId, msg.sender, action, body, callback.target, callback.selector, asset, amount);
    }

    function complete(bytes32 requestId, uint8 status, bytes32 resultHash, string calldata uri, bytes calldata args)
        external
    {
        if (msg.sender != writer) revert NotWriter();
        Request storage stored = requests[requestId];
        if (stored.payer == address(0)) revert UnknownRequest(requestId);
        if (stored.completed) revert AlreadyCompleted(requestId);
        stored.completed = true;
        bool delivered;
        uint256 used;
        if (status == 0 && stored.callbackTarget != address(0)) {
            uint256 stipend = callbackGas;
            uint256 needed = stipend + stipend / 63 + CALLBACK_RESERVE;
            if (gasleft() < needed) revert CallbackGasShort(needed, gasleft());
            bytes memory data = bytes.concat(stored.callbackSelector, args);
            address target = stored.callbackTarget;
            if (target.code.length > 0) {
                assembly ("memory-safe") {
                    let before := gas()
                    delivered := call(stipend, target, 0, add(data, 0x20), mload(data), 0, 0)
                    used := sub(before, gas())
                }
            }
        }
        (lastDelivered, lastCallbackGasUsed) = (delivered, used);
        emit Completed(requestId, status, resultHash, uri, delivered);
    }
}
