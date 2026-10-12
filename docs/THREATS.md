# What this launch trusts, and where its guarantees stop

This document lists every outside party the three contracts rely on, what each is relied on for,
and every limit we know of, including the ones our own reviewers raised. It is written for an
auditor. Where a statement is shown by a test, the test is named; where it is not shown by
anything, it is listed in the last section.

Contracts: `Questions` (Standing Questions), `JobsReport` (the Robot Jobs Report), `Payroll`.
Status: not launched, not audited by a third party.

## 1. Who can do what

There is no owner, no admin, no setter, no pause and no upgrade path in any of the three contracts.
The functions that can change state are the 21 listed in `README.md` and no others, none of them
payable (`test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes`, which reads the compiler's
ABI); the manifest gives no contract an owner (`test_manifest_namesTheThreeContractsInOrder`). Every
one of the 21 is open to any caller, with one exception: `Questions.onOracleResult` accepts calls
from the Intake only (`test_callback_fromAnyoneButTheIntake_reverts`). A caller never chooses where
money goes. It chooses only when a fixed rule runs.

Money leaves the contracts in these ways and no others:

| Contract | Way out | Who receives |
|---|---|---|
| Questions | `request` | The Intake's fee payee: the live price, at most the feed's `maxPrice` |
| Questions | `defund` | The caller: its own share of what a meter has not spent |
| Questions | `collectTips` | The caller: tips it earned by answered rounds |
| Payroll | `drip` | sIMD |
| Payroll | `claimSeat`, `claimSeats` | The current owner of each seat |
| Payroll | `claimTip` | The current owner of the seat the agent is bound to |
| Payroll | `fundFeeds` | The three house feeds' meters in `Questions` |
| JobsReport | none | It holds no money |

## 2. Trust roots

| # | Party | Trusted for | If it fails or turns against us | What it cannot do |
|---|---|---|---|---|
| T1 | The oracle signer, `0x5598aa9146215bc13eb26f2c692ad1461fd32982`, one externally owned key | Signing every answer. `Questions` accepts an answer only with its signature. | A wrong or compromised key can write wrong values into any feed, and so into the Jobs Report. | Move any meter's IMD or anything in Payroll: no function pays out on the content of an answer. The only money tied to an answer is the round's own keeper tip (0.05 IMD on the house feeds). |
| T2 | IdentityMD's Intake, `0x1397434cd35e8a9c8ac312a61d3a285eb31dea56`, and its owner | Taking the price and recording the request. Its owner sets the price and the callback gas. | A price above a feed's `maxPrice` stops that feed's requests. Callback gas below what the callback needs (116,622 at most in our tests, 200,000 allowed today) stops delivery by callback; `submit` remains. | Take more than the live price, capped by the feed (`test_blocked_whenThePriceIsAboveTheFeedsCap`). Leave an allowance behind (`test_request_revertsWhenTheIntakeTakesLessThanThePrice`). |
| T3 | The Intake's writer, `0x3d3c0df7c1a17d384545e9d7c8228897bd9625cb`, and the service behind it | Calling `complete`, which delivers the answer. Marking a request completed. | A request that is never served or never completed costs the meter the price. The round can be closed by anyone after six hours (`test_abandon_doesNotDependOnTheIntakeBehaving`). | Deliver an answer the oracle signer did not sign. |
| T4 | The IMD token | Being a plain ERC-20 with no fee on transfer and no hooks. | Both contracts book what actually arrived, by balance difference (`test_fund_creditsWhatActuallyArrived`, `test_pay_booksWhatArrivedNotWhatWasAsked`). | |
| T5 | sIMD, `0x9efa934d9fad4ae28c998a40195646b965a97247` | Receiving the stakers' stream by plain transfer and pricing its shares from its IMD balance. | While it does not answer as a vault over IMD with shares outstanding, `drip` reverts and the stream waits in Payroll (`test_drip_waitsWhileTheVaultHasNoStakers` and the four tests after it). | Block bookings, seat claims or tips (`test_stuckVaultDoesNotBlockTheRestOfPayroll`). |
| T6 | The seat token, `0x0000ec93127baa929e58e97dd0095a2bfb38ec1d` | Saying who owns a seat. Payroll pays whoever `ownerOf` names at the moment of a claim. | A seat whose owner is never named again keeps its share of the seat pool in Payroll for good. | Take another seat's share (`test_claimSeat_cannotTouchAnotherSeatsShare`). |
| T7 | The seat Adapter, `0xde152afb7db5373f34876e1499fbd893a82dd336`, an upgradeable proxy, and whoever controls it | Saying which seat an agent is bound to. Only tips depend on it. | Its controller decides which seat's owner can claim an agent's unclaimed tips, or that nobody can; in the second case the tips fall to the seat pool after 180 to 360 days. | Touch the stakers' stream, the seat pool or the feed budget. Make a read cost more than 100,000 gas (`test_adapterRead_anAdapterBeyondItsAllowanceIsNotHeard`). |
| T8 | `Questions`, as Payroll and JobsReport see it | Payroll hands it at most one runway per house feed at a time. JobsReport copies its answers. | It is this launch's own immutable code. | Take more from Payroll than the amount offered (`test_fundFeeds_revertsIfATopUpTakesMoreThanItWasOffered`), or block the rest of Payroll (`test_questionsDown_blocksNothing`). |
| T9 | The launch pipeline and the ProjectFactory | Creating the three contracts with the manifest's arguments, in order. | A wrong argument is permanent. `docs/LAUNCH.md` says how to read every argument back after the launch. | Hold any privilege afterwards: no constructor stores `msg.sender`. |
| T10 | Keepers: whoever calls `request`, `print`, `drip`, `fundFeeds`, `abandon` | Liveness only. | With no keeper nothing moves and nothing is lost: feeds go stale, the stream waits, feed budget is released to stakers after 14 to 28 days. | |
| T11 | OpenZeppelin Contracts 5.5.0 (vendored in `lib/`), solc 0.8.26, and the EIP-2935 history contract that `Blockhash` reads for a block hash older than 256 blocks | Correctness of the library code and the compiler. | | |
| T12 | The oracle's rule for computing `questionHash` | Staying as it is. `Questions` rebuilds the hash on chain from a rule we reconstructed from 23 attested requests (`docs/DEVIATIONS.md`, D6). | If the rule changes, every feed that pins its hash, the three house feeds included, refuses every answer from then on. Rounds fail and back off; meters stay redeemable. | |

The oracle signer and the Intake are constructor arguments and cannot be replaced. That is a
deliberate departure from IdentityMD's guidance; `docs/DEVIATIONS.md` gives the reasoning and the
cost. `Intake.signer()` is a different key (it signs price quotes) and is not used.

If the oracle signer's account ever gets code (an EIP-7702 delegation, for example), signatures are
checked by asking that code (ERC-1271), plain signatures stop verifying, and every round fails until
the contracts are launched again. Meters stay redeemable throughout.

## 3. Limits of Questions

**Q1. A request is paid for whether or not it is answered.** The Intake never refunds. A refused
body, a panel that does not agree, a request the service never serves: each costs the meter the
price (0.5 IMD today). The keeper tip does come back to the meter (`test_tip_goesBackToTheMeterWhenTheRoundFails`).

**Q2. A caller can make a round go unserved, at its own expense.** The service serves only the
first Intake request of a transaction. `request` refuses a second request of its own in one
transaction (`test_blocked_secondRequestInOneTransaction_unmodifiedContract`), but it cannot see a
request its caller bought from the Intake earlier in the same transaction. The feed's request is
then paid for and never served: the meter loses the price, the round stays pending until it is
closed (six hours later unless the Intake completes it sooner), and the cadence doubles. A caller
that wins the first request at every due block five times running keeps a daily feed silent for
about two months (requests at cadence 0, 2, 6, 14 and 30, the next one allowed at 62). It pays five
Intake prices of its own for that and earns nothing: since decision 1 of the brief's section 12 the
tip is earned only by an answer (`test_request_afterTheCallersOwnIntakeRequest_isNeverServedAndEarnsTheCallerNothing`).
Nothing on chain tells such a transaction from an honest one without `tx.origin`, which we do not
use, so this is disclosed and not prevented. What limits it: for a feed open to `submit`, anyone can
answer the round two hours after the request by buying the same question for this contract, which
leaves the cadence as it was (`test_request_anUnservedRoundCanBeAnsweredThroughSubmit`).

**Q3. `submit` takes any signed answer to the feed's question about the round's blocks.** Nothing
on chain ties an attestation to the request a round paid for. Once `submit` is open (the Intake has
completed the round's own request with nothing stored, or two hours have passed since the request),
any attestation the oracle signed for this contract, for the same question hash and window, from a
panel at least as large as the feed's, is accepted, whoever bought it. For chain evidence with the
recipe pinned in the definitions, as in the three house feeds, there is one answer whoever asks. A
chain-evidence feed that leaves the recipe to the panel can be answered differently by two panels,
and a party with an interest could buy several answers and hand in the one it prefers: nothing of
value should depend on such a feed. A feed whose question a panel judges cannot use `submit` at all
(`test_submit_isNotForAQuestionAPanelJudges`). The question hash does not cover `guards`,
`toleranceBps`, `allowAmbiguous`, `validForSeconds` or `consumer`: those are the submitted
request's own.

**Q4. The tip of a submitted answer goes to whoever submits it.** That can be a different account
from the keeper that opened the round, including one that copied the attestation from a pending
transaction (`test_tip_goesToWhoeverHandsTheAnswerIn`). The feed gets its answer either way.

**Q5. A returned tip is shared by whoever holds the meter's shares when the round is closed.** It
comes back as balance and no share is minted, so every share is worth a little more afterwards. An
account that funds a meter while a round is pending and takes its money out after the round has
failed therefore receives part of a tip that earlier funders paid for
(`test_returnedTip_aFunderThatArrivesWhileTheRoundIsPendingSharesIt`). It does not need to wait: a
round that is about to be closed is visible to everyone (the thirty-minute wait after a refused
request, the sixth hour of a silent one), and funding, `abandon` and `defund` fit in one
transaction. With a deposit much larger than the meter it collects nearly the whole tip. The amount
is bounded by the feed's tip for each failed round, 0.05 IMD on the house feeds, and it needs a
round that fails; making one fail costs more than the tip (Q2). We did not close this: every way we
found either stops funding while a round is pending or leaves value on the meter that nobody can
withdraw, and `Questions` has no room left for more code (section 7).

**Q6. In two rare cases part of a returned tip belongs to nobody.** A share must never be worth
more than one wei. When the shares outstanding cannot take all of a returned tip (every funder left
while the round was pending, or the meter was spent to zero and refilled), the rest stays on the
meter, pays for later requests of the same feed, and can be withdrawn by nobody
(`test_returnedTip_withEveryFunderGone_belongsToNobody`, `test_returnedTip_afterTheMeterWasRefilledFromZero`).

**Q7. Failed rounds back the feed off.** After each failed round in a row the feed waits twice as
long before it may ask again, up to 32 times its cadence: about a month for a daily feed, about 31
weeks for the weekly one. One answer resets it (`test_blocked_backsOffAfterFailedRounds`). The rule
and its numbers are fixed at launch.

**Q8. Anyone may close a round six hours after its request.** An answer that arrives later than
that finds the round closed and is refused (`test_callback_afterAbandon_reverts`); the meter has
paid for it.

**Q9. A WHEN gate is read once, inside the transaction that asks.** A gate on a value that can be
moved and moved back within one transaction (a pool balance, a spot price) can be opened by the
caller at will. The three house feeds have no gate.

**Q10. One attestation can answer one round of each of two feeds** that hold the same question and
ask about the same blocks. Each feed paid for a request of its own, and what one does with an
answer never takes it away from the other (`test_anAnswerUsedOnATwinStillReachesTheFeedThatPaidForIt`).

**Q11. A feed can be created to waste its funders' IMD.** `createFeed` checks what can be checked
(panel, quorum, window, lag, tip at most `maxPrice`, the body's shape and length). It cannot check
that a question is answerable. Fund only a feed whose parameters and text you have read. Payroll
funds the three ids in its constructor and no others.

**Q12. IMD sent to `Questions` by plain transfer is not on any meter** and can be withdrawn by
nobody. There is no sweep on purpose: crediting it to a meter would let a sender change what a
share is worth.

**Q13. An old catch-up window's closing block hash is not checked.** When a window ends more than
8,191 blocks back, the chain no longer serves its hash, zero is stored, and the answer's
`blockHash` is accepted as signed. A daily house feed reaches that only when its last answered
window ended more than 29,791 blocks, a little over four days, before the request (the window is
cut at 21,600 blocks and its end is then more than 8,191 blocks back). The weekly feed always asks
about the newest blocks and never does.

**Q14. What is asked after a failed round depends on the feed.** A feed whose windows tile and
that already has an answer starts its next window at the same block and ends it at a newer one, so
no block is skipped. A tiling feed with no answer yet, and any feed that does not tile, asks about
the newest blocks; the failed round's own blocks are not asked about again
(`test_windows_contiguous_afterAFailedRound_startAtTheSameBlock`).

**Q15. Smaller points.** `costOf` is zero while no request can be bought (unknown feed, action not
sold, price unreadable or above the feed's cap). A feed can only be about the chain it is on. A
chain-evidence question whose definitions hold the exact text `"evidence":"panel"` is treated as
judged by a panel and loses `submit`. A list answer is stored as its hash; the list itself is
published by anyone who has it, through `reveal` or `JobsReport.crown`. An answer is valid for the
time its feed states (one day on the house feeds) and is refused after that.

## 4. Limits of the three house feeds

**F1. Not yet accepted by the live oracle.** No request with any of the three bodies has been
bought. The protocol's free check returned no blocker for the three questions on 11 October, but it
does not exercise the pinned recipe. `docs/LAUNCH.md`, section 5, is the proof to obtain before
launch, with its go and no-go conditions. Each refused request costs 0.5 IMD.

**F2. Hires counts transfers, not purchases.** It counts every IMD `Transfer` log whose recipient
is the fee payee, transfers of zero included, because a `log-count` filter reaches indexed
arguments only. Anyone can raise the day's figure for the price of gas. The fixture states this in
its title and limits (`test_hiresSaysItCountsZeroValueTransfers`), and any unofficial tally must
count the same way.

**F3. Payrolls and the ranking count every transfer to the fee payee**, whatever it paid for,
including this launch's own purchases of answers: `Questions` pays the fee payee for every request,
so it is itself one of the senders the ranking sees. An address can buy a place among the Employers
of the Week by paying the fee payee, and a sender of a zero-value transfer can appear when fewer
than three addresses paid in the week.

**F4. The employers feed is the least certain.** Its recipe (a ranking with a filter) has no
attested example with a filter. Nothing depends on it: `JobsReport.print` never reads it
(`test_print_neverReadsTheEmployersFeed`, `test_integration_theReportIsCompleteWithoutTheEmployersFeed`),
and Payroll funds it last, to a runway of four requests.

**F5. Their parameters are part of their ids**, and the ids are constructor arguments of
`JobsReport` and `Payroll`. A feed whose body the oracle later stops accepting cannot be replaced
without launching the three contracts again.

## 5. Limits of Payroll

**P1. A claim pays whoever holds the seat at that moment, and anyone may trigger it.** While a seat
sits in another contract (an escrow, a marketplace, a loan, even for one transaction), its accrued
share and the tips of agents bound to it can be paid to that contract
(`test_claimSeat_paysWhateverHoldsTheSeatAtThatMoment`). Claim before moving a seat.

**P2. The stakers' stream is only as even as its callers make it.** One `drip` sends at most one
hour of stream and drips are at least ten minutes apart. After days without a call the vested
backlog leaves in capped calls, up to six hours of stream an hour, and an account that stakes in
sIMD for those hours collects a full staker's share of them. Somebody dripping about once an hour
keeps the flow even (`test_shortVisitCollectsAtMostItsShareOfOneDrip`). The drip rule is kept as
built by decision 3.

**P3. Bookings neither slow nor rush the stream.** On each booking the stream's new end is the
average of the time the unvested money had left and seven days, weighted by the two amounts
(decision 2). A booking of dust moves the end by nothing; a large one takes about seven days
(`test_booking_ofDustDoesNotMoveTheEnd`, `test_booking_hourlyDustDoesNotStretchTheStream`,
`testFuzz_booking_weightedEndIsBetweenTheTwoTimes`). Stakers are paid in full on that schedule.

**P4. Tips depend on the Adapter (T7).** Only the first 16 agent ids of a tip share it; an id
listed twice is credited twice; ids are not checked when the tip arrives. A tip whose agent is
unbound, bound to something that is not a seat, or bound to a seat with no readable owner waits 180
to 360 days and can then be moved to the seat pool by anyone
(`test_sweepTip_aTipWaitsBetween180And360Days`). A later tip never delays an earlier one
(`test_sweepTip_oneWeiTipsCannotHoldOlderTipsOutOfTheSeatPool`). The binding is read once, when
`sweepTip` is called: an agent bound to an owned seat at that moment keeps its tip, whatever came
before. `claimTip` and `sweepTip` revert `GasTooLow` when the transaction carries too little gas to
read the Adapter or the seat token reliably, so a caller cannot make a bound agent look unbound, or
an owned seat look ownerless, by starving the read (`testFuzz_sweepTip_lowGasNeverSweepsABoundAgent`,
`testFuzz_sweepTip_lowGasNeverMakesAnOwnedSeatLookOwnerless`).

**P5. A seat nobody owns keeps its share.** If the seat token never names an owner for a seat
again, that seat's share of the seat pool stays in Payroll for good. Tips bound to such a seat are
different: they can be swept after their wait. A seat held by Payroll itself is paid like any
other; the IMD arrives back in Payroll and is booked again as revenue
(`test_seatOwnedByPayrollRecyclesItsShare`).

**P6. Payroll never takes IMD back from a meter.** What it places on a house feed's meter is spent
by that feed or stays there. The most that can sit on a meter that has stopped being used is one
runway: 14 requests for each daily feed and 4 for the weekly one, each counted at no more than 2
IMD. At the live cost of 0.55 IMD that is 7.7, 7.7 and 2.2 IMD. Payroll is a funder like any other
on those meters, so Q5 applies to it: a returned tip on a house meter is shared with whoever else
holds shares of it at that moment. A stranger can also fill a house meter and empty it again;
Payroll counts what others put there (`test_fundFeeds_countsWhatOthersAlreadyPutOnAMeter`) and tops
the meter up again at the next `fundFeeds` call, which anyone can make.

**P7. Feed budget waits, then goes to stakers.** Budget no meter needs within 14 to 28 days is
released to the staker stream (`test_budget_isKeptThroughOneBoundaryAndReleasedAtTheNext`).

**P8. A tip that falls back to a plain transfer is booked as revenue.** A caller that cannot
complete `tip` and transfers the IMD plainly has it split 50/30/20 by `book`, not held for the
agents. `tip` to 16 agents never seen before stays under 600,000 gas, and the dearest `tip` and
`pay` under the 1,000,000 the hire desk forwards (`test_gas_tipToSixteenNewAgents`,
`test_gas_tipToSixteenAgentsWhoseEarlierTipsMustBeAged`).

**P9. `claimSeats` takes at most 200 ids.** A full list of seats never paid before used about
47,600 gas a seat on a mainnet fork, 9.5 million for 200, inside the 16.7 million one transaction
may use.

## 6. Limits of JobsReport

**J1. It reports what the oracle answered.** It adds no check of its own on the figures beyond
passing over failed rounds, empty or unfinished windows, overlapping windows and answers above
2^128 − 1.

**J2. A count may cover a shifted window.** The two daily feeds are bought by separate
transactions. When they are requested in the same block the count is exact for its print's period.
When they have drifted, a count is attached to the print it shares more than half of the longer
window with; the print keeps the hires round and the count keeps its own window, so a reader can
show the exact blocks (`test_counts_aFeedThatDriftedStillPairsEveryDay`,
`test_integration_theHiresCountSurvivesOneLateRequest`). A count that pairs with no print stays in
its own series and in `totalCount`.

**J3. The streak ends on a catch-up.** A print over more than 7,500 blocks, which is what a missed
day produces, cannot take the best-day record and ends the streak
(`test_integration_theStreakEndsAfterAMissedDay`).

**J4. The crown is decoration.** Anyone holding the attested list may publish a round's top three,
once per round, in any order of rounds. Nothing else in the report depends on it.

## 7. Limits of the build

**B1. `Questions` is 22,986 bytes: 14 under our own 23,000-byte gate and 1,590 under the protocol's
limit.** Nothing can be added to it. That is why Q5 is disclosed and not closed.

**B2. The launch is 11.06 million gas in our rehearsal**, against our gate of 12 million and the
protocol's ceiling of 16.7 million (`test_fork_rehearsal_launchFitsOurGasAndSizeGates`).

**B3. Nothing is called after deployment.** The three feeds exist only after three transactions
that anyone may send; `docs/LAUNCH.md` holds their calldata. Until then meters cannot be funded and
Payroll's feed budget ages toward stakers.

**B4. Some tests use `QuestionsRig`**, which is `Questions` itself with six added functions that
write its storage directly, so that Payroll and JobsReport can be shown round shapes the real
contract never produces. No function of `Questions` is overridden. The tests under
`test/payroll/integration`, `test/launch` and every `fork` folder do not use the rig: they use
`Questions` as it is launched, or `QuestionsHarness`, which adds one function that clears the
one-request-per-transaction flag (a test function can run as a single transaction) and two
read-only views. The callback gas tests, the launch tests and the fork rehearsal use the contract
with nothing added. One test puts another contract in the place of `Questions`
(`test_fundFeeds_revertsIfATopUpTakesMoreThanItWasOffered`): it takes more IMD than `fund` was
told, which the real contract cannot do, and is the only way to reach Payroll's `FeedOverdrawn`.

## 8. Static analysis

Command: `slither . --filter-paths "lib|test"` (Slither 0.11.4), run on 12 October 2026.
Result: 42 findings. None is of high or medium impact. 19 are of low impact, all from one detector;
23 are informational.

### The 19 low findings: `timestamp`

Slither reports every comparison that involves `block.timestamp` or a value derived from it. On
Ethereum a block's timestamp is fixed by its slot, so a proposer cannot move it by more than
skipping a slot; and every period compared here is between ten minutes and 360 days long.

| Function | What is compared | Why it is safe |
|---|---|---|
| `Payroll.drip`, `Payroll.stream` | now against the last drip plus ten minutes | A ten-minute gap. |
| `Payroll._unvestedNow` | now against the stream's end | A stream that runs for up to seven days. |
| `Payroll._ageFeedBudget`, `Payroll.feedBudget` | the number of the current 14-day period against the stored one | Counters of fortnights. |
| `Payroll._creditTip`, `Payroll._agedTip` | the number of the current 180-day period against a tip's | Counters of 180-day periods. |
| `Questions._submitOpen`, `Questions.canSubmit` | now against the request time plus two hours | A two-hour wait. |
| `Questions._abandonStep`, `Questions.abandon` | now against the request time plus six hours, or the recorded completion plus thirty minutes | Waits of half an hour and six hours. |
| `Payroll.book`, `Payroll.claimTip`, `Payroll.sweepTip`, `Payroll._book`, `Payroll._creditSeatPool`, `Payroll._nextRipeAt`, `Payroll._levelStream`, and the `unvested == 0` test in `Payroll._unvestedNow` and the `sent == 0` test in `Payroll.drip` | an amount against zero | No time is compared. The amount was computed in a function that also reads the time, which is what the detector follows. |
| `JobsReport.crown` | a stored crowning time against zero | "Has this round been crowned": no time is compared with another. |

### The 23 informational findings

- `assembly` (4): `Questions._readWord` and `Payroll._readWord` are bounded static calls that copy
  exactly one word of whatever is returned; `Payroll._bindingOf` is the same for the Adapter's three
  words; `QuestionBody.holdsPanelEvidence` searches calldata a word at a time, which costs a fifth
  of the plain loop and is fuzzed against it.
- `low-level-calls` (1): `Payroll._fund` calls `Questions.fund` at low level so that a revert in
  `Questions` cannot block the rest of Payroll.
- `cyclomatic-complexity` (1): `Questions._settle` is the list of checks an answer must pass, one
  after another.
- `naming-convention` (16): immutables are written in upper case, and `IIntake.MAX_BODY_BYTES`
  carries the Intake's own name.
- `too-many-digits` (1): `Mainnet.ORACLE_ACTION` is the text `oracle.request@oracle-1` as a
  `bytes32`.

### What is silenced in the source, and why

In eleven places `src/` carries a comment that tells Slither not to report a finding. Each is listed
here so that a reader does not have to search for them.

| Where | Detector | Reason |
|---|---|---|
| `Questions` and `Payroll`, whole contract | `incorrect-equality` | Every `==` compares an amount, a balance difference or a stored time with zero, two period counters, or two values of an enum. None compares a token balance with a figure a sender could push off by one wei. |
| `Questions.request` | `reentrancy-no-eth`, `reentrancy-benign` | The Intake's request id is known only after the call, so two writes follow it. Every state-changing entry point holds the same transient lock (`test_request_cannotBeReentered`). |
| `Payroll.fundFeeds` | `reentrancy-no-eth`, `reentrancy-benign` | The books are written before each call into `Questions` as if the whole offer had left; what follows the calls is the correction when less left, and the ageing step, which runs last on purpose. Same lock (`test_callBackDuringATopUp_isRefused`, `test_fundFeeds_theBalanceCoversWhatIsOwedInTheMiddleOfATopUp`). |
| `Payroll._fund` | `reentrancy-no-eth` | The correction named in the row above. |
| `Questions.usedBy` | `uninitialized-state` | It is written in `_settle` through a storage reference. (Slither 0.11.4 does not report it even without the comment.) |
| `Payroll.tip` | `divide-before-multiply` | `got − (got / n) × n` is the remainder of the equal split, on purpose: it joins the seat pool. |
| `Payroll._creditSeatPool` | `weak-prng` | `sum % SEAT_COUNT` is the remainder carried to the next credit, not a source of chance. |
| `JobsReport._readPayrolls`, `JobsReport._readHires` | `calls-loop`, `unused-return` | One read of this launch's own `Questions` per round, at most eight a call; the time an answer was stored is not part of a print. |
| `JobsReport.crown` | `unused-return` | The same unused value. |

We also ran Slither on a copy of `src/` with these comments removed (outside the repository, 12
October 2026). It then reports 76 findings: the 42 above and 34 more, which are exactly the ones the
table covers. One of high impact: `weak-prng` in `Payroll._creditSeatPool`. Twenty-nine of medium
impact: 21 `incorrect-equality`, 4 `reentrancy-no-eth` (`Questions.request`, `Payroll.fundFeeds`
twice, `Payroll._fund`), 3 `unused-return` (the three reads in `JobsReport`), 1
`divide-before-multiply` (`Payroll.tip`). Four of low impact: 2 `calls-loop` and 2
`reentrancy-benign`. A reader who does not accept a reason in the table should treat the matching
finding as open.

## 9. What is not verified

- **The three house bodies against the live oracle.** See F1 and `docs/LAUNCH.md`, section 5.
- **A real answer delivered to the launched contracts.** Tests deliver answers signed by a test key,
  and verify 23 real attestations against a copy of the contract placed at the address each was
  signed for (`test/questions/RealAttestations.t.sol`). No real answer has been delivered to these
  feeds, because none of them has been asked.
- **The launch pipeline itself.** The factory call is rehearsed on a fork as the launch deployer
  (`test/launch/fork/LaunchRehearsal.fork.t.sol`). The pipeline's own checks before that call are
  not ours to run.
- **Whether a recipe filter on `Transfer`'s indexed `to` behaves like the attested filters on
  `from`**, whether log scans over 7,000 to 50,400 Ethereum blocks are reliable, and whether `head`
  is still part of the hashed question for a list answer, as it was in the five attested list
  requests we hold. The proof requests answer all three.
- **Whether the service ever completes a request it did not serve** (one that was not the first of
  its transaction). The contract handles both cases: `submit` opens at once if it does, two hours
  after the request if it does not.
- **`crown` on a real list of three.** The one real attested address list we hold has a single
  entry (`test_crown_readsARealAttestedList`). Lists of three are tested with lists we encoded
  ourselves.
- **No third-party audit.** Two internal reviews per contract, their findings fixed or listed
  above, and the checks in this repository.
- **Gas figures** are from tests and from a mainnet fork, not from mainnet transactions.
