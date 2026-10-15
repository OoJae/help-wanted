/**
 * The few things the evidence takes from IdentityMD's public API, with GET and nothing else.
 *
 * The shared package's client does the work: one request at a time, a fixed gap between them, and
 * a schema for every answer. Here it is given a `fetch` that refuses any method but GET, so that
 * nothing in this folder can make a paid or state-changing request even by mistake, and a gap of
 * thirteen seconds, under five requests a minute: the API's public allowance is shared by
 * everything that reads it.
 *
 * These reads are not pinned to a block. They say what IdentityMD's service said when it was
 * asked, and the document keeps them apart from what was read from the chain.
 */
import { ImdClient, isUnknownTransaction, IMD_API_BASE } from "./shared.js";

export type HttpGet = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImdLaunch {
  id: string;
  launchNumber: number;
  status: string;
  kind: string | null;
  sourceRepoUrl: string | null;
  sourceCommit: string | null;
  /**
   * Each contract as the launch's own record (`GET /launches/:id`) lists it. `verifiedAt` and
   * `verifyFailure` are that record's fields, null when it holds none; the list of launches
   * (`GET /launches`) leaves both out.
   */
  artifacts: {
    name: string;
    address: string;
    verifiedAt: string | null;
    verifyFailure: string | null;
  }[];
}

export interface ImdIntakeEntry {
  state: string;
  oracleRequestId: string | null;
}

export interface ImdJob {
  id: string;
  state: string;
  paidBy: string | null;
  createdAt: string;
  launchStatus: string | null;
}

export interface ImdReads {
  base: string;
  /**
   * IdentityMD's public record of the launch with this number, or null when it lists none. Two
   * reads: the list finds the launch's id, and the launch's own record gives its contracts.
   */
  launchByNumber(launchNumber: number): Promise<ImdLaunch | null>;
  /** The Intake request of a transaction with this id, or null while IdentityMD does not know the transaction. */
  intakeEntry(
    transaction: string,
    intakeRequestId: string,
  ): Promise<ImdIntakeEntry | null>;
  oracleRequest(
    id: string,
  ): Promise<{ status: string; attestedAt: string | null }>;
  job(id: string): Promise<ImdJob>;
}

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export function imdReads(
  options: {
    get?: HttpGet;
    gapMs?: number;
    base?: string;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): ImdReads {
  const get: HttpGet = options.get ?? ((url, init) => fetch(url, init));
  const client = new ImdClient({
    baseUrl: options.base ?? IMD_API_BASE,
    minIntervalMs: options.gapMs ?? 13_000,
    maxAttempts: 3,
    userAgent: "help-wanted-evidence/1",
    ...(options.sleep ? { sleep: options.sleep } : {}),
    fetch: (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET")
        throw new Error(
          `the evidence builder only reads: ${method} is refused`,
        );
      return get(String(input), init);
    },
  });
  return {
    base: client.baseUrl,

    async launchByNumber(launchNumber) {
      // `before` is a launch number and exclusive, so the newest launch below N + 1 is N itself.
      const page = await client.launches({
        before: launchNumber + 1,
        limit: 1,
      });
      const found = page.launches.find(
        (launch) => launch.launchNumber === launchNumber,
      );
      if (!found) return null;
      // The list row has no verification fields; the launch's own record does.
      const record = await client.launch(found.id);
      if (record.id !== found.id || record.launchNumber !== launchNumber) {
        throw new Error(
          `IdentityMD's record ${found.id} is not launch ${launchNumber}: it says ${record.id}, number ${String(record.launchNumber)}`,
        );
      }
      return {
        id: record.id,
        launchNumber,
        status: record.status,
        kind: record.kind ?? null,
        sourceRepoUrl: record.sourceRepoUrl ?? null,
        sourceCommit: record.sourceCommit ?? null,
        artifacts: (record.artifacts ?? []).map((artifact) => {
          const fields = artifact as Record<string, unknown>;
          return {
            name: artifact.name,
            address: artifact.address,
            verifiedAt: text(fields.verifiedAt),
            verifyFailure: text(fields.verifyFailure),
          };
        }),
      };
    },

    async intakeEntry(transaction, intakeRequestId) {
      try {
        const read = await client.intakeRead(1, transaction);
        const entry = read.entries.find(
          (e) => e.requestId?.toLowerCase() === intakeRequestId.toLowerCase(),
        );
        if (!entry) return null;
        return {
          state: entry.state,
          oracleRequestId: entry.admission?.result?.requestId ?? null,
        };
      } catch (error) {
        if (isUnknownTransaction(error)) return null;
        throw error;
      }
    },

    async oracleRequest(id) {
      const request = await client.oracleRequest(id);
      return { status: request.status, attestedAt: request.attestedAt ?? null };
    },

    async job(id) {
      const job = await client.job(id);
      const launch = (job as Record<string, unknown>).launch;
      const launchStatus =
        typeof launch === "object" && launch !== null
          ? text((launch as Record<string, unknown>).status)
          : null;
      return {
        id: job.id,
        state: job.state,
        paidBy: job.paidBy ?? null,
        createdAt: job.createdAt,
        launchStatus,
      };
    },
  };
}
