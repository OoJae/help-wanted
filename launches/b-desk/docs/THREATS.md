# What this launch trusts, and where its guarantees stop

This document lists every outside party the four contracts rely on, what each is relied on for,
and every limit we know of, including the ones our own reviewers raised. It is written for an
auditor. Where a statement is shown by a test, the test is named; where it is not shown by
anything, it is listed in section 10. Section 11 says what was checked in this code after
IdentityMD's launch pipeline changed our first launch.

Contracts: `WorkProof`, `WorkOrders` (the hire desk), `CrowdPots`, `Doorbell`.
Status: launched on Ethereum mainnet on 13 October 2026 (IdentityMD launch 1573, block 26184581;
the addresses are in `README.md`). Audited by IdentityMD's launch pipeline before it was deployed
(`ADAPTATION.md`; `docs/AUDITS.md` lists every finding it reported) and by no other third party.
`Payroll`, which the desk pays, belongs to HELP WANTED's first launch and has been live on
Ethereum mainnet since 13 October 2026.

## 1. Who can do what

There is no owner, no admin, no setter, no pause and no upgrade path in any of the four contracts.
The functions that can change state are the 28 listed in `README.md` and no others, none of them
payable (`test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes`, which reads the compiler's
ABI); the manifest gives no contract an owner (`test_manifest_namesTheFourContractsInOrder`).
`WorkProof` has no function that changes state at all.

Seven functions are restricted, each to a party of one order, never to a party of the contract:

| Function                                                | Who                                                   | Test                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `WorkOrders.cancel`                                     | the order's employer                                  | `test_cancel_onlyTheEmployer`                                                                    |
| `WorkOrders.release`, `register`, `claimDelivered`      | the runner that holds the order                       | `test_release_onlyTheRunner`, `test_register_onlyTheRunner`, `test_claimDelivered_onlyTheRunner` |
| `WorkOrders.resolve`                                    | the order's arbiter, if the employer named one        | `test_resolve_onlyTheArbiter`, `test_resolve_nobodyCanWhenThereIsNoArbiter`                      |
| `WorkOrders.reportFailed`, for one kind of receipt      | the runner, when the receipt shows its own job failed | `test_reportFailed_swarmFailureOnlyTheRunnerMayReport`                                           |
| `CrowdPots.onWorkDelivered`, `Doorbell.onWorkDelivered` | the desk                                              | `test_onWorkDelivered_revertsForAnyCallerButTheDesk`                                             |

Everything else is open to any caller. A caller never chooses where money goes; it chooses only
when a fixed rule runs. No function pays its caller for calling it: every payee is a party of the
order or of the pot, fixed before the call.

Money leaves the contracts in these ways and no others:

| Contract   | Way out                                                                                                                                        | Who receives                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| WorkOrders | a delivery (`settle`, `finalize`, `resolve` for the runner)                                                                                    | The runner: the fixed price less 10%, and the bonds. Payroll: the 10%. The employer: the rest of the escrow.                    |
| WorkOrders | `cancel`, `refund`, and every claim that ends without a delivery (`release`, `evict`, `timeout`, `reportFailed`, `resolve` against the runner) | The employer: its escrow, and bonds or shares of bonds. The runner or the challenger: what the rule for that ending gives back. |
| CrowdPots  | `launch`                                                                                                                                       | The desk, as the escrow of the pot's own order.                                                                                 |
| CrowdPots  | `claimRefund`, `claimRefunds`                                                                                                                  | The pot's contributors, pro rata.                                                                                               |
| Doorbell   | `ring`, on a 25th ring                                                                                                                         | The desk, as the escrow of the Doorbell's own order.                                                                            |
| WorkProof  | none                                                                                                                                           | It holds no money.                                                                                                              |

The desk holds exactly the escrows and bonds of its live orders, after every call
(`invariant_deskHoldsExactlyWhatItOwes`, `invariant_imdIsConserved`), and leaves no allowance with
Payroll (`invariant_noAllowanceIsLeftWithPayroll`). CrowdPots' balance covers everything it has
booked to contributors (`invariant_theBalanceCoversEverythingOwed`), and its money leaves only for
the desk or for contributors (`invariant_moneyOnlyLeavesForTheDeskOrContributors`).

## 2. Trust roots

| #   | Party                                                                                                                                                                                                                                                                                                                                                                                 | Trusted for                                                                                                                                                                               | If it fails or turns against us                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | What it cannot do                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | The writer of IdentityMD's WorkRegistry: `0x5dA3054201BC7E241875Ac68173e49C269F76D44` on 11, 12 and 13 October 2026. The registry's admin, `0x047F606fD5b2BaA5f5C6c4aB8958E45CB6B054B7`, an account with no code, can appoint another writer or another admin.                                                                                                                        | Writing a receipt for a job only when the swarm really produced that record.                                                                                                              | Whoever controls the writer can record a hash for a record of its own making. If it also holds an order as its runner, that record settles the order: every escrow a runner can claim is exposed to that key. If it stops writing, as it had when this was written, no receipt-only order is paid, and a runner that registered a job loses its bond at the delivery deadline (W1).                                                                                                                                                                                                                                                                                                                                 | Be paid for an order it does not hold: a record settles only the claim whose header it carries, and the header names the runner (`test_settle_revertsOnAnyOtherHeader`). Record a receipt as anyone but the writer (`test_fork_onlyTheRegistrysWriterRecords`).                                                                                                                                                                                                                                |
| T2  | The WorkRegistry contract, `0xb6d0a187b050fa5bb0b87033a203f37becf4a775`. Its source is not published.                                                                                                                                                                                                                                                                                 | Answering `latest(bytes16)` with the hash of the job's newest record, or zero.                                                                                                            | It is treated as untrusted code: called read-only, with 50,000 gas, and believed only when it returns exactly one non-zero word. Anything else is `NoReceipt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Make a proof pass for bytes whose hash it does not return. Burn more than its allowance (`test_prove_registryThatNeverReturnsIsNoReceipt_andCostsAtMostItsAllowance`). Be starved of gas by a caller so that a real receipt reads as none (`testFuzz_prove_noGasAmountTurnsAReceiptIntoNoReceipt`). Write anything (`test_prove_registryThatTriesToWriteIsNoReceipt`).                                                                                                                         |
| T3  | IdentityMD's swarm and its API                                                                                                                                                                                                                                                                                                                                                        | Deciding what a work record says: its `kind`, its `objective`, its `state`, the agents in its `signals`. Serving the record's bytes. Keeping the record's form as it was in October 2026. | A record that says `completed` for work that was not done settles the order: a proof says what IdentityMD recorded, not that the work is good (P1). If the API stops serving a record, only somebody who kept the bytes can prove it. If the form changes, new records cannot be proven (P4).                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T4  | The IMD token, `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7`, and its owner, `0x047F606fD5b2BaA5f5C6c4aB8958E45CB6B054B7`: the same account as the WorkRegistry's admin (T1)                                                                                                                                                                                                           | Moving exactly the amount it is asked to: no fee on transfer, no hooks. The desk's sums and CrowdPots' books assume it (`test_fork_imdIsThePlainTokenTheDeskAssumes`).                    | The desk does not measure what arrived. A token that kept a part of each transfer would leave the desk short. IMD on Ethereum is a LayerZero OFT (`BridgedFP`), not a proxy: its supply here is created only when LayerZero's endpoint delivers a transfer from the contract the token names as its peer on another chain. The owner names those peers (`setPeer`) and who sets how their messages are verified (`setDelegate`; the delegate is the owner itself), so it can have IMD created on Ethereum through a contract of its choosing. New IMD changes no escrow, bond or chip the desk and CrowdPots hold, only what each is worth. The owner can also rename the token and hand over or give up ownership. | Move, burn or freeze IMD that an address holds, pause transfers or charge a fee on them: the token has no function for any of these. Call back into a contract in the middle of a transfer and get past its lock, even if it tried (`test_aTokenCallbackCannotComeBackIn`).                                                                                                                                                                                                                    |
| T5  | `Payroll`, the contract of HELP WANTED's first launch, at `0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F` (IdentityMD launch 1531). It has no owner and no upgrade path. The address is in the manifest; its code was compared with that launch's build (`docs/LAUNCH.md`, section 6) and its hash is pinned in the fork suite (`test_fork_payroll_isTheContractTheFirstLaunchCreated`). | Receiving the fee and the tip, and crediting the tip to the agents named. What happens to that money afterwards is Payroll's own rule, stated under the table.                            | It cannot block a settlement. Each of its two calls is offered 1,000,000 gas; whatever it does not take, for any reason, is sent to it by plain transfer (`test_settle_payrollRevertsInBoth`, `test_settle_payrollReturnsWithoutPulling`, `test_settle_payrollPullsOnlyPart`, `test_settle_payrollWithNoCode`; against the live contract, `test_fork_payroll_bothCallsReverting_theSettlementStandsAndBookPicksUpThePlainTransfer`). A tip that arrives by plain transfer is booked by Payroll as revenue and is not credited to the agents.                                                                                                                                                                        | Take more than the fee and the tip (`test_settle_payrollPullsEverythingInPay`). Re-enter the desk (`test_settle_payrollCannotReenter`, `test_settle_payrollCannotRedeliverMidSettlement`). Be pushed onto the plain-transfer path by a caller that sends too little gas (`test_settle_alwaysOffersPayrollItsWholeAllowance`). Cost a settlement more than 2,000,000 gas (`test_settle_payrollBurnsAllItsGas`, `test_fork_payroll_burningAllItsGasCannotBlockASettlementOnTheDocumentedLimit`). |
| T6  | An employer's callback and an order's condition target                                                                                                                                                                                                                                                                                                                                | Nothing.                                                                                                                                                                                  | Both are untrusted. The callback runs last, with 150,000 gas, after every payment; its failure changes nothing (`test_callback_aRevertChangesNothing`, `test_callback_burningAllItsGasChangesNothing`, `test_callback_aLargeReturnCostsTheDeskNothing`). The condition is a static call with 100,000 gas (`test_condition_gasIsCapped`, `test_condition_failingTargetsNeverHold`).                                                                                                                                                                                                                                                                                                                                  | Touch the delivered order (`test_callback_cannotTouchTheDeliveredOrder`). Be starved of gas by the sender (`test_callback_cannotBeStarvedByTheCaller`, `test_trigger_lowGasCannotChooseTheConditionsAnswer`).                                                                                                                                                                                                                                                                                  |
| T7  | An order's arbiter, where the employer named one                                                                                                                                                                                                                                                                                                                                      | Deciding a disputed delivery claim, with no evidence required on chain.                                                                                                                   | It can decide either way. Only that order is affected, and only once a claim has been challenged. It may be the employer itself (`test_employerAsArbiter`). A runner should look at who the arbiter is before taking an order that allows claims, and a challenger before challenging one: an arbiter that decides for the runner gives the runner the challenger's bond (L6).                                                                                                                                                                                                                                                                                                                                      | Act on an order that is not disputed (`test_resolve_onlyWhileDisputed`), or on any order of another employer.                                                                                                                                                                                                                                                                                                                                                                                  |
| T8  | The desk, as `CrowdPots` and the `Doorbell` see it                                                                                                                                                                                                                                                                                                                                    | Reporting `accountOf` honestly and pushing what it reports. It is the same launch's immutable code.                                                                                       | As a second line, `CrowdPots` checks what the desk does at `launch` (`test_launch_revertsWhenTheDeskPullsLessThanTheTarget`, `test_launch_revertsWhenTheDeskReusesAnOrderId`, `test_launch_revertsWhenTheDeskNamesAnotherEmployer`) and refuses to book more than it holds (`test_reconcile_stopsRatherThanPayFromAnotherPot_whenTheDeskOverReports`). If the desk ever did over-report, that stop is first come, first served.                                                                                                                                                                                                                                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T9  | The launch pipeline and the ProjectFactory                                                                                                                                                                                                                                                                                                                                            | Creating the four contracts with the manifest's arguments, in order. The pipeline audits the code first and may change it before deploying, as it did for our first launch (section 11).  | A wrong argument is permanent. `docs/LAUNCH.md` says how to read every argument back after the launch. Code the pipeline changes is not the code tested here until the tests are run on it again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Hold any privilege afterwards: no constructor stores `msg.sender`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T10 | Runners, keepers and challengers                                                                                                                                                                                                                                                                                                                                                      | Liveness only. Nothing on the desk ends by itself.                                                                                                                                        | With nobody calling, orders wait: escrows stay where they are and can always be returned by anyone once the time has come. On the claimed path a delivery claim nobody watches is paid (L1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T11 | OpenZeppelin Contracts 5.5.0 (vendored in `lib/`) and solc 0.8.26                                                                                                                                                                                                                                                                                                                     | Correctness of the library code and the compiler.                                                                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

The registry's admin and writer were read on chain (`cast call … "writer()(address)"`,
`"admin()(address)"`); the fork suite reads `writer()` again on every run and prints it beside the
address recorded in `Mainnet.sol`. That the registry's 4,320 bytes of code hold the selectors of
`setWriter` and `setAdmin` and no DELEGATECALL was read by a reviewer on 11 October 2026 and is not
checked by a test.

What T4 says of the token's owner was read on 15 October 2026 and is not checked by a test. The
owner (`owner()`), and the delegate the endpoint holds for the token (`delegates(token)` on
LayerZero's endpoint `0x1a44076050125825900e736c501f859c50fE728c`), were read with `cast call`;
both are `0x047F606fD5b2BaA5f5C6c4aB8958E45CB6B054B7`, which is also what the WorkRegistry's
`admin()` returned that day, and the account has no code. The token's source is verified on
Sourcify as an exact match (contract `BridgedFP`, solc 0.8.26, deployed by that same account in
block 23,501,863), and the EIP-1967 implementation slot of the address is empty. The functions
named in T4 are every function of that source that only the owner may call: `setPeer`,
`setDelegate`, `setEnforcedOptions`, `setMsgInspector`, `setPreCrime`, `updateName`, `updateSymbol`,
`updateNameAndSymbol`, `transferOwnership` and `renounceOwnership`. `setEnforcedOptions`,
`setMsgInspector` and `setPreCrime` change how transfers to other chains are sent or checked; none
of the ten moves IMD that an address holds. The one burn in the source takes IMD from whoever calls
`send`, to move it to another chain.

**What Payroll does with a tip, for a reader who follows the money further.** This is the first
launch's rule, not this launch's, and no payment of the desk depends on it. Payroll owes each tip
to the agents the desk named and pays it to whoever owns the seat an agent is bound to, as
IdentityMD's seat Adapter (an upgradeable proxy) reports the binding. Anyone may make that claim
for an owner that is an ordinary wallet. When the seat's owner is a contract, only that owner may
claim (`ContractOwnerMustClaim`): IdentityMD's pipeline added that rule before it deployed the
first launch. A tip for an agent that stays unbound can be moved to Payroll's seat pool, by
anyone's call, once it has waited 180 to 360 days. On a fork, the tip of a settlement was followed to the owner of seat 1998, which agent 52211
is bound to (`test_fork_payroll_theTipIsPaidToTheOwnerOfTheAgentsSeat`); the test reads on the day
whether that owner is a wallet or a contract and follows the rule that applies.

## 3. Limits of WorkProof

**P1. A proof says what IdentityMD recorded, and binds three things.** The template name
(`kind`), the objective text and the final state. It says nothing about whether the work is good,
and nothing about a job's other inputs: a repository and commit, the steps of a plan, a rubric, the
size of a panel. A job whose objective names one repository can have been pointed at another. An
employer should word its spec so that "a job of this kind, with this objective, that ended
completed" is enough.

**P2. Only a job's latest receipt proves.** The registry holds one hash per job. A job can be given
a second receipt (IdentityMD wrote one when work was delivered to a repository, for the jobs we
saw from 27 September); the first then stops proving (`test_prove_supersededReceiptStopsProving`,
and on the fork `test_fork_everyFixtureProvesExactlyWhenItIsTheLatestReceipt`, where two of the 21
stored records are such first receipts).

**P3. A second receipt names no agents.** The proving record of a job that has one carries an empty
`signals` list, so a settlement made after it tips nobody in particular: the tip goes to Payroll
with an empty list, which the live Payroll books to its seat pool
(`test_fork_loop_aSecondReceiptSettlesAndTheTipHasNoAgents`). There is no path that reads the
agents from the earlier record: one rule, one record. A runner that wants its job's agents tipped
settles on the first receipt.

**P4. The record's form is fixed for good.** `WorkProof` accepts one canonical form, the one
records had in October 2026: one object, no whitespace, keys ascending, top-level keys of 1 to 31
ASCII bytes, the job id a lowercase UUID, the schema string `identitymd-work-v1`. It is narrower
than JSON on purpose. If IdentityMD changes the form while keeping the schema string, every record
written from then on is `Malformed` here, and proving those jobs takes a newly deployed verifier.
All 41 records examined, and the record of the job that carried a header, have the same 24
top-level keys.

**P5. The cost of a proof follows a record's shape, and structure has a ceiling.** Text costs 4 to
19 gas a byte whatever it holds (`test_gas_longStringsCostUnderFiveGasPerByte`,
`test_gas_noTextCostsTwentyGasPerByte`). Between strings the walk costs up to about 195 gas a byte
(`test_gas_bareStructureCeiling`). A record with 80 to 100 KB of nothing but brackets or tiny
strings ahead of `state` would need more gas than one transaction may use, and could not be proven
at all. Only the writer shapes a record's structure. The costliest real proof is under 700,000 gas,
for an 88 KB research record (`test_gas_everyFixture`).

**P6. A record above about 128 KB does not fit one transaction's calldata.** It has to be stored
first as data contracts for `proveChunks`, at 200 gas per byte of code: about 64 million gas over
several transactions for the 318 KB record among the fixtures, against about 575,000 for the proof
itself. The proof through thirteen data contracts is tested, offline and against the live registry
(`test_proveChunks_everyFixtureInCodeSizedChunks`, `test_fork_largestRecordProvesThroughChunks`).
The cost of storing them is computed, not measured on chain.

**P7. The scan stops at `state`.** What follows it (nine tenths of an audit record) is covered by
the record hash and by nothing else; `scan` alone says nothing about those bytes
(`test_decoy_bytesAfterStateAreNotRead_soOnlyTheHashVouchesForThem`). Nested values are stepped
over, not validated, to any depth (`test_decoy_deepNestingIsWalkedWithoutLimit`).

**P8. The list of agents is best effort.** At most 16, each once
(`test_fixtures_anAgentNamedInTwoSignalsIsNamedOnce`, `test_signals_stopAtSixteen`). An element
that cannot be read empties the list and never fails a proof
(`test_signals_anElementOfAnotherShapeEmptiesTheList`). An agent whose signal ends `"value":0`, a
submission verification rejected, is left out (`test_fixtures_rejectedSubmissionsAreNotNamed`). The
rule looks at the element's last member: if the writer ever adds a member after `value`, rejected
agents are named again.

**P9. Some finished jobs have no record to prove.** Three completed `research` jobs of 6 and 7
October had no work record at all, and IdentityMD's documentation says oracle work is recorded once
a day as one Merkle root for all of a day's jobs, not once a job. A runner on an order for such a
job could never settle it on a receipt.

**P10. The constructor takes any address.** A registry address with no code makes every proof
`NoReceipt` (`test_prove_registryWithNoCodeIsNoReceipt`). It fails safe; it is also permanent.

## 4. Limits of the hire desk

**W1. A runner bears the lateness of receipts.** On an order without the claimed path, a runner
that opened the right job and saw it completed is paid only when the receipt is on chain. If none
lands within the order's delivery time and somebody calls `timeout`, its bond goes to the employer
and its 0.5 IMD swarm fee is spent (`test_timeout_afterTheDeliveryTimeTheBondGoesToTheEmployer`).
Timeouts are lazy, so a late receipt still settles until that call is made
(`test_settle_aLateReceiptStillSettles`), but anyone may make it, the employer included, and the
employer is the one who gains by it. The desk cannot tell a job that was never done from a job
whose receipt is late: at the delivery deadline both look the same on chain. On 13 October 2026,
until 17:26 UTC, the registry's writer had written nothing since about 8 October, and the job we
bought that day was one of more than 2,200 whose receipts were queued. A runner should look at
the registry's newest `WorkRecorded` event before taking a receipt-only order, and should take none
while receipts are stalled.

**W2. The kind is the runner's risk, and a wrong kind costs it little.** A receipt with the right
objective, state `completed`, under another kind can never settle the order. Anyone may report it;
the order is free again and the bond returns to the runner
(`test_reportFailed_anotherKindFreesTheOrderForAnyoneAndReturnsTheBond`), because the desk cannot
tell a runner's wrong template from a kind the swarm renamed. A runner that picks a wrong template
on purpose pays the swarm's fee each time and holds the order until the receipt lands. It is not
barred from the order, so the same address can take it again at once and repeat this for as long
as the order stays open (`test_realDesk_aWrongKindReceipt_reopensWithTheBondReturned_andTheSameRunnerMayTakeItAgain`).
For an employer that hires once, a crowd pot, see C2.

**W3. Only the runner reports its own job's failure.** A receipt with the right objective and a
state other than `completed` returns the whole bond to the runner, and only the runner may submit
it: a job's first receipt need not be its last, and the runner decides whether to give up or to
register a retry. A runner whose job failed can therefore keep its claim until just before the
delivery deadline and still get its bond back. It cannot go past the deadline: `timeout` then takes
the bond. Its claim can outlast the order's expiry, though: the report then refunds the order
instead of reopening it, with the bond still returned whole. For an ordinary employer that means
opening another order; for a crowd pot, which hires once, it ends the pot (C2). Neither this ending
nor W2's charges the runner the release share that `release` and an undecided dispute do (L3):
the receipt carries the order's own objective, so the runner opened the job correctly and the
failure is the swarm's, and charging the runner for the swarm's failure would make honest runners
avoid the desk (the note on `reportFailed` in `src/desk/WorkOrders.sol`).

**W4. A record WorkProof cannot read decides nothing.** If the registry holds a hash for a job
whose record is not a canonical v1 work record, the record can be neither settled nor reported, and
the claim ends by `timeout` (`test_real_anUnreadableReceiptEndsByTimeout`).

**W5. One bond can keep an escrow out of reach for the delivery time.** A runner that registers a
job and goes silent holds the order until `registeredAt + deliverySecs`, at most 90 days
(`test_createOrder_revertsOnLongDelivery`). It costs the runner its bond, which the employer
receives, unless the runner ends the hold itself with a receipt that shows the job did not
complete (W3), or anyone ends it with one of another kind (W2): then the bond comes back whole and
the hold has cost the runner one swarm job. The price does not rise while the order is held
(`testFuzz_priceNow_holdingAnOrderNeverRaisesItsPrice`).

**W6. A settlement must be offered more gas than it uses.** The desk refuses to start a Payroll
call it cannot hand 1,000,000 gas to, so that no caller can push a payment onto the plain-transfer
path by sending too little. With the live Payroll on a fork
(`test_fork_payroll_gasOfASettlementWithTheLiveContract`, 13 October 2026), the first settlement
Payroll ever saw used 551,689 gas and needed 1,515,990 on offer; the same first settlement with
a record naming sixteen agents never tipped before used 1,128,435 and needed 1,750,121; a later
small one used 374,057 and needed 1,355,346. With the tests' stand-in for Payroll, the costliest
real record uses about 1.1 million and needs about 2.0 million
(`test_gas_settle_whatTheCostliestRecordMustBeOffered`). A contract that wants to call `settle`,
`finalize` or `resolve` for the runner from inside a gas-capped callback cannot.

**W7. The tip reaches the agents only when the proving record names them.** Not after a second
receipt (P3), and not on a delivery paid on a claim or by an arbiter, where the desk has no record
to read (`test_finalize_paysAnUnchallengedClaimAsUnproven`). In those cases the tip goes to Payroll
with an empty list. Once the challenge window of a claim has passed, anyone may call `finalize`,
also when the job's receipt has landed by then; the tip then still goes with an empty list, and a
later `stamp` moves no tip (`test_finalize_whenAReceiptExistsStillSendsTheTipWithNoAgents`). The
amounts every other party receives are the same either way. Whoever wants the agents tipped calls
`settle` with the record instead.

**W8. A condition is latched on one true reading.** `trigger`, or the first `claim`, records that
the condition held once, and it is never consulted again
(`test_condition_isNeverConsultedAgainOnceSeenTrue`). An employer that points a condition at
something a caller can make true for the length of one transaction (a spot balance, a pool price)
lets that caller open the order.

**W9. `accountOf(id).returned` counts what the desk paid the employer as the employer.** Every
such transfer is counted, exactly (`invariant_everyOrderKeepsItsBooks`,
`testFuzz_returnedIsExactOrTheClaimIsRefused`). Money the same address receives in another role,
as its own order's runner or as a challenger, is not counted
(`test_employerAsRunnerOnTheClaimedPath`, `test_employerAsChallenger`). To keep the figure exact,
`claim` refuses an order whose books could pass 96 bits, which takes more than 79 billion IMD
(`test_claim_refusesAnOrderWhoseBooksCouldOverflow`). The figure exists because the desk's payments
to an employer arrive when other people call: an employer contract keeps its books from it and
never from the moment a payment arrived.

**W10. An employer may be its own runner, and its own arbiter.** Nothing stops an address from
taking its own order (`test_claim_theEmployerMayRunItsOwnOrder`) or from naming itself arbiter
(`test_employerAsArbiter`). On the proven path it pays the 10% and the swarm's fee for doing so.
What it means for somebody who challenges such an order is L6. Which employers are ours is
published off chain; the desk has no notion of a house order.

**W11. The callback cannot hire again.** 150,000 gas records a delivery; it does not open an order
(`test_callback_cannotOpenAnOrderWithinItsAllowance`). A callback that fails leaves the delivery as
it is, and anyone can try it again with `redeliver` (`test_redeliver_retriesAFailedCallback`).

**W12. A spec is public and plain, and the desk does not know what the swarm will accept.** The
whole job text is emitted in `OrderOpened`. It is 1 to 7,900 bytes of printable ASCII with no `"`
and no `\`. The length fits IdentityMD's limit of 8,000 characters for an objective with the 85
header bytes in front. IdentityMD's API guide gives a lower limit, 4,000 characters, for the
`research` template: an order of that kind with a spec above 3,915 bytes is accepted by the desk
and can never be opened as a job. It ends in a refund. The desk checks characters and length
only; that a job with this text and this kind can be bought is for the employer and the runner to
know.

**W13. A job id is tied to an order only by a receipt, so two orders can have one job registered
at the same time.** `register` reserves nothing, so copying somebody's job id onto another order
blocks nobody (`test_register_copyingAJobIdBlocksNobody`,
`test_copiedJobIdCannotBlockAProvenSettlement`). The job's receipt carries one claim's header and
settles that claim's order alone. Once it has settled or stamped that order, the other order can
never be settled or stamped on the same job (`JobUsed`;
`test_stamp_revertsWhenTheJobProvedAnotherOrder`), and the job cannot be registered anywhere again
(`test_register_refusesAJobThatSettledAnotherOrder`,
`test_register_refusesAJobThatStampedAnotherOrder`). The other order's claim then ends in one of
three ways: anyone reports the receipt against it as a wrong job, and the bond goes to its employer
(shown at the end of `test_register_copyingAJobIdBlocksNobody`); its runner registers another job
in its place; or it runs to its delivery deadline and is timed out. A keeper that reads
`orderOfJob(jobId)` before sending `settle` or `stamp` avoids a transaction that would revert.

## 5. Limits of the claimed path

They apply only to orders whose employer set `FLAG_ALLOW_CLAIMED`. An order without the flag pays
on a matched receipt or not at all (`test_withoutTheFlagOnlyAReceiptPays`).

**L1. An untrue delivery claim that nobody challenges within 24 hours is paid.** The job id and the
record hash of a claim are the runner's word (`test_claimDelivered_theJobIdIsOnlyTheRunnersWord`).
What protects the employer is somebody watching and posting a bond equal to the runner's. Two
unchallenged claims that name the same job id are both paid
(`test_copiedJobIdOnTheClaimedPathBlocksNobody`).

**L2. While receipts are late, a challenger can keep a true claim from being paid, and it costs
the challenger only gas and the use of its bond until the deadline.** With no receipt and no
arbiter decision by the delivery deadline, the employer is refunded, the challenger gets its bond
back, and the runner loses a tenth of its bond to the employer
(`test_timeout_undecidedDisputeRefundsAndCostsTheRunnerTheReleaseShare`,
`test_fork_loop_dispute_undecidedAtTheDeadlineIsARefund`). The challenger can be the employer
(`test_employerAsChallenger`). What the challenger does risk is the receipt: if one lands before
somebody calls `timeout`, the runner is paid and takes the challenger's bond
(`test_fork_loop_dispute_aReceiptPaysTheRunnerAndTheChallengersBond`).

**L3. What the rules do guarantee.** A runner whose challenged claim is not upheld never gets off
more cheaply than by `release`, whoever the challenger was, its own second address included
(`test_selfChallenge_isNeverCheaperThanReleasing`, `test_timeout_aChallengedFalseClaimCostsTheClaimer`).
Any valid receipt of the registered job pays the runner, in a dispute too, whatever hash it named
(`test_dispute_anyValidReceiptPaysTheRunnerWhateverHashItNamed`,
`test_dispute_aSecondReceiptOfTheSameJobStillPaysTheRunner`), and cannot be used against it
(`test_dispute_aValidReceiptCannotBeReportedAsAFailure`). A claim must leave 48 hours before the
delivery deadline, so a challenge in the last second still leaves a day to decide
(`test_challenge_inTheLastSecondStillLeavesADayToDecide`).

**L4. An arbiter is the answer for an employer that wants neither L1 nor L2.** Crowd pots and the
Doorbell cannot name one (C3, D2).

**L5. A receipt for a job that did not complete refutes a claim, even if a later receipt would
have paid it.** In every job we saw with two receipts, both said `completed`. Whether IdentityMD
can write a not-completed receipt first and a completed one later is not known. If it can, a
runner that claimed delivery could lose its bond to the first.

**L6. A challenger's bond is held until the dispute ends, which can be 90 days, and a dispute that
nothing decides pays the challenger nothing.** From `challenge` on, the bond leaves the desk only
when a receipt, the order's arbiter or the delivery deadline ends the dispute; the deadline is
`registeredAt + deliverySecs`, and an order's delivery time can be 90 days. Two things follow for
somebody who watches orders and challenges untrue claims.

- _An employer that is its own runner can hold a watcher's bond for the price of gas._ It opens an
  order that allows claims with a long delivery time, takes it itself, registers a job id that no
  job has and claims delivery. A watcher that challenges cannot end the dispute early: there is no
  receipt to report, and never will be. At the deadline the watcher gets its bond back and nothing
  more, and the other party has lost nothing, because the tenth of its bond that the rules take
  goes to itself as the employer
  (`test_challenge_theBondIsHeldToTheDeliveryDeadline_andAnEmployerThatRunsItsOwnOrderLosesNothing`).
  Repeated, this can tie up everything a watcher has set aside for challenges, after which an
  untrue claim on an order the watcher does mean to defend goes unchallenged.
- _An arbiter of the employer's own choosing can take the bond._ An arbiter decides with no
  evidence. When the employer, the runner and the arbiter are one party, a challenge of its untrue
  claim is decided for the runner, and the challenger's bond goes to the runner
  (`test_challenge_anArbiterOfTheEmployersOwnTakesTheChallengersBond`).

What a watcher should do. Challenge only the orders of employers it has a reason to defend, never
orders at large in the hope of winning a bond. Before any challenge, read the order: its employer,
its arbiter (leave an order alone if it names an arbiter the watcher does not trust), its bond and
its delivery deadline, which is how long the bond can be held (`docs/LAUNCH.md`, section 8, has the
two calls). Keep a float sized for the orders defended and a limit on what is committed in a day.
HELP WANTED's keeper bot challenges nothing unless it is given both a float and a daily limit, and
can be told the employers whose orders it defends (its setting `CHALLENGE_EMPLOYERS`); for this
launch those are `CrowdPots` and the `Doorbell`, whose orders never have an arbiter and have
delivery times of at most 30 and 7 days.

Why the code was left as it is. We considered letting a dispute end before the delivery deadline.
The facts the desk has do not allow it: on chain, a job that does not exist and a real job whose
receipt is queued look the same, and while IdentityMD's writer is stalled the second is the common
case. Ending disputes sooner would shorten the time in which a late receipt can still pay a runner
whose true claim was challenged, and it is that same time that makes an unfounded challenge
dangerous to the challenger, who loses its bond to the runner when the receipt lands. A shorter
window would move the cost from watchers, who choose which orders to challenge and can read every
term first, to runners, who cannot choose whether a stranger challenges them. So the window stays
the order's own delivery time, which the employer publishes and both the runner and the challenger
can read before they commit anything.

**L7. The first challenge to be mined is the only one.** A delivery claim can be challenged once.
Somebody who sees a watcher's `challenge` waiting to be mined can send the same call ahead of it,
with a bond of its own. The watcher's transaction then reverts and costs it gas; the claim is
disputed all the same, by the other party's bond, so the employer is no worse protected; and what a
successful challenge wins (the runner's bond less a tenth) goes to the party whose transaction
landed, which also carries L6's wait (`test_challenge_onlyOne`). Nothing on the desk was promised
to the watcher before its transaction, so nothing of the watcher's is taken. We know of no cheap
way to reserve a challenge for the first to notice that would not also let a party reserve
challenges it never makes.

## 6. Limits of CrowdPots

**C1. Nothing on chain says the pot's kind is one the swarm writes.** Every pot names its kind in
text, in its opening event and through `kindOf`
(`test_kind_isNamedInTextWhenAPotOpens_andCanBeReadBack`), and the desk pins the hash of that text.
A pot whose kind no work record carries can never be paid on a receipt. A contributor has to know
the swarm's job templates; `docs/LAUNCH.md` lists the twenty we have seen.

**C2. A pot that allows claims can be ended early, in a refund, for a tenth of the bond.** A pot
hires once. One party with two addresses can take its order, claim delivery, challenge itself and
wait out the delivery time; the pot is then refunded and over
(`test_claimedPath_anUndecidedDisputeEndsThePotEarly_forATenthOfTheBond`). On a receipt-only pot
the same stall by silence costs the whole bond and the order is open again afterwards
(`test_provenPath_theSameStallCostsTheWholeBond_andTheOrderReopens`).

A receipt-only pot can also be ended in a refund with no bond forfeited at all, whatever bond the
opener chose. A runner takes the order shortly before its hire window closes and registers a job
whose receipt does not say `completed`; only the runner may report that receipt (W3), so nobody
can free the order sooner, and once the hire window has passed the report refunds the order and
the pot with the bond returned whole
(`test_realDesk_aFailedJobsReceiptPastTheHireWindow_refundsThePotWithTheBondReturned`). The same
ending comes from a `completed` receipt of another kind (W2), which anyone may report and which
bars nobody, so one address can cycle claim, register, wrong-template job and report on a pot's
order for as long as its hire window lasts
(`test_realDesk_aWrongKindReceipt_reopensWithTheBondReturned_andTheSameRunnerMayTakeItAgain`).
Either costs the runner one swarm job and gas, and the contributors the time their IMD was locked.
No IMD is lost. This is the desk's rule, kept on purpose (W3 says why), and it is what the bond
does and does not size: a bond is forfeited by silence (`timeout`, `evict`), by a job that is not
the order's, or by a contradicted delivery claim, never by a receipt that shows the swarm did not
complete the order's own job. A pot's contributors also accept L1 and L2. All of it is fixed and visible in the pot's terms before anyone chips in. The
first pot `docs/LAUNCH.md` proposes allows claims, because while receipts are stalled a pot that
does not could not be paid at all; that document says who fills it and who watches it.

**C3. A pot's order has no reserved runner, no arbiter and no condition,** because a contributor
could not judge them (`test_launch_putsTheWholeAmountOnTheDeskWithThePinnedTerms`). There is no
minimum bond relative to the target: a larger bond makes a stall dearer and a challenge harder, and
the bond is the opener's published choice. A forfeited bond is shared among the contributors by
their chips, so a party that holds most of a pot's chips and then stalls its order as the runner
gets most of its own bond back: for such a party a stall costs the other contributors' share of
the bond, not all of it.

**C4. A chip is locked while the pot runs.** There is no withdrawal while a pot collects. At the
longest: 30 days of collecting, one day in which a full pot can still be launched, 30 days waiting
for a runner, the desk's one-hour claim window and 30 days for delivery. Each of those ends when
somebody makes the call that ends it, not by itself; `reconcile` makes every one of them, and any
contributor may call it.

**C5. `reconcile` and `claimRefund` end an overdue claim as soon as they can.** Any contributor's
call has the desk time out a registered job whose delivery time has passed
(`test_claimRefund_afterASilentRunner_timesTheOrderOutItself`). A receipt that lands after that no
longer pays that runner. The one desk call a pot never makes is `finalize`: a delivery claim nobody
challenged keeps the pot hiring until somebody, normally the runner, finalizes it
(`test_reconcile_forAnUnchallengedDeliveryClaim_callsNothing_howeverLongItStands`).

**C6. The views cannot forecast an order a runner still holds past its time.** `stageOf` reads
`Hiring` and `refundOf` reads zero until `reconcile` or `claimRefund` has had the desk end the
claim. A simulated call of `claimRefund` gives the true figure. The views never show more than
`claimRefund` then pays (`test_views_lookOneStepAheadForAnOrderThatExpiredUntaken`).

**C7. IMD sent to CrowdPots by plain transfer belongs to nobody** and stays there
(`test_reconcile_strayTransfersAreNeverBookedToAPot`).

**C8. Shares are rounded down, and the last claimer takes the remainder.** A later claimer can
receive a few wei more than an earlier one with the same chip; the pot pays out to the wei
(`test_claimRefund_theLastClaimerTakesTheRemainder_noDust`, `invariant_everyClaimerGotTheirShare`).

**C9. The pot's copy of the job id and record hash is a convenience.** It stays zero if the desk's
callback never arrived, and on the claimed path it is the hash the runner named. Money is read from
the desk's books and does not depend on it
(`test_reconcile_withoutACallback_stillSettlesFromTheDesksBooks`).

**C10. A series cannot be closed, a chip sent to a series id goes to whichever round is
collecting, and anyone's first chip starts a round's clock.** A chip meant for one round goes to
that round's own id (`test_chipIn_toARoundsOwnId_neverSpillsIntoTheNextRound`). A round collects
for its `fundSecs` from its first chip, whoever sends it and however small: one wei from a stranger
opens a round, and funders that come later have that much less of the round's time
(`test_chipIn_toASeries_aOneWeiChipFromAnyoneStartsTheRoundsClock`). A round that runs out unfilled
gives every chip back, and the next chip to the series opens the next round, so the cost to a
standing funder is time, never money.

**C11. A refund is paid when anybody asks, to the contributor and nobody else.** `claimRefund` and
`claimRefunds` take the contributor as an argument and may be called by anyone, so a contributor
that is a contract and cannot make the call is still paid
(`test_claimRefund_paysAContributorThatIsAContractAndCannotCall`). The other side of that: a
contract contributor receives its refund at a moment somebody else chooses. A chip cannot be moved
to another address, so the refund could never have gone anywhere else; a contract that keeps books
of its own reads what it was paid from `chipOf(potId, itself)`. Whoever names a beneficiary with
`chipInFor` gives that address the chip and its refund for good, and should name one that can use
IMD. Section 11 says why this was not changed to the rule IdentityMD's pipeline gave our first
launch's seat claims.

## 7. Limits of the Doorbell

**D1. Its IMD can never be withdrawn.** It leaves only as the escrow of the Doorbell's own orders
(`invariant_moneyOnlyLeavesForTheDesk`). Fund it with small amounts.

**D2. With the claimed path on, everything it holds is open to delivery claims that nobody
challenges.** Anyone can ring it to a hire, take the order, claim delivery and be paid 24 hours
later unless somebody posts 0.25 IMD to challenge, each time. And a challenge nothing decides
refunds the order even when the claim was true
(`test_claimsOn_anUndecidedDisputeRefundsTheDoorbell_withTheRunnersForfeitedShare`). It has no
arbiter and no reserved runner. This is the setting `docs/LAUNCH.md` recommends while receipts are
stalled, for the reason given there; whoever funds the Doorbell should have a keeper watching its
orders with 0.25 IMD for each claim it may have to challenge. No watcher is running. On
15 October 2026 the team's keeper, the bot that can challenge an untrue claim, is not hosted: the
team runs it by hand and has no other watcher, and we know of nobody else who watches the
Doorbell's orders. At block 26,200,224 that day the Doorbell held no IMD, so it could open no
order until somebody funds it.

**D3. With the claimed path off, a wrong kind or a header the swarm does not keep means no order is
ever paid.** Each ends in a refund, the next 25th ring orders again, and the IMD stays in the
Doorbell for good (`test_claimsOff_withoutAReceiptTheMoneyComesBackAndHiresAgain`). The swarm kept
the header and wrote the template as the kind for the one job we bought with a header, a research
report; that has not been shown for a picture job, which is what the Doorbell orders
(`docs/LAUNCH.md`, section 5). And with the path off nothing is paid for as long as IdentityMD's
writer writes no receipts. Shown since, on 14 October 2026, for a picture job: the job bought for
order 1, the Doorbell's own, kept the header byte for byte, its record carries `skill:create-image`
as its kind, and the desk settled the order on its receipt.

**D4. Its only limit is its balance.** There is no daily cap. 25 rings and one escrow per order. A
25th ring that comes while the Doorbell holds less than one escrow is counted and hires nothing;
the next chance is 25 rings later.

**D5. Nothing checks the picture.** The spec asks for the day's date in a corner. No contract looks
at what was drawn.

## 8. Limits of the build and of its tests

**B1. One real swarm job has carried an order header; no order has been settled by a real job.** On
13 October 2026 we bought one job, `e70c56ce-60f0-4c2c-b413-67e5ae37ddce`, a research report whose
objective began with 85 bytes shaped like an order header. Its work record, stored as served in
`test/fixtures/proof/header-job/record.json`, shows that the swarm stored the objective with the
header unchanged and wrote the job's template as the record's `kind`, and `WorkProof` reads both
(`test_headerJob_scanFindsTheHeaderTheSpecTheKindAndTheAgent`). Three things that job does not
show. Its receipt was still queued at IdentityMD when this was written, so the proof has passed
only against a registry stand-in holding its hash (`test_headerJob_provesOnceTheRegistryHoldsItsHash`);
`test_fork_headerJobProvesExactlyWhenItsReceiptIsOnChain` asks the real registry on every run and
says which case it met. Its header was not the header of an order on a deployed desk, so it
settled nothing. And it was not a picture job. Every record the desk settles in a test is a real
IdentityMD record with its job id and objective replaced (`test/kit/RecordKit.sol`), or, in a few
tests, a record written out member by member; on the fork the real registry holds such a record
because the test acts as the registry's writer. Shown since, on 14 October 2026: IdentityMD's real
writer wrote the header job's receipt (block 26,189,975), and order 1 of the launched desk, a
picture job the Doorbell opened, was settled on the proven path against a receipt the real writer
had written a minute before (blocks 26,190,218 and 26,190,223). That order's header was the header
of an order on the deployed desk, and its job was a picture job (`README.md` has the transactions).

**B2. Payroll is a stand-in in the tests that run without a network, and the live contract in the
fork suite.** The stand-in (`test/kit/PayrollStandIn.sol`) does what the launched `pay`, `tip` and
`book` do and can be made to fail in eight ways. The fork suite builds the desk with the live
Payroll's address, as the manifest does, and every settlement there goes through the real `pay`
and `tip` with real IMD: the fee is booked as revenue, each agent is credited, an empty list is
booked to the seat pool, and no allowance is left
(`test/fork/WholeLoop.fork.t.sol`, `test/fork/LivePayroll.fork.t.sol`). One fork test sends the
same payments to the stand-in and to the live contract and compares what each books
(`test_fork_payroll_theStandInBooksWhatTheLiveContractBooks`). The live contract cannot be made to
fail by a caller, so its failures are imposed on the fork from outside: its two calls are made to
revert with a cheatcode, or its code is replaced by code that uses all the gas it is handed. Its
source is the first launch's repository, not this one; what is here is its interface, copied
unchanged (`src/interfaces/IPayroll.sol`), and the hash of its deployed code.

**B3. The registry is a stand-in in the default suite** (`test/kit/RegistryStandIn.sol`, and the
deliberately broken registries of `test/proof/utils/Registries.sol`). The fork suite uses the real
one.

**B4. Two contracts in the place of a sibling remain, on purpose.** `test/pots/mocks/OddDesk.sol`
is a desk that breaks its own interface (pulls less than asked, reuses an order id, names another
employer, over-reports), which the real desk cannot do; it is used only to reach the checks
`CrowdPots` and the `Doorbell` make on the desk's answers. `MockEmployer` and `MockCondition` are
untrusted outside parties, not copies of anything in `src/`. Every other test of the pots, the
Doorbell and the desk runs on the real desk and the real `WorkProof`.

**B5. 21 of the 41 records examined are stored,** covering 18 of the 20 kinds seen. Each stored
record has a stated role in `test/fixtures/proof/index.json`; the other 20 are listed there with
their hashes and can be fetched again. They are stored as hexadecimal text because they hold other
people's job text. The record of the job we bought ourselves is stored as served.

**B6. The launch is 11.04 million gas in our rehearsal,** against our gate of 12 million and the
protocol's ceiling of 16.7 million (`test_fork_rehearsal_launchFitsOurGasAndSizeGates`).

**B7. Nothing is called after deployment,** and nothing needs to be: the first order, the first pot
and the first ring are calls anyone may make (`test/launch/LaunchRunbook.t.sol`).

**B8. One byte of the desk's runtime code reads as ORIGIN to a scanner that does not tell code from
data.** It lies in the constant data after the last instruction. The desk never uses `tx.origin`.
Our own walk for DELEGATECALL, CALLCODE and SELFDESTRUCT reads the whole bytecode as instructions,
data included, and finds none (`test_launch_runtimeBytecodeHasNoForbiddenOpcode`).

**B9. With the IR pipeline, whether a large test function compiles can depend on which files are
compiled in the same run.** We met this once, in the test helper that builds records, and moved
that helper behind a contract (`test/kit/RecordMaker.sol`). The four contracts under `src/` compiled
in every configuration we ran: the whole project, `src/` alone, the default test set and the fork
set.

**B10. `forge build` prints advisory notes from Foundry's linter** for comparisons with
`block.timestamp`, events emitted after a call, and the two partial reads of `accountOf`. They are
the same matters as the Slither findings explained below.

**B11. The code is the code that was reviewed.** The four contracts' creation and runtime code are
byte for byte what they were when this project was assembled as one and reviewed (12 October 2026).
What changed since is in comments, tests and documents: the notes on `challenge` and `finalize`,
on what a challenge costs, on when a receipt decides, on a series round's clock and on refunds,
the fork tests against the live Payroll, and these documents. The bytecode was compared before and
after.

## 9. Static analysis

`slither . --filter-paths "lib|test"` (Slither 0.11.4, 13 October 2026, on the sources as they
are) reports 86 results: none of high impact, none of medium, 23 of low, 63 informational.

### The 23 low findings

- `timestamp` (17): 12 in `WorkOrders`, 4 in `CrowdPots`, 1 in the `Doorbell`. Each is a comparison
  of the block time with a deadline: an order's expiry, the one-hour claim window, the delivery
  time, the 24-hour challenge window, a pot's deadline, the price ramp. The windows are hours and
  days; the seconds a block proposer can shift a timestamp do not change who is paid.
- `reentrancy-benign` (5): `CrowdPots.launch`, `_reconcile`, `claimRefund`, `claimRefunds` and
  `Doorbell._hire` write state after a call to the desk, because what they write is only known
  then (the new order's id; what the desk sent back). Every one of them holds its contract's
  transient lock, and the only contracts called are IMD and the desk
  (`test_theDeskCannotComeBackInWhileAnOrderIsBeingCreated`,
  `test_ring_theDeskCannotRingAgainWhileTheOrderIsBeingCreated`).
- `missing-zero-check` (1): `WorkProof`'s constructor. On purpose: a registry that is not there
  fails safe as `NoReceipt` (P10).

### The 63 informational findings

- `naming-convention` (37): immutables and constants read through getters are written in upper case
  (`IMD()`, `WORK_PROOF()`, `MIN_BOND()`), in the contracts and in the interfaces that declare them.
- `assembly` (18): the scanner (`JsonScan`), the spec and header libraries, `WorkProof`'s registry
  call and chunk join, and the desk's three bounded calls (`_call`, `_condition`, the pass-through
  of WorkProof's revert data). Each block is marked memory-safe and has its reason beside it.
- `cyclomatic-complexity` (4): three parser functions in `JsonScan` and `CrowdPots._pin`, the list
  of checks a pot's terms must pass.
- `too-many-digits` (2): two 32-byte constants (`WorkProof.LATEST_SELECTOR`,
  `JsonScan.LITERAL_BYTES`).
- `low-level-calls` (1): the desk asks `WorkProof` by static call so that it can pass the revert
  data on unchanged.
- `costly-loop` (1): `claimRefunds` pays a list the caller chose; the loop costs only the caller.

### What is silenced in the source, and why

In five places `src/` carries a comment that tells Slither not to report a finding (three pairs of
`slither-disable-start` and `-end`, two `slither-disable-next-line`); together they silence six
findings. Each is listed here so that a reader does not have to search for them.

| Where                                             | Detector            | Reason                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CrowdPots.launch`                                | `reentrancy-no-eth` | The desk's id for the new order is known only once the desk has answered, so the two writes that record it follow the call. The function holds the lock, and the pot's stage and `owed` are written before the call. |
| `CrowdPots.claimRefund`, `CrowdPots.claimRefunds` | `reentrancy-no-eth` | Both first have the desk end what ran out of time and only then book and pay: what the desk sent back is not known before. Both hold the lock.                                                                       |
| `CrowdPots._reconcile`                            | `reentrancy-no-eth` | The same order of events, in the function the two above share.                                                                                                                                                       |
| `CrowdPots.launch`, `Doorbell._hire`              | `unused-return`     | `accountOf` returns five values and only the employer is wanted here, to check that the desk agrees who the employer is.                                                                                             |

Without these comments Slither reports 92 results, the 86 above and six of medium impact: the four
`reentrancy-no-eth` and the two `unused-return` in the table (run on a copy of the sources with the
comments removed, outside the repository). A reader who does not accept a reason in the table
should treat the matching finding as open. The comments change no bytecode: the four contracts'
creation and runtime code were compared before and after.

`WorkOrders`, `WorkProof` and `JsonScan` carry no Slither comment. They carry comments for
Foundry's linter (`forge-lint: disable`), each with its reason beside it: four casts that cannot
truncate and one read of an error selector in `WorkOrders`; the missing zero check in `WorkProof`;
and in `JsonScan` the casts of short text constants to words and the reverts inside the parser's
loop.

## 10. What is not verified

- **Shown since this list was written** (15 October 2026): a proof on chain for a job that
  carried an order header (the research-report job of B1, whose receipt was written on 14 October),
  and an order settled by a real job on the proven path: order 1, a picture job opened by the
  Doorbell, settled on 14 October with a receipt written by IdentityMD's real writer, which
  settles the Doorbell's kind on the proven path as well (`README.md` has the transactions). What
  follows is still not shown.
- **The live Payroll under a real failure.** It has none a caller can cause; the failures in the
  fork suite are imposed from outside (B2).
- **The launch pipeline itself** was not ours to run. It ran on 13 October 2026 and changed no
  compiled code: it corrected three comments in `src/pots/CrowdPots.sol` (`ADAPTATION.md`;
  `docs/AUDITS.md`, row 9); before that, the factory call was rehearsed on a fork as the launch
  deployer (`test/fork/LaunchRehearsal.fork.t.sol`).
- **Whether a not-completed receipt can be followed by a completed one** (L5), and whether
  IdentityMD still writes second receipts.
- **Whether a transaction with more than 128 KB of calldata can reach a block,** and the on-chain
  cost of storing a record as data contracts.
- **The kind strings of skills that have no receipt yet.**
- **That the registry holds no DELEGATECALL and what its admin can do,** beyond the reading named in
  section 2.
- **No audit by anyone outside IdentityMD's network.** The launch pipeline's audit agents and an
  independent reviewer read the code before it was deployed (`ADAPTATION.md`). Before that: two
  internal reviews per contract when the contracts were written, their findings fixed or listed
  above, a second read of the code changed since, the review of section 11, and the checks in this
  repository.
- **Gas figures** are from tests and from a mainnet fork, apart from those of order 1's own
  transactions on mainnet: the ring that hired used 328,183 gas and the settlement 636,569.

## 11. What IdentityMD's pipeline changed in our first launch, and what was checked here

IdentityMD's launch pipeline audits the code it imports and then changes what it can reproduce
before it deploys. For our first launch (`Questions`, `JobsReport`, `Payroll`; launch 1531) it made
three changes, recorded in that repository's `ADAPTATION.md`:

- a round's keeper tip now always goes to the keeper that opened the round. Before, whoever handed
  in the public signed answer first took it;
- a silent round can be closed only after the answer's validity has also run out. Before, a
  stranger could close it at twelve hours with a valid answer still on its way;
- a seat held by a contract must claim its own payouts. Before, anyone could have Payroll pay a
  contract that could not use the money.

Two audits of that launch, bought from IdentityMD's network, made nine more findings (that
repository's `docs/AUDITS.md`). On 13 October 2026 each of the three patterns and each of the
findings was taken through `WorkOrders`, `CrowdPots` and the `Doorbell`. **No contract code was
changed as a result.** What follows says what was looked at, what was concluded, and what was added
to the tests, the comments and this document.

### Pattern 1. A reward an observer can take from the party that earned it, by copying a public transaction

_Checked:_ every transfer each contract makes, and who decides its recipient.

- No function pays its caller for calling. `settle`, `finalize`, `stamp`, `reportFailed`,
  `timeout`, `evict`, `refund`, `trigger`, `redeliver`, `launch`, `reconcile`, `claimRefund` and
  `ring` are open to anyone and pay nobody for the call. There is no keeper reward to take.
- A runner's pay is tied to the runner before the work is bought. The ticket in the order header
  names the chain, the desk, the order, the claim and the runner; a record settles only the claim
  whose header it carries, and the money goes to that claim's runner whoever submits the record
  (`test_settle_revertsOnAnyOtherHeader`). Copying a job id, a record or a `settle` transaction
  moves nothing to the copier (`test_register_copyingAJobIdBlocksNobody`,
  `test_copiedJobIdOnTheClaimedPathBlocksNobody`, `test_copiedJobIdCannotBlockAProvenSettlement`).
- `register`, `release` and `claimDelivered` are the runner's alone.

_Concluded:_ the pattern does not hold here. Two places where the first transaction to land decides
something were written down as limits, each with a test: the first `challenge` to be mined is the
challenger (L7), and `finalize` after the window sends the tip with no agents even when a receipt
exists by then (W7).

### Pattern 2. A deadline at which a stranger can discard something still valid

_Checked:_ every comparison with the block time in the three contracts, and what a stranger's call
does once each has passed.

- In the first launch one thing had two clocks: a round could be closed at twelve hours while the
  answer it had asked for stayed valid for longer. Here each thing has one clock, published by the
  party whose money it is and accepted by the other before it commits anything: an order's expiry,
  the one-hour claim window, the delivery deadline, the 24-hour challenge window, a pot's deadline
  and its day of grace. Nothing the contracts hold says a claim or a pot is still good after the
  moment a stranger may end it.
- Before a deadline nobody can discard anything: `timeout`, `evict` and `refund` revert `TooEarly`,
  and a receipt that exists before the delivery deadline can be settled by anyone before it. The
  calls that end a claim early need a receipt, not a clock, and a receipt that settles the order
  cannot be reported against it (`test_dispute_aValidReceiptCannotBeReportedAsAFailure`).
- A delivery claim nobody challenged is not touched by `timeout` at all, and a claim must be made
  48 hours before the deadline, so a challenge in its last second still leaves a day
  (`test_challenge_inTheLastSecondStillLeavesADayToDecide`).
- After a deadline the rules are lazy on purpose: a late receipt, a late registration or a late
  arbiter decision still counts until somebody makes the call that ends the claim
  (`test_settle_aLateReceiptStillSettles`,
  `test_dispute_canStillBeDecidedAfterTheDeadlineUntilTimeoutIsCalled`). From then on the first
  call decides, and the party that gains by ending the claim will usually make it.

_Considered and rejected:_ having `timeout` wait while the registry holds a receipt for the
registered job. A receipt `WorkProof` cannot read (W4), or a failed job that only its runner may
report (W3), would then hold the order for good.

_Concluded:_ the pattern does not hold here. What remains is W1, which is not a second clock but
the thing the desk cannot see: that a job was done and its receipt is merely late. It matters
today, because receipts are stalled, and it is why the first day in `docs/LAUNCH.md` uses the
claimed path.

### Pattern 3. A payout an observer can force into a contract that cannot use it

_Checked:_ every address the three contracts send IMD to, and whether somebody other than that
address can cause the transfer.

- In the first launch the payee followed a token that can be moved: a seat placed in an escrow
  contract took the seat's accrued IMD with it when a stranger made the claim, and the seat's real
  owner lost it. Here no payee follows anything that can be moved. The desk pays an order's
  employer, its runner and a challenger, each of which took that role by a transaction of its own.
  `CrowdPots` pays a contributor, who chipped in itself or was named by whoever paid the chip, and
  a chip cannot be moved to another address. Whenever the money is paid it can go nowhere else. A
  stranger's call decides when a payment is made, never where it goes or whether it is made.
- So `claimRefund` stays open to anyone, on purpose (C11). Giving it the rule the pipeline gave
  seat claims (a contract must claim for itself) would strand the refund of every contributor that
  can receive IMD and cannot make the call, for example a beneficiary that a helper contract chips
  in for and that has no function for claiming
  (`test_claimRefund_paysAContributorThatIsAContractAndCannotCall`).
- Contracts that keep books do not depend on when a payment arrives: an employer contract reads
  `accountOf(id).returned` (W9), a contributor contract reads `chipOf`.
- The fee and the tip cannot be pushed onto the plain-transfer path, where a tip is booked as
  revenue, by a caller that sends too little gas (`test_settle_alwaysOffersPayrollItsWholeAllowance`),
  and the live Payroll takes what it is offered
  (`test_fork_loop_provenSettlementPaysEveryParty`).

_Concluded:_ the pattern does not hold here. `docs/DEVIATIONS.md`, D7, records the choice not to
follow the pipeline's rule for refunds.

### The findings of the two audits of the first launch

| Finding there                                                                           | What it was                                                                                                                   | What was checked here                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Conclusion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1, medium                                                                             | Of two permissionless calls at a time boundary, the one that came first decided where money went, against the intended order. | Whether the order of two open calls ever changes an amount or a recipient. Each ending of a claim pays fixed parties fixed amounts (`ClaimEnded` carries all three), and `CrowdPots` books an order once, from `accountOf`, when it can no longer move, so the order in which `reconcile`, `claimRefund` and the desk's own calls arrive changes no pot's total (`test_reconcile_anOrderThatReopensSeveralTimes_thenDelivers`, `invariant_everyClaimerGotTheirShare`). | Not present. After a deadline the first call decides between a late settlement and a timeout; that is the stated rule (W1, pattern 2).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 1.2 and 2.2, low                                                                        | A figure was sized from a pooled balance that a stranger could raise and lower around the call.                               | Every read of a balance. The desk reads none. `Doorbell.ring` reads its own balance to decide whether to hire; a stranger can only add to it, for good. `CrowdPots` compares its balance with what it owes only as a stop against a desk that over-reports, and never infers a pot's money from a balance (`test_reconcile_strayTransfersAreNeverBookedToAPot`, `test_twoPotsNeverShareMoney`).                                                                        | Not present. One relative was found and written down: a stranger's one-wei chip starts a series round's clock (C10, with a new test).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 1.3 and 2.3, low                                                                        | The documents claimed more than the code gives.                                                                               | Every sentence with "never", "always", "cannot" or "only" in the comments of `src/` and in these documents, against the code.                                                                                                                                                                                                                                                                                                                                          | Corrected in words, not in code: L2 now says what a challenge does cost; C4 says its bound holds when somebody makes the calls; W13 says how the other order of a shared job ends; the notes on `challenge` and `finalize` say what each leaves out; two comments that said a receipt "always decides" now say it decides when somebody submits it before the claim is paid or timed out; the runbook's sentence that three million gas covers every settlement now says which records it covers; B1 and B2 say what is and is not shown since the first launch and the header job. |
| 1.4 and 2.4, info                                                                       | A view reported an amount the action then refused to pay.                                                                     | Every view against the call it describes. `refundOf` and `stageOf` can lag behind and never run ahead of what `claimRefund` pays (C6). `funded()` is true exactly when the next 25th ring hires. `conditionOf` says of itself that it is only as good as the gas it was given.                                                                                                                                                                                         | One to know: `priceNow` answers with a price for an order that can no longer be taken (expired, or its condition not met). It reports a price, not availability; `stateOf`, the order's expiry and `conditionOf` say whether a claim would go through.                                                                                                                                                                                                                                                                                                                              |
| 2.1, medium, left open there                                                            | Somebody who arrives just before a distribution takes a full share of it.                                                     | Where something is shared pro rata: a pot's refund, by chips. Chips can be added only while a pot collects, and what is later shared (unused escrow, forfeited bonds) arises only after launch, when no chip is accepted (`test_chipIn_afterLaunch_takesNothing`).                                                                                                                                                                                                     | Not present. A relative is written down in C3: a majority contributor that stalls its own pot's order gets most of its bond back.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2.5, info                                                                               | A guard that cannot fire, and would do harm if it did.                                                                        | The guards that cannot fire with the real desk and real amounts: `BooksFull`, `DeskPulledWrongAmount`, `OrderIdReused`, `NotOurOrder`, `DeskShortfall`, `AlreadyDelivered`.                                                                                                                                                                                                                                                                                            | Each reverts the one call and writes nothing; none drops or misdirects money. Each is reached in a test with a desk built to misbehave (B4). `DeskShortfall` would hold a pot's refunds until the balance covered them (T8).                                                                                                                                                                                                                                                                                                                                                        |
| The fixed signer (an informational finding of the pipeline's own audit, kept as it was) | A dependency fixed at construction cannot be replaced.                                                                        | The same choice here: the registry behind `WorkProof`, and the desk's `WorkProof` and `Payroll`.                                                                                                                                                                                                                                                                                                                                                                       | The same answer, with its cost stated: `docs/DEVIATIONS.md`, D1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### What the review added

Four tests (`test_challenge_theBondIsHeldToTheDeliveryDeadline_andAnEmployerThatRunsItsOwnOrderLosesNothing`,
`test_challenge_anArbiterOfTheEmployersOwnTakesTheChallengersBond`,
`test_finalize_whenAReceiptExistsStillSendsTheTipWithNoAgents`,
`test_chipIn_toASeries_aOneWeiChipFromAnyoneStartsTheRoundsClock`); the limits L6, L7 and C11 and
the additions to W1, W7, W13, C3, C4 and C10; and comments on `challenge`, `finalize`,
`openSeries` and `claimRefund`, on what a challenge costs and on when a receipt decides. If the pipeline does change a rule in this code, the tests named
beside that rule in this document are the ones that will say what else moved.
