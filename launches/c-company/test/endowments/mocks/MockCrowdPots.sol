// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev The one function of `MockIMD` the `TakesMore` switch uses.
interface ITakeable {
    function take(address from, uint256 amount) external;
}

/// @dev A stand-in for the crowd pots (`CrowdPots`, launch B), which live in another project. It
/// carries the frozen `ICrowdPots` surface (`potCount`, `remaining`, `chipIn`, `chipInFor`), following
/// the real contract's rules as read from `launches/b-desk/src/pots/CrowdPots.sol`:
///
/// - a chip is cut to what the pot still needs, and a pot that needs nothing takes nothing and returns
///   zero instead of reverting;
/// - `chipInFor` reverts `BadBeneficiary` for a zero beneficiary and for the pots contract itself;
/// - a series holds no money: a chip sent to its id lands in its current round, and when that round is
///   full the next chip opens a new one. `remaining` of a series is its current round's need, or the
///   whole target when the next chip would open a round, so it is never zero;
/// - `remaining` of an id that was never opened is zero.
///
/// Where it is simpler than the real contract, in ways Endowments cannot see: a round of a series has
/// no pot id of its own here (the real one opens a pot per round, so `potCount` grows and the chip is
/// booked under the round's id), there are no funding deadlines, and nothing is hired or refunded.
///
/// The switches make it fail in ways a dependency could, most of which the real contract cannot.
contract MockCrowdPots {
    enum Mode {
        Normal,
        // `chipInFor` reverts.
        Reverts,
        // `chipInFor` spins until its gas is gone.
        BurnsGas,
        // `chipInFor` takes nothing and returns as much data as its gas allows.
        ReturnsHuge,
        // `chipInFor` calls back into the caller before pulling.
        CallsBack,
        // `chipInFor` reverts unless it was handed at least `minGas`.
        NeedsGas,
        // `chipInFor` takes what it should and then one wei more, through the mock token's `take`.
        TakesMore
    }

    enum ViewMode {
        Normal,
        // `remaining` reverts.
        Reverts,
        // `remaining` spins until its gas is gone.
        BurnsGas,
        // `remaining` returns 31 bytes instead of a word.
        ReturnsShort,
        // `remaining` returns as much data as its gas allows.
        ReturnsHuge,
        // `remaining` answers `fixedRoom` whatever the pot needs.
        Fixed,
        // `remaining` reverts, and the revert data is `fixedRoom` as one clean word.
        RevertsWithWord
    }

    IERC20 public immutable IMD;
    Mode public mode;
    ViewMode public viewMode;
    bytes public callback;
    bool public callbackSucceeded;
    bytes public callbackResult;

    /// @dev Ids run from 1 to `potCount`, as in the real contract.
    uint256 public potCount;
    uint256 public minGas;
    uint256 public fixedRoom;
    /// @dev Gas a chip that opens a new round of a series burns on top (the real one writes a whole pot).
    uint256 public roundCost;
    /// @dev Gas left when the last successful `chipInFor` was entered.
    uint256 public gasSeen;

    mapping(uint256 => uint256) public seriesTarget;
    mapping(uint256 => uint256) public rounds;
    mapping(uint256 => mapping(address => uint256)) public chipOf;
    mapping(uint256 => uint256) private _needs;

    error Refused();
    error Starved();
    error BadBeneficiary();

    constructor(address imd) {
        IMD = IERC20(imd);
    }

    // -------------------------------------------------------------------------------- test switches

    /// @dev Opens (or resets) a single pot that still needs `needs`.
    function open(uint256 potId, uint256 needs) external {
        seriesTarget[potId] = 0;
        _needs[potId] = needs;
        if (potId > potCount) potCount = potId;
    }

    /// @dev Opens a series whose every round collects `target`. No round is open yet.
    function openSeries(uint256 potId, uint256 target) external {
        seriesTarget[potId] = target;
        _needs[potId] = 0;
        if (potId > potCount) potCount = potId;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function setViewMode(ViewMode viewMode_) external {
        viewMode = viewMode_;
    }

    function setCallback(bytes calldata data) external {
        callback = data;
    }

    function setMinGas(uint256 minGas_) external {
        minGas = minGas_;
    }

    function setFixedRoom(uint256 fixedRoom_) external {
        fixedRoom = fixedRoom_;
    }

    function setRoundCost(uint256 roundCost_) external {
        roundCost = roundCost_;
    }

    // -------------------------------------------------------------------------------- ICrowdPots

    function remaining(uint256 potId) external view returns (uint256) {
        if (viewMode == ViewMode.Reverts) revert Refused();
        if (viewMode == ViewMode.BurnsGas) _spin();
        if (viewMode == ViewMode.ReturnsShort) {
            assembly {
                mstore(0, not(0))
                return(0, 31)
            }
        }
        if (viewMode == ViewMode.ReturnsHuge) {
            assembly {
                return(0, 400000)
            }
        }
        if (viewMode == ViewMode.Fixed) return fixedRoom;
        if (viewMode == ViewMode.RevertsWithWord) {
            uint256 word = fixedRoom;
            assembly {
                mstore(0, word)
                revert(0, 32)
            }
        }
        uint256 needs = _needs[potId];
        return needs == 0 ? seriesTarget[potId] : needs;
    }

    function chipIn(uint256 potId, uint256 amount) external returns (uint256 taken) {
        return chipInFor(potId, amount, msg.sender);
    }

    function chipInFor(uint256 potId, uint256 amount, address beneficiary) public returns (uint256 taken) {
        uint256 gasOnEntry = gasleft();
        if (mode == Mode.NeedsGas && gasOnEntry < minGas) revert Starved();
        if (mode == Mode.Reverts) revert Refused();
        if (mode == Mode.BurnsGas) _spin();
        if (mode == Mode.ReturnsHuge) {
            assembly {
                // About 400 KB of zeros: cheap to return, costly for a caller that copies it.
                return(0, 400000)
            }
        }
        if (mode == Mode.CallsBack) {
            (callbackSucceeded, callbackResult) = msg.sender.call(callback);
        }
        if (beneficiary == address(0) || beneficiary == address(this)) revert BadBeneficiary();

        uint256 needs = _needs[potId];
        uint256 target = seriesTarget[potId];
        if (target != 0 && needs == 0) {
            if (amount == 0) return 0;
            // The last round is full: this chip opens the next one.
            needs = target;
            rounds[potId] += 1;
            uint256 burn = roundCost;
            if (burn != 0) {
                uint256 stop = gasleft() - burn;
                while (gasleft() > stop) {}
            }
        }
        taken = amount < needs ? amount : needs;
        _needs[potId] = needs - taken;
        chipOf[potId][beneficiary] += taken;
        gasSeen = gasOnEntry;
        IMD.transferFrom(msg.sender, address(this), taken);
        if (mode == Mode.TakesMore) ITakeable(address(IMD)).take(msg.sender, 1);
    }

    function _spin() private pure {
        uint256 spin;
        while (true) {
            unchecked {
                ++spin;
            }
        }
    }
}
