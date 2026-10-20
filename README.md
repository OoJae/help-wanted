# HELP WANTED

[![CI](https://github.com/OoJae/help-wanted/actions/workflows/ci.yml/badge.svg)](https://github.com/OoJae/help-wanted/actions/workflows/ci.yml)

HELP WANTED is a job board on which the employer can be a smart contract. The employer's IMD stays
in escrow and is paid out on IdentityMD's on-chain receipt for that exact job, or, if the employer
opted in, on a bonded delivery claim that has stood 24 hours with nobody challenging it, or that the
order's arbiter upheld. Otherwise it goes back to the employer.

| 1. A contract escrows                                                                       | 2. A runner buys the job                                                        | 3. The swarm works                 | 4. The WorkRegistry receipt                                                | 5. The desk pays or refunds                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The employer, a contract or a wallet, puts IMD in escrow on the desk against a written job. | A runner posts a bond, takes the order and pays IdentityMD 0.5 IMD for the job. | IdentityMD's AI agents do the job. | IdentityMD writes the hash of the job's work record into its WorkRegistry. | The desk checks the record against that receipt and pays the runner, or refunds the employer. |

That is the proven path. On an order whose employer opted in, a bonded delivery claim that nobody
challenges for 24 hours is paid without waiting for step 4.

- **The hire desk**, `WorkOrders`, on Ethereum mainnet:
  [`0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2`](https://etherscan.io/address/0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2)
- **The site:** <https://web-production-a7c148.up.railway.app>
- **On X:** <https://x.com/HELPWANTED_imd>
- **The source:** <https://github.com/OoJae/help-wanted>

IMD is the token of IdentityMD, a protocol whose network of AI agents, the swarm, takes paid jobs.
When the swarm finishes a job, IdentityMD writes the hash of the job's work record into a contract
of its own on Ethereum, the WorkRegistry. That entry is the job's receipt. The desk pays only on the
receipt for that exact job, or, on an order whose employer opted in, on a bonded claim that nobody
challenged or that the order's arbiter upheld. A receipt pays only if the job's work record names
the order: its objective is the order's header followed by the order's job text.

**What is new here.** A contract can already buy a job from IdentityMD: its Intake contract takes a
contract's request and bills it up front, in the same transaction (IdentityMD's documents, read on
15 October 2026, say jobs have been sold there since 13 October 2026). x402, IdentityMD's other way
to pay, needs an ordinary wallet's signature, and is paid before the work starts too. Neither holds
the IMD back until the work is recorded. HELP WANTED does: it holds the IMD in escrow, pays on
IdentityMD's on-chain receipt for that exact job, and refunds it otherwise (or, where the employer
opted in, pays a bonded claim that nobody challenged or that the order's arbiter upheld). The desk
does not ask how a job was paid for. The team's runner buys each job through IdentityMD's public API
(the action `job.open`, paid by x402), not through the Intake contract.

It has five parts, in ten contracts, in three launches, all three live on Ethereum mainnet. No
contract has an owner, an admin or a setter, and there is no token of ours.

| Part                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Launch | Live today                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Standing Questions**    | A contract that buys its own oracle answers. IdentityMD's oracle has a panel of its agents answer a question about the chain, and signs the answer. Anyone creates a feed: a question, asked again every so many blocks. Anyone puts IMD on the feed's meter. When the feed is due, the contract pays for the answer from the meter. The signed answer comes back when IdentityMD calls the contract (the callback), or anyone hands it in (`submit`). The contract checks it and stores it. | A      | **Yes**                                                                                                                                      |
| **The Robot Jobs Report** | A public record of what the swarm was paid: IMD paid and number of payments, each taken from a Standing Question. One print so far (13 October 2026).                                                                                                                                                                                                                                                                                                                                        | A      | **Yes**                                                                                                                                      |
| **Payroll**               | Splits every IMD it receives by fixed code: half to those who stake IMD in IdentityMD's vault, 30% to the owners of IdentityMD's 2,000 seats (the tokens its agents work under), 20% to keep the report's questions funded.                                                                                                                                                                                                                                                                  | A      | **Yes**                                                                                                                                      |
| **The hire desk**         | The job board itself. An employer escrows IMD. A runner, which is anyone who posts a bond, buys the job from the swarm. The escrow pays against the job's receipt, or, if the employer allows it, against a bonded delivery claim nobody challenges for 24 hours or that the order's arbiter upholds. Two employers that are contracts come with it: a crowd pot, and a doorbell anyone can ring until it hires.                                                                             | B      | **Yes**. Its first order was paid on proof on 14 October 2026, and its second, opened by a rule of launch C, on 16 October 2026              |
| **The company**           | Rules of the form "when this is true, hire", endowments whose yield pays for a question or a pot, and a way to pay with ETH.                                                                                                                                                                                                                                                                                                                                                                 | C      | **Yes**, since 15 October 2026. On 16 October 2026 the team's wallet fired its first rule by hand, and the order it opened was paid on proof |

HELP WANTED is an entry in IdentityMD's builder competition.

## Why pay on proof

Where money waits for work, somebody decides when it moves. On the hire desk that is code: it pays
when the job's work record matches IdentityMD's on-chain receipt and names the order, and it refunds
otherwise. The other rows are what each one's published terms said when read on 20 October 2026
(two figures, marked, are reported by others).

| Where                                  | Who decides payment                                                                           | Until money moves                                                           | Refund                                                    | Source                                                                                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HELP WANTED, receipt path              | Code: `WorkProof` holds the work record against the WorkRegistry receipt and the order header | In the settling transaction; order 2 was paid 8 min 48 s after its rule fired | Yes: after the deadline, anyone may send it back          | Check 7 below                                                                                                                                                                                  |
| Upwork, fixed price                    | The client; silence approves after 14 days; disputes go to Upwork, then paid arbitration      | Up to 14 days of review, then a 5-day hold                                  | Through a dispute                                         | [getting paid](https://support.upwork.com/hc/en-us/articles/211063718-Get-Paid-for-Fixed-Price-Contracts), [disputes](https://support.upwork.com/hc/en-us/articles/14044146250259)                |
| Fiverr                                 | The buyer; the order completes by itself 3 days after delivery                               | 3 days (up to 5 more if extended), then 14 days of clearance                | By cancellation                                           | [order statuses](https://help.fiverr.com/hc/en-us/articles/37552517993105-The-complete-guide-to-your-Fiverr-order-Statuses-and-process), [clearance, reported](https://wise.com/us/blog/how-to-get-paid-on-fiverr) |
| Bountycaster, a bounty board           | Only the poster                                                                               | Whenever the poster pays                                                    | Nothing is held                                           | [FAQ](https://www.bountycaster.xyz/faq)                                                                                                                                                        |
| ERC-8183, and Virtuals ACP v2 on it    | One evaluator named at the start; no dispute step                                             | When the evaluator completes the job                                        | Yes, on rejection or after expiry                         | [EIP-8183](https://eips.ethereum.org/EIPS/eip-8183), [ACP changelog](https://whitepaper.virtuals.io/acp/acp-changelogs)                                                                          |
| x402r, escrow for x402 payments (beta) | An arbiter                                                                                    | After a 14-day timelock, unless released sooner                             | Yes, released by the arbiter                              | [x402r](https://www.x402r.org/), [timelock, reported](https://ethglobal.com/showcase/x402r-and-d-1k9yg)                                                                                          |
| IdentityMD's Intake                    | Nobody after the fact: the fee is taken in the call that opens the job                       | Before the work starts                                                      | "Refunds: None", in its docs                              | [IdentityMD docs](https://imd.fun/docs/llms.txt)                                                                                                                                               |

An order on the desk is in the shape of ERC-8183: the employer is the client, the runner the
provider, the receipt check the evaluator. The difference is that the evaluator is a fixed check of a
receipt IdentityMD wrote, not a party someone names. What the desk proves is delivery, not quality:
it pays a completed job of the order's kind whose work record names the order, and IdentityMD's own
verification of a research report is structural (for order 2's job: "paths and tree verified; no
suite was run for this kind of work"). It is not for work only a person can judge.

## Read this first: what is true on 16 October 2026

- **Launch A is live on Ethereum mainnet** since 13 October 2026. Three contracts, created by
  IdentityMD's launch pipeline in one transaction (IdentityMD launch 1531).
- **The first Robot Jobs Report was printed that day**: 112 IMD paid to the swarm in blocks
  26,176,608 to 26,183,607, and 223 payments counted in blocks 26,176,610 to 26,183,609. The
  week's top employers, the third question, were answered by IdentityMD's own callback.
- **Launch B, the hire desk, is live on Ethereum mainnet since the same day.** Four contracts,
  created in one transaction (IdentityMD launch 1573). The pipeline changed no compiled code: it
  corrected three comments in `CrowdPots.sol`
  ([`launches/b-desk/docs/AUDITS.md`](launches/b-desk/docs/AUDITS.md), row 9).
- **Launch C went live on Ethereum mainnet on 15 October 2026**, at 13:18 UTC. Three contracts,
  created in one transaction (IdentityMD launch 1845, from pipeline job
  `7f2023fc-fa1f-4a7f-a507-3bbc712c51d6`). The pipeline changed no file under `src/`. Its
  reviewers recorded 13 findings, six low and seven info, none marked blocking. No node of the
  pipeline answered ten of them, which come down to four matters not raised before and one that
  [`launches/c-company/ADAPTATION.md`](launches/c-company/ADAPTATION.md) had already answered, and
  the contracts were deployed as they were
  ([`launches/c-company/docs/AUDITS.md`](launches/c-company/docs/AUDITS.md) lists all 13). The
  deployments book (`packages/shared/src/deployments.ts`) holds launch C since the same day, and
  [`EVIDENCE.md`](EVIDENCE.md) counts it.
- **The desk's first order was opened by a contract and paid on proof.** The team's own wallet
  rang the Doorbell 25 times, and the 25th ring made the Doorbell, a contract with no owner, open
  order 1: one picture, 1 IMD in escrow
  ([`0xa9c9f256…15fb`](https://etherscan.io/tx/0xa9c9f25681b4512fc51d06cdd17d575e1ef3385d881b9ff62e25447bf8d815fb),
  13 October). The team's runner took it and paid IdentityMD 0.5 IMD by x402 for the picture job
  ([`0xc92c4731…6bc5`](https://etherscan.io/tx/0xc92c4731e996540cbe68d2e62bc820d67e6bf4d7ec9adc6464b4b0be90e66bc5)).
  On 14 October, a minute after IdentityMD wrote the job's receipt into its WorkRegistry, the
  runner settled the order with the job's work record
  ([`0xa3f5b783…7628`](https://etherscan.io/tx/0xa3f5b783fe194c35f348e411a10f0a199589ea89b668a16d1597794931217628)):
  the desk checked the record against the receipt, then paid the runner 0.9 IMD and its bond, and
  Payroll its 0.05 IMD fee and a 0.05 IMD tip, which Payroll credited to agent 51519, the agent
  the work record names. On 15 October Payroll paid that tip to the owner of the seat the agent is
  bound to. Check 6 below repeats the proof.
- **The desk's second order was opened by a rule and paid on proof, and all of it was the team's.**
  On 16 October 2026 the team's wallet H1 created rule 1 on `Rules`, the first rule of
  [`launches/c-company/docs/LAUNCH.md`](launches/c-company/docs/LAUNCH.md) (section 6): when launch
  A's hires feed reports at least 100, hire a research report that only a receipt can pay. Anyone
  may fire a rule whose condition holds. This time H1 fired it, by hand, with
  `scripts/first-rule.sh`. The fire read the hires feed (223) and opened order 2 on the desk, with
  `Rules` as its employer and 0.60 IMD in escrow
  ([`0x9f790aae…e37b`](https://etherscan.io/tx/0x9f790aae9db07625dc86b6c107d7ed55b43f96ba5bfaf5b02c64269ab963e37b)).
  The team's runner, hosted and running unattended, took it, paid IdentityMD 0.5 IMD by x402 for
  the job, and settled the order on the job's receipt under nine minutes after the fire
  ([`0x35bb49cc…0516`](https://etherscan.io/tx/0x35bb49cc9576a425b94a94137e8fe24e496017cc154456eeee255d22fc020516)).
  The desk paid the runner 0.504045 IMD and its bond, and Payroll a 0.0280025 IMD fee and a
  0.0280025 IMD tip for agent 52142, the agent the work record names. It sent the 0.03995 IMD the
  order did not spend back to `Rules`, which credited it to the rule. H1 then took that back by
  cancelling the rule, and called `claimTip`, which paid the tip to the owner of seat 1978. Check 7
  below repeats the proof. It shows a rule hiring the swarm on mainnet against a real IdentityMD
  receipt. It is not use by anyone outside the team: the rule's creator, the wallet that fired it
  and the runner were all H1.
- **Nobody outside the team has used the contracts.** Every transaction that touched them after
  their launch was sent by the team's own wallets, apart from one: IdentityMD's Intake delivering an
  oracle answer the team had paid for. The contracts have still sent IMD outside the team: to
  IdentityMD's fee address, which every paid request to IdentityMD pays (`Questions` paid it 0.5 IMD
  for each of the three answers it bought); to sIMD, IdentityMD's staking vault; and to two
  wallets: the owner of seat 1049, paid the tip of agent 51519, and, on 16 October, the owner of
  seat 1978, paid the tip of agent 52142, the agent order 2's work record names. Neither owner did
  anything to be paid: a tip goes to the owner of the seat bound to the agent a work record names,
  and receiving one is not use of HELP WANTED. "What is not shown yet", below, has the figures.

[`EVIDENCE.md`](EVIDENCE.md) is the record of what exists. It is generated from the chain at one
pinned block, which it names, by a command you can run, for every launch the deployments book
holds; check 8 below says when it was last run. Where this page and that file differ about what
existed at that block, believe that file. What happened after that block is not in it until the
command is run again.

## Status of each launch

IdentityMD deploys contracts through its launch pipeline: its own agents read the source, may
change it, and create the contracts in one transaction. A launch is that transaction.

<!-- prettier-ignore -->
| Launch | Contracts | Status | Addresses | Launch transaction | Source | Known limits |
| --- | --- | --- | --- | --- | --- | --- |
| A | `Questions`, `JobsReport`, `Payroll` | **Live** since 13 October 2026. IdentityMD launch 1531. | `Questions` `0xEECE4628ceb091C13393fc64056Be8b8501fD3F6`<br>`JobsReport` `0x58963B57E179f7fE4E95090C21E8e9D75353BCE4`<br>`Payroll` `0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F` | [`0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58`](https://etherscan.io/tx/0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58), block 26,182,869 | [`launches/a-payroll`](launches/a-payroll) | [`launches/a-payroll/docs/THREATS.md`](launches/a-payroll/docs/THREATS.md) |
| B | `WorkProof`, `WorkOrders`, `CrowdPots`, `Doorbell` | **Live** since 13 October 2026. IdentityMD launch 1573. | `WorkProof` `0xB268297dB06985ba0b806Ba97BcB90364b137469`<br>`WorkOrders` `0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2`<br>`CrowdPots` `0x8C2FfCdcb103659aa05c772b8F2059868B496EB5`<br>`Doorbell` `0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb` | [`0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c`](https://etherscan.io/tx/0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c), block 26,184,581 | [`launches/b-desk`](launches/b-desk) | [`launches/b-desk/docs/THREATS.md`](launches/b-desk/docs/THREATS.md) |
| C | `Rules`, `Endowments`, `Zap` | **Live** since 15 October 2026. IdentityMD launch 1845. It takes addresses that launches A and B created. | `Rules` `0xcbF0dddF07C00a78E2E7561a6F47C275B8c05D7E`<br>`Endowments` `0xbE916A53b9Bbe634AF7E10E604E06b6069edEE76`<br>`Zap` `0x51bF8c74bd9BD74Ad08cABDC90DaC7835C18B21A` | [`0x1806c02e5e38d4c8496476b3f3cf39f250a9d0c97ff5834c75a0475a12bd62fb`](https://etherscan.io/tx/0x1806c02e5e38d4c8496476b3f3cf39f250a9d0c97ff5834c75a0475a12bd62fb), block 26,198,165 | [`launches/c-company`](launches/c-company) | [`launches/c-company/docs/THREATS.md`](launches/c-company/docs/THREATS.md) |

This table is written by hand, and a test fails when it disagrees with the deployments book
(`packages/shared/src/deployments.ts`), the one file where a launch's addresses are recorded. The
generated table, with the code size and code hash at each address, is in
[`EVIDENCE.md`](EVIDENCE.md).

Each launch folder is a Foundry project that stands alone, with its own README, tests and
documents, because the pipeline imports a repository whose root is the project. That is why the
public repository, <https://github.com/OoJae/help-wanted>, also has a branch per launch
(`launch-a`, `launch-b`, `launch-c`) that holds one launch folder as its root.

## Check it yourself

Every command below was run on 13, 15 or 16 October 2026 and printed what is shown. They read
only. You need [Foundry](https://getfoundry.sh) (`cast`, `forge`), `curl`, `jq`, `xxd` and `bc`.
Check 2 also needs Node 18 or newer; check 8 needs Node 22 and pnpm 11.

```sh
export RPC=https://ethereum-rpc.publicnode.com
export LOGS_RPC=https://rpc.mevblocker.io   # for old logs: the first node keeps about 9,000 blocks
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

### 2. The launched code is the source in this repository

```sh
bash scripts/repro.sh        # or: pnpm repro
```

It builds each launched project into a temporary folder, fetches the code at each address, sets
the immutable ranges to zero in both (those bytes hold constructor arguments) and compares the rest.
Printed on 15 October 2026, with Foundry 1.8.3:

```text
MATCH      launch A  Questions   0xeece4628ceb091c13393fc64056be8b8501fd3f6  built 22233 bytes, on chain 22233 bytes, 18 immutable ranges (576 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xf876f5265e4ae5015645fbbee2c47e280391c23fc8256b46b688688a388618f7
MATCH      launch A  JobsReport  0x58963b57e179f7fe4e95090c21e8e9d75353bce4  built 9320 bytes, on chain 9320 bytes, 9 immutable ranges (288 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xb050a81690b40963e1cbdffb17aafb3fcdf42ddd432a05023be7e23873207432
MATCH      launch A  Payroll     0x6e4362a5cec59eb3f611af6b2d81915cf5b45f1f  built 11846 bytes, on chain 11846 bytes, 36 immutable ranges (1152 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xa962b0633998d594b2720984ad5f76fce369148592da0762b9d9acf399367236
MATCH      launch B  WorkProof   0xb268297db06985ba0b806ba97bcb90364b137469  built 4579 bytes, on chain 4579 bytes, 2 immutable ranges (64 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0x0a514db427f7f3845166e923929d67816f4a27e661d8ed510b7e910d730e5fba
MATCH      launch B  WorkOrders  0x730cb6c845d896e33283d3a4ed8967f8baa778d2  built 19289 bytes, on chain 19289 bytes, 13 immutable ranges (416 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xb06dfaf6410132828e12647f4ee5199a092f8c0fb9f0c0d2275b5f655262ffb3
MATCH      launch B  CrowdPots   0x8c2ffcdcb103659aa05c772b8f2059868b496eb5  built 14177 bytes, on chain 14177 bytes, 27 immutable ranges (864 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0x282560809f9474cbb416a8d6235fac38fe2679ff3e729a87ff88859006beb1c2
MATCH      launch B  Doorbell    0xfd5ab7e03e8554210faa3ccd3b9d47c622fffccb  built 5972 bytes, on chain 5972 bytes, 40 immutable ranges (1280 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xda26e8196bf95c4117124ef25c308be050bee1823ff5c6ccf287a5d788bfe43c
MATCH      launch C  Rules       0xcbf0dddf07c00a78e2e7561a6f47c275b8c05d7e  built 13762 bytes, on chain 13762 bytes, 25 immutable ranges (800 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xec51b0077f235e771b3309380d222b726b50632d97c99179a4f22af356089ff9
MATCH      launch C  Endowments  0xbe916a53b9bbe634af7e10e604e06b6069edee76  built 13161 bytes, on chain 13161 bytes, 37 immutable ranges (1184 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0xa87d11ad30a06bec5aa1293e7f7f4bfb6f0c84930057a5b9dc3e2253cc78cdbc
MATCH      launch C  Zap         0x51bf8c74bd9bd74ad08cabdc90dac7835c18b21a  built 3834 bytes, on chain 3834 bytes, 14 immutable ranges (448 bytes) set to zero in both: equal outside the immutable ranges. keccak256 of the on-chain code: 0x76271cf45487ed5b6b74adb4f0048a0918ce073bbbd3fac18e4bf26759fef63f
repro: 10 of 10 launched contracts match the code built from this repository.
```

It exits with a status other than zero when a contract differs or cannot be read, and when the
deployments book gives it no contract to compare. `REPRO_IMMUTABLES=1` also prints every
constructor argument found on chain, to hold against the manifest in each launch's
`docs/LAUNCH.md`. The script needs Foundry, Node 18 or newer and an RPC, and installs nothing.

What the explorers say of launches A and B, read on 15 October 2026. Etherscan shows each of the
seven contracts as "Source Code Verified", "Exact Match", under its own name, compiled with solc
0.8.26 and 200 optimizer runs. Sourcify holds a match for `CrowdPots` only (creation and runtime
code, verified on 13 October 2026 at 17:48 UTC) and none for the other six. IdentityMD's own record
of launches A and B gives each of their contracts a `verifiedAt` time on 13 October 2026, within
three minutes of its launch; [`EVIDENCE.md`](EVIDENCE.md) prints them. None of this is needed for
the comparison above, which holds whatever an explorer shows.

What the explorers say of launch C, read on 15 October 2026 at about 16:00 UTC. Etherscan shows
`Rules`, `Endowments` and `Zap` each as "Source Code Verified", "Exact Match", under its own name,
compiled with solc 0.8.26 and 200 optimizer runs. Sourcify holds a match (creation and runtime
code) for `Endowments` and `Zap`, verified on 15 October 2026 at 15:01 UTC, and for `Rules` it
answers with no match at all (HTTP 404). IdentityMD's record of launch 1845 gives the three
`verifiedAt` times from 13:21:19 to 13:21:35 UTC that day, under three minutes after the launch;
[`EVIDENCE.md`](EVIDENCE.md) prints them.

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
  --rpc-url $LOGS_RPC --json | jq -r '.[].data' | while read -r d; do cast to-dec "$d"; done \
  | paste -sd+ - | bc | xargs cast from-wei

# Payments in blocks 26,176,610 to 26,183,609. Prints 223
cast logs --address $IMD --from-block 26176610 --to-block 26183609 $TRANSFER "" $FEE_ADDRESS \
  --rpc-url $LOGS_RPC --json | jq length
```

The two windows differ by two blocks because the amount and the count come from two questions,
asked in two transactions. These logs are older than the roughly 9,000 blocks
`ethereum-rpc.publicnode.com` serves, and on 15 October 2026 it refused them ("Archive requests
require a personal token"), so the two commands read them from `$LOGS_RPC`. On that day
`rpc.mevblocker.io` answered each in one query, and the two commands printed
`112.000000000000000000` and `223`. Any node that keeps history will do. The contract read above
works on either node.

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
stalled since about 8 October. It wrote again from 13 October at 17:26 UTC (block 26,185,055),
working through its backlog first, and this job's receipt landed on 14 October (block 26,189,975).
On 15 October the command prints
`0x990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d`, the hash the record is
served under. The header in this job named no order (it was bought before the desk was launched);
check 6 is the same proof for a job that did.

### 6. Order 1 was paid on proof

The runner bought the job by x402: IdentityMD's fee address sent the settlement through x402's
contract, and it moved 0.5 IMD from the runner's wallet to that address
([`0xc92c4731…6bc5`](https://etherscan.io/tx/0xc92c4731e996540cbe68d2e62bc820d67e6bf4d7ec9adc6464b4b0be90e66bc5),
block 26,185,015). IdentityMD names the same wallet as the payer of the job:

```sh
curl -s https://api.imd.fun/jobs/f7bd80ba-3e8b-483f-ad02-6ffbd16fef92 | jq '{state, template, paidBy}'
# completed, skill:create-image, paid by 0x60cc…9560 (H1, the runner's wallet)
```

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
of the kind the Doorbell pins, of the header, of the Doorbell's job text, and the agent the record
names.

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

[See the picture the Doorbell paid for](https://explorer.imd.fun/jobs/f7bd80ba-3e8b-483f-ad02-6ffbd16fef92)
(IdentityMD's explorer, job `f7bd80ba-3e8b-483f-ad02-6ffbd16fef92`).

### 7. Order 2 was opened by a rule and paid on proof

The team's wallet H1 created rule 1 on `Rules`
([`0x8c69fca9…548b`](https://etherscan.io/tx/0x8c69fca9fcdd1893181832d708cfbf69fb7227c127206c4bcdd00bc0028e548b),
block 26,204,482) and fired it by hand with `scripts/first-rule.sh`
([`0x9f790aae…e37b`](https://etherscan.io/tx/0x9f790aae9db07625dc86b6c107d7ed55b43f96ba5bfaf5b02c64269ab963e37b),
block 26,204,499, 10:28 UTC). The fire read launch A's hires feed (223, at least 100) and opened
order 2 on the desk with `Rules` as the employer. Anyone may fire a rule whose condition holds;
this time the team's own wallet did, and the rule's 0.01 IMD tip went back to it.

The team's runner, which signs as H1, claimed the order at 0.56005 IMD
([`0x27fc5a9f…0cb1`](https://etherscan.io/tx/0x27fc5a9fa12302a79d9f8b97fa82a541c9ab01ba07e78c2980d86db2c9b20cb1),
block 26,204,508) and bought the job by x402: IdentityMD's fee address sent the settlement through
x402's contract, which moved 0.5 IMD from the runner's wallet to that address
([`0x2fc7fa99…ca70`](https://etherscan.io/tx/0x2fc7fa990bb74b015cff16c5c69e8d97eccdad38c79307c8b1a02bfbcea3ca70),
block 26,204,514). IdentityMD's writer wrote the job's receipt
([`0x3a604fc1…5abf`](https://etherscan.io/tx/0x3a604fc1d0a83a25d0f8b89142007d665557ca6bb7ee2ff80ddaca67eadb5abf),
block 26,204,533), two blocks before the runner registered the job
([`0x20ef3770…4467`](https://etherscan.io/tx/0x20ef3770d86475c944ce46a42fce15234549e53c17245f29759ca3c3dfe54467),
block 26,204,535). The runner settled the order on that receipt
([`0x35bb49cc…0516`](https://etherscan.io/tx/0x35bb49cc9576a425b94a94137e8fe24e496017cc154456eeee255d22fc020516),
block 26,204,543, 10:37 UTC), 44 blocks and under nine minutes after the fire. IdentityMD names the
same wallet as the payer of the job:

```sh
curl -s https://api.imd.fun/jobs/42f26c64-eea9-46f2-822a-33547ec18abf | jq '{state, template, paidBy}'
# completed, skill:research-report, paid by 0x60cc…9560 (H1, the runner's wallet)
```

The order on the desk, the job that was bought for it, and the receipt IdentityMD wrote for that
job:

```sh
cast call $DESK "headerOf(uint256)(bytes)" 2 --rpc-url $RPC | xargs cast to-utf8
# [help-wanted order bd623ece89b1c600768011d08b9f77f00f169c6b6f31d2e3c37d61515189c407] and a space
cast call 0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775 "latest(bytes16)(bytes32)" \
  0x42f26c64eea946f2822a33547ec18abf --rpc-url $RPC
# 0xf6d0bd11b43fc36a3720db09a65612a03a4be7b5b12476bcdace4d1383176a85
curl -s https://api.imd.fun/work-records/f6d0bd11b43fc36a3720db09a65612a03a4be7b5b12476bcdace4d1383176a85.json -o report.json
cast keccak "0x$(xxd -p report.json | tr -d '\n')"   # the same hash (the record is 3,801 bytes)
jq -j .objective report.json | head -c 85            # the same header
jq -r '.kind, .state' report.json                    # skill:research-report, completed
```

And through the launched `WorkProof`: the record's hash, the hash of the kind the rule pins, of the
header, of the rule's job text, and the agent the record names.

```sh
cast call 0xB268297dB06985ba0b806Ba97BcB90364b137469 \
  "prove(bytes16,bytes,uint256)((bytes32,bytes32,bytes32,bytes32,bytes32,uint256[]))" \
  0x42f26c64eea946f2822a33547ec18abf "0x$(xxd -p report.json | tr -d '\n')" 85 --rpc-url $RPC
# (0xf6d0bd11…6a85, 0x1eca7729…988b, 0x390b14f4…3f8f, 0xc6413a52…31e2, …, [52142])
```

The order is `Delivered` (state 6) and marked proven, with 0.56005 IMD spent and the 0.03995 IMD
it did not spend returned to `Rules`. The settlement's `Delivered` event gives the split:

```sh
cast call $DESK "stateOf(uint256)(uint8)" 2 --rpc-url $RPC
# 6
cast call $DESK "accountOf(uint256)(uint8,address,uint96,uint96,uint96)" 2 --rpc-url $RPC
# 6, Rules, 0 left in escrow, 560050000000000000 spent, 39950000000000000 returned
cast logs --address $DESK --from-block 26204543 --to-block 26204543 \
  "Delivered(uint256 indexed,bytes16 indexed,address indexed,bytes32,bool,uint256,uint256,uint256,uint256,uint256,uint256[])" 2 \
  --rpc-url $LOGS_RPC --json | jq -r '.[0].data' \
  | xargs cast decode-abi --input "x(bytes32,bool,uint256,uint256,uint256,uint256,uint256,uint256[])"
# the record hash; true (proven); 504045000000000000 to the runner; 28002500000000000 fee and
# 28002500000000000 tip to Payroll; 39950000000000000 back to Rules; 250000000000000000, the bond,
# back to the runner; [52142]
```

`Rules` received the 0.03995 IMD inside the settlement, through the desk's callback, and credited
it to rule 1. H1 cancelled the rule, which had used its one fire, and took that amount back
([`0x9c062d89…6846`](https://etherscan.io/tx/0x9c062d891f69d829be26a31cbc8cd7ed7a55bdfae3f3f0fcd7d2853ec3cb6846),
block 26,204,586). H1 then called `claimTip(52142)`, and Payroll paid the 0.0280025 IMD tip to the
owner of seat 1978, the seat agent 52142 is bound to, a wallet outside the team that did nothing to
be paid
([`0xd7a75e9c…f273`](https://etherscan.io/tx/0xd7a75e9c71968ba67badb671c96103a55364d78b563e6b6561a08b98603f6273),
block 26,204,587). The whole hire cost the team 0.556005 IMD and gas: IdentityMD's 0.5 IMD job fee,
and the fee and the tip paid to Payroll (H1 held 1.4 IMD before block 26,204,480 and 0.843995 IMD
after block 26,204,587).

The report counts the payments of IdentityMD's job fee in blocks 26,197,518 to 26,204,517: 220
transfers of 0.5 IMD to the fee address, 110 IMD in all, from 52 wallets, one row per wallet, each
row linking one of that wallet's transactions. We counted the same logs again (with `$IMD`,
`$TRANSFER` and `$FEE_ADDRESS` from check 3) and got the same figures. Among them are the team's
own payment for this job and one by the team's wallet W1.

```sh
cast logs --address $IMD --from-block 26197518 --to-block 26204517 $TRANSFER "" $FEE_ADDRESS \
  --rpc-url $LOGS_RPC --json | jq '[length, ([.[].topics[1]] | unique | length), ([.[].data] | unique | length)]'
# [220, 52, 1]: 220 transfers, 52 senders, one amount (0.5 IMD)
```

[See the report the rule paid for](https://api.imd.fun/artifacts/4dcebdb382dd91a82e53a629dc7620f811feb6146e011d3a6e799fdf7c6482f0)
(`report.md`, 10,523 bytes, served by IdentityMD's API; IdentityMD's explorer has the job at
<https://explorer.imd.fun/jobs/42f26c64-eea9-46f2-822a-33547ec18abf>).

### 8. Everything counted, at one block

```sh
pnpm install
pnpm evidence
```

writes [`EVIDENCE.md`](EVIDENCE.md) and `evidence/evidence.json` again from the chain. It prints
the block it pinned, holds every count against the contracts' own counters at that block, and
writes nothing if a read fails or a count disagrees. It holds no key and sends no transaction. With
no setting it reads from `https://ethereum-rpc.publicnode.com,https://rpc.mevblocker.io`, and asks
the first node for each range of blocks before the second. The first serves logs for about the last
9,000 blocks only, so older logs, such as the early logs of launches A and B, come from the second.
Run this way on 20 October 2026, it pinned block 26,234,773, read logs in ranges of 2,000 blocks and
found all 56 of its checks against the contracts in agreement. `RPC_URL` (one URL, or several
separated by commas) and `CHUNK_SIZE` change that.

## What is not shown yet

Stated as plainly as what is.

- **Launch C went live on 15 October 2026, at 13:18 UTC.** By block 26,198,957 every event its
  contracts had emitted came from four calls of the team's wallet W1 to `Endowments`: creating an
  endowment for the meter of the payrolls feed, staking, depositing 1 IMD and staking again. No
  rule had been created then, and nothing had gone through `Zap`. On 16 October 2026 the team's
  wallet H1 created the first rule (rule 1), fired it by hand, and cancelled it once its one fire
  was used and its order paid (check 7); that day `ruleCount()` read 1, and nothing had yet gone
  through `Zap`.
- **The endowment's principal came back to the wei; its yield was never enough to harvest.** On
  19 October 2026 W1 called `withdraw(1, 1 IMD)` and received exactly 1 IMD
  ([`0xcb48313a…024e`](https://etherscan.io/tx/0xcb48313ac8f8ac053fb6f1316dd8359795720441809c8d2503773612ba47024e),
  block 26,226,427): `Withdrawn(1, W1, principal 1 IMD, imdOut 1 IMD, sharesOut 0)`, and
  `principalOf(1, W1)` reads 0. Nothing was harvested. `harvest` runs only for `MIN_HARVEST`
  (0.001 IMD) or more, and `harvestable(1)` read 0 from the deposit to the withdrawal: sIMD's price
  (`convertToAssets`) did not move at all from block 26,198,165 (15 October) to block 26,226,427,
  so the staked IMD earned nothing in that time. The 0.000001 IMD seed paid to create the
  endowment is not refundable and stays in it. So the drill shows a deposit staked into IdentityMD's
  vault and taken back in full, not yield paying for a question.
- **Two orders, and all of them the team's own.** Order 1 was opened by the team's Doorbell after
  the team's own wallet rang it. Order 2 was opened by rule 1 on `Rules`, which the team's wallet
  H1 created and fired. The team's runner took both. No outside employer, runner, ringer or rule
  creator has used the desk, and no crowd pot has been opened.
- **IdentityMD's receipts stalled for about six days.** The WorkRegistry wrote no receipt from
  about 8 October until 13 October 2026, 17:26 UTC (block 26,185,055). It then worked through its
  backlog, and the receipts of jobs bought on 13 October, order 1's among them, landed on
  14 October. While receipts were stalled an order that pays only on a receipt could not be paid
  (the limit named W1 in
  [`launches/b-desk/docs/THREATS.md`](launches/b-desk/docs/THREATS.md)). The Doorbell was launched
  during the stall with the desk's other path switched on, for good: a bonded delivery claim paid
  after 24 hours without a challenge, with its own limits (L1, L2 and D2 in the same file). Order 1
  used that path to claim delivery, and was then paid on its receipt instead, which landed first.
  The writer has kept writing since. On 16 October it wrote the receipt of order 2's job 16
  seconds after IdentityMD listed the job as completed (10:35:18.756 UTC; block 26,204,533 at
  10:35:35 UTC), two blocks before the runner registered the job. Order 2 pays only on a receipt,
  and was paid on that one.
- **Nobody outside the team has used anything.** Every transaction that touched the contracts
  after their launch came from the team's wallets, apart from the Intake's one delivery.
  `EVIDENCE.md` has the number and splits every count HOUSE and OUTSIDE. By block 26,198,957 the
  contracts had sent IMD outside the team to three places. IdentityMD's fee address: `Questions`
  pays it 0.5 IMD each time it asks the oracle for an answer, three times by then. sIMD,
  IdentityMD's staking vault: it received Payroll's 14 drips to the stakers, about 0.0021 IMD in
  all, and the team's 1.000001 IMD that `Endowments` staked (an endowment's seed and a deposit of
  1 IMD). And one wallet: the owner of the seat agent 51519 is bound to, paid its tip by the team's
  own call (the point on Payroll below). On 16 October a second wallet was paid the same way: the
  owner of seat 1978, which agent 52142 is bound to, was paid order 2's tip when the team's wallet
  H1 called `claimTip`. Each payment goes to the owner of the seat bound to the agent a work record
  names. Neither owner used HELP WANTED.
- **Two of the three answers were handed in by the team.** The amount and the count of the first
  report were handed in with `submit` by the team's keeper wallet (the keeper is the bot that makes
  the calls anyone may make), and the contract checked the oracle's signature on each. The third,
  the weekly list of employers, can be answered by the callback only, and was.
- **Payroll has received two fees and two tips.** Order 1's 0.05 IMD fee was split by the code
  (half to the stakers' stream, of which a first part has reached sIMD, 30% to the seat pool, 20%
  to the house feeds' meters); no seat owner has claimed a share of the seat pool yet. Its
  0.05 IMD tip was credited to agent 51519. On 15 October 2026 the team's wallet W1 called
  `claimTip` for that agent, which anyone may do when the seat is held by an ordinary wallet, and
  Payroll paid the tip to the owner of seat 1049, the seat the agent is bound to
  ([`0x9edc8ba2…1fe8`](https://etherscan.io/tx/0x9edc8ba2ae4cfbabe95d6ca11e7a93f349f09729b7a699d575eac6f8466e1fe8)).
  Order 2's fee and tip, 0.0280025 IMD each, came on 16 October, and the fee was split the same
  way. The tip was credited to agent 52142. The team's wallet H1 called `claimTip(52142)`, and
  Payroll paid it to the owner of seat 1978
  ([`0xd7a75e9c…f273`](https://etherscan.io/tx/0xd7a75e9c71968ba67badb671c96103a55364d78b563e6b6561a08b98603f6273)).
  `EVIDENCE.md` has every figure up to the block it pins.
- **One day of the report exists.** Each feed's first request spent the IMD its meter held, and
  the feed budget has put back 0.01 IMD since. A meter needs 0.55 IMD to ask again.
  `EVIDENCE.md` shows each meter's balance.
- **The code was reviewed before each launch by the team and by IdentityMD's agents, and audited
  by nobody outside IdentityMD's network.** Launch A was audited first by two audit jobs bought
  from IdentityMD's network, and the team fixed or answered each finding. IdentityMD's launch
  pipeline then read the code with those fixes (`audit_imported_code`), changed it in answer to
  that review, and had four specialist agents and a judge read the code as adapted, all before it
  deployed the code on 13 October 2026. The launch's pull request says "An independent reviewer
  raised 8 finding(s).", and IdentityMD's record of the job holds those 8, none marked blocking.
  [`launches/a-payroll/ADAPTATION.md`](launches/a-payroll/ADAPTATION.md) answers the four of the
  imported review and lists what the pipeline changed;
  [`launches/a-payroll/docs/AUDITS.md`](launches/a-payroll/docs/AUDITS.md) lists every finding of
  the two audits and the pipeline's 8, with what became of each. One medium finding of the audits is
  acknowledged and left open
  ([`launches/a-payroll/docs/THREATS.md`](launches/a-payroll/docs/THREATS.md), P2). Launch B was
  read by the pipeline's audit agents and an independent reviewer before it was deployed, and no
  compiled code changed: the pipeline corrected three comments in `CrowdPots.sol`. Its pull request
  says 11 findings. [`launches/b-desk/ADAPTATION.md`](launches/b-desk/ADAPTATION.md) answers seven
  of them by name, and the other four through the judge's findings they were merged into, as
  [`launches/b-desk/docs/AUDITS.md`](launches/b-desk/docs/AUDITS.md) sets out; that file also names
  a file of answers the team never received. Launch C was read by the pipeline before its launch on
  15 October 2026. Its pull request says "An independent reviewer raised 13 finding(s).", and
  IdentityMD's record of the job holds 13 in its accepted reviews, six low and seven info, none
  marked blocking. [`launches/c-company/ADAPTATION.md`](launches/c-company/ADAPTATION.md) answers
  the three of the imported review. No node answered the other ten, which came after the code was
  adapted. They come down to four matters not raised before, each recorded by a specialist and
  again by the judge, and one finding of the imported review recorded twice more. The pipeline
  changed no file under `src/`.
  [`launches/c-company/docs/AUDITS.md`](launches/c-company/docs/AUDITS.md) lists all 13 with what
  became of each; the four new matters (its rows 4 to 7) are limits that
  [`launches/c-company/docs/THREATS.md`](launches/c-company/docs/THREATS.md) states since
  15 October 2026 (R11, E7, E9 and Z4). A test of launch C's suite shows each of the four, three of
  them in tests added on 15 October 2026. Nobody outside IdentityMD's network has audited any of
  the three launches, and IdentityMD records no outside audit or bounty for any of them.
- **One runner has taken two orders.** The team's runner took orders 1 and 2, and no other runner
  has claimed an order on the desk. Since 15 October 2026, 14:18 UTC, the team's runner has run around
  the clock on a hosted server (Railway), signing as H1. It takes orders from any employer, one
  order at a time, pays at most one 0.5 IMD swarm fee a day, posts bonds of at most 0.25 IMD, and
  takes research-report and picture jobs ([`bots/runner/README.md`](bots/runner/README.md)). Its
  list of employers (`EMPLOYERS`) is empty on purpose: the desk is for employers the team does not
  know, and while no other runner exists a list would leave their orders untaken. Those caps bound
  what serving anyone can cost it, for as long as it runs: at most 0.5 IMD in swarm fees a day,
  and at most 0.25 IMD in bonds at any one time, which it can lose order by order, plus gas. On
  15 October 2026 the team also set it to take an order that leaves it no margin
  (`MIN_MARGIN_IMD=0`, `EXPECTED_FAILURE_BPS=0`), so that it could serve the first order that a
  rule of the team's, in launch C, opened on the desk. It did. On 16 October 2026, running
  unattended, it took order 2, paid IdentityMD's 0.5 IMD job fee and settled the order on its
  receipt. It was paid 0.504045 IMD and its bond back, about 0.004 IMD more than the fee, before
  gas. Two orders have been opened on the desk, both by the team. The keeper is not hosted: the team runs it by hand. The site is public (its
  address is at the top of this page); this page names no public address for the indexer or the
  bots.

## Trust and known limits

Each launch's `docs/THREATS.md` lists every party the contracts trust and every known limit, and
`docs/DEVIATIONS.md` lists where we depart from IdentityMD's guidance. The ones a reader should
know before anything else:

- **One key signs every oracle answer.** `Questions` accepts what IdentityMD's oracle signer signs,
  and that address is fixed at launch. A wrong or lost key can put wrong numbers into a feed and
  into the report. What an answer can move differs by launch. In launch A no function pays out on
  the content of an answer; the only money tied to an answer is its round's keeper tip
  ([`launches/a-payroll/docs/THREATS.md`](launches/a-payroll/docs/THREATS.md), T1). In launch B an
  order's condition may read an answer, and a true reading only opens the order to runners; the
  escrow still pays a runner only on the job's receipt or, where the order allows it, on a bonded
  claim that nobody challenged or that the order's arbiter upheld
  ([`launches/b-desk/docs/THREATS.md`](launches/b-desk/docs/THREATS.md), T6 and W8). In launch C a
  FEED rule fires on a feed's answer, and the fire pays: the rule's recipient for a PAY rule, an
  escrow on the desk for a HIRE rule, and the rule's tip to whoever fires it
  ([`launches/c-company/docs/THREATS.md`](launches/c-company/docs/THREATS.md), T5, R2 and R3).
- **Two of the three feeds are facts the oracle recomputes from the chain. The third rests on a
  panel's agreement** and on nothing else
  ([`launches/a-payroll/docs/THREATS.md`](launches/a-payroll/docs/THREATS.md), F4).
- **A proof says what IdentityMD recorded, not that the work is good.** Whoever controls the
  WorkRegistry's writer can record a hash of its own making, and the registry's source is not
  published ([`launches/b-desk/docs/THREATS.md`](launches/b-desk/docs/THREATS.md), T1, T2 and P1).
- **IMD's owner can have new IMD created on Ethereum.** IMD here is a LayerZero bridged token, not a
  proxy. Its owner, `0x047F…54B7`, the same account as the WorkRegistry's admin, chooses which
  contracts on other chains may send IMD here and how their messages are checked, so it can have
  IMD created on Ethereum through a contract of its choosing. New IMD takes nothing from what the
  contracts hold, but changes what it is worth, and the token gives its owner no function that
  moves, burns or freezes IMD an address holds
  ([`launches/a-payroll/docs/THREATS.md`](launches/a-payroll/docs/THREATS.md), T4,
  [`launches/b-desk/docs/THREATS.md`](launches/b-desk/docs/THREATS.md), T4, and
  [`launches/c-company/docs/THREATS.md`](launches/c-company/docs/THREATS.md), T1).
- **On the claimed path an untrue delivery claim that nobody challenges within 24 hours is paid**,
  and while receipts are late a challenger can keep a true claim from being paid (the same file,
  L1 and L2). An employer chooses whether its order allows that path.
- **Nothing moves by itself.** Every call that keeps the system going is open to anyone, and
  somebody has to make it. With no keeper, feeds go stale and nothing is lost, except on the
  claimed path: there, an untrue delivery claim that nobody challenges within 24 hours is paid.
  **No watcher is running.** On 15 October 2026 the team's keeper, the bot that can challenge such
  a claim, is not hosted: the team runs it by hand and has no other watcher, and we know of nobody
  else who watches the Doorbell's orders, which are all on the claimed path. At block 26,200,224
  that day the Doorbell held no IMD, so it could open no order until somebody funds it
  ([`launches/b-desk/docs/THREATS.md`](launches/b-desk/docs/THREATS.md), D2).

To report a problem privately, read [`SECURITY.md`](SECURITY.md). There is no bounty.

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

## Use it from an AI agent

The site is also a remote MCP server, with no key and no account, at
<https://web-production-a7c148.up.railway.app/mcp>. Its tools read the desk, quote an order, plan
one and check any swarm job's receipt: `desk_status`, `list_orders`, `get_order`, `list_templates`,
`quote_order`, `plan_order`, `plan_ring_doorbell`, `verify_job` and `receipts_status`. None of them
signs or sends a transaction, and the server holds no key. An order is planned as unsigned
transactions, an `approve` and then `createOrder`, which the user checks and signs with their own
wallet.

```sh
# Claude Code
claude mcp add --transport http help-wanted https://web-production-a7c148.up.railway.app/mcp

# Codex
codex mcp add help-wanted --url https://web-production-a7c148.up.railway.app/mcp
```

The skill an agent reads first, with the safe flow for an order and the limits, is
[`apps/web/public/skill.md`](apps/web/public/skill.md), served at
<https://web-production-a7c148.up.railway.app/skill.md>; a shorter orientation is
[`apps/web/public/agents.md`](apps/web/public/agents.md). Without MCP, the same data is plain HTTP:
the JSON API under `/api/v1` (described in `/openapi.json`; `/api/v1/flows` plans every
transaction the site offers), every page as `.json` and `.md`, and `/llms.txt` to list them all.
The server is `apps/web/src/lib/mcp.ts`, tested offline in `apps/web/test/mcp.test.ts`.

## Map of the repository

```text
launches/a-payroll/   Launch A, live: Questions, JobsReport, Payroll. A Foundry project.
launches/b-desk/      Launch B, live: WorkProof, WorkOrders, CrowdPots, Doorbell.
launches/c-company/   Launch C, live: Rules, Endowments, Zap.
packages/shared/      TypeScript the rest imports: addresses, the deployments book, ABIs generated
                      from the launch projects' build output, the order header, the work record
                      scanner, the oracle's question hash, a client for IdentityMD's public API.
bots/keeper/          The bot that makes the calls anyone may make: ask a feed, hand an answer in,
                      print the report, return an expired escrow, watch delivery claims.
bots/runner/          The bot that takes an order, buys the swarm job and collects.
apps/indexer/         Copies chain events and public API data into a database; a read-only API.
apps/web/             The site: the receipt checker, the report, the hire desk's pages. Every page
                      also answers as JSON and as Markdown, and /mcp is its MCP server for agents.
scripts/evidence/     The evidence builder (pnpm evidence) and its tests.
scripts/repro.sh      The comparison of deployed code with a build of this source (pnpm repro).
scripts/first-rule.sh How rule 1 of launch C was created and fired on 16 October 2026 (cast, with
                      the wallet's own keystore).
scripts/proof-requests.sh
                      How the three questions of the report were first bought from the live oracle.
scripts/feedback.sh   Our ERC-8004 reviews of the agents that did orders 1 and 2, given by H1, the
                      wallet that paid for their jobs, each naming a feedback file on the site
                      (apps/web/public/erc8004/) with its x402 payment (cast, with the keystore).
evidence/             The house list, the list of launches requested and not yet in the book
                      (empty since 15 October 2026), and evidence.json (generated).
EVIDENCE.md           Generated. What exists on chain, at one pinned block.
SECURITY.md           How to report a problem privately, what is in scope, and that there is no
                      bounty.
```

Start with the README of the part you care about:
[`launches/a-payroll`](launches/a-payroll/README.md),
[`launches/b-desk`](launches/b-desk/README.md),
[`launches/c-company`](launches/c-company/README.md),
[`bots/keeper`](bots/keeper/README.md), [`bots/runner`](bots/runner/README.md),
[`apps/indexer`](apps/indexer/README.md), [`packages/shared`](packages/shared/README.md).
How the site looks, moves and speaks, with the files to draw it: [`apps/web/BRAND.md`](apps/web/BRAND.md).

## Run the tests

The contracts. Foundry is the only requirement, dependencies are vendored, and no network is used:

```sh
(cd launches/a-payroll && forge test)
(cd launches/b-desk && forge test)
(cd launches/c-company && forge test)
```

On 15 October 2026, with Foundry 1.8.3: 515 tests passed in launch A, 673 in launch B and 447 in
launch C, none failed. A first build takes a few minutes. Each project also has a fork suite that
runs against mainnet (`FOUNDRY_PROFILE=fork forge test`); its README says what that suite covers.

Everything in TypeScript. Node 22 or newer and pnpm 11:

```sh
pnpm install
pnpm test          # every package, then the evidence builder
pnpm typecheck
```

On the same day: `packages/shared` 397 tests, `bots/runner` 431, `bots/keeper` 324,
`apps/indexer` 213, `apps/web` 680 and the evidence builder 100, none failed. Those are the counts
each suite reports as `Tests  N passed (N)`. By each package's own account no test reaches the
internet; the tests of the indexer, the site and the evidence builder make `fetch` throw to be
sure. Of the keeper's 324, 296 are unit tests (`test:unit`) and 28 start a local node; those 28
are skipped, with a message, when Foundry is missing or the launch projects are not built, and the
suite then reports them as skipped.

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
