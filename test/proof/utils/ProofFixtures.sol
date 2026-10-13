// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Loads the real work records under `test/fixtures/proof`.
/// @dev Every expected value read here was derived outside Solidity (by `build_fixtures.py` in that
/// folder; see the `about` field of `index.json`), so a test that compares the contract's answer with
/// it compares two implementations.
///
/// A record is stored as hexadecimal text of the bytes IdentityMD served, so the folder holds data
/// and no third-party prose. Nothing is taken on trust for that: `WorkProofFixturesTest` hashes the
/// decoded bytes of every fixture and compares with the hash in the index, and the fork suite
/// compares the same hash with the real WorkRegistry.
abstract contract ProofFixtures is Test {
    using stdJson for string;

    struct Fixture {
        string file;
        bytes record;
        bytes16 jobId;
        bytes32 recordHash;
        bytes32 onChainLatest;
        bool isLatest;
        string kind;
        string state;
        bytes32 kindHash;
        bytes32 stateHash;
        bytes32 objectiveHash;
        uint256 objectiveStart;
        uint256 objectiveRawLen;
        uint256 scanStopsAt;
        uint256[] agentIds;
    }

    string internal constant FIXTURE_DIR = "test/fixtures/proof/";
    /// @dev The reference job of `README.md`; its receipt is quoted there.
    bytes16 internal constant REFERENCE_JOB = 0xe9efec1656f340d3924352c453effc7d;
    bytes32 internal constant REFERENCE_RECEIPT = 0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5;

    function _index() internal view returns (string memory) {
        return vm.readFile(string.concat(FIXTURE_DIR, "index.json"));
    }

    function _count(string memory index) internal pure returns (uint256) {
        return index.readUint(".count");
    }

    function _fixture(string memory index, uint256 i) internal view returns (Fixture memory f) {
        string memory at = string.concat(".fixtures[", vm.toString(i), "]");
        f.file = index.readString(string.concat(at, ".file"));
        f.record = vm.parseBytes(vm.readFile(string.concat(FIXTURE_DIR, f.file)));
        f.jobId = bytes16(index.readBytes(string.concat(at, ".jobIdBytes16")));
        f.recordHash = index.readBytes32(string.concat(at, ".recordHash"));
        f.onChainLatest = index.readBytes32(string.concat(at, ".onChainLatest"));
        f.isLatest = index.readBool(string.concat(at, ".isLatest"));
        f.kind = index.readString(string.concat(at, ".kind"));
        f.state = index.readString(string.concat(at, ".state"));
        f.kindHash = index.readBytes32(string.concat(at, ".kindHash"));
        f.stateHash = index.readBytes32(string.concat(at, ".stateHash"));
        f.objectiveHash = index.readBytes32(string.concat(at, ".objectiveHash"));
        f.objectiveStart = index.readUint(string.concat(at, ".objectiveStart"));
        f.objectiveRawLen = index.readUint(string.concat(at, ".objectiveRawLen"));
        f.scanStopsAt = index.readUint(string.concat(at, ".scanStopsAt"));
        f.agentIds = index.readUintArray(string.concat(at, ".agentIds"));
    }

    /// @dev The fixture for the reference job.
    function _reference() internal view returns (Fixture memory f) {
        f = _fixture(_index(), 0);
        assertEq(f.jobId, REFERENCE_JOB, "fixture 0 is the reference job");
    }

    /// @dev keccak256 of `len` bytes of `data` starting at `from`.
    function _sliceHash(bytes memory data, uint256 from, uint256 len) internal pure returns (bytes32 h) {
        require(from + len <= data.length, "slice out of range");
        assembly ("memory-safe") {
            h := keccak256(add(add(data, 0x20), from), len)
        }
    }
}
