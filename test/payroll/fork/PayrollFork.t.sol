// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {Payroll} from "../../../src/payroll/Payroll.sol";
import {ISeatAdapter, ISeats} from "../../../src/interfaces/external/ISeatAdapter.sol";
import {Mainnet} from "../../../src/interfaces/external/Mainnet.sol";
import {Questions} from "../../../src/questions/Questions.sol";

/// @dev Payroll against the real IMD, sIMD, seat token and seat Adapter on a fork of Ethereum mainnet at
/// the latest block. Questions is this project's own contract, deployed on the fork with the live
/// Intake and oracle signer; its three feeds are left uncreated here, so the feed budget is not
/// exercised (`LaunchAFork.t.sol` does that with the launch feeds).
/// Run with `FOUNDRY_PROFILE=fork forge test`. Every test skips itself when the RPC cannot be reached.
contract PayrollForkTest is Test {
    uint256 internal constant BOUND_AGENT = 52211;
    uint256 internal constant BOUND_SEAT = 1998;

    IERC20 internal constant IMD = IERC20(Mainnet.IMD);
    IERC4626 internal constant SIMD = IERC4626(Mainnet.SIMD);
    ISeats internal constant SEATS = ISeats(Mainnet.SEATS);

    Payroll internal payroll;
    Questions internal questions;
    address internal payer = makeAddr("payer");
    bool internal forked;

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("mainnet")) {
            forked = true;
        } catch {
            return;
        }
        questions = new Questions(Mainnet.INTAKE, Mainnet.IMD, Mainnet.ORACLE_SIGNER);
        payroll = new Payroll(
            Mainnet.IMD,
            Mainnet.SIMD,
            Mainnet.SEATS,
            Mainnet.SEAT_COUNT,
            Mainnet.SEAT_ADAPTER,
            address(questions),
            keccak256("feed a"),
            keccak256("feed b"),
            keccak256("feed c")
        );
        deal(Mainnet.IMD, payer, 100_000e18);
        vm.prank(payer);
        IMD.approve(address(payroll), type(uint256).max);
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true, "mainnet RPC unreachable");
            return;
        }
        _;
    }

    /// @dev sIMD is what the design assumes: a 24-decimal vault over IMD whose totalAssets is its IMD
    /// balance. A drip is a plain transfer; it raises totalAssets and the price of every share.
    function test_fork_dripRaisesTotalAssetsAndTheSharePrice() public onFork {
        assertEq(SIMD.asset(), Mainnet.IMD);
        assertEq(IERC20Metadata(Mainnet.SIMD).decimals(), 24);
        assertEq(SIMD.totalAssets(), IMD.balanceOf(Mainnet.SIMD), "totalAssets is the IMD balance");
        assertGt(SIMD.totalSupply(), 0, "there are stakers");

        vm.prank(payer);
        payroll.pay(16_800e18, bytes32("fork")); // 8,400 IMD for stakers: 50 an hour
        skip(1 hours);

        uint256 assetsBefore = SIMD.totalAssets();
        uint256 supplyBefore = SIMD.totalSupply();
        uint256 priceBefore = SIMD.convertToAssets(1e24);
        uint256 positionBefore = SIMD.previewRedeem(1_000e24);

        uint256 sent = payroll.drip();

        assertEq(sent, 50e18);
        assertEq(SIMD.totalAssets(), assetsBefore + sent, "totalAssets rose by exactly what was dripped");
        assertEq(SIMD.totalSupply(), supplyBefore, "no share was minted");
        assertGt(SIMD.convertToAssets(1e24), priceBefore, "one sIMD is worth more IMD than before");
        assertGt(SIMD.previewRedeem(1_000e24), positionBefore, "and a staker's position redeems for more");
        assertEq(payroll.ledger().dripped, sent);

        // Ten minutes later the next part follows; before that, nothing can be sent.
        vm.expectRevert();
        payroll.drip();
        skip(10 minutes);
        assertGt(payroll.drip(), 0);
    }

    /// @dev The seat pool pays the real owners of real seats, read from the seat token at claim time.
    function test_fork_seatPoolPaysTheRealSeatOwners() public onFork {
        vm.prank(payer);
        payroll.pay(20_000e18, bytes32("fork")); // 6,000 IMD over 2,000 seats: 3 each

        address owner = SEATS.ownerOf(BOUND_SEAT);
        uint256 before = IMD.balanceOf(owner);
        assertEq(payroll.seatClaimable(BOUND_SEAT), 3e18);
        assertEq(payroll.claimSeat(BOUND_SEAT), 3e18);
        assertEq(IMD.balanceOf(owner) - before, 3e18);

        // The first and the last seat exist; a batch pays both.
        uint256[] memory list = new uint256[](2);
        list[0] = 0;
        list[1] = Mainnet.SEAT_COUNT - 1;
        address ownerOfFirst = SEATS.ownerOf(0);
        address ownerOfLast = SEATS.ownerOf(Mainnet.SEAT_COUNT - 1);
        uint256 heldBefore =
            IMD.balanceOf(ownerOfFirst) + (ownerOfLast == ownerOfFirst ? 0 : IMD.balanceOf(ownerOfLast));
        assertEq(payroll.claimSeats(list), 6e18);
        uint256 heldAfter = IMD.balanceOf(ownerOfFirst) + (ownerOfLast == ownerOfFirst ? 0 : IMD.balanceOf(ownerOfLast));
        assertEq(heldAfter - heldBefore, 6e18);

        // Id 2,000 is not a seat, for the token and for Payroll alike.
        vm.expectRevert();
        SEATS.ownerOf(Mainnet.SEAT_COUNT);
        vm.expectRevert(abi.encodeWithSelector(Payroll.UnknownSeat.selector, Mainnet.SEAT_COUNT));
        payroll.claimSeat(Mainnet.SEAT_COUNT);
    }

    /// @dev A tip follows the real Adapter: agent 52211 is bound to seat 1998, so its tip is paid to that
    /// seat's owner; an agent the Adapter does not know waits and is swept once it has waited its 180
    /// to 360 days.
    function test_fork_tipFollowsTheRealAdapterBinding() public onFork {
        // What the Adapter answers, and how much gas the read takes next to the cap Payroll gives it.
        uint256 gasBefore = gasleft();
        (bool ok, bytes memory answer) =
            Mainnet.SEAT_ADAPTER.staticcall(abi.encodeCall(ISeatAdapter.bindingOf, (BOUND_AGENT)));
        uint256 gasUsed = gasBefore - gasleft();
        assertTrue(ok);
        assertEq(answer.length, 96);
        ISeatAdapter.Binding memory binding = abi.decode(answer, (ISeatAdapter.Binding));
        assertEq(binding.tokenContract, Mainnet.SEATS);
        assertEq(binding.tokenId, BOUND_SEAT);
        console.log("gas used by the real bindingOf (cold):", gasUsed);
        assertLt(gasUsed, payroll.BINDING_GAS() / 2, "the cap leaves the real Adapter ample room");

        uint256 unknownAgent = type(uint256).max - 7;
        uint256[] memory list = new uint256[](2);
        list[0] = BOUND_AGENT;
        list[1] = unknownAgent;
        vm.prank(payer);
        payroll.tip(list, 10e18);

        address owner = SEATS.ownerOf(BOUND_SEAT);
        uint256 before = IMD.balanceOf(owner);
        assertEq(payroll.claimTip(BOUND_AGENT), 5e18);
        assertEq(IMD.balanceOf(owner) - before, 5e18);

        vm.expectRevert(abi.encodeWithSelector(Payroll.AgentNotBound.selector, unknownAgent));
        payroll.claimTip(unknownAgent);

        // A tip that can be claimed is never swept, however old; one that cannot is, after its wait.
        vm.prank(payer);
        payroll.tip(list, 10e18);
        (,, uint256 sweepableFrom) = payroll.tipOf(unknownAgent);
        assertGe(sweepableFrom, vm.getBlockTimestamp() + 180 days);
        assertLe(sweepableFrom, vm.getBlockTimestamp() + 360 days);
        vm.warp(sweepableFrom);
        vm.expectRevert(abi.encodeWithSelector(Payroll.TipStillClaimable.selector, BOUND_AGENT, BOUND_SEAT));
        payroll.sweepTip(BOUND_AGENT);
        uint256 accruedBefore = payroll.seatAccrued() * Mainnet.SEAT_COUNT + payroll.seatCarry();
        assertEq(payroll.sweepTip(unknownAgent), 10e18);
        assertEq(payroll.seatAccrued() * Mainnet.SEAT_COUNT + payroll.seatCarry() - accruedBefore, 10e18);
        assertEq(payroll.claimTip(BOUND_AGENT), 5e18);
    }
}
