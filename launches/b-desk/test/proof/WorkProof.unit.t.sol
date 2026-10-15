// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {IWorkRegistry} from "../../src/interfaces/external/IWorkRegistry.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {Rec} from "./utils/Rec.sol";
import {Opcodes} from "./utils/Opcodes.sol";
import {
    MockRegistry,
    RevertingRegistry,
    RevertsWithOneWordRegistry,
    SilentRegistry,
    ExactCallRegistry,
    FixedAnswerRegistry,
    SpinningRegistry,
    WritingRegistry,
    SlowRegistry
} from "./utils/Registries.sol";

/// @notice `prove` and its errors, against registries that behave and registries that do not.
contract WorkProofUnitTest is Test {
    WorkProof internal proof;
    MockRegistry internal registry;

    bytes internal record;
    bytes32 internal recordHash;

    function setUp() public {
        registry = new MockRegistry();
        proof = new WorkProof(address(registry));
        record = Rec.minimal();
        recordHash = keccak256(record);
        registry.set(Rec.JOB, recordHash);
    }

    // ---------------------------------------------------------------- construction

    function test_constructor_storesTheRegistryWithoutTouchingIt() public {
        // An address with no code is accepted: the launch pipeline runs constructors on an empty chain.
        address nothingThere = makeAddr("no code here");
        WorkProof fresh = new WorkProof(nothingThere);
        assertEq(fresh.WORK_REGISTRY(), nothingThere);
        assertEq(proof.WORK_REGISTRY(), address(registry));
        assertEq(proof.REGISTRY_GAS(), 50_000);
    }

    function test_constructor_takesNoValue() public {
        bytes memory initcode = abi.encodePacked(type(WorkProof).creationCode, abi.encode(address(registry)));
        address created;
        vm.deal(address(this), 1 ether);
        assembly ("memory-safe") {
            created := create(1, add(initcode, 0x20), mload(initcode))
        }
        assertEq(created, address(0), "the constructor is not payable");
    }

    function test_selectors_matchTheRegistryInterface() public pure {
        assertEq(IWorkRegistry.latest.selector, bytes4(0xebe9712c));
    }

    // ---------------------------------------------------------------- what the code can do at all

    /// @dev The launch rules, read off the compiled code instead of the source: nothing here can
    /// delegate, destroy itself, create a contract, keep state or change anyone else's.
    function test_runtime_holdsNoInstructionTheLaunchRulesForbid() public view {
        bytes memory code = address(proof).code;
        assertEq(Opcodes.count(code, Opcodes.DELEGATECALL), 0, "DELEGATECALL");
        assertEq(Opcodes.count(code, Opcodes.CALLCODE), 0, "CALLCODE");
        assertEq(Opcodes.count(code, Opcodes.SELFDESTRUCT), 0, "SELFDESTRUCT");
        assertEq(Opcodes.count(code, Opcodes.CREATE), 0, "CREATE");
        assertEq(Opcodes.count(code, Opcodes.CREATE2), 0, "CREATE2");
        // No storage of either kind, so no owner, no setting and nothing to pause.
        assertEq(Opcodes.count(code, Opcodes.SSTORE), 0, "SSTORE");
        assertEq(Opcodes.count(code, Opcodes.SLOAD), 0, "SLOAD");
        assertEq(Opcodes.count(code, Opcodes.TSTORE), 0, "TSTORE");
        assertEq(Opcodes.count(code, Opcodes.TLOAD), 0, "TLOAD");
        assertEq(Opcodes.count(code, Opcodes.ORIGIN), 0, "ORIGIN");
        // It reaches outside itself in one way only: a single read-only call, to the registry.
        assertEq(Opcodes.count(code, Opcodes.CALL), 0, "CALL");
        assertEq(Opcodes.count(code, Opcodes.STATICCALL), 1, "STATICCALL");
    }

    /// @dev The launch pipeline runs constructors on an empty chain, so a constructor may not call
    /// out or look at another account's code. The creation code is the constructor's part followed
    /// by the runtime; only the first part is examined here.
    function test_constructor_holdsNoCallAndNoCodeSizeCheck() public view {
        bytes memory creation = type(WorkProof).creationCode;
        uint256 constructorPart = creation.length - address(proof).code.length;
        assertGt(constructorPart, 0);
        assertLt(constructorPart, 400, "the constructor only stores one address");
        uint8[9] memory forbidden = [
            Opcodes.CALL,
            Opcodes.STATICCALL,
            Opcodes.DELEGATECALL,
            Opcodes.CALLCODE,
            Opcodes.EXTCODESIZE,
            Opcodes.EXTCODECOPY,
            Opcodes.EXTCODEHASH,
            Opcodes.CREATE,
            Opcodes.CREATE2
        ];
        for (uint256 i = 0; i < forbidden.length; ++i) {
            assertEq(
                Opcodes.count(creation, constructorPart, forbidden[i]), 0, "an instruction a constructor may not use"
            );
        }
    }

    // ---------------------------------------------------------------- the happy path

    function test_prove_returnsWhatTheRecordSays() public view {
        IWorkProof.Proof memory p = proof.prove(Rec.JOB, record, 6);
        assertEq(p.recordHash, recordHash);
        assertEq(p.kindHash, keccak256("audit"));
        assertEq(p.headHash, keccak256("Check "));
        assertEq(p.specHash, keccak256("the vault for rounding errors."));
        assertEq(p.stateHash, keccak256("completed"));
        assertEq(p.agentIds.length, 1);
        assertEq(p.agentIds[0], 52211);
    }

    function test_prove_equalsScanOnTheSameBytes() public view {
        for (uint256 headLen = 0; headLen <= 36; headLen += 9) {
            IWorkProof.Proof memory proven = proof.prove(Rec.JOB, record, headLen);
            (bytes16 jobId, IWorkProof.Proof memory scanned) = proof.scan(record, headLen);
            assertEq(jobId, Rec.JOB);
            assertEq(abi.encode(proven), abi.encode(scanned));
        }
    }

    function test_prove_asksTheRegistryExactlyOnceWithTheAbiEncodedJob() public {
        // 4 selector bytes, then the id left-aligned in a 32-byte word.
        bytes memory expected = abi.encodeWithSelector(bytes4(0xebe9712c), Rec.JOB);
        assertEq(expected.length, 36);
        vm.expectCall(address(registry), expected, 1);
        proof.prove(Rec.JOB, record, 0);
    }

    function test_prove_asksTheRegistryWithExactlyThirtySixBytes() public {
        // `expectCall` above matches a prefix of the calldata, so it would not notice bytes sent
        // after the argument. The real registry's source is not published and nothing says it
        // tolerates them. This stand-in answers only the exact call: the selector and the job's
        // word with its low half clear.
        WorkProof exact = new WorkProof(address(new ExactCallRegistry(recordHash)));
        assertEq(exact.prove(Rec.JOB, record, 0).recordHash, recordHash);
    }

    function test_prove_readsTheRegistryOnEveryCall() public {
        proof.prove(Rec.JOB, record, 0);
        // A later receipt replaces the hash; the older record stops proving.
        bytes32 newer = keccak256("a later receipt");
        registry.set(Rec.JOB, newer);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, newer, recordHash));
        proof.prove(Rec.JOB, record, 0);
    }

    function test_scan_needsNoRegistry() public {
        WorkProof alone = new WorkProof(address(0));
        (bytes16 jobId, IWorkProof.Proof memory p) = alone.scan(record, 0);
        assertEq(jobId, Rec.JOB);
        assertEq(p.recordHash, recordHash);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, Rec.JOB));
        alone.prove(Rec.JOB, record, 0);
    }

    // ---------------------------------------------------------------- NoReceipt

    function test_prove_unknownJobIsNoReceipt() public {
        bytes16 other = bytes16(uint128(Rec.JOB) + 1);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, other));
        proof.prove(other, record, 0);
    }

    function test_prove_registryThatRevertsIsNoReceipt() public {
        _expectNoReceipt(address(new RevertingRegistry()));
    }

    function test_prove_registryThatRevertsWithTheRightWordIsNoReceipt() public {
        // A revert is `NoReceipt` whatever it carries, even exactly one word that equals the
        // record's hash. Judging the answer by its size alone would let this one through.
        _expectNoReceipt(address(new RevertsWithOneWordRegistry(recordHash)));
        // The same word from a call that succeeds is a receipt, so the stand-in differs from a
        // working registry in nothing but the revert.
        WorkProof answered = new WorkProof(address(new FixedAnswerRegistry(recordHash, 32)));
        assertEq(answered.prove(Rec.JOB, record, 0).recordHash, recordHash);
    }

    function test_prove_registryThatReturnsNothingIsNoReceipt() public {
        _expectNoReceipt(address(new SilentRegistry()));
    }

    function test_prove_registryWithNoCodeIsNoReceipt() public {
        _expectNoReceipt(makeAddr("an account, not a contract"));
        _expectNoReceipt(address(0));
        // A precompile answers a call too; its answer is not a receipt for this record.
        _expectNoReceipt(address(0x04));
    }

    function test_prove_answerOfTheWrongSizeIsNoReceipt() public {
        // The right hash, in an answer that is not exactly one word.
        uint256[5] memory sizes = [uint256(0), 31, 33, 64, 4096];
        for (uint256 i = 0; i < sizes.length; ++i) {
            _expectNoReceipt(address(new FixedAnswerRegistry(recordHash, sizes[i])));
        }
        // Exactly one word carrying the right hash is, of course, accepted.
        WorkProof exact = new WorkProof(address(new FixedAnswerRegistry(recordHash, 32)));
        assertEq(exact.prove(Rec.JOB, record, 0).recordHash, recordHash);
    }

    function test_prove_zeroAnswerIsNoReceipt() public {
        _expectNoReceipt(address(new FixedAnswerRegistry(bytes32(0), 32)));
    }

    function test_prove_registryThatNeverReturnsIsNoReceipt_andCostsAtMostItsAllowance() public {
        WorkProof spun = new WorkProof(address(new SpinningRegistry()));
        uint256 before = gasleft();
        try spun.prove(Rec.JOB, record, 0) {
            fail();
        } catch (bytes memory reason) {
            assertEq(reason, abi.encodeWithSelector(IWorkProof.NoReceipt.selector, Rec.JOB));
        }
        // The registry was given 50,000 gas and no more, however much the caller had.
        assertLt(before - gasleft(), 50_000 + 40_000, "a spinning registry burned more than its allowance");
    }

    function test_prove_registryThatTriesToWriteIsNoReceipt() public {
        _expectNoReceipt(address(new WritingRegistry()));
    }

    // ---------------------------------------------------------------- HashMismatch, JobIdMismatch

    function test_prove_anotherDocumentIsHashMismatch() public {
        bytes memory other = bytes.concat(record);
        other[other.length - 2] = "x";
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, recordHash, keccak256(other)));
        proof.prove(Rec.JOB, other, 0);
    }

    function test_prove_trailingNewlineIsHashMismatch() public {
        // The mistake most worth guarding: a tool that appends a newline to the downloaded file.
        bytes memory withNewline = abi.encodePacked(record, "\n");
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, recordHash, keccak256(withNewline)));
        proof.prove(Rec.JOB, withNewline, 0);
        // And the scanner alone turns the same bytes away too.
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.Malformed.selector, record.length));
        proof.scan(withNewline, 0);
    }

    function test_prove_recordThatNamesAnotherJobIsJobIdMismatch() public {
        // The registry holds this very hash under another job id. The hash check passes; the
        // record's own `jobId` does not match the job being asked about.
        bytes16 other = 0xffffffffffffffffffffffffffffffff;
        registry.set(other, recordHash);
        vm.expectRevert(IWorkProof.JobIdMismatch.selector);
        proof.prove(other, record, 0);

        // The same with a registry that answers every job alike.
        WorkProof echo = new WorkProof(address(new FixedAnswerRegistry(recordHash, 32)));
        vm.expectRevert(IWorkProof.JobIdMismatch.selector);
        echo.prove(other, record, 0);
        assertEq(echo.prove(Rec.JOB, record, 0).recordHash, recordHash);
    }

    function testFuzz_prove_anyOtherJobIdFails(bytes16 jobId) public {
        vm.assume(jobId != Rec.JOB);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, jobId));
        proof.prove(jobId, record, 0);
    }

    function testFuzz_prove_anyChangedByteFails(uint256 at, uint8 flip) public {
        at = bound(at, 0, record.length - 1);
        flip = uint8(bound(flip, 1, 255));
        bytes memory changed = bytes.concat(record);
        changed[at] = bytes1(uint8(changed[at]) ^ flip);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, recordHash, keccak256(changed)));
        proof.prove(Rec.JOB, changed, 0);
    }

    // ---------------------------------------------------------------- parse errors reach the caller

    function test_prove_registeredButMalformedDocumentReverts() public {
        // Should the registry ever hold the hash of something that is not a v1 record, the proof
        // fails on the document, not on the hash.
        bytes memory notJson = "not a work record";
        registry.set(Rec.JOB, keccak256(notJson));
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.Malformed.selector, 0));
        proof.prove(Rec.JOB, notJson, 0);

        bytes memory noState = '{"jobId":"01234567-89ab-cdef-0123-456789abcdef","kind":"audit"}';
        registry.set(Rec.JOB, keccak256(noState));
        vm.expectRevert(IWorkProof.MissingKey.selector);
        proof.prove(Rec.JOB, noState, 0);

        Rec.Parts memory p = Rec.parts();
        p.schema = '"identitymd-work-v2"';
        bytes memory v2 = Rec.build(p);
        registry.set(Rec.JOB, keccak256(v2));
        vm.expectRevert(IWorkProof.WrongSchema.selector);
        proof.prove(Rec.JOB, v2, 0);
    }

    function test_prove_headLenPastTheObjectiveIsHeadTooLong() public {
        uint256 len = bytes("Check the vault for rounding errors.").length;
        proof.prove(Rec.JOB, record, len);
        vm.expectRevert(IWorkProof.HeadTooLong.selector);
        proof.prove(Rec.JOB, record, len + 1);
    }

    function test_prove_hashIsCheckedBeforeTheDocumentIsRead() public {
        // A malformed document that is not the registered one fails on the hash.
        bytes memory junk = "{{{{";
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, recordHash, keccak256(junk)));
        proof.prove(Rec.JOB, junk, 0);
    }

    // ---------------------------------------------------------------- gas cannot fake a missing receipt

    function test_prove_tooLittleGasIsInsufficientGas() public {
        try proof.prove{gas: 45_000}(Rec.JOB, record, 0) {
            fail();
        } catch (bytes memory reason) {
            assertEq(reason, abi.encodeWithSelector(WorkProof.InsufficientGas.selector));
        }
    }

    function testFuzz_prove_noGasAmountTurnsAReceiptIntoNoReceipt(uint256 gasGiven) public {
        // A registry that needs most of its allowance before it answers. Whatever gas the caller
        // sends, the outcome is a proof, `InsufficientGas`, or running out outright (no data); it is
        // never `NoReceipt` or `HashMismatch` for a receipt that is there.
        SlowRegistry slow = new SlowRegistry(44_000);
        slow.set(Rec.JOB, recordHash);
        WorkProof slowProof = new WorkProof(address(slow));
        gasGiven = bound(gasGiven, 5_000, 400_000);

        try slowProof.prove{gas: gasGiven}(Rec.JOB, record, 0) returns (IWorkProof.Proof memory p) {
            assertEq(p.recordHash, recordHash);
        } catch (bytes memory reason) {
            if (reason.length != 0) {
                assertEq(reason, abi.encodeWithSelector(WorkProof.InsufficientGas.selector), "unexpected error");
            }
        }
    }

    /// @dev WorkProof promises its registry 50,000 gas and refuses to start (`InsufficientGas`) when
    /// it could not hand that over. The promise holds only if the guard covers the charge for a cold
    /// account and the one 64th the caller keeps: with the guard lowered from 56,000 to 51,000 every
    /// other test here still passed, and this one fails for any value below about 53,500. The
    /// stand-in needs nearly its whole allowance, so a call that gets past a guard set too low
    /// starves it and a receipt that exists comes back as `NoReceipt`.
    ///
    /// The check bites when each call in a test is its own transaction (this toolchain's default),
    /// because the registry account is then cold, as it is in a real settlement.
    function test_prove_gasGuardLeavesTheRegistryItsWholeAllowance() public {
        SlowRegistry slow = new SlowRegistry(47_200);
        slow.set(Rec.JOB, recordHash);

        // The stand-in really does need most of the allowance, and no more than the allowance.
        bytes memory ask = abi.encodeWithSelector(bytes4(0xebe9712c), Rec.JOB);
        (bool withinAllowance,) = address(slow).staticcall{gas: 50_000}(ask);
        assertTrue(withinAllowance, "the stand-in must answer inside 50,000 gas");
        (bool withLess,) = address(slow).staticcall{gas: 47_000}(ask);
        assertFalse(withLess, "the stand-in must need more than 47,000 gas");

        WorkProof slowProof = new WorkProof(address(slow));
        uint256 proven;
        uint256 refused;
        for (uint256 gasGiven = 48_000; gasGiven <= 90_000; gasGiven += 23) {
            try slowProof.prove{gas: gasGiven}(Rec.JOB, record, 0) returns (IWorkProof.Proof memory p) {
                assertEq(p.recordHash, recordHash);
                ++proven;
            } catch (bytes memory reason) {
                // No data: the gas ran out somewhere, which names no error and misleads nobody.
                if (reason.length == 0) continue;
                assertEq(
                    reason,
                    abi.encodeWithSelector(WorkProof.InsufficientGas.selector),
                    "a receipt that exists was reported as something else"
                );
                ++refused;
            }
        }
        // The sweep crossed the guard: some calls were refused up front and some went through.
        assertGt(refused, 0, "no call was refused by the guard");
        assertGt(proven, 0, "no call got through");
    }

    function test_prove_slowRegistryWithinItsAllowanceStillProves() public {
        SlowRegistry slow = new SlowRegistry(44_000);
        slow.set(Rec.JOB, recordHash);
        WorkProof slowProof = new WorkProof(address(slow));
        assertEq(slowProof.prove(Rec.JOB, record, 0).recordHash, recordHash);

        // One that needs more than the allowance is treated as having no receipt.
        SlowRegistry tooSlow = new SlowRegistry(60_000);
        tooSlow.set(Rec.JOB, recordHash);
        _expectNoReceipt(address(tooSlow));
    }

    // ---------------------------------------------------------------- malformed calls

    function test_prove_jobIdWithStrayLowBytesIsRejectedByTheAbi() public view {
        // A bytes16 argument occupies the high half of its word. Calldata with anything in the low
        // half is not a valid encoding, and the call reverts before any proof is attempted.
        bytes memory call = abi.encodeCall(IWorkProof.prove, (Rec.JOB, record, 0));
        call[4 + 31] = 0x01;
        (bool ok,) = address(proof).staticcall(call);
        assertFalse(ok);
    }

    function _expectNoReceipt(address badRegistry) internal {
        WorkProof p = new WorkProof(badRegistry);
        vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, Rec.JOB));
        p.prove(Rec.JOB, record, 0);
    }
}
