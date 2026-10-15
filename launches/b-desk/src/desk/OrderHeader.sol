// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title OrderHeader: the ticket and the 85 bytes a runner puts in front of the job text
/// @notice A swarm job counts for an order only when its objective starts with that order's header.
/// The header carries a ticket, and the ticket commits to the chain, the desk, the order, the claim
/// and the runner, so a work record written for one claim can never pay another one.
///
/// @dev The runner bot and the web app build the same bytes off chain; `test/fixtures/desk/header-vectors.json`
/// holds vectors both sides are tested against.
///
/// ticket    = keccak256(abi.encode(chainId, desk, orderId, claimSeq, runner))
/// header    = "[help-wanted order " ‖ 64 lowercase hex characters of the ticket ‖ "] "
/// objective = header ‖ spec
library OrderHeader {
    /// @dev 19 bytes of prefix, 64 of hex, 2 of suffix.
    uint256 internal constant LENGTH = 85;

    /// @notice The ticket of one claim.
    /// @param chainId The chain the desk lives on, so a record cannot be replayed on another chain.
    /// @param desk The WorkOrders contract, so it cannot be replayed on another desk.
    /// @param orderId The order.
    /// @param claimSeq How many times the order has been claimed, counting this claim, from 1.
    /// @param runner The address that holds the claim.
    function ticket(uint256 chainId, address desk, uint256 orderId, uint256 claimSeq, address runner)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainId, desk, orderId, claimSeq, runner));
    }

    /// @notice The 85 header bytes for a ticket.
    function build(bytes32 ticket_) internal pure returns (bytes memory out) {
        out = new bytes(LENGTH);
        assembly ("memory-safe") {
            // The 19 prefix bytes; the 13 zero bytes that follow are overwritten by the hex below.
            mstore(add(out, 0x20), "[help-wanted order ")
            let digits := "0123456789abcdef"
            let cursor := add(out, 51) // 0x20 + 19
            for { let i := 0 } lt(i, 32) { i := add(i, 1) } {
                let b := byte(i, ticket_)
                mstore8(cursor, byte(shr(4, b), digits))
                mstore8(add(cursor, 1), byte(and(b, 0x0f), digits))
                cursor := add(cursor, 2)
            }
            mstore8(cursor, 0x5d) // "]"
            mstore8(add(cursor, 1), 0x20) // " "
        }
    }

    /// @notice keccak256 of the header: what a proof's `headHash` must equal for this ticket.
    function hash(bytes32 ticket_) internal pure returns (bytes32) {
        return keccak256(build(ticket_));
    }
}
