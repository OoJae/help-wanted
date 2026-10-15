// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {Endowments} from "../../src/endowments/Endowments.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {EarlierLaunches} from "../kit/EarlierLaunches.sol";
import {IDeskLimits, Rules} from "../../src/rules/Rules.sol";
import {IMeterFunder, Zap} from "../../src/rules/Zap.sol";
import {MockCrowdPots} from "../endowments/mocks/MockCrowdPots.sol";
import {MockQuestions} from "../endowments/mocks/MockQuestions.sol";
import {MockStakedIMD} from "../endowments/mocks/MockStakedIMD.sol";
import {MockDesk} from "../rules/mocks/MockDesk.sol";
import {MockIMD} from "../rules/mocks/MockIMD.sol";
import {LaunchBench} from "./LaunchBench.sol";

/// @title The first day, as `docs/LAUNCH.md` describes it
/// @notice The launch creates three contracts and calls nothing. What happens next is a list of
/// shell commands in the launch document, each a call anyone may make. These tests hold that list
/// against the code:
///
/// - every `cast call` and `cast send` line in `docs/LAUNCH.md` and in `README.md` names a function
///   that the contract it is sent to really has;
/// - the documented steps work, in the documented order, on the three contracts created from the
///   document's manifest with nothing called in between, with the document's amounts: the first
///   endowment is created for the documented feed, its id read from the event the document names,
///   funded, staked, harvested onto the meter and withdrawn to the wei; the first rule is created
///   from the parameters and the job text written in the document, fires on the hires feed with
///   the documented gas limit, and its order is delivered with the change returned inside the
///   desk's callback, or withdrawn; IMD is bought with ETH with a minimum and a deadline;
/// - the first day's ledger in the document (what goes in, what comes back, what is spent) is what
///   those parameters and the contracts' constants give, figure by figure.
///
/// The chain is a local one. What lies outside this project stands at the manifest's addresses as
/// a stand-in (`LaunchBench`). The fork suite runs the same first day against the live contracts
/// of launches A and B (`fork/LiveSiblings.fork.t.sol`), and `integration/` against their sources.
contract LaunchRunbookTest is LaunchBench {
    Rules internal rules;
    Endowments internal endowments;
    Zap internal zap;
    MockIMD internal imd;
    MockStakedIMD internal simd;
    MockQuestions internal questions;
    MockCrowdPots internal pots;
    MockDesk internal desk;

    address internal operator = makeAddr("runbook operator");
    address internal keeper = makeAddr("runbook keeper");
    address internal passerBy = makeAddr("runbook passer-by");
    /// @dev The feed the first endowment funds, as the document names it.
    bytes32 internal feed;

    /// @dev The gas limit the document tells a sender to give `fire` for a HIRE rule.
    uint256 internal constant FIRE_GAS_LIMIT = 700_000;
    /// @dev The hire desk's fee and tip on a delivered order, each in basis points of the price.
    /// The stand-in desk does not split the price; the fork suite reads both from the live desk.
    uint256 internal constant DESK_FEE_BPS = 500;
    uint256 internal constant DESK_TIP_BPS = 500;
    /// @dev What the swarm charged for one job on 15 October 2026 (IdentityMD's price, paid by the
    /// runner, never refunded).
    uint256 internal constant SWARM_FEE = 0.5e18;
    /// @dev The hires feed's one answer before launch C: 223 transfers, round 1, stored on 13 October.
    uint256 internal constant HIRES_ANSWER = 223;

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.roll(20_000_000);
        _setUpBench();
        (rules, endowments, zap) = _launch();
        _placeStandIns();
        imd = MockIMD(lit.imd);
        simd = MockStakedIMD(lit.simd);
        questions = MockQuestions(lit.questions);
        pots = MockCrowdPots(lit.crowdPots);
        desk = MockDesk(lit.workOrders);

        feed = vm.parseBytes32(_block(_doc(), "firstEndowment:feed", "text"));
        questions.addFeed(feed);
        // The hires feed as it stood when launch C was planned: one answered round, two days old.
        questions.addFeed(EarlierLaunches.HIRES_FEED);
        // casting to 'uint64' is safe because a test's timestamp stays far below 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        questions.setLatest(EarlierLaunches.HIRES_FEED, HIRES_ANSWER, 1, uint64(vm.getBlockTimestamp() - 2 days));
        pots.open(1, 5e18);
        imd.mint(operator, 100_000e18);
        vm.deal(operator, 10 ether);
    }

    // ------------------------------------------------------------------------------------------
    // The commands
    // ------------------------------------------------------------------------------------------

    struct Surface {
        bytes4[] rules;
        bytes4[] endowments;
        bytes4[] zap;
        bytes4[] questions;
        bytes4[] desk;
        bytes4[] pots;
    }

    /// @dev Every `cast call $X "name(types)…"` and `cast send $X "name(types)…"` in the two
    /// documents is a call to a function that exists. `$RULES`, `$ENDOW` and `$ZAP` are checked
    /// against the ABIs the compiler wrote; `$QUESTIONS`, `$DESK` and `$POTS` against the interface
    /// files this project compiles against and the two functions it declares beside them
    /// (`integration/` checks the same lines against the real contracts' ABIs); `$IMD` against
    /// ERC-20 and `$SIMD` against ERC-4626.
    function test_runbook_everyDocumentedCommandNamesAFunctionThatExists() public view {
        Surface memory surface;
        surface.rules = _selectors("Rules", "Rules");
        surface.endowments = _selectors("Endowments", "Endowments");
        surface.zap = _selectors("Zap", "Zap");
        surface.questions = _selectors("IQuestions", "IQuestions");
        surface.desk = _selectors("IWorkOrders", "IWorkOrders");
        surface.pots = _selectors("ICrowdPots", "ICrowdPots");

        uint256 inLaunch = _checkCommands(vm.readFile(LAUNCH_DOC), LAUNCH_DOC, surface);
        _checkCommands(vm.readFile(README), README, surface);
        assertGe(inLaunch, 40, "docs/LAUNCH.md: the commands were not found");
    }

    function _checkCommands(string memory doc, string memory name, Surface memory surface)
        internal
        pure
        returns (uint256 checked)
    {
        string[] memory lines = vm.split(doc, "\n");
        for (uint256 i; i < lines.length; ++i) {
            uint256 at = vm.indexOf(lines[i], "cast call $");
            if (at == NOT_FOUND) at = vm.indexOf(lines[i], "cast send $");
            if (at == NOT_FOUND) continue;
            bytes memory b = bytes(lines[i]);

            // The shell variable that names the contract.
            uint256 from = at + 11;
            uint256 to = from;
            while (to < b.length && b[to] != " ") ++to;
            string memory target = _slice(b, from, to);

            // The signature: from the first quote to the end of the first balanced bracket group.
            uint256 quote = to;
            while (quote < b.length && b[quote] != '"') ++quote;
            require(quote < b.length, string.concat(name, ": a cast line without a signature: ", lines[i]));
            uint256 end = quote + 1;
            uint256 depth;
            while (end < b.length) {
                if (b[end] == "(") ++depth;
                if (b[end] == ")") {
                    --depth;
                    if (depth == 0) {
                        ++end;
                        break;
                    }
                }
                ++end;
            }
            string memory signature = _slice(b, quote + 1, end);
            require(
                _answers(target, bytes4(keccak256(bytes(signature))), surface),
                string.concat(name, ": $", target, " has no function ", signature)
            );
            ++checked;
        }
    }

    function _answers(string memory target, bytes4 selector, Surface memory surface) internal pure returns (bool) {
        if (_same(target, "RULES")) return _hasSelector(surface.rules, selector);
        if (_same(target, "ENDOW")) return _hasSelector(surface.endowments, selector);
        if (_same(target, "ZAP")) return _hasSelector(surface.zap, selector);
        if (_same(target, "QUESTIONS")) {
            // `fundFor` and `IMD()` are the real contract's, outside the frozen interface; Zap
            // declares the first, and `integration/` checks both against the real ABI.
            return _hasSelector(surface.questions, selector) || selector == IMeterFunder.fundFor.selector
                || selector == bytes4(keccak256("IMD()"));
        }
        if (_same(target, "DESK")) {
            return _hasSelector(surface.desk, selector) || selector == IDeskLimits.MAX_DELIVERY.selector;
        }
        if (_same(target, "POTS")) return _hasSelector(surface.pots, selector);
        if (_same(target, "IMD")) {
            return selector == IERC20.approve.selector || selector == IERC20.transfer.selector
                || selector == IERC20.balanceOf.selector || selector == IERC20.allowance.selector;
        }
        if (_same(target, "SIMD")) {
            return selector == IERC4626.totalAssets.selector || selector == IERC4626.convertToAssets.selector
                || selector == IERC4626.maxRedeem.selector || selector == IERC20.balanceOf.selector
                || selector == IERC4626.asset.selector;
        }
        return false;
    }

    // ------------------------------------------------------------------------------------------
    // Paying with ETH (not on the team's first day)
    // ------------------------------------------------------------------------------------------

    /// @dev The call is simulated to learn what the pool gives, then sent with a minimum one percent
    /// below that and a deadline ten minutes ahead, as the document says. The same call with a
    /// minimum the pool cannot meet, or after its deadline, reverts and costs the sender no ETH.
    function test_runbook_buyingImdWithEthWithAMinimumAndADeadline() public {
        uint256 deadline = vm.getBlockTimestamp() + 600;
        uint256 snapshot = vm.snapshotState();
        vm.prank(operator);
        uint256 quote = zap.buy{value: 0.01 ether}(1, deadline);
        vm.revertToState(snapshot);
        uint256 minimum = quote * 99 / 100;
        assertGt(minimum, 0);

        uint256 before = imd.balanceOf(operator);
        vm.prank(operator);
        assertEq(zap.buy{value: 0.01 ether}(minimum, deadline), quote);
        assertEq(imd.balanceOf(operator), before + quote);
        assertEq(operator.balance, 10 ether - 0.01 ether);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, quote, quote + 1));
        zap.buy{value: 0.01 ether}(quote + 1, deadline);

        // A pot that needs less than the swap produces: the rest comes back as IMD at once.
        uint256 needs = pots.remaining(1);
        assertEq(needs, 5e18);
        vm.prank(operator);
        (uint256 imdOut, uint256 chipped) = zap.chipIn{value: 0.02 ether}(1, minimum, deadline);
        assertEq(chipped, needs);
        assertEq(imd.balanceOf(operator), before + quote + imdOut - chipped);
        vm.prank(operator);
        (, uint256 shares) = zap.fundMeter{value: 0.01 ether}(feed, minimum, deadline);
        assertEq(questions.sharesOf(feed, operator), shares);

        vm.warp(deadline + 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, deadline));
        zap.buy{value: 0.01 ether}(minimum, deadline);
        assertEq(operator.balance, 10 ether - 0.04 ether, "the late call and the refused one cost no ETH");
        assertEq(imd.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);
    }

    // ------------------------------------------------------------------------------------------
    // The first day's ledger
    // ------------------------------------------------------------------------------------------

    /// @dev Every figure of the document's ledger follows from the first endowment's deposit, the
    /// first rule's parameters, the contracts' constants and the desk's split of a price: nothing in
    /// it is typed in twice. The hire is taken at its first price. With it, at most 2.360001 IMD is
    /// out at once and 0.556001 IMD is spent for good; without it, the seed alone.
    function test_runbook_theFirstDaysLedgerIsWhatTheParametersGive() public view {
        string memory doc = _doc();
        Ledger memory l = _ledger(doc);
        string memory json = _block(doc, "firstRule:params", "json");
        Rules.RuleParams memory p = _documentedRule(json);

        assertEq(l.endowmentDeposit, vm.parseUint(_block(doc, "firstEndowment:deposit", "text")), "deposit");
        assertEq(l.endowmentSeed, endowments.SEED(), "seed");
        assertEq(l.ruleDeposit, vm.parseUint(vm.parseJsonString(json, ".deposit")), "rule deposit");
        assertEq(l.ruleDeposit, uint256(p.hire.maxPay) + p.tip, "the rule's deposit is one fire's cost");
        assertEq(l.ruleTip, p.tip, "tip");
        assertEq(l.price, p.hire.minPay, "a runner that claims at once pays the first price");
        assertEq(l.change, p.hire.maxPay - l.price, "change");
        assertEq(l.deskFee, l.price * DESK_FEE_BPS / 10_000, "the desk's fee");
        assertEq(l.agentsTip, l.price * DESK_TIP_BPS / 10_000, "the agents' tip");
        assertEq(l.runnerPay, l.price - l.deskFee - l.agentsTip, "the runner's pay");
        assertGe(l.runnerPay, l.swarmFee, "the order pays a runner at least the swarm's fee");
        assertEq(l.runnerBond, p.hire.bond, "bond");
        assertEq(l.runnerBond, desk.MIN_BOND(), "the desk's minimum bond, the runner bot's default limit");
        assertEq(l.swarmFee, SWARM_FEE, "the swarm's fee");

        assertEq(l.peakOutlay, l.endowmentDeposit + l.endowmentSeed + l.ruleDeposit + l.runnerBond + l.swarmFee, "peak");
        assertEq(l.comesBack, l.endowmentDeposit + l.ruleTip + l.runnerPay + l.runnerBond + l.change, "back");
        assertEq(l.spentForGood, l.peakOutlay - l.comesBack, "spent");
        assertEq(l.spentForGood, l.swarmFee + l.deskFee + l.agentsTip + l.endowmentSeed, "what is spent, item by item");
        assertEq(l.spentForGoodWithoutTheHire, l.endowmentSeed, "without the hire only the seed is spent");
        // Taken at the top of its price ramp instead, the hire costs a tenth of 0.6 IMD besides the fee.
        assertEq(uint256(p.hire.maxPay) * (DESK_FEE_BPS + DESK_TIP_BPS) / 10_000, 0.06e18);
    }

    // ------------------------------------------------------------------------------------------
    // Step 1: the endowment drill
    // ------------------------------------------------------------------------------------------

    /// @dev The steps of the document, with its feed, its amount and its event topic: approve the
    /// deposit and the seed, create the endowment for the payrolls meter, read its id from the
    /// `Created` event, deposit, stake when the batch may go, harvest the yield onto the meter, and
    /// take the principal back to the wei. The yield here is 0.2%, about what six days of sIMD's
    /// rise between 10 and 15 October would give.
    function test_runbook_theFirstEndowmentIsCreatedStakedHarvestedAndWithdrawn() public {
        string memory doc = _doc();
        uint256 deposit = vm.parseUint(_block(doc, "firstEndowment:deposit", "text"));
        bytes32 createdTopic = vm.parseBytes32(_block(doc, "firstEndowment:createdTopic", "text"));
        assertEq(feed, EarlierLaunches.PAYROLLS_FEED, "the first endowment is for launch A's payrolls feed");
        assertEq(deposit, 1e18);
        assertEq(createdTopic, Endowments.Created.selector, "the document names another event");
        uint256 allowance = deposit + endowments.SEED();
        assertTrue(
            vm.contains(doc, string.concat('"approve(address,uint256)" $ENDOW ', vm.toString(allowance), " ")),
            "the approval in the document is not the deposit plus the seed"
        );
        assertTrue(
            vm.contains(doc, string.concat("export FEED=", vm.toString(feed))), "the shell variable is not the feed"
        );
        string[2] memory moves = ['"deposit(uint256,uint256)" $ID ', '"withdraw(uint256,uint256)" $ID '];
        for (uint256 i; i < 2; ++i) {
            assertTrue(
                vm.contains(doc, string.concat(moves[i], vm.toString(deposit), " ")),
                "a command does not carry the documented amount"
            );
        }

        uint256 walletBefore = imd.balanceOf(operator);
        assertGt(questions.costOf(feed), 0);
        vm.startPrank(operator);
        imd.approve(address(endowments), allowance);
        vm.recordLogs();
        uint256 returned = endowments.createForMeter(feed);
        uint256 id = _idFromTheCreatedEvent(vm.getRecordedLogs(), createdTopic);
        assertEq(id, returned);
        (Endowments.Kind kind, bytes32 target,,,,,) = endowments.endowment(id);
        assertEq(uint8(kind), 1, "kind 1 is a meter endowment");
        assertEq(target, feed);
        endowments.deposit(id, deposit);
        vm.stopPrank();
        assertEq(imd.allowance(operator, address(endowments)), 0, "the allowance was exactly what was needed");

        // Anyone stakes; the first stake may come at once.
        assertLe(endowments.nextStakeBlock(), vm.getBlockNumber(), "the first stake waits for nothing");
        vm.prank(passerBy);
        endowments.stake();
        assertTrue(endowments.vaultHold(), "in the stake block the vault pays nothing out");
        vm.roll(vm.getBlockNumber() + 1);
        assertFalse(endowments.vaultHold());

        // Before the yield reaches the least harvest, there is nothing to send.
        assertEq(endowments.harvestable(id), 0);
        vm.prank(passerBy);
        vm.expectRevert(Endowments.NothingToHarvest.selector);
        endowments.harvest(id);

        // The vault earns 0.2%: about 0.002 IMD of yield on this endowment, all of it room on the meter.
        imd.mint(lit.simd, simd.totalAssets() * 20 / 10_000);
        uint256 yield = endowments.harvestable(id);
        assertGe(yield, endowments.MIN_HARVEST());
        assertApproxEqAbs(yield, deposit * 20 / 10_000, 1e13);
        uint256 meterBefore = questions.meterBalance(feed);
        vm.prank(passerBy);
        assertEq(endowments.harvest(id), yield);
        assertEq(questions.meterBalance(feed), meterBefore + yield, "the yield is on the meter");
        assertGt(questions.sharesOf(feed, address(endowments)), 0, "the meter shares are the endowment's");
        assertEq(endowments.harvestable(id), 0);

        // The principal, to the wei: the operator is out the seed and nothing else.
        vm.prank(operator);
        endowments.withdraw(id, deposit);
        assertEq(imd.balanceOf(operator), walletBefore - endowments.SEED());
    }

    /// @dev The other way out the document gives: in a block where the vault pays nothing out, the
    /// principal leaves as sIMD shares worth at least as much, with the command's own arguments.
    function test_runbook_leavingWithSharesInABlockWhereTheVaultPaysNothingOut() public {
        string memory doc = _doc();
        uint256 deposit = vm.parseUint(_block(doc, "firstEndowment:deposit", "text"));
        assertTrue(
            vm.contains(
                doc,
                string.concat(
                    '"exit(uint256,uint256,uint256,bool)" $ID ',
                    vm.toString(deposit),
                    " ",
                    vm.toString(deposit),
                    " true"
                )
            ),
            "the exit command in the document has changed"
        );
        vm.startPrank(operator);
        imd.approve(address(endowments), deposit + endowments.SEED());
        uint256 id = endowments.createForMeter(feed);
        endowments.deposit(id, deposit);
        uint256 next = endowments.nextStakeBlock();
        if (vm.getBlockNumber() < next) vm.roll(next);
        endowments.stake();
        assertTrue(endowments.vaultHold());
        vm.expectRevert(Endowments.HoldActive.selector);
        endowments.withdraw(id, deposit);
        (uint256 imdOut, uint256 sharesOut) = endowments.exit(id, deposit, deposit, true);
        vm.stopPrank();
        assertEq(imdOut, 0);
        assertEq(simd.balanceOf(operator), sharesOut);
        assertGe(simd.convertToAssets(sharesOut), deposit);
    }

    function _idFromTheCreatedEvent(Vm.Log[] memory logs, bytes32 topic) internal view returns (uint256 id) {
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(endowments) && logs[i].topics[0] == topic) {
                id = uint256(logs[i].topics[1]);
                ++found;
            }
        }
        assertEq(found, 1, "exactly one Created event");
    }

    // ------------------------------------------------------------------------------------------
    // Step 2 and 3: the first rule
    // ------------------------------------------------------------------------------------------

    /// @dev The tuple the `createRule` command of the document must carry for those parameters: the
    /// values of the JSON block in the order of the function's arguments, with the kind's hash
    /// computed by the shell.
    function _documentedTuple(string memory json) internal pure returns (string memory) {
        string memory when = string.concat(
            "(",
            vm.toString(vm.parseJsonUint(json, ".when.kind")),
            ",",
            vm.toString(vm.parseJsonUint(json, ".when.cmp")),
            ",",
            vm.toString(vm.parseJsonUint(json, ".when.maxAge")),
            ",",
            vm.parseJsonString(json, ".when.target"),
            ",",
            vm.parseJsonString(json, ".when.threshold"),
            ",",
            vm.parseJsonString(json, ".when.feedId"),
            ",",
            vm.parseJsonString(json, ".when.data"),
            ")"
        );
        string memory hire = string.concat(
            "($(cast keccak ",
            vm.parseJsonString(json, ".hire.kind"),
            "),",
            vm.parseJsonString(json, ".hire.minPay"),
            ",",
            vm.parseJsonString(json, ".hire.maxPay"),
            ",",
            vm.toString(vm.parseJsonUint(json, ".hire.rampSecs")),
            ",",
            vm.toString(vm.parseJsonUint(json, ".hire.deliverySecs")),
            ","
        );
        hire = string.concat(
            hire,
            vm.parseJsonString(json, ".hire.bond"),
            ",",
            vm.parseJsonString(json, ".hire.runnerOnly"),
            ",",
            vm.parseJsonString(json, ".hire.arbiter"),
            ",",
            vm.toString(vm.parseJsonUint(json, ".hire.flags")),
            ",",
            vm.toString(vm.parseJsonUint(json, ".hire.orderTtl")),
            ")"
        );
        string memory rest = string.concat(
            "(",
            vm.parseJsonString(json, ".pay.recipient"),
            ",",
            vm.parseJsonString(json, ".pay.amount"),
            "),",
            vm.parseJsonString(json, ".tip"),
            ",",
            vm.toString(vm.parseJsonUint(json, ".cooldown")),
            ",",
            vm.toString(vm.parseJsonUint(json, ".maxFires"))
        );
        return
            string.concat('"(', when, ",", vm.toString(vm.parseJsonUint(json, ".action")), ",", hire, ",", rest, ')"');
    }

    /// @dev The document's first rule says what its prose says, and its command carries the same
    /// values as its JSON block.
    function test_runbook_theFirstRulesCommandCarriesTheDocumentedParameters() public view {
        string memory doc = _doc();
        string memory json = _block(doc, "firstRule:params", "json");
        string memory spec = _block(doc, "firstRule:spec", "text");
        Rules.RuleParams memory p = _documentedRule(json);
        uint256 deposit = vm.parseUint(vm.parseJsonString(json, ".deposit"));

        // WHEN the newest answer of launch A's hires feed, at most thirty days old, is at least 100 ...
        assertEq(p.when.kind, rules.COND_FEED());
        assertEq(p.when.cmp, rules.CMP_GE());
        assertEq(p.when.target, lit.questions, "the condition reads the Questions the manifest names");
        assertEq(p.when.feedId, EarlierLaunches.HIRES_FEED, "the hires feed");
        assertEq(p.when.threshold, 100);
        assertEq(p.when.maxAge, 30 days);
        assertEq(p.when.data.length, 0, "a FEED condition stores no calldata");
        // ... THEN HIRE a research report, receipt only, with the change returned in the callback.
        assertEq(p.action, rules.ACT_HIRE());
        assertEq(p.hire.kindHash, keccak256("skill:research-report"));
        assertEq(p.hire.flags, desk.FLAG_CALLBACK(), "the callback, and not the claimed path");
        assertEq(p.hire.bond, desk.MIN_BOND());
        assertEq(p.hire.minPay, 0.56e18);
        assertEq(p.hire.maxPay, 0.6e18);
        assertEq(p.hire.rampSecs, 1 days);
        assertEq(p.hire.deliverySecs, 7 days);
        assertEq(p.hire.orderTtl, 3 days);
        assertEq(p.tip, 0.01e18);
        assertEq(p.maxFires, 1);
        assertEq(deposit, uint256(p.hire.maxPay) + p.tip, "the deposit is one fire's cost");

        assertTrue(vm.contains(doc, _documentedTuple(json)), "the createRule command does not carry the JSON block");
        assertTrue(vm.contains(doc, string.concat('cast from-utf8 "', spec, '"')), "nor the documented job text");
        assertTrue(
            vm.contains(doc, string.concat('"approve(address,uint256)" $RULES ', vm.toString(deposit), " ")),
            "the approval is not the deposit"
        );
        assertTrue(vm.contains(doc, string.concat("  $SPEC ", vm.toString(deposit), " ")), "nor is the last argument");
        assertTrue(
            vm.contains(doc, '"fire(uint256,bytes)" $RULE $SPEC --gas-limit 700000 '), "the fire command has changed"
        );
        assertTrue(
            vm.contains(doc, string.concat("export HIRES=", vm.toString(EarlierLaunches.HIRES_FEED))),
            "the shell variable is not the hires feed"
        );
        // The signature in the command is `createRule`'s own.
        string memory signature =
            "createRule(((uint8,uint8,uint32,address,uint256,bytes32,bytes),uint8,(bytes32,uint96,uint96,uint32,uint32,uint96,address,address,uint8,uint32),(address,uint96),uint96,uint32,uint32),bytes,uint96)";
        assertEq(bytes4(keccak256(bytes(signature))), Rules.createRule.selector);
        assertTrue(vm.contains(doc, string.concat('cast send $RULES "', signature, '"')));
    }

    /// @dev The rule, created by the operator from the document's blocks on the launched contracts.
    function _createTheFirstRule() internal returns (uint256 id, Rules.RuleParams memory p, bytes memory spec) {
        string memory doc = _doc();
        string memory json = _block(doc, "firstRule:params", "json");
        spec = bytes(_block(doc, "firstRule:spec", "text"));
        p = _documentedRule(json);
        uint96 deposit = uint96(vm.parseUint(vm.parseJsonString(json, ".deposit")));
        vm.startPrank(operator);
        imd.approve(address(rules), deposit);
        id = rules.createRule(p, spec, deposit);
        vm.stopPrank();
        assertEq(id, rules.ruleCount());
        assertEq(rules.getRule(id).creator, operator);
        assertEq(rules.costOf(id), deposit);
    }

    /// @dev Fires the rule as the document says, with its gas limit, and returns the order.
    function _fireAsDocumented(uint256 id, bytes memory spec) internal returns (uint256 orderId) {
        vm.prank(keeper);
        (bool ok, bytes memory out) = address(rules).call{gas: FIRE_GAS_LIMIT}(abi.encodeCall(Rules.fire, (id, spec)));
        assertTrue(ok, "the documented gas limit is not enough to fire");
        orderId = abi.decode(out, (uint256));
    }

    /// @dev Steps 2 and 3 with the document's figures: the rule reads the hires feed's answer (223 in
    /// round 1, two days old), fires on the documented gas limit, opens the order its terms
    /// describe, and is paid the tip; the order is delivered at its first price, 0.56 IMD, and the
    /// 0.04 IMD of change is credited to the rule inside the desk's callback; the creator ends the
    /// rule and has the change. What the operator is out is the price, and the keeper has the tip:
    /// the ledger's figures.
    function test_runbook_theFirstRuleIsWrittenFiredAndPaid() public {
        Ledger memory l = _ledger(_doc());
        uint256 walletBefore = imd.balanceOf(operator);
        (uint256 id, Rules.RuleParams memory p, bytes memory spec) = _createTheFirstRule();

        // A round older than the rule accepts, or a value under its line, does not fire it.
        uint256 snapshot = vm.snapshotState();
        // casting to 'uint64' is safe because a test's timestamp stays far below 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        questions.setLatest(EarlierLaunches.HIRES_FEED, HIRES_ANSWER, 1, uint64(vm.getBlockTimestamp() - 30 days - 1));
        assertFalse(rules.canFire(id));
        // forge-lint: disable-next-line(unsafe-typecast)
        questions.setLatest(EarlierLaunches.HIRES_FEED, 99, 1, uint64(vm.getBlockTimestamp()));
        vm.prank(keeper);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, spec);
        vm.revertToState(snapshot);

        (bool met, uint256 value, uint64 round) = rules.check(id);
        assertTrue(met);
        assertEq(value, HIRES_ANSWER);
        assertEq(round, 1);
        uint256 firedAt = vm.getBlockTimestamp();
        uint256 orderId = _fireAsDocumented(id, spec);
        assertEq(imd.balanceOf(keeper), l.ruleTip, "whoever fires the rule is paid its tip");

        (IWorkOrders.State state, address employer, uint96 escrow,,) = desk.accountOf(orderId);
        assertEq(uint8(state), uint8(IWorkOrders.State.Open));
        assertEq(employer, address(rules), "the rule's contract is the employer");
        assertEq(escrow, p.hire.maxPay);
        IWorkOrders.OrderParams memory o = desk.paramsOf(orderId);
        assertEq(o.kindHash, p.hire.kindHash);
        assertEq(o.minPay, p.hire.minPay);
        assertEq(o.maxPay, p.hire.maxPay);
        assertEq(o.rampSecs, p.hire.rampSecs);
        assertEq(o.deliverySecs, p.hire.deliverySecs);
        assertEq(o.bond, p.hire.bond);
        assertEq(o.flags, p.hire.flags);
        assertEq(o.expiresAt, firedAt + p.hire.orderTtl);
        assertEq(desk.specHashOf(orderId), keccak256(spec));
        assertEq(uint8(rules.statusOf(id)), uint8(Rules.Status.Exhausted), "it was allowed one fire");
        (uint256 ruleOfOrder, uint96 sent,) = rules.orderOf(orderId);
        assertEq(ruleOfOrder, id);
        assertEq(sent, p.hire.maxPay);

        // Delivered at its first price: the change is the rule's inside the desk's callback.
        desk.deliver(orderId, uint96(l.price), bytes16(keccak256("the swarm's job")));
        assertEq(_credited(orderId), l.change, "the change was credited inside the callback");
        assertEq(rules.getRule(id).escrow, l.change);
        vm.prank(operator);
        assertEq(rules.cancel(id), l.change, "the creator takes the change");

        assertEq(walletBefore - imd.balanceOf(operator), l.price + l.ruleTip, "out: the price and the tip");
        assertEq(imd.balanceOf(address(rules)), 0);
        assertEq(rules.totalEscrowed(), 0);
    }

    function _credited(uint256 orderId) internal view returns (uint96 credited) {
        (,, credited) = rules.orderOf(orderId);
    }

    /// @dev Step 2 without step 3: nobody has taken the order, the creator withdraws it and ends the
    /// rule, and has every wei back but the tip the keeper was paid.
    function test_runbook_theFirstRuleCanBeUnwoundWithoutTheHire() public {
        Ledger memory l = _ledger(_doc());
        uint256 walletBefore = imd.balanceOf(operator);
        (uint256 id, Rules.RuleParams memory p, bytes memory spec) = _createTheFirstRule();
        uint256 orderId = _fireAsDocumented(id, spec);

        vm.prank(operator);
        assertEq(rules.recall(id, orderId), p.hire.maxPay);
        assertEq(uint8(desk.stateOf(orderId)), uint8(IWorkOrders.State.Cancelled));
        vm.prank(operator);
        assertEq(rules.cancel(id), p.hire.maxPay);
        assertEq(
            walletBefore - imd.balanceOf(operator), l.ruleTip, "the walk cost the operator the tip and nothing else"
        );
        assertEq(imd.balanceOf(keeper), l.ruleTip);
        assertEq(imd.balanceOf(address(rules)), 0);
        assertEq(rules.totalEscrowed(), 0);

        // An order nobody takes and nobody withdraws ends at its expiry the same way, through the
        // desk's open `refund` and anyone's `reconcile`.
        (uint256 id2,, bytes memory spec2) = _createTheFirstRule();
        uint256 firedAt = vm.getBlockTimestamp();
        // The feed must show a round this rule has not fired on; the first rule fired on round 1 of
        // its own copy only, so the second rule may fire on the same answer.
        uint256 order2 = _fireAsDocumented(id2, spec2);
        vm.warp(firedAt + p.hire.orderTtl);
        vm.prank(passerBy);
        desk.refund(order2);
        vm.prank(passerBy);
        assertEq(rules.reconcile(id2, order2), p.hire.maxPay);
        vm.prank(operator);
        assertEq(rules.cancel(id2), p.hire.maxPay);
        assertEq(walletBefore - imd.balanceOf(operator), 2 * l.ruleTip);
    }
}
