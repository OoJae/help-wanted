// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Endowments} from "../../../src/endowments/Endowments.sol";
import {MockIMD} from "../mocks/MockIMD.sol";
import {MockQuestions} from "../mocks/MockQuestions.sol";
import {MockStakedIMD} from "../mocks/MockStakedIMD.sol";
import {EndowmentsHandler} from "./EndowmentsHandler.sol";

/// @dev Checks shared by both invariant suites: the books, the buffer, the share ledger.
abstract contract EndowmentsInvariantBase is Test {
    EndowmentsHandler internal handler;
    Endowments internal endow;
    MockIMD internal imd;
    MockStakedIMD internal simd;

    function _setUp(bool allowLoss) internal {
        handler = new EndowmentsHandler(allowLoss);
        endow = handler.endow();
        imd = handler.imd();
        simd = handler.simd();

        bytes4[] memory selectors = new bytes4[](allowLoss ? 17 : 16);
        selectors[0] = EndowmentsHandler.deposit.selector;
        selectors[1] = EndowmentsHandler.donate.selector;
        selectors[2] = EndowmentsHandler.create.selector;
        selectors[3] = EndowmentsHandler.stake.selector;
        selectors[4] = EndowmentsHandler.roll.selector;
        selectors[5] = EndowmentsHandler.earn.selector;
        selectors[6] = EndowmentsHandler.strangerSendsShares.selector;
        selectors[7] = EndowmentsHandler.setPot.selector;
        selectors[8] = EndowmentsHandler.withdraw.selector;
        selectors[9] = EndowmentsHandler.exitInKind.selector;
        selectors[10] = EndowmentsHandler.harvest.selector;
        selectors[11] = EndowmentsHandler.meterSpends.selector;
        selectors[12] = EndowmentsHandler.strangerFundsMeter.selector;
        selectors[13] = EndowmentsHandler.repriceFeed.selector;
        selectors[14] = EndowmentsHandler.harvestMeter.selector;
        selectors[15] = EndowmentsHandler.depositToMeter.selector;
        if (allowLoss) selectors[16] = EndowmentsHandler.lose.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev E2: the shares booked to endowments never exceed the sIMD this contract holds, and what is
    /// left over is only split dust and what strangers sent.
    function _checkShareLedger() internal view {
        uint256 booked;
        uint256 count = endow.endowmentCount();
        for (uint256 id = 1; id <= count; ++id) {
            (,,,,, uint256 shares,) = endow.endowment(id);
            booked += shares;
        }
        uint256 held = simd.balanceOf(address(endow));
        assertLe(booked, held, "E2: booked shares exceed the sIMD held");
        assertLe(held - booked, handler.strayShareBound(), "unexplained spare shares");
    }

    /// @dev The buffer is exactly the IMD this contract holds: nothing is stranded and nothing is
    /// promised that is not there.
    function _checkBuffer() internal view {
        uint256 buffered;
        uint256 count = endow.endowmentCount();
        for (uint256 id = 1; id <= count; ++id) {
            (,,,, uint256 b,,) = endow.endowment(id);
            buffered += b;
        }
        assertEq(buffered, endow.pendingTotal(), "buffers do not add up to pendingTotal");
        assertEq(imd.balanceOf(address(endow)), endow.pendingTotal(), "IMD held is not the buffer");
    }

    /// @dev Each depositor's principal is what they put in and have not given up, and an endowment's
    /// principal is the sum of its depositors'.
    function _checkPrincipalBooks() internal view {
        uint256 count = endow.endowmentCount();
        uint256 actorCount = handler.actorCount();
        for (uint256 id = 1; id <= count; ++id) {
            (,,, uint256 principal,,,) = endow.endowment(id);
            uint256 sum;
            for (uint256 i = 0; i < actorCount; ++i) {
                address actor = handler.actors(i);
                uint256 mine = endow.principalOf(id, actor);
                assertEq(mine, handler.owed(id, actor), "principalOf differs from the handler's books");
                sum += mine;
            }
            assertEq(sum, principal, "principal is not the sum of its depositors'");
        }
    }

    /// @dev Nobody is ever paid more IMD than the principal they gave up.
    function _checkNobodyGainedPrincipal() internal view {
        uint256 actorCount = handler.actorCount();
        for (uint256 i = 0; i < actorCount; ++i) {
            address actor = handler.actors(i);
            assertLe(handler.gotBack(actor), handler.gaveUp(actor), "paid more than the principal given up");
        }
    }

    /// @dev How often the last run of a campaign reached the meter runway, so a reader can see that the
    /// runway invariants were not passed for want of trying.
    function _logMeterRunway() internal {
        emit log_named_uint("harvests in the last run", handler.harvests());
        emit log_named_uint("  to the meter", handler.meterHarvests());
        emit log_named_uint("  to the meter, cut to the room under the runway", handler.meterHarvestsCut());
        emit log_named_uint("meter harvests that had to wait for room", handler.meterHarvestsWaiting());
    }

    function _checkFlags() internal view {
        assertFalse(handler.wrongPayment(), "a withdrawal paid the wrong amount");
        assertFalse(handler.inKindRefused(), "an in-kind exit was refused or underpaid");
        assertFalse(handler.harvestBroken(), "a harvest broke a rule");
        assertFalse(handler.unfairExit(), "a leaver took more than their part");
        assertFalse(handler.depositGateBroken(), "the deposit gate misbehaved");
        assertFalse(handler.stakeGateBroken(), "the stake gate misbehaved");
        assertFalse(handler.exactWithdrawalRefused(), "E3: a withdrawal was refused outside a hold");
        assertFalse(handler.wholeNotExact(), "E3: a whole endowment would not pay a withdrawal in full");
        assertFalse(handler.ranBelowPeak(), "a stake or harvest ran below a price an earlier one saw");
        assertFalse(handler.potOverfed(), "a pot harvest took out more than the pot needed");
        assertFalse(handler.fallbackPaidNeedlessly(), "the fallback was paid while the pot had room");
        assertFalse(handler.meterOverfilled(), "a meter harvest took out more than the runway had room for");
        assertFalse(handler.meterGateBroken(), "a meter endowment was created or refused against the feed's cost");
    }

    /// @dev The contract's price mark is the highest price a stake or harvest went through at, as the
    /// handler saw it, and every endowment that is whole is also covered in plain IMD terms.
    function _checkPriceMarkAndCover() internal view {
        assertEq(endow.priceMark(), handler.peak(), "the price mark is not the highest price seen");
        bool below = endow.priceBelowMark();
        uint256 count = endow.endowmentCount();
        for (uint256 id = 1; id <= count; ++id) {
            if (below) assertEq(endow.harvestable(id), 0, "yield is on offer below the price mark");
            if (endow.isWhole(id)) {
                (,,, uint256 principal, uint256 buffered, uint256 shares,) = endow.endowment(id);
                assertGe(simd.convertToAssets(shares) + buffered, principal, "whole but not covered");
            }
        }
    }
}

/// @dev sIMD behaves: its price only rises. Every rule holds without exception.
///
/// forge-config: default.invariant.depth = 150
contract EndowmentsInvariantTest is EndowmentsInvariantBase {
    function setUp() public {
        _setUp(false);
    }

    /// @dev The invariants are only worth something if the handler really gets into the situations they
    /// are about. One fixed script, each step checked.
    function test_handler_reachesEveryBehaviour() public {
        // Seeds: actor 0, endowment 3 (the recipient endowment).
        handler.deposit(0, 2, 100e18);
        assertEq(endow.principalOf(3, handler.actors(0)), 100e18);
        handler.stake(true);
        assertEq(handler.stakes(), 1);

        // Same block as the stake: an in-kind exit works, an IMD withdrawal has to wait (and is excused).
        handler.exitInKind(0, 2, 10e18, false);
        assertEq(handler.inKindExits(), 1);
        handler.withdraw(0, 2, 10e18, false, true);
        assertEq(handler.exactWithdrawals(), 0);

        handler.earn(200);
        handler.harvest(2, false);
        assertEq(handler.harvests(), 1);
        assertGt(handler.targetsHold(), 0);

        handler.withdraw(0, 2, 40e18, false, false);
        assertEq(handler.exactWithdrawals(), 1);

        // A hold caused by someone else: excused again, and gone a block later. Both ways of causing it.
        handler.strangerSendsShares(5, false);
        handler.withdraw(0, 2, 10e18, false, true);
        assertEq(handler.exactWithdrawals(), 1);
        handler.withdraw(0, 2, 10e18, false, false);
        assertEq(handler.exactWithdrawals(), 2);
        handler.strangerSendsShares(1, true);
        handler.withdraw(0, 2, 1, true, true);
        assertEq(handler.exactWithdrawals(), 2);
        handler.withdraw(0, 2, 1, true, false);
        assertEq(handler.exactWithdrawals(), 3);
        assertEq(endow.principalOf(3, handler.actors(0)), 0);

        // A pot endowment: the pot needs 4 IMD, so 4 IMD is all a harvest takes out; a series is next.
        handler.deposit(1, 1, 1_000e18);
        handler.create(3);
        assertEq(endow.endowmentCount(), 4);
        handler.deposit(1, 3, 1_000e18);
        handler.stake(true);
        handler.earn(100);
        handler.setPot(4e18, false);
        uint256 potsBefore = imd.balanceOf(address(handler.pots()));
        handler.harvest(1, false);
        assertEq(imd.balanceOf(address(handler.pots())), potsBefore + 4e18);
        handler.harvest(3, false);
        assertEq(handler.harvests(), 3);
        assertEq(imd.balanceOf(handler.heir()), 0);

        _checkFlags();
        _checkPriceMarkAndCover();
        _checkShareLedger();
        _checkBuffer();
        _checkPrincipalBooks();
        _checkNobodyGainedPrincipal();
    }

    /// @dev The same for the meter runway: a harvest that is cut to the room, one that has to wait, one
    /// that replaces what a request spent, a meter somebody else filled, and a feed whose cost moves.
    function test_handler_reachesTheMeterRunway() public {
        bytes32 feed = keccak256("robot-jobs-report");
        MockQuestions questions = handler.questions();
        uint256 runway = 30 * 0.51e18;

        // Seeds: actor 0, endowment 1 (the meter endowment). 2% of 100,000 IMD is many runways.
        handler.deposit(0, 0, 100_000e18);
        handler.stake(true);
        handler.earn(200);
        handler.harvest(0, false);
        assertEq(handler.meterHarvests(), 1);
        assertEq(handler.meterHarvestsCut(), 1);
        assertEq(questions.meterBalance(feed), runway);

        handler.harvest(0, false);
        assertEq(handler.meterHarvests(), 1);
        assertEq(handler.meterHarvestsWaiting(), 1);

        handler.meterSpends(0.51e18);
        handler.harvest(0, false);
        assertEq(handler.meterHarvests(), 2);
        assertEq(questions.meterBalance(feed), runway);

        handler.meterSpends(5e18);
        handler.strangerFundsMeter(20e18);
        handler.harvest(0, false);
        assertEq(handler.meterHarvestsWaiting(), 2);

        handler.repriceFeed(2e18 + 1);
        handler.harvest(0, false);
        assertEq(handler.meterHarvests(), 3);
        assertEq(questions.meterBalance(feed), 30 * (2e18 + 1));

        handler.repriceFeed(8); // the Intake stops selling
        assertEq(questions.cost(), 0);
        handler.meterSpends(1e18);
        handler.harvest(0, false);
        assertEq(handler.meterHarvestsWaiting(), 3);

        handler.withdraw(0, 0, 0, true, false);
        assertEq(endow.principalOf(1, handler.actors(0)), 0);

        _checkFlags();
        _checkPriceMarkAndCover();
        _checkShareLedger();
        _checkBuffer();
        _checkPrincipalBooks();
        _checkNobodyGainedPrincipal();
    }

    /// @dev E1: for every endowment, what its shares convert to plus its buffered IMD covers its principal.
    function invariant_E1_holdingsCoverPrincipal() public view {
        uint256 count = endow.endowmentCount();
        for (uint256 id = 1; id <= count; ++id) {
            (,,, uint256 principal, uint256 buffered, uint256 shares,) = endow.endowment(id);
            assertGe(simd.convertToAssets(shares) + buffered, principal, "E1: holdings below principal");
            assertTrue(endow.isWhole(id), "E1: an endowment is short");
        }
    }

    function invariant_E2_bookedSharesWithinSimdHeld() public view {
        _checkShareLedger();
    }

    /// @dev E3, and the rest of what the handler watches for on every call.
    function invariant_E3_exactWithdrawalsOnlyWaitForAHold() public view {
        _checkFlags();
        assertEq(handler.shortExits(), 0, "an endowment was short although nothing was lost");
    }

    function invariant_bufferIsExactlyTheImdHeld() public view {
        _checkBuffer();
    }

    function invariant_principalBooksAgree() public view {
        _checkPrincipalBooks();
        _checkNobodyGainedPrincipal();
    }

    function invariant_priceMarkFollowsThePrice() public view {
        _checkPriceMarkAndCover();
        assertFalse(endow.priceBelowMark(), "the price fell although nothing was lost");
    }

    /// @dev E3 once more, at the end of every run: one block on, every depositor takes back everything
    /// they are owed from every endowment, to the wei, in whatever state the run left things.
    function afterInvariant() public {
        _logMeterRunway();
        vm.roll(vm.getBlockNumber() + 1);
        uint256 count = endow.endowmentCount();
        uint256 actorCount = handler.actorCount();
        for (uint256 id = 1; id <= count; ++id) {
            for (uint256 i = 0; i < actorCount; ++i) {
                address actor = handler.actors(i);
                uint256 mine = endow.principalOf(id, actor);
                if (mine == 0) continue;
                uint256 before = imd.balanceOf(actor);
                vm.prank(actor);
                endow.withdraw(id, mine);
                assertEq(imd.balanceOf(actor), before + mine, "final withdrawal was not exact");
            }
            (,,, uint256 principal,,,) = endow.endowment(id);
            assertEq(principal, 0, "principal left after everyone withdrew");
            assertTrue(endow.isWhole(id));
        }
        _checkShareLedger();
        _checkBuffer();
    }
}

/// @dev sIMD may lose IMD at any point. Exactness is no longer promised; what must still hold is that
/// the books stay true, the share ledger stays within what is held, harvest takes nothing from a short
/// endowment, no deposit walks into a loss, and nobody leaves with more than their part.
///
/// forge-config: default.invariant.depth = 150
contract EndowmentsLossInvariantTest is EndowmentsInvariantBase {
    function setUp() public {
        _setUp(true);
    }

    /// @dev The loss handler really produces short endowments, refused deposits and pro-rata exits.
    function test_handler_reachesLossBehaviour() public {
        handler.deposit(0, 2, 100e18);
        handler.deposit(1, 2, 300e18);
        handler.stake(true);
        handler.lose(2_000);
        assertEq(handler.losses(), 1);
        assertFalse(endow.isWhole(3));

        // The gate: a short endowment takes no deposit, and the handler agrees that it should not.
        handler.deposit(2, 2, 50e18);
        assertEq(endow.principalOf(3, handler.actors(2)), 0);

        // No harvest from a short endowment.
        handler.earn(100);
        handler.harvest(2, false);
        assertEq(handler.harvests(), 0);

        // No more staking either while the price is below the mark, however long it is left.
        handler.deposit(2, 0, 50e18);
        handler.roll(60);
        handler.stake(true);
        assertEq(handler.stakes(), 1);
        assertTrue(endow.priceBelowMark());

        handler.withdraw(0, 2, 0, true, false);
        handler.withdraw(1, 2, 0, true, false);
        assertEq(handler.shortExits(), 2);
        // Each got less than they gave up, and the same fraction of it.
        address first = handler.actors(0);
        address second = handler.actors(1);
        assertLt(handler.gotBack(first), handler.gaveUp(first));
        assertApproxEqRel(handler.gotBack(first) * 3, handler.gotBack(second), 1e9);

        // Once the price is back above the mark, staking goes on.
        handler.earn(300);
        handler.earn(300);
        handler.earn(300);
        handler.earn(300);
        handler.earn(300);
        handler.earn(300);
        handler.earn(300);
        handler.earn(300);
        assertFalse(endow.priceBelowMark());
        handler.stake(true);
        assertEq(handler.stakes(), 2);

        _checkFlags();
        _checkPriceMarkAndCover();
        _checkShareLedger();
        _checkBuffer();
        _checkPrincipalBooks();
        _checkNobodyGainedPrincipal();
    }

    function invariant_loss_bookedSharesWithinSimdHeld() public view {
        _checkShareLedger();
    }

    function invariant_loss_bufferIsExactlyTheImdHeld() public view {
        _checkBuffer();
    }

    function invariant_loss_principalBooksAgree() public view {
        _checkPrincipalBooks();
        _checkNobodyGainedPrincipal();
    }

    /// @dev Pro-rata exits, the deposit gate and harvest, as watched by the handler on every call.
    function invariant_loss_sharedFairlyAndHarvestStops() public view {
        _checkFlags();
        _checkPriceMarkAndCover();
        uint256 count = endow.endowmentCount();
        for (uint256 id = 1; id <= count; ++id) {
            if (!endow.isWhole(id)) assertEq(endow.harvestable(id), 0, "a short endowment shows yield");
        }
    }

    /// @dev At the end of every run every depositor leaves each endowment in turn. Whole endowments pay
    /// in full; short ones pay each leaver no more than their part of what was there when they left.
    function afterInvariant() public {
        _logMeterRunway();
        vm.roll(vm.getBlockNumber() + 1);
        uint256 count = endow.endowmentCount();
        uint256 actorCount = handler.actorCount();
        for (uint256 id = 1; id <= count; ++id) {
            for (uint256 i = 0; i < actorCount; ++i) {
                address actor = handler.actors(i);
                uint256 mine = endow.principalOf(id, actor);
                if (mine == 0) continue;
                (,,, uint256 principal, uint256 buffered, uint256 shares,) = endow.endowment(id);
                uint256 backing = endow.backingOf(id);
                bool whole = endow.isWhole(id);
                bool covered = principal <= buffered || shares >= simd.previewWithdraw(principal - buffered);
                uint256 before = imd.balanceOf(actor);
                vm.prank(actor);
                (uint256 imdOut,) = endow.exit(id, mine, 0, false);
                assertEq(imd.balanceOf(actor), before + imdOut);
                // Whole pays in full. Covered with too little to spare for that (only after a loss) pays
                // the leaver's slice rounded down, by at most three wei.
                if (whole) assertEq(imdOut, mine, "a whole endowment did not pay in full");
                if (covered) assertGe(imdOut + 3, mine, "a covered endowment paid more than three wei short");
                assertLe(imdOut, mine, "paid more than the principal given up");
                assertLe(imdOut, backing * mine / principal + 2, "paid more than the leaver's part");
            }
            (,,, uint256 left,,,) = endow.endowment(id);
            assertEq(left, 0, "principal left after everyone exited");
        }
        _checkShareLedger();
        _checkBuffer();
    }
}
