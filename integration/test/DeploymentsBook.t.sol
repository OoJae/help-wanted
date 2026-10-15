// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Mainnet} from "c-company/src/interfaces/external/Mainnet.sol";
import {EarlierLaunches} from "c-company/test/kit/EarlierLaunches.sol";

/// @dev The HELP WANTED repository keeps one book of where its launched contracts live
/// (`packages/shared/src/deployments.ts`), which its bots, its site and its evidence read. The
/// addresses this launch's manifest gives for launches A and B are the ones `Mainnet.sol` records
/// (the main project's `test_manifest_*` tests), and the fork suite checks `Mainnet.sol` against the
/// factory's own events. This test closes the loop: `Mainnet.sol` and `EarlierLaunches.sol` record
/// what the book records, for every contract, transaction, block and launch number of both launches. Like the rest of this
/// folder it runs only inside that repository.
contract DeploymentsBookTest is Test {
    string internal constant BOOK = "../../../packages/shared/src/deployments.ts";
    uint256 internal constant NOT_FOUND = type(uint256).max;

    /// @dev The 42 characters after `key` in the book, which must be a quoted address.
    function _addressAfter(string memory book, string memory key) internal pure returns (string memory) {
        uint256 at = vm.indexOf(book, key);
        require(at != NOT_FOUND, string.concat("the deployments book has no entry ", key));
        bytes memory b = bytes(book);
        bytes memory out = new bytes(42);
        for (uint256 i; i < 42; ++i) {
            out[i] = b[at + bytes(key).length + i];
        }
        return string(out);
    }

    function _same(string memory book, string memory key, address want) internal pure {
        assertEq(_addressAfter(book, key), vm.toLowercase(vm.toString(want)), key);
    }

    function test_book_recordsWhatTheTestsRecordForLaunchesAAndB() public view {
        string memory book = vm.toLowercase(vm.readFile(BOOK));

        _same(book, 'questions: "', Mainnet.QUESTIONS);
        _same(book, 'jobsreport: "', EarlierLaunches.JOBS_REPORT);
        _same(book, 'payroll: "', Mainnet.PAYROLL);
        _same(book, 'workproof: "', EarlierLaunches.WORK_PROOF);
        _same(book, 'workorders: "', Mainnet.WORK_ORDERS);
        _same(book, 'crowdpots: "', Mainnet.CROWD_POTS);
        _same(book, 'doorbell: "', EarlierLaunches.DOORBELL);

        assertTrue(vm.contains(book, string.concat('transaction: "', vm.toString(EarlierLaunches.LAUNCH_A_TX), '"')));
        assertTrue(vm.contains(book, string.concat("block: ", vm.toString(EarlierLaunches.LAUNCH_A_BLOCK), ",")));
        assertTrue(
            vm.contains(book, string.concat("launchnumber: ", vm.toString(uint256(EarlierLaunches.LAUNCH_A)), ","))
        );
        assertTrue(vm.contains(book, string.concat('transaction: "', vm.toString(EarlierLaunches.LAUNCH_B_TX), '"')));
        assertTrue(vm.contains(book, string.concat("block: ", vm.toString(EarlierLaunches.LAUNCH_B_BLOCK), ",")));
        assertTrue(
            vm.contains(book, string.concat("launchnumber: ", vm.toString(uint256(EarlierLaunches.LAUNCH_B)), ","))
        );
    }

    /// @dev And the manifest in this launch's document names those addresses, in lower case as the
    /// book writes them.
    function test_book_theManifestNamesTheBooksAddresses() public view {
        string memory doc = vm.readFile("../docs/LAUNCH.md");
        string[] memory head = vm.split(doc, "<!-- manifest -->\n```json\n");
        require(head.length == 2, "docs/LAUNCH.md: no manifest block");
        string memory manifest = vm.split(head[1], "\n```")[0];
        string memory book = vm.toLowercase(vm.readFile(BOOK));
        string[3] memory keys = ['questions: "', 'workorders: "', 'crowdpots: "'];
        for (uint256 k; k < 3; ++k) {
            assertTrue(
                vm.contains(manifest, string.concat('"', _addressAfter(book, keys[k]), '"')),
                string.concat("the manifest does not name the book's ", keys[k])
            );
        }
    }
}
