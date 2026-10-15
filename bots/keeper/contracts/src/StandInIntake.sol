// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title A stand-in for the IdentityMD Intake, for the keeper's integration test
/// @notice It follows the verified source of version 2 (REF/protocol/intake-v2/Intake.sol) in
/// everything a paying contract and a keeper touch: `request` takes the price in the asset and
/// forwards it to `payTo`, records who asked and where the answer goes, and emits `Requested` with
/// the whole body; `complete`, callable by the writer only and only once per request, marks the
/// request completed and, on status 0, calls the callback once with a fixed gas stipend inside a
/// try, so a callback that reverts cannot block the write. `requests`, `priceOf`, `callbackGas`,
/// `nonce`, `payTo`, `writer` and the two events have the real shapes.
///
/// Left out: paying in the native coin, quotes (`pay`), `requestWithFailure`, and the owner.
/// The test sets the price and the callback gas directly.
contract StandInIntake {
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
    error ForwardFailed();

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

    address public immutable payTo;
    address public immutable writer;
    uint64 public callbackGas = 200_000;
    mapping(bytes32 action => mapping(address asset => uint256 amount)) public priceOf;
    mapping(bytes32 requestId => Request) public requests;
    uint256 public nonce;

    constructor(address payTo_, address writer_) {
        payTo = payTo_;
        writer = writer_;
    }

    /// @notice Test set-up: the price of an action in an asset. Zero means it is not sold.
    function setPrice(bytes32 action, address asset, uint256 amount) external {
        priceOf[action][asset] = amount;
    }

    /// @notice Test set-up: the gas a callback is given.
    function setCallbackGas(uint64 gas) external {
        callbackGas = gas;
    }

    function request(bytes32 action, bytes calldata body, Callback calldata callback, address asset, uint256 amount)
        external
        returns (bytes32 requestId)
    {
        uint256 price = priceOf[action][asset];
        if (price == 0) revert ActionNotSold(action, asset);
        if (amount < price) revert PriceNotMet(price, amount);
        if (body.length == 0) revert EmptyBody();
        if (body.length > MAX_BODY_BYTES) revert BodyTooLong(body.length);
        requestId = keccak256(abi.encode(block.chainid, address(this), ++nonce));
        requests[requestId] = Request(msg.sender, callback.target, callback.selector, false);
        if (!IToken(asset).transferFrom(msg.sender, payTo, amount)) revert ForwardFailed();
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
        if (status == 0 && stored.callbackTarget != address(0)) {
            uint256 stipend = callbackGas;
            uint256 needed = stipend + stipend / 63 + CALLBACK_RESERVE;
            if (gasleft() < needed) revert CallbackGasShort(needed, gasleft());
            bytes memory data = bytes.concat(stored.callbackSelector, args);
            address target = stored.callbackTarget;
            if (target.code.length > 0) {
                assembly ("memory-safe") {
                    delivered := call(stipend, target, 0, add(data, 0x20), mload(data), 0, 0)
                }
            }
        }
        emit Completed(requestId, status, resultHash, uri, delivered);
    }
}
