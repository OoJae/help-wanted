// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import "../../src/interfaces/external/IIntake.sol";
import "../../src/interfaces/external/ISeatAdapter.sol";
import "../../src/interfaces/external/Mainnet.sol";
import "../../src/interfaces/IPayroll.sol";
import "../../src/interfaces/IQuestions.sol";

/// @dev Compiles every frozen interface so a signature that stops compiling is caught at once.
contract InterfacesCompileTest is Test {
    function test_oracleActionIsTheRightPaddedString() public pure {
        assertEq(Mainnet.ORACLE_ACTION, bytes32("oracle.request@oracle-1"));
    }
}
