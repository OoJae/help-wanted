// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {DeskToken} from "./mocks/DeskToken.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {RegistryStandIn} from "../kit/RegistryStandIn.sol";

/// The desk against the real WorkProof with records of two other makes than the rest of the desk
/// tests use: canonical work-record JSON written out here member by member, so that a test can
/// shape every part of a record (its padding, its signals, an objective of any length), and three
/// real records left exactly as IdentityMD served them, which were written for no order of ours.
///
/// It asserts what the desk does (who is paid, which state follows), not which error WorkProof
/// picks for a record it refuses.
contract WorkOrdersRealProofTest is Test {
    WorkOrders internal desk;
    WorkProof internal proof;
    RegistryStandIn internal registry;
    DeskToken internal imd;
    PayrollStandIn internal payroll;

    address internal employer = makeAddr("real.employer");
    address internal runner = makeAddr("real.runner");
    address internal challenger = makeAddr("real.challenger");
    address internal stranger = makeAddr("real.stranger");

    string internal constant KIND = "audit";
    bytes internal constant SPEC =
        "Audit the repository at the pinned commit and report every finding. Inputs: repoUrl=https://example.org/r; baseCommit=0123abcd";
    bytes16 internal constant JOB = bytes16(0x0123456789abcdef0123456789abcdef);
    /// Real jobs whose records are in the fixtures.
    bytes16 internal constant BLOCKED_JOB = bytes16(0x9012ff0b2ded4ea58f4a7a208492eb29);
    bytes16 internal constant TWICE_JOB = bytes16(0x97804d2b86b747a6a55834ca31c469d9);
    uint96 internal constant BOND = 0.25e18;
    uint96 internal constant PAY = 4e18;
    uint256 internal constant FUNDS = 1_000e18;
    uint256 internal constant START = 1_760_000_000;

    function setUp() public {
        vm.warp(START);
        imd = new DeskToken();
        registry = new RegistryStandIn();
        proof = new WorkProof(address(registry));
        payroll = new PayrollStandIn(address(imd));
        desk = new WorkOrders(address(imd), address(proof), address(payroll));
        address[4] memory cast = [employer, runner, challenger, stranger];
        for (uint256 i; i < cast.length; ++i) {
            imd.mint(cast[i], FUNDS);
            vm.prank(cast[i]);
            imd.approve(address(desk), type(uint256).max);
        }
    }

    // --- helpers ------------------------------------------------------------------------------

    /// @dev Every character a spec may hold, with a space in the middle: 0x21 to 0x7E without `"`
    /// and `\`. If the desk's character rule and the real scanner disagreed on any of them, the
    /// proven loop could not settle.
    function _everyAllowedCharacter() internal pure returns (bytes memory spec) {
        for (uint256 c = 0x21; c <= 0x7e; ++c) {
            if (c == 0x22 || c == 0x5c) continue;
            spec = abi.encodePacked(spec, bytes1(uint8(c)));
            if (c == 0x50) spec = abi.encodePacked(spec, " ");
        }
    }

    function _open(bytes memory spec, uint8 flags) internal returns (uint256 id) {
        IWorkOrders.OrderParams memory p;
        p.kindHash = keccak256(bytes(KIND));
        p.minPay = PAY;
        p.maxPay = PAY;
        p.deliverySecs = 3 days;
        p.expiresAt = uint40(START + 30 days);
        p.bond = BOND;
        p.flags = flags;
        vm.prank(employer);
        id = desk.createOrder(p, spec);
    }

    /// @dev An order held by `runner` with `jobId` registered.
    function _registered(bytes memory spec, uint8 flags, bytes16 jobId) internal returns (uint256 id) {
        id = _open(spec, flags);
        vm.prank(runner);
        desk.claim(id);
        vm.prank(runner);
        desk.register(id, jobId);
    }

    function _uuid(bytes16 jobId) internal pure returns (bytes memory out) {
        bytes16 digits = "0123456789abcdef";
        for (uint256 i; i < 16; ++i) {
            if (i == 4 || i == 6 || i == 8 || i == 10) out = abi.encodePacked(out, "-");
            out = abi.encodePacked(out, digits[uint8(jobId[i]) >> 4], digits[uint8(jobId[i]) & 0x0f]);
        }
    }

    /// @dev A canonical work record with the members the scanner reads, then `padding` bytes of
    /// submissions after `state`, where real records keep most of their bulk.
    function _recordOf(
        bytes16 jobId,
        string memory kind,
        bytes memory objective,
        string memory signals,
        string memory state,
        uint256 padding
    ) internal pure returns (bytes memory) {
        bytes memory filler = new bytes(padding);
        for (uint256 i; i < padding; ++i) {
            filler[i] = "x";
        }
        return abi.encodePacked(
            '{"jobId":"',
            _uuid(jobId),
            '","kind":"',
            kind,
            '","objective":"',
            objective,
            '","schema":"identitymd-work-v1","signals":',
            signals,
            ',"state":"',
            state,
            '","submissions":"',
            filler,
            '"}'
        );
    }

    /// @dev The record of a job done exactly as the order's current claim asks.
    function _goodRecord(uint256 id, bytes memory spec, uint256 padding) internal view returns (bytes memory) {
        return
            _recordOf(JOB, KIND, bytes.concat(desk.headerOf(id), spec), '[{"agentId":"52211"}]', "completed", padding);
    }

    /// @dev The registry writes (or replaces) the job's receipt.
    function _land(bytes16 jobId, bytes memory record) internal {
        registry.set(jobId, keccak256(record));
    }

    function _fixture(string memory name) internal view returns (bytes memory) {
        return vm.parseBytes(vm.readFile(string.concat("test/fixtures/proof/records/", name, ".hex")));
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _assertState(uint256 id, IWorkOrders.State s) internal view {
        assertEq(uint8(desk.stateOf(id)), uint8(s), "state");
    }

    // --- the proven path ----------------------------------------------------------------------

    /// The whole proven loop against the real scanner, with a spec made of every allowed character.
    function test_real_provenLoopSettles() public {
        bytes memory spec = _everyAllowedCharacter();
        uint256 id = _open(spec, 0);
        vm.prank(runner);
        bytes32 ticket = desk.claim(id);
        bytes memory header = desk.headerOf(id);
        assertEq(header.length, 85);
        assertEq(ticket, keccak256(abi.encode(block.chainid, address(desk), id, uint256(1), runner)));
        vm.prank(runner);
        desk.register(id, JOB);

        bytes memory record = _recordOf(
            JOB,
            KIND,
            bytes.concat(header, spec),
            '[{"agentId":"52211","tag1":"x"},{"agentId":"777"}]',
            "completed",
            7_000
        );
        _land(JOB, record);

        vm.prank(stranger);
        desk.settle(id, record, _none());
        _assertState(id, IWorkOrders.State.Delivered);
        assertTrue(desk.orderOf(id).proven);
        assertEq(desk.orderOfJob(JOB), id);
        assertEq(desk.claimOf(id).recordHash, keccak256(record));
        assertEq(imd.balanceOf(runner), FUNDS + 3.6e18);
        assertEq(imd.balanceOf(address(payroll)), 0.4e18);
        assertEq(imd.balanceOf(address(desk)), 0);
        uint256[] memory agents = payroll.lastAgentIds();
        assertEq(agents.length, 2);
        assertEq(agents[0], 52211);
        assertEq(agents[1], 777);
    }

    /// The same with the record stored across data contracts, for records too large to send.
    function test_real_settlesFromChunks() public {
        uint256 id = _registered(SPEC, 0, JOB);
        bytes memory record = _goodRecord(id, SPEC, 3_000);
        _land(JOB, record);
        uint256 cut = record.length / 3;
        bytes memory a = new bytes(cut);
        bytes memory b = new bytes(record.length - cut);
        for (uint256 i; i < record.length; ++i) {
            if (i < cut) a[i] = record[i];
            else b[i - cut] = record[i];
        }
        address[] memory chunks = new address[](2);
        chunks[0] = address(0xC0FFEE01);
        chunks[1] = address(0xC0FFEE02);
        vm.etch(chunks[0], bytes.concat(hex"00", a));
        vm.etch(chunks[1], bytes.concat(hex"00", b));
        desk.settle(id, "", chunks);
        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(desk.claimOf(id).recordHash, keccak256(record));
    }

    /// Nothing but the exact receipt pays: one byte more, another runner's header, another spec.
    function test_real_onlyTheExactReceiptPays() public {
        uint256 id = _registered(SPEC, 0, JOB);
        bytes memory record = _goodRecord(id, SPEC, 500);

        vm.expectRevert();
        desk.settle(id, record, _none());

        _land(JOB, record);
        vm.expectRevert();
        desk.settle(id, bytes.concat(record, " "), _none());

        // A record for the same order under another runner's ticket.
        bytes32 otherTicket = keccak256(abi.encode(block.chainid, address(desk), id, uint256(1), stranger));
        bytes memory otherHeader = abi.encodePacked("[help-wanted order ", _hex(otherTicket), "] ");
        assertEq(otherHeader.length, 85);
        bytes memory forOther = _recordOf(JOB, KIND, bytes.concat(otherHeader, SPEC), "[]", "completed", 0);
        _land(JOB, forOther);
        vm.expectRevert(IWorkOrdersRunner.WrongHeader.selector);
        desk.settle(id, forOther, _none());

        bytes memory otherSpec =
            _recordOf(JOB, KIND, bytes.concat(desk.headerOf(id), SPEC, " and more"), "[]", "completed", 0);
        _land(JOB, otherSpec);
        vm.expectRevert(IWorkOrdersRunner.WrongSpec.selector);
        desk.settle(id, otherSpec, _none());

        _land(JOB, record);
        desk.settle(id, record, _none());
        _assertState(id, IWorkOrders.State.Delivered);
    }

    function _hex(bytes32 word) internal pure returns (bytes memory out) {
        bytes16 digits = "0123456789abcdef";
        out = new bytes(64);
        for (uint256 i; i < 32; ++i) {
            out[2 * i] = digits[uint8(word[i]) >> 4];
            out[2 * i + 1] = digits[uint8(word[i]) & 0x0f];
        }
    }

    /// What a settlement costs with the real scanner, for the report: a 7 KB record, as large as
    /// the real research report in the fixtures.
    function test_real_settleGas() public {
        uint256 id = _registered(SPEC, 0, JOB);
        bytes memory record = _goodRecord(id, SPEC, 7_000);
        _land(JOB, record);
        uint256 before = gasleft();
        desk.settle(id, record, _none());
        uint256 used = before - gasleft();
        emit log_named_uint("record bytes", record.length);
        emit log_named_uint("settle gas (execution, real WorkProof, mock Payroll)", used);
        assertLt(used, 1_000_000);
    }

    // --- receipts that do not settle ----------------------------------------------------------

    /// A job the swarm ended "blocked" (the live registry does hold such receipts) frees the order
    /// and returns the runner's bond.
    function test_real_blockedJobFreesTheOrderAndReturnsTheBond() public {
        uint256 id = _registered(SPEC, 0, JOB);
        bytes memory record = _recordOf(JOB, KIND, bytes.concat(desk.headerOf(id), SPEC), "[]", "blocked", 100);
        _land(JOB, record);

        vm.expectRevert(IWorkOrdersRunner.NotCompleted.selector);
        desk.settle(id, record, _none());
        vm.prank(stranger);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.reportFailed(id, record, _none());
        vm.prank(runner);
        desk.reportFailed(id, record, _none());
        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner), FUNDS);
    }

    /// Completed, this claim's objective, but under another kind: anyone frees the order and the
    /// runner keeps its bond.
    function test_real_anotherKindFreesTheOrder() public {
        uint256 id = _registered(SPEC, 0, JOB);
        bytes memory record = _recordOf(JOB, "single", bytes.concat(desk.headerOf(id), SPEC), "[]", "completed", 100);
        _land(JOB, record);
        vm.expectRevert(IWorkOrdersRunner.WrongKind.selector);
        desk.settle(id, record, _none());
        vm.prank(stranger);
        desk.reportFailed(id, record, _none());
        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner), FUNDS);
        assertEq(imd.balanceOf(employer), FUNDS - PAY);
    }

    /// A runner registers a real job that is plainly somebody else's: a real completed job of the
    /// kind the order asks for, read by the real scanner. Anyone reports it and the bond goes to
    /// the employer.
    function test_real_aRealJobOpenedForSomethingElseIsAWrongJob() public {
        bytes memory record = _fixture("97804d2b-single-56cfc4e2");
        assertEq(keccak256(record), 0x56cfc4e2e4c6a1395d96349c2a39c5ba16351881916539b32a188f13936eb4dc);
        IWorkOrders.OrderParams memory p;
        p.kindHash = keccak256("single");
        p.minPay = PAY;
        p.maxPay = PAY;
        p.deliverySecs = 3 days;
        p.expiresAt = uint40(START + 30 days);
        p.bond = BOND;
        vm.prank(employer);
        uint256 id = desk.createOrder(p, SPEC);
        vm.prank(runner);
        desk.claim(id);
        vm.prank(runner);
        desk.register(id, TWICE_JOB);
        _land(TWICE_JOB, record);

        // Completed and of the order's kind, but its objective is not this claim's.
        vm.expectRevert(IWorkOrdersRunner.WrongHeader.selector);
        desk.settle(id, record, _none());
        vm.prank(stranger);
        desk.reportFailed(id, record, _none());
        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(employer), FUNDS - PAY + BOND);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
    }

    /// The same with the reference job of `README.md` (e9efec16), its record exactly as IdentityMD
    /// served it and as the registry holds it on chain: completed, of the kind the order asks for,
    /// and written for somebody else's objective. It can pay nobody here.
    function test_real_theReferenceRecordUnchangedIsAWrongJobOnAnyOrder() public {
        bytes16 referenceJob = bytes16(0xe9efec1656f340d3924352c453effc7d);
        bytes memory record = _fixture("e9efec16-skill-research-report-3db99325");
        assertEq(keccak256(record), 0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5);
        IWorkOrders.OrderParams memory p;
        p.kindHash = keccak256("skill:research-report");
        p.minPay = PAY;
        p.maxPay = PAY;
        p.deliverySecs = 3 days;
        p.expiresAt = uint40(START + 30 days);
        p.bond = BOND;
        vm.prank(employer);
        uint256 id = desk.createOrder(p, SPEC);
        vm.prank(runner);
        desk.claim(id);
        vm.prank(runner);
        desk.register(id, referenceJob);
        _land(referenceJob, record);

        (bytes16 stated, IWorkProof.Proof memory read) = proof.scan(record, 85);
        assertEq(stated, referenceJob);
        assertEq(read.kindHash, p.kindHash, "the kind matches the order's");
        assertEq(read.stateHash, keccak256("completed"));

        vm.expectRevert(IWorkOrdersRunner.WrongHeader.selector);
        desk.settle(id, record, _none());
        vm.prank(stranger);
        desk.reportFailed(id, record, _none());
        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(employer), FUNDS - PAY + BOND);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(desk.orderOfJob(referenceJob), 0, "a job that settled nothing is tied to nothing");
    }

    /// The real audit that ended blocked: registered on an order it was never opened for, it is a
    /// wrong job (the objective decides that, before the state is looked at).
    function test_real_aRealBlockedJobOpenedForSomethingElseIsAWrongJob() public {
        bytes memory record = _fixture("9012ff0b-audit-c31895f6");
        uint256 id = _registered(SPEC, 0, BLOCKED_JOB);
        _land(BLOCKED_JOB, record);
        vm.prank(stranger);
        desk.reportFailed(id, record, _none());
        assertEq(imd.balanceOf(employer), FUNDS - PAY + BOND);
    }

    /// @dev An order held by `runner`, who registered a job whose objective is eleven bytes long.
    function _strayJob(uint8 flags) internal returns (uint256 id, bytes memory record) {
        id = _registered(SPEC, flags, JOB);
        record = _recordOf(JOB, KIND, "hello world", "[]", "completed", 100);
        _land(JOB, record);
    }

    /// A registered job whose objective is shorter than a header can still be reported: the bond
    /// goes to the employer at once instead of after the whole delivery time.
    function test_real_aJobWithAShortObjectiveCanBeReported() public {
        (uint256 id, bytes memory record) = _strayJob(0);
        // The receipt is real as far as the registry goes, and the scanner reads it.
        (bytes16 stated,) = proof.scan(record, 0);
        assertEq(stated, JOB);
        vm.expectRevert();
        desk.settle(id, record, _none());

        vm.prank(stranger);
        desk.reportFailed(id, record, _none());
        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(employer), FUNDS - PAY + BOND);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
    }

    /// The same inside a dispute: the challenger can use the receipt.
    function test_real_aChallengerCanUseAReceiptWithAShortObjective() public {
        (uint256 id, bytes memory record) = _strayJob(1);
        vm.prank(runner);
        desk.claimDelivered(id, keccak256(record));
        vm.prank(challenger);
        desk.challenge(id);

        vm.prank(challenger);
        desk.reportFailed(id, record, _none());
        _assertState(id, IWorkOrders.State.Open);
        uint256 cut = uint256(BOND) / 10;
        assertEq(imd.balanceOf(challenger), FUNDS + BOND - cut);
        assertEq(imd.balanceOf(employer), FUNDS - PAY + cut);
        assertEq(imd.balanceOf(address(desk)), PAY);
    }

    /// A short objective is the only case in which the desk asks WorkProof a second time. A record
    /// that is not the registry's receipt gains nothing by it.
    function test_real_aShortObjectiveThatIsNotTheReceiptProvesNothing() public {
        (uint256 id, bytes memory record) = _strayJob(0);
        bytes memory other = _recordOf(JOB, KIND, "hello", "[]", "completed", 100);
        vm.prank(stranger);
        vm.expectRevert();
        desk.reportFailed(id, other, _none());
        // With no receipt at all, the same.
        registry.set(JOB, bytes32(0));
        vm.prank(stranger);
        vm.expectRevert();
        desk.reportFailed(id, record, _none());
        _assertState(id, IWorkOrders.State.Registered);
    }

    /// The stated limit of `reportFailed`: a receipt WorkProof cannot read at all (here: not a v1
    /// work record) can be neither settled nor reported, and the claim ends by timeout.
    function test_real_anUnreadableReceiptEndsByTimeout() public {
        uint256 id = _registered(SPEC, 0, JOB);
        bytes memory record = abi.encodePacked(
            '{"jobId":"',
            _uuid(JOB),
            '","kind":"audit","objective":"x","schema":"identitymd-work-v2","state":"completed"}'
        );
        _land(JOB, record);
        vm.expectRevert();
        desk.settle(id, record, _none());
        vm.prank(runner);
        vm.expectRevert();
        desk.reportFailed(id, record, _none());
        _assertState(id, IWorkOrders.State.Registered);

        vm.warp(START + 3 days);
        desk.timeout(id);
        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(employer), FUNDS - PAY + BOND);
    }

    // --- the claimed path and a job's second receipt ------------------------------------------

    /// Two real receipts of one real job (97804d2b), read by the real scanner: same kind, same
    /// objective, both "completed"; only the hash differs, and the second names no agents. This is
    /// why the hash named in a delivery claim decides nothing.
    function test_real_twoRealReceiptsOfOneJobSayTheSameThing() public view {
        bytes memory first = _fixture("97804d2b-single-b57f8912");
        bytes memory second = _fixture("97804d2b-single-56cfc4e2");
        (bytes16 jobA, IWorkProof.Proof memory a) = proof.scan(first, 85);
        (bytes16 jobB, IWorkProof.Proof memory b) = proof.scan(second, 85);
        assertEq(jobA, TWICE_JOB);
        assertEq(jobB, TWICE_JOB);
        assertEq(a.recordHash, 0xb57f89128f5fb7b4f78c710f617d46001a588d2810255a28c2271c8b7b599d86);
        assertEq(b.recordHash, 0x56cfc4e2e4c6a1395d96349c2a39c5ba16351881916539b32a188f13936eb4dc);
        assertEq(a.kindHash, b.kindHash, "same kind");
        assertEq(a.headHash, b.headHash, "same first 85 bytes of the objective");
        assertEq(a.specHash, b.specHash, "same rest of the objective");
        assertEq(a.stateHash, keccak256("completed"));
        assertEq(b.stateHash, keccak256("completed"));
        assertEq(a.agentIds.length, 1, "the first receipt names the agent");
        assertEq(b.agentIds.length, 0, "the second, which is latest(jobId) on chain, names nobody");
    }

    /// A runner claims delivery naming its job's first record and is challenged. The registry then
    /// moves on to the job's second receipt, as it did for the real job above. The second receipt
    /// pays the runner and cannot be used against it; the first can no longer be proven at all.
    function test_real_aSecondReceiptPaysADisputedClaim() public {
        uint256 id = _registered(SPEC, 1, JOB);
        bytes memory objective = bytes.concat(desk.headerOf(id), SPEC);
        bytes memory first = _recordOf(JOB, KIND, objective, '[{"agentId":"51017"}]', "completed", 200);
        bytes memory second = _recordOf(JOB, KIND, objective, "[]", "completed", 120);
        vm.prank(runner);
        desk.claimDelivered(id, keccak256(first));
        vm.prank(challenger);
        desk.challenge(id);

        _land(JOB, first);
        _land(JOB, second);
        vm.expectRevert();
        desk.settle(id, first, _none());
        vm.prank(challenger);
        vm.expectRevert(IWorkOrdersRunner.NotFailed.selector);
        desk.reportFailed(id, second, _none());

        desk.settle(id, second, _none());
        _assertState(id, IWorkOrders.State.Delivered);
        assertEq(imd.balanceOf(runner), FUNDS + 3.6e18 + BOND, "pay, and the challenger's bond");
        assertEq(imd.balanceOf(challenger), FUNDS - BOND);
        assertEq(desk.claimOf(id).recordHash, keccak256(second));
        assertEq(payroll.lastAgentIds().length, 0, "the second receipt names no agents");
    }

    /// An order paid on an unchallenged claim is stamped with whichever receipt the registry holds.
    function test_real_stampAfterAnUnprovenDelivery() public {
        uint256 id = _registered(SPEC, 1, JOB);
        bytes memory record = _goodRecord(id, SPEC, 300);
        vm.prank(runner);
        desk.claimDelivered(id, keccak256("the hash the API listed"));
        vm.warp(START + 24 hours);
        desk.finalize(id);
        assertFalse(desk.orderOf(id).proven);

        vm.expectRevert();
        desk.stamp(id, record, _none());
        _land(JOB, record);
        desk.stamp(id, record, _none());
        assertTrue(desk.orderOf(id).proven);
        assertEq(desk.orderOfJob(JOB), id);
        assertEq(desk.claimOf(id).recordHash, keccak256(record));
    }

    /// A blocked receipt refutes a challenged claim: the release share to the employer, the rest
    /// of the runner's bond and its own to the challenger.
    function test_real_aBlockedReceiptRefutesADisputedClaim() public {
        uint256 id = _registered(SPEC, 1, JOB);
        bytes memory record = _recordOf(JOB, KIND, bytes.concat(desk.headerOf(id), SPEC), "[]", "blocked", 50);
        vm.prank(runner);
        desk.claimDelivered(id, keccak256(record));
        vm.prank(challenger);
        desk.challenge(id);
        _land(JOB, record);
        vm.prank(stranger);
        desk.reportFailed(id, record, _none());
        uint256 cut = uint256(BOND) / 10;
        assertEq(imd.balanceOf(challenger), FUNDS + BOND - cut);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - PAY + cut);
        _assertState(id, IWorkOrders.State.Open);
    }
}
