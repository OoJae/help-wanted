/**
 * What has happened on chain that this site can no longer read for itself, kept here.
 *
 * The public RPC serves logs for about the newest 7,200 blocks, so the transactions behind the
 * first rounds, the first print and the first two orders fall out of its reach about a day after
 * they are mined. Their hashes are pinned below. Each was read from Ethereum mainnet on 15 October
 * 2026 with `cast receipt <hash> --rpc-url https://ethereum-rpc.publicnode.com` (order 2 and rule 1:
 * on 16 October 2026, with the same command against https://rpc.mevblocker.io), its logs decoded with
 * the shared package's ABIs; the block, the block's time, the sender and the event each entry names
 * are what that read gave. Only past events are pinned. Whatever can still change (an order's
 * state, a meter, a tip that is owed, a seat's owner) is read live by the page that shows it.
 *
 * Every record names the contract it belongs to, and a page uses it only while the deployments
 * book gives that contract the same address: a fork, a rehearsal or a test book never borrows
 * mainnet's history. `test/history.test.ts` holds the records against each other and against the
 * shared package (order header, job ids, the job text's hash).
 */
import type { Address, Hex } from "viem";
import { MAINNET, OFFCHAIN, type HouseFeedName } from "@help-wanted/shared";

/** The day the entries below were read from the chain and from the public records they cite. */
export const HISTORY_READ_ON = "15 October 2026";

/** The day order 2, rule 1 and the house x402 payments up to order 2's were read. */
export const ORDER_2_READ_ON = "16 October 2026";

export interface PinnedTx {
  hash: Hex;
  block: number;
  /** The block's time, UTC. */
  at: string;
  /** The transaction's sender, as the receipt gives it. */
  from: Address;
}

const H1: Address = "0x60CcC928eb8EEE1d64CA0164565BfA9858669560";
const W1: Address = "0x871e507B6a70F858Ad4B414bddb77473630C366b";

// ---------------------------------------------------------------------------------------------
// Standing Questions: the first round of each house feed
// ---------------------------------------------------------------------------------------------

export interface PinnedRound {
  feed: HouseFeedName;
  feedId: Hex;
  round: number;
  /** The `RoundOpened` log: who opened the round, what the meter paid, the Intake request it bought. */
  opened: PinnedTx & { keeper: Address; tipWei: bigint; priceWei: bigint; intakeRequestId: Hex };
  /**
   * The `RoundAnswered` log. `deliveredBy` is the Intake itself when its own callback delivered the
   * answer, and the caller of `submit` otherwise. `oracleRequestId` is as the log carries it: the
   * UUID's sixteen bytes, left-aligned in 32.
   */
  answered: PinnedTx & { deliveredBy: Address; byCallback: boolean; agreed: number; oracleRequestId: Hex };
}

export const ROUND_HISTORY: { questions: Address; rounds: readonly PinnedRound[] } = {
  questions: "0xEECE4628ceb091C13393fc64056Be8b8501fD3F6",
  rounds: [
    {
      feed: "payrolls",
      feedId: "0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61",
      round: 1,
      opened: {
        hash: "0x9fea43c9e0fd05c8c55b977284e6e543410f71c74363e5448747b1b482056b06",
        block: 26183619,
        at: "2026-10-13T12:37:59Z",
        from: H1,
        keeper: H1,
        tipWei: 50_000_000_000_000_000n,
        priceWei: 500_000_000_000_000_000n,
        intakeRequestId: "0x8b62aeadfbd380a68797107a800d55f2d1697849f94ac6564eb69856cc071841",
      },
      answered: {
        hash: "0xfd95b06615de1f0a1002fd4b8178c18d92a76e8f0ee11737c11f5cb6d1832ca5",
        block: 26183772,
        at: "2026-10-13T13:08:47Z",
        from: H1,
        deliveredBy: H1,
        byCallback: false,
        agreed: 6,
        oracleRequestId: "0xf8ffb99155b74316946144a94d5270aa00000000000000000000000000000000",
      },
    },
    {
      feed: "hires",
      feedId: "0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d",
      round: 1,
      opened: {
        hash: "0x943a265217afcd2f60bdc7c9f13cc070504cb2582d470ac0ed44e3c8658d6001",
        block: 26183621,
        at: "2026-10-13T12:38:23Z",
        from: H1,
        keeper: H1,
        tipWei: 50_000_000_000_000_000n,
        priceWei: 500_000_000_000_000_000n,
        intakeRequestId: "0xb5b449716f98becc4b2cd31f18d0dffff6243f6b0a2f68ca68b3665424f91339",
      },
      answered: {
        hash: "0x80138b296f005b1cd378e493c9e13d7daca5e347d592832184e3e34557455e61",
        block: 26183780,
        at: "2026-10-13T13:10:23Z",
        from: H1,
        deliveredBy: H1,
        byCallback: false,
        agreed: 7,
        oracleRequestId: "0x0a94afe2c48e4254918479de6d8f98a100000000000000000000000000000000",
      },
    },
    {
      feed: "employers",
      feedId: "0x22ad8df0e0af07aa59e29aa7f5540e0022fbfda0651ccae3eccb968553a14835",
      round: 1,
      opened: {
        hash: "0x4ef3313d793940eca2847b7d01969ea76c56f92fab92aa7601e863dd92660204",
        block: 26183622,
        at: "2026-10-13T12:38:35Z",
        from: H1,
        keeper: H1,
        tipWei: 50_000_000_000_000_000n,
        priceWei: 500_000_000_000_000_000n,
        intakeRequestId: "0xa81622f556b9441f6de3c0418d908b5a25dacc22c92c8c734be7a685fb6d02d9",
      },
      // Sent by IdentityMD's Intake writer to the Intake, version 2, which called Questions back.
      answered: {
        hash: "0xfed277e7525f289f8e8bad0333148c8823f42c779836280189ff874500de051b",
        block: 26185017,
        at: "2026-10-13T17:18:47Z",
        from: MAINNET.INTAKE_WRITER,
        deliveredBy: MAINNET.INTAKE,
        byCallback: true,
        agreed: 5,
        oracleRequestId: "0x4831e0331ddd43089d26396a8d340e8200000000000000000000000000000000",
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// The Robot Jobs Report: the transaction of each print
// ---------------------------------------------------------------------------------------------

export interface PinnedPrint {
  /** The print's index in the contract, from zero. */
  index: number;
  /** The `Printed` log's transaction. */
  tx: PinnedTx;
}

export const PRINT_HISTORY: { jobsReport: Address; prints: readonly PinnedPrint[] } = {
  jobsReport: "0x58963B57E179f7fE4E95090C21E8e9D75353BCE4",
  prints: [
    {
      index: 0,
      tx: {
        hash: "0x691890b4affed91496538e012610b632c72a739b5a2ec703b285d51961edb192",
        block: 26183781,
        at: "2026-10-13T13:10:35Z",
        from: H1,
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// The hire desk: the transactions of each order, in the order they happened
// ---------------------------------------------------------------------------------------------

export type TrailKey = "opened" | "claimed" | "paid" | "registered" | "asserted" | "receipt" | "settled";

export interface TrailStep {
  key: TrailKey;
  label: string;
  /** What the transaction did, in one or two sentences, from its decoded logs. */
  what: string;
  tx: PinnedTx;
}

export interface PinnedOrder {
  id: number;
  /** The day this order's transactions, and the code at its tip's payee, were read from the chain. */
  read: string;
  /** The swarm job the order was settled with. */
  jobId: string;
  /** The job text, from the order's `OrderOpened` log. A page shows it only when it hashes to the order's specHash. */
  spec: string;
  /** What `WorkProof.prove(jobId, record, 85)` answered for the job's record on the day below. */
  prove: {
    read: string;
    recordHash: Hex;
    kindHash: Hex;
    headHash: Hex;
    specHash: Hex;
    stateHash: Hex;
    agentIds: readonly string[];
  };
  /** The transactions, oldest first. */
  trail: readonly TrailStep[];
  /** `Payroll.claimTip` for the agents the settlement tipped, once someone has called it. */
  tipClaims: readonly {
    agentId: string;
    tokenId: string;
    /** The seat's owner Payroll paid, as the `TipClaimed` log names it. */
    paidTo: Address;
    /** Whether that address had code when eth_getCode was read on the day above. */
    paidToHasCode: boolean;
    amountWei: bigint;
    tx: PinnedTx;
  }[];
  /**
   * The work itself where IdentityMD serves it as a file (a report), not as a page that shows it (a
   * picture). This site serves no copy. Absent for a picture job.
   */
  work?: { label: string; url: string; what: string };
}

export const ORDER_HISTORY: { workOrders: Address; orders: readonly PinnedOrder[] } = {
  workOrders: "0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2",
  orders: [
    {
      id: 1,
      read: HISTORY_READ_ON,
      jobId: "f7bd80ba-3e8b-483f-ad02-6ffbd16fef92",
      spec: "Draw the doorbell of the day. Make one square picture of a single doorbell next to a front door, in a visual style chosen fresh for today so that no two days look alike. Write the current UTC date as YYYY-MM-DD in small plain lettering in the lower right corner and put no other text in the picture. This job was ordered on chain by the HELP WANTED Doorbell, a contract with no owner that hires the swarm on every 25th ring.",
      prove: {
        read: HISTORY_READ_ON,
        recordHash: "0x59f81da0ce7cde62693fca46e8dd10411c1dfae52102ffd68d25a66821451b68",
        kindHash: "0x7679ff00d2b015b122f4c00147c1004ea6657aada5fff65e72986b90c6869185",
        headHash: "0x88784319f8fdd8808fa2c7ea2b548aa12b019f0e60ec52298607a1ed967439c6",
        specHash: "0xc8faed8d83537bc41df11439ac993de622dc400fa59d29002958dd8ecfcfdba6",
        stateHash: "0x6216ba39af4188a6d7c765710d7e6075007c3444b59a22a973d1b958c43e60bb",
        agentIds: ["51519"],
      },
      trail: [
        {
          key: "opened",
          label: "Opened",
          what: "The Doorbell's 25th ring. The Doorbell, a contract with no owner, opened order 1 from its own code and escrowed 1 IMD on the desk. The ring was sent by house wallet H1.",
          tx: {
            hash: "0xa9c9f25681b4512fc51d06cdd17d575e1ef3385d881b9ff62e25447bf8d815fb",
            block: 26184854,
            at: "2026-10-13T16:46:11Z",
            from: H1,
          },
        },
        {
          key: "claimed",
          label: "Claimed",
          what: "The team's runner (house wallet H1) took the order: a bond of 0.25 IMD, the price fixed at 1 IMD, claim number 1.",
          tx: {
            hash: "0x64fa9f0ab43cd79f3e0a6ea1ba4829afae68ec882ba8a99dd9b692b579f4cb8b",
            block: 26185009,
            at: "2026-10-13T17:17:11Z",
            from: H1,
          },
        },
        {
          key: "paid",
          label: "x402 payment",
          what: `The runner's x402 payment for the swarm job, settled on chain: 0.5 IMD from H1 to IdentityMD's fee address, through the x402 Permit2 proxy (${OFFCHAIN.X402_EXACT_PERMIT2_PROXY}). IdentityMD sent the transaction on the runner's signed payment.`,
          tx: {
            hash: "0xc92c4731e996540cbe68d2e62bc820d67e6bf4d7ec9adc6464b4b0be90e66bc5",
            block: 26185015,
            at: "2026-10-13T17:18:23Z",
            from: MAINNET.FEE_PAYEE,
          },
        },
        {
          key: "registered",
          label: "Registered",
          what: "The runner registered swarm job f7bd80ba-3e8b-483f-ad02-6ffbd16fef92 on the order.",
          tx: {
            hash: "0x868c21f2ce636a1b14c98e78595c051f9d6787e774eb24603e6408a287e10904",
            block: 26185053,
            at: "2026-10-13T17:26:11Z",
            from: H1,
          },
        },
        {
          key: "asserted",
          label: "Delivery claimed",
          what: "IdentityMD's WorkRegistry wrote no receipt from 9 October, 01:39 UTC, until 13 October, 17:26 UTC, eleven minutes before this claim, and it had not yet written this job's. The Doorbell's orders accept a bonded claim, so the runner claimed delivery under its bond, naming record hash 0x59f81da0…1b68. Nobody challenged it. Its 24-hour window would have closed at 14 Oct 2026, 17:37:59 UTC; the settlement on the receipt at 10:44 UTC ended it first.",
          tx: {
            hash: "0xb1e9061678862f6b2049d7941b0a28e020dac681370dd3b6d8f564bd82c88a25",
            block: 26185112,
            at: "2026-10-13T17:37:59Z",
            from: H1,
          },
        },
        {
          key: "receipt",
          label: "Receipt written",
          what: "IdentityMD's WorkRegistry writer recorded the job's receipt: WorkRecorded for job f7bd80ba with the same record hash.",
          tx: {
            hash: "0x1c324621fe3b728710ad68e39aed26e2ccddc808fa0d2c52af9e1b6abb37d516",
            block: 26190218,
            at: "2026-10-14T10:43:23Z",
            from: MAINNET.WORK_REGISTRY_WRITER,
          },
        },
        {
          key: "settled",
          label: "Settled on proof",
          what: "A minute later, before the claim's 24 hours had run, the runner settled the order with the job's work record. The desk checked it against the receipt and paid: 0.9 IMD and the 0.25 IMD bond to the runner, a 0.05 IMD fee to Payroll, and a 0.05 IMD tip to Payroll for agent 51519. Delivered, proven.",
          tx: {
            hash: "0xa3f5b783fe194c35f348e411a10f0a199589ea89b668a16d1597794931217628",
            block: 26190223,
            at: "2026-10-14T10:44:23Z",
            from: H1,
          },
        },
      ],
      tipClaims: [
        {
          agentId: "51519",
          tokenId: "1049",
          paidTo: "0x6eE77E931C6154E4752C5Bf832Ce51f7897f105A",
          paidToHasCode: false,
          amountWei: 50_000_000_000_000_000n,
          tx: {
            hash: "0x9edc8ba2ae4cfbabe95d6ca11e7a93f349f09729b7a699d575eac6f8466e1fe8",
            block: 26198056,
            at: "2026-10-15T12:56:59Z",
            from: W1,
          },
        },
      ],
    },
    {
      id: 2,
      read: ORDER_2_READ_ON,
      jobId: "42f26c64-eea9-46f2-822a-33547ec18abf",
      spec: "Write a one-page plain-language report on who paid the IdentityMD swarm's job fee in the last 7,000 Ethereum blocks before this job started, from IMD Transfer events to the fee payee 0x4e0fA57Bde726079356537E2F34d671E9F41ADbc only, with every figure sourced to a transaction.",
      prove: {
        read: ORDER_2_READ_ON,
        recordHash: "0xf6d0bd11b43fc36a3720db09a65612a03a4be7b5b12476bcdace4d1383176a85",
        kindHash: "0x1eca772919112a33a7f2dec9335cff7b36a9ebb94160fa9a3c07556d47f2988b",
        headHash: "0x390b14f4107ba442916e9ebed452a7e38eb2eb80a221e8ed90da68b0212d3f8f",
        specHash: "0xc6413a52aaf533c2d6727f8590dd516adef39894f5c53ef5a9333039827431e2",
        stateHash: "0x6216ba39af4188a6d7c765710d7e6075007c3444b59a22a973d1b958c43e60bb",
        agentIds: ["52142"],
      },
      trail: [
        {
          key: "opened",
          label: "Opened",
          what: "Rule 1's one fire. House wallet H1 called Rules.fire(1) by hand (scripts/first-rule.sh; anyone may fire a rule whose condition holds). Rules read launch A's hires feed (223, round 1, at least 100), opened order 2 on the desk as its employer, escrowed 0.60 IMD from the rule's deposit and paid H1 the 0.01 IMD tip for firing.",
          tx: {
            hash: "0x9f790aae9db07625dc86b6c107d7ed55b43f96ba5bfaf5b02c64269ab963e37b",
            block: 26204499,
            at: "2026-10-16T10:28:47Z",
            from: H1,
          },
        },
        {
          key: "claimed",
          label: "Claimed",
          what: "The team's runner (house wallet H1, on its hosted server) took the order: a bond of 0.25 IMD, the price fixed at 0.56005 IMD, claim number 1.",
          tx: {
            hash: "0x27fc5a9fa12302a79d9f8b97fa82a541c9ab01ba07e78c2980d86db2c9b20cb1",
            block: 26204508,
            at: "2026-10-16T10:30:35Z",
            from: H1,
          },
        },
        {
          key: "paid",
          label: "x402 payment",
          what: `The runner's x402 payment for the swarm job, settled on chain: 0.5 IMD from H1 to IdentityMD's fee address, through the x402 Permit2 proxy (${OFFCHAIN.X402_EXACT_PERMIT2_PROXY}). IdentityMD sent the transaction on the runner's signed payment.`,
          tx: {
            hash: "0x2fc7fa990bb74b015cff16c5c69e8d97eccdad38c79307c8b1a02bfbcea3ca70",
            block: 26204514,
            at: "2026-10-16T10:31:47Z",
            from: MAINNET.FEE_PAYEE,
          },
        },
        {
          key: "receipt",
          label: "Receipt written",
          what: "IdentityMD's WorkRegistry writer recorded the job's receipt: WorkRecorded for job 42f26c64 with record hash 0xf6d0bd11…6a85, 16 seconds after IdentityMD listed the job as completed and two blocks before the runner registered the job.",
          tx: {
            hash: "0x3a604fc1d0a83a25d0f8b89142007d665557ca6bb7ee2ff80ddaca67eadb5abf",
            block: 26204533,
            at: "2026-10-16T10:35:35Z",
            from: MAINNET.WORK_REGISTRY_WRITER,
          },
        },
        {
          key: "registered",
          label: "Registered",
          what: "The runner registered swarm job 42f26c64-eea9-46f2-822a-33547ec18abf on the order.",
          tx: {
            hash: "0x20ef3770d86475c944ce46a42fce15234549e53c17245f29759ca3c3dfe54467",
            block: 26204535,
            at: "2026-10-16T10:35:59Z",
            from: H1,
          },
        },
        {
          key: "settled",
          label: "Settled on proof",
          what: "The runner settled the order with the job's 3,801-byte work record. The desk checked it against the receipt and paid: 0.504045 IMD and the 0.25 IMD bond to the runner, a 0.0280025 IMD fee to Payroll, and a 0.0280025 IMD tip to Payroll for agent 52142. It returned the 0.03995 IMD the order did not spend to Rules and called Rules back (onWorkDelivered), which credited it to rule 1. Delivered, proven. The order pays on a receipt only: the bonded-claim path was off.",
          tx: {
            hash: "0x35bb49cc9576a425b94a94137e8fe24e496017cc154456eeee255d22fc020516",
            block: 26204543,
            at: "2026-10-16T10:37:35Z",
            from: H1,
          },
        },
      ],
      tipClaims: [
        {
          agentId: "52142",
          tokenId: "1978",
          paidTo: "0x5C7d92736A6Db05b85eF1aEBBc3190f05cff3008",
          paidToHasCode: false,
          amountWei: 28_002_500_000_000_000n,
          tx: {
            hash: "0xd7a75e9c71968ba67badb671c96103a55364d78b563e6b6561a08b98603f6273",
            block: 26204587,
            at: "2026-10-16T10:46:23Z",
            from: H1,
          },
        },
      ],
      work: {
        label: "Download the report the rule paid for (Markdown)",
        url: "https://api.imd.fun/artifacts/4dcebdb382dd91a82e53a629dc7620f811feb6146e011d3a6e799fdf7c6482f0",
        what: "report.md, a Markdown file of 10,523 bytes. IdentityMD's API serves it as a download, so the link saves the file rather than opening a page. It counts 220 payments of 0.5 IMD to IdentityMD's fee address, 110 IMD in all, from 52 senders, in blocks 26,197,518 to 26,204,517; the team counted the same logs on chain on 16 October 2026 and got the same figures. Among them are the team's own payment for this job and one by house wallet W1.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Rules: the team's first rule
// ---------------------------------------------------------------------------------------------

export interface PinnedRule {
  id: number;
  /** The `RuleCreated` log's creator. */
  creator: Address;
  /** The order on the hire desk the rule's fire opened. */
  orderId: number;
  read: string;
  /** The transactions, oldest first, each sent to Rules by the wallet it names. */
  trail: readonly { label: string; what: string; tx: PinnedTx }[];
}

/**
 * Rule 1, created by house wallet H1 on 16 October 2026 exactly as the first rule of
 * launches/c-company/docs/LAUNCH.md, section 6, and fired by hand from the same wallet with
 * scripts/first-rule.sh. Its fire opened order 2 on the hire desk (above). Each transaction was read
 * with `cast receipt` on 16 October 2026 (status 1, sent by H1 to Rules) and its logs decoded:
 * RuleCreated with a deposit of 0.61 IMD; Fired, with 0.60 IMD moved to the desk and 0.01 IMD to H1;
 * RuleCancelled with a refund of 0.03995 IMD to H1. The rule's state is read live.
 */
export const RULE_HISTORY: { rules: Address; entries: readonly PinnedRule[] } = {
  rules: "0xcbF0dddF07C00a78E2E7561a6F47C275B8c05D7E",
  entries: [
    {
      id: 1,
      creator: H1,
      orderId: 2,
      read: ORDER_2_READ_ON,
      trail: [
        {
          label: "Rule created",
          what: "createRule: rule 1, WHEN launch A's hires feed reports at least 100, THEN hire a research report at 0.56 rising to 0.60 IMD that only a receipt can pay, a 0.01 IMD tip for whoever fires it, one fire. H1 deposited 0.61 IMD, one fire's cost.",
          tx: {
            hash: "0x8c69fca9fcdd1893181832d708cfbf69fb7227c127206c4bcdd00bc0028e548b",
            block: 26204482,
            at: "2026-10-16T10:25:23Z",
            from: H1,
          },
        },
        {
          label: "Rule fired",
          what: "fire(1), sent by hand: the hires feed read 223 (round 1), and the fire opened order 2 on the hire desk, moved 0.60 IMD into its escrow and paid H1 the 0.01 IMD tip. Anyone may fire a rule whose condition holds; this time the team's own wallet did.",
          tx: {
            hash: "0x9f790aae9db07625dc86b6c107d7ed55b43f96ba5bfaf5b02c64269ab963e37b",
            block: 26204499,
            at: "2026-10-16T10:28:47Z",
            from: H1,
          },
        },
        {
          label: "Change withdrawn",
          what: "cancel(1): the rule had used its one fire. Rules sent its creator, H1, the 0.03995 IMD the desk had returned for order 2.",
          tx: {
            hash: "0x9c062d891f69d829be26a31cbc8cd7ed7a55bdfae3f3f0fcd7d2853ec3cb6846",
            block: 26204586,
            at: "2026-10-16T10:46:11Z",
            from: H1,
          },
        },
      ],
    },
  ],
};

/** The pinned record of a rule, when the book's Rules is the one it was read from. */
export function pinnedRule(rules: string | null, id: number): PinnedRule | null {
  if (!rules || rules.toLowerCase() !== RULE_HISTORY.rules.toLowerCase()) return null;
  return RULE_HISTORY.entries.find((r) => r.id === id) ?? null;
}

// ---------------------------------------------------------------------------------------------
// The Doorbell: who rang it
// ---------------------------------------------------------------------------------------------

export interface PinnedRings {
  doorbell: Address;
  /** How many `Rang` logs the read below found, and the blocks they are in. */
  rings: number;
  fromBlock: number;
  toBlock: number;
  /** Rings by sender (lowercase address), as the logs name them. */
  byRinger: readonly { ringer: string; rings: number }[];
  /** The first ring and the 25th, which opened order 1. */
  first: PinnedTx;
  last: PinnedTx;
  read: string;
}

/**
 * Every ring of the Doorbell up to its first hire. The contract counts every ring (`rings()`) and
 * names the ringer in each ring's `Rang(ringer, count)` log. Those logs were read on 15 October
 * 2026 with `cast logs` from the Doorbell's launch block (26,184,581) to the head, through
 * rpc.mevblocker.io: 25 logs, counts 1 to 25, in blocks 26,184,821 to 26,184,854, every one sent
 * by house wallet H1. `rings()` read 25 the same day, so no other ring exists. The public RPC no
 * longer serves logs that old, so the split is kept here; rings after block 26,184,854 are read
 * live.
 */
export const RING_HISTORY: PinnedRings = {
  doorbell: "0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb",
  rings: 25,
  fromBlock: 26184821,
  toBlock: 26184854,
  byRinger: [{ ringer: H1.toLowerCase(), rings: 25 }],
  first: {
    hash: "0x6e4c2e22c3ea019c47b2c5d3c47679ddc32ee6ad24a9dcc30c15fed84cecc8a2",
    block: 26184821,
    at: "2026-10-13T16:39:35Z",
    from: H1,
  },
  last: {
    hash: "0xa9c9f25681b4512fc51d06cdd17d575e1ef3385d881b9ff62e25447bf8d815fb",
    block: 26184854,
    at: "2026-10-13T16:46:11Z",
    from: H1,
  },
  read: HISTORY_READ_ON,
};

/** The pinned rings, when the book's Doorbell is the one they were read from. */
export function pinnedRings(doorbell: string | null): PinnedRings | null {
  if (!doorbell || doorbell.toLowerCase() !== RING_HISTORY.doorbell.toLowerCase()) return null;
  return RING_HISTORY;
}

// ---------------------------------------------------------------------------------------------
// x402: every payment for a swarm job made from a house wallet
// ---------------------------------------------------------------------------------------------

/**
 * Every x402 payment for a swarm job from a house wallet. Counted from the IMD `Transfer` logs
 * from W1 or H1 to IdentityMD's fee address in blocks 25,952,256 to 26,204,876 (read through
 * rpc.mevblocker.io: up to block 26,198,140 on 15 October 2026, the rest on 16 October 2026): twelve
 * logs. Four are W1's purchases through the legacy Intake (the three house feed questions and the
 * employers feed's first attempt), sent by W1 to the Intake. The other eight are these: each
 * transaction was sent by IdentityMD from its fee address to the x402 Permit2 proxy. Each job's
 * payer, as IdentityMD's API gives it (`paidBy`), is the wallet named, and each job was created at
 * IdentityMD between 15 and 36 seconds after its payment was mined.
 */
export const HOUSE_X402: {
  fromBlock: number;
  toBlock: number;
  /** The day the count was last read. */
  read: string;
  payments: readonly { tx: PinnedTx; payer: "W1" | "H1"; jobId: string; job: string }[];
} = {
  fromBlock: 25_952_256,
  toBlock: 26_204_876,
  read: ORDER_2_READ_ON,
  payments: [
    {
      payer: "W1",
      jobId: "22624be0-d2da-400e-91c4-51dac0a9a7f5",
      job: "launch A's second audit",
      tx: {
        hash: "0xf3653c4ad2f03c8498ce8fa8874da0064101d4d72bae98faccab2183d56c5acb",
        block: 26179829,
        at: "2026-10-12T23:57:35Z",
        from: MAINNET.FEE_PAYEE,
      },
    },
    {
      payer: "W1",
      jobId: "be91e8ae-9f45-495f-a318-60fab672a92e",
      job: "launch A's first audit",
      tx: {
        hash: "0x855b73d60b5eb368c436b16f97695ded54aea6f054690b4115771a4bb9d9126f",
        block: 26179855,
        at: "2026-10-13T00:02:47Z",
        from: MAINNET.FEE_PAYEE,
      },
    },
    {
      payer: "W1",
      jobId: "d8bb3d81-820d-42f4-ad7c-1d3ed96b1da8",
      job: "launch A, through IdentityMD's launch pipeline",
      tx: {
        hash: "0xfa9113b873fc7c5a3dd47bfe2bff1220940428e58dea43201d57f91d9f77ef97",
        block: 26181862,
        at: "2026-10-13T06:45:47Z",
        from: MAINNET.FEE_PAYEE,
      },
    },
    {
      payer: "W1",
      jobId: "e70c56ce-60f0-4c2c-b413-67e5ae37ddce",
      job: "the header job",
      tx: {
        hash: "0x217032e129ab4ac259f8bfab27d3bb738521ad7116ff575d94e0655501995771",
        block: 26181905,
        at: "2026-10-13T06:54:23Z",
        from: MAINNET.FEE_PAYEE,
      },
    },
    {
      payer: "W1",
      jobId: "eb0f6c65-174a-45e8-9fe5-9312c66d4880",
      job: "launch B, through the launch pipeline",
      tx: {
        hash: "0x43b970369253dffb25b3de8570195d490f2496256dae685b6d941616d3dc1d4e",
        block: 26183709,
        at: "2026-10-13T12:55:59Z",
        from: MAINNET.FEE_PAYEE,
      },
    },
    {
      payer: "H1",
      jobId: "f7bd80ba-3e8b-483f-ad02-6ffbd16fef92",
      job: "order 1's picture, bought by the runner",
      tx: {
        hash: "0xc92c4731e996540cbe68d2e62bc820d67e6bf4d7ec9adc6464b4b0be90e66bc5",
        block: 26185015,
        at: "2026-10-13T17:18:23Z",
        from: MAINNET.FEE_PAYEE,
      },
    },
    {
      payer: "W1",
      jobId: "7f2023fc-fa1f-4a7f-a507-3bbc712c51d6",
      job: "launch C, through the launch pipeline",
      tx: {
        hash: "0x1e3af995fd5eb176a30414d2ac5375ec5a67b0ba861bac819164920ed6037a27",
        block: 26197697,
        at: "2026-10-15T11:44:59Z",
        from: MAINNET.FEE_PAYEE,
      },
    },
    {
      payer: "H1",
      jobId: "42f26c64-eea9-46f2-822a-33547ec18abf",
      job: "order 2's research report, bought by the runner",
      tx: {
        hash: "0x2fc7fa990bb74b015cff16c5c69e8d97eccdad38c79307c8b1a02bfbcea3ca70",
        block: 26204514,
        at: "2026-10-16T10:31:47Z",
        from: MAINNET.FEE_PAYEE,
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Launch C in IdentityMD's launch pipeline
// ---------------------------------------------------------------------------------------------

/**
 * The job that asked IdentityMD's launch pipeline to deploy launch C (Rules, Endowments, Zap), paid
 * for by W1 on 15 October 2026 (the last payment above). Its API gave the job as "completed" and
 * the launch as "live" on 15 October 2026; the judges page reads it live once the book records
 * launch C, as it does launch B's.
 */
export const LAUNCH_C_JOB = { jobId: "7f2023fc-fa1f-4a7f-a507-3bbc712c51d6" } as const;

/**
 * Launch C as mainnet holds it, read on 15 October 2026. Its transaction has status 1 in block
 * 26,198,165 and was sent by IdentityMD's launch deployer to its ProjectFactory; the factory's log
 * names launch 1845 (0x735) and the three addresses below, and eth_getCode returns code at each
 * (13,762, 13,161 and 3,834 bytes). IdentityMD's API gives launch 1845 as "live" on chain 1, with
 * the same transaction and addresses (`GET /launches/833dbd2c-fb6a-44c7-81a0-f75292e202e8`). Its
 * outside audits and bounties on record (`GET /launches/<launchId>/assurances`, which IdentityMD's
 * docs describe as "Outside audits and bounties on record, revoked ones included") answered a
 * count of 0 the same day.
 *
 * The deployments book holds the same transaction, block, launch number and addresses
 * (`test/history.test.ts` holds the two equal). Pages take the addresses from the book; this record
 * keeps what the book does not: IdentityMD's launch id, the block's time and the outside audits.
 */
export const LAUNCH_C_ON_CHAIN = {
  launchNumber: 1845,
  /** IdentityMD's id for the launch, as its API names it. */
  launchId: "833dbd2c-fb6a-44c7-81a0-f75292e202e8",
  /** What `GET /launches/<launchId>/assurances` counted on the day below. */
  outsideAudits: { count: 0, read: HISTORY_READ_ON },
  /** The day it was created, as a page says it. */
  day: "15 October 2026",
  tx: {
    hash: "0x1806c02e5e38d4c8496476b3f3cf39f250a9d0c97ff5834c75a0475a12bd62fb",
    block: 26198165,
    at: "2026-10-15T13:18:47Z",
    from: MAINNET.LAUNCH_DEPLOYER,
  } satisfies PinnedTx,
  contracts: {
    rules: "0xcbF0dddF07C00a78E2E7561a6F47C275B8c05D7E",
    endowments: "0xbE916A53b9Bbe634AF7E10E604E06b6069edEE76",
    zap: "0x51bF8c74bd9BD74Ad08cABDC90DaC7835C18B21A",
  } satisfies Record<string, Address>,
} as const;

// ---------------------------------------------------------------------------------------------
// Endowments: the team's drill
// ---------------------------------------------------------------------------------------------

export interface PinnedEndowment {
  id: number;
  /** The `Created` log's creator. */
  creator: Address;
  /** Why it exists, in a few words a page can print after "Endowment 1:". */
  purpose: string;
  /** The transactions, oldest first, each sent to Endowments by the wallet it names. */
  trail: readonly { label: string; what: string; tx: PinnedTx }[];
}

/**
 * Endowment 1, created by house wallet W1 on 15 October 2026 to try the contract on mainnet with the
 * team's own IMD: the meter of the payrolls feed, 1 IMD of principal. Each transaction was read with
 * `cast receipt` on 15 October 2026 (status 1, sent by W1 to Endowments) and its logs decoded with
 * the shared ABI. On 19 October 2026 W1 withdrew the whole principal as exactly 1 IMD (read the same
 * way that day); nothing was harvested, because sIMD's price did not move while the deposit was
 * staked. A page reads the endowment's state live. Kept here because its `Created` log falls out of
 * the public RPC's reach about a day after it was mined.
 */
export const ENDOWMENT_HISTORY: { endowments: Address; entries: readonly PinnedEndowment[] } = {
  endowments: "0xbE916A53b9Bbe634AF7E10E604E06b6069edEE76",
  entries: [
    {
      id: 1,
      creator: W1,
      purpose: "the team's own drill, with the team's own IMD",
      trail: [
        {
          label: "Created",
          what: "createForMeter for the payrolls feed: Created(1, Meter, creator W1), with the 0.000001 IMD seed.",
          tx: {
            hash: "0x30fed0233e644cd0bf6b8501bcfd49e412362c23b7329ed690ac7eece48213a5",
            block: 26198194,
            at: "2026-10-15T13:24:35Z",
            from: W1,
          },
        },
        {
          label: "Seed staked",
          what: "stake(): the contract's first batch, the 0.000001 IMD seed, into sIMD.",
          tx: {
            hash: "0xd84bed17222e4ba442551e47d03e90df194c95c7c40ecbb8c3ae9a9e765bd721",
            block: 26198196,
            at: "2026-10-15T13:24:59Z",
            from: W1,
          },
        },
        {
          label: "Deposited",
          what: "deposit(1, 1 IMD): Deposited(1, W1, 1 IMD). The principal is W1's.",
          tx: {
            hash: "0x523e1145cf4f9eaf962eedfc6f917c9d0c0402e9e552a732018e525546a8aa06",
            block: 26198207,
            at: "2026-10-15T13:27:11Z",
            from: W1,
          },
        },
        {
          label: "Staked",
          what: "stake(): the 1 IMD deposit, staked into sIMD in one batch.",
          tx: {
            hash: "0xc895beb4862e85f4dda0c9e3d7638054d2b3fdd852673cd374d8a8111fd7dc54",
            block: 26198303,
            at: "2026-10-15T13:46:23Z",
            from: W1,
          },
        },
        {
          label: "Withdrawn",
          what: "withdraw(1, 1 IMD): Withdrawn(1, W1, principal 1 IMD, imdOut 1 IMD, sharesOut 0). The whole principal came back to W1 as exactly 1 IMD.",
          tx: {
            hash: "0xcb48313ac8f8ac053fb6f1316dd8359795720441809c8d2503773612ba47024e",
            block: 26226427,
            at: "2026-10-19T11:49:35Z",
            from: W1,
          },
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// CrowdPots: the team's refund drill
// ---------------------------------------------------------------------------------------------

export interface PinnedPot {
  id: number;
  /** The `PotOpened` log's opener. */
  opener: Address;
  /** Why it exists, in a few words a page can print after "Pot 1:". */
  purpose: string;
  /** The transactions, oldest first, each sent to CrowdPots by the wallet it names. */
  trail: readonly { label: string; what: string; tx: PinnedTx }[];
}

/**
 * Pot 1, opened by house wallet H1 on 20 October 2026 to show a refund on mainnet with the team's
 * own IMD: a 1 IMD target, 72 minutes to collect, one chip of 0.01 IMD. Nobody else chipped in, so
 * it ran out of time and H1 claimed the chip back. Both transactions were read with `cast receipt`
 * that day (status 1, sent by H1 to CrowdPots) and their logs decoded with the launch's ABI. A page
 * reads the pot's state live; this is kept because the logs fall out of the public RPC's reach.
 */
export const POT_HISTORY: { crowdPots: Address; entries: readonly PinnedPot[] } = {
  crowdPots: "0x8C2FfCdcb103659aa05c772b8F2059868B496EB5",
  entries: [
    {
      id: 1,
      opener: H1,
      purpose: "the team's refund drill, with the team's own IMD",
      trail: [
        {
          label: "Opened",
          what: "openPot with a first chip of 0.01 IMD: SpecPinned, PotOpened(1, H1) for a research report with a 1 IMD target and 72 minutes to collect, and ChippedIn(1, H1, 0.01 IMD).",
          tx: {
            hash: "0x74a9a85132fd9e157995fb84400ac87cd17183e102a0dbaa4c70f59a9d3bb4e9",
            block: 26234345,
            at: "2026-10-20T14:18:35Z",
            from: H1,
          },
        },
        {
          label: "Refunded",
          what: "claimRefund(1, H1) after the pot ran out of time unfilled at 15:30:35 UTC: PotSettled(1, Refundable, spent 0, refundable 0.01 IMD), then RefundPaid(1, H1, 0.01 IMD). The chip came back to the wei.",
          tx: {
            hash: "0x61a72aef66a740fd5b8a347d35996f7774bc756088f79ce0745f1b66df125618",
            block: 26234717,
            at: "2026-10-20T15:33:11Z",
            from: H1,
          },
        },
      ],
    },
  ],
};

/** The pinned record of a pot, when the book's CrowdPots is the one it was read from. */
export function pinnedPot(crowdPots: string | null, id: number): PinnedPot | null {
  if (!crowdPots || crowdPots.toLowerCase() !== POT_HISTORY.crowdPots.toLowerCase()) return null;
  return POT_HISTORY.entries.find((e) => e.id === id) ?? null;
}

/** The pinned record of an endowment, when the book's Endowments is the one it was read from. */
export function pinnedEndowment(endowments: string | null, id: number): PinnedEndowment | null {
  if (!endowments || endowments.toLowerCase() !== ENDOWMENT_HISTORY.endowments.toLowerCase()) return null;
  return ENDOWMENT_HISTORY.entries.find((e) => e.id === id) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Verified source, as the explorers show it
// ---------------------------------------------------------------------------------------------

/**
 * What Etherscan and Sourcify showed for each launched contract on 15 October 2026. Etherscan: the
 * contract's code tab (`https://etherscan.io/address/<address>#code`), fetched over HTTP; every one
 * read "Source Code Verified (Exact Match)" with the contract's own name and compiler
 * v0.8.26+commit.8a97fa7a. Sourcify: `GET https://sourcify.dev/server/v2/contract/1/<address>`;
 * CrowdPots answered "match" (verified 13 Oct 2026, 17:48:28 UTC), and Endowments and Zap answered
 * "match" (verified 15 Oct 2026, 15:01:08 and 15:01:56 UTC), creation and runtime code both; the
 * other seven answered 404. Both were read again for all ten at about 16:00 UTC the same day, with
 * the same answers. A page shows a row only for an address the deployments book holds.
 */
export const VERIFIED_SOURCE: {
  checked: string;
  compiler: string;
  contracts: readonly {
    name: string;
    address: Address;
    etherscan: "Exact Match";
    sourcify: "match" | "not found";
  }[];
} = {
  checked: HISTORY_READ_ON,
  compiler: "v0.8.26+commit.8a97fa7a",
  contracts: [
    {
      name: "Questions",
      address: "0xEECE4628ceb091C13393fc64056Be8b8501fD3F6",
      etherscan: "Exact Match",
      sourcify: "not found",
    },
    {
      name: "JobsReport",
      address: "0x58963B57E179f7fE4E95090C21E8e9D75353BCE4",
      etherscan: "Exact Match",
      sourcify: "not found",
    },
    {
      name: "Payroll",
      address: "0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F",
      etherscan: "Exact Match",
      sourcify: "not found",
    },
    {
      name: "WorkProof",
      address: "0xB268297dB06985ba0b806Ba97BcB90364b137469",
      etherscan: "Exact Match",
      sourcify: "not found",
    },
    {
      name: "WorkOrders",
      address: "0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2",
      etherscan: "Exact Match",
      sourcify: "not found",
    },
    {
      name: "CrowdPots",
      address: "0x8C2FfCdcb103659aa05c772b8F2059868B496EB5",
      etherscan: "Exact Match",
      sourcify: "match",
    },
    {
      name: "Doorbell",
      address: "0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb",
      etherscan: "Exact Match",
      sourcify: "not found",
    },
    {
      name: "Rules",
      address: LAUNCH_C_ON_CHAIN.contracts.rules,
      etherscan: "Exact Match",
      sourcify: "not found",
    },
    {
      name: "Endowments",
      address: LAUNCH_C_ON_CHAIN.contracts.endowments,
      etherscan: "Exact Match",
      sourcify: "match",
    },
    {
      name: "Zap",
      address: LAUNCH_C_ON_CHAIN.contracts.zap,
      etherscan: "Exact Match",
      sourcify: "match",
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// What IdentityMD's launch pull requests say about review
// ---------------------------------------------------------------------------------------------

/**
 * IdentityMD's pull request for each launch, read over HTTP (the GitHub API) on 15 October 2026.
 * `reviewer` is the PR body's own sentence, word for word, and `count` the number it gives. No PR
 * has a comment or a review. The findings themselves are in IdentityMD's record of the pipeline job
 * (`record`, a public GET on its API, read the same day): every submission of every review node,
 * each finding with its severity. `accounted` says how the PR's count is made up from that record
 * and which of the findings the pipeline's ADAPTATION.md (in the PR, and the same file in this
 * repository) answers. `document` is our own document that lists every finding with what became of
 * it (for launch A, in its last section), or null while no document of ours does. Launch C's is
 * docs/AUDITS.md, written by the team on 15 October 2026, after the launch.
 *
 * Each launch's entry is shown once the deployments book records that launch.
 */
export const LAUNCH_PRS: readonly {
  launch: "A" | "B" | "C";
  launchNumber: number;
  url: string;
  merged: string;
  reviewer: string;
  count: number;
  record: string;
  document: string | null;
  accounted: string;
}[] = [
  {
    launch: "A",
    launchNumber: 1531,
    url: "https://github.com/identity-md-launches/launch-1531-please-deploy-repository-contracts/pull/1",
    merged: "2026-10-13T10:00:36Z",
    reviewer:
      "An independent reviewer raised 8 finding(s). Those with a concrete reproduction reopened the implementation before this was accepted.",
    count: 8,
    record: "https://api.imd.fun/jobs/d8bb3d81-820d-42f4-ad7c-1d3ed96b1da8/submissions",
    document: "launches/a-payroll/docs/AUDITS.md",
    accounted:
      "IdentityMD's record of the job holds the 8, all in accepted review submissions: 4 from audit_imported_code, 1 from audit_math, 1 from audit_economics, and 2 from audit_judge, which merged them from those two. None was marked blocking. The 4 from audit_imported_code are the findings of the audit the pipeline imported, and ADAPTATION.md answers them (keeper tip, premature closure, fixed signer, escrow claims).",
  },
  {
    launch: "B",
    launchNumber: 1573,
    url: "https://github.com/identity-md-launches/launch-1573-please-deploy-repository-contracts/pull/1",
    merged: "2026-10-13T15:45:14Z",
    reviewer:
      "An independent reviewer raised 11 finding(s). Those with a concrete reproduction reopened the implementation before this was accepted.",
    count: 11,
    record: "https://api.imd.fun/jobs/eb0f6c65-174a-45e8-9fe5-9312c66d4880/submissions",
    document: "launches/b-desk/docs/AUDITS.md",
    accounted:
      "IdentityMD's record of the job holds the 11 in its accepted review submissions: 4 from audit_imported_code, 1 from audit_economics, 2 from audit_flow, 1 from audit_permissions (medium, marked blocking) and 3 from audit_judge's last round (all info). ADAPTATION.md answers 7 of them: the 4 imported entries, and in its section 5 the judge's 3 (a96c4f58, bff72b72, 2094daa9). The judge merged the other 4 into those 3, the medium one from audit_permissions into a96c4f58. The record also holds the judge's first round, a submission that was not accepted: 3 findings, graded 1 medium (marked blocking) and 2 info, which its last round restates as its 3. They are not counted in the 11.",
  },
  {
    launch: "C",
    launchNumber: 1845,
    url: "https://github.com/identity-md-launches/launch-1845-please-deploy-repository-contracts/pull/1",
    merged: "2026-10-15T13:15:34Z",
    reviewer:
      "An independent reviewer raised 13 finding(s). Those with a concrete reproduction reopened the implementation before this was accepted.",
    count: 13,
    record: "https://api.imd.fun/jobs/7f2023fc-fa1f-4a7f-a507-3bbc712c51d6/submissions",
    document: "launches/c-company/docs/AUDITS.md",
    accounted:
      "IdentityMD's record of the job holds the 13, all in accepted review submissions: 3 from audit_imported_code, 2 from audit_permissions, 1 from audit_flow, 1 from audit_math, 1 from audit_economics, and 5 from audit_judge, each merged from one of the 5 that audit_permissions, audit_flow, audit_math and audit_economics raised. Of the 13, 6 are graded low and 7 info, and none was marked blocking. The 3 from audit_imported_code (2 low, 1 info) are the findings of the audit the pipeline imported, and ADAPTATION.md answers them. The other 10 were raised after the pipeline's one adaptation of the code had been accepted, and no node of the job answered them.",
  },
];

// ---------------------------------------------------------------------------------------------
// Protocol features we do not use
// ---------------------------------------------------------------------------------------------

/** Parts of IdentityMD's protocol no contract of ours uses, each with where the choice is written down. */
export const UNUSED_FEATURES: readonly { feature: string; why: string; source: string }[] = [
  {
    feature: "The Intake's failure hook (requestWithFailure, onOracleFailure)",
    why: "Questions asks with plain request and has no onOracleFailure. A round that gets no answer is closed by abandon, by the clock, and anyone may submit an answer the callback missed.",
    source: "launches/a-payroll/docs/DEVIATIONS.md, D2",
  },
  {
    feature: "Merkle receipts (one WorkRegistry root a day for oracle work)",
    why: "WorkProof proves per-job receipts only; it has no Merkle path. An order for oracle work cannot settle on a receipt.",
    source: "launches/b-desk/docs/DEVIATIONS.md, D3",
  },
  {
    feature: "The WorkRegistry's history of superseded receipts",
    why: "prove accepts only the record whose hash latest(jobId) returns.",
    source: "launches/b-desk/docs/DEVIATIONS.md, D4",
  },
  {
    feature: "ERC-8004 identity and reputation registries",
    why: `No contract of ours reads ${MAINNET.IDENTITY_REGISTRY} or ${MAINNET.REPUTATION_REGISTRY}: their addresses appear only as constants in launch A's Mainnet.sol. An agent id from a work record is turned into a seat through the seat Adapter's bindingOf, and its tip is paid to that seat's owner.`,
    source: "the src folders of launches A, B and C, searched on 15 October 2026",
  },
];

/** The pinned record of an order, when the book's desk is the one it was read from. */
export function pinnedOrder(workOrders: string | null, id: number): PinnedOrder | null {
  if (!workOrders || workOrders.toLowerCase() !== ORDER_HISTORY.workOrders.toLowerCase()) return null;
  return ORDER_HISTORY.orders.find((o) => o.id === id) ?? null;
}

/**
 * The pinned tip claims paid to a seat's owner, each with its order, when the book's desk is the one
 * they were read from. Only the orders kept here: not every tip the seat may have been paid.
 */
export function pinnedTipClaims(
  workOrders: string | null,
  tokenId: number,
): (PinnedOrder["tipClaims"][number] & { orderId: number })[] {
  if (!workOrders || workOrders.toLowerCase() !== ORDER_HISTORY.workOrders.toLowerCase()) return [];
  return ORDER_HISTORY.orders.flatMap((order) =>
    order.tipClaims
      .filter((claim) => claim.tokenId === String(tokenId))
      .map((claim) => ({ ...claim, orderId: order.id })),
  );
}

/** The pinned rounds, when the book's Questions is the one they were read from. */
export function pinnedRounds(questions: string | null): readonly PinnedRound[] {
  if (!questions || questions.toLowerCase() !== ROUND_HISTORY.questions.toLowerCase()) return [];
  return ROUND_HISTORY.rounds;
}

/** The pinned print with this index, when the book's JobsReport is the one it was read from. */
export function pinnedPrint(jobsReport: string | null, index: number | null): PinnedPrint | null {
  if (index === null || !jobsReport) return null;
  if (jobsReport.toLowerCase() !== PRINT_HISTORY.jobsReport.toLowerCase()) return null;
  return PRINT_HISTORY.prints.find((p) => p.index === index) ?? null;
}
