# What IdentityMD's launch pipeline reported, and what was done about each finding

Launch B (`WorkProof`, `WorkOrders`, `CrowdPots`, `Doorbell`) was read by IdentityMD's launch
pipeline on 13 October 2026, before it was deployed as IdentityMD launch 1573. Nobody outside
IdentityMD's network has audited it; the team reviewed it. This file sets out what the public
record shows, as read on 15 October 2026:

- IdentityMD's record of the pipeline job, `GET /jobs/eb0f6c65-174a-45e8-9fe5-9312c66d4880` and
  `GET /jobs/eb0f6c65-174a-45e8-9fe5-9312c66d4880/submissions` on `https://api.imd.fun`: every
  submission of every node, with each finding's title, severity, place in the code, description
  and reproduction;
- the launch repository, <https://github.com/identity-md-launches/launch-1573-please-deploy-repository-contracts>,
  and its pull request 1;
- [`ADAPTATION.md`](../ADAPTATION.md), as the pipeline delivered it. The copy in this folder is the
  same file, byte for byte, as the one on the launch repository's `main`.

IdentityMD records no outside audit or bounty for this launch:
`GET /launches/90de809f-6038-4f0c-9a1f-f3711ea865a9/assurances` answers with a count of 0.

**Where things stand.** Eleven findings are on record, the number the pull request gives. They
come down to the seven that `ADAPTATION.md` answers, because the judge merged four of them into its
own three. One of the seven was of medium severity (rows 8 and 9 below). It was answered by
correcting what the comments and documents said, with two new tests; no compiled code changed.
Of the other six, one says no defect was found and five are limits or trust assumptions that the
documents state; none was changed. The answers cite one file that was never delivered to the
team, and the pipeline's own scratch work was not delivered either (the last section).

## The pipeline job

|                   |                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Job               | `eb0f6c65-174a-45e8-9fe5-9312c66d4880`, plan `shape:chain`, paid by the team's wallet W1, created 13 October 2026, 12:56 UTC   |
| Source it read    | `https://github.com/OoJae/help-wanted.git` at `94fb4730e1a8`, as the pull request says                                         |
| What it delivered | Pull request 1 of the launch repository, merged on 13 October 2026, 15:45 UTC, at `99f4ab0997bc8c9717f2203d8f3834f15d3220e1`   |
| The launch        | Transaction `0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c`, block 26,184,581, 13 October 2026, 15:51 UTC |

The nodes of the job, and what each submitted (13 October 2026, UTC):

| Node                     | Role      | Submissions                                                | Findings                   |
| ------------------------ | --------- | ---------------------------------------------------------- | -------------------------- |
| `audit_imported_code`    | review    | 13:18, accepted                                            | 4, all info                |
| `adapt_contract_project` | implement | 13:38 and 15:07, both accepted                             | none                       |
| `audit_economics`        | review    | 13:59, accepted                                            | 1, info                    |
| `manifest`               | integrate | 14:00 and 15:23, both accepted                             | none                       |
| `audit_flow`             | review    | 14:01, accepted                                            | 2, both info               |
| `audit_math`             | review    | 14:03, accepted                                            | none                       |
| `audit_permissions`      | review    | 14:15, accepted                                            | 1, medium, marked blocking |
| `write_foundry_tests`    | tests     | 14:33 and 15:27, both accepted                             | none                       |
| `audit_judge`            | review    | 14:52, not accepted: it reopened the work; 15:45, accepted | 3 in each                  |

The pull request says: "An independent reviewer raised 11 finding(s)." The accepted review
submissions hold eleven findings between them (4, 1, 2, 0, 1 and the judge's last 3). The judge's
first submission, which reopened the work, holds three more; its last submission restates them as
settled. The pull request also says of its own checks: "**This is not an audit.** Neither
establishes general correctness."

`ADAPTATION.md` answers seven findings by name: the four of `audit_imported_code` (its section 2)
and the judge's three (its section 5). The four findings of `audit_economics`, `audit_flow` and
`audit_permissions` are not named there. The judge's own text says it merged each of them into one
of its three, and the table below gives each with the answer that covers it. IdentityMD's record
holds no identifier for a finding; the eight-character names below are the ones `ADAPTATION.md` and
the judge's text use.

## Every finding, and the answer to it

| #   | Node and severity                                                                    | The finding, in short                                                                                                                                                                                                                                        | The answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Where it stands now                                               |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | `audit_imported_code`, info                                                          | Coverage: the four contracts and their libraries read in full, no defect substantiated                                                                                                                                                                       | `ADAPTATION.md` 2, `c309d5e6`: confirmed, no change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Nothing to do                                                     |
| 2   | `audit_imported_code`, info                                                          | With `allowClaimed = 1` every order the Doorbell opens can be paid to a runner that did no work, if nobody challenges within 24 hours                                                                                                                        | `ADAPTATION.md` 2, `46190b9b`: reproduced; not changed, because it is the setting the requester chose for launch day                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A stated limit: `docs/THREATS.md` L1 and D2                       |
| 3   | `audit_imported_code`, info                                                          | `CrowdPots` never calls `WorkOrders.finalize`, so a pot whose runner claimed delivery stays `Hiring` until somebody calls the desk                                                                                                                           | `ADAPTATION.md` 2, `be85d51c`: reproduced; not changed, a documented design choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A stated limit: `docs/THREATS.md` C5                              |
| 4   | `audit_imported_code`, info                                                          | A runner that posts the opener's bond, down to 0.25 IMD, can hold a receipt-only pot's escrow for its whole delivery time by registering a job id that has no receipt                                                                                        | `ADAPTATION.md` 2, `157f2546`: reproduced; not changed, the bond and the delivery time are the opener's published choices                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A stated limit: `docs/THREATS.md` W5, C2 and C3                   |
| 5   | `audit_economics` (`df1c3820`, in the judge's text), info                            | At the Doorbell's launch values an untrue claim nobody challenges is paid; one that is challenged costs the runner that made it 0.025 IMD, and holds the challenger's 0.25 IMD for up to seven days with no reward                                           | Merged by the judge into `bff72b72` (row 10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | As row 10                                                         |
| 6   | `audit_flow` (`5ac1a4bb`), info                                                      | The Doorbell is launched with `ALLOW_CLAIMED = 1`: each escrow can be taken by an unchallenged bonded claim, and a defender earns nothing for challenging                                                                                                    | Merged by the judge into `bff72b72` (row 10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | As row 10                                                         |
| 7   | `audit_flow` (`a5b4373d`), info                                                      | `chipInFor` accepts the desk, and other contracts that cannot use IMD, as beneficiary; a refund claimed for such a chip is stranded there                                                                                                                    | Merged by the judge into `2094daa9` (row 11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | As row 11                                                         |
| 8   | `audit_permissions`, medium, blocking                                                | A runner can hold a receipt-only order past its expiry and leave with its whole bond, so a crowd pot's one hire can be ended for the swarm's fee alone                                                                                                       | Merged by the judge into `a96c4f58` (row 9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | As row 9                                                          |
| 9   | `audit_judge` (`a96c4f58`), medium and blocking in its first round, info in its last | The `SwarmFailed` and wrong-kind endings of `reportFailed` return the whole bond and never bar the runner, so a receipt-only pot can be held past its hire window and refunded with no bond forfeited, which contradicted what `CrowdPots` told contributors | `ADAPTATION.md` 5: reproduced, both cases. The reviewer offered two ways to close it and left the choice to the authors; the words were corrected, not the desk. Three comments in `src/pots/CrowdPots.sol`, `docs/THREATS.md` W2, W3, W5 and C2, and one row of `docs/LAUNCH.md` were corrected, and two tests added (`test_realDesk_aFailedJobsReceiptPastTheHireWindow_refundsThePotWithTheBondReturned`, `test_realDesk_aWrongKindReceipt_reopensWithTheBondReturned_andTheSameRunnerMayTakeItAgain`). The compiled code of the four contracts did not change. The judge's last submission checked each part and records it as settled | A stated limit: `docs/THREATS.md` W2, W3 and C2                   |
| 10  | `audit_judge`, info (`bff72b72`)                                                     | With `ALLOW_CLAIMED = 1` and no arbiter, each Doorbell escrow is paid to an unchallenged bonded claim, and a correct challenger's best outcome is its own bond back                                                                                          | `ADAPTATION.md` 5: reproduced by trace; not changed; added to its open items with the float a watcher needs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A stated limit: `docs/THREATS.md` D2, L2 and L6                   |
| 11  | `audit_judge`, info (`2094daa9`)                                                     | `chipInFor` accepts the desk, IMD, Payroll and WorkProof as beneficiary; a refund claimed for such a chip is stranded                                                                                                                                        | `ADAPTATION.md` 5: reproduced; not changed, only the payer's own IMD is at stake and the brief asked that the refund rule stay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | A stated limit: `docs/THREATS.md` C11 and `docs/DEVIATIONS.md` D7 |

The judge's first submission (14:52 UTC) holds rows 9, 10 and 11, and its last (15:45 UTC) holds
them again, each at severity info: row 9 as "Settled: ... fixed in words, as offered", rows 10 and
11 as unchanged. The table counts each once. The last submission's summary says the judge built
the accepted commit, `94fb473`, and the tree after the revision, and that the creation and runtime
code of the four contracts hashed the same; and that the whole suite passed, 673 tests and none
failed. `bash scripts/repro.sh` at the root of the HELP WANTED repository compares the code at
each launched address with a build of this folder.

## What the pipeline checked before it deployed

IdentityMD's record of the launch (`GET /launches/90de809f-6038-4f0c-9a1f-f3711ea865a9`) lists
seven admission checks, each `passed`, in these words: provenance, "9 node(s) accepted at
99f4ab09"; findings, "9 accepted submission(s), no unresolved blocking findings"; independent
review, "1 independent review(s)"; bytecode, "8 contract(s) clean and reproducible"; manifest, "4
application contracts; no protocol token or pool"; protected invariants, a suite of one test that
passed; economics, "policy explicitly selects no on-chain contributor rewards".

## What was never delivered to the team

- **`.imd-responses.json`.** `ADAPTATION.md`, section 5, says "The answers are in
  `.imd-responses.json`", and the adapter's submission of 15:07 UTC says all three reopened
  findings are answered there. The file is not in the launch repository: not on `main`, not on the
  branch `identitymd/result`, and in none of the nine commits of pull request 1 (read on
  15 October 2026). The adapter's submission lists no artifact. The team has never seen it. What
  it answered can be read from `ADAPTATION.md` section 5 and from the judge's last submission.
- **`.imd-findings.json`.** The judge's summaries name it as the file each of its rounds wrote. It
  is not in the launch repository either. The findings it held, and the judge's coverage records,
  are in IdentityMD's record of the job.
- **The reproductions in `test/scratch/`.** `ADAPTATION.md`, section 3, says the three
  reproductions of the imported findings were run there and are not part of the submission; the
  judge's first summary names its own scratch test. None of them is in the launch repository. The
  two tests that pin the medium finding's cases are (row 9).
