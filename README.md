# HELP WANTED

HELP WANTED is a job board on which the employer can be a smart contract.

An employer puts IMD in escrow against a written job. IMD is the token of IdentityMD, a protocol
whose network of AI agents, the swarm, takes paid jobs. When the swarm finishes a job, IdentityMD
writes the hash of the job's work record into a contract of its own on Ethereum, the WorkRegistry.
That entry is the job's receipt. The escrow pays only when the receipt shows the job was done. If
it never does, the employer gets the escrow back.

It has five parts, in ten contracts, deployed in three launches. No contract has an owner, an admin
or a setter, and there is no token of ours.

| Part | What it does | Launch | Live today |
| --- | --- | --- | --- |
| **Standing Questions** | A contract that buys its own oracle answers. IdentityMD's oracle has a panel of its agents answer a question about the chain, and signs the answer. Anyone creates a feed: a question, asked again every so many blocks. Anyone puts IMD on the feed's meter. When the feed is due, the contract pays for the answer from the meter. The signed answer comes back when IdentityMD calls the contract (the callback), or anyone hands it in (`submit`). The contract checks it and stores it. | A | **Yes** |
| **The Robot Jobs Report** | A daily public record of what the swarm was paid: IMD paid and number of payments, each taken from a Standing Question. | A | **Yes** |
| **Payroll** | Splits every IMD it receives by fixed code: half to those who stake IMD in IdentityMD's vault, 30% to the owners of IdentityMD's 2,000 seats (the tokens its agents work under), 20% to keep the report's questions funded. | A | **Yes** |
| **The hire desk** | The job board itself. An employer escrows IMD. A runner, which is anyone who posts a bond, buys the job from the swarm. The escrow pays against the job's receipt. Two employers that are contracts come with it: a crowd pot, and a doorbell anyone can ring until it hires. | B | **Yes**. Its first order was paid on proof on 14 October 2026 |
| **The company** | Rules of the form "when this is true, hire", endowments whose yield pays for a question or a pot, and a way to pay with ETH. | C | **No** |

HELP WANTED is an entry in IdentityMD's builder competition.

## Read this first: what is true on 15 October 2026

- **Launch A is live on Ethereum mainnet** since 13 October 2026. Three contracts, created by
  IdentityMD's launch pipeline in one transaction (IdentityMD launch 1531).
- **The first Robot Jobs Report was printed that day**: 112 IMD paid to the swarm in blocks
  26,176,608 to 26,183,607, and 223 payments counted in blocks 26,176,610 to 26,183,609. The
  week's top employers, the third question, were answered by IdentityMD's own callback.
- **Launch B, the hire desk, is live on Ethereum mainnet since the same day.** Four contracts,
  created in one transaction (IdentityMD launch 1573). The pipeline changed no contract code.
  Launch C has not been launched.
- **The desk's first order was opened by a contract and paid on proof.** The team's own wallet
  rang the Doorbell 25 times, and the 25th ring made the Doorbell, a contract with no owner, open
  order 1: one picture, 1 IMD in escrow
  ([`0xa9c9f256…15fb`](https://etherscan.io/tx/0xa9c9f25681b4512fc51d06cdd17d575e1ef3385d881b9ff62e25447bf8d815fb),
  13 October). The team's runner took it and bought the picture job from the swarm. On
  14 October, a minute after IdentityMD wrote the job's receipt into its WorkRegistry, the runner
  settled the order with the job's work record
  ([`0xa3f5b783…7628`](https://etherscan.io/tx/0xa3f5b783fe194c35f348e411a10f0a199589ea89b668a16d1597794931217628)):
  the desk checked the record against the receipt, then paid the runner 0.9 IMD and its bond,
  Payroll its 0.05 IMD fee, and a 0.05 IMD tip to agent 51519, which drew the picture. Check 6
  below repeats the proof.
- **Nobody outside the team has used the contracts.** Every transaction that touched them after
  the launch was sent by the team's own wallets, apart from one: IdentityMD's Intake delivering an
  oracle answer the team had paid for.

[`EVIDENCE.md`](EVIDENCE.md) is the record of what exists. It is generated from the chain at one
pinned block, by a command you can run. Where this page and that file differ, believe that file.

## Status of each launch

IdentityMD deploys contracts through its launch pipeline: its own agents read the source, may
change it, and create the contracts in one transaction. A launch is that transaction.

| Launch | Contracts | Status | Addresses | Launch transaction | Source | Known limits |
| --- | --- | --- | --- | --- | --- | --- |
| A | `Questions`, `JobsReport`, `Payroll` | **Live** since 13 October 2026. IdentityMD launch 1531. | `Questions` `0xEECE4628ceb091C13393fc64056Be8b8501fD3F6`<br>`JobsReport` `0x58963B57E179f7fE4E95090C21E8e9D75353BCE4`<br>`Payroll` `0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F` | [`0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58`](https://etherscan.io/tx/0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58), block 26,182,869 | [`launches/a-payroll`](launches/a-payroll) | [`launches/a-payroll/docs/THREATS.md`](launches/a-payroll/docs/THREATS.md) |
| B | `WorkProof`, `WorkOrders`, `CrowdPots`, `Doorbell` | **Live** since 13 October 2026. IdentityMD launch 1573. | `WorkProof` `0xB268297dB06985ba0b806Ba97BcB90364b137469`<br>`WorkOrders` `0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2`<br>`CrowdPots` `0x8C2FfCdcb103659aa05c772b8F2059868B496EB5`<br>`Doorbell` `0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb` | [`0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c`](https://etherscan.io/tx/0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c), block 26,184,581 | [`launches/b-desk`](launches/b-desk) | [`launches/b-desk/docs/THREATS.md`](launches/b-desk/docs/THREATS.md) |
| C | `Rules`, `Endowments`, `Zap` | **Not submitted.** It takes addresses that launches A and B created. | None | None | [`launches/c-company`](launches/c-company) | [`launches/c-company/docs/THREATS.md`](launches/c-company/docs/THREATS.md) |

This table is written by hand, and a test fails when it disagrees with the deployments book
(`packages/shared/src/deployments.ts`), the one file where a launch's addresses are recorded. The
generated table, with the code size and code hash at each address, is in
[`EVIDENCE.md`](EVIDENCE.md).

Each launch folder is a Foundry project that stands alone, with its own README, tests and
documents, because the pipeline imports a repository whose root is the project. That is why the
public repository, <https://github.com/OoJae/help-wanted>, also has a branch per launch
(`launch-a`, `launch-b`) that holds one launch folder as its root.

## Check it yourself

Every command below was run on 13 or 15 October 2026 and printed what is shown. They read only.
You need [Foundry](https://getfoundry.sh) (`cast`, `forge`), `curl`, `jq`, `xxd` and `bc`. Check 2
also needs Node 18 or newer; check 7 needs Node 22 and pnpm 11.

```sh
export RPC=https://ethereum-rpc.publicnode.com
```

### 1. The fact the design rests on

keccak256 of a job's work record, exactly as IdentityMD serves it, is what the WorkRegistry holds
for that job. For the real job `e9efec16-56f3-40d3-9243-52c453effc7d`:

```sh
curl -s https://api.imd.fun/work-records/3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5.json -o record.json
cast keccak "0x$(xxd -p record.json | tr -d '\n')"
cast call 0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775 "latest(bytes16)(bytes32)" \
  0xe9efec1656f340d3924352c453effc7d --rpc-url $RPC
```

Both print `0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5`. The job id is the
UUID without its dashes. The same check through this project's own launched `WorkProof`, which
reads the registry itself and answers only for the bytes whose hash the registry holds:

```sh
cast call 0xB268297dB06985ba0b806Ba97BcB90364b137469 \
  "prove(bytes16,bytes,uint256)((bytes32,bytes32,bytes32,bytes32,bytes32,uint256[]))" \
  0xe9efec1656f340d3924352c453effc7d "0x$(xxd -p record.json | tr -d '\n')" 0 --rpc-url $RPC
```

It answers with the record hash first and, last, `[52211]`: the agent the record names as having
done the work. Change one byte of `record.json` and the call reverts.

### 2. Launches A and B are the source in this repository

```sh
bash scripts/repro.sh        # or: pnpm repro
```

It builds each launched project into a temporary folder, fetches the code at each address, sets
the immutable ranges to zero in both (those bytes hold constructor arguments) and compares the rest.
Printed on 13 October 2026, with Foundry 1.8.3:

```text
MATCH      launch A  Questions   0xeece4628ceb091c13393fc64056be8b8501fd3f6  built 22233 bytes, on chain 22233 bytes, 18 immutable ranges (576 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xf876f5265e4ae5015645fbbee2c47e280391c23fc8256b46b688688a388618f7
MATCH      launch A  JobsReport  0x58963b57e179f7fe4e95090c21e8e9d75353bce4  built 9320 bytes, on chain 9320 bytes, 9 immutable ranges (288 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xb050a81690b40963e1cbdffb17aafb3fcdf42ddd432a05023be7e23873207432
MATCH      launch A  Payroll     0x6e4362a5cec59eb3f611af6b2d81915cf5b45f1f  built 11846 bytes, on chain 11846 bytes, 36 immutable ranges (1152 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xa962b0633998d594b2720984ad5f76fce369148592da0762b9d9acf399367236
MATCH      launch B  WorkProof   0xb268297db06985ba0b806ba97bcb90364b137469  built 4579 bytes, on chain 4579 bytes, 2 immutable ranges (64 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0x0a514db427f7f3845166e923929d67816f4a27e661d8ed510b7e910d730e5fba
MATCH      launch B  WorkOrders  0x730cb6c845d896e33283d3a4ed8967f8baa778d2  built 19289 bytes, on chain 19289 bytes, 13 immutable ranges (416 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xb06dfaf6410132828e12647f4ee5199a092f8c0fb9f0c0d2275b5f655262ffb3
MATCH      launch B  CrowdPots   0x8c2ffcdcb103659aa05c772b8f2059868b496eb5  built 14177 bytes, on chain 14177 bytes, 27 immutable ranges (864 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0x282560809f9474cbb416a8d6235fac38fe2679ff3e729a87ff88859006beb1c2
MATCH      launch B  Doorbell    0xfd5ab7e03e8554210faa3ccd3b9d47c622fffccb  built 5972 bytes, on chain 5972 bytes, 40 immutable ranges (1280 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xda26e8196bf95c4117124ef25c308be050bee1823ff5c6ccf287a5d788bfe43c
repro: 7 of 7 launched contracts match the code built from this repository.
```

It exits with a status other than zero when a contract differs. `REPRO_IMMUTABLES=1` also prints
every constructor argument found on chain, to hold against the manifest in each launch's
`docs/LAUNCH.md`. The script needs
Foundry, Node 18 or newer and an RPC, and installs nothing.

### 3. The first Robot Jobs Report, read from the contract and counted again

What the contract holds:

```sh
cast call 0x58963B57E179f7fE4E95090C21E8e9D75353BCE4 \
  "printAt(uint256)((uint256,uint256,uint64,uint64,uint64,uint64))" 0 --rpc-url $RPC
# (112000000000000000000 [1.12e20], 223, 26176608 [2.617e7], 26183607 [2.618e7], 1, 1)
```

That is 112 IMD (18 decimals), 223 payments, and the block window of the amount. The same two
figures, counted by you from the token's own `Transfer` logs to IdentityMD's fee address:

```sh
IMD=0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7
TRANSFER=$(cast keccak "Transfer(address,address,uint256)")
FEE_ADDRESS=0x0000000000000000000000004e0fa57bde726079356537e2f34d671e9f41adbc

# IMD paid in blocks 26,176,608 to 26,183,607. Prints 112.000000000000000000
cast logs --address $IMD --from-block 26176608 --to-block 26183607 $TRANSFER "" $FEE_ADDRESS \
  --rpc-url $RPC --json | jq -r '.[].data' | while read -r d; do cast to-dec "$d"; done \
  | paste -sd+ - | bc | xargs cast from-wei

# Payments in blocks 26,176,610 to 26,183,609. Prints 223
cast logs --address $IMD --from-block 26176610 --to-block 26183609 $TRANSFER "" $FEE_ADDRESS \
  --rpc-url $RPC --json | jq length
```

The two windows differ by two blocks because the amount and the count come from two questions,
asked in two transactions. The public node serves logs for roughly the last 9,000 blocks only.
These blocks pass that age late on 13 October 2026, and from then on the two commands need a node
that keeps history. The contract read above keeps working.

### 4. The oracle's answer was signed for our contract and checked on chain

```sh
curl -s https://api.imd.fun/oracle/requests/f8ffb991-55b7-4316-9461-44a94d5270aa \
  | jq '{status, figure: .attestation.figure, window, signer, consumer}'
cast call 0xEECE4628ceb091C13393fc64056Be8b8501fD3F6 \
  "latest(bytes32)(uint256,uint64,uint64,uint64,uint64)" \
  0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61 --rpc-url $RPC
```

The first shows IdentityMD's record of the oracle request: status `attested`, figure
`112000000000000000000`, the window 26,176,608 to 26,183,607, and `consumer.verifyingContract`
equal to our `Questions` address. The second shows the same figure and window stored in
`Questions`, which accepts an answer only after checking the oracle's signature, the question, the
window and the closing block's hash.

### 5. A real swarm job kept an order's header, and its receipt is on chain

A runner must put 85 bytes, the order's header, at the start of the job's objective, so that the
finished job's record names the order it was done for. One real job was bought that way on
13 October 2026 (job `e70c56ce-60f0-4c2c-b413-67e5ae37ddce`):

```sh
curl -s https://api.imd.fun/work-records/990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d.json -o header.json
cast keccak "0x$(xxd -p header.json | tr -d '\n')"   # 0x990ae775…a17d, the hash it is served under
jq -j .objective header.json | head -c 85            # [help-wanted order de7eddaa…2041] and a space
cast call 0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775 "latest(bytes16)(bytes32)" \
  0xe70c56ce60f04c2cb41367e5ae37ddce --rpc-url $RPC
```

On 13 October 2026 the last command printed 32 zero bytes: IdentityMD's receipt writer had
stalled since about 8 October. It wrote again on 14 October, and on 15 October the command prints
`0x990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d`, the hash the record is
served under. The header in this job named no order (it was bought before the desk was launched);
check 6 is the same proof for a job that did.

### 6. Order 1 was paid on proof

The order on the desk, the job that was bought for it, and the receipt IdentityMD wrote for that
job:

```sh
DESK=0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2
cast call $DESK "headerOf(uint256)(bytes)" 1 --rpc-url $RPC | xargs cast to-utf8
# [help-wanted order bd87367fc83372def576d4f8a370d72e295e10e2572f796ec8f1af720fa36d80] and a space
cast call 0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775 "latest(bytes16)(bytes32)" \
  0xf7bd80ba3e8b483fad026ffbd16fef92 --rpc-url $RPC
# 0x59f81da0ce7cde62693fca46e8dd10411c1dfae52102ffd68d25a66821451b68
curl -s https://api.imd.fun/work-records/59f81da0ce7cde62693fca46e8dd10411c1dfae52102ffd68d25a66821451b68.json -o picture.json
cast keccak "0x$(xxd -p picture.json | tr -d '\n')"   # the same hash
jq -j .objective picture.json | head -c 85            # the same header
jq -r '.kind, .state' picture.json                    # skill:create-image, completed
```

And through the launched `WorkProof`, which reads the registry itself: the record's hash, the hash
of the kind the Doorbell pins, of the header, of the Doorbell's job text, and the agent that did
the work.

```sh
cast call 0xB268297dB06985ba0b806Ba97BcB90364b137469 \
  "prove(bytes16,bytes,uint256)((bytes32,bytes32,bytes32,bytes32,bytes32,uint256[]))" \
  0xf7bd80ba3e8b483fad026ffbd16fef92 "0x$(xxd -p picture.json | tr -d '\n')" 85 --rpc-url $RPC
# (0x59f81da0…1b68, 0x7679ff00…9185, 0x88784319…39c6, 0xc8faed8d…dba6, …, [51519])
```

The order itself is `Delivered` (state 6) and marked proven (the twentieth field of `orderOf`,
`true`), with all of its 1 IMD spent:

```sh
cast call $DESK "accountOf(uint256)(uint8,address,uint96,uint96,uint96)" 1 --rpc-url $RPC
# 6, the Doorbell, 0 left in escrow, 1000000000000000000 spent, 0 returned
```

The picture: <https://explorer.imd.fun/jobs/f7bd80ba-3e8b-483f-ad02-6ffbd16fef92>.

### 7. Everything counted, at one block

```sh
pnpm install
pnpm evidence
```

writes [`EVIDENCE.md`](EVIDENCE.md) and `evidence/evidence.json` again from the chain. It prints
the block it pinned, holds every count against the contracts' own counters at that block, and
writes nothing if a read fails or a count disagrees. It holds no key and sends no transaction.

## What is not shown yet

Stated as plainly as what is.

- **Launch C is not on chain.** `Rules`, `Endowments` and `Zap` are source and tests.
- **One order, and all of it the team's own.** Order 1 was opened by the team's Doorbell after the
  team's own wallet rang it, and taken by the team's runner. No outside employer, runner or ringer
  has used the desk, and no crowd pot has been opened.
- **IdentityMD's receipts stalled for about six days.** The WorkRegistry logged nothing from about
  8 October until 14 October 2026; while that lasted an order that pays only on a receipt could not
  be paid (the limit named W1 in
  [`launches/b-desk/docs/THREATS.md`](launches/b-desk/docs/THREATS.md)). The Doorbell was launched
  during the stall with the desk's other path switched on, for good: a bonded delivery claim paid
  after 24 hours without a challenge, with its own limits (L1, L2 and D2 in the same file). Order 1
  used that path to claim delivery, and was then paid on its receipt instead, which landed first.
- **Nobody outside the team has used anything.** Every transaction that touched launch A's
  contracts after its launch came from the team's wallets. `EVIDENCE.md` has the number and splits
  every count HOUSE and OUTSIDE.
- **Two of the three answers were handed in by the team.** The amount and the count of the first
  report were handed in with `submit` by the team's keeper wallet (the keeper is the bot that makes
  the calls anyone may make), and the contract checked the oracle's signature on each. The third,
  the weekly list of employers, can be answered by the callback only, and was.
- **Payroll has received one fee and one tip, and nothing has been claimed from it.** Order 1's
  0.05 IMD fee was split by the code (half to the stakers' stream, of which a first part has
  reached sIMD, 30% to the seat pool, 20% to the house feeds' meters), and its 0.05 IMD tip is owed
  to agent 51519's seat. No seat owner has claimed yet. `EVIDENCE.md` has every figure.
- **One day of the report exists.** Each feed's first request spent the IMD its meter held, and
  the feed budget has put back 0.01 IMD since. A meter needs 0.55 IMD to ask again.
  `EVIDENCE.md` shows each meter's balance.
- **The source is not verified on a block explorer.** Sourcify answered "no match" for all three
  addresses on 13 October 2026, and IdentityMD's record of the launch holds no verification time.
  Check 2 above is how to compare the code with this source.
- **Launch A was audited before its launch by IdentityMD's audit agents, and the fixes were not
  audited again by a third party.** The pipeline then changed the code once more before deploying
  it. [`launches/a-payroll/docs/AUDITS.md`](launches/a-payroll/docs/AUDITS.md) lists every finding;
  [`launches/a-payroll/ADAPTATION.md`](launches/a-payroll/ADAPTATION.md) lists what the pipeline
  changed. One medium finding is acknowledged and left open
  ([`launches/a-payroll/docs/THREATS.md`](launches/a-payroll/docs/THREATS.md), P2). Launch B was
  read by the pipeline's audit agents and an independent reviewer before it was deployed; no
  contract code was changed, and [`launches/b-desk/ADAPTATION.md`](launches/b-desk/ADAPTATION.md)
  answers each finding. Neither launch has been audited by anyone else, and launch C by nobody.
- **This page names no public address for the site, the indexer or the bots.** Each runs from a
  clone of this repository.

## Trust and known limits

Each launch's `docs/THREATS.md` lists every party the contracts trust and every known limit, and
`docs/DEVIATIONS.md` lists where we depart from IdentityMD's guidance. The ones a reader should
know before anything else:

- **One key signs every oracle answer.** `Questions` accepts what IdentityMD's oracle signer signs,
  and that address is fixed at launch. A wrong or lost key can put wrong numbers into a feed and
  into the report. No function pays out on the content of an answer
  ([`launches/a-payroll/docs/THREATS.md`](launches/a-payroll/docs/THREATS.md), T1).
- **Two of the three feeds are facts the oracle recomputes from the chain. The third rests on a
  panel's agreement** and on nothing else (the same file, F4).
- **A proof says what IdentityMD recorded, not that the work is good.** Whoever controls the
  WorkRegistry's writer can record a hash of its own making, and the registry's source is not
  published ([`launches/b-desk/docs/THREATS.md`](launches/b-desk/docs/THREATS.md), T1, T2 and P1).
- **On the claimed path an untrue delivery claim that nobody challenges within 24 hours is paid**,
  and while receipts are late a challenger can keep a true claim from being paid (the same file,
  L1 and L2). An employer chooses whether its order allows that path.
- **Nothing moves by itself.** Every call that keeps the system going is open to anyone, and
  somebody has to make it. With no keeper, feeds go stale and nothing is lost.

## HOUSE and OUTSIDE

The team publishes every wallet it controls in
[`evidence/house-wallets.json`](evidence/house-wallets.json). Activity of those wallets, and of
HELP WANTED's own contracts, is HOUSE. Everything else is OUTSIDE. Every count we publish is split
that way, a zero is printed as a zero, and house activity is never presented as usage.

The rule is exact, event by event, in `scripts/evidence/contracts.ts`: each event is counted for
one account, and when that account made the call itself the count is HOUSE if the account or the
sender of the transaction is on the list. A transaction sent by IdentityMD's own service accounts
(its Intake's writer delivering an oracle answer, its WorkRegistry's writer) is counted apart from
both: it delivers something that was paid for, and is nobody's use of the contracts.

## Map of the repository

```text
launches/a-payroll/   Launch A, live: Questions, JobsReport, Payroll. A Foundry project.
launches/b-desk/      Launch B, live: WorkProof, WorkOrders, CrowdPots, Doorbell.
launches/c-company/   Launch C, not submitted: Rules, Endowments, Zap.
packages/shared/      TypeScript the rest imports: addresses, the deployments book, ABIs generated
                      from the launch projects' build output, the order header, the work record
                      scanner, the oracle's question hash, a client for IdentityMD's public API.
bots/keeper/          The bot that makes the calls anyone may make: ask a feed, hand an answer in,
                      print the report, return an expired escrow, watch delivery claims.
bots/runner/          The bot that takes an order, buys the swarm job and collects.
apps/indexer/         Copies chain events and public API data into a database; a read-only API.
apps/web/             The site: the receipt checker, the report, the hire desk's pages. Every page
                      also answers as JSON and as Markdown.
scripts/evidence/     The evidence builder (pnpm evidence) and its tests.
scripts/repro.sh      The comparison of deployed code with a build of this source (pnpm repro).
scripts/proof-requests.sh
                      How the three questions of the report were first bought from the live oracle.
evidence/             The house list, the launches requested, and evidence.json (generated).
EVIDENCE.md           Generated. What exists on chain, at one pinned block.
```

Start with the README of the part you care about:
[`launches/a-payroll`](launches/a-payroll/README.md),
[`launches/b-desk`](launches/b-desk/README.md),
[`launches/c-company`](launches/c-company/README.md),
[`bots/keeper`](bots/keeper/README.md), [`bots/runner`](bots/runner/README.md),
[`apps/indexer`](apps/indexer/README.md), [`packages/shared`](packages/shared/README.md).

## Run the tests

The contracts. Foundry is the only requirement, dependencies are vendored, and no network is used:

```sh
(cd launches/a-payroll && forge test)
(cd launches/b-desk && forge test)
(cd launches/c-company && forge test)
```

On 13 October 2026, with Foundry 1.8.3: 515 tests passed in launch A, 673 in launch B and 409 in
launch C, none failed. A first build takes a few minutes. Each project also has a fork suite that
runs against mainnet (`FOUNDRY_PROFILE=fork forge test`); its README says what that suite covers.

Everything in TypeScript. Node 22 or newer and pnpm 11:

```sh
pnpm install
pnpm test          # every package, then the evidence builder
pnpm typecheck
```

On the same day: `packages/shared` 396 tests, `bots/runner` 420, `bots/keeper` 324,
`apps/indexer` 213, `apps/web` 559, the evidence builder 88, none failed. By each package's own
account no test reaches the internet; the tests of the indexer, the site and the evidence builder
make `fetch` throw to be sure. The keeper's integration tests start a local node and are skipped,
with a message, when Foundry is missing or the launch projects are not built.

One part at a time: `pnpm --filter @help-wanted/keeper test` (and `shared`, `runner`, `indexer`,
`web`), or `pnpm evidence:test`.

## Record a launch

When a launch is mined, its transaction, its block and its addresses are written into
`DEPLOYMENT_BOOK` in `packages/shared/src/deployments.ts`. That is the only change needed: the
bots, the indexer, the site, `pnpm evidence` and `pnpm repro` all read the book. Then:

```sh
pnpm repro         # the deployed code is this source
pnpm evidence      # EVIDENCE.md and evidence/evidence.json again
pnpm test          # among others: this page's status table must agree with the book
```

and the row of that launch in the table above is brought up to date by hand.

## Licence

MIT. See [`LICENSE`](LICENSE).
