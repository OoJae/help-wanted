// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {JobsReport} from "../../src/payroll/JobsReport.sol";
import {Payroll} from "../../src/payroll/Payroll.sol";

/// @title What the launch tests share
/// @notice Three things, each read from a file a person also reads, so that the tests and the
/// documents cannot drift apart:
///
/// - the three house feeds, from `test/fixtures/questions/feeds/*.json`;
/// - the manifest this launch expects, from the JSON block in `docs/LAUNCH.md`;
/// - the runbook's calldata, from the marked blocks in `docs/LAUNCH.md`.
///
/// and one thing computed here: the constructor arguments as the code and the fixtures give them,
/// independently of the document. The tests compare the two.
abstract contract LaunchKit is Test {
    string internal constant FEEDS_DIR = "test/fixtures/questions/feeds/";
    string internal constant LAUNCH_DOC = "docs/LAUNCH.md";

    /// @dev Our own gates, below the protocol's limits of 24,576 and 49,152 bytes and 16.7M gas.
    uint256 internal constant RUNTIME_GATE = 23_000;
    uint256 internal constant INITCODE_GATE = 46_000;
    uint256 internal constant LAUNCH_GAS_GATE = 12_000_000;
    /// @dev What one byte of initcode costs a launch, all in: measured on launch 1240 (9,596,612 gas
    /// for 39,910 bytes).
    uint256 internal constant GAS_PER_INITCODE_BYTE = 240;

    struct HouseFeed {
        string name;
        Questions.FeedParams params;
        bytes qPrefix;
        bytes tail;
        /// The id written in the fixture file.
        bytes32 feedId;
    }

    struct Entry {
        string name;
        string[] args;
    }

    // ---- the house feeds ------------------------------------------------------------------------

    function _feedNames() internal pure returns (string[3] memory) {
        return ["payrolls", "hires", "employers"];
    }

    function _houseFeed(string memory name) internal view returns (HouseFeed memory h) {
        string memory j = vm.readFile(string.concat(FEEDS_DIR, name, ".json"));
        h.name = name;
        Questions.FeedParams memory p;
        p.action = vm.parseJsonBytes32(j, ".params.action");
        p.chainId = uint64(vm.parseJsonUint(j, ".params.chainId"));
        p.answerType = uint8(vm.parseJsonUint(j, ".params.answerType"));
        p.panelSize = uint16(vm.parseJsonUint(j, ".params.panelSize"));
        p.quorum = uint16(vm.parseJsonUint(j, ".params.quorum"));
        p.minAgreed = uint16(vm.parseJsonUint(j, ".params.minAgreed"));
        p.validFor = uint32(vm.parseJsonUint(j, ".params.validFor"));
        p.cadenceBlocks = uint32(vm.parseJsonUint(j, ".params.cadenceBlocks"));
        p.maxWindowBlocks = uint32(vm.parseJsonUint(j, ".params.maxWindowBlocks"));
        p.lagBlocks = uint16(vm.parseJsonUint(j, ".params.lagBlocks"));
        p.contiguous = vm.parseJsonBool(j, ".params.contiguous");
        p.pinHash = vm.parseJsonBool(j, ".params.pinHash");
        p.maxPrice = uint96(vm.parseJsonUint(j, ".params.maxPrice"));
        p.tip = uint96(vm.parseJsonUint(j, ".params.tip"));
        p.gateCmp = uint8(vm.parseJsonUint(j, ".params.gateCmp"));
        p.gateTarget = vm.parseJsonAddress(j, ".params.gateTarget");
        p.gateThreshold = vm.parseJsonUint(j, ".params.gateThreshold");
        p.gateData = vm.parseJsonBytes(j, ".params.gateData");
        h.params = p;
        h.qPrefix = vm.parseJsonBytes(j, ".qPrefixHex");
        h.tail = vm.parseJsonBytes(j, ".tailHex");
        h.feedId = vm.parseJsonBytes32(j, ".feedId");
    }

    /// @dev A feed's id by the rule the contract uses, computed here from the fixture's parts and
    /// from nothing else: not from the id the fixture states, and not from the document.
    function _recomputedId(HouseFeed memory h) internal pure returns (bytes32) {
        return keccak256(abi.encode(h.params, keccak256(h.qPrefix), keccak256(h.tail)));
    }

    function _recomputedIds() internal view returns (bytes32[3] memory ids) {
        string[3] memory names = _feedNames();
        for (uint256 i; i < 3; ++i) {
            ids[i] = _recomputedId(_houseFeed(names[i]));
        }
    }

    // ---- the document ---------------------------------------------------------------------------

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
        uint256 n = vm.parseJsonKeys(json, ".contracts[0]").length == 0 ? 0 : _countContracts(json);
        entries = new Entry[](n);
        for (uint256 i; i < n; ++i) {
            string memory at = string.concat(".contracts[", vm.toString(i), "]");
            entries[i].name = vm.parseJsonString(json, string.concat(at, ".contract"));
            entries[i].args = vm.parseJsonStringArray(json, string.concat(at, ".constructorArgs"));
        }
    }

    function _countContracts(string memory json) private view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".contracts[", vm.toString(n), "]"))) {
            ++n;
        }
    }

    // ---- the arguments as the code gives them ------------------------------------------------------

    /// @dev The constructor arguments of the three contracts, in manifest order, as ABI words. The
    /// values come from `Mainnet.sol` and from the feed ids recomputed out of the fixtures;
    /// `questions` is the address the first contract was given.
    function _expectedWords(uint256 index, address questions) internal view returns (bytes32[] memory w) {
        bytes32[3] memory ids = _recomputedIds();
        if (index == 0) {
            w = new bytes32[](3);
            w[0] = _word(Mainnet.INTAKE);
            w[1] = _word(Mainnet.IMD);
            w[2] = _word(Mainnet.ORACLE_SIGNER);
        } else if (index == 1) {
            w = new bytes32[](4);
            w[0] = _word(questions);
            (w[1], w[2], w[3]) = (ids[0], ids[1], ids[2]);
        } else {
            w = new bytes32[](9);
            w[0] = _word(Mainnet.IMD);
            w[1] = _word(Mainnet.SIMD);
            w[2] = _word(Mainnet.SEATS);
            w[3] = bytes32(Mainnet.SEAT_COUNT);
            w[4] = _word(Mainnet.SEAT_ADAPTER);
            w[5] = _word(questions);
            (w[6], w[7], w[8]) = (ids[0], ids[1], ids[2]);
        }
    }

    function _word(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _creationCode(uint256 index) internal pure returns (bytes memory) {
        if (index == 0) return type(Questions).creationCode;
        if (index == 1) return type(JobsReport).creationCode;
        return type(Payroll).creationCode;
    }

    function _contractName(uint256 index) internal pure returns (string memory) {
        return ["Questions", "JobsReport", "Payroll"][index];
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
}
