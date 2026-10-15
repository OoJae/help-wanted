// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title SpecText: the character rules of a job spec
/// @notice A spec is the job text a runner sends to the swarm after the order header. The desk
/// accepts only text whose JSON-escaped form is the text itself, because the work record stores
/// the objective JSON-escaped and the desk compares hashes of raw bytes. A spec that passes here
/// can always be matched against a record; one that fails could never be settled.
///
/// @dev The rules: 1 to 7,900 bytes; every byte printable ASCII (0x20 to 0x7E); no `"` (0x22) and
/// no `\` (0x5C); the first and the last byte are not a space, so nothing that trims text on the way
/// to the swarm can change it.
library SpecText {
    uint256 internal constant MAX_LENGTH = 7900;

    /// @dev What `firstBad` returns for a spec that breaks no rule.
    uint256 internal constant NONE = type(uint256).max;

    /// @notice Finds the first byte that breaks a rule.
    /// @return at `NONE` when the spec is acceptable. Otherwise: 0 for an empty spec; `MAX_LENGTH`
    /// (the index of the first byte over the limit) for one that is too long; else the lowest index
    /// of a byte that is not allowed where it stands.
    function firstBad(bytes calldata spec) internal pure returns (uint256 at) {
        uint256 len = spec.length;
        if (len == 0) return 0;
        if (len > MAX_LENGTH) return MAX_LENGTH;
        if (spec[0] == 0x20) return 0;

        at = NONE;
        assembly ("memory-safe") {
            let ones := 0x0101010101010101010101010101010101010101010101010101010101010101
            let highs := 0x8080808080808080808080808080808080808080808080808080808080808080
            let start := spec.offset
            for { let i := 0 } lt(i, len) { i := add(i, 0x20) } {
                let w := calldataload(add(start, i))
                let left := sub(len, i)
                if lt(left, 0x20) {
                    // The word runs past the end of the spec: read those bytes as "a".
                    let pad := shr(shl(3, left), not(0))
                    w := or(and(w, not(pad)), and(mul(ones, 0x61), pad))
                }
                // A set high bit in `bad` means: some byte of the word is over 0x7F, is under 0x20,
                // or equals 0x7F, 0x22 or 0x5C. The word-wide tests can only say "somewhere in this
                // word", so the exact byte is then found one at a time.
                let bad := and(w, highs)
                bad := or(bad, and(and(sub(w, mul(ones, 0x20)), not(w)), highs))
                let x := xor(w, mul(ones, 0x7f))
                bad := or(bad, and(and(sub(x, ones), not(x)), highs))
                x := xor(w, mul(ones, 0x22))
                bad := or(bad, and(and(sub(x, ones), not(x)), highs))
                x := xor(w, mul(ones, 0x5c))
                bad := or(bad, and(and(sub(x, ones), not(x)), highs))
                if bad {
                    for { let j := 0 } lt(j, 0x20) { j := add(j, 1) } {
                        let c := byte(j, w)
                        if or(or(lt(c, 0x20), gt(c, 0x7e)), or(eq(c, 0x22), eq(c, 0x5c))) {
                            at := add(i, j)
                            break
                        }
                    }
                    if iszero(eq(at, not(0))) { break }
                }
            }
        }
        if (at == NONE && spec[len - 1] == 0x20) return len - 1;
    }
}
