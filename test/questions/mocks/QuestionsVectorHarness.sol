// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OracleAttestation} from "../../../src/questions/OracleAttestation.sol";
import {Questions} from "../../../src/questions/Questions.sol";

/// @title Questions with a pending round planted, for the protocol's conformance test
/// @notice Questions accepts an answer only for a round it asked itself: a request it paid for,
/// about a window of its own chain, with the question hash and closing block hash it recorded.
/// The protocol's vector attestation is about blocks 100 to 200 of chain 1 with a fixed question
/// hash, which no request made in a test could ever have asked. `plant` writes the round that
/// request would have left behind, so the unmodified callback can be given the vector. Every check
/// the callback makes stays on, pinned to the vector's own values.
contract QuestionsVectorHarness is Questions {
    constructor(address intake, address imd, address oracleSigner_) Questions(intake, imd, oracleSigner_) {}

    /// @param requestId The Intake request id the answer will be delivered under.
    /// @param a The attestation the planted round expects: its chain, type, panel, window, question
    /// hash and closing block hash are recorded as if this contract had asked for them.
    function plant(bytes32 requestId, OracleAttestation.Attestation calldata a) external returns (bytes32 feedId) {
        feedId = keccak256(abi.encode("planted feed", requestId));
        Feed storage f = _feeds[feedId];
        f.state.exists = true;
        f.state.rounds = 1;
        f.state.pending = true;
        f.params.chainId = uint64(a.chainId);
        f.params.answerType = a.answerType;
        f.params.panelSize = a.panelSize;
        f.params.quorum = a.quorum;
        f.params.minAgreed = a.quorum;
        f.params.pinHash = true;
        Round storage r = _rounds[feedId][1];
        r.requestId = requestId;
        r.questionHash = a.questionHash;
        r.blockHash = a.blockHash;
        r.fromBlock = a.fromBlock;
        r.toBlock = a.toBlock;
        r.requestedAt = uint48(block.timestamp);
        r.status = RoundStatus.Pending;
        _feedOfRequest[requestId] = feedId;
    }
}
