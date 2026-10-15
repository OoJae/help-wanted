# @help-wanted/shared

The one place the bots, the indexer and the web app get protocol facts from: addresses, ABIs, the
three house feeds, the question hash, the order header, work records, and a typed client for
IdentityMD's public API. Nothing in this package signs, sends a transaction or holds a key.

It exports its TypeScript sources as they are. Import it from a bundler, vitest or tsx; plain
`node` cannot resolve them (`pnpm --filter @help-wanted/shared build` emits JavaScript to `dist/`
for anything that needs it).

```ts
import { MAINNET, HOUSE_FEEDS, questionsAbi, ImdClient } from "@help-wanted/shared";
import { payrollAbi } from "@help-wanted/shared/abi"; // ABIs alone
import { IntakeRead } from "@help-wanted/shared/api"; // the API client and its schemas alone
```

## What to import for what

### Addresses and constants

| You need                                                                                                                                          | Import                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A mainnet address: IMD, sIMD, the seats, the Adapter, the Intake, the oracle signer, the fee payee, the WorkRegistry, Permit2, the v4 contracts   | `MAINNET.IMD`, `MAINNET.INTAKE`, …                                                                    |
| The Intake. `MAINNET.INTAKE` is **version 2** (`0xa43e…de82`), the one launch A is built on. Version 1 (`0x1397…ea56`) is legacy and still served | `MAINNET.INTAKE`, `MAINNET.INTAKE_V1`, `INTAKES`, `isIntake(address)`                                 |
| The oracle action id (`bytes32("oracle.request@oracle-1")`)                                                                                       | `MAINNET.ORACLE_ACTION`                                                                               |
| To compare two addresses (the API writes them lowercase)                                                                                          | `sameAddress(a, b)`, `lowerAddress(a)`                                                                |
| Chain id, decimals, the price of a paid action today, API and explorer base URLs                                                                  | `CHAIN_ID`, `IMD_DECIMALS`, `SIMD_DECIMALS`, `PAID_ACTION_PRICE`, `IMD_API_BASE`, `IMD_EXPLORER_BASE` |
| Addresses no contract of ours touches (the x402 proxy, the quote signer)                                                                          | `OFFCHAIN`                                                                                            |

`MAINNET` mirrors `src/interfaces/external/Mainnet.sol` of the launch projects. Each project keeps
only the constants it uses, so a test reads all three copies.

### Our own contracts: where they are

| You need                                                      | Import                                                                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The address of one of our contracts                           | `DEPLOYMENTS.questions`, … (null until its launch), or `deployed("questions")`, which throws a sentence saying what is missing                             |
| Whether a launch is on chain, and the block to read logs from | `isLaunched("a")`, `launchBlock("a")`                                                                                                                      |
| **To record a launch**                                        | fill in `DEPLOYMENT_BOOK` in `src/deployments.ts`. It is the one place: transaction, block and addresses per launch. A test fails on a half-filled launch. |

### ABIs

One `as const` ABI per contract, for viem.

| Contract                                                                   | Import                                                                                  | Where it comes from                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| Questions, JobsReport, Payroll (launch A)                                  | `questionsAbi`, `jobsReportAbi`, `payrollAbi`                                           | the compiler's output                  |
| WorkProof, WorkOrders, CrowdPots, Doorbell (launch B), and `IWorkEmployer` | `workProofAbi`, `workOrdersAbi`, `crowdPotsAbi`, `doorbellAbi`, `workEmployerAbi`       | the compiler's output                  |
| Rules, Endowments, Zap (launch C)                                          | `rulesAbi`, `endowmentsAbi`, `zapAbi`                                                   | the compiler's output                  |
| IMD, sIMD, the seats, the Intake, the WorkRegistry, the Adapter            | `erc20Abi`, `erc4626Abi`, `erc721Abi`, `intakeAbi`, `workRegistryAbi`, `seatAdapterAbi` | signatures in `scripts/abi-sources.ts` |

**The ABIs of our own contracts are generated, never written by hand.** After a contract changes:

```sh
cd launches/<project> && forge build          # never forge clean
pnpm --filter @help-wanted/shared abi:gen     # rewrites src/abi/generated/*.ts
```

The generator reads `launches/<project>/out/<File>.sol/<Contract>.json` and nothing else (the
`out-<area>` folders beside `out/` are stale). It refuses to write from an artifact that is missing
or older than its sources. A test fails when a generated file differs from what the generator
would write now, or when an artifact was built from other sources than those on disk; it is
skipped, with a message naming the project to build, when the build output is absent.

The protocol's ABIs are regenerated with `pnpm --filter @help-wanted/shared abis`.

### The hire desk: deadlines, gas and what a record means

| You need                                                                                                                                                                        | Import                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| What a work record means for one claim of an order, by the desk's own tests: it settles, the job did not complete, another kind, another objective, or it cannot be read        | `judgeRecord(claim, bytes)`, `refutes(verdict)`, types `ClaimTerms`, `RecordVerdict`                 |
| The times that bound a claim: the end of the claim window, the delivery deadline, the last moment for `claimDelivered` (48 hours before it), the end of the challenge window    | `claimWindowEndsAt`, `deliveryDeadline`, `lastDeliveryClaimAt`, `challengeEndsAt`                    |
| The gas a `settle` must be sent with for a record of a given size, by the desk's own measurements (never set a low limit by hand: the desk reverts `GasShort`), and for `stamp` | `settleGasNeeded(bytes)`, `proofGasNeeded(bytes)`, `largestSettleableRecord(gasLimit)`, `SETTLE_GAS` |
| The largest real record seen of a kind a runner opens                                                                                                                           | `JOB_TEMPLATES[kind].largestRecordSeen`                                                              |
| When a silent Standing Questions round can be closed (since launch A was adapted: twelve hours, the answer's validity, the tolerance and a second)                              | `silenceSeconds(validFor)`; `Questions.canAbandon` reports the moment itself                         |

### Reading a contract from a node

Small pure functions that say what a node's answer means. The indexer and the evidence builder at
the repository root (`scripts/evidence`) both name logs and sort refused log queries with them, so
there is one decoder and not two.

| You need                                                                                                    | Import                                                     |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| To name a log under an ABI, strictly (null for a log the ABI does not know)                                 | `decodeLogUnder(abi, topics, data)`, `eventNamesOf(abi)`   |
| The calldata of a view call, and its answer read back by name                                               | `viewCallData(abi, fn, args)`, `viewResult(abi, fn, data)` |
| Why a node refused an `eth_getLogs`: history it does not keep, a range it finds too large, or anything else | `classifyLogsError(error)`, `errorText(error)`             |
| An address with its checksum; keccak256 of bytes given as hex (of a contract's code, its code hash)         | `checksumAddress(address)`, `keccakOfHex(hex)`             |

### Standing Questions and the house feeds

| You need                                                                                                                                                                                 | Import                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| The three house feeds: id, parameters, question prefix and body tail (bytes and text), answer type, whether a panel judges it, whether `submit` is open to it, Payroll's slot and runway | `HOUSE_FEEDS.payrolls`, `.hires`, `.employers`; `HOUSE_FEED_NAMES`; `houseFeedById(id)`                                         |
| The id of a feed from its parts (what `Questions.feedIdOf` returns)                                                                                                                      | `feedIdOf(params, qPrefix, tail)`                                                                                               |
| The exact body `Questions` sends for a block window, and the question hash an answer must carry                                                                                          | `feedBody(feed, window)`, `feedBodyHex(feed, window)`, `feedQuestionHash(feed, window)`                                         |
| The contract's enums by name                                                                                                                                                             | `ROUND_STATUS`, `REQUEST_BLOCKER`, `ABANDON_STEP`, `roundStatusName(code)`, `requestBlockerName(code)`, `abandonStepName(code)` |
| The waits fixed at launch (thirty minutes, thirty minutes, twelve hours to sign: the silence deadline itself is `silenceSeconds`)                                                        | `QUESTIONS_WAITS` (to display; read them from the contract to act on them)                                                      |
| Whether a question prefix is judged by a panel, as the contract tests it                                                                                                                 | `holdsPanelEvidence(qPrefix)`                                                                                                   |
| How an answered round got its answer, from `RoundAnswered.deliveredBy`: the Intake's callback, or somebody's `submit`                                                                    | `answerDelivery(deliveredBy, intake)`                                                                                           |

The feeds are generated from launch A's own fixture files
(`launches/a-payroll/test/fixtures/questions/feeds/*.json`) by
`pnpm --filter @help-wanted/shared feeds:gen`, and a test fails when the generated file and the
fixtures differ. The tests also replay the three proof records of launch A: the body that was
bought, the hash that was signed and the real signatures.

### The oracle: questions, bodies, attestations

| You need                                                                                                                          | Import                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| The question hash of a request (`definitions` when there are any, `evidence` only when it is `"panel"`, `head` when there is one) | `questionHash(question, window)`, `questionHashOfRequest(apiRecord)`, `questionHashOfBody(body)`                                                  |
| To build a request body the way the contract assembles it, split into prefix and tail                                             | `oracleBodyParts(question, terms)`, `assembleOracleBody(parts, window)`, `buildOracleBody(…)`, `questionHashFromPrefix(prefix, window)`           |
| To check a body before paying for it                                                                                              | `checkOracleBody(body)`                                                                                                                           |
| To turn the API's attestation into the struct a contract takes                                                                    | `attestationMessage(apiAttestation)`, or `signedAttestation(document)` for the whole `/attestation` document                                      |
| To check who an answer was signed for, and by whom                                                                                | `isSignedFor(signed, consumer)`, `verifyAttestation(consumer, message, signature, signer)`, `recoverAttestationSigner(…)`, `attestationDigest(…)` |
| The EIP-712 types and domain                                                                                                      | `ORACLE_ATTESTATION_TYPES`, `oracleDomain(chainId, contract)`                                                                                     |
| Answer types and their codes                                                                                                      | `ANSWER_TYPES`, `ANSWER_TYPE_CODE`                                                                                                                |

An answer is signed for the contract the request names: the body's `consumer` when it has one,
otherwise the callback target. `isSignedFor` reads the document's domain; `verifyAttestation`
proves it.

### IdentityMD's API

`ImdClient` is a typed client for the public routes. It is deliberately slow: every request goes
through one queue with a gap of 2.1 seconds (under thirty a minute; the whole product shares 120),
honours `Retry-After`, and backs off on errors. Every answer is checked with zod; a shape the
product depends on that has changed throws `ImdSchemaError`.

| You need                                                                                                       | Call                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| What the plane made of an Intake request: its state, the oracle request behind it, what the writer has written | `client.intakeRead(chainId, transactionHash)` → `IntakeRead`; `isUnknownTransaction(error)`                        |
| An oracle request, and its signed answer                                                                       | `client.oracleRequest(id)`, `client.oracleAttestation(id)`; `isNotAttested(error)`                                 |
| Jobs, their results and records; a work record's bytes checked against its hash                                | `client.jobs()`, `client.job(id)`, `client.jobResult(id)`, `client.jobRecords(id)`, `client.workRecord(hash)`      |
| Launches, health, capabilities, what a wallet paid for                                                         | `client.launches()`, `client.health()`, `client.capabilities()`, `client.paidBy(address)`                          |
| The free preflight (the one POST; it costs nothing and creates nothing)                                        | `client.check(action, input)`                                                                                      |
| The schemas alone, to validate a saved response                                                                | `IntakeRead`, `IntakeEntry`, `OracleRequest`, `OracleAttestationDocument`, `Job`, … from `@help-wanted/shared/api` |
| The states an Intake entry goes through                                                                        | `INTAKE_STATE`, `INTAKE_COMPLETION_STATUS`                                                                         |

An Intake entry in state `completing` has been decided (an answer is signed, or a refusal is
recorded) and has not yet been written on chain by the plane's writer. On 13 October 2026 entries
stayed in that state for more than seven hours; `fixtures/api/intake` holds real ones.

### The hire desk and work records

| You need                                                                | Import                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The order ticket and the 85-byte header, and the spec's character rules | `orderTicket(…)`, `orderHeader(…)`, `buildObjective(…)`, `parseObjective(…)`, `checkSpec(…)` (`src/order.ts`) |
| The desk's states, flags, constants and price arithmetic                | `ORDER_STATE`, `ORDER_FLAG`, `CLAIM_END`, `DESK`, `priceAt(…)` (`src/desk.ts`)                                |
| The job kinds and the body of the swarm job for a spec                  | `JOB_TEMPLATES`, `kindHash(kind)`, `buildJobInput(…)`, `parseSpecInputs(…)` (`src/jobInput.ts`)               |
| To fetch, hash and scan a work record as `WorkProof` does               | `workRecordUrl(hash)`, `checkRecordBytes(…)`, `fetchWorkRecord(…)`, `scanWorkRecord(…)` (`src/workRecord.ts`) |
| Canonical JSON exactly as IdentityMD writes it                          | `canonicalize(value)`                                                                                         |
| UUIDs to and from their on-chain forms                                  | `uuidToBytes16`, `uuidToBytes32`, `bytes16ToUuid`                                                             |

## Scripts

| Command                                          | What it does                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `pnpm --filter @help-wanted/shared typecheck`    | `tsc --noEmit`                                                           |
| `pnpm --filter @help-wanted/shared test`         | vitest; no test reaches the network                                      |
| `pnpm --filter @help-wanted/shared abi:gen`      | our contracts' ABIs from the launch projects' build output               |
| `pnpm --filter @help-wanted/shared feeds:gen`    | the house feeds from launch A's fixtures                                 |
| `pnpm --filter @help-wanted/shared gen`          | both of the above                                                        |
| `pnpm --filter @help-wanted/shared abis`         | the protocol's ABIs from `scripts/abi-sources.ts`                        |
| `pnpm --filter @help-wanted/shared vectors`      | the golden vectors (Python)                                              |
| `pnpm --filter @help-wanted/shared vectors:scan` | the record scanner compared with the real `WorkProof.scan` (needs forge) |
| `pnpm --filter @help-wanted/shared build`        | JavaScript to `dist/`                                                    |

## Tests that read other folders

Some tests compare this package with files the launch projects own: `Mainnet.sol`, the interface
files, the feed fixtures, the proof records, `LAUNCH.md`, and the build output. Each skips itself
with a message when its file is not there, and fails when the two sides differ. A failure of that
kind names the command that puts it right.

`fixtures/` holds real responses of public IdentityMD routes, byte for byte; `fixtures/PROVENANCE.json`
says where each came from and when.
