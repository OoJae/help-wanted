/**
 * The world the integration test runs in: a local node it starts itself, the real launch A
 * contracts deployed from their build output, small stand-ins for everything they depend on, and a
 * local HTTP server that plays IdentityMD's service.
 *
 * Nothing here touches the internet. The node is `anvil` with no fork; the keys are the ones
 * every local node prints (the public test mnemonic); the HTTP server listens on 127.0.0.1 only.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  getAbiItem,
  getAddress,
  http,
  keccak256,
  parseUnits,
  stringToHex,
  toHex,
  type Abi,
  type AbiParameter,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import {
  ANSWER_TYPE_CODE,
  HOUSE_FEEDS,
  MAINNET,
  ORACLE_ATTESTATION_TYPES,
  intakeAbi,
  jobsReportAbi,
  oracleDomain,
  payrollAbi,
  questionHashOfBody,
  questionsAbi,
  uuidToBytes32,
  type AnswerType,
  type OracleAttestationMessage,
} from "@help-wanted/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
export const KEEPER_DIR = join(HERE, "..", "..");
export const REPO = join(KEEPER_DIR, "..", "..");
const CONTRACTS = join(KEEPER_DIR, "contracts");

/** The mnemonic every local development node starts with. Public; it guards nothing. */
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

export interface TestAccount {
  account: HDAccount;
  address: Address;
  privateKey: Hex;
}

export function testAccount(index: number): TestAccount {
  const account = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: index });
  const key = account.getHdKey().privateKey;
  if (!key) throw new Error("the test mnemonic gave no key");
  return { account, address: account.address, privateKey: toHex(key) };
}

/** Who is who on the local node. */
export const WHO = {
  deployer: testAccount(0),
  keeper: testAccount(1),
  writer: testAccount(2),
  oracle: testAccount(3),
  feePayee: testAccount(4),
  staker: testAccount(5),
  other: testAccount(6),
};

/** Why the integration test cannot run here, or null when it can. */
export function cannotRun(): string | null {
  for (const tool of ["anvil", "forge"]) {
    try {
      execFileSync(tool, ["--version"], { stdio: "ignore" });
    } catch {
      return `${tool} is not installed: the integration test needs Foundry (anvil and forge) on the PATH`;
    }
  }
  for (const name of ["Questions", "JobsReport", "Payroll"]) {
    const path = join(REPO, "launches", "a-payroll", "out", `${name}.sol`, `${name}.json`);
    if (!existsSync(path)) {
      return `launches/a-payroll/out/${name}.sol/${name}.json is absent: run \`forge build\` in launches/a-payroll`;
    }
  }
  return null;
}

/** Compiles the stand-in contracts. `--offline`: the compiler must already be installed. */
export function buildStandIns(): void {
  execFileSync("forge", ["build", "--root", CONTRACTS, "--offline"], { stdio: "pipe" });
}

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export function artifact(path: string): Artifact {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

export const standIn = (file: string, name: string) =>
  artifact(join(CONTRACTS, "out", `${file}.sol`, `${name}.json`));
const launchA = (name: string) =>
  artifact(join(REPO, "launches", "a-payroll", "out", `${name}.sol`, `${name}.json`));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface Node {
  url: string;
  public: PublicClient;
  rpc(method: string, params?: unknown[]): Promise<unknown>;
  /** Places runtime code at an address: how a stand-in comes to sit at a mainnet address. */
  setCode(address: Address, code: Hex): Promise<void>;
  /** Gives an address ETH for gas. */
  setBalance(address: Address, wei: bigint): Promise<void>;
  /** Mines `count` blocks, twelve seconds apart. */
  mine(count: number): Promise<void>;
  /** Mines one block with exactly this timestamp. */
  mineAt(timestamp: bigint): Promise<void>;
  latest(): Promise<{ number: bigint; timestamp: bigint; hash: Hex }>;
  wallet(who: TestAccount): WalletClient;
  stop(): void;
}

/** Starts a local node: chain id 1, no fork, twelve seconds between blocks. */
export async function startNode(): Promise<Node> {
  const port = await freePort();
  const child: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", "1", "--silent"], {
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const transport = http(url);
  const client = createPublicClient({ chain: mainnet, transport, pollingInterval: 50 });
  const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await rpc("eth_chainId");
      break;
    } catch (error) {
      if (attempt > 100) {
        child.kill();
        throw new Error(`the local node did not start: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  // Every block is twelve seconds after the one before, whatever the wall clock says.
  await rpc("anvil_setBlockTimestampInterval", [12]);
  return {
    url,
    public: client as PublicClient,
    rpc,
    setCode: async (address, code) => {
      await rpc("anvil_setCode", [address, code]);
    },
    setBalance: async (address, wei) => {
      await rpc("anvil_setBalance", [address, toHex(wei)]);
    },
    mine: async (count) => {
      await rpc("anvil_mine", [toHex(count)]);
    },
    mineAt: async (timestamp) => {
      await rpc("evm_setNextBlockTimestamp", [toHex(timestamp)]);
      await rpc("anvil_mine", ["0x1"]);
    },
    latest: async () => {
      const block = await client.getBlock();
      return { number: block.number, timestamp: block.timestamp, hash: block.hash };
    },
    wallet: (who) =>
      createWalletClient({ account: who.account, chain: mainnet, transport, pollingInterval: 50 }),
    stop: () => {
      child.kill();
    },
  };
}

export interface World {
  imd: Address;
  simd: Address;
  seats: Address;
  adapter: Address;
  intake: Address;
  questions: Address;
  jobsReport: Address;
  payroll: Address;
  abis: { imd: Abi; simd: Abi; intake: Abi };
}

export async function deploy(node: Node, a: Artifact, args: readonly unknown[] = []): Promise<Address> {
  const hash = await node.wallet(WHO.deployer).deployContract({
    abi: a.abi,
    bytecode: a.bytecode,
    args,
    account: WHO.deployer.account,
    chain: mainnet,
  });
  const receipt = await node.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("a deployment failed");
  return receipt.contractAddress;
}

/** Sends a call from one of the test accounts and waits for it. */
export async function send(
  node: Node,
  who: TestAccount,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<Hex> {
  const hash = await node.wallet(who).writeContract({
    address,
    abi,
    functionName,
    args,
    account: who.account,
    chain: mainnet,
  });
  const receipt = await node.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}

export const IMD = (amount: string): bigint => parseUnits(amount, 18);

/**
 * Deploys the stand-ins and then launch A's three contracts, in manifest order, from the bytecode
 * the launch project's own build wrote. The feed ids are the launch's: the node has chain id 1 and
 * the feeds are created from the same fixtures.
 */
export async function deployWorld(node: Node, options: { imdAt?: Address } = {}): Promise<World> {
  const imdArtifact = standIn("StandInIMD", "StandInIMD");
  const simdArtifact = standIn("StandInSIMD", "StandInSIMD");
  const intakeArtifact = standIn("StandInIntake", "StandInIntake");
  let imd = await deploy(node, imdArtifact);
  if (options.imdAt !== undefined) {
    // The stand-in token keeps nothing its constructor set, so its code can be placed at another
    // address: the runner reads IMD at its mainnet address and nowhere else.
    const code = await node.public.getCode({ address: imd });
    if (!code) throw new Error("the stand-in token has no code");
    await node.setCode(options.imdAt, code);
    imd = options.imdAt;
  }
  const simd = await deploy(node, simdArtifact, [imd]);
  const seats = await deploy(node, standIn("StandInSeats", "StandInSeats"));
  const adapter = await deploy(node, standIn("StandInSeats", "StandInAdapter"));
  const intake = await deploy(node, intakeArtifact, [WHO.feePayee.address, WHO.writer.address]);
  await send(node, WHO.deployer, intake, intakeArtifact.abi, "setPrice", [
    MAINNET.ORACLE_ACTION,
    imd,
    IMD("0.5"),
  ]);

  const ids = [HOUSE_FEEDS.payrolls.id, HOUSE_FEEDS.hires.id, HOUSE_FEEDS.employers.id];
  const questions = await deploy(node, launchA("Questions"), [intake, imd, WHO.oracle.address]);
  const jobsReport = await deploy(node, launchA("JobsReport"), [questions, ...ids]);
  const payroll = await deploy(node, launchA("Payroll"), [
    imd,
    simd,
    seats,
    2000n,
    adapter,
    questions,
    ...ids,
  ]);

  // The keeper's wallet funds the meters on the first day; a staker makes sIMD a vault with shares.
  await send(node, WHO.deployer, imd, imdArtifact.abi, "mint", [WHO.keeper.address, IMD("100")]);
  await send(node, WHO.deployer, imd, imdArtifact.abi, "mint", [WHO.staker.address, IMD("50")]);
  await send(node, WHO.staker, imd, imdArtifact.abi, "approve", [simd, IMD("10")]);
  await send(node, WHO.staker, simd, simdArtifact.abi, "deposit", [IMD("10"), WHO.staker.address]);
  return {
    imd: getAddress(imd),
    simd: getAddress(simd),
    seats: getAddress(seats),
    adapter: getAddress(adapter),
    intake: getAddress(intake),
    questions: getAddress(questions),
    jobsReport: getAddress(jobsReport),
    payroll: getAddress(payroll),
    abis: { imd: imdArtifact.abi, simd: simdArtifact.abi, intake: intakeArtifact.abi },
  };
}

export const ABI = {
  questions: questionsAbi as unknown as Abi,
  jobsReport: jobsReportAbi as unknown as Abi,
  payroll: payrollAbi as unknown as Abi,
  intake: intakeAbi as unknown as Abi,
};

// ---------------------------------------------------------------------------------------------
// IdentityMD's service, played locally
// ---------------------------------------------------------------------------------------------

interface ServiceEntry {
  tx: Hex;
  logIndex: number;
  blockNumber: number;
  intakeRequestId: Hex;
  payer: Address;
  target: Address;
  selector: Hex;
  body: string;
  bodyHash: Hex;
  amount: bigint;
  asset: Address;
  oracleRequestId: string;
  state: string;
  reason: string | null;
  oracle: { status: string; failure: string | null };
  attestation: { message: OracleAttestationMessage; signature: Hex; api: Record<string, unknown> } | null;
  completion: {
    state: string;
    status: number;
    resultHash: Hex;
    uri: string;
    txHash: Hex | null;
    delivered: boolean | null;
    attempts: number;
    detail: string | null;
  } | null;
}

const REQUESTED = getAbiItem({ abi: intakeAbi, name: "Requested" });
const ATTESTATION_TUPLE: readonly AbiParameter[] = getAbiItem({
  abi: questionsAbi,
  name: "onOracleResult",
}).inputs;

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  const tail = uuidCounter.toString(16).padStart(12, "0");
  return `0a1b2c3d-0000-4000-8000-${tail}`;
}

/**
 * A stand-in for IdentityMD's plane: it "sees" Intake requests, answers them with attestations
 * signed by the test oracle key for the contract that asked, completes them on chain as the
 * writer when the test says so, and serves the three routes the keeper reads.
 */
export class StandInService {
  readonly #node: Node;
  readonly #world: World;
  readonly #entries = new Map<string, ServiceEntry>();
  /** The node and the world, for a subclass that plays more of the service. */
  protected get node(): Node {
    return this.#node;
  }
  protected get world(): World {
    return this.#world;
  }
  #server: Server | null = null;
  /** When true every route answers 503: the service cannot be read. */
  down = false;
  /** How many requests each route has answered. */
  readonly hits = { intake: 0, attestation: 0, oracle: 0 };
  url = "";

  constructor(node: Node, world: World) {
    this.#node = node;
    this.#world = world;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.route(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    this.url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    this.#server = server;
  }

  /**
   * Answers one request. A subclass adds routes by handling them first and calling this for the
   * rest.
   */
  protected async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (this.down) return reply(503, { error: "unavailable" });
      const path = (request.url ?? "").split("?")[0] ?? "";
      const intake = /^\/intake\/1\/(0x[0-9a-f]{64})$/.exec(path);
      if (intake) {
        this.hits.intake += 1;
        const entries = [...this.#entries.values()].filter((e) => e.tx === intake[1]);
        if (entries.length === 0) return reply(404, { error: "unknown_transaction" });
        return reply(200, {
          chainId: 1,
          transactionHash: intake[1],
          entries: entries.map((e) => this.#intakeEntry(e)),
        });
      }
      const attestation = /^\/oracle\/requests\/([0-9a-f-]{36})\/attestation$/.exec(path);
      if (attestation) {
        this.hits.attestation += 1;
        const entry = this.#byOracleId(attestation[1] as string);
        if (!entry) return reply(404, { error: "unknown_request" });
        if (!entry.attestation) return reply(404, { error: "not_attested" });
        return reply(200, this.#attestationDocument(entry));
      }
      const oracle = /^\/oracle\/requests\/([0-9a-f-]{36})$/.exec(path);
      if (oracle) {
        this.hits.oracle += 1;
        const entry = this.#byOracleId(oracle[1] as string);
        if (!entry) return reply(404, { error: "unknown_request" });
        return reply(200, this.#oracleRecord(entry));
      }
      return reply(404, { error: "not_found" });
    }
  }

  stop(): void {
    this.#server?.close();
  }

  #byOracleId(id: string): ServiceEntry | undefined {
    return [...this.#entries.values()].find((e) => e.oracleRequestId === id);
  }

  entry(intakeRequestId: Hex): ServiceEntry {
    const entry = this.#entries.get(intakeRequestId.toLowerCase());
    if (!entry) throw new Error(`the service has not seen ${intakeRequestId}`);
    return entry;
  }

  /** The plane notices the Intake requests of a transaction: each becomes an admitted request. */
  async see(tx: Hex): Promise<Hex[]> {
    const receipt = await this.#node.public.getTransactionReceipt({ hash: tx });
    const seen: Hex[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.#world.intake.toLowerCase()) continue;
      let decoded;
      try {
        decoded = decodeEventLog({ abi: [REQUESTED], data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      const args = decoded.args as unknown as {
        requestId: Hex;
        payer: Address;
        body: Hex;
        callbackTarget: Address;
        callbackSelector: Hex;
        asset: Address;
        amount: bigint;
      };
      const body = Buffer.from(args.body.slice(2), "hex").toString("utf8");
      this.#entries.set(args.requestId.toLowerCase(), {
        tx,
        logIndex: Number(log.logIndex),
        blockNumber: Number(receipt.blockNumber),
        intakeRequestId: args.requestId,
        payer: args.payer,
        target: args.callbackTarget,
        selector: args.callbackSelector,
        body,
        bodyHash: keccak256(args.body),
        amount: args.amount,
        asset: args.asset,
        oracleRequestId: nextUuid(),
        state: "admitted",
        reason: null,
        oracle: { status: "assessing", failure: null },
        attestation: null,
        completion: null,
      });
      seen.push(args.requestId);
    }
    return seen;
  }

  /**
   * The oracle answers: an attestation signed by the test oracle key in the domain of the contract
   * that asked (the callback target), for the body's own question and window, with the closing
   * block's hash read from the chain. The request then shows as `completing`.
   */
  async attest(
    intakeRequestId: Hex,
    answer: { type: AnswerType; value: bigint | Address[] },
    options: { issuedAt?: bigint; validFor?: bigint; agreed?: number; signedFor?: Address } = {},
  ): Promise<void> {
    const entry = this.entry(intakeRequestId);
    const body = JSON.parse(entry.body) as {
      window: { fromBlock: number; toBlock: number };
      chainId: number;
      panelSize: number;
      quorum: number;
      validForSeconds: number;
    };
    const closing = await this.#node.public.getBlock({ blockNumber: BigInt(body.window.toBlock) });
    const issuedAt = options.issuedAt ?? (await this.#node.latest()).timestamp;
    const encoded =
      answer.type === "address[]"
        ? encodeAbiParameters([{ type: "address[]" }], [answer.value as Address[]])
        : encodeAbiParameters([{ type: "uint256" }], [answer.value as bigint]);
    const jobId = nextUuid();
    const message: OracleAttestationMessage = {
      requestId: uuidToBytes32(entry.oracleRequestId),
      chainId: BigInt(body.chainId),
      questionHash: questionHashOfBody(entry.body),
      answerType: ANSWER_TYPE_CODE[answer.type],
      answer: encoded,
      figure: answer.type === "address[]" ? 0n : (answer.value as bigint),
      fromBlock: BigInt(body.window.fromBlock),
      toBlock: BigInt(body.window.toBlock),
      blockHash: closing.hash,
      panelJobId: uuidToBytes32(jobId),
      panelSize: body.panelSize,
      quorum: body.quorum,
      agreed: options.agreed ?? body.quorum,
      issuedAt,
      expiresAt: issuedAt + (options.validFor ?? BigInt(body.validForSeconds)),
    };
    const verifyingContract = options.signedFor ?? entry.target;
    const signature = await WHO.oracle.account.signTypedData({
      domain: oracleDomain(1, verifyingContract),
      types: ORACLE_ATTESTATION_TYPES,
      primaryType: "OracleAttestation",
      message,
    });
    entry.attestation = {
      message,
      signature,
      api: {
        requestId: message.requestId,
        chainId: Number(message.chainId),
        questionHash: message.questionHash,
        answerType: answer.type,
        answer: message.answer,
        figure: message.figure.toString(),
        fromBlock: Number(message.fromBlock),
        toBlock: Number(message.toBlock),
        blockHash: message.blockHash,
        panelJobId: message.panelJobId,
        panelSize: message.panelSize,
        quorum: message.quorum,
        agreed: message.agreed,
        issuedAt: Number(message.issuedAt),
        expiresAt: Number(message.expiresAt),
        verifyingContract,
      },
    };
    entry.oracle = { status: "attested", failure: null };
    entry.state = "completing";
    entry.completion = {
      state: "queued",
      status: 0,
      resultHash: keccak256(stringToHex(JSON.stringify(entry.attestation.api))),
      uri: `${this.url}/oracle/requests/${entry.oracleRequestId}/attestation`,
      txHash: null,
      delivered: null,
      attempts: 0,
      detail: null,
    };
  }

  /** The plane refuses the request (status 1) or the oracle ends without an answer (status 2). */
  fail(intakeRequestId: Hex, status: 1 | 2, reason: string): void {
    const entry = this.entry(intakeRequestId);
    entry.state = status === 1 ? "refused" : "failed";
    entry.reason = status === 1 ? reason : null;
    entry.oracle =
      status === 1
        ? { status: "refused", failure: reason }
        : { status: reason, failure: "the panel did not reach the quorum" };
    entry.completion = {
      state: "queued",
      status,
      resultHash: `0x${"00".repeat(32)}`,
      uri: `${this.url}/oracle/requests/${entry.oracleRequestId}`,
      txHash: null,
      delivered: null,
      attempts: 0,
      detail: null,
    };
  }

  /**
   * The writer writes: `Intake.complete` on chain, which makes the callback on status 0. Returns
   * whether the callback ran without reverting.
   */
  async complete(intakeRequestId: Hex): Promise<boolean> {
    const entry = this.entry(intakeRequestId);
    if (!entry.completion) throw new Error("nothing is decided for this request yet");
    const args =
      entry.completion.status === 0 && entry.attestation
        ? encodeAbiParameters(ATTESTATION_TUPLE, [
            entry.intakeRequestId,
            entry.attestation.message,
            entry.attestation.signature,
          ])
        : "0x";
    const hash = await this.#node.wallet(WHO.writer).writeContract({
      address: this.#world.intake,
      abi: this.#world.abis.intake,
      functionName: "complete",
      args: [
        entry.intakeRequestId,
        entry.completion.status,
        entry.completion.resultHash,
        entry.completion.uri,
        args,
      ],
      account: WHO.writer.account,
      chain: mainnet,
      gas: 600_000n,
    });
    const receipt = await this.#node.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("complete reverted");
    const completed = getAbiItem({ abi: intakeAbi, name: "Completed" });
    let delivered = false;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: [completed], data: log.data, topics: log.topics });
        delivered = (decoded.args as unknown as { delivered: boolean }).delivered;
      } catch {
        // Another contract's log (the callback's own events).
      }
    }
    entry.completion = { ...entry.completion, state: "confirmed", txHash: hash, delivered, attempts: 1 };
    if (entry.completion.status === 0) entry.state = "completed";
    return delivered;
  }

  #intakeEntry(e: ServiceEntry): Record<string, unknown> {
    return {
      logIndex: e.logIndex,
      blockNumber: e.blockNumber,
      kind: "request",
      intake: this.#world.intake.toLowerCase(),
      state: e.state,
      reason: e.reason,
      detail: null,
      payer: e.payer.toLowerCase(),
      asset: e.asset.toLowerCase(),
      amount: e.amount.toString(),
      requestId: e.intakeRequestId,
      action: "oracle.request",
      actionVersion: "oracle-1",
      bodyHash: e.bodyHash,
      callback: { target: e.target.toLowerCase(), selector: e.selector },
      deliverTo: null,
      order: { id: nextUuid(), status: "paid", action: "oracle.request", policyVersion: "oracle-1" },
      admission: {
        id: nextUuid(),
        result: {
          kind: "oracle",
          requestId: e.oracleRequestId,
          statusUrl: `/oracle/requests/${e.oracleRequestId}`,
          attestationUrl: `/oracle/requests/${e.oracleRequestId}/attestation`,
        },
        createdAt: "2026-10-13T00:00:00.000Z",
      },
      completion: e.completion,
      delivery: null,
      receivedAt: "2026-10-13T00:00:00.000Z",
      updatedAt: "2026-10-13T00:00:00.000Z",
    };
  }

  #attestationDocument(e: ServiceEntry): Record<string, unknown> {
    if (!e.attestation) throw new Error("unreachable");
    const { verifyingContract, ...message } = e.attestation.api;
    return {
      requestId: e.oracleRequestId,
      domain: { name: "IdentityMD Oracle", version: "2", chainId: 1, verifyingContract },
      types: ORACLE_ATTESTATION_TYPES,
      primaryType: "OracleAttestation",
      message,
      signature: e.attestation.signature,
      signer: WHO.oracle.address.toLowerCase(),
      attestedAt: "2026-10-13T00:00:00.000Z",
    };
  }

  #oracleRecord(e: ServiceEntry): Record<string, unknown> {
    const body = JSON.parse(e.body) as Record<string, unknown>;
    const window = body.window as { fromBlock: number; toBlock: number };
    return {
      id: e.oracleRequestId,
      status: e.oracle.status,
      question: body.question,
      questionHash: questionHashOfBody(e.body),
      chainId: body.chainId,
      window,
      answerType: body.answerType,
      evidence: body.evidence ?? "chain",
      panelSize: body.panelSize,
      quorum: body.quorum,
      validForSeconds: body.validForSeconds,
      consumer: { chainId: 1, verifyingContract: e.target.toLowerCase() },
      attestation: e.attestation
        ? Object.fromEntries(Object.entries(e.attestation.api).filter(([k]) => k !== "verifyingContract"))
        : null,
      signature: e.attestation?.signature ?? null,
      signer: e.attestation ? WHO.oracle.address.toLowerCase() : null,
      failure: e.oracle.failure,
      createdAt: "2026-10-13T00:00:00.000Z",
      updatedAt: "2026-10-13T00:00:00.000Z",
    };
  }
}
