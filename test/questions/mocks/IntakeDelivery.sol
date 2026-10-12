// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title A stand-in for the protocol's IntakeDelivery, for the conformance test only
/// @notice The protocol's conformance test hands the vector attestation to a consumer through
/// `IntakeDelivery.deliver`. The protocol's own contract is not part of this project, and Questions
/// is a same-chain consumer that never uses it. This stand-in has the same constructor and the same
/// `deliver` call, and makes the call the way the Intake and IntakeDelivery both do: once, with a
/// fixed 200,000 gas stipend, the outcome returned and never passed on. In the conformance test it
/// is the address Questions trusts as its Intake, so the test's body runs unchanged.
contract IntakeDelivery {
    error NotWriter();

    uint64 public constant CALLBACK_GAS = 200_000;
    address public immutable OWNER;
    address public immutable WRITER;

    constructor(address owner_, address writer_) {
        OWNER = owner_;
        WRITER = writer_;
    }

    function deliver(
        uint256, /* sourceChainId */
        address, /* sourceIntake */
        bytes32, /* sourceRequestId */
        address target,
        bytes4 selector,
        bytes calldata args
    )
        external
        returns (bool called)
    {
        if (msg.sender != WRITER) revert NotWriter();
        bytes memory data = bytes.concat(selector, args);
        if (target.code.length > 0) {
            assembly ("memory-safe") {
                called := call(200000, target, 0, add(data, 0x20), mload(data), 0, 0)
            }
        }
    }
}
