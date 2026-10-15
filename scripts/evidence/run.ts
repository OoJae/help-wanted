/**
 * One run of the evidence builder: every read, then the counting, then the checks.
 *
 * Everything is read at one block, the pinned block: the node's finalized block when the run
 * begins, unless one is named by hand. Logs are read from each launch's own block up to it, views
 * and code are read at it. The function returns the whole document or throws: a read that fails,
 * a log that no ABI names, an event about something no earlier log opened, or a count that
 * disagrees with the contract's own counter stops the run, and the caller writes nothing.
 *
 * It takes its node, its API reader and its clock as arguments, so the tests run the same code on
 * a recording of a real run, with no network.
 */
import {
  CONTRACTS,
  LAUNCH_KEYS,
  LAUNCH_TITLES,
  type ContractSpec,
} from "./contracts.js";
import {
  EVIDENCE_SCHEMA,
  type Check,
  type ContractRow,
  type EvidenceDocument,
  type IdentityMdReads,
  type LaunchEvidence,
  type LaunchTransaction,
  type PinnedBlock,
} from "./document.js";
import {
  attribute,
  eventTable,
  foldLaunchA,
  foldLaunchB,
  foldLaunchC,
  isoTime,
  transactionsBySender,
  viewKey,
  type Attributed,
  type DecodedLog,
} from "./fold.js";
import { houseList, parseHouseFile, type HouseList } from "./house.js";
import type { ImdReads } from "./imd.js";
import {
  BadNodeAnswerError,
  hexAddress,
  hexBytes,
  hexWord,
  quantity,
  type ChainLog,
  type Rpc,
} from "./rpc.js";
import {
  checksumAddress,
  decodeLogUnder,
  erc20Abi,
  keccakOfHex,
  MAINNET,
  viewCallData,
  viewResult,
  type Abi,
  type Address,
  type ContractName,
  type DeploymentBook,
  type Hex,
  type LaunchKey,
} from "./shared.js";

export interface RunInputs {
  book: DeploymentBook;
  /** `evidence/house-wallets.json`, parsed. */
  houseFile: unknown;
  /** `evidence/launch-requests.json`, parsed, or null when there is none. */
  launchRequests: unknown;
}

export interface RunSettings {
  /** Widest block range asked of a node in one log query. */
  chunkSize: number;
  /** A block named by hand, or null for the node's finalized block. */
  block: number | null;
}

export interface RunDeps {
  rpc: Rpc;
  /** Null when the API is switched off for the run; the document then says it was not read. */
  imd: ImdReads | null;
  now: () => Date;
  /** Progress, one line at a time. */
  say: (line: string) => void;
}

/** A count from the logs disagrees with the contract's own counter. Nothing is written. */
export class ChecksFailedError extends Error {
  readonly failed: Check[];

  constructor(failed: Check[]) {
    super(
      `the logs do not agree with the contracts at the pinned block, so nothing is written:\n${failed
        .map(
          (c) =>
            `  ${c.what}: ${c.expected} from ${c.expectedFrom}, ${c.contractSays} from the contract`,
        )
        .join(
          "\n",
        )}\nThe node may have returned logs with holes. Run again, or use another node.`,
    );
    this.name = "ChecksFailedError";
    this.failed = failed;
  }
}

export const HOUSE_RULE =
  "HOUSE is the activity of the wallets the team publishes in evidence/house-wallets.json and of HELP WANTED's own contracts; everything else is OUTSIDE. Each event is counted for one account: the one that made the call, the one the event pays, or the one an earlier event settled (the opener of a round, the employer of an order). When the account made the call itself, the count is HOUSE if that account or the sender of the transaction is on the list. scripts/evidence/contracts.ts holds the rule of every event.";

const hexBlock = (block: number) => `0x${block.toString(16)}`;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

function launchRequestsOf(
  raw: unknown,
): { launch: LaunchKey; jobId: string }[] {
  if (raw === null || raw === undefined) return [];
  const list = (raw as Record<string, unknown>).requests;
  if (!Array.isArray(list))
    throw new Error("evidence/launch-requests.json has no list of requests");
  return list.map((entry) => {
    const e = entry as Record<string, unknown>;
    if (
      !LAUNCH_KEYS.includes(e.launch as LaunchKey) ||
      typeof e.jobId !== "string"
    ) {
      throw new Error(
        "evidence/launch-requests.json: each request needs a launch (a, b or c) and a jobId",
      );
    }
    return { launch: e.launch as LaunchKey, jobId: e.jobId };
  });
}

interface LaunchState {
  key: LaunchKey;
  specs: ContractSpec[];
  /** Lowercase addresses by contract key. Empty when not launched. */
  addresses: Partial<Record<ContractName, Address>>;
  launched: boolean;
}

function launchStates(book: DeploymentBook): LaunchState[] {
  return LAUNCH_KEYS.map((key) => {
    const record = book[key];
    const specs = CONTRACTS.filter((contract) => contract.launch === key);
    const entries = Object.entries(record.contracts) as [
      ContractName,
      Address | null,
    ][];
    const named = specs
      .map((s) => s.key)
      .sort()
      .join(",");
    if (
      entries
        .map(([name]) => name)
        .sort()
        .join(",") !== named
    ) {
      throw new Error(
        `launch ${key.toUpperCase()}: the deployments book and the evidence builder list different contracts`,
      );
    }
    const filled = entries.filter(([, address]) => address !== null);
    if (filled.length !== 0 && filled.length !== entries.length) {
      throw new Error(
        `launch ${key.toUpperCase()}: the deployments book holds an address for some of its contracts and not for others. A launch creates all of them in one transaction: fill in all or none.`,
      );
    }
    const launched = filled.length === entries.length;
    if (launched && (record.transaction === null || record.block === null)) {
      throw new Error(
        `launch ${key.toUpperCase()}: the deployments book holds addresses and no launch transaction or block`,
      );
    }
    const addresses: Partial<Record<ContractName, Address>> = {};
    for (const [name, address] of filled)
      addresses[name] = (address as string).toLowerCase() as Address;
    return { key, specs, addresses, launched };
  });
}

export async function buildEvidence(
  inputs: RunInputs,
  settings: RunSettings,
  deps: RunDeps,
): Promise<EvidenceDocument> {
  const { rpc, say } = deps;
  const { book } = inputs;
  const states = launchStates(book);
  const allAddresses: Partial<Record<ContractName, Address>> = Object.assign(
    {},
    ...states.map((s) => s.addresses),
  );
  const house: HouseList = houseList(
    parseHouseFile(inputs.houseFile),
    states.flatMap((state) =>
      state.specs.flatMap((spec) => {
        const address = state.addresses[spec.key];
        return address ? [{ name: spec.name, launch: state.key, address }] : [];
      }),
    ),
  );

  // ---- The chain and the pinned block ----
  const chainId = await rpc.read(
    "eth_chainId",
    [],
    (r) => quantity(r, "the chain id"),
    "the chain id",
  );
  if (chainId !== book.chainId) {
    throw new Error(
      `the node is on chain ${chainId} and the deployments book is for chain ${book.chainId}`,
    );
  }
  const header = (result: unknown, what: string) => {
    if (typeof result !== "object" || result === null)
      throw new BadNodeAnswerError(`${what} was not returned`);
    const block = result as Record<string, unknown>;
    return {
      number: quantity(block.number, `${what}'s number`),
      hash: hexWord(block.hash, `${what}'s hash`),
      timestamp: quantity(block.timestamp, `${what}'s timestamp`),
    };
  };
  const pinnedHeader =
    settings.block === null
      ? await rpc.read(
          "eth_getBlockByNumber",
          ["finalized", false],
          (r) => header(r, "the finalized block"),
          "the finalized block",
        )
      : await rpc.read(
          "eth_getBlockByNumber",
          [hexBlock(settings.block), false],
          (r) => {
            const block = header(r, `block ${settings.block}`);
            if (block.number !== settings.block)
              throw new BadNodeAnswerError(
                "the node returned another block than the one asked for",
              );
            return block;
          },
          `block ${settings.block}`,
        );
  const pinned: PinnedBlock = {
    ...pinnedHeader,
    time: isoTime(pinnedHeader.timestamp),
    finality: settings.block === null ? "finalized" : "chosen",
  };
  const at = hexBlock(pinned.number);
  say(
    `pinned block ${pinned.number} (${pinned.hash}, ${pinned.time}, ${pinned.finality})`,
  );

  for (const state of states) {
    const block = book[state.key].block;
    if (state.launched && block !== null && block > pinned.number) {
      throw new Error(
        `launch ${state.key.toUpperCase()} was mined in block ${block}, after the pinned block ${pinned.number}. Run again in about fifteen minutes, when that block is final, or name a newer block with EVIDENCE_BLOCK.`,
      );
    }
  }

  // ---- Reads at the pinned block ----
  const call = <T>(
    to: Address,
    abi: Abi,
    fn: string,
    args: readonly unknown[],
    what: string,
  ): Promise<T> =>
    rpc.read(
      "eth_call",
      [{ to, data: viewCallData(abi, fn, args) }, at],
      (r) => viewResult(abi, fn, hexBytes(r, what)) as T,
      what,
    );
  const blockTimes = new Map<number, number>();
  const timeOf = async (block: number): Promise<number> => {
    const known = blockTimes.get(block);
    if (known !== undefined) return known;
    const read = await rpc.read(
      "eth_getBlockByNumber",
      [hexBlock(block), false],
      (r) => {
        const b = header(r, `block ${block}`);
        if (b.number !== block)
          throw new BadNodeAnswerError(
            "the node returned another block than the one asked for",
          );
        return b.timestamp;
      },
      `block ${block}`,
    );
    blockTimes.set(block, read);
    return read;
  };
  const transaction = (hash: string) =>
    rpc.read(
      "eth_getTransactionByHash",
      [hash],
      (r) => {
        if (typeof r !== "object" || r === null)
          throw new BadNodeAnswerError("the transaction was not returned");
        const tx = r as Record<string, unknown>;
        if (hexWord(tx.hash, "the transaction's hash") !== hash.toLowerCase()) {
          throw new BadNodeAnswerError(
            "the node returned another transaction than the one asked for",
          );
        }
        return {
          from: hexAddress(tx.from, "the transaction's sender"),
          to:
            tx.to == null
              ? null
              : hexAddress(tx.to, "the transaction's recipient"),
          block: quantity(tx.blockNumber, "the transaction's block"),
        };
      },
      `transaction ${hash}`,
    );

  const views = new Map<string, unknown>();
  const chainLogs: (ChainLog & { contract: ContractName })[] = [];
  const contractRows = new Map<ContractName, Omit<ContractRow, "events">>();
  const launchTxs = new Map<LaunchKey, LaunchTransaction>();
  const logRanges = new Map<
    LaunchKey,
    { fromBlock: number; toBlock: number; count: number; transactions: number }
  >();
  let logChunks = 0;

  for (const state of states) {
    const record = book[state.key];
    if (!state.launched) {
      for (const spec of state.specs) {
        contractRows.set(spec.key, {
          key: spec.key,
          name: spec.name,
          source: spec.source,
          address: null,
          code: null,
          namedInLaunchTransaction: null,
          imdHeldWei: null,
        });
      }
      continue;
    }
    const launchHash = (record.transaction as string).toLowerCase();
    const launchBlock = record.block as number;
    say(
      `launch ${state.key.toUpperCase()}: reading the launch transaction, code, views and logs from block ${launchBlock}`,
    );

    // The launch transaction, and what the ProjectFactory logged in it.
    const tx = await transaction(launchHash);
    if (tx.block !== launchBlock) {
      throw new Error(
        `launch ${state.key.toUpperCase()}: the book says block ${launchBlock}, the node says the launch transaction is in block ${tx.block}`,
      );
    }
    const receipt = await rpc.read(
      "eth_getTransactionReceipt",
      [launchHash],
      (r) => {
        if (typeof r !== "object" || r === null)
          throw new BadNodeAnswerError("the receipt was not returned");
        const rec = r as Record<string, unknown>;
        if (!Array.isArray(rec.logs))
          throw new BadNodeAnswerError("the receipt has no list of logs");
        return {
          succeeded: quantity(rec.status, "the receipt's status") === 1,
          logs: rec.logs.map((entry) => {
            const log = entry as Record<string, unknown>;
            return {
              address: hexAddress(log.address, "a receipt log's address"),
              topics: Array.isArray(log.topics)
                ? log.topics.map((t) => hexWord(t, "a receipt log's topic"))
                : [],
              data: hexBytes(log.data, "a receipt log's data"),
            };
          }),
        };
      },
      `the receipt of ${launchHash}`,
    );
    // The factory names the contracts it created as 32-byte words in the data of one log, with the
    // launch number as that log's first indexed argument. No ABI is needed to see an address in it.
    const factory = MAINNET.PROJECT_FACTORY.toLowerCase();
    const wordsOf = (data: string) =>
      new Set(data.slice(2).match(/.{64}/g) ?? []);
    const wordOf = (address: string) =>
      address.slice(2).toLowerCase().padStart(64, "0");
    const expected = Object.values(state.addresses).map((address) =>
      wordOf(address as string),
    );
    const factoryLog =
      receipt.logs.find(
        (log) =>
          log.address === factory &&
          expected.every((w) => wordsOf(log.data).has(w)),
      ) ?? null;
    const factoryNumber = factoryLog?.topics[1]
      ? Number(BigInt(factoryLog.topics[1]))
      : null;
    launchTxs.set(state.key, {
      hash: launchHash,
      block: launchBlock,
      time: isoTime(await timeOf(launchBlock)),
      from: checksumAddress(tx.from),
      to: tx.to === null ? "" : checksumAddress(tx.to),
      succeeded: receipt.succeeded,
      factoryLaunchNumber:
        factoryNumber !== null && Number.isSafeInteger(factoryNumber)
          ? factoryNumber
          : null,
    });

    for (const spec of state.specs) {
      const address = state.addresses[spec.key] as Address;
      const code = await rpc.read(
        "eth_getCode",
        [address, at],
        (r) => hexBytes(r, "the code"),
        `the code of ${spec.name}`,
      );
      const bytes = (code.length - 2) / 2;
      if (bytes === 0) {
        throw new Error(
          `the deployments book says ${spec.name} is at ${checksumAddress(address)}, and there is no code at that address at block ${pinned.number}. Nothing is written.`,
        );
      }
      const held = await call<bigint>(
        MAINNET.IMD.toLowerCase() as Address,
        erc20Abi,
        "balanceOf",
        [address],
        `the IMD balance of ${spec.name}`,
      );
      contractRows.set(spec.key, {
        key: spec.key,
        name: spec.name,
        source: spec.source,
        address: checksumAddress(address),
        code: { nonEmpty: true, bytes, keccak256: keccakOfHex(code) },
        namedInLaunchTransaction:
          factoryLog !== null && wordsOf(factoryLog.data).has(wordOf(address)),
        imdHeldWei: held.toString(10),
      });
      for (const fn of spec.views) {
        views.set(
          viewKey(spec.key, fn),
          await call(address, spec.abi, fn, [], `${spec.name}.${fn}()`),
        );
      }
    }

    const byAddress = new Map<string, ContractName>(
      state.specs.map((spec) => [
        state.addresses[spec.key] as string,
        spec.key,
      ]),
    );
    const read = await rpc.logs(
      [...byAddress.keys()] as Address[],
      launchBlock,
      pinned.number,
      settings.chunkSize,
    );
    logChunks += read.chunks;
    for (const log of read.logs)
      chainLogs.push({
        ...log,
        contract: byAddress.get(log.address) as ContractName,
      });
    logRanges.set(state.key, {
      fromBlock: launchBlock,
      toBlock: pinned.number,
      count: read.logs.length,
      transactions: new Set(read.logs.map((log) => log.txHash)).size,
    });
    say(
      `launch ${state.key.toUpperCase()}: ${read.logs.length} logs in blocks ${launchBlock} to ${pinned.number}`,
    );
  }

  // ---- Name every log, and find who sent its transaction ----
  const hashes = [...new Set(chainLogs.map((log) => log.txHash))];
  const senders = new Map<string, Address>();
  await mapLimit(hashes, 4, async (hash) => {
    const tx = await transaction(hash);
    senders.set(hash, tx.from);
    const log = chainLogs.find((l) => l.txHash === hash);
    if (log && log.blockNumber !== tx.block) {
      throw new Error(
        `transaction ${hash} is in block ${tx.block} and its log says block ${log.blockNumber}`,
      );
    }
  });
  const decoded: DecodedLog[] = [];
  for (const log of chainLogs) {
    const spec = CONTRACTS.find((c) => c.key === log.contract) as ContractSpec;
    const named = decodeLogUnder(spec.abi, log.topics, log.data);
    if (named === null || Array.isArray(named.args)) {
      throw new Error(
        `a log of ${spec.name} in transaction ${log.txHash} (first topic ${log.topics[0] ?? "none"}) is not an event of its ABI in packages/shared. Regenerate the ABIs from the launched source; nothing is written.`,
      );
    }
    decoded.push({
      contract: log.contract,
      event: named.event,
      args: named.args as Record<string, unknown>,
      txHash: log.txHash,
      txFrom: senders.get(log.txHash) as Address,
      blockNumber: log.blockNumber,
      blockTime: log.blockTime ?? (await timeOf(log.blockNumber)),
      logIndex: log.logIndex,
    });
  }

  // ---- Views that depend on what the logs hold: one pair per feed ----
  const questions = allAddresses.questions;
  if (questions) {
    const spec = CONTRACTS.find((c) => c.key === "questions") as ContractSpec;
    const feedIds = [
      ...new Set(
        decoded
          .filter(
            (log) =>
              log.contract === "questions" && log.event === "FeedCreated",
          )
          .map((log) => String(log.args.feedId).toLowerCase()),
      ),
    ];
    for (const feedId of feedIds) {
      views.set(
        viewKey("questions", "feedState", [feedId]),
        await call(
          questions,
          spec.abi,
          "feedState",
          [feedId],
          "Questions.feedState",
        ),
      );
      views.set(
        viewKey("questions", "latest", [feedId]),
        await call(questions, spec.abi, "latest", [feedId], "Questions.latest"),
      );
    }
  }

  // ---- Count ----
  const intake = questions
    ? hexAddress(
        views.get(viewKey("questions", "INTAKE")),
        "Questions.INTAKE()",
      )
    : null;
  const attributed: Attributed[] = attribute(decoded, {
    house,
    intake,
    addresses: allAddresses,
  });
  const checks: Check[] = [];
  const state = (key: LaunchKey) =>
    states.find((s) => s.key === key) as LaunchState;
  const need = (name: ContractName) => allAddresses[name] as Address;

  const a = state("a").launched
    ? foldLaunchA(attributed, views, { questions: need("questions") })
    : null;
  const b = state("b").launched
    ? foldLaunchB(attributed, views, {
        workProof: need("workProof"),
        workOrders: need("workOrders"),
        crowdPots: need("crowdPots"),
        doorbell: need("doorbell"),
        payroll: allAddresses.payroll ?? null,
        rules: allAddresses.rules ?? null,
      })
    : null;
  const c = state("c").launched
    ? foldLaunchC(
        attributed,
        views,
        {
          questions: allAddresses.questions ?? null,
          workOrders: allAddresses.workOrders ?? null,
          crowdPots: allAddresses.crowdPots ?? null,
        },
        house,
      )
    : null;
  for (const part of [a, b, c]) if (part) checks.push(...part.checks);
  for (const s of states) {
    const tx = launchTxs.get(s.key);
    if (!tx) continue;
    const number = book[s.key].launchNumber;
    checks.push({
      what: `Launch ${s.key.toUpperCase()}: the ProjectFactory's log in the launch transaction names every address in the book`,
      expected: "true",
      expectedFrom: "the deployments book",
      contractSays: String(
        s.specs.every(
          (spec) =>
            contractRows.get(spec.key)?.namedInLaunchTransaction === true,
        ),
      ),
      agree: s.specs.every(
        (spec) => contractRows.get(spec.key)?.namedInLaunchTransaction === true,
      ),
    });
    if (number !== null) {
      checks.push({
        what: `Launch ${s.key.toUpperCase()}: the launch number in the ProjectFactory's log`,
        expected: String(number),
        expectedFrom: "the deployments book",
        contractSays: String(tx.factoryLaunchNumber),
        agree: tx.factoryLaunchNumber === number,
      });
    }
    checks.push({
      what: `Launch ${s.key.toUpperCase()}: the launch transaction succeeded`,
      expected: "true",
      expectedFrom: "the deployments book",
      contractSays: String(tx.succeeded),
      agree: tx.succeeded,
    });
  }
  const failed = checks.filter((entry) => !entry.agree);
  if (failed.length > 0) throw new ChecksFailedError(failed);

  // ---- IdentityMD's public API: not pinned, kept apart ----
  const identitymd = await readIdentityMd(
    deps,
    inputs,
    states,
    house,
    a?.evidence.questions.rounds ?? [],
  );

  // ---- Assemble ----
  const rowsOf = (key: LaunchKey): ContractRow[] =>
    state(key).specs.map((spec) => ({
      ...(contractRows.get(spec.key) as Omit<ContractRow, "events">),
      events: state(key).launched ? eventTable(attributed, spec.key) : null,
    }));
  const launch = <E>(key: LaunchKey, evidence: E | null): LaunchEvidence<E> => {
    const record = book[key];
    const s = state(key);
    return {
      key,
      title: LAUNCH_TITLES[key],
      project: record.project,
      threats: `${record.project}/docs/THREATS.md`,
      launched: s.launched,
      status: s.launched
        ? `live${record.launchNumber !== null ? `: IdentityMD launch ${record.launchNumber}` : ""}, block ${record.block}`
        : "not launched: the deployments book holds no address for it",
      launchNumber: record.launchNumber,
      transaction: launchTxs.get(key) ?? null,
      contracts: rowsOf(key),
      logs: logRanges.get(key) ?? null,
      evidence,
    };
  };
  const rows = [...contractRows.values()];
  return {
    schema: EVIDENCE_SCHEMA,
    about:
      "What exists on chain of HELP WANTED, read at one pinned block. Written by scripts/evidence/build.ts (pnpm evidence) and by nothing else; do not edit by hand.",
    chainId,
    pinnedBlock: pinned,
    houseRule: HOUSE_RULE,
    house: house.entries.map((entry) => ({
      label: entry.label,
      address: entry.address,
      kind: entry.kind,
      note: entry.note,
    })),
    headline: {
      contractsInTheBook: rows.length,
      contractsLaunched: rows.filter((row) => row.address !== null).length,
      contractsWithCode: rows.filter((row) => row.code?.nonEmpty === true)
        .length,
      transactions: transactionsBySender(
        attributed,
        house,
        [...launchTxs.values()].map((tx) => tx.hash),
        [MAINNET.INTAKE_WRITER, MAINNET.WORK_REGISTRY_WRITER],
      ),
    },
    launches: {
      a: launch("a", a?.evidence ?? null),
      b: launch("b", b?.evidence ?? null),
      c: launch("c", c?.evidence ?? null),
    },
    checks,
    identitymd,
    reads: { rpcHosts: rpc.hosts, chunkSize: settings.chunkSize, logChunks },
  };
}

async function readIdentityMd(
  deps: RunDeps,
  inputs: RunInputs,
  states: readonly LaunchState[],
  house: HouseList,
  rounds: readonly {
    feedId: string;
    houseFeed: string | null;
    round: number;
    ending: string;
    request: { tx: string; intakeRequestId: string };
  }[],
): Promise<IdentityMdReads> {
  const { imd, say } = deps;
  if (imd === null) {
    return {
      read: false,
      reason:
        "IdentityMD's API was switched off for this run (EVIDENCE_API=off)",
      base: "",
      fetchedAt: null,
      launches: [],
      pendingRounds: [],
      launchRequests: [],
    };
  }
  const fetchedAt = deps.now().toISOString();
  say(
    `reading IdentityMD's public API at ${imd.base} (GET only, one request at a time)`,
  );

  const launches: IdentityMdReads["launches"] = [];
  for (const state of states) {
    const number = inputs.book[state.key].launchNumber;
    if (!state.launched || number === null) continue;
    const record = await imd.launchByNumber(number);
    if (record === null)
      throw new Error(
        `IdentityMD's API lists no launch ${number}, the number the deployments book gives launch ${state.key.toUpperCase()}`,
      );
    const listed = record.artifacts
      .map((artifact) => artifact.address.toLowerCase())
      .sort();
    const ours = Object.values(state.addresses)
      .map((address) => (address as string).toLowerCase())
      .sort();
    launches.push({
      launch: state.key,
      launchNumber: number,
      id: record.id,
      status: record.status,
      kind: record.kind,
      sourceRepoUrl: record.sourceRepoUrl,
      sourceCommit: record.sourceCommit,
      artifacts: record.artifacts.map((artifact) => ({
        name: artifact.name,
        address: checksumAddress(artifact.address),
        verifiedAt: artifact.verifiedAt,
      })),
      addressesMatchTheBook: listed.join(",") === ours.join(","),
    });
  }

  const pendingRounds: IdentityMdReads["pendingRounds"] = [];
  for (const round of rounds.filter((r) => r.ending === "pending")) {
    const entry = await imd.intakeEntry(
      round.request.tx,
      round.request.intakeRequestId,
    );
    const oracle = entry?.oracleRequestId
      ? await imd.oracleRequest(entry.oracleRequestId)
      : null;
    pendingRounds.push({
      feedId: round.feedId,
      houseFeed: round.houseFeed,
      round: round.round,
      requestTx: round.request.tx,
      intakeState: entry?.state ?? null,
      oracleRequestId: entry?.oracleRequestId ?? null,
      oracleStatus: oracle?.status ?? null,
      attestedAt: oracle?.attestedAt ?? null,
    });
  }

  const launchRequests: IdentityMdReads["launchRequests"] = [];
  for (const request of launchRequestsOf(inputs.launchRequests)) {
    // Once a launch is in the book its own record above says more than the job that asked for it.
    if (states.find((s) => s.key === request.launch)?.launched) continue;
    const job = await imd.job(request.jobId);
    launchRequests.push({
      launch: request.launch,
      jobId: job.id,
      state: job.state,
      paidBy: job.paidBy === null ? null : checksumAddress(job.paidBy),
      paidBySide: job.paidBy === null ? null : house.sideOf(job.paidBy),
      createdAt: job.createdAt,
      launchStatus: job.launchStatus,
    });
  }

  const mismatch = launches.find((entry) => !entry.addressesMatchTheBook);
  if (mismatch) {
    throw new Error(
      `IdentityMD's record of launch ${mismatch.launchNumber} lists other addresses than the deployments book holds for launch ${mismatch.launch.toUpperCase()}. One of the two is wrong; nothing is written.`,
    );
  }
  return {
    read: true,
    reason: null,
    base: imd.base,
    fetchedAt,
    launches,
    pendingRounds,
    launchRequests,
  };
}
