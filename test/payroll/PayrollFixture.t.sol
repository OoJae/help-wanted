// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Payroll} from "../../src/payroll/Payroll.sol";
import {ISeatAdapter, ISeats} from "../../src/interfaces/external/ISeatAdapter.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {PayrollSetup} from "./PayrollSetup.sol";
import {MockSeats, MockAdapter, RawResponder} from "./mocks/MockSeats.sol";

/// @dev Replays bytes recorded from Ethereum mainnet (`test/fixtures/payroll/mainnet-seat-binding.json`)
/// so the Adapter and seat-token paths are tested offline against what the real contracts return.
contract PayrollFixtureTest is PayrollSetup {
    string internal json;
    RawResponder internal recordedAdapter;
    MockSeats internal seatsAtMainnetAddress;
    Payroll internal p;

    function setUp() public override {
        super.setUp();
        json = vm.readFile("test/fixtures/payroll/mainnet-seat-binding.json");

        // A seat token at the mainnet seat address, because that is the address the recorded binding names.
        address seatAddress = vm.parseJsonAddress(json, ".seats");
        vm.etch(seatAddress, address(seats).code);
        seatsAtMainnetAddress = MockSeats(seatAddress);
        seatsAtMainnetAddress.setMinted(vm.parseJsonUint(json, ".seatCount"));
        seatsAtMainnetAddress.setOwner(
            vm.parseJsonUint(json, ".boundTokenId"), vm.parseJsonAddress(json, ".ownerOfBoundSeat")
        );

        recordedAdapter = new RawResponder();
        p = new Payroll(
            address(imd),
            address(simd),
            seatAddress,
            vm.parseJsonUint(json, ".seatCount"),
            address(recordedAdapter),
            address(questions),
            FEED_A,
            FEED_B,
            FEED_C
        );
        vm.prank(payer);
        imd.approve(address(p), type(uint256).max);
    }

    function test_fixture_agreesWithTheFrozenInterfaceAndAddresses() public view {
        assertEq(vm.parseJsonAddress(json, ".adapter"), Mainnet.SEAT_ADAPTER);
        assertEq(vm.parseJsonAddress(json, ".seats"), Mainnet.SEATS);
        assertEq(vm.parseJsonUint(json, ".seatCount"), Mainnet.SEAT_COUNT);

        bytes memory recorded = vm.parseJsonBytes(json, ".bindingOfReturn");
        assertEq(recorded.length, 96, "three static words, as the 96-byte check in Payroll expects");
        ISeatAdapter.Binding memory binding = abi.decode(recorded, (ISeatAdapter.Binding));
        assertEq(binding.standard, 0);
        assertEq(binding.tokenContract, Mainnet.SEATS);
        assertEq(binding.tokenId, vm.parseJsonUint(json, ".boundTokenId"));

        // The mock Adapter reverts with the same error the mainnet one recorded for an unbound agent.
        bytes memory unbound = vm.parseJsonBytes(json, ".unboundRevertData");
        assertEq(bytes4(unbound), MockAdapter.UnknownAgent.selector);
        assertEq(
            unbound,
            abi.encodeWithSelector(MockAdapter.UnknownAgent.selector, vm.parseJsonUint(json, ".unboundAgentId"))
        );
        assertEq(bytes4(vm.parseJsonBytes(json, ".missingSeatRevertData")), MockSeats.TokenDoesNotExist.selector);
        assertEq(ISeatAdapter.bindingOf.selector, bytes4(0x4d69ebc2));
        assertEq(ISeats.ownerOf.selector, bytes4(0x6352211e));
    }

    /// @dev The recorded answer for agent 52211: seat 1998, whose recorded owner is paid.
    function test_fixture_recordedBindingPaysTheRecordedSeatOwner() public {
        uint256 agentId = vm.parseJsonUint(json, ".boundAgentId");
        address owner = vm.parseJsonAddress(json, ".ownerOfBoundSeat");
        recordedAdapter.program(vm.parseJsonBytes(json, ".bindingOfReturn"), false);

        vm.prank(payer);
        p.tip(ids(agentId), 5e18);
        assertEq(p.claimTip(agentId), 5e18);
        assertEq(imd.balanceOf(owner), 5e18);

        // And a sweep of a new tip is refused while that binding stands, however long it has waited.
        vm.prank(payer);
        p.tip(ids(agentId), 1e18);
        skip(360 days);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipStillClaimable.selector, agentId, 1998));
        p.sweepTip(agentId);
    }

    /// @dev The recorded revert for an unbound agent: the tip waits, and is swept once it has waited
    /// its 180 to 360 days.
    function test_fixture_recordedUnknownAgentRevertMeansUnbound() public {
        uint256 agentId = vm.parseJsonUint(json, ".unboundAgentId");
        recordedAdapter.program(vm.parseJsonBytes(json, ".unboundRevertData"), true);

        vm.prank(payer);
        p.tip(ids(agentId), 4_000e18);
        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentNotBound.selector, agentId));
        p.claimTip(agentId);

        skip(180 days - 1);
        vm.expectRevert();
        p.sweepTip(agentId);
        skip(180 days + 1);
        assertEq(p.sweepTip(agentId), 4_000e18);
        assertEq(p.seatClaimable(1998), 2e18);
    }

    /// @dev The seat pool pays the recorded owner of seat 1998, and id 2000 is not a seat.
    function test_fixture_seatPoolPaysTheRecordedOwner() public {
        address owner = vm.parseJsonAddress(json, ".ownerOfBoundSeat");
        vm.prank(payer);
        p.pay(20_000e18, bytes32(0));
        assertEq(p.claimSeat(1998), 3e18);
        assertEq(imd.balanceOf(owner), 3e18);

        uint256 missing = vm.parseJsonUint(json, ".missingSeatId");
        vm.expectRevert(abi.encodeWithSelector(Payroll.UnknownSeat.selector, missing));
        p.claimSeat(missing);
    }
}
