// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {Doorbell} from "../../src/pots/Doorbell.sol";
import {LaunchValues} from "../kit/LaunchValues.sol";
import {LaunchKit} from "./LaunchKit.sol";

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

/// @title Launch B as the manifest will describe it
/// @notice `docs/LAUNCH.md` carries the manifest this launch expects: four contracts in order, each
/// with its constructor arguments. These tests read that manifest out of the document and hold it
/// against the code:
///
/// - the contracts are `WorkProof`, `WorkOrders`, `CrowdPots`, `Doorbell`, in that order;
/// - every argument is the mainnet address `Mainnet.sol` names (IMD, IdentityMD's WorkRegistry, and
///   the `Payroll` contract HELP WANTED's first launch created), a backward reference to an
///   earlier contract of the launch, or one of the Doorbell's values (`LaunchValues`);
/// - the four contracts, created in that order from those arguments on a chain where none of their
///   dependencies has code, come out configured as written, inside our size and gas gates, with no
///   DELEGATECALL, CALLCODE or SELFDESTRUCT in their runtime bytecode and no call or code-size
///   check in their constructors;
/// - the functions that can change state are exactly the ones `README.md` lists, none of them is
///   an owner's, and no contract can receive ETH.
///
/// A change to a constructor, to an address or to one of the Doorbell's values that is not also
/// made in the document fails here.
contract LaunchManifestTest is LaunchKit {
    address[] internal deployed;
    uint256[4] internal creationGas;
    uint256[4] internal initcodeBytes;

    function _launchFromTheDocument() internal {
        uint256[] memory gasUsed;
        uint256[] memory lengths;
        (deployed, gasUsed, lengths) = _createFromManifest();
        for (uint256 i; i < CONTRACTS; ++i) {
            creationGas[i] = gasUsed[i];
            initcodeBytes[i] = lengths[i];
        }
    }

    // ---- the document against the code ------------------------------------------------------------

    function test_manifest_namesTheFourContractsInOrder() public view {
        (string memory kind, Entry[] memory entries) = _manifest();
        assertEq(kind, "evm_contracts");
        assertEq(entries.length, CONTRACTS);
        for (uint256 i; i < CONTRACTS; ++i) {
            assertEq(entries[i].name, _contractName(i));
            assertLe(bytes(entries[i].name).length, 32, "a manifest name is at most 32 characters");
            assertLe(entries[i].args.length, 16, "a launch contract takes at most 16 arguments");
        }
        assertEq(entries[0].args.length, 1, "WorkProof(workRegistry)");
        assertEq(entries[1].args.length, 3, "WorkOrders(imd, workProof, payroll)");
        assertEq(entries[2].args.length, 2, "CrowdPots(imd, workOrders)");
        assertEq(
            entries[3].args.length,
            8,
            "Doorbell(imd, workOrders, kindHash, minPay, maxPay, bond, deliverySecs, allowClaimed)"
        );
        // The only references point backward, and there is no owner anywhere.
        assertEq(entries[1].args[1], "$contract:WorkProof");
        assertEq(entries[2].args[1], "$contract:WorkOrders");
        assertEq(entries[3].args[1], "$contract:WorkOrders");
        string memory json = _block(_doc(), "manifest", "json");
        assertFalse(vm.contains(json, "$owner"), "no contract of this launch has an owner");
        assertFalse(vm.contains(json, "$token"), "this launch has no token");
    }

    /// @notice The desk's third argument is the address of `Payroll`, the contract HELP WANTED's
    /// first launch created (IdentityMD launch 1531). It was the last value to be filled in. It
    /// stands in the manifest as a literal, it is the address `Mainnet.sol` records, and the
    /// document names the same address wherever it tells a reader to check it. No marker for a
    /// value still to come is left anywhere in the document. That the address holds the launched
    /// code is shown on a fork (`test_fork_payroll_isTheContractTheFirstLaunchCreated`).
    function test_manifest_payrollIsTheFirstLaunchsLiveAddress() public view {
        (, Entry[] memory entries) = _manifest();
        uint256 payroll = vm.parseUint(entries[1].args[2]);
        assertEq(payroll, uint160(Mainnet.PAYROLL), "WorkOrders' third argument is not launch A's Payroll");
        assertTrue(payroll != uint160(Mainnet.IMD), "Payroll is not the token");
        assertTrue(payroll != uint160(Mainnet.WORK_REGISTRY), "Payroll is not the registry");
        assertEq(_payrollOfTheManifest(), Mainnet.PAYROLL);

        string memory doc = _doc();
        assertFalse(vm.contains(doc, "FILL_IN"), "the document still carries a marker for a missing value");
        string memory lower = vm.toLowercase(doc);
        string memory written = vm.toLowercase(vm.toString(Mainnet.PAYROLL));
        // The manifest, the table of arguments and the command that reads it back.
        assertGe(vm.split(lower, written).length - 1, 3, "the document names Payroll's address fewer than three times");
        assertTrue(
            vm.contains(lower, string.concat("export payroll=", written)),
            "the shell variable the commands read is not launch A's Payroll"
        );
        assertTrue(
            vm.contains(vm.toLowercase(vm.readFile(README)), written), "README.md does not name Payroll's address"
        );
    }

    /// @notice Every argument in the document is the value the code gives: `Mainnet.sol` for the
    /// registry, the token and Payroll, the address an earlier contract was created at for a
    /// reference, and `LaunchValues` for the Doorbell.
    function test_manifest_everyArgumentIsWhatTheCodeExpects() public {
        _launchFromTheDocument();
        (, Entry[] memory entries) = _manifest();
        for (uint256 i; i < CONTRACTS; ++i) {
            bytes32[] memory want = _expectedWords(i, deployed);
            bytes32[] memory got = _wordsOf(entries, i, deployed);
            assertEq(got.length, want.length, _contractName(i));
            for (uint256 a; a < want.length; ++a) {
                assertEq(got[a], want[a], string.concat(_contractName(i), ", argument ", vm.toString(a)));
            }
        }
    }

    /// @notice The Doorbell's kind is written in the document as text, and the hash in the manifest
    /// is the hash of that text. The text is the kind of a real picture job's work record: the
    /// stored record of job df6805ee, read here by the launch's own WorkProof.
    function test_manifest_theDoorbellsKindIsTheTextTheDocumentNames() public {
        (, Entry[] memory entries) = _manifest();
        string memory kind = _block(_doc(), "doorbell:kind", "text");
        assertEq(kind, "skill:create-image");
        assertEq(bytes32(vm.parseUint(entries[3].args[2])), keccak256(bytes(kind)));
        assertEq(LaunchValues.BELL_KIND_HASH, keccak256(bytes(kind)));

        string memory evidence = vm.readFile("test/fixtures/pots/picture-job.json");
        assertEq(vm.parseJsonString(evidence, ".kind"), kind);
        bytes memory record = vm.parseBytes(vm.readFile(vm.parseJsonString(evidence, ".recordFile")));
        assertEq(keccak256(record), vm.parseJsonBytes32(evidence, ".recordHash"), "the stored record is the one named");
        WorkProof proof = new WorkProof(Mainnet.WORK_REGISTRY);
        (bytes16 jobId, WorkProof.Proof memory p) = proof.scan(record, 0);
        assertEq(jobId, bytes16(vm.parseJsonBytes(evidence, ".jobId")));
        assertEq(p.kindHash, keccak256(bytes(kind)), "the picture job's record carries this kind");
        assertEq(p.stateHash, keccak256("completed"));
    }

    /// @notice The Doorbell's other values in the document's table are the ones in the manifest.
    function test_manifest_theDoorbellsValuesAreTheOnesTheDocumentExplains() public view {
        (, Entry[] memory entries) = _manifest();
        string memory doc = _doc();
        assertEq(vm.parseUint(entries[3].args[3]), vm.parseUint(_block(doc, "doorbell:minPay", "text")));
        assertEq(vm.parseUint(entries[3].args[4]), vm.parseUint(_block(doc, "doorbell:maxPay", "text")));
        assertEq(vm.parseUint(entries[3].args[5]), vm.parseUint(_block(doc, "doorbell:bond", "text")));
        assertEq(vm.parseUint(entries[3].args[6]), vm.parseUint(_block(doc, "doorbell:deliverySecs", "text")));
        assertEq(vm.parseUint(entries[3].args[7]), vm.parseUint(_block(doc, "doorbell:allowClaimed", "text")));
        assertLe(vm.parseUint(entries[3].args[7]), 1, "a bool is written 0 or 1");
    }

    // ---- the launch on an empty chain -------------------------------------------------------------

    /// @notice The launch pipeline creates the contracts in manifest order on a chain where none of
    /// their dependencies exists, and calls nothing afterwards. Here every dependency address is
    /// checked to be without code, the four are created from the document's manifest, and what
    /// each one stores is read back.
    function test_launch_deploysInManifestOrderOnAnEmptyChain() public {
        address[3] memory dependencies = [Mainnet.WORK_REGISTRY, Mainnet.IMD, _payrollOfTheManifest()];
        for (uint256 i; i < dependencies.length; ++i) {
            assertEq(dependencies[i].code.length, 0, "a dependency has code on the test chain");
        }

        _launchFromTheDocument();
        WorkProof proof = WorkProof(deployed[0]);
        WorkOrders desk = WorkOrders(deployed[1]);
        CrowdPots pots = CrowdPots(deployed[2]);
        Doorbell bell = Doorbell(deployed[3]);

        assertEq(proof.WORK_REGISTRY(), Mainnet.WORK_REGISTRY);

        assertEq(desk.IMD(), Mainnet.IMD);
        assertEq(desk.WORK_PROOF(), address(proof), "$contract:WorkProof");
        assertEq(desk.PAYROLL(), Mainnet.PAYROLL, "the Payroll contract of the first launch");

        assertEq(address(pots.IMD()), Mainnet.IMD);
        assertEq(address(pots.WORK_ORDERS()), address(desk), "$contract:WorkOrders, in CrowdPots");

        assertEq(address(bell.IMD()), Mainnet.IMD);
        assertEq(address(bell.WORK_ORDERS()), address(desk), "$contract:WorkOrders, in the Doorbell");
        assertEq(bell.KIND_HASH(), keccak256("skill:create-image"));
        assertEq(bell.MIN_PAY(), LaunchValues.BELL_MIN_PAY);
        assertEq(bell.MAX_PAY(), LaunchValues.BELL_MAX_PAY);
        assertEq(bell.BOND(), LaunchValues.BELL_BOND);
        assertEq(bell.DELIVERY_SECS(), LaunchValues.BELL_DELIVERY_SECS);
        assertEq(bell.ALLOW_CLAIMED(), LaunchValues.BELL_ALLOW_CLAIMED);

        // Nothing is called after deployment, and nothing needs to be: no order, no pot and no
        // ring exist yet, and the views that touch no other contract answer.
        assertEq(desk.orderCount(), 0);
        assertEq(pots.potCount(), 0);
        assertEq(pots.owed(), 0);
        assertEq(bell.rings(), 0);
        assertEq(bell.hires(), 0);
        assertEq(bell.ringsUntilHire(), 25);
        // The Doorbell's own values are ones the desk accepts.
        assertGe(bell.BOND(), desk.MIN_BOND());
        assertGe(bell.DELIVERY_SECS(), desk.MIN_DELIVERY());
        assertLe(bell.DELIVERY_SECS(), desk.MAX_DELIVERY());
        assertGt(bell.MIN_PAY(), 0);
        assertLe(bell.MIN_PAY(), bell.MAX_PAY());
    }

    /// @notice Our gates: runtime at most 23,000 bytes and initcode at most 46,000 for each
    /// contract (the protocol's limits are 24,576 and 49,152), and the whole launch under 12 million
    /// gas (the protocol's ceiling is 16.7 million). The launch's gas is estimated at 240 gas for
    /// each byte of initcode, the rate a real contracts-only launch paid; the creation cost measured
    /// here must be inside that estimate. The fork suite rehearses the launch through the real
    /// factory and measures it there.
    function test_launch_fitsOurSizeAndGasGates() public {
        _launchFromTheDocument();
        uint256 totalInitcode;
        uint256 totalCreation;
        uint256 totalRuntime;
        for (uint256 i; i < CONTRACTS; ++i) {
            uint256 runtime = deployed[i].code.length;
            totalRuntime += runtime;
            emit log_named_uint(string.concat(_contractName(i), ": runtime bytes"), runtime);
            emit log_named_uint(string.concat(_contractName(i), ": initcode bytes with arguments"), initcodeBytes[i]);
            emit log_named_uint(string.concat(_contractName(i), ": creation gas"), creationGas[i]);
            assertLe(runtime, RUNTIME_GATE, string.concat(_contractName(i), " is over our runtime gate"));
            assertLe(initcodeBytes[i], INITCODE_GATE, string.concat(_contractName(i), " is over our initcode gate"));
            totalInitcode += initcodeBytes[i];
            totalCreation += creationGas[i];
        }
        uint256 estimate = totalInitcode * GAS_PER_INITCODE_BYTE;
        emit log_named_uint("launch B: initcode bytes in all", totalInitcode);
        emit log_named_uint("launch B: gas at 240 a byte", estimate);
        emit log_named_uint("launch B: creation gas measured here", totalCreation);
        assertLt(estimate, LAUNCH_GAS_GATE, "launch B is over our gas gate");
        assertLt(totalCreation, estimate, "the estimate is not on the safe side of the measured creation cost");
        // Storing code alone costs 200 gas a byte: a figure below that was not measured at all.
        assertGt(totalCreation, 200 * totalRuntime, "the creation cost was not measured");
    }

    // ---- entry points -----------------------------------------------------------------------------

    /// @notice The complete list of functions that can change state, for each of the four
    /// contracts, read from the ABI the compiler wrote and held against the list a reader finds in
    /// `README.md`. No contract has a function outside its list, none can receive ETH (no payable
    /// function, no `receive`, no fallback), and every constructor is nonpayable. A function added
    /// later, under whatever name, fails here until it is documented.
    ///
    /// The lists hold no owner, admin, setter, pause, initializer, upgrade or mint function. Who
    /// may call each of the functions that are listed is shown by that function's own tests. The
    /// ones with a restriction are `WorkOrders.cancel` (the order's employer), `release`,
    /// `register` and `claimDelivered` (the runner that holds the order), `resolve` (the order's
    /// arbiter), and the two `onWorkDelivered` callbacks (the desk).
    function test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes() public view {
        string memory readme = vm.readFile(README);
        _assertWriters("WorkProof", "", readme);
        _assertWriters(
            "WorkOrders",
            "cancel,challenge,claim,claimDelivered,createOrder,evict,finalize,redeliver,refund,register,release,reportFailed,resolve,settle,stamp,timeout,trigger",
            readme
        );
        _assertWriters(
            "CrowdPots",
            "chipIn,chipInFor,claimRefund,claimRefunds,launch,onWorkDelivered,openPot,openSeries,reconcile",
            readme
        );
        _assertWriters("Doorbell", "onWorkDelivered,ring", readme);
    }

    /// @dev Walks the `abi` array of one contract's build artifact.
    function _assertWriters(string memory name, string memory expectedList, string memory readme) internal view {
        string memory artifact = _artifact(name);
        string[] memory expected = bytes(expectedList).length == 0 ? new string[](0) : vm.split(expectedList, ",");
        bool[] memory seen = new bool[](expected.length);
        bool constructorSeen;

        for (uint256 i; vm.keyExistsJson(artifact, string.concat(".abi[", vm.toString(i), "]")); ++i) {
            string memory at = string.concat(".abi[", vm.toString(i), "]");
            bytes32 kind = keccak256(bytes(vm.parseJsonString(artifact, string.concat(at, ".type"))));
            assertTrue(kind != keccak256("receive") && kind != keccak256("fallback"), string.concat(name, " takes ETH"));
            if (kind != keccak256("function") && kind != keccak256("constructor")) continue;

            bytes32 mutability = keccak256(bytes(vm.parseJsonString(artifact, string.concat(at, ".stateMutability"))));
            assertTrue(mutability != keccak256("payable"), string.concat(name, " has a payable entry"));
            if (kind == keccak256("constructor")) {
                constructorSeen = true;
                _assertStaticArguments(name, artifact, at);
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
        }

        assertTrue(constructorSeen, string.concat(name, ": no constructor in the ABI"));
        for (uint256 k; k < expected.length; ++k) {
            assertTrue(seen[k], string.concat(name, " has no function ", expected[k]));
            assertTrue(
                vm.contains(readme, string.concat("`", expected[k], "(")),
                string.concat("README.md does not list ", name, ".", expected[k])
            );
        }
    }

    /// @dev A launch constructor takes at most 16 arguments, each one static word: an address, an
    /// unsigned integer, a bool or a bytes32.
    function _assertStaticArguments(string memory name, string memory artifact, string memory at) internal view {
        uint256 n;
        for (; vm.keyExistsJson(artifact, string.concat(at, ".inputs[", vm.toString(n), "]")); ++n) {
            string memory ty = vm.parseJsonString(artifact, string.concat(at, ".inputs[", vm.toString(n), "].type"));
            bool ok = _same(ty, "address") || _same(ty, "bool") || _same(ty, "bytes32");
            if (!ok && bytes(ty).length > 4) {
                // uint8 to uint256, and nothing after the digits (no array, no tuple).
                bytes memory t = bytes(ty);
                ok = t[0] == "u" && t[1] == "i" && t[2] == "n" && t[3] == "t";
                for (uint256 c = 4; ok && c < t.length; ++c) {
                    ok = t[c] >= "0" && t[c] <= "9";
                }
            }
            assertTrue(ok, string.concat(name, ": constructor argument of type ", ty));
        }
        assertLe(n, 16, string.concat(name, ": more than 16 constructor arguments"));
    }

    /// @notice No function of any of the four contracts carries a name that speaks of an owner or
    /// of a power to change the contract after launch. (Names prove little by themselves; the list
    /// of state-changing functions above is the complete one, and each has its own tests.)
    function test_launch_noFunctionNamesAnOwnerOrAPowerToChange() public view {
        string[14] memory words = [
            "owner",
            "admin",
            "pause",
            "freeze",
            "blacklist",
            "initialize",
            "upgrade",
            "mint",
            "burn",
            "withdraw",
            "sweep",
            "rescue",
            "transferOwnership",
            "set"
        ];
        for (uint256 i; i < CONTRACTS; ++i) {
            (string[] memory signatures,) = _methods(_contractName(i));
            for (uint256 s; s < signatures.length; ++s) {
                string memory lower = vm.toLowercase(signatures[s]);
                for (uint256 w; w < words.length; ++w) {
                    string memory word = vm.toLowercase(words[w]);
                    // A setter is `set` followed by a capital letter (`settle` is not one).
                    if (_same(word, "set")) {
                        bytes memory raw = bytes(signatures[s]);
                        bool setter = raw.length > 3 && raw[0] == "s" && raw[1] == "e" && raw[2] == "t" && raw[3] >= "A"
                            && raw[3] <= "Z";
                        assertFalse(setter, string.concat(_contractName(i), " has a setter: ", signatures[s]));
                    } else {
                        assertFalse(
                            vm.contains(lower, word),
                            string.concat(_contractName(i), " has a function named for ", words[w], ": ", signatures[s])
                        );
                    }
                }
            }
        }
    }

    // ---- bytecode ---------------------------------------------------------------------------------

    /// @notice No deployed contract of this launch holds DELEGATECALL, CALLCODE or SELFDESTRUCT.
    /// The runtime bytecode is walked instruction by instruction, stepping over the data of every
    /// PUSH so that a constant which happens to contain one of those bytes is not taken for one.
    function test_launch_runtimeBytecodeHasNoForbiddenOpcode() public {
        _launchFromTheDocument();
        for (uint256 i; i < CONTRACTS; ++i) {
            bytes memory code = deployed[i].code;
            assertGt(code.length, 0);
            uint256 at = _firstOpcode(code, _forbidden());
            assertEq(
                at, code.length, string.concat(_contractName(i), " holds a forbidden opcode at byte ", vm.toString(at))
            );
        }
    }

    /// @notice The walk is not blind: it finds a DELEGATECALL in a contract that has one, and it
    /// does not mistake the same bytes for instructions when they are the data of a PUSH.
    function test_bytecodeWalk_findsWhatItLooksForAndSkipsPushData() public {
        bytes memory bad = address(new UsesDelegatecall()).code;
        assertLt(_firstOpcode(bad, _forbidden()), bad.length, "a DELEGATECALL went unseen");
        assertEq(uint8(bad[_firstOpcode(bad, _forbidden())]), 0xf4);

        bytes memory harmless = address(new HoldsTheBytesAsData()).code;
        assertEq(_firstOpcode(harmless, _forbidden()), harmless.length, "PUSH data was read as instructions");

        // By hand: PUSH2 f4 ff, STOP has none; STOP, SELFDESTRUCT has one at byte 1; STOP,
        // CALLCODE has one at byte 1.
        assertEq(_firstOpcode(hex"61f4ff00", _forbidden()), 4);
        assertEq(_firstOpcode(hex"00ff", _forbidden()), 1);
        assertEq(_firstOpcode(hex"00f2", _forbidden()), 1);
        // A PUSH32 whose data runs past the end of the code hides nothing behind it.
        assertEq(_firstOpcode(hex"7ff4f2ff", _forbidden()), 4);
    }

    /// @notice A launch constructor runs on an empty chain: it may not call another contract, look
    /// at another address's code, or create a contract of its own that this launch did not name.
    /// The constructor's code is what a contract's creation code holds before its runtime code; it
    /// is walked for CALL, STATICCALL, DELEGATECALL, CALLCODE, the three EXTCODE instructions,
    /// BALANCE, CREATE, CREATE2 and SELFDESTRUCT.
    function test_launch_constructorsMakeNoCallAndNoCodeCheck() public {
        _launchFromTheDocument();
        bytes memory outward = hex"f1faf4f23b3c3f31f0f5ff";
        for (uint256 i; i < CONTRACTS; ++i) {
            bytes memory creation = _creationCode(i);
            uint256 constructorLength = creation.length - deployed[i].code.length;
            assertGt(constructorLength, 0);
            bytes memory constructorCode = new bytes(constructorLength);
            for (uint256 b; b < constructorLength; ++b) {
                constructorCode[b] = creation[b];
            }
            uint256 at = _firstOpcode(constructorCode, outward);
            assertEq(
                at,
                constructorLength,
                string.concat(_contractName(i), ": the constructor reaches outside itself at byte ", vm.toString(at))
            );
        }
    }
}
