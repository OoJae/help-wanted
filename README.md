# HELP WANTED, launch B: WorkProof, the hire desk, crowd pots and the Doorbell

Four contracts for Ethereum mainnet with no owner and no token. `WorkOrders` is a job board on
which the employer can be a contract: an employer escrows IMD against a pinned job text, a bonded
runner opens the job with IdentityMD's swarm, and the escrow pays when the job's work record is
proven on chain against IdentityMD's WorkRegistry. `WorkProof` is that proof, `CrowdPots` lets many
wallets commission one job together, and the `Doorbell` is a contract anyone can ring until it
hires.

**Status, read this first.**

- **Live on Ethereum mainnet since 13 October 2026.** IdentityMD launch 1573 created the four
  contracts in one transaction, `0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c`
  (block 26184581): `WorkProof` at `0xB268297dB06985ba0b806Ba97BcB90364b137469`, `WorkOrders` at
  `0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2`, `CrowdPots` at
  `0x8C2FfCdcb103659aa05c772b8F2059868B496EB5` and the `Doorbell` at
  `0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb`. `src/` is the source that was deployed: built here
  with the manifest's arguments, each contract has the runtime code that is at its address.
  IdentityMD's pipeline changed no compiled code before deploying; `ADAPTATION.md` says what it
  checked and which comments and documents it corrected. `docs/LAUNCH.md` is the launch request
  and the runbook, kept as written before the launch, apart from its status paragraph.
- **The central claim holds through the launched `WorkProof`.** Called on mainnet with the served
  record of the real job `e9efec16-56f3-40d3-9243-52c453effc7d`, `prove` answers with the record's
  hash and the agent the record names (`docs/LAUNCH.md`, section 7, step 0, has the command).
- **`Payroll`, the one contract this launch pays and does not create, is live.** HELP WANTED's
  first launch put it on Ethereum mainnet on 13 October 2026, at
  `0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F`. That address is the desk's third constructor
  argument, and the fork tests run the desk against the contract that lives there, with real IMD.
  The tests that need no network use a stand-in for it.
- **The desk's first order was settled by a real job, on proof.** On 13 October 2026 the
  Doorbell opened order 1 (one picture, 1 IMD) on its 25th ring, and a runner bought the picture
  job from the swarm with the order's header at the start of its objective. A runner must put 85
  bytes at the start of the job's objective, and the swarm kept them. On 14 October, a
  minute after IdentityMD wrote the job's receipt, the runner settled the order with the job's
  work record (transaction
  `0xa3f5b783fe194c35f348e411a10f0a199589ea89b668a16d1597794931217628`, block 26190223): the desk
  had `WorkProof` check the record against the live WorkRegistry, then paid the runner 0.9 IMD and
  its bond, `Payroll` its 0.05 IMD fee and a 0.05 IMD tip, which `Payroll` credited to agent 51519,
  the agent the record names, and called the Doorbell back. On 15 October `Payroll` paid that tip
  to the owner of seat 1049, the seat the agent is bound to (`claimTip`, called by the team's
  wallet W1). The order is `Delivered` and marked proven. The ringer, the runner and the
  Doorbell's IMD were all the team's own.
- **The desk's second order was opened by a contract of launch C and settled on proof.** On 16
  October 2026 rule 1 of launch C's `Rules` (`0xcbF0dddF07C00a78E2E7561a6F47C275B8c05D7E`), which
  the team's wallet H1 created and fired, opened order 2. It was a research report that only a
  receipt can pay, at 0.56 rising to 0.60 IMD, with `Rules` as its employer and the delivery
  callback on. The team's runner took it at 0.56005 IMD and bought the job from the swarm with the
  order's header at the start of its objective. IdentityMD's writer wrote the job's receipt two
  blocks before the runner registered the job. The runner then settled the order (transaction
  `0x35bb49cc9576a425b94a94137e8fe24e496017cc154456eeee255d22fc020516`, block 26204543). The desk
  had `WorkProof` check the 3,801-byte record against the live WorkRegistry. It paid the runner
  0.504045 IMD and its bond, and paid `Payroll` a 0.0280025 IMD fee and a 0.0280025 IMD tip, which
  `Payroll` credited to agent 52142. It returned the 0.03995 IMD the order did not spend to `Rules`
  and called `Rules` back. H1 then called `claimTip`, and `Payroll` paid that tip to the owner of
  seat 1978. The order is `Delivered` and marked proven. The rule's creator, the wallet that fired
  it and the runner were all the team's own.
- **The earlier header job is proven too.** The research-report job bought with a header on 13
  October has its receipt since 14 October, and
  `FOUNDRY_PROFILE=fork forge test --match-test test_fork_headerJob -vv` proves it against the
  real registry.
- **IdentityMD's receipts stalled from about 8 to 14 October 2026.** The registry wrote no
  `WorkRecorded` event from about 8 October until 13 October, 17:26 UTC (block 26,185,055). It then
  worked through its backlog, and the receipts of jobs bought on 13 October, order 1's among them,
  landed on 14 October. While receipts are late, only orders that allow the bonded-claim path can
  be paid, which is why the Doorbell was launched with that path on (`docs/LAUNCH.md`, section 5;
  `docs/THREATS.md`, D2). The registry has kept writing since: on 16 October the receipt of order
  2's job landed two blocks before its runner registered the job.
- **Audited by IdentityMD's launch pipeline, and by nobody outside IdentityMD's network.** Before
  deploying, its audit agents and an independent reviewer read this code and reported one medium
  and several info findings. None changed the compiled code; each is answered in `ADAPTATION.md`,
  and the medium one (a receipt-only pot can be ended in a refund with no bond forfeited) is now
  stated as a limit in `docs/THREATS.md`, C2. Of the eleven findings on IdentityMD's record of the pipeline job,
  `ADAPTATION.md` answers seven by name, and the other four through the judge's findings they were
  merged into. `docs/AUDITS.md` lists all eleven, the answer that covers each, and the one file the
  answers cite that the team never received. `docs/THREATS.md` lists every trust root and every
  known limit, and, in its section 11, what was checked here after the pipeline changed our first
  launch. `docs/DEVIATIONS.md` lists where we depart from IdentityMD's guidance.

This is the second of three launches of HELP WANTED. It pays its fees into `Payroll` (the first
launch) and needs nothing else from the other two.

## Check the central claim yourself

The whole design rests on one fact about IdentityMD's protocol: **keccak256 of a job's work
record, as served, equals `WorkRegistry.latest(jobId)` on Ethereum mainnet.** For the real job
`e9efec16-56f3-40d3-9243-52c453effc7d`, with `curl`, `xxd` and Foundry's `cast`:

```sh
REGISTRY=0xb6d0a187b050fa5bb0b87033a203f37becf4a775
curl -s https://api.imd.fun/work-records/3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5.json -o record.json
cast keccak "0x$(xxd -p record.json | tr -d '\n')"
cast call $REGISTRY "latest(bytes16)(bytes32)" 0xe9efec1656f340d3924352c453effc7d \
  --rpc-url https://ethereum-rpc.publicnode.com
```

Both print `0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5` (run again on 13
October 2026 at 11:29 UTC). The job id is the UUID without its dashes. The same record is stored in
this repository, so the first half needs no network:

```sh
cast keccak "$(cat test/fixtures/proof/records/e9efec16-skill-research-report-3db99325.hex)"
```

And through this launch's own `WorkProof`, against the live registry on a fork of mainnet:

```sh
FOUNDRY_PROFILE=fork forge test --match-test test_fork_centralClaim -vv
```

## Build and test

Foundry is the only requirement. Dependencies (forge-std, OpenZeppelin Contracts 5.5.0) are
vendored in `lib/`, so no network is needed for the first three commands.

```sh
forge fmt --check
forge build --sizes
forge test
```

`forge test` runs 673 tests in 32 suites and needs no network. It skips the fork tests.

```sh
FOUNDRY_PROFILE=fork forge test
```

runs the 38 fork tests against Ethereum mainnet at the latest block, through the RPC named in
`foundry.toml`. Each fork test skips itself when the RPC cannot be reached. They include the whole
loop against the real WorkRegistry with the fee and the tip paid into the live `Payroll`, and a
rehearsal of this launch through IdentityMD's real ProjectFactory, called as the launch deployer.

```sh
slither . --filter-paths "lib|test"
```

reports no finding of high or medium impact (Slither 0.11.4). Its 23 low findings and the five
places where the source silences a detector (six findings of medium impact without them) are
explained one by one in `docs/THREATS.md`, section 9.

The compiler settings are the ones a launch requires and are in `foundry.toml`: solc 0.8.26, EVM
version cancun, optimizer at 200 runs, `via_ir`, `bytecode_hash = "none"`, `cbor_metadata = false`.
A full build takes a few minutes because of `via_ir`.

## The contracts

| Contract     | File                      | Runtime bytes | Initcode bytes | Holds money                                                    |
| ------------ | ------------------------- | ------------- | -------------- | -------------------------------------------------------------- |
| `WorkProof`  | `src/proof/WorkProof.sol` | 4,579         | 4,712          | No                                                             |
| `WorkOrders` | `src/desk/WorkOrders.sol` | 19,289        | 19,630         | Escrows and bonds of live orders                               |
| `CrowdPots`  | `src/pots/CrowdPots.sol`  | 14,177        | 14,582         | Chips of pots that have not hired, and refunds not yet claimed |
| `Doorbell`   | `src/pots/Doorbell.sol`   | 5,972         | 6,776          | What it was sent, until it hires                               |

The limits are 24,576 bytes of runtime code and 49,152 of initcode; our own gates are 23,000 and
46,000, and a test fails above them.

Supporting code: `src/proof/JsonScan.sol` reads the top level of a work record without parsing the
rest. `src/desk/OrderHeader.sol` builds the 85 header bytes and `src/desk/SpecText.sol` holds the
character rules of a job text. `src/interfaces/` holds what other contracts and outside tools
compile against: `IWorkOrders` (an employer's view of the desk), `IWorkOrdersRunner` (a runner's
and a keeper's, with notes written for somebody who wants to run one), `IWorkProof`, `ICrowdPots`,
and `IPayroll`, which is the first launch's, copied unchanged. `src/interfaces/external/Mainnet.sol`
lists mainnet addresses for tests and documents; no deployed contract imports it.

### How they fit together

1. An **employer** calls `createOrder` with a job text (the spec), the `kind` of work record that
   must come back, a price range, a bond and a delivery time. The desk pulls the top of the price
   range as escrow. The price rises from the bottom of the range while the order waits.
2. A **runner** calls `claim`: it posts the bond and the price is fixed. The desk gives it a
   header, 85 bytes that name this chain, this desk, this order, this claim and this runner.
3. The runner buys the job from IdentityMD's swarm with its own wallet (0.5 IMD, outside these
   contracts), with an objective that is the header followed by the spec, and calls `register`
   with the job's id.
4. When the swarm has finished, IdentityMD writes keccak256 of the job's work record to its
   WorkRegistry. Anyone calls `settle` with the record. `WorkProof` checks that the bytes are the
   registry's receipt for that job and reads what they say; the desk checks that the job ended
   `completed`, under the order's kind, with exactly this claim's header and the order's spec.
5. The desk pays: 5% of the price to `Payroll` as a fee, 5% as a tip for the agents the record
   names, the rest and the bond to the runner, and what the price left of the escrow back to the
   employer. An employer contract that asked for it is told last.
6. If no receipt comes, the order ends by `timeout` and the bond goes to the employer; an order
   nobody takes is refunded at its expiry. An employer that set the claimed-path flag also accepts
   a runner's bonded statement that the job was delivered, payable after 24 hours without a
   challenge. Anyone may challenge by posting an equal bond, which is then held until a receipt,
   the order's arbiter or the delivery deadline ends the dispute.

`CrowdPots` and the `Doorbell` are employers. A pot collects chips up to a target, becomes the
employer of one order for the whole amount, and shares back whatever the desk returns. The Doorbell
opens an order for a picture on every 25th ring, as long as it holds the escrow.

## Every entry point

No function in any of the four contracts is restricted to an owner or an admin: there is none.
"Anyone" below means any account or contract. Every function of `WorkOrders`, `CrowdPots` and the
`Doorbell` that moves IMD holds one transient-storage lock per contract, so a nested call into the
same contract reverts `ReentrancyGuardReentrantCall`.

The tables are complete. `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes` reads each
contract's ABI as the compiler wrote it and fails if a contract has a state-changing function that
is not in its table, a payable function, a `receive` or a fallback.
`test_runnerInterface_theDeskHasNothingPublicBeyondIt` does the same for the desk against
`IWorkOrdersRunner`.

### WorkProof

It has no function that changes state. All three are open to anyone.

| Function                                     | What it does                                                                                                                                                                                        | Reverts when                                                                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prove(jobId, record, headLen)` (view)       | Returns the record's hash, the hashes of its `kind`, `state` and `objective` (the objective split at `headLen`) and the agents it names, if `record` is the receipt the registry holds for `jobId`. | `InsufficientGas`; `NoReceipt(jobId)`: the registry holds nothing usable; `HashMismatch(expected, got)`; `Malformed(pos)`, `MissingKey`, `WrongSchema`: not a canonical v1 work record; `JobIdMismatch`; `HeadTooLong`. |
| `proveChunks(jobId, chunks, headLen)` (view) | The same for a record stored across data contracts, each holding `0x00` and a slice.                                                                                                                | As `prove`; `BadChunk(index)`.                                                                                                                                                                                          |
| `scan(record, headLen)` (pure)               | Parses a record without asking the registry. Proves nothing.                                                                                                                                        | `Malformed`, `MissingKey`, `WrongSchema`, `HeadTooLong`.                                                                                                                                                                |

Views: `WORK_REGISTRY`, `REGISTRY_GAS`.

### WorkOrders

| Function                           | Who may call                                                                        | What it does                                                                                                             | Reverts when                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createOrder(params, spec)`        | Anyone, having approved `maxPay`                                                    | Opens an order and pulls `maxPay` as escrow. The caller is the employer.                                                 | `SpecInvalid(at)`; `PayRange`; `DeliveryTooShort`, `DeliveryTooLong`; `BondTooLow`; `Expired`; `BadFlags`; `BadCondition`; the token transfer fails. |
| `cancel(id)`                       | **The order's employer**                                                            | Withdraws an order nobody holds.                                                                                         | `BadState`; `NotEmployer`.                                                                                                                           |
| `refund(id)`                       | Anyone                                                                              | Returns the escrow of an order that expired with nobody holding it.                                                      | `BadState`; `TooEarly`.                                                                                                                              |
| `trigger(id)`                      | Anyone                                                                              | Records that a conditional order's condition holds now, which opens it for good.                                         | `BadState`; `ConditionNotMet`; `GasShort`.                                                                                                           |
| `claim(id)`                        | Anyone, having approved the bond (the one named runner, if the order names one)     | Takes an open order: posts the bond, fixes the price, returns the ticket.                                                | `BadState`; `Expired`; `NotRunner`; `Barred`; `ConditionNotMet`; `GasShort`; `BooksFull`.                                                            |
| `release(id)`                      | **The runner that holds the order**                                                 | Gives the order back inside the first hour: 90% of the bond back, 10% to the employer.                                   | `BadState`; `NotRunner`; `TooLate`.                                                                                                                  |
| `evict(id)`                        | Anyone                                                                              | Removes a runner that registered no job within the hour. The bond goes to the employer.                                  | `BadState`; `TooEarly`.                                                                                                                              |
| `register(id, jobId)`              | **The runner that holds the order**                                                 | Records the swarm job, or replaces it with a retry.                                                                      | `BadState`; `NotRunner`; `ZeroJob`; `JobUsed`.                                                                                                       |
| `settle(id, record, chunks)`       | Anyone                                                                              | Pays the order out against the registered job's work record.                                                             | WorkProof's errors, passed on; `JobUsed`; `NotCompleted`; `WrongKind`; `WrongHeader`; `WrongSpec`; `BadState`; `GasShort`.                           |
| `reportFailed(id, record, chunks)` | Anyone, except that a failed job with the right objective is its runner's to report | Ends a claim with a receipt that does not settle the order.                                                              | WorkProof's errors; `NotFailed`; `NotRunner`; `BadState`.                                                                                            |
| `timeout(id)`                      | Anyone                                                                              | Ends a claim whose delivery time has passed: a registered job forfeits the bond; an undecided dispute refunds the order. | `BadState`; `TooEarly`.                                                                                                                              |
| `claimDelivered(id, recordHash)`   | **The runner that holds the order**, on an order that allows it                     | States that the job was delivered and opens the 24-hour challenge window.                                                | `BadState`; `NotRunner`; `ClaimedPathOff`; `ZeroHash`; `TooLate`.                                                                                    |
| `challenge(id)`                    | Anyone, having approved an amount equal to the bond                                 | Disputes a delivery claim. The bond is held until the dispute ends, at the longest until the delivery deadline.          | `BadState`; `TooLate`; the token transfer fails.                                                                                                     |
| `finalize(id)`                     | Anyone                                                                              | Pays out a delivery claim nobody challenged in time, marked unproven, the tip with no agents named.                      | `BadState`; `TooEarly`; `GasShort`.                                                                                                                  |
| `resolve(id, delivered)`           | **The order's arbiter**                                                             | Decides a disputed claim.                                                                                                | `BadState`; `NotArbiter`; `GasShort`.                                                                                                                |
| `redeliver(id)`                    | Anyone                                                                              | Tries a failed employer callback again. Moves no money.                                                                  | `BadState`; `GasShort`; `ReentrancyGuardReentrantCall`.                                                                                              |
| `stamp(id, record, chunks)`        | Anyone                                                                              | Marks an order paid on a claim as proven, once its receipt exists. Moves no money.                                       | `BadState`; WorkProof's errors; the checks of `settle`.                                                                                              |

Views: `stateOf`, `accountOf`, `orderOf`, `claimOf`, `priceNow`, `ticketOf`, `headerOf`,
`conditionOf`, `orderOfJob`, `barred`, `orderCount`, and the constants and constructor arguments
by name. `headerOf` reverts `BadState` unless a runner holds the order or it was delivered; the
others answer with zeros for an order that does not exist.

### CrowdPots

| Function                                      | Who may call            | What it does                                                                                                                      | Reverts when                                                                                                                                                                                                                |
| --------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openPot(terms, spec, firstChip)`             | Anyone                  | Opens a pot, with its job kind in text, and optionally chips in. The opener gets no rights.                                       | `KindMissing`, `KindTooLong`; `SpecInvalid(at)` for the kind or the spec; `TargetTooSmall`; `HireWindowOutOfRange`; `FundingWindowOutOfRange`; `BadPriceRamp`; `DeskTokenMismatch`; `BondOutOfRange`; `DeliveryOutOfRange`. |
| `openSeries(terms, spec)`                     | Anyone                  | Opens a recurring pot: a chip sent to its id lands in its current round.                                                          | As `openPot`.                                                                                                                                                                                                               |
| `chipIn(potId, amount)`                       | Anyone, having approved | Adds IMD to a pot that is collecting. Takes nothing, and does not revert, when the pot is full, launched, out of time or unknown. | The token transfer fails.                                                                                                                                                                                                   |
| `chipInFor(potId, amount, beneficiary)`       | Anyone, having approved | The same; the chip and any refund belong to `beneficiary`.                                                                        | `BadBeneficiary`; the token transfer fails.                                                                                                                                                                                 |
| `launch(potId, spec)`                         | Anyone                  | Turns a full pot into one order on the desk for the whole amount.                                                                 | `WrongStage`; `NotFull`; `PastDeadline`; `WrongSpec`; the desk refuses the order; `DeskPulledWrongAmount`, `OrderIdReused`, `NotOurOrder` if the desk misbehaves.                                                           |
| `onWorkDelivered(orderId, jobId, recordHash)` | **The desk only**       | Records the delivery. Moves no money.                                                                                             | `NotDesk`; `UnknownOrder`.                                                                                                                                                                                                  |
| `reconcile(potId)`                            | Anyone                  | Brings a pot's books up to date, after making the desk call its order is waiting for.                                             | `NotOurOrder`; `DeskShortfall`.                                                                                                                                                                                             |
| `claimRefund(potId, contributor)`             | Anyone, for anyone      | Pays a contributor their share of what a settled pot has to give back.                                                            | `WrongStage`; `NotOurOrder`; `DeskShortfall`.                                                                                                                                                                               |
| `claimRefunds(potId, contributors)`           | Anyone                  | The same for a list.                                                                                                              | As `claimRefund`.                                                                                                                                                                                                           |

Views: `potOf`, `stageOf`, `chipOf`, `refundOf`, `remaining`, `kindOf`, `potCount`, `owed`,
`potOfOrder`, `currentRound`, and the constants and constructor arguments by name.

### Doorbell

| Function                                      | Who may call      | What it does                                                                    | Reverts when                                                                                                |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ring()`                                      | Anyone            | Counts a ring. Every 25th ring opens an order if the Doorbell holds the escrow. | The desk refuses the order; `DeskPulledWrongAmount`, `OrderIdReused`, `NotOurOrder` if the desk misbehaves. |
| `onWorkDelivered(orderId, jobId, recordHash)` | **The desk only** | Records the delivery. Moves no money.                                           | `NotDesk`; `UnknownOrder`; `AlreadyDelivered`.                                                              |

Views: `hireOf`, `ringsUntilHire`, `funded`, `rings`, `hires`, `receipts`, `lastOrderId`,
`lastDeliveredOrderId`, `SPEC`, `SPEC_HASH`, and the constants and constructor arguments by name.

## What was measured

Sizes and launch gas are in `docs/LAUNCH.md`, section 3: 11,040,950 gas for the whole launch in
the fork rehearsal, against our gate of 12,000,000 and the protocol's ceiling of 16.7 million.

A settlement, on real work records with an order's objective swapped in, through the real
`WorkProof`, with the Payroll stand-in (`test/desk/WorkOrders.gas.t.sol`; `execution` is the desk
call alone, `transaction` adds the base cost and the calldata, computed):

| Record                                                       | Bytes   | `settle`, execution | `settle`, transaction | Least gas to offer |
| ------------------------------------------------------------ | ------- | ------------------- | --------------------- | ------------------ |
| Small: a research report                                     | 3,549   | 480,904             | 559,476               | 1,384,398          |
| Large: a contract project, sent as calldata                  | 102,034 | 589,718             | 4,104,500             |                    |
| The same through five data contracts                         | 102,034 | 565,724             | 588,416               |                    |
| The costliest real shape: research, walked nearly to its end | 86,837  | 1,060,279           | 3,496,590             | 2,008,178          |

The gas to offer is more than the gas used because the desk refuses to start a Payroll call it
cannot hand 1,000,000 gas to.

The same with the live `Payroll` and real IMD, on a mainnet fork
(`test_fork_payroll_gasOfASettlementWithTheLiveContract`, 13 October 2026, records of 3,576 and
7,680 bytes):

| Settlement                                                    | `settle`, execution | Least gas to offer |
| ------------------------------------------------------------- | ------------------- | ------------------ |
| The first the live Payroll ever sees, one agent               | 551,689             | 1,515,990          |
| The same first settlement, sixteen agents never tipped before | 1,128,435           | 1,750,121          |
| A later one, sixteen more agents never tipped before          | 950,872             | 1,589,477          |
| A later one, one agent                                        | 374,057             | 1,355,346          |

Those figures were taken while nothing had yet been paid into Payroll on mainnet; they move with
its state on the day of the run. The test asserts only what does not: each case is inside the
3,000,000 gas `docs/LAUNCH.md` tells a sender to offer for a small record. A large record sent as
calldata needs more, as the first table shows: its own bytes are most of what it costs.

Other figures, each printed by the named test with `-vv`:

| What                                                                                            | Gas                      | Test                                                                                 |
| ----------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `WorkProof.prove`, the 7,339-byte reference record, registry cold                               | under 140,000 (asserted) | `test_gas_referenceJob`                                                              |
| `WorkProof.prove`, each stored record                                                           | printed as a table       | `test_gas_everyFixture`                                                              |
| The live `WorkRegistry.latest`, cold, mainnet fork                                              | 5,468                    | `test_fork_registryAnswersFarInsideItsGasAllowance`                                  |
| Long text inside a record                                                                       | 3.95 a byte              | `test_gas_longStringsCostUnderFiveGasPerByte`                                        |
| The costliest text found                                                                        | 18.81 a byte             | `test_gas_noTextCostsTwentyGasPerByte`                                               |
| Bare structure between strings                                                                  | up to 195.26 a byte      | `test_gas_bareStructureCeiling`                                                      |
| `Doorbell.ring` that hires, mainnet fork                                                        | 354,333                  | `test_fork_rehearsal_firstDay_theDoorbellHiresAndItsPictureJobIsProven`              |
| `settle` of the Doorbell's order, real IMD, the live Payroll, a 5,072-byte record, mainnet fork | 719,399                  | the same test                                                                        |
| `finalize` of the first pot's order, the live Payroll, mainnet fork                             | 495,295                  | `test_fork_rehearsal_firstDay_theDocumentedPotIsPaidOnAClaimWhileReceiptsAreStalled` |
| `settle` with both Payroll calls using all the gas they are handed, mainnet fork                | 2,379,082                | `test_fork_payroll_burningAllItsGasCannotBlockASettlementOnTheDocumentedLimit`       |

The figures are as Foundry 1.8.3 prints them with its default settings on the day of the run (13
October 2026).

## Documents

- `docs/LAUNCH.md`: the launch request, the manifest with the source of every constructor argument,
  every value fixed at launch, the Doorbell's proposed values, what to check before launching, the
  first-day runbook and what a keeper does each day.
- `docs/THREATS.md`: trust roots, every known limit, the static-analysis results, what is not
  verified, and what was checked after IdentityMD's pipeline changed our first launch.
- `docs/DEVIATIONS.md`: where we depart from IdentityMD's guidance, and why.
- `docs/AUDITS.md`: every finding IdentityMD's launch pipeline reported for this launch, and what
  was done about each.

## Layout

```
src/proof/            WorkProof, JsonScan
src/desk/             WorkOrders, OrderHeader, SpecText
src/pots/             CrowdPots, Doorbell
src/interfaces/       IWorkOrders, IWorkOrdersRunner, IWorkProof, ICrowdPots, IPayroll, and the
                      registry and mainnet addresses as seen from here
test/proof/           unit, fuzz and gas tests of WorkProof and the scanner
test/desk/            unit, fuzz, invariant and gas tests of the desk; the runner interface
test/pots/            unit, fuzz and invariant tests of CrowdPots and the Doorbell
test/launch/          the manifest, the empty-chain launch, the runbook
test/fork/            the whole loop against the real WorkRegistry and the live Payroll; the
                      launch rehearsal; the job that carried a header
test/kit/             what the tests share: real records with an order's objective, stand-ins for
                      the registry and Payroll
test/fixtures/        21 real work records with their on-chain hashes, the record of the job that
                      carried a header, header vectors, spec vectors
docs/                 LAUNCH.md, THREATS.md, DEVIATIONS.md, AUDITS.md
```

## Licence

MIT. See `LICENSE`.
