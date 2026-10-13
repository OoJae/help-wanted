// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IWorkProof} from "../../src/interfaces/IWorkProof.sol";
import {IWorkRegistry} from "../../src/interfaces/external/IWorkRegistry.sol";
import {Mainnet} from "../../src/interfaces/external/Mainnet.sol";
import {WorkProof} from "../../src/proof/WorkProof.sol";

/// @notice The real job that carried a HELP WANTED order header (see
/// `test/proof/WorkProof.headerJob.t.sol`), asked of IdentityMD's real WorkRegistry on a fork of mainnet.
/// @dev The receipt for this job was queued at IdentityMD, not yet written on chain, when the record was
/// saved on 13 October 2026. The test holds either way and says which case it met: with no receipt the
/// proof is refused; once the registry holds the record's hash, the proof passes and returns the header.
/// It skips itself when the RPC endpoint cannot be reached.
contract HeaderJobForkTest is Test {
    bytes16 internal constant JOB = bytes16(0xe70c56ce60f04c2cb41367e5ae37ddce);
    bytes32 internal constant RECORD_HASH = 0x990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d;
    string internal constant HEADER =
        "[help-wanted order de7eddaacedc4110cb3ca3388ecec4dae5bda3eae85c721452c078dc71592041] ";

    function test_fork_headerJobProvesExactlyWhenItsReceiptIsOnChain() public {
        try vm.createSelectFork(vm.rpcUrl("mainnet")) returns (uint256) {}
        catch {
            vm.skip(true);
            return;
        }
        if (Mainnet.WORK_REGISTRY.code.length == 0) {
            vm.skip(true);
            return;
        }
        WorkProof proof = new WorkProof(Mainnet.WORK_REGISTRY);
        bytes memory record = vm.readFileBinary("test/fixtures/proof/header-job/record.json");
        bytes32 latest = IWorkRegistry(Mainnet.WORK_REGISTRY).latest(JOB);

        if (latest == bytes32(0)) {
            console2.log("header job: no receipt on chain yet; the proof is refused, as it must be");
            vm.expectRevert(abi.encodeWithSelector(IWorkProof.NoReceipt.selector, JOB));
            proof.prove(JOB, record, 85);
        } else if (latest == RECORD_HASH) {
            console2.log("header job: receipt on chain; proven against the real WorkRegistry");
            IWorkProof.Proof memory p = proof.prove(JOB, record, 85);
            assertEq(p.headHash, keccak256(bytes(HEADER)));
            assertEq(p.kindHash, keccak256("skill:research-report"));
            assertEq(p.stateHash, keccak256("completed"));
        } else {
            console2.log("header job: the registry holds a newer receipt than the saved record");
            vm.expectRevert(abi.encodeWithSelector(IWorkProof.HashMismatch.selector, latest, RECORD_HASH));
            proof.prove(JOB, record, 85);
        }
    }
}
