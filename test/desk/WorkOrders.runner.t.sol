// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {DeskBase} from "./DeskBase.sol";
import {ForgivingCondition, GasCheckedSource, MockCondition} from "./mocks/MockCondition.sol";

/// Conditions and the first half of a runner's life: claim, release, evict, register.
contract WorkOrdersRunnerTest is DeskBase {
    // --- conditions ---------------------------------------------------------------------------

    /// Every comparison, below, at and above the threshold.
    function test_condition_everyComparison() public {
        // cmp: 1 >=, 2 <=, 3 >, 4 <, 5 ==, 6 !=   against threshold 10, for values 9, 10, 11
        bool[3][7] memory want = [
            [false, false, false],
            [false, true, true],
            [true, true, false],
            [false, false, true],
            [true, false, false],
            [false, true, false],
            [true, false, true]
        ];
        for (uint8 cmp = 1; cmp <= 6; ++cmp) {
            uint256 id = _open(_condParams(cmp, 10));
            for (uint256 k; k < 3; ++k) {
                cond.set(9 + k);
                (bool met, bool holds, uint256 value) = desk.conditionOf(id);
                assertFalse(met);
                assertEq(holds, want[cmp][k], "comparison");
                assertEq(value, 9 + k);
            }
        }
    }

    function testFuzz_condition_comparesUnsignedWords(uint8 cmp, uint256 value, uint256 threshold) public {
        cmp = uint8(bound(cmp, 1, 6));
        uint256 id = _open(_condParams(cmp, threshold));
        cond.set(value);
        bool want = cmp == 1
            ? value >= threshold
            : cmp == 2
                ? value <= threshold
                : cmp == 3
                    ? value > threshold
                    : cmp == 4 ? value < threshold : cmp == 5 ? value == threshold : value != threshold;
        (, bool holds, uint256 got) = desk.conditionOf(id);
        assertEq(holds, want);
        assertEq(got, value);
        if (want) {
            desk.trigger(id);
            assertTrue(desk.orderOf(id).condMet);
        } else {
            vm.expectRevert(IWorkOrdersRunner.ConditionNotMet.selector);
            desk.trigger(id);
            vm.prank(runner);
            vm.expectRevert(IWorkOrdersRunner.ConditionNotMet.selector);
            desk.claim(id);
        }
    }

    function test_trigger_latchesAConditionThatHoldsNow() public {
        uint256 id = _open(_condParams(1, 10));
        cond.set(9);
        vm.expectRevert(IWorkOrdersRunner.ConditionNotMet.selector);
        desk.trigger(id);

        cond.set(12);
        vm.warp(START + 500);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Triggered(id, 12);
        vm.prank(stranger);
        desk.trigger(id);

        IWorkOrdersRunner.Order memory o = desk.orderOf(id);
        assertTrue(o.condMet);
        assertEq(o.rampFrom, START + 500);
        (bool met, bool holds, uint256 value) = desk.conditionOf(id);
        assertTrue(met);
        assertTrue(holds);
        assertEq(value, 12);
    }

    function test_trigger_revertsOnAnOrderWithNoCondition() public {
        uint256 id = _open();
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.trigger(id);
    }

    function test_trigger_revertsOnceTriggered() public {
        uint256 id = _open(_condParams(1, 10));
        cond.set(10);
        desk.trigger(id);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.trigger(id);
    }

    function test_trigger_revertsWhenTheOrderIsNotOpen() public {
        uint256 id = _open(_condParams(1, 10));
        cond.set(10);
        vm.prank(employer);
        desk.cancel(id);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.trigger(id);
    }

    /// The whole point of latching: once seen true, the condition is never asked again.
    function test_condition_isNeverConsultedAgainOnceSeenTrue() public {
        uint256 id = _open(_condParams(1, 10));
        cond.set(10);
        desk.trigger(id);
        cond.set(0);
        (bool met, bool holds,) = desk.conditionOf(id);
        assertTrue(met);
        assertFalse(holds);
        // Even with the target gone bad, the order can be taken.
        vm.etch(address(cond), hex"fe");
        _claim(id, runner);
        _assertState(id, IWorkOrders.State.Claimed);
    }

    function test_claim_latchesImplicitly() public {
        uint256 id = _open(_condParams(4, 10));
        cond.set(3);
        vm.warp(START + 900);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Triggered(id, 3);
        _claim(id, runner);
        IWorkOrdersRunner.Order memory o = desk.orderOf(id);
        assertTrue(o.condMet);
        assertEq(o.rampFrom, START + 900);
        // The ramp starts at that moment, so the claim is at the floor.
        assertEq(desk.claimOf(id).price, MIN_PAY);
    }

    function test_claim_revertsWhileTheConditionHasNeverHeld() public {
        uint256 id = _open(_condParams(1, 10));
        cond.set(9);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ConditionNotMet.selector);
        desk.claim(id);
        assertEq(imd.balanceOf(runner), FUNDS);
        _assertState(id, IWorkOrders.State.Open);
    }

    function test_condition_withAnArgument() public {
        IWorkOrders.OrderParams memory p = _condParams(5, 42);
        p.condSelector = MockCondition.readFor.selector;
        p.condArg = keccak256("the key");
        p.flags = 4;
        uint256 id = _open(p);
        cond.set(42); // the argument-less value must not matter
        (, bool holds,) = desk.conditionOf(id);
        assertFalse(holds);
        cond.setFor(keccak256("the key"), 42);
        (, holds,) = desk.conditionOf(id);
        assertTrue(holds);
        desk.trigger(id);
    }

    /// Without the flag the argument is not sent, even if one was given.
    function test_condition_argumentIgnoredWithoutTheFlag() public {
        IWorkOrders.OrderParams memory p = _condParams(5, 42);
        p.condSelector = MockCondition.readFor.selector;
        p.condArg = keccak256("the key");
        uint256 id = _open(p);
        cond.setFor(keccak256("the key"), 42);
        // readFor(bytes32) called with no argument reverts on decoding: the condition does not hold.
        (, bool holds,) = desk.conditionOf(id);
        assertFalse(holds);
    }

    /// A target that fails in any way counts as "does not hold"; it can stop nobody but runners.
    function test_condition_failingTargetsNeverHold() public {
        bytes4[5] memory selectors = [
            MockCondition.fails.selector,
            MockCondition.short.selector,
            MockCondition.empty.selector,
            MockCondition.writes.selector,
            MockCondition.burns.selector
        ];
        for (uint256 i; i < selectors.length; ++i) {
            IWorkOrders.OrderParams memory p = _condParams(6, 12345);
            p.condSelector = selectors[i];
            uint256 id = _open(p);
            (bool met, bool holds, uint256 value) = desk.conditionOf(id);
            assertFalse(met);
            assertFalse(holds, "a failing target held");
            assertEq(value, 0);
            vm.expectRevert(IWorkOrdersRunner.ConditionNotMet.selector);
            desk.trigger(id);
            vm.prank(runner);
            vm.expectRevert(IWorkOrdersRunner.ConditionNotMet.selector);
            desk.claim(id);
            // The employer is never stuck behind its own condition.
            vm.prank(employer);
            desk.cancel(id);
        }
    }

    function test_condition_targetWithNoCodeNeverHolds() public {
        IWorkOrders.OrderParams memory p = _condParams(6, 12345);
        p.condTarget = makeAddr("no code here");
        uint256 id = _open(p);
        (, bool holds,) = desk.conditionOf(id);
        assertFalse(holds);
        vm.expectRevert(IWorkOrdersRunner.ConditionNotMet.selector);
        desk.trigger(id);
        _skip(LIFE);
        desk.refund(id);
        _assertState(id, IWorkOrders.State.Refunded);
    }

    /// The condition call gets 100,000 gas and no more.
    function test_condition_gasIsCapped() public {
        IWorkOrders.OrderParams memory p = _condParams(5, 1);
        p.condSelector = MockCondition.costly.selector;
        p.flags = 4;
        p.condArg = bytes32(uint256(80_000));
        uint256 cheap = _open(p);
        p.condArg = bytes32(uint256(130_000));
        uint256 dear = _open(p);

        (, bool holds,) = desk.conditionOf(cheap);
        assertTrue(holds, "80k of work fits");
        (, holds,) = desk.conditionOf(dear);
        assertFalse(holds, "130k of work does not");

        // A target that burns everything costs the caller the cap, not the transaction.
        p = _condParams(5, 1);
        p.condSelector = MockCondition.burns.selector;
        uint256 burner = _open(p);
        uint256 before = gasleft();
        (, holds,) = desk.conditionOf(burner);
        uint256 used = before - gasleft();
        assertFalse(holds);
        assertLt(used, 125_000, "more than the cap was spent");
        assertGt(used, 100_000);
    }

    /// Only the first word is read, so a large return costs nothing extra.
    function test_condition_largeReturnIsReadCheaply() public {
        IWorkOrders.OrderParams memory p = _condParams(5, 77);
        p.condSelector = MockCondition.big.selector;
        uint256 id = _open(p);
        cond.set(77);
        uint256 before = gasleft();
        (, bool holds, uint256 value) = desk.conditionOf(id);
        uint256 used = before - gasleft();
        assertTrue(holds);
        assertEq(value, 77);
        assertLt(used, 40_000);
        desk.trigger(id);
    }

    /// Too little gas can only make the caller's own transaction fail; it never latches a
    /// condition that would not hold with the full allowance. Here the target runs out of gas itself.
    function test_condition_lowGasCannotLatchAFalseCondition() public {
        IWorkOrders.OrderParams memory p = _condParams(5, 1);
        p.condSelector = MockCondition.costly.selector;
        p.flags = 4;
        p.condArg = bytes32(uint256(80_000));
        uint256 id = _open(p);
        for (uint256 g = 40_000; g <= 140_000; g += 10_000) {
            try desk.trigger{gas: g}(id) {
                // If it went through, the condition really answered.
                assertTrue(desk.orderOf(id).condMet);
                return;
            } catch {
                assertFalse(desk.orderOf(id).condMet);
            }
        }
        desk.trigger(id);
        assertTrue(desk.orderOf(id).condMet);
    }

    /// @dev "Hire when the reading falls below 50", read from a target whose answer depends on
    /// its gas: with its allowance it reads 100 (false); starved, its inner read fails and it
    /// answers 0 (true).
    function _forgivingOrder() internal returns (uint256 id) {
        ForgivingCondition target = new ForgivingCondition(new GasCheckedSource());
        IWorkOrders.OrderParams memory p = _params();
        p.condTarget = address(target);
        p.condSelector = ForgivingCondition.reading.selector;
        p.condCmp = 4; // <
        p.condThreshold = 50;
        id = _open(p);
        (bool met, bool holdsNow, uint256 value) = desk.conditionOf(id);
        assertFalse(met);
        assertFalse(holdsNow, "with its full allowance the condition is false");
        assertEq(value, 100);
    }

    /// The caller does not get to choose how much gas the condition answers on: `trigger` either
    /// offers the target its whole allowance or reverts. No amount of gas latches this condition.
    function test_trigger_lowGasCannotChooseTheConditionsAnswer() public {
        uint256 id = _forgivingOrder();
        uint256 gasShort;
        uint256 notMet;
        for (uint256 g = 20_000; g <= 260_000; g += 500) {
            try desk.trigger{gas: g}(id) {
                fail(string.concat("a false condition was latched by calling trigger with ", vm.toString(g), " gas"));
            } catch (bytes memory err) {
                if (bytes4(err) == IWorkOrdersRunner.GasShort.selector) ++gasShort;
                if (bytes4(err) == IWorkOrdersRunner.ConditionNotMet.selector) ++notMet;
            }
            assertFalse(desk.orderOf(id).condMet);
        }
        assertGt(gasShort, 0, "the gas check never fired");
        assertGt(notMet, 0, "the condition was never really asked");
    }

    /// The same through `claim`, which latches a condition implicitly.
    function test_claim_lowGasCannotChooseTheConditionsAnswer() public {
        uint256 id = _forgivingOrder();
        for (uint256 g = 20_000; g <= 400_000; g += 1_000) {
            vm.prank(runner);
            try desk.claim{gas: g}(id) {
                fail(string.concat("a false condition was latched by calling claim with ", vm.toString(g), " gas"));
            } catch {}
            assertFalse(desk.orderOf(id).condMet);
            _assertState(id, IWorkOrders.State.Open);
        }
        assertEq(imd.balanceOf(runner), FUNDS);
    }

    /// And the other way round: a condition that is true but dear to evaluate (95,000 of its
    /// 100,000 gas) is never reported as "not met" because the caller sent little gas. Such a call
    /// fails for lack of gas, and says so.
    function test_trigger_aTrueConditionIsNeverRefusedForLackOfGas() public {
        IWorkOrders.OrderParams memory p = _condParams(5, 1);
        p.condSelector = MockCondition.costly.selector;
        p.flags = 4;
        p.condArg = bytes32(uint256(95_000));
        uint256 id = _open(p);
        (, bool holds,) = desk.conditionOf(id);
        assertTrue(holds);
        uint256 successes;
        uint256 gasShort;
        for (uint256 g = 60_000; g <= 260_000; g += 500) {
            uint256 snap = vm.snapshotState();
            try desk.trigger{gas: g}(id) {
                ++successes;
                assertTrue(desk.orderOf(id).condMet);
            } catch (bytes memory err) {
                assertTrue(
                    bytes4(err) != IWorkOrdersRunner.ConditionNotMet.selector, "a true condition was called not met"
                );
                if (bytes4(err) == IWorkOrdersRunner.GasShort.selector) ++gasShort;
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
        assertGt(gasShort, 0);
    }

    // --- claim --------------------------------------------------------------------------------

    function test_claim_postsTheBondAndFixesThePrice() public {
        uint256 id = _open();
        vm.warp(START + RAMP / 2);
        bytes32 expected = keccak256(abi.encode(block.chainid, address(desk), id, uint256(1), runner));

        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Claimed(id, runner, 1, 3e18, BOND, expected);
        bytes32 ticket = _claim(id, runner);

        assertEq(ticket, expected);
        _assertState(id, IWorkOrders.State.Claimed);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(address(desk)), MAX_PAY + BOND);
        IWorkOrdersRunner.Claim memory c = desk.claimOf(id);
        assertEq(c.runner, runner);
        assertEq(c.claimedAt, START + RAMP / 2);
        assertEq(c.registeredAt, 0);
        assertEq(c.price, 3e18);
        assertEq(c.jobId, bytes16(0));
        assertEq(c.challenger, address(0));
        assertEq(c.assertedAt, 0);
        assertEq(c.recordHash, bytes32(0));
        assertEq(desk.orderOf(id).seq, 1);
        // The escrow is untouched by a claim.
        (,, uint96 escrow,,) = desk.accountOf(id);
        assertEq(escrow, MAX_PAY);
        _assertSolvent();
    }

    function test_claim_revertsWhenNotOpen() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.prank(runner2);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.claim(id);
        vm.prank(runner2);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.claim(999);
    }

    function test_claim_revertsFromTheExpiryOn() public {
        uint256 id = _open();
        uint256 expiresAt = desk.orderOf(id).expiresAt;
        vm.warp(expiresAt);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.Expired.selector);
        desk.claim(id);
        vm.warp(expiresAt - 1);
        _claim(id, runner);
    }

    function test_claim_reservedOrder() public {
        IWorkOrders.OrderParams memory p = _params();
        p.runnerOnly = runner2;
        uint256 id = _open(p);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.claim(id);
        _claim(id, runner2);
        assertEq(desk.claimOf(id).runner, runner2);
    }

    function test_claim_revertsWithoutTheBond() public {
        uint256 id = _open();
        address poor = makeAddr("poor");
        vm.prank(poor);
        imd.approve(address(desk), type(uint256).max);
        vm.prank(poor);
        vm.expectRevert();
        desk.claim(id);
        _assertState(id, IWorkOrders.State.Open);
    }

    function test_claim_theEmployerMayRunItsOwnOrder() public {
        uint256 id = _open();
        _claim(id, employer);
        _register(id, employer, JOB);
        desk.settle(id, _landGood(id, JOB), _noChunks());
        (uint256 runnerPay,,) = _split(MIN_PAY);
        // It paid itself and kept everything but the fee and the tip.
        assertEq(imd.balanceOf(employer), FUNDS - MIN_PAY + runnerPay);
        _assertSolvent();
    }

    function test_claim_eachClaimGetsItsOwnTicket() public {
        uint256 id = _open();
        bytes32 t1 = _claim(id, runner);
        _skip(1 hours);
        desk.evict(id);
        bytes32 t2 = _claim(id, runner);
        _skip(1 hours);
        desk.evict(id);
        bytes32 t3 = _claim(id, runner2);
        assertTrue(t1 != t2 && t2 != t3 && t1 != t3);
        assertEq(desk.orderOf(id).seq, 3);
        assertEq(t2, keccak256(abi.encode(block.chainid, address(desk), id, uint256(2), runner)));
        assertEq(t3, keccak256(abi.encode(block.chainid, address(desk), id, uint256(3), runner2)));
        assertEq(desk.ticketOf(id), t3);
    }

    /// A new claim starts clean: nothing of the previous holder's job, claim or dispute survives.
    function test_claim_resetsTheClaimRecord() public {
        bytes memory record = _record(JOB);
        uint256 id = _disputed(record);
        vm.prank(arbiter);
        desk.resolve(id, false);
        _assertState(id, IWorkOrders.State.Open);
        _claim(id, runner2);
        IWorkOrdersRunner.Claim memory c = desk.claimOf(id);
        assertEq(c.runner, runner2);
        assertEq(c.registeredAt, 0);
        assertEq(c.jobId, bytes16(0));
        assertEq(c.challenger, address(0));
        assertEq(c.assertedAt, 0);
        assertEq(c.recordHash, bytes32(0));
    }

    // --- release ------------------------------------------------------------------------------

    function test_release_costsATenthOfTheBondAndBarsTheRunner() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.Released, BOND - BOND / 10, BOND / 10, 0, IWorkOrders.State.Open
        );
        vm.prank(runner);
        desk.release(id);

        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner), FUNDS - BOND / 10);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND / 10);
        assertTrue(desk.barred(id, runner));
        (,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, MAX_PAY);
        assertEq(spent, 0);
        assertEq(returned, BOND / 10);
        _assertSolvent();

        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.Barred.selector);
        desk.claim(id);
        // Others still can, and the bar is per order.
        _claim(id, runner2);
        uint256 other = _open();
        _claim(other, runner);
    }

    /// Giving an order back for a tenth of the bond is for the claim window only. Past it the ways
    /// on are to register a job or to be evicted for the whole bond, so a runner that overstays
    /// cannot wait for an eviction to appear and release first.
    function test_release_onlyInsideTheClaimWindow() public {
        uint256 id = _open();
        _claim(id, runner);

        uint256 snap = vm.snapshotState();
        vm.warp(START + 1 hours - 1);
        vm.prank(runner);
        desk.release(id);
        assertEq(imd.balanceOf(runner), FUNDS - BOND / 10);
        vm.revertToState(snap);

        vm.warp(START + 1 hours);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.TooLate.selector);
        desk.release(id);
        _assertState(id, IWorkOrders.State.Claimed);

        // It can still register (eviction is lazy) ...
        snap = vm.snapshotState();
        _register(id, runner, JOB);
        _assertState(id, IWorkOrders.State.Registered);
        vm.revertToState(snap);
        // ... or be evicted, for the whole bond.
        desk.evict(id);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
    }

    function test_release_onlyTheRunner() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.prank(runner2);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.release(id);
        vm.prank(employer);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.release(id);
    }

    function test_release_notAfterRegistering() public {
        uint256 id = _registered();
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.release(id);
    }

    function test_release_afterExpiryRefundsTheOrder() public {
        uint256 id = _open();
        _skip(LIFE - 1);
        _claim(id, runner);
        _skip(1);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Refunded(id, MAX_PAY);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(
            id, runner, IWorkOrdersRunner.End.Released, BOND - BOND / 10, BOND / 10, 0, IWorkOrders.State.Refunded
        );
        vm.prank(runner);
        desk.release(id);
        _assertState(id, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(employer), FUNDS + BOND / 10);
        (,, uint96 escrow,, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, 0);
        assertEq(returned, MAX_PAY + BOND / 10);
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    function testFuzz_release_splitsTheBondExactly(uint96 bond) public {
        bond = uint96(bound(bond, 0.25e18, 1_000_000e18));
        imd.mint(runner, bond);
        IWorkOrders.OrderParams memory p = _params();
        p.bond = bond;
        uint256 id = _open(p);
        _claim(id, runner);
        uint256 runnerBefore = imd.balanceOf(runner);
        uint256 employerBefore = imd.balanceOf(employer);
        vm.prank(runner);
        desk.release(id);
        uint256 toRunner = imd.balanceOf(runner) - runnerBefore;
        uint256 toEmployer = imd.balanceOf(employer) - employerBefore;
        assertEq(toRunner + toEmployer, bond, "bond not conserved");
        assertEq(toEmployer, uint256(bond) / 10);
        _assertSolvent();
    }

    // --- evict --------------------------------------------------------------------------------

    function test_evict_afterTheClaimWindowTheBondGoesToTheEmployer() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.warp(START + 1 hours - 1);
        vm.expectRevert(IWorkOrdersRunner.TooEarly.selector);
        desk.evict(id);

        vm.warp(START + 1 hours);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.ClaimEnded(id, runner, IWorkOrdersRunner.End.Evicted, 0, BOND, 0, IWorkOrders.State.Open);
        vm.prank(stranger);
        desk.evict(id);

        _assertState(id, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner), FUNDS - BOND);
        assertEq(imd.balanceOf(employer), FUNDS - MAX_PAY + BOND);
        assertEq(imd.balanceOf(stranger), FUNDS);
        (,, uint96 escrow,, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, MAX_PAY);
        assertEq(returned, BOND);
        assertFalse(desk.barred(id, runner));
        _assertSolvent();
        // An evicted runner lost its bond but may try again.
        _claim(id, runner);
    }

    function test_evict_notOnceAJobIsRegistered() public {
        uint256 id = _registered();
        _skip(2 hours);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.evict(id);
    }

    function test_evict_afterExpiryRefundsTheOrder() public {
        uint256 id = _open();
        vm.warp(START + LIFE - 10);
        _claim(id, runner);
        vm.warp(START + LIFE + 1 hours);
        desk.evict(id);
        _assertState(id, IWorkOrders.State.Refunded);
        assertEq(imd.balanceOf(employer), FUNDS + BOND);
        (,, uint96 escrow,, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, 0);
        assertEq(returned, MAX_PAY + BOND);
        _assertSolvent();
    }

    /// `returned` is exact, always: it never saturates and is never estimated. A claim that could
    /// take it past the 96 bits it is reported in is refused before any money moves, and the order
    /// is not stuck by that: the employer can still withdraw it.
    function test_claim_refusesAnOrderWhoseBooksCouldOverflow() public {
        uint96 hugeBond = type(uint96).max / 2 + 1;
        imd.mint(runner, uint256(hugeBond) * 2);
        IWorkOrders.OrderParams memory p = _params();
        p.bond = hugeBond;
        uint256 id = _open(p);
        _claim(id, runner);
        _skip(1 hours);
        desk.evict(id);
        (,, uint96 escrow,, uint96 returned) = desk.accountOf(id);
        assertEq(returned, hugeBond, "returned is not the bond that was paid over");
        assertEq(escrow, MAX_PAY);

        uint256 runnerBefore = imd.balanceOf(runner);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.BooksFull.selector);
        desk.claim(id);
        assertEq(imd.balanceOf(runner), runnerBefore);
        _assertState(id, IWorkOrders.State.Open);

        vm.prank(employer);
        desk.cancel(id);
        (,, escrow,, returned) = desk.accountOf(id);
        assertEq(escrow, 0);
        assertEq(returned, uint256(hugeBond) + MAX_PAY);
        assertEq(imd.balanceOf(employer), FUNDS + uint256(hugeBond));
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    /// Whatever the bond and however often it is forfeited, `returned` equals what the employer
    /// was actually sent, to the wei; the only other outcome is a refused claim.
    function testFuzz_returnedIsExactOrTheClaimIsRefused(uint96 bond, uint8 rounds) public {
        bond = uint96(bound(bond, 0.25e18, type(uint96).max));
        rounds = uint8(bound(rounds, 1, 6));
        imd.mint(runner, uint256(bond) * rounds);
        IWorkOrders.OrderParams memory p = _params();
        p.bond = bond;
        uint256 id = _open(p);
        uint256 employerBefore = imd.balanceOf(employer);
        uint256 forfeited;
        for (uint256 i; i < rounds; ++i) {
            vm.prank(runner);
            try desk.claim(id) {
                _skip(1 hours);
                desk.evict(id);
                forfeited += bond;
            } catch (bytes memory err) {
                assertEq(bytes4(err), IWorkOrdersRunner.BooksFull.selector);
                assertGt(forfeited + MAX_PAY + bond, type(uint96).max, "refused although the books had room");
                break;
            }
        }
        vm.prank(employer);
        desk.cancel(id);
        (,, uint96 escrow,, uint96 returned) = desk.accountOf(id);
        assertEq(escrow, 0);
        assertEq(returned, forfeited + MAX_PAY, "returned is not what was sent");
        assertEq(imd.balanceOf(employer) - employerBefore, forfeited + MAX_PAY);
        assertEq(imd.balanceOf(address(desk)), 0);
    }

    /// Eviction is lazy: a runner that is late but not yet evicted can still register.
    function test_evict_isLazy() public {
        uint256 id = _open();
        _claim(id, runner);
        _skip(5 hours);
        _register(id, runner, JOB);
        _assertState(id, IWorkOrders.State.Registered);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.evict(id);
    }

    // --- register -----------------------------------------------------------------------------

    function test_register_recordsTheJobAndStartsTheDeliveryClock() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.warp(START + 600);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Registered(id, JOB);
        _register(id, runner, JOB);
        _assertState(id, IWorkOrders.State.Registered);
        IWorkOrdersRunner.Claim memory c = desk.claimOf(id);
        assertEq(c.jobId, JOB);
        assertEq(c.registeredAt, START + 600);
    }

    function test_register_onlyTheRunner() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.prank(runner2);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.register(id, JOB);
        vm.prank(employer);
        vm.expectRevert(IWorkOrdersRunner.NotRunner.selector);
        desk.register(id, JOB);
    }

    function test_register_revertsOnAZeroJobId() public {
        uint256 id = _open();
        _claim(id, runner);
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.ZeroJob.selector);
        desk.register(id, bytes16(0));
    }

    function test_register_revertsWhenNotHeld() public {
        uint256 id = _open();
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.register(id, JOB);
    }

    function test_register_aRetryReplacesTheJobButNotTheClock() public {
        uint256 id = _registered();
        vm.warp(START + 1 days);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.Registered(id, JOB2);
        _register(id, runner, JOB2);
        IWorkOrdersRunner.Claim memory c = desk.claimOf(id);
        assertEq(c.jobId, JOB2);
        assertEq(c.registeredAt, START, "a retry restarted the delivery clock");
        _assertState(id, IWorkOrders.State.Registered);

        // The deadline is still counted from the first registration.
        vm.warp(START + DELIVERY);
        desk.timeout(id);
        _assertState(id, IWorkOrders.State.Open);
    }

    function test_register_notOnceDeliveryWasClaimed() public {
        uint256 id = _asserted(_record(JOB));
        vm.prank(runner);
        vm.expectRevert(IWorkOrdersRunner.BadState.selector);
        desk.register(id, JOB2);
    }

    /// Registering a job id reserves nothing. Somebody who copies a runner's job id onto another
    /// order gains nothing and blocks nothing: the job's receipt still settles the order it was
    /// opened for, and only that one.
    function test_register_copyingAJobIdBlocksNobody() public {
        uint256 honest = _registered();
        uint256 copy = _open();
        _claim(copy, runner2);
        _register(copy, runner2, JOB);
        assertEq(desk.orderOfJob(JOB), 0);

        bytes memory record = _landGood(honest, JOB);
        vm.expectRevert(IWorkOrdersRunner.WrongHeader.selector);
        desk.settle(copy, record, _noChunks());

        desk.settle(honest, record, _noChunks());
        _assertState(honest, IWorkOrders.State.Delivered);
        assertEq(desk.orderOfJob(JOB), honest);

        // The copy can be cleared at once with the same receipt, at the copier's cost.
        desk.reportFailed(copy, record, _noChunks());
        _assertState(copy, IWorkOrders.State.Open);
        assertEq(imd.balanceOf(runner2), FUNDS - BOND);
        _assertSolvent();
    }

    /// A job whose receipt already settled an order can never settle another one, so the desk
    /// refuses to register it, as a first job or as a retry.
    function test_register_refusesAJobThatSettledAnotherOrder() public {
        uint256 first = _registered();
        desk.settle(first, _landGood(first, JOB), _noChunks());
        assertEq(desk.orderOfJob(JOB), first);

        uint256 second = _open();
        _claim(second, runner2);
        vm.prank(runner2);
        vm.expectRevert(IWorkOrdersRunner.JobUsed.selector);
        desk.register(second, JOB);
        _assertState(second, IWorkOrders.State.Claimed);
        assertEq(desk.claimOf(second).jobId, bytes16(0));

        _register(second, runner2, JOB2);
        vm.prank(runner2);
        vm.expectRevert(IWorkOrdersRunner.JobUsed.selector);
        desk.register(second, JOB);
        assertEq(desk.claimOf(second).jobId, JOB2);
    }

    /// The same once a job was matched by `stamp` after an unproven delivery.
    function test_register_refusesAJobThatStampedAnotherOrder() public {
        bytes memory record = _record(JOB);
        uint256 first = _asserted(record);
        vm.warp(START + 24 hours);
        desk.finalize(first);

        // Named in a claim that was paid, but matched to nothing yet: still free to register.
        uint256 snap = vm.snapshotState();
        uint256 second = _open();
        _claim(second, runner2);
        _register(second, runner2, JOB);
        vm.revertToState(snap);

        desk.stamp(first, _landGood(first, JOB), _noChunks());
        second = _open();
        _claim(second, runner2);
        vm.prank(runner2);
        vm.expectRevert(IWorkOrdersRunner.JobUsed.selector);
        desk.register(second, JOB);
    }
}
