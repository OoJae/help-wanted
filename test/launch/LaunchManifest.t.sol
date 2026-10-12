// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {JobsReport} from "../../src/payroll/JobsReport.sol";
import {Payroll} from "../../src/payroll/Payroll.sol";
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

/// @title Launch A as the manifest will describe it
/// @notice `docs/LAUNCH.md` carries the manifest this launch expects: three contracts in order,
/// each with its constructor arguments. These tests read that manifest out of the document and
/// hold it against the code and the fixtures:
///
/// - the contracts are `Questions`, `JobsReport`, `Payroll`, in that order;
/// - every argument is the mainnet address `Mainnet.sol` names, a backward reference to
///   `Questions`, or a house feed id recomputed here from the feed's parameters and text;
/// - the three contracts, created in that order from those arguments on a chain where none of
///   their dependencies has code, come out configured as written, inside our size and gas gates,
///   with no DELEGATECALL, CALLCODE or SELFDESTRUCT in their runtime bytecode and no call or
///   code-size check in their constructors.
/// - the functions that can change state are exactly the ones `README.md` lists, and none of them
///   is an owner's.
///
/// A change to a feed's parameters, to a constructor or to an address that is not also made in the
/// document fails here.
contract LaunchManifestTest is LaunchKit {
    address[3] internal deployed;
    uint256[3] internal creationGas;
    uint256[3] internal initcodeBytes;

    /// @dev Creates the three contracts from the document's manifest, in its order, resolving
    /// `$contract:Name` to the address an earlier entry was created at, as the launch does.
    function _launchFromTheDocument() internal {
        (, Entry[] memory entries) = _manifest();
        assertEq(entries.length, 3, "the manifest names three contracts");
        for (uint256 i; i < 3; ++i) {
            bytes memory init = _initcode(i, _wordsOf(entries, i));
            initcodeBytes[i] = init.length;
            address created;
            uint256 gasBefore = gasleft();
            assembly ("memory-safe") {
                created := create(0, add(init, 0x20), mload(init))
            }
            creationGas[i] = gasBefore - gasleft();
            assertTrue(created != address(0), string.concat(entries[i].name, " did not deploy"));
            deployed[i] = created;
        }
    }

    /// @dev One manifest entry's arguments as ABI words. A manifest argument is a decimal or hex
    /// static word, or a reference to a contract earlier in the list.
    function _wordsOf(Entry[] memory entries, uint256 index) internal view returns (bytes32[] memory words) {
        string[] memory args = entries[index].args;
        words = new bytes32[](args.length);
        for (uint256 a; a < args.length; ++a) {
            string[] memory ref = vm.split(args[a], "$contract:");
            if (ref.length == 2) {
                bool found;
                for (uint256 e; e < index; ++e) {
                    if (keccak256(bytes(entries[e].name)) == keccak256(bytes(ref[1]))) {
                        words[a] = _word(deployed[e]);
                        found = true;
                    }
                }
                assertTrue(found, string.concat("a reference that does not point backward: ", args[a]));
            } else {
                words[a] = bytes32(vm.parseUint(args[a]));
            }
        }
    }

    // ---- the document against the code ------------------------------------------------------------

    function test_manifest_namesTheThreeContractsInOrder() public view {
        (string memory kind, Entry[] memory entries) = _manifest();
        assertEq(kind, "evm_contracts");
        assertEq(entries.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(entries[i].name, _contractName(i));
            assertLe(bytes(entries[i].name).length, 32, "a manifest name is at most 32 characters");
            assertLe(entries[i].args.length, 16, "a launch contract takes at most 16 arguments");
        }
        assertEq(entries[0].args.length, 3);
        assertEq(entries[1].args.length, 4);
        assertEq(entries[2].args.length, 9);
        // The only references are the two to Questions; there is no owner anywhere.
        assertEq(entries[1].args[0], "$contract:Questions");
        assertEq(entries[2].args[5], "$contract:Questions");
        assertFalse(
            vm.contains(_block(_doc(), "manifest", "json"), "$owner"), "no contract of this launch has an owner"
        );
    }

    /// @notice The feed ids the document gives to JobsReport and to Payroll are the ids of the
    /// three feeds in the fixture files: recomputed from each feed's parameters, prefix and tail,
    /// by the rule `createFeed` uses, and checked against the contract's own `feedIdOf`.
    function test_manifest_feedIdsAreRecomputedFromTheFixtures() public {
        (, Entry[] memory entries) = _manifest();
        Questions q = new Questions(Mainnet.INTAKE, Mainnet.IMD, Mainnet.ORACLE_SIGNER);
        string[3] memory names = _feedNames();
        string memory doc = _doc();
        for (uint256 i; i < 3; ++i) {
            HouseFeed memory h = _houseFeed(names[i]);
            bytes32 id = _recomputedId(h);
            assertEq(q.feedIdOf(h.params, h.qPrefix, h.tail), id, names[i]);
            assertEq(h.feedId, id, string.concat("the fixture file states another id for ", names[i]));
            assertEq(bytes32(vm.parseUint(entries[1].args[1 + i])), id, string.concat("JobsReport: ", names[i]));
            assertEq(bytes32(vm.parseUint(entries[2].args[6 + i])), id, string.concat("Payroll: ", names[i]));
            // The id also stands in the document's own table of feeds and in its runbook.
            assertEq(bytes32(vm.parseUint(_block(doc, string.concat("feedId:", names[i]), "text"))), id, names[i]);
        }
    }

    /// @notice Every argument in the document is the value the code and the fixtures give.
    function test_manifest_everyArgumentIsWhatTheCodeExpects() public {
        _launchFromTheDocument();
        (, Entry[] memory entries) = _manifest();
        for (uint256 i; i < 3; ++i) {
            bytes32[] memory want = _expectedWords(i, deployed[0]);
            bytes32[] memory got = _wordsOf(entries, i);
            assertEq(got.length, want.length, _contractName(i));
            for (uint256 a; a < want.length; ++a) {
                assertEq(got[a], want[a], string.concat(_contractName(i), ", argument ", vm.toString(a)));
            }
        }
    }

    // ---- the launch on an empty chain -------------------------------------------------------------

    /// @notice The launch pipeline creates the contracts in manifest order on a chain where none of
    /// their dependencies exists, and calls nothing afterwards. Here every dependency address is
    /// checked to be without code, the three are created from the document's manifest, and what
    /// each one stores is read back.
    function test_launch_deploysInManifestOrderOnAnEmptyChain() public {
        address[6] memory dependencies =
            [Mainnet.INTAKE, Mainnet.IMD, Mainnet.ORACLE_SIGNER, Mainnet.SIMD, Mainnet.SEATS, Mainnet.SEAT_ADAPTER];
        for (uint256 i; i < dependencies.length; ++i) {
            assertEq(dependencies[i].code.length, 0, "a dependency has code on the test chain");
        }

        _launchFromTheDocument();
        Questions q = Questions(deployed[0]);
        JobsReport report = JobsReport(deployed[1]);
        Payroll payroll = Payroll(deployed[2]);
        bytes32[3] memory ids = _recomputedIds();

        assertEq(address(q.INTAKE()), Mainnet.INTAKE);
        assertEq(address(q.IMD()), Mainnet.IMD);
        assertEq(q.oracleSigner(), Mainnet.ORACLE_SIGNER);

        assertEq(address(report.QUESTIONS()), address(q));
        assertEq(report.PAYROLLS_FEED(), ids[0]);
        assertEq(report.HIRES_FEED(), ids[1]);
        assertEq(report.EMPLOYERS_FEED(), ids[2]);

        assertEq(address(payroll.IMD()), Mainnet.IMD);
        assertEq(payroll.SIMD(), Mainnet.SIMD);
        assertEq(payroll.SEATS(), Mainnet.SEATS);
        assertEq(payroll.SEAT_COUNT(), 2000);
        assertEq(payroll.ADAPTER(), Mainnet.SEAT_ADAPTER);
        assertEq(payroll.QUESTIONS(), address(q));
        assertEq(payroll.FEED_A(), ids[0], "feedA is the payrolls feed");
        assertEq(payroll.FEED_B(), ids[1], "feedB is the hires feed");
        assertEq(payroll.FEED_C(), ids[2], "feedC is the employers feed, the slow one");

        // Nothing is called after deployment, and nothing needs to be: no feed exists yet, the
        // report is empty, the books are at zero, and every view answers.
        assertEq(q.feedCount(), 0);
        assertEq(report.printCount(), 0);
        (,,,, uint256 owedInAll) = payroll.owed();
        assertEq(owedInAll, 0);
        uint256[3] memory needs = payroll.feedShortfalls();
        assertEq(needs[0] + needs[1] + needs[2], 0, "a feed nobody has created needs nothing");
    }

    /// @notice Our gates: runtime at most 23,000 bytes and initcode at most 46,000 for each
    /// contract (the protocol's limits are 24,576 and 49,152), and the whole launch under 12 million
    /// gas (the protocol's ceiling is 16.7 million). The launch's gas is estimated the way the brief
    /// does, at 240 gas for each byte of initcode, a figure taken from a real launch; the creation
    /// cost measured here must be inside that estimate. The fork suite rehearses the launch through
    /// the real factory and measures it there.
    function test_launch_fitsOurSizeAndGasGates() public {
        _launchFromTheDocument();
        uint256 totalInitcode;
        uint256 totalCreation;
        uint256 totalRuntime;
        for (uint256 i; i < 3; ++i) {
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
        emit log_named_uint("launch A: initcode bytes in all", totalInitcode);
        emit log_named_uint("launch A: gas at 240 a byte", estimate);
        emit log_named_uint("launch A: creation gas measured here", totalCreation);
        assertLt(estimate, LAUNCH_GAS_GATE, "launch A is over our gas gate");
        assertLt(totalCreation, estimate, "the estimate is not on the safe side of the measured creation cost");
        // Storing code alone costs 200 gas a byte: a figure below that was not measured at all.
        assertGt(totalCreation, 200 * totalRuntime, "the creation cost was not measured");
    }

    // ---- entry points -----------------------------------------------------------------------------

    /// @notice The complete list of functions that can change state, for each of the three
    /// contracts, read from the ABI the compiler wrote and held against the list a reader finds in
    /// `README.md`. No contract has a function outside its list, none can receive ETH (no payable
    /// function, no `receive`, no fallback), and every constructor is nonpayable. A function added
    /// later, under whatever name, fails here until it is documented.
    ///
    /// The lists hold no owner, admin, setter, pause, initializer, upgrade or mint function. Who
    /// may call each of the functions that are listed is shown by that function's own tests; the
    /// only one with a restriction is `Questions.onOracleResult`, which takes calls from the Intake.
    function test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes() public view {
        _assertWriters(
            "Questions", "abandon,collectTips,createFeed,defund,fund,fundFor,onOracleResult,request,reveal,submit"
        );
        _assertWriters("JobsReport", "crown,print");
        _assertWriters("Payroll", "book,claimSeat,claimSeats,claimTip,drip,fundFeeds,pay,sweepTip,tip");
    }

    /// @dev Walks the `abi` array of one contract's build artifact.
    function _assertWriters(string memory name, string memory expectedList) internal view {
        string memory artifact = vm.readFile(string.concat("out/", name, ".sol/", name, ".json"));
        string[] memory expected = vm.split(expectedList, ",");
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
                continue;
            }
            if (mutability == keccak256("view") || mutability == keccak256("pure")) continue;

            string memory fn = vm.parseJsonString(artifact, string.concat(at, ".name"));
            bool listed;
            for (uint256 k; k < expected.length; ++k) {
                if (keccak256(bytes(expected[k])) == keccak256(bytes(fn))) {
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
        }
    }

    // ---- bytecode ---------------------------------------------------------------------------------

    /// @notice No deployed contract of this launch holds DELEGATECALL, CALLCODE or SELFDESTRUCT.
    /// The runtime bytecode is walked instruction by instruction, stepping over the data of every
    /// PUSH so that a constant which happens to contain one of those bytes is not taken for one.
    function test_launch_runtimeBytecodeHasNoForbiddenOpcode() public {
        _launchFromTheDocument();
        for (uint256 i; i < 3; ++i) {
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

        // By hand: PUSH2 f4 ff, STOP has none; STOP, SELFDESTRUCT has one at byte 1.
        assertEq(_firstOpcode(hex"61f4ff00", _forbidden()), 4);
        assertEq(_firstOpcode(hex"00ff", _forbidden()), 1);
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
        for (uint256 i; i < 3; ++i) {
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
