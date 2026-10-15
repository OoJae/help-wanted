// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {Endowments} from "../../../src/endowments/Endowments.sol";
import {IWorkOrders} from "../../../src/interfaces/IWorkOrders.sol";
import {Mainnet} from "../../../src/interfaces/external/Mainnet.sol";
import {EarlierLaunches} from "../../kit/EarlierLaunches.sol";
import {Rules} from "../../../src/rules/Rules.sol";
import {Zap} from "../../../src/rules/Zap.sol";
import {ILivePayroll, LiveSiblings} from "../../kit/LiveSiblings.sol";
import {LaunchManifest} from "../LaunchManifest.sol";

/// @dev Launch C against the live contracts of launches A and B, with real IMD, on a fork of mainnet
/// at the latest block: the first day of `docs/LAUNCH.md`, section 6, with its amounts, and each of
/// the three contracts against the live `Questions`, `WorkOrders` and `CrowdPots`.
///
/// The three contracts are built here with the arguments the document's manifest gives (the
/// factory's own creation of them is rehearsed in `LaunchC.fork.t.sol`). What is real: IMD, sIMD,
/// the Uniswap pool, the launched Questions, WorkOrders, WorkProof, CrowdPots and Payroll, and
/// IdentityMD's WorkRegistry, into which a receipt is written by acting as the writer the registry
/// names. What is not: the swarm's job itself. Its work record is a real IdentityMD record with the
/// job id and objective of the order (`LiveSiblings`).
///
/// Nothing asserts a figure that drifts, except where it is the point: the first day's ledger,
/// which the live desk must pay to the wei.
contract LiveSiblingsForkTest is LiveSiblings {
    Rules internal rules;
    Endowments internal endow;
    Zap internal zap;

    address internal operator = makeAddr("live fork operator");
    address internal keeper = makeAddr("live fork keeper");
    address internal runner = makeAddr("live fork runner");
    address internal user = makeAddr("live fork user");
    address internal heir = makeAddr("live fork heir");

    uint256 internal constant NO_DEADLINE = type(uint256).max;

    function setUp() public {
        if (!_selectLiveFork()) return;
        LaunchManifest.Literals memory v = _literals();
        rules = new Rules(v.imd, v.workOrders);
        endow = new Endowments(v.imd, v.simd, v.questions, v.crowdPots);
        zap = new Zap(v.imd, v.poolManager, v.crowdPots, v.questions);

        // A contract created on a fork can land where somebody once sent dust.
        _rulesDust = IMD.balanceOf(address(rules));
        _endowDust = IMD.balanceOf(address(endow));
        _fund(operator, 5_000e18, address(rules));
        vm.prank(operator);
        IMD.approve(address(endow), type(uint256).max);
        _fund(runner, 1e18, address(DESK));
        vm.deal(user, 1 ether);
    }

    // ------------------------------------------------------------------------------------------
    // The record and the contracts
    // ------------------------------------------------------------------------------------------

    /// @dev The stored record is byte for byte the one IdentityMD served for the reference job: its
    /// hash is the receipt the real registry holds for that job. And the live contracts are wired as
    /// their launches' manifests say.
    function test_fork_live_theRecordIsTheOneIdentityMDServedAndTheSiblingsAreWired() public onFork {
        bytes memory record = _referenceRecord();
        assertEq(record.length, 7_339);
        assertEq(keccak256(record), REFERENCE_RECEIPT);
        assertEq(REGISTRY.latest(REFERENCE_JOB), REFERENCE_RECEIPT, "the registry's receipt for the reference job");

        assertEq(QUESTIONS.IMD(), Mainnet.IMD);
        assertEq(DESK.IMD(), Mainnet.IMD);
        assertEq(DESK.PAYROLL(), Mainnet.PAYROLL);
        assertEq(DESK.WORK_PROOF(), EarlierLaunches.WORK_PROOF);
        assertEq(POTS.IMD(), Mainnet.IMD);
        assertEq(POTS.WORK_ORDERS(), Mainnet.WORK_ORDERS);
        assertEq(PAYROLL.QUESTIONS(), Mainnet.QUESTIONS);
        assertEq(DESK.FEE_BPS(), 500);
        assertEq(DESK.TIP_BPS(), 500);
    }

    // ------------------------------------------------------------------------------------------
    // The first rule
    // ------------------------------------------------------------------------------------------

    /// @dev Why the documented rule cannot fire on this fork, or an empty string when it can: the
    /// live hires feed's newest answer must be at least the rule's line and no older than its
    /// `maxAge`.
    function _whyTheFeedWillNotDo(Rules.RuleParams memory p) internal view returns (string memory) {
        (uint256 value,,, uint64 round, uint64 updatedAt) = QUESTIONS.latest(p.when.feedId);
        if (round == 0) return "the hires feed has no answered round on this fork";
        if (vm.getBlockTimestamp() - updatedAt > p.when.maxAge) {
            return "the hires feed's newest answer is older than the documented rule accepts: a new round is needed";
        }
        if (value < p.when.threshold) return "the hires feed's newest answer is under the documented rule's line";
        return "";
    }

    /// @dev What a settlement moved, read before and after.
    struct Moved {
        uint256 runner;
        uint256 operator;
        uint256 rules;
        ILivePayroll.Ledger payroll;
    }

    function _moved() internal view returns (Moved memory m) {
        m.runner = IMD.balanceOf(runner);
        m.operator = IMD.balanceOf(operator);
        m.rules = IMD.balanceOf(address(rules));
        m.payroll = PAYROLL.ledger();
    }

    /// @dev Fires rule `id` (whose terms are `p`), has the runner claim at once and register a fresh
    /// job, writes the job's receipt into the real registry, and settles on the live desk. Checks
    /// every figure against the ledger `l` and returns the gas of the fire and of the settlement.
    function _fireAndSettle(uint256 id, Rules.RuleParams memory p, bytes memory spec, Ledger memory l)
        internal
        returns (uint256 fireGas, uint256 settleGas, uint256 orderId)
    {
        uint256 keeperBefore = IMD.balanceOf(keeper);
        vm.prank(keeper);
        uint256 gasBefore = gasleft();
        orderId = rules.fire(id, spec);
        fireGas = gasBefore - gasleft();
        assertEq(IMD.balanceOf(keeper) - keeperBefore, l.ruleTip, "the tip went to whoever fired");

        (IWorkOrders.State state, address employer, uint96 escrow, uint96 spent, uint96 returned) =
            DESK.accountOf(orderId);
        assertEq(uint8(state), uint8(IWorkOrders.State.Open), "the order is open on the live desk");
        assertEq(employer, address(rules), "the rule's contract is the employer");
        assertEq(escrow, p.hire.maxPay);
        assertEq(spent + returned, 0);
        assertEq(DESK.priceNow(orderId), l.price, "a runner that claims at once pays the first price");

        // The runner claims in the same block, registers a job, and the job's receipt is written.
        vm.startPrank(runner);
        DESK.claim(orderId);
        bytes16 jobId = _freshJob();
        DESK.register(orderId, jobId);
        vm.stopPrank();
        bytes memory record = _recordFor(orderId, jobId, spec);
        _recordWork(jobId, record);

        Moved memory a = _moved();
        vm.prank(runner);
        gasBefore = gasleft();
        DESK.settle(orderId, record, _none());
        settleGas = gasBefore - gasleft();
        Moved memory b = _moved();

        (state, employer, escrow, spent, returned) = DESK.accountOf(orderId);
        assertEq(uint8(state), uint8(IWorkOrders.State.Delivered));
        assertEq(escrow, 0, "the desk holds nothing for the order");
        assertEq(spent, l.price, "the price was spent");
        assertEq(returned, l.change, "the change went back to the employer");
        assertEq(b.runner - a.runner, l.runnerPay + l.runnerBond, "the runner's pay and its bond");
        assertEq(b.payroll.received - a.payroll.received, l.deskFee, "Payroll booked the desk's fee");
        assertEq(b.payroll.tipsIn - a.payroll.tipsIn, l.agentsTip, "Payroll took the agents' tip");
        assertEq(b.rules - a.rules, l.change, "the change reached Rules");
        (uint256 ruleOfOrder, uint96 sent, uint96 credited) = rules.orderOf(orderId);
        assertEq(ruleOfOrder, id);
        assertEq(sent, p.hire.maxPay);
        assertEq(credited, l.change, "credited to the rule inside the desk's callback");
        assertEq(rules.getRule(id).escrow, l.change);
        assertEq(rules.totalEscrowed(), IMD.balanceOf(address(rules)) - _rulesDust);
    }

    /// @dev IMD that sat at the Rules and Endowments addresses before they were created there.
    uint256 internal _rulesDust;
    uint256 internal _endowDust;

    /// @dev Section 6, steps 2 and 3, with the document's blocks, against the live contracts: the
    /// rule reads the live hires feed, fires on the documented gas limit and opens its order on the
    /// live desk; a runner claims at the first price; the job's receipt is written into the real
    /// WorkRegistry; `settle` on the live desk pays the runner, books the fee and the tip in the live
    /// Payroll and returns the change to the rule inside the callback; the creator ends the rule. Each
    /// figure is the document's ledger. If the live feed cannot fire the rule today, the test says why
    /// and skips; `test_fork_live_aHireRuleIsPaidOnARealReceiptOnTheLiveDesk` covers the hire either way.
    function test_fork_live_theFirstRule_firesOnTheLiveHiresFeedAndIsPaidOnARealReceipt() public onFork {
        string memory doc = _doc();
        Ledger memory l = _ledger(doc);
        Rules.RuleParams memory p = _documentedRule(_block(doc, "firstRule:params", "json"));
        bytes memory spec = bytes(_block(doc, "firstRule:spec", "text"));
        uint96 deposit = uint96(vm.parseUint(vm.parseJsonString(_block(doc, "firstRule:params", "json"), ".deposit")));
        assertEq(p.when.target, Mainnet.QUESTIONS);
        assertEq(p.when.feedId, EarlierLaunches.HIRES_FEED);
        string memory why = _whyTheFeedWillNotDo(p);
        if (bytes(why).length != 0) {
            vm.skip(true, why);
            return;
        }
        uint256 operatorBefore = IMD.balanceOf(operator);

        vm.prank(operator);
        uint256 gasBefore = gasleft();
        uint256 id = rules.createRule(p, spec, deposit);
        uint256 createGas = gasBefore - gasleft();
        (bool met, uint256 value, uint64 round) = rules.check(id);
        assertTrue(met, "the documented rule holds on the live feed");
        assertGe(value, p.when.threshold);
        assertGt(round, 0);
        assertTrue(rules.canFire(id));

        // The documented gas limit is enough for the fire on the live desk.
        uint256 snapshot = vm.snapshotState();
        vm.prank(keeper);
        (bool ok,) = address(rules).call{gas: 700_000}(abi.encodeCall(Rules.fire, (id, spec)));
        assertTrue(ok, "the documented gas limit is not enough on the live desk");
        vm.revertToState(snapshot);

        (uint256 fireGas, uint256 settleGas,) = _fireAndSettle(id, p, spec, l);

        vm.prank(operator);
        gasBefore = gasleft();
        assertEq(rules.cancel(id), l.change, "the creator takes the change");
        uint256 cancelGas = gasBefore - gasleft();
        assertEq(operatorBefore - IMD.balanceOf(operator), l.price + l.ruleTip, "out: the price and the tip");
        assertEq(rules.totalEscrowed(), 0);

        emit log_named_uint("hires feed: newest answer", value);
        emit log_named_uint("hires feed: its round", round);
        emit log_named_uint("gas: createRule, the first rule", createGas);
        emit log_named_uint("gas: fire, FEED on the live hires feed then HIRE on the live desk", fireGas);
        emit log_named_uint("gas: settle on the live desk, 7,339-byte record, live Payroll, rule callback", settleGas);
        emit log_named_uint("gas: cancel, returning the change", cancelGas);
    }

    /// @dev The same hire with a condition that holds whatever the live feeds say (sIMD holds at
    /// least what it holds now), so that the live desk's settlement of a rule's order is shown on
    /// every run, with the first day's terms and figures.
    function test_fork_live_aHireRuleIsPaidOnARealReceiptOnTheLiveDesk() public onFork {
        string memory doc = _doc();
        Ledger memory l = _ledger(doc);
        Rules.RuleParams memory p = _documentedRule(_block(doc, "firstRule:params", "json"));
        bytes memory spec = bytes(_block(doc, "firstRule:spec", "text"));
        p.when.kind = rules.COND_VIEW();
        p.when.maxAge = 0;
        p.when.feedId = bytes32(0);
        p.when.target = Mainnet.SIMD;
        p.when.threshold = IERC4626(Mainnet.SIMD).totalAssets();
        p.when.data = abi.encodeCall(IERC4626.totalAssets, ());

        vm.prank(operator);
        uint256 id = rules.createRule(p, spec, uint96(l.ruleDeposit));
        (uint256 fireGas, uint256 settleGas,) = _fireAndSettle(id, p, spec, l);
        vm.prank(operator);
        assertEq(rules.cancel(id), l.change);
        emit log_named_uint("gas: fire, VIEW on sIMD then HIRE on the live desk", fireGas);
        emit log_named_uint("gas: settle on the live desk, 7,339-byte record, live Payroll, rule callback", settleGas);
    }

    /// @dev Step 2 without step 3, on the live desk: the creator withdraws the order nobody took and
    /// ends the rule. Every wei of the deposit is back but the tip.
    function test_fork_live_theFirstRule_canBeUnwoundOnTheLiveDesk() public onFork {
        string memory doc = _doc();
        Ledger memory l = _ledger(doc);
        Rules.RuleParams memory p = _documentedRule(_block(doc, "firstRule:params", "json"));
        bytes memory spec = bytes(_block(doc, "firstRule:spec", "text"));
        string memory why = _whyTheFeedWillNotDo(p);
        if (bytes(why).length != 0) {
            vm.skip(true, why);
            return;
        }
        uint256 operatorBefore = IMD.balanceOf(operator);
        vm.prank(operator);
        uint256 id = rules.createRule(p, spec, uint96(l.ruleDeposit));
        vm.prank(keeper);
        uint256 orderId = rules.fire(id, spec);

        vm.prank(operator);
        uint256 gasBefore = gasleft();
        assertEq(rules.recall(id, orderId), p.hire.maxPay);
        uint256 recallGas = gasBefore - gasleft();
        assertEq(uint8(DESK.stateOf(orderId)), uint8(IWorkOrders.State.Cancelled));
        vm.prank(operator);
        assertEq(rules.cancel(id), p.hire.maxPay);
        assertEq(operatorBefore - IMD.balanceOf(operator), l.ruleTip, "the walk cost the tip and nothing else");
        assertEq(l.spentForGoodWithoutTheHire, endow.SEED());
        emit log_named_uint("gas: recall of an order nobody took, on the live desk", recallGas);
    }

    // ------------------------------------------------------------------------------------------
    // The first endowment, and the other targets
    // ------------------------------------------------------------------------------------------

    /// @dev Section 6, step 1, with the document's feed and amount, against the live Questions and
    /// the real sIMD: the endowment is created for the payrolls feed, the deposit is staked, yield
    /// arrives as sIMD receives it (here 0.2%, a plain IMD transfer to the vault), the harvest lands
    /// on the live payrolls meter as meter shares the endowment holds, and the deposit comes back to
    /// the wei. The operator is out the seed.
    function test_fork_live_theFirstEndowment_fundsTheLivePayrollsMeterAndReturnsThePrincipal() public onFork {
        string memory doc = _doc();
        Ledger memory l = _ledger(doc);
        bytes32 feed = vm.parseBytes32(_block(doc, "firstEndowment:feed", "text"));
        uint256 deposit = vm.parseUint(_block(doc, "firstEndowment:deposit", "text"));
        assertEq(feed, EarlierLaunches.PAYROLLS_FEED);
        assertEq(deposit, l.endowmentDeposit);
        uint256 cost = QUESTIONS.costOf(feed);
        if (cost == 0) {
            vm.skip(true, "the live Questions states no cost for the payrolls feed: the Intake is not selling it");
            return;
        }
        uint256 operatorBefore = IMD.balanceOf(operator);

        vm.startPrank(operator);
        uint256 gasBefore = gasleft();
        uint256 id = endow.createForMeter(feed);
        uint256 createGas = gasBefore - gasleft();
        gasBefore = gasleft();
        endow.deposit(id, deposit);
        uint256 depositGas = gasBefore - gasleft();
        gasBefore = gasleft();
        endow.stake();
        uint256 stakeGas = gasBefore - gasleft();
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(endow.harvestable(id), 0, "no yield yet");

        _yieldBps(20);
        uint256 yield = endow.harvestable(id);
        assertGe(yield, endow.MIN_HARVEST());
        assertApproxEqAbs(yield, deposit * 20 / 10_000, 1e13);
        (uint256 meterBefore,) = QUESTIONS.meterOf(feed);
        assertLt(meterBefore + yield, 30 * cost, "the meter has room for it");
        uint256 sharesBefore = QUESTIONS.sharesOf(feed, address(endow));
        vm.prank(keeper);
        gasBefore = gasleft();
        assertEq(endow.harvest(id), yield);
        uint256 harvestGas = gasBefore - gasleft();
        (uint256 meterAfter,) = QUESTIONS.meterOf(feed);
        assertEq(meterAfter, meterBefore + yield, "the yield is on the live payrolls meter");
        assertGt(QUESTIONS.sharesOf(feed, address(endow)), sharesBefore, "as meter shares the endowment holds");
        assertApproxEqAbs(QUESTIONS.redeemable(feed, address(endow)), yield, 1);
        assertEq(IMD.balanceOf(address(endow)), _endowDust, "no IMD is left in Endowments");

        vm.prank(operator);
        gasBefore = gasleft();
        endow.withdraw(id, deposit);
        uint256 withdrawGas = gasBefore - gasleft();
        assertEq(operatorBefore - IMD.balanceOf(operator), l.endowmentSeed, "out: the seed and nothing else");

        emit log_named_uint("payrolls feed: cost of a request", cost);
        emit log_named_uint("payrolls meter before the harvest", meterBefore);
        emit log_named_uint("harvested onto the meter", yield);
        emit log_named_uint("gas: createForMeter, reading the live Questions", createGas);
        emit log_named_uint("gas: deposit", depositGas);
        emit log_named_uint("gas: stake, into the real sIMD", stakeGas);
        emit log_named_uint("gas: harvest onto the live payrolls meter", harvestGas);
        emit log_named_uint("gas: withdraw, out of the real sIMD", withdrawGas);
    }

    /// @dev A meter endowment never lifts the live meter above thirty requests at the live cost.
    function test_fork_live_aMeterEndowmentStopsAtThirtyRequestsOfTheLiveCost() public onFork {
        bytes32 feed = EarlierLaunches.PAYROLLS_FEED;
        uint256 cost = QUESTIONS.costOf(feed);
        if (cost == 0) {
            vm.skip(true, "the live Questions states no cost for the payrolls feed: the Intake is not selling it");
            return;
        }
        vm.startPrank(operator);
        uint256 id = endow.createForMeter(feed);
        endow.deposit(id, 4_000e18);
        endow.stake();
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 1);
        _yieldBps(100);
        (uint256 held,) = QUESTIONS.meterOf(feed);
        uint256 room = 30 * cost - held;
        assertEq(endow.harvestable(id), room, "the harvest is cut to the meter's room");
        vm.prank(keeper);
        assertEq(endow.harvest(id), room);
        (uint256 after_,) = QUESTIONS.meterOf(feed);
        assertEq(after_, 30 * cost, "thirty requests at the live cost, and no more");
        assertEq(endow.harvestable(id), 0, "the rest of the yield stays staked");
        vm.prank(operator);
        endow.withdraw(id, 4_000e18);
    }

    /// @dev A pot endowment on a pot opened on the live CrowdPots: the harvest takes out what the pot
    /// still needs and chips it in the fallback beneficiary's name, and the least gas a pot harvest
    /// can be sent with, against the live pot, is under the 850,000 the document gives.
    function test_fork_live_aPotEndowmentChipsIntoALivePot() public onFork {
        uint256 potId = _openLivePot(5e18);
        assertEq(POTS.remaining(potId), 5e18);
        vm.startPrank(operator);
        uint256 id = endow.createForPot(potId, heir);
        endow.deposit(id, 1_000e18);
        endow.stake();
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 1);
        _yieldBps(100);
        assertEq(endow.harvestable(id), 5e18, "what the pot still needs");

        uint256 least = _leastGasForHarvest(id);
        assertGt(least, endow.POT_CALL_GAS());
        assertLt(least, 850_000, "a pot harvest needs more gas than the document says to send");

        uint256 heirBefore = IMD.balanceOf(heir);
        vm.prank(keeper);
        (bool ok,) = address(endow).call{gas: 850_000}(abi.encodeCall(Endowments.harvest, (id)));
        assertTrue(ok, "a pot harvest sent with the documented gas limit failed");
        (uint256 chip,,) = POTS.chipOf(potId, heir);
        assertEq(chip, 5e18, "the chip is the beneficiary's");
        assertEq(POTS.remaining(potId), 0);
        assertEq(IMD.balanceOf(heir), heirBefore, "nothing went to the fallback: the pot took it all");
        emit log_named_uint("least gas for a pot harvest into the live CrowdPots", least);

        vm.prank(operator);
        endow.withdraw(id, 1_000e18);
    }

    /// @dev The least gas, to the nearest 500, with which `harvest(id)` goes through.
    function _leastGasForHarvest(uint256 id) internal returns (uint256 hi) {
        uint256 lo = 100_000;
        hi = 2_000_000;
        while (hi - lo > 500) {
            uint256 mid = (lo + hi) / 2;
            uint256 snapshot = vm.snapshotState();
            vm.prank(keeper);
            (bool ok,) = address(endow).call{gas: mid}(abi.encodeCall(Endowments.harvest, (id)));
            vm.revertToState(snapshot);
            if (ok) hi = mid;
            else lo = mid;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Zap
    // ------------------------------------------------------------------------------------------

    /// @dev Real ETH through the real pool into a pot opened on the live CrowdPots and onto the live
    /// payrolls meter: the chip and the meter shares are the caller's, and Zap keeps nothing.
    function test_fork_live_zap_chipsIntoALivePotAndFundsALiveMeter() public onFork {
        uint256 potId = _openLivePot(1_000e18);
        uint256 dustImd = IMD.balanceOf(address(zap));
        uint256 deadline = vm.getBlockTimestamp() + 10 minutes;

        vm.prank(user);
        uint256 gasBefore = gasleft();
        (uint256 imdOut, uint256 chipped) = zap.chipIn{value: 0.01 ether}(potId, 1, deadline);
        uint256 chipGas = gasBefore - gasleft();
        assertGt(imdOut, 0);
        assertEq(chipped, imdOut, "a pot that needs more takes all of it");
        (uint256 chip,,) = POTS.chipOf(potId, user);
        assertEq(chip, chipped, "the chip is the caller's");
        (uint256 zapChip,,) = POTS.chipOf(potId, address(zap));
        assertEq(zapChip, 0, "Zap is never a contributor");

        bytes32 feed = EarlierLaunches.PAYROLLS_FEED;
        if (QUESTIONS.costOf(feed) != 0) {
            uint256 before = QUESTIONS.sharesOf(feed, user);
            vm.prank(user);
            gasBefore = gasleft();
            (uint256 funded, uint256 shares) = zap.fundMeter{value: 0.01 ether}(feed, 1, deadline);
            uint256 meterGas = gasBefore - gasleft();
            assertGt(funded, 0);
            assertEq(QUESTIONS.sharesOf(feed, user) - before, shares, "the meter shares are the caller's");
            assertEq(QUESTIONS.sharesOf(feed, address(zap)), 0, "Zap is never a funder");
            emit log_named_uint("gas: Zap.fundMeter onto the live payrolls meter", meterGas);
        }
        assertEq(IMD.balanceOf(address(zap)), 0, "Zap holds no IMD");
        assertEq(address(zap).balance, 0, "Zap holds no ETH");
        assertEq(IMD.allowance(address(zap), Mainnet.CROWD_POTS), 0);
        assertEq(IMD.allowance(address(zap), Mainnet.QUESTIONS), 0);
        assertGe(IMD.balanceOf(user), dustImd, "what sat at Zap's address went to its first caller");
        emit log_named_uint("gas: Zap.chipIn into a pot on the live CrowdPots", chipGas);
    }
}
