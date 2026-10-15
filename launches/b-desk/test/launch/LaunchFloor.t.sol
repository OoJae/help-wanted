// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {Doorbell} from "../../src/pots/Doorbell.sol";
import {OrderHeader} from "../../src/desk/OrderHeader.sol";
import {LaunchValues} from "../kit/LaunchValues.sol";
import {LaunchKit} from "./LaunchKit.sol";
import {MockIMD} from "../pots/mocks/MockIMD.sol";

/// @dev The same probe the launch's protected harness etches at the ProjectFactory: CREATE2 from
/// the factory's address, callable only by the harness that made it, refusing an initcode that is
/// empty or above EIP-3860's limit and a constructor that leaves no code behind.
contract FactoryProbe {
    address private immutable controller = msg.sender;

    function deploy(bytes memory code, bytes32 salt) external returns (address deployed) {
        require(msg.sender == controller, "not the protected harness");
        require(code.length > 0 && code.length <= 49_152, "invalid init code");
        assembly ("memory-safe") {
            deployed := create2(0, add(code, 32), mload(code), salt)
        }
        require(deployed != address(0) && deployed.code.length > 0, "application constructor failed");
    }
}

/// @title The launch's protected floor, rehearsed without an environment
/// @notice The protected harness (`Contracts.protected.t.sol`) reads its inputs from environment
/// variables that only the pipeline sets: the factory, the chain id, each initcode, each salt and
/// each predicted address. This file rehearses the same floor with the manifest `docs/LAUNCH.md`
/// carries, on chain id 1, through a probe etched at the real ProjectFactory's address, with every
/// `$contract:` reference resolved to the CREATE2 address *predicted* for the earlier entry before
/// anything is deployed, as the pipeline must do to fill the later initcodes. Then the walk the
/// harness makes over the runtime code is made again, byte for byte the same walk.
///
/// The second half is what the floor refuses: a constructor handed value, a bool written as
/// anything but 0 or 1, a zero address in a slot that must not be one, a wrong-order argument
/// list, and a reference that points forward. Each parks the launch at the probe, which is the
/// right place for it to stop. One slot the floor does not catch is written down as a test too:
/// `WorkProof` takes any registry address, zero included (`docs/THREATS.md`, P10).
contract LaunchFloorTest is LaunchKit {
    address internal constant FACTORY = Mainnet.PROJECT_FACTORY;
    uint256 internal constant EIP170 = 24_576;
    uint256 internal constant EIP3860 = 49_152;

    Entry[] internal entries;
    address[] internal predicted;
    bytes32[] internal salts;

    function setUp() public {
        vm.chainId(1);
        FactoryProbe implementation = new FactoryProbe();
        vm.etch(FACTORY, address(implementation).code);

        (, Entry[] memory read) = _manifest();
        for (uint256 i; i < read.length; ++i) {
            entries.push(read[i]);
        }
        require(entries.length == CONTRACTS, "the manifest names four contracts");

        // The pipeline chooses a salt for each entry and predicts each address from the initcode
        // it will hand the factory, whose references are the predicted addresses of earlier entries.
        for (uint256 i; i < CONTRACTS; ++i) {
            salts.push(keccak256(abi.encode("launch B", i)));
            bytes memory init = _initcode(i, _wordsOf(entries, i, predicted));
            predicted.push(vm.computeCreate2Address(salts[i], keccak256(init), FACTORY));
        }
    }

    /// @dev The initcode the factory is handed for entry `i`, references resolved to `predicted`.
    function _init(uint256 i) internal view returns (bytes memory) {
        return _initcode(i, _wordsOf(entries, i, predicted));
    }

    function _deployAll() internal returns (address[] memory made) {
        made = new address[](CONTRACTS);
        for (uint256 i; i < CONTRACTS; ++i) {
            made[i] = FactoryProbe(FACTORY).deploy(_init(i), salts[i]);
        }
    }

    // ---- the floor as the harness walks it ---------------------------------------------------------

    /// @notice Each contract lands at the address predicted before any was deployed, so the
    /// references written into the later initcodes point at the earlier contracts as deployed.
    function test_floor_deploysAtThePredictedAddressesThroughTheFactory() public {
        address[] memory made = _deployAll();
        for (uint256 i; i < CONTRACTS; ++i) {
            assertEq(made[i], predicted[i], string.concat(_contractName(i), ": application prediction mismatch"));
            assertGt(made[i].code.length, 0);
        }
        assertEq(WorkOrders(made[1]).WORK_PROOF(), made[0], "the desk's WorkProof is entry 0 as deployed");
        assertEq(address(CrowdPots(made[2]).WORK_ORDERS()), made[1], "the pots' desk is entry 1 as deployed");
        assertEq(address(Doorbell(made[3]).WORK_ORDERS()), made[1], "the Doorbell's desk is entry 1 as deployed");
        assertEq(WorkOrders(made[1]).PAYROLL(), Mainnet.PAYROLL);
        assertEq(WorkOrders(made[1]).IMD(), Mainnet.IMD);
        assertEq(WorkProof(made[0]).WORK_REGISTRY(), Mainnet.WORK_REGISTRY);
    }

    /// @notice The harness's own walk, repeated here instruction by instruction: the runtime is
    /// present, at most 24,576 bytes, and holds no DELEGATECALL (0xf4), CALLCODE (0xf2) or
    /// SELFDESTRUCT (0xff) outside PUSH data.
    function test_floor_runtimeIsPresentBoundedAndHasNoEscapeOpcodes() public {
        address[] memory made = _deployAll();
        for (uint256 i; i < CONTRACTS; ++i) {
            bytes memory code = made[i].code;
            assertGt(code.length, 0, "missing runtime");
            assertLe(code.length, EIP170, "runtime exceeds EIP-170");
            for (uint256 j; j < code.length; ++j) {
                uint8 op = uint8(code[j]);
                if (op >= 0x60 && op <= 0x7f) {
                    j += op - 0x5f;
                    continue;
                }
                assertTrue(op != 0xf4 && op != 0xf2 && op != 0xff, "forbidden application opcode");
            }
        }
    }

    /// @notice Every initcode with its arguments is inside what the probe accepts, and each
    /// argument list is exactly as long as the constructor's ABI: a word too many or too few would
    /// change what the constructor reads.
    function test_floor_everyInitcodeFitsTheProbe() public view {
        uint256[4] memory words = [uint256(1), 3, 2, 8];
        for (uint256 i; i < CONTRACTS; ++i) {
            bytes memory init = _init(i);
            assertGt(init.length, 0);
            assertLe(init.length, EIP3860, string.concat(_contractName(i), ": initcode above 49,152 bytes"));
            assertEq(init.length - _creationCode(i).length, 32 * words[i], _contractName(i));
        }
    }

    /// @notice The factory holds no privilege afterwards. No runtime code carries its address (no
    /// constructor baked `msg.sender` into an immutable), the first storage slots of each contract
    /// do not hold it, and the two callbacks refuse it like any other stranger.
    function test_floor_theFactoryKeepsNoPrivilege() public {
        address[] memory made = _deployAll();
        for (uint256 i; i < CONTRACTS; ++i) {
            assertFalse(_holds(made[i].code, abi.encodePacked(FACTORY)), "runtime code carries the factory");
            for (uint256 slot; slot < 64; ++slot) {
                assertTrue(vm.load(made[i], bytes32(slot)) != _word(FACTORY), "storage holds the factory");
            }
        }
        vm.startPrank(FACTORY);
        vm.expectRevert(CrowdPots.NotDesk.selector);
        CrowdPots(made[2]).onWorkDelivered(1, bytes16(0), bytes32(0));
        vm.expectRevert(Doorbell.NotDesk.selector);
        Doorbell(made[3]).onWorkDelivered(1, bytes16(0), bytes32(0));
        vm.stopPrank();
    }

    /// @notice On the factory-made contracts, with nothing called after deployment, the first ring
    /// and the first pot are a stranger's calls: fund the Doorbell, ring 25 times, and it hires.
    function test_floor_nothingNeedsToBeCalledAfterDeployment() public {
        vm.etch(Mainnet.IMD, address(new MockIMD()).code);
        address[] memory made = _deployAll();
        Doorbell bell = Doorbell(made[3]);
        WorkOrders desk = WorkOrders(made[1]);
        address ringer = makeAddr("ringer");
        MockIMD(Mainnet.IMD).mint(ringer, LaunchValues.BELL_MAX_PAY);
        vm.startPrank(ringer);
        MockIMD(Mainnet.IMD).transfer(address(bell), LaunchValues.BELL_MAX_PAY);
        assertTrue(bell.funded());
        for (uint256 i; i < 24; ++i) {
            (, bool hired,) = bell.ring();
            assertFalse(hired);
        }
        (uint256 count, bool hiredNow, uint256 orderId) = bell.ring();
        vm.stopPrank();
        assertEq(count, 25);
        assertTrue(hiredNow);
        assertEq(orderId, 1);
        assertEq(desk.orderCount(), 1);
        assertEq(desk.orderOf(1).employer, address(bell));
        assertEq(desk.orderOf(1).maxPay, LaunchValues.BELL_MAX_PAY);
        assertEq(desk.orderOf(1).flags, desk.FLAG_CALLBACK() | desk.FLAG_ALLOW_CLAIMED());
        assertEq(MockIMD(Mainnet.IMD).balanceOf(address(bell)), 0, "one price: nothing is left after a hire");
    }

    /// @notice The order header ties a job to one chain. The same desk, order, claim and runner on
    /// chain 1 and on any other chain give different tickets, so a job bought for a test-net desk
    /// cannot settle the mainnet one.
    function testFuzz_floor_theTicketBindsChainOne(uint256 otherChain, uint256 id, uint32 seq, address runner) public {
        otherChain = bound(otherChain, 2, type(uint64).max);
        bytes32 mainnet = OrderHeader.ticket(1, predicted[1], id, seq, runner);
        bytes32 other = OrderHeader.ticket(otherChain, predicted[1], id, seq, runner);
        assertTrue(mainnet != other, "a ticket does not depend on the chain id");
        assertTrue(mainnet != OrderHeader.ticket(1, predicted[2], id, seq, runner), "nor on the desk");
    }

    // ---- what the floor refuses ---------------------------------------------------------------------

    /// @notice Deployment sends zero ETH, and every constructor is nonpayable: one wei sent with any
    /// of the four initcodes makes the creation fail, so a value-carrying launch could never
    /// silently fund a contract that has no way to spend ETH.
    function test_floor_aNonpayableConstructorRefusesValue() public {
        vm.deal(address(this), 1 ether);
        for (uint256 i; i < CONTRACTS; ++i) {
            bytes memory init = _init(i);
            address made;
            assembly ("memory-safe") {
                made := create(1, add(init, 0x20), mload(init))
            }
            assertEq(made, address(0), string.concat(_contractName(i), " accepted value in its constructor"));
            assembly ("memory-safe") {
                made := create(0, add(init, 0x20), mload(init))
            }
            assertTrue(made != address(0), string.concat(_contractName(i), " did not deploy without value"));
        }
    }

    /// @notice The Doorbell's last argument is a bool written 0 or 1. Any other word is refused by
    /// the ABI decoder, so a manifest that wrote `2` parks the launch at the probe.
    function test_floor_aBoolWrittenOutsideZeroOrOneParksTheLaunch() public {
        _deployFirst(3);
        bytes32[] memory words = _wordsOf(entries, 3, predicted);
        words[7] = bytes32(uint256(2));
        vm.expectRevert(bytes("application constructor failed"));
        FactoryProbe(FACTORY).deploy(_initcode(3, words), salts[3]);
        // And both legal values deploy; the alternative the launch day may choose is receipt-only.
        words[7] = bytes32(0);
        Doorbell strict = Doorbell(FactoryProbe(FACTORY).deploy(_initcode(3, words), keccak256("strict")));
        assertFalse(strict.ALLOW_CLAIMED());
        words[7] = bytes32(uint256(1));
        Doorbell open = Doorbell(FactoryProbe(FACTORY).deploy(_initcode(3, words), keccak256("open")));
        assertTrue(open.ALLOW_CLAIMED());
    }

    /// @notice A zero address in any slot of `WorkOrders`, `CrowdPots` or the `Doorbell` parks the
    /// launch at the probe: the constructors refuse it, and the factory reports the failure.
    function test_floor_aZeroAddressParksTheLaunch() public {
        _deployFirst(3);
        uint256[3] memory index = [uint256(1), 2, 3];
        uint256[3] memory addressSlots = [uint256(3), 2, 2];
        for (uint256 k; k < index.length; ++k) {
            uint256 i = index[k];
            for (uint256 slot; slot < addressSlots[k]; ++slot) {
                bytes32[] memory words = _wordsOf(entries, i, predicted);
                words[slot] = bytes32(0);
                vm.expectRevert(bytes("application constructor failed"));
                FactoryProbe(FACTORY).deploy(_initcode(i, words), keccak256(abi.encode("zero", i, slot)));
            }
        }
    }

    /// @notice What the floor does not catch, written down: `WorkProof` takes any registry
    /// address, the zero address included. It fails safe (every proof is `NoReceipt`) and is
    /// permanent (`docs/THREATS.md`, P10). A reader of the manifest, not the floor, checks slot 0.
    function test_floor_workProofAcceptsAnyRegistryAddress_evenZero() public {
        bytes32[] memory words = new bytes32[](1);
        words[0] = bytes32(0);
        WorkProof unsafe = WorkProof(FactoryProbe(FACTORY).deploy(_initcode(0, words), keccak256("zero registry")));
        assertEq(unsafe.WORK_REGISTRY(), address(0));
        // No code at the registry: a proof of anything is `NoReceipt`, never a pass.
        bytes memory record = bytes('{"job_id":"00000000-0000-4000-8000-000000000000","schema":"identitymd-work-v1"}');
        vm.expectRevert();
        unsafe.prove(bytes16(0), record, 0);
    }

    /// @notice The Doorbell's six values in the wrong order are refused. With `bond` and
    /// `deliverySecs` swapped the bond is 604,800 wei, far below the desk's minimum. With the hash
    /// and the price swapped, the price is the hash's low 96 bits, above `maxPay`, so the range
    /// check refuses it. With `minPay` and `maxPay` swapped nothing changes: this launch gives the
    /// Doorbell one price, so that swap is the same manifest.
    function test_floor_theDoorbellsArgumentsInTheWrongOrderAreRefused() public {
        _deployFirst(3);
        bytes32[] memory words = _wordsOf(entries, 3, predicted);
        (words[5], words[6]) = (words[6], words[5]);
        vm.expectRevert(bytes("application constructor failed"));
        FactoryProbe(FACTORY).deploy(_initcode(3, words), keccak256("swapped bond and delivery"));

        words = _wordsOf(entries, 3, predicted);
        (words[2], words[3]) = (words[3], words[2]);
        assertGt(
            uint96(uint256(LaunchValues.BELL_KIND_HASH)), LaunchValues.BELL_MAX_PAY, "the hash's low bits as a price"
        );
        vm.expectRevert(bytes("application constructor failed"));
        FactoryProbe(FACTORY).deploy(_initcode(3, words), keccak256("swapped kind and price"));

        words = _wordsOf(entries, 3, predicted);
        (words[3], words[4]) = (words[4], words[3]);
        Doorbell same = Doorbell(FactoryProbe(FACTORY).deploy(_initcode(3, words), keccak256("swapped prices")));
        assertEq(same.MIN_PAY(), same.MAX_PAY());
        assertEq(same.MIN_PAY(), LaunchValues.BELL_MIN_PAY);
    }

    /// @notice A reference must point backward. The kit refuses a manifest whose desk names a
    /// contract that comes later, before any initcode is built.
    function test_floor_aForwardReferenceIsRefused() public {
        Entry[] memory forward = new Entry[](CONTRACTS);
        for (uint256 i; i < CONTRACTS; ++i) {
            forward[i] = entries[i];
        }
        forward[1].args[1] = "$contract:CrowdPots";
        vm.expectRevert(bytes("a reference that does not point backward: $contract:CrowdPots"));
        this.resolve(forward, 1, predicted);
    }

    /// @notice Deploying the same initcode under the same salt twice fails at the factory: a
    /// launch cannot be replayed onto its own addresses.
    function test_floor_theSameSaltCannotBeUsedTwice() public {
        _deployAll();
        vm.expectRevert(bytes("application constructor failed"));
        FactoryProbe(FACTORY).deploy(_init(0), salts[0]);
    }

    /// @notice Only the harness that etched the probe may use it.
    function test_floor_theProbeRefusesAnyOtherCaller() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bytes("not the protected harness"));
        FactoryProbe(FACTORY).deploy(_init(0), salts[0]);
    }

    // ---- helpers ------------------------------------------------------------------------------------

    function resolve(Entry[] memory list, uint256 index, address[] memory known)
        external
        pure
        returns (bytes32[] memory)
    {
        return _wordsOf(list, index, known);
    }

    function _deployFirst(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            FactoryProbe(FACTORY).deploy(_init(i), salts[i]);
        }
    }

    /// @dev True when `needle` occurs anywhere in `hay`.
    function _holds(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i + needle.length <= hay.length; ++i) {
            bool same = true;
            for (uint256 j; j < needle.length && same; ++j) {
                same = hay[i + j] == needle[j];
            }
            if (same) return true;
        }
        return false;
    }
}
