// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";

import {Endowments} from "../../src/endowments/Endowments.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {EarlierLaunches} from "../kit/EarlierLaunches.sol";
import {Rules} from "../../src/rules/Rules.sol";
import {Zap} from "../../src/rules/Zap.sol";
import {MockCrowdPots} from "../endowments/mocks/MockCrowdPots.sol";
import {MockQuestions} from "../endowments/mocks/MockQuestions.sol";
import {MockDesk} from "../rules/mocks/MockDesk.sol";
import {MockIMD} from "../rules/mocks/MockIMD.sol";
import {Bytecode} from "./Bytecode.sol";
import {LaunchBench, MiniFactory} from "./LaunchBench.sol";
import {LaunchManifest} from "./LaunchManifest.sol";

/// @dev A contract that does what a launch forbids, to show the bytecode walk below can find it.
contract UsesDelegatecall {
    function run(address target, bytes calldata data) external returns (bool ok) {
        (ok,) = target.delegatecall(data);
    }
}

/// @dev A contract whose only 0xf4, 0xf2 and 0xff bytes are the data of a PUSH: the walk must step
/// over them.
contract HoldsTheBytesAsData {
    function word() external pure returns (bytes32) {
        return 0xf4f2fff4f2fff4f2fff4f2fff4f2fff4f2fff4f2fff4f2fff4f2fff4f2fff4f2;
    }
}

/// @dev Launch C as the launch pipeline will deploy it: `Rules`, `Endowments`, `Zap`, in that order,
/// from the manifest written in `docs/LAUNCH.md`, on a chain where none of the addresses they are
/// given has any code yet. Checked here, offline:
///
/// - the manifest in the document and the manifest in `LaunchManifest.sol` are the same manifest;
/// - the three deploy, in order, with the manifest's arguments, and report those arguments back;
/// - every runtime and every initcode is under our own size gates, and the whole launch under our
///   gas gate;
/// - no constructor touches anything outside its own contract (no call, no code-size check, no
///   balance read), takes ETH, or accepts a missing address;
/// - no deployed runtime contains DELEGATECALL, CALLCODE or SELFDESTRUCT;
/// - the functions that can change state are exactly the ones `README.md` lists;
/// - once code exists behind the addresses, each contract works with them on first use.
///
/// The rehearsal through the real ProjectFactory is in `fork/LaunchC.fork.t.sol`.
contract LaunchCTest is LaunchBench {
    /// @dev The launch rules' limits, and the tighter gates this project holds itself to.
    uint256 internal constant RULE_RUNTIME = 24_576;
    uint256 internal constant RULE_INITCODE = 49_152;
    uint256 internal constant RULE_GAS = 16_700_000;
    uint256 internal constant GATE_RUNTIME = 23_000;
    uint256 internal constant GATE_INITCODE = 46_000;
    uint256 internal constant GATE_GAS = 12_000_000;
    /// @dev What a real contracts-only launch cost per byte of initcode (launch 1240: 9,596,612 gas for
    /// 39,910 bytes), rounded up.
    uint256 internal constant GAS_PER_INITCODE_BYTE = 241;
    uint256 internal constant NO_DEADLINE = type(uint256).max;

    function setUp() public {
        _setUpBench();
    }

    // ------------------------------------------------------------------------------------------
    // The manifest
    // ------------------------------------------------------------------------------------------

    /// @dev The manifest written in `docs/LAUNCH.md`: the launch kind, the three contracts in order
    /// with the number of arguments each constructor takes, no owner, no token, and no reference
    /// from one contract of this launch to another.
    function test_manifest_theDocumentNamesTheThreeContractsInOrder() public view {
        (string memory kind, Entry[] memory entries) = _manifest();
        assertEq(kind, "evm_contracts");
        assertEq(entries.length, LaunchManifest.CONTRACTS);
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            assertEq(entries[i].name, LaunchManifest.name(i));
            assertEq(entries[i].args.length, LaunchManifest.argumentCount(i), entries[i].name);
        }
        string memory json = _block(_doc(), "manifest", "json");
        assertFalse(vm.contains(json, "$owner"), "no contract of this launch has an owner");
        assertFalse(vm.contains(json, "$token"), "this launch has no token");
        assertFalse(vm.contains(json, "$contract:"), "no contract of this launch refers to another");
    }

    /// @dev Every argument in the document is the value the code gives (`Mainnet.sol`), and the same
    /// value wherever one contract is named twice. Built from the document, each contract's
    /// arguments are byte for byte the ones `LaunchManifest.sol` builds, so the offline launch and
    /// the fork rehearsal deploy what the document says.
    function test_manifest_everyArgumentInTheDocumentIsWhatTheCodeExpects() public view {
        (, Entry[] memory entries) = _manifest();
        assertEq(_addressOf(entries[0].args[0]), Mainnet.IMD, "Rules: imd");
        assertEq(_addressOf(entries[0].args[1]), Mainnet.WORK_ORDERS, "Rules: workOrders");
        assertEq(_addressOf(entries[1].args[0]), Mainnet.IMD, "Endowments: imd");
        assertEq(_addressOf(entries[1].args[1]), Mainnet.SIMD, "Endowments: simd");
        assertEq(_addressOf(entries[1].args[2]), Mainnet.QUESTIONS, "Endowments: questions");
        assertEq(_addressOf(entries[1].args[3]), Mainnet.CROWD_POTS, "Endowments: crowdPots");
        assertEq(_addressOf(entries[2].args[0]), Mainnet.IMD, "Zap: imd");
        assertEq(_addressOf(entries[2].args[1]), Mainnet.POOL_MANAGER, "Zap: poolManager");
        assertEq(_addressOf(entries[2].args[2]), Mainnet.CROWD_POTS, "Zap: crowdPots");
        assertEq(_addressOf(entries[2].args[3]), Mainnet.QUESTIONS, "Zap: questions");
        assertEq(entries[1].args[2], entries[2].args[3], "Questions is written two ways");
        assertEq(entries[1].args[3], entries[2].args[2], "CrowdPots is written two ways");

        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            bytes memory fromTheDocument;
            for (uint256 a; a < entries[i].args.length; ++a) {
                fromTheDocument = bytes.concat(fromTheDocument, abi.encode(_addressOf(entries[i].args[a])));
            }
            assertEq(fromTheDocument, LaunchManifest.arguments(i, LaunchManifest.literals()), entries[i].name);
        }
    }

    /// @dev The three addresses of the earlier launches are the ones those launches created:
    /// `WorkOrders` and `CrowdPots` of launch B (IdentityMD launch 1573) and `Questions` of launch A
    /// (launch 1531), as `Mainnet.sol` records them (and `EarlierLaunches.sol` each launch's transaction). No marker from
    /// before those launches is left in either document. The document names each address in the
    /// argument tables in its checksummed form and in the shell variables its commands read, and
    /// names both launches' transactions; `README.md` names the three addresses. That the addresses
    /// are what the factory's `ContractsLaunched` events say, and that code lives there, is checked
    /// on a mainnet fork (`test_fork_manifest_theEarlierLaunchesAreTheOnesTheFactoryRecorded`).
    function test_manifest_theEarlierLaunchesAreWrittenWithTheirLiveAddresses() public view {
        assertEq(lit.workOrders, Mainnet.WORK_ORDERS, "Rules' desk is not launch B's WorkOrders");
        assertEq(lit.questions, Mainnet.QUESTIONS, "not launch A's Questions");
        assertEq(lit.crowdPots, Mainnet.CROWD_POTS, "not launch B's CrowdPots");
        assertTrue(_manifestIsComplete());

        string memory doc = _doc();
        string memory readme = vm.readFile(README);
        assertFalse(vm.contains(doc, MARKER), "docs/LAUNCH.md still carries a marker for a missing value");
        assertFalse(vm.contains(readme, MARKER), "README.md still carries a marker for a missing value");

        string memory lower = vm.toLowercase(doc);
        address[3] memory live = [Mainnet.QUESTIONS, Mainnet.WORK_ORDERS, Mainnet.CROWD_POTS];
        string[3] memory variables = ["export questions=", "export desk=", "export pots="];
        for (uint256 k; k < 3; ++k) {
            string memory written = vm.toLowercase(vm.toString(live[k]));
            assertTrue(vm.contains(doc, vm.toString(live[k])), "an argument table does not name it checksummed");
            assertGe(vm.split(lower, written).length - 1, 3, "the document names an address fewer than three times");
            assertTrue(
                vm.contains(lower, string.concat(variables[k], written)),
                "the shell variable the commands read is not the live address"
            );
            assertTrue(vm.contains(vm.toLowercase(readme), written), "README.md does not name the address");
        }
        assertTrue(vm.contains(lower, vm.toString(EarlierLaunches.LAUNCH_A_TX)), "launch A's transaction is not named");
        assertTrue(vm.contains(lower, vm.toString(EarlierLaunches.LAUNCH_B_TX)), "launch B's transaction is not named");
    }

    /// @dev The manifest names three contracts, each a plain identifier of at most 32 characters and
    /// each at most 16 static words of arguments, all of them addresses that are not zero.
    function test_manifest_namesAndArgumentsFitTheLaunchRules() public view {
        assertEq(LaunchManifest.CONTRACTS, 3);
        assertEq(LaunchManifest.name(0), "Rules");
        assertEq(LaunchManifest.name(1), "Endowments");
        assertEq(LaunchManifest.name(2), "Zap");
        assertEq(LaunchManifest.nameWord(0), bytes32("Rules"));
        assertEq(LaunchManifest.nameWord(1), bytes32("Endowments"));
        assertEq(LaunchManifest.nameWord(2), bytes32("Zap"));

        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            bytes memory args = LaunchManifest.arguments(i, lit);
            uint256 count = LaunchManifest.argumentCount(i);
            assertLe(count, 16, "at most 16 constructor arguments");
            assertEq(args.length, 32 * count, "one static word per argument");
            assertLe(bytes(LaunchManifest.name(i)).length, 32);
            for (uint256 w; w < count; ++w) {
                uint256 word;
                assembly ("memory-safe") {
                    word := mload(add(add(args, 0x20), mul(w, 0x20)))
                }
                assertGt(word, 0, "an argument is zero");
                assertLe(word, type(uint160).max, "an argument is not an address");
            }
            assertEq(
                LaunchManifest.initcode(i, lit).length,
                LaunchManifest.creationCode(i).length + 32 * count,
                "the initcode is the creation code followed by the arguments"
            );
        }
    }

    /// @dev The three addresses that exist today are the ones the protocol and Uniswap publish, and the
    /// six literals are six different addresses.
    function test_manifest_literals() public view {
        assertEq(lit.imd, 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7);
        assertEq(lit.simd, 0x9Efa934D9fAd4AE28c998a40195646b965a97247);
        assertEq(lit.poolManager, 0x000000000004444c5dc75cB358380D2e3dE08A90);
        address[6] memory all = [lit.imd, lit.simd, lit.poolManager, lit.questions, lit.workOrders, lit.crowdPots];
        for (uint256 i; i < 6; ++i) {
            for (uint256 j = i + 1; j < 6; ++j) {
                assertTrue(all[i] != all[j], "two literals are the same address");
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Deployment on an empty chain
    // ------------------------------------------------------------------------------------------

    /// @dev Nothing the contracts are told about exists yet: the launch checks run on a chain like
    /// this one. The three deploy in manifest order all the same, and each reports the manifest's
    /// arguments back from its immutables.
    function test_launch_deploysInManifestOrderOnAnEmptyChain() public {
        assertEq(lit.imd.code.length, 0);
        assertEq(lit.simd.code.length, 0);
        assertEq(lit.poolManager.code.length, 0);
        assertEq(lit.questions.code.length, 0);
        assertEq(lit.workOrders.code.length, 0);
        assertEq(lit.crowdPots.code.length, 0);

        (Rules rules, Endowments endowments, Zap zap) = _launch();

        // CREATE2 from the factory, salted by the position in the manifest.
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            address expected =
                vm.computeCreate2Address(bytes32(i), keccak256(LaunchManifest.initcode(i, lit)), address(factory));
            assertEq([address(rules), address(endowments), address(zap)][i], expected);
        }

        assertEq(address(rules.IMD()), lit.imd);
        assertEq(address(rules.WORK_ORDERS()), lit.workOrders);
        assertEq(rules.ruleCount(), 0);
        assertEq(rules.totalEscrowed(), 0);

        assertEq(address(endowments.IMD()), lit.imd);
        assertEq(address(endowments.SIMD()), lit.simd);
        assertEq(address(endowments.QUESTIONS()), lit.questions);
        assertEq(address(endowments.CROWD_POTS()), lit.crowdPots);
        assertEq(endowments.endowmentCount(), 0);
        assertEq(endowments.epoch(), 1);
        assertEq(endowments.METER_RUNWAY(), 30);

        assertEq(address(zap.IMD()), lit.imd);
        assertEq(address(zap.POOL_MANAGER()), lit.poolManager);
        assertEq(address(zap.CROWD_POTS()), lit.crowdPots);
        assertEq(address(zap.QUESTIONS()), lit.questions);
        // With the real IMD address, the pool Zap names is the live ETH/IMD pool.
        assertEq(zap.POOL_ID(), 0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3);
    }

    /// @dev Sizes against the launch's limits and against our own tighter gates, and the gas of the
    /// whole launch: measured here, and estimated at what a real launch of this kind cost per byte.
    function test_launch_sizeAndGasGates() public {
        // Built before the clock starts, so that only the factory's call is measured.
        bytes[] memory codes = LaunchManifest.initcodes(lit);
        uint256 gasBefore = gasleft();
        address[] memory out = factory.launch(codes, 0);
        uint256 gasUsed = gasBefore - gasleft();

        uint256 initcodeTotal;
        uint256 runtimeTotal;
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            uint256 runtime = out[i].code.length;
            uint256 initcode = codes[i].length;
            initcodeTotal += initcode;
            runtimeTotal += runtime;
            emit log_named_string("contract", LaunchManifest.name(i));
            emit log_named_uint("  runtime bytes", runtime);
            emit log_named_uint("  initcode bytes, with arguments", initcode);
            assertGt(runtime, 0);
            assertLe(runtime, GATE_RUNTIME, "runtime over our gate of 23,000 bytes");
            assertLe(initcode, GATE_INITCODE, "initcode over our gate of 46,000 bytes");
            assertLt(GATE_RUNTIME, RULE_RUNTIME);
            assertLt(GATE_INITCODE, RULE_INITCODE);
        }

        uint256 estimate = initcodeTotal * GAS_PER_INITCODE_BYTE;
        emit log_named_uint("initcode bytes, whole launch", initcodeTotal);
        emit log_named_uint("gas, three CREATE2 in one call (measured here)", gasUsed);
        emit log_named_uint("gas, at 241 per initcode byte (a real launch's rate)", estimate);
        assertLe(gasUsed, GATE_GAS, "the launch is over our gas gate of 12M");
        assertLe(estimate, GATE_GAS, "the launch is over our gas gate of 12M at a real launch's rate");
        assertLt(GATE_GAS, RULE_GAS);
        // Storing code alone costs 200 gas a byte: a figure below that was not measured at all.
        assertGt(gasUsed, 200 * runtimeTotal, "the creation cost was not measured");
    }

    /// @dev A constructor that called another contract, or asked whether an address has code, would
    /// revert in the launch checks and park the launch. Every account access made during the three
    /// creations is recorded: the only ones are the factory's three creations themselves.
    function test_launch_constructorsTouchNothingOutsideTheirOwnContract() public {
        bytes[] memory codes = LaunchManifest.initcodes(lit);
        vm.startStateDiffRecording();
        address[] memory out = factory.launch(codes, 0);
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        uint256 creations;
        for (uint256 i; i < accesses.length; ++i) {
            VmSafe.AccountAccess memory a = accesses[i];
            // A marker that a call frame went on after a nested one returned; not an access.
            if (a.kind == VmSafe.AccountAccessKind.Resume) continue;
            if (a.accessor == address(this)) {
                // The test calling the factory.
                assertEq(uint8(a.kind), uint8(VmSafe.AccountAccessKind.Call));
                assertEq(a.account, address(factory));
                continue;
            }
            // Everything else must be the factory creating the next contract of the manifest. An
            // access made from inside a constructor would name the new contract as its accessor.
            assertEq(a.accessor, address(factory), "a constructor reached outside its own contract");
            assertEq(uint8(a.kind), uint8(VmSafe.AccountAccessKind.Create), "not a creation");
            assertEq(a.account, out[creations], "created out of manifest order");
            assertEq(a.value, 0, "a creation carried ETH");
            assertFalse(a.reverted);
            ++creations;
        }
        assertEq(creations, LaunchManifest.CONTRACTS, "not exactly three creations");
    }

    /// @dev Deployment sends zero ETH, and the constructors are nonpayable: with a single wei each
    /// creation fails.
    function test_launch_constructorsAreNonpayable() public {
        vm.deal(address(this), 1 ether);
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            bytes[] memory one = new bytes[](1);
            one[0] = LaunchManifest.initcode(i, lit);
            vm.expectRevert(abi.encodeWithSelector(MiniFactory.DeploymentFailed.selector, 0));
            factory.launch{value: 1}(one, 1);
        }
    }

    /// @dev A manifest with one address left out (zero) does not deploy: each of the ten arguments is
    /// checked, so a launch cannot go out with a literal that was never filled in as zero.
    function test_launch_aMissingAddressIsRefused() public {
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            uint256 count = LaunchManifest.argumentCount(i);
            for (uint256 w; w < count; ++w) {
                bytes memory args = LaunchManifest.arguments(i, lit);
                assembly ("memory-safe") {
                    mstore(add(add(args, 0x20), mul(w, 0x20)), 0)
                }
                bytes[] memory one = new bytes[](1);
                one[0] = bytes.concat(LaunchManifest.creationCode(i), args);
                vm.expectRevert(abi.encodeWithSelector(MiniFactory.DeploymentFailed.selector, 0));
                factory.launch(one, 0);
            }
        }
    }

    /// @dev The same statement read off the bytecode. A constructor's code is what a contract's
    /// creation code holds before its runtime code. In none of the three does it hold CALL,
    /// STATICCALL, DELEGATECALL, CALLCODE, an EXTCODE instruction, BALANCE, CREATE, CREATE2 or
    /// SELFDESTRUCT.
    function test_launch_constructorCodeHoldsNoCallAndNoCodeCheck() public {
        address[] memory out = factory.launch(LaunchManifest.initcodes(lit), 0);
        uint8[11] memory outward = [0xf1, 0xfa, 0xf4, 0xf2, 0x3b, 0x3c, 0x3f, 0x31, 0xf0, 0xf5, 0xff];
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            bytes memory creation = LaunchManifest.creationCode(i);
            uint256 constructorLength = creation.length - out[i].code.length;
            assertGt(constructorLength, 0);
            bytes memory constructorCode = new bytes(constructorLength);
            for (uint256 b; b < constructorLength; ++b) {
                constructorCode[b] = creation[b];
            }
            for (uint256 k; k < outward.length; ++k) {
                assertEq(
                    Bytecode.count(constructorCode, outward[k]),
                    0,
                    string.concat(
                        LaunchManifest.name(i), ": the constructor holds instruction ", vm.toString(outward[k])
                    )
                );
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Entry points
    // ------------------------------------------------------------------------------------------

    /// @dev The complete list of functions that can change state, for each of the three contracts,
    /// read from the ABI the compiler wrote and held against the tables a reader finds in
    /// `README.md`. No contract has a function outside its list, none has a `receive` or a
    /// fallback, every constructor is nonpayable and takes only addresses, and the only functions
    /// that take ETH are Zap's three entry points, which exist to take it. A function added later,
    /// under whatever name, fails here until it is documented.
    ///
    /// The lists hold no owner, admin, setter, pause, initializer, upgrade or mint function. Who may
    /// call each listed function is shown by that function's own tests; the ones with a restriction
    /// are `Rules.cancel` and `Rules.recall` (the rule's creator), `Rules.onWorkDelivered` (the hire
    /// desk) and `Zap.unlockCallback` (the PoolManager).
    function test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes() public view {
        string memory readme = vm.readFile(README);
        _assertWriters("Rules", "cancel,createRule,fire,onWorkDelivered,recall,reconcile,topUp", "", readme);
        _assertWriters(
            "Endowments",
            "createForMeter,createForPot,createForRecipient,deposit,donate,exit,harvest,stake,withdraw",
            "",
            readme
        );
        _assertWriters("Zap", "buy,chipIn,fundMeter,unlockCallback", "buy,chipIn,fundMeter", readme);
    }

    /// @dev Walks the `abi` array of one contract's build artifact.
    function _assertWriters(
        string memory name,
        string memory expectedList,
        string memory payableList,
        string memory readme
    ) internal view {
        string memory artifact = _artifact(name, name);
        string[] memory expected = vm.split(expectedList, ",");
        bool[] memory seen = new bool[](expected.length);
        bool constructorSeen;
        uint256 payableSeen;

        for (uint256 i; vm.keyExistsJson(artifact, string.concat(".abi[", vm.toString(i), "]")); ++i) {
            string memory at = string.concat(".abi[", vm.toString(i), "]");
            bytes32 kind = keccak256(bytes(vm.parseJsonString(artifact, string.concat(at, ".type"))));
            assertTrue(
                kind != keccak256("receive") && kind != keccak256("fallback"),
                string.concat(name, " has a receive or a fallback")
            );
            if (kind != keccak256("function") && kind != keccak256("constructor")) continue;

            bytes32 mutability = keccak256(bytes(vm.parseJsonString(artifact, string.concat(at, ".stateMutability"))));
            if (kind == keccak256("constructor")) {
                constructorSeen = true;
                assertTrue(mutability == keccak256("nonpayable"), string.concat(name, ": the constructor takes ETH"));
                uint256 n;
                for (; vm.keyExistsJson(artifact, string.concat(at, ".inputs[", vm.toString(n), "]")); ++n) {
                    assertEq(
                        vm.parseJsonString(artifact, string.concat(at, ".inputs[", vm.toString(n), "].type")),
                        "address",
                        string.concat(name, ": a constructor argument that is not an address")
                    );
                }
                assertEq(n, LaunchManifest.argumentCount(_indexOf(name)), string.concat(name, ": constructor arity"));
                continue;
            }
            if (mutability == keccak256("view") || mutability == keccak256("pure")) continue;

            string memory fn = vm.parseJsonString(artifact, string.concat(at, ".name"));
            bool listed;
            for (uint256 k; k < expected.length; ++k) {
                if (_same(expected[k], fn)) {
                    assertFalse(seen[k], string.concat(name, ".", fn, " is overloaded"));
                    seen[k] = true;
                    listed = true;
                }
            }
            assertTrue(listed, string.concat(name, " has a state-changing function that is not documented: ", fn));
            if (mutability == keccak256("payable")) {
                ++payableSeen;
                assertTrue(
                    vm.contains(string.concat(",", payableList, ","), string.concat(",", fn, ",")),
                    string.concat(name, ".", fn, " takes ETH and is not documented as doing so")
                );
            }
        }

        assertTrue(constructorSeen, string.concat(name, ": no constructor in the ABI"));
        assertEq(
            payableSeen,
            bytes(payableList).length == 0 ? 0 : vm.split(payableList, ",").length,
            string.concat(name, ": the functions that take ETH are not the documented ones")
        );
        for (uint256 k; k < expected.length; ++k) {
            assertTrue(seen[k], string.concat(name, " has no function ", expected[k]));
            assertTrue(
                vm.contains(readme, string.concat("`", expected[k], "(")),
                string.concat("README.md does not list ", name, ".", expected[k])
            );
        }
    }

    function _indexOf(string memory name) internal pure returns (uint256) {
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            if (_same(LaunchManifest.name(i), name)) return i;
        }
        revert("not a contract of this launch");
    }

    /// @dev No function of any of the three contracts carries a name that speaks of an owner or of a
    /// power to change the contract after launch. (Names prove little by themselves; the list of
    /// state-changing functions above is the complete one, and each has its own tests.)
    /// `Endowments.withdraw` is the one name on such a list that this launch does have: it gives a
    /// depositor back that depositor's own principal, and is tested as such.
    function test_launch_noFunctionNamesAnOwnerOrAPowerToChange() public view {
        string[11] memory words = [
            "owner", "admin", "pause", "freeze", "blacklist", "initialize", "upgrade", "mint", "sweep", "rescue", "set"
        ];
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            string memory name = LaunchManifest.name(i);
            string[] memory signatures = vm.parseJsonKeys(_artifact(name, name), ".methodIdentifiers");
            assertGt(signatures.length, 10);
            for (uint256 s; s < signatures.length; ++s) {
                string memory lower = vm.toLowercase(signatures[s]);
                for (uint256 w; w < words.length; ++w) {
                    if (_same(words[w], "set")) {
                        // A setter is `set` followed by a capital letter (`settle` would not be one).
                        bytes memory raw = bytes(signatures[s]);
                        bool setter = raw.length > 3 && raw[0] == "s" && raw[1] == "e" && raw[2] == "t" && raw[3] >= "A"
                            && raw[3] <= "Z";
                        assertFalse(setter, string.concat(name, " has a setter: ", signatures[s]));
                    } else {
                        assertFalse(
                            vm.contains(lower, words[w]),
                            string.concat(name, " has a function named for ", words[w], ": ", signatures[s])
                        );
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Forbidden instructions
    // ------------------------------------------------------------------------------------------

    /// @dev The walk is not blind on compiled code either: it finds the DELEGATECALL of a contract
    /// that has one, and does not take the same bytes for instructions where a compiled contract
    /// holds them as a constant.
    function test_scan_findsADelegatecallInCompiledCodeAndNotInAConstant() public {
        bytes memory bad = address(new UsesDelegatecall()).code;
        assertEq(Bytecode.count(bad, Bytecode.DELEGATECALL), 1, "a DELEGATECALL went unseen");
        assertGt(Bytecode.forbidden(bad), 0);

        bytes memory harmless = address(new HoldsTheBytesAsData()).code;
        assertEq(Bytecode.forbidden(harmless), 0, "PUSH data was read as instructions");
    }

    /// @dev The scan reads instructions, not bytes: an 0xf4 that is the data of a PUSH is not a
    /// DELEGATECALL, and one that stands as an instruction is found wherever it is.
    function test_scan_seesInstructionsAndStepsOverPushData() public pure {
        // PUSH1 0xf4, PUSH2 0xf2ff, PUSH32 (0xff x 32), STOP
        bytes memory onlyData = abi.encodePacked(hex"60f4", hex"61f2ff", hex"7f", bytes32(type(uint256).max), hex"00");
        assertEq(Bytecode.forbidden(onlyData), 0);
        (uint256 instructions, uint256 pushData) = Bytecode.shape(onlyData);
        assertEq(instructions, 4);
        assertEq(pushData, 1 + 2 + 32);

        assertEq(Bytecode.count(hex"f4", Bytecode.DELEGATECALL), 1);
        assertEq(Bytecode.count(hex"6000f2", Bytecode.CALLCODE), 1);
        assertEq(Bytecode.count(hex"60f4ff", Bytecode.SELFDESTRUCT), 1);
        // PUSH1 0x60 then DELEGATECALL: the 0x60 is data, so the next byte is an instruction again.
        assertEq(Bytecode.forbidden(hex"6060f4"), 1);
        assertEq(Bytecode.forbidden(abi.encodePacked(onlyData, hex"f4f2ff")), 3);
        // A PUSH cut short by the end of the code hides nothing behind it.
        assertEq(Bytecode.forbidden(hex"f47f"), 1);
    }

    /// @dev Every runtime this launch puts on chain, as deployed with the manifest's arguments, has no
    /// DELEGATECALL, CALLCODE or SELFDESTRUCT instruction. Neither does any initcode, so no
    /// constructor can run one either. None creates a contract or reads `tx.origin`.
    function test_launch_noForbiddenInstructionInAnyDeployedRuntime() public {
        address[] memory out = factory.launch(LaunchManifest.initcodes(lit), 0);
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            bytes memory runtime = out[i].code;
            bytes memory initcode = LaunchManifest.initcode(i, lit);
            string memory who = LaunchManifest.name(i);

            assertEq(Bytecode.count(runtime, Bytecode.DELEGATECALL), 0, string.concat(who, ": DELEGATECALL"));
            assertEq(Bytecode.count(runtime, Bytecode.CALLCODE), 0, string.concat(who, ": CALLCODE"));
            assertEq(Bytecode.count(runtime, Bytecode.SELFDESTRUCT), 0, string.concat(who, ": SELFDESTRUCT"));
            assertEq(Bytecode.forbidden(initcode), 0, string.concat(who, ": forbidden instruction in the initcode"));

            assertEq(Bytecode.count(runtime, Bytecode.CREATE), 0, string.concat(who, ": CREATE"));
            assertEq(Bytecode.count(runtime, Bytecode.CREATE2), 0, string.concat(who, ": CREATE2"));
            assertEq(Bytecode.count(runtime, Bytecode.ORIGIN), 0, string.concat(who, ": ORIGIN"));

            // The scan walked real code: thousands of instructions, with constants stepped over.
            (uint256 instructions, uint256 pushData) = Bytecode.shape(runtime);
            assertGt(instructions, 1_000);
            assertGt(pushData, 100);
        }
    }

    // ------------------------------------------------------------------------------------------
    // First use
    // ------------------------------------------------------------------------------------------

    /// @dev Before anything exists behind the addresses, the contracts are inert, not broken: every
    /// call that needs a dependency reverts and leaves no state behind.
    function test_launch_beforeTheDependenciesExistEveryUseReverts() public {
        (Rules rules, Endowments endowments, Zap zap) = _launch();
        address user = makeAddr("user");
        vm.deal(user, 1 ether);

        vm.startPrank(user);
        vm.expectRevert();
        endowments.createForRecipient(user);
        vm.expectRevert();
        endowments.createForMeter(keccak256("feed"));
        vm.expectRevert();
        endowments.createForPot(1, user);
        vm.expectRevert();
        zap.buy{value: 0.01 ether}(0, NO_DEADLINE);
        vm.stopPrank();

        assertEq(endowments.endowmentCount(), 0);
        assertEq(rules.ruleCount(), 0);
        assertEq(user.balance, 1 ether);
    }

    /// @dev Code now exists behind every address the manifest names: stand-ins for IMD, sIMD, the
    /// PoolManager and the three HELP WANTED contracts of the earlier launches, placed at the
    /// manifest's own literals. Each contract of this launch then does its job once, through the
    /// addresses it was constructed with and nothing else.
    function test_launch_onceTheDependenciesExistEachContractWorks() public {
        (Rules rules, Endowments endowments, Zap zap) = _launch();
        _placeStandIns();
        MockIMD imd = MockIMD(lit.imd);
        MockQuestions questions = MockQuestions(lit.questions);
        MockCrowdPots pots = MockCrowdPots(lit.crowdPots);
        MockDesk desk = MockDesk(lit.workOrders);

        bytes32 feed = keccak256("robot-jobs-report");
        questions.addFeed(feed);
        pots.open(1, 5e18);
        address user = makeAddr("user");
        vm.deal(user, 1 ether);
        imd.mint(user, 100_000e18);

        // ---- Zap: ETH in, a chip, meter shares and IMD out, all in the caller's name
        vm.startPrank(user);
        (uint256 imdOut, uint256 chipped) = zap.chipIn{value: 0.01 ether}(1, 3e18, NO_DEADLINE);
        assertEq(imdOut, 3e18);
        assertEq(chipped, 3e18);
        assertEq(pots.chipOf(1, user), 3e18);
        (, uint256 shares) = zap.fundMeter{value: 0.01 ether}(feed, 3e18, NO_DEADLINE);
        assertEq(shares, 3e18);
        assertEq(questions.sharesOf(feed, user), 3e18);
        assertEq(zap.buy{value: 0.01 ether}(3e18, NO_DEADLINE), 3e18);
        assertEq(imd.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);

        // ---- Endowments: a meter endowment stakes, earns, and tops the meter up to its runway
        imd.approve(address(endowments), type(uint256).max);
        uint256 meterId = endowments.createForMeter(feed);
        uint256 potId = endowments.createForPot(1, user);
        endowments.deposit(meterId, 10_000e18);
        endowments.deposit(potId, 10_000e18);
        vm.roll(vm.getBlockNumber() + 50);
        endowments.stake();
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 1);
        imd.mint(lit.simd, imd.balanceOf(lit.simd) / 100); // 1% yield, as sIMD receives it

        uint256 runway = 30 * questions.cost();
        assertEq(endowments.harvest(meterId), runway - 3e18, "the meter is topped up to thirty requests");
        assertEq(questions.meterBalance(feed), runway);
        // The pot still needs 2 IMD, so that is all its endowment takes out; nothing goes to the fallback.
        uint256 userBefore = imd.balanceOf(user);
        assertEq(endowments.harvest(potId), 2e18);
        assertEq(pots.remaining(1), 0);
        assertEq(imd.balanceOf(user), userBefore);
        vm.prank(user);
        endowments.withdraw(meterId, 10_000e18);

        // ---- Rules: WHEN the vault holds at least 10,000 IMD THEN HIRE, on the desk the manifest names
        Rules.RuleParams memory p;
        p.when.kind = 1;
        p.when.cmp = 1;
        p.when.target = lit.simd;
        p.when.threshold = 10_000e18;
        p.when.data = abi.encodeWithSignature("totalAssets()");
        p.action = 1;
        p.hire.kindHash = keccak256("audit");
        p.hire.minPay = 4e18;
        p.hire.maxPay = 10e18;
        p.hire.rampSecs = 1 hours;
        p.hire.deliverySecs = 7 days;
        p.hire.bond = 0.5e18;
        p.hire.orderTtl = 14 days;
        p.tip = 0.05e18;
        p.maxFires = 1;
        bytes memory spec = "Audit the vault and list every finding. Inputs: repoUrl=https://example.org/vault";
        vm.startPrank(user);
        imd.approve(address(rules), type(uint256).max);
        uint256 ruleId = rules.createRule(p, spec, 10.05e18);
        vm.stopPrank();
        assertTrue(rules.canFire(ruleId));
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        uint256 orderId = rules.fire(ruleId, spec);
        assertEq(imd.balanceOf(keeper), 0.05e18);
        (, address employer, uint96 escrow,,) = desk.accountOf(orderId);
        assertEq(employer, address(rules));
        assertEq(escrow, 10e18);
        assertEq(imd.balanceOf(address(rules)), rules.totalEscrowed());
    }
}
