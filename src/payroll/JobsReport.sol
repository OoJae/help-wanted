// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IQuestions} from "../interfaces/IQuestions.sol";

/// @title The Robot Jobs Report
/// @notice A public record of what the IdentityMD swarm was paid, period by period, built only from
/// answers that the Standing Questions contract bought from the swarm's own oracle. It reads three
/// feeds: "payrolls" (the sum of IMD paid to the protocol's fee wallet over a block window), "hires"
/// (how many payments that was) and "employers" (the wallets that paid most over a week).
///
/// Nobody owns this contract and it holds no money. Anyone may call `print` to copy newly answered
/// rounds into the record, and anyone may call `crown` to publish a week's top three employers by
/// handing in the list the oracle attested. Nothing here can be edited afterwards.
///
/// The report is complete with the first two feeds alone. `print` never reads the employers feed, so
/// a ranking that never arrives, or a `crown` nobody calls, changes nothing about the prints.
///
/// @dev Two series are kept, one per feed, each in round order and each complete on its own:
///
///  - A print for every usable answered round of the payrolls feed.
///  - A count for every usable answered round of the hires feed.
///
/// A round is not usable when it failed, when its window is empty or ends at or after the current
/// block, when it starts at or before the end of the previous entry of its series, or when its figure
/// is too large to be real. Entries of one series therefore never overlap, and each running total
/// (`total`, `totalCount`) never counts a block twice.
///
/// The two feeds are bought by separate transactions, each on its own schedule, so their windows need
/// not line up: one late request shifts that feed's windows for good. The series are therefore joined
/// by overlap, not by exact edges. A count is attached to a print when the blocks the two windows
/// share are more than half of the longer window. Entries of a series do not overlap, so a print has
/// at most one such count and a count at most one such print, and the pairing is the same whoever
/// calls `print` and whenever. When both feeds are requested in the same block the windows are equal
/// and the count is exact for the print's period. When they have drifted, the attached count covers
/// the print's window shifted by the drift (less than half a window): the print keeps the hires round
/// and the count keeps its own window, so a reader can show exactly which blocks it covers. A count
/// that pairs with no print (for example one catch-up window over three days of daily prints) stays
/// in its own series and in `totalCount`; nothing is dropped.
contract JobsReport {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice One period of the report.
    /// @param amount IMD wei paid to the fee wallet in the window (the payrolls answer).
    /// @param count The number of payments attached to this period (a hires answer: the number of IMD
    /// Transfer logs to the fee wallet in its window, transfers of zero included). Zero until one is
    /// attached. It covers the window of `hiresRound`, which is this print's window when the two feeds
    /// were requested together and a window shifted by less than half its length otherwise.
    /// @param fromBlock First block of the window.
    /// @param toBlock Last block of the window.
    /// @param payrollsRound The payrolls round the amount came from.
    /// @param hiresRound The hires round the count came from, or zero while no count is attached.
    struct Print {
        uint256 amount;
        uint256 count;
        uint64 fromBlock;
        uint64 toBlock;
        uint64 payrollsRound;
        uint64 hiresRound;
    }

    /// @notice One answered round of the hires feed: how many payments a block window held.
    /// @param count The hires answer.
    /// @param fromBlock First block of the window the count covers.
    /// @param toBlock Last block of that window.
    /// @param hiresRound The hires round it came from.
    /// @param print One more than the index of the print it is attached to; zero when it is attached
    /// to none (not yet, or never).
    struct Count {
        uint256 count;
        uint64 fromBlock;
        uint64 toBlock;
        uint64 hiresRound;
        uint64 print;
    }

    /// @notice Employers of the Week for one round of the employers feed.
    /// @param first The wallet that paid most; zero when the list was empty.
    /// @param second Zero when the list had fewer than two entries.
    /// @param third Zero when the list had fewer than three entries.
    /// @param fromBlock First block of the round's window.
    /// @param toBlock Last block of the round's window.
    /// @param crownedAt When `crown` stored this (unix seconds); zero means the round is not crowned.
    /// @param places How many of the three places are filled.
    struct Crown {
        address first;
        uint64 fromBlock;
        address second;
        uint64 toBlock;
        address third;
        uint64 crownedAt;
        uint8 places;
    }

    /// @notice Everything a page needs besides the entries themselves.
    /// @param prints Number of prints.
    /// @param total Sum of every print's amount, in IMD wei.
    /// @param counts Number of counts.
    /// @param totalCount Sum of every count, attached to a print or not.
    /// @param bestAmount The largest amount printed for a window of at most `MAX_DAY_BLOCKS` blocks.
    /// @param bestIndex The print that holds that record (meaningless while `bestAmount` is zero).
    /// @param streak How many prints in a row, ending with the newest, each cover at most
    /// `MAX_DAY_BLOCKS` blocks and each start one block after the print before. A print over a longer
    /// window (the catch-up after a missed day) ends the run and is not part of one, so the figure is
    /// zero right after it.
    /// @param longestStreak The longest such run so far.
    /// @param payrollsRead Payrolls rounds consumed so far.
    /// @param hiresRead Hires rounds consumed so far.
    /// @param pairedPrints Prints the pairing has settled: each has its count or will never have one.
    /// @param pairedCounts Counts the pairing has settled.
    /// @param crowns Number of crowned rounds.
    /// @param latestCrownedRound The highest crowned round of the employers feed, or zero.
    struct Summary {
        uint256 prints;
        uint256 total;
        uint256 counts;
        uint256 totalCount;
        uint256 bestAmount;
        uint256 bestIndex;
        uint256 streak;
        uint256 longestStreak;
        uint64 payrollsRead;
        uint64 hiresRead;
        uint64 pairedPrints;
        uint64 pairedCounts;
        uint256 crowns;
        uint64 latestCrownedRound;
    }

    /// @dev Where `print` has got to, in one storage slot. Round numbers and entry counts fit 48 bits
    /// for longer than any chain will run.
    struct Progress {
        uint48 payrollsRead;
        uint48 hiresRead;
        uint48 pairedPrints;
        uint48 pairedCounts;
        uint32 streak;
        uint32 longestStreak;
    }

    /// @notice Why a round was passed over.
    /// @dev `None`: it was not; the value is never emitted. `Failed`: the round bought no answer.
    /// `BadWindow`: the window is empty or ends at or after the block of the call; the Questions
    /// contract this report reads never stores either, see `print`. `Overlap`: the
    /// window starts at or before the end of the previous entry of the same series. `OutOfRange`: the
    /// answer is too large to be a real figure.
    enum SkipReason {
        None,
        Failed,
        BadWindow,
        Overlap,
        OutOfRange
    }

    // ---------------------------------------------------------------------------------------------
    // Constants and immutables
    // ---------------------------------------------------------------------------------------------

    /// @notice The most rounds, of both feeds together, that one `print` call consumes.
    uint256 public constant MAX_ROUNDS_PER_CALL = 8;
    /// @notice The most steps one `print` call spends on pairing counts with prints. Every step
    /// settles one print or one count, so a backlog is worked off over a few calls.
    uint256 public constant MAX_PAIRING_STEPS = 16;
    /// @notice The longest window, in blocks, that still counts as one day (about 25 hours). A print
    /// over a longer window cannot take the best-day record and cannot be part of a streak: otherwise
    /// a window that covers several days after a missed one would win the record and hide the miss.
    uint256 public constant MAX_DAY_BLOCKS = 7_500;
    /// @notice The most entries a page view returns.
    uint256 public constant MAX_PAGE = 100;
    /// @dev Answers above this are passed over, so no single answer can overflow a running total.
    uint256 private constant MAX_FIGURE = type(uint128).max;

    /// @notice The Standing Questions contract the three feeds live in.
    IQuestions public immutable QUESTIONS;
    /// @notice The feed whose answer is the IMD paid in a window.
    bytes32 public immutable PAYROLLS_FEED;
    /// @notice The feed whose answer is the number of payments in a window.
    bytes32 public immutable HIRES_FEED;
    /// @notice The feed whose answer is the list of top payers, stored by Questions as the hash of the list.
    bytes32 public immutable EMPLOYERS_FEED;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    Print[] private _prints;
    Count[] private _counts;
    Progress private _progress;

    /// @notice Sum of every print's amount, in IMD wei.
    uint256 public total;
    /// @notice Sum of every count, attached to a print or not.
    uint256 public totalCount;
    /// @notice The best-day record; see `Summary`.
    uint256 public bestAmount;
    uint256 public bestIndex;

    mapping(uint64 round => Crown) private _crowns;
    uint64[] private _crownedRounds;
    /// @notice The highest crowned round of the employers feed, or zero.
    uint64 public latestCrownedRound;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    /// @notice A period was printed. `total` and `streak` are the running figures after it.
    event Printed(
        uint256 indexed index,
        uint64 indexed round,
        uint256 amount,
        uint64 fromBlock,
        uint64 toBlock,
        uint256 total,
        uint256 streak
    );
    /// @notice An answer of the hires feed was recorded as count number `index`. `totalCount` is the
    /// running figure after it.
    event CountRecorded(
        uint256 indexed index, uint64 indexed round, uint256 count, uint64 fromBlock, uint64 toBlock, uint256 totalCount
    );
    /// @notice Print `index` received the count of hires round `round`.
    event Counted(uint256 indexed index, uint64 indexed round, uint256 count);
    /// @notice Print `index` set a new best-day record.
    event BestDay(uint256 indexed index, uint256 amount);
    /// @notice A round was consumed without adding an entry.
    event RoundSkipped(bytes32 indexed feedId, uint64 indexed round, SkipReason reason);
    /// @notice The top three payers of a round of the employers feed were published.
    event EmployersOfTheWeek(
        uint64 indexed round, address first, address second, address third, uint64 fromBlock, uint64 toBlock
    );

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    /// @notice The constructor's Questions address was zero.
    error ZeroAddress();
    /// @notice Two of the three feed ids were the same.
    error DuplicateFeed();
    /// @notice This round of the employers feed is already crowned.
    error AlreadyCrowned(uint64 round);
    /// @notice The employers feed has no answer for this round.
    error RoundNotAnswered(uint64 round);
    /// @notice The bytes handed in do not hash to the word Questions stored for the round.
    error AnswerMismatch(uint64 round);
    /// @notice The attested bytes are not an ABI-encoded list of addresses.
    error BadAnswer();
    /// @notice There is no print at this index.
    error NoSuchPrint(uint256 index);
    /// @notice There is no count at this index.
    error NoSuchCount(uint256 index);

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    /// @notice Fixes the Questions contract and the three feeds for good. Makes no external call, so it
    /// deploys on an empty chain and before the feeds exist: feed ids are content-addressed.
    /// @param questions The Standing Questions contract.
    /// @param payrollsFeed The feed that sums IMD paid to the fee wallet (answer type uint256).
    /// @param hiresFeed The feed that counts those payments (answer type uint256).
    /// @param employersFeed The feed that ranks payers (answer type address list).
    constructor(address questions, bytes32 payrollsFeed, bytes32 hiresFeed, bytes32 employersFeed) {
        if (questions == address(0)) revert ZeroAddress();
        if (payrollsFeed == hiresFeed || payrollsFeed == employersFeed || hiresFeed == employersFeed) {
            revert DuplicateFeed();
        }
        QUESTIONS = IQuestions(questions);
        PAYROLLS_FEED = payrollsFeed;
        HIRES_FEED = hiresFeed;
        EMPLOYERS_FEED = employersFeed;
    }

    // ---------------------------------------------------------------------------------------------
    // Printing
    // ---------------------------------------------------------------------------------------------

    /// @notice Copies newly answered rounds into the report. Anyone may call, at any time.
    /// @dev Consumes at most `MAX_ROUNDS_PER_CALL` rounds per call, payrolls first, then spends at most
    /// `MAX_PAIRING_STEPS` steps attaching counts to prints, so a backlog is worked off over several
    /// calls. Each feed stops at a round that is still waiting for its answer and picks up there next
    /// time; neither feed waits for the other. A call with nothing new to read changes nothing and
    /// does not revert. It reverts only if Questions itself reverts. What ends up in the report does
    /// not depend on who calls, and against this Questions contract it does not depend on when
    /// either. Every rule that passes a round over reads the round alone, with one exception: a
    /// round whose window ends at or after the block of the call is passed over for good
    /// (`BadWindow`). Questions never stores such an answer, because a window ends at least five
    /// blocks behind the block of its request and the answer comes later still, so the rule cannot
    /// fire here. It is kept as a guard. If such a round were ever shown to this contract, printing
    /// it would make every later round overlap it, and waiting for it could wait for ever; passing
    /// it over costs the report that one round.
    /// @return printed How many prints this call added.
    /// @return counted How many counts this call recorded.
    function print() external returns (uint256 printed, uint256 counted) {
        Progress memory p = _progress;
        uint256 budget = MAX_ROUNDS_PER_CALL;
        (budget, printed) = _readPayrolls(p, budget);
        if (budget != 0) counted = _readHires(p, budget);
        _pair(p);
        _progress = p;
    }

    /// @dev Turns answered payrolls rounds into prints. Updates `p` in memory.
    function _readPayrolls(Progress memory p, uint256 budget) private returns (uint256 left, uint256 printed) {
        uint256 opened = QUESTIONS.roundCount(PAYROLLS_FEED);
        uint256 n = _prints.length;
        uint256 lastTo = n == 0 ? 0 : _prints[n - 1].toBlock;

        while (budget != 0 && p.payrollsRead < opened) {
            uint64 round = uint64(p.payrollsRead) + 1;
            // One read of our own Questions contract per round consumed, at most `MAX_ROUNDS_PER_CALL`
            // a call. The time an answer was stored is not part of a print.
            // forge-lint: disable-start(calls-loop, unused-return)
            // slither-disable-next-line calls-loop,unused-return
            (IQuestions.RoundStatus status, uint256 amount, uint64 fromBlock, uint64 toBlock,) =
                QUESTIONS.roundOf(PAYROLLS_FEED, round);
            // forge-lint: disable-end(calls-loop, unused-return)
            // A round that is still pending may yet be answered: stop and come back to it.
            if (status != IQuestions.RoundStatus.Answered && status != IQuestions.RoundStatus.Failed) break;
            ++p.payrollsRead;
            --budget;

            SkipReason reason = _unusable(status, amount, fromBlock, toBlock, n != 0, lastTo);
            if (reason != SkipReason.None) {
                emit RoundSkipped(PAYROLLS_FEED, round, reason);
                continue;
            }

            _addPrint(p, round, amount, fromBlock, toBlock, n != 0 && fromBlock == lastTo + 1);
            lastTo = toBlock;
            ++n;
            ++printed;
        }
        left = budget;
    }

    /// @dev Stores one print and updates the running figures. `follows` says whether its window starts
    /// one block after the previous print's end.
    function _addPrint(Progress memory p, uint64 round, uint256 amount, uint64 fromBlock, uint64 toBlock, bool follows)
        private
    {
        // A streak is made of day-sized prints that follow each other without a gap. The feed's windows
        // tile, so a missed day shows up as a longer window, and that ends the run.
        bool day = uint256(toBlock) - fromBlock < MAX_DAY_BLOCKS;
        p.streak = day ? (follows ? p.streak + 1 : 1) : 0;
        if (p.streak > p.longestStreak) p.longestStreak = p.streak;

        uint256 index = _prints.length;
        uint256 sum = total + amount;
        total = sum;
        _prints.push(Print(amount, 0, fromBlock, toBlock, round, 0));
        emit Printed(index, round, amount, fromBlock, toBlock, sum, p.streak);
        if (day && amount > bestAmount) {
            bestAmount = amount;
            bestIndex = index;
            emit BestDay(index, amount);
        }
    }

    /// @dev Turns answered hires rounds into counts. Updates `p` in memory.
    function _readHires(Progress memory p, uint256 budget) private returns (uint256 counted) {
        uint256 opened = QUESTIONS.roundCount(HIRES_FEED);
        uint256 n = _counts.length;
        uint256 lastTo = n == 0 ? 0 : _counts[n - 1].toBlock;

        while (budget != 0 && p.hiresRead < opened) {
            uint64 round = uint64(p.hiresRead) + 1;
            // One read of our own Questions contract per round consumed, at most `MAX_ROUNDS_PER_CALL`
            // a call. The time an answer was stored is not part of a count.
            // forge-lint: disable-start(calls-loop, unused-return)
            // slither-disable-next-line calls-loop,unused-return
            (IQuestions.RoundStatus status, uint256 count, uint64 fromBlock, uint64 toBlock,) =
                QUESTIONS.roundOf(HIRES_FEED, round);
            // forge-lint: disable-end(calls-loop, unused-return)
            if (status != IQuestions.RoundStatus.Answered && status != IQuestions.RoundStatus.Failed) break;
            ++p.hiresRead;
            --budget;

            SkipReason reason = _unusable(status, count, fromBlock, toBlock, n != 0, lastTo);
            if (reason != SkipReason.None) {
                emit RoundSkipped(HIRES_FEED, round, reason);
                continue;
            }

            _addCount(round, count, fromBlock, toBlock);
            lastTo = toBlock;
            ++n;
            ++counted;
        }
    }

    /// @dev Stores one count and adds it to the running total.
    function _addCount(uint64 round, uint256 count, uint64 fromBlock, uint64 toBlock) private {
        uint256 index = _counts.length;
        uint256 sum = totalCount + count;
        totalCount = sum;
        _counts.push(Count(count, fromBlock, toBlock, round, 0));
        emit CountRecorded(index, round, count, fromBlock, toBlock, sum);
    }

    /// @dev Why a consumed round adds no entry, or `None` when it does. The second half of the
    /// `BadWindow` test is the one place a skip reads the block of the call: see `print`.
    function _unusable(
        IQuestions.RoundStatus status,
        uint256 figure,
        uint256 fromBlock,
        uint256 toBlock,
        bool hasPrevious,
        uint256 previousTo
    ) private view returns (SkipReason) {
        if (status == IQuestions.RoundStatus.Failed) return SkipReason.Failed;
        if (fromBlock > toBlock || toBlock >= block.number) return SkipReason.BadWindow;
        if (hasPrevious && fromBlock <= previousTo) return SkipReason.Overlap;
        if (figure > MAX_FIGURE) return SkipReason.OutOfRange;
        return SkipReason.None;
    }

    /// @dev Walks the two series side by side from where the last call stopped. Both only move forward
    /// in block height, so this is a merge: each step looks at the first print and the first count not
    /// settled yet. If they pair, both are settled. If not, the one that ends first is settled
    /// unpaired, because everything still to come in the other series starts after it. The walk stops
    /// when either series runs out, and resumes when more entries exist.
    function _pair(Progress memory p) private {
        uint256 prints = _prints.length;
        uint256 counts = _counts.length;
        uint256 i = p.pairedPrints;
        uint256 j = p.pairedCounts;

        for (uint256 steps = MAX_PAIRING_STEPS; steps != 0 && i < prints && j < counts; --steps) {
            Print storage period = _prints[i];
            Count storage tally = _counts[j];
            uint256 periodTo = period.toBlock;
            uint256 tallyTo = tally.toBlock;
            if (_mostlyShared(period.fromBlock, periodTo, tally.fromBlock, tallyTo)) {
                uint256 count = tally.count;
                uint64 round = tally.hiresRound;
                period.count = count;
                period.hiresRound = round;
                // An index into an array of entries that are at least one block apart: far below 2^64.
                // forge-lint: disable-next-line(unsafe-typecast)
                tally.print = uint64(i + 1);
                emit Counted(i, round, count);
                ++i;
                ++j;
            } else if (periodTo < tallyTo) {
                ++i;
            } else {
                ++j;
            }
        }

        // Both are bounded by the number of rounds consumed, which fits 48 bits (see `Progress`).
        // forge-lint: disable-next-line(unsafe-typecast)
        (p.pairedPrints, p.pairedCounts) = (uint48(i), uint48(j));
    }

    /// @dev True when the blocks two windows share are more than half of the longer window. Each
    /// window is `[from, to]` with `from <= to`.
    function _mostlyShared(uint256 aFrom, uint256 aTo, uint256 bFrom, uint256 bTo) private pure returns (bool) {
        uint256 lo = aFrom > bFrom ? aFrom : bFrom;
        uint256 hi = aTo < bTo ? aTo : bTo;
        if (lo > hi) return false;
        uint256 aLength = aTo - aFrom;
        uint256 bLength = bTo - bFrom;
        uint256 longer = (aLength > bLength ? aLength : bLength) + 1;
        return (hi - lo + 1) * 2 > longer;
    }

    // ---------------------------------------------------------------------------------------------
    // Employers of the Week
    // ---------------------------------------------------------------------------------------------

    /// @notice Publishes the top three payers for one answered round of the employers feed. Anyone may
    /// call; the caller supplies the list, the contract checks it.
    /// @dev Questions stores a list answer as one word, `uint256(keccak256(answer))`, where `answer` is
    /// the attestation's answer bytes: the ABI encoding of an address list, best first. This function
    /// hashes the bytes it is handed and requires that word, so only the attested list can be crowned,
    /// whoever submits it. The first three addresses are stored; a shorter list fills fewer places.
    /// Nothing else in the report depends on a crown.
    /// Reverts `AlreadyCrowned`, `RoundNotAnswered`, `AnswerMismatch`, or `BadAnswer` when the attested
    /// bytes are not a well-formed address list.
    /// @param round The round of the employers feed, counting from 1.
    /// @param answer The attested answer bytes for that round.
    function crown(uint64 round, bytes calldata answer) external {
        if (_crowns[round].crownedAt != 0) revert AlreadyCrowned(round);
        // The time the answer was stored is not part of a crown.
        // forge-lint: disable-start(unused-return)
        // slither-disable-next-line unused-return
        (IQuestions.RoundStatus status, uint256 stored, uint64 fromBlock, uint64 toBlock,) =
            QUESTIONS.roundOf(EMPLOYERS_FEED, round);
        // forge-lint: disable-end(unused-return)
        if (status != IQuestions.RoundStatus.Answered) revert RoundNotAnswered(round);
        if (uint256(keccak256(answer)) != stored) revert AnswerMismatch(round);

        (address[3] memory top, uint8 places) = _topThree(answer);
        _crowns[round] = Crown({
            first: top[0],
            fromBlock: fromBlock,
            second: top[1],
            toBlock: toBlock,
            third: top[2],
            // A unix time fits 64 bits for longer than the chain will run.
            // forge-lint: disable-next-line(unsafe-typecast)
            crownedAt: uint64(block.timestamp),
            places: places
        });
        _crownedRounds.push(round);
        if (round > latestCrownedRound) latestCrownedRound = round;
        emit EmployersOfTheWeek(round, top[0], top[1], top[2], fromBlock, toBlock);
    }

    /// @dev Reads the first three entries of an ABI-encoded `address[]` with explicit bounds checks, so
    /// bytes of any shape end in `BadAnswer` rather than in a bare revert.
    function _topThree(bytes calldata answer) private pure returns (address[3] memory top, uint8 places) {
        if (answer.length < 64) revert BadAnswer();
        uint256 offset = uint256(bytes32(answer[:32]));
        if (offset > answer.length - 32) revert BadAnswer();
        uint256 length = uint256(bytes32(answer[offset:offset + 32]));
        uint256 start = offset + 32;
        if (length > (answer.length - start) / 32) revert BadAnswer();

        // At most three.
        // forge-lint: disable-next-line(unsafe-typecast)
        places = length > 3 ? 3 : uint8(length);
        for (uint256 i = 0; i < places; ++i) {
            uint256 word = uint256(bytes32(answer[start + 32 * i:start + 32 * i + 32]));
            // Three steps at most; one entry that is not an address makes the whole list unusable.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (word > type(uint160).max) revert BadAnswer();
            // Checked on the line above: the word fits an address.
            // forge-lint: disable-next-line(unsafe-typecast)
            top[i] = address(uint160(word));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice How many prints the report holds.
    function printCount() external view returns (uint256) {
        return _prints.length;
    }

    /// @notice The print at `index` (oldest is 0). Reverts `NoSuchPrint` past the end.
    function printAt(uint256 index) external view returns (Print memory) {
        if (index >= _prints.length) revert NoSuchPrint(index);
        return _prints[index];
    }

    /// @notice The newest print. `exists` is false, and the rest zero, before the first print.
    function latestPrint() external view returns (bool exists, uint256 index, Print memory latest) {
        uint256 n = _prints.length;
        exists = n != 0;
        if (exists) {
            index = n - 1;
            latest = _prints[index];
        }
    }

    /// @notice A page of the history, oldest first, starting at print `start`.
    /// @param limit How many to return at most; capped at `MAX_PAGE`. The page is shorter at the end of
    /// the history and empty past it.
    function printsPage(uint256 start, uint256 limit) external view returns (Print[] memory page) {
        uint256 size = _pageSize(_prints.length, start, limit);
        page = new Print[](size);
        for (uint256 i = 0; i < size; ++i) {
            page[i] = _prints[start + i];
        }
    }

    /// @notice A page of the history, newest first, after skipping the `skip` newest prints.
    /// @param limit How many to return at most; capped at `MAX_PAGE`.
    function latestPrints(uint256 skip, uint256 limit) external view returns (Print[] memory page) {
        uint256 n = _prints.length;
        uint256 size = _pageSize(n, skip, limit);
        page = new Print[](size);
        for (uint256 i = 0; i < size; ++i) {
            page[i] = _prints[n - 1 - skip - i];
        }
    }

    /// @notice How many counts the report holds: one per usable answered round of the hires feed.
    function countsRecorded() external view returns (uint256) {
        return _counts.length;
    }

    /// @notice The count at `index` (oldest is 0). Reverts `NoSuchCount` past the end.
    function countAt(uint256 index) external view returns (Count memory) {
        if (index >= _counts.length) revert NoSuchCount(index);
        return _counts[index];
    }

    /// @notice A page of the counts, oldest first, starting at count `start`.
    /// @param limit How many to return at most; capped at `MAX_PAGE`.
    function countsPage(uint256 start, uint256 limit) external view returns (Count[] memory page) {
        uint256 size = _pageSize(_counts.length, start, limit);
        page = new Count[](size);
        for (uint256 i = 0; i < size; ++i) {
            page[i] = _counts[start + i];
        }
    }

    /// @notice A page of the counts, newest first, after skipping the `skip` newest.
    /// @param limit How many to return at most; capped at `MAX_PAGE`.
    function latestCounts(uint256 skip, uint256 limit) external view returns (Count[] memory page) {
        uint256 n = _counts.length;
        uint256 size = _pageSize(n, skip, limit);
        page = new Count[](size);
        for (uint256 i = 0; i < size; ++i) {
            page[i] = _counts[n - 1 - skip - i];
        }
    }

    /// @notice The crown stored for a round of the employers feed. `crownedAt` is zero when there is none.
    function crownOf(uint64 round) external view returns (Crown memory) {
        return _crowns[round];
    }

    /// @notice The crown of the highest crowned round. `exists` is false before the first crown.
    function latestCrown() external view returns (bool exists, uint64 round, Crown memory latest) {
        round = latestCrownedRound;
        exists = round != 0;
        if (exists) latest = _crowns[round];
    }

    /// @notice How many rounds have been crowned.
    function crownCount() external view returns (uint256) {
        return _crownedRounds.length;
    }

    /// @notice A page of crowns in the order they were stored, starting at position `start`.
    /// @param limit How many to return at most; capped at `MAX_PAGE`.
    /// @return rounds The employers-feed round of each entry.
    /// @return page The crowns, in the same order.
    function crownsPage(uint256 start, uint256 limit)
        external
        view
        returns (uint64[] memory rounds, Crown[] memory page)
    {
        uint256 size = _pageSize(_crownedRounds.length, start, limit);
        rounds = new uint64[](size);
        page = new Crown[](size);
        for (uint256 i = 0; i < size; ++i) {
            uint64 round = _crownedRounds[start + i];
            rounds[i] = round;
            page[i] = _crowns[round];
        }
    }

    /// @notice The running figures and where `print` has got to. See `Summary`.
    function summary() external view returns (Summary memory s) {
        Progress memory p = _progress;
        s.prints = _prints.length;
        s.total = total;
        s.counts = _counts.length;
        s.totalCount = totalCount;
        s.bestAmount = bestAmount;
        s.bestIndex = bestIndex;
        s.streak = p.streak;
        s.longestStreak = p.longestStreak;
        s.payrollsRead = p.payrollsRead;
        s.hiresRead = p.hiresRead;
        s.pairedPrints = p.pairedPrints;
        s.pairedCounts = p.pairedCounts;
        s.crowns = _crownedRounds.length;
        s.latestCrownedRound = latestCrownedRound;
    }

    /// @dev How many of `length` items a page starting at `start` holds, at most `limit` and `MAX_PAGE`.
    function _pageSize(uint256 length, uint256 start, uint256 limit) private pure returns (uint256 size) {
        if (start >= length) return 0;
        size = length - start;
        if (size > limit) size = limit;
        if (size > MAX_PAGE) size = MAX_PAGE;
    }
}
