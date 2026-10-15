// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Vm} from "forge-std/Vm.sol";

import {IPayroll} from "../../src/interfaces/IPayroll.sol";
import {IWorkOrders} from "../../src/interfaces/IWorkOrders.sol";
import {IWorkOrdersRunner} from "../../src/interfaces/IWorkOrdersRunner.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";
import {WorkOrders} from "../../src/desk/WorkOrders.sol";
import {CrowdPots} from "../../src/pots/CrowdPots.sol";
import {Doorbell} from "../../src/pots/Doorbell.sol";
import {LaunchValues} from "../kit/LaunchValues.sol";
import {LaunchKit} from "../launch/LaunchKit.sol";
import {ForkKit, ILivePayroll} from "./ForkKit.sol";

/// @dev IdentityMD's ProjectFactory, as a contracts-only launch uses it. Taken from the verified ABI
/// (Sourcify, Ethereum mainnet `0xff03410d0fe5fa8f7f59f743de35e333d9857120`).
interface IProjectFactory {
    struct LaunchRecord {
        bytes32 kind;
        uint64 launchNumber;
        uint64 recordedAt;
        bytes32 sourceCommit;
        bytes32 manifestHash;
        bytes32 attestationHash;
        bytes32 verifierKey;
        string sourceRepoUrl;
    }

    struct ContractsParams {
        uint64 launchNumber;
        bytes[] contractCreationCodes;
        bytes32[] contractNames;
        address[] expectedContracts;
        LaunchRecord record;
        uint256[] agentIds;
    }

    event ContractsLaunched(uint64 indexed launchNumber, address[] contracts);

    error NotDeployer();
    error AlreadyLaunched(uint64 launchNumber);

    function launchContracts(ContractsParams calldata p) external returns (address[] memory contracts);

    function predictContract(uint64 launchNumber, uint256 index, bytes calldata code) external view returns (address);

    function deploymentBlock(uint64 launchNumber) external view returns (uint256 blockNumber);

    function deployer() external view returns (address);
}

/// @title Launch B rehearsed through the real ProjectFactory
/// @notice On a fork of Ethereum mainnet, the launch deployer calls the real factory's
/// `launchContracts` with this project's four contracts, built from the manifest in
/// `docs/LAUNCH.md`: the same call, by the same sender, that the launch pipeline makes (compare
/// launch 1240, transaction `0x93a1b0cc…972d71a3`). Then the first day is walked on what the
/// factory created, against the live IMD token, the live WorkRegistry and the live Payroll: the
/// Doorbell is funded and rung until it hires, a runner takes its order, the registry's writer
/// records the picture job's receipt, the order settles, and the crowd pot the runbook proposes
/// is opened, filled, launched and paid.
///
/// What is rehearsed: the factory accepts the four initcodes in manifest order and creates them at
/// the addresses it predicts; `$contract:WorkProof` and `$contract:WorkOrders` resolve to those
/// addresses; the desk's third argument is the address of the Payroll contract HELP WANTED's first
/// launch created, which holds that launch's code; the whole call fits our 12 million gas gate with
/// the transaction's own intrinsic cost added; the deployed bytecode holds no forbidden opcode; and
/// the launched contracts work with nothing called after deployment, paying their fees and tips
/// into the live Payroll.
///
/// What cannot be rehearsed here: the pipeline's own checks before it sends the transaction, and a
/// real swarm job (the receipts are written by the registry's writer, impersonated on the fork).
/// One test removes the code at Payroll's address, to show what a settlement would do had a wrong
/// address been written into the manifest.
///
/// The record fields the factory stores with a launch (source commit, manifest hash, attestation
/// hash, verifier key, repository URL) are placeholders here. The launch number is one no launch
/// has used.
///
/// Run with `FOUNDRY_PROFILE=fork forge test`. Every test skips itself when the RPC cannot be reached.
contract LaunchRehearsalForkTest is ForkKit, LaunchKit {
    IProjectFactory internal constant FACTORY = IProjectFactory(Mainnet.PROJECT_FACTORY);

    /// @dev Far above any launch number in use (they are in the low thousands).
    uint64 internal constant LAUNCH_NUMBER = 4_000_000_002;

    bytes[] internal initcodes;
    address[] internal predicted;
    address[] internal launched;
    uint256 internal launchExecutionGas;
    uint256 internal launchIntrinsicGas;
    Vm.Log[] internal launchLogs;

    WorkProof internal proof;
    WorkOrders internal desk;
    CrowdPots internal pots;
    Doorbell internal bell;
    /// @dev The address the manifest gives the desk for Payroll: the live contract of the first
    /// launch. Nothing is placed there by this test.
    address internal payrollAt;

    address internal funder = makeAddr("rehearsal funder");
    address internal runner = makeAddr("rehearsal runner");
    address internal alice = makeAddr("rehearsal alice");
    address internal bob = makeAddr("rehearsal bob");
    address internal stranger = makeAddr("rehearsal stranger");

    string internal constant PICTURE_FIXTURE = "df6805ee-skill-create-image-7dd1a0a2.hex";
    uint256 internal constant PICTURE_AGENT = 51029;

    function setUp() public {
        if (!_fork()) return;
        _launch();
        proof = WorkProof(launched[0]);
        desk = WorkOrders(launched[1]);
        pots = CrowdPots(launched[2]);
        bell = Doorbell(launched[3]);
        payrollAt = _payrollOfTheManifest();
        _fund(runner, 100e18, address(desk));
        _fund(funder, 100e18, address(desk));
    }

    // ---- the launch -----------------------------------------------------------------------------

    /// @dev Builds the factory call from the document's manifest and makes it as the launch deployer.
    function _launch() internal {
        (, Entry[] memory entries) = _manifest();
        IProjectFactory.ContractsParams memory p;
        p.launchNumber = LAUNCH_NUMBER;
        p.contractCreationCodes = new bytes[](entries.length);
        p.contractNames = new bytes32[](entries.length);
        p.expectedContracts = new address[](entries.length);

        for (uint256 i; i < entries.length; ++i) {
            // A reference to an earlier contract is filled with the address the factory will give it.
            bytes memory init = _initcode(i, _wordsOf(entries, i, p.expectedContracts));
            p.contractCreationCodes[i] = init;
            p.contractNames[i] = bytes32(bytes(entries[i].name));
            p.expectedContracts[i] = FACTORY.predictContract(LAUNCH_NUMBER, i, init);
            initcodes.push(init);
            predicted.push(p.expectedContracts[i]);
        }

        p.record = IProjectFactory.LaunchRecord({
            kind: bytes32("evm_contracts"),
            launchNumber: LAUNCH_NUMBER,
            recordedAt: 0,
            sourceCommit: bytes32(bytes20(keccak256("a rehearsal has no commit"))),
            manifestHash: keccak256("rehearsal manifest"),
            attestationHash: keccak256("rehearsal attestation"),
            verifierKey: keccak256("rehearsal verifier key"),
            sourceRepoUrl: "https://example.invalid/help-wanted/launch-b"
        });
        p.agentIds = new uint256[](0);

        // The calldata is built first, so that what is measured is the call and not the cost of
        // encoding 46 KB of arguments in this test's memory.
        bytes memory data = abi.encodeCall(IProjectFactory.launchContracts, (p));
        launchIntrinsicGas = _intrinsicGas(data);

        vm.recordLogs();
        vm.prank(Mainnet.LAUNCH_DEPLOYER);
        uint256 gasBefore = gasleft();
        (bool ok, bytes memory ret) = address(FACTORY).call(data);
        launchExecutionGas = gasBefore - gasleft();
        require(ok, "the factory refused the launch");
        address[] memory created = abi.decode(ret, (address[]));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            launchLogs.push(logs[i]);
        }
        for (uint256 i; i < created.length; ++i) {
            launched.push(created[i]);
        }
    }

    /// @dev What a transaction with this calldata costs before any code runs: 21,000, plus 4 gas
    /// for each zero byte and 16 for each other byte. (The floor price EIP-7623 sets for calldata,
    /// 10 and 40, applies only to a transaction that executes almost nothing; this one does not.)
    function _intrinsicGas(bytes memory data) internal pure returns (uint256 gas) {
        gas = 21_000;
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// @notice The factory created the four contracts where it said it would, in manifest order,
    /// and recorded the launch. What each was built with is what the manifest says.
    function test_fork_rehearsal_factoryCreatesTheFourContracts() public onFork {
        assertEq(FACTORY.deployer(), Mainnet.LAUNCH_DEPLOYER, "the launch deployer has changed");
        assertEq(launched.length, CONTRACTS);
        for (uint256 i; i < CONTRACTS; ++i) {
            assertEq(launched[i], predicted[i], _contractName(i));
            assertGt(launched[i].code.length, 0, _contractName(i));
        }
        assertEq(FACTORY.deploymentBlock(LAUNCH_NUMBER), vm.getBlockNumber());

        // The factory's own event names the four addresses.
        bool seen;
        for (uint256 i; i < launchLogs.length; ++i) {
            if (
                launchLogs[i].emitter == address(FACTORY)
                    && launchLogs[i].topics[0] == IProjectFactory.ContractsLaunched.selector
            ) {
                address[] memory named = abi.decode(launchLogs[i].data, (address[]));
                assertEq(named.length, CONTRACTS);
                for (uint256 k; k < CONTRACTS; ++k) {
                    assertEq(named[k], launched[k]);
                }
                seen = true;
            }
        }
        assertTrue(seen, "the factory did not emit ContractsLaunched");

        assertEq(proof.WORK_REGISTRY(), Mainnet.WORK_REGISTRY);
        assertEq(desk.IMD(), Mainnet.IMD);
        assertEq(desk.WORK_PROOF(), address(proof), "$contract:WorkProof");
        assertEq(desk.PAYROLL(), payrollAt, "the manifest's third argument of WorkOrders");
        assertEq(payrollAt, Mainnet.PAYROLL, "the manifest names another address than Mainnet.sol");
        assertEq(payrollAt.codehash, PAYROLL_CODEHASH, "the address does not hold the first launch's Payroll");
        assertEq(ILivePayroll(payrollAt).IMD(), desk.IMD(), "Payroll and the desk are paid in the same token");
        assertEq(address(pots.IMD()), Mainnet.IMD);
        assertEq(address(pots.WORK_ORDERS()), address(desk), "$contract:WorkOrders, in CrowdPots");
        assertEq(address(bell.IMD()), Mainnet.IMD);
        assertEq(address(bell.WORK_ORDERS()), address(desk), "$contract:WorkOrders, in the Doorbell");
        assertEq(bell.KIND_HASH(), LaunchValues.BELL_KIND_HASH);
        assertEq(bell.MIN_PAY(), LaunchValues.BELL_MIN_PAY);
        assertEq(bell.MAX_PAY(), LaunchValues.BELL_MAX_PAY);
        assertEq(bell.BOND(), LaunchValues.BELL_BOND);
        assertEq(bell.DELIVERY_SECS(), LaunchValues.BELL_DELIVERY_SECS);
        assertEq(bell.ALLOW_CLAIMED(), LaunchValues.BELL_ALLOW_CLAIMED);

        // The dependencies the constructors could not check are what the contracts expect.
        assertGt(Mainnet.IMD.code.length, 0);
        assertEq(IERC20Metadata(Mainnet.IMD).decimals(), 18);
        assertGt(Mainnet.WORK_REGISTRY.code.length, 0);
        assertEq(REGISTRY.latest(REFERENCE_JOB) != bytes32(0), true, "the registry answers latest(bytes16)");
        assertFalse(bell.funded(), "nobody has funded the Doorbell yet");
        assertEq(desk.orderCount(), 0);
        assertEq(pots.potCount(), 0);
    }

    function test_fork_rehearsal_onlyTheDeployerLaunchesAndOnlyOnce() public onFork {
        IProjectFactory.ContractsParams memory p;
        p.launchNumber = LAUNCH_NUMBER + 1;
        p.contractCreationCodes = new bytes[](1);
        p.contractCreationCodes[0] = initcodes[0];
        p.contractNames = new bytes32[](1);
        p.contractNames[0] = bytes32("WorkProof");
        p.expectedContracts = new address[](1);
        p.expectedContracts[0] = FACTORY.predictContract(LAUNCH_NUMBER + 1, 0, initcodes[0]);
        p.record.kind = bytes32("evm_contracts");
        p.record.launchNumber = LAUNCH_NUMBER + 1;
        p.agentIds = new uint256[](0);

        vm.expectRevert(IProjectFactory.NotDeployer.selector);
        FACTORY.launchContracts(p);

        p.launchNumber = LAUNCH_NUMBER;
        p.record.launchNumber = LAUNCH_NUMBER;
        vm.prank(Mainnet.LAUNCH_DEPLOYER);
        vm.expectRevert(abi.encodeWithSelector(IProjectFactory.AlreadyLaunched.selector, LAUNCH_NUMBER));
        FACTORY.launchContracts(p);
    }

    /// @notice The whole launch, as one transaction, is inside our 12 million gas gate (the
    /// protocol's ceiling is 16.7 million): what the factory call used here plus what the
    /// transaction's calldata costs before any code runs. Each contract is inside our size gates.
    /// The second part is added by hand from the calldata's bytes; under Foundry's default setting
    /// the measured call may already include it, so the total errs high.
    function test_fork_rehearsal_launchFitsOurGasAndSizeGates() public onFork {
        uint256 totalInitcode;
        uint256 totalRuntime;
        for (uint256 i; i < CONTRACTS; ++i) {
            totalRuntime += launched[i].code.length;
            emit log_named_uint(string.concat(_contractName(i), ": runtime bytes"), launched[i].code.length);
            emit log_named_uint(string.concat(_contractName(i), ": initcode bytes with arguments"), initcodes[i].length);
            assertLe(launched[i].code.length, RUNTIME_GATE, _contractName(i));
            assertLe(initcodes[i].length, INITCODE_GATE, _contractName(i));
            totalInitcode += initcodes[i].length;
        }
        uint256 total = launchExecutionGas + launchIntrinsicGas;
        emit log_named_uint("launch B: initcode bytes in all", totalInitcode);
        emit log_named_uint("launch B: gas used by the factory call", launchExecutionGas);
        emit log_named_uint("launch B: intrinsic gas of the transaction", launchIntrinsicGas);
        emit log_named_uint("launch B: the two together", total);
        emit log_named_uint("launch B: gas per initcode byte", total / totalInitcode);
        // Storing code alone costs 200 gas a byte: a figure below that was not measured at all.
        assertGt(launchExecutionGas, 200 * totalRuntime, "the factory call's gas was not measured");
        assertLt(total, LAUNCH_GAS_GATE, "launch B is over our gas gate");
        // A cross-check on the measurement itself: a real contracts-only launch (number 1240) used
        // 9,596,612 gas for 39,910 bytes of initcode. The rehearsal's cost for each byte is within
        // two percent of that.
        uint256 atTheRealRate = totalInitcode * 9_596_612 / 39_910;
        emit log_named_uint("launch B: at launch 1240's gas per initcode byte", atTheRealRate);
        assertLt(total, atTheRealRate * 102 / 100, "dearer for each byte than a real launch was");
        assertGt(total, atTheRealRate * 98 / 100, "cheaper for each byte than a real launch was");
    }

    /// @notice The bytecode the factory put on chain holds no DELEGATECALL, CALLCODE or SELFDESTRUCT.
    function test_fork_rehearsal_deployedBytecodeHasNoForbiddenOpcode() public onFork {
        for (uint256 i; i < CONTRACTS; ++i) {
            bytes memory code = launched[i].code;
            assertEq(_firstOpcode(code, _forbidden()), code.length, _contractName(i));
        }
    }

    // ---- the first day --------------------------------------------------------------------------

    /// @dev Steps 1 and 2 of the runbook: a wallet funds the Doorbell with one order's escrow by
    /// plain transfer, and it is rung until the 25th ring opens an order.
    function _ringUntilHired() internal returns (uint256 orderId) {
        uint256 maxPay = bell.MAX_PAY();
        vm.prank(funder);
        IMD.transfer(address(bell), maxPay);
        assertTrue(bell.funded());
        uint256 per = bell.RINGS_PER_HIRE();
        for (uint256 i = 1; i < per; ++i) {
            vm.prank(stranger);
            (, bool early,) = bell.ring();
            assertFalse(early);
        }
        uint256 g = gasleft();
        vm.prank(stranger);
        (uint256 count, bool hired, uint256 id) = bell.ring();
        emit log_named_uint("Doorbell.ring that hires: gas", g - gasleft());
        assertTrue(hired, "the 25th ring hires");
        assertEq(count % per, 0);
        orderId = id;
        (IWorkOrders.State state, address employer, uint96 escrow,,) = desk.accountOf(orderId);
        assertEq(uint8(state), uint8(IWorkOrders.State.Open));
        assertEq(employer, address(bell));
        assertEq(escrow, maxPay);
        assertEq(IMD.allowance(address(bell), address(desk)), 0, "the exact allowance was used up");
    }

    /// @dev The record of the Doorbell's picture job: the real record of a real create-image job
    /// (df6805ee), its kind as IdentityMD wrote it, with the job id and the objective swapped for
    /// this claim's header followed by the Doorbell's own spec.
    function _pictureRecord(uint256 orderId, bytes16 jobId) internal view returns (bytes memory) {
        return _recordFrom(PICTURE_FIXTURE, jobId, bytes.concat(desk.headerOf(orderId), bytes(bell.SPEC())));
    }

    /// @notice The Doorbell's first hire, proven: funded, rung 25 times, taken by a runner, the
    /// picture job's receipt recorded by the registry's writer, settled by anyone. The Doorbell
    /// hears of it through its callback and gets the unused escrow back for its next hire.
    function test_fork_rehearsal_firstDay_theDoorbellHiresAndItsPictureJobIsProven() public onFork {
        uint256 orderId = _ringUntilHired();
        uint256 runnerBefore = IMD.balanceOf(runner);
        uint256 payrollBefore = IMD.balanceOf(payrollAt);
        uint256 owedBefore = IPayroll(payrollAt).tipOwed(PICTURE_AGENT);
        uint256 revenueBefore = ILivePayroll(payrollAt).ledger().received;

        // Taken at once: the price is where the ramp starts.
        vm.prank(runner);
        desk.claim(orderId);
        uint256 price = desk.priceNow(orderId);
        assertEq(price, bell.MIN_PAY());
        bytes16 jobId = _freshJob();
        vm.prank(runner);
        desk.register(orderId, jobId);

        bytes memory record = _pictureRecord(orderId, jobId);
        bytes32 receipt = _recordWork(jobId, record);
        uint256 g = gasleft();
        vm.prank(stranger);
        desk.settle(orderId, record, _none());
        emit log_named_uint("settle of the Doorbell's order: gas", g - gasleft());
        emit log_named_uint("its record: bytes", record.length);

        uint256 fee = price / 20;
        assertEq(IMD.balanceOf(runner) - runnerBefore, price - 2 * fee, "the runner: the price less 10%");
        assertEq(IMD.balanceOf(payrollAt) - payrollBefore, 2 * fee, "Payroll: the fee and the tip");
        assertEq(IMD.balanceOf(address(bell)), bell.MAX_PAY() - price, "the Doorbell: the unused escrow");
        assertEq(IMD.balanceOf(address(desk)), 0);
        assertEq(
            IPayroll(payrollAt).tipOwed(PICTURE_AGENT) - owedBefore,
            fee,
            "the tip is owed to the one agent the real picture record names"
        );
        assertEq(
            ILivePayroll(payrollAt).ledger().received - revenueBefore, fee, "the live Payroll booked the fee as revenue"
        );
        assertEq(IMD.allowance(address(desk), payrollAt), 0);

        assertEq(bell.receipts(), 1, "the desk's callback reached the Doorbell");
        assertEq(bell.lastDeliveredOrderId(), orderId);
        Doorbell.Hire memory h = bell.hireOf(orderId);
        assertTrue(h.delivered);
        assertEq(h.jobId, jobId);
        assertEq(h.recordHash, receipt);
        assertTrue(desk.orderOf(orderId).proven);
    }

    /// @notice The same hire while receipts are late, as they are on the day this was written: if
    /// the manifest deploys the Doorbell with the claimed path on, the runner's delivery claim is
    /// paid after 24 hours without a challenge and stamped when the receipt lands; if it deploys it
    /// with the path off, no such claim can be made at all.
    function test_fork_rehearsal_firstDay_theDoorbellsOrderWhileReceiptsAreLate() public onFork {
        uint256 orderId = _ringUntilHired();
        vm.prank(runner);
        desk.claim(orderId);
        bytes16 jobId = _freshJob();
        vm.prank(runner);
        desk.register(orderId, jobId);
        bytes memory record = _pictureRecord(orderId, jobId);

        if (!bell.ALLOW_CLAIMED()) {
            vm.prank(runner);
            vm.expectRevert(IWorkOrdersRunner.ClaimedPathOff.selector);
            desk.claimDelivered(orderId, keccak256(record));
            return;
        }

        uint256 runnerBefore = IMD.balanceOf(runner);
        vm.prank(runner);
        desk.claimDelivered(orderId, keccak256(record));
        _skip(desk.CHALLENGE_WINDOW());
        vm.prank(stranger);
        desk.finalize(orderId);
        uint256 price = bell.MIN_PAY();
        assertEq(IMD.balanceOf(runner) - runnerBefore, price - price / 10 + bell.BOND());
        assertEq(bell.receipts(), 1);
        assertEq(bell.hireOf(orderId).recordHash, keccak256(record), "the hash the runner named");
        assertFalse(desk.orderOf(orderId).proven);

        _recordWork(jobId, record);
        desk.stamp(orderId, record, _none());
        assertTrue(desk.orderOf(orderId).proven);
        assertEq(bell.receipts(), 1, "a stamp does not call the employer again");
    }

    /// @dev The pot the runbook proposes, opened by one wallet, filled by two, launched by a third,
    /// and taken by a runner that registers a fresh job.
    function _documentedPotHires()
        internal
        returns (CrowdPots.Terms memory t, bytes memory spec, uint256 potId, uint256 orderId, bytes16 jobId)
    {
        (t, spec) = _firstPot();
        _fund(alice, 10e18, address(pots));
        _fund(bob, 10e18, address(pots));
        uint256 first = _openersChip(t.target);
        vm.prank(alice);
        potId = pots.openPot(t, spec, first);
        assertEq(pots.kindOf(pots.potOf(potId).kindHash), t.kind, "the kind can be read back as text");
        vm.prank(bob);
        assertEq(pots.chipIn(potId, 50e18), uint256(t.target) - first, "cut to what was missing");
        assertEq(IMD.balanceOf(address(pots)), t.target);

        vm.prank(stranger);
        orderId = pots.launch(potId, spec);
        assertEq(IMD.balanceOf(address(pots)), 0);
        assertEq(IMD.balanceOf(address(desk)), t.target);

        vm.prank(runner);
        desk.claim(orderId);
        jobId = _freshJob();
        vm.prank(runner);
        desk.register(orderId, jobId);
    }

    /// @dev What the pot's opener chips in with the opening: three fifths of the target, so the
    /// two contributors hold unequal shares.
    function _openersChip(uint256 target) internal pure returns (uint256) {
        return target * 3 / 5;
    }

    /// @dev What the price left of the target is shared back to the two contributors, to the wei.
    function _assertSharedBack(uint256 potId, uint256 orderId, uint256 price, uint256 target) internal {
        (,, uint96 escrow, uint96 spent, uint96 returned) = desk.accountOf(orderId);
        assertEq(escrow, 0);
        assertEq(spent, price, "taken at once, at the start of the ramp");
        assertEq(returned, target - price);
        assertEq(IMD.balanceOf(address(pots)), returned, "the desk pushed what it reports");

        uint256 aliceBefore = IMD.balanceOf(alice);
        uint256 bobBefore = IMD.balanceOf(bob);
        uint256 a = pots.claimRefund(potId, alice);
        uint256 b = pots.claimRefund(potId, bob);
        assertEq(a, uint256(returned) * _openersChip(target) / target);
        assertEq(a + b, returned, "shared out to the wei");
        assertEq(IMD.balanceOf(alice) - aliceBefore, a);
        assertEq(IMD.balanceOf(bob) - bobBefore, b);
        assertEq(IMD.balanceOf(address(pots)), 0);
        assertEq(pots.owed(), 0);
    }

    /// @notice The first crowd pot as the runbook proposes it while receipts are stalled, on the
    /// launched contracts: its terms and spec are read from `docs/LAUNCH.md`, it allows the claimed
    /// path, and it is paid on a delivery claim nobody challenged for 24 hours. The live Payroll
    /// takes the fee and, with no record to name agents, books the tip to its seat pool. When the
    /// receipt lands in the real registry the order is stamped proven and no money moves.
    function test_fork_rehearsal_firstDay_theDocumentedPotIsPaidOnAClaimWhileReceiptsAreStalled() public onFork {
        (CrowdPots.Terms memory t, bytes memory spec, uint256 potId, uint256 orderId, bytes16 jobId) =
            _documentedPotHires();
        assertTrue(t.allowClaimed, "the first pot of the runbook allows the claimed path");
        bytes memory record = _recordOf(jobId, t.kind, bytes.concat(desk.headerOf(orderId), spec), "completed");
        ILivePayroll.Ledger memory before = ILivePayroll(payrollAt).ledger();
        uint256 runnerBefore = IMD.balanceOf(runner);

        vm.prank(runner);
        desk.claimDelivered(orderId, keccak256(record));
        _skip(desk.CHALLENGE_WINDOW());
        uint256 g = gasleft();
        vm.prank(stranger);
        desk.finalize(orderId);
        emit log_named_uint("finalize of the first pot's order: gas", g - gasleft());

        uint256 price = t.minPay;
        assertEq(IMD.balanceOf(runner) - runnerBefore, price - price / 10 + t.bond);
        ILivePayroll.Ledger memory later = ILivePayroll(payrollAt).ledger();
        assertEq(later.received - before.received, price / 20, "the fee, booked as revenue");
        assertEq(later.tipsIn - before.tipsIn, price / 20, "the tip");
        assertEq(later.tipsToSeats - before.tipsToSeats, price / 20, "with no agents named, all of it to the seat pool");
        assertEq(pots.potOf(potId).recordHash, keccak256(record), "the callback reached the pot with the hash named");
        assertFalse(desk.orderOf(orderId).proven);
        _assertSharedBack(potId, orderId, price, t.target);

        _recordWork(jobId, record);
        desk.stamp(orderId, record, _none());
        assertTrue(desk.orderOf(orderId).proven);
    }

    /// @notice The same pot when its job's receipt is in the real registry: delivered against the
    /// receipt, and what the price left of the target shared back to the wei.
    function test_fork_rehearsal_firstDay_theDocumentedPotSettlesOnAReceipt() public onFork {
        (CrowdPots.Terms memory t, bytes memory spec, uint256 potId, uint256 orderId, bytes16 jobId) =
            _documentedPotHires();
        bytes memory record = _recordOf(jobId, t.kind, bytes.concat(desk.headerOf(orderId), spec), "completed");
        bytes32 receipt = _recordWork(jobId, record);
        desk.settle(orderId, record, _none());
        assertEq(pots.potOf(potId).recordHash, receipt, "the callback reached the pot");
        assertTrue(desk.orderOf(orderId).proven);
        _assertSharedBack(potId, orderId, t.minPay, t.target);
    }

    /// @notice What a settlement would do if nothing lived at the address the desk was given for
    /// Payroll, as after a wrong address written into the manifest: here the live Payroll's code is
    /// removed on the fork. The two calls reach no code, nothing is pulled, and the desk sends the
    /// fee and the tip to that address by plain transfer. The runner and the employer are paid
    /// exactly as otherwise. Whether that IMD could ever be used would depend on what lives at the
    /// address, which is why the manifest's value is checked against the first launch before this one.
    function test_fork_rehearsal_withNoCodeAtPayrollsAddress_theFeeIsSentThereByPlainTransfer() public onFork {
        vm.etch(payrollAt, "");
        uint256 orderId = _ringUntilHired();
        vm.prank(runner);
        desk.claim(orderId);
        bytes16 jobId = _freshJob();
        vm.prank(runner);
        desk.register(orderId, jobId);
        bytes memory record = _pictureRecord(orderId, jobId);
        _recordWork(jobId, record);

        uint256 price = bell.MIN_PAY();
        uint256 runnerBefore = IMD.balanceOf(runner);
        uint256 thereBefore = IMD.balanceOf(payrollAt);
        vm.expectEmit(address(desk));
        emit IWorkOrdersRunner.PayrollFallback(orderId, price / 10);
        desk.settle(orderId, record, _none());
        assertEq(IMD.balanceOf(payrollAt) - thereBefore, price / 10);
        assertEq(IMD.balanceOf(runner) - runnerBefore, price - price / 10 + bell.BOND());
        assertEq(IMD.allowance(address(desk), payrollAt), 0);
        assertEq(bell.receipts(), 1);
    }
}
