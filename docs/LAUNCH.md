# Launch C: Rules, Endowments, Zap

This document is what the launch needs and nothing else: the launch request, the manifest we expect,
where every constructor argument comes from, every value that can never be changed afterwards, what
to check before launching, and what to do on the first day and every day after.

**Status: launched.** IdentityMD launch 1845 created the three contracts on Ethereum mainnet on 15
October 2026, in transaction `0x1806c02e5e38d4c8496476b3f3cf39f250a9d0c97ff5834c75a0475a12bd62fb`
(block 26198165): `Rules` at `0xcbF0dddF07C00a78E2E7561a6F47C275B8c05D7E`, `Endowments` at
`0xbE916A53b9Bbe634AF7E10E604E06b6069edEE76` and `Zap` at
`0x51bF8c74bd9BD74Ad08cABDC90DaC7835C18B21A`. The rest of this document is kept as it was written
before the launch. One correction: section 6, step 2, says IdentityMD's receipt writer has been
writing again since 14 October; it wrote again from 13 October 2026, 17:26 UTC (block 26,185,055),
and the desk's first order was paid on its job's receipt on 14 October. Section 6, step 2, ran on
mainnet on 16 October 2026, and the hire of step 3 was done by the team's hosted runner with its
standing settings (it takes any employer's orders, not only `EMPLOYERS=$RULES`). The team's
wallet H1 created the rule exactly as written (rule 1; block 26,204,482, 365,124 gas). It fired
the rule by hand with `scripts/first-rule.sh` at the root of the HELP WANTED repository (block
26,204,499, 348,583 gas of the documented 700,000). The fire read the hires feed's answer of 13
October (223, round 1) and opened order 2 on the desk. The runner claimed the order nine blocks
after the fire, when the price had risen to 0.56005 IMD, so the figures differ slightly from the
ledger below. The runner was paid 0.504045 IMD and its bond, Payroll's fee and tip were 0.0280025
IMD each, and 0.03995 IMD came back to the rule inside the callback (`accountOf` reads 6, `Rules`,
0, 560050000000000000, 39950000000000000). The creator took that back with `cancel` (block
26,204,586). The settlement used 488,072 gas with a 3,801-byte record, against a receipt
IdentityMD's writer had written in block 26,204,533. Step 1, the endowment drill, ran from 15 to
19 October 2026 with W1: endowment 1 was created, 1 IMD deposited (block 26,198,207) and staked,
and on 19 October `withdraw` paid back exactly 1 IMD (block 26,226,427). Nothing was harvested:
sIMD's price did not move while the deposit was staked, so `harvestable` stayed below 0.001 IMD,
unlike the estimate in step 1. Every number below was
produced by a test or a command that is named beside it, and where a command needs one of the three
addresses it reads it from a shell variable: set those to the addresses above.

**Every constructor argument is known.** `Rules` takes the address of `WorkOrders`, and `Endowments`
and `Zap` take the addresses of `Questions` and `CrowdPots`. Those three contracts belong to the two
earlier launches of HELP WANTED, and both are live on Ethereum mainnet since 13 October 2026: launch A
is IdentityMD launch 1531, launch B is IdentityMD launch 1573. Their addresses are written into the
manifest below, section 2 says where each comes from, and section 5 how each was checked.

The tests in `test/launch/` read this file. The blocks that follow a marker comment
(`<!-- manifest -->`, `<!-- firstRule:… -->`, `<!-- firstEndowment:… -->`, `<!-- firstDay:… -->`)
are parsed and compared with the code, and every `cast call` and `cast send` line is checked to name
a function the contract it is sent to really has. A block edited by hand without the matching change
in the code fails `forge test`.

## 1. The launch request

To send to IdentityMD with the repository's URL:

> Please deploy this repository as it is: contracts only, on Ethereum mainnet. There is no token
> and no owner.
>
> It holds three contracts, to be created in this order: `Rules`, `Endowments`, `Zap`. Their
> constructor arguments are in `docs/LAUNCH.md`: ten addresses in all, every one a literal. Three
> are existing mainnet contracts (IMD, the sIMD staking vault and Uniswap's v4 PoolManager) and
> three are contracts of our two earlier launches, live since 13 October 2026: `Questions`
> (`0xEECE4628ceb091C13393fc64056Be8b8501fD3F6`) of launch 1531, and `WorkOrders`
> (`0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2`) and `CrowdPots`
> (`0x8C2FfCdcb103659aa05c772b8F2059868B496EB5`) of launch 1573. Some are given to more than one
> contract. No contract of this launch refers to another, so there is no `$contract:` reference,
> and no argument is `$owner`: no contract has an owner, an admin or a setter.
>
> Nothing has to be called after deployment. The constructors make no external call and check no
> code size, so they run on an empty chain. There is no proxy, no initializer, no pausing and no
> minting; the runtime bytecode holds no DELEGATECALL, CALLCODE or SELFDESTRUCT. `Zap` has three
> functions that take ETH, because paying with ETH is what it is for; deployment sends none.
> `forge test` checks each of these statements (`test/launch/LaunchC.t.sol`).
>
> The project builds with solc 0.8.26, EVM version cancun, optimizer 200 runs, `via_ir`,
> `bytecode_hash = "none"` and `cbor_metadata = false`, as `foundry.toml` already says. We believe
> no source file needs to change for the launch. The folder `integration/` is a second Foundry
> project that tests these contracts against the sources of our earlier launches; `forge build`,
> `forge test` and `forge fmt --check` run from the root do not reach it, it builds only beside
> those two repositories, and it is not part of what is deployed. `docs/THREATS.md`, section 10,
> says what we checked in this code after the changes your pipeline made to our first launch and
> the findings your auditors raised on our second, and why each rule here is as it is.
>
> One sentence on two rules we ask you to leave as they are: `Rules.fire` pays a rule's tip to
> whoever fires it first, and `Endowments.harvest`, open to anyone, sends yield only to the target
> the endowment's creator fixed, a contract included, because there is no earlier party to pay
> instead and no other address the money may go to (`docs/THREATS.md`, section 10, patterns 1 to 3).

The repository carries no `launch.json`: the pipeline's manifest step writes it.

## 2. The manifest we expect

Contracts in order, with their constructor arguments in order:

<!-- manifest -->
```json
{
  "kind": "evm_contracts",
  "contracts": [
    {
      "contract": "Rules",
      "constructorArgs": [
        "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
        "0x730cb6c845d896e33283d3a4ed8967f8baa778d2"
      ]
    },
    {
      "contract": "Endowments",
      "constructorArgs": [
        "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
        "0x9efa934d9fad4ae28c998a40195646b965a97247",
        "0xeece4628ceb091c13393fc64056be8b8501fd3f6",
        "0x8c2ffcdcb103659aa05c772b8f2059868b496eb5"
      ]
    },
    {
      "contract": "Zap",
      "constructorArgs": [
        "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
        "0x000000000004444c5dc75cb358380d2e3de08a90",
        "0x8c2ffcdcb103659aa05c772b8f2059868b496eb5",
        "0xeece4628ceb091c13393fc64056be8b8501fd3f6"
      ]
    }
  ],
  "notes": "Contracts only. No token, no owner, nothing to call after deployment. Three arguments are contracts of our two earlier launches: WorkOrders and CrowdPots of launch 1573 and Questions of launch 1531."
}
```

Mind the order of `Zap`'s last two arguments: the crowd pots come before Questions there, and after
it in `Endowments`.

### Every argument and where its value comes from

All addresses are Ethereum mainnet. The constant names are those of
`src/interfaces/external/Mainnet.sol`, which the tests import; the deployed contracts do not import
it, they receive every address as an argument.

**`Rules(address imd, address workOrders)`**

| # | Argument | Value | Source |
|---|---|---|---|
| 0 | `imd` | `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` | `Mainnet.IMD`. The token every rule is funded with, pays in and tips in. |
| 1 | `workOrders` | `0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2` | `Mainnet.WORK_ORDERS`. `WorkOrders`, the hire desk, as the factory's `ContractsLaunched` event of launch B (IdentityMD launch 1573, transaction `0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c`, block 26,184,581) names it, second of four. Every HIRE rule opens its orders there, and the delivery callback is accepted from this address only. |

**`Endowments(address imd, address simd, address questions, address crowdPots)`**

| # | Argument | Value | Source |
|---|---|---|---|
| 0 | `imd` | `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` | `Mainnet.IMD`. What is deposited, withdrawn and harvested. |
| 1 | `simd` | `0x9efa934d9fad4ae28c998a40195646b965a97247` | `Mainnet.SIMD`. IdentityMD's staking vault, an ERC-4626 vault over IMD with no owner. Every deposit is staked there. The fork suite checks what the contract assumes about it (`test_fork_simdIsWhatTheDesignAssumes`). |
| 2 | `questions` | `0xEECE4628ceb091C13393fc64056Be8b8501fD3F6` | `Mainnet.QUESTIONS`. `Questions`, as the factory's `ContractsLaunched` event of launch A (IdentityMD launch 1531, transaction `0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58`, block 26,182,869) names it, first of three. Meter endowments read a feed's cost and meter there and fund the meter. |
| 3 | `crowdPots` | `0x8C2FfCdcb103659aa05c772b8F2059868B496EB5` | `Mainnet.CROWD_POTS`. `CrowdPots`, third of four in launch B's event. Pot endowments chip in there. |

**`Zap(address imd, address poolManager, address crowdPots, address questions)`**

| # | Argument | Value | Source |
|---|---|---|---|
| 0 | `imd` | `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` | `Mainnet.IMD`. With native ETH it names the pool: the pool id Zap computes from this address is `0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3`, the live ETH/IMD pool (`test_launch_deploysInManifestOrderOnAnEmptyChain`, `test_fork_zap_thePoolItNamesIsLiveAndLiquid`). |
| 1 | `poolManager` | `0x000000000004444c5dc75cb358380d2e3de08a90` | `Mainnet.POOL_MANAGER`. Uniswap v4's PoolManager on Ethereum mainnet, as Uniswap publishes it. |
| 2 | `crowdPots` | `0x8C2FfCdcb103659aa05c772b8F2059868B496EB5` | The same address as `Endowments`' argument 3. |
| 3 | `questions` | `0xEECE4628ceb091C13393fc64056Be8b8501fD3F6` | The same address as `Endowments`' argument 2. Zap calls its `fundFor`. |

The manifest is written in lower case, as launch B's was; the tables above give the same addresses
with their checksums.

## 3. What the tests show about the launch

| Statement | Test |
|---|---|
| The manifest above names `Rules`, `Endowments`, `Zap` in that order, with 2, 4 and 4 arguments, no `$owner`, no `$token` and no reference between them | `test_manifest_theDocumentNamesTheThreeContractsInOrder` |
| Every argument is the `Mainnet.sol` address; Questions and CrowdPots are written the same way in both contracts that take them; the bytes built from this document are the bytes `LaunchManifest.sol` builds | `test_manifest_everyArgumentInTheDocumentIsWhatTheCodeExpects` |
| The three addresses of the earlier launches are the ones `Mainnet.sol` records for launches 1531 and 1573; no marker from before those launches is left; this document and `README.md` name them where a reader and the commands look for them | `test_manifest_theEarlierLaunchesAreWrittenWithTheirLiveAddresses` |
| On a mainnet fork, each of the three is the address the factory's `ContractsLaunched` event of its launch names, in its place; the factory records each launch at its block; code lives at each, with the size and code hash read on 15 October 2026, and each is wired to the others and to IMD as its launch's manifest says | `test_fork_manifest_theEarlierLaunchesAreTheOnesTheFactoryRecorded` (fork suite) |
| Created in manifest order from those arguments, on a chain where no dependency has code, the three contracts deploy and report the configuration written here | `test_launch_deploysInManifestOrderOnAnEmptyChain` |
| Each contract is inside our gates of 23,000 bytes of runtime code and 46,000 bytes of initcode; the launch is inside our gate of 12,000,000 gas | `test_launch_sizeAndGasGates` |
| No runtime bytecode and no initcode holds DELEGATECALL, CALLCODE or SELFDESTRUCT (walked instruction by instruction, PUSH data skipped); no runtime holds CREATE, CREATE2 or ORIGIN | `test_launch_noForbiddenInstructionInAnyDeployedRuntime`, `test_scan_seesInstructionsAndStepsOverPushData`, `test_scan_findsADelegatecallInCompiledCodeAndNotInAConstant` |
| No constructor reaches outside its own contract: recorded while the three are created, and read off the constructor code (no CALL, STATICCALL, EXTCODE instruction, BALANCE, CREATE or CREATE2) | `test_launch_constructorsTouchNothingOutsideTheirOwnContract`, `test_launch_constructorCodeHoldsNoCallAndNoCodeCheck` |
| Every constructor is nonpayable, takes only addresses, and refuses a zero address in any position | `test_launch_constructorsAreNonpayable`, `test_launch_aMissingAddressIsRefused`, `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes` |
| The functions that can change state are the 20 listed in `README.md` and no others; no contract has a `receive` or a fallback; the only functions that take ETH are Zap's `chipIn`, `fundMeter` and `buy` | `test_launch_stateChangingFunctionsAreExactlyTheDocumentedOnes` |
| Before the dependencies exist every use reverts and leaves nothing behind; once they exist each contract does its job through the addresses it was constructed with | `test_launch_beforeTheDependenciesExistEveryUseReverts`, `test_launch_onceTheDependenciesExistEachContractWorks` |
| On a mainnet fork, the launch deployer's `launchContracts` call to the real ProjectFactory creates the three contracts at the predicted addresses, and nobody else can make it | `test_fork_launch_throughTheRealFactoryAsTheLaunchDeployer`, `test_fork_launch_theFactoryRefusesAnyoneElseAndAnySecondTime` (fork suite) |
| On the contracts the factory created, with nothing called after deployment: Zap swaps on the real ETH/IMD pool, Endowments stakes into the real sIMD and returns the principal to the wei, a rule that reads the real vault pays in real IMD; and the same three reach the live Questions, crowd pots and hire desk: a chip and meter shares bought with ETH in the caller's name, and a HIRE rule's order on the live desk | `test_fork_launch_theLaunchedContractsWorkAgainstTheRealProtocol`, `test_fork_launch_theLaunchedContractsReachTheLiveQuestionsPotsAndDesk` (fork suite) |
| The first day of section 6, with its amounts, against the live contracts of launches A and B and real IMD: the endowment funds the live payrolls meter from yield and returns the principal to the wei; the rule fires on the live hires feed, opens its order on the live desk, and is paid on a work record written into the real WorkRegistry, with the change returned inside the desk's callback and every party paid what section 6 says | `test_fork_live_theFirstEndowment_fundsTheLivePayrollsMeterAndReturnsThePrincipal`, `test_fork_live_theFirstRule_firesOnTheLiveHiresFeedAndIsPaidOnARealReceipt` (fork suite) |
| Against the sources of the real Questions, WorkOrders, WorkProof and CrowdPots: 51 tests, among them a HIRE rule's order settled on a real work record and its change returned inside the desk's callback | `integration/`, see `README.md` |

Measured sizes (`forge build --sizes`; the protocol's limits are 24,576 and 49,152 bytes):

| Contract | Runtime bytes | Initcode bytes | Initcode with arguments |
|---|---|---|---|
| Rules | 13,762 | 14,153 | 14,217 |
| Endowments | 13,161 | 13,746 | 13,874 |
| Zap | 3,834 | 4,458 | 4,586 |

Launch gas:

| Measure | Gas | Where it comes from |
|---|---|---|
| Creating the three contracts with CREATE2 in one call, on an empty chain | 6,835,468 | `test_launch_sizeAndGasGates`, with Foundry's default setting, which runs the call as a transaction of its own. |
| An estimate from a real launch: 241 gas for each of the 32,677 bytes of initcode | 7,875,157 | The same test. Launch 1240 used 9,596,612 gas for 39,910 bytes. |
| The real ProjectFactory's `launchContracts`, called by the launch deployer on a mainnet fork, with the manifest above | about 7,388,500 for the call, and about 519,650 more for the transaction's base cost and calldata: about 7.91 million | `test_fork_launch_throughTheRealFactoryAsTheLaunchDeployer`, 15 October 2026: 7,908,188 and 7,908,164 in two runs. The figure moves by a few gas with the launch number the rehearsal picks (7,908,185 and 7,908,161 on 13 October, with stand-ins at the three addresses). |

Our gate is 12,000,000 gas and the protocol's ceiling is 16.7 million. The second part of the
rehearsal figure is added by hand from the calldata's bytes, which may count some of it twice; the
figure errs high. It comes to 242 gas for each byte of initcode, where a real contracts-only
launch used 240.5 (launch 1240), and the same test fails if the two are more than a twentieth apart.

## 4. What is fixed at launch

Nothing below can be changed by anyone once the launch transaction is mined. There is no owner, no
setter and no upgrade path. Each value is listed with the reason it has the value it has.

### Rules

| Value | Setting | Reason |
|---|---|---|
| IMD, WorkOrders | constructor arguments | Written in the manifest, readable by anyone (`IMD()`, `WORK_ORDERS()`). |
| Conditions | 1 VIEW: a static call with stored calldata whose first returned word is compared; 2 FEED: the newest answer of a Standing Question, with a maximum age, once per answered round | Two kinds and no more, by design. |
| Actions | 1 HIRE: an order on the desk with Rules as the employer; 2 PAY: a fixed amount to a fixed recipient | There is no third verb. |
| Comparisons | 1 `>=`, 2 `<=`, 3 `>`, 4 `<`, 5 `==`, 6 `!=`, all unsigned | Numbered as the hire desk numbers its own. |
| `COND_GAS` | 100,000 | The most gas a condition read may use. The same allowance as the desk's own condition. |
| Gas `fire` must have in hand when it reads the condition | 121,587 (`COND_GAS` × 64/63 + 20,000) | So that the target is always offered the whole allowance, whoever sends the transaction and whatever gas they send (`test_fire_view_theCallerCannotStarveTheConditionOfGas`, `test_fire_gasShort_isACleanRefusal_andAnOrdinaryLimitIsEnough`). The 20,000 is room for what is charged between the check and the call, several times today's cost. |
| `MAX_COND_DATA` | 132 bytes | A selector and four words. |
| `MAX_SPEC` and the spec's character rules | 7,900 bytes of printable ASCII, no `"`, no `\`, no space at either end | The hire desk's own rule, checked when a rule is written so that a rule which is accepted can open its order. `createRule` refuses a spec exactly when the real desk does, with the same bytes (`integration/`: `testFuzz_createRule_refusesASpecExactlyAsTheRealDeskDoes`). |
| Flags a HIRE rule may set | the desk's `FLAG_ALLOW_CLAIMED` (1) and `FLAG_CALLBACK` (2), read from the desk | A rule's order has no condition of its own, so the desk refuses its third flag. |
| Fee | none | Rules keeps nothing. The tip paid to whoever fires a rule is the creator's own choice, per rule. |
| Who may end a rule | its creator, with `cancel` | The one privilege in the contract, and it belongs to a rule, not to the contract. |

### Endowments

| Value | Setting | Reason |
|---|---|---|
| IMD, sIMD, Questions, CrowdPots | constructor arguments | Written in the manifest. `stake` checks on first use that the vault's asset is IMD. |
| `STAKE_INTERVAL` | 50 blocks, about ten minutes | sIMD pays nothing out to a holder in the block it minted shares to that holder. Staking in batches keeps that to one block in fifty at most. |
| `SEED` | 0.000001 IMD (1e12 wei), paid once by whoever creates an endowment, never refunded | It is staked with the first batch and is nobody's principal: it is what lets every depositor take back exactly what they put in although every vault conversion rounds against the caller. |
| `MARGIN`, `SPARE` | 1e12 and 5e11 sIMD share-wei (a share-wei is worth about 0.000008 IMD-wei) | What a harvest always leaves on top of the principal, and what an endowment must hold on top to accept a deposit. |
| `MIN_HARVEST` | 0.001 IMD | Smaller amounts wait and keep earning. |
| `METER_RUNWAY` | 30 requests | A harvest never lifts a feed's meter above the cost of thirty requests at `Questions.costOf`; yield beyond that stays staked until the meter has room. At the house feeds' 0.55 IMD a request that is 16.5 IMD. |
| `POT_CALL_GAS`, `POT_VIEW_GAS` | 500,000 and 50,000 | What the pot is handed for a chip and for saying what it still needs. The real pots' costliest chip, one that opens a new round of a series, used 246,132 gas (`integration/`: `test_pot_theGasFloorAndWhatTheRealPotUses`). A pot harvest is refused (`LowGas`) unless it can hand over the whole allowance, so a caller cannot starve the pot to push yield to the fallback. |
| Targets | one per endowment, fixed when it is created: a feed's meter, a pot or series with a fallback beneficiary, or a recipient | Nobody, the creator included, can point an endowment's yield elsewhere later. |
| Refused as a recipient or fallback | the zero address, Endowments itself, IMD, sIMD, Questions, CrowdPots | Addresses where a plain IMD transfer would be lost, and sIMD, where a lump of yield would be shared with whoever staked one block earlier. |
| Fee | none | |

### Zap

| Value | Setting | Reason |
|---|---|---|
| IMD, PoolManager, CrowdPots, Questions | constructor arguments | Written in the manifest. |
| The pool | native ETH and IMD, fee 10000 (1%), tick spacing 200, no hook contract; `POOL_ID` is computed from the IMD address in the constructor | The one ETH/IMD pool there is. An `int24` cannot be a launch constructor argument, and a pool that could be chosen later would need somebody to choose it. |
| Price limit of the swap | one above Uniswap's lowest price | The swap may move the price as far as it must; the caller's minimum decides whether the result is acceptable. |
| What every entry point takes | the least IMD the swap must produce, and a deadline: the last block timestamp at which the call may run | Zap sets no limit of its own. |
| Fee | none | Zap keeps nothing: every wei of IMD bought goes to the pot, the meter or the caller, and unused ETH goes back to the caller. The pool's own fee is 1%. |

## 5. Before launch

**Done on 15 October 2026, at block 26,197,383.**

1. **The three addresses of the earlier launches were taken from the factory's own record.** The
   `ContractsLaunched` event of transaction
   `0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58` names `Questions` first of
   launch 1531's three contracts, and that of
   `0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c` names `WorkOrders` and
   `CrowdPots` second and third of launch 1573's four. The fork test
   `test_fork_manifest_theEarlierLaunchesAreTheOnesTheFactoryRecorded` reads both transactions'
   receipts again and checks the event against the manifest. Then each contract was asked something
   only the right one answers:

   ```sh
   export RPC=...                                              # an Ethereum mainnet RPC URL
   export IMD=0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7
   export QUESTIONS=0xEECE4628ceb091C13393fc64056Be8b8501fD3F6  # launch A (IdentityMD launch 1531)
   export DESK=0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2       # WorkOrders, launch B (launch 1573)
   export POTS=0x8C2FfCdcb103659aa05c772b8F2059868B496EB5       # CrowdPots, launch B (launch 1573)
   export PAYROLLS=0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61
   export HIRES=0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d

   cast call $QUESTIONS "IMD()(address)" --rpc-url "$RPC"                          # must be $IMD
   cast call $QUESTIONS "costOf(bytes32)(uint256)" $PAYROLLS --rpc-url "$RPC"      # 550000000000000000 on 15 October
   cast call $QUESTIONS "meterOf(bytes32)(uint256,uint256)" $PAYROLLS --rpc-url "$RPC"
   cast call $QUESTIONS "latest(bytes32)(uint256,uint64,uint64,uint64,uint64)" $HIRES --rpc-url "$RPC"
   cast call $DESK "IMD()(address)" --rpc-url "$RPC"                           # must be $IMD
   cast call $DESK "MIN_BOND()(uint96)" --rpc-url "$RPC"                       # 250000000000000000
   cast call $DESK "MIN_DELIVERY()(uint32)" --rpc-url "$RPC"                   # 259200
   cast call $DESK "MAX_DELIVERY()(uint32)" --rpc-url "$RPC"                   # 7776000
   cast call $DESK "FLAG_ALLOW_CLAIMED()(uint8)" --rpc-url "$RPC"              # 1
   cast call $DESK "FLAG_CALLBACK()(uint8)" --rpc-url "$RPC"                   # 2
   cast call $DESK "orderCount()(uint256)" --rpc-url "$RPC"                    # 1 on 15 October
   cast call $POTS "potCount()(uint256)" --rpc-url "$RPC"                      # 0 on 15 October
   cast call $POTS "remaining(uint256)(uint256)" 1 --rpc-url "$RPC"            # 0 while no pot exists
   ```

   Every answer was the expected one. The payrolls and hires feeds each had one answered round
   (13 October; the hires feed counted 223 transfers to the swarm's fee payee in its window) and a
   meter of 0.005 IMD; the desk had one order, the Doorbell's, delivered on a receipt on 14 October;
   no crowd pot had been opened. Code lives at each address: 22,233, 19,289 and 14,177 bytes.

   A wrong address cannot be corrected after launch. With a wrong desk no HIRE rule can be written
   (PAY rules still work). With a wrong Questions no meter endowment can be created and `fundMeter`
   reverts. With a wrong CrowdPots no pot endowment can be created and `chipIn` reverts. In each
   case the rest of the launch works and no money is at risk, but the launch would have to be
   repeated to get the missing part (section 9).

2. **The three addresses are written into the manifest above**, each in every one of its places,
   and into `src/interfaces/external/Mainnet.sol`; `forge test` holds the two against each other
   (`test_manifest_everyArgumentInTheDocumentIsWhatTheCodeExpects`,
   `test_manifest_theEarlierLaunchesAreWrittenWithTheirLiveAddresses`).

3. **Run the suites** on the commit that will be imported:

   ```sh
   forge fmt --check && forge build --sizes && forge test
   FOUNDRY_PROFILE=fork forge test
   ```

   The fork suite meets the live contracts of launches A and B at the manifest's addresses: the
   rehearsal through the real factory deploys this launch against them, `RulesDeskForkTest` walks a
   HIRE rule through the live desk, and `LiveSiblingsForkTest` runs section 6 against them.

4. **Run the tests against the sibling sources** as they stand at the commits that were launched,
   from a checkout that holds the three launch folders side by side:

   ```sh
   cd integration && forge test
   ```

## 6. The first day

Nothing is called by the launch pipeline after deployment. Every call below is open to anyone; none
needs a privilege, and the team's wallets are only the first to make them. `$WALLET` stands for the
operator's own signing option for `cast send`, for example `--account NAME` (an encrypted keystore)
or `--ledger`. No key is written in this file, and none should be typed on a command line.

The first day shows two things on mainnet with as little money as can show them, and puts in only
money that comes back, apart from one optional hire:

- **an endowment drill:** one IMD deposited into an endowment for launch A's payrolls feed, staked,
  its yield harvested onto the feed's meter, and the IMD withdrawn to the wei;
- **a rule that fires:** WHEN launch A's hires feed reports at least 100 hires in its window, THEN
  hire a research report on the desk of launch B. Firing it opens the order. Having it done (step 3)
  costs the swarm's fee and the desk's tenth of the price, 0.556 IMD in all; without step 3 the
  creator withdraws the order and nothing is spent.

### What goes in, what comes back, what is spent

The amounts, in IMD wei, as `test/launch/LaunchRunbook.t.sol` and the fork test
`test_fork_live_theFirstRule_firesOnTheLiveHiresFeedAndIsPaidOnARealReceipt` read them:

<!-- firstDay:ledger -->
```json
{
  "endowmentDeposit": "1000000000000000000",
  "endowmentSeed": "1000000000000",
  "ruleDeposit": "610000000000000000",
  "ruleTip": "10000000000000000",
  "price": "560000000000000000",
  "change": "40000000000000000",
  "deskFee": "28000000000000000",
  "agentsTip": "28000000000000000",
  "runnerPay": "504000000000000000",
  "runnerBond": "250000000000000000",
  "swarmFee": "500000000000000000",
  "peakOutlay": "2360001000000000000",
  "comesBack": "1804000000000000000",
  "spentForGood": "556001000000000000",
  "spentForGoodWithoutTheHire": "1000000000000"
}
```

| Item | In | Back | Spent for good |
|---|---|---|---|
| Endowment: the deposit | 1 | 1, to the wei, by `withdraw` | 0 |
| Endowment: the seed, paid once by its creator | 0.000001 | 0 | 0.000001 |
| Endowment: the yield harvested | none of ours | | goes onto the payrolls meter (about 0.001 IMD) |
| Rule: the deposit, one fire's cost | 0.61 | the tip and the change, below | |
| Rule: the tip, to whoever fires it | (from the deposit) | 0.01, when a wallet of ours fires it | 0 |
| The order's escrow on the desk | 0.60 (from the deposit) | the change, 0.04, inside the desk's callback, then to the creator by `cancel` | |
| The price, if a runner takes the order at once | 0.56 (from the escrow) | the runner's 90%: 0.504 | the desk's fee, 0.028 (to Payroll), and the agents' tip, 0.028 |
| The runner's bond | 0.25 | 0.25, at settlement | 0 |
| The swarm's fee, paid by the runner for the job | 0.5 | 0 | 0.5 |
| **All of it, with the hire** | **2.360001 at most at once** | **1.804** | **0.556001** |
| **Without the hire** (the creator recalls the order) | 1.610001 at most at once | 1.61 | 0.000001 |

The price rises from 0.56 to 0.60 IMD over a day while nobody holds the order. The runner bot takes
it as soon as it sees it (below; each minute of delay moves the price by less than 0.00003 IMD); if
it were taken later, more would go to the runner, less would come back as change, and the desk's
tenth of the price would be at most 0.06: the hire would cost at most 0.560001 IMD. Gas comes on top, in ETH (section 8). A rule that is public can be fired by anybody: if a
stranger fires it first, the 0.01 tip is theirs, and that is all they can take.

### Step 0. Read back what was deployed

```sh
export RPC=...            # an Ethereum mainnet RPC URL
export ME=0x...           # the operator's own address
export IMD=0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7
export SIMD=0x9efa934d9fad4ae28c998a40195646b965a97247
export QUESTIONS=0xEECE4628ceb091C13393fc64056Be8b8501fD3F6
export DESK=0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2
export POTS=0x8C2FfCdcb103659aa05c772b8F2059868B496EB5
export RULES=0x...        # the three addresses this launch created, from its ContractsLaunched event
export ENDOW=0x...
export ZAP=0x...
```

Compare each answer with section 2.

```sh
cast call $RULES "IMD()(address)" --rpc-url "$RPC"
cast call $RULES "WORK_ORDERS()(address)" --rpc-url "$RPC"        # must be $DESK
cast call $ENDOW "IMD()(address)" --rpc-url "$RPC"
cast call $ENDOW "SIMD()(address)" --rpc-url "$RPC"               # must be $SIMD
cast call $ENDOW "QUESTIONS()(address)" --rpc-url "$RPC"          # must be $QUESTIONS
cast call $ENDOW "CROWD_POTS()(address)" --rpc-url "$RPC"         # must be $POTS
cast call $ZAP "IMD()(address)" --rpc-url "$RPC"
cast call $ZAP "POOL_MANAGER()(address)" --rpc-url "$RPC"
cast call $ZAP "CROWD_POTS()(address)" --rpc-url "$RPC"           # must be $POTS
cast call $ZAP "QUESTIONS()(address)" --rpc-url "$RPC"            # must be $QUESTIONS
cast call $ZAP "POOL_ID()(bytes32)" --rpc-url "$RPC"              # 0xb07d640f…5abfb3
cast call $ENDOW "METER_RUNWAY()(uint256)" --rpc-url "$RPC"       # 30
```

### Step 1. The endowment drill: yield that pays for a Standing Question

An endowment for launch A's payrolls feed, the feed the Robot Jobs Report is made of. Its depositors
can take back every wei they put in; only the yield their IMD earns in sIMD leaves, and only to that
feed's meter, never more than thirty requests' worth at a time.

<!-- firstEndowment:feed -->
```text
0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61
```

<!-- firstEndowment:deposit -->
```text
1000000000000000000
```

That is 1 IMD. Creating the endowment costs 0.000001 IMD on top (the seed, 1e12 wei), so the
allowance below is the deposit plus the seed.

```sh
export FEED=0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61
cast call $QUESTIONS "costOf(bytes32)(uint256)" $FEED --rpc-url "$RPC"     # not 0, or the next call reverts FeedNotLive
cast send $IMD "approve(address,uint256)" $ENDOW 1000001000000000000 --rpc-url "$RPC" $WALLET
TX=$(cast send $ENDOW "createForMeter(bytes32)" $FEED --rpc-url "$RPC" $WALLET --json | jq -r .transactionHash)
```

Read the new endowment's id from the `Created` event of that transaction, not from a guess: ids are
handed out in order, and somebody else's endowment may have been created in between.

<!-- firstEndowment:createdTopic -->
```text
0x291da4ef24c0ed2e99f048c6b1e178c77a6a860ff2ef668f20bfbd7e330f31a6
```

```sh
ID=$(cast receipt $TX --rpc-url "$RPC" --json | jq -r '.logs[] | select(.topics[0]=="0x291da4ef24c0ed2e99f048c6b1e178c77a6a860ff2ef668f20bfbd7e330f31a6") | .topics[1]' | cast to-dec)
cast call $ENDOW "endowment(uint256)(uint8,bytes32,address,uint256,uint256,uint256,uint256)" $ID --rpc-url "$RPC"   # kind 1, target $FEED
cast send $ENDOW "deposit(uint256,uint256)" $ID 1000000000000000000 --rpc-url "$RPC" $WALLET
```

The deposit waits in the contract until the next batch is staked. Anyone may stake, at most once
every 50 blocks; the first `stake` may come at once:

```sh
cast call $ENDOW "nextStakeBlock()(uint256)" --rpc-url "$RPC"
cast send $ENDOW "stake()" --rpc-url "$RPC" $WALLET
```

Then wait for yield. `harvest` runs only for 0.001 IMD or more. Between 10 and 15 October 2026
sIMD's price rose by 0.16% in 4.6 days (read from the vault at blocks 26,164,296 and 26,197,383), at
which rate one IMD earns 0.001 IMD in about three days. Nothing is lost by waiting, and the deposit
can be taken back at any time meanwhile.

```sh
cast call $ENDOW "harvestable(uint256)(uint256)" $ID --rpc-url "$RPC"    # 0 until it reaches 1000000000000000
cast send $ENDOW "harvest(uint256)" $ID --rpc-url "$RPC" $WALLET
cast call $QUESTIONS "meterOf(bytes32)(uint256,uint256)" $FEED --rpc-url "$RPC"   # the meter grew by what was harvested
```

A harvest of a **pot** endowment, which this drill does not make, must be sent with a gas limit of
850,000 (`--gas-limit 850000`): below about 800,000 it reverts `LowGas`, and what is not used comes
back.

Then the principal, to the wei:

```sh
cast call $ENDOW "vaultHold()(bool)" --rpc-url "$RPC"
cast send $ENDOW "withdraw(uint256,uint256)" $ID 1000000000000000000 --rpc-url "$RPC" $WALLET
```

If `vaultHold()` answers true, sIMD pays nothing out to the contract in this block: wait one block,
or leave at once with sIMD shares instead of IMD (the last argument, `true`):

```sh
cast send $ENDOW "exit(uint256,uint256,uint256,bool)" $ID 1000000000000000000 1000000000000000000 true --rpc-url "$RPC" $WALLET
```

`test_runbook_theFirstEndowmentIsCreatedStakedHarvestedAndWithdrawn` walks these steps with these
amounts on the contracts created from the manifest, and
`test_fork_live_theFirstEndowment_fundsTheLivePayrollsMeterAndReturnsThePrincipal` against the live
Questions, the real sIMD and real IMD.

### Step 2. The rule that fires: WHEN the hires feed reports a busy day, THEN hire

A sentence a contract keeps for its creator: **when launch A's hires feed reports at least 100
hires of the swarm in its window, hire a research report on who paid for them.** The condition is
the newest answer of a Standing Question, which the oracle signed; the action is an order on the
hire desk, paid from the rule's own escrow; whoever fires the rule is paid the tip.

<!-- firstRule:params -->
```json
{
  "when": {
    "kind": 2,
    "cmp": 1,
    "maxAge": 2592000,
    "target": "0xeece4628ceb091c13393fc64056be8b8501fd3f6",
    "threshold": "100",
    "feedId": "0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d",
    "data": "0x"
  },
  "action": 1,
  "hire": {
    "kind": "skill:research-report",
    "minPay": "560000000000000000",
    "maxPay": "600000000000000000",
    "rampSecs": 86400,
    "deliverySecs": 604800,
    "bond": "250000000000000000",
    "runnerOnly": "0x0000000000000000000000000000000000000000",
    "arbiter": "0x0000000000000000000000000000000000000000",
    "flags": 2,
    "orderTtl": 259200
  },
  "pay": {
    "recipient": "0x0000000000000000000000000000000000000000",
    "amount": "0"
  },
  "tip": "10000000000000000",
  "cooldown": 0,
  "maxFires": 1,
  "deposit": "610000000000000000"
}
```

<!-- firstRule:spec -->
```text
Write a one-page plain-language report on who paid the IdentityMD swarm's job fee in the last 7,000 Ethereum blocks before this job started, from IMD Transfer events to the fee payee 0x4e0fA57Bde726079356537E2F34d671E9F41ADbc only, with every figure sourced to a transaction.
```

Field by field: the condition is a FEED (`kind` 2) on the `Questions` contract of launch A
(`target`), feed `hires` (`feedId`), and holds when the newest answer is at least (`cmp` 1) 100, is
from a round the rule has not fired on, and is no older than thirty days (`maxAge`). The hires feed
is asked on the days somebody pays for a round, not every day; its one answer so far, 223, is from
13 October. The action is a HIRE (`action` 1) of a job whose work record must carry the kind
`skill:research-report` (the contract takes keccak256 of that text), for 0.56 rising to 0.60 IMD
over a day, with the desk's minimum bond of 0.25 IMD, seven days for delivery and three days for a
runner to take the order. `flags` 2 asks the desk to call the rule back at settlement so the change
returns at once; it does not allow the desk's claimed path, so only an on-chain receipt pays.
IdentityMD's receipt writer, stalled from about 8 October, has been writing again since 14 October,
and the desk's first order was paid on a receipt that day. The tip is 0.01 IMD, the rule fires
once, and the deposit is one fire's cost: 0.60 IMD for the order and 0.01 for the tip.

Read the feed before creating the rule; the value must be at least 100 and `updatedAt` no more than
thirty days ago:

```sh
cast call $QUESTIONS "latest(bytes32)(uint256,uint64,uint64,uint64,uint64)" $HIRES --rpc-url "$RPC"   # value, fromBlock, toBlock, round, updatedAt
```

```sh
SPEC=$(cast from-utf8 "Write a one-page plain-language report on who paid the IdentityMD swarm's job fee in the last 7,000 Ethereum blocks before this job started, from IMD Transfer events to the fee payee 0x4e0fA57Bde726079356537E2F34d671E9F41ADbc only, with every figure sourced to a transaction.")
cast send $IMD "approve(address,uint256)" $RULES 610000000000000000 --rpc-url "$RPC" $WALLET
cast send $RULES "createRule(((uint8,uint8,uint32,address,uint256,bytes32,bytes),uint8,(bytes32,uint96,uint96,uint32,uint32,uint96,address,address,uint8,uint32),(address,uint96),uint96,uint32,uint32),bytes,uint96)" \
  "((2,1,2592000,0xeece4628ceb091c13393fc64056be8b8501fd3f6,100,0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d,0x),1,($(cast keccak skill:research-report),560000000000000000,600000000000000000,86400,604800,250000000000000000,0x0000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,2,259200),(0x0000000000000000000000000000000000000000,0),10000000000000000,0,1)" \
  $SPEC 610000000000000000 --rpc-url "$RPC" $WALLET
RULE=$(cast call $RULES "ruleCount()(uint256)" --rpc-url "$RPC")
cast call $RULES "getRule(uint256)((address,uint96,uint8,bool,uint32,uint32,uint96,uint32,uint40,uint64,bytes32,(uint8,uint8,uint32,address,uint256,bytes32,bytes),(bytes32,uint96,uint96,uint32,uint32,uint96,address,address,uint8,uint32),(address,uint96)))" $RULE --rpc-url "$RPC"   # the first field must be $ME
```

`ruleCount()` is the new rule's id only if nobody else created a rule in between; the `getRule`
line checks that the rule read back is the operator's own.

Anyone can then ask whether the rule would fire, and fire it:

```sh
cast call $RULES "check(uint256)(bool,uint256,uint64)" $RULE --rpc-url "$RPC"    # true, 223, 1 while the 13 October answer is the newest
cast call $RULES "canFire(uint256)(bool)" $RULE --rpc-url "$RPC"
cast send $RULES "fire(uint256,bytes)" $RULE $SPEC --gas-limit 700000 --rpc-url "$RPC" $WALLET
ORDER=$(cast call $DESK "orderCount()(uint256)" --rpc-url "$RPC")
cast call $RULES "orderOf(uint256)(uint256,uint96,uint96)" $ORDER --rpc-url "$RPC"    # $RULE, 600000000000000000, 0
```

`fire` must be given the spec text again, exactly as it was published when the rule was created
(the rule keeps only its hash). On a fork of mainnet this fire read the live hires feed and opened
its order on the live desk for 400,806 gas (`test_fork_live_theFirstRule_firesOnTheLiveHiresFeedAndIsPaidOnARealReceipt`); the
gas limit above leaves room. The order belongs to the rule: a runner takes it on the desk like any
other, as launch B's document describes. As with `ruleCount()`, the order's id is the desk's
`orderCount()` only if nobody else opened an order in between; `orderOf` checks it.

**Without the hire**, the creator withdraws the order while nobody holds it, then ends the rule:
every wei of the deposit is back but the tip, which went to the wallet that fired.

```sh
cast send $RULES "recall(uint256,uint256)" $RULE $ORDER --rpc-url "$RPC" $WALLET
cast send $RULES "cancel(uint256)" $RULE --rpc-url "$RPC" $WALLET
```

`test_runbook_theFirstRuleIsWrittenFiredAndPaid` creates exactly this rule from the blocks above on
the contracts created from the manifest, fires it with the documented gas limit, has its order
delivered at 0.56 IMD with the change returned inside the callback, and checks every figure of the
ledger above; `test_runbook_theFirstRuleCanBeUnwoundWithoutTheHire` takes the other way.

### Step 3. The hire, done (optional: 0.556 IMD)

The team's runner bot takes the order, pays the swarm for the job and settles it when the job's
receipt is written. The order pays a runner 0.504 IMD at its first price, just above the swarm's
fee of 0.5, so the bot must be told to accept no margin for this order, which pays its own team:

```sh
MIN_MARGIN_IMD=0 EXPECTED_FAILURE_BPS=0 MAX_BOND_IMD=0.25 TEMPLATES=skill:research-report \
  RECEIPT_ONLY_ORDERS=when-receipts-flow EMPLOYERS=$RULES ...     # with the bot's usual settings
```

`EMPLOYERS=$RULES` keeps the bot to this rule's orders while it runs so. The bot claims (bond 0.25
IMD), buys the job with the order's 85-byte header in front of the spec, registers the job id within
the hour, and settles when IdentityMD's WorkRegistry holds the receipt. At settlement the desk pays
the runner 0.504 IMD and its bond, sends Payroll the fee (0.028) and the tip (0.028, credited to the
agents the record names), and calls the rule back with the change: 0.04 IMD credited to the rule
inside the settlement. The creator then ends the rule and takes the change:

```sh
cast call $DESK "accountOf(uint256)(uint8,address,uint96,uint96,uint96)" $ORDER --rpc-url "$RPC"   # 6 (Delivered), $RULES, 0, 560000000000000000, 40000000000000000
cast call $RULES "orderOf(uint256)(uint256,uint96,uint96)" $ORDER --rpc-url "$RPC"                   # $RULE, 600000000000000000, 40000000000000000
cast send $RULES "cancel(uint256)" $RULE --rpc-url "$RPC" $WALLET                                     # sends the creator 40000000000000000
```

On a fork of mainnet the whole of steps 2 and 3 ran against the live contracts: the rule fired on the
live hires feed; a runner claimed at 0.56 IMD and registered a fresh job id; its record (a real
IdentityMD work record with the job id and objective of this order) was written into the real
WorkRegistry by acting as its writer; `settle` on the live desk used 531,215 gas, paid the runner
0.504 and its bond, booked 0.028 as Payroll revenue and 0.028 as a tip, and returned 0.04 to the rule
inside the callback (`test_fork_live_theFirstRule_firesOnTheLiveHiresFeedAndIsPaidOnARealReceipt`).

If the receipt is late past the delivery deadline, the desk refunds the order and the runner's bond
to the rule (the bond is forfeited to the employer, which is the rule, which is ours), and the
swarm's fee is spent all the same: the hire costs 0.5 IMD and nothing else.

### Not on the team's first day: paying with ETH

Zap is for somebody who holds ETH and no IMD. Using it buys IMD, so the team's first day leaves it
out; anyone may make these calls. The call is first simulated to learn what the pool gives now, then
sent with a minimum one percent below that and a deadline ten minutes ahead. A call that would
deliver less, or that is mined later, reverts and costs only gas.

```sh
DEADLINE=$(( $(date +%s) + 600 ))
QUOTE=$(cast call $ZAP "buy(uint256,uint256)(uint256)" 1 $DEADLINE --value 0.01ether --from $ME --rpc-url "$RPC" | cut -d' ' -f1)
MIN=$(echo "$QUOTE * 99 / 100" | bc)
cast send $ZAP "buy(uint256,uint256)" $MIN $DEADLINE --value 0.01ether --rpc-url "$RPC" $WALLET
```

The same two arguments end the other two entry points. To chip into a pot, size the ETH from what
the pot still needs (`cast call $POTS "remaining(uint256)(uint256)" $POT`); what the swap produces
beyond that comes back to the sender as IMD in the same transaction:

```sh
cast send $ZAP "chipIn(uint256,uint256,uint256)" $POT $MIN $DEADLINE --value 0.01ether --rpc-url "$RPC" $WALLET
cast send $ZAP "fundMeter(bytes32,uint256,uint256)" $FEED $MIN $DEADLINE --value 0.01ether --rpc-url "$RPC" $WALLET
```

On a mainnet fork, through the real pool and into a pot opened on the live `CrowdPots` and the
payrolls meter of the live `Questions`, `chipIn` used 238,028 gas and `fundMeter` 238,396, and
the chip and the meter shares were the caller's (`test_fork_live_zap_chipsIntoALivePotAndFundsALiveMeter`).

**A rule on a view call** has the same shape with a VIEW condition: `kind` 1, `target` the contract
to read, `data` the calldata (at most 132 bytes), no `feedId` and a `maxAge` of zero. For example
`data` `0x01e1d114` (`totalAssets()`) on sIMD with a threshold of 2,000,000 IMD hires once the
vault holds two million. `RulesDeskForkTest` walks a rule of that shape (a VIEW condition on sIMD) through the live desk.

## 7. Every day after

A keeper is any account that makes these calls. It needs ETH for gas. Only `fire` pays the keeper
(the rule's tip). Several keepers can run at once: the second caller's transaction reverts or does
nothing.

| When | Call | Notes |
|---|---|---|
| Endowments holds unstaked IMD (`pendingTotal()` is not 0) and block `nextStakeBlock()` has come | `Endowments.stake()` | At most once every 50 blocks. Reverts `PriceFell` while sIMD's price is below the highest this contract has seen. |
| `harvestable(id)` is not 0 | `Endowments.harvest(id)` | Not in a block where `vaultHold()` is true. For a pot endowment send a gas limit of 850,000. A meter endowment waits while its meter holds thirty requests' worth. |
| `canFire(id)` is true | `Rules.fire(id, spec)` | The spec is in the rule's `RuleCreated` event. Pays the tip. Needs about 122,000 gas in hand when the condition is read, whatever the read uses; send 300,000 for a PAY rule and 700,000 for a HIRE rule. |
| An order of a rule has ended, or returned something (a refund, the change, a bond) | `Rules.reconcile(id, orderId)` | The order ids of a rule are in its `Fired` events. A rule that asked for the desk's callback gets the change of a delivered order without this call. |
| An order of a rule expired with nobody holding it | `WorkOrders.refund(orderId)`, then `Rules.reconcile(id, orderId)` | The desk's call is open to anyone. |

To watch: `Rules.RuleCreated` and `Rules.Fired`, `Endowments.Created`, `Staked`, `Harvested`,
`MeterFunded`, `FallbackPaid` and `PriceMarked`, and `Zap.ChippedIn`, `MeterFunded` and `Bought`.

## 8. What Zap, Rules and Endowments cost to use

Gas, each figure printed by the named test with `-vv`. They are from tests, on a mainnet fork against
the live contracts where the row says so and with stand-ins otherwise, and not from mainnet
transactions. Figures against the live contracts move by a few tens of gas from one block to the
next: two runs on 15 October 2026 gave 531,215 and 531,254 for the settlement. On 15 October 2026 the base fee was about 0.07 gwei; at 1 gwei every call of section 6
together costs less than 0.004 ETH.

| Call | Gas | Test |
|---|---|---|
| `Endowments.createForMeter`, reading the live Questions (fork) | 197,855 | `test_fork_live_theFirstEndowment_fundsTheLivePayrollsMeterAndReturnsThePrincipal` |
| `Endowments.deposit` (fork) | 108,955 | the same |
| `Endowments.stake`, into the real sIMD (fork) | 235,765 | the same |
| `Endowments.harvest` of a meter endowment, onto the live payrolls meter (fork) | 299,968 | the same |
| `Endowments.withdraw`, out of the real sIMD (fork) | 129,002 | the same |
| `Rules.createRule`, the first rule of section 6 (fork) | 374,586 | `test_fork_live_theFirstRule_firesOnTheLiveHiresFeedAndIsPaidOnARealReceipt` |
| `Rules.fire`, FEED on the live hires feed then HIRE on the live desk (fork) | 400,806 | the same |
| `WorkOrders.settle` of that order on a 7,339-byte record, with the live Payroll and the rule's callback (fork; the runner's call) | 531,215 in execution; as a transaction add the record's calldata, about 120,000. The desk asks for about 1.4 to 1.8 million on offer (launch B's document), so the runner bot's limit of 3,000,000 is the one to send | the same |
| `Rules.cancel` after the callback (fork) | 57,421 | the same |
| `Rules.recall` of an order nobody took (fork) | 137,438 | `test_fork_live_theFirstRule_canBeUnwoundOnTheLiveDesk` |
| `Rules.createRule`, HIRE with a 7,900-byte spec | 607,044 | `test_createRule_hire_acceptsTheLongestSpec` |
| `Rules.fire`, VIEW then PAY | 111,553 | `test_fire_gas` |
| `Rules.fire`, VIEW then PAY, reading the real sIMD and paying real IMD (fork) | 119,026 | `test_fork_rules_viewRule_readsSimdTotalAssets_andPays` |
| `Rules.fire`, VIEW then HIRE, stand-in desk | 391,443 | `test_fire_gas` |
| `Rules.onWorkDelivered` with change to credit | 62,365 (the desk allows 150,000) | `test_onWorkDelivered_gasFitsTheDesksAllowance` |
| `Rules.check` of a FEED rule on the real Questions | 25,194 (the read is offered 100,000) | `integration/`: `test_feed_theRealReadFitsTheConditionsGas` |
| `Zap.buy` through the real pool (fork) | about 150,000; the figure moves by a few hundred gas with the block | `test_fork_zap_buy_realSwap` |
| `Zap.chipIn` into a pot on the live CrowdPots, `Zap.fundMeter` onto the live payrolls meter (fork) | 238,028 and 238,396 | `test_fork_live_zap_chipsIntoALivePotAndFundsALiveMeter` |
| Creating Endowments alone (CREATE2 of its initcode) | 2,694,036 | `test_constructor_makesNoCallAndNeedsNoCodeAtItsArguments` |
| The least gas a pot harvest can be sent with, chipping into a pot on the live CrowdPots (fork) | 786,523 | `test_fork_live_aPotEndowmentChipsIntoALivePot` |
| A pot harvest that opens a round of a real series (stand-in vault) | 462,439 used | `integration/`: `test_pot_theGasFloorAndWhatTheRealPotUses` |

## 9. What can go wrong on the day, and what happens then

| Event | What the contracts do |
|---|---|
| One of the three addresses in the manifest is wrong | Nothing can be taken from anyone, and nothing can be corrected. A wrong desk: `createRule` reverts for every HIRE rule (the desk cannot be read); PAY rules work. A wrong Questions: `createForMeter` reverts and `fundMeter` reverts; FEED rules are not affected, since each names its own feed source. A wrong CrowdPots: `createForPot` and `chipIn` revert. Recipient endowments, PAY rules and `buy` need none of the three. The three were checked against the factory's own events (section 5). |
| The hires feed's newest answer is below 100 or older than thirty days | The first rule does not fire (`ConditionNotMet`), and costs nothing to keep. It fires on the next answered round that qualifies; a round costs 0.55 IMD to whoever asks for it. |
| IdentityMD's receipts stall again | A HIRE rule's order without the claimed path is not paid; it ends in a timeout or a refund and its escrow returns to the rule through `reconcile`, with the runner's bond. Nothing is lost by the rule. The runner's swarm fee is spent. |
| The hires or payrolls feed gets no answers | FEED rules on it do not fire. Meter endowments keep topping its meter up to thirty requests and no further; if no request is bought the meter stays full and the yield stays staked. |
| The Intake stops selling the feed's action, or its price passes the feed's cap | `Questions.costOf` is zero: no meter endowment can be created for the feed and existing ones harvest nothing until it is sold again. Principal is not affected. |
| sIMD's price falls | `stake` and `harvest` revert `PriceFell` until the price is back. Endowments whose shares no longer cover their principal take no deposits and pay each leaver their proportional part (`exit`). See `docs/THREATS.md`, E1 and E2. |
| The ETH/IMD pool is thin or moves | A Zap call that would deliver less than its sender's minimum reverts, as does one mined after its deadline. A sender who passes a minimum of zero and a far deadline accepts any price. |
| Uniswap's PoolManager, or the pool, is no longer usable | Zap's three entry points revert. Rules and Endowments are not affected. |
| Nobody runs a keeper | Nothing is lost. Deposits wait unstaked (and stay withdrawable), yield stays staked, rules do not fire. |
