# Where this launch departs from IdentityMD's guidance, and why

IdentityMD publishes guidance for contracts-only launches (the `evm_contracts` launch skill and the
skill for adapting a project to it), for reviewing, testing, measuring and documenting a project
(the security-review and security-checklist skills, the test-writing skill, the gas-and-size skill
and the readme skill). This document lists every place where the three contracts, or this
repository, do something else, the reason, and what the choice costs. A second part lists where the
contracts differ from our own first design, because a reader comparing the code with the older
documents will meet those too.

What is followed without change comes first.

## Followed as written

- Every constructor is nonpayable, takes only addresses (two, four and four of them), makes no
  external call and checks no code size (`test_launch_constructorsTouchNothingOutsideTheirOwnContract`,
  `test_launch_constructorCodeHoldsNoCallAndNoCodeCheck`,
  `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes`). Each dependency is checked on
  first use instead: Rules reads the desk's limits when a HIRE rule is written
  (`test_createRule_hire_revertsWhenTheDeskHasNoCode_butPayStillWorks`); Endowments checks the
  vault's asset at the first `stake`, the feed's cost when a meter endowment is created and the
  pot's existence when a pot endowment is created (`test_stake_revertsIfTheVaultIsNotOverImd`,
  `test_createForMeter_revertsIfQuestionsHasNoCode`, `test_createForPot_revertsIfCrowdPotsHasNoCode`);
  Zap meets the PoolManager at the first swap.
- Nothing is called after deployment. There is no proxy, no initializer, no pausing, no freezing,
  no minting, and no DELEGATECALL, CALLCODE or SELFDESTRUCT
  (`test_launch_noForbiddenInstructionInAnyDeployedRuntime`).
- No constructor stores `msg.sender`, which at launch is the factory.
- The manifest names three contracts, every argument is a literal address, and the repository
  carries no `launch.json`.
- Values that never change are constants (the gas allowances, the runway, the pool's fee and tick
  spacing), not constructor arguments. Zap derives the pool's id from the token's address, as the
  launch skill suggests for a pool's sorted currencies.
- Deployment sends no ETH. Zap's three entry points take ETH afterwards, which the launch skill
  allows where a project needs it; paying with ETH is what Zap is for.
- Every function that moves money holds a reentrancy lock, and state is settled before a call
  wherever the order can be chosen; where it cannot (an amount or an id that only the called
  contract can state), the lock is what protects it and `docs/THREATS.md`, section 8, names each
  place.
- Tests for what holds value are invariant tests with a handler, and run counts and depths that
  differ from `foundry.toml` are set in the test files. No test sets or reads an environment
  variable.
- `README.md` leads with what the project is and what is not yet true of it, gives the commands in
  the order they are run, and lists every entry point with who may call it and what makes it
  revert.

## D1. No owner, so `$owner` is not used and nothing can be changed

**Guidance.** "In a contracts-only launch, every owner or admin role is a constructor argument
filled by `$owner`, the wallet that paid for the launch, unless the brief names another owner."

**What we do.** There is no owner or admin role in any of the three contracts, so there is nothing
for `$owner` to fill. The six addresses the contracts depend on and every number are fixed at
construction or in the code.

**Why.** An owner who could replace the hire desk could have every rule's returns reported as it
pleased. An owner who could replace the vault could take every endowment's principal. An owner who
could replace the pool could set the price of every Zap. The product's claim is that nobody can.

**What it costs.** Nothing can be corrected after launch. If a contract of the earlier launches is
replaced, or Uniswap's pool is abandoned, the part of this launch that depends on it stops and
resuming takes a new launch. A wrong address in the manifest is permanent. `docs/LAUNCH.md` exists
to get them right once.

## D2. Rules accepts conditions the security guidance warns against

**Guidance.** "Oracles: staleness, a zero or negative answer, a paused feed, a price manipulable
within one transaction (spot prices from a pool are not oracles)."

**What we do.** A VIEW rule's condition is any static call its creator names. Rules does not judge
whether the value read can be moved for the length of one transaction. A FEED rule does carry the
checks the guidance asks of an oracle read: a maximum age, a round that must be newer than the one
last acted on, and a refusal of an answer stamped in the future.

**Why.** Rules is a general instrument, and no on-chain test tells a movable value from a steady
one. Refusing whole classes of targets would refuse honest uses (a vault's total assets, a
contract's counter) and still miss the dangerous ones.

**What it costs.** A creator can write a rule that anyone can trigger at will. What such a caller
gains is the rule's tip and the action its creator fixed (`docs/THREATS.md`, R1). The documents say
so in plain words, and the first rule proposed in `docs/LAUNCH.md` pays only against a receipt.

## D3. Zap sets no minimum price of its own

**Guidance.** "`amountOutMinimum` is explicitly set, slippage defaults are tight."

**What we do.** Every entry point takes the caller's minimum and the caller's deadline and enforces
both. Zap has no default and no floor: a caller may pass a minimum of zero and a deadline at the end
of time.

**Why.** A floor needs a price to measure against. Zap has no oracle, and the pool it swaps on is
the only on-chain price of IMD; reading it would protect nobody. The party that knows what price
was quoted is the caller.

**What it costs.** A caller, or a page, that passes zero accepts any price. The runbook quotes the
pool by simulation and passes 99% of the quote with a ten-minute deadline
(`test_runbook_buyingImdWithEthWithAMinimumAndADeadline`).

## D4. Rules does not measure what a transfer delivered

**Guidance.** "Tokens that lie: fee-on-transfer, rebasing, tokens returning no boolean, tokens
returning false. Measure balances before and after rather than trusting the amount argument."

**What we do.** Endowments measures every deposit (`test_deposit_revertsIfTheTokenKeepsPartOfTheTransfer`).
Rules credits a rule with the amount it asked the token to move, and checks balances only where
another contract moves the money: the desk must have pulled exactly an order's price, and no return
is credited beyond the IMD that is there.

**Why.** The token is one fixed address, IMD, which keeps nothing on transfer. Rules' books are per
rule; measuring each deposit would not make them safer against IMD as it is.

**What it costs.** If IMD's behaviour ever changed, Rules' escrows could exceed its balance. That
is a trust root (`docs/THREATS.md`, T1).

## D5. A second Foundry project that does not build alone

**Guidance.** A launch imports a repository whose root is the Foundry project, and a project's
layout and configuration are kept as they are.

**What we do.** The root is a complete Foundry project. Beside it, `integration/` is a second one
with its own `foundry.toml`. It compiles the real `Questions`, `WorkOrders`, `WorkProof` and
`CrowdPots` from two sibling repositories and runs this launch's contracts against them. The root
project never compiles, tests or formats that folder: `forge build`, `forge test` and
`forge fmt --check` run from the root do not reach it (`docs/THREATS.md`, B2, says how that was
checked).

**Why.** The contracts this launch is given at construction belong to two other repositories. The
root suite must build alone, so its offline tests use stand-ins. Without a run against the real
sources nothing would show that the stand-ins are faithful or that the contracts work with what
they will meet. We did not copy the sibling sources in: a copy can drift from what is launched.
Since both earlier launches went live on 13 October 2026, the root's fork suite also meets the
launched contracts themselves at their mainnet addresses.

**What it costs.** A reader who has this repository alone cannot run `integration/`. Its results are
stated in the documents and have to be reproduced from a checkout that holds the three launch
folders side by side. The same reader can run the fork suite, which needs only a mainnet RPC.

## D6. No gas snapshot file

**Guidance.** The gas-and-size skill asks for `forge snapshot` output in `.gas-snapshot` and a
report in `artifacts/gas.md`.

**What we do.** Neither file is in the repository. Sizes and gas figures are in `README.md` and
`docs/LAUNCH.md`, each beside the test that prints it, and the figures that matter are asserted: the
size gates, the launch gas gate, the gas a condition is offered, the gas a pot is handed, the
callback's fit inside the desk's allowance.

**Why.** A snapshot of every test's gas changes with every test edit and says little about what a
user pays. The figures a user pays for are measured by tests written for that.

**What it costs.** A tool that looks for `.gas-snapshot` finds none. `forge snapshot` runs on this
repository and writes one.

## D7. Two open rules kept where the pipeline changed similar ones in our first launch

**What the pipeline did.** Before deploying our first launch, IdentityMD's pipeline gave a round's
keeper tip to the keeper that opened the round, instead of whoever handed in the public answer
first, and made a contract that holds a seat claim its own payouts, instead of letting anyone have
Payroll pay it.

**What we do.** `Rules.fire` pays a rule's tip to whoever fires the rule first. `Endowments.harvest`
is open to anyone and sends an endowment's yield to its fixed target, a contract included, whether or
not that contract could make the call itself.

**Why.** In the first launch each change gave the money to a party that had earned or owned it and
was losing it to an observer: the keeper that had paid for the round, the economic owner of a seat.
Neither party exists here. Firing a rule is the whole of the work it pays for, so whoever fires first
has done it. An endowment's target is fixed by its creator before anyone deposits and owns its yield
outright; requiring a contract target to call `harvest` itself would leave the yield of every meter
endowment, and of most pot endowments, unable to leave. `docs/THREATS.md`, section 10, patterns 1
and 2, has the reasoning and the tests.

**What it costs.** A keeper's `fire` can be copied and mined ahead of it; the copy takes the tip and
the keeper loses its gas (`docs/THREATS.md`, R12). A recipient that cannot move IMD on keeps what it
is sent (E8). The launch request asks the pipeline to leave both rules as they are.

## Where the contracts differ from our own first design

Our first design came first; reviews and fixes changed some rules. Each
difference below was decided, and is listed so that a reader who knows the older text is not
surprised. None is a departure from IdentityMD's guidance.

| Contract | The first design | What the code does | Why |
|---|---|---|---|
| Rules | Three actions: HIRE, PAY, SWAP | HIRE and PAY | A swap belongs in Zap, which pays with ETH; a rule hires or pays. |
| Rules | A rule pins a hash of its action; whoever fires it supplies the parameters | The order's terms are stored; only the job text is supplied again, as `fire(id, spec)` | A keeper needs one event to fire a rule, and the terms can be read on chain. |
| Rules | An order's expiry is a fixed time | A lifetime counted from each fire (`orderTtl`) | A rule may fire long after it was written. |
| Rules | `reconcile`, and nothing else, brings money back from the desk | `reconcile` (anyone), `recall` (the creator withdraws an order nobody has taken) and the desk's delivery callback, which credits a delivered order's change at once | Only the employer can withdraw an order, and Rules is the employer; a rule that asks for the callback needs no keeper to get its change. |
| Rules | Returns always rejoin the rule's escrow | For a cancelled rule they go to its creator | A cancelled rule holds nothing. |
| Rules | A VIEW condition's calldata is 4 to 132 bytes | 0 to 132 bytes | The rule is "at most 132 bytes"; a target that answers plain calls can be read. |
| Rules | The condition is read with whatever gas the caller left | `fire` reverts `GasShort` unless the target can be offered the whole 100,000 | Whoever fires a rule must not choose the answer of a target whose answer depends on gas. |
| Rules | `createRule` checks the spec and the desk's minimums | It also refuses flags the desk refuses, a delivery time above the desk's maximum, and a cost no escrow can hold, and reports a bad spec at the position the desk reports | A rule that is accepted must be able to open its order. |
| Endowments | Principal is recorded at what the minted shares redeem for | Principal is the exact deposit, paid for by a creation seed and a harvest margin | "To the wei" is the promise; a vault round trip is always one share-wei short. |
| Endowments | One `create` with a kind | `createForMeter`, `createForPot`, `createForRecipient` | Three targets, each with what it needs fixed at creation: a meter, a pot with a fallback beneficiary, a recipient. |
| Endowments | `withdraw` only | `withdraw` (exact or revert) and `exit` (accepts a loss, can pay in sIMD shares) | A way out in a block where the vault pays nothing, and a fair way out after a loss. |
| Endowments | Harvest stops for an endowment that is short | Also: `stake` and `harvest` stop for everyone while sIMD's price is below the highest they have seen | After a fall, yield is kept as cover and no more IMD enters the vault. |
| Endowments | Covered is whole | Whole needs `SPARE` share-wei beyond covered | A deposit accepted right after a loss was made good could not be withdrawn exactly. |
| Endowments | A pot harvest offers the pot everything and pays the rest to the fallback | It takes out only what the pot says it needs; the rest stays staked | A series would take the rest in its next round; the fallback is for a pot that takes nothing. |
| Endowments | Any non-zero feed id or pot id is accepted | The feed must have a cost and the pot must exist | Yield for a target that can never take it would never leave. |
| Endowments | sIMD may be a recipient | It is refused | A lump of yield sent to the vault is partly collected by whoever staked one block earlier. |
| Endowments | A meter harvest sends all the yield | At most what lifts the meter to thirty requests' cost | A feed that stops asking must not absorb an endowment's yield without end. |
| Zap | Opens an order for the caller | Does not; `buy` hands over the IMD | The desk makes its caller the employer, and its surface has no `createOrderFor`. |
| Zap | Constructor takes the desk | `Zap(imd, poolManager, crowdPots, questions)` | The same decision. |
| Zap | Funds a meter with `fund` | With `fundFor`, so the shares are the caller's | Questions has `fundFor` for this; with `fund` the shares would be Zap's. |
| Zap | The caller's minimum is the only protection | A minimum and a deadline on every entry point | A transaction that waits in the mempool must not swap at a price quoted long before. |
| Zap | Returns computed remainders | Returns its whole balance of IMD and ETH to the caller | Nothing can collect in the contract. |
| Zap | Any failed ETH refund reverts | Only a refund the caller is owed must arrive | ETH forced into Zap must not block a caller that cannot receive ETH. |
