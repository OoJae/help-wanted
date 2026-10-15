// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {Endowments} from "../../../src/endowments/Endowments.sol";
import {IWorkOrders} from "../../../src/interfaces/IWorkOrders.sol";
import {Mainnet} from "../../../src/interfaces/external/Mainnet.sol";
import {EarlierLaunches} from "../../kit/EarlierLaunches.sol";
import {Rules} from "../../../src/rules/Rules.sol";
import {Zap} from "../../../src/rules/Zap.sol";
import {ILivePots, ILiveQuestions} from "../../kit/LiveSiblings.sol";
import {Bytecode} from "../Bytecode.sol";
import {LaunchDoc} from "../LaunchDoc.sol";
import {LaunchManifest} from "../LaunchManifest.sol";

/// @title The ProjectFactory, as the launch deployer calls it for an `evm_contracts` launch
/// @notice Ethereum mainnet `0xfF03410d0Fe5fa8f7F59F743de35E333D9857120`. The shapes are taken from
/// the factory's verified ABI and from a real launch of this kind (launch 1240, transaction
/// `0x93a1b0cce64e04d4bd7edd7b5fb6e6268b1fd5ab68fb5b990e66c56e972d71a3`).
interface IProjectFactoryLike {
    /// @dev What the factory writes to its launch registry about the launch.
    struct LaunchRecord {
        /// `"evm_contracts"`, ASCII padded with zeros on the right.
        bytes32 kind;
        uint64 launchNumber;
        uint64 recordedAt;
        /// The 20-byte git commit of the source, left-aligned.
        bytes32 sourceCommit;
        bytes32 manifestHash;
        bytes32 attestationHash;
        bytes32 verifierKey;
        string sourceRepoUrl;
    }

    struct ContractsParams {
        uint64 launchNumber;
        /// One initcode per contract (creation code followed by its constructor arguments), in
        /// manifest order.
        bytes[] contractCreationCodes;
        bytes32[] contractNames;
        /// The addresses the factory must produce; it reverts if it produces any other.
        address[] expectedContracts;
        LaunchRecord record;
        /// The ERC-8004 ids of the agents that worked on the launch.
        uint256[] agentIds;
    }

    event ContractsLaunched(uint64 indexed launchNumber, address[] contracts);

    error NotDeployer();
    error AlreadyLaunched(uint64 launchNumber);
    error ContractAddressMismatch(uint256 index, address expected, address actual);

    function launchContracts(ContractsParams calldata p) external returns (address[] memory contracts);

    function predictContract(uint64 launchNumber, uint256 index, bytes calldata code) external view returns (address);

    function deploymentBlock(uint64 launchNumber) external view returns (uint256);

    function deployer() external view returns (address);
}

/// @dev Launch C rehearsed through the real ProjectFactory on a fork of Ethereum mainnet, called by
/// the launch deployer exactly as the pipeline will call it: one transaction, the three initcodes of
/// the manifest in order, zero ETH, nothing called afterwards.
///
/// Everything here is real: the factory, its launch registry, the deployer's address, IMD, sIMD, the
/// Uniswap v4 PoolManager and the ETH/IMD pool, and the contracts of launches A and B at the
/// addresses the document's manifest names (IdentityMD launches 1531 and 1573, live since 13
/// October 2026). The rehearsal deploys this launch from the document's manifest against them.
///
/// Nothing asserts a number that drifts, apart from the code sizes and code hashes of the three
/// contracts of the earlier launches, which cannot change: none of them can be upgraded or
/// destroyed. Every test skips itself when the RPC cannot be reached; a reachable node on which the
/// manifest names an address without code fails.
contract LaunchCForkTest is LaunchDoc {
    IProjectFactoryLike internal constant FACTORY = IProjectFactoryLike(Mainnet.PROJECT_FACTORY);
    IERC20 internal constant IMD = IERC20(Mainnet.IMD);
    IERC4626 internal constant SIMD = IERC4626(Mainnet.SIMD);

    uint256 internal constant GATE_GAS = 12_000_000;
    uint256 internal constant NO_DEADLINE = type(uint256).max;

    bool internal forked;
    LaunchManifest.Literals internal lit;
    uint64 internal launchNumber;

    address internal user = makeAddr("launch rehearsal user");
    address internal keeper = makeAddr("launch rehearsal keeper");

    /// @dev What the three contracts of the earlier launches are, read from mainnet on 15 October
    /// 2026 (`cast codesize`, and `cast keccak $(cast code …)`).
    uint256 internal constant QUESTIONS_CODE_SIZE = 22_233;
    bytes32 internal constant QUESTIONS_CODE_HASH = 0xf876f5265e4ae5015645fbbee2c47e280391c23fc8256b46b688688a388618f7;
    uint256 internal constant WORK_ORDERS_CODE_SIZE = 19_289;
    bytes32 internal constant WORK_ORDERS_CODE_HASH =
        0xb06dfaf6410132828e12647f4ee5199a092f8c0fb9f0c0d2275b5f655262ffb3;
    uint256 internal constant CROWD_POTS_CODE_SIZE = 14_177;
    bytes32 internal constant CROWD_POTS_CODE_HASH = 0x282560809f9474cbb416a8d6235fac38fe2679ff3e729a87ff88859006beb1c2;

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("mainnet")) {
            forked = true;
        } catch {
            return;
        }

        lit = _literals();
        // A manifest that names an address with no code would deploy, and then never work.
        require(lit.questions.code.length != 0, "docs/LAUNCH.md: nothing is deployed at the Questions address");
        require(lit.workOrders.code.length != 0, "docs/LAUNCH.md: nothing is deployed at the WorkOrders address");
        require(lit.crowdPots.code.length != 0, "docs/LAUNCH.md: nothing is deployed at the CrowdPots address");

        // A launch number nobody has used. The factory refuses to launch a number twice.
        launchNumber = 4_000_000_000 + uint64(vm.getBlockNumber());
        while (FACTORY.deploymentBlock(launchNumber) != 0) ++launchNumber;

        vm.deal(user, 10 ether);
        deal(Mainnet.IMD, user, 50_000e18);
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true, "mainnet RPC not reachable");
            return;
        }
        _;
    }

    function _params() internal view returns (IProjectFactoryLike.ContractsParams memory p) {
        p.launchNumber = launchNumber;
        p.contractCreationCodes = LaunchManifest.initcodes(lit);
        p.contractNames = new bytes32[](LaunchManifest.CONTRACTS);
        p.expectedContracts = new address[](LaunchManifest.CONTRACTS);
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            p.contractNames[i] = LaunchManifest.nameWord(i);
            p.expectedContracts[i] = FACTORY.predictContract(launchNumber, i, p.contractCreationCodes[i]);
        }
        p.record.kind = bytes32("evm_contracts");
        p.record.launchNumber = launchNumber;
        // The pipeline fills these from the imported repository and its own attestation. The factory
        // records them; it does not interpret them.
        p.record.sourceCommit = bytes32(bytes20(keccak256("help-wanted launch C rehearsal commit")));
        p.record.manifestHash = keccak256("help-wanted launch C rehearsal manifest");
        p.record.attestationHash = keccak256("help-wanted launch C rehearsal attestation");
        p.record.verifierKey = keccak256("help-wanted launch C rehearsal verifier");
        p.record.sourceRepoUrl = "https://github.com/help-wanted/launch-c-company";
        // One of the agent ids that worked on launch 1240; it is bound to a seat.
        p.agentIds = new uint256[](1);
        p.agentIds[0] = 52211;
    }

    function _launch() internal returns (Rules rules, Endowments endowments, Zap zap, uint256 gasUsed) {
        return _launch(_params());
    }

    function _launch(IProjectFactoryLike.ContractsParams memory p)
        internal
        returns (Rules rules, Endowments endowments, Zap zap, uint256 gasUsed)
    {
        // Encoded before the clock starts and sent as a plain call, so that what is measured is the
        // factory's work and not this test's own handling of 32 KB of arguments.
        bytes memory data = abi.encodeCall(IProjectFactoryLike.launchContracts, (p));
        vm.prank(Mainnet.LAUNCH_DEPLOYER);
        uint256 gasBefore = gasleft();
        (bool ok, bytes memory answer) = address(FACTORY).call(data);
        gasUsed = gasBefore - gasleft();
        assertTrue(ok, "launchContracts reverted");
        address[] memory out = abi.decode(answer, (address[]));
        assertEq(out.length, LaunchManifest.CONTRACTS);
        return (Rules(out[0]), Endowments(out[1]), Zap(out[2]), gasUsed);
    }

    function _intrinsicGas(bytes memory data) internal pure returns (uint256 gas) {
        gas = 21_000;
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// @dev The factory is the one IdentityMD's launch guidance names, and its deployer is the launch deployer.
    function test_fork_launch_theFactoryAndItsDeployerAreTheOnesWeExpect() public onFork {
        assertGt(Mainnet.PROJECT_FACTORY.code.length, 0);
        assertEq(FACTORY.deployer(), Mainnet.LAUNCH_DEPLOYER);
        assertEq(FACTORY.deploymentBlock(launchNumber), 0, "the rehearsal's launch number is unused");
        // A real launch of this kind is on record.
        assertGt(FACTORY.deploymentBlock(1240), 0);
    }

    /// @dev The launch itself: the deployer calls `launchContracts` once with the manifest's three
    /// initcodes. The factory creates all three at the addresses it predicted, in manifest order, for
    /// less gas than our gate, and each contract reports the manifest's arguments.
    function test_fork_launch_throughTheRealFactoryAsTheLaunchDeployer() public onFork {
        IProjectFactoryLike.ContractsParams memory p = _params();
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            assertEq(p.expectedContracts[i].code.length, 0, "something already lives at a predicted address");
        }

        vm.expectEmit(true, true, true, true, address(FACTORY));
        emit IProjectFactoryLike.ContractsLaunched(launchNumber, p.expectedContracts);
        (Rules rules, Endowments endowments, Zap zap, uint256 gasUsed) = _launch(p);

        assertEq(address(rules), p.expectedContracts[0]);
        assertEq(address(endowments), p.expectedContracts[1]);
        assertEq(address(zap), p.expectedContracts[2]);
        assertEq(FACTORY.deploymentBlock(launchNumber), vm.getBlockNumber());

        uint256 initcodeTotal;
        for (uint256 i; i < LaunchManifest.CONTRACTS; ++i) {
            initcodeTotal += p.contractCreationCodes[i].length;
            bytes memory runtime = p.expectedContracts[i].code;
            assertGt(runtime.length, 0);
            assertLe(runtime.length, 23_000);
            assertEq(Bytecode.forbidden(runtime), 0, "a forbidden instruction in a launched runtime");
        }
        // What the call costs before it runs: the transaction's base cost and its calldata, which
        // carries all three initcodes (16 gas for each byte that is not zero, 4 for each that is).
        uint256 intrinsic = _intrinsicGas(abi.encodeCall(IProjectFactoryLike.launchContracts, (p)));
        emit log_named_uint("launch number used for the rehearsal", launchNumber);
        emit log_named_uint("initcode bytes, whole launch", initcodeTotal);
        emit log_named_uint("gas used by launchContracts", gasUsed);
        emit log_named_uint("gas for the transaction's base cost and calldata", intrinsic);
        emit log_named_uint("gas, whole transaction", gasUsed + intrinsic);
        emit log_named_uint("gas per initcode byte, whole transaction", (gasUsed + intrinsic) / initcodeTotal);
        assertLe(gasUsed + intrinsic, GATE_GAS, "the launch is over our gas gate of 12M");
        // Storing code alone costs 200 gas a byte: a figure below that was not measured at all. And a
        // real launch of this kind (launch 1240) used 240.5 gas for each byte of initcode, all in:
        // the rehearsal should be within a twentieth of that.
        uint256 perByte = (gasUsed + intrinsic) / initcodeTotal;
        assertGt(
            gasUsed, 200 * (address(rules).code.length + address(endowments).code.length + address(zap).code.length)
        );
        assertGt(perByte, 228, "far cheaper per byte than a real launch: was it measured?");
        assertLt(perByte, 253, "far dearer per byte than a real launch");

        assertEq(address(rules.IMD()), Mainnet.IMD);
        assertEq(address(rules.WORK_ORDERS()), lit.workOrders);
        assertEq(address(endowments.IMD()), Mainnet.IMD);
        assertEq(address(endowments.SIMD()), Mainnet.SIMD);
        assertEq(address(endowments.QUESTIONS()), lit.questions);
        assertEq(address(endowments.CROWD_POTS()), lit.crowdPots);
        assertEq(address(zap.IMD()), Mainnet.IMD);
        assertEq(address(zap.POOL_MANAGER()), Mainnet.POOL_MANAGER);
        assertEq(address(zap.CROWD_POTS()), lit.crowdPots);
        assertEq(address(zap.QUESTIONS()), lit.questions);
        assertEq(zap.POOL_ID(), 0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3);
        // Nothing was called after deployment and nothing needs to be: no contract holds anything yet.
        assertEq(rules.ruleCount(), 0);
        assertEq(endowments.endowmentCount(), 0);
        assertEq(IMD.balanceOf(address(rules)), 0);
        assertEq(IMD.balanceOf(address(endowments)), 0);
    }

    /// @dev Only the launch deployer can launch, a number launches once, and the factory refuses a
    /// launch whose addresses are not the ones it would produce.
    function test_fork_launch_theFactoryRefusesAnyoneElseAndAnySecondTime() public onFork {
        IProjectFactoryLike.ContractsParams memory p = _params();

        vm.prank(user);
        vm.expectRevert(IProjectFactoryLike.NotDeployer.selector);
        FACTORY.launchContracts(p);

        address right = p.expectedContracts[2];
        p.expectedContracts[2] = address(0xBEEF);
        vm.prank(Mainnet.LAUNCH_DEPLOYER);
        vm.expectRevert(
            abi.encodeWithSelector(IProjectFactoryLike.ContractAddressMismatch.selector, 2, address(0xBEEF), right)
        );
        FACTORY.launchContracts(p);
        p.expectedContracts[2] = right;

        vm.prank(Mainnet.LAUNCH_DEPLOYER);
        FACTORY.launchContracts(p);
        vm.prank(Mainnet.LAUNCH_DEPLOYER);
        vm.expectRevert(abi.encodeWithSelector(IProjectFactoryLike.AlreadyLaunched.selector, launchNumber));
        FACTORY.launchContracts(p);
    }

    /// @dev The three contracts, as the factory left them, each used once with real money: Zap swaps on
    /// the real ETH/IMD pool, Endowments stakes into the real sIMD and pays every wei back, and a rule
    /// that watches the real vault pays out in real IMD.
    function test_fork_launch_theLaunchedContractsWorkAgainstTheRealProtocol() public onFork {
        (Rules rules, Endowments endowments, Zap zap,) = _launch();
        uint256 deadline = vm.getBlockTimestamp() + 10 minutes;

        // ---- Zap
        // An address can hold dust before anything is deployed to it; Zap passes it to its first caller.
        uint256 imdBefore = IMD.balanceOf(user) + IMD.balanceOf(address(zap));
        uint256 ethBefore = user.balance + address(zap).balance;
        uint256 late = vm.getBlockTimestamp() - 1;
        vm.startPrank(user);
        uint256 bought = zap.buy{value: 0.01 ether}(1, deadline);
        assertGt(bought, 0);
        assertEq(IMD.balanceOf(user), imdBefore + bought);
        assertGe(user.balance, ethBefore - 0.01 ether);
        assertEq(IMD.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);
        vm.expectRevert(abi.encodeWithSelector(Zap.DeadlinePassed.selector, late));
        zap.buy{value: 0.01 ether}(1, late);
        vm.stopPrank();

        // ---- Endowments
        address recipient = makeAddr("launch rehearsal recipient");
        vm.startPrank(user);
        IMD.approve(address(endowments), type(uint256).max);
        uint256 id = endowments.createForRecipient(recipient);
        endowments.deposit(id, 10_000e18);
        uint256 next = endowments.nextStakeBlock();
        if (vm.getBlockNumber() < next) vm.roll(next);
        uint256 vaultBefore = SIMD.totalAssets();
        endowments.stake();
        assertEq(SIMD.totalAssets(), vaultBefore + 10_000e18 + endowments.SEED());
        vm.roll(vm.getBlockNumber() + 1);
        assertTrue(endowments.isWhole(id));
        uint256 before = IMD.balanceOf(user);
        endowments.withdraw(id, 10_000e18);
        assertEq(IMD.balanceOf(user), before + 10_000e18, "principal comes back to the wei");
        vm.stopPrank();

        // ---- Rules: WHEN sIMD holds any IMD at all THEN PAY 2 IMD
        Rules.RuleParams memory p;
        p.when.kind = 1;
        p.when.cmp = 3;
        p.when.target = Mainnet.SIMD;
        p.when.threshold = 0;
        p.when.data = abi.encodeCall(IERC4626.totalAssets, ());
        p.action = 2;
        p.pay = Rules.Pay({recipient: recipient, amount: 2e18});
        p.tip = 0.05e18;
        p.maxFires = 1;
        vm.startPrank(user);
        IMD.approve(address(rules), type(uint256).max);
        uint256 ruleId = rules.createRule(p, "", 2.05e18);
        vm.stopPrank();
        assertTrue(rules.canFire(ruleId));
        uint256 keeperBefore = IMD.balanceOf(keeper);
        uint256 recipientBefore = IMD.balanceOf(recipient);
        vm.prank(keeper);
        rules.fire(ruleId, "");
        assertEq(IMD.balanceOf(recipient), recipientBefore + 2e18);
        assertEq(IMD.balanceOf(keeper), keeperBefore + 0.05e18);
        assertEq(rules.totalEscrowed(), 0);
    }

    /// @dev The same three, as the factory created them, reach the live contracts of launches A and
    /// B through the addresses the manifest gave them: a chip in a pot opened on the live CrowdPots
    /// and meter shares on the live payrolls feed, both bought with ETH in the caller's name, and a
    /// HIRE rule's order on the live desk, withdrawn again by the rule's creator.
    function test_fork_launch_theLaunchedContractsReachTheLiveQuestionsPotsAndDesk() public onFork {
        (Rules rules,, Zap zap,) = _launch();
        uint256 deadline = vm.getBlockTimestamp() + 10 minutes;
        ILivePots pots = ILivePots(lit.crowdPots);
        ILiveQuestions questions = ILiveQuestions(lit.questions);
        IWorkOrders desk = IWorkOrders(lit.workOrders);

        // A pot on the live CrowdPots that needs more than 0.01 ETH buys.
        ILivePots.Terms memory t;
        t.kind = "skill:research-report";
        t.target = 1_000e18;
        t.minPay = 1_000e18;
        t.bond = desk.MIN_BOND();
        t.deliverySecs = desk.MIN_DELIVERY();
        t.hireSecs = 1 days;
        t.fundSecs = 1 days;
        uint256 potId = pots.openPot(t, "Write a one-page summary of the IMD staking vault's week, with sources.", 0);

        vm.startPrank(user);
        (uint256 imdOut, uint256 chipped) = zap.chipIn{value: 0.01 ether}(potId, 1, deadline);
        assertEq(chipped, imdOut);
        (uint256 chip,,) = pots.chipOf(potId, user);
        assertEq(chip, chipped, "the chip is the caller's");
        if (questions.costOf(EarlierLaunches.PAYROLLS_FEED) != 0) {
            uint256 before = questions.sharesOf(EarlierLaunches.PAYROLLS_FEED, user);
            (, uint256 shares) = zap.fundMeter{value: 0.01 ether}(EarlierLaunches.PAYROLLS_FEED, 1, deadline);
            assertEq(
                questions.sharesOf(EarlierLaunches.PAYROLLS_FEED, user) - before, shares, "the shares are the caller's"
            );
            assertEq(questions.sharesOf(EarlierLaunches.PAYROLLS_FEED, address(zap)), 0);
        }
        assertEq(IMD.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);

        // WHEN sIMD holds at least what it holds now THEN HIRE, on the live desk.
        Rules.RuleParams memory p;
        p.when.kind = 1;
        p.when.cmp = 1;
        p.when.target = Mainnet.SIMD;
        p.when.threshold = SIMD.totalAssets();
        p.when.data = abi.encodeCall(IERC4626.totalAssets, ());
        p.action = 1;
        p.hire.kindHash = keccak256("skill:research-report");
        p.hire.minPay = 0.56e18;
        p.hire.maxPay = 0.6e18;
        p.hire.rampSecs = 1 days;
        p.hire.deliverySecs = 7 days;
        p.hire.bond = desk.MIN_BOND();
        p.hire.flags = 2;
        p.hire.orderTtl = 3 days;
        p.tip = 0.01e18;
        p.maxFires = 1;
        bytes memory spec = "Write a one-page summary of who staked IMD this week, with every figure sourced.";
        IMD.approve(address(rules), type(uint256).max);
        uint256 ruleId = rules.createRule(p, spec, 0.61e18);
        vm.stopPrank();

        uint256 deskBefore = IMD.balanceOf(lit.workOrders);
        vm.prank(keeper);
        uint256 orderId = rules.fire(ruleId, spec);
        (IWorkOrders.State state, address employer, uint96 escrow,,) = desk.accountOf(orderId);
        assertEq(uint8(state), uint8(IWorkOrders.State.Open));
        assertEq(employer, address(rules), "the launched Rules is the employer on the live desk");
        assertEq(escrow, 0.6e18);
        assertEq(IMD.balanceOf(lit.workOrders), deskBefore + 0.6e18);

        vm.prank(user);
        assertEq(rules.recall(ruleId, orderId), 0.6e18);
        vm.prank(user);
        assertEq(rules.cancel(ruleId), 0.6e18);
        assertEq(rules.totalEscrowed(), 0);
    }

    // ------------------------------------------------------------------------------------------
    // The addresses of the earlier launches, against the factory's own record
    // ------------------------------------------------------------------------------------------

    /// @dev The receipt of a launch transaction as the node serves it (`eth_getTransactionReceipt`,
    /// through Foundry's `rpc` cheatcode, which returns it ABI-encoded).
    function _receipt(bytes32 txHash) internal returns (bytes memory) {
        return vm.rpc("eth_getTransactionReceipt", string.concat('["', vm.toString(txHash), '"]'));
    }

    /// @dev True when `needle` stands in `haystack` at a word boundary. The receipt's logs are
    /// ABI-encoded, so a log's topics and its data each begin on one.
    function _holds(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || needle.length > haystack.length) return false;
        bytes32 want = keccak256(needle);
        for (uint256 at; at + needle.length <= haystack.length; at += 32) {
            bytes32 got;
            uint256 n = needle.length;
            assembly ("memory-safe") {
                got := keccak256(add(add(haystack, 0x20), at), n)
            }
            if (got == want) return true;
        }
        return false;
    }

    /// @dev The receipt of launch `number`'s transaction holds the factory's `ContractsLaunched`
    /// event for that number, and that event's data is exactly `contracts`, in that order.
    function _assertLaunched(bytes32 txHash, uint64 number, uint256 blockNumber, address[] memory contracts) internal {
        assertEq(FACTORY.deploymentBlock(number), blockNumber, "the factory records the launch at another block");
        bytes memory receipt = _receipt(txHash);
        assertGt(receipt.length, 0, "the node served no receipt");
        assertTrue(
            _holds(receipt, abi.encodePacked(IProjectFactoryLike.ContractsLaunched.selector, uint256(number))),
            "the transaction emitted no ContractsLaunched event for this launch number"
        );
        assertTrue(_holds(receipt, abi.encode(contracts)), "the factory's event names other contracts");
    }

    /// @dev Each address the manifest gives for an earlier launch is the address the factory's
    /// `ContractsLaunched` event of that launch names, in its place: the transactions are the ones
    /// `Mainnet.sol` records for launches 1531 and 1573, read again from the node. Code lives at each
    /// address, with the size and hash read on 15 October 2026, and each contract is wired as its
    /// launch's manifest says: the desk and the pots price in IMD, the pots order through the desk,
    /// the desk pays the Payroll of launch A, and that Payroll names this Questions.
    function test_fork_manifest_theEarlierLaunchesAreTheOnesTheFactoryRecorded() public onFork {
        assertEq(lit.questions, Mainnet.QUESTIONS);
        assertEq(lit.workOrders, Mainnet.WORK_ORDERS);
        assertEq(lit.crowdPots, Mainnet.CROWD_POTS);

        address[] memory a = new address[](3);
        a[0] = lit.questions;
        a[1] = EarlierLaunches.JOBS_REPORT;
        a[2] = Mainnet.PAYROLL;
        _assertLaunched(EarlierLaunches.LAUNCH_A_TX, EarlierLaunches.LAUNCH_A, EarlierLaunches.LAUNCH_A_BLOCK, a);

        address[] memory b = new address[](4);
        b[0] = EarlierLaunches.WORK_PROOF;
        b[1] = lit.workOrders;
        b[2] = lit.crowdPots;
        b[3] = EarlierLaunches.DOORBELL;
        _assertLaunched(EarlierLaunches.LAUNCH_B_TX, EarlierLaunches.LAUNCH_B, EarlierLaunches.LAUNCH_B_BLOCK, b);

        assertEq(lit.questions.code.length, QUESTIONS_CODE_SIZE);
        assertEq(lit.questions.codehash, QUESTIONS_CODE_HASH);
        assertEq(lit.workOrders.code.length, WORK_ORDERS_CODE_SIZE);
        assertEq(lit.workOrders.codehash, WORK_ORDERS_CODE_HASH);
        assertEq(lit.crowdPots.code.length, CROWD_POTS_CODE_SIZE);
        assertEq(lit.crowdPots.codehash, CROWD_POTS_CODE_HASH);

        assertEq(ILiveQuestions(lit.questions).IMD(), Mainnet.IMD);
        assertEq(IWorkOrders(lit.workOrders).IMD(), Mainnet.IMD);
        assertEq(ILivePots(lit.crowdPots).IMD(), Mainnet.IMD);
        assertEq(ILivePots(lit.crowdPots).WORK_ORDERS(), lit.workOrders);
        (bool ok, bytes memory answer) = lit.workOrders.staticcall(abi.encodeWithSignature("PAYROLL()"));
        assertTrue(ok);
        assertEq(abi.decode(answer, (address)), Mainnet.PAYROLL);
        (ok, answer) = Mainnet.PAYROLL.staticcall(abi.encodeWithSignature("QUESTIONS()"));
        assertTrue(ok);
        assertEq(abi.decode(answer, (address)), lit.questions);
    }
}
