// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Rules} from "../../src/rules/Rules.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {MockIMD} from "./mocks/MockIMD.sol";
import {MockDesk} from "./mocks/MockDesk.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {Gauge, Puppet} from "./mocks/Targets.sol";

/// @dev Shared setup and rule builders for the Rules tests.
abstract contract RulesBase is Test {
    MockIMD internal imd;
    MockDesk internal desk;
    MockFeed internal feed;
    Gauge internal gauge;
    Puppet internal puppet;
    Rules internal rules;

    address internal creator = makeAddr("creator");
    address internal keeper = makeAddr("keeper");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");

    bytes internal constant SPEC =
        "Audit the vault at 0x00000000000000000000000000000000000000aa and list every finding. Inputs: repoUrl=https://example.org/vault; baseCommit=0123abcd";
    bytes32 internal constant FEED_ID = keccak256("feed:robot-payrolls");
    bytes32 internal constant KIND_AUDIT = keccak256("audit");

    uint96 internal constant TIP = 0.05e18;
    uint96 internal constant PAY_AMOUNT = 2e18;
    uint96 internal constant MAX_PAY = 10e18;

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        imd = new MockIMD();
        desk = new MockDesk(address(imd));
        feed = new MockFeed();
        gauge = new Gauge();
        puppet = new Puppet();
        rules = new Rules(address(imd), address(desk));

        imd.mint(creator, 1_000_000e18);
        imd.mint(stranger, 1_000_000e18);
        vm.prank(creator);
        imd.approve(address(rules), type(uint256).max);
        vm.prank(stranger);
        imd.approve(address(rules), type(uint256).max);
    }

    // ---- builders ----

    /// @dev WHEN gauge.value() <cmp> threshold
    function _viewCond(uint8 cmp, uint256 threshold) internal view returns (Rules.Condition memory c) {
        c.kind = 1;
        c.cmp = cmp;
        c.target = address(gauge);
        c.threshold = threshold;
        c.data = abi.encodeCall(gauge.value, ());
    }

    /// @dev WHEN target.call(data) <cmp> threshold
    function _rawCond(address target, bytes memory data, uint8 cmp, uint256 threshold)
        internal
        pure
        returns (Rules.Condition memory c)
    {
        c.kind = 1;
        c.cmp = cmp;
        c.target = target;
        c.threshold = threshold;
        c.data = data;
    }

    /// @dev WHEN the feed's newest answer <cmp> threshold, no older than maxAge
    function _feedCond(uint8 cmp, uint256 threshold, uint32 maxAge) internal view returns (Rules.Condition memory c) {
        c.kind = 2;
        c.cmp = cmp;
        c.target = address(feed);
        c.threshold = threshold;
        c.feedId = FEED_ID;
        c.maxAge = maxAge;
    }

    function _hire() internal pure returns (Rules.Hire memory h) {
        h.kindHash = KIND_AUDIT;
        h.minPay = 4e18;
        h.maxPay = MAX_PAY;
        h.rampSecs = 1 hours;
        h.deliverySecs = 7 days;
        h.bond = 0.5e18;
        h.runnerOnly = address(0);
        h.arbiter = address(0);
        h.flags = 0;
        h.orderTtl = 14 days;
    }

    function _payParams(Rules.Condition memory c, uint32 cooldown, uint32 maxFires)
        internal
        view
        returns (Rules.RuleParams memory p)
    {
        p.when = c;
        p.action = 2;
        p.pay = Rules.Pay({recipient: payee, amount: PAY_AMOUNT});
        p.tip = TIP;
        p.cooldown = cooldown;
        p.maxFires = maxFires;
    }

    function _hireParams(Rules.Condition memory c, uint32 cooldown, uint32 maxFires)
        internal
        pure
        returns (Rules.RuleParams memory p)
    {
        p.when = c;
        p.action = 1;
        p.hire = _hire();
        p.tip = TIP;
        p.cooldown = cooldown;
        p.maxFires = maxFires;
    }

    // ---- shortcuts ----

    /// @dev WHEN gauge.value() >= 100 THEN PAY 2 IMD to `payee`, tip 0.05, funded with `deposit`.
    function _createPayRule(uint32 cooldown, uint32 maxFires, uint96 deposit) internal returns (uint256 id) {
        vm.prank(creator);
        id = rules.createRule(_payParams(_viewCond(1, 100), cooldown, maxFires), "", deposit);
    }

    /// @dev WHEN gauge.value() >= 100 THEN HIRE an audit for up to 10 IMD, tip 0.05.
    function _createHireRule(uint32 cooldown, uint32 maxFires, uint96 deposit) internal returns (uint256 id) {
        vm.prank(creator);
        id = rules.createRule(_hireParams(_viewCond(1, 100), cooldown, maxFires), SPEC, deposit);
    }

    function _fire(uint256 id) internal returns (uint256 orderId) {
        vm.prank(keeper);
        orderId = rules.fire(id, SPEC);
    }

    function _escrow(uint256 id) internal view returns (uint256) {
        return rules.getRule(id).escrow;
    }
}
