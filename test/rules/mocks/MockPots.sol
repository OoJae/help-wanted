// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ICrowdPots} from "../../../src/interfaces/ICrowdPots.sol";

/// @dev A stand-in for the crowd pots (`CrowdPots`, launch B), which live in another project,
/// reduced to what a helper contract sees. Chipping in follows the real contract, as read from
/// `launches/b-desk/src/pots/CrowdPots.sol`:
///
/// - a chip is cut to what the pot still needs, and is recorded under the beneficiary;
/// - a pot that needs nothing, or an id that was never opened, takes nothing and answers zero
///   instead of reverting;
/// - `chipInFor` reverts `BadBeneficiary` for the zero address and for the pots contract itself,
///   whatever the pot;
/// - a series holds no money and shares the pot id space. A chip sent to its id lands in its
///   current round, which is a pot with an id of its own; when that round is full the next chip
///   opens the next round. `remaining` of a series is its current round's need, or the whole target
///   when the next chip would open a round, so it is never zero.
///
/// What it leaves out: funding deadlines, hiring and refunds. The one knob makes a full pot revert
/// instead of answering zero, which the real contract does not do.
contract MockPots is ICrowdPots {
    IERC20 public immutable IMD;
    uint256 public potCount;
    mapping(uint256 => uint256) public seriesTarget;
    mapping(uint256 => uint256) public currentRound;
    mapping(uint256 => mapping(address => uint256)) public chipOf;
    mapping(uint256 => uint256) private _needs;
    /// @dev When set, a chip that would be cut to zero reverts instead of returning zero.
    bool public revertWhenFull;

    /// @dev The real contract's error.
    error BadBeneficiary();
    /// @dev Raised by the knob only.
    error PotFull();

    constructor(address imd) {
        IMD = IERC20(imd);
    }

    function open(uint256 needs) external returns (uint256 potId) {
        potId = ++potCount;
        _needs[potId] = needs;
    }

    /// @dev Opens a series whose every round collects `target`. No round is open yet.
    function openSeries(uint256 target) external returns (uint256 seriesId) {
        seriesId = ++potCount;
        seriesTarget[seriesId] = target;
    }

    function setRevertWhenFull(bool on) external {
        revertWhenFull = on;
    }

    function remaining(uint256 potId) external view returns (uint256) {
        uint256 target = seriesTarget[potId];
        if (target == 0) return _needs[potId];
        uint256 round = currentRound[potId];
        if (round != 0) {
            uint256 need = _needs[round];
            if (need != 0) return need;
        }
        return target;
    }

    function chipIn(uint256 potId, uint256 amount) external returns (uint256 taken) {
        return chipInFor(potId, amount, msg.sender);
    }

    function chipInFor(uint256 potId, uint256 amount, address beneficiary) public returns (uint256 taken) {
        if (beneficiary == address(0) || beneficiary == address(this)) revert BadBeneficiary();
        uint256 target = seriesTarget[potId];
        if (target != 0) {
            if (amount == 0) return 0;
            uint256 round = currentRound[potId];
            if (round == 0 || _needs[round] == 0) {
                // The last round has stopped collecting: this chip opens the next one.
                round = ++potCount;
                _needs[round] = target;
                currentRound[potId] = round;
            }
            potId = round;
        }
        uint256 needs = _needs[potId];
        taken = amount < needs ? amount : needs;
        if (taken == 0) {
            if (revertWhenFull) revert PotFull();
            return 0;
        }
        _needs[potId] = needs - taken;
        chipOf[potId][beneficiary] += taken;
        require(IMD.transferFrom(msg.sender, address(this), taken), "transferFrom");
    }
}
