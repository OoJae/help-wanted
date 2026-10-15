# HELP WANTED runner

The runner is the bot that turns an order on the HELP WANTED hire desk into a job for the
IdentityMD swarm, and collects when the job is done.

A contract cannot buy a swarm job by itself: IdentityMD takes payment for jobs through x402, which
needs an ordinary wallet's signature. So an employer (a wallet, a contract, a crowd pot) escrows IMD
on the desk, and a runner does the buying:

1. it posts a small bond and **claims** the order;
2. it **pays the swarm 0.5 IMD** to open the job, with the order's 85-byte header at byte 0 of the
   objective and the order's spec right after it;
3. it **registers** the job id on the desk;
4. when the job is completed it **collects**: with the job's on-chain receipt (`settle`), or, if the
   employer allowed it and no receipt is on chain, with a bonded delivery claim that pays after a
   24 hour challenge window (`claimDelivered`, then `finalize`), and it marks that order proven
   (`stamp`) when the receipt lands later.

The runner is paid 90% of the order's price and gets its bond back. Anyone can run one.

> **Status.** The code is tested against fixtures, against the x402 libraries themselves, and, with
> the keeper, against the real contracts of all three launches on a local node, where a stand-in
> for IdentityMD checks both of its signatures. **It runs live.** On 13 and 14 October 2026 the
> team's runner took order 1 of the launched desk, paid IdentityMD 0.5 IMD for the job, and was
> paid on the job's receipt
> ([What is verified, and what is not](#what-is-verified-and-what-is-not) has the transactions).
> Since 15 October 2026, 14:18 UTC, the team's runner has run around the clock on a hosted server
> (Railway, [Docker and hosting](#docker-and-hosting)), signing as the team's wallet H1. It takes
> orders from any employer, one order at a time, pays at most one 0.5 IMD swarm fee a day, posts
> bonds of at most 0.25 IMD, and takes `skill:research-report` and `skill:create-image` jobs. By
> block 26,198,957 (15 October 2026, 15:57 UTC) order 1 was still the one order it had taken. Read
> [What can cost you money](#what-can-cost-you-money) before going live.

## Safe by default

With no configuration beyond the desk's address the runner is a **dry run**. It reads the chain and
IdentityMD's public API, decides what it would do with each order, and prints it. It signs nothing,
sends no transaction and makes no POST request, the protocol's free preflight included (set
`DRY_RUN_PREFLIGHT=1` if you want a dry run to ask that one free question).

It goes live only when `LIVE=1`, `RUNNER_PRIVATE_KEY` and `START_BLOCK` are all set.

- The key is read from the environment at start. The runner never writes it to disk, never logs
  it, and never creates one.
- In a dry run no account object is built at all, even if a key is present.
- In a live run two objects hold the account, and the key text is dropped from the configuration
  once they are built:
  - the **guarded signer**, which is all the payment library is given. It signs exactly two kinds
    of typed message (the Permit2 payment and IdentityMD's quote approval), only with values the
    runner has checked, and each only once. It has no method to sign a transaction or an arbitrary
    message.
  - the **wallet client**, which signs the runner's own transactions. Only `src/chain.ts` uses it.
- Every transaction goes through that one module, which simulates it first, refuses a network fee
  above your cap, refuses a transaction that would cost more than your limit, and sends one at a
  time.
- A kill switch stops every payment and every transaction at once.

## Quick start: a dry run

You need Node 22 or newer and pnpm 11.

```sh
git clone <this repository> && cd <it>
pnpm install

export WORK_ORDERS=0x...        # the hire desk (the WorkOrders contract)
export RPC_URL=https://...      # an Ethereum mainnet RPC; use a keyed provider

pnpm --filter @help-wanted/runner once      # one pass, then exit
pnpm --filter @help-wanted/runner start     # keep going; Ctrl-C stops after the current step
```

Instead of exporting variables you can copy `bots/runner/.env.example` to `bots/runner/.env` and
fill it in: the pnpm scripts hand that file to Node (`--env-file-if-exists=.env`), which puts it in
the environment before the runner starts. The runner itself reads the environment and nothing else.

Each line of output is one JSON object. A dry run that finds an order it would take prints the plan:

```json
{
  "level": "info",
  "msg": "dry run: would take this order",
  "order": "12",
  "steps": [
    "preflight POST /requests/check for a skill:research-report job (free)",
    "quote the job and read its payment challenge; go on only if both pass every check",
    "claim(12), posting a bond of 250000000000000000",
    "pay the swarm 500000000000000000 for job.open with the objective below",
    "register(12, jobId) once the job has completed, or before the claim window ends",
    "settle with the receipt, or claimDelivered and finalize when the order allows it"
  ],
  "preflight": "not asked (set DRY_RUN_PREFLIGHT=1 to ask the free preflight in a dry run)",
  "price": "3000000000000000000",
  "runnerPay": "2700000000000000000",
  "objective": "[help-wanted order 87a4…9571] Write a sourced report on …"
}
```

An order it would not take is logged once with the reason (`order not taken`).

## What can cost you money

Read this before you fund a runner. Amounts are with the defaults: a bond of 0.25 IMD (the desk's
minimum) and the swarm's fee of 0.5 IMD.

| What happens                                                                       | What it costs                                                                                 |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The job is bought.                                                                 | 0.5 IMD to IdentityMD. Never refunded, whatever becomes of the job.                           |
| The runner gives a claimed order back (`release`) before registering a job.        | A tenth of the bond, to the employer. The runner may not take that order again.               |
| No job is registered within one hour of the claim and somebody removes the runner. | The whole bond, to the employer.                                                              |
| A job is registered and no record settles the order by its delivery deadline.      | The whole bond, to the employer, and the fee already paid.                                    |
| A delivery claim is contradicted by a receipt of the registered job.               | The whole bond: to the employer, or mostly to the challenger if the claim was challenged.     |
| A delivery claim is challenged and nothing decides it by the delivery deadline.    | A tenth of the bond; the employer is refunded, so the runner is not paid and the fee is lost. |
| The job's receipt shows another kind than the order pins (a wrong template).       | The fee. The bond comes back once the receipt is on chain; anyone may report it.              |
| Every transaction.                                                                 | Gas, in ETH. A settlement must be sent with about two million gas and uses about 0.6 million. |

The ways a registered order ends without a settling record, and what the runner does about each:

- **The job ends blocked.** With the job's receipt on chain the runner reports it
  (`reportFailed`) and gets its whole bond back. Without a receipt it cannot. IdentityMD's receipt
  writer stalled from about 8 to 14 October 2026, so this is the case to plan for. The runner
  therefore **does not register a job at once**: it watches the job and registers it when it has
  completed, or fifteen minutes before the claim window ends. A job that ends blocked before that
  is given back for a tenth of the bond. `REGISTER_AT_ONCE=1` turns this off. With
  `MAX_JOBS_PER_ORDER=2` (and an `ORDER_CAP_IMD` that covers two fees) the runner instead buys one
  more job for a claim whose first job blocked after registration.
- **The employer chooses the job.** The employer writes the spec and, for an audit, names the
  repository. An employer who expects the job to fail receives the runner's bond when it does.
  This is why the defaults are a bond of the desk's minimum, one kind of job
  (`skill:research-report`, not `audit`), a price that must cover an allowance for failures
  (`EXPECTED_FAILURE_BPS`), and no further orders from an employer whose order cost a bond
  (`MAX_EMPLOYER_LOSSES`). For a hosted runner, list the employers you serve in `EMPLOYERS`.
- **A completed job has no work record.** This has been observed on real jobs. Without a record
  there is nothing to settle with and nothing to claim delivery of. The runner says so and waits;
  the bond is lost at the deadline.
- **Receipts stop while an order can only be paid on one.** An order whose employer did not allow
  the bonded claim pays on a receipt or not at all. The runner takes such an order only while the
  WorkRegistry is writing receipts (see
  [Orders that only a receipt can pay](#orders-that-only-a-receipt-can-pay)), but receipts can stop
  after the claim: the bond is then forfeited at the delivery deadline, with the fee.
- **The record is too large for one transaction, or for the gas limit.** Real audit records run
  from 72 KB to 255 KB; a node refuses a transaction above 128 KB, and `settle` carries the whole
  record at 16 gas a byte before the desk has read any of it. The runner sends no settlement that
  needs more than `MAX_SETTLE_GAS` (the limit comes from an estimate, never from a figure set by
  hand). It claims delivery instead (32 bytes), and does not take an order of a kind whose records
  have been seen too large for that limit unless the order allows the bonded claim. If such a claim is then challenged, only the chunked proof
  (`WorkProof.proveChunks`, which stores the record in data contracts at a cost of tens of millions
  of gas) can win it. The runner does not send that; it tells you, at `error`, that it is needed.
- **A challenge while receipts are late.** A challenger gets its own bond back when nothing decides
  the dispute, so while no receipt can land a true delivery claim can be kept from being paid at no
  cost to the challenger. The runner then loses the fee and a tenth of the bond. An order with an
  arbiter you trust (`ARBITERS`) is the answer to that; by default the runner takes no order that
  has an arbiter, because an arbiter it does not know could decide against a true claim.
- **The runner is down or cannot send.** A claim with no job registered after an hour, or a
  registered job past its deadline, costs the whole bond. Do not stop a live runner for long while
  it holds orders, give it a keyed RPC, and keep ETH in the wallet. The calls that protect a bond
  have their own, higher gas limits (`URGENT_MAX_FEE_GWEI`).

What bounds the total: `MAX_BOND_IMD` per order, `MAX_BONDS_AT_RISK_IMD` over all orders held,
`MAX_CONCURRENT`, `ORDER_CAP_IMD` and `DAILY_CAP_IMD` for the swarm's fees, and the wallet's own
balance. The runner calls only functions anyone may call, so a leaked key loses what the wallet
holds and nothing else.

With the defaults an order must pay the runner at least 0.5875 IMD: the 0.5 fee, the 0.05 margin,
and 5% of the 0.75 IMD a failure after registration costs. At a price of 0.66 IMD the runner's 90%
is 0.594. Set `EXPECTED_FAILURE_BPS` to the share of jobs you actually see fail.

## Going live

1. **Make a wallet for the runner only.** Make it yourself (`cast wallet new`, a hardware wallet
   export, your platform's key tool). Keep it small: it needs ETH for gas and enough IMD for the
   bonds and the 0.5 IMD fees of the orders it holds at once. With the defaults, 0.03 ETH and
   3 IMD is plenty. The wallet must be an ordinary account (or an EIP-7702 account): IdentityMD
   does not take payment from contract wallets such as a Safe.
2. **Give it storage that survives a restart.** `STORE_PATH` (default `./data/runner.json`) holds
   what the runner has signed and where each order stands. On a hosting platform mount a
   persistent volume there; a container's own filesystem is gone at the next deploy.
3. **Set `START_BLOCK`** to the block the desk was deployed in, and **`IMD_PAID_TOKEN`** to 64 hex
   characters of your own (`openssl rand -hex 32`). With those two, a runner whose store was lost
   finds every order it holds again on chain and every job it paid for through the protocol. See
   [If the store is lost](#if-the-store-is-lost).
4. **Approve Permit2 once.** IdentityMD settles the fee through Permit2, so Permit2 needs an IMD
   allowance from the runner. This sends one transaction, `IMD.approve(Permit2, PERMIT2_ALLOWANCE_IMD)`:

   ```sh
   LIVE=1 START_BLOCK=... RUNNER_PRIVATE_KEY=0x... pnpm --filter @help-wanted/runner bootstrap
   ```

   (Without `LIVE=1` it only says what it would send.) The bond allowance to the desk is handled
   order by order: the runner approves exactly the bond before each claim.

5. **Check where you stand.** `pnpm --filter @help-wanted/runner status` prints the wallet's ETH and
   IMD, both allowances, the orders in hand and the bonds posted, and warns when Permit2's allowance
   covers fewer fees than `MAX_CONCURRENT`.
6. **Run it**, with the key supplied by your secret manager:

   ```sh
   LIVE=1 START_BLOCK=... RUNNER_PRIVATE_KEY=0x... pnpm --filter @help-wanted/runner start
   ```

Watch the first order all the way through, with one small order of your own.

### Stopping, and starting again

- **Ctrl-C / SIGTERM**: finishes the step in hand and exits. Start it again and it resumes.
- **Kill switch**: set `KILL_SWITCH=1`, or create the file `data/runner.json.KILL` (see `KILL_FILE`)
  while it runs. From the next step on it makes no payment and sends no transaction; it keeps
  reading. Remove the file to carry on.
- **The breaker**: when `MAX_PAY_FAILURES` payments in a row end without a usable job after a bond
  was posted, the runner stops claiming and says so at `error`. Each such failure costs a tenth of a
  bond, and a cause that repeats would repeat on every order. It keeps working on the orders it
  holds. When you know the cause, `pnpm --filter @help-wanted/runner resume` clears it.

A stopped runner still holds what it holds; see the last point of
[What can cost you money](#what-can-cost-you-money).

### If the store is lost

The chain holds what is needed to finish an order: the desk's `claimOf` has the job id, the hash
that was named and the times. A runner that starts with an empty or replaced store:

- reads the desk's logs again from `START_BLOCK`, and looks first at the orders its own `Claimed`
  logs name;
- takes up every order it holds on chain, in whatever state: claimed, registered, delivery claimed,
  or challenged;
- for a claim it finds with no saved payment, asks IdentityMD's public
  `GET /requests/paid-by/<wallet>` whether a job was already bought for that claim (the job's
  objective carries the claim's ticket, so a match cannot be another claim's job) and uses it
  instead of paying again.

What is lost with the store: the signed bytes of a payment that was in flight, and the request
token unless `IMD_PAID_TOKEN` was set. Without the token the status of a paid order cannot be read;
the runner then finds the job through the public route above, and says so.

If the store file is damaged, do not simply delete it: read the message the runner prints.

## Configuration

All configuration is environment variables. `.env.example` lists every one; a test fails if the two
drift apart.

| Variable                        | Default                               | Meaning                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORK_ORDERS`                   | none, required                        | The hire desk's address.                                                                                                                                                                                    |
| `RPC_URL`                       | `https://ethereum-rpc.publicnode.com` | Ethereum mainnet RPC. Public nodes serve logs only for about the last 9,000 blocks: use a keyed provider. Never logged.                                                                                     |
| `START_BLOCK`                   | none; required to go live             | The block the desk was deployed in. A dry run without it starts 5,000 blocks back.                                                                                                                          |
| `LIVE`                          | unset                                 | `1` to go live. Needs `RUNNER_PRIVATE_KEY` and `START_BLOCK` as well.                                                                                                                                       |
| `RUNNER_PRIVATE_KEY`            | unset                                 | The runner wallet's key, `0x` and 64 hex. Environment only.                                                                                                                                                 |
| `RUNNER_ADDRESS`                | unset                                 | In a keyless dry run, the address to simulate as.                                                                                                                                                           |
| `IMD_PAID_TOKEN`                | made and kept in the store            | The paid-request Bearer token (64 hex). Set it for a hosted run.                                                                                                                                            |
| `DRY_RUN_PREFLIGHT`             | `0`                                   | `1`: a dry run also asks the protocol's free preflight about each job (one POST each).                                                                                                                      |
| `LOOK_ONLY`                     | `0`                                   | `1`: a live run that stops short of the claim. It asks for each order's quote and payment challenge, checks them, saves the challenge beside the store, and claims and signs nothing.                       |
| `TEMPLATES`                     | `skill:research-report`               | Kinds of job the runner opens, comma-separated. Also: `audit`, `skill:create-image`, `skill:create-video`.                                                                                                  |
| `RECEIPT_ONLY_ORDERS`           | `when-receipts-flow`                  | Orders that only a receipt can pay: `never`, `when-receipts-flow` or `always`. See below.                                                                                                                   |
| `RECEIPT_STALL_BLOCKS`          | `1800`                                | Receipts count as stalled when the WorkRegistry wrote none in this many blocks (six hours).                                                                                                                 |
| `LATCH_CONDITIONS`              | `1`                                   | Send `trigger` for a conditional order whose condition holds, when only its risen price would pay. Gas only.                                                                                                |
| `ARBITERS`                      | empty                                 | Arbiters the runner accepts, comma-separated. By default it takes no order that has one.                                                                                                                    |
| `EMPLOYERS`                     | empty                                 | When set, the only employers whose orders are taken.                                                                                                                                                        |
| `MAX_EMPLOYER_LOSSES`           | `1`                                   | After this many lost bonds on one employer's orders, that employer's orders are left alone.                                                                                                                 |
| `MIN_ORDER_LIFETIME_SECONDS`    | `7200`                                | Leave alone orders that expire sooner than this.                                                                                                                                                            |
| `DAILY_CAP_IMD`                 | `2`                                   | Most IMD paid to the swarm per UTC day.                                                                                                                                                                     |
| `ORDER_CAP_IMD`                 | `0.5`                                 | Most IMD paid to the swarm for one order.                                                                                                                                                                   |
| `MAX_BOND_IMD`                  | `0.25`                                | Largest bond the runner posts. 0.25 is the desk's minimum.                                                                                                                                                  |
| `MAX_BONDS_AT_RISK_IMD`         | `1`                                   | Most IMD posted as bonds at one time, over all orders held.                                                                                                                                                 |
| `MAX_CONCURRENT`                | `2`                                   | Orders held at once.                                                                                                                                                                                        |
| `MIN_MARGIN_IMD`                | `0.05`                                | What must be left of the runner's 90% after the 0.5 IMD fee and the allowance for failures.                                                                                                                 |
| `EXPECTED_FAILURE_BPS`          | `500`                                 | The share of (bond + fee), in ten-thousandths, the price must also cover.                                                                                                                                   |
| `MAX_PAY_FAILURES`              | `2`                                   | Failed payments in a row, after a claim, before the runner stops claiming until `resume`.                                                                                                                   |
| `MAX_JOBS_PER_ORDER`            | `1`                                   | `2` allows one more job for a claim whose first ended blocked with no receipt on chain.                                                                                                                     |
| `REGISTER_AT_ONCE`              | `0`                                   | `1`: register the job when it is admitted, not when it has completed.                                                                                                                                       |
| `CLAIM_SETTLE_SECONDS`          | `600`                                 | How long the job's newest record must have stood before delivery is claimed on it.                                                                                                                          |
| `MAX_SETTLE_RECORD_BYTES`       | `100000`                              | A larger record is not carried in a `settle`; the bonded claim is used instead.                                                                                                                             |
| `MAX_SETTLE_GAS`                | `3000000`                             | The most gas a `settle`, `stamp` or `reportFailed` is sent with. A record that needs more is claimed instead.                                                                                               |
| `STAMP_AFTER_FINALIZE`          | `1`                                   | After a claim was paid unchallenged, mark the order proven when its receipt lands. No money moves.                                                                                                          |
| `STAMP_WATCH_DAYS`              | `30`                                  | How long the receipt is looked for after that.                                                                                                                                                              |
| `DISPUTE_TIMEOUT_AFTER_SECONDS` | `86400`                               | A challenged claim nothing decided: how long after the delivery deadline the runner waits before it ends it itself.                                                                                         |
| `PREPARED_INPUT_EXTRA_KEYS`     | empty                                 | Fields IdentityMD may add, with a value, to the job it prepares. Any other added field stops the payment.                                                                                                   |
| `MAX_FEE_GWEI`                  | `3`                                   | Do not send a transaction while the network fee is above this.                                                                                                                                              |
| `MAX_PRIORITY_FEE_GWEI`         | `0.1`                                 | Cap on the priority fee of an ordinary transaction.                                                                                                                                                         |
| `MAX_TX_COST_ETH`               | `0.01`                                | Do not send a transaction that would cost more than this. Must cover `MAX_SETTLE_GAS` at `MAX_FEE_GWEI`.                                                                                                    |
| `URGENT_MAX_FEE_GWEI`           | `30`                                  | The fee cap for the calls that protect a bond: `register`, `release`, `claimDelivered`, `reportFailed`, `timeout`, and a `settle` whose delivery deadline is within six hours or whose claim is challenged. |
| `URGENT_MAX_TX_COST_ETH`        | `0.02`                                | The cost limit for those.                                                                                                                                                                                   |
| `MIN_ETH_BALANCE`               | `0.003`                               | Claim no new order while the wallet holds less ETH than this: the steps after a claim need gas.                                                                                                             |
| `PERMIT2_ALLOWANCE_IMD`         | `5`                                   | What `bootstrap` approves Permit2 for.                                                                                                                                                                      |
| `KILL_SWITCH` / `KILL_FILE`     | off / `<store>.KILL`                  | See Stopping.                                                                                                                                                                                               |
| `STORE_PATH`                    | `./data/runner.json`                  | The runner's memory. Must survive a restart.                                                                                                                                                                |
| `POLL_SECONDS`                  | `60`                                  | Pause between passes.                                                                                                                                                                                       |
| `CONFIRMATIONS`                 | `2`                                   | Blocks behind the head that logs are read at.                                                                                                                                                               |
| `LOG_CHUNK_BLOCKS`              | `2000`                                | Blocks per log query. A refused query is tried once more at an eighth of this.                                                                                                                              |
| `LOG_LEVEL`                     | `info`                                | `debug`, `info`, `warn` or `error`.                                                                                                                                                                         |
| `IMD_API`                       | `https://api.imd.fun`                 | IdentityMD's control plane.                                                                                                                                                                                 |

The token (IMD) and the registry (IdentityMD's WorkRegistry) are fixed to their mainnet addresses
and cannot be configured.

### Orders that only a receipt can pay

An order can be paid in two ways. The proven way needs the job's receipt in IdentityMD's
WorkRegistry. The claimed way, which the employer has to allow (`FLAG_ALLOW_CLAIMED`), needs none.
IdentityMD's receipt writer stalled from about 8 to 14 October 2026: jobs finished, the API listed
their record hashes as `queued`, and the receipts landed days later. It writes again since
13 October (53 receipts in the 1,800 blocks up to block 26,198,141, on 15 October), and it can
stall again. A runner that takes an order which can _only_ be paid on a receipt has its bond at
risk of the delivery deadline through no fault of its own.

`RECEIPT_ONLY_ORDERS` decides what the runner does with such an order:

| Value                | The runner                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `when-receipts-flow` | takes it only while the registry is writing receipts: its newest `WorkRecorded` event is within `RECEIPT_STALL_BLOCKS` (1,800 blocks, six hours). A registry that cannot be read counts as stalled. Default. |
| `never`              | takes none of them.                                                                                                                                                                                          |
| `always`             | takes them and waits for the receipt. If none lands by the delivery deadline the bond is forfeited, and you have chosen that.                                                                                |

Which of the two paths an order is on is said in the log at every step: `delivery claimed`,
`finalized unchallenged … not yet proven`, `stamped proven`, or `settled against the receipt`.

## What it does with an order

```
seen ──▶ claimed ──▶ paid ──▶ registered ──▶ delivered                      settled against the receipt
  │         │          │           │
  │         │          │           └──▶ asserted ──▶ unproven ──▶ delivered  bonded claim, unchallenged for
  │         │          │                                                     24 h, then stamped with the receipt
  │         │          └──▶ releasing ──▶ released               the job blocked before registration
  │         └──▶ releasing ──▶ released                          the job could not be bought
  └──▶ skipped                                                   not an order for this runner
any held state ──▶ lost                  several passes agree the order is no longer this runner's
```

**Seen.** Orders are found through the desk's `OrderOpened` event, which carries the whole job text;
the desk itself stores only its hash. An order is taken only if all of this holds, and each of
these is a check with a test of its own:

- it is open, and the order on chain is the one the event announced;
- **its kind is one the swarm writes and this runner opens**: its `kindHash` is the hash of a kind
  in the shared package's table (`JOB_TEMPLATES`: kinds seen in real work records, each with a
  job body that yields it), and that kind is in `TEMPLATES`. The desk pins a hash and cannot know
  whether any work record will ever carry it;
- its spec passes the desk's character rules and hashes to the order's `specHash`;
- it is not reserved for another runner; its employer is one you serve and has not cost you a
  bond; it has no arbiter, or one you listed;
- **it can be paid on a path this runner can finish**: it allows the bonded claim, or receipts are
  flowing (see above), and the records of its kind have fitted `MAX_SETTLE_GAS` so far;
- its bond is within your limits (per order, and over all orders held); it does not expire too
  soon; this runner has not released it before;
- its condition, if it has one, holds now or was latched before;
- **its price covers its cost**: what the runner is paid at the current price (90% of it) is at
  least the swarm's fee, your margin and the allowance for failures;
- the caps have room, the breaker is not set, and the runner holds fewer orders than
  `MAX_CONCURRENT`.

An order that does not qualify for a reason that can change is looked at again, less and less often
(up to every 30 minutes); the orders in hand are looked at on every pass. An order skipped for good
is looked at again when you change what the runner takes (`TEMPLATES`, `EMPLOYERS`, `ARBITERS`, a
limit): it then reads the desk's logs again from `START_BLOCK`.

**A conditional order** can be taken once its condition has been seen true. A claim latches a
condition that holds now, so the runner needs no call of its own for that. Until it is latched the
price stands at the start of its ramp; when the condition holds, the price there does not pay and
the top price would, the runner sends `trigger(id)` (gas only) so that the price starts to rise,
and takes the order when it pays.

For an audit, the spec ends with the one inputs clause every part of HELP WANTED reads:
`Inputs: repoUrl=https://github.com/owner/repo; baseCommit=<40 hex>` (pairs separated by a semicolon
and a space).

**Before a claim.** A claim costs a bond, and giving an order back costs a tenth of it, so the
runner first makes sure it can finish what it starts, while a refusal still costs nothing:

- it reads `GET /requests/capabilities` and takes no new order unless `job.open` is still sold for
  IMD on mainnet, to IdentityMD's payee, at a fee within `ORDER_CAP_IMD`;
- the wallet must hold `MIN_ETH_BALANCE` for gas, IMD for the bond and the fee, and a Permit2
  allowance for the fee, on top of the fees of orders already claimed and not yet paid for;
- it sends the exact job it would open to IdentityMD's free `POST /requests/check`. A blocker, or a
  work-record kind other than the order's, ends the order for this runner;
- it asks for the **quote** and the **payment challenge** of that job and runs every check of the
  next section on them, signing nothing. If IdentityMD changed the job, or the payment terms are
  not the expected ones, the order is not claimed and the reason is logged at `error`.

**Claim.** `IMD.approve(desk, bond)` if needed, then `claim(id)`. The runner reads the claim back
from the chain and computes the ticket and header itself. If the claim turned out to be another one
than the quote was made for, the quote is dropped and asked for again. If the chain shows the claim
fixed a price that pays less than the swarm's fee even after what giving the order back would cost,
it gives the order back.

**The header.** Before anything is signed for the claim, the runner reads the desk's own
`headerOf(id)` and compares it, byte for byte, with the header it built. A job under any other
header could never settle the order. If they differ the payment is not made and the order is given
back; if the desk cannot be read, nothing is signed on that pass.

**Pay.** See the next section. A payment is not signed while the transaction that must follow it
(`register`) could not be sent, for instance because gas is above even the higher cap. If the job
cannot be bought and nothing was charged, or the one-hour claim window is about to end with nothing
signed, the runner calls `release(id)`: that costs a tenth of the bond, where being removed for
inaction would cost all of it. A payment whose settlement failed (`payment_failed`, an ordinary
event) is replaced by a new quote once its permit has run out.

**Register.** The runner first checks that the job IdentityMD opened carries this claim's
objective, was paid by this wallet, and runs under the template that is the order's kind (a work
record's kind is the job's template; under another template the record could never settle, and
the order is given back for a tenth of the bond while that is still possible). Then
`register(id, jobId)`, once the job has completed or fifteen minutes before the claim window ends
(see [What can cost you money](#what-can-cost-you-money)).

**Watch.** Each pass it asks the WorkRegistry first. A job can be given a second record after its
first, and the registry then holds the newer hash, so the record is always fetched by the hash the
registry holds, never by one remembered. Every record is checked locally against everything the desk
will check, as hashes of its raw bytes: it is for this job, its state is `completed`, its kind is
the order's, and its objective is this claim's header followed by the order's spec. Then:

- a receipt is on chain and its record settles: `settle(id, record, [])`, sent with the gas an
  estimate finds (the desk refuses a settlement unless it is offered about 1.4 million gas more than
  it uses) and never more than `MAX_SETTLE_GAS`; if the record is too large, needs more gas than
  that, or the transaction cannot be sent, `claimDelivered` on that hash instead;
- a receipt is on chain and shows the job did not complete, or completed under another kind:
  `reportFailed(id, record)`, which returns the bond;
- no receipt yet, the job is completed and the order allows it: `claimDelivered(id, recordHash)` on
  the newest record the API lists, once that record has stood for `CLAIM_SETTLE_SECONDS` and while
  the 24 hour challenge window and the 24 hours the desk keeps after it still fit before the
  delivery deadline;
- after a delivery claim: `settle` as soon as any receipt lands that settles the order (the desk
  pays on it whatever hash was named), otherwise `finalize(id)` when the challenge window is over;
- after an unproven finalize (the runner's own, a keeper's, or an arbiter's decision): the order
  is looked at every ten minutes for `STAMP_WATCH_DAYS`, and `stamp(id, record, [])` is sent when
  the registry holds a receipt whose record would have settled it. No money moves.

**At each deadline.**

| Deadline                                                       | What the runner does                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One hour after the claim (`CLAIM_WINDOW`)                      | Registers the job fifteen minutes before it at the latest. Gives the order back (`release`, a tenth of the bond) no later than two minutes before it: afterwards the desk refuses a release.                                                 |
| 48 hours before the delivery deadline                          | The last moment for `claimDelivered` (the desk keeps 24 hours to challenge and 24 more to decide). The runner claims five minutes earlier at the latest, and says when it is too late.                                                       |
| 24 hours after a delivery claim (`CHALLENGE_WINDOW`)           | `finalize(id)`, if nobody challenged.                                                                                                                                                                                                        |
| The delivery deadline (`registeredAt + deliverySecs`)          | A registered job with no receipt: anyone may now `timeout` and the bond goes to the employer; the runner says so at `error` and still settles if the receipt lands first. Within six hours of it a settlement may pay the higher gas limits. |
| The delivery deadline, with the claim challenged and undecided | A receipt or the arbiter can still decide for the runner until somebody calls `timeout`. The runner waits `DISPUTE_TIMEOUT_AFTER_SECONDS` (a day), then calls it itself and takes back nine tenths of its bond.                              |

**Believing the chain.** Every step starts from the chain, reading the order and its claim at one
block. A reading from a block older than the last one the runner acted on is not believed. A
reading that says the order is no longer held is believed only when three passes over at least two
minutes agree; the order is then marked lost, and is still asked about for a week in case the chain
shows it held after all.

## How the payment is protected

`src/pay.ts` follows IdentityMD's documented paid-request flow: quote, 402 challenge, a Permit2
payment signature, an EIP-712 `QuoteApproval`, submit, poll. Each of these is checked before the
key is used, and the first three are checked once already before the bond is posted:

| Check              | What must hold                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The quote          | action `job.open`; network `eip155:1`; token IMD; recipient IdentityMD's payee `0x4e0f…adbc`; amount within `ORDER_CAP_IMD`; 18 decimals; not expiring within 30 seconds.                                                                                                                                                                                                                                                                                      |
| The prepared input | IdentityMD may rewrite an input before pricing it. The saved objective must equal header plus spec **byte for byte**, and **every field that was sent** (`skill` or `template`, `outputs`, `repoUrl`, `baseCommit`, …) must be there with the value it was sent with. A field that was not sent is tolerated only if it holds nothing, or if you listed it in `PREPARED_INPUT_EXTRA_KEYS`; a field that decides the kind of job or makes it a launch never is. |
| The challenge      | `accepts[0]` is scheme `exact`, same network, token, recipient and amount as the quote, `assetTransferMethod: permit2`; the quote inside is the one first given; the resource is this order's submit URL; the payment window (`maxTimeoutSeconds`) ends at least five seconds before the quote expires; the `PAYMENT-REQUIRED` header agrees with the body.                                                                                                    |
| The caps           | The amount is reserved against the per-order and daily caps before signing. No room, no signature.                                                                                                                                                                                                                                                                                                                                                             |
| The signatures     | The signer refuses anything but a Permit2 `PermitWitnessTransferFrom` for exactly that token and amount, to the x402 exact proxy `0x4020…0001` as spender, with the payee as witness and a deadline before the quote's expiry; and a `QuoteApproval` with exactly the fields computed from the challenge.                                                                                                                                                      |
| The payload        | Only the keys IdentityMD's strict parser allows (no `extensions`); `accepted` equals `accepts[0]`; the signature recovers to the runner.                                                                                                                                                                                                                                                                                                                       |

The exact bytes of the paying request are **saved before they are sent**. If the answer is lost, or
the runner restarts, the same bytes are sent again; the protocol treats that as the same payment.
The runner never signs a second payment for an order that already has one, and it asks for a new
quote only after an earlier signed payment has passed its deadline and can no longer be settled.

When it is unsure whether the fee was taken, it does not guess:

- a refusal of a _resend_ is not read as "not charged" (the first copy may have been settled): the
  status route is asked;
- an order that comes back as already `paid` is never treated as an unpaid quote that ran out,
  whatever the quote's age;
- a status that cannot be read (a 404 after the token changed, an unknown shape) is logged on every
  pass, at `error` from the fifth, and the job is looked for through the public
  `GET /requests/paid-by/<wallet>`. If no job id was learned five minutes before the claim window
  ends, the claim is given back for a tenth of the bond rather than left to be removed for all of it.

## What is on disk

`data/runner.json`, readable by its owner only: the block the log scan reached, each order and how
far it got, the paid-request token (unless you supplied one), any signed payment request, the
transaction that is waiting to be mined, what was spent each day, and the counts behind the breaker
and the employer rule. It is rewritten only when something changed. An order that was skipped for
good keeps a line and loses its text.

It never holds the wallet key. The token is a random value; IdentityMD uses it to tell whose paid
orders are whose, and it cannot authorise a payment. A signed payment request pays one fixed amount
to IdentityMD's payee before its deadline, and can do nothing else. Still, treat the file as private.

## Docker and hosting

Build from the repository root (the runner uses `packages/shared`):

```sh
docker build -f bots/runner/Dockerfile -t help-wanted-runner .

# a dry run
docker run --rm -e WORK_ORDERS=0x... -e RPC_URL=https://... -v hw-runner:/data help-wanted-runner once

# live: the key comes from the environment at start, through your secret store
docker run -d --name hw-runner --restart unless-stopped \
  -e WORK_ORDERS=0x... -e RPC_URL=https://... -e START_BLOCK=... \
  -e LIVE=1 -e RUNNER_PRIVATE_KEY -e IMD_PAID_TOKEN \
  -v hw-runner:/data help-wanted-runner
```

`-e RUNNER_PRIVATE_KEY` with no value passes the variable through from your shell, so the key never
appears in the command line. The image contains no key.

The store lives at `/data/runner.json`. Attach a persistent volume at `/data` (with Docker,
`-v hw-runner:/data`; on Railway, a volume mounted at `/data`; Railway refuses a Dockerfile that
declares a `VOLUME` itself, so this one declares none). A live runner refuses to start if it cannot
write its store.

The team's own runner has been hosted on Railway since 15 October 2026, 14:18 UTC.
`scripts/deploy-runner.sh` at the repository root deploys the runner to Railway: it uploads only
what this Dockerfile copies, leaves out `.env` and `.env.*` files and the store, and refuses to
upload anything when a file sets `RUNNER_PRIVATE_KEY` or `KEEPER_PRIVATE_KEY` to a key. A key kept
in a file any other way is not caught, so keep keys out of the folder. The upload holds no
`railway.toml`, and the script sets none of the Dockerfile path, the volume at `/data`, the key or
`LIVE=1`: each is a setting of the service, in Railway. When the script creates the service, it
prints a reminder to set the first two.

## What is verified, and what is not

Verified on the live system, with order 1 of the launched desk (13 and 14 October 2026). The
order was the Doorbell's, a picture job that allows the bonded claim; the runner's wallet is the
team's H1:

- `claim(1)`: transaction `0x64fa9f0ab43cd79f3e0a6ea1ba4829afae68ec882ba8a99dd9b692b579f4cb8b`,
  block 26,185,009, 114,328 gas.
- **A real payment.** IdentityMD accepted the runner's paid request and settled it on chain
  (transaction `0xc92c4731e996540cbe68d2e62bc820d67e6bf4d7ec9adc6464b4b0be90e66bc5`, block
  26,185,015): 0.5 IMD moved from the runner's wallet to IdentityMD's fee address through the x402
  contract. IdentityMD opened job `f7bd80ba-3e8b-483f-ad02-6ffbd16fef92`, a `skill:create-image`
  job whose objective begins with the order's 85-byte header, and names the runner's wallet as its
  payer.
- `register(1, jobId)` once the job had completed: transaction
  `0x868c21f2ce636a1b14c98e78595c051f9d6787e774eb24603e6408a287e10904`, 41,748 gas.
- `claimDelivered` on the record hash the API listed, before the job's receipt was written:
  transaction `0xb1e9061678862f6b2049d7941b0a28e020dac681370dd3b6d8f564bd82c88a25`, 13 October,
  17:37 UTC, 81,113 gas.
- `settle` on the job's receipt, one minute after IdentityMD's writer wrote it on 14 October and
  before the claim's 24 hours were over: transaction
  `0xa3f5b783fe194c35f348e411a10f0a199589ea89b668a16d1597794931217628`, block 26,190,223. The desk
  proved the record, marked the order proven, and paid the runner 0.9 IMD and its bond. The
  settlement used 636,569 gas of the 1,904,420 it was sent with.

Verified on the live system before that (13 October 2026):

- **The header survives.** Job `e70c56ce-60f0-4c2c-b413-67e5ae37ddce` was sent an objective of our
  85-byte header followed by a question; IdentityMD stored it byte for byte, and its work record
  hashes to the hash the API lists, has kind `skill:research-report` and state `completed`.
- **The free preflight** returned no blockers for a header-carrying objective. Its `kind` was
  `report`, which is not a work-record kind: the runner says so at `info` and does not act on it.

Verified against the real contracts of all three launches on a local node
(`pnpm --filter @help-wanted/keeper test:integration`, the joint test in `bots/keeper`):

- The whole order path against the deployed bytecode of `WorkOrders`, `WorkProof`, `CrowdPots`,
  `Rules` and `Payroll`: discovery from `OrderOpened`, `claim`, `headerOf`, `register`, `settle`,
  `claimDelivered`, and what follows a keeper's `finalize` and `stamp`. A settlement of a 3.5 KB
  record used 590,557 gas of the 1,916,393 it was sent with.
- The paid flow against a stand-in for IdentityMD that recovers both signatures the way the guide
  describes (the Permit2 payment in Permit2's domain, and the quote approval over the SHA-256 of
  the canonical payment), refuses any payload key the guide does not list, and then moves the fee
  out of the runner's allowance to Permit2. The stand-in is ours, written from the guide: it is
  not the live service.

Verified by tests that run offline (`pnpm --filter @help-wanted/runner test`):

- The order header and ticket, against vectors produced independently (with `cast` for the desk's
  Solidity tests, and with a separate Python implementation for the shared package).
- The record checks, through the shared scanner, which gives the same answer as the desk's own
  `WorkProof.scan` on 6,084 cases (788 of them kept as vectors), error and byte offset included.
  `packages/shared/scripts/scan-differential/run.sh` reruns that comparison against the contract.
- The Permit2 payment: made by `@x402/core` and `@x402/evm` at exactly 2.28.0 (the versions
  IdentityMD's control plane pins) and checked field by field; the signature recovers to the payer.
- The `QuoteApproval` types and domain, against the ones IdentityMD publishes in its OpenAPI
  document; the payment hash, against the `canon` function in IdentityMD's guide.
- Every refusal in the table above; the look at the quote and the challenge before a claim; the
  resend of identical bytes after a lost answer; what is done when the fee may or may not have been
  taken; resuming from the store at every stage, and from the chain alone with an empty store; the
  caps, the limits on bonds and employers, the breaker, the kill switch; the gas limits, the
  replacement of a transaction that is not mined, and the refusal to queue behind one.
- The shape of `GET /requests/paid-by/<wallet>`, against one real response saved in
  `packages/shared/fixtures/api`.

Verified only against documentation or source, **not against the live protocol**:

- **The paid flow, beyond one job.** One paid request has been made (order 1, above), for a
  `skill:create-image` job. The quote, status and most challenge fixtures in `test/fixtures` are
  built by hand from IdentityMD's OpenAPI document and API guide; one real challenge, saved by a
  `LOOK_ONLY=1` run for order 1 on 13 October 2026, is in `test/fixtures/live`.
- **A quote for a header-carrying job of another kind.** Order 1's quote, made through this code,
  carried the header and passed the byte-for-byte check before the claim. No other kind has been
  quoted through this code. The runner checks every quote before it claims: if the prepared input
  differs by one byte the order is not claimed, so being wrong costs nothing. It checks once more
  that the job IdentityMD opened carries the objective before it registers it.
- **`maxTimeoutSeconds`.** The fixtures assume 300 seconds against the 600 second quote, and the
  live challenge of 13 October 2026 said 300. If a later value leaves no room before the quote
  expires, no payment can be signed; the runner finds that out before it claims as well, and says
  so at `error`.
- **What IdentityMD adds to a prepared input, beyond one kind.** For the `skill:create-image` job of
  order 1 it added one field, `contracts`, empty, which the check lets through. A default with a
  value stops the order before the claim, with the field named in the log; list it in
  `PREPARED_INPUT_EXTRA_KEYS` once you have looked at it.
- **The job bodies.** The `skill:create-image` body was accepted and bought (order 1). `audit` and
  the other one-skill bodies follow the examples in the guide and have not been bought through
  this code. The `kind` the live preflight returned for a research-report job was `report`, not a
  work record's kind: the runner acts on that field only when it is spelled like one.
- **How promptly the API lists a record.** Delivery is claimed with the hash
  `GET /jobs/:id/records` lists, after it has stood for `CLAIM_SETTLE_SECONDS`. A keeper that
  checks the claim reads the same route; if the route served another list a few minutes later, a
  true claim could look untrue to it.
- **The x402 client and IMD.** At 2.28.0 the stock `x402Client` refuses IMD unless it is listed in
  `spendControls.allowedAssets` (a test shows this). The runner lists it, with the order cap as the
  per-payment maximum.
- **The desk on mainnet, beyond order 1.** The ABI is generated from the launch project's build
  output, and the runner has run against that bytecode on a local node and, for order 1, against
  the launched desk (above). `finalize`, `stamp`, `reportFailed`, `release`, `timeout`, a dispute
  and the chunked proof have not been used on mainnet.
- **The receipts-flow test against mainnet's registry.** `WorkRecorded` is read from the registry
  over the last 1,800 blocks; a public node serves logs for about 9,000, so the query fits. The
  event's shape is the one in `packages/shared` (`workRegistryAbi`); the registry's source is not
  published.
- **Replacing a transaction that is not mined.** Tested against a stand-in for the node, not
  against a real mempool.
- **The Docker image on a machine of your own.** It has not been built on the development machine
  (no Docker daemon); its install step was reproduced outside Docker. The team's runner has run on
  Railway since 15 October 2026, 14:18 UTC. Which Dockerfile Railway builds it from is a setting of
  the service, and that setting was not read for this document.

First live run: one free `POST /requests/check` with a header objective (`DRY_RUN_PREFLIGHT=1`),
then `LOOK_ONLY=1` with `LIVE=1` to see the real quote and payment challenge pass every check
without claiming (the challenge is saved beside the store as `challenge-<order id>.json`), then one
small order of your own with the kill switch at hand.

The first live look, on 13 October 2026, found one difference from the hand-built fixtures: the
challenge's `resourceUrl` names the order itself (`<api>/requests/<id>`), not its submit route. The
runner refused it before claiming, as it is meant to; both forms are accepted since, and the paying
request is sent to the submit route whatever the challenge names. The first live payment followed
the same day, for that order, order 1 (above).

### For launch B

- The Doorbell orders a picture: its kind is `skill:create-image`. The default `TEMPLATES` is
  `skill:research-report` alone, so a runner meant to serve the Doorbell needs
  `TEMPLATES=skill:research-report,skill:create-image`.
- The Doorbell was launched with the claimed path on (`ALLOW_CLAIMED()` reads true), and a pot
  whose terms say so allows it too, so their orders are taken while receipts are stalled. An order
  without it is taken only while receipts flow (`RECEIPT_ONLY_ORDERS`). The first pot proposed in
  launch B's documents allows the claimed path; the first rule proposed in launch C's is
  receipt-only, and while receipts are stalled this runner leaves its orders alone, and says why.
- A pot's bond is its opener's choice (the first pot proposed in launch B's documents asks 0.5
  IMD): raise `MAX_BOND_IMD` to take such an order, and `MAX_BONDS_AT_RISK_IMD` with it.
- If you also run the keeper, name this runner's address in the keeper's `DESK_OWN_RUNNERS`, or it
  will evict and time out your runner's claims the second they are due, like anyone else's.

## What the runner does not do

- It does not send the chunked proof for a record too large for one transaction (see above).
- It does not act on other runners' orders: removing a runner that overstayed, timing an order
  out, challenging a claim, finalizing and stamping others' claims are a keeper's work
  (`bots/keeper`, the desk module).
- It does not use a job paid for under a claim that was then lost: a new claim has a new ticket,
  and that job's objective carries the old one.

## Development

```sh
pnpm --filter @help-wanted/runner typecheck
pnpm --filter @help-wanted/runner test
pnpm --filter @help-wanted/runner format
```

| File              | What is in it                                                           |
| ----------------- | ----------------------------------------------------------------------- |
| `src/pay.ts`      | The paid-request flow and every check that guards it.                   |
| `src/machine.ts`  | The order state machine.                                                |
| `src/chain.ts`    | The one module that sends transactions.                                 |
| `src/runtime.ts`  | Wiring: clients, the account, the store, the payment flow, the machine. |
| `src/desk.ts`     | The hire desk's reads and writes.                                       |
| `src/config.ts`   | Environment variables to configuration; dry run unless told otherwise.  |
| `src/store.ts`    | The local store.                                                        |
| `src/log.ts`      | JSON logging with secrets removed.                                      |
| `src/commands.ts` | The loop, `status`, `bootstrap` and `resume`.                           |
| `src/cli.ts`      | The command line.                                                       |
| `bin/`            | The `hw-runner` launcher.                                               |
| `test/fixtures/`  | Hand-built protocol fixtures and the script that writes them.           |

The runner and the shared package are TypeScript sources and run under `tsx`; plain `node` cannot
import them. `bin/hw-runner.mjs` registers `tsx` and starts the command line.

The test wallet in `test/world.ts` is account 0 of Anvil and Hardhat, a key printed in their
documentation. It signs test messages only, and the runner refuses to go live with it.
