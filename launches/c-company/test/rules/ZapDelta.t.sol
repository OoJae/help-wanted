// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Zap} from "../../src/rules/Zap.sol";
import {IPoolManagerLike, IUnlockCallback, PoolKey, SwapParams} from "../../src/rules/v4/IPoolManagerLike.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockPots} from "./mocks/MockPots.sol";
import {MockQuestions} from "./mocks/MockQuestions.sol";

/// @dev A PoolManager that answers a swap with whatever packed delta a test scripted, pays out IMD on
/// `take` and counts ETH on `settle`, and checks nothing else. It exists to drive `unlockCallback`
/// through every corner of the 256-bit word Uniswap packs two 128-bit amounts into.
contract ScriptedPoolManager is IPoolManagerLike {
    MockIMD public immutable IMD;
    int256 public delta;
    address public locker;
    uint256 public ethSettled;

    constructor(MockIMD imd) {
        IMD = imd;
    }

    function script(int128 eth, int128 imd) external {
        // Uniswap v4's `toBalanceDelta`: amount0 in the upper half, amount1 in the lower.
        delta = (int256(eth) << 128) | (int256(imd) & int256(uint256(type(uint128).max)));
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        locker = msg.sender;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        locker = address(0);
    }

    function swap(PoolKey calldata, SwapParams calldata, bytes calldata) external view returns (int256) {
        require(msg.sender == locker, "locked");
        return delta;
    }

    function settle() external payable returns (uint256) {
        require(msg.sender == locker, "locked");
        ethSettled += msg.value;
        return msg.value;
    }

    function take(address currency, address to, uint256 amount) external {
        require(msg.sender == locker, "locked");
        require(currency == address(IMD), "currency");
        IMD.mint(to, amount);
    }
}

/// @dev The decoding of a swap's result. Uniswap v4 returns both amounts in one word, each a signed
/// 128-bit number; a wrong split would read one amount's sign into the other. For every pair of
/// amounts Zap must accept exactly those where it owes ETH (or nothing) and is owed IMD, and never
/// more ETH than the caller sent, and what it then pays the caller must follow from the two halves.
contract ZapDeltaTest is Test {
    MockIMD internal imd;
    ScriptedPoolManager internal pool;
    Zap internal zap;
    address internal user = makeAddr("user");

    function setUp() public {
        imd = new MockIMD();
        pool = new ScriptedPoolManager(imd);
        MockPots pots = new MockPots(address(imd));
        MockQuestions questions = new MockQuestions(address(imd));
        zap = new Zap(address(imd), address(pool), address(pots), address(questions));
        vm.deal(user, type(uint128).max);
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_unlockCallback_acceptsExactlyTheWellSignedDeltasWithinTheEthSent(
        int128 eth,
        int128 imdOut,
        uint128 ethIn
    ) public {
        ethIn = uint128(bound(ethIn, 1, type(uint128).max));
        pool.script(eth, imdOut);

        bool wellSigned = eth <= 0 && imdOut >= 0;
        bool withinEth = wellSigned && uint256(-int256(eth)) <= ethIn;
        bool somethingOut = imdOut > 0;
        bool accepted = withinEth && somethingOut;

        vm.prank(user);
        if (!accepted) {
            if (!withinEth) {
                vm.expectRevert(Zap.UnexpectedDelta.selector);
            } else {
                vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, 0, 0));
            }
            zap.buy{value: ethIn}(0, type(uint256).max);
            assertEq(address(zap).balance, 0);
            assertEq(pool.ethSettled(), 0);
            return;
        }

        uint256 before = user.balance;
        uint256 got = zap.buy{value: ethIn}(0, type(uint256).max);
        uint256 ethSpent = uint256(-int256(eth));
        assertEq(got, uint256(int256(imdOut)), "imd out");
        assertEq(imd.balanceOf(user), got, "imd delivered");
        assertEq(pool.ethSettled(), ethSpent, "eth paid to the pool");
        assertEq(user.balance, before - ethSpent, "eth refunded");
        assertEq(address(zap).balance, 0, "zap kept eth");
        assertEq(imd.balanceOf(address(zap)), 0, "zap kept imd");
    }

    /// @dev The four corners of each half, pinned.
    function test_unlockCallback_theCornersOfThePackedWord() public {
        int128 min = type(int128).min;
        int128 max = type(int128).max;

        // IMD at its largest positive, ETH at its smallest magnitude: accepted.
        pool.script(-1, max);
        vm.prank(user);
        uint256 got = zap.buy{value: 1}(0, type(uint256).max);
        assertEq(got, uint256(int256(max)));

        // ETH at its most negative, 2^127 wei: accepted only when the call sent at least that much.
        pool.script(min, 1);
        vm.deal(user, type(uint128).max);
        uint256 magnitude = uint256(1) << 127;
        vm.prank(user);
        vm.expectRevert(Zap.UnexpectedDelta.selector);
        zap.buy{value: magnitude - 1}(0, type(uint256).max);
        vm.prank(user);
        zap.buy{value: magnitude}(0, type(uint256).max);
        assertEq(pool.ethSettled(), magnitude + 1);

        // IMD at its most negative: the lower half's sign bit must not be read as ETH owed.
        pool.script(0, min);
        vm.prank(user);
        vm.expectRevert(Zap.UnexpectedDelta.selector);
        zap.buy{value: 1}(0, type(uint256).max);

        // ETH positive by one: the pool says it owes Zap ETH, which a sale of ETH never does.
        pool.script(1, 1);
        vm.prank(user);
        vm.expectRevert(Zap.UnexpectedDelta.selector);
        zap.buy{value: 1}(0, type(uint256).max);

        // Nothing either way: a swap that did nothing is too little out.
        pool.script(0, 0);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, 0, 0));
        zap.buy{value: 1}(0, type(uint256).max);
    }

    /// @dev `minImdOut` is checked against the decoded lower half, at the line.
    function testFuzz_buy_minimumIsCheckedAgainstTheDecodedAmount(int128 imdOut, uint256 minOut) public {
        imdOut = int128(bound(imdOut, 1, type(int128).max));
        uint256 out = uint256(int256(imdOut));
        minOut = bound(minOut, out, out + 1);
        pool.script(-1, imdOut);
        vm.prank(user);
        if (minOut > out) vm.expectRevert(abi.encodeWithSelector(Zap.TooLittleOut.selector, out, minOut));
        zap.buy{value: 1}(minOut, type(uint256).max);
    }
}
