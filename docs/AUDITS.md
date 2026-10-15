# What IdentityMD's launch pipeline reported, and what was done about each finding

Launch C (`Rules`, `Endowments`, `Zap`) was read by IdentityMD's launch pipeline on 15 October 2026,
before it was deployed as IdentityMD launch 1845. Nobody outside IdentityMD's network has audited
it; the team reviewed it. This file sets out what the public record shows, as read on 15 October
2026:

- IdentityMD's record of the pipeline job, `GET /jobs/7f2023fc-fa1f-4a7f-a507-3bbc712c51d6` and
  `GET /jobs/7f2023fc-fa1f-4a7f-a507-3bbc712c51d6/submissions` on `https://api.imd.fun`: every
  submission of every node, with each finding's title, severity, place in the code, description
  and reproduction;
- the launch repository, <https://github.com/identity-md-launches/launch-1845-please-deploy-repository-contracts>,
  and its pull request 1;
- [`ADAPTATION.md`](../ADAPTATION.md), as the pipeline delivered it. The copy in this folder is the
  same file, byte for byte, as the one on the launch repository's `main`.

IdentityMD records no outside audit or bounty for this launch:
`GET /launches/833dbd2c-fb6a-44c7-81a0-f75292e202e8/assurances` answers with a count of 0.

**Where things stand.** Thirteen findings are on record, the number the pull request gives: six
low and seven info, none marked blocking. They come down to seven matters. The judge's five each
restate one of the five findings of the four specialist reviewers, and the specialist on economics
recorded again a matter the audit of the imported code had raised. `ADAPTATION.md` answers the
three findings of that audit by name: two were reproduced with new tests and kept as they were,
with sentences added to `docs/THREATS.md`, and the third is a note on what was read. The other ten
were raised after the pipeline's one adaptation of the code had been accepted, and no node of the
job answered them. No file was changed for them, and the contracts were deployed as they were. Four
of the seven matters are limits that `docs/THREATS.md` stated in part or not at all before the
launch. It states them since 15 October 2026, after the launch (rows 4 to 7 below). Nothing beyond
`ADAPTATION.md` and its two tests was delivered to the team in answer to any finding (the last
section).

## The pipeline job

|                   |                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Job               | `7f2023fc-fa1f-4a7f-a507-3bbc712c51d6`, plan `shape:chain`, paid by the team's wallet W1, created 15 October 2026, 11:45 UTC   |
| Source it read    | `https://github.com/OoJae/help-wanted.git` at `01d9b26f1831`, as the pull request says                                         |
| What it delivered | Pull request 1 of the launch repository, merged on 15 October 2026, 13:15 UTC, at `6ad9a2022a27a9e8170275fdb6bf253bc214fe03`   |
| The launch        | Transaction `0x1806c02e5e38d4c8496476b3f3cf39f250a9d0c97ff5834c75a0475a12bd62fb`, block 26,198,165, 15 October 2026, 13:18 UTC |

The nodes of the job, and what each submitted (15 October 2026, UTC):

| Node                     | Role      | Submissions                                                               | Findings         |
| ------------------------ | --------- | ------------------------------------------------------------------------- | ---------------- |
| `audit_imported_code`    | review    | 12:00, accepted                                                           | 3: 2 low, 1 info |
| `adapt_contract_project` | implement | 12:19, accepted                                                           | none             |
| `manifest`               | integrate | 12:22, not accepted (its clone of the repository failed); 12:32, accepted | none             |
| `audit_math`             | review    | 12:36, accepted                                                           | 1, info          |
| `audit_flow`             | review    | 12:37, accepted                                                           | 1, low           |
| `audit_permissions`      | review    | 12:48, accepted                                                           | 2: 1 low, 1 info |
| `write_foundry_tests`    | tests     | 12:50, accepted                                                           | none             |
| `audit_economics`        | review    | 13:02, accepted                                                           | 1, info          |
| `audit_judge`            | review    | 13:15, accepted                                                           | 5: 2 low, 3 info |

The pull request says: "An independent reviewer raised 13 finding(s). Those with a concrete
reproduction reopened the implementation before this was accepted." The accepted review
submissions hold thirteen findings between them (3, 1, 1, 2, 1 and 5). In this job nothing was
reopened: the record gives every node one attempt (the manifest two, after the failed clone) and no
revision, and the adapter's one submission, at 12:19 UTC, came before every finding but the three
of `audit_imported_code`. The pull request also says of its own checks: "**This is not an audit.**
Neither establishes general correctness."

What the pull request delivered: eight files, none of them under `src/`. `ADAPTATION.md`; a new
count of tests in `README.md`; sentences in `docs/THREATS.md` (E3, E5 and E12); `launch.json`, which
the manifest node wrote; `test/endowments/Endowments.audit.t.sol`, the adapter's two tests; and
three files of tests from `write_foundry_tests` (`test/endowments/Endowments.edges.t.sol`,
`test/rules/RulesEdges.t.sol`, `test/rules/ZapDelta.t.sol`, 24 tests that found no defect). With
them the default suite runs 441 tests in 23 suites. Every file on the launch repository's `main` is
in this folder, and each is the same byte for byte (compared on 15 October 2026), apart from
`README.md`, `docs/LAUNCH.md` and `docs/THREATS.md`, which the team has brought up to date since the
launch. This file is the team's own, written after the launch.

The judge's summary says that it built the project with the pinned settings, that all 441 tests
passed, that all five specialist findings reproduce, and: "Nothing blocks the launch." IdentityMD's
record holds no identifier for a finding; the eight-character names below are the ones
`ADAPTATION.md` uses.

## Every finding, and the answer to it

| #   | Node and severity           | The finding, in short                                                                                                                                                                                                                                                                                                                          | The answer                                                                                                                                                                                                                                            | Where it stands now                                                 |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `audit_imported_code`, low  | Anyone can put one wei into sIMD in Endowments' name in every block; while that goes on, every harvest and every IMD withdrawal that needs the vault reverts. Principal can still leave in kind                                                                                                                                                | `ADAPTATION.md`, `fb892c57`: reproduced (`test_audit_aStrangerCanHoldTheVaultEveryBlock_andOnlyTheInKindExitIsOpen`); not changed, as the finding itself concludes, because the hold is sIMD's rule. E3 now says the hold has no upper bound          | A stated limit: `docs/THREATS.md` E3 and E12                        |
| 2   | `audit_imported_code`, low  | While Questions states no cost for a meter endowment's feed, its yield cannot leave, even after the last depositor has gone; if the feed is never sold again, it stays for good                                                                                                                                                                | `ADAPTATION.md`, `04444071`: reproduced (`test_audit_aMeterEndowmentsYieldWaitsForAsLongAsTheFeedIsNotSold`); not changed, because the fallback the finding sketches would give the yield a second address. E5 and E12 now say the wait may never end | A stated limit: `docs/THREATS.md` E5 and E12                        |
| 3   | `audit_imported_code`, info | Coverage: the three contracts read in full; the live sources of Questions, WorkOrders and CrowdPots were not in the checkout                                                                                                                                                                                                                   | `ADAPTATION.md`, `3dcaa097`: not a defect, nothing to do                                                                                                                                                                                              | Nothing to do                                                       |
| 4   | `audit_math`, info          | A pot harvest has no `MIN_HARVEST` floor on what the pot still needs: a pot one wei short is harvested, which costs the caller the gas of a pot harvest to move one wei. Nothing is lost                                                                                                                                                       | Not answered by any node; not changed                                                                                                                                                                                                                 | A stated limit since 15 October 2026: `docs/THREATS.md` E7          |
| 5   | `audit_flow`, low           | Endowments accepts this launch's own `Zap` as a recipient or a fallback beneficiary, and Zap hands the IMD it holds to whoever calls it next, so the caller of `harvest` can take the yield in the same transaction. The same holds for a PAY rule of `Rules` whose recipient is Zap. Only yield or the PAY amount is exposed, never principal | Not answered by any node; not changed. The fixes offered (Zap returns only what the call produced, or the address is named in the documents) were not made                                                                                            | A stated limit since 15 October 2026: `docs/THREATS.md` Z4          |
| 6   | `audit_permissions`, low    | `createForPot` accepts a pot that already needs nothing. Such an endowment pays every harvest to its fallback beneficiary, though its `Created` event names a pot. `createForMeter` refuses the matching case                                                                                                                                  | Not answered by any node; not changed. The fix offered (refuse a pot whose `remaining` is zero at creation) was not made                                                                                                                              | A stated limit since 15 October 2026: `docs/THREATS.md` E9, with E6 |
| 7   | `audit_permissions`, info   | `createRule` refuses condition fields a rule does not use, but accepts action fields it does not use (a PAY half on a HIRE rule, a HIRE half on a PAY rule) and publishes them in `RuleCreated`; the stored rule has only its own half. No money moves on the unused half                                                                      | Not answered by any node; not changed                                                                                                                                                                                                                 | A stated limit since 15 October 2026: `docs/THREATS.md` R11         |
| 8   | `audit_economics`, info     | Row 1 again, weighed for its economics and recorded as accepted by the requester; no change asked for                                                                                                                                                                                                                                          | As row 1                                                                                                                                                                                                                                              | As row 1                                                            |
| 9   | `audit_judge`, low          | Row 6, "Merged from audit_permissions"                                                                                                                                                                                                                                                                                                         | As row 6                                                                                                                                                                                                                                              | As row 6                                                            |
| 10  | `audit_judge`, low          | Row 5, "Merged from audit_flow"                                                                                                                                                                                                                                                                                                                | As row 5                                                                                                                                                                                                                                              | As row 5                                                            |
| 11  | `audit_judge`, info         | Row 4, "Merged from audit_math"                                                                                                                                                                                                                                                                                                                | As row 4                                                                                                                                                                                                                                              | As row 4                                                            |
| 12  | `audit_judge`, info         | Row 7, "Merged from audit_permissions"                                                                                                                                                                                                                                                                                                         | As row 7                                                                                                                                                                                                                                              | As row 7                                                            |
| 13  | `audit_judge`, info         | Row 8, "Merged from audit_economics", "accepted by design"                                                                                                                                                                                                                                                                                     | As row 1                                                                                                                                                                                                                                              | As row 1                                                            |

The three contracts have no owner and no upgrade path. A change to any rule in rows 4 to 7 would
need a new launch. The sentences `docs/THREATS.md` gained for them say what each reviewer showed on
their own copy of the code. Row 4 is also shown by a test this repository held before the review
(`test_harvest_pot_aPotThatNeedsOneWeiIsSentOneWei`); rows 5 to 7 are shown by no test here.

## What the pipeline checked before it deployed

IdentityMD's record of the launch (`GET /launches/833dbd2c-fb6a-44c7-81a0-f75292e202e8`) lists
seven admission checks, each `passed`, in these words: provenance, "9 node(s) accepted at
6ad9a202"; findings, "9 accepted submission(s), no unresolved blocking findings"; independent
review, "1 independent review(s)"; bytecode, "4 contract(s) clean and reproducible"; manifest, "3
application contracts; no protocol token or pool"; protected invariants, a suite of one test that
passed; economics, "policy explicitly selects no on-chain contributor rewards". `bash scripts/repro.sh`
at the root of the HELP WANTED repository compares the code at each launched address with a build
of this folder; on 15 October 2026 it printed a match for all three contracts.

## What was never delivered to the team

- **`.imd-findings.json`.** The summaries of `audit_imported_code`, `audit_math`, `audit_flow`,
  `audit_permissions`, `audit_economics` and `audit_judge` name it as the file each wrote. It is not
  in the launch repository: not on `main`, not on the branch `identitymd/result`, and in none of the
  four commits of pull request 1 (read on 15 October 2026). The findings it held, and each
  reviewer's coverage records, are in IdentityMD's record of the job.
- **The reviewers' reproductions.** The judge says that one scratch test file,
  `test/scratch/Specialists.t.sol`, reproduces four of the specialist findings, and that an
  existing test of this repository covers the fifth. `audit_imported_code` says it reproduced its
  two findings in a scratch test, and `audit_math`, `audit_permissions` and `audit_economics` say
  they removed theirs. None of them is in the launch repository. Rows 1 and 2 are pinned by the
  adapter's two tests, which are, and row 4 by a test this repository already held; rows 5 to 7
  by no test here.
- **An answer to the ten later findings.** No node answered them, and the record names no file of
  answers. What the team knows of them is what the record holds.
