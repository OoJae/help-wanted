// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Rules} from "../../src/rules/Rules.sol";
import {LaunchManifest} from "./LaunchManifest.sol";

/// @title The launch document, as the tests read it
/// @notice `docs/LAUNCH.md` carries the manifest this launch expects, as a JSON block a person reads
/// and the launch pipeline's manifest step can copy. `LaunchManifest.sol` is the same manifest as
/// code. This contract reads the document so that the tests can hold the two against each other
/// and deploy from what the document says: a block edited by hand without the matching change in
/// the code, or the other way round, fails `forge test`.
///
/// @dev Three of the manifest's addresses are contracts of HELP WANTED's two earlier launches:
/// `Questions` (launch A, IdentityMD launch 1531), `WorkOrders` and `CrowdPots` (launch B, launch
/// 1573). Until those launches had happened the document carried a marker in each place; since 13
/// October 2026 it carries their live addresses, and a marker left anywhere in the manifest now
/// fails every test that reads it.
abstract contract LaunchDoc is Test {
    string internal constant LAUNCH_DOC = "docs/LAUNCH.md";
    string internal constant README = "README.md";

    /// @dev What the manifest carried, before launches A and B, where their three addresses now
    /// stand. Text containing it is refused as a manifest argument.
    string internal constant MARKER = "FILL_IN";

    uint256 internal constant NOT_FOUND = type(uint256).max;

    struct Entry {
        string name;
        string[] args;
    }

    // ---- the document -------------------------------------------------------------------------

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

    function _same(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _isMarker(string memory arg) internal pure returns (bool) {
        return vm.contains(arg, MARKER);
    }

    /// @dev One manifest argument as an address: a hex or decimal static word. A marker left from
    /// before the earlier launches is refused.
    function _addressOf(string memory arg) internal pure returns (address) {
        require(!_isMarker(arg), string.concat("docs/LAUNCH.md: a marker is left in the manifest: ", arg));
        uint256 word = vm.parseUint(arg);
        require(word <= type(uint160).max, string.concat("docs/LAUNCH.md: not an address: ", arg));
        return address(uint160(word));
    }

    /// @dev The six literals of the manifest, read from the document's own entries by position:
    /// `Rules(imd, workOrders)`, `Endowments(imd, simd, questions, crowdPots)`,
    /// `Zap(imd, poolManager, crowdPots, questions)`. `test_manifest_*` checks that the positions
    /// that must agree do.
    function _literals() internal view returns (LaunchManifest.Literals memory v) {
        (, Entry[] memory entries) = _manifest();
        require(entries.length == LaunchManifest.CONTRACTS, "docs/LAUNCH.md: the manifest names three contracts");
        require(entries[0].args.length == 2 && entries[1].args.length == 4 && entries[2].args.length == 4, "arity");
        v.imd = _addressOf(entries[0].args[0]);
        v.workOrders = _addressOf(entries[0].args[1]);
        v.simd = _addressOf(entries[1].args[1]);
        v.questions = _addressOf(entries[1].args[2]);
        v.crowdPots = _addressOf(entries[1].args[3]);
        v.poolManager = _addressOf(entries[2].args[1]);
    }

    /// @dev True when no marker is left anywhere in the manifest block.
    function _manifestIsComplete() internal view returns (bool) {
        return !vm.contains(_block(_doc(), "manifest", "json"), MARKER);
    }

    // ---- the first day, as the document writes it ------------------------------------------------

    /// @dev The figures of the first day's ledger (`<!-- firstDay:ledger -->`), in IMD wei.
    struct Ledger {
        uint256 endowmentDeposit;
        uint256 endowmentSeed;
        uint256 ruleDeposit;
        uint256 ruleTip;
        uint256 price;
        uint256 change;
        uint256 deskFee;
        uint256 agentsTip;
        uint256 runnerPay;
        uint256 runnerBond;
        uint256 swarmFee;
        uint256 peakOutlay;
        uint256 comesBack;
        uint256 spentForGood;
        uint256 spentForGoodWithoutTheHire;
    }

    function _ledger(string memory doc) internal pure returns (Ledger memory l) {
        string memory json = _block(doc, "firstDay:ledger", "json");
        l.endowmentDeposit = vm.parseUint(vm.parseJsonString(json, ".endowmentDeposit"));
        l.endowmentSeed = vm.parseUint(vm.parseJsonString(json, ".endowmentSeed"));
        l.ruleDeposit = vm.parseUint(vm.parseJsonString(json, ".ruleDeposit"));
        l.ruleTip = vm.parseUint(vm.parseJsonString(json, ".ruleTip"));
        l.price = vm.parseUint(vm.parseJsonString(json, ".price"));
        l.change = vm.parseUint(vm.parseJsonString(json, ".change"));
        l.deskFee = vm.parseUint(vm.parseJsonString(json, ".deskFee"));
        l.agentsTip = vm.parseUint(vm.parseJsonString(json, ".agentsTip"));
        l.runnerPay = vm.parseUint(vm.parseJsonString(json, ".runnerPay"));
        l.runnerBond = vm.parseUint(vm.parseJsonString(json, ".runnerBond"));
        l.swarmFee = vm.parseUint(vm.parseJsonString(json, ".swarmFee"));
        l.peakOutlay = vm.parseUint(vm.parseJsonString(json, ".peakOutlay"));
        l.comesBack = vm.parseUint(vm.parseJsonString(json, ".comesBack"));
        l.spentForGood = vm.parseUint(vm.parseJsonString(json, ".spentForGood"));
        l.spentForGoodWithoutTheHire = vm.parseUint(vm.parseJsonString(json, ".spentForGoodWithoutTheHire"));
    }

    /// @dev The rule's parameters, as the JSON block of the document gives them.
    function _documentedRule(string memory json) internal pure returns (Rules.RuleParams memory p) {
        p.when.kind = uint8(vm.parseJsonUint(json, ".when.kind"));
        p.when.cmp = uint8(vm.parseJsonUint(json, ".when.cmp"));
        p.when.maxAge = uint32(vm.parseJsonUint(json, ".when.maxAge"));
        p.when.target = vm.parseJsonAddress(json, ".when.target");
        p.when.threshold = vm.parseUint(vm.parseJsonString(json, ".when.threshold"));
        p.when.feedId = vm.parseJsonBytes32(json, ".when.feedId");
        p.when.data = vm.parseJsonBytes(json, ".when.data");
        p.action = uint8(vm.parseJsonUint(json, ".action"));
        p.hire.kindHash = keccak256(bytes(vm.parseJsonString(json, ".hire.kind")));
        p.hire.minPay = uint96(vm.parseUint(vm.parseJsonString(json, ".hire.minPay")));
        p.hire.maxPay = uint96(vm.parseUint(vm.parseJsonString(json, ".hire.maxPay")));
        p.hire.rampSecs = uint32(vm.parseJsonUint(json, ".hire.rampSecs"));
        p.hire.deliverySecs = uint32(vm.parseJsonUint(json, ".hire.deliverySecs"));
        p.hire.bond = uint96(vm.parseUint(vm.parseJsonString(json, ".hire.bond")));
        p.hire.runnerOnly = vm.parseJsonAddress(json, ".hire.runnerOnly");
        p.hire.arbiter = vm.parseJsonAddress(json, ".hire.arbiter");
        p.hire.flags = uint8(vm.parseJsonUint(json, ".hire.flags"));
        p.hire.orderTtl = uint32(vm.parseJsonUint(json, ".hire.orderTtl"));
        p.pay.recipient = vm.parseJsonAddress(json, ".pay.recipient");
        p.pay.amount = uint96(vm.parseUint(vm.parseJsonString(json, ".pay.amount")));
        p.tip = uint96(vm.parseUint(vm.parseJsonString(json, ".tip")));
        p.cooldown = uint32(vm.parseJsonUint(json, ".cooldown"));
        p.maxFires = uint32(vm.parseJsonUint(json, ".maxFires"));
    }

    // ---- ABIs, as the compiler wrote them -------------------------------------------------------

    function _artifact(string memory file, string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat("out/", file, ".sol/", name, ".json"));
    }

    /// @dev Every function of a contract or interface, inherited ones included, as selectors.
    function _selectors(string memory file, string memory name) internal view returns (bytes4[] memory selectors) {
        string[] memory signatures = vm.parseJsonKeys(_artifact(file, name), ".methodIdentifiers");
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

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (string memory) {
        bytes memory out = new bytes(to - from);
        for (uint256 i = from; i < to; ++i) {
            out[i - from] = b[i];
        }
        return string(out);
    }
}
