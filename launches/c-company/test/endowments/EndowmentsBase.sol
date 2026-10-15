// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Endowments} from "../../src/endowments/Endowments.sol";
import {MockCrowdPots} from "./mocks/MockCrowdPots.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockQuestions} from "./mocks/MockQuestions.sol";
import {MockStakedIMD} from "./mocks/MockStakedIMD.sol";

/// @dev Shared setup: a mock IMD, a mock sIMD put in the state the real sIMD was in at mainnet block
/// 26,164,296 (see `test/fixtures/endowments/simd-block-26164296.json`), mock targets, and one endowment
/// of each kind.
///
/// The project compiles with `via_ir`, where the optimizer may treat `block.number` as a constant inside
/// one test function. Test code therefore always reads the block through `vm.getBlockNumber()`.
abstract contract EndowmentsBase is Test {
    uint256 internal constant REAL_TOTAL_ASSETS = 1824332924627773926954268;
    uint256 internal constant REAL_TOTAL_SUPPLY = 229085987734110772074526144065;

    bytes32 internal constant FEED = keccak256("robot-jobs-report");
    uint256 internal constant POT = 7;
    uint256 internal constant POT_NEEDS = 1_000e18;
    uint256 internal constant WALLET = 10_000_000e18;

    MockIMD internal imd;
    MockStakedIMD internal simd;
    MockQuestions internal questions;
    MockCrowdPots internal pots;
    Endowments internal endow;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal keeper = makeAddr("keeper");
    address internal recipient = makeAddr("recipient");
    address internal heir = makeAddr("heir");
    address internal whale = makeAddr("whale");
    address internal stranger = makeAddr("stranger");

    uint256 internal meterId;
    uint256 internal potId;
    uint256 internal recipientId;

    uint256 internal seed;
    uint256 internal margin;
    uint256 internal spare;
    uint256 internal interval;

    function setUp() public virtual {
        vm.roll(20_000_000);

        imd = new MockIMD();
        simd = new MockStakedIMD(address(imd));
        simd.seed(whale, REAL_TOTAL_SUPPLY);
        imd.mint(address(simd), REAL_TOTAL_ASSETS);

        questions = new MockQuestions(address(imd));
        questions.addFeed(FEED);
        pots = new MockCrowdPots(address(imd));
        pots.open(POT, POT_NEEDS);

        endow = new Endowments(address(imd), address(simd), address(questions), address(pots));
        seed = endow.SEED();
        margin = endow.MARGIN();
        spare = endow.SPARE();
        interval = endow.STAKE_INTERVAL();

        address[5] memory wallets = [creator, alice, bob, carol, stranger];
        for (uint256 i = 0; i < wallets.length; ++i) {
            imd.mint(wallets[i], WALLET);
            vm.prank(wallets[i]);
            imd.approve(address(endow), type(uint256).max);
        }

        vm.startPrank(creator);
        meterId = endow.createForMeter(FEED);
        potId = endow.createForPot(POT, heir);
        recipientId = endow.createForRecipient(recipient);
        vm.stopPrank();

        _roll(1);
    }

    // ------------------------------------------------------------------------------------ actions

    function _roll(uint256 blocks) internal {
        vm.roll(vm.getBlockNumber() + blocks);
    }

    function _deposit(address who, uint256 id, uint256 amount) internal {
        vm.prank(who);
        endow.deposit(id, amount);
    }

    function _withdraw(address who, uint256 id, uint256 amount) internal {
        vm.prank(who);
        endow.withdraw(id, amount);
    }

    /// @dev Moves to the first block in which `stake` is allowed (if not there yet) and stakes.
    function _stake() internal {
        uint256 next = endow.nextStakeBlock();
        if (vm.getBlockNumber() < next) vm.roll(next);
        vm.prank(keeper);
        endow.stake();
    }

    /// @dev Stakes and steps one block on, so the hold of the stake block is over.
    function _stakeAndWait() internal {
        _stake();
        _roll(1);
    }

    /// @dev Yield the way sIMD really receives it: IMD sent to the vault by plain transfer.
    function _yield(uint256 amount) internal {
        imd.mint(address(simd), amount);
    }

    function _yieldBps(uint256 bps) internal {
        _yield(simd.totalAssets() * bps / 10_000);
    }

    function _loseBps(uint256 bps) internal {
        simd.lose(simd.totalAssets() * bps / 10_000);
    }

    /// @dev Someone else mints sIMD and sends one share-wei to the endowments contract, which carries
    /// the one-block hold over to it.
    function _strangerCausesHold() internal {
        vm.startPrank(stranger);
        imd.approve(address(simd), 1e18);
        simd.deposit(1e18, stranger);
        simd.transfer(address(endow), 1);
        vm.stopPrank();
    }

    /// @dev The cheapest way to cause the same hold: one IMD-wei deposited into sIMD with the endowments
    /// contract named as the receiver of the shares.
    function _strangerDepositsInOurName() internal {
        vm.startPrank(stranger);
        imd.approve(address(simd), 1);
        simd.deposit(1, address(endow));
        vm.stopPrank();
    }

    /// @dev For use after a fall in the share price that left `id` short. Sends the vault the least IMD
    /// that brings `id` back to holding exactly `target` share-wei more than its staked principal needs,
    /// and checks that it landed there.
    ///
    /// previewWithdraw(staked) = ceil(staked * (supply + 1e6) / (assets + 1)) <= shares - target
    ///   <=>  assets + 1 >= ceil(staked * (supply + 1e6) / (shares - target))
    ///
    /// With a few IMD of principal one IMD-wei of yield moves the need by less than one share-wei, so the
    /// least such amount lands exactly on the target.
    function _recoverToSpare(uint256 id, uint256 target) internal {
        (,,, uint256 principal, uint256 buffered, uint256 shares,) = endow.endowment(id);
        uint256 staked = principal - buffered;
        uint256 assetsPlusOne = Math.mulDiv(staked, simd.totalSupply() + 1e6, shares - target, Math.Rounding.Ceil);
        uint256 have = simd.totalAssets() + 1;
        assertGt(assetsPlusOne, have, "setup: the endowment already has more than the wanted spare");
        _yield(assetsPlusOne - have);
        assertEq(_cushion(id), int256(target), "setup: the spare is not where the test wants it");
    }

    // ------------------------------------------------------------------------------------ readers

    function _principal(uint256 id) internal view returns (uint256 principal) {
        (,,, principal,,,) = endow.endowment(id);
    }

    function _buffered(uint256 id) internal view returns (uint256 buffered) {
        (,,,, buffered,,) = endow.endowment(id);
    }

    function _shares(uint256 id) internal view returns (uint256 shares) {
        (,,,,, shares,) = endow.endowment(id);
    }

    function _harvested(uint256 id) internal view returns (uint256 harvested) {
        (,,,,,, harvested) = endow.endowment(id);
    }

    /// @dev Shares the endowment holds beyond what its staked principal needs. Negative when it is short.
    function _cushion(uint256 id) internal view returns (int256) {
        (,,, uint256 principal, uint256 buffered, uint256 shares,) = endow.endowment(id);
        uint256 need = principal > buffered ? simd.previewWithdraw(principal - buffered) : 0;
        return int256(shares) - int256(need);
    }

    /// @dev The first rule: what the shares convert to, plus buffered IMD, covers the principal.
    function _assertCovered(uint256 id) internal view {
        (,,, uint256 principal, uint256 buffered, uint256 shares,) = endow.endowment(id);
        assertGe(simd.convertToAssets(shares) + buffered, principal, "holdings below principal");
        assertTrue(endow.isWhole(id), "not whole");
    }
}
