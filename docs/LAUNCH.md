# Launch A: Questions, JobsReport, Payroll

This document is what the launch needs and nothing else: the launch request, the manifest we expect,
where every constructor argument comes from, every value that can never be changed afterwards, the
proof to obtain before launching, and what to do on the first day and every day after.

**Status: not launched.** Nothing in this document has been sent to a chain. Every number below was
produced by a test or a command that is named beside it. Addresses of the three contracts do not
exist yet; where a command needs one, it reads it from a shell variable.

The tests in `test/launch/` read this file. The blocks that follow a marker comment
(`<!-- manifest -->`, `<!-- feedId:… -->`, `<!-- createFeed:… -->`, `<!-- proof:… -->`) are parsed
and compared with the code and the fixtures, so a block that is edited by hand without the matching
change in the code fails `forge test`.

## 1. The launch request

To send to IdentityMD with the repository's URL:

> Please deploy this repository as it is: contracts only, on Ethereum mainnet. There is no token
> and no owner.
>
> It holds three contracts, to be created in this order: `Questions`, `JobsReport`, `Payroll`.
> Their constructor arguments are in `docs/LAUNCH.md`: six existing mainnet addresses (IMD, sIMD,
> the seat token, the seat Adapter, the Intake and the oracle signer), the number 2000, three
> `bytes32` feed ids, and two references to `Questions`. No argument is `$owner`: no contract has
> an owner, an admin or a setter.
>
> Nothing has to be called after deployment. The constructors make no external call and check no
> code size, so they run on an empty chain. There is no proxy, no initializer, no pausing and no
> minting; the runtime bytecode holds no DELEGATECALL, CALLCODE or SELFDESTRUCT. `forge test`
> checks each of these statements (`test/launch/LaunchManifest.t.sol`).
>
> The project builds with solc 0.8.26, EVM version cancun, optimizer 200 runs, `via_ir`,
> `bytecode_hash = "none"` and `cbor_metadata = false`, as `foundry.toml` already says. We believe
> no source file needs to change for the launch.

The repository carries no `launch.json`: the pipeline's manifest step writes it.

## 2. The manifest we expect

Contracts in order, with their constructor arguments in order:

<!-- manifest -->
```json
{
  "kind": "evm_contracts",
  "contracts": [
    {
      "contract": "Questions",
      "constructorArgs": [
        "0x1397434cd35e8a9c8ac312a61d3a285eb31dea56",
        "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
        "0x5598aa9146215bc13eb26f2c692ad1461fd32982"
      ]
    },
    {
      "contract": "JobsReport",
      "constructorArgs": [
        "$contract:Questions",
        "0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61",
        "0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d",
        "0xc09b49435a17cb78599285e972df2f6f095b0f49658a8279812f653670633817"
      ]
    },
    {
      "contract": "Payroll",
      "constructorArgs": [
        "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
        "0x9efa934d9fad4ae28c998a40195646b965a97247",
        "0x0000ec93127baa929e58e97dd0095a2bfb38ec1d",
        "2000",
        "0xde152afb7db5373f34876e1499fbd893a82dd336",
        "$contract:Questions",
        "0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61",
        "0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d",
        "0xc09b49435a17cb78599285e972df2f6f095b0f49658a8279812f653670633817"
      ]
    }
  ],
  "notes": "Contracts only. No token, no owner, nothing to call after deployment."
}
```

### Every argument and where its value comes from

All addresses are Ethereum mainnet. The constant names are those of
`src/interfaces/external/Mainnet.sol`, which the tests import; the deployed contracts do not import
it, they receive every address as an argument.

**`Questions(address intake, address imd, address oracleSigner_)`**

| # | Argument | Value | Source |
|---|---|---|---|
| 0 | `intake` | `0x1397434cd35e8a9c8ac312a61d3a285eb31dea56` | `Mainnet.INTAKE`. IdentityMD's Intake, version 1, source verified on Sourcify. Every request is bought from it and every callback must come from it. |
| 1 | `imd` | `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` | `Mainnet.IMD`. The token meters hold and the Intake is paid in. |
| 2 | `oracleSigner_` | `0x5598aa9146215bc13eb26f2c692ad1461fd32982` | `Mainnet.ORACLE_SIGNER`. The address that signs oracle attestations: the `signer` of all 23 attested requests saved under `test/fixtures/questions/requests/`, whose signatures `test/questions/RealAttestations.t.sol` verifies. It is **not** `Intake.signer()`, which signs price quotes. |

**`JobsReport(address questions, bytes32 payrollsFeed, bytes32 hiresFeed, bytes32 employersFeed)`**

| # | Argument | Value | Source |
|---|---|---|---|
| 0 | `questions` | `$contract:Questions` | The first contract of this launch. |
| 1 | `payrollsFeed` | the payrolls feed id, below | Recomputed from `test/fixtures/questions/feeds/payrolls.json`. |
| 2 | `hiresFeed` | the hires feed id, below | Recomputed from `test/fixtures/questions/feeds/hires.json`. |
| 3 | `employersFeed` | the employers feed id, below | Recomputed from `test/fixtures/questions/feeds/employers.json`. |

**`Payroll(address imd, address simd, address seats, uint256 seatCount, address adapter, address questions, bytes32 feedA, bytes32 feedB, bytes32 feedC)`**

| # | Argument | Value | Source |
|---|---|---|---|
| 0 | `imd` | `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` | `Mainnet.IMD`. |
| 1 | `simd` | `0x9efa934d9fad4ae28c998a40195646b965a97247` | `Mainnet.SIMD`. The ERC-4626 vault over IMD that stakers hold; the staker stream is sent to it by plain transfer. |
| 2 | `seats` | `0x0000ec93127baa929e58e97dd0095a2bfb38ec1d` | `Mainnet.SEATS`. The seat ERC-721. |
| 3 | `seatCount` | `2000` | `Mainnet.SEAT_COUNT`. Seats are token ids 0 to 1999. |
| 4 | `adapter` | `0xde152afb7db5373f34876e1499fbd893a82dd336` | `Mainnet.SEAT_ADAPTER`. IdentityMD's agent-to-seat Adapter (an upgradeable proxy; only tips depend on it). |
| 5 | `questions` | `$contract:Questions` | The first contract of this launch. |
| 6 | `feedA` | the payrolls feed id | Served first, 14-request runway. |
| 7 | `feedB` | the hires feed id | Served first, 14-request runway. |
| 8 | `feedC` | the employers feed id | The slow feed: served only from what the first two leave, 4-request runway. |

The order `feedA` = payrolls, `feedB` = hires, `feedC` = employers matters: the third feed is the
one Payroll funds last and least.

### The three feed ids

A feed id is `keccak256(abi.encode(params, keccak256(qPrefix), keccak256(tail)))`: it depends only on
what the feed asks, so the ids are known before any feed exists.
`test_manifest_feedIdsAreRecomputedFromTheFixtures` recomputes the three from the fixture files and
fails if any id written in this document differs.

payrolls (the sum of IMD transferred to the fee payee `0x4e0fa57bde726079356537e2f34d671e9f41adbc`, per day):

<!-- feedId:payrolls -->
```text
0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61
```

hires (the number of IMD `Transfer` logs to the fee payee, per day, transfers of zero included):

<!-- feedId:hires -->
```text
0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d
```

employers (the three addresses that sent the fee payee the most IMD over the last seven days):

<!-- feedId:employers -->
```text
0xc09b49435a17cb78599285e972df2f6f095b0f49658a8279812f653670633817
```

## 3. What the tests show about the launch

| Statement | Test |
|---|---|
| The manifest above names `Questions`, `JobsReport`, `Payroll` in that order, with 3, 4 and 9 arguments, two backward references and no `$owner` | `test_manifest_namesTheThreeContractsInOrder` |
| Every argument is the `Mainnet.sol` address, the reference, or the recomputed feed id | `test_manifest_everyArgumentIsWhatTheCodeExpects`, `test_manifest_feedIdsAreRecomputedFromTheFixtures` |
| Created in manifest order from those arguments, on a chain where no dependency has code, the three contracts deploy and report the configuration written here | `test_launch_deploysInManifestOrderOnAnEmptyChain` |
| Each contract is inside our gates of 23,000 bytes of runtime code and 46,000 bytes of initcode; the launch is inside our gate of 12,000,000 gas | `test_launch_fitsOurSizeAndGasGates` |
| No runtime bytecode holds DELEGATECALL, CALLCODE or SELFDESTRUCT (walked instruction by instruction, PUSH data skipped) | `test_launch_runtimeBytecodeHasNoForbiddenOpcode`, `test_bytecodeWalk_findsWhatItLooksForAndSkipsPushData` |
| No constructor holds CALL, STATICCALL, an EXTCODE instruction, BALANCE, CREATE or CREATE2 | `test_launch_constructorsMakeNoCallAndNoCodeCheck` |
| On a mainnet fork, the launch deployer's `launchContracts` call to the real ProjectFactory creates the three contracts at the predicted addresses | `test_fork_rehearsal_factoryCreatesTheThreeContracts` (fork suite) |

Measured sizes (`forge build --sizes`; the protocol's limits are 24,576 and 49,152 bytes):

| Contract | Runtime bytes | Initcode bytes | Initcode with arguments |
|---|---|---|---|
| Questions | 22,986 | 24,395 | 24,491 |
| JobsReport | 9,320 | 9,618 | 9,746 |
| Payroll | 11,561 | 12,268 | 12,556 |

`Questions` is 14 bytes under our own 23,000-byte gate and 1,590 bytes under the limit. It has no room
left for additions; that is known and accepted, since nothing can be added after launch anyway.

Launch gas:

| Measure | Gas | Where it comes from |
|---|---|---|
| Creating the three contracts one after another on an empty chain | 9,792,287 (Questions 5,098,726, JobsReport 2,104,853, Payroll 2,588,708) | `test_launch_fitsOurSizeAndGasGates`, with Foundry's default setting, which runs each creation as a transaction of its own. With `FOUNDRY_ISOLATE=false` the same test prints 8,909,847. |
| The brief's estimate: 240 gas for each of the 46,793 bytes of initcode | 11,230,320 | The same test. The rate is that of launch 1240 (9,596,612 gas for 39,910 bytes). |
| The real ProjectFactory's `launchContracts`, called by the launch deployer on a mainnet fork | About 10.31 million for the call, and 0.75 million more for the transaction's base cost and calldata: about 11.06 million | `test_fork_rehearsal_launchFitsOurGasAndSizeGates`. Three runs on 12 October 2026 printed 11,055,056, 11,057,407 and 11,057,595; the figure moves by a few thousand gas with the block the fork is taken at. |

Our gate is 12,000,000 gas and the protocol's ceiling is 16.7 million. The rehearsed launch is
about 0.94 million gas under our gate. The second part of the rehearsal figure is added by hand
from the calldata's bytes, which may count some of it twice; the figure errs high.

## 4. What is fixed at launch

Nothing below can be changed by anyone once the launch transaction is mined. There is no owner, no
setter and no upgrade path. Each value is listed with the reason it has the value it has.

### Questions

| Value | Setting | Reason |
|---|---|---|
| Intake, IMD, oracle signer | constructor arguments | No key exists that could point a feed at another signer or another Intake. The cost is stated in `docs/DEVIATIONS.md`: if IdentityMD rotates the signer or moves the Intake, new answers stop and the contract has to be launched again. |
| Attestation domain | name `IdentityMD Oracle`, version `2` | From the protocol's `OracleAttestation.sol`, copied unchanged. |
| `ISSUED_AT_TOLERANCE` | 5 minutes | From the protocol's library: how far ahead of the chain's clock a signing time may be. |
| `SUBMIT_AFTER_SILENCE` | 2 hours | When anyone may hand in an answer for a request the Intake has still not completed. Past the oracle's usual latency (on IdentityMD's public list of requests on 10 October 2026 the median was 14 minutes and nine in ten were answered within 55) and four hours before the round can be closed. |
| `ABANDON_AFTER_COMPLETED` | 30 minutes | Time left to hand in an answer whose callback did not run, counted from the first `abandon` call that sees the Intake's completion. |
| `ABANDON_AFTER_SILENCE` | 6 hours | Any pending round can be closed by anyone after this, whatever the Intake says, so no feed can be stuck. |
| Back-off | cadence × 2^(failed rounds in a row), at most 2^5 = 32 (`MAX_BACKOFF_DOUBLINGS` = 5) | A feed whose question keeps failing spends its funders' IMD more and more slowly, and never stops asking altogether. One answer resets it. |
| `GATE_GAS`, `GATE_DATA_MAX` | 100,000 gas, 68 bytes | The WHEN gate is one bounded static call with a selector and at most two words. |
| `MAX_PANEL_SIZE` | 300 | The protocol's own upper limit for a panel. |
| `MIN_LAG_BLOCKS`, `MAX_LAG_BLOCKS` | 5, 256 | The protocol refuses a window that ends fewer than 5 blocks back; 256 is as far as BLOCKHASH reaches. |
| `validFor` range | 60 seconds to 30 days | The protocol's range for `validForSeconds`. |
| Longest body | 16,384 bytes | The Intake's limit. |
| Tip bound | a feed's tip is at most its `maxPrice` | A keeper is never paid more for asking than the feed pays for the answer. |
| Tip rule | set aside at `request`, earned by an answer, returned to the meter when the round fails | Brief, section 12, decision 1: asking earns nothing by itself. |
| Intake read gas | 50,000 per read | A bound, so an Intake getter that burns gas cannot keep a round from being closed. |
| Share rescale | counts divided by 2^64 when a meter has more than 2^128 shares per wei | Keeps a long-lived meter's share count from overflowing. |

### Payroll

| Value | Setting | Reason |
|---|---|---|
| IMD, sIMD, seat token, seat count, Adapter, Questions, three feed ids | constructor arguments | Written in the manifest, readable by anyone. |
| Split of every booking | 50% stakers (and every rounding remainder), 30% seats (`SEAT_BPS` 3000), 20% feeds (`FEED_BPS` 2000) | The product's fee split. |
| `STREAM_DURATION` | 7 days | New money for stakers vests over a week, so a short visit to sIMD cannot collect a week's fees. |
| Stream end on a booking | `now + (remaining × timeLeft + amount × 7 days) / (remaining + amount)` | Brief, section 12, decision 2: a booking of dust moves the end by nothing; a large one still takes about seven days. |
| `DRIP_INTERVAL`, `DRIP_WINDOW` | 10 minutes, 1 hour | Drips are at least ten minutes apart and one drip sends at most one hour of stream, so one transfer to sIMD is always small. Kept as built (decision 3). |
| `MAX_TIP_AGENTS` | 16 | Only the first 16 agent ids of a tip share it: a bounded loop, and `tip` stays under 600,000 gas. |
| `TIP_SWEEP_DELAY` | 180 days | A tip that cannot be claimed waits between 180 and 360 days, then anyone may move it to the seat pool. |
| `MAX_SEATS_PER_CALL` | 200 | A full `claimSeats` list is about 10 million gas at the per-seat cost measured on a mainnet fork. |
| `FEED_RUNWAY_REQUESTS` | 14 | The two daily feeds are topped up to two weeks of requests and no further. |
| `FEED_C_RUNWAY_REQUESTS` | 4 | The weekly feed is topped up to four requests, and only from what the first two leave. |
| `FEED_COST_CAP` | 2 IMD | The most Payroll assumes one request costs when it sizes a top-up, so a price change at the Intake cannot empty the budget into one meter. |
| `FEED_BUDGET_PERIOD` | 14 days | Feed budget no meter needed is released to stakers after 14 to 28 days, so it cannot be stranded. |
| `BINDING_GAS` | 100,000 | Gas given to the Adapter read, with a floor so a caller cannot starve it. The live Adapter used 13,200 on a mainnet fork. |

### JobsReport

| Value | Setting | Reason |
|---|---|---|
| Questions, three feed ids | constructor arguments | Written in the manifest. |
| `MAX_ROUNDS_PER_CALL`, `MAX_PAIRING_STEPS` | 8, 16 | Bounded work per `print` call; a backlog is worked off over several calls. |
| `MAX_DAY_BLOCKS` | 7,500 | About 25 hours. A print over a longer window (the catch-up after a missed day) cannot take the best-day record and ends the streak. |
| Pairing rule | a count joins a print when the two windows share more than half of the longer one | The two daily feeds are requested by separate transactions and may drift. |
| Largest figure | 2^128 − 1 | A larger answer is passed over, so no single answer can overflow a running total. |
| `MAX_PAGE` | 100 | The most entries a page view returns. |

### The three house feeds

These are parameters of the feeds, not of the contracts. They are fixed in the sense that
`JobsReport` and `Payroll` are bound to the three ids above, and an id changes if any parameter or
any byte of the question changes. Until the proof requests of section 5 have been bought they can
still be changed in the fixture files, and this document and the ids with them.

| Parameter | payrolls | hires | employers | Reason |
|---|---|---|---|---|
| Recipe (pinned in `definitions.recipe`) | `log-sum` of `Transfer.value` to the fee payee | `log-count` of `Transfer` to the fee payee | `log-rank` of senders by summed `value`, top 5 | Chain evidence only: the oracle reruns the agreed recipe at the pinned blocks before it signs, so the answer is a fact about the chain. |
| Answer type | `uint256` | `uint256` | `address[]`, `head` 3 | |
| Panel size, quorum, `minAgreed` | 7, 5, 5 | 7, 5, 5 | 7, 5, 5 | The values of the attested request the bodies are modelled on. `minAgreed` equal to the quorum accepts only the panel's own agreement. |
| `validFor` | 86,400 s | 86,400 s | 86,400 s | One day to deliver an answer. |
| `cadenceBlocks` | 7,000 | 7,000 | 49,000 | 23 h 20 min, so a keeper can ask at the same clock time every day; a little under seven days for the ranking. |
| `maxWindowBlocks` | 21,600 | 21,600 | 50,400 | Three days of catch-up for the daily feeds; exactly seven days for the ranking. |
| `lagBlocks` | 12 | 12 | 12 | The usual distance behind the head. |
| `contiguous` | yes | yes | no | Daily windows tile with no gap and no overlap; a ranking is of the newest seven days. |
| `pinHash` | yes | yes | yes | An answer must carry the question hash built on chain from the feed's own text. |
| `maxPrice` | 2 IMD | 2 IMD | 2 IMD | Four times the live price of 0.5 IMD. Above it, requests stop. |
| `tip` | 0.05 IMD | 0.05 IMD | 0.05 IMD | Paid to the keeper for an answered round. Kept as built (decision 3). |
| WHEN gate | none | none | none | |

Limits a reader of the feeds should know: hires counts every `Transfer` log to the fee payee,
including transfers of zero and transfers that are not purchases, because a `log-count` filter
reaches indexed arguments only. The feeds' own purchases are transfers to the fee payee too and are
counted. See `docs/THREATS.md`.

## 5. Before launch: prove each feed body with one real request

**This has not been done yet. It is a condition of launching.**

The protocol's free check returned no blocker for the three questions on 11 October, with one
note on each ("may be read more than one way"). The free check does not take `definitions`, so it
did not exercise the pinned recipe. Only a paid request does. So before launch A, the team buys
one request per feed from an ordinary wallet, through the Intake, with no callback, using exactly
the bytes `Questions` will send.

What it costs: 0.5 IMD per request, 1.5 IMD for the three, plus gas. **The price is never
refunded**, whether the request is answered, refused or left without an answer.

<!-- proof:priceWei -->
```text
500000000000000000
```

<!-- proof:action -->
```text
0x6f7261636c652e72657175657374406f7261636c652d31000000000000000000
```

The window each proof asks about is the window `Questions` asks first: it ends 12 blocks behind the
head and covers this many blocks.

<!-- proof:blocks:payrolls -->
```text
7000
```

<!-- proof:blocks:hires -->
```text
7000
```

<!-- proof:blocks:employers -->
```text
50400
```

`test_proof_shellRecipeGivesTheBodyTheContractSends` shows that the body and the question hash
assembled below are, byte for byte, what the contract produces for the same window, for all three
feeds. `test_fork_proof_walletBuys…` (fork suite) makes the same two calls as below against the live
Intake on a fork.

### The commands

They need `cast` (Foundry) and `jq`, and are run from the repository root. `$WALLET` stands for the
operator's own signing option for `cast send`, for example `--account NAME` (an encrypted keystore)
or `--ledger`. No key is written in this file, and none should be typed on a command line.

```sh
export RPC=...                                              # an Ethereum mainnet RPC URL
export IMD=0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7
export INTAKE=0x1397434cd35e8a9c8ac312a61d3a285eb31dea56
export ACTION=0x6f7261636c652e72657175657374406f7261636c652d31000000000000000000
export PRICE=500000000000000000

# Once: allow the Intake to take the three prices (1.5 IMD).
cast send $IMD "approve(address,uint256)" $INTAKE 1500000000000000000 --rpc-url "$RPC" $WALLET
```

Then, for each feed in turn, **one request per transaction** (IdentityMD's service serves only the
first request of a transaction):

```sh
FEED=payrolls; BLOCKS=7000        # then: FEED=hires; BLOCKS=7000   and: FEED=employers; BLOCKS=50400
F=test/fixtures/questions/feeds/$FEED.json

HEAD=$(cast block-number --rpc-url "$RPC")
TO=$((HEAD - 12)); FROM=$((TO - BLOCKS + 1))
WINDOW="$FROM,\"toBlock\":$TO}"
BODY=$(cast concat-hex "$(jq -r .qPrefixHex $F)" "$(cast from-utf8 "$WINDOW")" "$(jq -r .tailHex $F)")
QHASH=$(cast keccak "$(cast concat-hex "$(jq -r .qPrefixHex $F)" "$(cast from-utf8 "$WINDOW}")")")
echo "$FEED: blocks $FROM to $TO, question hash $QHASH"
cast to-utf8 $BODY                                          # read the body before paying for it

cast send $INTAKE "request(bytes32,bytes,(address,bytes4),address,uint256)" \
  $ACTION $BODY "(0x0000000000000000000000000000000000000000,0x00000000)" $IMD $PRICE \
  --rpc-url "$RPC" $WALLET
```

Keep `FROM`, `TO`, `QHASH` and the transaction hash of each request.

### Where to read the result

On IdentityMD's public list of requests on 10 October 2026 the median answer took 14 minutes and
nine in ten were there within 55.

```sh
TX=0x...                                                    # the request's transaction hash
curl -s https://api.imd.fun/intake/1/$TX | jq '.entries[0] | {state, reason, requestId, admission, completion}'
```

`state` moves through `received`, `paid`, `admitted`, `completing` and ends at `completed`,
`refused` or `failed`. `admission.result.statusUrl` names the oracle request; the full list is at
<https://api.imd.fun/oracle/requests>.

```sh
ID=...                                                      # admission.result.requestId
curl -s https://api.imd.fun/oracle/requests/$ID | jq '{status, questionHash, answerType, signer, failure, attestation}'
```

On chain, the Intake's `Completed` event for the request (its `requestId` is the first topic of the
`Requested` event in the transaction's receipt):

```sh
REQ=$(cast receipt $TX --rpc-url "$RPC" --json | jq -r '.logs[] | select(.address | ascii_downcase == "0x1397434cd35e8a9c8ac312a61d3a285eb31dea56") | .topics[1]')
cast logs --rpc-url "$RPC" --address $INTAKE --from-block $(cast receipt $TX blockNumber --rpc-url "$RPC") \
  "Completed(bytes32 indexed,uint8,bytes32,string,bool)" $REQ
```

`status` in that event is 0 for an answer, 1 for a refused request, 2 for no answer. `delivered` is
`false` here, because the request named no callback. The same three facts are in the Intake read
above, under `completion`, with the hash of the completing transaction. (A free RPC node serves logs
for roughly the last 9,000 blocks only, so read the event the same day.)

These reads were tried on 12 October 2026 against a past mainnet request that named no callback
(transaction `0x9c9b61d90d202084cf4cda99ed0ab3ba90061d70e8e530c054f5404911da51a9`): the Intake read
returned `state` `completed`, `completion.status` 0 and `completion.delivered` `false`.

### Go or no-go

A feed is **go** when all of these hold for its proof request:

1. The Intake read says `completed` and the `Completed` event has `status` 0.
2. The oracle request's `status` is `attested`.
3. Its `questionHash` equals `QHASH`. This is the hash `Questions` computes on chain and requires of
   every answer, so a different hash here means the contract would refuse every answer.
4. `attestation.fromBlock` and `attestation.toBlock` equal `FROM` and `TO`, and
   `attestation.blockHash` equals `cast block $TO --field hash --rpc-url "$RPC"`.
5. `attestation.answerType` is `uint256` for payrolls and hires and `address[]` for employers.
6. `attestation.panelSize` is at least 7, `attestation.quorum` at least 5, and `attestation.agreed`
   at least `attestation.quorum`. The feeds accept only the panel's own agreement.
7. `signer` is `0x5598aa9146215bc13eb26f2c692ad1461fd32982`, the address in the manifest.
8. For employers: `cast decode-abi "f()(address[])" <attestation.answer>` prints a list of at most
   three addresses.

A feed is **no-go** when:

- the request is `refused` (`status` 1). The body is not acceptable as written. Read `reason` and
  `detail`, change the feed's text or tail in `test/fixtures/questions/tools/build_house_feeds.py`,
  regenerate the fixtures (`python3 -I test/fixtures/questions/tools/build_house_feeds.py
  test/fixtures/questions/feeds`), update the ids and calldata in this document (the tests say
  where), and buy the proof again. If the reason is the wording screen, the remedy is a clearer sentence or
  `"allowAmbiguous":true` in the tail;
- the question hash differs (point 3). Do not launch: the hash rule in `QuestionBody.sol` no longer
  matches the oracle's;
- the request ends with no answer (`status` 2, the panel did not agree), or with `agreed` below the
  quorum. Buy it once more with a fresh window. A second failure is a no-go for that feed.

**Launch A needs payrolls and hires to be go.** The Jobs Report is complete without the employers
feed: `print` never reads it, and `crown` is the only function that does. If employers alone is
no-go, there are two honest choices. Either correct its body first (its id, and so the manifest,
changes), or launch as written and leave the employers feed uncreated and unfunded. In the second
case nothing else is affected, with one exposure to state: `createFeed` is open to anyone, and if
somebody creates that feed, `Payroll.fundFeeds` will keep its meter at up to four requests (2.2 IMD
at the live price), from budget the two daily feeds did not need, and each failed round costs that
meter 0.5 IMD, at most once per cadence of 49,000 blocks and less often after each failure.

## 6. The first day

Nothing is called by the launch pipeline after deployment, so the feeds do not exist until somebody
creates them. Every call below is open to anyone; none needs a privilege, and the team's wallet is
only the first to make them.

```sh
export QUESTIONS=...     # the three addresses the launch created, from its ContractsLaunched event
export JOBS_REPORT=...
export PAYROLL=...
export PAYROLLS=0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61
export HIRES=0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d
export EMPLOYERS=0xc09b49435a17cb78599285e972df2f6f095b0f49658a8279812f653670633817
```

Before anything else, read back what was deployed and compare it with section 2:

```sh
cast call $QUESTIONS "INTAKE()(address)" --rpc-url "$RPC"
cast call $QUESTIONS "IMD()(address)" --rpc-url "$RPC"
cast call $QUESTIONS "oracleSigner()(address)" --rpc-url "$RPC"
cast call $JOBS_REPORT "QUESTIONS()(address)" --rpc-url "$RPC"
cast call $PAYROLL "QUESTIONS()(address)" --rpc-url "$RPC"
cast call $PAYROLL "FEED_A()(bytes32)" --rpc-url "$RPC"    # payrolls; FEED_B hires; FEED_C employers
```

### Step 1. Create the three feeds

Three transactions to `Questions`, each with the calldata below as its whole input. The calldata is
`createFeed(params, qPrefix, tail)` for the feed's fixture file;
`test_runbook_documentedCalldataIsWhatTheFixturesGive` compares each block with the fixtures byte
for byte, and `test_runbook_documentedCalldataCreatesTheManifestFeeds` sends each to a fresh
`Questions` and gets the three ids of section 2. To print them again after a change:
`forge test --match-test test_runbook_printsTheCalldata -vv` (it prints, it sends nothing). To read
one before sending it:
`cast decode-calldata "createFeed((bytes32,uint64,uint8,uint16,uint16,uint16,uint32,uint32,uint32,uint16,bool,bool,uint96,uint96,uint8,address,uint256,bytes),bytes,bytes)" <calldata>`.

```sh
cast send $QUESTIONS <calldata> --rpc-url "$RPC" $WALLET
```

On a mainnet fork the three calls used about 892,000 gas (payrolls), 820,000 (hires) and 1,044,000 (employers); the fork suite logs them. Creating a feed that already exists returns its id and
changes nothing, so it does not matter who gets there first.

payrolls:

<!-- createFeed:payrolls -->
```text
0x8320d106000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000005a06f7261636c652e72657175657374406f7261636c652d310000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000151800000000000000000000000000000000000000000000000000000000000001b580000000000000000000000000000000000000000000000000000000000005460000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000001bc16d674ec8000000000000000000000000000000000000000000000000000000b1a2bc2ec500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000240000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b77b22616e7377657254797065223a2275696e74323536222c22636861696e4964223a312c22646566696e6974696f6e73223a7b22726563697065223a227b5c226b696e645c223a5c226c6f672d73756d5c222c5c22616464726573735c223a5c223078643334613939626330663637616531626264363363363630653664306230646430336532363362375c222c5c226576656e745c223a5c226576656e74205472616e73666572286164647265737320696e64657865642066726f6d2c206164647265737320696e646578656420746f2c2075696e743235362076616c7565295c222c5c2273756d4172675c223a5c2276616c75655c222c5c226162735c223a66616c73652c5c2266696c7465725c223a7b5c22746f5c223a5c223078346530666135376264653732363037393335363533376532663334643637316539663431616462635c227d7d202d207772697465207265636970652065786163746c7920746869732c206576656e74207465787420696e636c756465642e227d2c227175657374696f6e223a2257686174206973207468652073756d206f66207468652076616c756520617267756d656e74206f66206576657279205472616e73666572286164647265737320696e64657865642066726f6d2c206164647265737320696e646578656420746f2c2075696e743235362076616c756529206576656e7420656d69747465642062792074686520746f6b656e20636f6e7472616374203078643334613939626330663637616531626264363363363630653664306230646430336532363362372077686f736520746f20617267756d656e742069732030783465306661353762646537323630373933353635333765326633346436373165396634316164626320696e207468652077696e646f773f222c2276223a312c2277696e646f77223a7b2266726f6d426c6f636b223a00000000000000000000000000000000000000000000000000000000000000000000000000000000562c2265766964656e6365223a22636861696e222c2270616e656c53697a65223a372c2271756f72756d223a352c22746f6c6572616e6365427073223a302c2276616c6964466f725365636f6e6473223a38363430307d00000000000000000000
```

hires:

<!-- createFeed:hires -->
```text
0x8320d106000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000005606f7261636c652e72657175657374406f7261636c652d310000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000151800000000000000000000000000000000000000000000000000000000000001b580000000000000000000000000000000000000000000000000000000000005460000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000001bc16d674ec8000000000000000000000000000000000000000000000000000000b1a2bc2ec5000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000026f7b22616e7377657254797065223a2275696e74323536222c22636861696e4964223a312c22646566696e6974696f6e73223a7b22726563697065223a227b5c226b696e645c223a5c226c6f672d636f756e745c222c5c22616464726573735c223a5c223078643334613939626330663637616531626264363363363630653664306230646430336532363362375c222c5c226576656e745c223a5c226576656e74205472616e73666572286164647265737320696e64657865642066726f6d2c206164647265737320696e646578656420746f2c2075696e743235362076616c7565295c222c5c2266696c7465725c223a7b5c22746f5c223a5c223078346530666135376264653732363037393335363533376532663334643637316539663431616462635c227d7d202d207772697465207265636970652065786163746c7920746869732c206576656e74207465787420696e636c756465642e227d2c227175657374696f6e223a22486f77206d616e79205472616e73666572286164647265737320696e64657865642066726f6d2c206164647265737320696e646578656420746f2c2075696e743235362076616c756529206576656e7473206469642074686520746f6b656e20636f6e74726163742030786433346139396263306636376165316262643633633636306536643062306464303365323633623720656d69742077686f736520746f20617267756d656e742069732030783465306661353762646537323630373933353635333765326633346436373165396634316164626320696e207468652077696e646f773f222c2276223a312c2277696e646f77223a7b2266726f6d426c6f636b223a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000562c2265766964656e6365223a22636861696e222c2270616e656c53697a65223a372c2271756f72756d223a352c22746f6c6572616e6365427073223a302c2276616c6964466f725365636f6e6473223a38363430307d00000000000000000000
```

employers:

<!-- createFeed:employers -->
```text
0x8320d106000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000006806f7261636c652e72657175657374406f7261636c652d31000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000015180000000000000000000000000000000000000000000000000000000000000bf68000000000000000000000000000000000000000000000000000000000000c4e0000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000001bc16d674ec8000000000000000000000000000000000000000000000000000000b1a2bc2ec500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000240000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003917b22616e7377657254797065223a22616464726573735b5d222c22636861696e4964223a312c22646566696e6974696f6e73223a7b22726563697065223a227b5c226b696e645c223a5c226c6f672d72616e6b5c222c5c22616464726573735c223a5c223078643334613939626330663637616531626264363363363630653664306230646430336532363362375c222c5c226576656e745c223a5c226576656e74205472616e73666572286164647265737320696e64657865642066726f6d2c206164647265737320696e646578656420746f2c2075696e743235362076616c7565295c222c5c2273756d4172675c223a5c2276616c75655c222c5c226162735c223a66616c73652c5c2267726f757042795c223a5c2266726f6d5c222c5c22746f704e5c223a352c5c2266696c7465725c223a7b5c22746f5c223a5c223078346530666135376264653732363037393335363533376532663334643637316539663431616462635c227d7d202d207772697465207265636970652065786163746c7920746869732c206576656e74207465787420696e636c756465642e227d2c2268656164223a332c227175657374696f6e223a225768696368206164647265737365732073656e7420746865206d6f737420494d442028746f6b656e20636f6e7472616374203078643334613939626330663637616531626264363363363630653664306230646430336532363362372920746f20307834653066613537626465373236303739333536353337653266333464363731653966343161646263206f6e20457468657265756d206d61696e6e657420696e207468652077696e646f773f2052616e6b2073656e64657273206279207468652073756d206f662076616c7565206f766572205472616e73666572286164647265737320696e64657865642066726f6d2c206164647265737320696e646578656420746f2c2075696e743235362076616c756529206576656e7473206f66207468617420636f6e74726163742077686f736520746f20617267756d656e74206973203078346530666135376264653732363037393335363533376532663334643637316539663431616462632c2067726f757065642062792066726f6d3b20616e737765722074686520746f7020352c206c6172676573742066697273742c207469657320627920617363656e64696e6720616464726573732e222c2276223a312c2277696e646f77223a7b2266726f6d426c6f636b223a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000452c2265766964656e6365223a22636861696e222c2270616e656c53697a65223a372c2271756f72756d223a352c2276616c6964466f725365636f6e6473223a38363430307d000000000000000000000000000000000000000000000000000000
```

Check: `cast call $QUESTIONS "feedCount()(uint256)" --rpc-url "$RPC"` is 3 and
`cast call $QUESTIONS "costOf(bytes32)(uint256)" $PAYROLLS --rpc-url "$RPC"` is 550000000000000000
(the price of 0.5 IMD plus the tip of 0.05).

### Step 2. Fund the meters

A request costs the meter 0.55 IMD: 0.5 to the Intake, never refunded, and 0.05 set aside as the
keeper's tip, which comes back to the meter if the round fails. Until Payroll has revenue, the
meters are funded from a wallet. One runway is 14 requests for each daily feed (7.7 IMD) and 4 for
the weekly one (2.2 IMD): 17.6 IMD in all.

```sh
cast send $IMD "approve(address,uint256)" $QUESTIONS 17600000000000000000 --rpc-url "$RPC" $WALLET
cast send $QUESTIONS "fund(bytes32,uint256)" $PAYROLLS  7700000000000000000 --rpc-url "$RPC" $WALLET
cast send $QUESTIONS "fund(bytes32,uint256)" $HIRES     7700000000000000000 --rpc-url "$RPC" $WALLET
cast send $QUESTIONS "fund(bytes32,uint256)" $EMPLOYERS 2200000000000000000 --rpc-url "$RPC" $WALLET
```

The funder holds shares of each meter and can take back whatever the meter has not spent, at any
time, with `defund(bytes32,uint256)`; `type(uint256).max` as the share count takes everything.
Later, 20% of what Payroll books becomes feed budget, and `fundFeeds()` tops the same meters up to
the same runways, so a wallet that funded the first day can withdraw as revenue takes over.

Fund the employers meter only if its proof request was go (section 5).

### Step 3. The first requests

Each request is a transaction of its own. Never batch two, and never send one through a contract
that also buys from the Intake in the same transaction: IdentityMD's service serves only the first
request of a transaction, and a request that is not served costs the meter 0.5 IMD and six hours.

Send payrolls and hires so that they land in the same block (two transactions, consecutive nonces):
their windows are then identical and every count is exact for its print's period.

```sh
cast call $QUESTIONS "canRequest(bytes32)(bool,uint8,uint256,uint64,uint64)" $PAYROLLS --rpc-url "$RPC"
cast send $QUESTIONS "request(bytes32)" $PAYROLLS  --rpc-url "$RPC" $WALLET
cast send $QUESTIONS "request(bytes32)" $HIRES     --rpc-url "$RPC" $WALLET
cast send $QUESTIONS "request(bytes32)" $EMPLOYERS --rpc-url "$RPC" $WALLET
```

`canRequest` returns whether a request would go through and, if not, why (the second value: 0 none,
1 unknown feed, 2 already asked in this transaction, 3 round pending, 4 too soon, 5 no blocks, 6
gate closed, 7 not sold, 8 price above the cap, 9 meter too low). On a mainnet fork, against the live Intake, a first request used about 423,000 gas (payrolls), 418,000 (hires) and 440,000 (employers).

### Step 4. The answers

The Intake's writer delivers each answer by calling `onOracleResult` on `Questions`. Nobody has to
do anything. To see it:

```sh
cast call $QUESTIONS "latest(bytes32)(uint256,uint64,uint64,uint64,uint64)" $PAYROLLS --rpc-url "$RPC"
cast call $QUESTIONS "feedState(bytes32)((bool,uint64,uint64,uint64,uint64,uint8,bool,bytes32,uint64,uint256,uint256,uint256,uint8))" $PAYROLLS --rpc-url "$RPC"
```

### Step 5. Print, and crown

```sh
cast send $JOBS_REPORT "print()" --rpc-url "$RPC" $WALLET
cast call $JOBS_REPORT "printCount()(uint256)" --rpc-url "$RPC"
```

`print` copies every newly answered payrolls and hires round into the report. It never reads the
employers feed. When an employers round has an answer, anyone may publish its top three by handing
in the attested list, which the contract checks against the hash `Questions` stored:

```sh
# ANSWER is attestation.answer from https://api.imd.fun/oracle/requests/<id> for that round
cast send $JOBS_REPORT "crown(uint64,bytes)" 1 $ANSWER --rpc-url "$RPC" $WALLET
```

## 7. Every day after

A keeper is any account that makes these calls. It needs ETH for gas and nothing else; no call
below takes IMD from the keeper. All of them can be made by several keepers at once: the second
caller's transaction reverts or does nothing.

| When | Call | Notes |
|---|---|---|
| Once a day (every 7,000 blocks, 23 h 20 min) | `Questions.request(PAYROLLS)` and `Questions.request(HIRES)`, two transactions for the same block | Ask `canRequest` first. Each answered round earns the caller 0.05 IMD. |
| After each answer | `JobsReport.print()` | Free of any condition; a call with nothing new changes nothing. |
| Once a week (every 49,000 blocks) | `Questions.request(EMPLOYERS)`, then `JobsReport.crown(round, answer)` once it is answered | Optional: the report is complete without it. |
| About once an hour | `Payroll.drip()` | `stream()` returns `dueNow`; call when it is not zero. An hourly drip keeps the stakers' stream even. |
| When IMD reached Payroll by plain transfer | `Payroll.book()` | `unbooked()` says how much is waiting. |
| When a meter is below its runway, and at least once a fortnight | `Payroll.fundFeeds()` | `feedShortfalls()` and `feedBudget()` say what it would do. |
| When a round has been pending too long | `Questions.abandon(feedId)` | `canAbandon` returns the step: 1 means a first call that only starts a 30-minute wait, 2 means the call closes the round. Six hours after the request one call always closes it. |
| When it likes | `Questions.collectTips()` | Pays the caller the tips it has earned. `tipsOf(address)` shows earned and pending. |

A round the Intake completed without an answer (refused, or the panel did not agree) takes two
`abandon` calls thirty minutes apart, or one call six hours after the request. After a failed round
the feed waits twice as long before it may ask again, four times after two in a row, up to 32
times; the first answer puts the cadence back.

A round the service never served can be rescued instead of abandoned. Two hours after the request,
`canSubmit(feedId)` turns true. Anyone who buys the same body from the oracle over HTTP, with
`consumer` set to `{chainId: 1, verifyingContract: <Questions>}`, can hand the signed answer in with
`submit(feedId, attestation, signature)`. That answers the round, leaves the cadence as it was, and
earns that caller the round's tip. The exact body of the pending round is in the Intake's
`Requested` event for it; `roundOf` gives its window and `roundRequest` its question hash.

Seat owners and their agents are paid on request, by anyone, to whoever owns the seat at that
moment: `Payroll.claimSeat(tokenId)`, `claimSeats(tokenIds)` (at most 200 ids per call) and
`claimTip(agentId)`. A seat owner should claim before moving a seat into another contract.

## 8. What can go wrong on the day, and what happens then

| Event | What the contracts do |
|---|---|
| Nobody creates a feed | `fund` reverts for that feed, Payroll skips it (`costOf` is zero), the report stays empty. Payroll's feed budget waits 14 to 28 days and then goes to stakers. Nothing is lost. |
| A feed's body is refused by the oracle | Each request costs its meter 0.5 IMD and the round fails. The back-off slows the spending. Funders can take the rest out at any time. Section 5 exists to find this out for 1.5 IMD before launch. |
| The employers feed never answers | The Jobs Report is unaffected. Its meter holds at most 2.2 IMD of Payroll's budget at a time. |
| The Intake's price rises above 2 IMD | Requests stop (`canRequest` says price above the cap) until it falls. Meters stay redeemable. |
| IdentityMD rotates the oracle signer or replaces the Intake | No new answer is accepted. Rounds fail and back off; meters stay redeemable; Payroll's other functions are unaffected. The three contracts must be launched again to resume the feeds. |
| The Intake's callback gas is lowered below what the callback needs | The answer is not stored by the callback. Anyone can hand it in with `submit`. The callback used 116,622 gas at most in our tests, against 200,000 today. |
