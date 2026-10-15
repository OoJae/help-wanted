// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {CallbackToken, MockIMD} from "./mocks/MockIMD.sol";
import {Inert, PotsBase} from "./PotsBase.sol";

contract CrowdPotsTest is PotsBase {
    // ------------------------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------------------------

    function test_constructor_storesTheTwoAddressesAndStartsEmpty() public view {
        assertEq(address(pots.IMD()), address(imd));
        assertEq(address(pots.WORK_ORDERS()), address(desk));
        assertEq(pots.potCount(), 0);
        assertEq(pots.owed(), 0);
    }

    function test_constructor_makesNoCall_soItRunsOnAnEmptyChain() public {
        // Neither address has code. A constructor that called them or checked their code would revert.
        CrowdPots c = new CrowdPots(address(0xA11CE), address(0xB0B));
        assertEq(address(c.IMD()), address(0xA11CE));
        assertEq(address(c.WORK_ORDERS()), address(0xB0B));
    }

    /// @dev An external call, so that a constructor revert is one call deep. A test that expects
    /// the revert of a `new` written in its own body ends there, and what follows never runs.
    function deployPots(address imd_, address desk_) external returns (CrowdPots) {
        return new CrowdPots(imd_, desk_);
    }

    function test_constructor_revertsOnAZeroAddress() public {
        vm.expectRevert(CrowdPots.ZeroAddress.selector);
        this.deployPots(address(0), address(desk));
        vm.expectRevert(CrowdPots.ZeroAddress.selector);
        this.deployPots(address(imd), address(0));
        vm.expectRevert(CrowdPots.ZeroAddress.selector);
        this.deployPots(address(0), address(0));
        // And the same helper deploys when both are given.
        assertEq(address(this.deployPots(address(imd), address(desk)).IMD()), address(imd));
    }

    function test_constants() public view {
        assertEq(pots.MIN_TARGET(), 1e18);
        assertEq(pots.MIN_FUND_SECS(), 1 hours);
        assertEq(pots.MAX_FUND_SECS(), 30 days);
        assertEq(pots.LAUNCH_GRACE(), 1 days);
        assertEq(pots.MIN_HIRE_SECS(), 1 days);
        assertEq(pots.MAX_HIRE_SECS(), 30 days);
        assertEq(pots.MAX_DELIVERY_SECS(), 30 days);
        assertEq(pots.MAX_KIND_LENGTH(), 64);
    }

    // ------------------------------------------------------------------------------------------
    // openPot
    // ------------------------------------------------------------------------------------------

    function test_openPot_storesEveryTermAndPublishesTheSpec() public {
        CrowdPots.Terms memory t = _rampTerms();
        t.allowClaimed = true;

        vm.expectEmit(address(pots));
        emit CrowdPots.SpecPinned(keccak256(SPEC), SPEC);
        vm.expectEmit(address(pots));
        emit CrowdPots.PotOpened(1, opener, 0, keccak256(SPEC), uint40(START + t.fundSecs), t);
        uint256 potId = _open(t);

        assertEq(potId, 1, "ids start at 1");
        assertEq(pots.potCount(), 1);
        CrowdPots.Pot memory p = pots.potOf(potId);
        assertEq(p.specHash, keccak256(SPEC));
        assertEq(p.kindHash, KIND);
        assertEq(p.target, t.target);
        assertEq(p.raised, 0);
        assertEq(p.deadline, START + t.fundSecs);
        assertEq(uint256(p.stage), uint256(CrowdPots.Stage.Funding));
        assertTrue(p.allowClaimed);
        assertEq(p.minPay, t.minPay);
        assertEq(p.bond, t.bond);
        assertEq(p.rampSecs, t.rampSecs);
        assertEq(p.deliverySecs, t.deliverySecs);
        assertEq(p.opener, opener);
        assertEq(p.hireSecs, t.hireSecs);
        assertEq(p.fundSecs, t.fundSecs);
        assertEq(p.pool, 0);
        assertEq(p.chipsLeft, 0);
        assertEq(p.orderExpiresAt, 0);
        assertEq(p.seriesId, 0);
        assertEq(p.orderId, 0);
        assertEq(p.jobId, bytes16(0));
        assertEq(p.recordHash, bytes32(0));
        assertEq(pots.remaining(potId), t.target);
        assertEq(imd.balanceOf(address(pots)), 0, "opening moves no money");
    }

    function test_openPot_withAFirstChip_pullsItFromTheOpener() public {
        vm.expectEmit(address(pots));
        emit CrowdPots.ChippedIn(1, opener, opener, 2e18, 2e18);
        vm.prank(opener);
        uint256 potId = pots.openPot(_terms(), SPEC, 2e18);

        (uint256 amount,,) = pots.chipOf(potId, opener);
        assertEq(amount, 2e18);
        assertEq(pots.potOf(potId).raised, 2e18);
        assertEq(imd.balanceOf(address(pots)), 2e18);
        assertEq(imd.balanceOf(opener), WALLET - 2e18);
        assertEq(pots.owed(), 2e18);
    }

    function test_openPot_aFirstChipAboveTheTargetIsCut() public {
        vm.prank(opener);
        uint256 potId = pots.openPot(_terms(), SPEC, 25e18);
        assertEq(pots.potOf(potId).raised, 10e18);
        assertEq(imd.balanceOf(opener), WALLET - 10e18);
    }

    function test_openPot_idsCountUp() public {
        assertEq(_open(_terms()), 1);
        assertEq(_open(_terms()), 2);
        assertEq(_open(_rampTerms()), 3);
        assertEq(pots.potCount(), 3);
    }

    function test_openPot_acceptsEveryTermAtItsBound() public {
        CrowdPots.Terms memory t = _terms();
        t.target = pots.MIN_TARGET();
        t.minPay = 1;
        t.rampSecs = 1 days;
        t.bond = desk.MIN_BOND();
        t.deliverySecs = desk.MIN_DELIVERY();
        t.hireSecs = pots.MIN_HIRE_SECS();
        t.fundSecs = pots.MIN_FUND_SECS();
        _open(t);

        t.target = type(uint96).max;
        t.minPay = type(uint96).max;
        t.rampSecs = 0;
        t.bond = type(uint96).max;
        t.deliverySecs = pots.MAX_DELIVERY_SECS();
        t.hireSecs = pots.MAX_HIRE_SECS();
        t.fundSecs = pots.MAX_FUND_SECS();
        _open(t);
    }

    function _expectOpenRevert(CrowdPots.Terms memory t, bytes4 selector) internal {
        vm.expectRevert(selector);
        vm.prank(opener);
        pots.openPot(t, SPEC, 0);
        // A series is held to exactly the same terms.
        vm.expectRevert(selector);
        vm.prank(opener);
        pots.openSeries(t, SPEC);
    }

    function test_openPot_revertsWithoutAKind() public {
        CrowdPots.Terms memory t = _terms();
        t.kind = "";
        _expectOpenRevert(t, CrowdPots.KindMissing.selector);
    }

    function test_openPot_revertsBelowTheMinimumTarget() public {
        CrowdPots.Terms memory t = _terms();
        t.target = 1e18 - 1;
        t.minPay = t.target;
        t.bond = 0.25e18;
        _expectOpenRevert(t, CrowdPots.TargetTooSmall.selector);
    }

    function test_openPot_revertsOnAZeroStartingPrice() public {
        CrowdPots.Terms memory t = _rampTerms();
        t.minPay = 0;
        _expectOpenRevert(t, CrowdPots.BadPriceRamp.selector);
    }

    function test_openPot_revertsWhenTheStartingPriceIsAboveTheTarget() public {
        CrowdPots.Terms memory t = _terms();
        t.minPay = t.target + 1;
        _expectOpenRevert(t, CrowdPots.BadPriceRamp.selector);
    }

    function test_openPot_revertsOnARampForAFixedPrice() public {
        CrowdPots.Terms memory t = _terms();
        t.rampSecs = 1;
        _expectOpenRevert(t, CrowdPots.BadPriceRamp.selector);
    }

    function test_openPot_revertsOnARisingPriceWithNoRampTime() public {
        CrowdPots.Terms memory t = _rampTerms();
        t.rampSecs = 0;
        _expectOpenRevert(t, CrowdPots.BadPriceRamp.selector);
    }

    function test_openPot_revertsWhenTheRampOutlastsTheHireWindow() public {
        CrowdPots.Terms memory t = _rampTerms();
        t.rampSecs = t.hireSecs + 1;
        _expectOpenRevert(t, CrowdPots.BadPriceRamp.selector);
        t.rampSecs = t.hireSecs;
        _open(t);
    }

    function test_openPot_revertsOnABondBelowTheDesksMinimum() public {
        CrowdPots.Terms memory t = _terms();
        t.bond = desk.MIN_BOND() - 1;
        _expectOpenRevert(t, CrowdPots.BondOutOfRange.selector);
    }

    function test_openPot_revertsOnABondAboveTheTarget() public {
        CrowdPots.Terms memory t = _terms();
        t.bond = t.target + 1;
        _expectOpenRevert(t, CrowdPots.BondOutOfRange.selector);
        t.bond = t.target;
        _open(t);
    }

    function test_openPot_revertsOnADeliveryTimeOutOfRange() public {
        CrowdPots.Terms memory t = _terms();
        t.deliverySecs = desk.MIN_DELIVERY() - 1;
        _expectOpenRevert(t, CrowdPots.DeliveryOutOfRange.selector);
        t.deliverySecs = pots.MAX_DELIVERY_SECS() + 1;
        _expectOpenRevert(t, CrowdPots.DeliveryOutOfRange.selector);
    }

    function test_openPot_revertsOnAHireWindowOutOfRange() public {
        CrowdPots.Terms memory t = _terms();
        t.hireSecs = pots.MIN_HIRE_SECS() - 1;
        _expectOpenRevert(t, CrowdPots.HireWindowOutOfRange.selector);
        t.hireSecs = pots.MAX_HIRE_SECS() + 1;
        _expectOpenRevert(t, CrowdPots.HireWindowOutOfRange.selector);
    }

    function test_openPot_revertsOnAFundingWindowOutOfRange() public {
        CrowdPots.Terms memory t = _terms();
        t.fundSecs = pots.MIN_FUND_SECS() - 1;
        _expectOpenRevert(t, CrowdPots.FundingWindowOutOfRange.selector);
        t.fundSecs = pots.MAX_FUND_SECS() + 1;
        _expectOpenRevert(t, CrowdPots.FundingWindowOutOfRange.selector);
    }

    function _expectSpecRevert(bytes memory spec, uint256 at) internal {
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.SpecInvalid.selector, at));
        vm.prank(opener);
        pots.openPot(_terms(), spec, 0);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.SpecInvalid.selector, at));
        vm.prank(opener);
        pots.openSeries(_terms(), spec);
    }

    function test_openPot_revertsOnASpecTheDeskWouldRefuse() public {
        _expectSpecRevert("", 0);
        _expectSpecRevert(" leading space", 0);
        _expectSpecRevert("trailing space ", 14);
        _expectSpecRevert('say "hello" to the swarm', 4);
        _expectSpecRevert("a back\\slash", 6);
        _expectSpecRevert("line one\nline two", 8);
        _expectSpecRevert(hex"61627f", 2);
        _expectSpecRevert(unicode"café", 3);
        _expectSpecRevert(new bytes(7_901), 7_900);
    }

    function test_openPot_acceptsTheLongestSpec() public {
        bytes memory spec = new bytes(7_900);
        for (uint256 i; i < spec.length; ++i) {
            spec[i] = "a";
        }
        vm.prank(opener);
        uint256 potId = pots.openPot(_terms(), spec, 0);
        assertEq(pots.potOf(potId).specHash, keccak256(spec));
    }

    function test_openPot_revertsWhenTheDeskEscrowsAnotherToken() public {
        MockIMD other = new MockIMD();
        CrowdPots c = new CrowdPots(address(other), address(desk));
        vm.expectRevert(CrowdPots.DeskTokenMismatch.selector);
        c.openPot(_terms(), SPEC, 0);
    }

    function test_openPot_revertsWhenTheDeskHasNoCode() public {
        CrowdPots c = new CrowdPots(address(imd), address(0xDE5C));
        vm.expectRevert();
        c.openPot(_terms(), SPEC, 0);
    }

    // ------------------------------------------------------------------------------------------
    // chipIn and chipInFor
    // ------------------------------------------------------------------------------------------

    function test_chipIn_pullsTheChipAndCreditsTheCaller() public {
        uint256 potId = _open(_terms());

        vm.expectEmit(address(pots));
        emit CrowdPots.ChippedIn(potId, alice, alice, 3e18, 3e18);
        uint256 taken = _chip(alice, potId, 3e18);

        assertEq(taken, 3e18);
        (uint256 amount, uint256 refunded, bool claimed) = pots.chipOf(potId, alice);
        assertEq(amount, 3e18);
        assertEq(refunded, 0);
        assertFalse(claimed);
        assertEq(pots.potOf(potId).raised, 3e18);
        assertEq(pots.remaining(potId), 7e18);
        assertEq(imd.balanceOf(address(pots)), 3e18);
        assertEq(imd.balanceOf(alice), WALLET - 3e18);
        assertEq(pots.owed(), 3e18);
    }

    function test_chipIn_addsUpRepeatChips() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 1e18);
        _chip(bob, potId, 2e18);
        _chip(alice, potId, 3e18);
        (uint256 amount,,) = pots.chipOf(potId, alice);
        assertEq(amount, 4e18);
        assertEq(pots.potOf(potId).raised, 6e18);
    }

    function test_chipIn_isCutToWhatThePotStillNeeds() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 7e18);

        vm.expectEmit(address(pots));
        emit CrowdPots.ChippedIn(potId, bob, bob, 3e18, 10e18);
        vm.expectEmit(address(pots));
        emit CrowdPots.PotFilled(potId, 10e18);
        uint256 taken = _chip(bob, potId, 50e18);

        assertEq(taken, 3e18, "only the missing part is taken");
        assertEq(imd.balanceOf(bob), WALLET - 3e18);
        assertEq(pots.remaining(potId), 0);
    }

    function test_chipIn_afterTheTargetIsMet_takesNothing() public {
        uint256 potId = _filled(_terms());
        uint256 before = imd.balanceOf(bob);

        vm.recordLogs();
        uint256 taken = _chip(bob, potId, 1e18);

        assertEq(taken, 0);
        assertEq(vm.getRecordedLogs().length, 0, "no event, no transfer");
        assertEq(imd.balanceOf(bob), before);
        assertEq(pots.potOf(potId).raised, 10e18);
    }

    function test_chipIn_isAcceptedUpToTheDeadlineSecondAndNotAfter() public {
        uint256 potId = _open(_terms());
        vm.warp(pots.potOf(potId).deadline);
        assertEq(_chip(alice, potId, 1e18), 1e18);

        vm.warp(pots.potOf(potId).deadline + 1);
        assertEq(pots.remaining(potId), 0);
        assertEq(_chip(alice, potId, 1e18), 0);
        assertEq(pots.potOf(potId).raised, 1e18);
    }

    function test_chipIn_afterLaunch_takesNothing() public {
        (uint256 potId,) = _launched(_terms());
        assertEq(pots.remaining(potId), 0);
        assertEq(_chip(alice, potId, 1e18), 0);
    }

    function test_chipIn_toAnUnknownPot_takesNothing() public {
        assertEq(pots.remaining(0), 0);
        assertEq(pots.remaining(99), 0);
        assertEq(_chip(alice, 0, 1e18), 0);
        assertEq(_chip(alice, 99, 1e18), 0);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    function test_chipIn_ofZero_takesNothing() public {
        uint256 potId = _open(_terms());
        assertEq(_chip(alice, potId, 0), 0);
    }

    function test_chipIn_revertsWithoutAnAllowance() public {
        uint256 potId = _open(_terms());
        address newcomer = makeAddr("newcomer");
        imd.mint(newcomer, 5e18);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(pots), 0, 1e18)
        );
        vm.prank(newcomer);
        pots.chipIn(potId, 1e18);
    }

    function test_chipIn_revertsWithoutTheBalance() public {
        uint256 potId = _open(_terms());
        address newcomer = makeAddr("newcomer");
        vm.prank(newcomer);
        imd.approve(address(pots), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, newcomer, 0, 1e18));
        vm.prank(newcomer);
        pots.chipIn(potId, 1e18);
    }

    function test_chipInFor_theCallerPaysAndTheBeneficiaryOwnsTheChip() public {
        uint256 potId = _open(_terms());

        vm.expectEmit(address(pots));
        emit CrowdPots.ChippedIn(potId, bob, alice, 4e18, 4e18);
        vm.prank(alice);
        uint256 taken = pots.chipInFor(potId, 4e18, bob);

        assertEq(taken, 4e18);
        (uint256 bobChip,,) = pots.chipOf(potId, bob);
        (uint256 aliceChip,,) = pots.chipOf(potId, alice);
        assertEq(bobChip, 4e18);
        assertEq(aliceChip, 0);
        assertEq(imd.balanceOf(alice), WALLET - 4e18);
        assertEq(imd.balanceOf(bob), WALLET);
    }

    function test_chipInFor_theRefundGoesToTheBeneficiaryNotThePayer() public {
        uint256 potId = _open(_terms());
        vm.prank(alice);
        pots.chipInFor(potId, 4e18, bob);
        vm.warp(pots.potOf(potId).deadline + 1);

        assertEq(_claim(potId, alice), 0, "the payer has no chip");
        assertEq(_claim(potId, bob), 4e18);
        assertEq(imd.balanceOf(bob), WALLET + 4e18);
        assertEq(imd.balanceOf(alice), WALLET - 4e18);
    }

    function test_chipInFor_revertsForTheZeroAddressAndForThePotsContract() public {
        uint256 potId = _open(_terms());
        vm.startPrank(alice);
        vm.expectRevert(CrowdPots.BadBeneficiary.selector);
        pots.chipInFor(potId, 1e18, address(0));
        vm.expectRevert(CrowdPots.BadBeneficiary.selector);
        pots.chipInFor(potId, 1e18, address(pots));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------
    // launch
    // ------------------------------------------------------------------------------------------

    function test_launch_putsTheWholeAmountOnTheDeskWithThePinnedTerms() public {
        CrowdPots.Terms memory t = _rampTerms();
        uint256 potId = _filled(t);
        vm.warp(START + 1 hours);

        vm.expectEmit(address(pots));
        emit CrowdPots.PotLaunched(potId, 1, stranger, t.target, uint40(vm.getBlockTimestamp() + t.hireSecs));
        uint256 orderId = _launch(potId);

        assertEq(orderId, 1);
        IWorkOrdersRunner.Order memory o = desk.orderOf(orderId);
        assertEq(o.kindHash, KIND);
        assertEq(o.minPay, t.minPay);
        assertEq(o.maxPay, t.target, "the whole amount");
        assertEq(o.rampSecs, t.rampSecs);
        assertEq(o.deliverySecs, t.deliverySecs);
        assertEq(o.expiresAt, vm.getBlockTimestamp() + t.hireSecs);
        assertEq(o.bond, t.bond);
        assertEq(o.flags, desk.FLAG_CALLBACK(), "callback only: the claimed path was not allowed");
        assertEq(o.runnerOnly, address(0), "any runner");
        assertEq(o.arbiter, address(0), "no arbiter");
        assertEq(o.condTarget, address(0), "no condition");
        assertEq(o.condSelector, bytes4(0));
        assertEq(o.condArg, bytes32(0));
        assertEq(o.condCmp, 0);
        assertEq(o.condThreshold, 0);
        assertEq(o.specHash, keccak256(SPEC), "the spec byte for byte");
        assertEq(o.employer, address(pots));

        (IWorkOrders.State state, address employer, uint96 escrow, uint96 spent, uint96 returned) =
            desk.accountOf(orderId);
        assertEq(uint256(state), uint256(IWorkOrders.State.Open));
        assertEq(employer, address(pots));
        assertEq(escrow, t.target);
        assertEq(spent, 0);
        assertEq(returned, 0);

        CrowdPots.Pot memory p = pots.potOf(potId);
        assertEq(uint256(p.stage), uint256(CrowdPots.Stage.Hiring));
        assertEq(p.orderId, orderId);
        assertEq(p.orderExpiresAt, vm.getBlockTimestamp() + t.hireSecs);
        assertEq(pots.potOfOrder(orderId), potId);
        assertEq(imd.balanceOf(address(pots)), 0);
        assertEq(imd.balanceOf(address(desk)), t.target);
        assertEq(pots.owed(), 0);
        assertEq(imd.allowance(address(pots), address(desk)), 0, "no allowance is left behind");
    }

    function test_launch_setsTheClaimedFlagOnlyWhenThePotAllowedIt() public {
        CrowdPots.Terms memory t = _terms();
        t.allowClaimed = true;
        (, uint256 orderId) = _launched(t);
        assertEq(desk.orderOf(orderId).flags, desk.FLAG_CALLBACK() | desk.FLAG_ALLOW_CLAIMED());
    }

    function test_launch_worksAtTheDeadlineSecond() public {
        uint256 potId = _filled(_terms());
        vm.warp(pots.potOf(potId).deadline);
        _launch(potId);
        _assertStage(potId, CrowdPots.Stage.Hiring);
    }

    function test_launch_aFullPotCanStillBeLaunchedForADayAfterItsDeadline() public {
        uint256 potId = _filled(_terms());
        uint256 deadline = pots.potOf(potId).deadline;

        vm.warp(deadline + 1);
        _assertLiveStage(potId, CrowdPots.Stage.Funding);
        assertEq(pots.remaining(potId), 0, "full, so it takes no chip");
        assertEq(pots.refundOf(potId, alice), 0, "nothing to refund while it can still hire");
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Funding));
        pots.claimRefund(potId, alice);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Funding));

        vm.warp(deadline + pots.LAUNCH_GRACE());
        uint256 orderId = _launch(potId);
        _assertStage(potId, CrowdPots.Stage.Hiring);
        assertEq(pots.potOf(potId).orderExpiresAt, vm.getBlockTimestamp() + 7 days, "the hire window starts at launch");
        assertEq(desk.orderOf(orderId).expiresAt, vm.getBlockTimestamp() + 7 days);
    }

    function test_launch_revertsOnceTheGraceIsOver_evenForAFullPot() public {
        uint256 potId = _filled(_terms());
        vm.warp(_afterLaunchTime(potId));
        _assertLiveStage(potId, CrowdPots.Stage.Refundable);
        vm.expectRevert(CrowdPots.PastDeadline.selector);
        pots.launch(potId, SPEC);
    }

    /// A pot that fills in its very last second has no block left to be launched in. It used to
    /// become refundable at once, although the crowd had funded it in time.
    function test_launch_aPotThatFillsInItsLastSecondCanStillHire() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 9e18);
        uint256 deadline = pots.potOf(potId).deadline;

        vm.warp(deadline);
        assertEq(_chip(bob, potId, 1e18), 1e18, "the last chip is accepted");
        assertEq(pots.potOf(potId).raised, pots.potOf(potId).target, "the target was met in time");

        // The next block, twelve seconds later.
        vm.warp(deadline + 12);
        _assertLiveStage(potId, CrowdPots.Stage.Funding);
        _launch(potId);
        _assertStage(potId, CrowdPots.Stage.Hiring);
        assertEq(imd.balanceOf(address(desk)), 10e18);
    }

    function test_launch_anUnfilledPotGetsNoGrace() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 10e18 - 1);
        vm.warp(pots.potOf(potId).deadline + 1);

        _assertLiveStage(potId, CrowdPots.Stage.Refundable);
        assertEq(_chip(bob, potId, 1), 0, "no chip can fill it after the deadline");
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.NotFull.selector, 1));
        pots.launch(potId, SPEC);
        assertEq(_claim(potId, alice), 10e18 - 1);
    }

    function test_launch_revertsUntilTheTargetIsMet() public {
        uint256 potId = _open(_terms());
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.NotFull.selector, 10e18));
        pots.launch(potId, SPEC);
        _chip(alice, potId, 10e18 - 1);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.NotFull.selector, 1));
        pots.launch(potId, SPEC);
    }

    function test_launch_revertsOnAnyTextButThePinnedSpec() public {
        uint256 potId = _filled(_terms());
        vm.expectRevert(CrowdPots.WrongSpec.selector);
        pots.launch(potId, "Audit something else entirely.");
        vm.expectRevert(CrowdPots.WrongSpec.selector);
        pots.launch(potId, "");
    }

    function test_launch_twice_reverts() public {
        (uint256 potId,) = _launched(_terms());
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Hiring));
        pots.launch(potId, SPEC);
        assertEq(desk.orderCount(), 1, "one order only");
    }

    function test_launch_revertsForAnUnknownPot() public {
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.None));
        pots.launch(7, SPEC);
    }

    function test_launch_revertsOnceThePotIsRefundable() public {
        uint256 potId = _filled(_terms());
        vm.warp(_afterLaunchTime(potId));
        pots.reconcile(potId);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Refundable));
        pots.launch(potId, SPEC);
    }

    function test_launch_theOpenerHasNoSayAndAnyoneMayLaunch() public {
        uint256 potId = _filled(_terms());
        vm.prank(carol);
        pots.launch(potId, SPEC);
        _assertStage(potId, CrowdPots.Stage.Hiring);
    }

    // ------------------------------------------------------------------------------------------
    // onWorkDelivered
    // ------------------------------------------------------------------------------------------

    function test_onWorkDelivered_recordsTheReceiptAndMovesNoMoney() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        uint256 before = imd.balanceOf(address(pots));

        vm.expectEmit(address(pots));
        emit CrowdPots.WorkDelivered(potId, orderId, JOB, RECEIPT);
        vm.prank(address(desk));
        pots.onWorkDelivered(orderId, JOB, RECEIPT);

        CrowdPots.Pot memory p = pots.potOf(potId);
        assertEq(p.jobId, JOB);
        assertEq(p.recordHash, RECEIPT);
        assertEq(uint256(p.stage), uint256(CrowdPots.Stage.Hiring), "the callback alone settles nothing");
        assertEq(imd.balanceOf(address(pots)), before);
        assertEq(pots.owed(), 0);
    }

    function test_onWorkDelivered_revertsForAnyCallerButTheDesk() public {
        (, uint256 orderId) = _launched(_terms());
        vm.expectRevert(CrowdPots.NotDesk.selector);
        vm.prank(stranger);
        pots.onWorkDelivered(orderId, JOB, RECEIPT);
        vm.expectRevert(CrowdPots.NotDesk.selector);
        vm.prank(opener);
        pots.onWorkDelivered(orderId, JOB, RECEIPT);
    }

    function test_onWorkDelivered_revertsForAnOrderThatIsNotAPots() public {
        _launched(_terms());
        // An order somebody else placed on the same desk.
        IWorkOrders.OrderParams memory o;
        o.kindHash = KIND;
        o.minPay = 10e18;
        o.maxPay = 10e18;
        o.deliverySecs = 7 days;
        o.bond = 1e18;
        o.flags = desk.FLAG_CALLBACK();
        o.expiresAt = uint40(vm.getBlockTimestamp() + 1 days);
        vm.prank(stranger);
        uint256 foreign = desk.createOrder(o, SPEC);

        vm.expectRevert(abi.encodeWithSelector(CrowdPots.UnknownOrder.selector, foreign));
        vm.prank(address(desk));
        pots.onWorkDelivered(foreign, JOB, RECEIPT);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.UnknownOrder.selector, 0));
        vm.prank(address(desk));
        pots.onWorkDelivered(0, JOB, RECEIPT);
    }

    function test_onWorkDelivered_touchesOnlyThePotOfThatOrder() public {
        (uint256 potA, uint256 orderA) = _launched(_terms());
        (uint256 potB,) = _launched(_terms());
        vm.prank(address(desk));
        pots.onWorkDelivered(orderA, JOB, RECEIPT);
        assertEq(pots.potOf(potA).recordHash, RECEIPT);
        assertEq(pots.potOf(potB).recordHash, bytes32(0));
        assertEq(pots.potOf(potB).jobId, bytes16(0));
    }

    function test_onWorkDelivered_arrivesThroughTheDesksGasCappedCall() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        _takeAndRegister(orderId, runner);
        // As in a real settlement transaction, none of the pots' storage has been touched yet.
        vm.cool(address(pots));
        bytes32 receipt = _settle(orderId);

        assertTrue(desk.orderOf(orderId).notified, "the callback fits in the desk's 150,000 gas");
        assertEq(pots.potOf(potId).jobId, JOB);
        assertEq(pots.potOf(potId).recordHash, receipt, "the hash of the record that was proven");
    }

    function test_onWorkDelivered_usesWellUnderTheDesksAllowance() public {
        (, uint256 orderId) = _launched(_terms());
        vm.cool(address(pots));
        vm.prank(address(desk));
        uint256 before = gasleft();
        pots.onWorkDelivered(orderId, JOB, RECEIPT);
        uint256 used = before - gasleft();
        assertLt(used, 75_000, "half the desk's allowance");
    }

    // ------------------------------------------------------------------------------------------
    // reconcile: pots that never hired
    // ------------------------------------------------------------------------------------------

    function test_reconcile_beforeTheDeadline_changesNothing() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 4e18);
        vm.recordLogs();
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Funding));
        assertEq(vm.getRecordedLogs().length, 0);
        _assertLiveStage(potId, CrowdPots.Stage.Funding);
    }

    function test_reconcile_afterTheDeadline_makesAnUnfilledPotRefundable() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 4e18);
        _chip(bob, potId, 1e18);
        vm.warp(pots.potOf(potId).deadline + 1);

        _assertStage(potId, CrowdPots.Stage.Funding);
        _assertLiveStage(potId, CrowdPots.Stage.Refundable);

        vm.expectEmit(address(pots));
        emit CrowdPots.PotSettled(potId, CrowdPots.Stage.Refundable, 0, 5e18);
        vm.prank(stranger);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));

        CrowdPots.Pot memory p = pots.potOf(potId);
        assertEq(p.pool, 5e18);
        assertEq(p.chipsLeft, 5e18);
        assertEq(pots.owed(), 5e18, "the chips were booked all along");
    }

    function test_reconcile_isIdempotent() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 4e18);
        vm.warp(pots.potOf(potId).deadline + 1);
        pots.reconcile(potId);
        vm.recordLogs();
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(pots.potOf(potId).pool, 4e18);
        assertEq(pots.owed(), 4e18);
    }

    function test_reconcile_anEmptyExpiredPotSettlesWithNothing() public {
        uint256 potId = _open(_terms());
        vm.warp(pots.potOf(potId).deadline + 1);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));
        assertEq(pots.potOf(potId).pool, 0);
        assertEq(_claim(potId, alice), 0);
    }

    function test_reconcile_ofAnUnknownPot_returnsNone() public {
        assertEq(uint256(pots.reconcile(42)), uint256(CrowdPots.Stage.None));
        _assertLiveStage(42, CrowdPots.Stage.None);
    }

    // ------------------------------------------------------------------------------------------
    // reconcile: pots that hired
    // ------------------------------------------------------------------------------------------

    function test_reconcile_staysHiringThroughEveryLiveOrderState() public {
        CrowdPots.Terms memory t = _terms();
        t.allowClaimed = true;
        (uint256 potId, uint256 orderId) = _launched(t);

        _assertOrderState(orderId, IWorkOrders.State.Open);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        _take(orderId, runner);
        _assertOrderState(orderId, IWorkOrders.State.Claimed);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        _register(orderId, runner);
        _assertOrderState(orderId, IWorkOrders.State.Registered);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        vm.prank(runner);
        desk.claimDelivered(orderId, RECEIPT);
        _assertOrderState(orderId, IWorkOrders.State.Asserted);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        vm.prank(challenger);
        desk.challenge(orderId);
        _assertOrderState(orderId, IWorkOrders.State.Disputed);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Hiring));
        pots.claimRefund(potId, alice);
        assertEq(pots.refundOf(potId, alice), 0);
        assertEq(pots.owed(), 0);
    }

    function test_reconcile_deliveredAtTheFullPrice_leavesNothingToRefund() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        _deliver(orderId);

        _assertStage(potId, CrowdPots.Stage.Hiring);
        _assertLiveStage(potId, CrowdPots.Stage.Delivered);

        vm.expectEmit(address(pots));
        emit CrowdPots.PotSettled(potId, CrowdPots.Stage.Delivered, 10e18, 0);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));

        assertEq(pots.potOf(potId).pool, 0);
        assertEq(pots.owed(), 0);
        assertEq(_claim(potId, alice), 0);
        assertEq(imd.balanceOf(alice), WALLET - 5e18, "the chip paid for the work");
        assertEq(imd.balanceOf(address(pots)), 0);
    }

    function test_reconcile_deliveredForLess_returnsTheDifferenceProRata() public {
        (uint256 potId, uint256 orderId) = _launched(_rampTerms());
        // A quarter of the way up the ramp: 4 + 6/4 = 5.5 IMD.
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        _deliver(orderId);

        vm.expectEmit(address(pots));
        emit CrowdPots.PotSettled(potId, CrowdPots.Stage.Delivered, 5.5e18, 4.5e18);
        pots.reconcile(potId);

        assertEq(pots.owed(), 4.5e18);
        assertEq(imd.balanceOf(address(pots)), 4.5e18);
        assertEq(pots.refundOf(potId, alice), 2.25e18);
        assertEq(_claim(potId, alice), 2.25e18);
        assertEq(_claim(potId, bob), 1.35e18);
        assertEq(_claim(potId, carol), 0.9e18);
        assertEq(imd.balanceOf(address(pots)), 0);
        assertEq(pots.owed(), 0);
        assertEq(pots.potOf(potId).jobId, JOB, "the callback recorded the job");
    }

    function test_reconcile_anOrderThatReopensSeveralTimes_thenDelivers() public {
        CrowdPots.Terms memory t = _terms();
        t.hireSecs = 30 days;
        t.deliverySecs = 3 days;
        (uint256 potId, uint256 orderId) = _launched(t);

        // First runner gives the order back: a tenth of its bond is the pot's.
        _take(orderId, stranger);
        vm.prank(stranger);
        desk.release(orderId);
        _assertOrderState(orderId, IWorkOrders.State.Open);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        // Second runner sits on it past the claim window: the whole bond.
        _take(orderId, runner2);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        desk.evict(orderId);
        _assertOrderState(orderId, IWorkOrders.State.Open);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        // Third runner registers a job and no receipt comes: the whole bond again.
        _takeAndRegister(orderId, challenger);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        desk.timeout(orderId);
        _assertOrderState(orderId, IWorkOrders.State.Open);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        // The forfeited bonds are in the contract but booked to nobody yet.
        assertEq(imd.balanceOf(address(pots)), 2.1e18);
        assertEq(pots.owed(), 0);
        assertEq(pots.refundOf(potId, alice), 0);

        // Fourth time lucky.
        _deliver(orderId);
        vm.expectEmit(address(pots));
        emit CrowdPots.PotSettled(potId, CrowdPots.Stage.Delivered, 10e18, 2.1e18);
        pots.reconcile(potId);

        assertEq(_returned(orderId), 2.1e18);
        assertEq(_claim(potId, alice), 1.05e18);
        assertEq(_claim(potId, bob), 0.63e18);
        assertEq(_claim(potId, carol), 0.42e18);
        assertEq(imd.balanceOf(address(pots)), 0);
    }

    function test_reconcile_anOrderThatExpiresUntaken_isRefundedInOneCall() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.warp(pots.potOf(potId).orderExpiresAt);
        _assertOrderState(orderId, IWorkOrders.State.Open);

        // Nobody called the desk: reconcile asks it for the refund itself.
        vm.expectEmit(address(pots));
        emit CrowdPots.PotSettled(potId, CrowdPots.Stage.Refundable, 0, 10e18);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));

        _assertOrderState(orderId, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(address(pots)), 10e18);
        assertEq(pots.owed(), 10e18);
    }

    function test_views_lookOneStepAheadForAnOrderThatExpiredUntaken() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        // A runner forfeits a bond first, so the forecast has two parts: 1 returned, 10 in escrow.
        _take(orderId, runner2);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        desk.evict(orderId);

        vm.warp(pots.potOf(potId).orderExpiresAt - 1);
        _assertLiveStage(potId, CrowdPots.Stage.Hiring);
        assertEq(pots.refundOf(potId, alice), 0);

        vm.warp(pots.potOf(potId).orderExpiresAt);
        _assertOrderState(orderId, IWorkOrders.State.Open);
        _assertStage(potId, CrowdPots.Stage.Hiring);
        _assertLiveStage(potId, CrowdPots.Stage.Refundable);
        assertEq(pots.refundOf(potId, alice), 5.5e18);
        assertEq(pots.refundOf(potId, bob), 3.3e18);
        assertEq(pots.owed(), 0, "a forecast books nothing");

        // And the claim pays exactly what the views said.
        assertEq(_claim(potId, alice), 5.5e18);
        assertEq(pots.refundOf(potId, bob), 3.3e18);
        assertEq(_claim(potId, bob), 3.3e18);
        assertEq(_claim(potId, carol), 2.2e18);
        _assertOrderState(orderId, IWorkOrders.State.Refunded);
    }

    function test_reconcile_oneSecondBeforeExpiry_doesNotAskForARefund() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.warp(pots.potOf(potId).orderExpiresAt - 1);
        // Not even a call the desk would refuse: the pot knows its order's expiry.
        vm.expectCall(address(desk), abi.encodeCall(desk.refund, (orderId)), 0);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Open);
    }

    /// @dev Says how often the next calls may ask the desk for each ending of `orderId`. The pot
    /// never finalises a delivery claim, so that count is always zero.
    function _expectDeskCalls(uint256 orderId, uint64 evictions, uint64 timeouts, uint64 refunds) internal {
        vm.expectCall(address(desk), abi.encodeCall(desk.evict, (orderId)), evictions);
        vm.expectCall(address(desk), abi.encodeCall(desk.timeout, (orderId)), timeouts);
        vm.expectCall(address(desk), abi.encodeCall(desk.refund, (orderId)), refunds);
        vm.expectCall(address(desk), abi.encodeCall(desk.finalize, (orderId)), 0);
    }

    // The pot only ever makes the one call on the desk that the order's state can be waiting for.

    function test_reconcile_forAnOrderARunnerHolds_asksOnlyForAnEviction() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        _take(orderId, runner);
        _expectDeskCalls(orderId, 1, 0, 0);
        pots.reconcile(potId);
    }

    function test_reconcile_forARegisteredJob_asksOnlyForATimeout() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        _takeAndRegister(orderId, runner);
        _expectDeskCalls(orderId, 0, 1, 0);
        pots.reconcile(potId);
    }

    function test_reconcile_forAnExpiredOrderNobodyHolds_asksOnlyForARefund() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.warp(pots.potOf(potId).orderExpiresAt);
        _expectDeskCalls(orderId, 0, 0, 1);
        pots.reconcile(potId);
    }

    function test_reconcile_forAnUnchallengedDeliveryClaim_callsNothing_howeverLongItStands() public {
        CrowdPots.Terms memory t = _terms();
        t.allowClaimed = true;
        (uint256 potId, uint256 orderId) = _launched(t);
        _takeAndRegister(orderId, runner);
        vm.prank(runner);
        desk.claimDelivered(orderId, RECEIPT);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _expectDeskCalls(orderId, 0, 0, 0);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
    }

    function test_reconcile_andClaims_callNothingOnceTheOrderHasEnded() public {
        (uint256 potId, uint256 orderId) = _launched(_rampTerms());
        _deliver(orderId);
        _expectDeskCalls(orderId, 0, 0, 0);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));
        // A settled pot does not ask the desk anything any more.
        vm.expectCall(address(desk), abi.encodeCall(desk.stateOf, (orderId)), 0);
        vm.expectCall(address(desk), abi.encodeCall(desk.accountOf, (orderId)), 0);
        assertEq(_claim(potId, alice), 3e18);
        assertEq(_claim(potId, bob), 1.8e18);
    }

    function test_reconcile_anExpiredOrderARunnerHolds_isStillHiring() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.warp(pots.potOf(potId).orderExpiresAt - 1);
        _takeAndRegister(orderId, runner);
        vm.warp(vm.getBlockTimestamp() + 1 days);

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Registered);

        // The late receipt still pays.
        _settle(orderId);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));
    }

    function test_reconcile_aTimeoutAfterExpiry_refundsEveryChipPlusTheBond() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.warp(pots.potOf(potId).orderExpiresAt - 1);
        _takeAndRegister(orderId, runner);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        desk.timeout(orderId);
        _assertOrderState(orderId, IWorkOrders.State.Refunded);

        vm.expectEmit(address(pots));
        emit CrowdPots.PotSettled(potId, CrowdPots.Stage.Refundable, 0, 11e18);
        pots.reconcile(potId);

        assertEq(_claim(potId, alice), 5.5e18);
        assertEq(_claim(potId, bob), 3.3e18);
        assertEq(_claim(potId, carol), 2.2e18);
        assertEq(imd.balanceOf(alice), WALLET + 0.5e18, "the chip and half the forfeited bond");
        assertEq(imd.balanceOf(address(pots)), 0);
    }

    function test_reconcile_aCancelledOrder_isRefundable() public {
        // A pot never cancels its order. If the desk reports one cancelled all the same, the pot
        // treats it like any order that ended without delivery.
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.prank(address(pots));
        desk.cancel(orderId);
        _assertOrderState(orderId, IWorkOrders.State.Cancelled);

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));
        assertEq(_claim(potId, alice), 5e18);
        assertEq(_claim(potId, bob), 3e18);
        assertEq(_claim(potId, carol), 2e18);
    }

    function test_reconcile_claimedPath_anUnchallengedClaimDelivers() public {
        CrowdPots.Terms memory t = _rampTerms();
        t.allowClaimed = true;
        (uint256 potId, uint256 orderId) = _launched(t);
        _takeAndRegister(orderId, runner);
        vm.prank(runner);
        desk.claimDelivered(orderId, RECEIPT);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        desk.finalize(orderId);

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));
        assertEq(pots.potOf(potId).recordHash, RECEIPT, "the hash the runner named");
        assertEq(pots.potOf(potId).pool, 6e18, "claimed at the starting price of 4");
    }

    function test_reconcile_claimedPath_aRefutedClaimReopensAndTheBondComesToThePot() public {
        CrowdPots.Terms memory t = _terms();
        t.allowClaimed = true;
        (uint256 potId, uint256 orderId) = _launched(t);
        _takeAndRegister(orderId, runner);
        vm.prank(runner);
        desk.claimDelivered(orderId, RECEIPT);
        // A receipt contradicts the claim before anyone challenged: the bond is the employer's.
        _reportFailed(orderId, false);
        _assertOrderState(orderId, IWorkOrders.State.Open);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));

        vm.warp(pots.potOf(potId).orderExpiresAt);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));
        assertEq(pots.potOf(potId).pool, 11e18);
    }

    /// An undecided dispute at the delivery deadline: the order is refunded, the challenger gets
    /// its bond back, and the runner forfeits to the pot the share of its bond a release costs.
    function test_reconcile_claimedPath_anUndecidedDisputeRefundsThePot_withTheRunnersForfeitedShare() public {
        CrowdPots.Terms memory t = _terms();
        t.allowClaimed = true;
        (uint256 potId, uint256 orderId) = _launched(t);
        _dispute(orderId, runner, challenger);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        desk.timeout(orderId);
        _assertOrderState(orderId, IWorkOrders.State.Refunded);

        assertEq(imd.balanceOf(runner), WALLET - 0.1e18, "the runner forfeits a tenth of its 1 IMD bond");
        assertEq(imd.balanceOf(challenger), WALLET, "the challenger gets its bond back");
        assertEq(_returned(orderId), 10.1e18, "the desk counts the forfeited share as returned");
        assertEq(imd.balanceOf(address(pots)), 10.1e18, "and pushed what it reports");

        vm.expectEmit(address(pots));
        emit CrowdPots.PotSettled(potId, CrowdPots.Stage.Refundable, 0, 10.1e18);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));
        assertEq(pots.potOf(potId).pool, 10.1e18, "the pot shares the escrow and the forfeited share");
        assertEq(_claim(potId, alice), 5.05e18);
        assertEq(_claim(potId, bob), 3.03e18);
        assertEq(_claim(potId, carol), 2.02e18);
        assertEq(imd.balanceOf(address(pots)), 0);
        assertEq(pots.owed(), 0);
    }

    function test_reconcile_claimedPath_aChallengedClaimRefutedByAReceipt_reopensWithTheReleaseShare() public {
        CrowdPots.Terms memory t = _terms();
        t.allowClaimed = true;
        (uint256 potId, uint256 orderId) = _launched(t);
        _dispute(orderId, runner, challenger);
        // A receipt of the registered job that does not settle the order.
        _reportFailed(orderId, false);

        _assertOrderState(orderId, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner), WALLET - 1e18, "the runner lost its whole bond");
        assertEq(imd.balanceOf(challenger), WALLET + 0.9e18, "nine tenths of it went to the challenger");
        assertEq(_returned(orderId), 0.1e18, "and the release share to the pot");
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring), "the order is open again");

        // A second runner delivers; the forfeited share is paid out with the settlement.
        _takeAndRegister(orderId, runner2);
        _settle(orderId);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));
        assertEq(pots.potOf(potId).pool, 0.1e18);
        assertEq(_claim(potId, alice), 0.05e18);
    }

    function test_reconcile_claimedPath_aChallengedClaimUpheldByAReceipt_delivers() public {
        CrowdPots.Terms memory t = _rampTerms();
        t.allowClaimed = true;
        (uint256 potId, uint256 orderId) = _launched(t);
        _dispute(orderId, runner, challenger);
        _settle(orderId);

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));
        assertEq(pots.potOf(potId).pool, 6e18, "the unused escrow; no bond comes to the pot");
        assertEq(imd.balanceOf(challenger), WALLET - 1e18, "the challenger's bond went to the runner");
    }

    /// What a pot accepts when it allows claims: one party with two addresses can end its order
    /// in a refund long before the hire window is over, for a tenth of the bond. The pot hires
    /// once, so the job is never done; the contributors get everything back and the forfeit.
    function test_claimedPath_anUndecidedDisputeEndsThePotEarly_forATenthOfTheBond() public {
        CrowdPots.Terms memory t = _terms();
        t.allowClaimed = true;
        t.target = 1_000e18;
        t.minPay = 1_000e18;
        t.bond = desk.MIN_BOND();
        t.hireSecs = 30 days;
        t.deliverySecs = 3 days;
        (uint256 potId, uint256 orderId) = _launched(t);
        _dispute(orderId, runner, challenger);
        vm.warp(vm.getBlockTimestamp() + t.deliverySecs);

        // No keeper: reconciling the pot has the desk end the dispute.
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Refundable));
        _assertOrderState(orderId, IWorkOrders.State.Refunded);
        assertEq(pots.potOf(potId).orderExpiresAt - vm.getBlockTimestamp(), 27 days, "27 days of hiring unused");
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Refundable));
        pots.launch(potId, SPEC);

        uint256 cost = (WALLET - imd.balanceOf(runner)) + (WALLET - imd.balanceOf(challenger));
        assertEq(cost, 0.025e18, "what it cost the two addresses together");
        assertEq(pots.potOf(potId).pool, 1_000.025e18);
    }

    /// The same stall on a pot that pays on a receipt only costs the whole bond, and the order is
    /// open again for the rest of its hire window.
    function test_provenPath_theSameStallCostsTheWholeBond_andTheOrderReopens() public {
        CrowdPots.Terms memory t = _terms();
        t.target = 1_000e18;
        t.minPay = 1_000e18;
        t.bond = desk.MIN_BOND();
        t.hireSecs = 30 days;
        t.deliverySecs = 3 days;
        (uint256 potId, uint256 orderId) = _launched(t);
        _takeAndRegister(orderId, runner);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ClaimedPathOff.selector);
        desk.claimDelivered(orderId, RECEIPT);
        vm.warp(vm.getBlockTimestamp() + t.deliverySecs);

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Open);
        assertEq(WALLET - imd.balanceOf(runner), 0.25e18);
        assertEq(_returned(orderId), 0.25e18);
    }

    function test_reconcile_withoutACallback_stillSettlesFromTheDesksBooks() public {
        (uint256 potId, uint256 orderId) = _launched(_rampTerms());
        _takeAndRegister(orderId, runner);
        // The desk's call to the pot fails; the delivery stands.
        vm.mockCallRevert(address(pots), abi.encodeWithSelector(pots.onWorkDelivered.selector), "no callback");
        _settle(orderId);
        vm.clearMockedCalls();
        assertFalse(desk.orderOf(orderId).notified);

        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));
        assertEq(pots.potOf(potId).pool, 6e18);
        assertEq(pots.potOf(potId).recordHash, bytes32(0), "only the receipt record is missing");
        assertEq(_claim(potId, alice), 3e18);
    }

    function test_reconcile_strayTransfersAreNeverBookedToAPot() public {
        (uint256 potId, uint256 orderId) = _launched(_rampTerms());
        vm.prank(stranger);
        imd.transfer(address(pots), 123e18);
        _deliver(orderId);
        pots.reconcile(potId);

        assertEq(pots.potOf(potId).pool, 6e18, "only what the desk says it sent back");
        assertEq(pots.owed(), 6e18);
        assertEq(imd.balanceOf(address(pots)), 129e18);
    }

    // ------------------------------------------------------------------------------------------
    // claimRefund and claimRefunds
    // ------------------------------------------------------------------------------------------

    function test_claimRefund_settlesThePotByItself() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 4e18);
        vm.warp(pots.potOf(potId).deadline + 1);

        assertEq(pots.refundOf(potId, alice), 4e18, "the view already knows");
        vm.expectEmit(address(pots));
        emit CrowdPots.PotSettled(potId, CrowdPots.Stage.Refundable, 0, 4e18);
        vm.expectEmit(address(pots));
        emit CrowdPots.RefundPaid(potId, alice, 4e18);
        assertEq(_claim(potId, alice), 4e18);

        (uint256 amount, uint256 refunded, bool claimed) = pots.chipOf(potId, alice);
        assertEq(amount, 4e18, "the chip stays on record");
        assertEq(refunded, 4e18);
        assertTrue(claimed);
        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(pots.owed(), 0);
        assertEq(pots.refundOf(potId, alice), 0);
    }

    function test_claimRefund_paysTheContributorWhoeverCalls() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 4e18);
        vm.warp(pots.potOf(potId).deadline + 1);
        uint256 callerBefore = imd.balanceOf(stranger);

        vm.prank(stranger);
        pots.claimRefund(potId, alice);

        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(imd.balanceOf(stranger), callerBefore, "the caller gets nothing");
    }

    function test_claimRefund_aSecondClaimPaysNothing() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 4e18);
        _chip(bob, potId, 2e18);
        vm.warp(pots.potOf(potId).deadline + 1);
        _claim(potId, alice);

        vm.recordLogs();
        assertEq(_claim(potId, alice), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(imd.balanceOf(address(pots)), 2e18, "bob's chip is untouched");
        assertEq(_claim(potId, bob), 2e18);
    }

    function test_claimRefund_forSomeoneWithNoChip_paysNothing() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 4e18);
        vm.warp(pots.potOf(potId).deadline + 1);
        assertEq(_claim(potId, stranger), 0);
        assertEq(_claim(potId, address(0)), 0);
        assertEq(imd.balanceOf(address(pots)), 4e18);
    }

    function test_claimRefund_revertsWhileThePotIsCollecting() public {
        uint256 potId = _open(_terms());
        _chip(alice, potId, 4e18);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Funding));
        pots.claimRefund(potId, alice);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.None));
        pots.claimRefund(99, alice);
    }

    function test_claimRefund_aFullPotNobodyLaunched_refundsOnceTheGraceIsOver() public {
        uint256 potId = _filled(_terms());
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Funding));
        pots.claimRefund(potId, alice);

        vm.warp(_afterLaunchTime(potId) - 1);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Funding));
        pots.claimRefund(potId, alice);

        vm.warp(_afterLaunchTime(potId));
        assertEq(pots.refundOf(potId, alice), 5e18);
        assertEq(_claim(potId, alice), 5e18);
        assertEq(_claim(potId, bob), 3e18);
        assertEq(_claim(potId, carol), 2e18);
    }

    function test_claimRefund_paysAContributorThatIsAContractAndCannotCall() public {
        Inert inert = new Inert();
        uint256 potId = _open(_terms());
        vm.prank(alice);
        pots.chipInFor(potId, 6e18, address(inert));
        vm.warp(pots.potOf(potId).deadline + 1);

        assertEq(_claim(potId, address(inert)), 6e18);
        assertEq(imd.balanceOf(address(inert)), 6e18);
    }

    function test_claimRefund_theLastClaimerTakesTheRemainder_noDust() public {
        // Three equal chips share a refund that does not divide by three.
        CrowdPots.Terms memory t = _rampTerms();
        t.target = 3e18;
        t.minPay = 1e18;
        t.bond = 0.25e18;
        uint256 potId = _open(t);
        _chip(alice, potId, 1e18);
        _chip(bob, potId, 1e18);
        _chip(carol, potId, 1e18);
        uint256 orderId = _launch(potId);
        vm.warp(vm.getBlockTimestamp() + 12_345);
        _deliver(orderId);
        uint256 refundable = _returned(orderId);
        assertTrue(refundable % 3 != 0, "the case under test");

        uint256 a = _claim(potId, alice);
        uint256 b = _claim(potId, bob);
        uint256 c = _claim(potId, carol);

        assertEq(a, refundable / 3);
        assertGe(b, refundable / 3);
        assertGe(c, refundable / 3);
        assertEq(a + b + c, refundable, "to the wei");
        assertEq(imd.balanceOf(address(pots)), 0);
        assertEq(pots.owed(), 0);
        assertEq(pots.potOf(potId).pool, 0);
        assertEq(pots.potOf(potId).chipsLeft, 0);
    }

    function test_claimRefunds_paysAListAndSkipsWhatHasNothingToClaim() public {
        uint256 potId = _filled(_terms());
        vm.warp(_afterLaunchTime(potId));
        address[] memory list = new address[](5);
        list[0] = alice;
        list[1] = stranger;
        list[2] = bob;
        list[3] = alice;
        list[4] = carol;

        vm.prank(stranger);
        uint256 paid = pots.claimRefunds(potId, list);

        assertEq(paid, 10e18);
        assertEq(imd.balanceOf(alice), WALLET);
        assertEq(imd.balanceOf(bob), WALLET);
        assertEq(imd.balanceOf(carol), WALLET);
        assertEq(imd.balanceOf(address(pots)), 0);
    }

    function test_claimRefunds_withAnEmptyList_onlySettles() public {
        uint256 potId = _filled(_terms());
        vm.warp(_afterLaunchTime(potId));
        assertEq(pots.claimRefunds(potId, new address[](0)), 0);
        _assertStage(potId, CrowdPots.Stage.Refundable);
    }

    function test_claimRefunds_revertsWhileThePotIsHiring() public {
        (uint256 potId,) = _launched(_terms());
        address[] memory list = new address[](1);
        list[0] = alice;
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Hiring));
        pots.claimRefunds(potId, list);
    }

    function test_twoPotsNeverShareMoney() public {
        // Pot A is refunded with a forfeited bond while pot B is still collecting.
        (uint256 potA, uint256 orderA) = _launched(_terms());
        uint256 potB = _open(_terms());
        _chip(carol, potB, 7e18);

        vm.warp(pots.potOf(potA).orderExpiresAt - 1);
        _takeAndRegister(orderA, runner);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        desk.timeout(orderA);

        // B's deadline has long passed too: both are refundable, each from its own money.
        assertEq(_claim(potA, alice), 5.5e18);
        assertEq(_claim(potB, carol), 7e18);
        assertEq(_claim(potA, carol), 2.2e18);
        assertEq(_claim(potA, bob), 3.3e18);
        assertEq(imd.balanceOf(address(pots)), 0);
        assertEq(pots.owed(), 0);
    }

    // ------------------------------------------------------------------------------------------
    // Ending on the desk what has run out of time (no keeper needed)
    // ------------------------------------------------------------------------------------------

    /// A runner takes the order just before it expires, registers a job and goes silent, and
    /// nobody calls the desk. One `claimRefund` after the delivery time is enough.
    function test_claimRefund_afterASilentRunner_timesTheOrderOutItself() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.warp(pots.potOf(potId).orderExpiresAt - 1);
        _takeAndRegister(orderId, runner);

        // One second before the delivery time is up the desk refuses, and so does the pot.
        vm.warp(vm.getBlockTimestamp() + 7 days - 1);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Hiring));
        pots.claimRefund(potId, alice);
        _assertOrderState(orderId, IWorkOrders.State.Registered);

        vm.warp(vm.getBlockTimestamp() + 1);
        // The views cannot see a claim running out; the claim itself can end it.
        _assertLiveStage(potId, CrowdPots.Stage.Hiring);
        assertEq(pots.refundOf(potId, alice), 0);

        vm.expectEmit(address(pots));
        emit CrowdPots.PotSettled(potId, CrowdPots.Stage.Refundable, 0, 11e18);
        assertEq(_claim(potId, alice), 5.5e18, "the chip and half the forfeited bond");

        _assertOrderState(orderId, IWorkOrders.State.Refunded);
        _assertStage(potId, CrowdPots.Stage.Refundable);
        assertEq(imd.balanceOf(runner), WALLET - 1e18, "the silent runner lost its bond");
        assertEq(_claim(potId, bob), 3.3e18);
        assertEq(_claim(potId, carol), 2.2e18);
        assertEq(imd.balanceOf(address(pots)), 0);
        assertEq(pots.owed(), 0);
    }

    function test_claimRefund_afterARunnerThatRegisteredNothing_evictsItItself() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        vm.warp(pots.potOf(potId).orderExpiresAt - 1);
        _take(orderId, runner);
        // The claim window has passed and so has the order's expiry.
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _assertOrderState(orderId, IWorkOrders.State.Claimed);

        assertEq(_claim(potId, alice), 5.5e18);
        _assertOrderState(orderId, IWorkOrders.State.Refunded);
        assertEq(pots.potOf(potId).pool, 5.5e18);
    }

    function test_reconcile_evictsAnIdleRunnerInsideTheHireWindow_andTheOrderIsOpenAgain() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        _take(orderId, runner2);

        vm.warp(vm.getBlockTimestamp() + 1 hours - 1);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Claimed);

        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(stranger);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner2), WALLET - 1e18);
        assertEq(imd.balanceOf(address(pots)), 1e18, "the bond is in the contract");
        assertEq(pots.owed(), 0, "and booked to nobody until the order ends");

        // The next runner delivers, and the bond is shared out with the settlement.
        _deliver(orderId);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered));
        assertEq(pots.potOf(potId).pool, 1e18);
    }

    function test_reconcile_timesOutAnUndecidedDisputeItself() public {
        CrowdPots.Terms memory t = _terms();
        t.allowClaimed = true;
        (uint256 potId, uint256 orderId) = _launched(t);
        _dispute(orderId, runner, challenger);

        vm.warp(vm.getBlockTimestamp() + 7 days - 1);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Disputed);

        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(_claim(potId, alice), 5.05e18);
        _assertOrderState(orderId, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(challenger), WALLET);
        assertEq(imd.balanceOf(runner), WALLET - 0.1e18);
    }

    /// A delivery claim nobody challenged is paid by `finalize` on the desk. The pot leaves that
    /// call to the runner: until it is made the pot is hiring, however long that takes.
    function test_reconcile_leavesAnUnchallengedClaimToTheRunner() public {
        CrowdPots.Terms memory t = _rampTerms();
        t.allowClaimed = true;
        (uint256 potId, uint256 orderId) = _launched(t);
        _takeAndRegister(orderId, runner);
        vm.prank(runner);
        desk.claimDelivered(orderId, RECEIPT);

        vm.warp(vm.getBlockTimestamp() + 60 days);
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Hiring));
        _assertOrderState(orderId, IWorkOrders.State.Asserted);
        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Hiring));
        pots.claimRefund(potId, alice);

        desk.finalize(orderId);
        assertEq(_claim(potId, alice), 3e18, "half of the 6 IMD the job did not cost");
    }

    /// `claimRefund` reverts while the pot is hiring, and a revert undoes everything: a claim it
    /// ended on the way, which only reopened the order, is not ended after all.
    function test_claimRefund_whenEndingAClaimOnlyReopensTheOrder_revertsAndLeavesTheDeskAsItWas() public {
        (uint256 potId, uint256 orderId) = _launched(_terms());
        _take(orderId, runner);
        vm.warp(vm.getBlockTimestamp() + 1 hours);

        vm.expectRevert(abi.encodeWithSelector(CrowdPots.WrongStage.selector, CrowdPots.Stage.Hiring));
        pots.claimRefund(potId, alice);
        _assertOrderState(orderId, IWorkOrders.State.Claimed);
        assertEq(imd.balanceOf(address(pots)), 0);

        // `reconcile` does not revert, so there the eviction stands.
        pots.reconcile(potId);
        _assertOrderState(orderId, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(address(pots)), 1e18);
    }

    function test_onWorkDelivered_aCallbackThatFailedArrivesLaterThroughTheDesksRedeliver() public {
        (uint256 potId, uint256 orderId) = _launched(_rampTerms());
        _takeAndRegister(orderId, runner);
        vm.mockCallRevert(address(pots), abi.encodeWithSelector(pots.onWorkDelivered.selector), "no callback");
        bytes32 receipt = _settle(orderId);
        vm.clearMockedCalls();
        assertEq(uint256(pots.reconcile(potId)), uint256(CrowdPots.Stage.Delivered), "the money does not wait");
        assertEq(pots.potOf(potId).jobId, bytes16(0));

        vm.expectEmit(address(pots));
        emit CrowdPots.WorkDelivered(potId, orderId, JOB, receipt);
        desk.redeliver(orderId);
        assertEq(pots.potOf(potId).jobId, JOB);
        assertEq(pots.potOf(potId).recordHash, receipt);
        assertTrue(desk.orderOf(orderId).notified);
        assertEq(pots.potOf(potId).pool, 6e18, "a late report changes no amount");

        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.redeliver(orderId);
    }

    // ------------------------------------------------------------------------------------------
    // The job kind, named in text
    // ------------------------------------------------------------------------------------------

    function test_kind_isNamedInTextWhenAPotOpens_andCanBeReadBack() public {
        assertEq(pots.kindOf(KIND), "", "nobody has named this kind yet");

        // The opening event carries the terms, and the terms carry the kind as text.
        CrowdPots.Terms memory t = _terms();
        vm.expectEmit(address(pots));
        emit CrowdPots.PotOpened(1, opener, 0, keccak256(SPEC), uint40(START + t.fundSecs), t);
        uint256 potId = _open(t);

        assertEq(pots.potOf(potId).kindHash, keccak256(bytes(KIND_TEXT)), "the pot keeps the hash of the text");
        assertEq(pots.kindOf(pots.potOf(potId).kindHash), KIND_TEXT, "and the text can be read as text");
        assertEq(imd.balanceOf(address(pots)), 0);

        // The desk pins the same hash for the pot's order.
        _chip(alice, potId, 10e18);
        uint256 orderId = _launch(potId);
        assertEq(desk.orderOf(orderId).kindHash, keccak256(bytes(KIND_TEXT)));
    }

    function test_kind_aSeriesNamesItToo_andEveryRoundPublishesItAgain() public {
        CrowdPots.Terms memory t = _terms();
        t.kind = "skill:create-image";
        vm.expectEmit(address(pots));
        emit CrowdPots.SeriesOpened(1, opener, keccak256(SPEC), t);
        vm.prank(opener);
        uint256 seriesId = pots.openSeries(t, SPEC);
        assertEq(pots.kindOf(keccak256("skill:create-image")), "skill:create-image");

        // The first chip opens the first round, whose own opening event names the kind in text.
        vm.expectEmit(address(pots));
        emit CrowdPots.PotOpened(2, opener, seriesId, keccak256(SPEC), uint40(START + t.fundSecs), t);
        _chip(alice, seriesId, 1e18);
        assertEq(pots.potOf(2).kindHash, keccak256("skill:create-image"));
    }

    function test_kind_acceptsTheKindsTheSwarmWrites() public {
        string[6] memory kinds =
            ["audit", "research", "single", "skill:research-report", "shape:chain", "skill:write-readme-and-docs"];
        for (uint256 i; i < kinds.length; ++i) {
            CrowdPots.Terms memory t = _terms();
            t.kind = kinds[i];
            uint256 potId = _open(t);
            bytes32 kindHash = pots.potOf(potId).kindHash;
            assertEq(kindHash, keccak256(bytes(kinds[i])));
            assertEq(pots.kindOf(kindHash), kinds[i]);
        }
        // The kind of the real work record in the fixtures.
        assertEq(
            KIND, keccak256(bytes(vm.parseJsonString(vm.readFile("test/fixtures/pots/real-receipt.json"), ".kind")))
        );
    }

    function _expectKindRevert(string memory kind, bytes memory why) internal {
        CrowdPots.Terms memory t = _terms();
        t.kind = kind;
        vm.expectRevert(why);
        vm.prank(opener);
        pots.openPot(t, SPEC, 0);
        vm.expectRevert(why);
        vm.prank(opener);
        pots.openSeries(t, SPEC);
    }

    function test_kind_revertsOnTextAWorkRecordWouldNotHoldAsItIs() public {
        _expectKindRevert("", abi.encodeWithSelector(CrowdPots.KindMissing.selector));
        _expectKindRevert(" audit", abi.encodeWithSelector(CrowdPots.SpecInvalid.selector, 0));
        _expectKindRevert("audit ", abi.encodeWithSelector(CrowdPots.SpecInvalid.selector, 5));
        _expectKindRevert('audit"', abi.encodeWithSelector(CrowdPots.SpecInvalid.selector, 5));
        _expectKindRevert("au\\dit", abi.encodeWithSelector(CrowdPots.SpecInvalid.selector, 2));
        _expectKindRevert(unicode"café", abi.encodeWithSelector(CrowdPots.SpecInvalid.selector, 3));
    }

    function test_kind_revertsOnTextOverTheLimit() public {
        bytes memory text = new bytes(65);
        for (uint256 i; i < text.length; ++i) {
            text[i] = "k";
        }
        _expectKindRevert(string(text), abi.encodeWithSelector(CrowdPots.KindTooLong.selector));

        bytes memory longest = new bytes(64);
        for (uint256 i; i < longest.length; ++i) {
            longest[i] = "k";
        }
        CrowdPots.Terms memory t = _terms();
        t.kind = string(longest);
        uint256 potId = _open(t);
        assertEq(pots.potOf(potId).kindHash, keccak256(longest));
        assertEq(bytes(pots.kindOf(keccak256(longest))).length, 64);
    }

    /// The text kept for a kind is always the preimage of the hash the pot pins.
    function testFuzz_kind_theTextIsFiledUnderItsOwnHash(bytes memory raw) public {
        vm.assume(raw.length != 0 && raw.length <= 64);
        bytes memory text = new bytes(raw.length);
        for (uint256 i; i < raw.length; ++i) {
            // Letters, digits and the punctuation the swarm's kinds use.
            text[i] = bytes1(0x2D + uint8(raw[i]) % 78);
            if (text[i] == 0x5C) text[i] = ":";
        }
        CrowdPots.Terms memory t = _terms();
        t.kind = string(text);
        uint256 potId = _open(t);
        bytes32 kindHash = pots.potOf(potId).kindHash;
        assertEq(kindHash, keccak256(text));
        assertEq(keccak256(bytes(pots.kindOf(kindHash))), kindHash);
    }

    // ------------------------------------------------------------------------------------------
    // Reentrancy
    // ------------------------------------------------------------------------------------------

    /// @dev IMD has no transfer hook. This shows the lock holds even for a token that had one: every
    /// attempt to come back in during a transfer is refused.
    function test_aTokenCallbackCannotComeBackIn() public {
        CallbackToken token = new CallbackToken();
        WorkOrders d = new WorkOrders(address(token), address(proof), payroll);
        CrowdPots p = new CrowdPots(address(token), address(d));
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.approve(address(p), type(uint256).max);
        vm.prank(alice);
        uint256 potId = p.openPot(_terms(), SPEC, 0);

        address[] memory list = new address[](1);
        list[0] = alice;
        bytes[] memory attempts = new bytes[](6);
        attempts[0] = abi.encodeCall(p.chipIn, (potId, 1e18));
        attempts[1] = abi.encodeCall(p.chipInFor, (potId, 1e18, bob));
        attempts[2] = abi.encodeCall(p.claimRefund, (potId, alice));
        attempts[3] = abi.encodeCall(p.claimRefunds, (potId, list));
        attempts[4] = abi.encodeCall(p.launch, (potId, SPEC));
        attempts[5] = abi.encodeCall(p.reconcile, (potId));

        for (uint256 i; i < attempts.length; ++i) {
            token.arm(address(p), attempts[i]);
            vm.prank(alice);
            p.chipIn(potId, 1e18);
            assertFalse(token.lastCallOk(), "the inner call must fail");
            assertEq(
                bytes4(token.lastCallResult()),
                ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector,
                "and for this reason"
            );
        }
        token.arm(address(0), "");
        assertEq(p.potOf(potId).raised, 6e18, "only the six outer chips counted");
    }
}
