# What this launch trusts, and where its guarantees stop

This document lists every outside party the three contracts rely on, what each is relied on for,
and every limit we know of, including the ones our own reviewers raised. It is written for an
auditor. Where a statement is shown by a test, the test is named; where it is not shown by
anything, it is listed in the last section. Tests named with `integration/` in front are in the
second Foundry project of that folder, which runs these contracts against the real sources of the
two earlier launches; every other test is in `test/`.

Contracts: `Rules`, `Endowments`, `Zap`.
Status: launched on Ethereum mainnet on 15 October 2026 (IdentityMD launch 1845, block 26198165; the
addresses are in `README.md`). Audited by IdentityMD's launch pipeline before it was deployed
(`ADAPTATION.md`) and by no other third party. The two launches it builds on are live on Ethereum
mainnet since 13 October 2026: launch A (IdentityMD launch 1531) and launch B
(IdentityMD launch 1573). Section 10 says what IdentityMD's launch pipeline changed in those two and
what was checked here as a result.

## 1. Who can do what

There is no owner, no admin, no setter, no pause and no upgrade path in any of the three contracts.
The functions that can change state are the 20 listed in `README.md` and no others
(`test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes`, which reads the compiler's ABI);
the manifest gives no contract an owner (`test_manifest_theDocumentNamesTheThreeContractsInOrder`).

Six functions are restricted, none of them to a party of the contract itself:

| Function | Who | Test |
|---|---|---|
| `Rules.cancel`, `Rules.recall` | the creator of that rule | `test_cancel_onlyTheCreator`, `test_recall_onlyTheCreator` |
| `Rules.onWorkDelivered` | the hire desk named at construction | `test_onWorkDelivered_onlyTheDesk`, `integration/`: `test_hire_theCallbackIsTheDesksAlone` |
| `Endowments.withdraw`, `Endowments.exit` | a depositor, for no more than its own principal in that endowment | `test_withdraw_revertsAboveTheCallersOwnPrincipal`, `test_withdraw_principalInOneEndowmentCannotBeTakenFromAnother`, `test_exit_inKind_cannotTakeMoreThanTheCallersPrincipal` |
| `Zap.unlockCallback` | Uniswap's PoolManager | `test_unlockCallback_onlyThePoolManager`, `test_fork_zap_unlockCallback_isClosedToEveryoneButTheManager` |

Everything else is open to any caller. A caller never chooses where money goes; it chooses only
when a fixed rule runs.

Money leaves the contracts in these ways and no others:

| Contract | Way out | Who receives |
|---|---|---|
| Rules | `fire` | The rule's fixed recipient (PAY), or the hire desk as the escrow of the rule's own order (HIRE). The caller: the rule's tip. |
| Rules | `cancel` | The rule's creator: the rule's unspent escrow. |
| Rules | `reconcile`, `recall`, `onWorkDelivered`, for a rule that was cancelled | The rule's creator: what the desk returned for that rule's order. For a rule that is not cancelled these three move nothing out; they add to the rule's escrow. |
| Endowments | `stake` | The sIMD vault: everything waiting to be staked. |
| Endowments | `withdraw`, `exit` | The depositor: its own principal, as IMD or as sIMD shares. |
| Endowments | `harvest` | The endowment's fixed target: a meter of Questions, a chip in CrowdPots in the fallback beneficiary's name, the fallback beneficiary, or the recipient. Never the caller. |
| Zap | inside one call | The PoolManager: the ETH swapped. CrowdPots or Questions: the IMD bought, in the caller's name. The caller: everything else. |

Rules' balance always covers the sum of its rules' escrows, and no rule can spend another's
(`invariant_holdingsCoverEveryEscrow`, `invariant_eachRulesEscrowIsConserved`,
`invariant_nothingIsCreatedOrLost`, `test_fire_aRuleCannotSpendAnotherRulesEscrow`). In Endowments
the IMD held is exactly the unstaked buffer, the shares booked to endowments never exceed the sIMD
held, and every endowment's holdings cover its principal (`invariant_bufferIsExactlyTheImdHeld`,
`invariant_E2_bookedSharesWithinSimdHeld`, `invariant_E1_holdingsCoverPrincipal`). Zap holds nothing
of a caller's after a call: no IMD, no ETH, no allowance, no meter share
(`invariant_zapKeepsNothingOfACallers`, `invariant_everyWeiIsAccountedFor`).

Every function that changes state holds its contract's transient lock
(`test_reentrancy_everyMoneyFunctionIsLockedWhileARuleFires`,
`test_reentrancy_lockedWhileAnOrderIsRecalled`, `test_harvest_meter_aCallBackIntoEndowmentsIsRefused`,
`test_harvest_pot_aCallBackIntoEndowmentsIsRefused`,
`test_reentrancy_aCallerCannotStartASecondZapFromItsRefund`). The one exception is
`Zap.unlockCallback`, which runs inside the locked call that asked for it and is closed to every
caller but the PoolManager.

## 2. Trust roots

| # | Party | Trusted for | If it fails or turns against us | What it cannot do |
|---|---|---|---|---|
| T1 | The IMD token, `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` | Moving exactly the amount it is asked to: no fee on transfer, no hooks. | Rules does not measure what arrived when a rule is funded; a token that kept part of each transfer would leave the escrows above the balance. Endowments does measure (`test_deposit_revertsIfTheTokenKeepsPartOfTheTransfer`, `test_create_revertsIfTheTokenKeepsPartOfTheTransfer`). Whatever powers IMD's issuer has over the token apply to IMD held here. | Call back into a contract in the middle of a transfer and get past its lock, even if it had hooks. |
| T2 | The sIMD vault, `0x9efa934d9fad4ae28c998a40195646b965a97247`: a Solady ERC-4626 over IMD whose owner is the zero address | Holding everything Endowments has staked, and doing what its previews say. | A loss inside the vault is shared by the depositors of each endowment in proportion (E2). A vault that does not do what it previewed is not acted on: the call reverts `VaultMismatch` (`test_stake_revertsIfTheVaultMintsFewerSharesThanItPreviewed`, `test_withdraw_revertsIfTheVaultPaysShort`, `test_withdraw_revertsIfTheVaultBurnsMoreThanItSaid`, `test_harvest_revertsIfTheVaultPaysShort`). It pays nothing out to a holder in a block in which that holder was minted shares (E3). | Be made to pay one endowment's principal to another: each endowment's shares and each depositor's principal are booked here, not in the vault. |
| T3 | Permit2, `0x000000000022d473030f116ddee9f6b43ac78ba3`, to which sIMD gives a standing allowance over every holder's shares | Moving tokens only with the holder's approval inside Permit2 or the holder's signature. | Endowments can give neither: it never calls Permit2 and has no signature check. | Move the shares Endowments holds (`test_fork_permit2CannotMoveThisContractsShares`). |
| T4 | `Questions` (launch A), `0xEECE4628ceb091C13393fc64056Be8b8501fD3F6` | For a meter endowment: stating a feed's cost and its meter honestly, and crediting what it is sent. For Zap: crediting the meter shares to the address Zap names. | A meter harvest is final (E5). A Questions that misreports its meter changes only how much yield leaves, never principal. If it cannot be read, a meter harvest reverts and the yield stays staked (`test_runway_ifQuestionsCannotBeReadTheYieldStaysStaked`). | Take more than a harvest sends it (the allowance is exactly that amount), or take less and leave the rest stranded (`test_harvest_meter_revertsIfTheMeterPullsLessThanItWasSent`). Re-enter (`test_harvest_meter_aCallBackIntoEndowmentsIsRefused`). Keep Zap's caller from its IMD without crediting shares (`test_fundMeter_revertsWhenNoSharesAreCredited`). |
| T5 | The source of a FEED rule: whatever contract the rule's creator named, normally `Questions` | Answering `latest(feedId)` truthfully: the value, the round and the time of the answer. | Rules believes it. A source of the creator's choosing can answer anything; behind the real Questions stand IdentityMD's oracle signer and whoever hands in a signed answer (R3). | Make a rule do anything but the action its creator fixed, more often than once per round it reports and once per cooldown. Stop or slow other rules: the read is a static call with 100,000 gas whose failure means "not now" (`test_fire_feed_aSourceThatRevertsOnlyStopsTheRule`, `test_fire_feed_aSourceThatBurnsItsGasOnlyStopsTheRule`, `test_fire_feed_aShortAnswerOnlyStopsTheRule`). |
| T6 | `WorkOrders`, the hire desk (launch B), `0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2` | Reporting `accountOf(orderId)` honestly: `returned` counts every IMD transfer the desk makes to the employer for that order, each exactly once. Pulling exactly the order's `maxPay`. Never reusing an order id. | Rules checks what it can: the amount pulled (`test_fire_hire_refusesADeskThatTakesLessThanTheOrderCosts`), the id (`test_fire_hire_refusesAnOrderIdItAlreadyKnows`), that the desk names Rules as the employer (`test_reconcile_refusesADeskThatNamesAnotherEmployer`), and that no rule is credited with IMD that is not there (`test_reconcile_refusesADeskThatReportsMoreThanItSent`). It cannot tell one order's return from another's: a desk that over-reported one order would have that order's rule credited from another rule's return that nobody had reconciled yet (`test_reconcile_theBalanceCheckProtectsBookedEscrows_notUnreconciledReturns`). The desk is the same team's immutable code, launched as launch B and unchanged by IdentityMD's pipeline, and launch B holds the property as an invariant; on a fork the live desk's figures for a settled order of a rule are exactly what it sent (`test_fork_live_theFirstRule_firesOnTheLiveHiresFeedAndIsPaidOnARealReceipt`). | Reach escrows that are already booked to a rule. Re-enter Rules while a rule fires or an order is recalled. |
| T7 | Everything behind the desk: IdentityMD's WorkRegistry and its writer, runners, challengers, an order's arbiter | Deciding whether an order of a HIRE rule is paid. | An order's escrow is on the desk and follows the desk's rules, which launch B's `docs/THREATS.md` sets out. The registry's writer wrote no receipt from about 8 to 14 October 2026 (R14). In short: a receipt written for work that was not done pays the runner; with the claimed-path flag an untrue delivery claim that nobody challenges within 24 hours is paid (R6). What is not paid out comes back to the rule. | Take more than the order's `maxPay`, which the rule's creator fixed. |
| T8 | `CrowdPots` (launch B), `0x8C2FfCdcb103659aa05c772b8F2059868B496EB5` | For a pot endowment: saying what a pot still needs and taking a chip in the beneficiary's name. For Zap: the same, in the caller's name. | It is called defensively by Endowments: the question with 50,000 gas, the chip with 500,000, neither can stop a harvest, and what the pot took is read from the balance (`test_harvest_pot_aRevertingPotSendsEverythingToTheFallback`, `test_harvest_pot_aPotThatBurnsItsGasCannotStopTheHarvest`, `test_harvest_pot_aPotThatReturnsHugeDataCannotStopTheHarvest`). What a pot does with a chip afterwards is launch B's matter. | Take more than it was offered (`test_harvest_pot_revertsIfThePotTakesMoreThanItWasOffered`). Re-enter (`test_harvest_pot_aCallBackIntoEndowmentsIsRefused`). |
| T9 | Uniswap v4's PoolManager, `0x000000000004444c5dc75cb358380d2e3de08a90`, and the ETH/IMD pool | Calling back only the contract that asked it to unlock, and refusing to finish unless every amount owed is settled. The pool's price is not trusted: the caller states the least it accepts. | A manager that misreported a swap is caught where Zap can see it: a result of the wrong sign, more ETH used than was offered, ETH paid and not counted (`test_swap_revertsOnAResultOfTheWrongSign`, `test_swap_revertsWhenTheManagerUsesMoreEthThanItWasOffered`, `test_swap_revertsWhenTheManagerDoesNotCountTheEthItWasPaid`). If the pool or the manager stops working, Zap's three entry points revert and nothing else is affected. | Leave Zap holding a caller's money: whatever a call does not deliver goes back to the caller, or the call reverts. |
| T10 | A VIEW rule's target: any contract the rule's creator named | Nothing. | It is untrusted. It is read with a static call and 100,000 gas; a revert, a burn of all its gas, too few bytes or no code only mean the rule does not fire (`test_fire_view_aTargetThatRevertsOnlyStopsTheRule`, `test_fire_view_aTargetThatBurnsItsGasOnlyStopsTheRule`, `test_fire_view_aTargetThatAnswersWithTooFewBytesOnlyStopsTheRule`, `test_fire_view_aTargetThatTriesToWriteOnlyStopsTheRule`, `test_fire_view_aTargetWithoutCodeOnlyStopsTheRule`). | Be given less gas by whoever fires the rule, so as to answer differently (`test_fire_view_theCallerCannotStarveTheConditionOfGas`). Cost Rules more than its allowance, whatever it returns (`test_fire_view_aVeryLongAnswerIsReadByItsFirstWordOnly`). |
| T11 | A rule's creator, and an endowment's creator | The creator of a rule chooses everything about it and can cancel it at any time. The creator of an endowment chooses its target and, for a pot, its fallback beneficiary, once and for good. | A keeper has no claim on a tip until it has fired the rule. Depositors must read an endowment's target and beneficiary before depositing (E6). | An endowment's creator has no power over it after creating it: it cannot move principal, change the target or stop a harvest. |
| T12 | Keepers | Liveness only. Nothing here runs by itself. | With nobody calling: deposits wait unstaked and stay withdrawable, yield stays staked, rules do not fire, returns from the desk wait to be reconciled. Nothing is lost. | |
| T13 | The launch pipeline and the ProjectFactory | Creating the three contracts with the manifest's arguments, in order. | A wrong argument is permanent. `docs/LAUNCH.md` says how to check each address before the launch and how to read every argument back after it. | Hold any privilege afterwards: no constructor stores `msg.sender` (`test_launch_constructorsTouchNothingOutsideTheirOwnContract`). |
| T14 | OpenZeppelin Contracts 5.5.0 (vendored in `lib/`) and solc 0.8.26 | Correctness of the library code and the compiler. | | |

## 3. Limits of Rules

**R1. Any VIEW condition is accepted, including one a caller can make true for the length of one
transaction.** Rules does not judge conditions. A creator who points a rule at a spot balance, a
pool price or anything else that can be moved and moved back lets whoever wants the tip make it
true, fire the rule and undo the move. What that caller can gain is bounded by the rule itself: the
tip, and an action whose recipient or order terms the creator fixed. If the caller also stands to
gain from the action (it is the PAY recipient's partner, or it means to take the order as a
runner), the condition is the creator's only gate, and it was the creator's choice. The first rule
of `docs/LAUNCH.md` reads a Standing Question's answer, which only the oracle's signature can set,
and its action is an order that is paid only against a receipt. The VIEW rule that document gives
as an example reads sIMD's total assets, which anyone with enough IMD can raise for a block.

**R2. A condition is read when the rule is fired, and only then.** One true reading fires it. There
is no latch and no second look: a PAY rule's money moves in that transaction.

**R3. A FEED rule believes its source.** The rule's creator names the contract that is asked for
`latest(feedId)`; a later Questions deployment needs no new Rules, and by the same token a source
that is not Questions at all is believed just as much. With the real Questions the answer is one
that IdentityMD's oracle signer attested, delivered by the Intake or handed in by any caller
through `submit` once that is open; launch A's `docs/THREATS.md` (Q3, Q4) says which feeds that
matters for. A list answer is stored as a hash, which a rule can only compare as a number. A FEED
rule can fire on an answer that was already there when the rule was created, if it is fresh enough;
after that, once for each newer answered round (`test_fire_feed_firesOncePerRound`,
`integration/`: `test_feed_firesOncePerAnsweredRoundOfTheRealFeed`). A failed round is not a new
answer (`integration/`: `test_feed_aFailedRoundIsNotANewAnswer`).

**R4. Only `fire` insists on the condition's gas.** `fire` reverts `GasShort` unless the target can
be offered the whole 100,000 gas, so the sender of a transaction cannot choose the answer of a
target whose answer depends on gas (`test_fire_gasShort_isACleanRefusal_andAnOrdinaryLimitIsEnough`).
The views `check` and `canFire` cannot insist: a reading taken through them with little gas can
differ (`test_check_isOnlyAsGoodAsTheGasItIsGiven`).

**R5. What a HIRE rule's creator fixes, it fixes for every order the rule opens.** The job text,
the kind, the price range, the bond, the delivery time, a reserved runner, an arbiter and the flags
are stored once (`test_fire_hire_opensTheOrderWithThePinnedTerms`). Rules checks at creation what
the desk would refuse later: the spec's characters and length, the bond and delivery time against
the desk's limits, the flags (`test_createRule_hire_refusesFlagsTheDeskRefuses`,
`testFuzz_spec_arbitraryBytesAgreeWithTheDesk`, and against the real desk `integration/`:
`test_createRule_readsTheRealDesksLimits`, `testFuzz_createRule_refusesASpecExactlyAsTheRealDeskDoes`).
It cannot check that the swarm writes the named kind for the job described, or that IdentityMD
accepts the job text (its API guide gives a 4,000-character limit for one template, below the
desk's 7,900). An order that no job can settle ends in a refund and its escrow returns to the rule;
the tip of the fire that opened it is spent.

**R6. With the claimed-path flag, the creator accepts the desk's bonded claims for every order of
the rule.** A runner's statement that the job was delivered is paid after 24 hours unless somebody
posts a bond equal to the runner's to challenge it, and an untrue claim that nobody challenges is
paid. A challenged claim that nothing decides by the delivery deadline refunds the order, even when
the claim was true. Rules never challenges and never arbitrates; a creator who wants a say names an
arbiter. Without the flag only a receipt pays (`integration/`:
`test_hire_claimedPath_anUnchallengedClaimIsPaidAndTheChangeReturns`,
`test_hire_claimedPath_anUndecidedDisputeRefundsTheRule`, `test_hire_withoutTheFlagOnlyAReceiptPays`).

**R7. Money comes back from the desk only as the desk reports it.** `reconcile` credits the
difference between the desk's `returned` figure and what was already credited, never a change in
balance (`test_reconcile_creditsEachNewAmountOnce`, `test_reconcile_isSafeToRepeat`). The limits of
that are in T6. IMD sent to Rules any other way belongs to no rule; no function pays it out and it
stays in the contract.

**R8. Returns for a cancelled rule go to its creator, not to the rule.** `cancel` ends the rule
for good; orders it opened stay on the desk, and what they return later is sent straight to the
creator by whoever calls `reconcile` (`test_reconcile_afterCancel_paysTheCreatorDirectly`,
`test_onWorkDelivered_afterCancel_paysTheCreator`).

**R9. The delivery callback is a convenience.** A rule that set the desk's callback flag gets the
change of a delivered order inside the settlement, in about 62,000 of the 150,000 gas the desk
allows (`test_onWorkDelivered_gasFitsTheDesksAllowance`; on the real desk `integration/`:
`test_hire_aProvenDeliveryReturnsTheChangeInsideTheDesksCallback`,
`test_hire_aCancelledRulesChangeGoesToItsCreatorInsideTheCallback`). If the callback fails, nothing
is lost: `reconcile` does the same later. The callback does not open a new order; a rule hires
again only when somebody fires it again.

**R10. A tip is paid for every fire, whatever becomes of the order.** A keeper can fire a HIRE rule
whose order nobody then takes. The order's escrow returns; the tip does not. Cooldown and the
maximum number of fires are the creator's limits on this (`test_fire_respectsTheCooldown`,
`test_fire_stopsAtTheMaximumNumberOfFires`); a rule with no cooldown whose condition stays true can
be fired again in the same block until its fires or its escrow run out
(`test_fire_aZeroCooldownAllowsFiresBackToBack`).

**R11. Smaller points.** Anyone may add to a rule's escrow, and what they add becomes the creator's
on `cancel` (`test_topUp_anExhaustedRuleStillTakesMoney_whichItsCreatorCanWithdraw`). A rule may be
created with less than one fire's cost and then waits (`test_createRule_acceptsAZeroDeposit`). A
fire that would cost more than 2^96 wei is refused at creation
(`test_createRule_refusesACostNoEscrowCanHold`). Rule ids are handed out in order: read a new rule's
id from its `RuleCreated` event. The job text of a HIRE rule is public from the moment the rule is
created.

**R12. The tip is the first firer's.** Whoever's `fire` is mined first is paid the tip; a keeper whose
transaction somebody copies and has mined ahead loses its gas, and its own transaction reverts having
moved nothing. The rule's recipient or order is served once either way, and no caller can take more
than the tip (`test_fire_aCopiedFireTakesTheTip_andTheFireItCopiedRevertsHavingMovedNothing`). There
is no earlier party a tip could be kept for: firing is the whole of the work. Section 10, pattern 2.

**R13. A creator's `cancel` races every keeper once the condition holds.** Whichever is mined first
decides: a fire spends one fire's cost and the cancel returns the rest, or the cancel returns
everything and the fire reverts (`test_cancel_racesAFireOnceTheConditionHolds_andWhicheverLandsFirstDecides`).
A creator who wants a rule never to fire again should cancel it before its condition can hold.

**R14. A HIRE rule's order without the claimed path waits on IdentityMD's receipts.** The desk pays
only when the WorkRegistry holds the job's receipt, and a receipt that arrives after the order's
delivery deadline cannot pay if somebody has had the order timed out first (launch B's
`docs/THREATS.md`, W1). The registry wrote no receipt from about 8 October 2026 to 14 October; it has
written again since, and that day the desk's first order was paid on its receipt. What the rule
loses when a receipt is late is the tip of the fire and the order's time: the escrow comes back
through `reconcile`, with the runner's bond, which the desk forfeits to the employer.

## 4. Limits of Endowments

**E1. What the principal guarantee covers.** A depositor can take back exactly the IMD it put in,
to the wei, in whole or in pieces, whenever it likes, and nobody else can move it: not the
endowment's creator, not its target, not a keeper. `harvest` takes only shares an endowment holds
beyond what its principal needs, plus a margin (`testFuzz_principalComesBackToTheWei`,
`testFuzz_everyDepositorGetsExactlyTheirOwn`, `testFuzz_harvestNeverTakesPrincipal`,
`invariant_E3_exactWithdrawalsOnlyWaitForAHold`; with the real IMD and the real vault,
`test_fork_depositStakeHold_thenExactPrincipal_withNoYield` and
`test_fork_yieldByPlainTransfer_harvest_thenExactPrincipal`).

**E2. What it does not cover.**

- *A loss inside sIMD.* sIMD's price cannot fall by its own rules, and this contract does not rely
  on that. If it did fall, an endowment whose shares no longer cover its principal is short: it
  takes no deposits, `harvest` takes nothing from it, `withdraw` reverts, and `exit` pays each
  leaver the same fraction of what the endowment holds as they give up of its principal, so the
  first to leave cannot take more than their part (`test_loss_isSharedProRata_theFirstToLeaveCannotTakeEverything`,
  `invariant_loss_sharedFairlyAndHarvestStops`). The rest of that principal is written off for the
  leaver; nothing is owed later if the endowment recovers.
- *Deposits that were still waiting to be staked when the loss happened.* They are pooled with the
  rest of their endowment and share its loss (`test_loss_bufferedImdIsSharedInTheSameProportion`).
  Keeping them apart would need a ledger per depositor and an end to paying withdrawals from the
  buffer first.
- *The block of a hold* (E3), in which principal leaves as sIMD shares or waits one block.
- *The state right after a loss has been made good.* An endowment can then cover its principal
  with fewer than `SPARE` share-wei left over. It takes no deposits, and a withdrawal that would
  leave the others one share-wei short is refused, until yield or a small donation rebuilds the
  spare (`test_spare_none_isCoveredButNotWhole_andTakesNoDeposit`,
  `test_spare_none_noWithdrawalLeavesTheOthersAShareWeiShort`).
- *Earnings.* A depositor earns nothing. All yield belongs to the endowment's target, and yield
  that has been harvested is gone for good.
- *The seed* (0.000001 IMD, paid by the creator), and anything given with `donate`.
- *IMD's own value*, and anything that happens to the IMD token itself.

**E3. In a block where sIMD holds the contract, only buffered IMD can be withdrawn as IMD.** That
is the block of this contract's own `stake` (at most one block in fifty), and any block in which
somebody deposits into sIMD in this contract's name or sends it freshly minted shares. The second
costs whoever does it one sIMD deposit of gas for every block they keep it up and gains them
nothing; while it lasts, `harvest` cannot run and IMD withdrawals that need the vault wait
(`test_withdraw_whenSomeoneDepositsIntoTheVaultInOurName_waitsOneBlock`,
`test_harvest_whenSomeoneElseCausesAHold_failsWithTheVaultsError_forThatBlockOnly`). There is no
upper bound on how long: a stranger who repeats the one-wei deposit in every block keeps every
`harvest` and every IMD withdrawal that needs the vault reverting, with the vault's own error rather
than `HoldActive`, for as long as they pay about 60,000 gas a block; no yield reaches any target
meanwhile, and no principal is at risk
(`test_audit_aStrangerCanHoldTheVaultEveryBlock_andOnlyTheInKindExitIsOpen`; the launch audit's
finding fb892c57, kept as it is: `ADAPTATION.md`). `exit` with
`inKind` is never held: it hands over sIMD shares worth the principal
(`test_exit_inKind_worksInTheStakeBlock_andTheSharesAreWorthThePrincipal`,
`test_fork_holdCausedBySomeoneElse_inKindExitStillWorks`).

**E4. The price mark sees a fall only from a price that `stake` or `harvest` ran at.** Both record
the highest sIMD price they have seen and refuse to run below it, so that after a fall no more IMD
enters the vault and yield is kept as cover (`test_priceFall_stakeAndHarvestStop_andTheYieldKeptCoversASecondFall`).
A rise and a fall between two such runs goes unnoticed; then only the per-endowment rules of E2
apply (`test_priceFall_thatNoStakeOrHarvestSaw_eatsYieldFirstAndNeverPrincipal`).

**E5. A meter endowment's harvests are final, and the runway bounds them only so far.** Harvested
IMD becomes meter shares that Endowments holds and never redeems; nothing in the contract calls
`defund` (`integration/`: `test_meter_harvestedYieldStaysOnTheMeter`). So that a feed which has
stopped asking cannot absorb an endowment's yield without end, a harvest never lifts a meter above
the cost of thirty requests at `Questions.costOf`, and the rest stays staked
(`test_runway_aHarvestFillsTheMeterToThirtyRequestsAndNoFurther`,
`testFuzz_runway_neverLiftsTheMeterAboveThirtyRequests`, and on the real meter `integration/`:
`test_meter_aHarvestTopsTheRealMeterUpToThirtyRequests`). What that rule does not do:

- The cost is the feed's own: the Intake's price plus the keeper tip that whoever created the feed
  set (0.5 and 0.05 IMD for the house feeds). A feed with a large tip has a large runway, and the
  tip of every answered round is paid out by Questions to the keeper that opened the round, however
  the answer arrives: IdentityMD's pipeline set that rule in launch A before deploying it (section
  10). Depositors should read a feed's parameters before endowing it.
- It bounds what a harvest adds, not what a meter holds. A tip returned by a failed round, a fall
  in the feed's cost, or IMD somebody else put on the meter can leave it above thirty requests; the
  endowment then waits (`test_runway_followsTheFeedsCost`, and with a real failed round
  `integration/`: `test_meter_aTipReturnedByAFailedRoundCanLeaveTheMeterAboveTheRunway`).
- Anyone can fill the room with IMD of their own. It is then their money that buys the feed's
  answers, they can take the unspent part back, and the endowment's yield waits meanwhile
  (`test_runway_aMeterSomeoneElseFilledTakesNothing`). They can do it for the length of one
  transaction around somebody else's harvest: that harvest then sends less or nothing, the yield
  stays staked and the next harvest sends it; nothing is lost and nothing reaches them
  (`test_runway_aFundAndDefundAroundAHarvestOnlyDelaysTheYield`). Section 10, pattern 5.
- A meter is shared. What is on it is spent for every holder of its shares in proportion, and
  launch A's `docs/THREATS.md` (Q5) describes how a funder that arrives just before a failed round
  is closed takes part of the returned tip.
- While Questions states no cost for the feed (the Intake is not selling its action, or asks more
  than the feed's cap), nothing is harvested and no meter endowment can be created for it
  (`test_createForMeter_revertsWhileTheFeedCannotBeAsked_andWorksOnceItCan`, `integration/`:
  `test_meter_theRunwayFollowsTheRealCost`). That wait has no other end. A meter endowment has no
  fallback and no other target, there is no sweep, and depositors take back exactly their
  principal, so the yield it holds, earned before or after the feed stopped being sold, stays staked
  in Endowments until the feed is sold again, even after the last depositor has left. If the feed is
  never sold again it stays there for good
  (`test_audit_aMeterEndowmentsYieldWaitsForAsLongAsTheFeedIsNotSold`; the launch audit's finding
  04444071, kept as it is: `ADAPTATION.md`). Whoever creates a meter endowment accepts that: the
  design gives the yield no address but the feed's meter, so that no stranger's call and no later
  choice can send it anywhere else.
- Launch A's Payroll tops its house feeds' meters up to a runway of its own, 14 or 4 requests,
  counted from its own meter shares (`Questions.redeemable`), so an endowment that keeps a meter full
  does not take Payroll's place. The endowment's runway counts the whole meter, Payroll's IMD
  included: on a house meter that Payroll keeps topped up, a harvest has room for thirty requests
  less what Payroll holds there. This follows from the two contracts' rules as written; no test here
  runs them together.

**E6. A pot endowment's fallback beneficiary is a party to trust.** Every chip is made in the
beneficiary's name, so every refund or change the pot pays goes to them. They receive the whole
harvest whenever the pot takes no chips: it is full, launched, out of time, cannot be read, or
reverts (`test_harvest_pot_aFullPotSendsEverythingToTheFallback`, `integration/`:
`test_pot_aRealPotOutOfTimePaysTheFallback`). For a single pot that is the normal end: once it is
full, all later yield is the beneficiary's, and anyone, the beneficiary included, can fill the pot.
A series never needs nothing, so its beneficiary is not paid directly while the series runs
(`integration/`: `test_pot_aRealSeriesIsFundedRoundAfterRound`). A harvest takes out no more than
the pot says it needs (`test_harvest_pot_takesOutOnlyWhatThePotStillNeeds_andTheRestStaysStaked`;
on the live CrowdPots, `test_fork_live_aPotEndowmentChipsIntoALivePot`). Refunds of those chips are
paid by CrowdPots to the beneficiary at anyone's call, which is what lets a beneficiary contract
with no function for claiming be paid at all; IdentityMD's pipeline left that rule of launch B as it
was (section 10, pattern 3). A beneficiary that cannot move IMD on keeps what it is paid, as E8 says
of a recipient.

**E7. A pot harvest must be sent with more gas than it uses.** It reverts `LowGas` unless the pot
can be handed its whole 500,000 gas, so that a caller cannot starve the pot and push the yield to
the fallback (`test_harvest_pot_noGasAmountPushesTheHarvestToTheFallback`,
`test_harvest_pot_atTheLeastGasAllowed_aPotThatBurnsEverythingStillLeavesTheFallbackPaid`). The
least gas that passes was 784,667 with the real IMD and sIMD
(`test_fork_potHarvest_withTheRealToken_andItsGas`); 850,000 is the limit to send.

**E8. A recipient can be any address but six.** The zero address, Endowments itself, IMD, sIMD,
Questions and CrowdPots are refused, because IMD sent there by plain transfer would be lost or, for
sIMD, shared with whoever staked a block earlier
(`test_createForRecipient_revertsWhereTheYieldWouldBeStranded`,
`test_createForRecipient_refusesTheVault_soNoHarvestCanBeCollectedByAOneBlockStaker`). Any other
contract is accepted, including one that cannot move IMD on
(`test_createForRecipient_acceptsAnyOtherContract`), and a harvest, which anyone may call, pays it
(`test_harvest_paysARecipientContractThatCannotMoveIMD_becauseItsCreatorChoseIt`). The list cannot be
complete: Endowments does not know the hire desk, Payroll or WorkProof, where IMD sent by plain
transfer would also stay; launch B's auditors noted the same of `CrowdPots.chipInFor`. Section 10,
pattern 1.

**E9. Targets are checked once, at creation.** A meter endowment needs a feed Questions states a
cost for; a pot endowment needs a pot or series that already exists
(`test_createForMeter_revertsForAnIdThatIsNotAFeed`, `test_createForPot_revertsForAPotThatDoesNotExistYet`).
Endowment ids are handed out in order: read a new id from its `Created` event and deposit to that
id, not to a predicted one.

**E10. Dust, and tokens sent directly.** IMD is accounted for to the wei. sIMD shares are not: the
split of a staked batch between endowments rounds down and leaves under one share-wei per endowment
per batch (about 0.000008 IMD-wei) booked to nobody. IMD or sIMD sent straight to the contract
belongs to no endowment. There is no sweep: any destination would be somebody's choice.

**E11. Sizes that assume today's order of magnitude.** `SEED`, `MARGIN` and `SPARE` assume a
share-wei is worth less than an IMD-wei, which holds until sIMD's price is more than a hundred
thousand times today's. Beyond that the contract stays exact, but a new endowment takes no second
deposit until it has earned a little
(`test_harvest_pot_whenAShareWeiIsWorthThousandsOfImdWei_theAmountsAreStillExact`).

**E12. Waiting.** A deposit earns nothing for its endowment until the next `stake`, up to 50 blocks
away and only when somebody calls it. `harvestable` and `harvest` of a meter endowment revert if
Questions cannot be read. Two waits have no bound inside this contract: a hold that somebody else
renews every block (E3), and a meter endowment's yield while its feed is not sold (E5). Neither
touches principal; the first ends when the stranger stops paying, the second when the feed is sold.

## 5. Limits of Zap

**Z1. Price protection is the caller's own: the minimum out and the deadline.** Zap swaps on one
pool and sets no limit of its own. A caller who passes a minimum of zero accepts any price, and a
transaction can be reordered around; a caller who passes a far deadline accepts being mined at any
time. A call that would produce less than its minimum, or that runs after its deadline, reverts and
costs only gas (`test_chipIn_minimumOut_protectsAgainstAWorsePrice`,
`test_deadline_runsInItsLastSecondAndRevertsOneSecondLater`, `test_deadline_isCheckedBeforeEverythingElse`,
`testFuzz_deadline_runsExactlyWhenNotLate`). A deadline of zero is a deadline that has passed, not
"none" (`test_deadline_zeroIsNotNoDeadline`).

**Z2. The whole of the ETH is swapped before the pot is asked what it needs.** If the pot needs
less, the surplus comes back to the caller as IMD in the same call, bought at the pool's price and
fee (`test_chipIn_sendsBackTheImdThePotDidNotNeed`, `integration/`:
`test_chipIn_theChipIsTheCallersAndTheSurplusComesBack`). A pot that takes nothing at all reverts
the call, so the caller keeps its ETH (`test_chipIn_revertsWhenThePotTakesNothing`, `integration/`:
`test_chipIn_revertsWhenTheRealPotTakesNothing`).

**Z3. The pool is fixed, and its cost is not Zap's to set.** The liquidity providers' fee is 1%.
Uniswap's protocol fee comes on top (it read 0.1% on 13 October 2026) and can be changed by
Uniswap's governance. The pool's depth is thin and changes; on 10 October a swap of 0.01 ETH
returned 98.9% of the spot price. If liquidity leaves, callers' minimums stop being met.

**Z4. What reaches Zap from outside goes to the next caller that can take it.** Zap has no
`receive`, but ETH can be forced into any address and anyone can transfer IMD to it. Each call ends
by sending the caller Zap's whole balance of both (`test_strayImdAndEthLeaveWithTheNextCall`). A
caller that cannot receive ETH is served as long as it is owed none of its own back
(`test_strayEth_doesNotStopACallerThatIsOwedNoRefund`), and reverts if it is
(`test_strayEth_aCallerOwedARefundItCannotTakeStillReverts`).

**Z5. Zap does not open orders.** The hire desk makes whoever calls it the employer, who receives
the refund, the change and the callback, and that must be the person who paid. `buy` hands over the
IMD and the caller opens the order in its own name.

**Z6. What the caller is credited with is launch A's and launch B's to honour.** The meter shares
are the caller's by `Questions.fundFor` and the chip by `CrowdPots.chipInFor`; Zap keeps neither
(`integration/`: `test_fundMeter_theSharesAreTheCallersOnTheRealMeter`,
`test_chipIn_aRefundOfTheChipGoesToTheCallerNotToZap`).

## 6. Limits of the build and of its tests

**B1. In this repository's own suite, Questions, the hire desk and the crowd pots are stand-ins.**
Their sources are two other repositories. The stand-ins are `test/rules/mocks/MockDesk.sol`,
`MockFeed.sol`, `MockPots.sol`, `MockQuestions.sol` and `test/endowments/mocks/MockQuestions.sol`,
`MockCrowdPots.sol`. What each leaves out of the real contract:

| Stand-in | Follows the real contract for | Leaves out |
|---|---|---|
| `MockDesk` | `createOrder`'s checks in their order with the real errors and error data, `cancel`, `refund`, `accountOf`, `stateOf`, the constants | Runners, claims, receipts, disputes: a delivery and a bond award are test helpers. Its lock: it has none. |
| `MockFeed` | The shape of `latest`: five words | Everything else; a test stores what it answers. |
| `MockPots` (Zap's) | `chipIn`, `chipInFor`, `remaining`, `potCount`, a series that opens a pot per round, `BadBeneficiary` | Funding deadlines, hiring, refunds. |
| `MockCrowdPots` (Endowments') | The same surface | The same; and a round of a series has no pot id of its own. |
| `MockQuestions` (both) | `fund`, `fundFor`, `defund`, `costOf`, `meterOf`, `sharesOf`, the retiring of shares when a meter is spent to zero, the real errors | Asking, answers, the oracle, tips, the rescaling of share counts in a very old meter, and the lock. |

`integration/` holds each one beside the real contract and drives both with the same calls
(`StandInsAgree.t.sol`: the same acceptances, the same refusals with the same bytes, the same
amounts and books, among them 256 fuzzed orders and 256 fuzzed specs against the real desk), and
runs Rules, Endowments and Zap against the real contracts themselves. On 15 October 2026 it ran
against the sources of both sibling repositories as they were launched, IdentityMD's adaptations
included (`Questions.sol` sha256 `598e8783…`, `WorkOrders.sol` `92d339b1…`, `CrowdPots.sol`
`e65c02a6…`, `WorkProof.sol` `4def8163…`): 51 passed. The fork suite meets the live
contracts themselves (B4).

**B2. `integration/` is not part of what a launch import builds.** It compiles sources from two
folders beside this one and does not build without them. `forge build`, `forge test` and
`forge fmt --check` run from the root do not reach it: the root's `src`, `test` and `script` are
`src/`, `test/` and `script/`, its remappings name only forge-std and OpenZeppelin, and a copy of
this folder alone with invalid Solidity and unformatted code placed in `integration/test` built,
passed every test and passed the format check (15 October 2026). Somebody has to run
`cd integration && forge test` on the commits that are launched; `docs/LAUNCH.md`, section 5, makes
it a step.

**B3. Even there, some things are stand-ins.** IMD, the sIMD vault and the PoolManager (the fork
suite of the main project uses the real ones); IdentityMD's WorkRegistry and Intake (the test
doubles of launches B and A); the oracle's key (a test key); Payroll behind the desk (launch B's
stand-in). The work record a HIRE rule's order is settled on is a real IdentityMD record with its
job id and objective replaced, as in launch B's own tests.

**B4. On the fork, the contracts of the earlier launches are the live ones; the swarm's job is not
run.** The rehearsal through the real ProjectFactory deploys this launch against the live Questions,
WorkOrders and CrowdPots, and `test/launch/fork/LiveSiblings.fork.t.sol` runs the first day of
`docs/LAUNCH.md` against them with real IMD. Three things there are not what will happen on the day:
the job's receipt is written into the real WorkRegistry by acting as the writer the registry names;
the work record is a real IdentityMD record (job e9efec16, 7,339 bytes) with the order's job id and
objective put in; and the yield a harvest sends is IMD transferred to the vault by the test, as the
vault receives its yield, in place of days of real earnings. The FEED rule reads the live hires feed's
real answer, signed by the oracle and stored on 13 October 2026; on a day that answer is too old for
the rule, the two tests that depend on it skip themselves and say why.

**B5. The vault and the pool of the default suite are stand-ins checked against the real ones.**
`MockStakedIMD` is put in the state the real vault was in at block 26,164,296, and a fork test
compares its answers with the real vault's (`test_fork_theMockAnswersLikeTheRealVault`). The pool
stand-in sells at a fixed rate; the real pool is used in `test/rules/fork/RulesAndZapFork.t.sol`.

**B6. The fork suite depends on a public RPC.** Every fork test skips itself when the node cannot
be reached, and a skipped run shows nothing.

**B7. The launch is 7.91 million gas in our rehearsal,** against our gate of 12 million and the
protocol's ceiling of 16.7 million (`test_fork_launch_throughTheRealFactoryAsTheLaunchDeployer`).
The rehearsal passes placeholder values for the record the factory stores (source commit, manifest
hash, attestation hash) and an unused launch number.

**B8. Faults were planted to see the tests fail.** In a copy outside the repository, 42 single
changes were made one at a time: to the runway, the deadline, the order a rule opens, each
stand-in, and the calls into the real contracts. 40 failed at least one test. The two that passed
change no behaviour a test could see: the room for gas between `fire`'s check and its read lowered
from 20,000 to 10,000 (either leaves the target its whole allowance), and a pot's reported need of
zero no longer skipped before a calculation that comes to nothing for zero anyway.

The documents were treated the same way on 13 October 2026: 27 changes, one at a time, to the
manifest block, the first rule's parameters, job text and commands, the first endowment's amount and
event topic, a command's function name, a row of `README.md`'s tables, and four to the sources (an
undocumented function, a fallback, a constructor that looks at an address's code, a DELEGATECALL).
26 failed a launch test, each for its own reason. The 27th, writing three real-looking addresses
over the markers, was the change still to be made then, and it passed, as it had to. On 15 October 2026, with the three addresses
written in and the first day rewritten, 17 more changes were made the same way: a digit of an
address in the manifest, a marker put back, a shell variable and `README.md` naming another address,
a digit of launch A's transaction, two figures of the first day's ledger, the rule's deposit, line,
flags, gas limit and empty calldata, the endowment's amount and feed, a command naming a function
Questions lacks, the hires feed's shell variable, the withdrawal's amount. Each failed between one
and five launch tests.

**B9. `forge build` prints advisory notes from Foundry's linter** for names in capitals and
similar matters. The findings it would raise in `src/` for events emitted after a call, comparisons
with `block.timestamp`, narrowing casts and partial reads of a tuple are silenced line by line with
`forge-lint: disable` comments, each with its reason beside it.

## 7. What this launch inherits from the two before it

These are not limits of the three contracts, but a reader deciding whether to use them should know
them. Each is set out in the earlier launches' own documents. As of 15 October 2026:

- **Receipts.** An order of a HIRE rule without the claimed path is paid only when IdentityMD's
  WorkRegistry holds the job's receipt. The registry's writer wrote nothing from about 8 October to 14
  October 2026; it has written again since (44 receipts in the 1,800 blocks before block 26,197,394),
  and on 14 October the desk's first order was paid on its receipt. It can stall again (R14).
- **The order header.** IdentityMD keeps a job's objective byte for byte with the desk's 85 header
  bytes in front: shown on a research report bought on 13 October, and on chain by the desk's first
  order, a picture job, which the desk paid on the proven path on 14 October.
- **The house feeds.** Launch A's three feeds were created and their first rounds bought; each was
  answered on 13 October 2026, the employers feed by the Intake's own callback. A FEED rule, and a
  meter endowment, are worth what their feed is worth, and a feed is asked only when somebody pays
  for a round.
- **The Intake.** Launch A's `Questions` buys from version 2 of IdentityMD's Intake
  (`0xa43e6f75ee006411f79ac1c84120606c2330de82`), the one IdentityMD names for anything new. A
  Questions that cannot buy answers states no cost, and then no meter endowment can be created or
  harvested (E5).
- **What IdentityMD's pipeline changed.** In launch A: a round's keeper tip always goes to the
  keeper that opened the round; a silent round can be closed only after the answer's validity has
  also run out (36 hours, 5 minutes and 1 second for the house feeds); a seat held by a contract must
  claim its own payouts. In launch B: nothing in the code. Section 10 takes each through this launch.

## 8. Static analysis

`slither . --filter-paths "lib|test"` (Slither 0.11.4, run again on 15 October 2026 on the sources as
they are, which this pass did not change) reports 34 results: none of high impact, none of medium, 6
of low, 28 informational.

### The 6 low findings

- `timestamp` (4): `Rules.fire` and `Rules.canFire` compare the block time with a rule's cooldown;
  `Rules._check` compares it with the age of a feed's answer; `Zap._swap` compares it with the
  caller's deadline. Each is a duration in seconds chosen by a creator or a caller. The seconds a
  block proposer can shift a timestamp move a cooldown or a deadline by those seconds and no more.
- `reentrancy-benign` (2): `Rules._hire` records the link between a rule and its order after the
  call to the desk, because the order's id is the desk's answer; `Rules.recall` credits the rule
  after the desk has cancelled the order, because the amount is the desk's to state. Both run
  under the contract's lock, and the only contracts called are IMD and the desk
  (`test_reentrancy_everyMoneyFunctionIsLockedWhileARuleFires`,
  `test_reentrancy_lockedWhileAnOrderIsRecalled`).

### The 28 informational findings

- `naming-convention` (18): immutables and constants read through getters are written in upper
  case (`IMD()`, `WORK_ORDERS()`, `POOL_ID()`), in the contracts and in the interfaces that declare
  them.
- `assembly` (5): the three bounded reads of Rules (`_readWord`, `_readFeed`) and its spec check
  (`_firstRefusedByte`), and Endowments' bounded question to the pot and bounded chip (`_potRoom`,
  `_forward`). Each block is marked memory-safe and has its reason beside it.
- `cyclomatic-complexity` (3): `Rules.createRule` and `Rules.fire`, each a list of checks, and
  `Endowments._exit`.
- `low-level-calls` (1): Zap returns ETH to its caller with a plain call.
- `too-many-digits` (1): the constant 2^64 in `Rules._readFeed`.

### What is silenced in the source, and why

In seven places `src/` carries a comment that tells Slither not to report a finding (two pairs of
`slither-disable-start` and `-end`, five `slither-disable-next-line`). Each is listed here so that
a reader does not have to search for them.

| Where | Detector | Reason |
|---|---|---|
| `Zap._returnEverything` | `arbitrary-send-eth` (high) | The ETH goes to `msg.sender`, and it is the ETH that caller sent and the pool did not use, plus whatever was forced into the contract from outside. Zap holds nobody's ETH between calls, and the three callers of this function hold the lock. |
| `Rules.recall` | `reentrancy-no-eth` (medium) | The rule is credited after the desk's `cancel`, with the amount the desk then reports. The function holds the lock; a view read during the desk's call shows the return as not yet credited, which is what it is. |
| `Rules._reconcile` | `unused-return` (medium) | `accountOf` returns five values; only the employer and `returned` are needed. |
| `Endowments._meterRoom` | `unused-return` (medium) | `meterOf` returns the meter's balance and its share count; only the balance is needed. |
| `Endowments.stake`, `_leaveVault`, `_forward` | `reentrancy-balance` | Each reads a balance, calls sIMD or Questions, and compares the balance again: that is how the contract checks that they did what they reported. All three run under the lock. |

Without these comments Slither 0.11.4 reports 38 results: the 34 above, one of high impact and
three of medium, as marked in the table (run on a copy of the sources with the comments removed,
outside the repository). It has no `reentrancy-balance` detector, so the three comments of the last
row silence nothing in this version; the first-wave run with Slither 0.11.6 reported six findings
of that kind there, of high impact, which is why the comments exist. A reader who does not accept a
reason in the table should treat the matching finding as open.

## 9. What is not verified

- **These contracts on chain.** Nothing of this launch has been deployed. The launch is rehearsed on
  a fork through the real ProjectFactory, with placeholder record fields; the pipeline's own checks
  before that call are not ours to run.
- **A real swarm job for a rule's order, and a receipt written by IdentityMD.** On the fork the
  order of the first rule is settled on the live desk against the real WorkRegistry, but the receipt
  is written by acting as the registry's writer, for a real record whose job id and objective were
  replaced (B4). That a real job's receipt pays a desk order on chain was shown by launch B's first
  order on 14 October 2026, not by an order of a rule.
- **A FEED rule on an answer newer than 13 October.** The fork reads the live hires feed's one
  answered round. Whether the feed is asked again, and when, depends on somebody paying for it.
- **`integration/` in the launch pipeline.** It is run by hand (B2).
- **Real yield harvested.** No test waits for sIMD's own earnings: the tests add yield by
  transferring IMD to the vault, which is how the real vault receives it. The rate the first day
  counts on (0.16% in 4.6 days, 10 to 15 October 2026) is a reading of two blocks, not a promise.
- **The pool on the day.** Depth and price are read at the fork's block. Nothing here says what a
  swap will return on launch day.
- **A review by a second person of the changes made in the integration pass and in this one:** the
  runway in `Endowments`, the deadline in `Zap`, the first-day plan, the fork tests against the live
  contracts, section 10 and the documents around them. The integration pass's changes were read line
  by line by another engineer and 42 planted faults were run against them (B8); this pass changed no
  contract code.
- **No third-party audit.** Two internal reviews per contract in the first wave, their findings
  fixed or listed above, and the checks in this repository.
- **Gas figures** are from tests and from a mainnet fork, not from mainnet transactions.

## 10. What IdentityMD's pipeline did to our earlier launches, and what was checked here

IdentityMD's launch pipeline audits the code it imports and changes what it can reproduce before it
deploys. For our first launch (`Questions`, `JobsReport`, `Payroll`; IdentityMD launch 1531) it made
three changes: a round's keeper tip always goes to the keeper that opened the round, where before
whoever handed in the public signed answer first took it; a silent round can be closed only after
the answer's validity has also run out, where before a stranger could close it at twelve hours with a
valid answer still on its way; and a seat held by a contract must claim its own payouts, where before
anyone could have Payroll pay a contract that could not use the money. Two audits of that launch
raised nine findings more, one of them a medium left open there: a visitor to sIMD takes its share of
every drip it attends. For our second launch (`WorkProof`, `WorkOrders`, `CrowdPots`, the Doorbell;
launch 1573) the pipeline changed no code; its auditors raised one medium finding, answered in words
(a runner can hold a receipt-only pot's order past its hire window and give it back with nothing
forfeited, when the job's receipt shows a failed or another kind of job), and four notes. Both
repositories' own records give the details.

On 15 October 2026 each pattern behind those changes and findings was taken through `Rules`,
`Endowments` and `Zap`, function by function: every transfer and who decides its recipient, every
comparison with time and whose clock it is, every read of a balance that someone else can move.
**No contract code was changed as a result.** Where a pattern holds, it is written down here with a
test that shows it; four tests were added for this section.

### Pattern 1. A payout an observer can force into a contract that cannot use it

*In launch A:* a seat's payout followed the seat, a token that can be moved; a stranger's claim paid
an escrow contract that held the seat, and the seat's real owner lost the money. The pipeline made a
contract claim for itself.

*Here:* no payee follows anything that can be moved. `Rules` pays a PAY rule's recipient and the
desk's order escrow, both fixed by the rule's creator, the tip to the caller, and a rule's unspent
escrow and returns to its creator. `Endowments` pays a depositor its own principal on its own call,
and an endowment's yield to the target its creator fixed: a meter, a chip in the fallback
beneficiary's name, the beneficiary, or a recipient. `Zap` pays only its caller. A stranger's call
decides when a payment is made, never where it goes.

*What holds:* `harvest` is open to anyone and pays a recipient, or a pot endowment's fallback
beneficiary, that is a contract, whether or not it can move IMD on
(`test_harvest_paysARecipientContractThatCannotMoveIMD_becauseItsCreatorChoseIt`). That address was
fixed by the endowment's creator before anyone deposited, and only yield reaches it, never principal.
Endowments refuses the six addresses it knows would strand IMD (E8); it cannot know every one.

*Decided:* no change. The pipeline's rule for seats (a contract must claim for itself) would protect
nobody here, since no other party is owed that money, and it would leave the yield of every
endowment whose target is a contract unable to leave unless that contract made the call: a meter
cannot, and neither can most beneficiaries a pot endowment is created for. `docs/DEVIATIONS.md`, D7.

### Pattern 2. A function anyone may call that moves money to a third party, or pays its caller

*In launch A:* the keeper tip for a round went to whoever handed in the public signed answer first,
so an observer could copy the transaction and take the tip from the keeper that had paid for the
round. The pipeline gave the tip to the round's opener.

*Here:* the functions open to anyone that move money are `Rules.fire`, `reconcile` and
`onWorkDelivered` (the desk only), `Endowments.stake` and `harvest`, and Zap's three entry points.
Only `fire` pays its caller, and only the tip its creator set. Everything else goes to a party fixed
before the call.

*What holds:* the tip is the first firer's (R12,
`test_fire_aCopiedFireTakesTheTip_andTheFireItCopiedRevertsHavingMovedNothing`). Unlike the round in
launch A there is no earlier party that paid for the work and could be paid instead: firing a rule is
the whole of the work, and whoever does it first has done it. The copier takes the tip and nothing
else. A creator's `cancel` races keepers in the same way once the condition holds (R13,
`test_cancel_racesAFireOnceTheConditionHolds_andWhicheverLandsFirstDecides`).

*Decided:* no change. Tying the tip to an address chosen in advance would make the rule depend on
that keeper staying alive, which is what an open tip exists to avoid.

### Pattern 3. A tip or a refund that somebody else can redirect

*Checked:* every tip and every refund the three contracts pay or are paid. A rule's tip goes to the
caller of `fire` and nowhere else. What the desk returns for a rule's order goes to `Rules`, which
credits it to that rule from the desk's own figure (`accountOf(id).returned`), or to the creator of a
rule that was cancelled; nobody can name another destination (T6, R7, R8). Zap returns what a swap
did not use to its caller, and the chip and meter shares it buys are the caller's
(`integration/`: `test_chipIn_aRefundOfTheChipGoesToTheCallerNotToZap`). A pot endowment's chips are
the fallback beneficiary's, so a pot's refund of them goes there; launch B pays it at anyone's call,
which is how a beneficiary contract with no function for claiming is paid at all, and the pipeline
left that rule of launch B as it was.

*What holds:* nothing new. IMD or ETH that reaches Zap from outside goes to Zap's next caller (Z4); it
belongs to nobody, and Zap holds nobody's money between calls.

*Decided:* no change.

### Pattern 4. A wait measured against an outside service that can be late

*In launch A:* a round could be closed at twelve hours while the answer it had asked for was still
valid and on its way. The pipeline made the round wait for the answer's validity too.

*Here:* no function of the three lets a stranger end something that is still good. Rules' own clocks
are a rule's cooldown and, for a FEED rule, the age of an answer: an answer older than the creator's
`maxAge` is not acted on, which is the safe side (the rule waits), never a discard. Endowments' clock
is its own (50 blocks between batches, the one-block hold of sIMD); a harvest that cannot run waits
and loses nothing. Zap's deadline is the caller's.

*What holds:* a HIRE rule's order inherits the desk's clocks, and the desk cannot tell a job never
done from a job whose receipt is late. IdentityMD's receipts stopped for about six days in October
2026; an order of a rule whose delivery deadline passed in such a stall ends in a refund to the rule,
and the runner who did the work loses its bond and its swarm fee (R14, launch B's W1). The rule's
creator chooses the delivery time, up to 90 days, and the first rule of `docs/LAUNCH.md` gives seven.

*Decided:* no change in this code; nothing here can wait for a receipt better than the desk does.

### Pattern 5. A pro-rata share a just-in-time depositor can take

*In launch A:* stakers who enter sIMD just before Payroll's drip and leave after it take a full share
of the drip (left open there by the team).

*Here:* no depositor of an endowment earns anything: all yield goes to the endowment's target, and a
depositor takes back exactly its principal, so a depositor who arrives just before a harvest gains
nothing. The split of a staked batch between endowments is at one price for all. sIMD is refused as a
recipient precisely so that a lump harvest is never shared with whoever staked a block earlier (E8,
`test_createForRecipient_refusesTheVault_soNoHarvestCanBeCollectedByAOneBlockStaker`). Rules credits
returns from the desk's books per order, never from a shared balance (R7).

*What holds:* two things that are launch A's, met through its meters. A meter endowment holds meter
shares, so a funder that arrives just before a failed round is closed takes part of the returned tip
(launch A's Q5, E5). And a meter endowment's room is read from the meter's whole balance, which anyone
can raise and lower: the figure in launch A's low findings 1.2 and 2.2. Here a stranger who funds the
meter around somebody else's harvest makes that harvest send less or nothing; the yield stays staked,
the next harvest sends it, and the stranger gains nothing
(`test_runway_aFundAndDefundAroundAHarvestOnlyDelaysTheYield`).

*Decided:* no change. Launch A sized Payroll's top-ups from its own position because there a moved
figure sent money away for good. Here it only delays a harvest, and the runway exists to bound what
the meter holds, whoever's money it is: sized from the endowment's own shares, several endowments, or
an endowment and Payroll, could together lift a meter past it.

### Pattern 6. A bond that an employer can hold

*Raised for launch B:* a challenger's bond is held until an order's delivery deadline, up to 90 days,
and an employer that is its own runner, or names its own arbiter, can hold or take it.

*Here:* `Rules` is an employer on the desk. It never challenges, never arbitrates, and never runs an
order; it sets the terms its creator fixed, among them the arbiter and the claimed-path flag, and it
publishes them in `RuleCreated` before any order exists. A creator who names an arbiter of its own and
allows claimed deliveries can hold a challenger's bond through Rules exactly as through the desk
directly; a challenger can read the rule's terms first. What the desk forfeits to an employer (a
runner's bond) is credited to the rule and is its creator's (R8). `Endowments` and `Zap` hold no bonds.

*What holds:* the desk's behaviour, unchanged by Rules. The medium finding of launch B's review (a
runner can take a receipt-only order, register a job whose receipt shows a failed or another kind of
job, report it, and give the order back with its whole bond, as often as it likes) applies to a
rule's order as it does to a pot's: the rule's order can be held until its expiry and then refunded
to the rule, which loses the fire's tip and the order's time, not its escrow.

*Decided:* no change in this code. The first rule of `docs/LAUNCH.md` names no arbiter, does not
allow claimed deliveries, and gives a runner three days to take its order.

### The findings that do not follow a pattern above

| Finding | Where | Here |
|---|---|---|
| A guard that cannot fire and would do harm if it did | launch A, 2.5 | `Rules`' `DeskPulledWrongAmount`, `OrderAlreadyLinked` and `ReturnNotReceived`, and Endowments' `VaultMismatch` and `TargetMismatch`, cannot fire with the real desk, vault, meter and pots. Each reverts the one call and writes nothing; none drops or misdirects money (T2, T4, T6). |
| A view reports an amount the action then refuses | launch A, 1.4 and 2.4 | `harvestable` reports zero while the price is below the mark, and does not look at the hold (said in its notes); `canFire` and `check` are only as good as the gas they are given (R4); `quote` does not look at the hold. |
| The documents claimed more than the code gives | launch A, 1.3 and 2.3; launch B's medium | Every sentence with "never", "always", "cannot" or "only" in these documents and in the comments of `src/` was read against the code on 15 October 2026. Corrected: E5's account of who is paid a round's tip and of how Payroll's runway and an endowment's share a meter, both out of date since launch A was launched; E8, which named no address it misses; the status of every document. |
| The order of two open calls at a boundary decides where money goes | launch A, 1.1 | Whichever of `fire` and `cancel` is mined first decides (R13); both move money only to parties the creator fixed. A harvest and a withdrawal, or two harvests, in either order send the same amounts to the same places, to a share-wei. |
| A dependency fixed at construction cannot be replaced | the pipeline's note on launch A | The same choice here, for every address: `docs/DEVIATIONS.md`, D1. |
| `chipInFor` accepts a beneficiary where a refund would be stranded | launch B, note | Endowments refuses six such addresses for a pot endowment's fallback, and accepts the rest (E8). |

### What the review added, and one request

Four tests (`test_fire_aCopiedFireTakesTheTip_andTheFireItCopiedRevertsHavingMovedNothing`,
`test_cancel_racesAFireOnceTheConditionHolds_andWhicheverLandsFirstDecides`,
`test_runway_aFundAndDefundAroundAHarvestOnlyDelaysTheYield`,
`test_harvest_paysARecipientContractThatCannotMoveIMD_becauseItsCreatorChoseIt`); R12 to R14 and the
additions to T6, T7, E5, E6 and E8; D7 in `docs/DEVIATIONS.md`. The launch request in
`docs/LAUNCH.md` asks the pipeline to leave two rules as they are: the tip to the first firer
(pattern 2) and a harvest that pays a contract target (pattern 1). If the pipeline does change a rule
in this code, the tests named beside it in this document are the ones that will say what else moved.
