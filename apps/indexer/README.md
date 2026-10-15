# @help-wanted/indexer

One small TypeScript process that copies into a database the chain events and public API data
HELP WANTED's pages, bots and evidence pack read. It reads Ethereum mainnet with viem
`eth_getLogs` and a cursor, mirrors a few documents of the public IdentityMD API, and serves what
it stored through typed query functions, a read-only JSON API and deterministic snapshot files.

It only reads. It holds no key, signs nothing, sends no transaction and makes no paid or
state-changing request.

## Run it

Nothing to set up: with no configuration it uses an embedded Postgres (PGlite) in `.data/`, the
free public node, and the last 7,000 blocks.

```sh
cd "/path/to/repo" && pnpm install

pnpm --filter @help-wanted/indexer once      # one sync pass, prints what it stored
pnpm --filter @help-wanted/indexer start     # sync, mirror the API and serve http://127.0.0.1:8787
curl -s http://127.0.0.1:8787/v1/status
curl -s "http://127.0.0.1:8787/v1/jobs-report/daily?days=14"
```

Other commands (each is `pnpm --filter @help-wanted/indexer <name>`):

| Command                                       | What it does                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `once [--mirror]`                             | One sync pass, and with `--mirror` one pass over the API mirror. Exit code 2 if anything failed.           |
| `start` / `dev`                               | Run until stopped (`dev` restarts on file changes).                                                        |
| `backfill --module <name> --from <block>`     | Read an older range for one module, down to `<block>`. Interrupted, the same command continues.            |
| `skip --module <name> --to <block\|latest-N>` | Give up blocks the node no longer serves and start the module's coverage again further on (see below).     |
| `reproject [--module <name>]`                 | Rebuild modules' tables from the stored logs (after a handler or ABI changed).                             |
| `rewind --to <block>`                         | Discard everything above `<block>`; the next sync reads it again.                                          |
| `snapshot [--out <dir>] [--through <block>]`  | Write the evidence files, cut at the node's finalized block (or at `<block>`). Default `evidence/indexer`. |
| `status`                                      | Print block ranges and row counts.                                                                         |
| `migrate`                                     | Create or update the tables, then exit (every other command does this on opening the database).            |
| `db:generate`                                 | Regenerate the SQL migration after a table definition changed.                                             |

With PGlite only one process can have the database open, so stop a running indexer before using
another command, or use Postgres (`DATABASE_URL`), where they can run side by side.

`start` stops on SIGINT or SIGTERM. A request in flight, to the node or to the API, is cut off and
one waiting for its turn is let go; the pass in hand is dropped, which loses nothing, because a
block range is stored in one database transaction or not at all. Then the server and the database
are closed and the last log line is `stopped`. Should anything still hold the process up after ten
seconds, it exits anyway.

## What it indexes today

| Module          | Contract                                                                                      | Events                                    | Table                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `receipts`      | WorkRegistry `0xb6d0…a775`                                                                    | `WorkRecorded`                            | `receipts`: job id (both spellings), keccak256 of the work record, block, transaction                                                                         |
| `intake`        | Both Intake contracts: version 2 `0xa43e…de82` (current) and version 1 `0x1397…ea56` (legacy) | `Requested`, `Completed`                  | `intake_requests`: one row per request, which Intake logged it (`intake`), the body decoded (hex, text, JSON, question), who paid, the callback, how it ended |
| `fee_transfers` | IMD `0xd34a…63b7`                                                                             | `Transfer` to the fee payee `0x4e0f…adbc` | `fee_transfers`: payer, amount, block time                                                                                                                    |

and a mirror of the public IdentityMD API (`api_health`, `api_jobs`, `api_job_records`,
`api_oracle_requests`): `/health`, the newest jobs, the newest oracle requests, and for the jobs
on the watch list the whole job and its work records.

**The default range holds only recent receipts.** The default look-back is the last 7,000 blocks
(about 23 hours). IdentityMD's receipt writer wrote nothing from about 8 October 2026 until 13
October, 17:26 UTC, and writes again since; but a receipt older than the range is not in
`receipts` after a default run, and a lookup answers `latest: null` for such a job. The answer says which blocks were searched
(`coverage`), so it cannot be read as "no receipt". To index the receipts that exist, read further
back through a node that keeps old logs:

```sh
RPC_URL="https://<a node with history>,https://ethereum-rpc.publicnode.com" \
  pnpm --filter @help-wanted/indexer backfill --module receipts --from 26013352
```

### The Robot Jobs Report's unofficial tally

Counted from `fee_transfers`: per UTC day or per block window, IMD paid, payments, and distinct
payers, each split HOUSE / OUTSIDE by the published list in `evidence/house-wallets.json` (plus
any contract address configured below).

- **Every Transfer log to the fee payee is a payment, zero-value ones included, and its sender is
  a payer.** That is how the official hires feed counts (its recipe counts logs and cannot leave
  out a transfer of nothing), so the unofficial number and the official one can be put side by
  side. The cost is that anyone can add a "payment" for the price of gas; every count comes with
  `zeroValueLogs`, the number of its payments that moved no IMD, so a reader can take them out.
- Every day of the indexed range is listed, a day on which nobody paid as zeros. A day outside the
  range is absent. A day is marked `complete` only when the range spans all of it.

## HELP WANTED's own contracts

Their addresses come from one place: the deployments book of the shared package
(`packages/shared/src/deployments.ts`), which the bots and the web app read too. A launch written
there brings its addresses and its block, and the indexer starts that launch's modules at that
block on its next start. Nothing has to be configured, and a module whose contract has no address
in the book stays idle.

For each contract there is a module, a cursor and tables (`feeds`, `rounds`, `prints`,
`payroll_movements`, `orders`, `claims`, `pots`, `chips`, `rules`); Doorbell, Endowments and Zap
have a module that keeps their logs without a table.

**Launch A is on mainnet and its three modules are finished.** `questions`, `jobs_report` and
`payroll` decode every log with the ABI the shared package generates from the launch project's
build output and fold them: feeds and their rounds, the Jobs Report's prints, Payroll's ledger.
Each module's file header lists which event goes where, and which events are kept in `events`
without a table and why; a test fails when the ABI has an event that is in neither list.

| Module        | Contract   | Folded into                                                                                                                              |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `questions`   | Questions  | `feeds` (creator, parameters, text, meter totals, newest answer), `rounds` (window, price, tip, keeper, state, answer, who delivered it) |
| `jobs_report` | JobsReport | `prints` (amount, window, running total, streak, the count once attached, best day)                                                      |
| `payroll`     | Payroll    | `payroll_movements`: one row per movement of IMD, by kind                                                                                |

**The handlers of launches B and C are stubs.** Launch B (WorkOrders, CrowdPots, Doorbell) has been
on mainnet since 13 October 2026, so its events are final, but its handlers are not written yet;
the same holds for launch C (Rules, Endowments, Zap), on mainnet since 15 October 2026. From the moment such a contract has an
address, every log of it is stored in `events` with its raw topics and data (undecoded, from the
launch block on), but nothing is folded into its tables: there is no row in `orders`, `claims`,
`pots` or `chips` however many orders and pots exist on chain. So that an empty
table is never read as "nothing happened", every answer about such a table says
`"handler": "stub"`: the status route, the `coverage` of each route, and each snapshot file (whose
description begins with NOT INDEXED YET). Finishing one is three steps and loses no data (see
`src/modules/own/stub.ts`): set the module's `abi` to the generated one, replace `stubHandler()`
with the fold its file header describes, run `reproject --module <name>`.

A finished module that has indexed nothing (its contract has no address in the configuration at
hand) says so too: its coverage has `throughBlock: null`, and its snapshot file's description
carries NOT INDEXED.

**The environment can name a contract instead of the book**, for a fork, a rehearsal or a contract
the book does not hold yet: `ADDR_WORK_ORDERS=0x…@26170000` (or the block on its own in
`START_BLOCK_WORK_ORDERS`). The address replaces the book's. It must come with the block the
contract was deployed in: an order exists in the tables only because its `OrderOpened` was read, so
a module must read its contract from the first event, and started from the default look-back it
would skip everything older than a day without a word. An address without a block is refused at
start-up; the book's block is not borrowed for an address the book did not give. If the block is
older than what the node serves, the module stops with a message and stores nothing: point
`RPC_URL` at a node with history.

### Adding a contract

A contract is one file under `src/modules`: an ABI, a handler and the tables the handler writes
(`src/engine/module.ts` is the contract; `src/modules/workRegistry.ts` is the shortest example).
List it in `src/modules/index.ts`, export its tables from `src/db/schema.ts`, run `db:generate`.

## How it works

- **A cursor per module, and coverage.** `cursors` holds, per module, one unbroken block range
  `[start_block, next_block)` whose logs have all been read: the module's coverage. The module's
  tables hold exactly what that range holds. Each module is its own small indexer, so adding one
  never disturbs the others and one failing does not stop the rest. The cursor is written with the
  first range that is stored, not before, so a first run that the node refuses leaves nothing
  behind.
- **Each log once.** A log is stored in `events` under `(module, tx_hash, log_index)`. Reading a
  range again inserts nothing. The module's tables are a fold of its events: the handler runs
  exactly once per stored event, in chain order, in the same database transaction that stores the
  event and moves the cursor. Tables with one row per log are also keyed by
  `(tx_hash, log_index)`.
- **A log the handler cannot fold does not stop the module.** The handler runs inside a savepoint.
  If it throws, what it wrote for that log is undone, the reason is kept on the event
  (`events.fold_error`) and the module reads on. Such logs are counted as `unfolded` in the status
  route, in every route's `coverage` and in the snapshot's `coverage.json`; the status route says
  `ok: false` while there is one; `reproject` tries them again. Without this, one log (anyone can
  emit one through the Intake for 0.5 IMD) could stop a module on its block for good.
- **Reorganisations.** Every stored log carries the hash of its block. The first `eth_getLogs` of
  each sync also covers the last `REORG_DEPTH` blocks already stored (64 by default), and that part
  of the answer is compared with the database. A stored log that is gone, or sits in a block with
  another hash, or a log that the chain now has and the database does not, means the chain was
  reorganised: everything from the first differing block up is deleted for every module, the
  cursors go back, the affected tables are rebuilt from the events that remain, and the range is
  read again. The comparison costs no extra request. The same re-read repairs an answer that a
  node gave while it was a few blocks behind.
- **Node limits.** A range the node refuses as too large is halved until it is accepted, down to
  one block; the size that worked is kept and tried again at double after ten clean requests. A
  node that refuses because it does not keep old history is not asked again with a smaller range.
  It is asked the same thing once more, because the free node's machines do not always agree on
  what they keep (below); if it refuses again the module stops with a message that says what to
  do, and the others carry on.
- **A failing module waits; the others do not.** The first two failed passes of a module are tried
  again at once. From the third the module is left alone for 2, 4, 8… poll intervals, at most
  five minutes, while the healthy modules keep their cadence. Only a pass that cannot read the
  head at all slows the whole loop.
- **Nothing a node says is stored unchecked.** Every field of a log must have the shape of what it
  claims to be (an address, a 32-byte word, hex data, a timestamp a mainnet block can carry), and
  a log from another address or from outside the requested range drops the whole answer. The fee
  handler checks the recipient again itself.
- **Text from outside is data.** Request bodies, job objectives and URIs are written by other
  people. They are stored and served as data; no URL found in them is ever fetched. Characters
  Postgres cannot store are replaced in the decoded copy, and the raw bytes are kept. JSON nested
  deeper than 32 levels is not kept as JSON (a real body is two or three levels deep; a body can
  hold 8,000 nested brackets, which exist only to exhaust the stack of whatever walks them): the
  Intake body's hex and text are stored and `body_json` is left null; an API document that deep is
  skipped. Nothing in the package walks a JSON value past 64 levels.
- **What leaves the process.** Logs are for the operator: an error is one line, cut to 600
  characters (200 for the part a node or driver wrote), and anything that looks like a credential
  in the configuration (the path and query of an RPC URL, a database password) is cut out of every
  line. The public status route shows less: only sentences this package or viem wrote, never the
  text of a node's answer.

### When the node no longer serves the blocks a module needs

The free node serves about the last 9,000 blocks of logs (some 30 hours). A process that was off
for longer comes back with its cursor below that, and the module stops with a message. Two ways on:

1. Point `RPC_URL` at a node that keeps old logs. The module continues where it stopped.
2. `skip --module <name> --to latest-7000` (or `--to <block>`): give up the blocks in between.
   Coverage must stay one unbroken range, so the old range is taken off the books: coverage starts
   again at the new block, the module's tables are emptied and fill from there, and the logs
   already stored stay in `events`, outside coverage, counted as `eventsOutside` and shown in no
   list. Nothing is deleted. A later `backfill --module <name> --from <the old start>` through a
   node with history reads the hole and brings the whole range back.

`START_BLOCK` and `START_BLOCK_<MODULE>` apply to a module's first run only; once something is
stored, the cursor decides.

## Configuration

Environment variables; all optional. `.env.example` lists them.

| Variable                                                                                                                                                  | Default                               | Meaning                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                                                            | unset                                 | Postgres connection string. Unset: PGlite in `PGLITE_DIR`.                                                                                                                                                                                                           |
| `PGLITE_DIR`                                                                                                                                              | `.data/pglite`                        | Folder of the embedded database.                                                                                                                                                                                                                                     |
| `RPC_URL`                                                                                                                                                 | `https://ethereum-rpc.publicnode.com` | One URL, or several separated by commas in order of preference; a request one node refuses is tried on the next.                                                                                                                                                     |
| `START_BLOCK`                                                                                                                                             | `-7000`                               | Where a module begins on its first run: a block number, or `-N` for N blocks behind the head.                                                                                                                                                                        |
| `START_BLOCK_<MODULE>`                                                                                                                                    | unset                                 | The same for one module, e.g. `START_BLOCK_INTAKE=26142962`. Anything older than about 9,000 blocks needs a node with history (see below).                                                                                                                           |
| `CHUNK_SIZE`                                                                                                                                              | `2000`                                | Widest block range per `eth_getLogs`.                                                                                                                                                                                                                                |
| `CONFIRMATIONS`                                                                                                                                           | `2`                                   | Blocks the indexer stays behind the head.                                                                                                                                                                                                                            |
| `REORG_DEPTH`                                                                                                                                             | `64`                                  | Already-stored blocks read again on each sync.                                                                                                                                                                                                                       |
| `POLL_INTERVAL_MS`                                                                                                                                        | `12000`                               | Pause between sync passes.                                                                                                                                                                                                                                           |
| `ADDR_QUESTIONS`, `ADDR_JOBS_REPORT`, `ADDR_PAYROLL`, `ADDR_WORK_ORDERS`, `ADDR_CROWD_POTS`, `ADDR_DOORBELL`, `ADDR_RULES`, `ADDR_ENDOWMENTS`, `ADDR_ZAP` | unset                                 | Normally unset: the addresses come from the shared deployments book. `<address>@<deployment block>` replaces the book's entry for one contract (a fork, a rehearsal); the block is required (or `START_BLOCK_<MODULE>`). Every contract of ours is counted as HOUSE. |
| `HOUSE_WALLETS_FILE`                                                                                                                                      | `../../evidence/house-wallets.json`   | The published house list. Empty string: no list.                                                                                                                                                                                                                     |
| `API_MIRROR`                                                                                                                                              | `true`                                | Mirror the public IdentityMD API.                                                                                                                                                                                                                                    |
| `API_BASE`                                                                                                                                                | `https://api.imd.fun`                 |                                                                                                                                                                                                                                                                      |
| `API_CALLS_PER_MINUTE`                                                                                                                                    | `12`                                  | All routes together. Values above 19 are refused.                                                                                                                                                                                                                    |
| `WATCH_JOBS`                                                                                                                                              | unset                                 | Job UUIDs to mirror in full, separated by commas. Jobs registered on our orders are added automatically.                                                                                                                                                             |
| `HTTP` / `HOST` / `PORT`                                                                                                                                  | `true` / `127.0.0.1` / `8787`         | The read-only API. Set `HOST=0.0.0.0` in a container.                                                                                                                                                                                                                |
| `LOG_LEVEL`                                                                                                                                               | `info`                                | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr.                                                                                                                                                                                                   |

## What a full backfill needs

The default node serves recent logs only. Measured on 10 October 2026: `ethereum-rpc.publicnode.com`
answered `eth_getLogs` for a range 9,000 blocks behind the head and refused ranges 12,000 or more
behind it with "Archive requests require a personal token", so about a day to a day and a half of
history. The default look-back of 7,000 blocks stays inside that. The pool behind that URL is not
uniform, though: on 11 October one request for a range 7,000 blocks behind the head was refused
with the same message while requests for the same blocks before and after it, and for ranges 9,000
blocks behind, were served. That is why a refusal for missing history is asked about once more
before it is believed. Anything older needs a node that keeps and serves old logs:

- a keyed provider (Alchemy, Infura, QuickNode, a publicnode token, your own node), set first in
  `RPC_URL`; the public node may stay second as a fallback;
- or, for the small histories below, a free node that happens to serve them. On the same day
  `rpc.mevblocker.io` served 2,000-block ranges up to 33,000 blocks behind the head without a key
  (it refused a 20,000-block range), `cloudflare-eth.com` capped a query at 800 blocks, and drpc's
  free plan refused old ranges. None of that is a promise; the halving copes with the caps.

How much there is to read (creation blocks are in `src/constants.ts`):

| Module          | From block                                                                        | Blocks to head on 10 Oct | Requests at `CHUNK_SIZE=2000`       |
| --------------- | --------------------------------------------------------------------------------- | ------------------------ | ----------------------------------- |
| `intake`        | 26,142,962 (the legacy Intake created; version 2 is younger, so this holds both)  | about 22,000             | 11                                  |
| `receipts`      | 26,013,352 (WorkRegistry created)                                                 | about 152,000            | 76                                  |
| `fee_transfers` | 23,501,863 (IMD created; the first payment is later, the block is not known here) | about 2,663,000          | 1,332, or 267 at `CHUNK_SIZE=10000` |

```sh
export RPC_URL="https://<your keyed node>,https://ethereum-rpc.publicnode.com"
pnpm --filter @help-wanted/indexer once                                   # the first sync
pnpm --filter @help-wanted/indexer backfill --module intake --from 26142962
pnpm --filter @help-wanted/indexer backfill --module receipts --from 26013352
pnpm --filter @help-wanted/indexer backfill --module fee_transfers --from 23501863
```

A backfill reads from `--from` up to where the module already starts. It stores the logs range by
range, each time noting how far it has got, and they stay outside the module's coverage (in no
table, in no list) until the whole range is in. Only then, in one transaction, is `start_block`
lowered and the module's tables rebuilt in chain order. So an interrupted backfill changes nothing
a reader can see, whatever is rebuilt in the meantime, and the same command (the same `--from`)
continues where it stopped; `status` shows it as `backfill: {fromBlock, nextBlock}`. On a fresh
database, setting `START_BLOCK_<MODULE>` before the first run does the same thing without a
separate command. A real backfill of the legacy Intake's whole history as it stood on 10 October (8 requests, 13 logs) and of three
days of receipts (282 logs, 14 requests) through the public node with `rpc.mevblocker.io` as the
second URL took 8 and 12 seconds. A rebuild folds about 2,000 events a second on the embedded
database.

## Read-only API

`GET /v1` lists the routes. All answers are JSON, CORS `*`, amounts as decimal strings of wei.
Anything but GET, HEAD and OPTIONS is refused with 405.

Every answer about chain data carries `coverage`: the module it was read from, whether that
module's handler is finished (`handler: "ready"` or `"stub"`), the inclusive block range that has
been indexed (`fromBlock`, `throughBlock`, with their times; null while nothing is), and
`unfolded`, the number of logs in that range missing from the rows because the handler could not
fold them. An empty answer means "nothing in that range", never "nothing on chain".

| Route                                                                                       |                                                                                                                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/status`                                                                                | See below.                                                                                                                                    |
| `/v1/receipts`, `/v1/receipts/:job`                                                         | Receipts in the indexed range, newest first; all receipts of one job by UUID or `0x` bytes16, with `latest` (null when the range holds none). |
| `/v1/intake/requests`, `/v1/intake/requests/:id`                                            | Oracle requests bought on chain through either Intake; `intake` names the contract. `?payer` `?callbackTarget`                                |
| `/v1/fee-transfers`                                                                         | Transfers to the fee payee, labelled HOUSE or OUTSIDE. `?fromBlock` `?toBlock` `?from`                                                        |
| `/v1/jobs-report/daily?days=14`                                                             | The unofficial tally per UTC day.                                                                                                             |
| `/v1/jobs-report/window?fromBlock=&toBlock=`                                                | The tally of one block window with its top payers, and whether the window is fully indexed.                                                   |
| `/v1/orders`, `/v1/orders/:id`                                                              | Orders and their claims. `?state` `?employer`                                                                                                 |
| `/v1/feeds`, `/v1/feeds/:feed/rounds`, `/v1/rounds`, `/v1/prints`, `/v1/payroll/movements`  | Launch A's tables, folded from its contracts' logs (`handler: "ready"`).                                                                      |
| `/v1/pots`, `/v1/pots/:id`, `/v1/rules`                                                     | The tables of launches B and C (`handler: "stub"`: not filled yet).                                                                           |
| `/v1/events?module=&event=`                                                                 | Stored logs inside each module's coverage, raw and decoded; `foldError` on a log its handler could not fold.                                  |
| `/v1/mirror/health`, `/v1/mirror/jobs`, `/v1/mirror/jobs/:id`, `/v1/mirror/oracle-requests` | The API mirror.                                                                                                                               |

Lists take `?limit` (1 to 1000, default 100).

### `/v1/status`

Per module: block range, handler state, `blocksBehind`, `events`, `unfolded`, `eventsOutside`, an
unfinished `backfill`, the last error and, while the module is being left alone after repeated
failures, `retryInSeconds`. Then row counts and the age of the mirror.

`ok` is true only when all of these hold:

- the last sync pass synced every module (a pass that could not read the head, or that left a
  failing module waiting, is not such a pass);
- that pass ended less than 240 seconds ago (the time the chain takes to add 20 blocks), or three
  poll intervals if that is longer: a loop that hangs fails nothing, and this is what gives it away;
- no enabled module is more than 20 blocks behind. `blocksBehind` is measured against the head the
  node last reported, plus one block for every 12 seconds since (`headAgeSeconds`), so an outage
  shows as modules falling behind instead of as "0 blocks behind the last head we saw";
- no enabled module has a log its handler could not fold.

`lastPassError` and each module's `lastError` are in words safe to publish (see "What leaves the
process"); the full text is in the process log. `mirror.ok` reports separately whether `/health`
was copied in the last ten minutes; it does not enter `ok`, which is about the chain.

## Query functions

```ts
import { createQueries, openDatabase } from "@help-wanted/indexer";

const { db, close } = await openDatabase({ databaseUrl: process.env.DATABASE_URL });
const q = createQueries(db, { house: ["0x871e507B6a70F858Ad4B414bddb77473630C366b"] });

const receipt = await q.jobReceipts("e9efec16-56f3-40d3-9243-52c453effc7d");
// { jobId, latest, receipts, coverage }: latest is null when the indexed range holds none,
// and coverage says which blocks that range is.
const report = await q.jobsReportDaily({ days: 14 }); // DayTally[]: bigint wei, HOUSE / OUTSIDE
const window = await q.jobsReportWindow({ fromBlock, toBlock }); // to put beside an official print
const bought = await q.intakeRequests({ callbackTarget: questionsAddress });
const orders = await q.source("work_orders"); // { handler: "stub", fromBlock, throughBlock, … }
```

`src/queries.ts` has the full list with the row types. Table definitions are exported from
`@help-wanted/indexer/schema`; the tally arithmetic (`tallyByDay`, `tallyAll`, `rankPayers`,
`formatImd`) is exported as pure functions.

## Snapshot

`snapshot` writes one JSON file per table plus `jobs-report.json`, `coverage.json` and
`manifest.json` (a SHA-256 per file) into `evidence/indexer` at the root of the repository, or into
`--out <dir>`. The files are deterministic: lists ordered by key, object keys sorted, amounts as
strings, no time of writing. The same database contents give the same bytes. Files marked `chain`
in the manifest depend only on Ethereum logs, so anyone indexing the same block range gets the same
file; files marked `api` are copies of what the IdentityMD API served and carry the time each was
fetched. Each chain file names its module and `handler`; an empty file of a module whose handler is
a stub says so in its description.

**A snapshot is cut at a block that can no longer change.** The indexer follows the chain two
blocks behind its head, and a block that recent can still be replaced; the running process repairs
its database when that happens, but a published file stays as it is. So the command asks the node
for its finalized block and cuts there: no chain file holds anything above it, and `coverage.json`
and the manifest name the block, its hash and its time. The store as of that block is rebuilt, not
filtered (a request answered after the cut reads as unanswered): the tables of every module with
logs above the cut are folded again from the logs up to it, inside a transaction that is rolled
back, so the database is left as it was. `--through <block>` names the cut yourself, for a snapshot
without the node (the block's hash is then left out) or at a block of your choosing; a block that
is not final yet is accepted with a warning.

With PGlite, stop the indexer first. With Postgres the snapshot can run beside it: it reads one
consistent state of the database (one "repeatable read" transaction). Should the indexer change a
row at the very moment the snapshot is rebuilding it, the command stops with a serialization error
before writing anything, and is simply run again.

## Manners towards the IdentityMD API

`api.imd.fun` allows 120 public reads a minute per address, shared by everything we run. The
mirror sends one request at a time with a fixed gap (12 a minute by default, never more than 19),
and on 429, 502, 503 or 504 stops the whole queue for as long as `Retry-After` asks, or 5, 10,
20… seconds when it does not say, capped at five minutes. A visitor's request is never passed on
to the API.

Health and the job list are polled each minute, oracle requests every two. They come first: the
headline numbers do not depend on how long the watch list is. Watched jobs (two requests each)
take what is left of the budget, the one that has waited longest first, and give way as soon as a
list is due again. How often a watched job is looked at depends on how fast it can still change:
every five minutes while it is being worked on; every half hour once it has ended but a receipt is
still to be written (while the receipt writer is stalled that is every ended job, and some
completed jobs never get a record); hourly once every record is written or failed. A job that
cannot be read (an id the API answers 404 for) is asked for less and less often: 10, 20, 40…
minutes apart, up to six hours.

## Tests

```sh
pnpm --filter @help-wanted/indexer typecheck
pnpm --filter @help-wanted/indexer test
```

No test touches the network. The node is a class in memory behind a real viem client
(`test/helpers/fakeNode.ts`), the database is PGlite in memory with the real migrations, and the
API is a scripted `fetch` with a made-up clock. A setup file makes `fetch` and socket connections
throw, so a test that reached for the network would fail. The logs the handlers are tested against
are real ones, recorded once from mainnet by `scripts/record-fixtures.ts` (see
`test/fixtures/README.md`): five WorkRegistry receipts including that of job `e9efec16-…`, all 13
logs of the legacy Intake from its creation to 10 October, the 94 IMD transfers to the fee payee of
a 7,000-block window, and every log of our Questions contract from its launch block to the first
three requests (13 October 2026). What is launched is injected in tests, never assumed: a test
builds its configuration from a book with nothing launched, with launch A only, or with all three.

### On a Postgres server

Production runs on a Postgres server through another driver (node-postgres) than the embedded
database uses. The same suite runs on that path when it is pointed at a server on the same
machine, for example a CI service container:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  pnpm --filter @help-wanted/indexer test
```

Each test file creates a database of its own on that server and drops it afterwards (the role
must be allowed to create databases). Only a socket to that server's port on the loopback address
is let through; everything else stays refused. On 11 October 2026 the whole suite passed this way
against PostgreSQL 18.4, the snapshot of the same recorded logs was byte-identical between the two
engines, and `migrate`, `once`, `backfill`, `reproject`, `rewind`, `skip` and `snapshot` were run
against that server with real mainnet data.

## Limits

- Mainnet only: every address is a mainnet constant and the process refuses another chain id.
- The handlers of launches B and C are stubs (above). Launch A's are finished. Launch B is
  launched, so until its handlers are written the indexer holds its raw logs and no table of
  orders, claims, pots or chips.
- The orders routes (`/v1/orders`) belong to launch B and are stubs like the rest of it: they
  answer with `handler: "stub"` and an empty list, which is not a count of orders.
- A reorganisation deeper than `REORG_DEPTH` is not noticed on its own. If a stored log later
  turns up in a block with another hash, the module stops with a message asking for `rewind`.
- A node that returns an incomplete answer without an error is believed. Two confirmations and
  the re-read of recent blocks cover a node that is briefly behind; they cannot cover one that
  withholds logs for good. Use a node you trust for the evidence pack.
- The tally counts payments, not hires: a schedule top-up or a launch fee is a payment too, a
  payer can split one payment into many, and a transfer of nothing counts as one (above). The
  official numbers come from the oracle feeds.
- `body_json` is a convenience copy: its numbers are JavaScript doubles. Exact digits are in
  `body_text`, exact bytes in `body_hex`.
- A database written by a version before the 32-level rule can hold a deeper `body_json`; a route
  that meets one answers 500 and the snapshot refuses to write. `reproject --module intake`
  rewrites such rows.
- Addresses, the deployments book and the ABIs of launch A come from `@help-wanted/shared`;
  `src/constants.ts` re-exports them under the names the modules use. The WorkRegistry, Intake and
  Transfer event signatures the three external modules decode are still written out in those
  modules (a test holds each topic against its signature).
- Artifacts (job result files) are not copied; the design's bucket is not part of this package.
