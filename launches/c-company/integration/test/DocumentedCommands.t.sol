// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Siblings} from "./Siblings.sol";

/// @dev The launch document tells an operator to ask the contracts of the two earlier launches a
/// few questions before their addresses are written into the manifest. The main project can only
/// hold those commands against the interface files it has. Here they are held against the real
/// contracts: every `cast call` and `cast send` line addressed to `$QUESTIONS`, `$DESK` or `$POTS`
/// names a function the real contract has, and the answers the document says to expect from the
/// desk are the answers the real desk gives.
contract DocumentedCommandsTest is Siblings {
    string internal constant LAUNCH_DOC = "../docs/LAUNCH.md";
    string internal constant README = "../README.md";
    uint256 internal constant NOT_FOUND = type(uint256).max;

    function _selectors(string memory name) internal view returns (bytes4[] memory selectors) {
        string memory artifact = vm.readFile(string.concat("out/", name, ".sol/", name, ".json"));
        string[] memory signatures = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        selectors = new bytes4[](signatures.length);
        for (uint256 i; i < signatures.length; ++i) {
            selectors[i] = bytes4(keccak256(bytes(signatures[i])));
        }
    }

    function _has(bytes4[] memory selectors, bytes4 selector) internal pure returns (bool) {
        for (uint256 i; i < selectors.length; ++i) {
            if (selectors[i] == selector) return true;
        }
        return false;
    }

    function _same(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (string memory) {
        bytes memory out = new bytes(to - from);
        for (uint256 i = from; i < to; ++i) {
            out[i - from] = b[i];
        }
        return string(out);
    }

    /// @dev How many commands of `doc` are addressed to one of the three sibling contracts; each
    /// must name a function of the real contract.
    function _check(
        string memory doc,
        bytes4[] memory questions,
        bytes4[] memory deskSelectors,
        bytes4[] memory potSelectors
    ) internal pure returns (uint256 checked) {
        string[] memory lines = vm.split(doc, "\n");
        for (uint256 i; i < lines.length; ++i) {
            uint256 at = vm.indexOf(lines[i], "cast call $");
            if (at == NOT_FOUND) at = vm.indexOf(lines[i], "cast send $");
            if (at == NOT_FOUND) continue;
            bytes memory b = bytes(lines[i]);
            uint256 from = at + 11;
            uint256 to = from;
            while (to < b.length && b[to] != " ") ++to;
            string memory target = _slice(b, from, to);
            bool isQuestions = _same(target, "QUESTIONS");
            bool isDesk = _same(target, "DESK");
            bool isPots = _same(target, "POTS");
            if (!isQuestions && !isDesk && !isPots) continue;

            uint256 quote = to;
            while (quote < b.length && b[quote] != '"') ++quote;
            require(quote < b.length, string.concat("a cast line without a signature: ", lines[i]));
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
            bytes4 selector = bytes4(keccak256(bytes(signature)));
            bool answers = isQuestions
                ? _has(questions, selector)
                : isDesk ? _has(deskSelectors, selector) : _has(potSelectors, selector);
            require(answers, string.concat("the real $", target, " has no function ", signature));
            ++checked;
        }
    }

    function test_documents_everyCommandToASiblingNamesAFunctionOfTheRealContract() public view {
        bytes4[] memory questions = _selectors("Questions");
        bytes4[] memory deskSelectors = _selectors("WorkOrders");
        bytes4[] memory potSelectors = _selectors("CrowdPots");
        uint256 inLaunch = _check(vm.readFile(LAUNCH_DOC), questions, deskSelectors, potSelectors);
        _check(vm.readFile(README), questions, deskSelectors, potSelectors);
        assertGe(inLaunch, 10, "docs/LAUNCH.md: the commands to the sibling contracts were not found");
    }

    /// @dev Section 5 of the document says what the right desk answers: each of these commands is
    /// followed, on its own line, by a comment with the value to expect. The real desk answers that.
    function test_documents_theDeskAnswersWhatTheDocumentSaysToExpect() public view {
        string[] memory lines = vm.split(vm.readFile(LAUNCH_DOC), "\n");
        _expectDocumented(lines, 'cast call $DESK "MIN_BOND()(uint96)"', desk.MIN_BOND());
        _expectDocumented(lines, 'cast call $DESK "MIN_DELIVERY()(uint32)"', desk.MIN_DELIVERY());
        _expectDocumented(lines, 'cast call $DESK "MAX_DELIVERY()(uint32)"', desk.MAX_DELIVERY());
        _expectDocumented(lines, 'cast call $DESK "FLAG_ALLOW_CLAIMED()(uint8)"', desk.FLAG_ALLOW_CLAIMED());
        _expectDocumented(lines, 'cast call $DESK "FLAG_CALLBACK()(uint8)"', desk.FLAG_CALLBACK());
        assertEq(desk.IMD(), address(imd));
        // The questions the document asks of Questions and the pots have an answer on the real ones.
        assertGt(q.costOf(feed), 0);
        (uint256 balance, uint256 shares) = q.meterOf(feed);
        assertEq(balance + shares, 0);
        assertEq(pots.potCount(), 0);
        assertEq(pots.remaining(1), 0);
    }

    /// @dev The first line of the document that carries `command` ends with `# value`.
    function _expectDocumented(string[] memory lines, string memory command, uint256 value) internal pure {
        for (uint256 i; i < lines.length; ++i) {
            if (vm.indexOf(lines[i], command) == NOT_FOUND) continue;
            string[] memory parts = vm.split(lines[i], "# ");
            require(parts.length == 2, string.concat("no expected value beside: ", command));
            require(_same(parts[1], vm.toString(value)), string.concat("the real desk answers otherwise: ", command));
            return;
        }
        revert(string.concat("docs/LAUNCH.md has no line: ", command));
    }
}
