// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {Questions} from "../../../src/questions/Questions.sol";

/// @title Questions with one extra door for tests
/// @notice A Foundry test function runs as a single transaction, so the contract's
/// one-request-per-transaction flag would stay set between two `request` calls that on a real
/// chain are separate transactions. `newTransaction` clears the flag, which is all that the end of
/// a transaction does to it. Nothing else differs from `Questions`; the tests of the flag itself
/// and of callback gas use the unmodified contract.
contract QuestionsHarness is Questions {
    using TransientSlot for *;

    constructor(address intake, address imd, address oracleSigner_) Questions(intake, imd, oracleSigner_) {}

    function newTransaction() external {
        ASKED_SLOT.asBoolean().tstore(false);
    }

    /// @dev Raw share bookkeeping, for tests of the rescale arithmetic.
    function rawStake(bytes32 feedId, address funder) external view returns (uint256, uint32, uint32) {
        Stake storage s = _stakes[feedId][funder];
        return (s.shares, s.epoch, s.rescales);
    }

    function meterEpochs(bytes32 feedId) external view returns (uint32 epoch, uint32 rescales) {
        Meter storage m = _feeds[feedId].meter;
        return (m.epoch, m.rescales);
    }
}
