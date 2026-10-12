// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {QuestionBody} from "../../src/questions/QuestionBody.sol";
import {Questions} from "../../src/questions/Questions.sol";
import {CanonicalQuestion} from "./lib/CanonicalQuestion.sol";
import {QuestionsFixture} from "./QuestionsFixture.sol";

/// @title The three house feeds of the Robot Jobs Report
/// @notice `test/fixtures/questions/feeds/{payrolls,hires,employers}.json` hold each feed's
/// parameters, question prefix, tail, an example body and its id. They were written by a script
/// with its own ABI encoder and keccak; these tests recompute every derived value with the contract
/// and tie the question text to the canonical form the fixtures test proved against the oracle.
contract HouseFeedsTest is QuestionsFixture {
    string internal constant DIR = "test/fixtures/questions/feeds/";
    address internal constant IMD_MAINNET = 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7;
    address internal constant FEE_PAYEE = 0x4e0fA57Bde726079356537E2F34d671E9F41ADbc;

    struct HouseFeed {
        string json;
        Questions.FeedParams params;
        bytes qPrefix;
        bytes tail;
        bytes32 feedId;
    }

    function setUp() public override {
        super.setUp();
        // The house feeds are about Ethereum mainnet and can only be created there.
        vm.chainId(1);
    }

    function _names() internal pure returns (string[3] memory) {
        return ["payrolls", "hires", "employers"];
    }

    function _load(string memory name) internal view returns (HouseFeed memory h) {
        h.json = vm.readFile(string.concat(DIR, name, ".json"));
        assertEq(vm.parseJsonString(h.json, ".name"), name);
        string memory j = h.json;
        Questions.FeedParams memory p;
        p.action = vm.parseJsonBytes32(j, ".params.action");
        p.chainId = uint64(vm.parseJsonUint(j, ".params.chainId"));
        p.answerType = uint8(vm.parseJsonUint(j, ".params.answerType"));
        p.panelSize = uint16(vm.parseJsonUint(j, ".params.panelSize"));
        p.quorum = uint16(vm.parseJsonUint(j, ".params.quorum"));
        p.minAgreed = uint16(vm.parseJsonUint(j, ".params.minAgreed"));
        p.validFor = uint32(vm.parseJsonUint(j, ".params.validFor"));
        p.cadenceBlocks = uint32(vm.parseJsonUint(j, ".params.cadenceBlocks"));
        p.maxWindowBlocks = uint32(vm.parseJsonUint(j, ".params.maxWindowBlocks"));
        p.lagBlocks = uint16(vm.parseJsonUint(j, ".params.lagBlocks"));
        p.contiguous = vm.parseJsonBool(j, ".params.contiguous");
        p.pinHash = vm.parseJsonBool(j, ".params.pinHash");
        p.maxPrice = uint96(vm.parseJsonUint(j, ".params.maxPrice"));
        p.tip = uint96(vm.parseJsonUint(j, ".params.tip"));
        p.gateCmp = uint8(vm.parseJsonUint(j, ".params.gateCmp"));
        p.gateTarget = vm.parseJsonAddress(j, ".params.gateTarget");
        p.gateThreshold = vm.parseJsonUint(j, ".params.gateThreshold");
        p.gateData = vm.parseJsonBytes(j, ".params.gateData");
        h.params = p;
        h.qPrefix = vm.parseJsonBytes(j, ".qPrefixHex");
        h.tail = vm.parseJsonBytes(j, ".tailHex");
        h.feedId = vm.parseJsonBytes32(j, ".feedId");
    }

    /// @notice Each feedId is recomputed from its parts, by the contract and by hand.
    function test_feedIdsRecomputeFromTheirParts() public view {
        string[3] memory names = _names();
        for (uint256 i; i < names.length; ++i) {
            HouseFeed memory h = _load(names[i]);
            assertEq(q.feedIdOf(h.params, h.qPrefix, h.tail), h.feedId, names[i]);
            assertEq(keccak256(abi.encode(h.params, keccak256(h.qPrefix), keccak256(h.tail))), h.feedId, names[i]);
            // The readable strings in the file are the same bytes as the hex the id is made from.
            assertEq(bytes(vm.parseJsonString(h.json, ".qPrefix")), h.qPrefix, names[i]);
            assertEq(bytes(vm.parseJsonString(h.json, ".tail")), h.tail, names[i]);
        }
    }

    /// @notice The three ids differ, and each feed passes every check `createFeed` makes on mainnet.
    function test_feedsAreAcceptedOnMainnet() public {
        string[3] memory names = _names();
        bytes32[3] memory ids;
        for (uint256 i; i < names.length; ++i) {
            HouseFeed memory h = _load(names[i]);
            assertEq(uint8(q.checkFeed(h.params, h.qPrefix, h.tail)), uint8(Questions.FeedFault.None), names[i]);
            ids[i] = q.createFeed(h.params, h.qPrefix, h.tail);
            assertEq(ids[i], h.feedId, names[i]);
            assertEq(h.params.action, bytes32("oracle.request@oracle-1"));
            assertTrue(h.params.pinHash, "house feeds pin their question");
            assertEq(h.params.minAgreed, h.params.quorum, "house feeds take only the panel's own agreement");
            assertEq(h.params.gateTarget, address(0));
        }
        assertTrue(ids[0] != ids[1] && ids[1] != ids[2] && ids[0] != ids[2]);
        assertEq(q.feedCount(), 3);
    }

    /// @notice They cannot be created on another chain: the windows would be counted in the wrong blocks.
    function test_feedsAreRefusedOffMainnet() public {
        vm.chainId(4663);
        HouseFeed memory h = _load("payrolls");
        vm.expectRevert(abi.encodeWithSelector(Questions.BadFeed.selector, Questions.FeedFault.Chain));
        q.createFeed(h.params, h.qPrefix, h.tail);
    }

    /// @notice The example body in each file is what the contract sends for the example window,
    /// byte for byte, and the example hash is what an answer to it must carry.
    function test_exampleBodiesAreWhatTheContractSends() public {
        string[3] memory names = _names();
        for (uint256 i; i < names.length; ++i) {
            HouseFeed memory h = _load(names[i]);
            uint64 fromBlock = uint64(vm.parseJsonUint(h.json, ".example.fromBlock"));
            uint64 toBlock = uint64(vm.parseJsonUint(h.json, ".example.toBlock"));
            bytes memory example = vm.parseJsonBytes(h.json, ".example.bodyHex");
            bytes32 exampleHash = vm.parseJsonBytes32(h.json, ".example.questionHash");
            assertEq(bytes(vm.parseJsonString(h.json, ".example.body")), example, names[i]);
            assertEq(QuestionBody.body(h.qPrefix, h.tail, fromBlock, toBlock), example, names[i]);
            assertEq(QuestionBody.questionHash(h.qPrefix, fromBlock, toBlock), exampleHash, names[i]);

            // And through the contract: created, funded and requested in the example's block.
            bytes32 feedId = q.createFeed(h.params, h.qPrefix, h.tail);
            vm.roll(vm.parseJsonUint(h.json, ".example.requestBlock"));
            (bytes memory next, bytes32 nextHash, uint64 nextFrom, uint64 nextTo) = q.nextBody(feedId);
            assertEq(next, example, names[i]);
            assertEq(nextHash, exampleHash, names[i]);
            assertEq(nextFrom, fromBlock, names[i]);
            assertEq(nextTo, toBlock, names[i]);
            _fund(alice, feedId, 10e18);
            _request(feedId);
            assertEq(intake.lastBody(), example, names[i]);
            (, bytes32 pinned,,) = q.roundRequest(feedId, 1);
            assertEq(pinned, exampleHash, names[i]);
        }
    }

    /// @notice Each prefix is the canonical document of its own example body: reading the body back
    /// as JSON and writing it by the rule the fixtures test proved gives the stored prefix. So the
    /// hash the contract pins is the hash the oracle will compute for the body it receives.
    function test_prefixesAreTheCanonicalFormOfTheBody() public view {
        string[3] memory names = _names();
        for (uint256 i; i < names.length; ++i) {
            HouseFeed memory h = _load(names[i]);
            string memory body = vm.parseJsonString(h.json, ".example.body");
            assertEq(CanonicalQuestion.prefix(body), h.qPrefix, names[i]);
            // The fields the hash does not cover are in the tail, as the contract's checks read them.
            assertEq(vm.parseJsonUint(body, ".panelSize"), h.params.panelSize);
            assertEq(vm.parseJsonUint(body, ".quorum"), h.params.quorum);
            assertEq(vm.parseJsonUint(body, ".validForSeconds"), h.params.validFor);
            assertEq(vm.parseJsonString(body, ".evidence"), "chain");
            assertEq(vm.parseJsonUint(body, ".v"), 1);
            assertEq(vm.parseJsonUint(body, ".chainId"), 1);
        }
    }

    /// @notice What each feed asks, read back from its own text: the IMD token's Transfer events
    /// to the fee payee, summed, counted and ranked by sender.
    function test_recipesNameTheTokenAndThePayee() public view {
        string[3] memory names = _names();
        string[3] memory kinds = ["log-sum", "log-count", "log-rank"];
        for (uint256 i; i < names.length; ++i) {
            HouseFeed memory h = _load(names[i]);
            string memory body = vm.parseJsonString(h.json, ".example.body");
            string memory pinned = vm.parseJsonString(body, ".definitions.recipe");
            // The definition is the recipe as JSON followed by one sentence; cut the sentence off.
            bytes memory text = bytes(pinned);
            bytes memory sentence = " - write recipe exactly this, event text included.";
            assertGt(text.length, sentence.length);
            string memory recipe = string(CanonicalQuestion.slice(text, 0, text.length - sentence.length));
            assertEq(CanonicalQuestion.slice(text, text.length - sentence.length, text.length), sentence, names[i]);
            assertEq(vm.parseJsonString(recipe, ".kind"), kinds[i]);
            assertEq(vm.parseJsonAddress(recipe, ".address"), IMD_MAINNET);
            assertEq(vm.parseJsonAddress(recipe, ".filter.to"), FEE_PAYEE);
            assertEq(
                vm.parseJsonString(recipe, ".event"),
                "event Transfer(address indexed from, address indexed to, uint256 value)"
            );
        }
        HouseFeed memory employers = _load("employers");
        string memory ranked = vm.parseJsonString(employers.json, ".example.body");
        assertEq(vm.parseJsonString(ranked, ".answerType"), "address[]");
        assertEq(vm.parseJsonUint(ranked, ".head"), 3);
        assertFalse(employers.params.contiguous, "a ranking is of a period, not a running total");
        assertTrue(_load("payrolls").params.contiguous);
        assertTrue(_load("hires").params.contiguous);
    }

    /// @notice The hires feed counts every Transfer log to the fee payee, zero-value ones included,
    /// because no recipe can leave them out: its recipe has no condition on `value` (a log-count
    /// filter reaches indexed arguments only). The feed's own documentation has to say so, in its
    /// title and in its limits, so that nobody reads the figure as a count of paid actions and so
    /// that an unofficial tally counts the same way.
    function test_hiresSaysItCountsZeroValueTransfers() public view {
        HouseFeed memory hires = _load("hires");
        string memory body = vm.parseJsonString(hires.json, ".example.body");
        string memory pinned = vm.parseJsonString(body, ".definitions.recipe");
        assertTrue(vm.contains(pinned, '"kind":"log-count"'));
        assertTrue(vm.contains(pinned, '"filter":{"to":"0x4e0fa57bde726079356537e2f34d671e9f41adbc"}'));
        assertFalse(vm.contains(pinned, "value\":"), "the recipe has a condition on value: update the feed's limits");
        assertFalse(vm.contains(pinned, "sumArg"));

        assertTrue(vm.contains(vm.parseJsonString(hires.json, ".title"), "zero-value"), "the title does not say");
        assertFalse(vm.contains(vm.parseJsonString(hires.json, ".title"), "paid actions"));
        assertTrue(vm.contains(vm.parseJsonString(hires.json, ".notes.what"), "zero-value"));
        string[] memory limits = vm.parseJsonStringArray(hires.json, ".notes.limits");
        assertGe(limits.length, 2);
        assertTrue(vm.contains(limits[0], "zero-value transfers are counted"), "the limits do not say");
        assertTrue(vm.contains(limits[1], "must count the same way"));

        // Every feed states its limits, and each says that the feeds' own purchases are counted.
        string[3] memory names = _names();
        for (uint256 i; i < names.length; ++i) {
            limits = vm.parseJsonStringArray(_load(names[i]).json, ".notes.limits");
            bool saysOwnPurchases;
            for (uint256 k; k < limits.length; ++k) {
                if (vm.contains(limits[k], "the feeds' own purchases are included")) saysOwnPurchases = true;
            }
            assertTrue(saysOwnPurchases, names[i]);
        }
    }
}
