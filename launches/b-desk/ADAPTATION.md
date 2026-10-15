# Adaptation for launch B (contracts only, Ethereum mainnet)

This file records what was changed to make the repository launchable through IdentityMD's
`evm_contracts` factory, and why. The short answer: **no contract code, test configuration or
build configuration was changed.** The project arrived already in the form the launch requires,
and the checks below confirm it. The first round added only this file. The revision after the
independent review (section 5) corrected comments and documents that claimed more than the code
gives, and added two tests; the compiled bytecode of all four contracts is the same as before.

## 1. What the launch requires, and where the code already meets it

| Launch rule | Where the project meets it | Checked by |
|---|---|---|
| Each contract is fully configured in a nonpayable constructor taking only static words (address, uintN, bool, bytes32), at most 16 of them | `WorkProof(address)`, `WorkOrders(address,address,address)`, `CrowdPots(address,address)`, `Doorbell(address,address,bytes32,uint96,uint96,uint96,uint32,bool)` | `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes` (walks each constructor's ABI inputs) |
| A constructor runs on an empty chain: no external call, no code-size check | Every constructor stores its arguments and refuses only the zero address or an out-of-range value; `Doorbell` checks its bond and delivery time against constants, not against the desk | `test_launch_constructorsMakeNoCallAndNoCodeCheck` (walks constructor bytecode for CALL, STATICCALL, DELEGATECALL, CALLCODE, EXTCODE*, BALANCE, CREATE, CREATE2, SELFDESTRUCT); `test_launch_deploysInManifestOrderOnAnEmptyChain` (asserts the three mainnet dependencies have no code, then deploys in manifest order) |
| No owner, admin or setter; `$owner` is never an argument; `msg.sender` (the factory) and `tx.origin` are never stored | No contract has an owner. No constructor reads `msg.sender` or `tx.origin` | `test_manifest_namesTheFourContractsInOrder` (the manifest holds no `$owner` and no `$token`); `test_launch_noFunctionNamesAnOwnerOrAPowerToChange` |
| No minting, pausing, freezing, blacklisting, seizing, proxy, initializer or upgrade path | None exists. The 28 state-changing functions are the ones `README.md` lists and no others; no contract can receive ETH | `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes` |
| No DELEGATECALL, CALLCODE or SELFDESTRUCT in runtime bytecode | None | `test_launch_runtimeBytecodeHasNoForbiddenOpcode`, `test_bytecodeWalk_findsWhatItLooksForAndSkipsPushData`; reproduced independently with the protected harness (section 3) |
| Nothing is called after deployment | Nothing needs to be: no initializer, no configuration. Orders, pots and rings start from zero | `test_launch_deploysInManifestOrderOnAnEmptyChain` |
| Every library function the contracts call is internal (no unlinked bytecode) | `SpecText`, `OrderHeader` and `JsonScan` have only internal functions; the four build artifacts have empty `linkReferences` | `forge build` output; the protected harness deploys the bytecode as built |
| Contracts-only launch: no `LaunchToken`, no `MerkleDistributor`, no pool; no `launch.json` in the tree | None of these exists. The manifest is in `docs/LAUNCH.md` for the manifest step to write | `test_manifest_*` |
| Runtime at most 24,576 bytes, initcode at most 49,152 | 4,579 / 19,289 / 14,177 / 5,972 runtime; 4,744 / 19,726 / 14,646 / 7,032 initcode with arguments | `test_launch_fitsOurSizeAndGasGates`; `forge build --sizes` |
| Build configuration | `foundry.toml` already has solc 0.8.26, cancun, optimizer 200 runs, `via_ir`, `bytecode_hash = "none"`, `cbor_metadata = false`. It was not touched | `forge build` |

The manifest the brief gives matches `docs/LAUNCH.md` word for word and is what the tests check
against the code: `test_manifest_everyArgumentIsWhatTheCodeExpects`,
`test_manifest_theDoorbellsValuesAreTheOnesTheDocumentExplains`,
`test_manifest_theDoorbellsKindIsTheTextTheDocumentNames`,
`test_manifest_payrollIsTheFirstLaunchsLiveAddress`.

## 2. The imported audit: what reproduced, what was done

The audit reported four entries, all at level **info**, and stated of each that it is a documented
trust assumption or a coverage note, not a code defect against the stated design. Each was
reproduced against the unchanged code before deciding. **None required a change**: fixing any of
the three behavioural entries would replace a rule the requester chose and documented, which the
launch rules do not ask for and the brief forbids ("deploy this repository as it is").

### c309d5e6 (coverage, no defect)

Confirmed. `forge build` and the full `forge test` suite pass (654 tests, 30 suites, invariant
suites included, with an empty environment and no network). The bytecode scan, the constructor
ABI shapes, the nonpayable constructors and the absence of launch-forbidden features were all
re-checked by the tests named in section 1 and by the rehearsal in section 3. No change.

### 46190b9b: with `allowClaimed = 1`, a Doorbell order can be paid on an unchallenged false claim

**Reproduced** step by step with the manifest's exact Doorbell values on the real desk: one IMD
transferred to the Doorbell, one address with 0.25 IMD rings 25 times, claims, registers a
fabricated job id, claims delivery with an arbitrary hash, and after 24 hours anyone finalizes.
The address ends with 1.15 IMD (0.9 runner pay plus its 0.25 bond), Payroll receives 0.1 IMD, the
Doorbell receives nothing back, and the order is delivered but unproven.

**Not changed.** This is the behaviour the requester asks for: the value `1` is a launch-day
decision explained in `docs/LAUNCH.md` section 5 (receipts stalled since about 8 October 2026),
stated at the head of `src/pots/Doorbell.sol`, and mitigated operationally by the watcher that
section 6, point 4 of `docs/LAUNCH.md` requires before the Doorbell is funded. The same scenario
is pinned by the existing tests `test_claimsOn_theOrderAcceptsAnUnchallengedDeliveryClaim`
(`test/pots/Doorbell.t.sol`) and `test_runbook_theFirstPot_anUntrueClaimIsStoppedByAChallenge`
(`test/launch/LaunchRunbook.t.sol`). Setting the argument to `0` is the requester's call on the
day, not an adaptation; the manifest step is told the same value.

### be85d51c: `CrowdPots` never calls `finalize`, so an unchallenged claim leaves a pot Hiring

**Reproduced**: a pot with the claimed path on, launched, taken, registered and claimed delivered;
after 25 hours and again 30 days later `claimRefund` reverts `WrongStage(Hiring)`, `stageOf`
reads `Hiring` and `reconcile` makes no desk call; after any address calls
`WorkOrders.finalize(orderId)`, `reconcile` moves the pot to `Delivered` and `claimRefund` pays.

**Not changed.** The contract header (`src/pots/CrowdPots.sol`, "The one call they do not make is
`finalize`") and the `reconcile` notes document this as a design choice, and the existing test
`test_reconcile_leavesAnUnchallengedClaimToTheRunner` (`test/pots/CrowdPots.t.sol`) pins it.
Having `reconcile` call `finalize` would add the two Payroll calls and the callback to every
reconcile of such a pot (about 2.15 million gas of required allowance) and would make a
contributor's refund call pay the runner, which is a change of the product's rules rather than a
launch requirement. Contributors lose nothing to it: the runner is paid either way, and
`finalize` is open to anyone. Left for the requester to decide after launch review.

### 157f2546: a minimum bond holds a receipt-only pot's escrow for its whole delivery time

**Reproduced**: a pot of 1,000 IMD with the desk's minimum bond (0.25 IMD), 30 days of delivery
and 30 days of hiring, receipt-only; an address with 0.25 IMD claims and registers a job id that
has no receipt. For the 30 days `reconcile` returns `Hiring`, `claimRefund` reverts
`WrongStage(Hiring)` and `reportFailed` reverts `NoReceipt`. At the deadline `reconcile` has the
desk time the claim out; the pot is refundable for 1,000.25 IMD (target plus the forfeited bond).

**Not changed.** The bond and the delivery time are the opener's choices, published in `Terms`
before anyone chips in and bounded by the contract (bond at least the desk's minimum, delivery at
most 30 days). The `Terms` documentation states the trade-off, `docs/THREATS.md` L6 and C3 state
it, and the existing tests `test_provenPath_theSameStallCostsTheWholeBond_andTheOrderReopens` and
`test_claimedPath_anUndecidedDisputeEndsThePotEarly_forATenthOfTheBond` pin the cost. Raising the
minimum bond or shortening the maximum delivery would change what every pot and every order may
ask for, which is not a launch requirement.

## 3. Checks run for this adaptation

- `forge build --sizes` with the project's own `foundry.toml`: builds; sizes as in section 1.
- `forge test` (default profile, no network, empty environment): 654 passed, 0 failed.
- The launch kind's protected harness (`Contracts.protected.t.sol`) was run in `test/scratch/`
  with chain id 1, the real ProjectFactory address etched with the probe, and the four initcodes
  built from the manifest's arguments with `$contract:` references resolved to the CREATE2
  addresses predicted for each earlier contract. All four deployed at their predicted addresses
  and the runtime scan found no DELEGATECALL, CALLCODE or SELFDESTRUCT.
- The three audit reproductions above were run in `test/scratch/` against the launch's real
  `WorkOrders`, `CrowdPots` and `Doorbell`. `test/scratch/` is scaffolding and is not part of the
  submission; the permanent tests that pin the same behaviour are named beside each finding.
- The fork suite (`FOUNDRY_PROFILE=fork`) was not run: it needs a mainnet RPC, and the launch's
  verification runs without network.

## 4. Open items for the launch, none of which needs a code change

- The Doorbell's last argument (`allowClaimed`) is `1` in the manifest. It is permanent once
  deployed. `docs/LAUNCH.md` section 5 gives the command that decides it on launch day.
- The three mainnet addresses (IMD, WorkRegistry, Payroll of launch 1531) are the requester's
  values from `docs/LAUNCH.md` and `src/interfaces/external/Mainnet.sol`. They were not re-read
  from the chain here; section 6 of `docs/LAUNCH.md` says how the requester checked Payroll.
- The rule the requester asked to keep (anyone may call `claimRefund` and `claimRefunds` for any
  contributor, contracts included) is kept as it is. `docs/DEVIATIONS.md` D7 gives the reasoning.

## 5. Revision after the independent review (13 October 2026)

An independent reviewer reopened the accepted work with one medium finding and two advisory
notes. Each was reproduced against the tree before anything was decided. The answers are in
`.imd-responses.json`; this section records what changed and why.

### a96c4f58 (medium): the `SwarmFailed` and wrong-kind endings of `reportFailed` return the whole bond and bar nobody, so a receipt-only pot can be held past its hire window and refunded with nothing forfeited

**Reproduced**, both cases, on the real desk, real `WorkProof` and real `CrowdPots` with the
reviewer's exact terms (target 10 IMD and 3 wei, bond 1 IMD, delivery 3 days, hiring 30 days,
receipt-only). Case 1: a runner takes the order two days before its expiry, registers a job, and
the registry's receipt for it says `blocked` with the order's own objective; a contributor's
`reportFailed` reverts `NotRunner`; after the expiry the runner's `reportFailed` leaves the order
`Refunded`, the runner's balance where it started, `accountOf.returned` at exactly the escrow and
the pot `Refundable`. Case 2: three rounds of claim, register, `completed` receipt of another
kind, `reportFailed` by a contributor; after each round the order is `Open`, the runner's balance
is unchanged, `barred` is false, `returned` stays zero and the same address claims again at once.

**What was done: the words were corrected, not the desk.** The reviewer offered two resolutions
and said the choice is the authors'. The desk's rule is deliberate and documented three times
over: in the note on `reportFailed` (`src/desk/WorkOrders.sol`, "taking its bond for the swarm's
failure would make honest runners avoid the desk"), in `docs/THREATS.md` W2 and W3, and in the
existing tests `test_reportFailed_anotherKindFreesTheOrderForAnyoneAndReturnsTheBond` and the
`SwarmFailed` cases of `test/desk/WorkOrders.settle.t.sol`, one of which already pins the
`Refunded` ending with the bond returned whole. The brief says to deploy the repository as it is,
and `docs/THREATS.md` section 11 records the requester's own handling of the same class of
finding in the first launch's audits (1.3 and 2.3, "the documents claimed more than the code
gives"): corrected in words, not in code. Charging the release share or barring the runner on
those endings would be a change to the product's economics that the launch rules do not ask for,
and this adaptation does not make it. What was wrong was what `CrowdPots` told contributors the
bond sizes.

Changed, all comments and documents, with the compiled bytecode of all four contracts unchanged
(verified: the `bytecode` and `deployedBytecode` of each artifact hash the same before and after;
the build has `bytecode_hash = "none"` and `cbor_metadata = false`, so comments cannot reach it):

| File | What | Why |
|---|---|---|
| `src/pots/CrowdPots.sol`, contract notes ("The size of the bond next to the target") | "The bond is all a runner loses by taking the order and not delivering" became: the most it loses, lost whole by silence, and not lost at all when the job's receipt shows the swarm did not complete it or ran it under another kind, which can end a pot past its hire window for the price of one swarm job | The sentence claimed what the desk does not do |
| `src/pots/CrowdPots.sol`, `Terms.bond` | Added when the bond is forfeited (timeout, wrong job, contradicted claim) and when it comes back whole (W2, W3) | "forfeited ... if the runner lets the order time out" left out the receipt endings |
| `src/pots/CrowdPots.sol`, `Terms.allowClaimed` | "On a receipt-only pot the same stall costs the whole bond" became "the same stall by silence", with the receipt ending and its effect on a pot after the hire window added | Same |
| `docs/THREATS.md` W2 | Added that the runner is not barred and can take the order again at once, with the new test named | Reviewer's case 2 |
| `docs/THREATS.md` W3 | Added that the report can land after the order's expiry and then refunds it, what that means for a pot, and why neither ending charges the release share | Reviewer's case 1 |
| `docs/THREATS.md` W5 | Added the exception to "it costs the runner its bond" | Was stated without the exception |
| `docs/THREATS.md` C2 | A new paragraph: a receipt-only pot can be ended in a refund with no bond forfeited, how, what it costs each side, and what the bond does and does not size; both new tests named | The reviewer's finding, stated as a limit of the pot |
| `docs/LAUNCH.md`, section "If something goes wrong", row "writes another kind" | "runners lose the swarm's fee and their bonds" now distinguishes a receipt without the header (bond to the employer) from one with the header under another kind (bond back to the runner) | The same overstatement in one more place |
| `test/pots/PotsRealDesk.t.sol` | Two tests: `test_realDesk_aFailedJobsReceiptPastTheHireWindow_refundsThePotWithTheBondReturned` and `test_realDesk_aWrongKindReceipt_reopensWithTheBondReturned_andTheSameRunnerMayTakeItAgain`, the reviewer's two cases on the real desk, asserting the state, the balances, `barred`, `accountOf.returned`, the pot's stage and (case 1) that the contributors' refunds are exactly their chips | Every corrected sentence is now tied to a test; if the desk's rule is ever changed, these say what moved |

### bff72b72 (info): with `ALLOW_CLAIMED = 1` and no arbiter, each Doorbell escrow is paid to an unchallenged bonded claim, and a correct challenger's best outcome is its own bond back

**Reproduced by trace** at the manifest's values and agreed with the reviewer's figures: an
undefended false claim costs the Doorbell 1 IMD per order; a defended one costs the attacker
0.025 IMD and holds the defender's 0.25 IMD for seven days with no reward
(`timeout` on an undecided dispute pays the challenger exactly its bond). It is the same root
cause as the imported finding 46190b9b (section 2) and the reviewer says so: the requested
behaviour, stated in the Doorbell's own notes and in `docs/THREATS.md` D2, L2 and L6, with the
eighth constructor argument fixed by the brief. **Not changed.** Added to the open items below as
the one trust assumption the mainnet manifest turns on, with the float it implies.

### 2094daa9 (info): `chipInFor` accepts the desk, IMD, Payroll and WorkProof as beneficiary, and a refund claimed for such a chip is stranded

**Reproduced**: a chip for `address(WORK_ORDERS)` is accepted, and after the pot runs out
`claimRefund(potId, address(WORK_ORDERS))` moves the IMD into the desk, which only ever sends what
it booked for an order. **Not changed.** Only the payer's own IMD is at stake, by the payer's own
choice of beneficiary; `docs/DEVIATIONS.md` D7 and `docs/THREATS.md` C11 say so ("Whoever names a
beneficiary that cannot use IMD has given that IMD away"), and the brief asks that this rule be
left as it is. The reviewer calls it a note, not a defect. Refusing two of the four addresses
would be a partial rule (CrowdPots does not hold Payroll's or WorkProof's address), and a change
to the contract's code on a brief that asks for none.

### Checks run for the revision

- `forge build`: builds; `forge test` (default profile, no network, empty environment): 656
  passed, 0 failed, the two new tests included.
- Bytecode comparison: `out/*/*.json` `bytecode.object` and `deployedBytecode.object` of
  `WorkProof`, `WorkOrders`, `CrowdPots` and `Doorbell` hash the same at the accepted commit and
  after this revision.

### Open item added by the review

- The Doorbell with `allowClaimed = 1`: with balance B, anyone can open floor(B / 1 IMD) orders
  in one transaction, and each is paid to an unchallenged claim after 24 hours. Whoever funds it
  should size the watcher's float for the orders it means to defend (0.25 IMD held for up to seven
  days per challenge, no reward when nothing decides the dispute) and fund the Doorbell with small
  amounts, as `docs/LAUNCH.md` section 6 and `docs/THREATS.md` D1 already say.
