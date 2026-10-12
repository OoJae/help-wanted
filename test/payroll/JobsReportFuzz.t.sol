// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {JobsReport} from "../../src/payroll/JobsReport.sol";
import {JobsReportSetup} from "./JobsReportSetup.sol";
import {QuestionsRig, Rig} from "./mocks/QuestionsRig.sol";

using Rig for QuestionsRig;

/// @dev Fuzz tests of the list reader, of `print` against a reference model written here, and of the
/// rule that a count joins the one print whose window it mostly shares, and no other.
contract JobsReportFuzzTest is JobsReportSetup {
    // ---- crown

    function testFuzz_crown_topThreeAreTheFirstThreeOfTheList(address[] memory list) public {
        bytes memory answer = abi.encode(list);
        uint64 round = employers(answer, 0, 6);
        report.crown(round, answer);

        JobsReport.Crown memory c = report.crownOf(round);
        assertEq(c.places, list.length > 3 ? 3 : list.length);
        assertEq(c.first, list.length > 0 ? list[0] : address(0));
        assertEq(c.second, list.length > 1 ? list[1] : address(0));
        assertEq(c.third, list.length > 2 ? list[2] : address(0));
    }

    function testFuzz_crown_onlyTheAttestedBytesAreAccepted(address[] memory attested, bytes memory other) public {
        bytes memory answer = abi.encode(attested);
        vm.assume(keccak256(other) != keccak256(answer));
        uint64 round = employers(answer, 0, 6);
        vm.expectRevert(abi.encodeWithSelector(JobsReport.AnswerMismatch.selector, round));
        report.crown(round, other);
    }

    /// @dev Whatever bytes were attested, `crown` either stores a crown or reverts `BadAnswer`.
    function testFuzz_crown_anyAttestedBytesEndCleanly(bytes memory raw) public {
        assertEndsCleanly(raw);
    }

    /// @dev The same, with bytes shaped like a list whose offset, length and entries are arbitrary.
    function testFuzz_crown_anyListShapedBytesEndCleanly(
        uint256 offset,
        uint256 length,
        uint256[5] memory words,
        bool smallOffset,
        bool smallLength
    ) public {
        if (smallOffset) offset = bound(offset, 0, 7) * 32;
        if (smallLength) length = bound(length, 0, 6);
        assertEndsCleanly(abi.encode(offset, length, words[0], words[1], words[2], words[3], words[4]));
    }

    function assertEndsCleanly(bytes memory raw) internal {
        uint64 round = employers(raw, 0, 6);
        try report.crown(round, raw) {
            JobsReport.Crown memory c = report.crownOf(round);
            assertGt(c.crownedAt, 0);
            assertLe(c.places, 3);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), JobsReport.BadAnswer.selector, "anything else would be a panic");
            assertEq(report.crownOf(round).crownedAt, 0);
        }
    }

    // ---- print against a reference model

    struct Model {
        uint256 prints;
        uint256 total;
        uint256 lastTo;
        uint256 streak;
        uint256 longest;
        uint256 bestAmount;
        uint256 bestIndex;
        uint256 read;
        bool waiting;
    }

    /// @dev Builds up to 14 payrolls rounds of every kind (answered, failed, pending; contiguous,
    /// gapped, overlapping, empty, not over yet; ordinary and absurd amounts), prints them, and compares
    /// the report with the rules applied here step by step.
    function testFuzz_print_matchesTheRules(uint256 seed) public {
        uint256 n = seed % 15;
        Model memory m;
        uint256[] memory amounts = new uint256[](n);
        uint64[] memory froms = new uint64[](n);
        uint64[] memory tos = new uint64[](n);
        uint256 cursor = BASE;

        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 kind = r % 12;
            uint256 shape = (r >> 8) % 12;
            uint256 amount = (r >> 16) % 4 == 0 ? r : (r >> 24) % 200e18;
            uint64 from = uint64(cursor + 1);
            if (shape == 0) from += uint64((r >> 40) % 30 + 1); // a gap
            if (shape == 1) from -= uint64((r >> 40) % 30 + 1); // an overlap
            uint64 to = from + uint64((r >> 56) % 9_000);
            if (shape == 2) to = from - 1; // empty
            if (shape == 3) to = uint64(vm.getBlockNumber() + (r >> 72) % 5); // not over yet

            if (kind == 0) {
                q.pushFailed(PAYROLLS, from, to);
            } else if (kind == 1) {
                q.openRound(PAYROLLS, from, to);
            } else {
                q.pushAnswered(PAYROLLS, amount, from, to);
            }

            // The rules, applied to the same round.
            if (m.waiting) continue;
            if (kind == 1) {
                m.waiting = true;
                continue;
            }
            ++m.read;
            if (kind == 0) continue;
            if (from > to || to >= vm.getBlockNumber()) continue;
            if (m.prints != 0 && from <= m.lastTo) continue;
            if (amount > type(uint128).max) continue;

            // A streak is made of day-sized prints that follow each other without a gap.
            bool day = uint256(to) - from + 1 <= 7_500;
            m.streak = day ? ((m.prints != 0 && from == m.lastTo + 1) ? m.streak + 1 : 1) : 0;
            if (m.streak > m.longest) m.longest = m.streak;
            if (amount > m.bestAmount && day) {
                m.bestAmount = amount;
                m.bestIndex = m.prints;
            }
            amounts[m.prints] = amount;
            froms[m.prints] = from;
            tos[m.prints] = to;
            m.total += amount;
            m.lastTo = to;
            ++m.prints;
            cursor = to;
        }

        uint256 printed;
        for (uint256 i; i < 3; ++i) {
            (uint256 more,) = report.print();
            assertLe(more, 8);
            printed += more;
        }

        assertEq(printed, m.prints);
        JobsReport.Summary memory s = report.summary();
        assertEq(s.prints, m.prints);
        assertEq(s.total, m.total);
        assertEq(s.streak, m.streak);
        assertEq(s.longestStreak, m.longest);
        assertEq(s.bestAmount, m.bestAmount);
        if (m.bestAmount != 0) assertEq(s.bestIndex, m.bestIndex);
        assertEq(s.payrollsRead, m.read);

        uint256 sum;
        for (uint256 i; i < m.prints; ++i) {
            JobsReport.Print memory p = report.printAt(i);
            assertEq(p.amount, amounts[i]);
            assertEq(p.fromBlock, froms[i]);
            assertEq(p.toBlock, tos[i]);
            assertLe(p.fromBlock, p.toBlock);
            if (i != 0) assertGt(p.fromBlock, report.printAt(i - 1).toBlock, "prints never overlap");
            sum += p.amount;
        }
        assertEq(sum, s.total, "the total is the sum of the prints");
    }

    // ---- counts

    /// @dev Two series of windows that each tile forward with random lengths and occasional gaps, as
    /// two feeds on different schedules produce. After printing, every pairing is checked against the
    /// rule applied here to every print and every count: they are paired exactly when the blocks they
    /// share are more than half of the longer window. No print holds two counts, no count joins two
    /// prints, nothing else is attached, and every count is in the total whether paired or not.
    function testFuzz_counts_pairExactlyByTheMostlySharedRule(uint256 seed) public {
        uint256 prints = 1 + seed % 10;
        uint256 counts = 1 + (seed >> 8) % 10;
        uint64[] memory pFrom = new uint64[](prints);
        uint64[] memory pTo = new uint64[](prints);
        uint64[] memory cFrom = new uint64[](counts);
        uint64[] memory cTo = new uint64[](counts);
        uint256[] memory cValue = new uint256[](counts);

        uint256 cursor = BASE;
        for (uint256 i; i < prints; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, "print", i)));
            pFrom[i] = uint64(cursor + 1 + (r % 7 == 0 ? (r >> 8) % 3_000 : 0));
            pTo[i] = pFrom[i] + uint64(lengthOf(r >> 24));
            cursor = pTo[i];
            q.pushAnswered(PAYROLLS, (r >> 64) % 100e18, pFrom[i], pTo[i]);
        }
        cursor = BASE + (seed >> 16) % 8_000;
        uint256 sum;
        for (uint256 j; j < counts; ++j) {
            uint256 r = uint256(keccak256(abi.encode(seed, "count", j)));
            cFrom[j] = uint64(cursor + 1 + (r % 7 == 0 ? (r >> 8) % 3_000 : 0));
            cTo[j] = cFrom[j] + uint64(lengthOf(r >> 24));
            cursor = cTo[j];
            cValue[j] = 1 + (r >> 64) % 500;
            sum += cValue[j];
            q.pushAnswered(HIRES, cValue[j], cFrom[j], cTo[j]);
        }

        for (uint256 i; i < 6; ++i) {
            report.print();
        }
        assertEq(report.printCount(), prints);
        assertEq(report.countsRecorded(), counts);
        assertEq(report.totalCount(), sum, "every count is in the total");

        uint256[] memory joined = new uint256[](counts);
        for (uint256 i; i < prints; ++i) {
            JobsReport.Print memory p = report.printAt(i);
            uint256 partner; // one more than the index of the count the rule gives this print
            for (uint256 j; j < counts; ++j) {
                if (mostlyShared(pFrom[i], pTo[i], cFrom[j], cTo[j])) {
                    assertEq(partner, 0, "two counts for one print: the rule itself would be ambiguous");
                    partner = j + 1;
                }
            }
            if (partner == 0) {
                assertEq(p.hiresRound, 0, "a count was attached that the rule does not give");
                assertEq(p.count, 0);
            } else {
                assertEq(p.hiresRound, partner, "the count the rule gives was not attached");
                assertEq(p.count, cValue[partner - 1]);
                assertEq(joined[partner - 1], 0, "one count joined two prints");
                joined[partner - 1] = i + 1;
            }
        }
        for (uint256 j; j < counts; ++j) {
            JobsReport.Count memory c = report.countAt(j);
            assertEq(c.count, cValue[j]);
            assertEq(c.fromBlock, cFrom[j]);
            assertEq(c.toBlock, cTo[j]);
            assertEq(c.hiresRound, j + 1);
            assertEq(c.print, joined[j], "a count names another print than the one that holds it");
        }
    }

    /// @dev Mostly a day, sometimes a short window, sometimes a catch-up over two or three days.
    function lengthOf(uint256 r) internal pure returns (uint256) {
        uint256 kind = r % 10;
        if (kind == 0) return (r >> 8) % 500;
        if (kind == 1) return 14_000 + (r >> 8) % 7_600;
        return 6_900 + (r >> 8) % 700;
    }

    function mostlyShared(uint256 aFrom, uint256 aTo, uint256 bFrom, uint256 bTo) internal pure returns (bool) {
        uint256 lo = aFrom > bFrom ? aFrom : bFrom;
        uint256 hi = aTo < bTo ? aTo : bTo;
        if (lo > hi) return false;
        uint256 aLength = aTo - aFrom + 1;
        uint256 bLength = bTo - bFrom + 1;
        return 2 * (hi - lo + 1) > (aLength > bLength ? aLength : bLength);
    }
}
