# HELP WANTED, launch A: Standing Questions, the Robot Jobs Report and Payroll

Three contracts for Ethereum mainnet with no owner and no token. `Questions` keeps buying its own
answers from the IdentityMD oracle and publishes them as feeds; `JobsReport` turns two of those
feeds into a daily public record of what the IdentityMD swarm was paid; `Payroll` splits every IMD
it receives between sIMD stakers, the owners of the 2,000 seats and the meters that keep those
feeds funded.

**Status, read this first.**

- **Not deployed.** Nothing in this repository has been sent to a chain. `docs/LAUNCH.md` is the
  launch request and the runbook.
- **The three house feeds have not been accepted by the live oracle yet.** No request with their
  bodies has been bought. `docs/LAUNCH.md`, section 5, is the proof to obtain before launch.
- **Oracle answers in the tests are signed by a test key**, with two exceptions: 23 real
  attestations saved as fixtures are verified and stored end to end, and the protocol's own
  conformance test passes. The Intake is a stand-in in the default suite and the live contract in
  the fork suite.
- **Not audited by a third party.** `docs/THREATS.md` lists every trust root and every known
  limit; `docs/DEVIATIONS.md` lists where we depart from IdentityMD's guidance.

This is the first of three launches of HELP WANTED. The later ones (a hire desk and its employers)
pay their fees into `Payroll` and read feeds from `Questions`; this launch needs nothing from them.

## Build and test

Foundry is the only requirement. Dependencies (forge-std, OpenZeppelin Contracts 5.5.0) are
vendored in `lib/`, so no network is needed for the first three commands.

```sh
forge fmt --check
forge build --sizes
forge test
```

`forge test` runs 454 tests in 42 suites and needs no network. It skips the fork tests.

```sh
FOUNDRY_PROFILE=fork forge test
```

runs the 19 fork tests against Ethereum mainnet at the latest block, through the RPC named in
`foundry.toml`. Each fork test skips itself when the RPC cannot be reached. They include a
rehearsal of this launch through IdentityMD's real ProjectFactory, called as the launch deployer.

```sh
slither . --filter-paths "lib|test"
```

reports no finding of high or medium impact (Slither 0.11.4). Its 19 low findings and the eleven
places where the source silences a detector are explained one by one in `docs/THREATS.md`, section 8.

The compiler settings are the ones a launch requires and are in `foundry.toml`: solc 0.8.26, EVM
version cancun, optimizer at 200 runs, `via_ir`, `bytecode_hash = "none"`, `cbor_metadata = false`.
A full build takes a few minutes because of `via_ir`.

## The contracts

| Contract | File | Runtime bytes | Initcode bytes | Holds money |
|---|---|---|---|---|
| `Questions` | `src/questions/Questions.sol` | 22,986 | 24,395 | The feeds' meters and keepers' tips |
| `JobsReport` | `src/payroll/JobsReport.sol` | 9,320 | 9,618 | No |
| `Payroll` | `src/payroll/Payroll.sol` | 11,561 | 12,268 | Fees until they are paid out |

The limits are 24,576 bytes of runtime code and 49,152 of initcode; our own gates are 23,000 and
46,000, and a test fails above them. `Questions` is 14 bytes under our gate.

Supporting code: `src/questions/OracleAttestation.sol` is IdentityMD's library and base contract,
copied unchanged. `src/questions/QuestionBody.sol` builds a request body and the question hash an
answer must carry from one stored text. `src/interfaces/` holds the two interfaces later launches
compile against (`IQuestions`, `IPayroll`) and the outside contracts as this launch sees them.
`src/interfaces/external/Mainnet.sol` lists mainnet addresses for tests and documents; no deployed
contract imports it.

### How they fit together

1. Anyone creates a **feed** in `Questions`: a question about this chain, with a cadence in blocks.
   A feed's id is the hash of its parameters and text.
2. Anyone puts IMD on the feed's **meter** with `fund` and holds shares of it. A funder can take
   back, at any time, its share of whatever the meter has not spent.
3. When the feed is due, anyone calls `request`. The contract pays the IdentityMD Intake from the
   meter (0.5 IMD today), sends the question for the newest block window, and sets the feed's
   keeper tip aside for the caller.
4. The oracle's signed answer comes back through the Intake's callback. `Questions` checks the
   signature, the question hash, the window, the panel and the closing block's hash, stores the
   answer as one word, and the tip becomes the keeper's. A round that gets no answer is closed by
   `abandon`; its tip goes back to the meter and the feed waits longer before asking again.
5. Anyone calls `JobsReport.print`, which copies answered rounds of the "payrolls" and "hires"
   feeds into a public record: one print per day, a running total, a best day and a streak.
6. `Payroll` receives fees through `pay` or by plain transfer. Half is streamed to sIMD stakers
   over seven days, 30% accrues to the 2,000 seats, 20% tops up the three house feeds' meters. Tips
   for the agents that did a job wait for the owner of the seat each agent is bound to.

## Every entry point

No function in any of the three contracts is restricted to an owner or an admin: there is none.
"Anyone" below means any account or contract. Every function that moves IMD holds one
transient-storage lock per contract, so a nested call into the same contract reverts
`ReentrancyGuardReentrantCall`.

The three tables are complete. `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes`
reads each contract's ABI as the compiler wrote it and fails if a contract has a state-changing
function that is not in its table, a payable function, a `receive` or a fallback.

### Questions

| Function | Who may call | What it does | Reverts when |
|---|---|---|---|
| `createFeed(params, qPrefix, tail)` | Anyone | Registers a feed and returns its id. Creating a feed that exists returns its id and changes nothing. | `BadFeed(fault)`: a parameter is out of range, the tip is above the price cap, the text is not the feed's canonical document, or the body would be longer than 16,384 bytes. |
| `fund(feedId, amount)` | Anyone, having approved `amount` | Pulls IMD onto the meter and mints shares to the caller. | `UnknownFeed`; `ZeroAmount` (nothing asked or nothing arrived); `ZeroShares`; the token transfer fails. |
| `fundFor(feedId, amount, beneficiary)` | Anyone, having approved `amount` | The same, with the shares minted to `beneficiary`. | As `fund`; `ZeroAddress` for a zero beneficiary. |
| `defund(feedId, shares)` | A holder of shares | Burns shares and pays the caller their part of the unspent meter. More shares than held means all of them. Never blocked by the feed's state. | `NothingToDefund`: the caller holds no shares of this meter. |
| `request(feedId)` | Anyone | Buys the feed's next answer from the Intake with the meter's IMD. Sets the tip aside for the caller. | `RequestBlocked(why)`: unknown feed, a second request in one transaction, a round pending, too soon, no blocks yet, gate closed, action not sold, price above the feed's cap, or meter too low. `PriceNotTaken`, `RequestIdReused`, `MetersNotCovered` if the Intake misbehaves. |
| `onOracleResult(requestId, attestation, signature)` | **The Intake only** | Stores the oracle's answer for the pending round and credits the tip to the keeper that opened it. | `NotTheIntake`; `UnknownRequest`; the attestation is expired, not yet valid, not signed by the oracle signer for this contract, already used by this feed, or does not match the round's chain, question hash, window, answer type, panel, quorum, agreement or closing block hash; `MalformedAnswer`. |
| `submit(feedId, attestation, signature)` | Anyone | Hands in an answer the callback missed. The tip goes to the caller. | `UnknownFeed`; `SubmitNeedsPinnedQuestion`; `SubmitNotForPanelEvidence`; `NoPendingRound`; `SubmitTooEarly(opensAt)` until the Intake has completed the round's request or two hours have passed; then every check of the callback. |
| `abandon(feedId)` | Anyone | Closes a pending round that will not be answered and returns its tip to the meter. Returns `false` when the call only started the thirty-minute wait. | `UnknownFeed`; `NoPendingRound`; `TooEarlyToAbandon(notBefore)`. |
| `collectTips()` | Anyone | Pays the caller the tips it has earned. Pays nothing, without reverting, when none are earned. | Only if the token transfer fails. |
| `reveal(feedId, round, answer)` | Anyone | Publishes, in an event, the list behind a list-typed round. Stores nothing. | `NothingToReveal`; `WrongAnswerBytes`. |

Views: `latest`, `roundOf`, `roundRequest`, `roundCount`, `costOf`, `meterOf`, `sharesOf`,
`redeemable`, `tipsOf`, `feedParams`, `feedText`, `feedState`, `feedCount`, `feedAt`,
`feedOfRequest`, `canRequest`, `canSubmit`, `canAbandon`, `nextBody`, `gateOpen`, `feedIdOf`,
`checkFeed`, `usedBy`, `consumed`, `attestationDigest`, `totalMetered`, `totalTips`. `feedParams`,
`feedText`, `nextBody` and `gateOpen` revert `UnknownFeed` for a feed that does not exist, and
`feedAt` reverts past the end of the list; the others answer with zeros (`feedState` with
`exists` false).

### JobsReport

| Function | Who may call | What it does | Reverts when |
|---|---|---|---|
| `print()` | Anyone | Copies newly answered rounds of the payrolls and hires feeds into the report, at most eight rounds a call, and attaches counts to prints. A call with nothing new changes nothing. It never reads the employers feed. | Only if `Questions` reverts. |
| `crown(round, answer)` | Anyone holding the attested list | Publishes the top three of one answered round of the employers feed, after checking the bytes against the hash `Questions` stored. | `AlreadyCrowned`; `RoundNotAnswered`; `AnswerMismatch`; `BadAnswer`. |

Views: `printCount`, `printAt`, `latestPrint`, `printsPage`, `latestPrints`, `countsRecorded`,
`countAt`, `countsPage`, `latestCounts`, `crownOf`, `latestCrown`, `crownCount`, `crownsPage`,
`summary`, `total`, `totalCount`, `bestAmount`, `bestIndex`, `latestCrownedRound`. `printAt` and
`countAt` revert `NoSuchPrint` and `NoSuchCount` past the end.

### Payroll

| Function | Who may call | What it does | Reverts when |
|---|---|---|---|
| `pay(amount, memo)` | Anyone, having approved `amount` | Pulls IMD and books it: 50% stakers, 30% seats, 20% feeds. A zero amount does nothing. | Only if the token transfer fails. |
| `book()` | Anyone | Books IMD that arrived by plain transfer, split the same way. Returns the amount, zero when nothing new arrived. | Only if the token's balance cannot be read. |
| `tip(agentIds, amount)` | Anyone, having approved `amount` | Pulls IMD and credits it equally to the first 16 ids; the remainder, or everything for an empty list, joins the seat pool. | Only if the token transfer fails. |
| `drip()` | Anyone | Sends the vested part of the stakers' stream to sIMD, at most one hour of stream per call. Returns zero when nothing has vested. | `DripTooSoon(notBefore)` inside ten minutes of the last drip; `StakingVaultNotReady` when sIMD does not answer as a vault over IMD with shares outstanding. |
| `claimSeat(tokenId)` | Anyone | Pays a seat's share of the seat pool to whoever owns the seat now. | `UnknownSeat`; `SeatHasNoOwner`. |
| `claimSeats(tokenIds)` | Anyone | The same for a list of at most 200 ids. Skips what it cannot pay. | `TooManySeats`. |
| `claimTip(agentId)` | Anyone | Pays an agent's tips to the owner of the seat the agent is bound to. | `AgentNotBound`; `AgentBoundElsewhere`; `SeatHasNoOwner`; `GasTooLow`. |
| `sweepTip(agentId)` | Anyone | Moves the part of an agent's tips that has waited 180 to 360 days, and still cannot be claimed, to the seat pool. | `TipNotSweepableYet(agentId, notBefore)`; `TipStillClaimable`; `GasTooLow`. |
| `fundFeeds()` | Anyone | Tops the three house feeds' meters up to their runways from the feed budget, then releases budget that has waited 14 to 28 days to the stakers' stream. | `FeedOverdrawn`, only if more IMD left than was approved. A failure inside `Questions` does not revert it. |

Views: `ledger`, `owed`, `unbooked`, `stream`, `feedBudget`, `feedShortfalls`, `seatClaimable`,
`tipOwed`, `tipOf`, `clock`, `dripCap`, `streamUnvested`, `seatAccrued`, `seatCarry`, `seatPaid`,
`feedBudgetOld`, and the constants and constructor arguments by name.

## What was measured

Callback gas, through the stand-in Intake's call, from cold storage, with a keeper tip to credit
(`test/questions/QuestionsCallbackGas.t.sol`; the test fails above 140,000, and the Intake gives
200,000):

| Answer | Gas |
|---|---|
| `uint256` | 115,764 |
| `uint256`, zero | 95,864 |
| `bool`, no | 95,890 |
| `address` | 115,801 |
| `address[]` of three | 115,904 |
| `bytes32[]` of thirty-two | 116,622 |

Launch gas and sizes are in `docs/LAUNCH.md`, section 3: about 11.06 million gas for the whole
launch in the fork rehearsal, against our gate of 12,000,000 and the protocol's ceiling of 16.7
million.

Other calls, each printed by the named test with `-vv`:

| Call | Gas | Test |
|---|---|---|
| `Payroll.pay` | 103,446 (the first ever: 259,128) | `test_gas_pay`, `test_gas_theFirstPayEver` |
| `Payroll.pay` that also ages and releases feed budget | 132,759 | `test_gas_payThatAlsoReleasesTheWaitingFeedBudget` |
| `Payroll.book` | 98,277 (the first ever: 232,882) | `test_gas_book`, `test_gas_theFirstBookEver` |
| `Payroll.tip`, 4 agents already owed | 77,609 | `test_gas_tipToFourKnownAgents` |
| `Payroll.tip`, 16 agents never seen | 427,143 (as the first tip ever: 506,036) | `test_gas_tipToSixteenNewAgents`, `test_gas_theFirstTipEverToSixteenAgents` |
| `Payroll.tip`, 16 agents whose earlier tips must be aged | 553,961 | `test_gas_tipToSixteenAgentsWhoseEarlierTipsMustBeAged` |
| `Payroll.drip` | 68,791 | `test_gas_drip` |
| `Payroll.claimSeat` | 103,182 | `test_gas_claimSeat` |
| `Payroll.claimSeats`, 20 seats of 20 owners | 1,173,780 | `test_gas_claimTwentySeats` |
| `Payroll.claimSeats`, 200 seats of 200 owners | 11,289,941 | `test_gas_claimAFullListOfSeats` |
| `Payroll.claimTip` | 116,621 | `test_gas_claimTip` |
| `Payroll.fundFeeds`, one meter topped up | 173,427 | `test_gas_fundFeeds` |
| `JobsReport.print`, one period with its count | 232,314 | `test_gas_print` |
| `JobsReport.crown`, a list of ten | 177,671 | `test_gas_crown` |
| `Questions.createFeed`, the three house feeds, mainnet fork | about 820,000 to 1,044,000 | `test_fork_rehearsal_firstRequest_payrolls` |
| `Questions.request`, live Intake, mainnet fork | about 418,000 to 440,000 | `test_fork_rehearsal_firstRequest_payrolls`, `…_hires`, `…_employers` |
| `Payroll.claimSeats`, 20 real seats, mainnet fork | 47,631 a seat | `test_fork_gasOfSeatClaimsAgainstTheRealContracts` |
| The live Adapter's `bindingOf`, mainnet fork | 13,200 | `test_fork_tipFollowsTheRealAdapterBinding` |

The figures are as Foundry 1.8.3 prints them with its default settings on the day of the run (12
October 2026); the Payroll and JobsReport rows use stand-ins for IMD, sIMD, the seat token and the
Adapter, and the fork rows use the real contracts.

## Documents

- `docs/LAUNCH.md`: the launch request, the manifest with the source of every constructor argument,
  every value fixed at launch, the proof to buy before launching, the first-day runbook with the
  exact calldata of the three `createFeed` calls, and what a keeper does each day.
- `docs/THREATS.md`: trust roots, every known limit, the static-analysis results, what is not
  verified.
- `docs/DEVIATIONS.md`: where we depart from IdentityMD's guidance, and why.

## Layout

```
src/questions/        Questions, QuestionBody, OracleAttestation (IdentityMD's, unchanged)
src/payroll/          Payroll, JobsReport
src/interfaces/       IQuestions, IPayroll, and the outside contracts as seen from here
test/questions/       unit, fuzz, invariant and fork tests of Questions
test/payroll/         unit, fuzz, invariant, integration and fork tests of Payroll and JobsReport
test/launch/          the manifest, the empty-chain launch, the runbook, the fork rehearsal
test/fixtures/        real attestations, real seat bindings, the three house feeds, and the
                      scripts that wrote them
docs/                 LAUNCH.md, THREATS.md, DEVIATIONS.md
```

## Licence

MIT, as the licence line at the top of every source file says.
