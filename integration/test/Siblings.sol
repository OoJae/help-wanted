// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {QuestionsFixture} from "a-payroll/test/questions/QuestionsFixture.sol";
import {WorkOrders} from "b-desk/src/desk/WorkOrders.sol";
import {CrowdPots} from "b-desk/src/pots/CrowdPots.sol";
import {WorkProof} from "b-desk/src/proof/WorkProof.sol";
import {PayrollStandIn} from "b-desk/test/kit/PayrollStandIn.sol";
import {RecordMaker} from "b-desk/test/kit/RecordMaker.sol";
import {RegistryStandIn} from "b-desk/test/kit/RegistryStandIn.sol";
import {Endowments} from "c-company/src/endowments/Endowments.sol";
import {Rules} from "c-company/src/rules/Rules.sol";
import {Zap} from "c-company/src/rules/Zap.sol";
import {MockStakedIMD} from "c-company/test/endowments/mocks/MockStakedIMD.sol";
import {MockPoolManager} from "c-company/test/rules/mocks/MockPoolManager.sol";

/// @title Launch C beside the real contracts of launches A and B
/// @notice What every test of this folder starts from. Rules, Endowments and Zap are the sources of
/// this repository. The three contracts they are given at launch are the real ones, compiled from
/// the sibling projects:
///
/// - `Questions` (launch A), through that project's own test fixture: the real contract with one
///   added function that ends a transaction for the one-request-per-transaction flag, a test double
///   of the IdentityMD Intake, and a test key as the oracle signer;
/// - `WorkOrders` (launch B), with the real `WorkProof` behind it;
/// - `CrowdPots` (launch B), on that desk.
///
/// What is still a stand-in, because it belongs to nobody in this product: the IMD token, the sIMD
/// vault, the Uniswap PoolManager and IdentityMD's WorkRegistry (launch B's stand-in, which holds
/// whatever hash a test writes, as the real registry holds what its writer writes). Payroll, where
/// the desk sends its fee, is launch B's stand-in: launch C never touches it. The fork suite of the
/// main project uses the real IMD, sIMD and PoolManager.
abstract contract Siblings is QuestionsFixture {
    /// @dev The real sIMD's totals at mainnet block 26,164,296, as in the main project's tests.
    uint256 internal constant REAL_TOTAL_ASSETS = 1824332924627773926954268;
    uint256 internal constant REAL_TOTAL_SUPPLY = 229085987734110772074526144065;
    uint256 internal constant NO_DEADLINE = type(uint256).max;
    /// @dev A real IdentityMD work record stored by launch B: job e9efec16, kind
    /// `skill:research-report`, state `completed`, one signal naming agent 52211.
    string internal constant RECORD_FILE =
        "../../b-desk/test/fixtures/proof/records/e9efec16-skill-research-report-3db99325.hex";
    string internal constant KIND = "skill:research-report";
    bytes internal constant SPEC =
        "Audit the vault and list every finding. Inputs: repoUrl=https://example.org/vault; baseCommit=0123abcd";

    RegistryStandIn internal registry;
    WorkProof internal proof;
    PayrollStandIn internal payroll;
    WorkOrders internal desk;
    CrowdPots internal pots;
    MockStakedIMD internal simd;
    MockPoolManager internal pool;
    RecordMaker internal recordMaker;

    Rules internal rules;
    Endowments internal endow;
    Zap internal zap;

    address internal user = makeAddr("user");
    address internal heir = makeAddr("heir");
    address internal runner = makeAddr("runner");
    address internal challenger = makeAddr("challenger");
    /// @dev The feed launch A's fixture creates: a pinned uint256 feed, 0.5 IMD a request and a 0.01
    /// IMD keeper tip.
    bytes32 internal feed;

    function setUp() public virtual override {
        super.setUp();

        registry = new RegistryStandIn();
        proof = new WorkProof(address(registry));
        payroll = new PayrollStandIn(address(imd));
        desk = new WorkOrders(address(imd), address(proof), address(payroll));
        pots = new CrowdPots(address(imd), address(desk));
        recordMaker = new RecordMaker();

        simd = new MockStakedIMD(address(imd));
        simd.seed(makeAddr("whale"), REAL_TOTAL_SUPPLY);
        imd.mint(address(simd), REAL_TOTAL_ASSETS);
        pool = new MockPoolManager(address(imd));
        imd.mint(address(pool), 10_000_000e18);

        // Launch C, with the constructor arguments of its manifest, in manifest order.
        rules = new Rules(address(imd), address(desk));
        endow = new Endowments(address(imd), address(simd), address(q), address(pots));
        zap = new Zap(address(imd), address(pool), address(pots), address(q));

        feed = _createDefault();

        vm.deal(user, 100 ether);
        address[3] memory wallets = [user, runner, challenger];
        for (uint256 i; i < wallets.length; ++i) {
            imd.mint(wallets[i], 10_000_000e18);
            vm.startPrank(wallets[i]);
            imd.approve(address(endow), type(uint256).max);
            imd.approve(address(rules), type(uint256).max);
            imd.approve(address(q), type(uint256).max);
            imd.approve(address(pots), type(uint256).max);
            imd.approve(address(desk), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @dev The terms of a crowd pot that collects `target` for one job.
    function _terms(uint96 target) internal pure returns (CrowdPots.Terms memory t) {
        t.kind = KIND;
        t.target = target;
        t.minPay = target;
        t.rampSecs = 0;
        t.bond = 0.25e18;
        t.deliverySecs = 3 days;
        t.hireSecs = 2 days;
        t.fundSecs = 1 days;
    }

    /// @dev The unspent IMD on the feed's meter, as the real Questions reports it.
    function _meter() internal view returns (uint256 balance) {
        (balance,) = q.meterOf(feed);
    }

    /// @dev Stakes what Endowments has buffered and steps past the block in which sIMD holds it.
    function _stakeAndWait() internal {
        uint256 next = endow.nextStakeBlock();
        if (vm.getBlockNumber() < next) vm.roll(next);
        endow.stake();
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev Yield the way sIMD receives it: IMD sent to the vault by plain transfer.
    function _yieldBps(uint256 bps) internal {
        imd.mint(address(simd), simd.totalAssets() * bps / 10_000);
    }

    /// @dev The real record made into the record of `jobId` for the order's current claim: this
    /// claim's 85 header bytes followed by the spec as its objective, and the receipt written to
    /// the registry the way the real one holds it (keccak256 of the record's bytes).
    function _landReceipt(uint256 orderId, bytes16 jobId, string memory state) internal returns (bytes memory record) {
        bytes memory base = vm.parseBytes(vm.readFile(RECORD_FILE));
        bytes memory objective = bytes.concat(desk.headerOf(orderId), SPEC);
        record = recordMaker.recordOf(base, jobId, KIND, objective, state);
        registry.set(jobId, keccak256(record));
    }
}
