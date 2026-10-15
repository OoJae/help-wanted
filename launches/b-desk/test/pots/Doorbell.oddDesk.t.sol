// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Doorbell} from "../../src/pots/Doorbell.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {OddDesk} from "./mocks/OddDesk.sol";

/// @notice The Doorbell against a desk that breaks its own interface. The real desk is immutable
/// code from the same launch and does none of this; these tests show that if a desk ever refused
/// an order, pulled the wrong amount, reused an order id, named another employer or called back in,
/// the Doorbell would stop instead of losing track of its money.
contract DoorbellOddDeskTest is Test {
    MockIMD internal imd;
    OddDesk internal desk;
    Doorbell internal bell;

    address internal ringer = makeAddr("ringer");
    address internal funder = makeAddr("funder");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant KIND = keccak256("skill:create-image");
    uint96 internal constant MIN_PAY = 1e18;
    uint96 internal constant MAX_PAY = 2e18;
    uint96 internal constant BOND = 0.5e18;
    uint32 internal constant DELIVERY = 3 days;

    function setUp() public {
        vm.warp(1_760_000_000);
        imd = new MockIMD();
        desk = new OddDesk(address(imd), makeAddr("payroll"));
        bell = new Doorbell(address(imd), address(desk), KIND, MIN_PAY, MAX_PAY, BOND, DELIVERY, true);
        imd.mint(funder, 1_000e18);
    }

    function _fund(uint256 amount) internal {
        vm.prank(funder);
        imd.transfer(address(bell), amount);
    }

    function _ring(uint256 times) internal {
        vm.startPrank(ringer);
        for (uint256 i; i < times; ++i) {
            bell.ring();
        }
        vm.stopPrank();
    }

    /// @dev Funds one order's escrow and rings until the 25th ring has opened it.
    function _hire() internal returns (uint256 orderId) {
        _fund(MAX_PAY);
        _ring(25 - bell.rings() % 25);
        orderId = bell.lastOrderId();
    }

    function test_ring_revertsAndIsNotCountedWhenTheDeskRefusesTheOrder() public {
        _fund(MAX_PAY);
        _ring(24);
        desk.setRejectOrders(true);

        vm.expectRevert(OddDesk.Rejected.selector);
        bell.ring();
        assertEq(bell.rings(), 24, "the ring that could not hire was not counted");
        assertEq(bell.hires(), 0);
        assertEq(imd.balanceOf(address(bell)), MAX_PAY);
        assertEq(imd.allowance(address(bell), address(desk)), 0);

        desk.setRejectOrders(false);
        _ring(1);
        assertEq(bell.rings(), 25);
        assertEq(bell.hires(), 1);
    }

    function test_ring_revertsWhenTheDeskPullsLessThanTheEscrow() public {
        _fund(MAX_PAY);
        _ring(24);
        desk.setPullShortBy(1);
        vm.expectRevert(abi.encodeWithSelector(Doorbell.DeskPulledWrongAmount.selector, 1));
        bell.ring();
        assertEq(bell.rings(), 24);
    }

    function test_ring_revertsWhenTheDeskReusesAnOrderId() public {
        uint256 first = _hire();
        _fund(MAX_PAY);
        _ring(24);
        desk.setReuseLastId(true);
        vm.expectRevert(abi.encodeWithSelector(Doorbell.OrderIdReused.selector, first));
        bell.ring();
        assertEq(bell.hires(), 1);
    }

    function test_ring_revertsWhenTheDeskNamesAnotherEmployer() public {
        _fund(MAX_PAY);
        _ring(24);
        desk.setReportEmployer(stranger);
        vm.expectRevert(abi.encodeWithSelector(Doorbell.NotOurOrder.selector, 1));
        bell.ring();
        assertEq(bell.hires(), 0);
    }

    function test_ring_theDeskCannotRingAgainWhileTheOrderIsBeingCreated() public {
        _fund(2 * uint256(MAX_PAY));
        _ring(24);
        desk.setReenter(address(bell), abi.encodeCall(bell.ring, ()));
        _ring(1);

        assertFalse(desk.reenterOk(), "the inner ring must fail");
        assertEq(bytes4(desk.reenterResult()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        assertEq(bell.rings(), 25, "one ring, one count");
        assertEq(bell.hires(), 1);
    }
}
