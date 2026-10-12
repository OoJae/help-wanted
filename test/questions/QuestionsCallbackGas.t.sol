// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {OracleAttestation} from "../../src/questions/OracleAttestation.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockIntake} from "./mocks/MockIntake.sol";

/// @title What the callback costs, measured the way the Intake pays for it
/// @notice The Intake gives the callback 200,000 gas, once. The target here is 120,000 and these
/// tests fail above 140,000.
///
/// The measurement is honest about storage. The round is opened in `setUp`, which Foundry runs as
/// a transaction of its own, and the test does nothing but have the Intake's writer complete the
/// request. Every slot the callback touches is therefore cold and holds the value a real callback
/// would find, with or without Foundry's per-call isolation. The number is what the mock Intake saw
/// go: the gas before its `call` minus the gas after, which also counts the call's own overhead, so
/// it errs high. The contract under test is the unmodified `Questions`, and each case is a contract
/// of its own so that `setUp` makes exactly one request.
///
/// Every case is a feed with a keeper tip, so the figure includes crediting the tip to the keeper
/// that opened the round: one more slot read (who the keeper is and what was set aside) and one
/// write to the keeper's own slot, which already holds the tip as pending.
abstract contract CallbackGasCase is Test {
    bytes32 internal constant ACTION = bytes32("oracle.request@oracle-1");
    uint256 internal constant TARGET = 120_000;
    uint256 internal constant GATE = 140_000;
    address internal constant WRITER = address(0x3D3C);

    MockIMD internal imd;
    MockIntake internal intake;
    Questions internal q;
    bytes32 internal feedId;
    bytes32 internal intakeId;
    bytes internal args;

    /// @dev The case: the feed's answer type, its protocol name, the signed answer, the stored word.
    function _case()
        internal
        pure
        virtual
        returns (uint8 answerType, string memory typeName, bytes memory answer, uint256 expected);

    function setUp() public {
        vm.roll(26_200_000);
        vm.warp(1_791_600_000);
        (address oracle, uint256 oracleKey) = makeAddrAndKey("oracle signer");
        imd = new MockIMD();
        intake = new MockIntake(address(0x4E0F), WRITER);
        intake.setPrice(ACTION, address(imd), 0.5e18);
        q = new Questions(address(intake), address(imd), oracle);
        imd.mint(address(this), 100e18);
        imd.approve(address(q), type(uint256).max);

        (uint8 answerType, string memory typeName, bytes memory answer,) = _case();
        Questions.FeedParams memory p;
        p.action = ACTION;
        p.chainId = uint64(vm.getChainId());
        p.answerType = answerType;
        (p.panelSize, p.quorum, p.minAgreed) = (7, 5, 5);
        p.validFor = 86_400;
        (p.cadenceBlocks, p.maxWindowBlocks, p.lagBlocks) = (7000, 21_600, 12);
        (p.contiguous, p.pinHash) = (true, true);
        (p.maxPrice, p.tip) = (1e18, 0.05e18);
        bytes memory prefix = bytes(
            string.concat(
                '{"answerType":"',
                typeName,
                '","chainId":',
                vm.toString(vm.getChainId()),
                ',"question":"A standing question?","v":1,"window":{"fromBlock":'
            )
        );
        feedId = q.createFeed(p, prefix, ',"panelSize":7,"quorum":5,"validForSeconds":86400}');
        q.fund(feedId, 5e18);
        intakeId = q.request(feedId);

        (, bytes32 questionHash, bytes32 blockHash,) = q.roundRequest(feedId, 1);
        (,, uint64 fromBlock, uint64 toBlock,) = q.roundOf(feedId, 1);
        OracleAttestation.Attestation memory a = OracleAttestation.Attestation({
            requestId: bytes32(bytes16(keccak256("oracle request"))),
            chainId: vm.getChainId(),
            questionHash: questionHash,
            answerType: answerType,
            answer: answer,
            figure: 53.5e18,
            fromBlock: fromBlock,
            toBlock: toBlock,
            blockHash: blockHash,
            panelJobId: bytes32(bytes16(keccak256("panel job"))),
            panelSize: 7,
            quorum: 5,
            agreed: 6,
            issuedAt: uint64(vm.getBlockTimestamp()),
            expiresAt: uint64(vm.getBlockTimestamp() + 86_400)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, q.attestationDigest(a));
        args = abi.encode(intakeId, a, abi.encodePacked(r, s, v));
        // The answer arrives a quarter of an hour later, in another block.
        vm.roll(vm.getBlockNumber() + 75);
        skip(15 minutes);
    }

    function test_callbackGas_staysUnderTheGate() public {
        (, string memory typeName,, uint256 expected) = _case();
        assertEq(intake.callbackGas(), 200_000, "the stipend these numbers are measured against");
        vm.prank(WRITER);
        intake.complete(intakeId, 0, keccak256("result"), "uri", args);

        assertTrue(intake.lastDelivered(), "the callback did not run to the end under 200,000 gas");
        (uint256 value,,, uint64 round,) = q.latest(feedId);
        assertEq(round, 1);
        assertEq(value, expected);
        // The same call credited the keeper (this contract, which made the request in `setUp`).
        (uint256 earned, uint256 pending) = q.tipsOf(address(this));
        assertEq(earned, 0.05e18, "the answer did not earn the keeper its tip");
        assertEq(pending, 0);
        uint256 used = intake.lastCallbackGasUsed();
        console2.log(string.concat("callback gas (", typeName, "):"), used);
        assertLt(used, GATE, "callback gas is above the 140,000 gate");
        assertLt(used, TARGET, "callback gas is above the 120,000 target");
    }
}

/// @notice A daily sum: the Payrolls and Hires shape.
contract CallbackGasUint256Test is CallbackGasCase {
    function _case() internal pure override returns (uint8, string memory, bytes memory, uint256) {
        return (OracleAttestation.ANSWER_UINT256, "uint256", abi.encode(uint256(53.5e18)), 53.5e18);
    }
}

/// @notice A sum of zero: the value slot is written with a zero, the cheapest case.
contract CallbackGasZeroSumTest is CallbackGasCase {
    function _case() internal pure override returns (uint8, string memory, bytes memory, uint256) {
        return (OracleAttestation.ANSWER_UINT256, "uint256", abi.encode(uint256(0)), 0);
    }
}

/// @notice A "no".
contract CallbackGasBoolNoTest is CallbackGasCase {
    function _case() internal pure override returns (uint8, string memory, bytes memory, uint256) {
        return (OracleAttestation.ANSWER_BOOL, "bool", abi.encode(false), 0);
    }
}

contract CallbackGasAddressTest is CallbackGasCase {
    function _case() internal pure override returns (uint8, string memory, bytes memory, uint256) {
        return (OracleAttestation.ANSWER_ADDRESS, "address", abi.encode(address(0xA11CE)), 0xA11CE);
    }
}

/// @notice A top-three list: the Employers of the Week shape.
contract CallbackGasAddressListTest is CallbackGasCase {
    function _case() internal pure override returns (uint8, string memory, bytes memory, uint256) {
        address[] memory top = new address[](3);
        (top[0], top[1], top[2]) = (address(0xA11CE), address(0xB0B), address(0xCA401));
        bytes memory answer = abi.encode(top);
        return (OracleAttestation.ANSWER_ADDRESS_LIST, "address[]", answer, uint256(keccak256(answer)));
    }
}

/// @notice A list of thirty-two entries, the longest `head` the protocol allows.
contract CallbackGasLongListTest is CallbackGasCase {
    function _case() internal pure override returns (uint8, string memory, bytes memory, uint256) {
        bytes32[] memory ids = new bytes32[](32);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = keccak256(abi.encode(i));
        }
        bytes memory answer = abi.encode(ids);
        return (OracleAttestation.ANSWER_BYTES32_LIST, "bytes32[]", answer, uint256(keccak256(answer)));
    }
}
