// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The contract side of the scanner's differential run. Not part of any launch: `run.sh` copies this
// file, with `JsonScan.sol`, `WorkProof.sol` and `IWorkProof.sol` from launches/b-desk, into a
// throwaway Foundry project outside the repository and runs it there.
//
// It calls `WorkProof.scan` on every case in data/cases.json and writes one line per case to
// data/sol-results.txt: `ok:` and the keccak256 of everything the scan returned, or `err:` and the
// revert data. The TypeScript scanner in packages/shared must give the same line for each.

import {Test} from "forge-std/Test.sol";
import {WorkProof} from "../src/proof/WorkProof.sol";
import {IWorkProof} from "../src/interfaces/IWorkProof.sol";

contract DiffTest is Test {
    function test_diff() public {
        WorkProof wp = new WorkProof(address(0xdead));
        string memory json = vm.readFile("./data/cases.json");
        bytes[] memory cases = vm.parseJsonBytesArray(json, ".cases");
        uint256[] memory heads = vm.parseJsonUintArray(json, ".heads");
        string memory out = "";
        for (uint256 i = 0; i < cases.length; i++) {
            string memory line;
            try wp.scan(cases[i], heads[i]) returns (bytes16 jobId, IWorkProof.Proof memory p) {
                line = string.concat(
                    "ok:",
                    vm.toString(keccak256(abi.encode(jobId, p.recordHash, p.kindHash, p.headHash, p.specHash, p.stateHash, p.agentIds)))
                );
            } catch (bytes memory err) {
                line = string.concat("err:", vm.toString(err));
            }
            out = string.concat(out, line, "\n");
            if (i % 200 == 199) {
                vm.writeLine("./data/sol-results.txt", out);
                out = "";
            }
        }
        if (bytes(out).length != 0) vm.writeLine("./data/sol-results.txt", out);
    }
}
