/**
 * Every transaction flow the site offers, as data.
 *
 * A flow is a small form and a function from the form's values to an ordered list of contract
 * calls. The same list is used three ways: the server prints it as `cast send` commands (so the
 * page works with JavaScript off, and an agent reads exactly what would be sent), the wallet island
 * sends it call by call, and the tests check its arguments. A flow whose contract has no address
 * yet still plans its calls; they just cannot be sent.
 *
 * Every call is encoded with an ABI from `@help-wanted/shared`, which generates the ABIs of our
 * contracts from the launch projects' build output, and the signature a `cast` command prints is
 * read from that same ABI (`signatureOf`). No signature is typed in this file.
 */
import { getAddress, isAddress, stringToHex, toFunctionSelector, type Abi, type Hex } from "viem";
import {
  checkSpec,
  crowdPotsAbi,
  DESK,
  doorbellAbi,
  endowmentsAbi,
  erc20Abi,
  HOUSE_FEED_NAMES,
  HOUSE_FEEDS,
  jobsReportAbi,
  kindHash,
  MAINNET,
  ORDER_FLAG,
  payrollAbi,
  QUESTIONS_WAITS,
  questionsAbi,
  rulesAbi,
  silenceSeconds,
  splitPrice,
  workOrdersAbi,
  zapAbi,
} from "@help-wanted/shared";
import type { ContractKey } from "~/config/deployments";
import { specInputsProblem, TEMPLATES, templateBySlug } from "~/config/templates";
import { callSignatureOf, COMPARISONS, ENDOWMENT, GAS_LIMIT, POTS, RULE, signatureOf } from "~/lib/contracts";
import {
  formatDuration,
  formatImd,
  formatUnits,
  formatUtc,
  hasAmbiguousComma,
  parseUnits,
} from "~/lib/format";
import { jobIdToBytes16, parseHash, parseJobId } from "~/lib/ids";
import { specProblemWords } from "~/lib/specWords";

export type FieldKind =
  "imd" | "eth" | "number" | "text" | "longtext" | "address" | "bytes32" | "select" | "checkbox";

export interface FlowField {
  name: string;
  label: string;
  kind: FieldKind;
  help?: string;
  placeholder?: string;
  /** The value the form starts with. */
  initial?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** A unit printed after the input: "IMD", "hours". */
  unit?: string;
}

export interface FlowCall {
  /** What the call does, in a plain sentence. */
  label: string;
  /** Which contract: one of ours, or a protocol contract by name. */
  target: ContractKey | "IMD";
  /** The address, or null when the contract is not launched yet. */
  to: string | null;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** The canonical signature, for `cast send`: read from `abi`. */
  signature: string;
  /** The arguments as `cast` takes them. */
  castArgs: string[];
  /** ETH sent with the call, in wei. */
  value?: bigint;
  /** A gas limit to send with, where the contract must be offered more gas than it uses. */
  gas?: bigint;
  /** For an `approve`: the allowance the later call needs, so an existing one can be reused. */
  allowance?: { spender: string | null; amount: bigint };
}

/** A read to make before sending: the same contract, asked with `cast call`. Nothing is signed. */
export interface FlowRead {
  label: string;
  target: ContractKey | "IMD";
  to: string | null;
  /** The signature with its outputs, as `cast call` takes it. */
  signature: string;
  castArgs: string[];
  /** ETH the simulated call carries, in wei. */
  value?: bigint;
  /** True when the read simulates a call from the reader's own address (`--from`). */
  fromSelf?: boolean;
}

export type FlowPlan =
  { ok: true; calls: FlowCall[]; summary: string[]; reads?: FlowRead[] } | { ok: false; problems: string[] };

export type Addresses = Record<ContractKey, string | null>;

export interface FlowContext {
  addresses: Addresses;
  /** Seconds. Passed in so the same values plan the same calls on the server and in the browser. */
  now: number;
}

export interface FlowDef {
  id: string;
  title: string;
  /** The contract of ours the flow needs. */
  contract: ContractKey;
  /** What the button says. */
  action: string;
  fields(preset: Record<string, string>): FlowField[];
  plan(values: Record<string, string>, ctx: FlowContext): FlowPlan;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;
const MAX_UINT256 = (1n << 256n) - 1n;
const PLACEHOLDER: Record<ContractKey | "IMD", string> = {
  IMD: "IMD",
  questions: "QUESTIONS",
  jobsReport: "JOBS_REPORT",
  payroll: "PAYROLL",
  workProof: "WORK_PROOF",
  workOrders: "WORK_ORDERS",
  crowdPots: "CROWD_POTS",
  doorbell: "DOORBELL",
  rules: "RULES",
  endowments: "ENDOWMENTS",
  zap: "ZAP",
};

const NAMES: Record<ContractKey, string> = {
  questions: "Questions",
  jobsReport: "JobsReport",
  payroll: "Payroll",
  workProof: "WorkProof",
  workOrders: "WorkOrders",
  crowdPots: "CrowdPots",
  doorbell: "Doorbell",
  rules: "Rules",
  endowments: "Endowments",
  zap: "Zap",
};

function imd(text: string | undefined): bigint | null {
  return parseUnits(text ?? "", 18);
}

/** The largest amount the desk's books hold (`uint96`); far above all the IMD that exists. */
const MAX_UINT96 = (1n << 96n) - 1n;

/**
 * Why an amount field could not be read, when the reason is worth saying: a comma is not taken for
 * a decimal mark (see `parseUnits`), and an amount beyond the contract's range is refused here
 * rather than by an encoder.
 */
function amountProblems(fields: readonly (readonly [string, string | undefined])[]): string[] {
  const problems: string[] = [];
  for (const [label, text] of fields) {
    if (hasAmbiguousComma(text ?? "")) {
      problems.push(
        `${label}: write the amount with a point for the decimals and no commas, like 0.5 or 1000.5. A comma is not read as a decimal mark.`,
      );
    }
    const amount = imd(text);
    if (amount !== null && amount > MAX_UINT96) problems.push(`${label}: that is more IMD than can exist.`);
  }
  return problems;
}

function whole(text: string | undefined): bigint | null {
  const t = (text ?? "").trim();
  return /^\d{1,30}$/.test(t) ? BigInt(t) : null;
}

function bytes32(text: string | undefined): Hex | null {
  const t = (text ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(t) ? (t as Hex) : null;
}

/** A length of time typed as a number of some unit, in whole seconds. Null when it is not a number. */
function seconds(text: string | undefined, unitSecs: number): number | null {
  const n = Number((text ?? "").trim());
  if ((text ?? "").trim() === "" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * unitSecs);
}

/** A tuple, array or scalar in the spelling `cast` accepts. */
function castValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(castValue).join(",")}]`;
  if (typeof value === "bigint" || typeof value === "number") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function shellQuote(text: string): string {
  return /^[A-Za-z0-9_.:/@=+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A job text as the `bytes` argument `cast` takes. */
function castText(text: string): string {
  return `"$(cast from-utf8 ${shellQuote(text)})"`;
}

function approve(spenderKey: ContractKey, spender: string | null, amount: bigint): FlowCall {
  return {
    label: `Allow the ${NAMES[spenderKey]} contract to pull ${formatImd(amount, 18)} IMD from your wallet`,
    target: "IMD",
    to: MAINNET.IMD,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender ?? ZERO_ADDRESS, amount],
    signature: signatureOf(erc20Abi, "approve"),
    castArgs: [spender ?? `$${PLACEHOLDER[spenderKey]}`, amount.toString()],
    allowance: { spender, amount },
  };
}

function call(
  target: ContractKey,
  ctx: FlowContext,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  label: string,
  extra: { castArgs?: string[]; value?: bigint; gas?: bigint } = {},
): FlowCall {
  return {
    label,
    target,
    to: ctx.addresses[target],
    abi,
    functionName,
    args,
    signature: signatureOf(abi, functionName),
    castArgs: extra.castArgs ?? args.map((a) => shellQuote(castValue(a))),
    ...(extra.value !== undefined ? { value: extra.value } : {}),
    ...(extra.gas !== undefined ? { gas: extra.gas } : {}),
  };
}

function read(
  target: ContractKey,
  ctx: FlowContext,
  abi: Abi,
  functionName: string,
  castArgs: string[],
  label: string,
  extra: { value?: bigint; fromSelf?: boolean } = {},
): FlowRead {
  return {
    label,
    target,
    to: ctx.addresses[target],
    signature: callSignatureOf(abi, functionName),
    castArgs,
    ...extra,
  };
}

/** The `cast send` line for a call. A contract without an address is written as a shell variable. */
export function castCommand(c: FlowCall, rpcUrl: string): string {
  const to = c.to ?? `$${PLACEHOLDER[c.target]}`;
  const tail = c.castArgs.length ? ` ${c.castArgs.join(" ")}` : "";
  const value = c.value !== undefined ? ` --value ${c.value}` : "";
  const gas = c.gas !== undefined ? ` --gas-limit ${c.gas}` : "";
  return `cast send ${to} "${c.signature}"${tail}${value}${gas} --rpc-url ${rpcUrl} --account <your-keystore-account>`;
}

/** The `cast call` line for a read. It sends nothing and needs no key. */
export function castReadCommand(r: FlowRead, rpcUrl: string): string {
  const to = r.to ?? `$${PLACEHOLDER[r.target]}`;
  const tail = r.castArgs.length ? ` ${r.castArgs.join(" ")}` : "";
  const value = r.value !== undefined ? ` --value ${r.value}` : "";
  const from = r.fromSelf ? " --from <your-address>" : "";
  return `cast call ${to} "${r.signature}"${tail}${value}${from} --rpc-url ${rpcUrl}`;
}

// ---------------------------------------------------------------------------------------------
// Orders: WorkOrders.createOrder
// ---------------------------------------------------------------------------------------------

/** How long an order must stay open at the least, on this form. The desk itself asks only for a future time. */
const MIN_OPEN_SECS = 3600;

/** What the claim checkbox says. A page may add why it is ticked or not today (`claimNote`). */
const CLAIM_HELP =
  "Off: only an on-chain receipt pays, and an order whose receipt does not arrive in time is refunded. On: a runner may claim delivery under its bond, and is paid if nobody challenges the claim within 24 hours. That has two limits. A claim that is untrue is paid if nobody challenges it in time, so someone has to watch your order. And a challenge that nothing decides refunds you even when the claim was true. A receipt that exists in time decides either way.";

function payFields(preset: Record<string, string>): FlowField[] {
  return [
    {
      name: "maxPay",
      label: "The most you will pay",
      kind: "imd",
      unit: "IMD",
      required: true,
      help: "Escrowed now. Whatever the fixed price leaves comes back to you.",
    },
    {
      name: "minPay",
      label: "Opening price",
      kind: "imd",
      unit: "IMD",
      required: true,
      help: "The price starts here and rises to the most you will pay. The first runner to take the order fixes it.",
    },
    {
      name: "rampHours",
      label: "Price rises over",
      kind: "number",
      unit: "hours",
      initial: "1",
      required: true,
    },
    {
      name: "expiresDays",
      label: "Keep the order open for",
      kind: "number",
      unit: "days",
      initial: "7",
      required: true,
      help: "If no runner has taken it by then, anyone can send your escrow back to you.",
    },
    {
      name: "allowClaimed",
      label: "Also accept a bonded delivery claim when no receipt is available",
      kind: "checkbox",
      initial: "false",
      help: preset.claimNote ? `${preset.claimNote} ${CLAIM_HELP}` : CLAIM_HELP,
    },
    {
      name: "arbiter",
      label: "Arbiter for a disputed claim (optional)",
      kind: "address",
      placeholder: "0x… or leave empty",
      help: "An address you trust to decide a challenged delivery claim either way, without waiting for a receipt. It has no other power. Used only when delivery claims are accepted.",
    },
  ];
}

interface OrderInput {
  kind: string;
  spec: string;
  values: Record<string, string>;
  cond?: { target: string; selector: Hex; arg: Hex | null; cmp: number; threshold: bigint };
}

function specProblems(kind: string, text: string): string[] {
  const spec = checkSpec(text);
  if (!spec.ok) return [specProblemWords(spec.problem)];
  // A spec the desk accepts can still be one no runner can open.
  const unopenable = specInputsProblem(kind, text);
  return unopenable ? [unopenable] : [];
}

function planOrder(input: OrderInput, ctx: FlowContext): FlowPlan {
  const problems: string[] = specProblems(input.kind, input.spec);
  problems.push(
    ...amountProblems([
      ["The most you will pay", input.values.maxPay],
      ["Opening price", input.values.minPay],
    ]),
  );
  const maxPay = imd(input.values.maxPay);
  const minPay = imd(input.values.minPay);
  if (maxPay === null || maxPay === 0n) problems.push("Say the most you will pay, in IMD.");
  if (minPay === null) problems.push("Say the opening price, in IMD.");
  if (maxPay !== null && minPay !== null && minPay > maxPay) {
    problems.push("The opening price cannot be more than the most you will pay.");
  }
  const rampHours = Number(input.values.rampHours ?? "1");
  const expiresDays = Number(input.values.expiresDays ?? "7");
  if (!Number.isFinite(rampHours) || rampHours < 0 || rampHours > 24 * 365)
    problems.push("Give the price ramp in hours.");
  else if (maxPay !== null && minPay !== null && minPay < maxPay && Math.round(rampHours * 3600) === 0) {
    // With no ramp the desk prices the order at the most at once; the opening price would mean nothing.
    problems.push(
      "The price cannot rise over no time at all. Give the ramp a length, or make the opening price equal to the most you will pay.",
    );
  }
  if (!Number.isFinite(expiresDays) || expiresDays <= 0 || expiresDays > 3650)
    problems.push("Give how many days the order stays open.");
  else if (Math.round(expiresDays * 86_400) < MIN_OPEN_SECS)
    problems.push("Keep the order open for at least an hour, or no runner will have time to take it.");
  const allowClaimed = input.values.allowClaimed === "true";
  const arbiterText = (input.values.arbiter ?? "").trim();
  let arbiter: string | null = null;
  if (arbiterText !== "") {
    if (!isAddress(arbiterText, { strict: false }))
      problems.push("Arbiter: give an address, or leave it empty.");
    else if (/^0x0{40}$/i.test(arbiterText)) problems.push("Arbiter: leave it empty to name none.");
    else if (!allowClaimed)
      problems.push(
        "An arbiter decides disputed delivery claims, and this order accepts none. Accept delivery claims, or leave the arbiter empty.",
      );
    else arbiter = getAddress(arbiterText);
  }
  if (problems.length > 0 || maxPay === null || minPay === null) return { ok: false, problems };

  const rampSecs = minPay === maxPay ? 0 : Math.round(rampHours * 3600);
  const openSecs = Math.round(expiresDays * 86_400);
  const expiresAt = ctx.now + openSecs;
  const flags = (allowClaimed ? ORDER_FLAG.ALLOW_CLAIMED : 0) | (input.cond?.arg ? ORDER_FLAG.COND_ARG : 0);
  const params = {
    kindHash: kindHash(input.kind),
    minPay,
    maxPay,
    rampSecs,
    deliverySecs: DESK.MIN_DELIVERY,
    expiresAt,
    bond: DESK.MIN_BOND,
    flags,
    runnerOnly: ZERO_ADDRESS,
    arbiter: arbiter ?? ZERO_ADDRESS,
    condTarget: input.cond?.target ?? ZERO_ADDRESS,
    condSelector: input.cond?.selector ?? "0x00000000",
    condArg: input.cond?.arg ?? ZERO_BYTES32,
    condCmp: input.cond?.cmp ?? 0,
    condThreshold: input.cond?.threshold ?? 0n,
  };
  const tuple = `(${[
    params.kindHash,
    params.minPay,
    params.maxPay,
    params.rampSecs,
    params.deliverySecs,
    params.expiresAt,
    params.bond,
    params.flags,
    params.runnerOnly,
    params.arbiter,
    params.condTarget,
    params.condSelector,
    params.condArg,
    params.condCmp,
    params.condThreshold,
  ].join(",")})`;
  const desk = ctx.addresses.workOrders;
  const atMost = splitPrice(maxPay);
  const cmp = COMPARISONS.find((c) => c.code === input.cond?.cmp);
  const largeRecord = TEMPLATES.find((t) => t.kind === input.kind)?.recordNote;
  const claimLines = allowClaimed
    ? [
        "You also accept a bonded delivery claim: when no receipt is available, the runner may state under its bond that the job was delivered, and anyone can challenge that for 24 hours by posting an equal bond. A receipt that exists before the claim is paid decides it, whichever way it points.",
        "First limit: a claim that is untrue and that nobody challenges within 24 hours is paid. Nothing on chain watches your order for you; you, or someone you ask, must.",
        arbiter
          ? `Second limit: a challenged claim is decided by a receipt or by your arbiter ${arbiter}, who can rule either way. If neither does by the delivery deadline, you are refunded and the runner goes unpaid, even if the claim was true.`
          : "Second limit: you named no arbiter, so only a receipt decides a challenged claim. With none by the delivery deadline you are refunded and the runner goes unpaid, even if the claim was true; anyone can cause that at no cost by challenging.",
      ]
    : [
        `Only an on-chain receipt pays. If IdentityMD's receipt for the job has not been written by the delivery deadline, the order times out and your escrow comes back.${
          largeRecord
            ? " A record of this kind is often too large to prove in one transaction, so a runner may pass on the order as it stands."
            : ""
        }`,
      ];
  return {
    ok: true,
    calls: [
      approve("workOrders", desk, maxPay),
      call(
        "workOrders",
        ctx,
        workOrdersAbi,
        "createOrder",
        [params, stringToHex(input.spec)],
        "Open the order: the desk pulls the escrow and pins the job text",
        { castArgs: [shellQuote(tuple), castText(input.spec)] },
      ),
    ],
    summary: [
      `You escrow ${formatImd(maxPay)} IMD. That is the most this order can cost you.`,
      input.cond && cmp
        ? `Nobody can take the order until ${input.cond.target} has been seen to answer a value that ${cmp.words} ${input.cond.threshold}. Anyone may check it; once seen true, it stays open.`
        : null,
      minPay === maxPay
        ? `The price is fixed at ${formatImd(maxPay)} IMD.`
        : `The price starts at ${formatImd(minPay)} IMD and rises to ${formatImd(maxPay)} IMD over ${formatDuration(rampSecs * 1000)}. The first runner to take the order fixes the price at that moment; the rest of your escrow comes back.`,
      `Of the fixed price, 5% is the fee (at most ${formatImd(atMost.fee)} IMD: half to sIMD stakers, 30% to seat owners, 20% to the feeds), 5% is a tip to the seats of the agents the job's work record names, and the runner keeps the rest, out of which it pays the swarm's 0.5 IMD.`,
      `A runner must post a bond of ${formatImd(DESK.MIN_BOND)} IMD to take the order, and then has three days for the job's receipt to exist.`,
      ...claimLines,
      `If nobody has taken the order after ${formatDuration(openSecs * 1000)}, anyone can send the whole escrow back to you. Until a runner takes it you can withdraw it yourself.`,
    ].filter((line): line is string => line !== null),
  };
}

const hire: FlowDef = {
  id: "hire",
  title: "Post an order",
  contract: "workOrders",
  action: "Post the order",
  fields(preset) {
    const template = templateBySlug(preset.template ?? "") ?? TEMPLATES[0];
    if (!template) return payFields(preset);
    const slots: FlowField[] = template.slots.map((slot) => ({
      name: slot.name,
      label: slot.label,
      kind: slot.kind === "longtext" ? "longtext" : "text",
      help: slot.help,
      placeholder: slot.placeholder,
      required: slot.required,
    }));
    return [
      ...slots,
      ...payFields(preset).map((f) =>
        f.name === "maxPay"
          ? { ...f, initial: template.suggestedMaxPay }
          : f.name === "minPay"
            ? { ...f, initial: template.suggestedMinPay }
            : f,
      ),
    ];
  },
  plan(values, ctx) {
    const template = templateBySlug(values.template ?? "");
    if (!template) return { ok: false, problems: ["Choose what kind of job to order."] };
    const problems: string[] = [];
    for (const slot of template.slots) {
      const value = (values[slot.name] ?? "").trim();
      if (slot.required && !value) problems.push(`${slot.label}: this is needed.`);
      if (
        value &&
        slot.kind === "repo" &&
        !/^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
      ) {
        problems.push("Repository: give a public GitHub address like https://github.com/owner/repo.");
      }
      if (value && slot.kind === "commit" && !/^[0-9a-fA-F]{40}$/.test(value)) {
        problems.push("Commit: give the full 40-character commit hash.");
      }
    }
    if (problems.length > 0) return { ok: false, problems };
    return planOrder({ kind: template.kind, spec: template.spec(values), values }, ctx);
  },
};

const TEMPLATE_FIELD: FlowField = {
  name: "template",
  label: "THEN hire",
  kind: "select",
  initial: TEMPLATES[0]?.slug ?? "",
  options: TEMPLATES.map((t) => ({ value: t.slug, label: `${t.staff}: ${t.title.toLowerCase()}` })),
};

const SPEC_FIELD: FlowField = {
  name: "spec",
  label: "to do this",
  kind: "longtext",
  required: true,
  placeholder: "The job text: one line of plain ASCII, no double quotes or backslashes.",
  help: "For an audit, end the text with: Inputs: repoUrl=https://github.com/owner/repo; baseCommit=<40 hex>. Without both, no runner can open the job.",
};

/** A view call typed as `name(type)` and one argument, as the stored condition takes it. */
function parseViewCall(
  fn: string,
  rawArg: string,
  problems: string[],
): { selector: Hex; arg: Hex | null; signature: string } | null {
  const match = fn.match(/^([A-Za-z_][A-Za-z0-9_]*)\((address|uint256|bytes32)?\)$/);
  if (!match) {
    problems.push(
      "The call must be a function name with no argument or with one address, uint256 or bytes32 argument, like totalSupply() or balanceOf(address).",
    );
    return null;
  }
  const argType = match[2] ?? null;
  let arg: Hex | null = null;
  if (argType) {
    if (argType === "address" && isAddress(rawArg, { strict: false })) {
      arg = `0x${"0".repeat(24)}${rawArg.slice(2).toLowerCase()}` as Hex;
    } else if (argType === "uint256" && whole(rawArg) !== null) {
      arg = `0x${(whole(rawArg) as bigint).toString(16).padStart(64, "0")}` as Hex;
    } else if (argType === "bytes32" && bytes32(rawArg)) {
      arg = bytes32(rawArg);
    } else {
      problems.push(`The call takes one ${argType}; give its value.`);
      return null;
    }
  } else if (rawArg) {
    problems.push("The call takes no argument; leave the argument empty.");
    return null;
  }
  return { selector: toFunctionSelector(fn), arg, signature: fn };
}

const CONDITION_FIELDS: FlowField[] = [
  {
    name: "condTarget",
    label: "WHEN this contract",
    kind: "address",
    placeholder: "0x…",
    required: true,
    help: "Any contract with a view function that returns a number.",
  },
  {
    name: "condFunction",
    label: "answers this call",
    kind: "text",
    initial: "totalSupply()",
    required: true,
    help: "A function with no argument, like totalSupply(), or one with a single address, uint256 or bytes32 argument, like balanceOf(address).",
  },
  {
    name: "condArg",
    label: "with this argument",
    kind: "text",
    placeholder: "leave empty for a function with no argument",
    help: "An address, a whole number, or 32 bytes of hex.",
  },
  {
    name: "condCmp",
    label: "with a value that",
    kind: "select",
    initial: "1",
    options: COMPARISONS.map((c) => ({ value: String(c.code), label: `${c.words} (${c.symbol})` })),
  },
  {
    name: "condThreshold",
    label: "this number",
    kind: "text",
    placeholder: "1000000000000000000000000",
    required: true,
    help: "A whole number, compared with the first word the call returns. For a token amount, include the decimals.",
  },
];

const sayWhen: FlowDef = {
  id: "say-when",
  title: "Say when, once",
  contract: "workOrders",
  action: "Post the conditional order",
  fields(preset) {
    return [
      ...CONDITION_FIELDS,
      TEMPLATE_FIELD,
      SPEC_FIELD,
      ...payFields(preset).map((f) =>
        f.name === "maxPay" ? { ...f, initial: "3" } : f.name === "minPay" ? { ...f, initial: "2" } : f,
      ),
    ];
  },
  plan(values, ctx) {
    const problems: string[] = [];
    const target = (values.condTarget ?? "").trim();
    if (!isAddress(target, { strict: false }))
      problems.push("WHEN: give the address of the contract to watch.");
    const view = parseViewCall((values.condFunction ?? "").trim(), (values.condArg ?? "").trim(), problems);
    const cmp = Number(values.condCmp ?? "1");
    if (!COMPARISONS.some((c) => c.code === cmp)) problems.push("Choose how to compare.");
    const threshold = whole(values.condThreshold);
    if (threshold === null) problems.push("The number to compare with must be a whole number.");
    const template = templateBySlug(values.template ?? "");
    if (!template) problems.push("THEN: choose what kind of job to order.");
    if (problems.length > 0 || !view || !template || threshold === null) return { ok: false, problems };
    return planOrder(
      {
        kind: template.kind,
        spec: (values.spec ?? "").trim(),
        values,
        cond: { target: getAddress(target), selector: view.selector, arg: view.arg, cmp, threshold },
      },
      ctx,
    );
  },
};

function simple(def: {
  id: string;
  title: string;
  action: string;
  contract: ContractKey;
  fields: FlowField[];
  plan(values: Record<string, string>, ctx: FlowContext): FlowPlan;
}): FlowDef {
  return { ...def, fields: () => def.fields };
}

const ORDER_ID: FlowField = { name: "id", label: "Order number", kind: "number", required: true };

/** A flow that is one call on the desk with the order number as its only argument. */
function orderCall(def: {
  id: string;
  title: string;
  action: string;
  functionName: string;
  label: (id: bigint) => string;
  summary: string[];
  gas?: bigint;
}): FlowDef {
  return simple({
    id: def.id,
    title: def.title,
    action: def.action,
    contract: "workOrders",
    fields: [ORDER_ID],
    plan(values, ctx) {
      const id = whole(values.id);
      if (id === null) return { ok: false, problems: ["Give the order number."] };
      return {
        ok: true,
        calls: [
          call("workOrders", ctx, workOrdersAbi, def.functionName, [id], def.label(id), {
            ...(def.gas !== undefined ? { gas: def.gas } : {}),
          }),
        ],
        summary: def.summary,
      };
    },
  });
}

const orderCancel = orderCall({
  id: "order-cancel",
  title: "Withdraw an order",
  action: "Withdraw the order",
  functionName: "cancel",
  label: (id) => `Withdraw order ${id} (its employer only, and only while nobody has taken it)`,
  summary: [
    "The whole escrow comes back to the employer. Only the employer can do this, and only before a runner takes the order.",
  ],
});

const orderRefund = orderCall({
  id: "order-refund",
  title: "Refund an expired order",
  action: "Send the escrow back",
  functionName: "refund",
  label: (id) => `Return the escrow of expired order ${id} to its employer`,
  summary: [
    "Anyone may do this once the order has expired with nobody holding it. The money goes to the employer, not to you.",
  ],
});

const orderTrigger = orderCall({
  id: "order-trigger",
  title: "Check a conditional order's condition",
  action: "Record that the condition holds",
  functionName: "trigger",
  label: (id) => `Record that the condition of order ${id} holds now`,
  gas: 200_000n,
  summary: [
    "Anyone may do this. If the condition holds in this block, the order is open from now on, even if the value moves back. If it does not hold, the call reverts and costs only gas.",
    "The desk reads the condition with a fixed allowance of 100,000 gas, so the call must be sent with room for it: the limit above is what to send.",
  ],
});

const orderEvict = orderCall({
  id: "order-evict",
  title: "Remove a runner that registered no job",
  action: "Remove the runner",
  functionName: "evict",
  label: (id) => `Remove the runner of order ${id}, who registered no job within the hour`,
  summary: [
    "Anyone may do this once an hour has passed since the runner took the order without registering a job. The runner's bond goes to the employer and the order is open again.",
  ],
});

const orderTimeout = orderCall({
  id: "order-timeout",
  title: "End a claim whose delivery time has passed",
  action: "End the claim",
  functionName: "timeout",
  label: (id) => `End the claim on order ${id}: its delivery time has passed`,
  summary: [
    "Anyone may do this once the delivery time has passed with no settlement. A registered job forfeits the runner's bond to the employer. A challenged claim that nothing decided refunds the employer, returns the challenger's bond, and costs the runner a tenth of its bond.",
    "Until this call is made a late receipt can still settle the order.",
  ],
});

const runnerRelease = orderCall({
  id: "runner-release",
  title: "Give an order back",
  action: "Give the order back",
  functionName: "release",
  label: (id) => `Give order ${id} back (its runner only, inside the first hour)`,
  summary: [
    "Only the runner that holds the order can do this, and only in the first hour, before it has registered a job. It gets nine tenths of its bond back; a tenth goes to the employer. The order is open again.",
  ],
});

const runnerFinalize = orderCall({
  id: "runner-finalize",
  title: "Pay out an unchallenged delivery claim",
  action: "Finalize the claim",
  functionName: "finalize",
  label: (id) => `Pay out the delivery claim on order ${id}: nobody challenged it within 24 hours`,
  gas: GAS_LIMIT.FINALIZE,
  summary: [
    "Anyone may do this once a delivery claim has stood 24 hours without a challenge. The runner is paid the fixed price less the fee and the tip, and gets its bond back. The order is marked delivered but not proven; anyone can stamp it proven later, when its receipt exists.",
    "The desk refuses to start unless it can hand each of its two Payroll calls 1,000,000 gas, so this must be offered far more gas than it uses. What is not used is returned.",
  ],
});

const runnerClaim = simple({
  id: "runner-claim",
  title: "Take an order",
  action: "Take the order",
  contract: "workOrders",
  fields: [
    ORDER_ID,
    {
      name: "bond",
      label: "The order's bond",
      kind: "imd",
      unit: "IMD",
      initial: "0.25",
      required: true,
      help: "Read it from the order page; the desk's minimum is 0.25 IMD.",
    },
  ],
  plan(values, ctx) {
    const id = whole(values.id);
    const bond = imd(values.bond);
    const problems: string[] = amountProblems([["The order's bond", values.bond]]);
    if (id === null) problems.push("Give the order number.");
    if (bond === null || bond < DESK.MIN_BOND) problems.push("The bond is at least 0.25 IMD.");
    if (problems.length > 0 || id === null || bond === null) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "workOrders",
          ctx,
          workOrdersAbi,
          "priceNow",
          [id.toString()],
          "What the order pays if you take it in this block",
        ),
      ],
      calls: [
        approve("workOrders", ctx.addresses.workOrders, bond),
        call(
          "workOrders",
          ctx,
          workOrdersAbi,
          "claim",
          [id],
          `Take order ${id}: post the bond and fix the price`,
        ),
      ],
      summary: [
        `You post a bond of ${formatImd(bond)} IMD and hold order ${id} alone for one hour.`,
        "The call returns the order's ticket; headerOf(id) gives the 85 bytes built from it. The swarm job you open must begin with those bytes, followed by the order's job text, byte for byte, or the order will not pay you.",
        "Give the order back before you register a job and you lose a tenth of the bond; let the hour pass without registering one and you lose all of it.",
      ],
    };
  },
});

const runnerRegister = simple({
  id: "runner-register",
  title: "Register the swarm job",
  action: "Register the job",
  contract: "workOrders",
  fields: [
    ORDER_ID,
    {
      name: "jobId",
      label: "Swarm job id",
      kind: "text",
      required: true,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
  ],
  plan(values, ctx) {
    const id = whole(values.id);
    const jobId = parseJobId(values.jobId);
    const problems: string[] = [];
    if (id === null) problems.push("Give the order number.");
    if (!jobId) problems.push("Give the swarm job id (a UUID).");
    if (problems.length > 0 || id === null || !jobId) return { ok: false, problems };
    return {
      ok: true,
      calls: [
        call(
          "workOrders",
          ctx,
          workOrdersAbi,
          "register",
          [id, jobIdToBytes16(jobId)],
          `Record job ${jobId} as the job opened for order ${id}`,
        ),
      ],
      summary: [
        "From now the delivery clock runs: three days, or the order's own delivery time, for the job's receipt to exist.",
        "The desk refuses a job whose receipt has already settled another order: one job pays for one order.",
      ],
    };
  },
});

const runnerClaimDelivered = simple({
  id: "runner-claim-delivered",
  title: "Claim delivery without a receipt",
  action: "Claim delivery",
  contract: "workOrders",
  fields: [
    ORDER_ID,
    {
      name: "recordHash",
      label: "The job's work-record hash",
      kind: "bytes32",
      required: true,
      placeholder: "0x… (32 bytes)",
      help: "The hash IdentityMD's API lists for the job's record (GET /jobs/<id>/records). It is there for a watcher to compare; a receipt, when it lands, is what decides.",
    },
  ],
  plan(values, ctx) {
    const id = whole(values.id);
    const hash = parseHash(values.recordHash);
    const problems: string[] = [];
    if (id === null) problems.push("Give the order number.");
    if (!hash || /^0x0+$/.test(hash)) problems.push("Give the record hash: 0x and 64 hex characters.");
    if (problems.length > 0 || id === null || !hash) return { ok: false, problems };
    return {
      ok: true,
      calls: [
        call(
          "workOrders",
          ctx,
          workOrdersAbi,
          "claimDelivered",
          [id, hash],
          `State, under your bond, that the job registered for order ${id} was delivered`,
        ),
      ],
      summary: [
        "Only the runner that holds the order can do this, and only on an order whose employer allowed delivery claims. It must be made at least 48 hours before the delivery deadline.",
        "A 24-hour window opens in which anyone may challenge by posting a bond equal to yours. Unchallenged, finalize pays you. Challenged, only a receipt for the job, or the order's arbiter if it has one, decides.",
        "A receipt that shows the job did not complete costs you the bond. A challenge nothing decides by the deadline refunds the employer and costs you a tenth of the bond, even if the claim was true.",
      ],
    };
  },
});

const orderChallenge = simple({
  id: "order-challenge",
  title: "Challenge a delivery claim",
  action: "Challenge the claim",
  contract: "workOrders",
  fields: [
    ORDER_ID,
    {
      name: "bond",
      label: "The order's bond",
      kind: "imd",
      unit: "IMD",
      initial: "0.25",
      required: true,
      help: "A challenger posts the same amount the runner did. Read it from the order page.",
    },
  ],
  plan(values, ctx) {
    const id = whole(values.id);
    const bond = imd(values.bond);
    const problems: string[] = amountProblems([["The order's bond", values.bond]]);
    if (id === null) problems.push("Give the order number.");
    if (bond === null || bond < DESK.MIN_BOND) problems.push("The bond is at least 0.25 IMD.");
    if (problems.length > 0 || id === null || bond === null) return { ok: false, problems };
    return {
      ok: true,
      calls: [
        approve("workOrders", ctx.addresses.workOrders, bond),
        call(
          "workOrders",
          ctx,
          workOrdersAbi,
          "challenge",
          [id],
          `Dispute the delivery claim on order ${id}, posting a bond equal to the runner's`,
        ),
      ],
      summary: [
        `You post ${formatImd(bond)} IMD. If a receipt for the registered job then shows a completed job of the right kind and text, the runner is paid and receives your bond.`,
        "If a receipt contradicts the claim, you receive the runner's bond less the tenth that goes to the employer. If nothing decides it by the delivery deadline, your bond comes back and the employer is refunded.",
        "A record hash that differs from the one the runner named is not by itself a reason to challenge: any valid receipt for the job pays the runner.",
      ],
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Crowd pots and the Doorbell
// ---------------------------------------------------------------------------------------------

const KIND_FIELD: FlowField = {
  name: "template",
  label: "The job's kind",
  kind: "select",
  initial: TEMPLATES[1]?.slug ?? TEMPLATES[0]?.slug ?? "",
  options: TEMPLATES.map((t) => ({ value: t.slug, label: `${t.kind} (${t.title.toLowerCase()})` })),
  help: "Written into the pot as text. A work record must carry exactly this kind for the pot's order to be paid on a receipt.",
};

const openPot = simple({
  id: "open-pot",
  title: "Open a pot",
  action: "Open the pot",
  contract: "crowdPots",
  fields: [
    KIND_FIELD,
    { ...SPEC_FIELD, label: "The job text", name: "spec" },
    { name: "target", label: "Target", kind: "imd", unit: "IMD", initial: "5", required: true },
    {
      name: "minPay",
      label: "Opening price of the order",
      kind: "imd",
      unit: "IMD",
      initial: "2",
      required: true,
      help: "The order's price starts here and rises to the target while it waits for a runner.",
    },
    { name: "rampHours", label: "Price rises over", kind: "number", unit: "hours", initial: "24" },
    {
      name: "bond",
      label: "Runner's bond",
      kind: "imd",
      unit: "IMD",
      initial: "0.5",
      required: true,
      help: "Between the desk's minimum of 0.25 IMD and the target.",
    },
    { name: "fundDays", label: "Collect for", kind: "number", unit: "days", initial: "3", required: true },
    {
      name: "hireDays",
      label: "Wait for a runner for",
      kind: "number",
      unit: "days",
      initial: "7",
      required: true,
    },
    {
      name: "deliveryDays",
      label: "Delivery time",
      kind: "number",
      unit: "days",
      initial: "7",
      required: true,
    },
    {
      name: "allowClaimed",
      label: "Let the pot's order accept a bonded delivery claim",
      kind: "checkbox",
      initial: "false",
      help: "Fixed when the pot opens and shown to every contributor. A pot that allows claims accepts that an untrue claim nobody challenges within 24 hours is paid, and that a challenge nothing decides refunds the pot. A pot cannot name an arbiter.",
    },
    {
      name: "firstChip",
      label: "Your own first chip (optional)",
      kind: "imd",
      unit: "IMD",
      initial: "0",
    },
  ],
  plan(values, ctx) {
    const template = templateBySlug(values.template ?? "");
    const spec = (values.spec ?? "").trim();
    const problems: string[] = [];
    if (!template) problems.push("Choose the job's kind.");
    else problems.push(...specProblems(template.kind, spec));
    problems.push(
      ...amountProblems([
        ["Target", values.target],
        ["Opening price", values.minPay],
        ["Runner's bond", values.bond],
        ["Your first chip", values.firstChip],
      ]),
    );
    const target = imd(values.target);
    const minPay = imd(values.minPay);
    const bond = imd(values.bond);
    const firstChip = (values.firstChip ?? "").trim() === "" ? 0n : imd(values.firstChip);
    const fundSecs = seconds(values.fundDays, 86_400);
    const hireSecs = seconds(values.hireDays, 86_400);
    const deliverySecs = seconds(values.deliveryDays, 86_400);
    const rampTyped = seconds(values.rampHours ?? "0", 3600);
    if (target === null || target < POTS.MIN_TARGET) problems.push("The target is at least 1 IMD.");
    if (minPay === null || minPay === 0n) problems.push("Give the order's opening price, in IMD.");
    if (target !== null && minPay !== null && minPay > target)
      problems.push("The opening price cannot be more than the target.");
    if (bond === null || bond < DESK.MIN_BOND || (target !== null && bond > target))
      problems.push("The bond is between 0.25 IMD and the target.");
    if (firstChip === null) problems.push("Give your first chip in IMD, or leave it at 0.");
    if (fundSecs === null || fundSecs < POTS.MIN_FUND_SECS || fundSecs > POTS.MAX_FUND_SECS)
      problems.push("A pot collects for between one hour and 30 days.");
    if (hireSecs === null || hireSecs < POTS.MIN_HIRE_SECS || hireSecs > POTS.MAX_HIRE_SECS)
      problems.push("A pot's order waits for a runner for between one and 30 days.");
    if (deliverySecs === null || deliverySecs < DESK.MIN_DELIVERY || deliverySecs > POTS.MAX_DELIVERY_SECS)
      problems.push("The delivery time is between three and 30 days.");
    const flat = target !== null && minPay !== null && minPay === target;
    const rampSecs = flat ? 0 : rampTyped;
    if (!flat && (rampSecs === null || rampSecs === 0 || (hireSecs !== null && rampSecs > hireSecs)))
      problems.push(
        "The price rises over at least a moment and at most the time the order waits for a runner. Or make the opening price equal to the target.",
      );
    if (
      problems.length > 0 ||
      !template ||
      target === null ||
      minPay === null ||
      bond === null ||
      firstChip === null ||
      fundSecs === null ||
      hireSecs === null ||
      deliverySecs === null ||
      rampSecs === null
    )
      return { ok: false, problems };
    const allowClaimed = values.allowClaimed === "true";
    const terms = {
      kind: template.kind,
      target,
      minPay,
      rampSecs,
      bond,
      deliverySecs,
      hireSecs,
      fundSecs,
      allowClaimed,
    };
    const tuple = `(${[template.kind, target, minPay, rampSecs, bond, deliverySecs, hireSecs, fundSecs, allowClaimed].join(",")})`;
    const open = call(
      "crowdPots",
      ctx,
      crowdPotsAbi,
      "openPot",
      [terms, stringToHex(spec), firstChip],
      `Open the pot: pin the kind "${template.kind}" and the job text${firstChip > 0n ? ", and chip in" : ""}`,
      { castArgs: [shellQuote(tuple), castText(spec), firstChip.toString()] },
    );
    return {
      ok: true,
      calls: firstChip > 0n ? [approve("crowdPots", ctx.addresses.crowdPots, firstChip), open] : [open],
      summary: [
        `The pot collects up to ${formatImd(target)} IMD for ${formatDuration(fundSecs * 1000)}. Its job kind is written into it as text, "${template.kind}", so every contributor can read what is being ordered; the desk pins the hash of that text.`,
        `When it is full anyone launches it: the pot becomes the employer of one order for ${formatImd(target)} IMD at most, priced from ${formatImd(minPay)} IMD${flat ? "" : ` and rising over ${formatDuration(rampSecs * 1000)}`}, with a runner's bond of ${formatImd(bond)} IMD, ${formatDuration(hireSecs * 1000)} to find a runner and ${formatDuration(deliverySecs * 1000)} for delivery.`,
        allowClaimed
          ? "The pot's order accepts a bonded delivery claim. An untrue claim nobody challenges within 24 hours is paid, and a challenge nothing decides refunds the pot; a pot has no arbiter."
          : "The pot's order pays only on an on-chain receipt. While IdentityMD's receipts are late, such an order ends in a refund to the contributors.",
        "Opening a pot gives you no rights over it. Nobody can change its terms, and every chip is refundable pro rata if the work is not delivered.",
        firstChip > 0n
          ? `You chip in ${formatImd(firstChip)} IMD in the same transaction.`
          : "You chip in nothing now; anyone, you included, can chip in afterwards.",
      ],
    };
  },
});

const chipIn = simple({
  id: "chip-in",
  title: "Chip in",
  action: "Chip in",
  contract: "crowdPots",
  fields: [
    { name: "potId", label: "Pot number", kind: "number", required: true },
    { name: "amount", label: "Your chip", kind: "imd", unit: "IMD", initial: "0.5", required: true },
  ],
  plan(values, ctx) {
    const potId = whole(values.potId);
    const amount = imd(values.amount);
    const problems: string[] = amountProblems([["Your chip", values.amount]]);
    if (potId === null) problems.push("Give the pot number.");
    if (amount === null || amount === 0n) problems.push("Give your chip in IMD.");
    if (problems.length > 0 || potId === null || amount === null) return { ok: false, problems };
    return {
      ok: true,
      calls: [
        approve("crowdPots", ctx.addresses.crowdPots, amount),
        call(
          "crowdPots",
          ctx,
          crowdPotsAbi,
          "chipIn",
          [potId, amount],
          `Add up to ${formatImd(amount)} IMD to pot ${potId}`,
        ),
      ],
      summary: [
        `You add ${formatImd(amount)} IMD to pot ${potId}. If the pot needs less than that, it takes only what it needs. A pot that is full, launched, out of time or unknown takes nothing, and the call does not revert.`,
        "If the work is not delivered, your chip is refundable in proportion. If it is delivered for less than the pot raised, the difference is shared back the same way.",
        "There is no withdrawal while the pot runs: a chip is locked until the pot's order has ended.",
      ],
    };
  },
});

const launchPot = simple({
  id: "launch-pot",
  title: "Launch a full pot",
  action: "Launch the pot",
  contract: "crowdPots",
  fields: [
    { name: "potId", label: "Pot number", kind: "number", required: true },
    {
      ...SPEC_FIELD,
      label: "The pot's job text, exactly as it was pinned",
      help: "The pot keeps only the hash of its job text. Launching hands the text to the desk again, and it must hash to the pot's hash.",
    },
  ],
  plan(values, ctx) {
    const potId = whole(values.potId);
    const spec = (values.spec ?? "").trim();
    const problems: string[] = [];
    if (potId === null) problems.push("Give the pot number.");
    const checked = checkSpec(spec);
    if (!checked.ok) problems.push(specProblemWords(checked.problem));
    if (problems.length > 0 || potId === null) return { ok: false, problems };
    return {
      ok: true,
      calls: [
        call(
          "crowdPots",
          ctx,
          crowdPotsAbi,
          "launch",
          [potId, stringToHex(spec)],
          `Turn full pot ${potId} into one order on the hire desk`,
          { castArgs: [potId.toString(), castText(spec)] },
        ),
      ],
      summary: [
        "Anyone may do this once the pot is full, until one day after its collecting deadline. The pot becomes the employer of one order for the whole amount, with the terms fixed when it opened.",
        "The text must be the pot's own: a text that does not hash to the pot's hash is refused.",
      ],
    };
  },
});

const claimRefund = simple({
  id: "claim-refund",
  title: "Claim a pot refund",
  action: "Claim the refund",
  contract: "crowdPots",
  fields: [
    { name: "potId", label: "Pot number", kind: "number", required: true },
    {
      name: "contributor",
      label: "Contributor",
      kind: "address",
      required: true,
      help: "The money goes to this address whoever sends the transaction.",
    },
  ],
  plan(values, ctx) {
    const potId = whole(values.potId);
    const who = (values.contributor ?? "").trim();
    const problems: string[] = [];
    if (potId === null) problems.push("Give the pot number.");
    if (!isAddress(who, { strict: false })) problems.push("Give the contributor's address.");
    if (problems.length > 0 || potId === null) return { ok: false, problems };
    return {
      ok: true,
      calls: [
        call(
          "crowdPots",
          ctx,
          crowdPotsAbi,
          "claimRefund",
          [potId, getAddress(who)],
          `Pay ${getAddress(who)} their share of what pot ${potId} gives back`,
        ),
      ],
      summary: [
        "Anyone may call this for anyone: the money only ever goes to the contributor.",
        "If the pot's order is past its time, this call has the desk end it first; a receipt that lands after that no longer pays that runner.",
      ],
    };
  },
});

const ring = simple({
  id: "ring",
  title: "Ring the Doorbell",
  action: "Ring",
  contract: "doorbell",
  fields: [],
  plan(_values, ctx) {
    return {
      ok: true,
      calls: [
        call("doorbell", ctx, doorbellAbi, "ring", [], "Ring the Doorbell once", { gas: GAS_LIMIT.RING }),
      ],
      summary: [
        "Anyone may ring. Every 25th ring, if the Doorbell holds enough IMD, it opens an order on the hire desk from its own code: a contract with no owner hiring the swarm.",
        "A ring that hires uses about 354,000 gas, so every ring is sent with a limit of 600,000; what is not used is returned.",
      ],
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Standing Questions and the Jobs Report
// ---------------------------------------------------------------------------------------------

const FEED_FIELDS: FlowField[] = [
  {
    name: "feed",
    label: "Feed",
    kind: "select",
    initial: "payrolls",
    options: [
      ...HOUSE_FEED_NAMES.map((name) => ({ value: name, label: `${name}: ${HOUSE_FEEDS[name].title}` })),
      { value: "other", label: "another feed (give its id below)" },
    ],
  },
  {
    name: "feedId",
    label: "Feed id, for another feed",
    kind: "bytes32",
    placeholder: "0x… (32 bytes); leave empty for a house feed",
  },
];

/** The feed a form names: one of the three house feeds, or an id typed in. */
function feedOf(values: Record<string, string>, problems: string[]): { id: Hex; name: string } | null {
  const typed = (values.feedId ?? "").trim();
  if (typed !== "") {
    const id = bytes32(typed);
    if (!id) {
      problems.push("Give the feed id: 0x and 64 hex characters.");
      return null;
    }
    const house = HOUSE_FEED_NAMES.find((name) => HOUSE_FEEDS[name].id.toLowerCase() === id);
    return { id, name: house ? `the ${house} feed` : `feed ${id.slice(0, 10)}…` };
  }
  const name = HOUSE_FEED_NAMES.find((n) => n === values.feed);
  if (!name) {
    problems.push("Choose a house feed, or give another feed's id.");
    return null;
  }
  return { id: HOUSE_FEEDS[name].id, name: `the ${name} feed` };
}

const TIP_RULE =
  "The keeper tip is part of what a request costs the meter. It is set aside when the request is made, credited to the keeper that made it only when the round is answered, and goes back onto the meter when the round fails. Whoever delivers the answer, the Intake's callback or somebody calling submit, the tip is the opener's: handing an answer in earns nothing.";

const fundFeed = simple({
  id: "fund-feed",
  title: "Fund a feed's meter",
  action: "Fund the meter",
  contract: "questions",
  fields: [
    ...FEED_FIELDS,
    { name: "amount", label: "Amount", kind: "imd", unit: "IMD", initial: "5", required: true },
  ],
  plan(values, ctx) {
    const problems: string[] = amountProblems([["Amount", values.amount]]);
    const feed = feedOf(values, problems);
    const amount = imd(values.amount);
    if (amount === null || amount === 0n) problems.push("Give the amount in IMD.");
    if (problems.length > 0 || !feed || amount === null) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "questions",
          ctx,
          questionsAbi,
          "costOf",
          [feed.id],
          "What one request costs the meter now (the Intake's price plus the keeper tip; zero means none can be bought)",
        ),
      ],
      calls: [
        approve("questions", ctx.addresses.questions, amount),
        call(
          "questions",
          ctx,
          questionsAbi,
          "fund",
          [feed.id, amount],
          `Add ${formatImd(amount)} IMD to the meter of ${feed.name}`,
        ),
      ],
      summary: [
        `You add ${formatImd(amount)} IMD to the meter of ${feed.name} and receive meter shares for it.`,
        "Each request the feed buys is paid from the meter, by every holder of its shares in proportion. Your shares can be redeemed at any time, with defund, for their part of what has not been spent.",
        TIP_RULE,
        "A request is paid for whether or not it is answered: the Intake never refunds its price. Fund only a feed whose question and parameters you have read.",
      ],
    };
  },
});

const defundFeed = simple({
  id: "defund-feed",
  title: "Take your unspent share back",
  action: "Redeem the shares",
  contract: "questions",
  fields: [
    ...FEED_FIELDS,
    {
      name: "shares",
      label: "Meter shares to redeem",
      kind: "text",
      placeholder: "leave empty for all of them",
      help: "A whole number of share units. Naming more than you hold redeems all you hold.",
    },
  ],
  plan(values, ctx) {
    const problems: string[] = [];
    const feed = feedOf(values, problems);
    const typed = (values.shares ?? "").trim();
    const shares = typed === "" ? MAX_UINT256 : whole(typed);
    if (shares === null || shares === 0n) problems.push("Give a whole number of shares, or leave it empty.");
    if (problems.length > 0 || !feed || shares === null) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "questions",
          ctx,
          questionsAbi,
          "redeemable",
          [feed.id, "<your-address>"],
          "What your shares of the meter would fetch now, in IMD-wei",
        ),
      ],
      calls: [
        call(
          "questions",
          ctx,
          questionsAbi,
          "defund",
          [feed.id, shares],
          typed === ""
            ? `Redeem all your shares of the meter of ${feed.name}`
            : `Redeem ${shares} shares of the meter of ${feed.name}`,
        ),
      ],
      summary: [
        "You are paid your part of what the meter has not spent. This is never blocked by the feed's state: a pending round, a failed round or a feed that has stopped asking does not hold your money.",
        "What the meter already spent on requests is gone, answered or not.",
      ],
    };
  },
});

const requestFeed = simple({
  id: "request-feed",
  title: "Ask a feed's next question",
  action: "Buy the next answer",
  contract: "questions",
  fields: FEED_FIELDS,
  plan(values, ctx) {
    const problems: string[] = [];
    const feed = feedOf(values, problems);
    if (problems.length > 0 || !feed) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "questions",
          ctx,
          questionsAbi,
          "canRequest",
          [feed.id],
          "Whether a request would go through now and, if not, why (0 none, 3 round pending, 4 too soon, 9 meter too low)",
        ),
      ],
      calls: [
        call(
          "questions",
          ctx,
          questionsAbi,
          "request",
          [feed.id],
          `Buy the next answer of ${feed.name} from the IdentityMD Intake, with the meter's IMD`,
        ),
      ],
      summary: [
        "Anyone may do this when the feed is due. It costs you gas only: the Intake's price is paid from the feed's meter, and the question is the feed's own stored text with the newest block window.",
        TIP_RULE,
        "Send it as a transaction of its own. IdentityMD's service serves only the first Intake request of a transaction, so a request batched behind another is paid for and never answered.",
      ],
    };
  },
});

const collectTips = simple({
  id: "collect-tips",
  title: "Collect keeper tips",
  action: "Collect the tips",
  contract: "questions",
  fields: [],
  plan(_values, ctx) {
    return {
      ok: true,
      reads: [
        read(
          "questions",
          ctx,
          questionsAbi,
          "tipsOf",
          ["<your-address>"],
          "What you have earned and what is still set aside for rounds you opened",
        ),
      ],
      calls: [
        call(
          "questions",
          ctx,
          questionsAbi,
          "collectTips",
          [],
          "Pay yourself the keeper tips you have earned",
        ),
      ],
      summary: [
        "Pays the caller the tips it has earned by answered rounds. It pays nothing, without reverting, when none are earned.",
        "A tip is earned by an answer and by nothing else: asking earns nothing by itself, and the tip of a round that fails goes back onto the meter.",
      ],
    };
  },
});

const abandonFeed = simple({
  id: "abandon-feed",
  title: "Close a round that will not be answered",
  action: "Close the round",
  contract: "questions",
  fields: FEED_FIELDS,
  plan(values, ctx) {
    const problems: string[] = [];
    const feed = feedOf(values, problems);
    if (problems.length > 0 || !feed) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "questions",
          ctx,
          questionsAbi,
          "canAbandon",
          [feed.id],
          "What the call would do now (0 nothing, 1 start the 30-minute wait, 2 close the round) and when the round can be closed",
        ),
      ],
      calls: [
        call(
          "questions",
          ctx,
          questionsAbi,
          "abandon",
          [feed.id],
          `Close the pending round of ${feed.name}, or record that the Intake completed its request and start the 30-minute wait`,
        ),
      ],
      summary: [
        `Anyone may do this. One call closes a round once ${formatDuration(QUESTIONS_WAITS.ABANDON_AFTER_SILENCE * 1000)}, the time the feed's answers stay valid, ${formatDuration(QUESTIONS_WAITS.ISSUED_AT_TOLERANCE * 1000)} and one second have passed since its request: ${formatDuration(Number(silenceSeconds(HOUSE_FEEDS.payrolls.params.validFor)) * 1000)} and one second for a house feed. canAbandon gives the exact moment for the feed you name.`,
        `Sooner than that, a round can be closed only if the Intake completed its request without an answer being stored, and that takes two calls: the first records that the completion was seen, the second closes the round ${formatDuration(QUESTIONS_WAITS.ABANDON_AFTER_COMPLETED * 1000)} later.`,
        "The round's tip goes back onto the meter, and the feed waits longer before it asks again.",
        "Do not close a round while IdentityMD's service shows its request as completing: the answer exists and is on its way, and an answer that arrives after its round was closed is refused.",
      ],
    };
  },
});

const printReport = simple({
  id: "print-report",
  title: "Print the Jobs Report",
  action: "Print",
  contract: "jobsReport",
  fields: [],
  plan(_values, ctx) {
    return {
      ok: true,
      calls: [
        call(
          "jobsReport",
          ctx,
          jobsReportAbi,
          "print",
          [],
          "Copy newly answered rounds of the payrolls and hires feeds into the report",
        ),
      ],
      summary: [
        "Anyone may do this. It copies at most eight newly answered rounds a call into the public record, and attaches each count of payments to the print whose blocks it shares. A call with nothing new changes nothing.",
        "It never reads the employers feed: the report is complete without the weekly list.",
      ],
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------------------------

function payrollCall(def: {
  id: string;
  title: string;
  action: string;
  functionName: string;
  label: string;
  summary: string[];
  reads?: { functionName: string; label: string }[];
}): FlowDef {
  return simple({
    id: def.id,
    title: def.title,
    action: def.action,
    contract: "payroll",
    fields: [],
    plan(_values, ctx) {
      return {
        ok: true,
        ...(def.reads
          ? { reads: def.reads.map((r) => read("payroll", ctx, payrollAbi, r.functionName, [], r.label)) }
          : {}),
        calls: [call("payroll", ctx, payrollAbi, def.functionName, [], def.label)],
        summary: def.summary,
      };
    },
  });
}

const claimSeat = simple({
  id: "claim-seat",
  title: "Claim a seat's share",
  action: "Pay the seat's owner",
  contract: "payroll",
  fields: [
    { name: "tokenId", label: "Seat number", kind: "number", required: true, placeholder: "0 to 1999" },
  ],
  plan(values, ctx) {
    const tokenId = whole(values.tokenId);
    if (tokenId === null || tokenId >= BigInt(MAINNET.SEAT_COUNT))
      return { ok: false, problems: ["Give a seat number from 0 to 1999."] };
    return {
      ok: true,
      reads: [
        read(
          "payroll",
          ctx,
          payrollAbi,
          "seatClaimable",
          [tokenId.toString()],
          "What the seat can claim now, in IMD-wei",
        ),
      ],
      calls: [
        call(
          "payroll",
          ctx,
          payrollAbi,
          "claimSeat",
          [tokenId],
          `Pay seat #${tokenId}'s share of the seat pool to whoever owns the seat now`,
        ),
      ],
      summary: [
        "The IMD goes to the seat's current owner, never to the caller. Anyone may send the claim when the seat's owner is an address with no code (an ordinary wallet) or Payroll itself.",
        "When the owner is any other address with code (an escrow, a marketplace, a loan, a contract wallet, or a wallet that has delegated to code), only the owner may send it; anyone else's call reverts ContractOwnerMustClaim. Nobody can push IMD into a contract that did not ask for it.",
        "What a seat has not claimed follows the seat: it keeps accruing, and it is paid to whoever owns the seat when the claim is made.",
      ],
    };
  },
});

const claimTip = simple({
  id: "claim-tip",
  title: "Claim an agent's tips",
  action: "Pay the tips",
  contract: "payroll",
  fields: [{ name: "agentId", label: "Agent id (ERC-8004)", kind: "number", required: true }],
  plan(values, ctx) {
    const agentId = whole(values.agentId);
    if (agentId === null) return { ok: false, problems: ["Give the agent id."] };
    return {
      ok: true,
      reads: [
        read(
          "payroll",
          ctx,
          payrollAbi,
          "tipOwed",
          [agentId.toString()],
          "The tips waiting for the agent, in IMD-wei",
        ),
      ],
      calls: [
        call(
          "payroll",
          ctx,
          payrollAbi,
          "claimTip",
          [agentId],
          `Pay agent ${agentId}'s tips to the owner of the seat it is bound to`,
        ),
      ],
      summary: [
        "The agent's seat is looked up in IdentityMD's Adapter at that moment and the tips go to the seat's owner, never to the caller. Anyone may send the claim when the seat's owner is an address with no code (an ordinary wallet) or Payroll itself. When the owner is any other address with code (a contract, or a wallet that has delegated to code), only the owner may send it; anyone else's call reverts ContractOwnerMustClaim.",
        "It reverts while the agent is bound to no seat. A tip that cannot be claimed waits 180 to 360 days and can then be moved to the seat pool by anyone.",
      ],
    };
  },
});

const drip = payrollCall({
  id: "drip",
  title: "Drip the staker stream",
  action: "Send what is due to sIMD",
  functionName: "drip",
  label: "Move the due part of the staker stream into sIMD",
  reads: [
    {
      functionName: "stream",
      label:
        "The stream now; the last figure is what a drip would send (zero means the call would revert or send nothing)",
    },
  ],
  summary: [
    "Anyone may call this, at most once every ten minutes. It sends at most one hour of the stream, by a plain IMD transfer to sIMD, which every holder of sIMD at that moment shares.",
    "It reverts inside the ten-minute gap and while sIMD has no stakers; stream() reports zero due in both cases.",
  ],
});

const book = payrollCall({
  id: "book",
  title: "Book plain transfers",
  action: "Book what arrived",
  functionName: "book",
  label: "Split any IMD that reached Payroll by plain transfer",
  reads: [{ functionName: "unbooked", label: "IMD that arrived by plain transfer and is not split yet" }],
  summary: [
    "Anyone may call this. IMD sent to Payroll without a call is split the same way as a fee: 50% stakers, 30% seats, 20% feeds.",
  ],
});

const fundFeeds = payrollCall({
  id: "fund-feeds",
  title: "Top up the house feeds' meters",
  action: "Fund the feeds",
  functionName: "fundFeeds",
  label:
    "Top Payroll's own position on each house meter up to its runway, then release budget whose wait is over",
  reads: [
    {
      functionName: "feedShortfalls",
      label:
        "How far Payroll's own position on each house meter is below its runway, in the order payrolls, hires, employers: what each would be offered with budget to spare",
    },
    {
      functionName: "feedBudget",
      label:
        "The feed budget: total, the part that falls due next, the part releasable now, the next boundary",
    },
  ],
  summary: [
    "Anyone may call this. From the 20% of fees booked for the feeds, Payroll tops its own position on each of the three house meters up to its runway: 14 requests for each daily feed, 4 for the weekly one. It counts only its own position, not what others put on a meter.",
    "It is also the only call that releases feed budget: budget no meter needed within 14 to 28 days goes to the stakers' stream, after the meters have been served.",
  ],
});

// ---------------------------------------------------------------------------------------------
// Rules (launch C)
// ---------------------------------------------------------------------------------------------

const RULE_ID: FlowField = { name: "id", label: "Rule number", kind: "number", required: true };

const createRule: FlowDef = {
  id: "create-rule",
  title: "Write a standing rule",
  contract: "rules",
  action: "Create the rule",
  fields(preset) {
    return [
      {
        name: "condKind",
        label: "WHEN",
        kind: "select",
        initial: "view",
        options: [
          { value: "view", label: "a contract's view call crosses a line" },
          { value: "feed", label: "a Standing Question's newest answer crosses a line" },
        ],
      },
      {
        ...CONDITION_FIELDS[0],
        label: "this contract (a view), or the Questions contract (a feed)",
      } as FlowField,
      { ...CONDITION_FIELDS[1], required: false, help: "For a view call only." } as FlowField,
      CONDITION_FIELDS[2] as FlowField,
      {
        name: "feedId",
        label: "the feed (for a feed condition)",
        kind: "bytes32",
        placeholder: "0x… (32 bytes)",
      },
      {
        name: "maxAgeHours",
        label: "no older than (for a feed condition)",
        kind: "number",
        unit: "hours",
        initial: "24",
      },
      CONDITION_FIELDS[3] as FlowField,
      CONDITION_FIELDS[4] as FlowField,
      {
        name: "action",
        label: "THEN",
        kind: "select",
        initial: "hire",
        options: [
          { value: "hire", label: "hire: open an order on the hire desk" },
          { value: "pay", label: "pay: send a fixed amount to a fixed address" },
        ],
      },
      { ...TEMPLATE_FIELD, label: "hire" },
      { ...SPEC_FIELD, required: false },
      ...payFields(preset)
        .filter((f) => f.name !== "expiresDays" && f.name !== "arbiter")
        .map((f) =>
          f.name === "maxPay"
            ? { ...f, initial: "5", required: false }
            : f.name === "minPay"
              ? { ...f, initial: "2", required: false }
              : f.name === "rampHours"
                ? { ...f, initial: "24", required: false }
                : f,
        ),
      {
        name: "orderDays",
        label: "Each order waits for a runner for",
        kind: "number",
        unit: "days",
        initial: "14",
      },
      { name: "payRecipient", label: "pay this address", kind: "address", placeholder: "0x…" },
      { name: "payAmount", label: "this much", kind: "imd", unit: "IMD" },
      {
        name: "tip",
        label: "Tip for whoever fires the rule",
        kind: "imd",
        unit: "IMD",
        initial: "0.05",
        required: true,
      },
      { name: "cooldownHours", label: "Wait between fires", kind: "number", unit: "hours", initial: "0" },
      {
        name: "maxFires",
        label: "Fire at most",
        kind: "number",
        unit: "times",
        initial: "1",
        required: true,
      },
      {
        name: "deposit",
        label: "Deposit into the rule's escrow",
        kind: "imd",
        unit: "IMD",
        initial: "5.05",
        required: true,
        help: "One fire costs the order's most (or the payment) plus the tip. A rule with less than that waits until it is topped up.",
      },
    ];
  },
  plan(values, ctx) {
    const problems: string[] = [];
    const feedCondition = values.condKind === "feed";
    const target = (values.condTarget ?? "").trim();
    if (!isAddress(target, { strict: false }))
      problems.push(
        feedCondition
          ? "WHEN: give the address of the Questions contract the feed lives in."
          : "WHEN: give the address of the contract to watch.",
      );
    let data: Hex = "0x";
    let feedId: Hex = ZERO_BYTES32;
    let maxAge = 0;
    let conditionWords = "";
    if (feedCondition) {
      const id = bytes32(values.feedId);
      if (!id || /^0x0+$/.test(id)) problems.push("Give the feed's id: 0x and 64 hex characters.");
      else feedId = id;
      const age = seconds(values.maxAgeHours, 3600);
      if (age === null || age === 0 || age > 0xffffffff)
        problems.push("Say how old an answer may be, in hours; it cannot be zero.");
      else maxAge = age;
      conditionWords = `the newest answer of feed ${feedId.slice(0, 10)}… at ${target}, no older than ${formatDuration(maxAge * 1000)}`;
    } else {
      const view = parseViewCall((values.condFunction ?? "").trim(), (values.condArg ?? "").trim(), problems);
      if (view) {
        data = `${view.selector}${view.arg ? view.arg.slice(2) : ""}` as Hex;
        conditionWords = `${view.signature} on ${target}`;
      }
    }
    const cmp = Number(values.condCmp ?? "1");
    const comparison = COMPARISONS.find((c) => c.code === cmp);
    if (!comparison) problems.push("Choose how to compare.");
    const threshold = whole(values.condThreshold);
    if (threshold === null) problems.push("The number to compare with must be a whole number.");

    const hireAction = values.action !== "pay";
    const tip = imd(values.tip);
    const deposit = imd(values.deposit);
    const cooldown = seconds(values.cooldownHours ?? "0", 3600);
    const maxFires = whole(values.maxFires);
    problems.push(
      ...amountProblems([
        ["Tip", values.tip],
        ["Deposit", values.deposit],
      ]),
    );
    if (tip === null) problems.push("Give the tip in IMD (it may be 0).");
    if (deposit === null) problems.push("Give the deposit in IMD (it may be 0).");
    if (cooldown === null || cooldown > 0xffffffff) problems.push("Give the wait between fires in hours.");
    if (maxFires === null || maxFires === 0n || maxFires > 0xffffffffn)
      problems.push("A rule fires at least once.");

    let spend = 0n;
    let spec = "";
    let hire = {
      kindHash: ZERO_BYTES32,
      minPay: 0n,
      maxPay: 0n,
      rampSecs: 0,
      deliverySecs: 0,
      bond: 0n,
      runnerOnly: ZERO_ADDRESS,
      arbiter: ZERO_ADDRESS,
      flags: 0,
      orderTtl: 0,
    };
    let pay = { recipient: ZERO_ADDRESS, amount: 0n };
    let actionWords = "";
    let claims = false;
    if (hireAction) {
      const template = templateBySlug(values.template ?? "");
      spec = (values.spec ?? "").trim();
      if (!template) problems.push("THEN: choose what kind of job to order.");
      else problems.push(...specProblems(template.kind, spec));
      problems.push(
        ...amountProblems([
          ["The most each order pays", values.maxPay],
          ["Opening price", values.minPay],
        ]),
      );
      const maxPay = imd(values.maxPay);
      const minPay = imd(values.minPay);
      const ramp = seconds(values.rampHours ?? "0", 3600);
      const ttl = seconds(values.orderDays, 86_400);
      if (maxPay === null || maxPay === 0n) problems.push("Say the most each order pays, in IMD.");
      if (minPay === null) problems.push("Say each order's opening price, in IMD.");
      if (maxPay !== null && minPay !== null && minPay > maxPay)
        problems.push("The opening price cannot be more than the most an order pays.");
      if (ttl === null || ttl === 0 || ttl > 0xffffffff)
        problems.push("Say how many days each order waits for a runner.");
      if (ramp === null) problems.push("Give the price ramp in hours.");
      claims = values.allowClaimed === "true";
      if (template && maxPay !== null && minPay !== null && ttl !== null && ramp !== null) {
        hire = {
          kindHash: kindHash(template.kind),
          minPay,
          maxPay,
          rampSecs: minPay === maxPay ? 0 : ramp,
          deliverySecs: DESK.MIN_DELIVERY,
          bond: DESK.MIN_BOND,
          runnerOnly: ZERO_ADDRESS,
          arbiter: ZERO_ADDRESS,
          // The callback returns a delivered order's change to the rule inside the settlement.
          flags: ORDER_FLAG.CALLBACK | (claims ? ORDER_FLAG.ALLOW_CLAIMED : 0),
          orderTtl: ttl,
        };
        spend = maxPay;
        actionWords = `open an order for ${template.staff} (kind ${template.kind}) paying ${formatImd(minPay)} to ${formatImd(maxPay)} IMD`;
      }
    } else {
      const recipient = (values.payRecipient ?? "").trim();
      const amount = imd(values.payAmount);
      problems.push(...amountProblems([["The payment", values.payAmount]]));
      if (!isAddress(recipient, { strict: false }) || /^0x0{40}$/i.test(recipient))
        problems.push("THEN pay: give the address to pay.");
      if (amount === null || amount === 0n) problems.push("THEN pay: give the amount in IMD.");
      if (isAddress(recipient, { strict: false }) && amount !== null) {
        pay = { recipient: getAddress(recipient), amount };
        spend = amount;
        actionWords = `pay ${formatImd(amount)} IMD to ${getAddress(recipient)}`;
      }
    }
    if (
      problems.length > 0 ||
      !comparison ||
      threshold === null ||
      tip === null ||
      deposit === null ||
      cooldown === null ||
      maxFires === null
    )
      return { ok: false, problems };

    const when = {
      kind: feedCondition ? RULE.COND_FEED : RULE.COND_VIEW,
      cmp,
      maxAge,
      target: getAddress(target),
      threshold,
      feedId,
      data,
    };
    const params = {
      when,
      action: hireAction ? RULE.ACT_HIRE : RULE.ACT_PAY,
      hire,
      pay,
      tip,
      cooldown,
      maxFires: Number(maxFires),
    };
    const tuple = `((${[when.kind, when.cmp, when.maxAge, when.target, when.threshold, when.feedId, when.data].join(",")}),${params.action},(${[hire.kindHash, hire.minPay, hire.maxPay, hire.rampSecs, hire.deliverySecs, hire.bond, hire.runnerOnly, hire.arbiter, hire.flags, hire.orderTtl].join(",")}),(${pay.recipient},${pay.amount}),${tip},${cooldown},${params.maxFires})`;
    const cost = spend + tip;
    const create = call(
      "rules",
      ctx,
      rulesAbi,
      "createRule",
      [params, hireAction ? stringToHex(spec) : "0x", deposit],
      "Create the rule and escrow its deposit",
      { castArgs: [shellQuote(tuple), hireAction ? castText(spec) : "0x", deposit.toString()] },
    );
    return {
      ok: true,
      calls: deposit > 0n ? [approve("rules", ctx.addresses.rules, deposit), create] : [create],
      summary: [
        `WHEN ${conditionWords} ${comparison.words} ${threshold}, THEN ${actionWords}.`,
        `Anyone may fire the rule while that holds and is paid the tip of ${formatImd(tip)} IMD from the rule's escrow. One fire costs the rule ${formatImd(cost)} IMD; you deposit ${formatImd(deposit)} IMD${deposit < cost ? ", which is less than one fire, so the rule waits until it is topped up" : ""}.`,
        `It fires at most ${maxFires} time${maxFires === 1n ? "" : "s"}${cooldown > 0 ? `, at least ${formatDuration(cooldown * 1000)} apart` : ""}${feedCondition ? ", and at most once for each newly answered round of the feed" : ""}. The condition is read when the rule is fired, and only then: one true reading fires it.`,
        hireAction
          ? claims
            ? "Each order the rule opens accepts the desk's bonded delivery claim: an untrue claim nobody challenges within 24 hours is paid, and a challenge nothing decides refunds the order. Rules never challenges and never arbitrates."
            : "Each order the rule opens pays only on an on-chain receipt. While IdentityMD's receipts are late such an order is not paid and ends in a refund, which returns to the rule; the tip of the fire that opened it is spent."
          : "The payment moves in the transaction that fires the rule. A condition a caller can make true for the length of one transaction (a spot balance, a pool price) lets that caller fire it.",
        ...(hireAction ? [] : [zapPayeeLine(ctx, "the recipient", "the payment", "fire")]),
        "You, and only you, can cancel the rule at any time and take back what it has not spent. Nobody else has any power over it.",
      ],
    };
  },
};

const fireRule = simple({
  id: "fire-rule",
  title: "Fire a rule",
  action: "Fire the rule",
  contract: "rules",
  fields: [
    RULE_ID,
    {
      ...SPEC_FIELD,
      name: "spec",
      label: "The rule's job text (a HIRE rule only)",
      required: false,
      help: "A HIRE rule keeps only the hash of its job text; firing hands the text over again, exactly as its RuleCreated event published it. Leave empty for a PAY rule.",
    },
  ],
  plan(values, ctx) {
    const id = whole(values.id);
    if (id === null) return { ok: false, problems: ["Give the rule number."] };
    const spec = (values.spec ?? "").trim();
    if (spec !== "") {
      const checked = checkSpec(spec);
      if (!checked.ok) return { ok: false, problems: [specProblemWords(checked.problem)] };
    }
    const hireRule = spec !== "";
    return {
      ok: true,
      reads: [
        read("rules", ctx, rulesAbi, "canFire", [id.toString()], "Whether the rule would fire now"),
        read(
          "rules",
          ctx,
          rulesAbi,
          "check",
          [id.toString()],
          "The condition as read now: whether it holds, the value, and for a feed the round",
        ),
      ],
      calls: [
        call(
          "rules",
          ctx,
          rulesAbi,
          "fire",
          [id, hireRule ? stringToHex(spec) : "0x"],
          `Fire rule ${id}: ${hireRule ? "open its order" : "make its payment"} and be paid its tip`,
          {
            castArgs: [id.toString(), hireRule ? castText(spec) : "0x"],
            gas: hireRule ? GAS_LIMIT.FIRE_HIRE : GAS_LIMIT.FIRE_PAY,
          },
        ),
      ],
      summary: [
        "Anyone may fire a rule whose condition holds. The rule opens its order or makes its payment from its own escrow and pays you its tip.",
        "The rule reads its condition with a fixed allowance of 100,000 gas and refuses to start with less than about 122,000 in hand, so the call is sent with the limit above. If the condition does not hold, it reverts and costs only gas.",
      ],
    };
  },
});

const cancelRule = simple({
  id: "cancel-rule",
  title: "Cancel a rule",
  action: "Cancel the rule",
  contract: "rules",
  fields: [RULE_ID],
  plan(values, ctx) {
    const id = whole(values.id);
    if (id === null) return { ok: false, problems: ["Give the rule number."] };
    return {
      ok: true,
      calls: [
        call("rules", ctx, rulesAbi, "cancel", [id], `End rule ${id} and take back its unspent escrow`),
      ],
      summary: [
        "Only the rule's creator can do this. The rule ends for good and its unspent escrow goes to the creator. Orders it already opened stay on the desk; what they return later is sent to the creator by whoever calls reconcile.",
      ],
    };
  },
});

const reconcileRule = simple({
  id: "reconcile-rule",
  title: "Return an order's money to its rule",
  action: "Reconcile",
  contract: "rules",
  fields: [RULE_ID, { name: "orderId", label: "Order number", kind: "number", required: true }],
  plan(values, ctx) {
    const id = whole(values.id);
    const orderId = whole(values.orderId);
    if (id === null || orderId === null)
      return { ok: false, problems: ["Give the rule number and the order number."] };
    return {
      ok: true,
      calls: [
        call(
          "rules",
          ctx,
          rulesAbi,
          "reconcile",
          [id, orderId],
          `Credit rule ${id} with what the desk has returned for its order ${orderId}`,
        ),
      ],
      summary: [
        "Anyone may do this. What the desk has handed back for the order since the last call (a refund, the change of a delivered job, a forfeited bond) returns to the rule's escrow, read from the desk's own books. For a cancelled rule it goes to the creator.",
      ],
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Endowments (launch C)
// ---------------------------------------------------------------------------------------------

const ENDOWMENT_ID: FlowField = { name: "id", label: "Endowment number", kind: "number", required: true };
const AMOUNT: FlowField = { name: "amount", label: "Amount", kind: "imd", unit: "IMD", required: true };
const SEED_LINE = `Creating an endowment costs a seed of ${formatUnits(ENDOWMENT.SEED, 18)} IMD, paid once and never refunded. It is nobody's principal: it is what lets every depositor take back exactly what they put in although every vault conversion rounds against the caller.`;
const NEW_ID_LINE =
  "Read the new endowment's number from the Created event of that transaction, not from a guess: numbers are handed out in order, and somebody else's may have been created in between.";

/**
 * Why nobody should name launch C's Zap as a payee, though Endowments and Rules accept it: each
 * call to Zap ends by sending its caller all the IMD Zap holds (launch C's THREATS.md, Z4, and row 5
 * of its docs/AUDITS.md).
 */
function zapPayeeLine(ctx: FlowContext, as: string, what: string, by: string): string {
  const zap = ctx.addresses.zap;
  return `Zap${zap ? ` (${zap})` : ""} is accepted as ${as} but should not be named: each call to Zap ends by sending its caller all the IMD Zap holds, so whoever calls ${by} can take ${what} in the same transaction (launch C's docs/THREATS.md, Z4).`;
}

const endowCreateMeter = simple({
  id: "endow-create-meter",
  title: "Endow a feed's meter",
  action: "Create the endowment",
  contract: "endowments",
  fields: FEED_FIELDS,
  plan(values, ctx) {
    const problems: string[] = [];
    const feed = feedOf(values, problems);
    if (problems.length > 0 || !feed) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "questions",
          ctx,
          questionsAbi,
          "costOf",
          [feed.id],
          "The feed's cost per request; zero means it cannot be bought now and the creation would revert",
        ),
      ],
      calls: [
        approve("endowments", ctx.addresses.endowments, ENDOWMENT.SEED),
        call(
          "endowments",
          ctx,
          endowmentsAbi,
          "createForMeter",
          [feed.id],
          `Create an endowment whose yield tops up the meter of ${feed.name}`,
        ),
      ],
      summary: [
        `The endowment's target is fixed for good: the meter of ${feed.name}. Nobody, its creator included, can point its yield elsewhere later.`,
        `A harvest never lifts the meter above the cost of ${ENDOWMENT.METER_RUNWAY} requests; yield beyond that stays staked until the meter has room. Harvested IMD stays on the meter: the contract never takes it back.`,
        "That cost includes the keeper tip the feed's creator set, which is paid out for every answered round. Read a feed's parameters before endowing it.",
        SEED_LINE,
        NEW_ID_LINE,
      ],
    };
  },
});

const endowCreatePot = simple({
  id: "endow-create-pot",
  title: "Endow a crowd pot",
  action: "Create the endowment",
  contract: "endowments",
  fields: [
    { name: "potId", label: "Pot or series number", kind: "number", required: true },
    {
      name: "beneficiary",
      label: "Fallback beneficiary",
      kind: "address",
      required: true,
      placeholder: "0x…",
      help: "Every chip is made in this address's name, so every refund or change the pot pays goes to it, and it receives the whole harvest whenever the pot takes nothing.",
    },
  ],
  plan(values, ctx) {
    const potId = whole(values.potId);
    const who = (values.beneficiary ?? "").trim();
    const problems: string[] = [];
    if (potId === null || potId === 0n) problems.push("Give the pot or series number.");
    if (!isAddress(who, { strict: false }) || /^0x0{40}$/i.test(who))
      problems.push("Give the fallback beneficiary's address.");
    if (problems.length > 0 || potId === null) return { ok: false, problems };
    return {
      ok: true,
      calls: [
        approve("endowments", ctx.addresses.endowments, ENDOWMENT.SEED),
        call(
          "endowments",
          ctx,
          endowmentsAbi,
          "createForPot",
          [potId, getAddress(who)],
          `Create an endowment whose yield chips into pot ${potId} in the name of ${getAddress(who)}`,
        ),
      ],
      summary: [
        `The endowment's target is fixed for good: pot or series ${potId}. Its yield is chipped in for what the pot still needs, in the beneficiary's name.`,
        "The beneficiary is a party to trust: it is paid directly whenever the pot takes no chips (it is full, launched, out of time or cannot be read). For a single pot that is the normal end. Depositors should read who it is before depositing.",
        zapPayeeLine(ctx, "the fallback beneficiary", "what the harvest pays it", "harvest"),
        SEED_LINE,
        NEW_ID_LINE,
      ],
    };
  },
});

const endowCreateRecipient = simple({
  id: "endow-create-recipient",
  title: "Endow a recipient",
  action: "Create the endowment",
  contract: "endowments",
  fields: [{ name: "recipient", label: "Recipient", kind: "address", required: true, placeholder: "0x…" }],
  plan(values, ctx) {
    const who = (values.recipient ?? "").trim();
    if (!isAddress(who, { strict: false }) || /^0x0{40}$/i.test(who))
      return { ok: false, problems: ["Give the recipient's address."] };
    return {
      ok: true,
      calls: [
        approve("endowments", ctx.addresses.endowments, ENDOWMENT.SEED),
        call(
          "endowments",
          ctx,
          endowmentsAbi,
          "createForRecipient",
          [getAddress(who)],
          `Create an endowment whose yield is sent to ${getAddress(who)}`,
        ),
      ],
      summary: [
        `The endowment's target is fixed for good: every harvest sends all the yield to ${getAddress(who)}.`,
        "The zero address, the contract itself, IMD, sIMD, Questions and CrowdPots are refused as recipients, because IMD sent there by plain transfer would be lost or shared with whoever staked a block earlier.",
        zapPayeeLine(ctx, "a recipient", "the yield", "harvest"),
        SEED_LINE,
        NEW_ID_LINE,
      ],
    };
  },
});

const endowDeposit = simple({
  id: "endow-deposit",
  title: "Deposit into an endowment",
  action: "Deposit",
  contract: "endowments",
  fields: [ENDOWMENT_ID, AMOUNT],
  plan(values, ctx) {
    const id = whole(values.id);
    const amount = imd(values.amount);
    const problems = amountProblems([["Amount", values.amount]]);
    if (id === null || amount === null || amount === 0n)
      return { ok: false, problems: [...problems, "Give the endowment number and an amount in IMD."] };
    if (problems.length > 0) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "endowments",
          ctx,
          endowmentsAbi,
          "endowment",
          [id.toString()],
          "The endowment's kind (1 meter, 2 pot, 3 recipient), target and beneficiary: read them before depositing",
        ),
      ],
      calls: [
        approve("endowments", ctx.addresses.endowments, amount),
        call(
          "endowments",
          ctx,
          endowmentsAbi,
          "deposit",
          [id, amount],
          `Deposit ${formatImd(amount)} IMD as principal of endowment ${id}`,
        ),
      ],
      summary: [
        `Your ${formatImd(amount)} IMD becomes principal you can take back at any time, to the wei. It waits in the contract until the next batch is staked into sIMD; only the yield is ever spent, and it earns you nothing.`,
        "Recoverable still carries the risk of a defect in our contract or in sIMD, and a loss inside sIMD would be shared by an endowment's depositors in proportion.",
      ],
    };
  },
});

const endowWithdraw = simple({
  id: "endow-withdraw",
  title: "Withdraw principal",
  action: "Withdraw",
  contract: "endowments",
  fields: [ENDOWMENT_ID, AMOUNT],
  plan(values, ctx) {
    const id = whole(values.id);
    const amount = imd(values.amount);
    const problems = amountProblems([["Amount", values.amount]]);
    if (id === null || amount === null || amount === 0n)
      return { ok: false, problems: [...problems, "Give the endowment number and an amount in IMD."] };
    if (problems.length > 0) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "endowments",
          ctx,
          endowmentsAbi,
          "vaultHold",
          [],
          "True in a block where sIMD pays nothing out to the contract: wait one block, or use exit",
        ),
      ],
      calls: [
        call(
          "endowments",
          ctx,
          endowmentsAbi,
          "withdraw",
          [id, amount],
          `Take ${formatImd(amount)} IMD of your principal back from endowment ${id}`,
        ),
      ],
      summary: [
        "You receive exactly the amount, or the call reverts. In a block in which the contract has just staked, sIMD pays nothing out, so a withdrawal that needs the vault waits one block.",
        "The long form, exit(id, amount, minOut, inKind), is never held: it can hand over sIMD shares of the same worth instead of IMD, and accepts less when an endowment is short.",
      ],
    };
  },
});

const endowHarvest = simple({
  id: "endow-harvest",
  title: "Harvest the yield",
  action: "Send the yield to its target",
  contract: "endowments",
  fields: [
    ENDOWMENT_ID,
    {
      name: "pot",
      label: "This endowment's target is a crowd pot",
      kind: "checkbox",
      initial: "false",
      help: "A pot endowment's harvest must be sent with a gas limit of 850,000: below about 800,000 it reverts, so that a caller cannot starve the pot and push the yield to the fallback beneficiary.",
    },
  ],
  plan(values, ctx) {
    const id = whole(values.id);
    if (id === null) return { ok: false, problems: ["Give the endowment number."] };
    const pot = values.pot === "true";
    return {
      ok: true,
      reads: [
        read(
          "endowments",
          ctx,
          endowmentsAbi,
          "harvestable",
          [id.toString()],
          "What a harvest would send now, in IMD-wei. For a meter: what the meter has room for",
        ),
      ],
      calls: [
        call(
          "endowments",
          ctx,
          endowmentsAbi,
          "harvest",
          [id],
          `Send endowment ${id}'s yield to the feed, pot or recipient it was created for`,
          { ...(pot ? { gas: ENDOWMENT.POT_HARVEST_GAS } : {}) },
        ),
      ],
      summary: [
        "Anyone may call this. It redeems only what the endowment holds beyond its principal, so principal is never touched, and the IMD goes to the endowment's fixed target, never to the caller.",
        `A meter endowment harvests only up to a runway: it never lifts the feed's meter above the cost of ${ENDOWMENT.METER_RUNWAY} requests. When the meter already holds that much, or the feed cannot be bought right now, nothing is harvestable and the yield stays staked.`,
        "It reverts when there is under 0.001 IMD to send, and in a block where sIMD is holding the contract.",
      ],
    };
  },
});

const endowStake = simple({
  id: "endow-stake",
  title: "Stake the waiting deposits",
  action: "Stake",
  contract: "endowments",
  fields: [],
  plan(_values, ctx) {
    return {
      ok: true,
      reads: [
        read("endowments", ctx, endowmentsAbi, "pendingTotal", [], "IMD waiting to be staked"),
        read(
          "endowments",
          ctx,
          endowmentsAbi,
          "nextStakeBlock",
          [],
          "The first block the next batch may be staked in",
        ),
      ],
      calls: [
        call(
          "endowments",
          ctx,
          endowmentsAbi,
          "stake",
          [],
          "Move every waiting deposit into sIMD in one batch",
        ),
      ],
      summary: [
        `Anyone may call this, at most once every ${ENDOWMENT.STAKE_INTERVAL_BLOCKS} blocks (about ten minutes). Deposits earn nothing for their endowment until they are staked.`,
        "Batching keeps the block in which sIMD pays nothing out to the contract to one in fifty at most.",
      ],
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Zap (launch C): pay with ETH
// ---------------------------------------------------------------------------------------------

/** How far ahead the form sets a Zap deadline unless the visitor changes it. */
const ZAP_DEADLINE_MINUTES = "10";

const ZAP_FIELDS: FlowField[] = [
  { name: "eth", label: "ETH to spend", kind: "eth", unit: "ETH", initial: "0.01", required: true },
  {
    name: "minImdOut",
    label: "The least IMD you accept for it",
    kind: "imd",
    unit: "IMD",
    required: true,
    help: "Run the quote command first and take about 99% of what it prints. The call reverts, and costs only gas, if the swap would produce less. Zap sets no limit of its own: a minimum of nearly nothing accepts any price.",
  },
  {
    name: "deadlineMinutes",
    label: "Must be mined within",
    kind: "number",
    unit: "minutes",
    initial: ZAP_DEADLINE_MINUTES,
    required: true,
    help: "The deadline is set this many minutes ahead of the moment you press the button, and shown below. A call mined after it reverts.",
  },
];

interface ZapTerms {
  wei: bigint;
  minOut: bigint;
  deadline: bigint;
  minutes: number;
  /** The deadline as a shell expression, so a command run later is not already late. */
  castDeadline: string;
}

function zapTerms(values: Record<string, string>, ctx: FlowContext, problems: string[]): ZapTerms | null {
  if (hasAmbiguousComma(values.eth ?? ""))
    problems.push("ETH to spend: write the amount with a point for the decimals and no commas.");
  const wei = parseUnits(values.eth ?? "", 18);
  if (wei === null || wei === 0n) problems.push("Say how much ETH to spend.");
  problems.push(...amountProblems([["The least IMD you accept", values.minImdOut]]));
  const minOut = imd(values.minImdOut);
  if (minOut === null || minOut === 0n)
    problems.push(
      "Give the least IMD you accept. It cannot be zero: a minimum of zero would accept any price.",
    );
  const minutes = Number((values.deadlineMinutes ?? ZAP_DEADLINE_MINUTES).trim());
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120)
    problems.push("Set the deadline between 1 and 120 minutes ahead.");
  if (problems.length > 0 || wei === null || minOut === null) return null;
  const secs = Math.round(minutes * 60);
  return {
    wei,
    minOut,
    deadline: BigInt(ctx.now + secs),
    minutes,
    castDeadline: `$(($(date +%s) + ${secs}))`,
  };
}

function zapDeadlineLine(terms: ZapTerms): string {
  return `The deadline is ${formatUtc(Number(terms.deadline) * 1000)} (timestamp ${terms.deadline}), ${terms.minutes} minute${terms.minutes === 1 ? "" : "s"} after this plan was made. A call mined later reverts and costs only gas. The command below works its deadline out when you run it; the wallet button sets it when you press it.`;
}

const ZAP_PRICE_LINE =
  "The swap runs on the one Uniswap v4 ETH/IMD pool, whose fee is 1% (Uniswap's own fee comes on top). Its depth is thin and changes, so the minimum is your price protection, and yours alone.";

const zapChipIn = simple({
  id: "zap-chip-in",
  title: "Chip in with ETH",
  action: "Swap and chip in",
  contract: "zap",
  fields: [{ name: "potId", label: "Pot number", kind: "number", required: true }, ...ZAP_FIELDS],
  plan(values, ctx) {
    const problems: string[] = [];
    const potId = whole(values.potId);
    if (potId === null) problems.push("Give the pot number.");
    const terms = zapTerms(values, ctx, problems);
    if (problems.length > 0 || potId === null || !terms) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "crowdPots",
          ctx,
          crowdPotsAbi,
          "remaining",
          [potId.toString()],
          "What the pot still needs, in IMD-wei: size your ETH to it",
        ),
        read(
          "zap",
          ctx,
          zapAbi,
          "buy",
          ["1", terms.castDeadline],
          "A quote: what this much ETH buys now, in IMD-wei (a simulated call; nothing is sent)",
          { value: terms.wei, fromSelf: true },
        ),
      ],
      calls: [
        call(
          "zap",
          ctx,
          zapAbi,
          "chipIn",
          [potId, terms.minOut, terms.deadline],
          `Swap ${formatUnits(terms.wei, 18)} ETH for at least ${formatImd(terms.minOut)} IMD and chip it into pot ${potId} in your name`,
          { castArgs: [potId.toString(), terms.minOut.toString(), terms.castDeadline], value: terms.wei },
        ),
      ],
      summary: [
        `Zap swaps ${formatUnits(terms.wei, 18)} ETH for IMD and chips it into pot ${potId} in your name: the chip, and any refund of it, are yours. You need no IMD and no approval.`,
        "All of the ETH is swapped before the pot is asked what it needs. What the pot does not take comes back to you as IMD in the same transaction. A pot that takes nothing at all reverts the call, so you keep your ETH.",
        `The call reverts unless the swap produces at least ${formatImd(terms.minOut)} IMD.`,
        zapDeadlineLine(terms),
        ZAP_PRICE_LINE,
      ],
    };
  },
});

const zapFundMeter = simple({
  id: "zap-fund-meter",
  title: "Fund a feed's meter with ETH",
  action: "Swap and fund the meter",
  contract: "zap",
  fields: [...FEED_FIELDS, ...ZAP_FIELDS],
  plan(values, ctx) {
    const problems: string[] = [];
    const feed = feedOf(values, problems);
    const terms = zapTerms(values, ctx, problems);
    if (problems.length > 0 || !feed || !terms) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "zap",
          ctx,
          zapAbi,
          "buy",
          ["1", terms.castDeadline],
          "A quote: what this much ETH buys now, in IMD-wei (a simulated call; nothing is sent)",
          { value: terms.wei, fromSelf: true },
        ),
      ],
      calls: [
        call(
          "zap",
          ctx,
          zapAbi,
          "fundMeter",
          [feed.id, terms.minOut, terms.deadline],
          `Swap ${formatUnits(terms.wei, 18)} ETH for at least ${formatImd(terms.minOut)} IMD and add it to the meter of ${feed.name}`,
          { castArgs: [feed.id, terms.minOut.toString(), terms.castDeadline], value: terms.wei },
        ),
      ],
      summary: [
        `Zap swaps ${formatUnits(terms.wei, 18)} ETH for IMD and adds all of it to the meter of ${feed.name}. The meter shares are yours, not Zap's: you can redeem them with defund for their part of what the meter has not spent.`,
        `The call reverts unless the swap produces at least ${formatImd(terms.minOut)} IMD, and for a feed that does not exist.`,
        zapDeadlineLine(terms),
        TIP_RULE,
        ZAP_PRICE_LINE,
      ],
    };
  },
});

const zapBuy = simple({
  id: "zap-buy",
  title: "Buy IMD with ETH",
  action: "Swap",
  contract: "zap",
  fields: ZAP_FIELDS,
  plan(values, ctx) {
    const problems: string[] = [];
    const terms = zapTerms(values, ctx, problems);
    if (problems.length > 0 || !terms) return { ok: false, problems };
    return {
      ok: true,
      reads: [
        read(
          "zap",
          ctx,
          zapAbi,
          "buy",
          ["1", terms.castDeadline],
          "A quote: what this much ETH buys now, in IMD-wei (a simulated call; nothing is sent)",
          { value: terms.wei, fromSelf: true },
        ),
      ],
      calls: [
        call(
          "zap",
          ctx,
          zapAbi,
          "buy",
          [terms.minOut, terms.deadline],
          `Swap ${formatUnits(terms.wei, 18)} ETH for at least ${formatImd(terms.minOut)} IMD, sent to you`,
          { castArgs: [terms.minOut.toString(), terms.castDeadline], value: terms.wei },
        ),
      ],
      summary: [
        `Zap swaps ${formatUnits(terms.wei, 18)} ETH for IMD and sends the IMD to you. It is how a wallet with only ETH gets the IMD to post an order in its own name: Zap does not open orders, because the desk makes whoever calls it the employer.`,
        `The call reverts unless the swap produces at least ${formatImd(terms.minOut)} IMD.`,
        zapDeadlineLine(terms),
        ZAP_PRICE_LINE,
      ],
    };
  },
});

export const FLOWS: readonly FlowDef[] = [
  hire,
  sayWhen,
  orderCancel,
  orderRefund,
  orderTrigger,
  orderEvict,
  orderTimeout,
  orderChallenge,
  runnerClaim,
  runnerRegister,
  runnerRelease,
  runnerClaimDelivered,
  runnerFinalize,
  openPot,
  chipIn,
  launchPot,
  claimRefund,
  ring,
  fundFeed,
  defundFeed,
  requestFeed,
  collectTips,
  abandonFeed,
  printReport,
  claimSeat,
  claimTip,
  drip,
  book,
  fundFeeds,
  createRule,
  fireRule,
  cancelRule,
  reconcileRule,
  endowCreateMeter,
  endowCreatePot,
  endowCreateRecipient,
  endowDeposit,
  endowWithdraw,
  endowHarvest,
  endowStake,
  zapChipIn,
  zapFundMeter,
  zapBuy,
];

export function flowById(id: string): FlowDef | null {
  return FLOWS.find((f) => f.id === id) ?? null;
}

/** The values a flow's form starts with: each field's initial value, then the preset on top. */
export function initialValues(flow: FlowDef, preset: Record<string, string> = {}): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of flow.fields(preset)) values[field.name] = field.initial ?? "";
  return { ...values, ...preset };
}

export const CONTRACT_NAMES = NAMES;
