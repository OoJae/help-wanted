// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {Zap} from "../../src/rules/Zap.sol";
import {PoolKey} from "../../src/rules/v4/IPoolManagerLike.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockPots} from "./mocks/MockPots.sol";
import {MockPoolManager} from "./mocks/MockPoolManager.sol";
import {MockQuestions} from "./mocks/MockQuestions.sol";

/// @dev For calls that set no time limit.
uint256 constant NO_DEADLINE = type(uint256).max;

/// @dev A caller that cannot be sent ETH: a helper contract, or a wallet contract that does not take
/// plain transfers. It needs no refund when the pool uses all the ETH it sends.
contract NoReceive {
    function chipIn(Zap zap, uint256 potId, uint256 minOut) external payable returns (uint256, uint256) {
        return zap.chipIn{value: msg.value}(potId, minOut, NO_DEADLINE);
    }

    function fundMeter(Zap zap, bytes32 feedId, uint256 minOut) external payable returns (uint256, uint256) {
        return zap.fundMeter{value: msg.value}(feedId, minOut, NO_DEADLINE);
    }

    function buy(Zap zap, uint256 minOut) external payable returns (uint256) {
        return zap.buy{value: msg.value}(minOut, NO_DEADLINE);
    }
}

/// @dev A caller that, when its unspent ETH comes back, tries to start another zap and notes how
/// that attempt ended.
contract Reenterer {
    Zap public immutable zap;
    bytes4 public innerError;
    bool public innerSucceeded;

    constructor(Zap zap_) {
        zap = zap_;
    }

    function buy(uint256 minOut) external payable {
        zap.buy{value: msg.value}(minOut, NO_DEADLINE);
    }

    receive() external payable {
        try zap.buy{value: 1}(0, NO_DEADLINE) {
            innerSucceeded = true;
        } catch (bytes memory why) {
            innerError = bytes4(why);
        }
    }
}

/// @dev Zap against a PoolManager stand-in that keeps Uniswap v4's unlock, settle and take discipline.
contract ZapTest is Test {
    MockIMD internal imd;
    MockPoolManager internal pool;
    MockPots internal pots;
    MockQuestions internal questions;
    Zap internal zap;

    address internal user = makeAddr("user");
    bytes32 internal constant FEED_ID = keccak256("feed:robot-payrolls");

    uint256 internal constant RATE = 300e18; // IMD per ETH in the mock pool

    event ChippedIn(address indexed caller, uint256 indexed potId, uint256 ethSpent, uint256 imdOut, uint256 chipped);
    event MeterFunded(address indexed caller, bytes32 indexed feedId, uint256 ethSpent, uint256 imdOut, uint256 shares);
    event Bought(address indexed caller, uint256 ethSpent, uint256 imdOut);

    function setUp() public {
        imd = new MockIMD();
        pool = new MockPoolManager(address(imd));
        pots = new MockPots(address(imd));
        questions = new MockQuestions(address(imd));
        questions.open(FEED_ID);
        zap = new Zap(address(imd), address(pool), address(pots), address(questions));
        imd.mint(address(pool), 10_000_000e18);
        vm.deal(user, 100 ether);
    }

    function _assertZapHoldsNothing() internal view {
        assertEq(imd.balanceOf(address(zap)), 0, "Zap holds IMD");
        assertEq(address(zap).balance, 0, "Zap holds ETH");
        assertEq(imd.allowance(address(zap), address(pots)), 0, "Zap left an allowance to the pots");
        assertEq(imd.allowance(address(zap), address(questions)), 0, "Zap left an allowance to Questions");
    }

    // ---- constructor and pool identity ----

    function test_constructor_recordsItsArguments() public view {
        assertEq(address(zap.IMD()), address(imd));
        assertEq(address(zap.POOL_MANAGER()), address(pool));
        assertEq(address(zap.CROWD_POTS()), address(pots));
        assertEq(address(zap.QUESTIONS()), address(questions));
        assertEq(zap.POOL_FEE(), 10_000);
        assertEq(zap.POOL_TICK_SPACING(), 200);
    }

    function test_constructor_refusesZeroAddresses() public {
        address a = address(0xA);
        vm.expectRevert(Zap.ZeroAddress.selector);
        new Zap(address(0), a, a, a);
        vm.expectRevert(Zap.ZeroAddress.selector);
        new Zap(a, address(0), a, a);
        vm.expectRevert(Zap.ZeroAddress.selector);
        new Zap(a, a, address(0), a);
        vm.expectRevert(Zap.ZeroAddress.selector);
        new Zap(a, a, a, address(0));
    }

    /// @dev Launch checks run constructors on an empty chain: no argument needs code behind it.
    function test_constructor_makesNoCallToItsArguments() public {
        Zap z = new Zap(address(0x11), address(0x22), address(0x33), address(0x44));
        assertEq(address(z.IMD()), address(0x11));
        assertEq(address(z.QUESTIONS()), address(0x44));
    }

    function test_poolKey_isTheHooklessEthImdPool() public view {
        PoolKey memory key = zap.poolKey();
        assertEq(key.currency0, address(0), "native ETH is currency0");
        assertEq(key.currency1, address(imd));
        assertEq(key.fee, 10_000);
        assertEq(key.tickSpacing, 200);
        assertEq(key.hooks, address(0));
        assertEq(zap.POOL_ID(), keccak256(abi.encode(key)));
        assertEq(zap.POOL_ID(), pool.expectedPoolId());
    }

    /// @dev Built with the real IMD address, Zap's pool id is the one recorded from mainnet.
    function test_poolId_matchesTheMainnetFixture() public {
        string memory json = vm.readFile("test/fixtures/rules/eth-imd-pool.json");
        bytes32 recorded = vm.parseJsonBytes32(json, ".poolId");
        assertEq(vm.parseJsonAddress(json, ".key.currency1"), Mainnet.IMD);
        assertEq(vm.parseJsonAddress(json, ".key.currency0"), address(0));
        assertEq(vm.parseJsonAddress(json, ".key.hooks"), address(0));
        assertEq(vm.parseJsonUint(json, ".key.fee"), 10_000);
        assertEq(vm.parseJsonUint(json, ".key.tickSpacing"), 200);
        assertEq(vm.parseJsonAddress(json, ".poolManager"), Mainnet.POOL_MANAGER);
        assertEq(recorded, 0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3);

        Zap real = new Zap(Mainnet.IMD, Mainnet.POOL_MANAGER, address(pots), address(questions));
        assertEq(real.POOL_ID(), recorded);
        // The reading shows the pool had liquidity and the expected 1% fee when it was recorded.
        assertGt(vm.parseJsonUint(json, ".reading.liquidity"), 0);
        assertEq(vm.parseJsonUint(json, ".reading.lpFee"), 10_000);
    }

    // ---- chipIn ----

    function test_chipIn_swapsAndChipsInTheCallersName() public {
        uint256 potId = pots.open(1_000e18);

        vm.expectEmit(true, true, true, true, address(zap));
        emit ChippedIn(user, potId, 0.01 ether, 3e18, 3e18);
        vm.prank(user);
        (uint256 imdOut, uint256 chipped) = zap.chipIn{value: 0.01 ether}(potId, 3e18, NO_DEADLINE);

        assertEq(imdOut, 3e18);
        assertEq(chipped, 3e18);
        assertEq(pots.chipOf(potId, user), 3e18, "the chip is the caller's");
        assertEq(pots.chipOf(potId, address(zap)), 0, "and not Zap's");
        assertEq(imd.balanceOf(address(pots)), 3e18);
        assertEq(imd.balanceOf(user), 0);
        assertEq(user.balance, 100 ether - 0.01 ether);
        assertEq(address(pool).balance, 0.01 ether);
        _assertZapHoldsNothing();
    }

    function test_chipIn_sendsBackTheImdThePotDidNotNeed() public {
        uint256 potId = pots.open(1e18);

        vm.expectEmit(true, true, true, true, address(zap));
        emit ChippedIn(user, potId, 0.01 ether, 3e18, 1e18);
        vm.prank(user);
        (uint256 imdOut, uint256 chipped) = zap.chipIn{value: 0.01 ether}(potId, 0, NO_DEADLINE);

        assertEq(imdOut, 3e18);
        assertEq(chipped, 1e18);
        assertEq(pots.chipOf(potId, user), 1e18);
        assertEq(imd.balanceOf(user), 2e18, "the unused IMD goes to the caller");
        assertEq(pots.remaining(potId), 0);
        _assertZapHoldsNothing();
    }

    function test_chipIn_revertsWhenThePotTakesNothing() public {
        uint256 potId = pots.open(1e18);
        vm.prank(user);
        zap.chipIn{value: 0.01 ether}(potId, 0, NO_DEADLINE);
        uint256 ethBefore = user.balance;

        // A full pot that answers zero.
        vm.prank(user);
        vm.expectRevert(Zap.NothingChipped.selector);
        zap.chipIn{value: 0.01 ether}(potId, 0, NO_DEADLINE);
        // A pot that does not exist.
        vm.prank(user);
        vm.expectRevert(Zap.NothingChipped.selector);
        zap.chipIn{value: 0.01 ether}(999, 0, NO_DEADLINE);
        // A full pot that reverts instead: its own error comes through.
        pots.setRevertWhenFull(true);
        vm.prank(user);
        vm.expectRevert(MockPots.PotFull.selector);
        zap.chipIn{value: 0.01 ether}(potId, 0, NO_DEADLINE);

        assertEq(user.balance, ethBefore, "the caller was not left holding a swap it did not ask for");
        _assertZapHoldsNothing();
    }

    function test_chipIn_minimumOut_passesAtTheExactAmountAndFailsOneAbove() public {
        uint256 potId = pots.open(1_000e18);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, 3e18, 3e18 + 1));
        zap.chipIn{value: 0.01 ether}(potId, 3e18 + 1, NO_DEADLINE);
        assertEq(user.balance, 100 ether);

        vm.prank(user);
        zap.chipIn{value: 0.01 ether}(potId, 3e18, NO_DEADLINE);
        assertEq(pots.chipOf(potId, user), 3e18);
    }

    function test_chipIn_minimumOut_protectsAgainstAWorsePrice() public {
        uint256 potId = pots.open(1_000e18);
        pool.setRate(RATE / 2);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, 1.5e18, 2.9e18));
        zap.chipIn{value: 0.01 ether}(potId, 2.9e18, NO_DEADLINE);
    }

    function test_chipIn_revertsWithoutEth() public {
        uint256 potId = pots.open(1_000e18);
        vm.prank(user);
        vm.expectRevert(Zap.NoEth.selector);
        zap.chipIn(potId, 0, NO_DEADLINE);
    }

    function test_chipIn_refundsTheEthThePoolCouldNotUse() public {
        uint256 potId = pots.open(1_000e18);
        pool.setMaxEthFill(0.004 ether);

        vm.expectEmit(true, true, true, true, address(zap));
        emit ChippedIn(user, potId, 0.004 ether, 1.2e18, 1.2e18);
        vm.prank(user);
        (uint256 imdOut,) = zap.chipIn{value: 0.01 ether}(potId, 1e18, NO_DEADLINE);

        assertEq(imdOut, 1.2e18);
        assertEq(user.balance, 100 ether - 0.004 ether, "the unspent ETH came back");
        assertEq(address(pool).balance, 0.004 ether);
        _assertZapHoldsNothing();
    }

    function test_chipIn_revertsWhenThePoolGivesNothing_evenWithAZeroMinimum() public {
        uint256 potId = pots.open(1_000e18);
        pool.setMaxEthFill(0);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, 0, 0));
        zap.chipIn{value: 0.01 ether}(potId, 0, NO_DEADLINE);
        assertEq(user.balance, 100 ether);
    }

    function test_chipIn_revertsWhenTheCallerCannotTakeItsEthBack() public {
        uint256 potId = pots.open(1_000e18);
        NoReceive caller = new NoReceive();
        pool.setMaxEthFill(0.004 ether);
        vm.prank(user);
        vm.expectRevert(Zap.EthRefundFailed.selector);
        caller.chipIn{value: 0.01 ether}(zap, potId, 0);
        // With nothing to refund, the same caller is fine.
        pool.setMaxEthFill(type(uint256).max);
        vm.prank(user);
        caller.chipIn{value: 0.01 ether}(zap, potId, 0);
        assertEq(pots.chipOf(potId, address(caller)), 3e18);
        _assertZapHoldsNothing();
    }

    /// @dev Zap cannot be sent ETH, but ETH can be forced into any address. A caller that takes no
    /// ETH and is owed none (the pool used everything it sent) must be served all the same: the
    /// forced-in wei is not its refund. It waits in Zap for the next caller that can take it.
    function test_strayEth_doesNotStopACallerThatIsOwedNoRefund() public {
        NoReceive caller = new NoReceive();
        uint256 potId = pots.open(1_000e18);

        // With Zap empty this caller is served: the pool uses all 0.01 ETH and nothing comes back.
        vm.prank(user);
        caller.chipIn{value: 0.01 ether}(zap, potId, 0);
        assertEq(pots.chipOf(potId, address(caller)), 3e18);

        // Somebody forces one wei into Zap. The same call goes through again, on every entry point.
        vm.deal(address(zap), 1);
        vm.prank(user);
        caller.chipIn{value: 0.01 ether}(zap, potId, 0);
        assertEq(pots.chipOf(potId, address(caller)), 6e18, "the caller's chip went in");
        vm.prank(user);
        caller.fundMeter{value: 0.01 ether}(zap, FEED_ID, 0);
        assertEq(questions.sharesOf(FEED_ID, address(caller)), 3e18, "the caller's shares were credited");
        vm.prank(user);
        caller.buy{value: 0.01 ether}(zap, 0);
        assertEq(imd.balanceOf(address(caller)), 3e18);

        // The wei is still there, and is nobody's refund. Nothing else is.
        assertEq(address(zap).balance, 1);
        assertEq(imd.balanceOf(address(zap)), 0);
        assertEq(address(pool).balance, 0.04 ether, "every wei the caller sent was spent");

        // The next caller that can take ETH takes it along.
        vm.prank(user);
        zap.buy{value: 0.01 ether}(0, NO_DEADLINE);
        assertEq(user.balance, 100 ether - 0.05 ether + 1);
        _assertZapHoldsNothing();
    }

    /// @dev What must still revert: a caller that takes no ETH and IS owed some. Stray ETH in Zap
    /// changes nothing about that.
    function test_strayEth_aCallerOwedARefundItCannotTakeStillReverts() public {
        NoReceive caller = new NoReceive();
        pool.setMaxEthFill(0.004 ether);
        vm.deal(address(zap), 1);
        vm.prank(user);
        vm.expectRevert(Zap.EthRefundFailed.selector);
        caller.buy{value: 0.01 ether}(zap, 0);
        assertEq(user.balance, 100 ether);
        assertEq(address(zap).balance, 1);
    }

    // ---- fundMeter ----

    function test_fundMeter_swapsAndFundsInTheCallersName() public {
        vm.expectEmit(true, true, true, true, address(zap));
        emit MeterFunded(user, FEED_ID, 0.01 ether, 3e18, 3e18);
        vm.prank(user);
        (uint256 imdOut, uint256 shares) = zap.fundMeter{value: 0.01 ether}(FEED_ID, 3e18, NO_DEADLINE);

        assertEq(imdOut, 3e18);
        assertEq(shares, 3e18);
        assertEq(questions.sharesOf(FEED_ID, user), 3e18, "the shares are the caller's");
        assertEq(questions.sharesOf(FEED_ID, address(zap)), 0, "and not Zap's");
        assertEq(questions.meterBalance(FEED_ID), 3e18);
        assertEq(imd.balanceOf(address(questions)), 3e18);
        assertEq(imd.balanceOf(user), 0);
        assertEq(user.balance, 100 ether - 0.01 ether);
        assertEq(address(pool).balance, 0.01 ether);
        _assertZapHoldsNothing();
    }

    /// @dev A meter that has spent part of what it held mints more than one share per wei. The
    /// caller gets whatever the meter credits, and Zap reports the same number.
    function test_fundMeter_creditsSharesAtTheMetersWorth() public {
        vm.prank(user);
        zap.fundMeter{value: 0.01 ether}(FEED_ID, 0, NO_DEADLINE);
        questions.spend(FEED_ID, 2e18); // 3e18 shares now stand for 1e18 IMD

        address second = makeAddr("second funder");
        vm.deal(second, 1 ether);
        vm.prank(second);
        (uint256 imdOut, uint256 shares) = zap.fundMeter{value: 0.01 ether}(FEED_ID, 0, NO_DEADLINE);
        assertEq(imdOut, 3e18);
        assertEq(shares, 9e18);
        assertEq(questions.sharesOf(FEED_ID, second), 9e18);
        assertEq(questions.sharesOf(FEED_ID, user), 3e18, "the first funder's shares are untouched");
        _assertZapHoldsNothing();
    }

    function test_fundMeter_minimumOutAndNoEth() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, 3e18, 3e18 + 1));
        zap.fundMeter{value: 0.01 ether}(FEED_ID, 3e18 + 1, NO_DEADLINE);
        vm.prank(user);
        vm.expectRevert(Zap.NoEth.selector);
        zap.fundMeter(FEED_ID, 0, NO_DEADLINE);
        assertEq(user.balance, 100 ether);
        assertEq(questions.meterBalance(FEED_ID), 0);

        vm.prank(user);
        zap.fundMeter{value: 0.01 ether}(FEED_ID, 3e18, NO_DEADLINE);
        assertEq(questions.sharesOf(FEED_ID, user), 3e18);
    }

    /// @dev Questions refuses (the feed does not exist): its own error comes through, the swap is
    /// undone with everything else, and the caller keeps the ETH.
    function test_fundMeter_revertsWhenQuestionsRefuses() public {
        bytes32 unknown = keccak256("feed:nobody-made-this");
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MockQuestions.UnknownFeed.selector, unknown));
        zap.fundMeter{value: 0.01 ether}(unknown, 0, NO_DEADLINE);
        assertEq(user.balance, 100 ether);
        assertEq(address(pool).balance, 0);
        _assertZapHoldsNothing();
    }

    /// @dev A meter that takes the IMD and credits nothing: the caller would have paid for nothing,
    /// so the whole call reverts.
    function test_fundMeter_revertsWhenNoSharesAreCredited() public {
        questions.setCreditNothing(true);
        vm.prank(user);
        vm.expectRevert(Zap.NothingFunded.selector);
        zap.fundMeter{value: 0.01 ether}(FEED_ID, 0, NO_DEADLINE);
        assertEq(user.balance, 100 ether);
        assertEq(imd.balanceOf(address(questions)), 0);
        _assertZapHoldsNothing();
    }

    /// @dev A meter that pulls less than it was offered: the rest reaches the caller, and the
    /// allowance it did not use does not outlive the call.
    function test_fundMeter_sendsBackTheImdTheMeterDidNotTake() public {
        questions.setPullBps(2_500);
        vm.prank(user);
        (uint256 imdOut, uint256 shares) = zap.fundMeter{value: 0.01 ether}(FEED_ID, 0, NO_DEADLINE);
        assertEq(imdOut, 3e18);
        assertEq(shares, 0.75e18);
        assertEq(imd.balanceOf(address(questions)), 0.75e18);
        assertEq(imd.balanceOf(user), 2.25e18, "the unused IMD goes to the caller");
        _assertZapHoldsNothing();
    }

    function test_fundMeter_refundsTheEthThePoolCouldNotUse() public {
        pool.setMaxEthFill(0.004 ether);
        vm.expectEmit(true, true, true, true, address(zap));
        emit MeterFunded(user, FEED_ID, 0.004 ether, 1.2e18, 1.2e18);
        vm.prank(user);
        (uint256 imdOut,) = zap.fundMeter{value: 0.01 ether}(FEED_ID, 1e18, NO_DEADLINE);
        assertEq(imdOut, 1.2e18);
        assertEq(user.balance, 100 ether - 0.004 ether, "the unspent ETH came back");
        _assertZapHoldsNothing();
    }

    // ---- buy ----

    function test_buy_sendsTheImdToTheCaller() public {
        vm.expectEmit(true, true, true, true, address(zap));
        emit Bought(user, 1 ether, 300e18);
        vm.prank(user);
        uint256 imdOut = zap.buy{value: 1 ether}(300e18, NO_DEADLINE);

        assertEq(imdOut, 300e18);
        assertEq(imd.balanceOf(user), 300e18);
        assertEq(user.balance, 99 ether);
        _assertZapHoldsNothing();
    }

    function test_buy_minimumOutAndNoEth() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, 300e18, 300e18 + 1));
        zap.buy{value: 1 ether}(300e18 + 1, NO_DEADLINE);
        vm.prank(user);
        vm.expectRevert(Zap.NoEth.selector);
        zap.buy(0, NO_DEADLINE);
        assertEq(user.balance, 100 ether);
    }

    function test_buy_refundsTheEthThePoolCouldNotUse() public {
        pool.setMaxEthFill(0.25 ether);
        vm.expectEmit(true, true, true, true, address(zap));
        emit Bought(user, 0.25 ether, 75e18);
        vm.prank(user);
        zap.buy{value: 1 ether}(0, NO_DEADLINE);
        assertEq(user.balance, 99.75 ether);
        assertEq(imd.balanceOf(user), 75e18);
        _assertZapHoldsNothing();
    }

    // ---- the deadline ----

    /// @dev The deadline is the last second at which a call may still run: in that second every
    /// entry point goes through, and one second later every one of them reverts and the caller keeps
    /// its ETH.
    function test_deadline_runsInItsLastSecondAndRevertsOneSecondLater() public {
        vm.warp(1_760_000_000);
        uint256 deadline = vm.getBlockTimestamp() + 10 minutes;
        uint256 potId = pots.open(1_000e18);

        vm.warp(deadline);
        vm.startPrank(user);
        (, uint256 chipped) = zap.chipIn{value: 0.01 ether}(potId, 3e18, deadline);
        (, uint256 shares) = zap.fundMeter{value: 0.01 ether}(FEED_ID, 3e18, deadline);
        uint256 bought = zap.buy{value: 0.01 ether}(3e18, deadline);
        vm.stopPrank();
        assertEq(chipped, 3e18);
        assertEq(shares, 3e18);
        assertEq(bought, 3e18);
        assertEq(user.balance, 100 ether - 0.03 ether);

        vm.warp(deadline + 1);
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, deadline));
        zap.chipIn{value: 0.01 ether}(potId, 3e18, deadline);
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, deadline));
        zap.fundMeter{value: 0.01 ether}(FEED_ID, 3e18, deadline);
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, deadline));
        zap.buy{value: 0.01 ether}(3e18, deadline);
        vm.stopPrank();

        assertEq(user.balance, 100 ether - 0.03 ether, "a late call costs the caller no ETH");
        assertEq(address(pool).balance, 0.03 ether, "and nothing was swapped");
        assertEq(pots.chipOf(potId, user), 3e18);
        assertEq(questions.sharesOf(FEED_ID, user), 3e18);
        assertEq(imd.balanceOf(user), 3e18);
        _assertZapHoldsNothing();
    }

    /// @dev The deadline is looked at before anything else: a late call reports that it is late,
    /// whatever else is wrong with it, and never reaches the pool.
    function test_deadline_isCheckedBeforeEverythingElse() public {
        vm.warp(1_760_000_000);
        uint256 late = vm.getBlockTimestamp() - 1;
        pool.setFlipSigns(true); // a swap would revert `UnexpectedDelta`

        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, late));
        zap.buy(0, late); // no ETH either
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, late));
        zap.buy{value: 1 ether}(type(uint256).max, late); // and a minimum nothing could meet
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, late));
        zap.chipIn{value: 1 ether}(999, 0, late); // a pot that does not exist
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, late));
        zap.fundMeter{value: 1 ether}(keccak256("feed:nobody-made-this"), 0, late);
        vm.stopPrank();
        assertEq(user.balance, 100 ether);
    }

    /// @dev A deadline of zero is a deadline like any other: it passed long ago.
    function test_deadline_zeroIsNotNoDeadline() public {
        vm.warp(1_760_000_000);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, 0));
        zap.buy{value: 1 ether}(0, 0);
    }

    /// @dev Any clock and any deadline: the call runs exactly when the block is not later than the
    /// deadline.
    function testFuzz_deadline_runsExactlyWhenNotLate(uint256 nowIs, uint256 deadline, uint8 entry) public {
        nowIs = bound(nowIs, 1, type(uint64).max);
        // Half the time close to the clock, where the boundary is.
        if (deadline % 2 == 0) deadline = bound(deadline, nowIs - 1, nowIs + 1);
        vm.warp(nowIs);
        uint256 potId = pots.open(1_000e18);
        bool late = nowIs > deadline;

        vm.prank(user);
        if (late) vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, deadline));
        if (entry % 3 == 0) zap.chipIn{value: 0.01 ether}(potId, 0, deadline);
        else if (entry % 3 == 1) zap.fundMeter{value: 0.01 ether}(FEED_ID, 0, deadline);
        else zap.buy{value: 0.01 ether}(0, deadline);

        assertEq(user.balance, late ? 100 ether : 100 ether - 0.01 ether);
        assertEq(address(pool).balance, late ? 0 : 0.01 ether);
        _assertZapHoldsNothing();
    }

    // ---- nothing stays in Zap ----

    function test_strayImdAndEthLeaveWithTheNextCall() public {
        imd.mint(address(zap), 7e18); // sent by mistake
        vm.deal(address(zap), 0.5 ether); // forced in; Zap has no way to accept ETH itself

        vm.prank(user);
        zap.buy{value: 1 ether}(0, NO_DEADLINE);

        assertEq(imd.balanceOf(user), 300e18 + 7e18);
        assertEq(user.balance, 99 ether + 0.5 ether);
        _assertZapHoldsNothing();
    }

    function test_zapCannotBeSentEth() public {
        vm.prank(user);
        (bool ok,) = address(zap).call{value: 1 ether}("");
        assertFalse(ok, "no receive function");
        vm.prank(user);
        (ok,) = address(zap).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok, "no fallback function");
        assertEq(address(zap).balance, 0);
    }

    // ---- the PoolManager callback ----

    function test_unlockCallback_onlyThePoolManager() public {
        vm.prank(user);
        vm.expectRevert(Zap.NotPoolManager.selector);
        zap.unlockCallback(abi.encode(uint256(1 ether)));
    }

    function test_swap_revertsOnAResultOfTheWrongSign() public {
        pool.setFlipSigns(true);
        vm.prank(user);
        vm.expectRevert(Zap.UnexpectedDelta.selector);
        zap.buy{value: 1 ether}(0, NO_DEADLINE);
    }

    function test_swap_revertsWhenTheManagerDoesNotCountTheEthItWasPaid() public {
        pool.setUndercountSettle(true);
        vm.prank(user);
        vm.expectRevert(Zap.UnexpectedDelta.selector);
        zap.buy{value: 1 ether}(0, NO_DEADLINE);
    }

    /// @dev A manager that reports using more ETH than the swap was told to sell. Zap holds stray
    /// ETH that could cover the difference; it is not the caller's to spend, and the call reverts.
    function test_swap_revertsWhenTheManagerUsesMoreEthThanItWasOffered() public {
        vm.deal(address(zap), 1 ether);
        pool.setOverspendBy(1);
        vm.prank(user);
        vm.expectRevert(Zap.UnexpectedDelta.selector);
        zap.buy{value: 1 ether}(0, NO_DEADLINE);
        assertEq(address(zap).balance, 1 ether);
        assertEq(user.balance, 100 ether);
    }

    /// @dev A Zap built for a different token asks the manager for a pool it does not have.
    function test_swap_usesItsOwnPoolKey() public {
        MockIMD other = new MockIMD();
        Zap wrong = new Zap(address(other), address(pool), address(pots), address(questions));
        vm.prank(user);
        vm.expectRevert(MockPoolManager.PoolNotInitialized.selector);
        wrong.buy{value: 1 ether}(0, NO_DEADLINE);
    }

    // ---- reentrancy ----

    function test_reentrancy_aCallerCannotStartASecondZapFromItsRefund() public {
        Reenterer caller = new Reenterer(zap);
        pool.setMaxEthFill(0.25 ether);
        vm.prank(user);
        caller.buy{value: 1 ether}(0);

        assertFalse(caller.innerSucceeded());
        assertEq(caller.innerError(), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        assertEq(imd.balanceOf(address(caller)), 75e18);
        assertEq(address(caller).balance, 0.75 ether);
        _assertZapHoldsNothing();
    }

    // ---- fuzz ----

    /// @dev Any amount, price, pool depth, pot size and stray balance: Zap ends with nothing, the
    /// caller pays exactly what the pool used, and every wei of IMD bought is in the pot or with
    /// the caller.
    function testFuzz_chipIn_conservesEverything(
        uint256 ethIn,
        uint256 rate,
        uint256 fill,
        uint256 potNeeds,
        uint256 strayImd,
        uint256 strayEth
    ) public {
        ethIn = bound(ethIn, 1, 50 ether);
        rate = bound(rate, 1e15, 100_000e18);
        fill = bound(fill, 0, 60 ether);
        potNeeds = bound(potNeeds, 0, 1_000_000e18);
        strayImd = bound(strayImd, 0, 10e18);
        strayEth = bound(strayEth, 0, 1 ether);

        pool.setRate(rate);
        pool.setMaxEthFill(fill);
        uint256 potId = pots.open(potNeeds);
        imd.mint(address(zap), strayImd);
        vm.deal(address(zap), strayEth);

        uint256 spent = ethIn < fill ? ethIn : fill;
        uint256 out = spent * rate / 1e18;
        // The pot takes from everything Zap approved, which is the swap's output only.
        uint256 chip = out < potNeeds ? out : potNeeds;

        vm.prank(user);
        if (out == 0) {
            vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, 0, 0));
            zap.chipIn{value: ethIn}(potId, 0, NO_DEADLINE);
            return;
        }
        if (chip == 0) {
            vm.expectRevert(Zap.NothingChipped.selector);
            zap.chipIn{value: ethIn}(potId, 0, NO_DEADLINE);
            return;
        }
        (uint256 imdOut, uint256 chipped) = zap.chipIn{value: ethIn}(potId, out, NO_DEADLINE);

        assertEq(imdOut, out);
        assertEq(chipped, chip);
        assertEq(pots.chipOf(potId, user), chip);
        assertEq(imd.balanceOf(user), out - chip + strayImd);
        assertEq(user.balance, 100 ether - spent + strayEth);
        assertEq(address(pool).balance, spent);
        _assertZapHoldsNothing();
    }

    /// @dev The same for a meter: any amount, price, pool depth, earlier spending and stray balance.
    /// Every wei of IMD bought is on the meter, the caller holds the shares the meter credited, and
    /// Zap ends with nothing.
    function testFuzz_fundMeter_conservesEverything(
        uint256 ethIn,
        uint256 rate,
        uint256 fill,
        uint256 spentBefore,
        uint256 strayImd,
        uint256 strayEth
    ) public {
        ethIn = bound(ethIn, 1, 50 ether);
        rate = bound(rate, 1e15, 100_000e18);
        fill = bound(fill, 0, 60 ether);
        strayImd = bound(strayImd, 0, 10e18);
        strayEth = bound(strayEth, 0, 1 ether);

        // An earlier funder, and a meter that has spent some of it: shares are no longer one per wei.
        address earlier = makeAddr("earlier funder");
        vm.deal(earlier, 1 ether);
        vm.prank(earlier);
        zap.fundMeter{value: 0.01 ether}(FEED_ID, 0, NO_DEADLINE);
        spentBefore = bound(spentBefore, 0, 3e18 - 1);
        questions.spend(FEED_ID, spentBefore);
        uint256 poolEthBefore = address(pool).balance;

        pool.setRate(rate);
        pool.setMaxEthFill(fill);
        imd.mint(address(zap), strayImd);
        vm.deal(address(zap), strayEth);

        uint256 spent = ethIn < fill ? ethIn : fill;
        uint256 out = spent * rate / 1e18;
        uint256 expectedShares = out * 3e18 / (3e18 - spentBefore);

        vm.prank(user);
        if (out == 0) {
            vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, 0, 0));
            zap.fundMeter{value: ethIn}(FEED_ID, 0, NO_DEADLINE);
            return;
        }
        (uint256 imdOut, uint256 shares) = zap.fundMeter{value: ethIn}(FEED_ID, out, NO_DEADLINE);

        assertEq(imdOut, out);
        assertEq(shares, expectedShares);
        assertEq(questions.sharesOf(FEED_ID, user), expectedShares);
        assertEq(questions.sharesOf(FEED_ID, address(zap)), 0);
        assertEq(questions.meterBalance(FEED_ID), 3e18 - spentBefore + out);
        assertEq(imd.balanceOf(user), strayImd, "only what was pushed into Zap from outside reaches the caller");
        assertEq(user.balance, 100 ether - spent + strayEth);
        assertEq(address(pool).balance - poolEthBefore, spent);
        _assertZapHoldsNothing();
    }

    function testFuzz_buy_minimumOut(uint256 ethIn, uint256 rate, uint256 minOut) public {
        ethIn = bound(ethIn, 1, 50 ether);
        rate = bound(rate, 1e15, 100_000e18);
        pool.setRate(rate);
        uint256 out = ethIn * rate / 1e18;
        minOut = bound(minOut, 0, 2 * out + 1);

        vm.prank(user);
        if (out == 0 || out < minOut) {
            vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, out, minOut));
            zap.buy{value: ethIn}(minOut, NO_DEADLINE);
            assertEq(user.balance, 100 ether);
        } else {
            assertEq(zap.buy{value: ethIn}(minOut, NO_DEADLINE), out);
            assertEq(imd.balanceOf(user), out);
            assertEq(user.balance, 100 ether - ethIn);
        }
        _assertZapHoldsNothing();
    }

    function test_gas() public {
        uint256 potId = pots.open(1_000e18);
        vm.prank(user);
        uint256 g = gasleft();
        zap.chipIn{value: 0.01 ether}(potId, 0, NO_DEADLINE);
        emit log_named_uint("gas: chipIn (mock pool, mock pots)", g - gasleft());
        vm.prank(user);
        g = gasleft();
        zap.fundMeter{value: 0.01 ether}(FEED_ID, 0, NO_DEADLINE);
        emit log_named_uint("gas: fundMeter (mock pool, mock questions)", g - gasleft());
        vm.prank(user);
        g = gasleft();
        zap.buy{value: 0.01 ether}(0, NO_DEADLINE);
        emit log_named_uint("gas: buy (mock pool)", g - gasleft());
    }
}
