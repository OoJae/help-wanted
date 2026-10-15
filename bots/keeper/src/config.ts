/**
 * Keeper configuration: environment variables only, read once at start.
 *
 * The safety model is the runner's. The wallet key is never read from a file by this code, never
 * written anywhere and never logged. Dry-run is the default: the keeper is live only when `LIVE=1`
 * is set and a key is present. In dry-run no account object is even constructed, so there is
 * nothing in the process that could sign.
 *
 * Everything the keeper calls is open to any caller, so its key guards nothing but the ETH it
 * holds for gas (and, on the first day only, the IMD its wallet puts on the meters).
 */
import { getAddress, isAddress, parseGwei, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import {
  CHAIN_ID,
  DEPLOYMENT_BOOK,
  HOUSE_FEEDS,
  IMD_API_BASE,
  MAINNET,
  isHouseFeedName,
  flattenBook,
  launchBlock,
  type DeploymentBook,
  type HouseFeed,
} from "@help-wanted/shared";
import type { LogLevel } from "./log.js";
import { BUILT_MODULES, MODULE_LAUNCH, type ModuleName } from "./modules/names.js";

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
 * once. A live run with one of them is refused unless the node is on this machine.
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

/** The addresses a deployment of launch A must have been built on, checked on the first day. */
export interface ExpectedDeployment {
  intake: Address;
  imd: Address;
  oracleSigner: Address;
}

export interface KeeperConfig {
  mode: "live" | "dry-run";
  /** Why the keeper is not live, in words, for the first log line. */
  dryRunReason: string | null;
  /**
   * Present only in live mode, and only until the account has been built from it: the command
   * line sets it to null right after. Never log it; `createLogger` is given it to redact.
   */
  privateKey: Hex | null;
  /** The keeper's address: derived from the key, or `KEEPER_ADDRESS` in a keyless dry run. */
  keeper: Address | null;
  chainId: number;
  rpcUrl: string;
  /** True when the node is on this machine: a local rehearsal, never a public chain. */
  rpcIsLocal: boolean;
  /** Send the reads of a pass to the node as JSON-RPC batches. Off for a node that refuses them. */
  rpcBatch: boolean;
  apiBase: string;
  /** The least time between two requests to IdentityMD's API, in milliseconds. */
  apiMinIntervalMs: number;

  /** Launch A. Null until the launch is written into the deployments book or given here. */
  questions: Address | null;
  jobsReport: Address | null;
  payroll: Address | null;
  expected: ExpectedDeployment;
  /** Launch B. Null until the launch is written into the deployments book or given here. */
  workOrders: Address | null;
  crowdPots: Address | null;
  doorbell: Address | null;
  /** Launch C. */
  rules: Address | null;
  endowments: Address | null;
  /**
   * The blocks launches B and C were mined in: where the pots' and the rules' logs are read from.
   * Null when neither the deployments book nor the environment says; the logs are then read from
   * `logLookbackBlocks` behind the head, which misses anything older.
   */
  startBlockB: bigint | null;
  startBlockC: bigint | null;
  logLookbackBlocks: number;

  /** Which modules run. Each is switched on or off by name. */
  modules: ReadonlySet<ModuleName>;
  /** The feeds the questions module keeps: house feeds, by name, in the order they are asked. */
  feeds: readonly HouseFeed[];

  statePath: string;
  statusPath: string;
  killFile: string;
  /** Set by `KILL_SWITCH=1`: send no transaction, whatever else is configured. */
  killSwitch: boolean;
  pollSeconds: number;
  /** How many times one pass looks again after sending something, so a chain of steps finishes. */
  maxRounds: number;
  logLevel: LogLevel;

  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The most one transaction may cost: gas limit times the fee ceiling, in wei. */
  maxTxCost: bigint;
  /** The most ETH the keeper spends on gas in one UTC day, in wei. */
  dailySpendCap: bigint;
  /** Below this ETH balance the status file asks for attention. Nothing is blocked by it. */
  minEthBalance: bigint;

  /** Collect earned tips once they reach this much IMD. */
  tipCollectMin: bigint;
  /**
   * Close a round past the contract's silence deadline (36 hours, 5 minutes and one second after
   * the request for the house feeds) even though IdentityMD's service still shows its request as
   * being worked on or completing. Off by default: such a round's answer may be on its
   * way, and an answer that arrives after its round was closed is refused.
   */
  closeRoundsInProgress: boolean;
  /** A signed answer is handed in only while it has at least this many seconds of validity left. */
  expiryMarginSeconds: number;
  /** Ask the feeds at this time of day (seconds after midnight UTC), or null for as soon as due. */
  requestAtUtc: number | null;

  /** Book plain transfers once this much IMD is waiting. */
  bookMin: bigint;
  /** The least time between two drips this keeper sends, in seconds. */
  dripEverySeconds: number;
  /** Call `fundFeeds` once a meter is at least this far below its runway. */
  fundFeedsMin: bigint;

  // ---- The desk (launch B) ----
  /**
   * The most IMD the keeper has posted as challenge bonds at one time. Zero, the default, means it
   * never challenges a delivery claim: it only reports what it found.
   */
  challengeFloat: bigint;
  /** The most IMD the keeper posts as challenge bonds in one UTC day. */
  challengeDailyCap: bigint;
  /** Arbiters accepted on an order the keeper challenges, lowercase. */
  challengeArbiters: ReadonlySet<string>;
  /** Employers whose orders the keeper posts challenge bonds for, lowercase. Empty: any employer. */
  challengeEmployers: ReadonlySet<string>;
  /** How long a claim must have been seen failing the check before it is challenged, in seconds. */
  challengeConfirmSeconds: number;
  /** Runners the keeper never evicts or times out, lowercase: the operator's own. */
  ownRunners: ReadonlySet<string>;
  /** The largest record carried in a `settle`, `stamp` or `reportFailed`, in bytes. */
  maxRecordBytes: number;
  /** Send `finalize` for delivery claims that passed the check and stood unchallenged. */
  finalizeClaims: boolean;
  /** Send `settle` for any order whose receipt has landed. */
  settleReceipts: boolean;
  /** The most orders, pots, rules and endowments read in one pass. */
  maxItems: number;
  /** Receipts count as stalled when the WorkRegistry wrote none in this many blocks. */
  receiptStallBlocks: number;
  /** How long an order paid on a claim is watched for its receipt, in seconds. */
  stampWatchSeconds: number;

  // ---- Crowd pots (launch B) ----
  /** The most contributors paid in one `claimRefunds` call. */
  potsRefundBatch: number;
  /** A refund below this is left for its contributor to claim. */
  potsRefundMin: bigint;

  // ---- Rules (launch C) ----
  /** Rule ids always fired when they can be, whatever their tip. */
  houseRules: ReadonlySet<string>;
  /** What one ETH is worth in IMD (IMD-wei per ETH), by the operator's figure; null when not given. */
  imdPerEth: bigint | null;
  /** A tip must cover the gas this many times over, in ten-thousandths. */
  tipCoverBps: bigint;

  // ---- Endowments (launch C) ----
  /** Stake once at least this much IMD waits in the buffer. */
  stakeMin: bigint;
  /** Harvest an endowment once at least this much IMD can be sent to its target. */
  harvestMin: bigint;

  /** First day: what to put on each meter, by feed name. Null means the feed's runway at the live cost. */
  firstDayFund: Readonly<Record<string, bigint | null>>;
  /** First day: the plan digest the operator confirmed after reading the dry run. */
  firstDayConfirm: string | null;
}

function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function imd(env: Env, name: string, fallback: string): bigint {
  const text = read(env, name) ?? fallback;
  if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(text)) {
    throw new ConfigError(`${name} must be an IMD amount such as 0.5`);
  }
  return parseUnits(text, 18);
}

function optionalImd(env: Env, name: string): bigint | null {
  return read(env, name) === undefined ? null : imd(env, name, "0");
}

function eth(env: Env, name: string, fallback: string): bigint {
  const text = read(env, name) ?? fallback;
  if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(text))
    throw new ConfigError(`${name} must be an ETH amount such as 0.01`);
  return parseUnits(text, 18);
}

function gwei(env: Env, name: string, fallback: string): bigint {
  const text = read(env, name) ?? fallback;
  if (!/^[0-9]+(\.[0-9]{1,9})?$/.test(text)) throw new ConfigError(`${name} must be a number of gwei`);
  return parseGwei(text);
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
    if (!isAddress(text, { strict: false })) {
      throw new ConfigError(`${name} holds something that is not an address`);
    }
    out.add(text.toLowerCase());
  }
  return out;
}

function block(env: Env, name: string): bigint | null {
  const text = read(env, name);
  if (text === undefined) return null;
  if (!/^[0-9]+$/.test(text)) throw new ConfigError(`${name} must be a block number`);
  return BigInt(text);
}

function list(env: Env, name: string, fallback: string): string[] {
  return (read(env, name) ?? fallback)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** "HH:MM" to seconds after midnight. */
export function parseTimeOfDay(text: string): number | null {
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Reads the configuration. Throws `ConfigError`, whose message never contains a secret. An address
 * the environment does not give is taken from `book`, the deployments book.
 */
export function loadConfig(env: Env, book: DeploymentBook = DEPLOYMENT_BOOK): KeeperConfig {
  const deployments = flattenBook(book);
  const keyText = read(env, "KEEPER_PRIVATE_KEY");
  let privateKey: Hex | null = null;
  let keyAddress: Address | null = null;
  if (keyText !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(keyText)) {
      throw new ConfigError("KEEPER_PRIVATE_KEY must be 0x followed by 64 hex characters");
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
  else if (privateKey === null) dryRunReason = "LIVE=1 is set but KEEPER_PRIVATE_KEY is not";
  const mode = dryRunReason === null ? "live" : "dry-run";

  const chainText = read(env, "CHAIN_ID");
  if (chainText !== undefined && chainText !== String(CHAIN_ID)) {
    throw new ConfigError("CHAIN_ID must be 1: launch A lives on Ethereum mainnet");
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
      "KEEPER_PRIVATE_KEY is a published development key; refusing to run live with it on a public chain",
    );
  }

  const declared = address(env, "KEEPER_ADDRESS");
  if (declared !== undefined && keyAddress !== null && declared !== keyAddress) {
    throw new ConfigError("KEEPER_ADDRESS does not belong to KEEPER_PRIVATE_KEY");
  }
  const keeper = keyAddress ?? declared ?? null;

  const questions = address(env, "QUESTIONS") ?? deployments.questions;
  const jobsReport = address(env, "JOBS_REPORT") ?? deployments.jobsReport;
  const payroll = address(env, "PAYROLL") ?? deployments.payroll;
  const workOrders = address(env, "WORK_ORDERS") ?? deployments.workOrders;
  const crowdPots = address(env, "CROWD_POTS") ?? deployments.crowdPots;
  const doorbell = address(env, "DOORBELL") ?? deployments.doorbell;
  const rules = address(env, "RULES") ?? deployments.rules;
  const endowments = address(env, "ENDOWMENTS") ?? deployments.endowments;

  // What each module needs to know before it can run.
  const needs: Record<ModuleName, [string, Address | null][]> = {
    questions: [["QUESTIONS", questions]],
    jobsReport: [
      ["JOBS_REPORT", jobsReport],
      ["QUESTIONS", questions],
    ],
    payroll: [["PAYROLL", payroll]],
    desk: [["WORK_ORDERS", workOrders]],
    pots: [["CROWD_POTS", crowdPots]],
    doorbell: [["DOORBELL", doorbell]],
    rules: [
      ["RULES", rules],
      ["WORK_ORDERS", workOrders],
    ],
    endowments: [["ENDOWMENTS", endowments]],
  };
  const modules = new Set<ModuleName>();
  const named = read(env, "MODULES");
  if (named === undefined) {
    // Unset: every module of launch A, as before, and every later module whose contracts are known.
    for (const name of BUILT_MODULES) {
      const launchA = name === "questions" || name === "jobsReport" || name === "payroll";
      if (launchA || needs[name].every(([, value]) => value !== null)) modules.add(name);
    }
  } else {
    for (const name of list(env, "MODULES", "")) {
      if (!(BUILT_MODULES as readonly string[]).includes(name)) {
        throw new ConfigError(`MODULES names "${name}", which is not one of: ${BUILT_MODULES.join(", ")}`);
      }
      modules.add(name as ModuleName);
    }
  }

  const feeds: HouseFeed[] = [];
  for (const name of list(env, "FEEDS", "payrolls,hires,employers")) {
    if (!isHouseFeedName(name)) {
      throw new ConfigError(`FEEDS names "${name}", which is not one of: payrolls, hires, employers`);
    }
    if (!feeds.some((feed) => feed.name === name)) feeds.push(HOUSE_FEEDS[name]);
  }

  for (const module of modules) {
    for (const [name, value] of needs[module]) {
      if (value === null) {
        throw new ConfigError(
          `${name} is not set: the ${module} module needs the address launch ${MODULE_LAUNCH[module]} created (or switch the module off with MODULES)`,
        );
      }
    }
  }

  const houseRules = new Set<string>();
  for (const id of list(env, "RULES_HOUSE", "")) {
    if (!/^[1-9][0-9]*$/.test(id)) throw new ConfigError("RULES_HOUSE must be rule ids, comma-separated");
    houseRules.add(id);
  }
  const rateText = read(env, "RULES_IMD_PER_ETH");
  let imdPerEth: bigint | null = null;
  if (rateText !== undefined) {
    if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(rateText) || Number(rateText) <= 0) {
      throw new ConfigError("RULES_IMD_PER_ETH must be a number above zero: how many IMD one ETH is worth");
    }
    imdPerEth = parseUnits(rateText, 18);
  }

  const levelText = read(env, "LOG_LEVEL") ?? "info";
  if (!(LOG_LEVELS as readonly string[]).includes(levelText)) {
    throw new ConfigError(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
  }

  const atText = read(env, "REQUEST_AT_UTC");
  let requestAtUtc: number | null = null;
  if (atText !== undefined) {
    requestAtUtc = parseTimeOfDay(atText);
    if (requestAtUtc === null) throw new ConfigError("REQUEST_AT_UTC must be a time of day such as 14:00");
  }

  const confirm = read(env, "FIRST_DAY_CONFIRM") ?? null;
  if (confirm !== null && !/^0x[0-9a-f]{64}$/.test(confirm)) {
    throw new ConfigError(
      "FIRST_DAY_CONFIRM must be the plan digest the dry run printed (0x and 64 hex characters)",
    );
  }

  const statePath = read(env, "STATE_PATH") ?? "./data/keeper.json";
  const config: KeeperConfig = {
    mode,
    dryRunReason,
    privateKey: mode === "live" ? privateKey : null,
    keeper,
    chainId: CHAIN_ID,
    rpcUrl,
    rpcIsLocal,
    rpcBatch: flag(env, "RPC_BATCH", true),
    apiBase,
    apiMinIntervalMs: integer(env, "API_MIN_INTERVAL_MS", 2100, 0, 60_000),
    questions,
    jobsReport,
    payroll,
    expected: { intake: MAINNET.INTAKE, imd: MAINNET.IMD, oracleSigner: MAINNET.ORACLE_SIGNER },
    workOrders,
    crowdPots,
    doorbell,
    rules,
    endowments,
    startBlockB: block(env, "START_BLOCK_B") ?? launchBlock("b", book),
    startBlockC: block(env, "START_BLOCK_C") ?? launchBlock("c", book),
    logLookbackBlocks: integer(env, "LOG_LOOKBACK_BLOCKS", 8_000, 1, 10_000_000),
    modules,
    feeds,
    statePath,
    statusPath: read(env, "STATUS_PATH") ?? "./data/keeper-status.json",
    killFile: read(env, "KILL_FILE") ?? `${statePath}.KILL`,
    killSwitch: flag(env, "KILL_SWITCH", false),
    pollSeconds: integer(env, "POLL_SECONDS", 300, 10, 86_400),
    maxRounds: integer(env, "MAX_ROUNDS", 4, 1, 12),
    logLevel: levelText as LogLevel,
    maxFeePerGas: gwei(env, "MAX_FEE_GWEI", "5"),
    maxPriorityFeePerGas: gwei(env, "MAX_PRIORITY_FEE_GWEI", "0.1"),
    // A settlement on the desk must be offered about two million gas (it uses about half a
    // million): at the fee cap of 5 gwei that is 0.0104 ETH.
    maxTxCost: eth(env, "MAX_TX_COST_ETH", "0.02"),
    dailySpendCap: eth(env, "DAILY_SPEND_CAP_ETH", "0.05"),
    minEthBalance: eth(env, "MIN_ETH_BALANCE", "0.01"),
    tipCollectMin: imd(env, "TIP_COLLECT_MIN_IMD", "0.5"),
    closeRoundsInProgress: flag(env, "CLOSE_ROUNDS_IN_PROGRESS", false),
    expiryMarginSeconds: integer(env, "ATTESTATION_EXPIRY_MARGIN_SECONDS", 120, 0, 3600),
    requestAtUtc,
    bookMin: imd(env, "BOOK_MIN_IMD", "1"),
    dripEverySeconds: integer(env, "DRIP_EVERY_SECONDS", 3600, 600, 604_800),
    fundFeedsMin: imd(env, "FUND_FEEDS_MIN_IMD", "1.1"),
    challengeFloat: imd(env, "CHALLENGE_FLOAT_IMD", "0"),
    challengeDailyCap: imd(env, "CHALLENGE_DAILY_CAP_IMD", "0"),
    challengeArbiters: addressSet(env, "CHALLENGE_ARBITERS"),
    challengeEmployers: addressSet(env, "CHALLENGE_EMPLOYERS"),
    challengeConfirmSeconds: integer(env, "CHALLENGE_CONFIRM_SECONDS", 900, 0, 43_200),
    ownRunners: addressSet(env, "DESK_OWN_RUNNERS"),
    maxRecordBytes: integer(env, "DESK_MAX_RECORD_BYTES", 100_000, 1_000, 120_000),
    finalizeClaims: flag(env, "DESK_FINALIZE", true),
    settleReceipts: flag(env, "DESK_SETTLE", true),
    maxItems: integer(env, "MAX_ITEMS_PER_PASS", 200, 1, 5_000),
    receiptStallBlocks: integer(env, "RECEIPT_STALL_BLOCKS", 1800, 10, 8_000),
    stampWatchSeconds: integer(env, "STAMP_WATCH_DAYS", 30, 0, 365) * 86_400,
    potsRefundBatch: integer(env, "POTS_REFUND_BATCH", 40, 1, 200),
    potsRefundMin: imd(env, "POTS_REFUND_MIN_IMD", "0"),
    houseRules,
    imdPerEth,
    tipCoverBps: BigInt(integer(env, "RULES_TIP_COVER_BPS", 10_000, 0, 1_000_000)),
    stakeMin: imd(env, "ENDOWMENTS_STAKE_MIN_IMD", "0.01"),
    harvestMin: imd(env, "ENDOWMENTS_HARVEST_MIN_IMD", "0.5"),
    firstDayFund: {
      payrolls: optionalImd(env, "FIRST_DAY_FUND_PAYROLLS_IMD"),
      hires: optionalImd(env, "FIRST_DAY_FUND_HIRES_IMD"),
      employers: optionalImd(env, "FIRST_DAY_FUND_EMPLOYERS_IMD"),
    },
    firstDayConfirm: confirm,
  };
  if (config.maxPriorityFeePerGas > config.maxFeePerGas) {
    throw new ConfigError("MAX_PRIORITY_FEE_GWEI is above MAX_FEE_GWEI");
  }
  if (config.dailySpendCap < config.maxTxCost) {
    throw new ConfigError("DAILY_SPEND_CAP_ETH is below MAX_TX_COST_ETH: no transaction could be sent");
  }
  if (config.bookMin === 0n) throw new ConfigError("BOOK_MIN_IMD must be above zero");
  if (config.stakeMin === 0n) throw new ConfigError("ENDOWMENTS_STAKE_MIN_IMD must be above zero");
  if ((config.challengeFloat === 0n) !== (config.challengeDailyCap === 0n)) {
    throw new ConfigError(
      "CHALLENGE_FLOAT_IMD and CHALLENGE_DAILY_CAP_IMD go together: set both to let the keeper challenge untrue delivery claims, or neither",
    );
  }
  return config;
}

/** The configuration as it may be printed: everything except the key and the RPC URL. */
export function describeConfig(config: KeeperConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    dryRunReason: config.dryRunReason,
    keeper: config.keeper,
    chainId: config.chainId,
    rpcHost: new URL(config.rpcUrl).host,
    apiBase: config.apiBase,
    questions: config.questions,
    jobsReport: config.jobsReport,
    payroll: config.payroll,
    workOrders: config.workOrders,
    crowdPots: config.crowdPots,
    doorbell: config.doorbell,
    rules: config.rules,
    endowments: config.endowments,
    challengeFloat: config.challengeFloat.toString(),
    challengeDailyCap: config.challengeDailyCap.toString(),
    houseRules: [...config.houseRules],
    modules: [...config.modules],
    feeds: config.feeds.map((feed) => feed.name),
    statePath: config.statePath,
    statusPath: config.statusPath,
    killSwitch: config.killSwitch,
    pollSeconds: config.pollSeconds,
    maxFeePerGas: config.maxFeePerGas.toString(),
    maxTxCost: config.maxTxCost.toString(),
    dailySpendCap: config.dailySpendCap.toString(),
    tipCollectMin: config.tipCollectMin.toString(),
    closeRoundsInProgress: config.closeRoundsInProgress,
    requestAtUtc: config.requestAtUtc,
    dripEverySeconds: config.dripEverySeconds,
  };
}
