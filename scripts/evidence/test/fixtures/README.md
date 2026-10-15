# Fixtures of the evidence builder

Real data, recorded once so that the tests run with no network. Do not edit these by hand.

| File | What it is |
|---|---|
| `run-2026-10-13.json` | Every answer one real run of `pnpm evidence` got on 13 October 2026: the JSON-RPC results from `ethereum-rpc.publicnode.com`, by method and parameters, and four answers of IdentityMD's public API, by path. The run pinned block 26,184,132, the node's finalized block at the time. |
| `house-wallets.json` | `evidence/house-wallets.json` as it was published on that day. |
| `launch-1531-2026-10-15.json` | IdentityMD's answer to `GET /launches/92bb495f-f565-414a-9b0d-d4bc62e699ac`, launch A's own record, as served on 15 October 2026 and slimmed as below. The builder of 13 October read only the list of launches, which leaves out each contract's `verifiedAt` and `verifyFailure`; the tests serve this answer beside the recording (`tape()` in `../helpers.ts`). |

The recording was written by the builder itself:

```sh
EVIDENCE_TAPE=scripts/evidence/test/fixtures/run-2026-10-13.json EVIDENCE_OUT=/some/empty/folder pnpm evidence
```

It is slimmed as it is written (`slimTape` in `../../tape.ts`): a block keeps its number, hash and
timestamp, a transaction its hash, sender, recipient and block, a receipt its status and its logs'
addresses, topics and data, and the pipeline job the beginning of its request text. Logs, contract
code and the results of calls are whole. Nothing else was changed.

On that day launch A was live and launches B and C were not, so the recording holds the logs of
three contracts: sixteen logs in thirteen transactions. The tests for launches B and C make their
logs from the contracts' ABIs instead (`../helpers.ts`).

Two more fixtures are read from where they already live: the first ten logs of `Questions` as the
indexer and the web app each saved them (`apps/indexer/test/fixtures/logs/launch-a-questions.json`
and `apps/web/test/fixtures/launch-a-questions-logs-26182869-26183622.json`). The builder must name
them as those two do.
