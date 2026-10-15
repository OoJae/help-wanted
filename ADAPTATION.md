# Adaptation for launch C (IdentityMD, Ethereum mainnet, contracts only)

This file lists every change made to the repository to make it launchable through IdentityMD's
`evm_contracts` factory, with the rule or audit finding that asked for it. Date: 15 October 2026.

## Summary

**No source file changed.** The three contracts (`Rules`, `Endowments`, `Zap`) already meet every
rule of the launch kind, and neither of the two audit findings on the imported code required a code
change. What was added is one test file that reproduces both findings, a few sentences in
`docs/THREATS.md` that say what the auditor showed the document left unsaid, and this file.

| Change | File | Why |
|---|---|---|
| Added two tests that reproduce the audit's findings | `test/endowments/Endowments.audit.t.sol` (new) | The launch asks that each reproduced finding be covered by a test. Both reproduce; see below. |
| E3: said that the external hold has no upper bound and reverts with the vault's error | `docs/THREATS.md`, E3 | Audit finding fb892c57. |
| E5: said that a meter endowment's yield has no exit while its feed is not sold, even after the last depositor leaves | `docs/THREATS.md`, E5 | Audit finding 04444071, which showed E5 and E12 said the yield "waits" without saying the wait may never end. |
| E12: named the two waits that have no bound inside the contract | `docs/THREATS.md`, E12 | Same finding. |
| Test count: 415 tests in 19 suites became 417 in 20 | `README.md`, "Building and testing" | The README states the count the default run gives; the new file adds two tests. |
| This file | `ADAPTATION.md` (new) | Required by the launch. |

Nothing in `src/`, `foundry.toml`, `remappings.txt`, `lib/`, `docs/LAUNCH.md` or `integration/`
changed. `launch.json` is not written here: the manifest step writes it from the block
in `docs/LAUNCH.md`, which `test/launch/LaunchC.t.sol` holds against the code.

## The launch rules, checked against the code

Every rule of the `evm_contracts` launch kind was read against the three contracts. Each holds as the
code arrived, and `forge test` proves each one (`test/launch/LaunchC.t.sol`):

- **Constructors.** All three are nonpayable, take only `address` arguments (2, 4 and 4, well under
  the 16 the manifest allows), store them, and make no external call and no code-size check, so they
  run on an empty chain (`test_launch_deploysInManifestOrderOnAnEmptyChain`,
  `test_launch_constructorsAreNonpayable`, `test_launch_constructorCodeHoldsNoCallAndNoCodeCheck`).
  Each refuses the zero address (`test_launch_aMissingAddressIsRefused`). Every argument is a literal
  mainnet address; there is no `$owner` and no `$contract:` reference, because no contract of this
  launch refers to another and none has an owner.
- **No owner, admin or setter.** No function names an owner or a power to change anything
  (`test_launch_noFunctionNamesAnOwnerOrAPowerToChange`,
  `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes`). Nothing assigns `msg.sender`
  or `tx.origin` any role, so neither the factory nor IMD's launch wallet can hold one.
- **No token.** Contracts-only launch; no ERC-20 was added and the project has none of its own.
- **Forbidden constructs.** No proxy, initializer, pause, mint, blacklist or seizure; the deployed
  runtimes hold no `DELEGATECALL`, `CALLCODE` or `SELFDESTRUCT` and each is under the EIP-170 size
  (`test_launch_noForbiddenInstructionInAnyDeployedRuntime`, `test_launch_sizeAndGasGates`).
- **ETH.** Deployment sends none. `Zap` has three payable functions because paying with ETH is what
  it is for, which the brief allows.
- **Libraries.** Every library the contracts use (OpenZeppelin `Math`, `SafeERC20`) is linked
  `internal`; nothing is left unlinked.
- **Build.** `foundry.toml` already sets solc 0.8.26, `cancun`, optimizer 200 runs, `via_ir`,
  `bytecode_hash = "none"` and `cbor_metadata = false`. Untouched.

## The audit's findings, reproduced

The audit of the imported code raised two low findings and one informational note. Each was
reproduced against the code before any decision, in the project's own mock vault
(`MockStakedIMD`, which follows the real sIMD's one-block hold) and mock Questions.

### fb892c57 (low): anyone can hold the vault every block for one wei

**Reproduces.** `test_audit_aStrangerCanHoldTheVaultEveryBlock_andOnlyTheInKindExitIsOpen` follows
the auditor's steps for five consecutive blocks: a stranger deposits one IMD-wei into sIMD in
Endowments' name; `vaultHold()` is true; `harvest` reverts `RedeemMoreThanMax` and `withdraw`
reverts `WithdrawMoreThanMax`, both the vault's errors; `exit` in kind works in each of those
blocks and hands over shares worth the principal; the first block without the deposit pays the
yield and the rest of the principal to the wei.

**Not changed, as the finding itself concludes.** The finding says "No code change is required":
the hold is sIMD's rule, and nothing inside Endowments can remove it. Its optional suggestion, to
read `SIMD.maxRedeem` before every vault call so that an external hold surfaces as `HoldActive`,
would add two external reads to every harvest and every vault withdrawal to change only the name of
an error that `docs/THREATS.md` E3, the README and two existing tests already document as the
vault's own. The requester asked for the code as it is, and the launch rules ask for the smallest
diff; a cosmetic change to an error path is neither. The trade-off is now stated in E3 with its
cost to the attacker and its bound (none), so the final panel weighs it knowingly, which is what the
finding asked for.

### 04444071 (low): a meter endowment's yield is stranded if Questions stops pricing the feed

**Reproduces.** `test_audit_aMeterEndowmentsYieldWaitsForAsLongAsTheFeedIsNotSold` follows the
auditor's steps: a meter endowment earns about one IMD of yield; Questions then reports a cost of
zero for the feed; `harvestable` is zero and `harvest` reverts `NothingToHarvest`; the depositor
withdraws their whole principal to the wei; the endowment is left with principal zero and shares
worth the yield; a thousand blocks and more yield later, `harvest` still reverts and nothing has
reached the meter. The test then shows the one exit: once the feed is priced again, the next
harvest sends everything to the meter.

**Not changed.** The finding reports "a documented trade-off with a concrete state, not a bug in
the arithmetic", and the change it sketches, a creator-chosen fallback for meter endowments, is a
design change: it would alter the public signature of `createForMeter`, the launch runbook in
`docs/LAUNCH.md` that `forge test` holds against the code, the README, the invariant handler and the
`integration/` suite, and it would give a meter endowment's yield a second address to go to, which
the design refuses on purpose (every target is fixed at creation; no stranger's call and no later
choice may send yield anywhere else, `docs/THREATS.md` section 10, pattern 1). The requester asked
that the contracts be deployed as they are. What the finding showed to be missing was a sentence:
E5 and E12 said the yield "waits" without saying the wait may never end. That sentence is now in
both, with the test that pins it. A meter endowment's creator chooses a feed knowing this, and the
creation-time check (`FeedNotLive`) already refuses a feed that is not sold today.

### 3dcaa097 (info): coverage note

Not a defect; nothing to do. The same limit applies to this work: the live sources of Questions,
WorkOrders and CrowdPots are not in this checkout, so their behaviour is taken from the frozen
interfaces, the stand-ins and the project's fork tests, which were not run here (no network is
assumed).

## What was run

- `forge build` with the project's configuration: clean.
- `forge test` (default profile, fork suites excluded as the project configures) with
  `FOUNDRY_FUZZ_SEED=0xeeba9f4b13666d26e7e43113dcb90276b7edaacddc2d62fd28430ac7a5f1b9b1`, the
  seed the verifier uses: all tests pass, the two new ones included.
- `forge fmt` on the new test file.

## Open items for the deployer, not for this work

- Explorer verification and the manifest are the launch's own steps.
- The fork suites (`FOUNDRY_PROFILE=fork forge test`) need a mainnet RPC and check the six literal
  addresses against live code; the requester's own run on 15 October 2026 is the evidence for them.
