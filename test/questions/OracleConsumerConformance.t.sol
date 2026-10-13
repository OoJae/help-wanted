// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleAttestation} from "../../src/questions/OracleAttestation.sol";
import {IntakeDelivery} from "./mocks/IntakeDelivery.sol";
import {QuestionsVectorHarness} from "./mocks/QuestionsVectorHarness.sol";

// HELP WANTED: this is the protocol's conformance test, copied by a script from the oracle-consumer
// reference (`OracleConsumerConformance.t.sol` in REFERENCE.md). Three things differ from the
// reference and nothing else, the vector constants least of all:
//   1. the imports above: this project's paths, a stand-in for IntakeDelivery, and the consumer;
//   2. the type of `consumer`;
//   3. `deployConsumer`, which deploys Questions at the vector address.
// Formatting is switched off below so the protocol's text stays as it was delivered.
// forgefmt: disable-start

/// @title The conformance test a consumer copies
/// @notice Delivered whole to builders by the `oracle-consumer` skill. It is the one test that ties
/// a consumer to what the oracle actually signs: the protocol's vector values, its digest and a
/// signature made by `oracle-eip712.ts` (the same vector `OracleAttestation.t.sol` pins). A consumer
/// whose struct, type string or domain differs from the protocol's passes its own self-signed tests
/// and fails this one.
///
/// A builder replaces `deployConsumer` with its own contract, deployed at `VECTOR_CONSUMER` with
/// `SIGNER` as its oracle signer and `caller()` as the address its callback trusts, and `CALLBACK`
/// with its callback's name in the canonical signature.
contract OracleConsumerConformanceTest is Test {
    // ---- the protocol's vector: do not change these ----
    uint256 constant VECTOR_CHAIN = 11155111;
    address constant VECTOR_CONSUMER = 0x0000000000000000000000000000000000002748;
    bytes32 constant VECTOR_DIGEST = 0x95fefa8b7c529852f4e2b6aec888930eb2bf5078e6443a85808e36df19e1325c;
    bytes constant VECTOR_SIGNATURE =
        hex"a26b14918607eb565af126beb54d3c5d19e923c41506def500b3521a4f9aa6d603ab44fd22f15dd2191732961a7131e4641244add8b0f09f20e6ae64381be8481b";
    /// @dev anvil's second account: the vector's attester. A test key, never a real one.
    address constant SIGNER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    uint256 constant SIGNER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint64 constant ISSUED_AT = 1800000000;
    uint64 constant EXPIRES_AT = 1800003600;

    /// @dev The callback's canonical signature. Its selector is what the intake calls: a struct that
    /// differs from the protocol's by one field has another selector and is never reached.
    string constant CALLBACK =
        "onOracleResult(bytes32,(bytes32,uint256,bytes32,uint8,bytes,uint256,uint64,uint64,bytes32,bytes32,uint16,uint16,uint16,uint64,uint64),bytes)";

    address constant WRITER = address(0x717E);
    address constant SOURCE_INTAKE = 0x1397434cd35e8a9C8aC312A61D3A285EB31dea56;

    IntakeDelivery delivery;
    QuestionsVectorHarness consumer;

    function setUp() public {
        vm.chainId(VECTOR_CHAIN);
        vm.warp(ISSUED_AT);
        delivery = new IntakeDelivery(address(this), WRITER);
        deployConsumer();
    }

    /// @dev Replace with your consumer, at the vector's address, trusting `caller()`.
    function deployConsumer() internal {
        // Questions(intake, imd, oracleSigner): it trusts `caller()` as its Intake and `SIGNER` as
        // its oracle. The token is never touched here; any non-zero address will do.
        deployCodeTo(
            "QuestionsVectorHarness.sol:QuestionsVectorHarness",
            abi.encode(caller(), address(0x1D), SIGNER),
            VECTOR_CONSUMER
        );
        consumer = QuestionsVectorHarness(VECTOR_CONSUMER);
        // Whatever your consumer needs to take the vector's question as its own. The reference's
        // example pins the question hash here. Questions takes an answer only for a round it asked
        // for itself, and holds that round to the question hash it built when it asked, so the
        // vector's round is planted as pending, with the vector's question hash pinned, under each
        // request id the tests below deliver with.
        consumer.plant(keccak256("source request"), vector());
        consumer.plant(bytes32(0), vector());
    }

    /// @dev Who calls your callback: `IntakeDelivery` for an answer from another chain, the
    /// `Intake` (or a mock of it) for one from the same chain.
    function caller() internal view returns (address) {
        return address(delivery);
    }

    /// @dev The vector attestation: a `bytes32[]` answer with one element, figure 12345, blocks
    /// 100–200, a panel of five with a quorum of four that agreed unanimously.
    function vector() internal pure returns (OracleAttestation.Attestation memory a) {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = bytes32(uint256(1));
        a = OracleAttestation.Attestation({
            requestId: 0x0000000000004000800000000000000100000000000000000000000000000000,
            chainId: 1,
            questionHash: 0x2117f4362ebfa37aa8a8c0fed548604fe09ac46faf8ae7559cd64780f26a46fb,
            answerType: OracleAttestation.ANSWER_BYTES32_LIST,
            answer: abi.encode(ids),
            figure: 12345,
            fromBlock: 100,
            toBlock: 200,
            blockHash: bytes32(uint256(7)),
            panelJobId: 0x0000000000004000800000000000000200000000000000000000000000000000,
            panelSize: 5,
            quorum: 4,
            agreed: 5,
            issuedAt: ISSUED_AT,
            expiresAt: EXPIRES_AT
        });
    }

    /// @notice The digest your consumer verifies is the one the oracle signs.
    function test_digestMatchesTheProtocol() public view {
        assertEq(consumer.attestationDigest(vector()), VECTOR_DIGEST, "struct, type string or domain differs from the protocol's");
    }

    /// @notice Your callback's selector is the one the intake calls.
    function test_callbackSelectorIsCanonical() public view {
        assertEq(consumer.onOracleResult.selector, bytes4(keccak256(bytes(CALLBACK))), "callback parameters differ from the protocol's");
    }

    /// @notice The protocol's own signature, delivered the way the writer delivers it, is accepted.
    /// @dev A consumer that refuses the vector's answer type signs its own answer with `SIGNER_KEY`
    /// instead; `test_digestMatchesTheProtocol` is what ties it to the protocol.
    function test_acceptsTheProtocolSignatureAsDelivered() public {
        bytes32 sourceRequestId = keccak256("source request");
        vm.prank(WRITER);
        bool called = delivery.deliver(
            4663,
            SOURCE_INTAKE,
            sourceRequestId,
            VECTOR_CONSUMER,
            bytes4(keccak256(bytes(CALLBACK))),
            abi.encode(sourceRequestId, vector(), VECTOR_SIGNATURE)
        );
        assertTrue(called, "the callback did not run to the end under the 200,000 gas stipend");
        assertTrue(consumer.consumed(vector().requestId));
    }

    /// @notice A fresh signature from the same key verifies too, so tests can sign their own answers.
    function test_acceptsAFreshSignatureFromTheVectorKey() public {
        OracleAttestation.Attestation memory a = vector();
        a.requestId = keccak256("another request");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, consumer.attestationDigest(a));
        vm.prank(caller());
        consumer.onOracleResult(bytes32(0), a, abi.encodePacked(r, s, v));
        assertTrue(consumer.consumed(a.requestId));
    }
}
// forgefmt: disable-end
