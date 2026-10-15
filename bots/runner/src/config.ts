/**
 * Runner configuration: environment variables only, read once at start.
 *
 * The wallet key is never read from a file by this code, never written anywhere and never logged.
 * Dry-run is the default: the runner is live only when `LIVE=1` is set and a key is present. In
 * dry-run no account object is even constructed, so there is nothing in the process that could sign.
 */
import { formatUnits, getAddress, isAddress, parseGwei, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import {
  CHAIN_ID,
  DEPLOYMENT_BOOK,
  DESK,
  IMD_API_BASE,
  JOB_TEMPLATES,
  flattenBook,
  kindHash,
  settleGasNeeded,
  type DeploymentBook,
} from "@help-wanted/shared";
import type { LogLevel } from "./log.js";

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * The ten accounts every local development node (Anvil, Hardhat) starts with. Their keys are
 * printed in the tools' documentation, so anything sent to them on a public chain is taken at
 * once. A live run with one of them is refused unless the node is on this machine (a rehearsal
 * against a local node, which holds nothing real).
 */
export const PUBLISHED_DEV_KEY_ADDRESSES: readonly string[] = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
];

/**
 * Which orders that can be paid on a receipt only are taken:
 * - `never`: none. Only orders whose employer allowed the bonded claim path.
 * - `when-receipts-flow`: only while IdentityMD's WorkRegistry has written a receipt recently
 *   (`RECEIPT_STALL_BLOCKS`). The default.
 * - `always`: also while receipts are stalled. The operator accepts that the bond is forfeited
 *   at the delivery deadline if no receipt lands by then.
 */
export const RECEIPT_ONLY_MODES = ["never", "when-receipts-flow", "always"] as const;
export type ReceiptOnlyMode = (typeof RECEIPT_ONLY_MODES)[number];

export interface RunnerConfig {
  mode: "live" | "dry-run";
  /** Why the runner is not live, in words, for the first log line. */
  dryRunReason: string | null;
  /**
   * Present only in live mode, and only until the account has been built from it: the command
   * line sets it to null right after. Never log it; `createLogger` is given it to redact.
   */
  privateKey: Hex | null;
  /** The runner's address: derived from the key, or `RUNNER_ADDRESS` in a keyless dry run. */
  runner: Address | null;
  /** Always 1: IdentityMD takes payment for jobs on Ethereum mainnet only. */
  chainId: number;
  rpcUrl: string;
  /** True when the node is on this machine: a local rehearsal, never a public chain. */
  rpcIsLocal: boolean;
  workOrders: Address;
  apiBase: string;
  storePath: string;
  killFile: string;
  /** Set by `KILL_SWITCH=1`: make no payment and send no transaction, whatever else is configured. */
  killSwitch: boolean;
  /** The block the desk was deployed in. Required to go live: see `loadConfig`. */
  startBlock: bigint | null;
  confirmations: number;
  logChunkBlocks: bigint;
  pollSeconds: number;
  logLevel: LogLevel;
  /** The paid-request Bearer token, when the operator supplies one. Otherwise one is kept in the store. */
  paidToken: string | null;
  /** In a dry run, also ask the protocol's free preflight what it makes of each job (one POST). */
  dryRunPreflight: boolean;
  /**
   * A live run that stops short of the claim: for each order it would take it asks for the quote
   * and the payment challenge, runs every check on them, and then claims nothing and signs nothing.
   */
  lookOnly: boolean;

  /** Kinds this runner will open jobs for: `keccak256(kind)` to the kind. */
  templates: ReadonlyMap<Hex, string>;
  /** The most IMD the runner pays the swarm in one UTC day. */
  dailyCap: bigint;
  /** The most IMD the runner pays the swarm for one order, over all its attempts. */
  orderCap: bigint;
  /** The largest bond the runner posts. */
  maxBond: bigint;
  /** The most IMD the runner has posted as bonds at any one time, over all the orders it holds. */
  maxBondsAtRisk: bigint;
  /** What must be left of the runner's pay after the swarm's fee and the allowance for failures. */
  minMargin: bigint;
  /**
   * How often, in ten-thousandths, the runner expects an order to end with its bond and fee lost.
   * The price must cover that share of (bond + fee) on top of the margin.
   */
  failureBps: bigint;
  /** Orders the runner holds at once. */
  maxConcurrent: number;
  /** Which orders that only a receipt can pay are taken. See `RECEIPT_ONLY_MODES`. */
  receiptOnlyOrders: ReceiptOnlyMode;
  /** Receipts count as stalled when the WorkRegistry wrote none in this many blocks. */
  receiptStallBlocks: number;
  /** Latch the condition of an order (`trigger`) so that its price ramp starts. */
  latchConditions: boolean;
  /** After an unproven finalize, mark the order proven (`stamp`) when its receipt lands. */
  stampAfterFinalize: boolean;
  /** How long after a finalize the receipt is still looked for, in seconds. */
  stampWatchSeconds: number;
  /**
   * How long after the delivery deadline of a challenged claim the runner waits for a receipt
   * before it ends the claim itself (`timeout`) and takes back nine tenths of its bond.
   */
  disputeTimeoutAfter: number;
  /** Arbiters the runner accepts. Orders with any other arbiter are left alone. */
  arbiters: ReadonlySet<string>;
  /** When not empty, the only employers whose orders are taken. */
  employers: ReadonlySet<string>;
  /** After this many lost bonds on one employer's orders, that employer's orders are left alone. */
  maxEmployerLosses: number;
  /** The lowest remaining lifetime, in seconds, an order must have to be taken. */
  minOrderLifetime: number;
  /** Payments in a row that may end without a job, after a claim, before the runner stops claiming. */
  maxPayFailures: number;
  /** How many jobs the runner will buy for one claim: 1 means a blocked job is never bought again. */
  maxJobsPerOrder: number;
  /** Register the job the moment it is admitted, instead of holding back while it can still be released. */
  registerAtOnce: boolean;
  /** How long the job's newest record must have stayed the newest before delivery is claimed on it. */
  claimSettleSeconds: number;
  /** The largest record the runner will carry in a `settle` transaction, in bytes. */
  maxSettleRecordBytes: number;
  /** The most gas the runner sends a `settle`, `stamp` or `reportFailed` with. */
  maxSettleGas: bigint;
  /** Fields the protocol may add, with a value, to the job it prepares from what was sent. */
  preparedInputExtraKeys: readonly string[];

  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxTxCost: bigint;
  /** The fee cap and cost limit for the calls that protect a bond. */
  urgentMaxFeePerGas: bigint;
  urgentMaxTxCost: bigint;
  /** The ETH the wallet must hold before a new order is claimed. */
  minGasBalance: bigint;
  /** What `bootstrap` approves Permit2 for. */
  permit2Allowance: bigint;
}

function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function imd(env: Env, name: string, fallback: string): bigint {
  const text = read(env, name) ?? fallback;
  if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(text))
    throw new ConfigError(`${name} must be an IMD amount such as 0.5`);
  return parseUnits(text, 18);
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const text = read(env, name);
  if (text === undefined) return fallback;
  if (!/^[0-9]+$/.test(text)) throw new ConfigError(`${name} must be a whole number`);
  const n = Number(text);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const text = read(env, name);
  if (text === undefined) return fallback;
  if (text === "1" || text === "true") return true;
  if (text === "0" || text === "false") return false;
  throw new ConfigError(`${name} must be 1 or 0`);
}

function address(env: Env, name: string): Address | undefined {
  const text = read(env, name);
  if (text === undefined) return undefined;
  if (!isAddress(text, { strict: false })) throw new ConfigError(`${name} is not an address`);
  return getAddress(text);
}

function addressSet(env: Env, name: string): Set<string> {
  const out = new Set<string>();
  for (const part of (read(env, name) ?? "").split(",")) {
    const text = part.trim();
    if (text === "") continue;
    if (!isAddress(text, { strict: false }))
      throw new ConfigError(`${name} holds something that is not an address`);
    out.add(getAddress(text));
  }
  return out;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Settings that used to exist and no longer do. Setting one is an error, not a silent no-op. */
const REMOVED: Readonly<Record<string, string>> = {
  IMD: "the token is IMD on Ethereum mainnet and cannot be pointed elsewhere",
  WORK_REGISTRY:
    "the registry is IdentityMD's WorkRegistry on Ethereum mainnet and cannot be pointed elsewhere",
  REQUIRE_CLAIMED_PATH:
    "use RECEIPT_ONLY_ORDERS: never (what REQUIRE_CLAIMED_PATH=1 was), when-receipts-flow (the default) or always",
};

/**
 * Reads the configuration. Throws `ConfigError`, whose message never contains a secret. The desk's
 * address, when the environment does not give it, is taken from `book`, the deployments book.
 */
export function loadConfig(env: Env, book: DeploymentBook = DEPLOYMENT_BOOK): RunnerConfig {
  for (const [name, why] of Object.entries(REMOVED)) {
    if (read(env, name) !== undefined) throw new ConfigError(`${name} is no longer a setting: ${why}`);
  }

  const keyText = read(env, "RUNNER_PRIVATE_KEY");
  let privateKey: Hex | null = null;
  let keyAddress: Address | null = null;
  if (keyText !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(keyText)) {
      throw new ConfigError("RUNNER_PRIVATE_KEY must be 0x followed by 64 hex characters");
    }
    privateKey = keyText as Hex;
    keyAddress = privateKeyToAddress(privateKey);
  }

  const liveText = read(env, "LIVE");
  if (liveText !== undefined && liveText !== "1" && liveText !== "0") {
    throw new ConfigError("LIVE must be 1 or 0");
  }
  const wantsLive = liveText === "1";
  let dryRunReason: string | null = null;
  if (!wantsLive) dryRunReason = "LIVE=1 is not set";
  else if (privateKey === null) dryRunReason = "LIVE=1 is set but RUNNER_PRIVATE_KEY is not";
  const mode = dryRunReason === null ? "live" : "dry-run";

  const declared = address(env, "RUNNER_ADDRESS");
  if (declared !== undefined && keyAddress !== null && declared !== keyAddress) {
    throw new ConfigError("RUNNER_ADDRESS does not belong to RUNNER_PRIVATE_KEY");
  }
  const runner = keyAddress ?? declared ?? null;

  const workOrders = address(env, "WORK_ORDERS") ?? flattenBook(book).workOrders ?? undefined;
  if (workOrders === undefined) {
    throw new ConfigError(
      "WORK_ORDERS is not set: give the address of the hire desk (the WorkOrders contract)",
    );
  }

  const chainText = read(env, "CHAIN_ID");
  if (chainText !== undefined && chainText !== String(CHAIN_ID)) {
    throw new ConfigError("CHAIN_ID must be 1: IdentityMD takes payment for jobs on Ethereum mainnet only");
  }

  const rpcUrl = read(env, "RPC_URL") ?? "https://ethereum-rpc.publicnode.com";
  const apiBase = (read(env, "IMD_API") ?? IMD_API_BASE).replace(/\/+$/, "");
  let rpcIsLocal = false;
  for (const [name, url] of [
    ["RPC_URL", rpcUrl],
    ["IMD_API", apiBase],
  ] as const) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConfigError(`${name} is not a URL`);
    }
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !local) throw new ConfigError(`${name} must use https`);
    if (name === "RPC_URL") rpcIsLocal = local;
  }

  if (
    mode === "live" &&
    keyAddress !== null &&
    PUBLISHED_DEV_KEY_ADDRESSES.includes(keyAddress) &&
    !rpcIsLocal
  ) {
    throw new ConfigError(
      "RUNNER_PRIVATE_KEY is a published development key; refusing to run live with it on a public chain",
    );
  }

  // One kind by default. Audit orders are opt-in: the employer names the code that is audited,
  // and an audit's record is too large to settle in one transaction.
  const kinds = (read(env, "TEMPLATES") ?? "skill:research-report").split(",").map((k) => k.trim());
  const templates = new Map<Hex, string>();
  for (const kind of kinds) {
    if (!(kind in JOB_TEMPLATES)) {
      throw new ConfigError(
        `TEMPLATES names "${kind}", which is not one of: ${Object.keys(JOB_TEMPLATES).join(", ")}`,
      );
    }
    templates.set(kindHash(kind), kind);
  }

  const paidToken = read(env, "IMD_PAID_TOKEN") ?? null;
  if (paidToken !== null && !/^[0-9a-f]{64}$/.test(paidToken)) {
    throw new ConfigError("IMD_PAID_TOKEN must be 64 lowercase hex characters");
  }

  const levelText = read(env, "LOG_LEVEL") ?? "info";
  if (!(LOG_LEVELS as readonly string[]).includes(levelText)) {
    throw new ConfigError(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
  }

  const extraKeys = (read(env, "PREPARED_INPUT_EXTRA_KEYS") ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  for (const key of extraKeys) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))
      throw new ConfigError("PREPARED_INPUT_EXTRA_KEYS holds something that is not a field name");
  }

  const storePath = read(env, "STORE_PATH") ?? "./data/runner.json";
  const startText = read(env, "START_BLOCK");
  if (startText !== undefined && !/^[0-9]+$/.test(startText))
    throw new ConfigError("START_BLOCK must be a block number");
  if (mode === "live" && startText === undefined) {
    // With it, a runner whose store was lost finds every order again, the ones it holds included.
    // Without it only the last few thousand blocks would be read, and an older order this wallet
    // has a bond on would never be looked at.
    throw new ConfigError(
      "START_BLOCK is not set: to go live, give the block the desk was deployed in, so that an empty " +
        "store can find again every order this wallet holds",
    );
  }
  const receiptOnlyText = read(env, "RECEIPT_ONLY_ORDERS") ?? "when-receipts-flow";
  if (!(RECEIPT_ONLY_MODES as readonly string[]).includes(receiptOnlyText)) {
    throw new ConfigError(`RECEIPT_ONLY_ORDERS must be one of: ${RECEIPT_ONLY_MODES.join(", ")}`);
  }

  const feeText = read(env, "MAX_FEE_GWEI") ?? "3";
  const tipText = read(env, "MAX_PRIORITY_FEE_GWEI") ?? "0.1";
  // Three million gas (a settlement's limit) at the fee cap of 3 gwei is 0.009 ETH.
  const costText = read(env, "MAX_TX_COST_ETH") ?? "0.01";
  const urgentFeeText = read(env, "URGENT_MAX_FEE_GWEI") ?? "30";
  const urgentCostText = read(env, "URGENT_MAX_TX_COST_ETH") ?? "0.02";
  const gasText = read(env, "MIN_ETH_BALANCE") ?? "0.003";
  for (const [name, text] of [
    ["MAX_FEE_GWEI", feeText],
    ["MAX_PRIORITY_FEE_GWEI", tipText],
    ["MAX_TX_COST_ETH", costText],
    ["URGENT_MAX_FEE_GWEI", urgentFeeText],
    ["URGENT_MAX_TX_COST_ETH", urgentCostText],
    ["MIN_ETH_BALANCE", gasText],
  ] as const) {
    if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) throw new ConfigError(`${name} must be a number`);
  }

  const config: RunnerConfig = {
    mode,
    dryRunReason,
    privateKey: mode === "live" ? privateKey : null,
    runner,
    chainId: CHAIN_ID,
    rpcUrl,
    rpcIsLocal,
    workOrders,
    apiBase,
    storePath,
    killFile: read(env, "KILL_FILE") ?? `${storePath}.KILL`,
    killSwitch: flag(env, "KILL_SWITCH", false),
    startBlock: startText === undefined ? null : BigInt(startText),
    confirmations: integer(env, "CONFIRMATIONS", 2, 0, 64),
    logChunkBlocks: BigInt(integer(env, "LOG_CHUNK_BLOCKS", 2000, 1, 50_000)),
    pollSeconds: integer(env, "POLL_SECONDS", 60, 5, 3600),
    logLevel: levelText as LogLevel,
    paidToken,
    dryRunPreflight: flag(env, "DRY_RUN_PREFLIGHT", false),
    lookOnly: flag(env, "LOOK_ONLY", false),
    templates,
    dailyCap: imd(env, "DAILY_CAP_IMD", "2"),
    orderCap: imd(env, "ORDER_CAP_IMD", "0.5"),
    // The desk's minimum. A bond is what an order can cost on top of the fee.
    maxBond: imd(env, "MAX_BOND_IMD", "0.25"),
    maxBondsAtRisk: imd(env, "MAX_BONDS_AT_RISK_IMD", "1"),
    minMargin: imd(env, "MIN_MARGIN_IMD", "0.05"),
    failureBps: BigInt(integer(env, "EXPECTED_FAILURE_BPS", 500, 0, 10_000)),
    maxConcurrent: integer(env, "MAX_CONCURRENT", 2, 1, 50),
    receiptOnlyOrders: receiptOnlyText as ReceiptOnlyMode,
    // 1,800 blocks are six hours: the test the desk's own documents use for stalled receipts.
    receiptStallBlocks: integer(env, "RECEIPT_STALL_BLOCKS", 1800, 10, 8_000),
    latchConditions: flag(env, "LATCH_CONDITIONS", true),
    stampAfterFinalize: flag(env, "STAMP_AFTER_FINALIZE", true),
    stampWatchSeconds: integer(env, "STAMP_WATCH_DAYS", 30, 0, 365) * 86_400,
    disputeTimeoutAfter: integer(env, "DISPUTE_TIMEOUT_AFTER_SECONDS", 86_400, 0, 30 * 86_400),
    arbiters: addressSet(env, "ARBITERS"),
    employers: addressSet(env, "EMPLOYERS"),
    maxEmployerLosses: integer(env, "MAX_EMPLOYER_LOSSES", 1, 1, 1000),
    minOrderLifetime: integer(env, "MIN_ORDER_LIFETIME_SECONDS", 7200, 0, 31_536_000),
    maxPayFailures: integer(env, "MAX_PAY_FAILURES", 2, 1, 100),
    maxJobsPerOrder: integer(env, "MAX_JOBS_PER_ORDER", 1, 1, 5),
    registerAtOnce: flag(env, "REGISTER_AT_ONCE", false),
    claimSettleSeconds: integer(env, "CLAIM_SETTLE_SECONDS", 600, 0, 86_400),
    // A node refuses a transaction above 128 KB, and every record byte costs at least 40 gas.
    maxSettleRecordBytes: integer(env, "MAX_SETTLE_RECORD_BYTES", 100_000, 1_000, 120_000),
    // What the desk's documents say to send a settlement with. An estimate decides the limit
    // actually sent; this is the most the runner will go to.
    maxSettleGas: BigInt(integer(env, "MAX_SETTLE_GAS", 3_000_000, 1_500_000, 16_000_000)),
    preparedInputExtraKeys: extraKeys,
    maxFeePerGas: parseGwei(feeText),
    maxPriorityFeePerGas: parseGwei(tipText),
    maxTxCost: parseUnits(costText, 18),
    urgentMaxFeePerGas: parseGwei(urgentFeeText),
    urgentMaxTxCost: parseUnits(urgentCostText, 18),
    minGasBalance: parseUnits(gasText, 18),
    permit2Allowance: imd(env, "PERMIT2_ALLOWANCE_IMD", "5"),
  };
  if (config.maxPriorityFeePerGas > config.maxFeePerGas) {
    throw new ConfigError("MAX_PRIORITY_FEE_GWEI is above MAX_FEE_GWEI");
  }
  if (config.urgentMaxFeePerGas < config.maxFeePerGas) {
    throw new ConfigError("URGENT_MAX_FEE_GWEI is below MAX_FEE_GWEI");
  }
  if (config.urgentMaxTxCost < config.maxTxCost) {
    throw new ConfigError("URGENT_MAX_TX_COST_ETH is below MAX_TX_COST_ETH");
  }
  if (config.maxBond < DESK.MIN_BOND) {
    throw new ConfigError(
      "MAX_BOND_IMD is below the desk's minimum bond of 0.25 IMD: no order could be taken",
    );
  }
  if (config.maxBondsAtRisk < config.maxBond) {
    throw new ConfigError("MAX_BONDS_AT_RISK_IMD is below MAX_BOND_IMD");
  }
  // A settlement is how the runner is paid. If the cost limit would refuse one at the fee cap,
  // every order would end on the slower claimed path, or not at all on a receipt-only order.
  if (config.maxSettleGas * config.maxFeePerGas > config.maxTxCost) {
    throw new ConfigError(
      `MAX_TX_COST_ETH is below what a settlement may cost at the fee cap: MAX_SETTLE_GAS (${config.maxSettleGas}) ` +
        `times MAX_FEE_GWEI is ${formatUnits(config.maxSettleGas * config.maxFeePerGas, 18)} ETH. ` +
        "Raise MAX_TX_COST_ETH, or lower MAX_FEE_GWEI or MAX_SETTLE_GAS",
    );
  }
  // The smallest real record of any kind this runner opens must fit its own gas limit.
  for (const kind of config.templates.values()) {
    const template = JOB_TEMPLATES[kind];
    if (template !== undefined && !template.largeRecords) {
      const needed = settleGasNeeded(template.largestRecordSeen);
      if (needed > config.maxSettleGas) {
        throw new ConfigError(
          `MAX_SETTLE_GAS (${config.maxSettleGas}) is below the ${needed} gas a record of kind ${kind} has needed: ` +
            "no such order could be settled",
        );
      }
    }
  }
  return config;
}

/** The configuration as it may be printed: everything except the key, the token and the RPC URL. */
export function describeConfig(config: RunnerConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    dryRunReason: config.dryRunReason,
    runner: config.runner,
    chainId: config.chainId,
    rpcHost: new URL(config.rpcUrl).host,
    workOrders: config.workOrders,
    apiBase: config.apiBase,
    storePath: config.storePath,
    startBlock: config.startBlock?.toString() ?? null,
    killSwitch: config.killSwitch,
    templates: [...config.templates.values()],
    dailyCap: config.dailyCap.toString(),
    orderCap: config.orderCap.toString(),
    maxBond: config.maxBond.toString(),
    maxBondsAtRisk: config.maxBondsAtRisk.toString(),
    minMargin: config.minMargin.toString(),
    failureBps: config.failureBps.toString(),
    maxConcurrent: config.maxConcurrent,
    receiptOnlyOrders: config.receiptOnlyOrders,
    receiptStallBlocks: config.receiptStallBlocks,
    latchConditions: config.latchConditions,
    stampAfterFinalize: config.stampAfterFinalize,
    maxSettleGas: config.maxSettleGas.toString(),
    arbiters: [...config.arbiters],
    employers: [...config.employers],
    maxJobsPerOrder: config.maxJobsPerOrder,
    registerAtOnce: config.registerAtOnce,
    lookOnly: config.lookOnly,
    maxFeePerGas: config.maxFeePerGas.toString(),
    maxTxCost: config.maxTxCost.toString(),
    urgentMaxFeePerGas: config.urgentMaxFeePerGas.toString(),
    urgentMaxTxCost: config.urgentMaxTxCost.toString(),
    operatorTokenSet: config.paidToken !== null,
  };
}
