# HELP WANTED, launch C: Rules, Endowments and Zap

Three contracts for Ethereum mainnet with no owner and no token. They sit on top of the two earlier
launches of HELP WANTED, a job board on which the employer can be a contract.

- **`Rules`** keeps standing sentences: _when_ a condition is true, _then_ hire or pay, from the
  rule's own escrow. The condition is a view call on any contract, or the newest answer of a
  Standing Question. Anyone may fire a rule whose condition holds and is paid the tip its creator
  set.
- **`Endowments`** holds IMD whose yield, and only its yield, pays for one fixed thing: a Standing
  Question's meter, a crowd pot, or a recipient. Deposits are staked in IdentityMD's sIMD vault and
  every depositor can take back exactly what they put in.
- **`Zap`** lets somebody who holds only ETH take part: it swaps the ETH for IMD on the Uniswap v4
  ETH/IMD pool, with the caller's own minimum and deadline, and chips into a crowd pot or funds a
  Standing Question's meter in the caller's name, or hands the IMD over.

**Status, read this first (19 October 2026).**

- **Live on Ethereum mainnet since 15 October 2026.** IdentityMD launch 1845 created the three
  contracts in one transaction, `0x1806c02e5e38d4c8496476b3f3cf39f250a9d0c97ff5834c75a0475a12bd62fb`
  (block 26198165): `Rules` at `0xcbF0dddF07C00a78E2E7561a6F47C275B8c05D7E`, `Endowments` at
  `0xbE916A53b9Bbe634AF7E10E604E06b6069edEE76` and `Zap` at
  `0x51bF8c74bd9BD74Ad08cABDC90DaC7835C18B21A`. `src/` is the source that was deployed.
  IdentityMD's pipeline changed no file under `src/` before deploying. `ADAPTATION.md` lists what
  its audit of the imported code raised (two low findings and one note) and what was added for them
  (tests and sentences in `docs/THREATS.md`). That is not all the pipeline's reviewers reported:
  the launch's pull request says they raised 13 findings, and IdentityMD's record of the job holds
  13, six low and seven info, none marked blocking. The ten raised after the code was adapted were
  answered by no node of the pipeline, and the code was deployed as it was. They come down to four
  matters not raised before and one that `ADAPTATION.md` had already answered. `docs/AUDITS.md`
  lists all 13 and what became of each; the four new matters (its rows 4 to 7) are limits
  `docs/THREATS.md` states since 15 October 2026 (R11, E7, E9 and Z4). `docs/LAUNCH.md` is the
  launch request and the runbook, kept as written before the launch, apart from its status
  paragraph.
- **The two launches it builds on are live.** Three of the ten constructor arguments are contracts
  of HELP WANTED's earlier launches on Ethereum mainnet: `Questions`
  (`0xEECE4628ceb091C13393fc64056Be8b8501fD3F6`) of launch A, IdentityMD launch 1531, and
  `WorkOrders` (`0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2`) and `CrowdPots`
  (`0x8C2FfCdcb103659aa05c772b8F2059868B496EB5`) of launch B, IdentityMD launch 1573, both created on
  13 October 2026. They are written into the manifest, and a fork test checks each against the
  factory's own record of its launch.
- **Its first rule was created and fired by the team's wallet on mainnet, and the order it opened
  was paid on proof (16 October 2026).** The team's wallet H1 created rule 1, the rule of
  `docs/LAUNCH.md`, section 6, step 2 (transaction
  `0x8c69fca9fcdd1893181832d708cfbf69fb7227c127206c4bcdd00bc0028e548b`, block 26204482, 365,124
  gas). It fired the rule by hand with `scripts/first-rule.sh` at the root of the
  HELP WANTED repository (transaction
  `0x9f790aae9db07625dc86b6c107d7ed55b43f96ba5bfaf5b02c64269ab963e37b`, block 26204499, 348,583
  gas). Anyone may fire a rule whose condition holds. This time the team's own wallet did, and the
  0.01 IMD tip went back to it. The fire read launch A's hires feed (223, round 1, answered on 13
  October) and opened order 2 on the live desk with `Rules` as the employer. The team's runner,
  hosted and running unattended, took the order at 0.56005 IMD and bought the research-report job
  `42f26c64-eea9-46f2-822a-33547ec18abf`. It settled the order on the receipt IdentityMD's writer
  wrote for that job (transaction
  `0x35bb49cc9576a425b94a94137e8fe24e496017cc154456eeee255d22fc020516`, block 26204543). The desk
  marked the order proven and called `onWorkDelivered`, which credited the 0.03995 IMD the order
  did not spend to rule 1. The rule's one fire was used. H1 then called `cancel(1)` and took that
  amount back (transaction `0x9c062d891f69d829be26a31cbc8cd7ed7a55bdfae3f3f0fcd7d2853ec3cb6846`).
  The rule's creator, the wallet that fired it and the runner were all the team's own. Apart from
  IdentityMD's fee address, which the runner paid 0.5 IMD for the job, the one wallet outside the
  team that was paid is the owner of seat 1978, paid the tip of agent 52142 when H1 called
  `Payroll.claimTip` (transaction
  `0xd7a75e9c71968ba67badb671c96103a55364d78b563e6b6561a08b98603f6273`); it did nothing to be paid.
  This shows a rule hiring the swarm on mainnet against a real receipt. Nobody outside the team
  has used these contracts.
- **The endowment drill took the principal back to the wei, and harvested nothing (15 to 19
  October 2026).** The team's wallet W1 created endowment 1 for the meter of launch A's payrolls
  feed, deposited 1 IMD
  (`0x523e1145cf4f9eaf962eedfc6f917c9d0c0402e9e552a732018e525546a8aa06`, block 26198207) and
  staked it into sIMD (block 26198303). On 19 October it called `withdraw(1, 1 IMD)` and received
  exactly 1 IMD (`0xcb48313ac8f8ac053fb6f1316dd8359795720441809c8d2503773612ba47024e`, block
  26226427). `harvest` runs only for 0.001 IMD or more, and `harvestable(1)` read 0 throughout:
  sIMD's price did not move from block 26198165 to block 26226427, so the staked IMD earned
  nothing. The drill shows a principal taken back in full, not yield paying for a question.
- **In this repository's own offline suite those three contracts are stand-ins**, because their
  sources belong to two other repositories. The fork suite meets the live contracts at their
  addresses, with real IMD: a rule fires on launch A's live hires feed, opens an order on the live
  desk and is paid on a work record written into IdentityMD's real WorkRegistry; an endowment funds
  the live payrolls meter from yield; Zap chips into a pot on the live CrowdPots. A second Foundry
  project in `integration/` compiles the real sources from the sibling folders and runs these
  contracts, and every stand-in, against them. It builds only where the three launch folders sit
  side by side.
- **What the product needs from outside, as of 16 October 2026.** A HIRE rule's order without the
  desk's claimed path (as rule 1's) is paid only on an on-chain receipt of IdentityMD's
  WorkRegistry; a creator may allow the bonded-claim path instead. The WorkRegistry wrote no
  receipt from about 8 October until 13 October 2026, 17:26 UTC (block 26,185,055). It then worked
  through its backlog, and on 14 October the desk's first order (the Doorbell's) was paid on its job's receipt,
  written that day. On 16 October the order of this launch's rule 1 (order 2 on the desk) was paid
  the same way. Its job's receipt was written in block 26,204,533, two blocks before the runner
  registered the job. A FEED rule needs answers on a Standing Question: launch A's payrolls, hires and
  employers feeds each had one answered round, from 13 October. How often a feed is asked depends on
  somebody paying for its rounds.
- **Audited by IdentityMD's launch pipeline, and by nobody outside IdentityMD's network.**
  IdentityMD records no outside audit or bounty for this launch. `docs/AUDITS.md` lists what the
  pipeline's reviewers reported. `docs/THREATS.md` lists every trust root and every known limit,
  and in section 10 what we checked here after IdentityMD's pipeline changed our first launch;
  `docs/DEVIATIONS.md` lists where we depart from IdentityMD's guidance.

## Check three claims yourself

Zap names its pool by an id it computes from the IMD address, with no call to anything. The same
computation with Foundry's `cast`, and the live pool behind that id (run on 13 October 2026, 00:48
UTC; the second command needs a mainnet RPC):

```sh
cast keccak $(cast abi-encode "f(address,address,uint24,int24,address)" \
  0x0000000000000000000000000000000000000000 0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7 \
  10000 200 0x0000000000000000000000000000000000000000)
# 0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3

cast call 0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227 "getSlot0(bytes32)(uint160,int24,uint24,uint24)" \
  0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3 \
  --rpc-url https://ethereum-rpc.publicnode.com
# a price that is not zero, and 10000 as the last number: the pool exists and its fee is 1%
```

Endowments counts on sIMD being a plain vault over IMD: what it reports as its assets is the IMD it
holds, so yield reaches every share by a plain transfer and by nothing else. On 13 October 2026 both
of these printed `1796987879036253851335449`:

```sh
cast call 0x9efa934d9fad4ae28c998a40195646b965a97247 "totalAssets()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast call 0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7 "balanceOf(address)(uint256)" \
  0x9efa934d9fad4ae28c998a40195646b965a97247 --rpc-url https://ethereum-rpc.publicnode.com
```

The three addresses of the earlier launches are the ones IdentityMD's ProjectFactory created: the
data of its `ContractsLaunched` event in each launch's transaction lists the contracts in manifest
order (launch 1531: Questions, JobsReport, Payroll; launch 1573: WorkProof, WorkOrders, CrowdPots,
Doorbell). Run on 15 October 2026:

```sh
cast receipt 0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58 --json --rpc-url https://ethereum-rpc.publicnode.com \
  | jq -r '.logs[] | select(.address=="0xff03410d0fe5fa8f7f59f743de35e333d9857120") | .data'
# ends with eece4628…d3f6, 58963b57…bce4, 6e4362a5…5f1f
cast receipt 0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c --json --rpc-url https://ethereum-rpc.publicnode.com \
  | jq -r '.logs[] | select(.address=="0xff03410d0fe5fa8f7f59f743de35e333d9857120") | .data'
# ends with b268297d…7469, 730cb6c8…78d2, 8c2ffcdc…6eb5, fd5ab7e0…fccb
```

## Build and test

Foundry is the only requirement. Dependencies (forge-std, OpenZeppelin Contracts 5.5.0) are
vendored in `lib/`, so no network is needed for the first three commands.

```sh
forge fmt --check
forge build --sizes
forge test
```

`forge test` runs 447 tests in 26 suites and needs no network. It skips the fork tests.

```sh
FOUNDRY_PROFILE=fork forge test
```

runs the 34 fork tests against Ethereum mainnet at the latest block, through the RPC named in
`foundry.toml`. Each fork test skips itself when the RPC cannot be reached. They include a rehearsal
of this launch through IdentityMD's real ProjectFactory, called as the launch deployer, against the
live contracts of launches A and B; a check of those three addresses against the factory's own
record; each contract used with the real IMD, the real sIMD vault and the real Uniswap pool; and the
first day of `docs/LAUNCH.md`, with its amounts, against the live Questions, hire desk, crowd pots
and Payroll, the order settled on a receipt written into IdentityMD's real WorkRegistry by acting as
its writer. Two of them read launch A's live hires feed and skip themselves, saying why, on a day its
newest answer is too old for the first rule.

```sh
cd integration && forge test
```

runs 51 tests against the real `Questions`, `WorkOrders`, `WorkProof` and `CrowdPots`, compiled
from `../a-payroll` and `../b-desk` beside this folder, as they were launched. In a checkout that
holds this repository alone the command does not build; nothing else here depends on it, and
`forge build`, `forge test` and `forge fmt --check` run from this folder do not reach it. What those
tests cover is listed under "What the stand-ins stand for" below.

```sh
slither . --filter-paths "lib|test"
```

reports no finding of high or medium impact (Slither 0.11.4). Its low findings and the places where
the source silences a detector are explained one by one in `docs/THREATS.md`, section 8.

The compiler settings are the ones a launch requires and are in `foundry.toml`: solc 0.8.26, EVM
version cancun, optimizer at 200 runs, `via_ir`, `bytecode_hash = "none"`, `cbor_metadata = false`.
A full build takes a few minutes because of `via_ir`.

## The contracts

| Contract     | File                            | Runtime bytes | Initcode bytes | Holds money                                                                     |
| ------------ | ------------------------------- | ------------- | -------------- | ------------------------------------------------------------------------------- |
| `Rules`      | `src/rules/Rules.sol`           | 13,762        | 14,153         | The escrows of its rules, in IMD                                                |
| `Endowments` | `src/endowments/Endowments.sol` | 13,161        | 13,746         | Deposits waiting to be staked, in IMD, and the sIMD shares of everything staked |
| `Zap`        | `src/rules/Zap.sol`             | 3,834         | 4,458          | Nothing between calls                                                           |

The limits are 24,576 bytes of runtime code and 49,152 of initcode; our own gates are 23,000 and
46,000, and a test fails above them.

Supporting code: `src/rules/v4/IPoolManagerLike.sol` holds the four Uniswap v4 calls a swap needs,
written out because v4-core is not vendored. `src/interfaces/` holds what the contracts compile
against: `IQuestions` (launch A's file) and `IWorkOrders` and `ICrowdPots` (launch B's files),
copied here unchanged. `src/interfaces/external/Mainnet.sol` lists mainnet addresses for tests and
documents; no deployed contract imports it.

### How they fit together

1. A **rule's creator** calls `Rules.createRule` with a condition, an action and a deposit. A VIEW
   condition is a contract, up to 132 bytes of calldata, a comparison and a threshold. A FEED
   condition is a Standing Question, a comparison, a threshold and the oldest answer the creator
   will act on. A HIRE action is the terms and the job text of an order on the hire desk; a PAY
   action is an amount and a recipient.
2. **Anyone** calls `fire` when the condition holds. Rules reads the condition itself, with a fixed
   gas allowance that the caller cannot shrink, takes the action's cost and the tip from the rule's
   escrow, opens the order (Rules is its employer) or makes the payment, and pays the caller the tip.
3. What the desk later hands back for an order (a refund, the change of a delivered job, a runner's
   forfeited bond) returns to the rule through `reconcile`, which reads the amount from the desk's
   own books. A rule that asked for it gets the change inside the desk's delivery callback.
4. An **endowment's creator** fixes its target for good: `createForMeter`, `createForPot` or
   `createForRecipient`. **Anyone** then deposits. Deposits wait in the contract until `stake`
   (anyone, at most once every 50 blocks) moves them into sIMD in one batch.
5. **Anyone** calls `harvest`. Only the shares an endowment holds beyond what its principal needs
   are redeemed, and the IMD goes to the target: a meter is topped up to thirty requests' worth and
   no further; a pot is given what it still needs, in the name of the endowment's fallback
   beneficiary, who is paid directly only when the pot takes nothing; a recipient is sent all of it.
6. A **depositor** calls `withdraw` and gets exactly the amount back. In a block where sIMD is
   holding the contract, `exit` hands over sIMD shares of the same worth instead.
7. A **wallet with ETH** calls `Zap.chipIn`, `fundMeter` or `buy` with the least IMD it accepts and
   a deadline. Zap swaps, passes the IMD on in the caller's name, and returns what is left over.

## Every entry point

No function in any of the three contracts is restricted to an owner or an admin: there is none.
"Anyone" below means any account or contract. Every function that changes state holds one
transient-storage lock per contract, so a nested call into the same contract reverts
`ReentrancyGuardReentrantCall`. Besides the errors listed, a call can revert with the IMD token's
own error or `SafeERC20FailedOperation` when a transfer or an allowance fails.

The tables are complete. `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes` reads each
contract's ABI as the compiler wrote it and fails if a contract has a state-changing function that
is not in its table, a `receive`, a fallback, or a function that takes ETH other than Zap's three.

### Rules

| Function                                      | Who may call                      | What it does                                                                                                                                   | Reverts when                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRule(params, spec, deposit)`           | Anyone, having approved `deposit` | Creates a rule and escrows `deposit` IMD for it. The caller is its creator.                                                                    | `ZeroAddress` (no condition target); `BadComparison`; `ZeroFires`; `BadCondition`; `BadConditionData` (more than 132 bytes); `ZeroMaxAge`; `FieldNotUsed`; `BadAction`; `BadPay`; `BadRecipient`; `ZeroTtl`; `SpecInvalid(at)`; `BelowDeskMinimum`; `AboveDeskMaximum`; `BadFlags`; `CostTooHigh`; for a HIRE rule, the desk cannot be read. |
| `topUp(id, amount)`                           | Anyone, having approved           | Adds to a rule's escrow. Money added by somebody else is a gift to the rule.                                                                   | `UnknownRule`; `RuleIsCancelled`; `ZeroAmount`.                                                                                                                                                                                                                                                                                              |
| `cancel(id)`                                  | **The rule's creator**            | Ends the rule and sends its unspent escrow to the creator.                                                                                     | `NotCreator`; `RuleIsCancelled`.                                                                                                                                                                                                                                                                                                             |
| `fire(id, spec)`                              | Anyone                            | Fires a rule whose condition holds: opens its order or makes its payment, and pays the caller the tip.                                         | `UnknownRule`; `RuleIsCancelled`; `RuleExhausted`; `CoolingDown(readyAt)`; `GasShort`; `ConditionNotMet`; `EscrowShort(needed, held)`; `WrongSpec`; the desk refuses the order (the desk's error); `DeskPulledWrongAmount`; `OrderAlreadyLinked`.                                                                                            |
| `reconcile(id, orderId)`                      | Anyone                            | Hands back to a rule what the desk has returned for one of its orders since the last call. For a cancelled rule the money goes to its creator. | `NotThisRulesOrder`; `ReturnNotReceived`.                                                                                                                                                                                                                                                                                                    |
| `recall(id, orderId)`                         | **The rule's creator**            | Withdraws from the desk an order nobody has taken, and reconciles it.                                                                          | `NotCreator`; `NotThisRulesOrder`; the desk's error when the order can no longer be withdrawn; `ReturnNotReceived`.                                                                                                                                                                                                                          |
| `onWorkDelivered(orderId, jobId, recordHash)` | **The hire desk only**            | Records a delivery and reconciles that order. An order Rules does not know is ignored.                                                         | `NotDesk`; `NotThisRulesOrder`; `ReturnNotReceived`.                                                                                                                                                                                                                                                                                         |

Views: `getRule`, `statusOf`, `check`, `canFire`, `costOf`, `orderOf`, `ruleCount`, `totalEscrowed`,
and the constants and constructor arguments by name. `check` and `canFire` never revert because of
what a condition's target does.

### Endowments

| Function                                   | Who may call                                    | What it does                                                                                                    | Reverts when                                                                                                                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createForMeter(feedId)`                   | Anyone, having approved the seed (0.000001 IMD) | Creates an endowment whose yield tops up one Standing Question's meter.                                         | `BadTarget` (a zero id); `FeedNotLive(feedId)`: Questions states no cost for the feed; Questions cannot be read; `TransferMismatch`.                                                                                                                   |
| `createForPot(potId, fallbackBeneficiary)` | Anyone, having approved the seed                | Creates an endowment whose yield chips into one crowd pot or series, in the beneficiary's name.                 | `BadTarget`; `UnknownPot(potId)`; the pots cannot be read; `TransferMismatch`.                                                                                                                                                                         |
| `createForRecipient(recipient)`            | Anyone, having approved the seed                | Creates an endowment whose yield is sent to one address.                                                        | `BadTarget`; `TransferMismatch`.                                                                                                                                                                                                                       |
| `deposit(id, amount)`                      | Anyone, having approved                         | Adds IMD to an endowment as the caller's principal.                                                             | `ZeroAmount`; `UnknownEndowment`; `EndowmentShort`; `TransferMismatch`.                                                                                                                                                                                |
| `donate(id, amount)`                       | Anyone, having approved                         | Gives IMD to an endowment without becoming a depositor. It cannot be taken back.                                | `ZeroAmount`; `UnknownEndowment`; `TransferMismatch`.                                                                                                                                                                                                  |
| `stake()`                                  | Anyone, at most once every 50 blocks            | Moves all waiting IMD into sIMD.                                                                                | `TooSoon(nextBlock)`; `NothingToStake`; `WrongVault`; `PriceFell(price, mark)`; `VaultMismatch`.                                                                                                                                                       |
| `withdraw(id, amount)`                     | **A depositor**, for its own principal          | Takes back exactly `amount` IMD.                                                                                | `ZeroAmount`; `UnknownEndowment`; `OverPrincipal(have)`; `HoldActive`; `BelowMinimum(out, minOut)`; sIMD's own error in a block where somebody else caused a hold; `VaultMismatch`.                                                                    |
| `exit(id, amount, minOut, inKind)`         | **A depositor**, for its own principal          | The long form of `withdraw`: accepts less when the endowment is short, and can take sIMD shares instead of IMD. | As `withdraw`.                                                                                                                                                                                                                                         |
| `harvest(id)`                              | Anyone                                          | Sends an endowment's yield to its target.                                                                       | `UnknownEndowment`; `LowGas` (a pot endowment sent too little gas); `NothingToHarvest`; `HoldActive`; `PriceFell(price, mark)`; `VaultMismatch`; `TargetMismatch`; for a meter, Questions' own error; sIMD's own error in a hold somebody else caused. |

Views: `endowment`, `principalOf`, `backingOf`, `isWhole`, `harvestable`, `quote`, `nextStakeBlock`,
`vaultHold`, `priceBelowMark`, `epochs`, `endowmentCount`, `pendingTotal`, `epoch`, `lastStakeBlock`,
`priceMark`, and the constants and constructor arguments by name.

### Zap

| Function                                             | Who may call             | What it does                                                                                                                      | Reverts when                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chipIn(potId, minImdOut, deadline)` (takes ETH)     | Anyone                   | Swaps the ETH sent for IMD and chips it into a pot in the caller's name. What the pot does not need returns to the caller as IMD. | `DeadlinePassed(deadline)`; `NoEth`; `TooLittleOut(imdOut, minImdOut)`; `NothingChipped`; `UnexpectedDelta`; `EthRefundFailed`; the pool's or the pots' own error.                    |
| `fundMeter(feedId, minImdOut, deadline)` (takes ETH) | Anyone                   | Swaps the ETH sent for IMD and adds it to a feed's meter; the meter shares are the caller's.                                      | `DeadlinePassed(deadline)`; `NoEth`; `TooLittleOut(imdOut, minImdOut)`; `NothingFunded`; Questions' own error, for an unknown feed for example; `UnexpectedDelta`; `EthRefundFailed`. |
| `buy(minImdOut, deadline)` (takes ETH)               | Anyone                   | Swaps the ETH sent for IMD and sends the IMD to the caller.                                                                       | `DeadlinePassed(deadline)`; `NoEth`; `TooLittleOut(imdOut, minImdOut)`; `UnexpectedDelta`; `EthRefundFailed`.                                                                         |
| `unlockCallback(data)`                               | **The PoolManager only** | The swap itself, inside the three functions above.                                                                                | `NotPoolManager`; `UnexpectedDelta`.                                                                                                                                                  |

Views: `poolKey`, `POOL_ID`, `POOL_FEE`, `POOL_TICK_SPACING`, and the constructor arguments by name.
Zap has no `receive`: ETH reaches it only with one of the three calls.

## What the stand-ins stand for

The main test suite cannot compile `Questions`, `WorkOrders` or `CrowdPots`: they are other
repositories. Its offline tests use stand-ins written from their sources, and its fork tests the
live contracts (`test/launch/fork/LiveSiblings.fork.t.sol`, `test/rules/fork/RulesDeskFork.t.sol`,
`test/launch/fork/LaunchC.fork.t.sol`). The stand-ins are `test/rules/mocks/MockDesk.sol`,
`MockFeed.sol`, `MockPots.sol` and `MockQuestions.sol`, and `test/endowments/mocks/MockQuestions.sol`
and `MockCrowdPots.sol`. Each stand-in's header says what it copies and what it leaves out; most can
also be switched to fail in ways the real contracts cannot.

`integration/` is the check on them, and the run against the real thing:

| What runs against the real sources                                                                                                                                                                                                                                                  | Tests                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Zap and the real `Questions.fundFor`: the shares are the caller's, Zap keeps none; the real refusals come through                                                                                                                                                                   | `ZapWithRealSiblings.t.sol`        |
| Zap and the real `CrowdPots.chipInFor`: the chip and its refund are the caller's; a full pot, an unknown pot and a pot out of time; a series                                                                                                                                        | the same file                      |
| A meter endowment on the real meter: the runway of thirty requests at the real `costOf`, a real round bought, a real round failed, the Intake repriced and not selling                                                                                                              | `EndowmentsWithRealSiblings.t.sol` |
| A pot endowment on the real pots: a pot, a series round after round, a pot out of time, the gas the real chip uses                                                                                                                                                                  | the same file                      |
| A HIRE rule on the real desk: the desk's limits, the spec rule byte for byte, an order settled on a real IdentityMD work record through the real `WorkProof` with the change returned inside the desk's callback, recall, expiry, a released and a forfeited bond, the claimed path | `RulesWithRealDesk.t.sol`          |
| A FEED rule on the real Questions: one fire per answered round, a failed round, an old answer                                                                                                                                                                                       | `RulesWithRealQuestions.t.sol`     |
| Each stand-in beside the real contract, driven by the same calls: acceptances, refusals with the same bytes, amounts, books                                                                                                                                                         | `StandInsAgree.t.sol`              |
| The shell commands `docs/LAUNCH.md` addresses to the three sibling contracts: each names a function of the real contract, and the desk answers what the document says to expect                                                                                                     | `DocumentedCommands.t.sol`         |

Still stand-ins there: IMD, the sIMD vault and the PoolManager (the fork suite uses the real ones),
IdentityMD's WorkRegistry and Intake (test doubles of launches B and A; the fork suite writes a
receipt into the real registry), the oracle's signing key (a test key), and Payroll behind the desk
(launch B's stand-in; this launch never calls Payroll, and the fork suite reads the live one's books
when a rule's order is settled).

## What was measured

Sizes and launch gas are in `docs/LAUNCH.md`, section 3: about 7.91 million gas for the whole launch
in the fork rehearsal, against our gate of 12,000,000 and the protocol's ceiling of 16.7 million. The
gas of every call the first day makes, against the live contracts on a fork, and of the calls a user
pays for, is in section 8 of the same document, each figure beside the test that prints it. On
mainnet on 16 October 2026 the first rule's `createRule` used 365,124 gas and its `fire` 348,583
(sent with the documented 700,000), and the settlement of its order 488,072 with a 3,801-byte
record.

The figures are as Foundry 1.8.3 prints them with its default settings on the day of the run (15
October 2026).

## Documents

- `docs/LAUNCH.md`: the launch request, the manifest with the source of every constructor argument,
  every value fixed at launch, what was checked before launching, the first-day runbook with every
  amount that goes in, comes back or is spent, and what a keeper does each day.
- `docs/THREATS.md`: trust roots, every known limit, the static-analysis results, what is not
  verified, and what IdentityMD's pipeline did to our earlier launches, checked here.
- `docs/DEVIATIONS.md`: where we depart from IdentityMD's guidance, and where the contracts differ
  from our own first design.
- `docs/AUDITS.md`: every finding IdentityMD's launch pipeline reported before the launch, and what
  became of each.

## Layout

```
src/rules/            Rules, Zap, and the Uniswap v4 calls Zap makes
src/endowments/       Endowments
src/interfaces/       IQuestions, IWorkOrders, ICrowdPots as the earlier launches publish them,
                      and the mainnet addresses this launch reads
test/rules/           unit, fuzz, invariant and fork tests of Rules and Zap; their stand-ins
test/endowments/      unit, fuzz, invariant and fork tests of Endowments; its stand-ins
test/launch/          the manifest, the empty-chain launch, the runbook, the fork rehearsal, and the
                      first day against the live contracts of launches A and B
test/kit/             what the fork tests share to meet the live contracts, and the record kit that
                      makes a real work record into the record of an order (from launch B)
test/scaffold/        the selectors this launch sends to other contracts
test/fixtures/        the state of the real sIMD vault and of the real pool on the day they were
                      read, and one real IdentityMD work record, as hexadecimal text
integration/          a second Foundry project: the same contracts against the sibling sources
docs/                 LAUNCH.md, THREATS.md, DEVIATIONS.md, AUDITS.md
```

## Licence

MIT. See `LICENSE`.
