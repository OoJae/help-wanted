# Launch B: WorkProof, WorkOrders, CrowdPots, Doorbell

This document is what the launch needs and nothing else: the launch request, the manifest we expect,
where every constructor argument comes from, every value that can never be changed afterwards, what
to check before launching, and what to do on the first day and every day after.

**Status: launched.** IdentityMD launch 1573 created the four contracts on Ethereum mainnet on 13
October 2026, in transaction `0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c`
(block 26184581): `WorkProof` at `0xB268297dB06985ba0b806Ba97BcB90364b137469`, `WorkOrders` at
`0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2`, `CrowdPots` at
`0x8C2FfCdcb103659aa05c772b8F2059868B496EB5` and the `Doorbell` at
`0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb`. The rest of this document is kept as it was written
before the launch. One correction: IdentityMD's receipt writer, stalled when this was written
(sections 5 and 7), wrote again from 13 October 2026, 17:26 UTC (block 26,185,055). The desk's first
order, the Doorbell's, was paid on its job's receipt on 14 October. Its second, a receipt-only
research report that a rule of HELP WANTED's third launch opened, was paid on its job's receipt on
16 October (`README.md` has the transactions). Every number below was produced by a test or a command that is named beside it,
and where a command needs a contract's address it reads it from a shell variable: set `PROOF`,
`DESK`, `POTS` and `BELL` to the four addresses above.

**Every constructor argument is known.** The last one was the address of `Payroll`, which
`WorkOrders` pays its fee and its tip to. HELP WANTED's first launch created it on Ethereum mainnet
on 13 October 2026 (IdentityMD launch 1531, transaction
`0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58`, block 26182869):
`0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F`. Section 6 says how that address was checked and how
to check it again.

**One argument is a decision for launch day.** The Doorbell's last argument, `allowClaimed`, says
whether its orders can be paid on a bonded claim when there is no receipt. The manifest below
carries `1` (yes), which is what we recommend while IdentityMD's receipt writer is stalled, as it
has been since about 8 October 2026. Section 5 gives the rule and the command to apply it.

The tests in `test/launch/` read this file. The blocks that follow a marker comment
(`<!-- manifest -->`, `<!-- doorbell:… -->`, `<!-- firstPot:… -->`) are parsed and compared with the
code, and every `cast call` and `cast send` line is checked to name a function the contract it is
sent to really has. A block edited by hand without the matching change in the code fails
`forge test`.

## 1. The launch request

To send to IdentityMD with the repository's URL:

> Please deploy this repository as it is: contracts only, on Ethereum mainnet. There is no token
> and no owner.
>
> It holds four contracts, to be created in this order: `WorkProof`, `WorkOrders`, `CrowdPots`,
> `Doorbell`. Their constructor arguments are in `docs/LAUNCH.md`: three existing mainnet addresses
> (IMD, IdentityMD's WorkRegistry, and the Payroll contract of our earlier launch, number 1531),
> three references to contracts of this same launch, and six fixed values for the Doorbell (one
> `bytes32`, four amounts and times, one bool written 0 or 1). No argument is `$owner`: no contract
> has an owner, an admin or a setter.
>
> Nothing has to be called after deployment. The constructors make no external call and check no
> code size, so they run on an empty chain. There is no proxy, no initializer, no pausing and no
> minting; the runtime bytecode holds no DELEGATECALL, CALLCODE or SELFDESTRUCT. `forge test`
> checks each of these statements (`test/launch/LaunchManifest.t.sol`).
>
> The project builds with solc 0.8.26, EVM version cancun, optimizer 200 runs, `via_ir`,
> `bytecode_hash = "none"` and `cbor_metadata = false`, as `foundry.toml` already says. We believe
> no source file needs to change for the launch. `docs/THREATS.md`, section 11, says what we
> checked in this code after the changes your pipeline made to our first launch, and why each rule
> here is as it is.
>
> One rule we ask you to leave as it is: `CrowdPots.claimRefund` and `claimRefunds` can be called
> by anyone for any contributor, a contract included. A chip can be made in another address's name
> (`chipInFor`), so a contributor may be a contract with no way to make the call itself.
> `docs/DEVIATIONS.md`, D7, gives the reasoning.

The repository carries no `launch.json`: the pipeline's manifest step writes it.

## 2. The manifest we expect

Contracts in order, with their constructor arguments in order:

<!-- manifest -->
```json
{
  "kind": "evm_contracts",
  "contracts": [
    {
      "contract": "WorkProof",
      "constructorArgs": [
        "0xb6d0a187b050fa5bb0b87033a203f37becf4a775"
      ]
    },
    {
      "contract": "WorkOrders",
      "constructorArgs": [
        "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
        "$contract:WorkProof",
        "0x6e4362a5cec59eb3f611af6b2d81915cf5b45f1f"
      ]
    },
    {
      "contract": "CrowdPots",
      "constructorArgs": [
        "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
        "$contract:WorkOrders"
      ]
    },
    {
      "contract": "Doorbell",
      "constructorArgs": [
        "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
        "$contract:WorkOrders",
        "0x7679ff00d2b015b122f4c00147c1004ea6657aada5fff65e72986b90c6869185",
        "1000000000000000000",
        "1000000000000000000",
        "250000000000000000",
        "604800",
        "1"
      ]
    }
  ],
  "notes": "Contracts only. No token, no owner, nothing to call after deployment. WorkOrders' third argument is the address of Payroll from our earlier launch, number 1531."
}
```

### Every argument and where its value comes from

All addresses are Ethereum mainnet. The constant names are those of
`src/interfaces/external/Mainnet.sol`, which the tests import; the deployed contracts do not import
it, they receive every address as an argument.

**`WorkProof(address workRegistry)`**

| # | Argument | Value | Source |
|---|---|---|---|
| 0 | `workRegistry` | `0xb6d0a187b050fa5bb0b87033a203f37becf4a775` | `Mainnet.WORK_REGISTRY`. IdentityMD's WorkRegistry, as named in its documentation. `latest(bytes16 jobId)` returns keccak256 of the job's work record. The fork suite reads it for 21 stored records (`test_fork_everyFixtureProvesExactlyWhenItIsTheLatestReceipt`). |

**`WorkOrders(address imd, address workProof, address payroll)`**

| # | Argument | Value | Source |
|---|---|---|---|
| 0 | `imd` | `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` | `Mainnet.IMD`. The token every escrow, bond, fee and tip is paid in. |
| 1 | `workProof` | `$contract:WorkProof` | The first contract of this launch. |
| 2 | `payroll` | `0x6e4362a5cec59eb3f611af6b2d81915cf5b45f1f` | `Mainnet.PAYROLL`. The `Payroll` contract of HELP WANTED's first launch: the third of the three contracts IdentityMD launch 1531 created in block 26182869. Section 6 says how it was checked. On a fork, the address holds that launch's code and the desk pays it (`test_fork_payroll_isTheContractTheFirstLaunchCreated`, `test_fork_rehearsal_factoryCreatesTheFourContracts`). |

**`CrowdPots(address imd, address workOrders)`**

| # | Argument | Value | Source |
|---|---|---|---|
| 0 | `imd` | `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` | `Mainnet.IMD`. |
| 1 | `workOrders` | `$contract:WorkOrders` | The second contract of this launch. |

**`Doorbell(address imd, address workOrders, bytes32 kindHash, uint96 minPay, uint96 maxPay, uint96 bond, uint32 deliverySecs, bool allowClaimed)`**

| # | Argument | Value | Source |
|---|---|---|---|
| 0 | `imd` | `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` | `Mainnet.IMD`. |
| 1 | `workOrders` | `$contract:WorkOrders` | The second contract of this launch. |
| 2 | `kindHash` | `0x7679ff00…6869185` | keccak256 of the text `skill:create-image`. Section 5. |
| 3 | `minPay` | `1000000000000000000` (1 IMD) | Our choice. Section 5. |
| 4 | `maxPay` | `1000000000000000000` (1 IMD) | Our choice: the same as `minPay`, so the Doorbell has one price. Section 5. |
| 5 | `bond` | `250000000000000000` (0.25 IMD) | The desk's minimum. Section 5. |
| 6 | `deliverySecs` | `604800` (7 days) | Our choice. Section 5. |
| 7 | `allowClaimed` | `1` (true) | **A launch-day decision.** `1` while IdentityMD's receipts are stalled, `0` when they are arriving. Section 5 gives the command that decides. |

## 3. What the tests show about the launch

| Statement | Test |
|---|---|
| The manifest above names `WorkProof`, `WorkOrders`, `CrowdPots`, `Doorbell` in that order, with 1, 3, 2 and 8 arguments, three backward references, no `$owner` and no `$token` | `test_manifest_namesTheFourContractsInOrder` |
| The desk's third argument is the address `Mainnet.sol` records for the first launch's Payroll; this document names that address wherever it tells a reader to check it, and carries no marker for a value still to come | `test_manifest_payrollIsTheFirstLaunchsLiveAddress` |
| Every argument is the `Mainnet.sol` address, the reference, or the Doorbell value in `test/kit/LaunchValues.sol` | `test_manifest_everyArgumentIsWhatTheCodeExpects`, `test_manifest_theDoorbellsValuesAreTheOnesTheDocumentExplains` |
| The Doorbell's kind hash is the hash of the text written in section 5, and that text is the kind of a real picture job's stored work record | `test_manifest_theDoorbellsKindIsTheTextTheDocumentNames` |
| Created in manifest order from those arguments, on a chain where no dependency has code, the four contracts deploy and report the configuration written here | `test_launch_deploysInManifestOrderOnAnEmptyChain` |
| Each contract is inside our gates of 23,000 bytes of runtime code and 46,000 bytes of initcode; the launch is inside our gate of 12,000,000 gas | `test_launch_fitsOurSizeAndGasGates` |
| No runtime bytecode holds DELEGATECALL, CALLCODE or SELFDESTRUCT (walked instruction by instruction, PUSH data skipped) | `test_launch_runtimeBytecodeHasNoForbiddenOpcode`, `test_bytecodeWalk_findsWhatItLooksForAndSkipsPushData` |
| No constructor holds CALL, STATICCALL, an EXTCODE instruction, BALANCE, CREATE or CREATE2; every constructor is nonpayable and takes only static words | `test_launch_constructorsMakeNoCallAndNoCodeCheck`, `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes` |
| The functions that can change state are the 28 listed in `README.md` and no others; no contract can receive ETH | `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes` |
| On a mainnet fork, the launch deployer's `launchContracts` call to the real ProjectFactory creates the four contracts at the predicted addresses, and the desk it creates names the live Payroll, whose code is the first launch's | `test_fork_rehearsal_factoryCreatesTheFourContracts` (fork suite) |
| On the contracts the factory created, with nothing called after deployment: the Doorbell is funded, rung 25 times and hires; its picture job is recorded in the real WorkRegistry by the registry's writer and the order settles, the fee and the tip pulled by the live Payroll | `test_fork_rehearsal_firstDay_theDoorbellHiresAndItsPictureJobIsProven` (fork suite) |
| The same hire while receipts are late: paid on an unchallenged claim after 24 hours, stamped when the receipt lands | `test_fork_rehearsal_firstDay_theDoorbellsOrderWhileReceiptsAreLate` (fork suite) |
| The first crowd pot of section 7, read from this document, fills, hires and is paid on a claim while receipts are stalled, and on a receipt when one exists | `test_fork_rehearsal_firstDay_theDocumentedPotIsPaidOnAClaimWhileReceiptsAreStalled`, `test_fork_rehearsal_firstDay_theDocumentedPotSettlesOnAReceipt` (fork suite) |

Measured sizes (`forge build --sizes`; the protocol's limits are 24,576 and 49,152 bytes):

| Contract | Runtime bytes | Initcode bytes | Initcode with arguments |
|---|---|---|---|
| WorkProof | 4,579 | 4,712 | 4,744 |
| WorkOrders | 19,289 | 19,630 | 19,726 |
| CrowdPots | 14,177 | 14,582 | 14,646 |
| Doorbell | 5,972 | 6,776 | 7,032 |

`WorkOrders` is 3,711 bytes under our own 23,000-byte gate.

Launch gas:

| Measure | Gas | Where it comes from |
|---|---|---|
| Creating the four contracts one after another on an empty chain | 9,863,916 (WorkProof 1,076,578, WorkOrders 4,260,050, CrowdPots 3,149,320, Doorbell 1,377,968) | `test_launch_fitsOurSizeAndGasGates`, with Foundry's default setting, which runs each creation as a transaction of its own. |
| An estimate of 240 gas for each of the 46,148 bytes of initcode, the rate of a real contracts-only launch | 11,075,520 | The same test. |
| The real ProjectFactory's `launchContracts`, called by the launch deployer on a mainnet fork | 10,309,522 for the call, and 731,428 more for the transaction's base cost and calldata: 11,040,950 | `test_fork_rehearsal_launchFitsOurGasAndSizeGates`, 13 October 2026. The fork is taken at the newest block, and the first figure moved by a few gas between runs made that day. |

Our gate is 12,000,000 gas and the protocol's ceiling is 16.7 million. The rehearsed launch is
about 0.96 million gas under our gate. The second part of the rehearsal figure is added by hand
from the calldata's bytes, which may count some of it twice; the figure errs high. As a check on
the measurement itself, the same test compares the rehearsal's cost for each byte of initcode with
what a real contracts-only launch used (launch 1240: 9,596,612 gas for 39,910 bytes) and requires
the two to agree within two percent.

## 4. What is fixed at launch

Nothing below can be changed by anyone once the launch transaction is mined. There is no owner, no
setter and no upgrade path. Each value is listed with the reason it has the value it has.

### WorkProof

| Value | Setting | Reason |
|---|---|---|
| WorkRegistry | constructor argument | The one outside contract a proof rests on. No key can point proofs at another registry. |
| Record schema | the text `identitymd-work-v1`, and the canonical form of October 2026 (`src/proof/JsonScan.sol`, rules 1 to 6) | One text per record and one order per set of keys. The cost is stated in `docs/THREATS.md`: a change of form by IdentityMD ends proofs for new records. |
| `REGISTRY_GAS` | 50,000 | The live `latest(bytes16)` answers in about 5,500 gas from cold. The allowance bounds what an unexpected registry can burn. |
| Agents named by a proof | at most 16, each once, rejected submissions left out | A bounded list; Payroll credits at most 16 agents per tip. |
| Chunk marker | a data contract's code starts with one `0x00` byte | So that a contract holding a record can never be run. |

### WorkOrders

| Value | Setting | Reason |
|---|---|---|
| IMD, WorkProof, Payroll | constructor arguments | Written in the manifest, readable by anyone. |
| `FEE_BPS`, `TIP_BPS` | 500 and 500: 5% and 5% of the fixed price, each rounded up to the next wei | The product's fee, and the tip for the agents that worked. Rounding favours the fee side; the three parts always sum to the price. |
| `RELEASE_BPS` | 1000: a tenth of the bond | What giving an order back costs, and the least a runner loses when a challenged claim is not upheld. |
| `MIN_BOND` | 0.25 IMD | Small enough that any runner can post it; a runner that goes silent still loses it. |
| `MIN_DELIVERY`, `MAX_DELIVERY` | 3 days, 90 days | A delivery claim needs 48 hours of delivery time left, so three days leave a runner one day to make it. Ninety days bounds how long one bond can keep an escrow out of reach, and how long a challenger's bond can be held (`docs/THREATS.md`, L6). |
| `CLAIM_WINDOW` | 1 hour | Time to open the swarm job and register it. Past it, anyone may remove the runner. |
| `CHALLENGE_WINDOW`, `DISPUTE_WINDOW` | 24 hours, 24 hours | A day to challenge a delivery claim, and at least a day after the last possible challenge for a receipt or the arbiter to decide. |
| `CALLBACK_GAS` | 150,000 | Enough for an employer contract to record a delivery, not to open a new order (about 260,000). An employer contract that hires again does so in a call of its own, never inside the callback. |
| `CONDITION_GAS` | 100,000 | One bounded static call per reading of a condition. |
| `PAYROLL_GAS` | 1,000,000 for each of the two Payroll calls | The first launch measured its `pay` at about 103,000 gas and its `tip` at up to about 554,000. The desk requires the allowance up front, so a caller cannot force the plain-transfer path by sending too little gas. Against the live Payroll on a fork, the settlement that costs Payroll's two calls the most (the first Payroll ever saw, with a record naming sixteen agents never tipped before) used 1,128,435 gas in all, proof and transfers included (`test_fork_payroll_gasOfASettlementWithTheLiveContract`). |
| Order header | `[help-wanted order ` + 64 lowercase hex of the ticket + `] `, 85 bytes; ticket = keccak256(abi.encode(chain id, desk, order id, claim number, runner)) | Ties a swarm job to one claim of one order on one chain. Outside tools build the same bytes from the vectors in `test/fixtures/desk/header-vectors.json`. |
| Spec rules | 1 to 7,900 bytes of printable ASCII, no `"`, no `\`, no space at either end | Text whose JSON form is itself, so a hash of the spec can be compared with a hash over the record's bytes. |
| Flags | 1 allow the claimed path, 2 call the employer back, 4 the condition takes an argument | |
| Dispute split | a refuted claim: a tenth of the runner's bond to the employer, the rest to the challenger; an undecided one: a tenth to the employer, the rest back to the runner, the challenger made whole, the employer refunded | So that claiming and then challenging oneself from a second address is never cheaper than releasing the order. |

### CrowdPots

| Value | Setting | Reason |
|---|---|---|
| IMD, WorkOrders | constructor arguments | Written in the manifest. |
| `MIN_TARGET` | 1 IMD | Below it a pot could not pay for a swarm job at all. |
| `MIN_FUND_SECS`, `MAX_FUND_SECS` | 1 hour, 30 days | How long a pot may collect. |
| `LAUNCH_GRACE` | 1 day | A pot that filled in its last second can still hire. |
| `MIN_HIRE_SECS`, `MAX_HIRE_SECS` | 1 day, 30 days | How long a pot's order waits for a runner. |
| `MAX_DELIVERY_SECS` | 30 days | The longest delivery time a pot may give. The shortest is the desk's. |
| `MAX_KIND_LENGTH` | 64 bytes | The longest kind text a pot may name. The longest kind seen in a work record is 28 bytes. |
| What a pot's order never has | a reserved runner, an arbiter, a condition | Things a contributor could not judge. A pot may allow the claimed path; that is pinned and published in its terms before anyone chips in. |

### Doorbell

| Value | Setting | Reason |
|---|---|---|
| IMD, WorkOrders, kind hash, price range, bond, delivery time, claimed path | constructor arguments | Section 5. |
| `SPEC` | the job text in `src/pots/Doorbell.sol`, 424 bytes | The picture of the day. It is in the code so that nobody can change what the Doorbell orders. |
| `RINGS_PER_HIRE` | 25 | The design's value. A hire takes 25 separate calls, so it can be watched coming. |
| `HIRE_SECS` | 2 days | How long an order waits for a runner before its escrow can be refunded to the Doorbell. |
| `RAMP_SECS` | 1 hour | How long the price takes to rise from `minPay` to `maxPay` when they differ. This launch gives the Doorbell one price, so its orders have no ramp. |
| `MAX_DELIVERY_SECS` | 30 days | The longest delivery time the constructor accepts. |
| No way out | IMD leaves only as the escrow of the Doorbell's own orders | It is a demonstration. Fund it with small amounts. |

## 5. The Doorbell's values

These are proposals. They become permanent with the launch, so each is given with its reason and
with what is and is not known.

### The kind

<!-- doorbell:kind -->
```text
skill:create-image
```

The manifest's `kindHash` is keccak256 of that text
(`cast keccak "skill:create-image"` prints `0x7679ff00d2b015b122f4c00147c1004ea6657aada5fff65e72986b90c6869185`).

What is known:

- A work record's `kind` equals the job's template string. That held for all 41 records we fetched
  (`test/fixtures/proof/index.json`, under `observed`, lists each with its hash, kind and state),
  and for the record of the one job we bought with an order header (below).
- Twenty kinds were seen: `audit`, `impl_tests`, `impl_tests_review`, `multi_contract`, `research`,
  `single`, `shape:chain`, `shape:dag`, `shape:fan_out_join`, `skill:adversarial-review`,
  `skill:build-contract-project`, `skill:build-ponder-indexer`, `skill:build-website`,
  `skill:create-audio`, `skill:create-image`, `skill:create-video`, `skill:research-report`,
  `skill:scaffold-project`, `skill:site-content-check`, `skill:write-readme-and-docs`
  (`test_fixtures_theIndexListsEveryKindObserved`).
- One real picture job, `df6805ee-e8e4-4177-aec0-ec9e5ae43937`, opened with the create-image skill,
  has a work record whose `kind` is `skill:create-image` and whose state is `completed`. Its record
  is stored (`test/fixtures/pots/picture-job.json` names it) and its hash is the job's receipt in
  the live registry (`test_fork_everyFixtureProvesExactlyWhenItIsTheLatestReceipt`).
- **A real job has carried an order header, and the swarm kept it.** On 13 October 2026 we bought
  one job from IdentityMD, `e70c56ce-60f0-4c2c-b413-67e5ae37ddce`, with the research-report skill
  and an objective made of 85 bytes shaped like an order header followed by a plain question.
  IdentityMD's API reports it `completed` under the template `skill:research-report`, and its work
  record (hash `0x990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d`, 3,552 bytes,
  stored unchanged in `test/fixtures/proof/header-job/record.json`) shows three things: the stored
  `objective` begins with the 85 header bytes exactly as sent and continues with the text exactly as
  sent; the record's `kind` is the template, `skill:research-report`; and this launch's `WorkProof`
  reads the record and splits the header from the rest
  (`test_headerJob_scanFindsTheHeaderTheSpecTheKindAndTheAgent`,
  `test_headerJob_theServedBytesHashToTheRecordHash`). To see the job yourself:

  ```sh
  curl -s https://api.imd.fun/jobs/e70c56ce-60f0-4c2c-b413-67e5ae37ddce | jq '{state, template, objective}'
  curl -s https://api.imd.fun/jobs/e70c56ce-60f0-4c2c-b413-67e5ae37ddce/records | jq '.records[] | {hash, status}'
  ```

What is not known:

- **Whether `prove` passes on chain for a job that carried a header.** The header job's receipt was
  still queued at IdentityMD when this was written (13 October 2026, 11:30 UTC: the API lists the
  record with status `queued`, and `WorkRegistry.latest` of the job is zero). Until the writer
  records it, the proof of that record has been shown only against a registry stand-in that holds
  its hash (`test_headerJob_provesOnceTheRegistryHoldsItsHash`).
  `FOUNDRY_PROFILE=fork forge test --match-test test_fork_headerJob -vv` asks the real registry and
  says which case it found.
- **Whether a picture job keeps a header the way the research job did.** The job we bought used the
  research-report skill. The Doorbell's orders are opened with the create-image skill. Nothing we
  have seen makes the stored objective or the kind depend on the skill, but no create-image job
  with a header has been bought.
- The header in that job was not the header of an order on a deployed desk (there is no desk yet),
  so no order has been settled by a real job.
- What kind the swarm writes for skills that have no receipt yet.
- Whether IdentityMD will rename a kind. A renamed kind ends proven settlement for the Doorbell.

What follows from a wrong kind, or a header the swarm does not keep for picture jobs: with the
claimed path off, no Doorbell order is ever paid, each ends in a refund, and the IMD stays in the
Doorbell for good (it has no way out). With the claimed path on, orders can still be paid on an
unchallenged claim and are never stamped as proven. Section 6 offers one more picture job with a
header as an optional check. It costs 0.5 IMD and settles the second unknown.

### The price

<!-- doorbell:minPay -->
```text
1000000000000000000
```

<!-- doorbell:maxPay -->
```text
1000000000000000000
```

One price: every order pays 1 IMD. The bottom and the top of the range are the same amount, so the
price does not move while an order waits. A runner pays the swarm 0.5 IMD for the job, which is
never refunded, and gas for three transactions; of the price it receives 90%. At 1 IMD that leaves
0.4 IMD and the gas to be covered. We do not know whether a runner outside the team will accept
that; HELP WANTED's own runner does.

Why no range. The desk takes the top of an order's range as escrow, and what the fixed price leaves
of it comes back to the employer at settlement. The Doorbell has no way out, so on a range of 1 to
3 IMD each hire at the bottom would leave 2 IMD in it that only a later hire could use. With one
price the escrow is the price: the Doorbell needs 1 IMD on a 25th ring and holds nothing of that
order after it is paid. The cost is that the Doorbell cannot find out whether somebody would work
for less, or raise its offer when nobody takes 1 IMD: an order nobody takes ends in a refund to
the Doorbell after two days. Any other employer can still give the desk a range; pots do
(section 7).

### The bond

<!-- doorbell:bond -->
```text
250000000000000000
```

0.25 IMD, the desk's minimum. A larger bond would make holding an order dearer, and it would also
make the order harder to take and, with the claimed path on, a delivery claim harder to challenge,
since a challenger posts the same amount. For a demonstration that anyone should be able to take
part in, the minimum.

### The delivery time

<!-- doorbell:deliverySecs -->
```text
604800
```

Seven days. A picture takes minutes. The time is long for another reason: a delivery claim must be
made at least 48 hours before the delivery deadline, so three days (the desk's minimum) would leave
a runner one day to claim; seven leave five. And when receipts start arriving again, a backlog has
time to clear. The cost: a runner that registers a job and goes silent keeps one order's escrow out
of reach for seven days, for its bond, and whoever challenges a delivery claim on a Doorbell order
has its 0.25 IMD held for up to those seven days. Neither stops the Doorbell: the next 25th ring
opens another order if it holds another 1 IMD.

### The claimed path

<!-- doorbell:allowClaimed -->
```text
1
```

**This value is decided on launch day, and our recommendation is `1` for as long as receipts are
stalled.** They were when this was written. On 13 October 2026 at 11:29 UTC the registry had
emitted no `WorkRecorded` event in the last 9,000 blocks (about 30 hours), IdentityMD's `/health`
answer gave `pendingFeedback` as 2288 (it was 2186 a day earlier), and the writer's account held
0.000068 ETH. The last receipt we know of was written on about 8 October. The rule we propose:

```sh
export RPC=...                                              # an Ethereum mainnet RPC URL
export REGISTRY=0xb6d0a187b050fa5bb0b87033a203f37becf4a775
HEAD=$(cast block-number --rpc-url "$RPC")
cast logs --rpc-url "$RPC" --address $REGISTRY --from-block $((HEAD - 1800)) \
  0xc3e4ffeab3a1fc840bb179d634166017188a59d5df2db3c5f563052a5f6f2f86 | grep -c transactionHash
```

1,800 blocks are six hours. If the count is zero, deploy with `1`. If receipts are arriving, deploy
with `0`: then only an on-chain receipt pays.

Why `1` while they are stalled: with `0`, a Doorbell order cannot be paid at all until the writer
writes again. A runner that took one would lose its bond and its 0.5 IMD at the delivery deadline,
so no careful runner takes one, and the demonstration shows a contract that orders and is never
served. The choice is permanent: a Doorbell deployed with `1` keeps accepting claims after
receipts return.

What each setting means for the IMD the Doorbell holds is written at the top of
`src/pots/Doorbell.sol` and in `docs/THREATS.md` (D2, D3). In short. With `1`, a runner can be paid
24 hours after stating that the job was delivered, unless somebody posts 0.25 IMD to challenge; an
untrue claim nobody challenges is paid, and a challenge nothing decides refunds the order even
when the claim was true. With `0`, nothing is paid while receipts are stalled, and nothing is ever
paid if the kind or the header is wrong.

## 6. Before launch

1. **The first launch, and the address of `Payroll`. Done on 13 October 2026.** IdentityMD launch
   1531 created `Questions`, `JobsReport` and `Payroll` in transaction
   `0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58`. `Payroll` is at
   `0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F`. What was checked, and how to check it again:

   ```sh
   export RPC=...                                              # an Ethereum mainnet RPC URL
   export PAYROLL=0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F
   cast code $PAYROLL --rpc-url "$RPC" | wc -c                 # 23695: 11,846 bytes of code as hex
   cast keccak "$(cast code $PAYROLL --rpc-url "$RPC")"         # 0xa962b063…99367236
   cast call $PAYROLL "IMD()(address)" --rpc-url "$RPC"         # the IMD token
   cast call $PAYROLL "QUESTIONS()(address)" --rpc-url "$RPC"   # Questions of the same launch
   cast call $PAYROLL "tipOwed(uint256)(uint256)" 52211 --rpc-url "$RPC"   # answers, with a number
   cast call $PAYROLL "unbooked()(uint256)" --rpc-url "$RPC"    # IMD waiting for book()
   ```

   The code at that address is 11,846 bytes and equals the build output of the first launch's
   source once the 36 places that hold constructor arguments are set aside (compared on 13 October
   2026). The fork suite pins the hash of that code and fails if the address ever holds anything
   else (`test_fork_payroll_isTheContractTheFirstLaunchCreated`); `Payroll` has no owner and no
   upgrade path, so it cannot. A wrong address could not be corrected after launch: the fee and
   the tip of every settlement would be sent to it by plain transfer
   (`test_fork_rehearsal_withNoCodeAtPayrollsAddress_theFeeIsSentThereByPlainTransfer`).

2. **Decide the Doorbell's claimed path** with the command in section 5, on the day, and write the
   result as the Doorbell's last argument. Recommendation: `1` while that command prints zero.

3. **One real job with a header. Done for a research report on 13 October 2026; optional for a
   picture.** Section 5 says what the job we bought showed. What it did not show can be closed in
   two ways, neither of which the launch has to wait for. When IdentityMD's writer records the
   job's receipt, the proof runs against the real registry:

   ```sh
   FOUNDRY_PROFILE=fork forge test --match-test test_fork_headerJob -vv
   ```

   And one picture job can be bought with the create-image skill and an objective that is 85 bytes
   shaped like a header followed by the Doorbell's spec (the text in `src/pots/Doorbell.sol`). It
   costs 0.5 IMD, which is never refunded, and needs an ordinary wallet and IdentityMD's paid API,
   which this repository does not call. Then read:

   ```sh
   JOB=...                                                     # the job's id
   curl -s https://api.imd.fun/jobs/$JOB | jq '{state, template, objective}'
   curl -s https://api.imd.fun/jobs/$JOB/records | jq '.records[] | {hash, status}'
   ```

   Go: `template` is `skill:create-image`, and `objective` begins with the 85 header bytes exactly
   as sent and continues with the spec exactly as sent. No-go for a Doorbell with the claimed path
   off: anything else.

4. **Have a watcher ready before the first order that allows claims exists.** Such an order pays
   an untrue delivery claim that nobody challenges within 24 hours. Whoever funds the Doorbell or
   fills the first pot should run a keeper that holds the orders' bonds in IMD (0.25 IMD for a
   Doorbell order, 0.5 IMD for the first pot's) and challenges untrue claims on those two
   employers' orders and on no others. Section 8 says why not on others.

5. **Run the suites** on the commit that will be imported:

   ```sh
   forge fmt --check && forge build --sizes && forge test
   FOUNDRY_PROFILE=fork forge test
   ```

## 7. The first day

Nothing is called by the launch pipeline after deployment. Every call below is open to anyone; none
needs a privilege, and the team's wallet is only the first to make them. `$WALLET` stands for the
operator's own signing option for `cast send`, for example `--account NAME` (an encrypted keystore)
or `--ledger`. No key is written in this file, and none should be typed on a command line.

```sh
export RPC=...            # an Ethereum mainnet RPC URL
export IMD=0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7
export REGISTRY=0xb6d0a187b050fa5bb0b87033a203f37becf4a775
export PAYROLL=0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F
export PROOF=...          # the four addresses the launch created, from its ContractsLaunched event
export DESK=...
export POTS=...
export BELL=...
```

**The first day is planned for stalled receipts.** While IdentityMD's writer is not writing, an
order can be paid only on the claimed path, so the Doorbell is deployed with it on (section 5) and
the first pot allows it (step 5). Two things follow for whoever runs the bots. A runner must be
willing to take such orders and to claim delivery; HELP WANTED's runner bot does, and leaves
receipt-only orders alone while receipts are stalled (its setting `RECEIPT_ONLY_ORDERS`, default
`when-receipts-flow`). And somebody must watch: HELP WANTED's keeper bot challenges untrue claims
only when it is given a float (`CHALLENGE_FLOAT_IMD` and `CHALLENGE_DAILY_CAP_IMD`), and should be
told which employers to defend (`CHALLENGE_EMPLOYERS`, set to `$POTS` and `$BELL`).

### Step 0. Read back what was deployed

Compare each answer with section 2.

```sh
cast call $PROOF "WORK_REGISTRY()(address)" --rpc-url "$RPC"
cast call $DESK "IMD()(address)" --rpc-url "$RPC"
cast call $DESK "WORK_PROOF()(address)" --rpc-url "$RPC"        # must be $PROOF
cast call $DESK "PAYROLL()(address)" --rpc-url "$RPC"           # must be $PAYROLL
cast call $POTS "WORK_ORDERS()(address)" --rpc-url "$RPC"       # must be $DESK
cast call $BELL "WORK_ORDERS()(address)" --rpc-url "$RPC"       # must be $DESK
cast call $BELL "KIND_HASH()(bytes32)" --rpc-url "$RPC"
cast call $BELL "MIN_PAY()(uint96)" --rpc-url "$RPC"
cast call $BELL "MAX_PAY()(uint96)" --rpc-url "$RPC"
cast call $BELL "BOND()(uint96)" --rpc-url "$RPC"
cast call $BELL "DELIVERY_SECS()(uint32)" --rpc-url "$RPC"
cast call $BELL "ALLOW_CLAIMED()(bool)" --rpc-url "$RPC"        # what was decided on the day
```

And the claim everything rests on, through the launched WorkProof, for a real job (the record is
7,339 bytes; the call sends nothing and costs nothing):

```sh
curl -s https://api.imd.fun/work-records/3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5.json -o record.json
cast call $PROOF "prove(bytes16,bytes,uint256)((bytes32,bytes32,bytes32,bytes32,bytes32,uint256[]))" \
  0xe9efec1656f340d3924352c453effc7d "0x$(xxd -p record.json | tr -d '\n')" 0 --rpc-url "$RPC"
```

It answers with the record hash `0x3db99325…b2c5` first, and reverts for any other bytes.

### Step 1. Fund the Doorbell

A plain transfer. One order needs 1 IMD; 3 IMD pays for three. There is no way to take it back.

```sh
cast send $IMD "transfer(address,uint256)" $BELL 3000000000000000000 --rpc-url "$RPC" $WALLET
cast call $BELL "funded()(bool)" --rpc-url "$RPC"
```

### Step 2. Ring

Anyone, as often as they like. Every 25th ring opens an order when the Doorbell holds 1 IMD.

```sh
cast send $BELL "ring()" --rpc-url "$RPC" $WALLET
cast call $BELL "ringsUntilHire()(uint256)" --rpc-url "$RPC"
cast call $BELL "hires()(uint64)" --rpc-url "$RPC"
cast call $BELL "lastOrderId()(uint256)" --rpc-url "$RPC"
```

On a mainnet fork a ring that hires used 354,333 gas; the 25th ring should be sent with a gas
limit of 600,000.

### Step 3. A runner takes the order

The runner is any wallet with 0.25 IMD for the bond, 0.5 IMD for the swarm's fee and ETH for gas.
`src/interfaces/IWorkOrdersRunner.sol` is the whole surface, with notes. HELP WANTED's runner bot
takes only the job templates it is told to (`TEMPLATES`, default `skill:research-report`): to serve
the Doorbell it must be started with `skill:create-image` in that list.

```sh
ID=$(cast call $BELL "lastOrderId()(uint256)" --rpc-url "$RPC")
cast call $DESK "priceNow(uint256)(uint96)" $ID --rpc-url "$RPC"
cast send $IMD "approve(address,uint256)" $DESK 250000000000000000 --rpc-url "$RPC" $WALLET
cast send $DESK "claim(uint256)" $ID --rpc-url "$RPC" $WALLET
cast call $DESK "headerOf(uint256)(bytes)" $ID --rpc-url "$RPC" | xargs cast to-utf8
```

Within one hour: open the job with IdentityMD, with the create-image skill, with an objective that
is exactly those 85 bytes followed by the Doorbell's spec, and register its id (the job's UUID
without the dashes):

```sh
cast send $DESK "register(uint256,bytes16)" $ID 0x<32 hex digits> --rpc-url "$RPC" $WALLET
```

### Step 4. Being paid

**While receipts are stalled**, which is the case this day is planned for, and only if the Doorbell
was deployed with the claimed path on: the runner states the hash IdentityMD's API lists for the
job's record, waits 24 hours, and anyone finalizes. The claim must be made at least 48 hours before
the delivery deadline.

```sh
cast send $DESK "claimDelivered(uint256,bytes32)" $ID 0x<record hash> --rpc-url "$RPC" $WALLET
# 24 hours later, if nobody challenged:
cast send $DESK "finalize(uint256)" $ID --gas-limit 2000000 --rpc-url "$RPC" $WALLET
# whenever the receipt lands, anyone:
cast send $DESK "stamp(uint256,bytes,address[])" $ID "0x$(xxd -p record.json | tr -d '\n')" "[]" --rpc-url "$RPC" $WALLET
```

**When the receipt exists** (`cast call $REGISTRY "latest(bytes16)(bytes32)" 0x<job id>` is not
zero): fetch the record whose hash that is and settle. Anyone may send this. If a delivery claim is
standing and the receipt has landed, settle rather than finalize: both pay the same, and only
`settle` hands the tip to the agents the record names.

```sh
HASH=$(cast call $REGISTRY "latest(bytes16)(bytes32)" 0x<job id> --rpc-url "$RPC")
curl -s https://api.imd.fun/work-records/${HASH#0x}.json -o record.json
cast send $DESK "settle(uint256,bytes,address[])" $ID "0x$(xxd -p record.json | tr -d '\n')" "[]" \
  --gas-limit 3000000 --rpc-url "$RPC" $WALLET
```

The gas limit matters: the desk refuses to start unless it can hand each of its two Payroll calls
1,000,000 gas, so a settlement must be offered far more than it uses. Against the live Payroll on a
fork (`test_fork_payroll_gasOfASettlementWithTheLiveContract`, 13 October 2026), the first
settlement Payroll ever sees used 551,689 gas and needed 1,515,990 on offer; the same first
settlement with a record naming sixteen agents never tipped before, which costs Payroll's two
calls the most, used 1,128,435 and needed 1,750,121; a later small one used 374,057 and needed
1,355,346. Those are the desk call alone, for records of 3.6 and 7.7 KB; the calldata of such a
record adds about 0.1 million. Three million covers a small record, such as the Doorbell's picture
record (5 KB) or a research report (3.5 KB), in every state of Payroll we measured, a Payroll that
burned all the gas it was handed included
(`test_fork_payroll_burningAllItsGasCannotBlockASettlementOnTheDocumentedLimit`, 2,379,082 gas);
what is not used is returned.

**Three million is not enough for a large record sent as calldata.** A record pays for its own
bytes: the 87 KB and 102 KB records among our fixtures cost 3.5 and 4.1 million gas as
transactions, most of it the charge for calldata (`README.md`, "What was measured"). For a record
above about 40 KB, take the limit from a gas estimate, not from this page; above about 128 KB the
record does not fit a transaction at all and goes through data contracts (section 9).

Then:

```sh
cast call $BELL "receipts()(uint64)" --rpc-url "$RPC"
cast call $DESK "accountOf(uint256)(uint8,address,uint96,uint96,uint96)" $ID --rpc-url "$RPC"
cast call $PAYROLL "tipOwed(uint256)(uint256)" 52211 --rpc-url "$RPC"   # an agent a settled record named
```

### Step 5. The first crowd pot

A pot names its job kind in text, pins the spec, and is open to any wallet. The first one we
propose:

<!-- firstPot:terms -->
```json
{
  "kind": "skill:research-report",
  "target": "2000000000000000000",
  "minPay": "1000000000000000000",
  "rampSecs": 86400,
  "bond": "500000000000000000",
  "deliverySecs": 604800,
  "hireSecs": 604800,
  "fundSecs": 259200,
  "allowClaimed": true
}
```

<!-- firstPot:spec -->
```text
Write a two-page plain-language report on who paid the IdentityMD swarm in the last seven days and for what, from on-chain IMD transfers to the fee payee only, with every figure sourced to a transaction.
```

**While receipts are stalled the first pot allows the claimed path.** A receipt-only pot opened
today could not complete: no receipt has been written since about 8 October, a runner that took its
order would forfeit its bond at the delivery deadline, and HELP WANTED's own runner bot refuses
such orders for that reason. With `allowClaimed` true the pot's order can be paid 24 hours after
the runner states that the job was delivered, and is stamped proven when the receipt lands. What
the contributors of such a pot accept is in `docs/THREATS.md` (L1, L2, C2): a claim that misreports
and that nobody challenges is paid, and a challenge nothing decides ends the pot in a refund. That
is why the first pot is filled by the team, and why a keeper with 0.5 IMD watches it (section 6,
point 4). When the command in section 5 prints a count above zero, open pots with `false` instead.

The bond is 0.5 IMD, twice the desk's minimum, because the pot allows claims: it is what a runner
loses for a refuted claim. HELP WANTED's runner bot takes no order whose bond is above its
`MAX_BOND_IMD`, which is 0.25 by default: start it with `MAX_BOND_IMD=0.5` (and `TEMPLATES`
including `skill:research-report`, the default) or it will pass this pot's order by.

`test_runbook_theFirstPotOpensFillsHiresAndIsPaidOnAClaim` opens exactly this pot on the launch's
contracts, fills it, launches it and has it paid on a claim; `test_runbook_theFirstPotSettlesOnAReceiptWhenOneExists`
settles it on a receipt; `test_runbook_theFirstPot_anUntrueClaimIsStoppedByAChallenge` shows the
watcher's part.

```sh
SPEC=$(cast from-utf8 "Write a two-page plain-language report on who paid the IdentityMD swarm in the last seven days and for what, from on-chain IMD transfers to the fee payee only, with every figure sourced to a transaction.")
cast send $POTS "openPot((string,uint96,uint96,uint32,uint96,uint32,uint32,uint32,bool),bytes,uint256)" \
  "(skill:research-report,2000000000000000000,1000000000000000000,86400,500000000000000000,604800,604800,259200,true)" \
  $SPEC 0 --rpc-url "$RPC" $WALLET
POT=$(cast call $POTS "potCount()(uint256)" --rpc-url "$RPC")
cast send $IMD "approve(address,uint256)" $POTS 2000000000000000000 --rpc-url "$RPC" $WALLET
cast send $POTS "chipIn(uint256,uint256)" $POT 2000000000000000000 --rpc-url "$RPC" $WALLET
cast send $POTS "launch(uint256,bytes)" $POT $SPEC --rpc-url "$RPC" $WALLET
```

The pot's order is taken and paid like the Doorbell's (steps 3 and 4), with a bond of 0.5 IMD and
the research-report skill. Its id:

```sh
cast call $POTS "potOf(uint256)((bytes32,bytes32,uint96,uint96,uint40,uint8,bool,uint96,uint96,uint32,uint32,address,uint32,uint32,uint96,uint96,uint40,uint64,bytes16,uint256,bytes32))" $POT --rpc-url "$RPC"
```

(the twentieth value is the order id). A watcher that finds a delivery claim on it untrue:

```sh
cast send $IMD "approve(address,uint256)" $DESK 500000000000000000 --rpc-url "$RPC" $WALLET
cast send $DESK "challenge(uint256)" $ID --rpc-url "$RPC" $WALLET
```

After the pot's order has ended, anyone settles the pot's books and pays a contributor:

```sh
cast send $POTS "claimRefund(uint256,address)" $POT 0x<contributor> --rpc-url "$RPC" $WALLET
```

### Step 6. An order from a wallet

`createOrder` takes the fifteen order parameters and the spec. The parameters, in order: kind hash,
minimum pay, maximum pay, ramp seconds, delivery seconds, expiry time, bond, flags, reserved
runner, arbiter, condition target, condition selector, condition argument, comparison, threshold.

```sh
EXPIRES=$(( $(date +%s) + 604800 ))
cast send $IMD "approve(address,uint256)" $DESK 4000000000000000000 --rpc-url "$RPC" $WALLET
cast send $DESK "createOrder((bytes32,uint96,uint96,uint32,uint32,uint40,uint96,uint8,address,address,address,bytes4,bytes32,uint8,uint256),bytes)" \
  "($(cast keccak skill:research-report),2000000000000000000,4000000000000000000,3600,604800,$EXPIRES,250000000000000000,0,0x0000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,0x00000000,0x0000000000000000000000000000000000000000000000000000000000000000,0,0)" \
  $SPEC --rpc-url "$RPC" $WALLET
```

The eighth value, the flags, is `0` here: a receipt-only order. While receipts are stalled no
careful runner takes it; write `1` there to allow the claimed path, and read `docs/THREATS.md`,
section 5, first.

## 8. Every day after

A keeper is any account that makes these calls. It needs ETH for gas and, for a challenge only, the
order's bond in IMD. No call below pays the keeper. Several keepers can run at once: the second
caller's transaction reverts.

| When | Call | Notes |
|---|---|---|
| An order expired with nobody holding it | `WorkOrders.refund(id)` | The escrow goes back to the employer. |
| A runner registered no job within an hour of claiming | `WorkOrders.evict(id)` | The bond goes to the employer; the order is open again. |
| A registered job has no settlement at its delivery deadline, or a challenged claim was not decided by then | `WorkOrders.timeout(id)` | The deadline is `claimOf(id).registeredAt + orderOf(id).deliverySecs`. |
| A job's receipt exists | `WorkOrders.settle(id, record, [])`, or `stamp` for an order already paid on a claim | Gas limit as in step 4: three million for a small record, an estimate for a large one. Settle also when a delivery claim is standing: `finalize` would send the tip with no agents. Read `orderOfJob(jobId)` first: a job that already settled another order settles no second one. |
| A receipt shows a job that does not settle its order | `WorkOrders.reportFailed(id, record, [])` | A failed job with the right objective can be reported by its runner only. |
| A delivery claim stood 24 hours without a challenge | `WorkOrders.finalize(id)` | Usually the runner's own call. |
| A delivery claim looks untrue, on an order you defend | `WorkOrders.challenge(id)` | Needs the order's bond. Read the order first (below). A record hash that differs from the one named is not by itself a reason: any valid receipt pays the runner. |
| An employer's callback failed | `WorkOrders.redeliver(id)` | Send 200,000 gas or more. |
| A conditional order's condition holds | `WorkOrders.trigger(id)` | Send 150,000 gas or more. |
| A pot's order has ended, or ran out of time | `CrowdPots.reconcile(potId)` or `claimRefund(potId, contributor)` | Both make the desk call the order is waiting for (`refund`, `evict` or `timeout`) themselves. |
| A full pot has not been launched | `CrowdPots.launch(potId, spec)` | Until one day after its deadline. |
| Somebody wants a picture | `Doorbell.ring()` | Every 25th ring hires if the Doorbell holds 1 IMD. |

**Before a challenge, read the order.** A challenger's bond stays in the desk until a receipt, the
order's arbiter or the delivery deadline ends the dispute, and nothing is paid for a dispute that
nothing decides.

```sh
cast call $DESK "orderOf(uint256)((address,uint40,uint40,uint8,uint8,bytes32,bytes32,uint96,uint96,uint32,uint32,address,uint96,address,uint96,address,bytes4,uint8,bool,bool,bool,uint32,bytes32,uint256,uint96,uint96))" $ID --rpc-url "$RPC"
cast call $DESK "claimOf(uint256)((address,uint40,uint40,uint96,bytes16,address,uint40,bytes32))" $ID --rpc-url "$RPC"
```

The first value of `orderOf` is the employer, the eleventh the delivery time in seconds, the
thirteenth the bond and the fourteenth the arbiter; the first value of `claimOf` is the runner and
the third the time the job was registered. Three things to look at:

- **How long the bond can be held**: until the registration time plus the delivery time, which can
  be 90 days.
- **The arbiter.** An arbiter decides with no evidence. If it is not the zero address and you do
  not trust it, do not challenge: an arbiter that sides with the runner gives the runner your bond.
- **The employer.** An employer may be its own runner. Such a party can claim delivery of a job
  that does not exist on an order with a 90-day delivery time; a challenge then holds your bond
  for 90 days, costs that party nothing but gas, and wins you nothing
  (`docs/THREATS.md`, L6). Challenge the orders of employers you have a reason to defend. On the
  first day those are `$POTS` and `$BELL`, whose orders never have an arbiter and have delivery
  times of 7 days or, for a pot, at most 30.

To watch: the desk's `OrderOpened`, `Claimed`, `Registered`, `DeliveryClaimed` and `Challenged`
events, and the registry's `WorkRecorded`. A delivery claim on an order whose employer nobody
watches for is paid after 24 hours if it is not challenged. That is the claimed path's stated
limit, and the reason to watch the Doorbell's and the first pot's orders while they allow it.

## 9. What can go wrong on the day, and what happens then

| Event | What the contracts do |
|---|---|
| Receipts stay stalled | Orders without the claimed path are not paid; each ends by timeout (the runner's bond goes to the employer) or refund. Orders with it are paid on unchallenged claims and stay unproven until a receipt lands. This is the case the first day is planned for. |
| Receipts return | Orders settle on receipts as written in step 4. A Doorbell deployed with the claimed path on keeps accepting claims; open new pots with `allowClaimed` false. |
| The swarm does not keep the header in the stored objective of some kind of job, or writes another kind | It kept both for the one job we bought (a research report; section 5). For a kind where it does not, no receipt settles an order: claims end by `reportFailed` (a receipt without the header is a wrong job: the bond goes to the employer; a receipt with the header under another kind returns the bond to the runner, `docs/THREATS.md` W2) or by timeout (the bond goes to the employer), and escrows return. Nothing is lost by employers; runners lose the swarm's fee, and their bonds except in the other-kind case. Orders that allow claims can still be paid on a claim. |
| Payroll reverts, runs out of gas or takes less than offered | The desk sends what Payroll did not take by plain transfer and emits `PayrollFallback`. The settlement stands (`test_settle_payrollRevertsInBoth`, `test_settle_payrollBurnsAllItsGas`, and against the live contract `test_fork_payroll_bothCallsReverting_theSettlementStandsAndBookPicksUpThePlainTransfer`). A tip that arrives that way is booked by Payroll as revenue, not credited to the agents. |
| IdentityMD replaces the registry's writer, or the registry | A new writer changes nothing here. A new registry at another address means no new receipt can be proven by this `WorkProof`: orders end by timeout or refund, claimed-path orders still work, and proving again needs a new launch. |
| IdentityMD changes the record format while keeping the schema string | New records are `Malformed` here. The same consequence as a new registry. |
| A record is too large for one transaction (above about 128 KB) | It has to be stored as data contracts first (`proveChunks`), at 200 gas per byte: about 64 million gas over several transactions for the 318 KB record among our fixtures. The runner pays that. |
| A watcher's challenge is held by an order nobody means to finish | Its bond comes back at the order's delivery deadline (section 8). The Doorbell's and a pot's orders cannot be used for this beyond 7 and 30 days, and never have an arbiter. |
| Nobody rings | Nothing happens and nothing is lost. |
