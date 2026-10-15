# Where this launch departs from IdentityMD's guidance, and why

IdentityMD publishes guidance for contracts-only launches (the `evm_contracts` launch skill and the
skill for adapting a project to it), for measuring and documenting a project (the gas-and-size and
readme skills), and an API guide that says how its work records are served and recorded. Its launch
pipeline also showed, by what it changed in our first launch before deploying it, what it expects
of a contract. This document lists every place where the four contracts, or this repository, do
something else, the reason, and what the choice costs. A second part lists where the contracts
differ from our own first design, because a reader who has seen an earlier description of the
product will meet those too.

What is followed without change comes first.

## Followed as written

- Every constructor is nonpayable, takes only static words (an address, an unsigned integer, a bool
  or a `bytes32`; at most eight), makes no external call and checks no code size
  (`test_launch_constructorsMakeNoCallAndNoCodeCheck`,
  `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes`). Each dependency is checked on
  first use instead: `CrowdPots` asks the desk for its token and its minimums when a pot opens
  (`test_openPot_revertsWhenTheDeskHasNoCode`, `test_openPot_revertsWhenTheDeskEscrowsAnotherToken`);
  `WorkProof` treats every answer of the registry as untrusted on every call.
- Nothing is called after deployment. There is no proxy, no initializer, no pausing, no freezing,
  no minting, and no DELEGATECALL, CALLCODE or SELFDESTRUCT
  (`test_launch_runtimeBytecodeHasNoForbiddenOpcode`).
- No constructor stores `msg.sender`, which at launch is the factory.
- The manifest names four contracts, references only earlier ones, and the repository carries no
  `launch.json`.
- Values that never change are constants (the fee, the windows, the gas allowances, the Doorbell's
  spec), not constructor arguments.
- A work record is hashed exactly as served, with nothing stripped or added. IdentityMD's API
  serves each record at `/work-records/<hash>.json`; all 41 records we fetched hash, as served, to
  the hash in their path and to the value the registry holds.
- `README.md` leads with what the project is and what is not yet true of it, gives the commands in
  the order they are run, and lists every entry point with who may call it and what makes it
  revert.

## D1. No owner, so `$owner` is not used and nothing can be changed

**Guidance.** "In a contracts-only launch, every owner or admin role is a constructor argument
filled by `$owner`, the wallet that paid for the launch, unless the brief names another owner."

**What we do.** There is no owner or admin role in any of the four contracts, so there is nothing
for `$owner` to fill. The three addresses the desk depends on (IMD, WorkProof, Payroll), the
registry behind WorkProof, and every number are fixed at construction or in the code.

**Why.** An owner who could replace WorkProof could pay any order to itself. An owner who could
replace Payroll could redirect every fee. The product's claim is that nobody can.

**What it costs.** Nothing can be corrected after launch. If IdentityMD moves its registry to a
new address or changes the form of a work record, no new receipt can be proven and the proven path
stops; orders then end by timeout or refund (nothing is lost), and resuming takes a new launch. A
wrong Payroll address, a wrong kind for the Doorbell, a wrong bound: each is permanent.
`docs/LAUNCH.md` exists to get them right once.

## D2. A verifier built on an interface IdentityMD has not published

**Guidance.** There is none to follow. IdentityMD's API guide names the WorkRegistry
("Append-only receipts for work, and the reviews written with them"), serves each work record under
its hash and lists a job's record hashes at `/jobs/:id/records`. It publishes neither the
registry's source nor its ABI, nor a statement of the canonical form of a work record.

**What we do.** `WorkProof` calls `latest(bytes16)` (selector `0xebe9712c`), a function we
recovered by matching selectors against the registry's live transactions and confirmed on 41 real
jobs. It parses the record on chain under rules we read off those 41 records (`JsonScan`, rules 1
to 6): key order, no whitespace, the schema string, the form of the job id.

**Why.** There is no other way to settle an escrow on IdentityMD's own receipt without a third
party in between. The alternative, an off-chain attester of our own, would be exactly the trusted
key this product does without.

**What it costs.** Both are observations, not promises. If the registry's function or the record's
form changes, proofs stop for new records (`docs/THREATS.md`, P4). The registry is called
defensively so that no change in it can make a wrong proof pass: only make proofs fail.

## D3. Only the per-job receipt is supported

**Guidance.** "Oracle work is recorded once a day, not once a job": each finished oracle job's
document goes into a Merkle tree over `(jobId, documentHash)` and one receipt carries the day's
root, to be checked with a Merkle proof. "Contract, website and research work still gets a receipt
per job."

**What we do.** `WorkProof` proves per-job receipts only. It has no Merkle path.

**Why.** The desk hires contract, website, research and media work, which is recorded per job. An
order for oracle work would be better bought from the Intake directly, as our first launch does.

**What it costs.** An order whose kind is an oracle job's cannot be settled on a receipt.

## D4. The latest receipt only; the registry's history is not read

**Guidance.** None published. The registry does keep earlier receipts (`receipts(bytes32)` answers
for a superseded record's hash).

**What we do.** `prove` accepts the record whose hash `latest(jobId)` returns and no other.

**Why.** One rule, one read, no question of which receipt counts.

**What it costs.** A job's first receipt stops proving once a second is written, and the second
names no agents, so a settlement made after it tips Payroll's seat pool and not the agents that
worked (`docs/THREATS.md`, P2 and P3).

## D5. Machine text at the start of a job's objective

**Guidance.** A job's objective is the requester's brief in plain language. IdentityMD's free
check suggests naming sources, a period and a format.

**What we do.** A runner must begin the objective with 85 bytes that are not for the swarm:
`[help-wanted order <64 hex>] `, then the employer's spec unchanged. The spec is limited to
printable ASCII without `"` and `\`.

**Why.** The header is what ties one swarm job to one claim of one order; without it any job with
the same text could be passed off as another's. The character rule makes the text identical before
and after JSON escaping, so hashes of raw bytes can be compared.

**What it costs.** A job text cannot hold a line break, a quotation mark or a non-ASCII letter,
and it is at most 7,900 bytes so that it fits IdentityMD's 8,000-character limit with the header.
IdentityMD's free check accepted an objective that began with a header (no blockers, 11 October
2026), and the one real job we bought with such an objective (a research report, 13 October 2026)
was stored with the header unchanged and its template as the record's kind
(`test/proof/WorkProof.headerJob.t.sol`; `docs/LAUNCH.md`, section 5, says what that job does and
does not show).

## D6. No gas snapshot file

**Guidance.** The gas-and-size skill asks for `forge snapshot` output in `.gas-snapshot` and a
report in `artifacts/gas.md`.

**What we do.** Neither file is in the repository. Sizes and gas figures are in `README.md` and
`docs/LAUNCH.md`, each beside the test that prints it, and the figures that matter are asserted:
the size gates, the launch gas gate, a ceiling for each settlement, the cost ceilings of the
scanner.

**Why.** A snapshot of every test's gas changes with every test edit and says little about what a
user pays. The figures a user pays for are measured by tests written for that.

**What it costs.** A tool that looks for `.gas-snapshot` finds none. `forge snapshot` runs on this
repository and writes one.

## D7. A refund is paid to a contract at anybody's call

**Guidance.** None is published. The practice is what IdentityMD's pipeline did to our first
launch before deploying it: where `Payroll` paid a seat's owner at anyone's call, the pipeline made
an owner that is a contract claim for itself, so that nobody can force a payout into a contract
that cannot use it.

**What we do.** `CrowdPots.claimRefund(potId, contributor)` and `claimRefunds` may be called by
anyone for any contributor, a contract included, and the desk pays an order's employer, runner and
challenger whenever the call that ends a claim is made, whoever makes it.

**Why.** The two cases differ in one thing. A seat is a token that can be moved, so its payout
followed it into whatever contract held it, and the seat's real owner could lose the money to a
stranger's call. A chip, an order and a challenge cannot be moved: the payee is the address that
took the role itself, or that the payer named, and the money can never go anywhere else. A
stranger's call decides when it is paid and nothing more. Closing `claimRefund` to contract
contributors would protect nobody's money and would strand the refund of every contributor that
can receive IMD and cannot make the call.

**What it costs.** A contract that chips in, or is named as a beneficiary, receives its refund at
a moment it did not choose. It must keep its books from `chipOf` (and an employer contract from
`accountOf(id).returned`), not from the moment a payment arrives. Whoever names a beneficiary that
cannot use IMD has given that IMD away. `docs/THREATS.md`, C11 and section 11.

## Where the contracts differ from our own first design

Our design came first; reviews and fixes changed some rules. Each difference below was decided,
and is listed so that a reader who has seen an earlier description is not surprised. None is a
departure from IdentityMD's guidance.

| Contract   | The first design                                                                                  | What the code does                                                                                                   | Why                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| WorkOrders | In a dispute, a receipt with another hash than the one the runner named counts against the runner | Any receipt of the registered job that passes the settlement checks pays the runner                                  | A job can be given a second receipt; the first rule took an honest runner's bond. |
| WorkOrders | An undecided dispute returns both bonds                                                           | The employer is refunded, the challenger made whole, the runner loses a tenth of its bond to the employer            | So that claiming and challenging oneself is never cheaper than releasing.         |
| WorkOrders | A refuted claim gives the whole bond to the challenger                                            | A tenth to the employer, the rest to the challenger                                                                  | The same reason.                                                                  |
| WorkOrders | A completed receipt of another kind is the runner's to report                                     | Anyone may report it; the bond returns to the runner                                                                 | The order is free as soon as the receipt exists.                                  |
| WorkOrders | `release` at any time before registering                                                          | Only inside the one-hour claim window                                                                                | A runner that overstays cannot swap an eviction for a tenth.                      |
| WorkOrders | A delivery claim needs 24 hours before the deadline                                               | 48 hours: the challenge window and a day to decide                                                                   | A challenge in the last second still leaves a day.                                |
| WorkOrders | The price ramp runs on while an order is held                                                     | It stands still                                                                                                      | Holding an order cannot push its price up.                                        |
| WorkOrders | No upper bound on the delivery time                                                               | 90 days                                                                                                              | One bond must not be able to hold an escrow, or a challenger's bond, for years.   |
| WorkOrders | `returned` stops at its maximum                                                                   | It is exact; `claim` refuses an order whose books could overflow                                                     | Employer contracts keep their books from it.                                      |
| WorkOrders | A failed Payroll call falls back whatever gas it had                                              | The desk requires 1,000,000 gas for each call up front                                                               | So that a caller cannot force the plain-transfer path by sending too little gas.  |
| WorkOrders | Fee and tip rounded down                                                                          | Rounded up; the runner gets what is left                                                                             | Rounding favours the fee side.                                                    |
| WorkOrders | Separate events for each way a claim ends                                                         | One event, `ClaimEnded`, with the reason and the three amounts                                                       | Every bond that leaves without a delivery leaves from one place.                  |
| WorkProof  | `agentIds` lists every agent in `signals`                                                         | An agent whose signal records a rejected submission is left out                                                      | A tip should not reward a rejected attempt.                                       |
| WorkProof  | The scanner refuses backslashes in keys                                                           | Keys are 1 to 31 ASCII bytes, the last byte must close the object, bare literals hold letters, digits and `+-.` only | One text per record. `docs/THREATS.md`, P4.                                       |
| CrowdPots  | The kind is a hash in the terms                                                                   | The kind is text in the terms; the pot stores and pins its hash and gives the text back                              | A contributor can read what is being ordered.                                     |
| CrowdPots  | A hard deadline                                                                                   | A full pot can be launched for one more day                                                                          | A pot that filled in its last second can still hire.                              |
| CrowdPots  | `reconcile` only reads the desk                                                                   | It first makes the desk call the order is waiting for (`refund`, `evict`, `timeout`)                                 | A contributor needs no keeper.                                                    |
| CrowdPots  | Its own copy of the desk's spec rules                                                             | The desk's own library, `SpecText`                                                                                   | One rule, one piece of code.                                                      |
| Doorbell   | The claimed path on, as a constant                                                                | A constructor argument                                                                                               | So that it can be decided on launch day by whether receipts are arriving.         |
| Doorbell   | No upper bound on its delivery time                                                               | 30 days                                                                                                              | The desk refuses orders far beyond it.                                            |
