# The HELP WANTED keeper

HELP WANTED is ten contracts with no owner, in three launches. Nothing in them moves by itself.

- **Launch A** (`Questions`, `JobsReport`, `Payroll`): somebody has to ask the feeds every day,
  hand in answers the Intake's writer is late with, print the report, drip the stakers' stream and
  top the meters up.
- **Launch B** (`WorkOrders`, the hire desk; `CrowdPots`; the `Doorbell`): somebody has to return
  the escrow of an order that expired, remove a runner that registered no job, end a claim that
  ran out of time, pay a delivery claim nobody challenged, and, while IdentityMD's receipts are
  late, watch every delivery claim, because an untrue one that nobody challenges within 24 hours
  is paid.
- **Launch C** (`Rules`, `Endowments`): somebody has to fire a rule whose condition holds, stake
  what depositors put in, and send yield where it belongs.

The keeper is that somebody. Every call it makes is open to anybody. It has no privilege, so its
key guards nothing but the ETH it holds for gas and, if you switch challenges on, the IMD it posts
as challenge bonds. Run your own if you like: two keepers do no harm, the second one's transaction
reverts in simulation and is never sent.

- [What it does](#what-it-does)
- [Safety](#safety)
- [Install](#install)
- [The first day](#the-first-day)
- [Every day](#every-day)
- [The rules it follows](#the-rules-it-follows)
- [The hire desk and the watch on delivery claims](#the-hire-desk-and-the-watch-on-delivery-claims)
- [The status file](#the-status-file)
- [Settings](#settings)
- [What it costs](#what-it-costs)
- [What is not verified](#what-is-not-verified)
- [Tests](#tests)
- [Adding a module](#adding-a-module)

## What it does

| Module     | Call                                               | When                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| questions  | `Questions.request(feedId)`                        | The contract's `canRequest` says yes. Each request is a transaction of its own.                                                                                                                                                                                    |
| questions  | `Payroll.fundFeeds()`                              | A meter is too low for a request and Payroll has budget for it. The request follows.                                                                                                                                                                               |
| questions  | `Questions.submit(feedId, attestation, signature)` | A round is pending, the contract's `canSubmit` is true (thirty minutes after the request, or at once when the Intake completed it with nothing stored), and IdentityMD's API serves an answer signed for this contract that passes every check the contract makes. |
| questions  | `Questions.abandon(feedId)`                        | A round can get no answer any more. See [the rules](#closing-a-round).                                                                                                                                                                                             |
| questions  | `Questions.collectTips()`                          | The keeper's earned tips reach `TIP_COLLECT_MIN_IMD`.                                                                                                                                                                                                              |
| jobsReport | `JobsReport.print()`                               | A payrolls or hires round is answered and not yet in the report.                                                                                                                                                                                                   |
| jobsReport | `JobsReport.crown(round, answer)`                  | The newest employers round is answered and not crowned. The list comes from the attestation; it is sent only if its hash is the word `Questions` stored.                                                                                                           |
| payroll    | `Payroll.book()`                                   | At least `BOOK_MIN_IMD` arrived by plain transfer.                                                                                                                                                                                                                 |
| payroll    | `Payroll.fundFeeds()`                              | Payroll has budget and a meter is `FUND_FEEDS_MIN_IMD` below its runway; or budget has waited out its time; or a fortnight boundary has passed.                                                                                                                    |
| payroll    | `Payroll.drip()`                                   | `stream().dueNow` is not zero, an hour has passed since the last drip, and a whole drip (an hour of the stream) is due.                                                                                                                                            |

| desk | `WorkOrders.refund(id)` | An order expired with nobody holding it. |
| desk | `WorkOrders.trigger(id)` | A conditional order's condition holds now and was never latched. |
| desk | `WorkOrders.evict(id)` | A runner registered no job within the hour after it claimed. |
| desk | `WorkOrders.timeout(id)` | A registered job has no settlement at its delivery deadline, or a challenged delivery claim was not decided by then. |
| desk | `WorkOrders.settle(id, record, [])` | The WorkRegistry holds a receipt for an order's job and its record settles the order: also for an order whose delivery was claimed or challenged. |
| desk | `WorkOrders.stamp(id, record, [])` | An order was paid on a delivery claim and its receipt has landed since. |
| desk | `WorkOrders.reportFailed(id, record, [])` | A receipt shows a job that does not settle its order, where anyone may report it. |
| desk | `WorkOrders.finalize(id)` | A delivery claim stood 24 hours unchallenged and passed [the check](#the-check-of-a-delivery-claim). |
| desk | `IMD.approve(desk, bond)`, `WorkOrders.challenge` | A delivery claim fails the check, no receipt is on chain, and the challenge fits the float, the daily cap and the lists. **Off unless you set both `CHALLENGE_FLOAT_IMD` and `CHALLENGE_DAILY_CAP_IMD`.** |
| pots | `CrowdPots.launch(potId, spec)` | A pot is full and has not hired, until one day after its deadline. |
| pots | `CrowdPots.reconcile(potId)` | A pot's order was delivered at its full price, so its books are due and nobody has anything to take back. |
| pots | `CrowdPots.claimRefunds(potId, contributors)` | A pot did not hire in time, or its order ended: each contributor is paid their refund or their share of the change. |
| doorbell | none | Ringing is for people. The Doorbell's state is in the status file. |
| rules | `Rules.fire(id, spec)` | `canFire(id)` is true and the rule is on `RULES_HOUSE`, or its tip covers the gas at the current fee by your `RULES_IMD_PER_ETH`. |
| rules | `Rules.reconcile(ruleId, orderId)` | An order a rule opened has ended and the desk returned more for it than the rule was credited. |
| endowments | `Endowments.stake()` | IMD waits in the buffer and the fifty-block gap since the last stake has passed. |
| endowments | `Endowments.harvest(id)` | `harvestable(id)` reaches `ENDOWMENTS_HARVEST_MIN_IMD`: there is yield and its target has room. |

It also has a command for launch A's first day: create the three feeds, fund the meters from the
operator's wallet, make the first requests.

A module runs when the addresses it needs are known: from `packages/shared/src/deployments.ts` once
its launch is written there, or from `WORK_ORDERS`, `CROWD_POTS`, `DOORBELL`, `RULES` and
`ENDOWMENTS`. With `MODULES` unset, the three modules of launch A run and so does every later
module whose addresses are given.

## Safety

The model is the runner's (`bots/runner`), unchanged:

- **Dry run is the default.** With no key configured there is nothing in the process that can
  sign. It reads, decides, prints what it would do, and writes the status file.
- **Live needs `LIVE=1` and `KEEPER_PRIVATE_KEY`,** both, explicitly.
- **The key comes from an environment variable at run time and from nowhere else.** It is never
  written, never logged (the logger removes it from every line, in every spelling) and never
  generated. The RPC URL is not logged either.
- **Every transaction is simulated first** and is not sent if it would revert.
- **Every transaction has a fee cap** (`MAX_FEE_GWEI`) and a cost limit (`MAX_TX_COST_ETH`).
- **One transaction is in flight at a time.** Nothing is sent behind a transaction that has not
  been mined, including one the operator sent from the same wallet by hand.
- **A daily spending cap in ETH** (`DAILY_SPEND_CAP_ETH`), counted per UTC day and kept across
  restarts.
- **A kill switch:** `KILL_SWITCH=1`, or create the file named by `KILL_FILE` while it runs.
- A published development key (the ten accounts every local node prints) is refused in a live run,
  unless the node is on this machine.

What a lost key loses: the ETH in the keeper's wallet, the IMD it holds for challenge bonds, and
tips it had earned and not collected (the house feeds pay 0.05 IMD per answered round). Keep the
float small; `MIN_ETH_BALANCE` only warns.

The keeper moves IMD of its own in two cases only, both of which you switch on:

- **The first-day command** funds the meters from the wallet that runs it. Use a wallet of the
  team's for that day and a small one after.
- **A challenge** posts a bond equal to the runner's (0.25 IMD on the Doorbell's orders) on a
  delivery claim that fails the check. It is bounded three ways: `CHALLENGE_FLOAT_IMD` (the most
  posted at one time, read from the chain: every disputed order this keeper challenged counts),
  `CHALLENGE_DAILY_CAP_IMD` (the most posted in one UTC day, kept in the state file), and the
  wallet's own balance. The desk is approved for exactly the bond, each time. With either limit
  unset the keeper never challenges: it reports what it found and asks for attention.

Nothing else spends the keeper's IMD: launching a pot, refunding contributors, firing a rule (which
pays the keeper the rule's tip), staking and harvesting all move the contracts' own money.

## Install

From the repository root (Node 22 or newer, pnpm 11):

```sh
pnpm install
cp bots/keeper/.env.example bots/keeper/.env
```

Put the three addresses the launch created into `bots/keeper/.env` (`QUESTIONS`, `JOBS_REPORT`,
`PAYROLL`) and an RPC URL. Do not put a key in that file. Then look, without sending anything:

```sh
pnpm --filter @help-wanted/keeper status
```

It prints the status document: every feed, what a pass would do and why, what is waiting.

To give a command the key without typing it on a command line or leaving it in the shell history:

```sh
read -rs KEEPER_PRIVATE_KEY && export KEEPER_PRIVATE_KEY     # paste, Enter; nothing is echoed
```

A hosted keeper takes it from the platform's secret store instead.

## The first day

Nothing is called by the launch pipeline after deployment, so the feeds do not exist until somebody
creates them (`launches/a-payroll/docs/LAUNCH.md`, section 6). One command does that section step by
step. The wallet needs ETH for about 4.5 million gas and 17.6 IMD (one runway for each meter: 7.7,
7.7 and 2.2 IMD at today's price), which stays the wallet's to take back with `Questions.defund`
for as long as the meters have not spent it.

**1. Dry run.** Prints the eleven steps and a digest of the whole runbook, and sends nothing.

```sh
KEEPER_ADDRESS=0xYourWallet pnpm --filter @help-wanted/keeper first-day
```

Read every step. Step 1 compares what was deployed with the launch: `Questions` must be built on
version 2 of the Intake, on IMD and on the oracle signer; `JobsReport` and `Payroll` must be bound
to it and to the three feed ids. If that step says `blocked`, stop: nothing will be sent, and the
launch needs looking at. The last log line gives the digest:

```
first day: plan digest {"digest":"0x…"}
```

**2. Live.** Sends the steps one at a time, each simulated first, looking at the chain again after
each. It needs the digest of step 1, so it can only send the plan that was read:

```sh
read -rs KEEPER_PRIVATE_KEY && export KEEPER_PRIVATE_KEY
LIVE=1 FIRST_DAY_CONFIRM=0x… pnpm --filter @help-wanted/keeper first-day
```

Ten transactions: three `createFeed`, one `approve` of exactly 17.6 IMD, three `fund`, three
`request`. Each request is a transaction of its own. If the gas price is above the default caps
(`createFeed` uses about a million gas), raise `MAX_FEE_GWEI`, `MAX_TX_COST_ETH` and
`DAILY_SPEND_CAP_ETH` for this run.

**3. If it stops,** run the same command again. A step that is on chain is skipped, whoever sent
it, and the digest stays the same. When every step is done the command says so and sends nothing.

The command exits 0 when the dry run printed its plan with no step blocked, or when every step is
on chain; 1 otherwise.

The requests land in three consecutive blocks, not one: the keeper never has two transactions in
flight. The payrolls and hires windows then differ by a block at each end, and the report attaches
the count to the print by overlap, as it is built to. If you want the two windows identical on
the first day, send those two requests by hand with consecutive nonces, as LAUNCH.md describes,
and let the command do the rest.

## Every day

Either of two ways. Both write the status file after every pass.

**A loop** (a pass every `POLL_SECONDS`, sooner when something it waits for is about to open):

```sh
read -rs KEEPER_PRIVATE_KEY && export KEEPER_PRIVATE_KEY
LIVE=1 pnpm --filter @help-wanted/keeper start
```

**Cron** (one pass and exit). The lock keeps two passes from overlapping:

```cron
*/5 * * * * cd /srv/help-wanted && flock -n /tmp/hw-keeper.lock pnpm --filter @help-wanted/keeper once >> /var/log/hw-keeper.log 2>&1
```

with `LIVE=1` and `KEEPER_PRIVATE_KEY` in the environment cron gives the job (from your secret
store, not from the crontab). `once` exits 1 when it could not read the chain, 0 otherwise; a step
that failed is in the status file.

**Docker:**

```sh
docker build -f bots/keeper/Dockerfile -t help-wanted-keeper .
docker run -d --name hw-keeper --restart unless-stopped \
  -e QUESTIONS=0x… -e JOBS_REPORT=0x… -e PAYROLL=0x… -e RPC_URL=https://… \
  -e LIVE=1 -e KEEPER_PRIVATE_KEY \
  -v hw-keeper:/data help-wanted-keeper
```

(`-e KEEPER_PRIVATE_KEY` with no value passes the variable from the shell that runs the command.)
`/data` must be a volume that survives a restart: it holds the day's spending and any transaction
in flight.

A pass every five minutes is enough. What matters most is that a pass runs soon after each of
these moments: when the daily feeds come due (every 7,000 blocks, 23 h 20 min); thirty minutes
after each request, when `submit` opens (the round's tip goes to whoever opened the round, whoever
hands the answer in);
and about once an hour for the drip.

Daily prints cannot be made up later. If the keeper is down for a day, the next payrolls and hires
windows cover the missed blocks (up to three days), so no IMD goes uncounted, but that day has no
print of its own.

## The rules it follows

Each module is a pure function, `decide(snapshot, policy)`, in `src/modules/`. It is given what
the chain says at one block (and, for a pending round, what IdentityMD's API says) and returns
actions, each with the reason its rule fired, and what it is waiting for. The reasons go into the
log and the status file word for word.

### Asking

A feed is asked when the contract's `canRequest` says yes. With `REQUEST_AT_UTC` set, it is asked
once per day at that time: a feed that comes due up to ninety minutes before it waits for it.
Without it, a feed is asked as soon as it is due, forty minutes earlier each day.

### Handing an answer in

On 13 October 2026 the oracle signed answers within one to five minutes, and the Intake's writer
put them on chain between two and a half and more than seven hours later. So the usual case for a
daily feed is: the signed answer is public long before the callback comes. The keeper does not
wait for the writer. For a pending round it reads `GET /intake/1/<transaction>`, which names the
oracle request, and once `canSubmit` is true it reads `GET /oracle/requests/<id>/attestation` and
hands the answer in.

Before it sends, it makes every check the contract makes: signed for this contract on this chain,
by the signer `Questions` trusts (the signature is recovered here, in the contract's own domain),
the round's question hash, window and closing block hash, the feed's answer type, panel, quorum and
agreement, not expired (with `ATTESTATION_EXPIRY_MARGIN_SECONDS` to spare) and not issued ahead of
the chain's clock. An answer that fails one is not sent, and the status file says which check.

This exists for the payrolls and hires feeds. The employers feed is judged by a panel, `Questions`
refuses `submit` for it, and only the Intake's own callback can answer its rounds.

### Closing a round

`abandon` closes a round as failed: its feed then waits twice as long before it asks again, and an
answer that arrives afterwards is refused. The keeper calls it only in these cases:

| What is true of the round                                                                                                                            | What the keeper does                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The request ended without an answer (refused, failed, the panel did not agree), or the Intake completed it and only its callback could have answered | Calls `abandon` when the contract allows a step: the first call starts thirty minutes, the second closes.                 |
| IdentityMD's service never saw the request                                                                                                           | Closes it at the contract's silence deadline, not before (36 h 5 min 1 s after the request for the house feeds).          |
| The service shows the request as received, paid, admitted, **completing** or completed-but-not-yet-on-chain                                          | **Does not close it, even after that deadline**, unless `CLOSE_ROUNDS_IN_PROGRESS=1`. The status file asks for attention. |
| The service cannot be read                                                                                                                           | Does not close it blind. The same switch applies after the deadline.                                                      |
| A usable signed answer is in hand                                                                                                                    | Hands it in. Answering always comes before closing.                                                                       |

The silence deadline is the contract's own: `requestedAt + ABANDON_AFTER_SILENCE` (twelve hours for
the oracle to sign) `+` the feed's `validFor` (a day for the house feeds) `+ ISSUED_AT_TOLERANCE`
(five minutes) `+ 1` second. `Questions.canAbandon` reports it as `closableAt`, and the keeper
reads it from there. Nothing stops another caller from closing a round once it has passed.

A round the service never served can be rescued by anyone who buys the same question from the
oracle for this contract and hands the answer in. The keeper does not buy answers: that takes IMD
and a payment flow it deliberately does not have.

### Printing, crowning, payroll

In the table at the top. Two details:

- `Payroll.fundFeeds()` is always sent with at least a million gas. It reads and funds the meters
  through calls whose failure it swallows, so a plain gas estimate can be just enough for the
  outer call and too little for the work inside it.
- A drip is sent when a whole drip is due, not for the few seconds that have vested right after a
  booking. The last of a stream that has finished vesting is sent however small it is.

## The hire desk and the watch on delivery claims

The desk module reads every order that can still change (`orderOf`, `claimOf`; an order that is
cancelled, refunded or proven is never read again) and applies the rules of the table at the top.
Three things about them:

- **The receipt always wins.** When the WorkRegistry holds a receipt for an order's registered
  job, the keeper fetches the record by the hash the registry holds and reads it as the desk will
  (`judgeRecord` in the shared package: this job, completed, the order's kind, this claim's
  header, the order's spec). A record that settles is settled, also on an order whose delivery
  was claimed or challenged, and also after its delivery deadline (timeouts are lazy). A record
  that does not settle is reported where anyone may report it; a job that ended without
  completing, on an order with no delivery claim, is its runner's alone to report.
- **A settlement is never sent with a low gas limit.** The desk refuses (`GasShort`) unless it can
  hand each of its two Payroll calls a million gas. The limit comes from an estimate and is never
  under the desk's own figure for a record of that size. On the local node, with the real Payroll,
  a settlement of a 3.5 KB record used 590,557 gas of a limit of 1,916,393.
- **Timeouts and evictions are sent when they are due**, to the second. If you run a runner of
  your own, name it in `DESK_OWN_RUNNERS`: the keeper then leaves its claims alone and says so.

### The check of a delivery claim

While IdentityMD's receipt writer is behind (it has been since about 8 October 2026), an order
that allows it is paid on a delivery claim: the runner names a job and a record hash, and if nobody
challenges within 24 hours the desk pays. Until a receipt exists both are the runner's word. For
every claim, the keeper holds them against IdentityMD's API:

| It reads                    | And requires                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /jobs/<jobId>`         | The job exists and is `completed`.                                                                                                                        |
|                             | Its objective begins with the order's header for that claim (the 85 bytes built from the desk's `ticketOf`), and continues with exactly the order's spec. |
|                             | Its template is the order's kind (a work record's kind is the job's template).                                                                            |
| `GET /jobs/<jobId>/records` | The record hash the claim named is one of the hashes listed.                                                                                              |

A claim that passes is **true**: the keeper leaves it, and finalizes it when its window is over.
One that fails any of these is **untrue**. One the API could not be asked about is **unknown**:
the keeper never challenges, and never finalizes, blind.

An untrue claim is challenged only when all of this holds: no receipt is on chain (with a receipt
the keeper settles or reports instead, which needs no bond); the claim was seen failing on two
looks at least `CHALLENGE_CONFIRM_SECONDS` apart (or the window would end before a second look);
the order has no arbiter, or one you listed in `CHALLENGE_ARBITERS` (an arbiter the keeper does
not know could decide against the challenge, and the bond would be lost); its employer is one you
listed in `CHALLENGE_EMPLOYERS`, when you listed any; and the bond fits the float, the daily cap
and the wallet. A record hash that differs from the one the registry later holds is **not** a
reason to challenge: a job can be given a second record, and any receipt that settles pays the
runner and takes the challenger's bond.

What a challenge costs: nothing, when a receipt refutes the claim (the keeper gets its bond back
with nine tenths of the runner's) or when nothing decides it by the delivery deadline (the bond
comes back and the employer is refunded). The bond is lost only if a receipt settles the order
after all, or a listed arbiter decides for the runner. It stays posted until one of these happens,
which can be the whole delivery time of the order, up to ninety days. **Set `CHALLENGE_EMPLOYERS`
to the employers you serve** (the Doorbell, CrowdPots, Rules, your own wallets): an order's
employer and its runner can be the same party, and without the list such a party can open orders,
claim them untruly and keep your whole float posted until their deadlines, at no cost to itself.

Every claim the keeper looked at is in the status file (`modules.desk.claims`: the order, the
runner, the job, the hash named, the verdict, each reason, what the keeper does and why) and in
the state file (`claims`, the newest three hundred, with the transaction of anything it sent).

### Crowd pots, the Doorbell, rules and endowments

- **Pots.** A pot keeps only the hash of its spec and no list of its contributors; both are read
  from its `SpecPinned` and `ChippedIn` logs when they are needed, from `START_BLOCK_B`, and kept
  in the state file. A public node serves logs for about the last 9,000 blocks only: give the
  keeper a keyed RPC, or a pot older than that cannot be launched or refunded by it, and the
  status file says so.
- **The Doorbell.** The keeper never rings. Its orders are desk orders like any others.
- **Rules.** `canFire` is the contract's own word for "armed, cooled down, funded, condition
  true". A rule on `RULES_HOUSE` is always fired then. Any other is fired when its tip, in IMD,
  covers the gas of the fire (450,000 gas for a HIRE, 150,000 for a PAY) at the network's current
  fee, converted with `RULES_IMD_PER_ETH`: how many IMD one ETH is worth, by your own figure. The
  keeper reads no price feed; without the setting, only house rules fire. A fire is sent with the
  700,000 (HIRE) or 300,000 (PAY) gas launch C's documents give.
- **Endowments.** `stake` at most once every fifty blocks, when at least
  `ENDOWMENTS_STAKE_MIN_IMD` waits. `harvest(id)` when `harvestable(id)` reaches
  `ENDOWMENTS_HARVEST_MIN_IMD`: the contract's figure is already cut to what a meter has room for
  under its thirty-request runway, or to what a pot still needs. Harvests are sent before the
  stake of the same pass, because a stake puts the contract on hold for its block. A pot harvest
  is sent with 850,000 gas.

## The status file

`STATUS_PATH` (default `./data/keeper-status.json`) is rewritten after every pass, whole. It holds
nothing secret. A page or an alert can read it:

| Field                                                | What it says                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `at`, `command`, `mode`, `keeper`, `block`, `killed` | When, how and as whom the pass ran, and the block it last looked at.                                                                                                                                                          |
| `checked`                                            | One line per thing looked at.                                                                                                                                                                                                 |
| `done`                                               | Every action, in order: `outcome` is `sent` (with `hash`, `block`, `gasUsed`, `costWei`), `dry-run` (with `wouldSucceed`), `failed` (with `code` and `error`), `planned` or `left`. Each carries the `reason` its rule fired. |
| `waiting`                                            | What is waited for and why, with `until` (unix seconds) when it is known.                                                                                                                                                     |
| `attention`                                          | What an operator should look at. Empty when all is well: alert on this.                                                                                                                                                       |
| `balances`                                           | The keeper's ETH and IMD, its earned and pending tips.                                                                                                                                                                        |
| `spend`                                              | Gas money spent in the current UTC day, and the cap.                                                                                                                                                                          |
| `nextDue`                                            | When each feed is next due: the block and a rough time.                                                                                                                                                                       |
| `nextLookAt`                                         | The earliest time something waited for is expected to change.                                                                                                                                                                 |
| `modules`                                            | Which modules ran, and each one's view: every feed with its meter, blocker and pending round (with what the service says); the report's counts; Payroll's stream and feed budget.                                             |
| `modules.desk`                                       | Every live order (state, employer, runner, job, deadlines, what its receipt says), whether receipts are flowing, and `claims`: every delivery claim looked at, its verdict, each reason, and what the keeper does and why.    |
| `modules.pots`, `modules.doorbell`                   | Every live pot (stage, raised, what each contributor can take back); the Doorbell's rings, hires, deliveries and whether it is funded.                                                                                        |
| `modules.rules`, `modules.endowments`                | Every armed rule (whether it can fire, what its condition reads, its tip and escrow) and the orders of rules still to be reconciled; the buffer, the next stake block and what each endowment can harvest.                    |
| `errors`                                             | Modules that could not be read.                                                                                                                                                                                               |

Amounts are decimal strings of wei.

## Settings

Everything is an environment variable; `.env.example` lists every one with its default. The ones
most worth knowing:

| Variable                                | Default                                                  |                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `QUESTIONS`, `JOBS_REPORT`, `PAYROLL`   | from `packages/shared/src/deployments.ts` once filled in | The three contracts.                                                                                                  |
| `RPC_URL`                               | a public node                                            | An Ethereum mainnet RPC.                                                                                              |
| `LIVE`, `KEEPER_PRIVATE_KEY`            | unset                                                    | Both are needed to send anything.                                                                                     |
| `WORK_ORDERS`, `CROWD_POTS`, `DOORBELL` | from the deployments book once filled in                 | Launch B. Each switches its module on.                                                                                |
| `RULES`, `ENDOWMENTS`                   | from the deployments book once filled in                 | Launch C. `rules` needs `WORK_ORDERS` too.                                                                            |
| `START_BLOCK_B`, `START_BLOCK_C`        | from the deployments book once filled in                 | Where the pots' and the rules' logs are read from.                                                                    |
| `MODULES`                               | launch A's three, and any later one whose address is set | Name them to choose: `desk,pots,doorbell`.                                                                            |
| `CHALLENGE_FLOAT_IMD`                   | 0                                                        | Most IMD posted as challenge bonds at once.                                                                           |
| `CHALLENGE_DAILY_CAP_IMD`               | 0                                                        | Most posted per UTC day. Both, or no challenges.                                                                      |
| `CHALLENGE_EMPLOYERS`                   | empty: any employer                                      | The employers whose orders are defended.                                                                              |
| `CHALLENGE_ARBITERS`                    | empty                                                    | Arbiters accepted on a challenged order.                                                                              |
| `DESK_OWN_RUNNERS`                      | empty                                                    | Runners never evicted or timed out.                                                                                   |
| `RULES_HOUSE`                           | empty                                                    | Rule ids always fired when they can be.                                                                               |
| `RULES_IMD_PER_ETH`                     | unset: only house rules fire                             | Your figure for what one ETH is worth in IMD.                                                                         |
| `MAX_FEE_GWEI`                          | 5                                                        | Nothing is sent while the network asks more.                                                                          |
| `MAX_TX_COST_ETH`                       | 0.02                                                     | The most one transaction may cost. A settlement on the desk is sent with about two million gas: 0.0104 ETH at 5 gwei. |
| `DAILY_SPEND_CAP_ETH`                   | 0.05                                                     | The most gas money per UTC day.                                                                                       |
| `REQUEST_AT_UTC`                        | unset                                                    | The time of day to ask at, for example `14:00`.                                                                       |
| `TIP_COLLECT_MIN_IMD`                   | 0.5                                                      |                                                                                                                       |
| `CLOSE_ROUNDS_IN_PROGRESS`              | 0                                                        | See [closing a round](#closing-a-round).                                                                              |
| `POLL_SECONDS`                          | 300                                                      |                                                                                                                       |

## What it costs

Gas only. Launch A measured a request at 418,000 to 451,000 gas against the live Intake on a
mainnet fork (`launches/a-payroll/README.md`). The keeper's integration test, on a local node with
stand-ins for the Intake and the tokens, measured the rest:

| Call                              | Gas                                                     |
| --------------------------------- | ------------------------------------------------------- |
| `Questions.submit`                | 143,000                                                 |
| `JobsReport.print`                | 117,000 to 305,000 (one feed's round; two days of both) |
| `JobsReport.crown`                | 172,000                                                 |
| `Questions.abandon`               | 44,000 (starts the wait) to 73,000 (closes)             |
| `Questions.collectTips`           | 40,000 to 50,000                                        |
| `Payroll.drip`                    | 67,000 to 84,000                                        |
| `Payroll.book`                    | 234,000 (the first ever)                                |
| `Payroll.fundFeeds`, three meters | 321,000                                                 |

For launches B and C, from the joint integration test (the real contracts of all three launches
on a local node, stand-in token and vault):

| Call                                       | Gas used                                                |
| ------------------------------------------ | ------------------------------------------------------- |
| `WorkOrders.refund`                        | 45,000 to 67,000                                        |
| `WorkOrders.trigger`                       | 50,000 (sent with at least 200,000)                     |
| `WorkOrders.evict`, `timeout`              | 94,000, 92,000                                          |
| `WorkOrders.finalize`                      | 194,000 to 278,000 (it must be offered about 2 million) |
| `WorkOrders.settle`, a 3.5 KB record       | 591,000 (sent with 1,916,000; the runner's transaction) |
| `WorkOrders.stamp`, a 3.5 KB record        | 227,000                                                 |
| `IMD.approve` and `WorkOrders.challenge`   | 46,000 and 53,000                                       |
| `CrowdPots.launch`                         | 333,000                                                 |
| `CrowdPots.claimRefunds`, two contributors | 93,000                                                  |
| `Rules.fire`, VIEW then HIRE               | 311,000 (sent with at least 700,000)                    |
| `Rules.reconcile`                          | 74,000                                                  |
| `Endowments.stake`                         | 127,000 to 178,000                                      |
| `Endowments.harvest` into a meter          | 201,000                                                 |

A day of two requests, two answers handed in, a print and twenty-four drips is about 3.2 million
gas: 0.0032 ETH at 1 gwei. The first day is about 4.5 million (`createFeed` alone is 820,000 to
1,120,000 for each feed). Print these again with
`HW_PRINT_GAS=1 pnpm --filter @help-wanted/keeper test:integration`.

The keeper earns the tip of every round it opened that is answered, whether the Intake's callback
or anybody's `submit` delivers the answer: 0.05 IMD each on the house feeds. Handing in the answer
of a round somebody else opened earns nothing; the keeper does it all the same, so that the feed
has its figure.

## What is not verified

- **An answer delivered by the Intake's own callback.** On 13 October 2026 both answers that
  reached the launched `Questions` were handed in by this keeper with `submit` (payrolls in block
  26183772, hires in block 26183780): the oracle had signed each for the `Questions` contract, and
  the contract accepted them. No answer has come by the callback yet, so what the keeper does
  after one (for the employers feed, which only the callback can answer, `crown` included) has run
  on a local node only. If an answer comes signed for another address, the keeper does not send it
  and the status file says who it was signed for.
- **How late the writer can be.** More than seven hours was seen on 13 October 2026. For the
  employers feed, which only the callback can answer, the round is closable by anyone 36 hours,
  5 minutes and one second after its request.
- **The keeper against mainnet, beyond launch A's first day.** On 13 October 2026 it sent thirteen
  transactions to the live contracts: the first day (three `createFeed`, one approval, three
  `fund`, three `request`), two `submit` and the first `print`. Closing a silent round, `crown`,
  `collectTips`, Payroll's calls and a second day's requests have run on a local node only (below).
- **The modules of launches B and C against the deployed contracts.** Neither launch is deployed.
  They have run against the real contracts of both, built from the launch projects' own output,
  on a local node, with a stand-in for the WorkRegistry and a local server in place of
  IdentityMD's API.
- **The check of a delivery claim against the live API.** The shapes of `GET /jobs/:id` and
  `GET /jobs/:id/records` are the shared package's schemas, written against real responses. That
  the API lists a record's hash before, or within minutes of, the job turning `completed` is
  assumed: a claim made in that gap would be seen failing. The second look that a challenge waits
  for (`CHALLENGE_CONFIRM_SECONDS`, fifteen minutes) is there for that, and has not been timed
  against the live service.
- **A record above 100,000 bytes.** The keeper does not send the chunked proof
  (`WorkProof.proveChunks`); it says when one is needed.
- **Pots and rules older than a node's log window.** Their texts come from logs; against a node
  that serves only recent logs they are not found, and the keeper says so and sends nothing.
- **Two daily requests in one block.** The keeper sends them in consecutive blocks.
- **A replaced transaction.** Raising the fee of a transaction that is not mined is tested against
  a stand-in for the node, not a real mempool.

## Tests

```sh
pnpm --filter @help-wanted/keeper typecheck
pnpm --filter @help-wanted/keeper test               # everything
pnpm --filter @help-wanted/keeper test:unit          # the decision rules, the writer, the settings
pnpm --filter @help-wanted/keeper test:integration   # a local node: launch A's day, and all three launches with the runner
```

No test reaches the internet.

The unit tests cover every decision rule with one second before and one second at each boundary
(submit opening, the silence deadline, the thirty minutes after a seen completion, an answer's expiry,
the hourly drip, the fortnight, the daily slot, the daily cap at midnight UTC).

The integration test starts `anvil` itself (no fork, chain id 1), deploys launch A's three
contracts from `launches/a-payroll/out`, with stand-ins for IMD, sIMD, the seats, the Adapter and
the Intake that it compiles from `contracts/` (`forge build --offline`), and plays IdentityMD's
service with a local HTTP server and an oracle key from the public test mnemonic. It then walks the
first day and the days after it. It needs Foundry on the PATH and launch A built; without either
it is skipped with a message that says which.

The joint test (`test/integration/company.test.ts`) deploys the real contracts of all three
launches, in launch order, and runs this keeper and the runner of `bots/runner` together against
them, both built the way their command lines build them. The stand-in token and a stand-in
WorkRegistry are placed at IMD's and the registry's mainnet addresses on the local node, because
the runner reads them there and nowhere else; the test plays the registry's writer. A local server
(`test/integration/plane.ts`) plays IdentityMD: the job and record routes both bots read, the free
preflight, and the paid-request routes, where the runner's Permit2 signature and its quote
approval are each recovered and checked the way IdentityMD's guide describes before a job is
admitted, and the fee is then moved on the local chain out of the runner's allowance to Permit2.
It walks, with balances read from the chain at each step:

1. an order taken, paid for, registered and settled on its receipt: the runner paid, the fee and
   the tip in the real Payroll (the tip credited to the agent the record names), the change back
   with the employer;
2. the same while receipts are stalled: a receipt-only order is left alone; delivery is claimed,
   the keeper checks the claim and leaves it, finalizes it when its window has passed, and stamps
   the order when the receipt lands days later;
3. an untrue delivery claim (a hash the API does not list): reported with challenges off,
   challenged on the second look with them on, and at the delivery deadline the employer is
   refunded with a tenth of the claimer's bond and the keeper has its own back;
4. a full crowd pot launched by the keeper, delivered, its change shared three to two; and a
   second pot whose runner registers nothing: evicted, the order refunded at its expiry, and 5.25
   IMD (the forfeited bond included) shared 3.15 to 2.10;
5. a rule whose view condition becomes true: not fired while its tip cannot be held against the
   gas, fired from the house list, the order taken by the runner, and its change handed back to
   the rule by `reconcile`;
6. an order whose condition reads a Standing Question's answer: untouched at 400, latched by the
   keeper once the answer is 1,400, and taken by the runner. (The second answer is handed in by
   another wallet than the round's opener: the tip is the opener's.)

It also checks that the Doorbell is reported and never rung, and that an endowment's buffer is
staked and its yield harvested into the feed's meter.

## Adding a module

A module is two functions and nothing more: an `observe` function that only reads (the chain at
one block and, where it must, IdentityMD's API) into a plain snapshot, and a pure `decide`
function that turns the snapshot and the operator's settings into actions, each with the reason
its rule fired, and things it is waiting for. To add one: write the two beside the others in
`src/observe/` and `src/modules/`, give `decide` a unit test for every rule with one second
before and one second at each boundary, add its name to `src/modules/names.ts`, the addresses it
needs to `src/config.ts`, and one block to `look` in `src/pass.ts`. The executor, the caps, the
kill switch and the status file are shared.

## Layout

```
src/cli.ts            the command line: once, run, status, first-day
src/config.ts         settings from the environment
src/runtime.ts        wires a configuration to a node, the API, the state file and the writer
src/chain.ts          the one place a transaction is sent from, with every cap
src/pass.ts           one pass: look, decide, act, look again, write the status
src/modules/          the decision rules, one pure function per module
src/observe/          the reads behind each module's snapshot
src/modules/          the decision rules, one pure function each: questions, jobsReport, payroll,
                      desk (with the check of a delivery claim), pots, doorbell, rules, endowments
src/observe/          what each module reads; nothing here sends
src/firstDay.ts       the first-day plan (pure); src/firstDayRun.ts runs it
src/status.ts         the status file
src/store.ts          the state file: spending per day, the transaction in flight, round notes,
                      challenge bonds per day, the claims looked at, texts read from logs
contracts/            stand-in contracts for the integration tests only
test/integration/     harness.ts (the node, launch A, the oracle), world.ts (launches B and C),
                      plane.ts (IdentityMD's job and paid-request routes), day.test.ts,
                      company.test.ts
```
