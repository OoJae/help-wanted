// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPayroll} from "../../src/interfaces/IPayroll.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {IWorkRegistry} from "../../src/interfaces/external/IWorkRegistry.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {Doorbell} from "../../src/pots/Doorbell.sol";
import {PayrollStandIn} from "../kit/PayrollStandIn.sol";
import {Receipts} from "../kit/Receipts.sol";
import {RegistryStandIn} from "../kit/RegistryStandIn.sol";
import {MockIMD} from "../pots/mocks/MockIMD.sol";
import {LaunchKit} from "./LaunchKit.sol";

/// @title The first day, as `docs/LAUNCH.md` describes it
/// @notice The launch creates four contracts and calls nothing. What happens next is a list of
/// shell commands in the launch document, each a call anyone may make. These tests hold that list
/// against the code:
///
/// - every `cast call` and `cast send` line in `docs/LAUNCH.md` and in `README.md` names a function
///   that the contract it is sent to really has;
/// - the documented steps work, in the documented order, on the four contracts created from the
///   document's manifest with nothing called in between: the Doorbell is funded, rung until it
///   hires, a runner takes the order and is paid on a receipt (with the gas limit the document
///   gives) or, while receipts are late, on an unchallenged claim; the first crowd pot is opened
///   with the terms and the spec written in the document, fills, hires and is paid the way the
///   document proposes for a day on which receipts are stalled (on an unchallenged claim, stamped
///   when the receipt lands), and on a receipt when one exists; a wallet opens an order with the
///   documented parameters.
///
/// The chain is a local one. What lies outside this project stands at its mainnet address as a
/// stand-in: a plain token for IMD, a registry that holds what a test writes, and a stand-in for
/// Payroll at the address the manifest gives the desk, which is the live contract's address. The
/// fork suite walks the same first day against the real IMD, the real WorkRegistry and the live
/// Payroll, through the real ProjectFactory.
contract LaunchRunbookTest is Receipts, LaunchKit {
    WorkProof internal proof;
    WorkOrders internal desk;
    CrowdPots internal pots;
    Doorbell internal bell;
    MockIMD internal imd = MockIMD(Mainnet.IMD);
    /// @dev The stand-in for Payroll, placed at the address the manifest gives the desk.
    PayrollStandIn internal payroll;

    address internal funder = makeAddr("runbook funder");
    address internal runner = makeAddr("runbook runner");
    address internal alice = makeAddr("runbook alice");
    address internal stranger = makeAddr("runbook stranger");

    uint256 internal constant START = 1_760_000_000;
    /// @dev The gas limits the document tells a sender to give `settle` and `finalize`.
    uint256 internal constant SETTLE_GAS_LIMIT = 3_000_000;
    uint256 internal constant FINALIZE_GAS_LIMIT = 2_000_000;
    string internal constant PICTURE_FIXTURE = "df6805ee-skill-create-image-7dd1a0a2.hex";
    uint256 internal constant NOT_FOUND = type(uint256).max;

    function setUp() public {
        vm.warp(START);
        vm.etch(Mainnet.IMD, address(new MockIMD()).code);
        vm.etch(Mainnet.WORK_REGISTRY, address(new RegistryStandIn()).code);
        payroll = PayrollStandIn(_payrollOfTheManifest());
        vm.etch(address(payroll), address(new PayrollStandIn(Mainnet.IMD)).code);
        registry = RegistryStandIn(Mainnet.WORK_REGISTRY);

        (address[] memory created,,) = _createFromManifest();
        proof = WorkProof(created[0]);
        desk = WorkOrders(created[1]);
        pots = CrowdPots(created[2]);
        bell = Doorbell(created[3]);

        imd.mint(funder, 100e18);
        imd.mint(runner, 100e18);
        imd.mint(alice, 100e18);
    }

    // ---- the commands ---------------------------------------------------------------------------

    /// @notice Every `cast call $X "name(types)…"` and `cast send $X "name(types)…"` in the two
    /// documents is a call to a function that exists: `$PROOF`, `$DESK`, `$POTS` and `$BELL` are
    /// checked against the ABIs the compiler wrote, `$IMD` against ERC-20, `$PAYROLL` against
    /// `IPayroll` and the three views of the launched contract the fork suite calls, and
    /// `$REGISTRY` against the two registry functions this project reads.
    function test_runbook_everyDocumentedCommandNamesAFunctionThatExists() public view {
        // Each contract's selectors, read once from the ABI the compiler wrote.
        Surface memory surface;
        (, surface.proof) = _methods("WorkProof");
        (, surface.desk) = _methods("WorkOrders");
        (, surface.pots) = _methods("CrowdPots");
        (, surface.bell) = _methods("Doorbell");

        uint256 inLaunch = _checkCommands(vm.readFile(LAUNCH_DOC), LAUNCH_DOC, surface);
        uint256 inReadme = _checkCommands(vm.readFile(README), README, surface);
        assertGe(inLaunch, 40, "docs/LAUNCH.md: the commands were not found");
        assertGe(inReadme, 1, "README.md: the commands were not found");
    }

    struct Surface {
        bytes4[] proof;
        bytes4[] desk;
        bytes4[] pots;
        bytes4[] bell;
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
        if (_same(target, "PROOF")) return _hasSelector(surface.proof, selector);
        if (_same(target, "DESK")) return _hasSelector(surface.desk, selector);
        if (_same(target, "POTS")) return _hasSelector(surface.pots, selector);
        if (_same(target, "BELL")) return _hasSelector(surface.bell, selector);
        if (_same(target, "IMD")) {
            return selector == IERC20.approve.selector || selector == IERC20.transfer.selector
                || selector == IERC20.balanceOf.selector || selector == IERC20.allowance.selector;
        }
        if (_same(target, "PAYROLL")) {
            // The last three are not in `IPayroll`; the launched contract has them, and
            // `test_fork_payroll_isTheContractTheFirstLaunchCreated` calls each on mainnet.
            return selector == IPayroll.tipOwed.selector || selector == IPayroll.seatClaimable.selector
                || selector == IPayroll.book.selector || selector == bytes4(keccak256("IMD()"))
                || selector == bytes4(keccak256("QUESTIONS()")) || selector == bytes4(keccak256("unbooked()"));
        }
        if (_same(target, "REGISTRY")) {
            // `writer()` is not in our interface file; the fork suite calls it on the real registry.
            return selector == IWorkRegistry.latest.selector || selector == bytes4(keccak256("writer()"));
        }
        return false;
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (string memory) {
        bytes memory out = new bytes(to - from);
        for (uint256 i = from; i < to; ++i) {
            out[i - from] = b[i];
        }
        return string(out);
    }

    // ---- steps 1 to 4: the Doorbell -------------------------------------------------------------

    /// @dev Steps 1 and 2: 3 IMD by plain transfer, then 25 rings by anyone.
    function _fundAndRing() internal returns (uint256 orderId) {
        vm.prank(funder);
        imd.transfer(address(bell), 3e18);
        assertTrue(bell.funded());
        for (uint256 i = 1; i < 25; ++i) {
            assertEq(bell.ringsUntilHire(), 26 - i);
            vm.prank(stranger);
            bell.ring();
        }
        assertEq(bell.hires(), 0);
        vm.prank(stranger);
        (uint256 count, bool hired, uint256 id) = bell.ring();
        assertEq(count, 25);
        assertTrue(hired);
        assertEq(bell.hires(), 1);
        assertEq(bell.lastOrderId(), id);
        orderId = id;
    }

    /// @dev Step 3: the runner approves the bond, claims, reads the header and registers a job.
    function _take(uint256 orderId, bytes16 jobId) internal returns (bytes memory record) {
        assertEq(desk.priceNow(orderId), bell.MIN_PAY());
        vm.prank(runner);
        imd.approve(address(desk), 0.25e18);
        vm.prank(runner);
        desk.claim(orderId);
        bytes memory header = desk.headerOf(orderId);
        assertEq(header.length, 85);
        vm.prank(runner);
        desk.register(orderId, jobId);
        record = _recordFrom(PICTURE_FIXTURE, jobId, bytes.concat(header, bytes(bell.SPEC())));
    }

    /// @notice Steps 1 to 4 with a receipt: the settlement goes through on the gas limit the
    /// document gives, the runner is paid, and the Doorbell hears of it.
    function test_runbook_firstDay_theDoorbellHiresAndIsSettledOnAReceipt() public {
        uint256 orderId = _fundAndRing();
        bytes16 jobId = bytes16(keccak256("the first picture job"));
        uint256 runnerBefore = imd.balanceOf(runner);
        bytes memory record = _take(orderId, jobId);

        assertEq(IWorkRegistry(Mainnet.WORK_REGISTRY).latest(jobId), bytes32(0));
        _write(jobId, record);
        bytes memory call = abi.encodeCall(IWorkOrdersRunner.settle, (orderId, record, new address[](0)));
        vm.prank(stranger);
        assertTrue(vm.contains(_doc(), '"[]" \\\n  --gas-limit 3000000'), "the settle command's gas limit has changed");
        (bool ok,) = address(desk).call{gas: SETTLE_GAS_LIMIT}(call);
        assertTrue(ok, "the documented gas limit is not enough to settle");

        assertEq(imd.balanceOf(runner) - runnerBefore, 0.9e18, "the price of 1 IMD less 10%");
        assertEq(bell.receipts(), 1);
        (IWorkOrders.State state, address employer, uint96 escrow, uint96 spent, uint96 returned) =
            desk.accountOf(orderId);
        assertEq(uint8(state), uint8(IWorkOrders.State.Delivered));
        assertEq(employer, address(bell));
        assertEq(escrow, 0);
        assertEq(spent, 1e18);
        assertEq(returned, 0, "one price: the escrow is the price");
        assertEq(imd.balanceOf(address(bell)), 2e18, "3 IMD less the price of one picture");
        assertEq(payroll.paid() + payroll.tipped(), 0.1e18);
    }

    /// @notice Step 4 while receipts are late. With the claimed path on in the manifest: a delivery
    /// claim, 24 hours, `finalize` on the documented gas limit, and a stamp when the receipt lands.
    /// With it off: the claim is refused.
    function test_runbook_firstDay_theDoorbellsOrderWhileReceiptsAreLate() public {
        uint256 orderId = _fundAndRing();
        bytes16 jobId = bytes16(keccak256("the first picture job"));
        bytes memory record = _take(orderId, jobId);
        bytes32 named = keccak256(record);

        if (!bell.ALLOW_CLAIMED()) {
            vm.prank(runner);
            vm.expectRevert(IWorkOrdersRunner.ClaimedPathOff.selector);
            desk.claimDelivered(orderId, named);
            return;
        }

        vm.prank(runner);
        desk.claimDelivered(orderId, named);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(stranger);
        assertTrue(
            vm.contains(_doc(), 'finalize(uint256)" $ID --gas-limit 2000000'),
            "the finalize command's gas limit has changed"
        );
        (bool ok,) = address(desk).call{gas: FINALIZE_GAS_LIMIT}(abi.encodeCall(IWorkOrdersRunner.finalize, (orderId)));
        assertTrue(ok, "the documented gas limit is not enough to finalize");
        assertEq(bell.receipts(), 1);
        assertFalse(desk.orderOf(orderId).proven);

        _write(jobId, record);
        vm.prank(stranger);
        desk.stamp(orderId, record, new address[](0));
        assertTrue(desk.orderOf(orderId).proven);
    }

    // ---- step 5: the first crowd pot ------------------------------------------------------------

    /// @notice The pot written in the document is the one its commands open: the `openPot` line
    /// carries the terms of the marked block and the `cast from-utf8` line its spec. While
    /// IdentityMD's receipts are stalled the proposal allows the claimed path, because an order
    /// that does not could not be paid at all; this test fails, on purpose, when the document is
    /// changed back to a receipt-only pot without the reasons in it being changed too.
    function test_runbook_theFirstPotIsTheOneTheCommandsOpen() public view {
        string memory doc = _doc();
        (CrowdPots.Terms memory t, bytes memory spec) = _firstPot();
        assertTrue(
            vm.contains(
                doc,
                string.concat(
                    '"(',
                    t.kind,
                    ",",
                    vm.toString(uint256(t.target)),
                    ",",
                    vm.toString(uint256(t.minPay)),
                    ",",
                    vm.toString(uint256(t.rampSecs)),
                    ",",
                    vm.toString(uint256(t.bond)),
                    ",",
                    vm.toString(uint256(t.deliverySecs)),
                    ",",
                    vm.toString(uint256(t.hireSecs)),
                    ",",
                    vm.toString(uint256(t.fundSecs)),
                    ",",
                    t.allowClaimed ? "true" : "false",
                    ')"'
                )
            ),
            "the openPot command in the document does not carry the documented terms"
        );
        assertTrue(vm.contains(doc, string.concat('cast from-utf8 "', string(spec), '"')), "nor the documented spec");
        assertTrue(t.allowClaimed, "the first pot is receipt-only: while receipts are stalled it could not be paid");
        assertTrue(
            vm.contains(doc, "**While receipts are stalled the first pot allows the claimed path.**"),
            "the document no longer says why the first pot allows the claimed path"
        );
        // The claim must leave 48 hours before the delivery deadline; the terms leave days.
        assertGe(t.deliverySecs, 4 days);
    }

    /// @dev Opens the documented pot, fills it from one wallet, has a third party launch it, and
    /// has the runner take the order and register a job.
    function _firstPotHires(bytes16 jobId)
        internal
        returns (CrowdPots.Terms memory t, bytes memory spec, uint256 potId, uint256 orderId)
    {
        (t, spec) = _firstPot();
        vm.prank(alice);
        potId = pots.openPot(t, spec, 0);
        assertEq(potId, pots.potCount());
        assertEq(pots.kindOf(pots.potOf(potId).kindHash), t.kind);
        vm.prank(alice);
        imd.approve(address(pots), t.target);
        vm.prank(alice);
        assertEq(pots.chipIn(potId, t.target), t.target);
        vm.prank(stranger);
        orderId = pots.launch(potId, spec);

        vm.prank(runner);
        imd.approve(address(desk), t.bond);
        vm.prank(runner);
        desk.claim(orderId);
        vm.prank(runner);
        desk.register(orderId, jobId);
    }

    /// @notice The first pot as the document proposes it for a day on which receipts are stalled:
    /// accepted, filled, launched by a third party, taken by a runner, and paid on a delivery
    /// claim nobody challenged for 24 hours, with `finalize` sent on the documented gas limit.
    /// What the price left of the target goes back to the contributor. When the receipt lands,
    /// anyone stamps the order proven and no money moves.
    function test_runbook_theFirstPotOpensFillsHiresAndIsPaidOnAClaim() public {
        bytes16 jobId = bytes16(keccak256("the first pot's job"));
        (CrowdPots.Terms memory t, bytes memory spec, uint256 potId, uint256 orderId) = _firstPotHires(jobId);
        bytes memory record = _recordOf(jobId, t.kind, bytes.concat(desk.headerOf(orderId), spec), "completed");

        uint256 runnerBefore = imd.balanceOf(runner);
        vm.prank(runner);
        desk.claimDelivered(orderId, keccak256(record));
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(stranger);
        (bool ok,) = address(desk).call{gas: FINALIZE_GAS_LIMIT}(abi.encodeCall(IWorkOrdersRunner.finalize, (orderId)));
        assertTrue(ok, "the documented gas limit is not enough to finalize");
        assertEq(
            imd.balanceOf(runner) - runnerBefore,
            uint256(t.minPay) - uint256(t.minPay) / 10 + t.bond,
            "the starting price less 10%, and the bond back"
        );
        assertFalse(desk.orderOf(orderId).proven);

        uint256 before = imd.balanceOf(alice);
        vm.prank(stranger);
        uint256 paid = pots.claimRefund(potId, alice);
        assertEq(paid, uint256(t.target) - t.minPay, "taken at once: the target less the starting price");
        assertEq(imd.balanceOf(alice) - before, paid);
        assertEq(pots.owed(), 0);

        _write(jobId, record);
        vm.prank(stranger);
        desk.stamp(orderId, record, new address[](0));
        assertTrue(desk.orderOf(orderId).proven);
        assertEq(imd.balanceOf(alice) - before, paid, "a stamp moves no money");
    }

    /// @notice The same pot when the job's receipt exists: it settles on the receipt, as any order
    /// does, whether or not it allows claims.
    function test_runbook_theFirstPotSettlesOnAReceiptWhenOneExists() public {
        bytes16 jobId = bytes16(keccak256("the first pot's job"));
        (CrowdPots.Terms memory t, bytes memory spec, uint256 potId, uint256 orderId) = _firstPotHires(jobId);
        bytes memory record = _recordOf(jobId, t.kind, bytes.concat(desk.headerOf(orderId), spec), "completed");
        _write(jobId, record);
        (bool ok,) = address(desk).call{gas: SETTLE_GAS_LIMIT}(
            abi.encodeCall(IWorkOrdersRunner.settle, (orderId, record, new address[](0)))
        );
        assertTrue(ok, "the documented gas limit is not enough to settle");
        assertTrue(desk.orderOf(orderId).proven);

        uint256 before = imd.balanceOf(alice);
        vm.prank(stranger);
        uint256 paid = pots.claimRefund(potId, alice);
        assertEq(paid, uint256(t.target) - t.minPay);
        assertEq(imd.balanceOf(alice) - before, paid);
        assertEq(pots.owed(), 0);
    }

    /// @notice What the document tells whoever watches the first pot to do about a delivery claim
    /// that is not true: challenge it with a bond equal to the runner's. With no receipt and no
    /// arbiter the dispute ends at the delivery deadline: the pot is refunded with a tenth of the
    /// runner's bond on top, the challenger gets its bond back whole, and the runner is not paid.
    function test_runbook_theFirstPot_anUntrueClaimIsStoppedByAChallenge() public {
        bytes16 jobId = bytes16(keccak256("a job that does not exist"));
        uint256 runnerBefore = imd.balanceOf(runner);
        (CrowdPots.Terms memory t,, uint256 potId, uint256 orderId) = _firstPotHires(jobId);
        vm.prank(runner);
        desk.claimDelivered(orderId, keccak256("a record that does not exist"));

        // The keeper: the order's bond in IMD, approved to the desk.
        vm.prank(funder);
        imd.approve(address(desk), t.bond);
        uint256 keeperBefore = imd.balanceOf(funder);
        vm.prank(funder);
        desk.challenge(orderId);
        assertEq(keeperBefore - imd.balanceOf(funder), t.bond);

        // Nothing can decide it: there is no receipt and a pot's order has no arbiter.
        vm.warp(desk.claimOf(orderId).registeredAt + uint256(t.deliverySecs));
        uint256 before = imd.balanceOf(alice);
        vm.prank(stranger);
        uint256 paid = pots.claimRefund(potId, alice);
        assertEq(paid, uint256(t.target) + uint256(t.bond) / 10, "every chip, and a tenth of the runner's bond");
        assertEq(imd.balanceOf(alice) - before, paid);
        assertEq(imd.balanceOf(funder), keeperBefore, "the challenger is whole");
        assertEq(runnerBefore - imd.balanceOf(runner), uint256(t.bond) / 10, "the claimer lost a tenth of its bond");
    }

    // ---- step 6: an order from a wallet ---------------------------------------------------------

    /// @notice The order of step 6, with the parameters written there.
    function test_runbook_aWalletOpensAnOrderWithTheDocumentedParameters() public {
        string memory doc = _doc();
        assertTrue(
            vm.contains(
                doc,
                ",2000000000000000000,4000000000000000000,3600,604800,$EXPIRES,250000000000000000,0,0x0000000000000000000000000000000000000000,"
            ),
            "the createOrder command in the document has changed"
        );
        IWorkOrders.OrderParams memory p;
        p.kindHash = keccak256("skill:research-report");
        p.minPay = 2e18;
        p.maxPay = 4e18;
        p.rampSecs = 3600;
        p.deliverySecs = 604_800;
        p.expiresAt = uint40(vm.getBlockTimestamp() + 604_800);
        p.bond = 0.25e18;
        bytes memory spec = bytes(_block(doc, "firstPot:spec", "text"));
        vm.prank(funder);
        imd.approve(address(desk), 4e18);
        vm.prank(funder);
        uint256 id = desk.createOrder(p, spec);
        (IWorkOrders.State state, address employer, uint96 escrow,,) = desk.accountOf(id);
        assertEq(uint8(state), uint8(IWorkOrders.State.Open));
        assertEq(employer, funder);
        assertEq(escrow, 4e18);
    }
}
