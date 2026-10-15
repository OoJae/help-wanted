# HELP WANTED: evidence

This file is written by `pnpm evidence` (`scripts/evidence/build.ts`) and by nothing else. Do not edit it: run the command again. The same facts, for a program, are in `evidence/evidence.json`.

Everything below was read from Ethereum mainnet (chain 1) at **block 26,197,296**, hash `0x3a9d9757d6c67ec1304de63f46237c77b4f23d35ecd8779cd1de32b0f440dcd2`, mined 15 Oct 2026, 10:24:23 UTC. It was the node's finalized block when the run began, so it can no longer change. Logs were read from each launch's own block up to that block, in ranges of at most 1,500 blocks; code and views were read at that block. Read through `rpc.mevblocker.io`, `ethereum-rpc.publicnode.com`.

A number is here only if it was read. A zero is a count that was read and is zero. "Not launched" means there is nothing to read.

## In one screen

- **7 of 10 contracts are launched**, and each of them has code at its address (launch A, launch B). Not launched: launch C.
- **Transactions that touched the launched contracts after their launch: 55. HOUSE 54, OUTSIDE 0, and 1 sent by IdentityMD's own service.** IdentityMD's service sends a transaction when its Intake delivers an oracle answer that was paid for; that is nobody's use of the contracts, and it is counted apart. Every other one was sent by the team's own wallets: nobody outside the team has used these contracts yet.
- Standing Questions: 3 feeds created (HOUSE 3, OUTSIDE 0); 3 oracle requests bought (HOUSE 3, OUTSIDE 0), of which 2 answered by `submit`, 1 by the Intake's callback, 0 closed without an answer and 0 pending.
- Robot Jobs Report: 1 print (HOUSE 1, OUTSIDE 0), 112 IMD and 223 payments recorded in all.
- Payroll: 0.05 IMD received since launch, 0.05 IMD in tips.
- Hire desk: 1 orders opened (HOUSE 1, OUTSIDE 0); 1 settled against a receipt, 0 paid on a claim, 0 refunded.

## HOUSE and OUTSIDE

HOUSE is the activity of the wallets the team publishes in evidence/house-wallets.json and of HELP WANTED's own contracts; everything else is OUTSIDE. Each event is counted for one account: the one that made the call, the one the event pays, or the one an earlier event settled (the opener of a round, the employer of an order). When the account made the call itself, the count is HOUSE if that account or the sender of the transaction is on the list. scripts/evidence/contracts.ts holds the rule of every event.

| Label | Address | What it is | Note |
| --- | --- | --- | --- |
| W1 | [`0x871e507B6a70F858Ad4B414bddb77473630C366b`](https://etherscan.io/address/0x871e507B6a70F858Ad4B414bddb77473630C366b) | wallet | Pays for every launch and paid action; the prize wallet; the team's depositor |
| H1 | [`0x60CcC928eb8EEE1d64CA0164565BfA9858669560`](https://etherscan.io/address/0x60CcC928eb8EEE1d64CA0164565BfA9858669560) | wallet | Hot key for the runner and keeper bots; holds a small float only |
| Questions | [`0xEECE4628ceb091C13393fc64056Be8b8501fD3F6`](https://etherscan.io/address/0xEECE4628ceb091C13393fc64056Be8b8501fD3F6) | contract | launch A, from the deployments book |
| JobsReport | [`0x58963B57E179f7fE4E95090C21E8e9D75353BCE4`](https://etherscan.io/address/0x58963B57E179f7fE4E95090C21E8e9D75353BCE4) | contract | launch A, from the deployments book |
| Payroll | [`0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F`](https://etherscan.io/address/0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F) | contract | launch A, from the deployments book |
| WorkProof | [`0xB268297dB06985ba0b806Ba97BcB90364b137469`](https://etherscan.io/address/0xB268297dB06985ba0b806Ba97BcB90364b137469) | contract | launch B, from the deployments book |
| WorkOrders | [`0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2`](https://etherscan.io/address/0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2) | contract | launch B, from the deployments book |
| CrowdPots | [`0x8C2FfCdcb103659aa05c772b8F2059868B496EB5`](https://etherscan.io/address/0x8C2FfCdcb103659aa05c772b8F2059868B496EB5) | contract | launch B, from the deployments book |
| Doorbell | [`0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb`](https://etherscan.io/address/0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb) | contract | launch B, from the deployments book |

## Launches

| Launch | What it holds | Status | Launch transaction | Block | Source | Known limits |
| --- | --- | --- | --- | --- | --- | --- |
| A | Standing Questions, the Robot Jobs Report and Payroll | live: IdentityMD launch 1531, block 26182869 | [`0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58`](https://etherscan.io/tx/0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58) | 26,182,869 | `launches/a-payroll` | `launches/a-payroll/docs/THREATS.md` |
| B | WorkProof, the hire desk, crowd pots and the Doorbell | live: IdentityMD launch 1573, block 26184581 | [`0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c`](https://etherscan.io/tx/0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c) | 26,184,581 | `launches/b-desk` | `launches/b-desk/docs/THREATS.md` |
| C | Rules, Endowments and Zap | not launched: the deployments book holds no address for it |  |  | `launches/c-company` | `launches/c-company/docs/THREATS.md` |

## Contracts

| Launch | Contract | Address | Code at the pinned block | Named in the factory's launch log | IMD held | Source |
| --- | --- | --- | --- | --- | --- | --- |
| A | `Questions` | [`0xEECE4628ceb091C13393fc64056Be8b8501fD3F6`](https://etherscan.io/address/0xEECE4628ceb091C13393fc64056Be8b8501fD3F6) | yes: 22,233 bytes, keccak256 `0xf876f5265e4ae5015645fbbee2c47e280391c23fc8256b46b688688a388618f7` | yes | 0.16 | `launches/a-payroll/src/questions/Questions.sol` |
| A | `JobsReport` | [`0x58963B57E179f7fE4E95090C21E8e9D75353BCE4`](https://etherscan.io/address/0x58963B57E179f7fE4E95090C21E8e9D75353BCE4) | yes: 9,320 bytes, keccak256 `0xb050a81690b40963e1cbdffb17aafb3fcdf42ddd432a05023be7e23873207432` | yes | 0 | `launches/a-payroll/src/payroll/JobsReport.sol` |
| A | `Payroll` | [`0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F`](https://etherscan.io/address/0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F) | yes: 11,846 bytes, keccak256 `0xa962b0633998d594b2720984ad5f76fce369148592da0762b9d9acf399367236` | yes | 0.088367063492063491 | `launches/a-payroll/src/payroll/Payroll.sol` |
| B | `WorkProof` | [`0xB268297dB06985ba0b806Ba97BcB90364b137469`](https://etherscan.io/address/0xB268297dB06985ba0b806Ba97BcB90364b137469) | yes: 4,579 bytes, keccak256 `0x0a514db427f7f3845166e923929d67816f4a27e661d8ed510b7e910d730e5fba` | yes | 0 | `launches/b-desk/src/proof/WorkProof.sol` |
| B | `WorkOrders` | [`0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2`](https://etherscan.io/address/0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2) | yes: 19,289 bytes, keccak256 `0xb06dfaf6410132828e12647f4ee5199a092f8c0fb9f0c0d2275b5f655262ffb3` | yes | 0 | `launches/b-desk/src/desk/WorkOrders.sol` |
| B | `CrowdPots` | [`0x8C2FfCdcb103659aa05c772b8F2059868B496EB5`](https://etherscan.io/address/0x8C2FfCdcb103659aa05c772b8F2059868B496EB5) | yes: 14,177 bytes, keccak256 `0x282560809f9474cbb416a8d6235fac38fe2679ff3e729a87ff88859006beb1c2` | yes | 0 | `launches/b-desk/src/pots/CrowdPots.sol` |
| B | `Doorbell` | [`0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb`](https://etherscan.io/address/0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb) | yes: 5,972 bytes, keccak256 `0xda26e8196bf95c4117124ef25c308be050bee1823ff5c6ccf287a5d788bfe43c` | yes | 0 | `launches/b-desk/src/pots/Doorbell.sol` |
| C | `Rules` | not launched |  |  |  | `launches/c-company/src/rules/Rules.sol` |
| C | `Endowments` | not launched |  |  |  | `launches/c-company/src/endowments/Endowments.sol` |
| C | `Zap` | not launched |  |  |  | `launches/c-company/src/rules/Zap.sol` |

"Named in the factory's launch log" means: the log IdentityMD's ProjectFactory wrote in the launch transaction lists this address. "IMD held" is the token's `balanceOf` for the address at the pinned block.

## Launch A: Standing Questions, the Robot Jobs Report and Payroll

**Live.** IdentityMD launch 1531. Created in transaction [`0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58`](https://etherscan.io/tx/0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58), block 26,182,869 (13 Oct 2026, 10:07:59 UTC), sent by `0xcECc29B037f5064fCdF45a5C318F132ef76aA551` to `0xfF03410d0Fe5fa8f7F59F743de35E333D9857120`; the transaction succeeded.

39 logs of these contracts, in 28 transactions, were read from block 26,182,869 to block 26,197,296. The source is in `launches/a-payroll`; its known limits are in `launches/a-payroll/docs/THREATS.md`.

### Standing Questions (`Questions`)

The contract is built on the Intake at `0xa43e6F75ee006411F79Ac1C84120606C2330DE82`. A round is one oracle request the contract bought from it.

| What | Total | HOUSE | OUTSIDE |
| --- | --- | --- | --- |
| Feeds created | 3 | 3 | 0 |
| Meter fundings, by funder | 5 | 5 | 0 |
| Put on the meters, IMD | 1.66 | 1.66 | 0 |
| Meter withdrawals, by funder | 0 | 0 | 0 |
| Taken back from the meters, IMD | 0 | 0 | 0 |
| Rounds opened (oracle requests bought), by opener | 3 | 3 | 0 |
| Of those: answered by `submit` | 2 | 2 | 0 |
| Of those: answered by the Intake's callback | 1 | 1 | 0 |
| Of those: closed without an answer | 0 | 0 | 0 |
| Of those: pending at the pinned block | 0 | 0 | 0 |
| Answers handed in with `submit`, by who handed them in | 2 | 2 | 0 |
| Paid to the Intake for the requests, IMD | 1.5 | 1.5 | 0 |
| Keeper tips earned (answered rounds, by opener) | 3 | 3 | 0 |
| Keeper tips earned, IMD | 0.15 | 0.15 | 0 |
| Keeper tip collections, by keeper | 0 | 0 | 0 |
| Keeper tips collected, IMD | 0 | 0 | 0 |
| Lists revealed | 0 | 0 | 0 |

#### Feeds

| Feed | Feed id | Created by | Side | Created in | Asked every | Rounds opened | On the meter, IMD | Newest answer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| payrolls | `0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61` | `0x60CcC928eb8EEE1d64CA0164565BfA9858669560` | HOUSE | [`0xae0f188392827e37895600f0eb6fcb625c31f99d13c6def8f1ca3dbbef7c5cbe`](https://etherscan.io/tx/0xae0f188392827e37895600f0eb6fcb625c31f99d13c6def8f1ca3dbbef7c5cbe) | 7,000 blocks | 1 | 0.005 | round 1: 112 IMD paid to the swarm |
| hires | `0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d` | `0x60CcC928eb8EEE1d64CA0164565BfA9858669560` | HOUSE | [`0x8bd0530e54a7502f557195ab64d6f4bd43c75f05e8d99ea08d186c694c0d07ac`](https://etherscan.io/tx/0x8bd0530e54a7502f557195ab64d6f4bd43c75f05e8d99ea08d186c694c0d07ac) | 7,000 blocks | 1 | 0.005 | round 1: 223 payments |
| employers | `0x22ad8df0e0af07aa59e29aa7f5540e0022fbfda0651ccae3eccb968553a14835` | `0x60CcC928eb8EEE1d64CA0164565BfA9858669560` | HOUSE | [`0xd08f84e5de4b984a35de837f13ff3aafa3c31ec81fe2db94071f59084aa6c1bd`](https://etherscan.io/tx/0xd08f84e5de4b984a35de837f13ff3aafa3c31ec81fe2db94071f59084aa6c1bd) | 49,000 blocks | 1 | 0 | round 1: a list of addresses; the contract stores its hash, 42073678670894866441324453801975447869762946790873191575450077339037486760450 |

#### Rounds: every oracle request, and how it ended

| Feed | Round | Request (transaction) | Block | Asked about blocks | Opened by | How it ended | Ended in | By | Answer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| payrolls | 1 | [`0x9fea43c9e0fd05c8c55b977284e6e543410f71c74363e5448747b1b482056b06`](https://etherscan.io/tx/0x9fea43c9e0fd05c8c55b977284e6e543410f71c74363e5448747b1b482056b06) | 26,183,619 | 26,176,608 to 26,183,607 | `0x60CcC928eb8EEE1d64CA0164565BfA9858669560` (HOUSE) | answered by submit | [`0xfd95b06615de1f0a1002fd4b8178c18d92a76e8f0ee11737c11f5cb6d1832ca5`](https://etherscan.io/tx/0xfd95b06615de1f0a1002fd4b8178c18d92a76e8f0ee11737c11f5cb6d1832ca5), block 26,183,772 | `0x60CcC928eb8EEE1d64CA0164565BfA9858669560` (HOUSE) | 112 IMD paid to the swarm |
| hires | 1 | [`0x943a265217afcd2f60bdc7c9f13cc070504cb2582d470ac0ed44e3c8658d6001`](https://etherscan.io/tx/0x943a265217afcd2f60bdc7c9f13cc070504cb2582d470ac0ed44e3c8658d6001) | 26,183,621 | 26,176,610 to 26,183,609 | `0x60CcC928eb8EEE1d64CA0164565BfA9858669560` (HOUSE) | answered by submit | [`0x80138b296f005b1cd378e493c9e13d7daca5e347d592832184e3e34557455e61`](https://etherscan.io/tx/0x80138b296f005b1cd378e493c9e13d7daca5e347d592832184e3e34557455e61), block 26,183,780 | `0x60CcC928eb8EEE1d64CA0164565BfA9858669560` (HOUSE) | 223 payments |
| employers | 1 | [`0x4ef3313d793940eca2847b7d01969ea76c56f92fab92aa7601e863dd92660204`](https://etherscan.io/tx/0x4ef3313d793940eca2847b7d01969ea76c56f92fab92aa7601e863dd92660204) | 26,183,622 | 26,133,211 to 26,183,610 | `0x60CcC928eb8EEE1d64CA0164565BfA9858669560` (HOUSE) | answered by the Intake's callback | [`0xfed277e7525f289f8e8bad0333148c8823f42c779836280189ff874500de051b`](https://etherscan.io/tx/0xfed277e7525f289f8e8bad0333148c8823f42c779836280189ff874500de051b), block 26,185,017 | `0xa43e6F75ee006411F79Ac1C84120606C2330DE82` (the Intake) | a list of addresses; the contract stores its hash, 42073678670894866441324453801975447869762946790873191575450077339037486760450 |

| Feed | Round | Intake request id | Price, IMD | Tip set aside, IMD | Oracle request at IdentityMD |
| --- | --- | --- | --- | --- | --- |
| payrolls | 1 | `0x8b62aeadfbd380a68797107a800d55f2d1697849f94ac6564eb69856cc071841` | 0.5 | 0.05 | `f8ffb991-55b7-4316-9461-44a94d5270aa` |
| hires | 1 | `0xb5b449716f98becc4b2cd31f18d0dffff6243f6b0a2f68ca68b3665424f91339` | 0.5 | 0.05 | `0a94afe2-c48e-4254-9184-79de6d8f98a1` |
| employers | 1 | `0xa81622f556b9441f6de3c0418d908b5a25dacc22c92c8c734be7a685fb6d02d9` | 0.5 | 0.05 | `4831e033-1ddd-4308-9d26-396a8d340e82` |

### The Robot Jobs Report (`JobsReport`)

| What | Total | HOUSE | OUTSIDE |
| --- | --- | --- | --- |
| Prints, by who called `print` | 1 | 1 | 0 |
| Counts recorded | 1 | 1 | 0 |
| Employers of the week crowned | 1 | 1 | 0 |
| Rounds read and skipped | 0 | 0 | 0 |

| Print | Transaction | Block | Time | Printed by | IMD paid to the swarm | In blocks | Payments | Counted in blocks | Running total, IMD | Streak | Best day when printed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no. 1 (index 0) | [`0x691890b4affed91496538e012610b632c72a739b5a2ec703b285d51961edb192`](https://etherscan.io/tx/0x691890b4affed91496538e012610b632c72a739b5a2ec703b285d51961edb192) | 26,183,781 | 13 Oct 2026, 13:10:35 UTC | `0x60CcC928eb8EEE1d64CA0164565BfA9858669560` (HOUSE) | 112 | 26,176,608 to 26,183,607 | 223 | 26,176,610 to 26,183,609 | 112 | 1 | yes |

A print's amount and its count come from two feeds, each asked about its own block window, so the two windows can differ by a block or two.

The contract's own summary at the pinned block: 1 print, 112 IMD in all; 1 count, 223 payments in all; a streak of 1; 1 crown.

### Payroll

| Payroll's own total since launch | IMD |
| --- | --- |
| Received and booked | 0.05 |
| Of that, to the stakers' stream | 0.025 |
| Of that, to the seat pool | 0.015 |
| Of that, to the feed budget | 0.01 |
| Sent on to sIMD stakers | 0.001632936507936509 |
| Claimed by seat owners | 0 |
| Tips taken in | 0.05 |
| Tips claimed | 0 |
| Tips that joined the seat pool | 0 |
| Placed on the house feeds' meters | 0.01 |
| Feed budget released to stakers | 0 |
| Still owed, all told | 0.088367063492063491 |
| Arrived by plain transfer and not booked yet | 0 |

| What | Total | HOUSE | OUTSIDE |
| --- | --- | --- | --- |
| Payments through `pay`, by payer | 1 | 1 | 0 |
| Paid through `pay`, IMD | 0.05 | 0.05 | 0 |
| Bookings (`pay` and plain transfers), by who sent the booking | 1 | 1 | 0 |
| Booked, IMD | 0.05 | 0.05 | 0 |
| Tips through `tip`, by payer | 1 | 1 | 0 |
| Tipped, IMD | 0.05 | 0.05 | 0 |
| Tip claims, by the seat owner paid | 0 | 0 | 0 |
| Tips claimed, IMD | 0 | 0 | 0 |
| Sweeps of unclaimed tips to the seat pool | 0 | 0 | 0 |
| Tips swept, IMD | 0 | 0 | 0 |
| Drips to sIMD, by caller | 11 | 11 | 0 |
| Dripped to sIMD, IMD | 0.001632936507936509 | 0.001632936507936509 | 0 |
| Seat claims, by the seat owner paid | 0 | 0 | 0 |
| Claimed by seats, IMD | 0 | 0 | 0 |
| Meter top-ups from the feed budget | 2 | 2 | 0 |
| Placed on meters, IMD | 0.01 | 0.01 | 0 |
| Releases of feed budget to stakers | 0 | 0 | 0 |
| Feed budget released, IMD | 0 | 0 | 0 |

### Every event of launch A's contracts

Every event in each contract's ABI, with how often it was logged. A row of zeros is an event that has never been logged.

| Contract | Event | Total | HOUSE | OUTSIDE | Counted for |
| --- | --- | --- | --- | --- | --- |
| `Questions` | `AnswerRevealed` | 0 | 0 | 0 | the sender of the transaction |
| `Questions` | `CompletionSeen` | 0 | 0 | 0 | the sender of the transaction |
| `Questions` | `Defunded` | 0 | 0 | 0 | the funder that took IMD back |
| `Questions` | `EIP712DomainChanged` | 0 | 0 | 0 | the launch itself (emitted by the constructor) |
| `Questions` | `FeedCreated` | 3 | 3 | 0 | the feed's creator |
| `Questions` | `Funded` | 5 | 5 | 0 | the funder |
| `Questions` | `FundedFor` | 0 | 0 | 0 | the payer |
| `Questions` | `OracleSignerSet` | 1 | 1 | 0 | the launch itself (emitted by the constructor) |
| `Questions` | `RoundAnswered` | 3 | 3 | 0 | whoever handed the answer in with submit; the round's opener when the Intake's callback delivered it |
| `Questions` | `RoundFailed` | 0 | 0 | 0 | whoever closed the round (the sender of the transaction) |
| `Questions` | `RoundOpened` | 3 | 3 | 0 | the keeper that opened the round |
| `Questions` | `SharesRescaled` | 0 | 0 | 0 | the sender of the transaction |
| `Questions` | `SharesRetired` | 2 | 2 | 0 | the sender of the transaction |
| `Questions` | `TipsCollected` | 0 | 0 | 0 | the keeper that collected |
| `JobsReport` | `BestDay` | 1 | 1 | 0 | whoever called print (the sender of the transaction) |
| `JobsReport` | `CountRecorded` | 1 | 1 | 0 | whoever called print (the sender of the transaction) |
| `JobsReport` | `Counted` | 1 | 1 | 0 | whoever called print (the sender of the transaction) |
| `JobsReport` | `EmployersOfTheWeek` | 1 | 1 | 0 | whoever called crown (the sender of the transaction) |
| `JobsReport` | `Printed` | 1 | 1 | 0 | whoever called print (the sender of the transaction) |
| `JobsReport` | `RoundSkipped` | 0 | 0 | 0 | whoever called print (the sender of the transaction) |
| `Payroll` | `Booked` | 1 | 1 | 0 | the sender of the transaction that booked the IMD |
| `Payroll` | `Dripped` | 11 | 11 | 0 | the caller of drip |
| `Payroll` | `FeedBudgetAged` | 0 | 0 | 0 | the sender of the transaction |
| `Payroll` | `FeedBudgetReleased` | 0 | 0 | 0 | the sender of the transaction that called fundFeeds |
| `Payroll` | `FeedFunded` | 2 | 2 | 0 | the sender of the transaction that called fundFeeds |
| `Payroll` | `FeedFundingFailed` | 0 | 0 | 0 | the sender of the transaction that called fundFeeds |
| `Payroll` | `Paid` | 1 | 1 | 0 | the payer; for a fee the hire desk pays, the employer of the order named in the memo |
| `Payroll` | `SeatClaimed` | 0 | 0 | 0 | the seat's owner, who is paid |
| `Payroll` | `StreamLevelled` | 1 | 1 | 0 | the sender of the transaction |
| `Payroll` | `TipClaimed` | 0 | 0 | 0 | the seat's owner, who is paid |
| `Payroll` | `TipSwept` | 0 | 0 | 0 | the sender of the transaction |
| `Payroll` | `Tipped` | 1 | 1 | 0 | the payer; for a tip the hire desk pays, the employer of the order settled in the same transaction |

## Launch B: WorkProof, the hire desk, crowd pots and the Doorbell

**Live.** IdentityMD launch 1573. Created in transaction [`0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c`](https://etherscan.io/tx/0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c), block 26,184,581 (13 Oct 2026, 15:51:11 UTC), sent by `0xcECc29B037f5064fCdF45a5C318F132ef76aA551` to `0xfF03410d0Fe5fa8f7F59F743de35E333D9857120`; the transaction succeeded.

32 logs of these contracts, in 29 transactions, were read from block 26,184,581 to block 26,197,296. The source is in `launches/b-desk`; its known limits are in `launches/b-desk/docs/THREATS.md`.

### The hire desk (`WorkOrders`)

| What | Total | HOUSE | OUTSIDE |
| --- | --- | --- | --- |
| Orders opened, by employer | 1 | 1 | 0 |
| Escrowed when opened (the top of each price range), IMD | 1 | 1 | 0 |
| Claims taken, by runner | 1 | 1 | 0 |
| Jobs registered, by runner | 1 | 1 | 0 |
| Settled, proven by a receipt, by employer | 1 | 1 | 0 |
| Price of those orders, IMD | 1 | 1 | 0 |
| Paid on a claim, not proven, by employer | 0 | 0 | 0 |
| Price of those orders, IMD | 0 | 0 | 0 |
| Of those: proven later, when the receipt landed | 0 | 0 | 0 |
| Refunded, by employer | 0 | 0 | 0 |
| Returned by refunds, IMD | 0 | 0 | 0 |
| Cancelled, by employer | 0 | 0 | 0 |
| Returned by cancellations, IMD | 0 | 0 | 0 |
| Delivery claims, by runner | 1 | 1 | 0 |
| Challenges, by challenger | 0 | 0 | 0 |
| Disputes decided by an arbiter | 0 | 0 | 0 |
| Claims ended without a delivery, by runner | 0 | 0 | 0 |
| Receipts reported that did not settle an order | 0 | 0 | 0 |
| Settlements whose fee or tip reached Payroll by plain transfer | 0 | 0 | 0 |

Of the orders opened, our own employer contracts opened: the Doorbell 1, CrowdPots 0, Rules 0. Those count as HOUSE orders; the outside part of them shows in the chips, the rings and the rules below.

Paid out at settlement over all delivered orders: 0.9 IMD to runners, 0.05 IMD in fees to Payroll, 0.05 IMD in tips.

| Order | Employer | Side | Opened in | Escrow, IMD | Allows the claimed path | Where it stands | Runner | Swarm job | Settled in |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb` (Doorbell) | HOUSE | [`0xa9c9f25681b4512fc51d06cdd17d575e1ef3385d881b9ff62e25447bf8d815fb`](https://etherscan.io/tx/0xa9c9f25681b4512fc51d06cdd17d575e1ef3385d881b9ff62e25447bf8d815fb) | 1 | yes | settled, proven by a receipt | `0x60CcC928eb8EEE1d64CA0164565BfA9858669560` | f7bd80ba-3e8b-483f-ad02-6ffbd16fef92 | [`0xa3f5b783fe194c35f348e411a10f0a199589ea89b668a16d1597794931217628`](https://etherscan.io/tx/0xa3f5b783fe194c35f348e411a10f0a199589ea89b668a16d1597794931217628) |

### Crowd pots (`CrowdPots`)

| What | Total | HOUSE | OUTSIDE |
| --- | --- | --- | --- |
| Pots opened, by opener | 0 | 0 | 0 |
| Series opened, by opener | 0 | 0 | 0 |
| Chips, by payer | 0 | 0 | 0 |
| Chipped in, IMD | 0 | 0 | 0 |
| Pots filled | 0 | 0 | 0 |
| Pots that hired (launched an order), by who launched | 0 | 0 | 0 |
| Pots settled | 0 | 0 | 0 |
| Refunds paid, by contributor | 0 | 0 | 0 |
| Refunded to contributors, IMD | 0 | 0 | 0 |

### The Doorbell

| What | Total | HOUSE | OUTSIDE |
| --- | --- | --- | --- |
| Rings, by ringer | 25 | 25 | 0 |
| Hires by the Doorbell, by the ringer whose ring hired | 1 | 1 | 0 |
| Escrowed by those hires, IMD | 1 | 1 | 0 |
| Rings that should have hired and could not (too little IMD) | 0 | 0 | 0 |
| Deliveries recorded | 1 | 1 | 0 |

At the pinned block the Doorbell does not hold the escrow for its next hire, and its orders allow the claimed path.

### Every event of launch B's contracts

Every event in each contract's ABI, with how often it was logged. A row of zeros is an event that has never been logged.

| Contract | Event | Total | HOUSE | OUTSIDE | Counted for |
| --- | --- | --- | --- | --- | --- |
| `WorkOrders` | `CallbackFailed` | 0 | 0 | 0 | the order's employer |
| `WorkOrders` | `Cancelled` | 0 | 0 | 0 | the order's employer |
| `WorkOrders` | `Challenged` | 0 | 0 | 0 | the challenger |
| `WorkOrders` | `ClaimEnded` | 0 | 0 | 0 | the runner whose claim ended |
| `WorkOrders` | `Claimed` | 1 | 1 | 0 | the runner |
| `WorkOrders` | `Delivered` | 1 | 1 | 0 | the order's employer |
| `WorkOrders` | `DeliveryClaimed` | 1 | 1 | 0 | the runner that holds the order |
| `WorkOrders` | `Failed` | 0 | 0 | 0 | the order's employer |
| `WorkOrders` | `OrderOpened` | 1 | 1 | 0 | the employer |
| `WorkOrders` | `PayrollFallback` | 0 | 0 | 0 | the order's employer |
| `WorkOrders` | `Proven` | 0 | 0 | 0 | the order's employer |
| `WorkOrders` | `Redelivered` | 0 | 0 | 0 | the order's employer |
| `WorkOrders` | `Refunded` | 0 | 0 | 0 | the order's employer |
| `WorkOrders` | `Registered` | 1 | 1 | 0 | the runner that holds the order |
| `WorkOrders` | `Resolved` | 0 | 0 | 0 | the arbiter |
| `WorkOrders` | `Triggered` | 0 | 0 | 0 | the order's employer |
| `CrowdPots` | `ChippedIn` | 0 | 0 | 0 | the payer of the chip |
| `CrowdPots` | `PotFilled` | 0 | 0 | 0 | the pot's opener |
| `CrowdPots` | `PotLaunched` | 0 | 0 | 0 | whoever launched the pot |
| `CrowdPots` | `PotOpened` | 0 | 0 | 0 | the pot's opener |
| `CrowdPots` | `PotSettled` | 0 | 0 | 0 | the pot's opener |
| `CrowdPots` | `RefundPaid` | 0 | 0 | 0 | the contributor, who is paid |
| `CrowdPots` | `SeriesOpened` | 0 | 0 | 0 | the series' opener |
| `CrowdPots` | `SpecPinned` | 0 | 0 | 0 | the sender of the transaction |
| `CrowdPots` | `WorkDelivered` | 0 | 0 | 0 | the pot's opener |
| `Doorbell` | `Delivered` | 1 | 1 | 0 | the Doorbell, as the order's employer |
| `Doorbell` | `HireSkipped` | 0 | 0 | 0 | the ringer (the sender of the transaction) |
| `Doorbell` | `Hired` | 1 | 1 | 0 | the ringer whose ring hired |
| `Doorbell` | `Rang` | 25 | 25 | 0 | the ringer |

## Launch C: Rules, Endowments and Zap

**Not launched.** The deployments book holds no address for `Rules`, `Endowments`, `Zap`, so there is nothing on chain to read and nothing is counted.

The source is in `launches/c-company`; its known limits are in `launches/c-company/docs/THREATS.md`. Once the launch's addresses are written into the book, the next run counts: rules created and fired, endowments created, deposits and harvests, swaps through Zap.

## Checks: the logs and the book against the chain

Before anything was written, what the builder counted from the logs, what the deployments book says and the addresses of IdentityMD's own contracts were held against what the chain itself answers at the pinned block. Had one of these disagreed, the run would have stopped and written nothing.

| What | Expected, from | Expected | The chain says | Agree |
| --- | --- | --- | --- | --- |
| Questions is built on IdentityMD's Intake, version 2 | IdentityMD's addresses in packages/shared | `0xa43e6F75ee006411F79Ac1C84120606C2330DE82` | `0xa43e6F75ee006411F79Ac1C84120606C2330DE82` | yes |
| Questions pays in IMD | IdentityMD's addresses in packages/shared | `0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7` | `0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7` | yes |
| Questions accepts answers signed by IdentityMD's oracle signer | IdentityMD's addresses in packages/shared | `0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982` | `0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982` | yes |
| Questions: feeds created | logs | `3` | `3` | yes |
| Questions: rounds opened on the payrolls feed | logs | `1` | `1` | yes |
| Questions: the payrolls feed has a round pending | logs | `false` | `false` | yes |
| Questions: newest answered round of the payrolls feed | logs | `1` | `1` | yes |
| Questions: newest answer of the payrolls feed | logs | `112000000000000000000` | `112000000000000000000` | yes |
| Questions: rounds opened on the hires feed | logs | `1` | `1` | yes |
| Questions: the hires feed has a round pending | logs | `false` | `false` | yes |
| Questions: newest answered round of the hires feed | logs | `1` | `1` | yes |
| Questions: newest answer of the hires feed | logs | `223` | `223` | yes |
| Questions: rounds opened on the employers feed | logs | `1` | `1` | yes |
| Questions: the employers feed has a round pending | logs | `false` | `false` | yes |
| Questions: newest answered round of the employers feed | logs | `1` | `1` | yes |
| Questions: newest answer of the employers feed | logs | `42073678670894866441324453801975447869762946790873191575450077339037486760450` | `42073678670894866441324453801975447869762946790873191575450077339037486760450` | yes |
| JobsReport: prints | logs | `1` | `1` | yes |
| JobsReport: IMD over all prints, in wei | logs | `112000000000000000000` | `112000000000000000000` | yes |
| JobsReport: counts recorded | logs | `1` | `1` | yes |
| JobsReport: payments over all counts | logs | `223` | `223` | yes |
| JobsReport: crowns | logs | `1` | `1` | yes |
| JobsReport is bound to the Questions address in the book | the deployments book | `0xEECE4628ceb091C13393fc64056Be8b8501fD3F6` | `0xEECE4628ceb091C13393fc64056Be8b8501fD3F6` | yes |
| Payroll: IMD booked, in wei | logs | `50000000000000000` | `50000000000000000` | yes |
| Payroll: tips taken in, in wei | logs | `50000000000000000` | `50000000000000000` | yes |
| Payroll: IMD sent to sIMD, in wei | logs | `1632936507936509` | `1632936507936509` | yes |
| Payroll: IMD claimed by seats, in wei | logs | `0` | `0` | yes |
| Payroll: tips claimed, in wei | logs | `0` | `0` | yes |
| Payroll: tips that joined the seat pool, in wei | logs | `0` | `0` | yes |
| Payroll: feed budget released to stakers, in wei | logs | `0` | `0` | yes |
| Payroll is bound to the Questions address in the book | the deployments book | `0xEECE4628ceb091C13393fc64056Be8b8501fD3F6` | `0xEECE4628ceb091C13393fc64056Be8b8501fD3F6` | yes |
| WorkOrders: orders opened | logs | `1` | `1` | yes |
| CrowdPots: pots and series opened | logs | `0` | `0` | yes |
| Doorbell: rings | logs | `25` | `25` | yes |
| Doorbell: hires | logs | `1` | `1` | yes |
| Doorbell: deliveries | logs | `1` | `1` | yes |
| WorkProof reads IdentityMD's WorkRegistry | IdentityMD's addresses in packages/shared | `0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775` | `0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775` | yes |
| WorkOrders is bound to the WorkProof address in the book | the deployments book | `0xB268297dB06985ba0b806Ba97BcB90364b137469` | `0xB268297dB06985ba0b806Ba97BcB90364b137469` | yes |
| CrowdPots is bound to the WorkOrders address in the book | the deployments book | `0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2` | `0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2` | yes |
| The Doorbell is bound to the WorkOrders address in the book | the deployments book | `0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2` | `0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2` | yes |
| WorkOrders is bound to the Payroll address in the book | the deployments book | `0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F` | `0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F` | yes |
| Launch A: the ProjectFactory's log in the launch transaction names every address in the book | the deployments book | `true` | `true` | yes |
| Launch A: the launch number in the ProjectFactory's log | the deployments book | `1531` | `1531` | yes |
| Launch A: the launch transaction succeeded | the deployments book | `true` | `true` | yes |
| Launch B: the ProjectFactory's log in the launch transaction names every address in the book | the deployments book | `true` | `true` | yes |
| Launch B: the launch number in the ProjectFactory's log | the deployments book | `1573` | `1573` | yes |
| Launch B: the launch transaction succeeded | the deployments book | `true` | `true` | yes |

## What IdentityMD's API said

Read from `https://api.imd.fun` with GET requests, starting at 15 Oct 2026, 10:39:51 UTC. These answers are not pinned to a block: they are what IdentityMD's service said when it was asked, and they are kept apart from the chain reads above.

| Launch | IdentityMD's record | Status | Kind | Source repository IdentityMD built from | Commit | Lists the book's addresses | Verification time on record |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A (no. 1531) | `92bb495f-f565-414a-9b0d-d4bc62e699ac` | live | evm_contracts | https://github.com/identity-md-launches/launch-1531-please-deploy-repository-contracts | `3507c0e002c14ce8cde713bd7c62e6e6e522db4b` | yes | none for JobsReport, Payroll, Questions |
| B (no. 1573) | `90de809f-6038-4f0c-9a1f-f3711ea865a9` | live | evm_contracts | https://github.com/identity-md-launches/launch-1573-please-deploy-repository-contracts | `99f4ab0997bc8c9717f2203d8f3834f15d3220e1` | yes | none for CrowdPots, Doorbell, WorkOrders, WorkProof |

The last column is the `verifiedAt` field of IdentityMD's record for each contract: the time it records a source verification on a block explorer. "None" means the record holds no such time. `pnpm repro` compares the code at each address with a build of the source in this repository, whatever an explorer shows.

No round was pending at the pinned block, so no oracle request was looked up.

## Make this file again

```sh
pnpm install
pnpm evidence
```

The command reads only: it holds no key and sends no transaction. It prints the block it pinned. Settings, all optional: `RPC_URL` (one URL, or several separated by commas; the default public node keeps logs for about 9,000 blocks, so an older launch needs a node with history), `CHUNK_SIZE` (blocks per log query, default 2000), `EVIDENCE_BLOCK` (pin a block by number), `EVIDENCE_API=off` (leave IdentityMD's API out). When a read fails, or a count disagrees with a contract, nothing is written.
