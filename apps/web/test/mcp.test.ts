/**
 * The MCP server at /mcp, driven the way a client drives it: one JSON-RPC message per POST, with
 * the recorded upstreams of `helpers.ts` behind it and no network. Both eras of the protocol are
 * covered: the `initialize` handshake of 2025-03-26 to 2025-11-25, and the per-request metadata of
 * 2026-07-28.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, hexToString } from "viem";
import { describe, expect, it } from "vitest";
import {
  DESK,
  erc20Abi,
  kindHash,
  MAINNET,
  PAID_ACTION_PRICE,
  splitPrice,
  workOrdersAbi,
} from "@help-wanted/shared";
import { REFERENCE_JOB } from "~/config/chain";
import { TEMPLATES } from "~/config/templates";
import { SlidingWindowLimiter } from "~/lib/cache";
import {
  callTool,
  handleMcpHttp,
  hostedRunner,
  leastPriceFor,
  LEGACY_VERSIONS,
  MCP_PROTOCOL_VERSION,
  RPC_ERROR,
  SUPPORTED_VERSIONS,
  TOOLS,
  type McpOptions,
} from "~/lib/mcp";
import { openApiDocument } from "~/lib/openapi";
import { llmsTxt, robotsTxt } from "~/lib/siteDocs";
import { RUNNER_STATEMENT } from "~/models/desk";
import { matchPage, parseTwinPath } from "~/models/registry";
import { BANNED, BOOKS, ctxFor, testSources, UNRECEIPTED_JOB, type TestWorld } from "./helpers";

const ORIGIN = "https://help-wanted.test";
const OPTIONS: McpOptions = { allowedOrigins: [ORIGIN] };

interface RpcAnswer {
  status: number;
  headers: Record<string, string>;
  json: {
    jsonrpc?: string;
    id?: string | number;
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: Record<string, unknown> };
  } | null;
  text: string | null;
}

async function post(
  world: TestWorld,
  message: unknown,
  headers: Record<string, string> = {},
  options: McpOptions = OPTIONS,
  visitor: string | null = null,
): Promise<RpcAnswer> {
  const answer = await handleMcpHttp(
    {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      }),
      body: typeof message === "string" ? message : JSON.stringify(message),
    },
    ctxFor(world, "/mcp", visitor),
    options,
  );
  let json: RpcAnswer["json"] = null;
  try {
    json = answer.body ? (JSON.parse(answer.body) as RpcAnswer["json"]) : null;
  } catch {
    json = null;
  }
  return { status: answer.status, headers: answer.headers, json, text: answer.body };
}

/** A request as a client of revision 2026-07-28 sends it: metadata in the body, mirrored in headers. */
function modern(method: string, params: Record<string, unknown> = {}, id: number | string = 1) {
  const message = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const headers: Record<string, string> = {
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  return { message, headers };
}

function call(name: string, args: Record<string, unknown>, id = 7) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
};

async function tool(world: TestWorld, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const answer = await post(world, call(name, args), { "mcp-protocol-version": "2025-11-25" });
  expect(answer.status).toBe(200);
  expect(answer.json?.error).toBeUndefined();
  return answer.json?.result as unknown as ToolResult;
}

describe("/mcp: the handshake of the initialize-based revisions", () => {
  it("answers initialize with the revision asked for, its tools capability and how to use it", async () => {
    const world = testSources();
    for (const asked of LEGACY_VERSIONS) {
      const answer = await post(world, {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: "test", version: "1" } },
      });
      expect(answer.status).toBe(200);
      expect(answer.headers["content-type"]).toBe("application/json; charset=utf-8");
      // No session: the server mints no Mcp-Session-Id, and answers each request on its own.
      expect(Object.keys(answer.headers).map((h) => h.toLowerCase())).not.toContain("mcp-session-id");
      expect(answer.json?.id).toBe(0);
      expect(answer.json?.result).toMatchObject({
        protocolVersion: asked,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "help-wanted", title: "HELP WANTED", websiteUrl: ORIGIN },
      });
      expect(String(answer.json?.result?.instructions)).toContain("None signs or sends anything");
    }
    // A revision it does not know: the newest of the handshake revisions it speaks.
    const other = await post(world, {
      jsonrpc: "2.0",
      id: "a",
      method: "initialize",
      params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(other.json?.result?.protocolVersion).toBe("2025-11-25");
  });

  it("takes notifications/initialized with 202 and no body", async () => {
    const answer = await post(testSources(), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(answer.status).toBe(202);
    expect(answer.text).toBeNull();
  });

  it("answers ping, and says a method it does not have is not found", async () => {
    const world = testSources();
    expect((await post(world, { jsonrpc: "2.0", id: 3, method: "ping" })).json).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {},
    });
    const unknown = await post(world, { jsonrpc: "2.0", id: 4, method: "resources/list" });
    expect(unknown.status).toBe(200);
    expect(unknown.json?.id).toBe(4);
    expect(unknown.json?.error?.code).toBe(RPC_ERROR.METHOD_NOT_FOUND);
    expect(unknown.json?.error?.message).toContain("resources/list");
  });
});

describe("/mcp: tools/list", () => {
  it("lists nine tools, each with an input schema, a title and read-only annotations", async () => {
    const answer = await post(testSources(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = answer.json?.result?.tools as {
      name: string;
      title: string;
      description: string;
      inputSchema: {
        type: string;
        properties: Record<string, { type: string; description: string }>;
        additionalProperties: boolean;
        required?: string[];
      };
      annotations: Record<string, unknown>;
    }[];
    expect(tools.map((t) => t.name)).toEqual([
      "desk_status",
      "list_orders",
      "get_order",
      "list_templates",
      "quote_order",
      "plan_order",
      "plan_ring_doorbell",
      "verify_job",
      "receipts_status",
    ]);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]{1,64}$/);
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.description.length, t.name).toBeGreaterThan(80);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const [name, prop] of Object.entries(t.inputSchema.properties)) {
        expect(["string", "integer", "number", "boolean"], `${t.name}.${name}`).toContain(prop.type);
        expect(prop.description.length, `${t.name}.${name}`).toBeGreaterThan(10);
      }
      for (const name of t.inputSchema.required ?? []) expect(t.inputSchema.properties[name]).toBeDefined();
      expect(t.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      // What every agent reads first is held to the site's own words.
      const text = `${t.title} ${t.description} ${JSON.stringify(t.inputSchema)}`;
      expect(BANNED.test(text), t.name).toBe(false);
      expect(text).not.toMatch(/—/);
    }
    expect(tools.find((t) => t.name === "plan_order")?.inputSchema.required).toEqual(["template", "maxPay"]);
    expect(tools.find((t) => t.name === "verify_job")?.inputSchema.required).toEqual(["jobId"]);
  });
});

describe("/mcp: tools/call", () => {
  it("verify_job runs the receipt check /verify runs: the reference job is proven on chain", async () => {
    const result = await tool(testSources(), "verify_job", { jobId: REFERENCE_JOB.jobId });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      jobId: REFERENCE_JOB.jobId,
      verdict: "proven",
      stamp: "PROVEN ON CHAIN",
      receipt: REFERENCE_JOB.receipt,
      record: { keccak: REFERENCE_JOB.receipt, matches: true, bytes: REFERENCE_JOB.recordBytes },
      page: `${ORIGIN}/verify/${REFERENCE_JOB.jobId}`,
    });
    expect(result.content[0]?.text).toContain(`PROVEN ON CHAIN: job ${REFERENCE_JOB.jobId}`);
    // The second block is the same data as JSON, for a client that reads text only.
    expect(JSON.parse(result.content[1]?.text ?? "null")).toEqual(result.structuredContent);
    // The job's objective was written by whoever ordered it: fenced, as in the JSON twins.
    const facts = result.structuredContent.facts as { objective: { untrusted: boolean; text: string } };
    expect(facts.objective.untrusted).toBe(true);
    expect(facts.objective.text.length).toBeGreaterThan(0);
    const commands = result.structuredContent.commands as { command: string }[];
    expect(commands[0]?.command).toContain(`cast call ${MAINNET.WORK_REGISTRY} "latest(bytes16)(bytes32)"`);
  });

  it("verify_job says NO RECEIPT YET for a finished job the registry holds nothing for, and refuses a bad id", async () => {
    const world = testSources();
    const none = await tool(world, "verify_job", { jobId: UNRECEIPTED_JOB });
    expect(none.structuredContent).toMatchObject({ verdict: "no_receipt", stamp: "NO RECEIPT YET" });
    const bad = await tool(world, "verify_job", { jobId: "not-a-job" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.problems).toEqual(["A job id is a UUID, or 32 hex characters."]);
  });

  it("plan_order returns the approve and the createOrder, unsigned, from the flows planner", async () => {
    const world = testSources({ book: BOOKS.aAndB });
    const desk = world.sources.deployments.contracts.workOrders.address as string;
    const question = "Compare the fee models of the three largest on-chain job escrows.";
    const result = await tool(world, "plan_order", {
      template: "research",
      jobText: question,
      maxPay: "1",
      from: "0x871e507B6a70F858Ad4B414bddb77473630C366b",
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent as {
      sendable: boolean;
      jobText: string;
      kind: string;
      maxPayImd: string;
      expiresAt: string;
      transactions: {
        step: number;
        chainId: number;
        from: string;
        to: string;
        value: string;
        valueWei: string;
        data: `0x${string}`;
        simulate: string;
        cast: string;
      }[];
    };
    expect(data.sendable).toBe(true);
    expect(data.kind).toBe("skill:research-report");
    expect(data.jobText).toBe(question);
    expect(data.maxPayImd).toBe("1");
    expect(data.expiresAt).toBe(new Date(ctxFor(world).now.getTime() + 7 * 86_400_000).toISOString());
    expect(data.transactions).toHaveLength(2);
    const [approve, create] = data.transactions;
    expect(approve).toMatchObject({ step: 1, chainId: 1, to: MAINNET.IMD, value: "0x0", valueWei: "0" });
    expect(approve?.from).toBe("0x871e507B6a70F858Ad4B414bddb77473630C366b");
    const approved = decodeFunctionData({ abi: erc20Abi, data: approve!.data });
    expect(approved.functionName).toBe("approve");
    expect(String(approved.args?.[0]).toLowerCase()).toBe(desk.toLowerCase());
    expect(approved.args?.[1]).toBe(10n ** 18n);
    expect(create).toMatchObject({ step: 2, chainId: 1, to: desk, value: "0x0" });
    const created = decodeFunctionData({ abi: workOrdersAbi, data: create!.data });
    expect(created.functionName).toBe("createOrder");
    const [params, spec] = created.args as unknown as [Record<string, unknown>, `0x${string}`];
    expect(params).toMatchObject({
      kindHash: kindHash("skill:research-report"),
      minPay: 10n ** 18n,
      maxPay: 10n ** 18n,
      rampSecs: 0,
      bond: DESK.MIN_BOND,
      flags: 0,
    });
    expect(hexToString(spec)).toBe(question);
    // Each step can be simulated from the user's address before it is signed.
    expect(create?.simulate).toBe(
      `cast call ${desk} --data ${create?.data} --from 0x871e507B6a70F858Ad4B414bddb77473630C366b --rpc-url https://ethereum-rpc.publicnode.com`,
    );
    expect(create?.cast).toContain("--account <your-keystore-account>");
    expect(result.content[0]?.text).toContain("2 unsigned transactions for Ethereum mainnet");
    expect(result.content[0]?.text).toContain("This server signs nothing and sends nothing.");
  });

  it("plan_order refuses a job text the desk or the runner would refuse, and says why", async () => {
    const world = testSources({ book: BOOKS.aAndB });
    const quoted = await tool(world, "plan_order", {
      template: "research",
      jobText: 'Say "hello"',
      maxPay: "1",
    });
    expect(quoted.isError).toBe(true);
    expect(String((quoted.structuredContent.problems as string[])[0])).toMatch(/double quote/i);
    const audit = await tool(world, "plan_order", { template: "audit", jobText: "the vault", maxPay: "2" });
    expect(audit.isError).toBe(true);
    expect((audit.structuredContent.problems as string[]).join(" ")).toContain("Repository: this is needed.");
    const amount = await tool(world, "plan_order", { template: "image", jobText: "A door", maxPay: "1,5" });
    expect(amount.isError).toBe(true);
    const unknown = await tool(world, "plan_order", {
      template: "image",
      jobText: "A door",
      maxPay: "1",
      colour: "red",
    });
    expect((unknown.structuredContent.problems as string[])[0]).toContain('Unknown argument "colour"');
  });

  it("plan_order plans an audit from the repository and the commit, and an unlaunched desk is not sendable", async () => {
    const audit = await tool(testSources({ book: BOOKS.aAndB }), "plan_order", {
      template: "audit",
      jobText: "the withdrawal path",
      repoUrl: "https://github.com/owner/repo",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      maxPay: 3,
    });
    expect(audit.isError).toBe(false);
    expect(audit.structuredContent.jobText).toContain(
      "Inputs: repoUrl=https://github.com/owner/repo; baseCommit=0123456789abcdef0123456789abcdef01234567",
    );
    const none = await tool(testSources({ book: BOOKS.none }), "plan_order", {
      template: "image",
      jobText: "A door",
      maxPay: "1",
    });
    expect(none.structuredContent.sendable).toBe(false);
    expect((none.structuredContent.transactions as { to: string | null }[])[1]?.to).toBeNull();
  });

  it("quote_order splits the price as the desk does and says what the runner needs", async () => {
    const result = await tool(testSources({ book: BOOKS.aAndB }), "quote_order", {
      template: "research",
      pay: "1",
    });
    const split = splitPrice(10n ** 18n);
    expect(result.structuredContent).toMatchObject({
      template: "research",
      priceImd: "1",
      split: { feeImd: "0.05", tipImd: "0.05", runnerKeepsImd: "0.9" },
      runnerNeeds: { bondImd: "0.25", swarmFeeImd: "0.5", marginImd: "0.4" },
    });
    expect(split.runnerPay).toBe(9n * 10n ** 17n);
    // The test book's desk is not mainnet's, so nothing is said of the team's runner.
    expect(result.structuredContent.hostedRunner).toBeNull();
  });

  it("desk_status, list_templates, list_orders, get_order, plan_ring_doorbell and receipts_status answer", async () => {
    const world = testSources();
    const status = await tool(world, "desk_status", {});
    expect(status.isError).toBe(false);
    expect(status.structuredContent).toMatchObject({ chainId: 1, contracts: { launched: 0, of: 10 } });
    expect(status.content[0]?.text).toContain("0 of 10 HELP WANTED contracts are launched");
    const templates = await tool(world, "list_templates", {});
    expect((templates.structuredContent.templates as { template: string }[]).map((t) => t.template)).toEqual(
      TEMPLATES.map((t) => t.slug),
    );
    const orders = await tool(world, "list_orders", { state: "open" });
    expect(orders.structuredContent).toMatchObject({ launched: false, orders: [] });
    const order = await tool(world, "get_order", { id: 1 });
    expect(order.structuredContent).toMatchObject({ id: 1, launched: false, state: null });
    const bell = await tool(world, "plan_ring_doorbell", {});
    expect(bell.structuredContent.sendable).toBe(false);
    const receipts = await tool(world, "receipts_status", {});
    expect(["late", "flowing", "unknown"]).toContain(receipts.structuredContent.state);
    expect(String(receipts.structuredContent.command)).toContain(
      `cast logs --address ${MAINNET.WORK_REGISTRY}`,
    );
  });

  it("answers an unknown tool with Invalid params, and a bad argument as a tool error the model can correct", async () => {
    const world = testSources();
    const unknown = await post(world, call("send_money", {}));
    expect(unknown.json?.error?.code).toBe(RPC_ERROR.INVALID_PARAMS);
    const bad = await tool(world, "get_order", { id: "first" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.problems).toEqual(['"id" must be a whole number.']);
    const missing = await tool(world, "quote_order", {});
    expect(String((missing.structuredContent.problems as string[])[0])).toContain('"template" is needed');
    // A research order without its question names the argument to add.
    const noText = await tool(world, "plan_order", { template: "research", maxPay: "0.6" });
    expect(noText.isError).toBe(true);
    expect(String((noText.structuredContent.problems as string[])[0])).toContain(
      '"jobText" is needed for a research order',
    );
  });

  it("cuts a call off at its time limit and says to try again; the reads carry on", async () => {
    const hanging = testSources({
      api: { fetch: (() => new Promise<Response>(() => undefined)) as typeof fetch, calls: [] },
    });
    const verify = TOOLS.find((t) => t.name === "verify_job")!;
    const started = Date.now();
    const result = (await callTool(
      verify,
      { jobId: UNRECEIPTED_JOB },
      ctxFor(hanging),
      50,
    )) as unknown as ToolResult;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("took longer than 1 s");
  });

  it("holds one visitor to its tool calls a minute", async () => {
    const world = testSources();
    const options: McpOptions = {
      allowedOrigins: [ORIGIN],
      toolCalls: new SlidingWindowLimiter({ max: 1, windowMs: 60_000 }),
    };
    const first = await post(world, call("list_templates", {}), {}, options, "203.0.113.9");
    expect((first.json?.result as unknown as ToolResult).isError).toBe(false);
    const second = await post(world, call("list_templates", {}), {}, options, "203.0.113.9");
    expect((second.json?.result as unknown as ToolResult).isError).toBe(true);
    expect((second.json?.result as unknown as ToolResult).content[0]?.text).toContain("Slow down");
  });
});

describe("/mcp: revision 2026-07-28, metadata on every request", () => {
  it("answers server/discover with the revisions it speaks, and tools/list with resultType", async () => {
    const world = testSources();
    const discover = modern("server/discover");
    const answer = await post(world, discover.message, discover.headers);
    expect(answer.status).toBe(200);
    expect(answer.json?.result).toMatchObject({
      resultType: "complete",
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "help-wanted" } },
    });
    expect(SUPPORTED_VERSIONS[0]).toBe("2026-07-28");
    const list = modern("tools/list");
    const tools = await post(world, list.message, list.headers);
    expect(tools.json?.result).toMatchObject({
      resultType: "complete",
      ttlMs: 3_600_000,
      cacheScope: "public",
    });
    expect(answer.json?.result).toMatchObject({ ttlMs: 3_600_000, cacheScope: "public" });
    expect((tools.json?.result?.tools as unknown[]).length).toBe(TOOLS.length);
    const verify = modern("tools/call", { name: "verify_job", arguments: { jobId: REFERENCE_JOB.jobId } });
    const proven = await post(world, verify.message, verify.headers);
    expect(proven.json?.result).toMatchObject({ resultType: "complete", isError: false });
    expect((proven.json?.result?.structuredContent as { verdict: string }).verdict).toBe("proven");
  });

  it("answers an unknown method with 404 and Method not found", async () => {
    const unknown = modern("resources/list");
    const answer = await post(testSources(), unknown.message, unknown.headers);
    expect(answer.status).toBe(404);
    expect(answer.json?.error?.code).toBe(RPC_ERROR.METHOD_NOT_FOUND);
  });

  it("refuses headers that do not match the body, an unknown revision and missing capabilities", async () => {
    const world = testSources();
    const list = modern("tools/list");
    const wrongMethod = await post(world, list.message, { ...list.headers, "mcp-method": "tools/call" });
    expect(wrongMethod.status).toBe(400);
    expect(wrongMethod.json?.error?.code).toBe(RPC_ERROR.HEADER_MISMATCH);
    const noHeader = await post(world, list.message, { "mcp-method": "tools/list" });
    expect(noHeader.json?.error?.code).toBe(RPC_ERROR.HEADER_MISMATCH);
    const named = modern("tools/call", { name: "verify_job", arguments: { jobId: REFERENCE_JOB.jobId } });
    const wrongName = await post(world, named.message, { ...named.headers, "mcp-name": "plan_order" });
    expect(wrongName.json?.error?.code).toBe(RPC_ERROR.HEADER_MISMATCH);
    const encoded = await post(world, named.message, {
      ...named.headers,
      "mcp-name": `=?base64?${btoa("verify_job")}?=`,
    });
    expect(encoded.status).toBe(200);

    const future = {
      ...list.message,
      params: {
        _meta: { ...list.message.params._meta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
      },
    };
    const unsupported = await post(world, future, { ...list.headers, "mcp-protocol-version": "2099-01-01" });
    expect(unsupported.status).toBe(400);
    expect(unsupported.json?.error).toMatchObject({
      code: RPC_ERROR.UNSUPPORTED_VERSION,
      data: { supported: SUPPORTED_VERSIONS, requested: "2099-01-01" },
    });

    const bare = {
      ...list.message,
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION } },
    };
    const noCapabilities = await post(world, bare, list.headers);
    expect(noCapabilities.status).toBe(400);
    expect(noCapabilities.json?.error?.code).toBe(RPC_ERROR.INVALID_PARAMS);
    // A modern client that left the metadata out of the body entirely.
    const noMeta = await post(world, { jsonrpc: "2.0", id: 1, method: "tools/list" }, list.headers);
    expect(noMeta.status).toBe(400);
    expect(noMeta.json?.error?.code).toBe(RPC_ERROR.INVALID_PARAMS);
  });
});

describe("/mcp over HTTP", () => {
  it("answers GET with 405 and where to read about it", async () => {
    const answer = await handleMcpHttp(
      { method: "GET", headers: new Headers(), body: "" },
      ctxFor(testSources(), "/mcp"),
      OPTIONS,
    );
    expect(answer.status).toBe(405);
    expect(answer.headers.allow).toBe("POST");
    expect(answer.body).toContain(`claude mcp add --transport http help-wanted ${ORIGIN}/mcp`);
    expect(answer.body).toContain(`${ORIGIN}/skill.md`);
  });

  it("refuses what is not one JSON-RPC message, a page of another site, and a body too large", async () => {
    const world = testSources();
    const notJson = await post(world, "{nope");
    expect(notJson.status).toBe(400);
    expect(notJson.json?.error?.code).toBe(RPC_ERROR.PARSE);
    const batch = await post(world, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(batch.status).toBe(400);
    expect(batch.json?.error?.code).toBe(RPC_ERROR.INVALID_REQUEST);
    const nullId = await post(world, { jsonrpc: "2.0", id: null, method: "ping" });
    expect(nullId.status).toBe(400);
    const elsewhere = await post(
      world,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { origin: "https://elsewhere.example" },
    );
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.json?.error?.code).toBe(RPC_ERROR.INVALID_REQUEST);
    expect(elsewhere.json).not.toHaveProperty("id");
    const ours = await post(world, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: ORIGIN });
    expect(ours.status).toBe(200);
    const big = await handleMcpHttp(
      { method: "POST", headers: new Headers({ "content-type": "application/json" }), body: null },
      ctxFor(world, "/mcp"),
      OPTIONS,
    );
    expect(big.status).toBe(413);
  });
});

describe("the hosted runner, as the tools say it", () => {
  it("says what the team's dated statement says, and no more", () => {
    const runner = hostedRunner("0x730cb6c845d896e33283d3a4ed8967f8baa778d2");
    expect(runner).not.toBeNull();
    const words = RUNNER_STATEMENT.lines.join(" ");
    expect(words).toContain("one order at a time");
    expect(words).toContain(
      "research reports and pictures (the kinds skill:research-report and skill:create-image)",
    );
    expect(words).toContain("at most one 0.5 IMD swarm fee a day");
    expect(words).toContain("bonds of at most 0.25 IMD");
    expect(words).toContain("an order need only pay it the swarm's 0.5 IMD fee");
    expect(runner?.serves.map((s) => s.kind)).toEqual(["skill:research-report", "skill:create-image"]);
    expect(runner?.capacity).toMatchObject({
      ordersAtOnce: 1,
      swarmFeesPerDay: 1,
      swarmFeeImd: "0.5",
      largestBondImd: "0.25",
    });
    expect(hostedRunner(null)).toBeNull();
    expect(hostedRunner("0x00000000000000000000000000000000000000b2")).toBeNull();
  });

  it("works out the least price that pays the runner the swarm's fee, to the wei", () => {
    const least = leastPriceFor(PAID_ACTION_PRICE);
    expect(splitPrice(least).runnerPay).toBeGreaterThanOrEqual(PAID_ACTION_PRICE);
    expect(splitPrice(least - 1n).runnerPay).toBeLessThan(PAID_ACTION_PRICE);
    // Order 2 paid 0.56005 IMD and its runner 0.504045 IMD: above the least price.
    expect(least).toBeLessThan(560_050_000_000_000_000n);
  });
});

describe("the front door for agents", () => {
  const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));

  it("/llms.txt and /robots.txt name the MCP endpoint, the skill and the orientation", async () => {
    const text = await llmsTxt(ctxFor(testSources()));
    expect(text).toContain("## For AI agents: MCP and a skill");
    expect(text).toContain(`claude mcp add --transport http help-wanted ${ORIGIN}/mcp`);
    expect(text).toContain(`codex mcp add help-wanted --url ${ORIGIN}/mcp`);
    expect(text).toContain(`(${ORIGIN}/skill.md)`);
    expect(text).toContain(`(${ORIGIN}/agents.md)`);
    for (const t of TOOLS) expect(text).toContain(`\`${t.name}\``);
    expect(text).toContain(MCP_PROTOCOL_VERSION);
    // A server not told its address prints a variable and says what to set it to.
    const bare = testSources({ env: { SITE_ORIGIN: "" } });
    const unaddressed = await llmsTxt({ ...ctxFor(bare), url: new URL("http://localhost:4321/llms.txt") });
    expect(unaddressed).toContain("claude mcp add --transport http help-wanted $SITE/mcp");
    expect(unaddressed).toContain("# Set SITE to the address you are reading this at.");
    expect(unaddressed).not.toContain("localhost");
    expect(robotsTxt(ctxFor(testSources()))).toContain("/mcp");
  });

  it("/openapi.json describes /mcp as the one POST", () => {
    const doc = openApiDocument(ORIGIN) as { paths: Record<string, Record<string, { summary: string }>> };
    expect(doc.paths["/mcp"]?.post?.summary).toContain("JSON-RPC 2.0");
    expect(doc.paths["/mcp"]?.post?.summary).toContain(MCP_PROTOCOL_VERSION);
    expect(Object.keys(doc.paths["/mcp"] ?? {}).sort()).toEqual(["get", "post"]);
  });

  it("serves skill.md and agents.md as static files that shadow no page or twin", () => {
    const files = readdirSync(PUBLIC);
    expect(files).toContain("skill.md");
    expect(files).toContain("agents.md");
    for (const name of files) {
      const twin = parseTwinPath(`/${name}`);
      if (twin) expect([name, matchPage(twin.path)]).toEqual([name, null]);
    }
  });

  it("skill.md is a skill: a name and a description, how to connect, the safe flow and the limits", () => {
    const skill = readFileSync(`${PUBLIC}skill.md`, "utf8");
    const front = /^---\nname: ([a-z-]+)\ndescription: (.+)\n---\n/.exec(skill);
    expect(front?.[1]).toBe("help-wanted");
    expect(front?.[2]?.length).toBeGreaterThan(100);
    expect(skill).toContain(
      "claude mcp add --transport http help-wanted https://web-production-a7c148.up.railway.app/mcp",
    );
    for (const t of TOOLS) expect(skill, t.name).toContain(`\`${t.name}`);
    expect(skill).toContain("## Order work: the safe flow");
    expect(skill).toContain("## Honest limits");
    expect(skill).toContain("Never ask for a private key");
    const agents = readFileSync(`${PUBLIC}agents.md`, "utf8");
    for (const text of [skill, agents]) {
      expect(BANNED.test(text)).toBe(false);
      expect(text).not.toMatch(/—/);
      expect(text).not.toMatch(/hackathon/i);
    }
    // The addresses the skill names are the book's and IdentityMD's.
    expect(skill).toContain(MAINNET.IMD);
    expect(skill).toContain(MAINNET.WORK_REGISTRY);
  });
});
