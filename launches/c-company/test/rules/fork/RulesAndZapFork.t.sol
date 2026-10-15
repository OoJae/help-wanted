// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {Rules} from "../../../src/rules/Rules.sol";
import {Zap} from "../../../src/rules/Zap.sol";
import {IPoolManagerLike, IStateViewLike, PoolKey} from "../../../src/rules/v4/IPoolManagerLike.sol";
import {Mainnet} from "../../../src/interfaces/external/Mainnet.sol";
import {MockPots} from "../mocks/MockPots.sol";
import {MockQuestions} from "../mocks/MockQuestions.sol";

/// @dev For calls that set no time limit.
uint256 constant NO_DEADLINE = type(uint256).max;

/// @dev Rules and Zap against real mainnet contracts, on a fork at the latest block.
///
/// Zap swaps real ETH for real IMD through the real Uniswap v4 PoolManager. The crowd pots and the
/// feed meters here are stand-ins, so that the tests can set a pot's size and read a meter that
/// nobody else funds; the same calls against the live CrowdPots and Questions of launches A and B
/// are in `test/launch/fork/LiveSiblings.fork.t.sol`. Rules reads the real sIMD vault and pays in
/// real IMD; only PAY rules run here (`RulesDeskFork.t.sol` and `LiveSiblings.fork.t.sol` run HIRE
/// rules against the live desk).
///
/// Both live in one contract so that one fork is created and its state is fetched once: the public
/// node is slow and shared. Every test skips itself when the node cannot be reached.
contract RulesAndZapForkTest is Test {
    IERC20 internal constant IMD = IERC20(Mainnet.IMD);
    IERC4626 internal constant SIMD = IERC4626(Mainnet.SIMD);
    IStateViewLike internal constant STATE_VIEW = IStateViewLike(Mainnet.STATE_VIEW);
    bytes32 internal constant POOL_ID = 0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3;
    uint256 internal constant ETH_IN = 0.01 ether;

    bool internal forked;
    string internal whyNot;

    MockPots internal pots;
    MockQuestions internal questions;
    Zap internal zap;
    Rules internal rules;
    bytes32 internal constant FEED_ID = keccak256("feed:robot-payrolls");
    /// @dev ETH and IMD already sitting at Zap's address on mainnet before Zap exists there. Test
    /// contracts deploy to well-known addresses that people have sent dust to. Zap passes whatever it
    /// holds to its next caller, so the first successful call below receives this as well.
    uint256 internal dustEth;
    uint256 internal dustImd;

    address internal user = makeAddr("zap fork user");
    address internal creator = makeAddr("rules fork creator");
    address internal keeper = makeAddr("rules fork keeper");
    address internal payee = makeAddr("rules fork payee");

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("mainnet")) returns (uint256) {
            forked = true;
        } catch Error(string memory reason) {
            whyNot = reason;
            return;
        } catch {
            whyNot = "the fork could not be created";
            return;
        }
        pots = new MockPots(Mainnet.IMD);
        questions = new MockQuestions(Mainnet.IMD);
        questions.open(FEED_ID);
        zap = new Zap(Mainnet.IMD, Mainnet.POOL_MANAGER, address(pots), address(questions));
        dustEth = address(zap).balance;
        dustImd = IMD.balanceOf(address(zap));
        vm.deal(user, 10 ether);

        rules = new Rules(Mainnet.IMD, address(0xD35C));
        // Real IMD for the creator, moved from the largest idle holder (the Uniswap PoolManager).
        _giveImd(creator, 100e18);
        vm.prank(creator);
        IMD.approve(address(rules), type(uint256).max);
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true, string.concat("mainnet RPC not reachable: ", whyNot));
            return;
        }
        _;
    }

    // ------------------------------------------------------------------------------------------
    // Zap
    // ------------------------------------------------------------------------------------------

    /// @dev What `ETH_IN` buys right now: one real swap, then the chain is put back as it was.
    function _quote() internal returns (uint256 imdOut) {
        uint256 snapshot = vm.snapshotState();
        vm.prank(user);
        imdOut = zap.buy{value: ETH_IN}(0, NO_DEADLINE);
        vm.revertToState(snapshot);
    }

    /// @dev IMD per `ethIn` at the pool's current price, before any fee: ethIn * sqrtPrice^2 / 2^192.
    function _atSpot(uint256 ethIn) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = STATE_VIEW.getSlot0(POOL_ID);
        uint256 priceX64 = (uint256(sqrtPriceX96) * sqrtPriceX96) >> 128;
        return ethIn * priceX64 >> 64;
    }

    function _assertZapHoldsNothing() internal view {
        assertEq(IMD.balanceOf(address(zap)), 0, "Zap holds IMD");
        assertEq(address(zap).balance, 0, "Zap holds ETH");
        assertEq(IMD.allowance(address(zap), address(pots)), 0, "Zap left an allowance to the pots");
        assertEq(IMD.allowance(address(zap), address(questions)), 0, "Zap left an allowance to Questions");
    }

    /// @dev The pool Zap names is the live one: initialized, 1% fee, with liquidity.
    function test_fork_zap_thePoolItNamesIsLiveAndLiquid() public onFork {
        assertEq(zap.POOL_ID(), POOL_ID);
        PoolKey memory key = zap.poolKey();
        assertEq(keccak256(abi.encode(key)), POOL_ID);
        assertEq(key.currency0, address(0));
        assertEq(key.currency1, Mainnet.IMD);
        assertEq(key.hooks, address(0));
        assertGt(Mainnet.POOL_MANAGER.code.length, 0);

        (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) = STATE_VIEW.getSlot0(POOL_ID);
        uint128 liquidity = STATE_VIEW.getLiquidity(POOL_ID);
        assertGt(sqrtPriceX96, 0, "the pool is initialized");
        assertEq(lpFee, 10_000, "a fixed 1% fee");
        assertGt(liquidity, 0, "the pool has liquidity in range");
        assertGt(IMD.balanceOf(Mainnet.POOL_MANAGER), 0);
        emit log_named_uint("block", block.number);
        emit log_named_uint("sqrtPriceX96", sqrtPriceX96);
        emit log_named_int("tick", tick);
        emit log_named_uint("protocolFee (two 12-bit halves)", protocolFee);
        emit log_named_uint("liquidity", liquidity);
        emit log_named_uint("IMD per ETH at spot (1e18)", _atSpot(1 ether));
        emit log_named_uint("dust at Zap's address before its first call, wei of ETH", dustEth);
    }

    /// @dev A real swap with a minimum that passes: exactly what the pool gives at this block.
    function test_fork_zap_chipIn_realSwap_minimumThatPasses() public onFork {
        uint256 quote = _quote();
        assertGt(quote, 0);
        uint256 spot = _atSpot(ETH_IN);
        assertLt(quote, spot, "the pool's fee makes the result less than the spot price");
        emit log_named_uint("IMD for 0.01 ETH", quote);
        emit log_named_uint("IMD for 0.01 ETH at spot, before the fee", spot);
        emit log_named_uint("result as parts per 10,000 of spot", quote * 10_000 / spot);

        uint256 potId = pots.open(1_000_000e18);
        uint256 managerImdBefore = IMD.balanceOf(Mainnet.POOL_MANAGER);
        uint256 managerEthBefore = Mainnet.POOL_MANAGER.balance;

        vm.prank(user);
        uint256 gasBefore = gasleft();
        (uint256 imdOut, uint256 chipped) = zap.chipIn{value: ETH_IN}(potId, quote, NO_DEADLINE);
        emit log_named_uint("gas: chipIn through the real pool", gasBefore - gasleft());

        assertEq(imdOut, quote);
        assertEq(chipped, quote);
        assertEq(pots.chipOf(potId, user), quote, "the chip is the caller's");
        assertEq(IMD.balanceOf(address(pots)), quote);
        assertEq(user.balance, 10 ether - ETH_IN + dustEth, "exactly the ETH sent was spent");
        assertEq(IMD.balanceOf(user), dustImd);
        assertEq(managerImdBefore - IMD.balanceOf(Mainnet.POOL_MANAGER), quote, "the IMD came from the pool");
        assertEq(Mainnet.POOL_MANAGER.balance - managerEthBefore, ETH_IN, "the ETH went to the pool");
        _assertZapHoldsNothing();
    }

    /// @dev The same swap with a minimum one wei above what the pool gives: it reverts, nothing moves.
    function test_fork_zap_chipIn_realSwap_minimumThatFails() public onFork {
        uint256 quote = _quote();
        uint256 potId = pots.open(1_000_000e18);
        uint256 managerImdBefore = IMD.balanceOf(Mainnet.POOL_MANAGER);
        uint256 managerEthBefore = Mainnet.POOL_MANAGER.balance;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, quote, quote + 1));
        zap.chipIn{value: ETH_IN}(potId, quote + 1, NO_DEADLINE);

        // A minimum at the spot price can never be met either: the fee alone is 1%.
        uint256 spot = _atSpot(ETH_IN);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, quote, spot));
        zap.chipIn{value: ETH_IN}(potId, spot, NO_DEADLINE);

        assertEq(user.balance, 10 ether);
        assertEq(IMD.balanceOf(Mainnet.POOL_MANAGER), managerImdBefore);
        assertEq(Mainnet.POOL_MANAGER.balance, managerEthBefore);
        assertEq(pots.chipOf(potId, user), 0);
        assertEq(IMD.balanceOf(address(pots)), 0);
        assertEq(address(zap).balance, dustEth, "a reverted call changes nothing at all");
    }

    /// @dev A pot that needs less than the swap produced: the rest of the IMD reaches the caller.
    function test_fork_zap_chipIn_realSwap_potNeedsLess() public onFork {
        uint256 quote = _quote();
        uint256 needs = quote / 3;
        uint256 potId = pots.open(needs);

        vm.prank(user);
        (uint256 imdOut, uint256 chipped) = zap.chipIn{value: ETH_IN}(potId, quote, NO_DEADLINE);

        assertEq(imdOut, quote);
        assertEq(chipped, needs);
        assertEq(pots.chipOf(potId, user), needs);
        assertEq(IMD.balanceOf(user), quote - needs + dustImd);
        _assertZapHoldsNothing();
    }

    /// @dev A real swap onto a feed meter: the IMD bought is all on the meter and the shares are the
    /// caller's. With a minimum one wei above what the pool gives, nothing moves.
    function test_fork_zap_fundMeter_realSwap_minimumThatPassesAndOneThatFails() public onFork {
        uint256 quote = _quote();
        uint256 managerImdBefore = IMD.balanceOf(Mainnet.POOL_MANAGER);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, quote, quote + 1));
        zap.fundMeter{value: ETH_IN}(FEED_ID, quote + 1, NO_DEADLINE);
        assertEq(user.balance, 10 ether);
        assertEq(IMD.balanceOf(Mainnet.POOL_MANAGER), managerImdBefore);
        assertEq(questions.sharesOf(FEED_ID, user), 0);

        vm.prank(user);
        uint256 gasBefore = gasleft();
        (uint256 imdOut, uint256 shares) = zap.fundMeter{value: ETH_IN}(FEED_ID, quote, NO_DEADLINE);
        emit log_named_uint("gas: fundMeter through the real pool", gasBefore - gasleft());

        assertEq(imdOut, quote);
        assertEq(shares, quote, "the first funder gets one share per wei");
        assertEq(questions.sharesOf(FEED_ID, user), quote, "the shares are the caller's");
        assertEq(questions.sharesOf(FEED_ID, address(zap)), 0);
        assertEq(IMD.balanceOf(address(questions)), quote);
        assertEq(managerImdBefore - IMD.balanceOf(Mainnet.POOL_MANAGER), quote, "the IMD came from the pool");
        assertEq(user.balance, 10 ether - ETH_IN + dustEth, "exactly the ETH sent was spent");
        assertEq(IMD.balanceOf(user), dustImd);
        _assertZapHoldsNothing();
    }

    function test_fork_zap_buy_realSwap() public onFork {
        uint256 quote = _quote();
        vm.prank(user);
        uint256 gasBefore = gasleft();
        uint256 imdOut = zap.buy{value: ETH_IN}(quote, NO_DEADLINE);
        emit log_named_uint("gas: buy through the real pool", gasBefore - gasleft());
        assertEq(imdOut, quote);
        assertEq(IMD.balanceOf(user), quote + dustImd);
        assertEq(user.balance, 10 ether - ETH_IN + dustEth);
        _assertZapHoldsNothing();

        // The first swap moved the price: the same ETH now buys less, and the old minimum fails.
        vm.prank(user);
        vm.expectPartialRevert(Zap.TooLittleOut.selector);
        zap.buy{value: ETH_IN}(quote, NO_DEADLINE);
    }

    /// @dev Nobody but the manager reaches Zap's callback, and Zap's local interface carries the
    /// deployed selectors (the swaps above would have failed otherwise).
    function test_fork_zap_unlockCallback_isClosedToEveryoneButTheManager() public onFork {
        vm.prank(user);
        vm.expectRevert(Zap.NotPoolManager.selector);
        zap.unlockCallback(abi.encode(uint256(1)));
        assertEq(IPoolManagerLike.swap.selector, bytes4(0xf3cd914c));
        assertEq(IPoolManagerLike.unlock.selector, bytes4(0x48c89491));
        assertEq(IPoolManagerLike.settle.selector, bytes4(0x11da60b4));
        assertEq(IPoolManagerLike.take.selector, bytes4(0x0b0d9c09));
    }

    // ------------------------------------------------------------------------------------------
    // Rules
    // ------------------------------------------------------------------------------------------

    function _giveImd(address to, uint256 amount) internal {
        vm.prank(Mainnet.POOL_MANAGER);
        IMD.transfer(to, amount);
    }

    /// @dev WHEN target.call(data) <cmp> threshold THEN PAY 1 IMD to `payee`, tip 0.01 IMD.
    function _payRule(address target, bytes memory data, uint8 cmp, uint256 threshold) internal returns (uint256 id) {
        Rules.RuleParams memory p;
        p.when.kind = 1;
        p.when.cmp = cmp;
        p.when.target = target;
        p.when.threshold = threshold;
        p.when.data = data;
        p.action = 2;
        p.pay = Rules.Pay({recipient: payee, amount: 1e18});
        p.tip = 0.01e18;
        p.cooldown = 1 days;
        p.maxFires = 3;
        vm.prank(creator);
        id = rules.createRule(p, "", 10e18);
    }

    /// @dev WHEN sIMD.totalAssets() >= what it is now THEN PAY: true at once, and it pays real IMD.
    function test_fork_rules_viewRule_readsSimdTotalAssets_andPays() public onFork {
        uint256 assets = SIMD.totalAssets();
        assertGt(assets, 0);
        assertEq(assets, IMD.balanceOf(Mainnet.SIMD), "sIMD's assets are its IMD balance");
        emit log_named_uint("block", block.number);
        emit log_named_uint("sIMD.totalAssets()", assets);

        uint256 id = _payRule(Mainnet.SIMD, abi.encodeCall(IERC4626.totalAssets, ()), 1, assets);

        uint256 gasBefore = gasleft();
        (bool met, uint256 value, uint64 round) = rules.check(id);
        emit log_named_uint("gas: check() reading the real sIMD", gasBefore - gasleft());
        assertTrue(met);
        assertEq(value, assets, "the rule read the same word the vault reports");
        assertEq(round, 0);
        assertTrue(rules.canFire(id));

        vm.prank(keeper);
        gasBefore = gasleft();
        rules.fire(id, "");
        emit log_named_uint("gas: fire, VIEW on sIMD then PAY in real IMD", gasBefore - gasleft());

        assertEq(IMD.balanceOf(payee), 1e18);
        assertEq(IMD.balanceOf(keeper), 0.01e18);
        assertEq(rules.getRule(id).escrow, 10e18 - 1.01e18);
        assertEq(IMD.balanceOf(address(rules)), rules.totalEscrowed());
    }

    /// @dev WHEN sIMD.totalAssets() >= one IMD more than now THEN PAY: false until IMD arrives in the
    /// vault (a plain transfer raises `totalAssets`), true from then on.
    function test_fork_rules_viewRule_firesOnlyOnceTheLineIsCrossed() public onFork {
        uint256 assets = SIMD.totalAssets();
        uint256 id = _payRule(Mainnet.SIMD, abi.encodeCall(IERC4626.totalAssets, ()), 1, assets + 1e18);

        (bool met, uint256 value,) = rules.check(id);
        assertFalse(met);
        assertEq(value, assets);
        vm.prank(keeper);
        vm.expectRevert(Rules.ConditionNotMet.selector);
        rules.fire(id, "");
        assertEq(IMD.balanceOf(payee), 0);

        _giveImd(Mainnet.SIMD, 1e18);
        assertEq(SIMD.totalAssets(), assets + 1e18);
        (met, value,) = rules.check(id);
        assertTrue(met);
        assertEq(value, assets + 1e18);

        vm.prank(keeper);
        rules.fire(id, "");
        assertEq(IMD.balanceOf(payee), 1e18);

        // The cooldown holds a second fire back, then lets it through.
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Rules.CoolingDown.selector, vm.getBlockTimestamp() + 1 days));
        rules.fire(id, "");
        skip(1 days);
        vm.prank(keeper);
        rules.fire(id, "");
        assertEq(IMD.balanceOf(payee), 2e18);

        // What is left goes back to the creator, to the wei.
        uint256 before = IMD.balanceOf(creator);
        vm.prank(creator);
        rules.cancel(id);
        assertEq(IMD.balanceOf(creator) - before, 10e18 - 2 * 1.01e18);
        assertEq(IMD.balanceOf(address(rules)), 0);
    }

    /// @dev A view with an argument on the real token: WHEN IMD.balanceOf(sIMD) == sIMD.totalAssets().
    function test_fork_rules_viewRule_readsAOneArgumentViewOnTheRealToken() public onFork {
        uint256 assets = SIMD.totalAssets();
        uint256 id = _payRule(Mainnet.IMD, abi.encodeCall(IERC20.balanceOf, (Mainnet.SIMD)), 5, assets);
        (bool met, uint256 value,) = rules.check(id);
        assertTrue(met);
        assertEq(value, assets);
    }

    /// @dev Real contracts that do not answer the question: the rule does not fire and nothing reverts
    /// on the way to finding that out.
    function test_fork_rules_viewRule_realTargetsThatDoNotAnswer() public onFork {
        // The IMD token has no `totalAssets()`.
        uint256 onToken = _payRule(Mainnet.IMD, abi.encodeCall(IERC4626.totalAssets, ()), 1, 0);
        // The seat Adapter reverts for an agent that is bound to nothing.
        uint256 onAdapter =
            _payRule(Mainnet.SEAT_ADAPTER, abi.encodeWithSignature("bindingOf(uint256)", type(uint256).max), 1, 0);
        // An address with no code at all.
        uint256 onNothing = _payRule(address(0xE0A), abi.encodeCall(IERC4626.totalAssets, ()), 1, 0);

        uint256[3] memory ids = [onToken, onAdapter, onNothing];
        for (uint256 i; i < 3; ++i) {
            (bool met, uint256 value,) = rules.check(ids[i]);
            assertFalse(met);
            assertEq(value, 0);
            assertFalse(rules.canFire(ids[i]));
            vm.prank(keeper);
            vm.expectRevert(Rules.ConditionNotMet.selector);
            rules.fire(ids[i], "");
        }
    }
}
