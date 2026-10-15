/**
 * The wiring the machine tests share: a machine over the in-memory desk and API of `fakes.ts`, with
 * the paid routes answered from the hand-built fixtures. Nothing here touches the network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, type Hex } from "viem";
import { vi } from "vitest";
import { kindHash } from "@help-wanted/shared";
import { memoryLogger } from "../src/log.js";
import { Machine, type MachineConfig, type PayHooks } from "../src/machine.js";
import { GuardedSigner, PayFlow, type PaidRequest, type PaidResponse } from "../src/pay.js";
import { memoryStore, type Store } from "../src/store.js";
import { FakeApi, FakeDesk, objectiveFor, workRecord } from "./fakes.js";
import {
  API,
  DESK,
  JOB_ID,
  NOW,
  ORDER_ID,
  PRICE,
  REQUEST_ID,
  RUNNER,
  TERMS,
  TEST_ACCOUNT,
  TEST_PRIVATE_KEY,
} from "./world.js";

const here = dirname(fileURLToPath(import.meta.url));
export const raw = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");

export const QUOTE_URL = `${API}/requests/quote`;
export const SUBMIT_URL = `${API}/requests/${REQUEST_ID}/submit`;

/**
 * The limits most tests run under. Two of them differ from the runner's defaults so that a test of
 * one thing does not have to act out another: the job is registered the moment it is admitted
 * (`registerAtOnce`), and delivery is claimed on a record as soon as it is seen
 * (`claimSettleSeconds: 0`). The tests of those two behaviours set them back.
 */
export const baseConfig: MachineConfig = {
  mode: "live",
  chainId: 1,
  workOrders: DESK,
  runner: RUNNER,
  templates: new Map<Hex, string>([
    [kindHash("skill:research-report"), "skill:research-report"],
    [kindHash("audit"), "audit"],
  ]),
  dailyCap: 2n * 10n ** 18n,
  orderCap: PRICE,
  maxBond: 10n ** 18n,
  maxBondsAtRisk: 10n ** 19n,
  minMargin: 5n * 10n ** 16n,
  failureBps: 0n,
  maxConcurrent: 2,
  receiptOnlyOrders: "never",
  receiptStallBlocks: 1800,
  latchConditions: true,
  stampAfterFinalize: true,
  stampWatchSeconds: 30 * 86_400,
  disputeTimeoutAfter: 86_400,
  arbiters: new Set(),
  employers: new Set(),
  maxEmployerLosses: 1,
  minOrderLifetime: 7200,
  maxPayFailures: 2,
  maxJobsPerOrder: 1,
  registerAtOnce: true,
  claimSettleSeconds: 0,
  maxSettleRecordBytes: 100_000,
  maxSettleGas: 3_000_000n,
  lookOnly: false,
  dryRunPreflight: false,
  startBlock: 0n,
  confirmations: 2,
  logChunkBlocks: 2000n,
  minGasBalance: 3n * 10n ** 15n,
};

export function world(
  overrides: Partial<MachineConfig> = {},
  options: { store?: Store; desk?: FakeDesk; api?: FakeApi } = {},
) {
  const desk = options.desk ?? new FakeDesk();
  const api = options.api ?? new FakeApi();
  const store = options.store ?? memoryStore(DESK, RUNNER);
  const log = memoryLogger([TEST_PRIVATE_KEY]);
  const config = { ...baseConfig, ...overrides };
  const requests: PaidRequest[] = [];
  let killed = false;
  /** Priced orders by request key, as the protocol keeps them: the same key gets the same order back. */
  const priced = new Map<string, { quote: Record<string, unknown>; input: unknown; expiresAt: number }>();
  /** The order the challenge speaks of: the one quoted last. */
  let current: { quote: Record<string, unknown>; input: unknown } | null = null;
  /**
   * What the paid routes answer. Tests replace parts of it. By default the protocol prepares the
   * input exactly as it was sent (the quote and the challenge both carry it back unchanged), a
   * quote lasts 600 seconds from when it was asked for, and asking again with the same key returns
   * the same order, `expired` once its time is up.
   */
  const protocol = {
    quote: (request: PaidRequest): PaidResponse => {
      const sent = JSON.parse(request.body ?? "{}") as { requestKey: string; input: unknown };
      const body = JSON.parse(raw("quote-response.json")) as {
        created: boolean;
        order: { requestKey: string; inputJson: string; status: string; quote: Record<string, unknown> };
      };
      let order = priced.get(sent.requestKey);
      if (order === undefined) {
        order = {
          quote: { ...body.order.quote, issuedAt: desk.now, expiresAt: desk.now + 600 },
          input: sent.input,
          expiresAt: desk.now + 600,
        };
        priced.set(sent.requestKey, order);
      } else {
        body.created = false;
      }
      body.order.requestKey = sent.requestKey;
      body.order.inputJson = JSON.stringify(order.input);
      body.order.quote = order.quote;
      if (desk.now >= order.expiresAt) body.order.status = "expired";
      current = order;
      return { status: body.created ? 201 : 200, headers: {}, text: JSON.stringify(body) };
    },
    challenge: (): PaidResponse => {
      const body = JSON.parse(raw("challenge-402.json")) as { input: unknown; quote: unknown };
      if (current !== null) {
        body.input = current.input;
        body.quote = current.quote;
      }
      return { status: 402, headers: {}, text: JSON.stringify(body) };
    },
    submit: (): PaidResponse => ({ status: 202, headers: {}, text: raw("status-payment-pending.json") }),
    status: (): PaidResponse => ({ status: 200, headers: {}, text: raw("status-admitted.json") }),
    /** Whether an admitted answer also makes the job exist in the API, running, as it would. */
    opensJob: true,
  };
  const signer = new GuardedSigner(TEST_ACCOUNT);
  const payFlow =
    config.mode === "live"
      ? (hooks: PayHooks) =>
          new PayFlow({
            http: async (request) => {
              requests.push(request);
              if (request.url === QUOTE_URL) return protocol.quote(request);
              if (request.url === SUBMIT_URL) {
                return request.headers["payment-signature"] === undefined
                  ? protocol.challenge()
                  : protocol.submit();
              }
              const answer = protocol.status();
              if (protocol.opensJob && answer.text.includes('"admitted"') && !api.jobs.has(JOB_ID)) {
                api.jobs.set(JOB_ID, {
                  state: "executing",
                  template: "skill:research-report",
                  objective: objectiveFor(ORDER_ID, 1),
                  paidBy: RUNNER.toLowerCase(),
                });
              }
              return answer;
            },
            signer,
            token: "e".repeat(64),
            terms: TERMS,
            now: () => desk.now,
            log,
            persist: hooks.persist,
            reserve: hooks.reserve,
            release: hooks.release,
            mayPay: hooks.mayPay,
          })
      : null;
  const machine = new Machine({
    config,
    store,
    desk,
    api,
    payFlow,
    now: () => desk.now,
    log,
    killed: () => killed,
  });
  const setTime = (t: number) => {
    desk.now = t;
    vi.setSystemTime(t * 1000);
  };
  return {
    machine,
    desk,
    api,
    store,
    log,
    requests,
    protocol,
    config,
    kill: (on: boolean) => void (killed = on),
    setTime,
    /** Moves the clock on by a number of seconds. */
    wait: (seconds: number) => setTime(desk.now + seconds),
    record: (id: bigint = ORDER_ID) => store.data.orders[id.toString()],
    paying: () => requests.filter((r) => r.headers["payment-signature"] !== undefined),
    quotes: () => requests.filter((r) => r.url === QUOTE_URL),
    /** Log lines an operator sees at the default level: `info` and above, never `debug`. */
    visible: () => log.lines.filter((l) => !l.includes('"level":"debug"')),
    /** Lines at `warn` or `error`. */
    loud: () => log.lines.filter((l) => l.includes('"level":"warn"') || l.includes('"level":"error"')),
  };
}

export type World = ReturnType<typeof world>;

/** Makes the swarm job of the fixtures exist, finished, with a record that settles the order. */
export function finishJob(
  w: World,
  fields: { state?: string; kind?: string; objective?: string; paidBy?: string; agentIds?: string[] } = {},
) {
  const objective = fields.objective ?? objectiveFor(ORDER_ID, 1);
  w.api.jobs.set(JOB_ID, {
    state: fields.state ?? "completed",
    template: fields.kind ?? "skill:research-report",
    objective,
    paidBy: fields.paidBy ?? RUNNER.toLowerCase(),
    blockedReason: fields.state === "blocked" ? "verifier rejected the work" : null,
  });
  const bytes = workRecord({
    jobId: JOB_ID,
    objective,
    kind: fields.kind,
    state: fields.state,
    agentIds: fields.agentIds,
  });
  w.api.records.set(JOB_ID, bytes);
  return { bytes, hash: keccak256(bytes) };
}

export async function ticks(w: World, n: number) {
  for (let i = 0; i < n; i++) await w.machine.tick();
}

/** Runs the order of the fixtures up to the point where its job is registered. */
export async function upToRegistered(overrides: Partial<MachineConfig> = {}): Promise<World> {
  const w = world(overrides);
  w.desk.open(ORDER_ID);
  await ticks(w, 3);
  if (w.record()?.status !== "registered") {
    throw new Error(
      `expected a registered order, found ${String(w.record()?.status)}: ${w.record()?.lastError}`,
    );
  }
  return w;
}

export { NOW };
