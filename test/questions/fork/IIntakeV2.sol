// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IIntake} from "../../../src/interfaces/external/IIntake.sol";

/// @title What version 2 of the IdentityMD Intake has that version 1 does not
/// @notice From the verified source of `0xa43e6f75ee006411f79ac1c84120606c2330de82`. Version 2 keeps
/// every function, event and getter of version 1 and adds a way to name a second function on the
/// callback target, called when a request is refused or ends without an answer. `Questions` does
/// not use it: it asks with plain `request` (docs/DEVIATIONS.md, D2). The fork tests use this
/// interface for two things only: to show that the Intake they run against is version 2 (version 1
/// has no `failureSelectorOf` and a call to it reverts), and that a request made by `Questions`
/// names no failure function.
interface IIntakeV2 is IIntake {
    event FailureHookSet(bytes32 indexed requestId, bytes4 selector);

    function requestWithFailure(
        bytes32 action,
        bytes calldata body,
        Callback calldata callback,
        bytes4 onFailure,
        address asset,
        uint256 amount
    ) external payable returns (bytes32 requestId);

    /// @notice The callback target's function for a refusal or a failure; zero when the request
    /// named none.
    function failureSelectorOf(bytes32 requestId) external view returns (bytes4);
}
