// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OrderHeader} from "../../src/desk/OrderHeader.sol";
import {DeskBase} from "./DeskBase.sol";

contract OrderHeaderHarness {
    function ticket(uint256 chainId, address desk, uint256 orderId, uint256 claimSeq, address runner)
        external
        pure
        returns (bytes32)
    {
        return OrderHeader.ticket(chainId, desk, orderId, claimSeq, runner);
    }

    function build(bytes32 ticket_) external pure returns (bytes memory) {
        return OrderHeader.build(ticket_);
    }

    function hash(bytes32 ticket_) external pure returns (bytes32) {
        return OrderHeader.hash(ticket_);
    }

    /// @dev Builds a header after dirtying memory, to show the result does not depend on what was there.
    function buildOnDirtyMemory(bytes32 ticket_) external pure returns (bytes memory) {
        bytes memory junk = new bytes(300);
        for (uint256 i; i < junk.length; ++i) {
            junk[i] = 0xff;
        }
        assembly {
            // Leave the free memory pointer where it is but fill what lies beyond it.
            let free := mload(0x40)
            for { let i := 0 } lt(i, 0x100) { i := add(i, 0x20) } { mstore(add(free, i), not(0)) }
        }
        return OrderHeader.build(ticket_);
    }
}

contract OrderHeaderTest is DeskBase {
    OrderHeaderHarness internal h;
    string internal vectors;

    function setUp() public override {
        super.setUp();
        h = new OrderHeaderHarness();
        vectors = vm.readFile("test/fixtures/desk/header-vectors.json");
    }

    /// The fixture was produced with `cast`, not with this library; the TypeScript side is tested
    /// against the same file.
    function test_matchesEveryFixtureVector() public view {
        assertEq(vm.parseJsonUint(vectors, ".headerLength"), OrderHeader.LENGTH);
        uint256 n;
        while (vm.keyExistsJson(vectors, string.concat(".vectors[", vm.toString(n), "]"))) ++n;
        assertEq(n, 7, "vector count");
        for (uint256 i; i < n; ++i) {
            _checkVector(string.concat(".vectors[", vm.toString(i), "]"));
        }
    }

    function _checkVector(string memory at) internal view {
        bytes32 ticket = vm.parseJsonBytes32(vectors, string.concat(at, ".ticket"));
        {
            uint256 chainId = vm.parseJsonUint(vectors, string.concat(at, ".chainId"));
            address desk_ = vm.parseJsonAddress(vectors, string.concat(at, ".desk"));
            uint256 orderId = vm.parseJsonUint(vectors, string.concat(at, ".orderId"));
            uint256 claimSeq = vm.parseJsonUint(vectors, string.concat(at, ".claimSeq"));
            address runner_ = vm.parseJsonAddress(vectors, string.concat(at, ".runner"));
            bytes memory preimage = abi.encode(chainId, desk_, orderId, claimSeq, runner_);
            assertEq(preimage, vm.parseJsonBytes(vectors, string.concat(at, ".preimage")), "preimage");
            assertEq(h.ticket(chainId, desk_, orderId, claimSeq, runner_), ticket, "ticket");
        }
        bytes memory built = h.build(ticket);
        assertEq(built.length, 85, "length");
        assertEq(built, vm.parseJsonBytes(vectors, string.concat(at, ".headerHex")), "header bytes");
        assertEq(string(built), vm.parseJsonString(vectors, string.concat(at, ".header")), "header text");
        assertEq(h.hash(ticket), vm.parseJsonBytes32(vectors, string.concat(at, ".headerHash")), "header hash");
    }

    function test_fixtureObjectiveIsHeaderThenSpec() public view {
        bytes memory spec = bytes(vm.parseJsonString(vectors, ".objectiveExample.spec"));
        bytes memory objective = vm.parseJsonBytes(vectors, ".objectiveExample.objectiveHex");
        bytes32 ticket = vm.parseJsonBytes32(vectors, ".vectors[0].ticket");
        assertEq(bytes.concat(h.build(ticket), spec), objective);
        assertEq(string(objective), vm.parseJsonString(vectors, ".objectiveExample.objective"));
        assertEq(keccak256(spec), vm.parseJsonBytes32(vectors, ".objectiveExample.specHash"));
        assertEq(keccak256(objective), vm.parseJsonBytes32(vectors, ".objectiveExample.objectiveHash"));
    }

    /// The example spec is one the desk accepts, and it ends with the Inputs clause in the agreed
    /// form: `Inputs: key=value; key=value`.
    function test_fixtureSpecIsAcceptedAndCarriesTheInputsClause() public {
        bytes memory spec = bytes(vm.parseJsonString(vectors, ".objectiveExample.spec"));
        vm.prank(employer);
        uint256 id = desk.createOrder(_params(), spec);
        assertEq(desk.orderOf(id).specHash, vm.parseJsonBytes32(vectors, ".objectiveExample.specHash"));

        bytes memory marker = "Inputs: ";
        uint256 at = type(uint256).max;
        for (uint256 i; i + marker.length <= spec.length; ++i) {
            bool here = true;
            for (uint256 k; k < marker.length; ++k) {
                if (spec[i + k] != marker[k]) {
                    here = false;
                    break;
                }
            }
            if (here) at = i + marker.length;
        }
        assertTrue(at != type(uint256).max, "no Inputs clause");
        // Walk the pairs: key of letters and digits, "=", a value with no semicolon, then "; " or the end.
        uint256 pairs;
        uint256 pos = at;
        while (pos < spec.length) {
            uint256 keyStart = pos;
            while (pos < spec.length && _isAlphaNumeric(spec[pos])) ++pos;
            assertGt(pos, keyStart, "empty key");
            assertTrue(pos < spec.length && spec[pos] == "=", "key not followed by =");
            ++pos;
            while (pos < spec.length && spec[pos] != ";") ++pos;
            ++pairs;
            if (pos == spec.length) break;
            assertTrue(pos + 1 < spec.length && spec[pos + 1] == " ", "pairs are separated by a semicolon and a space");
            pos += 2;
        }
        assertEq(pairs, 2);
    }

    function _isAlphaNumeric(bytes1 c) internal pure returns (bool) {
        return (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
    }

    function test_knownVectorWrittenOut() public view {
        bytes32 ticket =
            h.ticket(1, 0x5FbDB2315678afecb367f032d93F642f64180aa3, 1, 1, 0x70997970C51812dc3A010C7d01b50e0d17dc79C8);
        assertEq(ticket, 0x87a4ceb3cc6bf9ee0fce139b3944d337fe5374fe0f4ce715e185f310cea89571);
        assertEq(
            string(h.build(ticket)),
            "[help-wanted order 87a4ceb3cc6bf9ee0fce139b3944d337fe5374fe0f4ce715e185f310cea89571] "
        );
    }

    function test_shape() public view {
        bytes memory b = h.build(bytes32(uint256(0xabcdef)));
        assertEq(b.length, 85);
        assertEq(uint8(b[0]), 0x5b); // [
        assertEq(uint8(b[18]), 0x20); // the space before the hex
        assertEq(uint8(b[83]), 0x5d); // ]
        assertEq(uint8(b[84]), 0x20); // the space before the spec
    }

    function test_allZeroAndAllOnesTickets() public view {
        assertEq(
            string(h.build(bytes32(0))),
            "[help-wanted order 0000000000000000000000000000000000000000000000000000000000000000] "
        );
        assertEq(
            string(h.build(bytes32(type(uint256).max))),
            "[help-wanted order ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff] "
        );
    }

    function testFuzz_buildMatchesReference(bytes32 ticket) public view {
        bytes memory built = h.build(ticket);
        assertEq(built, _refHeaderOf(ticket));
        assertEq(h.hash(ticket), keccak256(_refHeaderOf(ticket)));
        assertEq(h.buildOnDirtyMemory(ticket), built);
    }

    function testFuzz_hexIsLowercaseAndReadsBackToTheTicket(bytes32 ticket) public view {
        bytes memory built = h.build(ticket);
        uint256 back;
        for (uint256 i = 19; i < 83; ++i) {
            uint8 c = uint8(built[i]);
            bool digit = c >= 0x30 && c <= 0x39;
            bool lower = c >= 0x61 && c <= 0x66;
            assertTrue(digit || lower, "not a lowercase hex character");
            back = back * 16 + (digit ? c - 0x30 : c - 0x61 + 10);
        }
        assertEq(bytes32(back), ticket);
    }

    function testFuzz_ticketMatchesReference(uint256 chainId, address desk_, uint256 orderId, uint256 seq, address who)
        public
        view
    {
        assertEq(h.ticket(chainId, desk_, orderId, seq, who), keccak256(abi.encode(chainId, desk_, orderId, seq, who)));
    }

    /// Changing any one of the five inputs changes the ticket: that is what stops a record written
    /// for one claim from paying another.
    function testFuzz_everyInputChangesTheTicket(uint256[5] memory input, uint8 which) public view {
        input[0] = uint64(input[0]);
        input[2] = uint64(input[2]);
        input[3] = uint32(input[3]);
        bytes32 base = _ticketOf(input);
        which = which % 5;
        if (which == 1 || which == 4) input[which] = uint256(uint160(input[which]) ^ 1);
        else input[which] += 1;
        assertTrue(base != _ticketOf(input));
    }

    function _ticketOf(uint256[5] memory input) internal view returns (bytes32) {
        return h.ticket(input[0], address(uint160(input[1])), input[2], input[3], address(uint160(input[4])));
    }

    /// The desk's own views agree with the reference for a live claim.
    function test_deskHeaderOfMatchesReference() public {
        uint256 id = _open();
        bytes32 ticket = _claim(id, runner);
        assertEq(ticket, keccak256(abi.encode(block.chainid, address(desk), id, uint256(1), runner)));
        assertEq(desk.ticketOf(id), ticket);
        assertEq(desk.headerOf(id), _refHeader(block.chainid, address(desk), id, 1, runner));
        assertEq(desk.HEADER_LEN(), 85);
    }
}
