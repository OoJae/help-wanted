// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Endowments} from "../../src/endowments/Endowments.sol";
import {EndowmentsBase} from "./EndowmentsBase.sol";
import {MockCrowdPots} from "./mocks/MockCrowdPots.sol";

/// @dev The constructor and the three ways to create an endowment.
contract EndowmentsCreateTest is EndowmentsBase {
    function test_constructor_storesTheFourAddresses() public view {
        assertEq(address(endow.IMD()), address(imd));
        assertEq(address(endow.SIMD()), address(simd));
        assertEq(address(endow.QUESTIONS()), address(questions));
        assertEq(address(endow.CROWD_POTS()), address(pots));
        assertEq(endow.epoch(), 1);
        assertEq(endow.lastStakeBlock(), 0);
        assertEq(endow.priceMark(), 0);
    }

    function test_constructor_constants() public view {
        assertEq(endow.STAKE_INTERVAL(), 50);
        assertEq(endow.SEED(), 1e12);
        assertEq(endow.MARGIN(), 1e12);
        assertEq(endow.SPARE(), 5e11);
        assertEq(endow.MIN_HARVEST(), 1e15);
        assertEq(endow.POT_CALL_GAS(), 500_000);
        assertEq(endow.POT_VIEW_GAS(), 50_000);
        assertEq(endow.PRICE_UNIT(), 1e24);
        // One whole sIMD: the price mark is read in the vault's own unit.
        assertEq(endow.PRICE_UNIT(), 10 ** simd.decimals());
    }

    function test_constructor_revertsOnAnyZeroAddress() public {
        address a = address(0xA11CE);
        vm.expectRevert(Endowments.ZeroAddress.selector);
        new Endowments(address(0), a, a, a);
        vm.expectRevert(Endowments.ZeroAddress.selector);
        new Endowments(a, address(0), a, a);
        vm.expectRevert(Endowments.ZeroAddress.selector);
        new Endowments(a, a, address(0), a);
        vm.expectRevert(Endowments.ZeroAddress.selector);
        new Endowments(a, a, a, address(0));
    }

    /// @dev The launch pipeline runs constructors on an empty chain: none of the four addresses has code
    /// there, and the constructor must not care.
    function test_constructor_makesNoCallAndNeedsNoCodeAtItsArguments() public {
        address imdLike = address(0x1001);
        address simdLike = address(0x1002);
        address questionsLike = address(0x1003);
        address potsLike = address(0x1004);
        assertEq(imdLike.code.length + simdLike.code.length + questionsLike.code.length + potsLike.code.length, 0);

        vm.expectCall(imdLike, bytes(""), 0);
        vm.expectCall(simdLike, bytes(""), 0);
        vm.expectCall(questionsLike, bytes(""), 0);
        vm.expectCall(potsLike, bytes(""), 0);
        Endowments fresh = new Endowments(imdLike, simdLike, questionsLike, potsLike);
        assertEq(address(fresh.SIMD()), simdLike);
        assertEq(fresh.endowmentCount(), 0);
        assertEq(fresh.pendingTotal(), 0);
        assertEq(fresh.epoch(), 1);
    }

    /// @dev The launch pipeline creates each contract with CREATE2 from its initcode followed by its
    /// static argument words, on a chain where none of the arguments has code, and sends no ETH. Our own
    /// gates are 23,000 bytes of runtime code and 46,000 bytes of initcode.
    function test_launch_create2FromInitcode_staysInsideOurGates() public {
        bytes memory initcode = abi.encodePacked(
            type(Endowments).creationCode,
            abi.encode(address(0x1001), address(0x1002), address(0x1003), address(0x1004))
        );
        assertLe(initcode.length, 46_000, "initcode over our gate");

        // The constructor is not payable: a creation that carries ETH fails.
        vm.deal(address(this), 1 ether);
        address withValue;
        assembly {
            withValue := create2(1, add(initcode, 0x20), mload(initcode), 0x48454c50)
        }
        assertEq(withValue, address(0));

        address deployed;
        uint256 gasBefore = gasleft();
        assembly {
            deployed := create2(0, add(initcode, 0x20), mload(initcode), 0x48454c50)
        }
        uint256 used = gasBefore - gasleft();
        assertTrue(deployed != address(0), "creation reverted");
        assertGt(deployed.code.length, 0);
        assertLe(deployed.code.length, 23_000, "runtime code over our gate");
        // Creation and code deposit, without the transaction's own calldata. The whole launch has 12M.
        assertLt(used, 3_500_000);
        emit log_named_uint("create2 gas", used);
        emit log_named_uint("runtime bytes", deployed.code.length);
        emit log_named_uint("initcode bytes with the four argument words", initcode.length);

        Endowments created = Endowments(deployed);
        assertEq(address(created.IMD()), address(0x1001));
        assertEq(address(created.CROWD_POTS()), address(0x1004));
        assertEq(created.epoch(), 1);
    }

    function test_setUp_createdOneEndowmentOfEachKind() public view {
        assertEq(endow.endowmentCount(), 3);
        assertEq(meterId, 1);
        assertEq(potId, 2);
        assertEq(recipientId, 3);
        // Three seeds are waiting in the buffer and are nobody's principal.
        assertEq(endow.pendingTotal(), 3 * seed);
        assertEq(imd.balanceOf(address(endow)), 3 * seed);
        assertEq(imd.balanceOf(creator), WALLET - 3 * seed);
        assertEq(_principal(meterId) + _principal(potId) + _principal(recipientId), 0);
    }

    // ------------------------------------------------------------------------------------ meter

    function test_createForMeter_recordsTheFeed() public {
        bytes32 feed = keccak256("another-feed");
        questions.addFeed(feed);
        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Created(4, Endowments.Kind.Meter, feed, address(0), alice);
        vm.prank(alice);
        uint256 id = endow.createForMeter(feed);
        assertEq(id, 4);

        (
            Endowments.Kind kind,
            bytes32 target,
            address beneficiary,
            uint256 principal,
            uint256 buffered,
            uint256 shares,
            uint256 harvested
        ) = endow.endowment(id);
        assertEq(uint8(kind), uint8(Endowments.Kind.Meter));
        assertEq(target, feed);
        assertEq(beneficiary, address(0));
        assertEq(principal, 0);
        assertEq(buffered, seed);
        assertEq(shares, 0);
        assertEq(harvested, 0);
        assertEq(imd.balanceOf(alice), WALLET - seed);
        assertEq(endow.principalOf(id, alice), 0);
    }

    function test_createForMeter_revertsOnZeroFeed() public {
        vm.prank(alice);
        vm.expectRevert(Endowments.BadTarget.selector);
        endow.createForMeter(bytes32(0));
    }

    /// @dev A feed id is a hash of the feed's content, so an id that is one character off can never
    /// become a feed. Its endowment's yield would have nowhere to go, ever: it is refused at the door.
    function test_createForMeter_revertsForAnIdThatIsNotAFeed() public {
        bytes32 mistyped = bytes32(uint256(FEED) ^ 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.FeedNotLive.selector, mistyped));
        endow.createForMeter(mistyped);
        assertEq(endow.endowmentCount(), 3);
        assertEq(imd.balanceOf(alice), WALLET);
    }

    /// @dev `costOf` is also zero while the Intake is not selling the feed's action. No request can be
    /// bought then, so the endowment waits until one can.
    function test_createForMeter_revertsWhileTheFeedCannotBeAsked_andWorksOnceItCan() public {
        questions.setCost(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.FeedNotLive.selector, FEED));
        endow.createForMeter(FEED);

        questions.setCost(0.5e18);
        vm.prank(alice);
        assertEq(endow.createForMeter(FEED), 4);
    }

    function test_createForMeter_revertsIfQuestionsHasNoCode() public {
        Endowments lonely = new Endowments(address(imd), address(simd), address(0xDEAD01), address(pots));
        vm.startPrank(alice);
        imd.approve(address(lonely), type(uint256).max);
        vm.expectRevert();
        lonely.createForMeter(FEED);
        vm.stopPrank();
        assertEq(lonely.endowmentCount(), 0);
    }

    // ------------------------------------------------------------------------------------ pot

    function test_createForPot_recordsThePotAndTheFallback() public {
        pots.open(99, 5e18);
        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Created(4, Endowments.Kind.Pot, bytes32(uint256(99)), carol, alice);
        vm.prank(alice);
        uint256 id = endow.createForPot(99, carol);

        (Endowments.Kind kind, bytes32 target, address beneficiary,,,,) = endow.endowment(id);
        assertEq(uint8(kind), uint8(Endowments.Kind.Pot));
        assertEq(uint256(target), 99);
        assertEq(beneficiary, carol);
    }

    function test_createForPot_acceptsASeries() public {
        pots.openSeries(8, 10e18);
        vm.prank(alice);
        uint256 id = endow.createForPot(8, carol);
        (, bytes32 target,,,,,) = endow.endowment(id);
        assertEq(uint256(target), 8);
    }

    /// @dev Pot ids are handed out in order. If an endowment could name a pot that is not open yet,
    /// anyone could open the pot that takes that id, with their own job, and collect its yield.
    function test_createForPot_revertsForAPotThatDoesNotExistYet() public {
        assertEq(pots.potCount(), POT);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endowments.UnknownPot.selector, 0));
        endow.createForPot(0, carol);
        vm.expectRevert(abi.encodeWithSelector(Endowments.UnknownPot.selector, POT + 1));
        endow.createForPot(POT + 1, carol);
        vm.stopPrank();
        assertEq(endow.endowmentCount(), 3);

        // The newest pot is fine, and so is the one after it once it has been opened.
        vm.prank(alice);
        endow.createForPot(POT, carol);
        pots.open(POT + 1, 1e18);
        vm.prank(alice);
        endow.createForPot(POT + 1, carol);
    }

    function test_createForPot_revertsIfCrowdPotsHasNoCode() public {
        Endowments lonely = new Endowments(address(imd), address(simd), address(questions), address(0xDEAD02));
        vm.startPrank(alice);
        imd.approve(address(lonely), type(uint256).max);
        vm.expectRevert();
        lonely.createForPot(1, heir);
        vm.stopPrank();
    }

    function test_createForPot_revertsWithoutAUsableFallback() public {
        address[6] memory bad =
            [address(0), address(endow), address(imd), address(simd), address(questions), address(pots)];
        vm.startPrank(alice);
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(Endowments.BadTarget.selector);
            endow.createForPot(POT, bad[i]);
        }
        vm.stopPrank();
        assertEq(endow.endowmentCount(), 3);
    }

    // ------------------------------------------------------------------------------------ recipient

    function test_createForRecipient_recordsTheRecipient() public {
        vm.expectEmit(true, true, true, true, address(endow));
        emit Endowments.Created(4, Endowments.Kind.Recipient, bytes32(0), bob, alice);
        vm.prank(alice);
        uint256 id = endow.createForRecipient(bob);

        (Endowments.Kind kind, bytes32 target, address beneficiary,,,,) = endow.endowment(id);
        assertEq(uint8(kind), uint8(Endowments.Kind.Recipient));
        assertEq(target, bytes32(0));
        assertEq(beneficiary, bob);
    }

    /// @dev Zero, and the places where a plain IMD transfer would belong to nobody or to the wrong people.
    function test_createForRecipient_revertsWhereTheYieldWouldBeStranded() public {
        address[6] memory bad =
            [address(0), address(endow), address(imd), address(simd), address(questions), address(pots)];
        vm.startPrank(alice);
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(Endowments.BadTarget.selector);
            endow.createForRecipient(bad[i]);
        }
        vm.stopPrank();
        assertEq(endow.endowmentCount(), 3);
    }

    /// @dev From the review. A harvest reaches its recipient as one lump. If that recipient were sIMD,
    /// the lump would lift the share price in one step, and someone who staked a block earlier and
    /// called `harvest` themselves would leave with a share of it in proportion to capital held for one
    /// block: about half of a 10,000 IMD harvest in the reviewer's run. sIMD's own guard only covers the
    /// same block. So the vault cannot be named, neither as a recipient nor as a pot's fallback.
    function test_createForRecipient_refusesTheVault_soNoHarvestCanBeCollectedByAOneBlockStaker() public {
        vm.startPrank(creator);
        vm.expectRevert(Endowments.BadTarget.selector);
        endow.createForRecipient(address(simd));
        vm.expectRevert(Endowments.BadTarget.selector);
        endow.createForPot(POT, address(simd));
        vm.stopPrank();

        // No endowment that exists pays the vault, whatever is harvested.
        for (uint256 id = 1; id <= endow.endowmentCount(); ++id) {
            (,, address beneficiary,,,,) = endow.endowment(id);
            assertTrue(beneficiary != address(simd));
        }
    }

    /// @dev Only the addresses this contract knows about are refused. Another contract is accepted as
    /// it is; whoever creates the endowment answers for it.
    function test_createForRecipient_acceptsAnyOtherContract() public {
        MockCrowdPots someContract = new MockCrowdPots(address(imd));
        vm.prank(alice);
        uint256 id = endow.createForRecipient(address(someContract));
        (,, address beneficiary,,,,) = endow.endowment(id);
        assertEq(beneficiary, address(someContract));
    }

    // ------------------------------------------------------------------------------------ the seed

    function test_create_revertsWhenTheSeedCannotBePulled() public {
        address broke = makeAddr("broke");
        vm.startPrank(broke);
        imd.approve(address(endow), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, broke, 0, seed));
        endow.createForRecipient(broke);
        vm.stopPrank();

        address unapproved = makeAddr("unapproved");
        imd.mint(unapproved, 1e18);
        vm.prank(unapproved);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(endow), 0, seed)
        );
        endow.createForRecipient(unapproved);
        assertEq(endow.endowmentCount(), 3);
    }

    function test_create_revertsIfTheTokenKeepsPartOfTheTransfer() public {
        imd.setFee(100);
        vm.prank(alice);
        vm.expectRevert(Endowments.TransferMismatch.selector);
        endow.createForRecipient(alice);
    }

    /// @dev Ids are handed out in order, whoever creates. A client must read its id from `Created`.
    function test_create_idsFollowTheOrderOfCreation() public {
        vm.prank(bob);
        uint256 first = endow.createForRecipient(bob);
        vm.prank(alice);
        uint256 second = endow.createForRecipient(alice);
        assertEq(first, 4);
        assertEq(second, 5);
        (,, address beneficiary,,,,) = endow.endowment(4);
        assertEq(beneficiary, bob);
    }

    function test_endowment_unknownIdReadsAsNone() public view {
        (Endowments.Kind kind, bytes32 target, address beneficiary, uint256 principal, uint256 buffered,,) =
            endow.endowment(404);
        assertEq(uint8(kind), uint8(Endowments.Kind.None));
        assertEq(target, bytes32(0));
        assertEq(beneficiary, address(0));
        assertEq(principal + buffered, 0);
        assertEq(endow.backingOf(404), 0);
        assertEq(endow.harvestable(404), 0);
        (uint256 imdOut, uint256 sharesOut, bool exact) = endow.quote(404, 1, false);
        assertEq(imdOut + sharesOut, 0);
        assertFalse(exact);
    }
}
