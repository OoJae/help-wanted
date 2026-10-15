// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IQuestions} from "../../src/interfaces/IQuestions.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {OracleAttestation} from "../../src/questions/OracleAttestation.sol";
import {QuestionBody} from "../../src/questions/QuestionBody.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {MockIntake} from "./mocks/MockIntake.sol";

/// @dev A token with no rule against the zero address, for one purpose. The three proof requests
/// were bought from a wallet with no callback, so the oracle signed their answers for no consumer:
/// the attestation's domain names the zero address. To put those real signatures through the real
/// callback, `Questions` is placed at the zero address here, and its meter must be able to hold and
/// pay out tokens there. Nothing else differs from a plain ERC-20.
contract OpenToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev The stand-in Intake with one more door. An Intake, the real one too, takes a request
/// whose payer is the zero address for one it never saw and will not complete it, and with
/// `Questions` placed at the zero address that is every request. `deliverToZeroPayer` does for
/// such a request what `complete` does for an answered one: the callback, once, under the stipend,
/// with the gas it used measured around the call as the other callback gas tests measure it.
contract ZeroPayerIntake is MockIntake {
    constructor(address payTo_, address writer_) MockIntake(payTo_, writer_) {}

    function deliverToZeroPayer(bytes32 requestId, bytes calldata args)
        external
        returns (bool delivered, uint256 used)
    {
        Request storage stored = requests[requestId];
        require(msg.sender == writer, "not the writer");
        require(stored.callbackSelector != bytes4(0) && !stored.completed, "not a pending request");
        stored.completed = true;
        bytes memory data = bytes.concat(stored.callbackSelector, args);
        address target = stored.callbackTarget;
        uint256 stipend = callbackGas;
        assembly ("memory-safe") {
            let before := gas()
            delivered := call(stipend, target, 0, add(data, 0x20), mload(data), 0, 0)
            used := sub(before, gas())
        }
    }
}

/// @title The three house feeds, as the live oracle answered them
/// @notice On 12 and 13 October 2026 one real request was bought for each house feed, with exactly
/// the bytes `Questions` sends for that feed, from an ordinary wallet through version 1 of the
/// Intake (before version 2 was adopted). All three were attested. The records IdentityMD's API
/// served for them are in `test/fixtures/questions/proofs/`, with the record of the first body the
/// employers feed had, which was not attested and is the reason that feed is now judged by the
/// panel. These tests tie the records to the fixture files the launch is built from: same bytes,
/// same question hash, answers of the right type, and the real signatures accepted by the real
/// callback. `docs/LAUNCH.md`, section 5, tells the same story with the commands to repeat it.
contract HouseFeedProofsTest is Test {
    string internal constant FEEDS = "test/fixtures/questions/feeds/";
    string internal constant PROOFS = "test/fixtures/questions/proofs/";
    bytes32 internal constant ACTION = bytes32("oracle.request@oracle-1");
    address internal constant WRITER = address(0x3D3C);

    struct Proven {
        string name;
        string feed;
        string record;
        string intake;
        Questions.FeedParams params;
        bytes qPrefix;
        bytes tail;
        bytes32 feedId;
        OracleAttestation.Attestation a;
        bytes signature;
    }

    function _names() internal pure returns (string[3] memory) {
        return ["payrolls", "hires", "employers"];
    }

    function _load(string memory name) internal view returns (Proven memory v) {
        v.name = name;
        v.feed = vm.readFile(string.concat(FEEDS, name, ".json"));
        v.record = vm.readFile(string.concat(PROOFS, name, ".oracle.json"));
        v.intake = vm.readFile(string.concat(PROOFS, name, ".intake.json"));
        string memory j = v.feed;
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
        v.params = p;
        v.qPrefix = vm.parseJsonBytes(j, ".qPrefixHex");
        v.tail = vm.parseJsonBytes(j, ".tailHex");
        v.feedId = vm.parseJsonBytes32(j, ".feedId");

        string memory r = v.record;
        v.signature = vm.parseJsonBytes(r, ".signature");
        v.a = OracleAttestation.Attestation({
            requestId: vm.parseJsonBytes32(r, ".attestation.requestId"),
            chainId: vm.parseJsonUint(r, ".attestation.chainId"),
            questionHash: vm.parseJsonBytes32(r, ".attestation.questionHash"),
            answerType: _code(vm.parseJsonString(r, ".attestation.answerType")),
            answer: vm.parseJsonBytes(r, ".attestation.answer"),
            figure: vm.parseJsonUint(r, ".attestation.figure"),
            fromBlock: uint64(vm.parseJsonUint(r, ".attestation.fromBlock")),
            toBlock: uint64(vm.parseJsonUint(r, ".attestation.toBlock")),
            blockHash: vm.parseJsonBytes32(r, ".attestation.blockHash"),
            panelJobId: vm.parseJsonBytes32(r, ".attestation.panelJobId"),
            panelSize: uint16(vm.parseJsonUint(r, ".attestation.panelSize")),
            quorum: uint16(vm.parseJsonUint(r, ".attestation.quorum")),
            agreed: uint16(vm.parseJsonUint(r, ".attestation.agreed")),
            issuedAt: uint64(vm.parseJsonUint(r, ".attestation.issuedAt")),
            expiresAt: uint64(vm.parseJsonUint(r, ".attestation.expiresAt"))
        });
    }

    function _code(string memory answerType) internal pure returns (uint8) {
        for (uint8 i; i < 6; ++i) {
            if (keccak256(bytes(QuestionBody.answerTypeName(i))) == keccak256(bytes(answerType))) return i;
        }
        revert("unknown answer type");
    }

    /// @notice The question hash the contract's own builder gives for each feed's prefix and the
    /// proven window is the one the oracle attested. A different hash here would mean the launched
    /// contract refuses every answer to that feed.
    function test_proofs_theContractsQuestionHashIsTheAttestedOne() public view {
        string[3] memory names = _names();
        bytes32[3] memory attested = [
            bytes32(0xa7eb81dbf5789fdd71e33f54c90cda86ac6cf4070c2320c6d1719e01e3a84dd3),
            0xdb20f183971eca9bda183646db40164a35cd6cec00acabff45918189f15e6dc5,
            0x3d14a9f53e3eaf1272d67871cff61223fc9b295f26e177c7a193ca5f90d52fc6
        ];
        for (uint256 i; i < names.length; ++i) {
            Proven memory v = _load(names[i]);
            assertEq(vm.parseJsonString(v.record, ".status"), "attested", names[i]);
            uint64 fromBlock = uint64(vm.parseJsonUint(v.record, ".window.fromBlock"));
            uint64 toBlock = uint64(vm.parseJsonUint(v.record, ".window.toBlock"));

            bytes32 built = QuestionBody.questionHash(v.qPrefix, fromBlock, toBlock);
            assertEq(built, attested[i], names[i]);
            assertEq(built, vm.parseJsonBytes32(v.record, ".questionHash"), names[i]);
            assertEq(built, v.a.questionHash, names[i]);
            assertEq(built, vm.parseJsonBytes32(v.feed, ".notes.proof.questionHash"), names[i]);

            // The signed window is the one that was asked, and it is the window `Questions` asks
            // first: one cadence for a feed whose windows tile, the whole span for one that does not.
            assertEq(v.a.fromBlock, fromBlock, names[i]);
            assertEq(v.a.toBlock, toBlock, names[i]);
            assertEq(v.a.blockHash, vm.parseJsonBytes32(v.record, ".window.toBlockHash"), names[i]);
            uint256 span = v.params.contiguous ? v.params.cadenceBlocks : v.params.maxWindowBlocks;
            assertEq(uint256(toBlock) - fromBlock + 1, span, names[i]);
        }
    }

    /// @notice The body that was bought is, byte for byte, the body the contract sends for that
    /// window: the hash the Intake's service recorded for the request's body is the hash of the
    /// feed's prefix, the window and the feed's tail. So the tail is proven too, not only the part
    /// the question hash covers.
    function test_proofs_theBodyThatWasBoughtIsTheBodyTheContractSends() public view {
        string[3] memory names = _names();
        for (uint256 i; i < names.length; ++i) {
            Proven memory v = _load(names[i]);
            bytes memory body = QuestionBody.body(v.qPrefix, v.tail, v.a.fromBlock, v.a.toBlock);
            assertEq(keccak256(body), vm.parseJsonBytes32(v.intake, ".entries[0].bodyHash"), names[i]);
            assertEq(keccak256(body), vm.parseJsonBytes32(v.feed, ".notes.proof.bodyHash"), names[i]);

            // The Intake's record and the oracle's record are of the same purchase: 0.5 IMD, from a
            // wallet, with no callback, through version 1 of the Intake.
            assertEq(vm.parseJsonUint(v.intake, ".chainId"), 1);
            assertEq(vm.parseJsonAddress(v.intake, ".entries[0].intake"), Mainnet.INTAKE_V1, names[i]);
            assertEq(vm.parseJsonAddress(v.intake, ".entries[0].asset"), Mainnet.IMD);
            assertEq(vm.parseJsonUint(v.intake, ".entries[0].amount"), 0.5e18);
            assertEq(vm.parseJsonString(v.intake, ".entries[0].action"), "oracle.request");
            assertEq(vm.parseJsonString(v.intake, ".entries[0].actionVersion"), "oracle-1");
            assertEq(
                vm.parseJsonString(v.intake, ".entries[0].admission.result.requestId"),
                vm.parseJsonString(v.record, ".id"),
                names[i]
            );
            assertEq(
                vm.parseJsonBytes32(v.intake, ".transactionHash"),
                vm.parseJsonBytes32(v.feed, ".notes.proof.transaction"),
                names[i]
            );
            assertEq(vm.parseJsonUint(v.intake, ".entries[0].completion.status"), 0, "status 0 is an answer");
        }
    }

    /// @notice Each recorded answer decodes under its feed's answer type, to the figure the panel
    /// agreed on: 114 IMD, 228 transfers, and three addresses.
    function test_proofs_eachAnswerDecodesUnderItsFeedsAnswerType() public view {
        Proven memory payrolls = _load("payrolls");
        assertEq(payrolls.a.answerType, OracleAttestation.ANSWER_UINT256);
        assertEq(payrolls.a.answerType, payrolls.params.answerType);
        assertEq(payrolls.a.answer.length, 32);
        assertEq(abi.decode(payrolls.a.answer, (uint256)), 114e18);
        assertEq(abi.decode(payrolls.a.answer, (uint256)), vm.parseJsonUint(payrolls.record, ".agreement.answer"));
        assertEq(payrolls.a.figure, 114e18);

        Proven memory hires = _load("hires");
        assertEq(hires.a.answerType, OracleAttestation.ANSWER_UINT256);
        assertEq(hires.a.answerType, hires.params.answerType);
        assertEq(hires.a.answer.length, 32);
        assertEq(abi.decode(hires.a.answer, (uint256)), 228);
        assertEq(abi.decode(hires.a.answer, (uint256)), vm.parseJsonUint(hires.record, ".agreement.answer"));

        Proven memory employers = _load("employers");
        assertEq(employers.a.answerType, OracleAttestation.ANSWER_ADDRESS_LIST);
        assertEq(employers.a.answerType, employers.params.answerType);
        address[] memory list = abi.decode(employers.a.answer, (address[]));
        assertEq(employers.a.answer, abi.encode(list), "the answer is the canonical encoding of its list");
        assertEq(list.length, vm.parseJsonUint(employers.record, ".head"), "the signed list holds `head` entries");
        assertEq(list.length, 3);
        address[] memory agreed = vm.parseJsonAddressArray(employers.record, ".agreement.answer");
        assertEq(agreed.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(list[i], agreed[i]);
            assertTrue(list[i] != address(0));
        }
        assertEq(list[0], 0x21919137E69ed667aC404c7FcB71B8179b645F46);
        assertEq(list[1], 0x9fAdAB91f6FA03DBd7F4F8a08A338704bAAcf63f);
        assertEq(list[2], 0x7B8C742F2e1eEB3fB2C10d72967Fa6d4a22f0479);
    }

    /// @notice The signed panel, quorum and agreement are what each feed requires, the signer is
    /// the address in the manifest, and the answer was valid for the time the feed states.
    function test_proofs_thePanelTheSignerAndTheValidityAreWhatTheFeedsRequire() public view {
        string[3] memory names = _names();
        for (uint256 i; i < names.length; ++i) {
            Proven memory v = _load(names[i]);
            assertEq(v.a.chainId, v.params.chainId, names[i]);
            assertGe(v.a.panelSize, v.params.panelSize, names[i]);
            assertGe(v.a.quorum, v.params.quorum, names[i]);
            assertEq(v.params.minAgreed, v.params.quorum, "house feeds take only the panel's own agreement");
            assertGe(v.a.agreed, v.a.quorum, names[i]);
            assertEq(v.a.panelSize, 7);
            assertEq(v.a.quorum, 5);
            assertEq(v.a.agreed, 5);
            assertEq(vm.parseJsonAddress(v.record, ".signer"), Mainnet.ORACLE_SIGNER, names[i]);
            assertEq(uint256(v.a.expiresAt) - v.a.issuedAt, v.params.validFor, names[i]);
            assertEq(vm.parseJsonString(v.record, ".evidence"), i == 2 ? "panel" : "chain", names[i]);
        }
    }

    /// @notice What `docs/LAUNCH.md`, section 5, says was proven is what the saved records hold:
    /// the block marked `proofs` there is compared, field by field, with the oracle's records, the
    /// Intake's records and the feed fixtures.
    function test_proofs_theDocumentStatesWhatTheRecordsHold() public view {
        string memory doc = vm.readFile("docs/LAUNCH.md");
        string[] memory head = vm.split(doc, "<!-- proofs -->\n```json\n");
        assertEq(head.length, 2, "docs/LAUNCH.md: expected exactly one block marked proofs");
        string memory stated = vm.split(head[1], "\n```")[0];

        string[3] memory names = _names();
        for (uint256 i; i < names.length; ++i) {
            Proven memory v = _load(names[i]);
            string memory at = string.concat("[", vm.toString(i), "]");
            assertEq(vm.parseJsonString(stated, string.concat(at, ".feed")), names[i]);
            assertEq(vm.parseJsonBytes32(stated, string.concat(at, ".feedId")), v.feedId, names[i]);
            assertEq(
                vm.parseJsonBytes32(stated, string.concat(at, ".transaction")),
                vm.parseJsonBytes32(v.intake, ".transactionHash"),
                names[i]
            );
            assertEq(
                vm.parseJsonUint(stated, string.concat(at, ".block")),
                vm.parseJsonUint(v.intake, ".entries[0].blockNumber"),
                names[i]
            );
            assertEq(
                vm.parseJsonString(stated, string.concat(at, ".oracleRequestId")),
                vm.parseJsonString(v.record, ".id"),
                names[i]
            );
            assertEq(vm.parseJsonUint(stated, string.concat(at, ".fromBlock")), v.a.fromBlock, names[i]);
            assertEq(vm.parseJsonUint(stated, string.concat(at, ".toBlock")), v.a.toBlock, names[i]);
            assertEq(vm.parseJsonBytes32(stated, string.concat(at, ".questionHash")), v.a.questionHash, names[i]);
            assertEq(
                vm.parseJsonBytes32(stated, string.concat(at, ".bodyHash")),
                keccak256(QuestionBody.body(v.qPrefix, v.tail, v.a.fromBlock, v.a.toBlock)),
                names[i]
            );
            assertEq(vm.parseJsonString(stated, string.concat(at, ".status")), "attested", names[i]);
            assertEq(vm.parseJsonBytes(stated, string.concat(at, ".answer")), v.a.answer, names[i]);
            assertEq(vm.parseJsonUint(stated, string.concat(at, ".agreed")), v.a.agreed, names[i]);
            assertEq(
                vm.parseJsonString(stated, string.concat(at, ".attestedAt")),
                vm.parseJsonString(v.record, ".attestedAt"),
                names[i]
            );
        }
        assertFalse(vm.keyExistsJson(stated, "[3]"), "a fourth proof is stated");
    }

    /// @notice The first body the employers feed had: a pinned ranking recipe with a filter. All
    /// five members that answered agreed, and the oracle did not attest: its own rerun of the
    /// recipe, which cannot carry the filter, named five other addresses. That body can never be
    /// attested, which is why the feed is now the panel-judged one.
    function test_proofs_theFirstEmployersBodyWasNotAttested() public view {
        string memory first = vm.readFile(string.concat(PROOFS, "employers-first-attempt.oracle.json"));
        assertEq(vm.parseJsonString(first, ".status"), "mismatch");
        assertEq(vm.parseJsonString(first, ".failure"), "the recipe did not reproduce the panel's answer");
        assertEq(vm.parseJsonString(first, ".evidence"), "chain");
        assertFalse(vm.keyExistsJson(first, ".attestation.answer"), "the first body was attested after all");
        assertEq(vm.parseJsonUint(first, ".agreement.agreed"), 5);
        assertEq(vm.parseJsonUint(first, ".agreement.quorum"), 5);
        // The agreed recipe carries no filter; the members put it under the definitions.
        assertFalse(vm.keyExistsJson(first, ".agreement.recipe.filter"));
        assertEq(vm.parseJsonAddress(first, ".agreement.definitions.to"), Mainnet.FEE_PAYEE);
        address[] memory panel = vm.parseJsonAddressArray(first, ".agreement.answer");
        address[] memory rerun = vm.parseJsonAddressArray(first, ".computed.answer");
        assertEq(panel.length, 3);
        assertEq(rerun.length, 5);
        for (uint256 i; i < panel.length; ++i) {
            for (uint256 k; k < rerun.length; ++k) {
                assertTrue(panel[i] != rerun[k], "the rerun named an address the panel named");
            }
        }

        // The panel-judged body asked the same thing, and its panel named the same three addresses.
        Proven memory now_ = _load("employers");
        address[] memory attested = abi.decode(now_.a.answer, (address[]));
        for (uint256 i; i < 3; ++i) {
            assertEq(attested[i], panel[i]);
        }
        // It is another question to the oracle and another feed to the contract.
        assertTrue(vm.parseJsonBytes32(first, ".questionHash") != now_.a.questionHash);
        assertEq(
            vm.parseJsonBytes32(first, ".questionHash"),
            vm.parseJsonBytes32(now_.feed, ".notes.firstAttempt.questionHash")
        );
        assertTrue(vm.parseJsonBytes32(now_.feed, ".notes.firstAttempt.feedIdThen") != now_.feedId);
    }

    /// @notice The real answers, with the real oracle signer's real signatures, pass every check of
    /// the real callback for the real feeds. `Questions` is placed where each answer was signed for
    /// (the zero address on chain 1: the proofs named no consumer), each house feed is created from
    /// its fixture file under its launch id, a round is opened in the block the proof was bought
    /// for, and the stand-in Intake calls the callback under the 200,000 gas the live Intake gives
    /// (through `ZeroPayerIntake`, see above). What this does not show is the live Intake
    /// delivering to the launched address: that needs an answer signed for that address, which
    /// exists only after launch.
    function test_proofs_theRealSignedAnswersPassEveryCheckOfTheCallback() public {
        string[3] memory names = _names();
        uint256[3] memory expected;
        expected[0] = 114e18;
        expected[1] = 228;
        expected[2] = uint256(keccak256(_load("employers").a.answer));

        for (uint256 i; i < names.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            Proven memory v = _load(names[i]);
            string memory doc = vm.readFile(string.concat(PROOFS, names[i], ".attestation.json"));
            assertEq(vm.parseJsonString(doc, ".domain.name"), "IdentityMD Oracle");
            assertEq(vm.parseJsonString(doc, ".domain.version"), "2");
            assertEq(vm.parseJsonUint(doc, ".domain.chainId"), 1);
            address consumer = vm.parseJsonAddress(doc, ".domain.verifyingContract");
            assertEq(consumer, address(0), "the proof was signed for a consumer after all: place Questions there");
            assertEq(vm.parseJsonBytes(doc, ".signature"), v.signature);

            vm.chainId(1);
            OpenToken token = new OpenToken();
            ZeroPayerIntake intake = new ZeroPayerIntake(Mainnet.FEE_PAYEE, WRITER);
            intake.setPrice(ACTION, address(token), 0.5e18);
            deployCodeTo(
                "Questions.sol:Questions", abi.encode(address(intake), address(token), Mainnet.ORACLE_SIGNER), consumer
            );
            Questions q = Questions(consumer);
            assertEq(q.oracleSigner(), Mainnet.ORACLE_SIGNER);
            assertEq(q.attestationDigest(v.a) != bytes32(0), true);

            // The house feed itself, under the id the manifest gives JobsReport and Payroll.
            bytes32 feedId = q.createFeed(v.params, v.qPrefix, v.tail);
            assertEq(feedId, v.feedId, names[i]);

            // The block the proof's window was computed for, and the moment the oracle signed.
            vm.roll(uint256(v.a.toBlock) + v.params.lagBlocks);
            vm.setBlockhash(v.a.toBlock, v.a.blockHash);
            vm.warp(v.a.issuedAt);
            token.mint(address(this), 1e18);
            token.approve(address(q), 1e18);
            q.fund(feedId, 1e18);
            bytes32 intakeId = q.request(feedId);
            (, bytes32 pinned, bytes32 closing,) = q.roundRequest(feedId, 1);
            assertEq(pinned, v.a.questionHash, "the round asks another question than the one attested");
            assertEq(closing, v.a.blockHash);
            assertEq(keccak256(intake.lastBody()), vm.parseJsonBytes32(v.intake, ".entries[0].bodyHash"), names[i]);

            vm.prank(WRITER);
            (bool delivered, uint256 used) = intake.deliverToZeroPayer(intakeId, abi.encode(intakeId, v.a, v.signature));
            assertTrue(delivered, string.concat("the real attestation was refused: ", names[i]));
            assertLt(used, 140_000, "callback gas");
            emit log_named_uint(string.concat("callback gas, real answer, ", names[i]), used);

            (uint256 value, uint64 fromBlock, uint64 toBlock, uint64 round,) = q.latest(feedId);
            assertEq(round, 1);
            assertEq(value, expected[i], names[i]);
            assertEq(fromBlock, v.a.fromBlock);
            assertEq(toBlock, v.a.toBlock);
            (IQuestions.RoundStatus status,,,,) = q.roundOf(feedId, 1);
            assertEq(uint8(status), uint8(IQuestions.RoundStatus.Answered));
            assertTrue(q.usedBy(v.a.requestId, feedId));
            // The keeper that opened the round earned the feed's tip by the answer.
            (uint256 earned,) = q.tipsOf(address(this));
            assertEq(earned, v.params.tip);
            // The list behind the employers round can be published against the stored word.
            if (i == 2) q.reveal(feedId, 1, v.a.answer);
            vm.revertToState(snapshot);
        }
    }

    /// @notice The same real attestation with one address of the list changed, or delivered for
    /// another window, is refused.
    function test_proofs_aChangedAnswerIsRefused() public {
        Proven memory v = _load("employers");
        vm.chainId(1);
        OpenToken token = new OpenToken();
        MockIntake intake = new MockIntake(Mainnet.FEE_PAYEE, WRITER);
        intake.setPrice(ACTION, address(token), 0.5e18);
        deployCodeTo(
            "Questions.sol:Questions", abi.encode(address(intake), address(token), Mainnet.ORACLE_SIGNER), address(0)
        );
        Questions q = Questions(address(0));
        bytes32 feedId = q.createFeed(v.params, v.qPrefix, v.tail);
        vm.roll(uint256(v.a.toBlock) + v.params.lagBlocks);
        vm.setBlockhash(v.a.toBlock, v.a.blockHash);
        vm.warp(v.a.issuedAt);
        token.mint(address(this), 1e18);
        token.approve(address(q), 1e18);
        q.fund(feedId, 1e18);
        bytes32 intakeId = q.request(feedId);

        address[] memory list = abi.decode(v.a.answer, (address[]));
        list[2] = address(0xC3);
        OracleAttestation.Attestation memory changed = v.a;
        changed.answer = abi.encode(list);
        vm.expectRevert(bytes4(keccak256("BadSignature()")));
        vm.prank(address(intake));
        q.onOracleResult(intakeId, changed, v.signature);

        // The true list for a window one block along is refused too, before the signature is looked at.
        changed = v.a;
        changed.toBlock += 1;
        vm.expectRevert(bytes4(keccak256("BadSignature()")));
        vm.prank(address(intake));
        q.onOracleResult(intakeId, changed, v.signature);
        (IQuestions.RoundStatus status,,,,) = q.roundOf(feedId, 1);
        assertEq(uint8(status), uint8(IQuestions.RoundStatus.Pending));
        // Nobody can hand the true one in instead: the feed is judged by a panel.
        vm.expectRevert(Questions.SubmitNotForPanelEvidence.selector);
        q.submit(feedId, v.a, v.signature);
    }
}
