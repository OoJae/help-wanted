# Fixtures

Real protocol data, recorded once so the tests run with no network. Do not edit these by hand.

## `logs/`: Ethereum mainnet logs

Written by `scripts/record-fixtures.ts` on 10 October 2026. Each file holds the raw
`eth_getLogs` answer (`logs`) and the header fields of every block a log sits in (`blocks`), so
the in-memory test node can answer both `eth_getLogs` and `eth_getBlockByNumber`.

| File | Contract | Blocks | Logs |
|---|---|---|---|
| `work-recorded.json` | WorkRegistry `0xb6d0a187…a775` | 26,131,900 to 26,132,100 | 5 `WorkRecorded`, among them the receipt of job `e9efec16-56f3-40d3-9243-52c453effc7d` (block 26,131,975, document hash `0x3db99325…b2c5`) |
| `intake.json` | Intake `0x1397434c…ea56` | 26,142,962 (its creation) to 26,164,615 | all 13: 8 `Requested`, 5 `Completed` |
| `fee-transfers.json` | IMD `0xd34a99bc…63b7`, recipient `0x4e0fa57b…adbc` | 26,157,615 to 26,164,615 | 94 `Transfer`: 118.5 IMD from 33 payers |
| `launch-a-questions.json` | HELP WANTED's Questions `0xEECE4628…D3F6` | 26,182,869 (its launch) to 26,183,622 | all 10: 1 `OracleSignerSet` from the launch transaction, then 3 `FeedCreated`, 3 `Funded` and 3 `RoundOpened` from house wallet H1 |

The first two were read from `rpc.mevblocker.io`, because the default node does not serve logs
that old; the third from `ethereum-rpc.publicnode.com`. `intake.json` is the legacy Intake
(version 1): version 2 did not exist in that range. `launch-a-questions.json` was read from
`ethereum-rpc.publicnode.com` on 13 October 2026, the day of the launch, with `cast logs` (no topic
filter) and `cast block` for the headers.

The request bodies inside `intake.json` are whatever the buyers sent, hex-encoded as the chain
has them. They are test data for the decoder and nothing more.

## `api/`: documents of the public IdentityMD API

| File | Route | Note |
|---|---|---|
| `health.json` | `GET /health` | as served on 10 October 2026 |
| `jobs-limit3.json` | `GET /jobs?limit=3` | as served |
| `job-e9efec16.json` | `GET /jobs/e9efec16-56f3-40d3-9243-52c453effc7d` | as served |
| `job-records-e9efec16.json` | `GET /jobs/e9efec16-…/records` | as served |
| `oracle-requests.json` | `GET /oracle/requests` | **trimmed**: six of the 100 requests of one real answer (two each of `attested`, `disagreed`, `blocked`), with `count` set to 6. The entries themselves are unchanged. |

`health.json` and `job-e9efec16.json` are copies of the files the build's reference folder holds;
`jobs-limit3.json` and `job-records-e9efec16.json` are copies of the same fixtures in
`packages/shared/fixtures/api`.
