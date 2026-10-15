// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {Doorbell} from "../../src/pots/Doorbell.sol";
import {LaunchValues} from "../kit/LaunchValues.sol";

/// @title What the launch tests share
/// @notice Two things, each read from a file a person also reads, so that the tests and the
/// documents cannot drift apart:
///
/// - the manifest this launch expects, from the JSON block in `docs/LAUNCH.md`;
/// - the marked blocks of `docs/LAUNCH.md` and the shell commands of both documents.
///
/// and one thing computed here: the constructor arguments as the code gives them (`Mainnet.sol`
/// for the addresses, `LaunchValues` for the Doorbell's values), independently of the document.
/// The tests compare the two.
///
/// Every argument is known. The last to become so was the address of `Payroll`, which HELP
/// WANTED's first launch created on 13 October 2026; it stands in the manifest as a literal and in
/// `Mainnet.sol` as `PAYROLL`.
abstract contract LaunchKit is Test {
    string internal constant LAUNCH_DOC = "docs/LAUNCH.md";
    string internal constant README = "README.md";

    /// @dev Our own gates, below the protocol's limits of 24,576 and 49,152 bytes and 16.7M gas.
    uint256 internal constant RUNTIME_GATE = 23_000;
    uint256 internal constant INITCODE_GATE = 46_000;
    uint256 internal constant LAUNCH_GAS_GATE = 12_000_000;
    /// @dev What one byte of initcode costs a launch, all in: measured on launch 1240 (9,596,612 gas
    /// for 39,910 bytes).
    uint256 internal constant GAS_PER_INITCODE_BYTE = 240;

    uint256 internal constant CONTRACTS = 4;

    struct Entry {
        string name;
        string[] args;
    }

    // ---- the documents --------------------------------------------------------------------------

    function _doc() internal view returns (string memory) {
        return vm.readFile(LAUNCH_DOC);
    }

    /// @dev The text of the fenced block that follows the marker `<!-- name -->` in the document.
    function _block(string memory doc, string memory name, string memory fence) internal pure returns (string memory) {
        string memory opening = string.concat("<!-- ", name, " -->\n```", fence, "\n");
        string[] memory head = vm.split(doc, opening);
        require(head.length == 2, string.concat("docs/LAUNCH.md: expected exactly one block marked ", name));
        string[] memory rest = vm.split(head[1], "\n```");
        return rest[0];
    }

    /// @dev The manifest the document says the launch will have, entry by entry.
    function _manifest() internal view returns (string memory kind, Entry[] memory entries) {
        string memory json = _block(_doc(), "manifest", "json");
        kind = vm.parseJsonString(json, ".kind");
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".contracts[", vm.toString(n), "]"))) {
            ++n;
        }
        entries = new Entry[](n);
        for (uint256 i; i < n; ++i) {
            string memory at = string.concat(".contracts[", vm.toString(i), "]");
            entries[i].name = vm.parseJsonString(json, string.concat(at, ".contract"));
            entries[i].args = vm.parseJsonStringArray(json, string.concat(at, ".constructorArgs"));
        }
    }

    /// @dev The address the manifest gives the desk for Payroll: the third argument of `WorkOrders`.
    function _payrollOfTheManifest() internal view returns (address) {
        (, Entry[] memory entries) = _manifest();
        uint256 word = vm.parseUint(entries[1].args[2]);
        require(word != 0 && word <= type(uint160).max, "docs/LAUNCH.md: Payroll's argument is not an address");
        return address(uint160(word));
    }

    /// @dev The first crowd pot the runbook proposes: its terms and its spec, read from the two
    /// marked blocks of the document.
    function _firstPot() internal view returns (CrowdPots.Terms memory t, bytes memory spec) {
        string memory doc = _doc();
        string memory terms = _block(doc, "firstPot:terms", "json");
        spec = bytes(_block(doc, "firstPot:spec", "text"));
        t = CrowdPots.Terms({
            kind: vm.parseJsonString(terms, ".kind"),
            target: uint96(vm.parseUint(vm.parseJsonString(terms, ".target"))),
            minPay: uint96(vm.parseUint(vm.parseJsonString(terms, ".minPay"))),
            rampSecs: uint32(vm.parseJsonUint(terms, ".rampSecs")),
            bond: uint96(vm.parseUint(vm.parseJsonString(terms, ".bond"))),
            deliverySecs: uint32(vm.parseJsonUint(terms, ".deliverySecs")),
            hireSecs: uint32(vm.parseJsonUint(terms, ".hireSecs")),
            fundSecs: uint32(vm.parseJsonUint(terms, ".fundSecs")),
            allowClaimed: vm.parseJsonBool(terms, ".allowClaimed")
        });
    }

    function _same(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /// @dev One manifest entry's arguments as ABI words. A manifest argument is a decimal or hex
    /// static word, or a reference to a contract earlier in the list. `known[e]` is the address of
    /// entry `e`.
    function _wordsOf(Entry[] memory entries, uint256 index, address[] memory known)
        internal
        pure
        returns (bytes32[] memory words)
    {
        string[] memory args = entries[index].args;
        words = new bytes32[](args.length);
        for (uint256 a; a < args.length; ++a) {
            string[] memory ref = vm.split(args[a], "$contract:");
            if (ref.length == 2) {
                bool found;
                for (uint256 e; e < index; ++e) {
                    if (_same(entries[e].name, ref[1])) {
                        words[a] = _word(known[e]);
                        found = true;
                    }
                }
                require(found, string.concat("a reference that does not point backward: ", args[a]));
            } else {
                words[a] = bytes32(vm.parseUint(args[a]));
            }
        }
    }

    /// @dev Creates the four contracts from the document's manifest, in its order, resolving
    /// `$contract:Name` to the address an earlier entry was created at, as the launch does.
    /// Returns what each creation used and the length of each initcode with its arguments.
    function _createFromManifest()
        internal
        returns (address[] memory created, uint256[] memory gasUsed, uint256[] memory initcodeLength)
    {
        (, Entry[] memory entries) = _manifest();
        require(entries.length == CONTRACTS, "the manifest names four contracts");
        created = new address[](CONTRACTS);
        gasUsed = new uint256[](CONTRACTS);
        initcodeLength = new uint256[](CONTRACTS);
        for (uint256 i; i < CONTRACTS; ++i) {
            bytes memory init = _initcode(i, _wordsOf(entries, i, created));
            initcodeLength[i] = init.length;
            address made;
            uint256 gasBefore = gasleft();
            assembly ("memory-safe") {
                made := create(0, add(init, 0x20), mload(init))
            }
            gasUsed[i] = gasBefore - gasleft();
            require(made != address(0), string.concat(entries[i].name, " did not deploy"));
            created[i] = made;
        }
    }

    // ---- the arguments as the code gives them ------------------------------------------------------

    /// @dev The constructor arguments of the four contracts, in manifest order, as ABI words.
    /// `known[e]` is the address contract `e` was created at.
    function _expectedWords(uint256 index, address[] memory known) internal pure returns (bytes32[] memory w) {
        if (index == 0) {
            w = new bytes32[](1);
            w[0] = _word(Mainnet.WORK_REGISTRY);
        } else if (index == 1) {
            w = new bytes32[](3);
            w[0] = _word(Mainnet.IMD);
            w[1] = _word(known[0]);
            w[2] = _word(Mainnet.PAYROLL);
        } else if (index == 2) {
            w = new bytes32[](2);
            w[0] = _word(Mainnet.IMD);
            w[1] = _word(known[1]);
        } else {
            w = new bytes32[](8);
            w[0] = _word(Mainnet.IMD);
            w[1] = _word(known[1]);
            w[2] = LaunchValues.BELL_KIND_HASH;
            w[3] = bytes32(uint256(LaunchValues.BELL_MIN_PAY));
            w[4] = bytes32(uint256(LaunchValues.BELL_MAX_PAY));
            w[5] = bytes32(uint256(LaunchValues.BELL_BOND));
            w[6] = bytes32(uint256(LaunchValues.BELL_DELIVERY_SECS));
            w[7] = bytes32(uint256(LaunchValues.BELL_ALLOW_CLAIMED ? 1 : 0));
        }
    }

    function _word(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _creationCode(uint256 index) internal pure returns (bytes memory) {
        if (index == 0) return type(WorkProof).creationCode;
        if (index == 1) return type(WorkOrders).creationCode;
        if (index == 2) return type(CrowdPots).creationCode;
        return type(Doorbell).creationCode;
    }

    function _contractName(uint256 index) internal pure returns (string memory) {
        return ["WorkProof", "WorkOrders", "CrowdPots", "Doorbell"][index];
    }

    /// @dev Creation code followed by its constructor arguments: what the factory is handed.
    function _initcode(uint256 index, bytes32[] memory words) internal pure returns (bytes memory) {
        return bytes.concat(_creationCode(index), abi.encodePacked(words));
    }

    // ---- bytecode -------------------------------------------------------------------------------

    /// @dev Walks bytecode one instruction at a time, stepping over the data of each PUSH, and
    /// returns the position of the first instruction that is one of `wanted`, or the code's length
    /// when there is none.
    function _firstOpcode(bytes memory code, bytes memory wanted) internal pure returns (uint256 at) {
        uint256 n = code.length;
        for (at = 0; at < n; ++at) {
            uint8 op = uint8(code[at]);
            if (op >= 0x60 && op <= 0x7f) {
                // PUSH1 to PUSH32 carry 1 to 32 bytes of data, which are not instructions.
                at += op - 0x5f;
                continue;
            }
            for (uint256 k; k < wanted.length; ++k) {
                if (op == uint8(wanted[k])) return at;
            }
        }
        return n;
    }

    /// @dev DELEGATECALL, CALLCODE and SELFDESTRUCT: what a launch forbids.
    function _forbidden() internal pure returns (bytes memory) {
        return hex"f4f2ff";
    }

    /// @dev True when `selector` is the data of some PUSH of one to four bytes in `code`: how a
    /// contract's dispatcher holds the selectors it answers. (A selector that begins with zero
    /// bytes is pushed with a shorter instruction, so the values are compared, not the bytes.)
    function _pushesSelector(bytes memory code, bytes4 selector) internal pure returns (bool) {
        uint256 want = uint32(selector);
        uint256 n = code.length;
        for (uint256 at; at < n; ++at) {
            uint8 op = uint8(code[at]);
            if (op < 0x60 || op > 0x7f) continue;
            uint256 width = op - 0x5f;
            if (width <= 4 && at + width < n) {
                uint256 value;
                for (uint256 b = 1; b <= width; ++b) {
                    value = (value << 8) | uint8(code[at + b]);
                }
                if (value == want) return true;
            }
            at += width;
        }
        return false;
    }

    // ---- ABIs, as the compiler wrote them -----------------------------------------------------------

    function _artifact(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat("out/", name, ".sol/", name, ".json"));
    }

    /// @dev Every function of a contract or interface, inherited ones included: its canonical
    /// signature as the compiler lists it, and the selector that signature hashes to.
    function _methods(string memory name)
        internal
        view
        returns (string[] memory signatures, bytes4[] memory selectors)
    {
        signatures = vm.parseJsonKeys(_artifact(name), ".methodIdentifiers");
        selectors = new bytes4[](signatures.length);
        for (uint256 i; i < signatures.length; ++i) {
            selectors[i] = bytes4(keccak256(bytes(signatures[i])));
        }
    }

    function _hasSelector(bytes4[] memory selectors, bytes4 selector) internal pure returns (bool) {
        for (uint256 i; i < selectors.length; ++i) {
            if (selectors[i] == selector) return true;
        }
        return false;
    }
}
