// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {ProofFixtures} from "./utils/ProofFixtures.sol";
import {MockRegistry} from "./utils/Registries.sol";
import {Chunks} from "./utils/Chunks.sol";
import {GasMeter} from "./utils/GasMeter.sol";
import {Rec} from "./utils/Rec.sol";
import {Opcodes} from "./utils/Opcodes.sol";

/// @dev Creates a contract from inside a call, so that the gas of the creation can be read off
/// whether or not the test runner gives each top-level call a transaction of its own.
contract CreationMeter {
    function create(bytes memory initcode) external returns (address created, uint256 used) {
        uint256 before = gasleft();
        assembly ("memory-safe") {
            created := create(0, add(initcode, 0x20), mload(initcode))
        }
        used = before - gasleft();
        require(created != address(0), "creation failed");
    }
}

/// @notice What proving each real record costs, and guards on the scanner's unit costs.
/// Run `forge test --match-contract WorkProofGasTest -vv` to print the table.
///
/// @dev `exec` is the gas the call to WorkProof uses, with the registry (and every chunk) cold as
/// they would be in a real transaction. That holds when the runner isolates each top-level call
/// into its own transaction, which is this toolchain's default; with isolation switched off the
/// cool-down cheat code leaves accounts warm and every figure drops by 2,500 gas per account read.
/// `tx` adds what a transaction pays around it: 21,000, the calldata, and the EIP-7623 floor of 10
/// gas per calldata token (a zero byte is one token, any other byte four). For most records above a
/// few kilobytes the floor is the larger figure, and the proof's own execution then adds nothing to
/// what the sender pays. Chunked numbers exclude storing the chunks, which costs 200 gas per byte,
/// once, in separate transactions.
contract WorkProofGasTest is ProofFixtures {
    WorkProof internal proof;
    MockRegistry internal registry;
    GasMeter internal meter;

    uint256 internal constant HEAD_LEN = 85;
    /// @dev A transaction's own gas limit since EIP-7825.
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    /// @dev What calling an already-warm account costs; the meter's figure includes it.
    uint256 internal constant WARM_CALL = 100;

    function setUp() public {
        registry = new MockRegistry();
        proof = new WorkProof(address(registry));
        meter = new GasMeter();
    }

    function test_gas_everyFixture() public {
        string memory index = _index();
        uint256 n = _count(index);
        console2.log("bytes | scanned | prove exec | prove tx | one tx? | chunks | proveChunks exec | kind (state)");
        for (uint256 i = 0; i < n; ++i) {
            Fixture memory f = _fixture(index, i);
            if (!f.isLatest) continue;
            registry.set(f.jobId, f.recordHash);
            uint256 headLen = f.objectiveRawLen < HEAD_LEN ? f.objectiveRawLen : HEAD_LEN;

            bytes memory call = abi.encodeCall(IWorkProof.prove, (f.jobId, f.record, headLen));
            vm.cool(address(registry));
            uint256 exec = meter.measure(address(proof), call) - WARM_CALL;
            uint256 txGas = _txGas(call, exec);

            address[] memory chunks =
                Chunks.etch(vm, f.record, Chunks.MAX_SLICE, uint160(0xC0DE0000) + uint160(i) * 1000);
            vm.cool(address(registry));
            for (uint256 c = 0; c < chunks.length; ++c) {
                vm.cool(chunks[c]);
            }
            uint256 chunkExec = meter.measure(
                address(proof), abi.encodeCall(IWorkProof.proveChunks, (f.jobId, chunks, headLen))
            ) - WARM_CALL;

            console2.log(
                string.concat(
                    vm.toString(f.record.length),
                    " | ",
                    vm.toString(f.scanStopsAt),
                    " | ",
                    vm.toString(exec),
                    " | ",
                    vm.toString(txGas),
                    " | ",
                    txGas <= TX_GAS_CAP && f.record.length <= 128 * 1024 ? "yes" : "no",
                    " | ",
                    vm.toString(chunks.length),
                    " | ",
                    vm.toString(chunkExec),
                    " | ",
                    f.kind,
                    " (",
                    f.state,
                    ")"
                )
            );

            // A loose ceiling per record: a fixed part, what copying and hashing the whole record
            // costs anyone, and 45 gas per byte the scanner actually walks. A walk one byte at a
            // time would cost upwards of 60 per byte; the real figures sit well below the ceiling.
            uint256 words = (f.record.length + 31) / 32;
            uint256 copyAndHash = words * 12 + (words * words) / 512;
            assertLt(exec, 90_000 + copyAndHash + f.scanStopsAt * 45, f.file);
        }
    }

    function test_gas_referenceJob() public {
        Fixture memory f = _reference();
        registry.set(f.jobId, f.recordHash);
        bytes memory call = abi.encodeCall(IWorkProof.prove, (f.jobId, f.record, HEAD_LEN));
        vm.cool(address(registry));
        uint256 exec = meter.measure(address(proof), call) - WARM_CALL;
        assertLt(exec, 140_000, "proving the 7.3 KB reference record");
        // The floor on its calldata alone is larger than the standard charge plus this execution.
        assertEq(_txGas(call, exec), _txGas(call, 0), "the calldata floor covers the proof");
    }

    // ---------------------------------------------------------------- unit costs of the scanner

    /// @dev Long text is searched 32 bytes at a time. If the lane constants ever fall back to being
    /// copied out of the code at every use (see the note in JsonScan), this nearly doubles.
    function test_gas_longStringsCostUnderFiveGasPerByte() public view {
        uint256 small = _scanGas(_withObjective(_repeat("abcdefghijklmnopqrstuvwxyz012345", 100)));
        uint256 large = _scanGas(_withObjective(_repeat("abcdefghijklmnopqrstuvwxyz012345", 1100)));
        uint256 perByte = (large - small) * 100 / 32_000; // hundredths of a gas, hashing and copying included
        console2.log("gas per byte of long text, in hundredths:", perByte);
        assertLt(perByte, 500);
    }

    /// @dev The compiler's other way of supplying a 32-byte constant is to copy it out of the code,
    /// at about ten times the cost of pushing it, and it switches to that for any constant used
    /// four times or more (see the note above the lane constants in JsonScan). Nothing else in this
    /// contract copies code, so the instruction must not occur at all.
    function test_gas_noConstantIsCopiedOutOfTheCode() public view {
        assertEq(
            Opcodes.count(address(proof).code, Opcodes.CODECOPY), 0, "a lane constant is being copied out of the code"
        );
    }

    /// @dev Escapes that are not in front of a quote are never looked at.
    function test_gas_escapesInTextCostNothingExtra() public view {
        uint256 plain = _scanGas(_withObjective(_repeat("abcdefghijklmnopqrstuvwxyz0123xy", 500)));
        uint256 escaped = _scanGas(_withObjective(_repeat("abcdefghijklmnopqrstuvwxyz0123\\n", 500)));
        assertEq(escaped, plain, "a text full of \\n costs what plain text costs");
    }

    /// @dev Dense structure: short keys and values, as in `nodes` and `signals`.
    function test_gas_shortNestedStrings() public view {
        Rec.Parts memory p = Rec.parts();
        p.head = string.concat('"identity":{', string(_repeat('"abcdefgh":"abcdefgh",', 50)), '"x":1},');
        uint256 few = _scanGas(Rec.build(p));
        p.head = string.concat('"identity":{', string(_repeat('"abcdefgh":"abcdefgh",', 550)), '"x":1},');
        uint256 many = _scanGas(Rec.build(p));
        uint256 perString = (many - few) / 1000;
        console2.log("gas per short nested string:", perString);
        assertLt(perString, 420);
    }

    function test_gas_deepNestingIsLinear() public view {
        uint256 shallow = _scanGas(_nested(1000));
        uint256 deep = _scanGas(_nested(11_000));
        uint256 perLevel = (deep - shallow) / 10_000;
        console2.log("gas per nesting level (two brackets):", perLevel);
        assertLt(perLevel, 400);
    }

    // ---------------------------------------------------------------- ceilings
    //
    // The cost of a proof is the cost of walking the record as far as `state`. These tests pin the
    // worst the walk can cost per byte, so that the bounds stated in the NatSpec of `JsonScan` and
    // `WorkProof` stay true. Every figure includes copying and hashing the bytes (about 2.5 gas each).

    /// @dev Text is what a job participant writes, so text is where a bound matters most. Whatever a
    /// string holds, the walk through it stays under 20 gas a byte. Before the look-ahead after an
    /// escaped quote was added, the first of these patterns cost about 150.
    function test_gas_noTextCostsTwentyGasPerByte() public view {
        string[12] memory units = [
            '\\"', // a text of nothing but quotation marks
            '\\\\\\"', // the text \" over and over: a run of three
            '\\\\\\\\\\"', // a run of five
            '\\\\\\\\\\\\\\"', // a run of seven
            "\\\\", // nothing but backslashes
            'x\\"',
            'xx\\"',
            '\\"\\\\',
            '\\"\\\\\\\\x', // escaped quote, escaped backslash, escaped backslash, a letter
            'abcdefghijklmnopqrstuvwxyz0123\\"', // one escaped quote in every word, at its end
            '\\"abcdefghijklmnopqrstuvwxyz0123', // and at its start
            '{\\"key\\":\\"value\\",\\"n\\":1},' // JSON carried inside a string
        ];
        uint256 worst;
        for (uint256 i = 0; i < units.length; ++i) {
            uint256 perByte = _perByteOfText(bytes(units[i]));
            console2.log(string.concat("hundredths of a gas per byte of ", units[i], " :"), perByte);
            assertLt(perByte, 2000, units[i]);
            if (perByte > worst) worst = perByte;
        }
        console2.log("the costliest of these, in hundredths of a gas per byte:", worst);
        // A long run of backslashes in front of one quote is counted a word at a time as well.
        bytes memory longRun = abi.encodePacked(_repeat("\\\\", 250), '\\"');
        uint256 run = _perByteOfText(longRun);
        console2.log("hundredths of a gas per byte of 501 backslashes and a quote:", run);
        assertLt(run, 2000);
    }

    /// @dev The case a reviewer built to show the old limit: a `research` record, whose answers sit
    /// ahead of `state` and are walked in full, with one answer made of quotation marks. At 120 KB it
    /// needed more gas than a transaction may use; it now needs about an eighth of that.
    function test_gas_quoteDenseResearchRecordFitsOneTransaction() public view {
        bytes memory record = _recordOfSize(',"research":[{"answer":"', '\\"', '"}]', false, 120 * 1024);
        uint256 exec = _scanGas(record);
        uint256 txGas = 21_000 + 16 * record.length + exec;
        console2.log("120 KB record, one answer of quotation marks: gas to scan, gas for the transaction");
        console2.log(exec, txGas);
        assertLt(txGas, TX_GAS_CAP / 3, "text alone must not bring a record near the transaction's gas limit");
    }

    /// @dev Between strings the walk is a byte at a time, and here the bound is a real limit: up to
    /// about 200 gas a byte. Only the writer decides a record's structure, and no record examined
    /// comes near this (the costliest real proof is under 700,000 gas), but the limit is stated, so
    /// it is pinned: structure ahead of `state` costs at most 200 gas a byte, which lets 64 KB of the
    /// costliest shape through in one transaction and would not let 80 KB through.
    function test_gas_bareStructureCeiling() public view {
        // Nested arrays, empty arrays, numbers, empty strings: the densest things JSON can hold.
        uint256 nested = _perByte(_nested(2_000), _nested(18_000), 32_000);
        uint256 empties = _perByteOfMember("[],", "[]");
        uint256 numbers = _perByteOfMember("1234567,", "0");
        uint256 literals = _perByteOfMember("null,", "null");
        uint256 strings = _perByteOfMember('"",', '""');
        // Short strings made of quotation marks. With one mark the look-ahead is spent on finding
        // the end of the string one byte further on, which is the costliest shape there is. With
        // fifteen it pays for itself.
        uint256 quoted = _perByteOfMember(QUOTED, '""');
        uint256 packed = _perByteOfMember('"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"",', '""');
        console2.log("hundredths of a gas per byte: nested brackets, empty arrays", nested, empties);
        console2.log("hundredths of a gas per byte: numbers, null, empty strings", numbers, literals, strings);
        console2.log("hundredths of a gas per byte: strings of one and of fifteen quotation marks", quoted, packed);
        assertLt(nested, 20_000);
        assertLt(empties, 20_000);
        assertLt(numbers, 20_000);
        assertLt(literals, 20_000);
        assertLt(strings, 20_000);
        assertLt(quoted, 20_000);
        assertLt(packed, 20_000);

        bytes memory fits = _recordOfSize('"assessments":[', QUOTED, '""],', true, 64 * 1024);
        uint256 txGas = 21_000 + 16 * fits.length + _scanGas(fits);
        console2.log("64 KB of the costliest shape ahead of state: gas for the transaction", txGas);
        assertLt(txGas, TX_GAS_CAP, "64 KB of the costliest structure must still be provable in one transaction");
    }

    /// @dev `"\"",` five bytes: a string holding one escaped quotation mark, and a comma.
    bytes internal constant QUOTED = '"\\"",';

    /// @dev What deploying the contract costs. `create` is the creation as a factory pays for it
    /// (the CREATE itself: 32,000, the constructor's run and 200 gas per byte of code kept); a plain
    /// creation transaction adds 21,000 and the charge for carrying the initcode as calldata. The
    /// launch this contract belongs to must fit 12M gas as a whole.
    function test_gas_deployment() public {
        bytes memory initcode = abi.encodePacked(type(WorkProof).creationCode, abi.encode(address(registry)));
        (address created, uint256 create) = new CreationMeter().create(initcode);
        uint256 asTransaction = _txGas(initcode, create);
        console2.log("initcode bytes with its argument, runtime bytes:", initcode.length, created.code.length);
        console2.log("gas for the creation, and as a transaction of its own:", create, asTransaction);
        assertEq(WorkProof(created).WORK_REGISTRY(), address(registry));
        assertLt(created.code.length, 23_000, "runtime size gate");
        assertLt(initcode.length, 46_000, "initcode size gate");
        assertLt(asTransaction, 1_300_000);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Gas per byte, in hundredths, of an objective made of `unit` repeated: the difference
    /// between a 6 KB and a 70 KB text, so that everything fixed drops out.
    function _perByteOfText(bytes memory unit) internal view returns (uint256) {
        uint256 small = 6_400 / unit.length;
        uint256 large = 70_400 / unit.length;
        return _perByte(
            _withObjective(_repeat(unit, small)), _withObjective(_repeat(unit, large)), (large - small) * unit.length
        );
    }

    /// @dev The same for a top-level array holding `unit` repeated and then `last`.
    function _perByteOfMember(bytes memory unit, bytes memory last) internal view returns (uint256) {
        uint256 small = 6_400 / unit.length;
        uint256 large = 38_400 / unit.length;
        return _perByte(_withArray(unit, last, small), _withArray(unit, last, large), (large - small) * unit.length);
    }

    function _perByte(bytes memory smaller, bytes memory larger, uint256 bytesBetween) internal view returns (uint256) {
        return (_scanGas(larger) - _scanGas(smaller)) * 100 / bytesBetween;
    }

    function _withArray(bytes memory unit, bytes memory last, uint256 times) internal pure returns (bytes memory) {
        Rec.Parts memory p = Rec.parts();
        p.head = string(abi.encodePacked('"assessments":[', _repeat(unit, times), last, "],"));
        return Rec.build(p);
    }

    /// @dev A canonical record of exactly `size` bytes holding `opening`, then as many copies of
    /// `unit` as fit, then `closing`: at the front of the record when `atFront`, or right after the
    /// objective otherwise (where `research` belongs in key order). What is left over is padded into
    /// the objective.
    function _recordOfSize(bytes memory opening, bytes memory unit, bytes memory closing, bool atFront, uint256 size)
        internal
        pure
        returns (bytes memory record)
    {
        uint256 n = (size - _assemble(opening, unit, closing, atFront, 0, 0).length) / unit.length;
        uint256 padding = size - _assemble(opening, unit, closing, atFront, n, 0).length;
        record = _assemble(opening, unit, closing, atFront, n, padding);
        require(record.length == size, "record size");
    }

    function _assemble(
        bytes memory opening,
        bytes memory unit,
        bytes memory closing,
        bool atFront,
        uint256 n,
        uint256 padding
    ) internal pure returns (bytes memory) {
        Rec.Parts memory p = Rec.parts();
        bytes memory member = abi.encodePacked(opening, _repeat(unit, n), closing);
        bytes memory objective = abi.encodePacked('"', _repeat("x", padding), Rec.inner(p.objective), '"');
        if (atFront) {
            p.head = string(member);
            p.objective = string(objective);
        } else {
            p.objective = string(abi.encodePacked(objective, member));
        }
        return Rec.build(p);
    }

    function _scanGas(bytes memory record) internal view returns (uint256) {
        return meter.measure(address(proof), abi.encodeCall(IWorkProof.scan, (record, 0)));
    }

    function _withObjective(bytes memory text) internal pure returns (bytes memory) {
        Rec.Parts memory p = Rec.parts();
        p.objective = string(abi.encodePacked('"', text, '"'));
        return Rec.build(p);
    }

    function _nested(uint256 depth) internal pure returns (bytes memory) {
        Rec.Parts memory p = Rec.parts();
        p.head = string(abi.encodePacked('"identity":', _repeat("[", depth), _repeat("]", depth), ","));
        return Rec.build(p);
    }

    function _repeat(bytes memory unit, uint256 times) internal pure returns (bytes memory out) {
        out = new bytes(unit.length * times);
        uint256 len = unit.length;
        for (uint256 i = 0; i < times; ++i) {
            assembly ("memory-safe") {
                mcopy(add(add(out, 0x20), mul(i, len)), add(unit, 0x20), len)
            }
        }
    }

    /// @dev Gas a transaction with this calldata and this much execution pays, EIP-7623 included.
    function _txGas(bytes memory data, uint256 exec) internal pure returns (uint256) {
        uint256 zeros = 0;
        for (uint256 i = 0; i < data.length; ++i) {
            if (data[i] == 0) ++zeros;
        }
        uint256 nonZeros = data.length - zeros;
        uint256 standard = 21_000 + 4 * zeros + 16 * nonZeros + exec;
        uint256 floor = 21_000 + 10 * (zeros + 4 * nonZeros);
        return standard > floor ? standard : floor;
    }
}
