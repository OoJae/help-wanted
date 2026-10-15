import { describe, expect, it } from "vitest";
import {
  READ_METHODS,
  ReadFailedError,
  Rpc,
  quantity,
  type HttpPost,
  type ReadMethod,
} from "../rpc.js";
import type { Address } from "../shared.js";

const A = "0x00000000000000000000000000000000000000aa" as Address;
const B = "0x00000000000000000000000000000000000000bb" as Address;
const WORD = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const noSleep = async () => {};

interface Call {
  url: string;
  method: string;
  params: unknown[];
}

/** A node played by a function: it sees each request and returns a result, or throws to refuse. */
function node(calls: Call[], answer: (call: Call) => unknown): HttpPost {
  return async (url, body) => {
    const request = JSON.parse(body) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const call = { url, method: request.method, params: request.params };
    calls.push(call);
    try {
      return {
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: answer(call),
        }),
      };
    } catch (error) {
      const refusal = error as {
        message: string;
        code?: number;
        status?: number;
      };
      return {
        status: refusal.status ?? 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: refusal.code ?? -32000, message: refusal.message },
        }),
      };
    }
  };
}

const refuse = (message: string, status?: number): never => {
  throw Object.assign(
    new Error(message),
    status === undefined ? {} : { status },
  );
};

function log(address: Address, block: number, index: number) {
  return {
    address,
    topics: [WORD(1)],
    data: "0x",
    blockNumber: `0x${block.toString(16)}`,
    blockHash: WORD(block),
    blockTimestamp: "0x6ace02ff",
    transactionHash: WORD(block * 1000 + index),
    transactionIndex: "0x0",
    logIndex: `0x${index.toString(16)}`,
    removed: false,
  };
}

const range = (call: Call) => {
  const filter = call.params[0] as { fromBlock: string; toBlock: string };
  return [
    Number(BigInt(filter.fromBlock)),
    Number(BigInt(filter.toBlock)),
  ] as const;
};

describe("the read-only JSON-RPC client", () => {
  it("knows eight methods, all of them reads, and refuses any other before a request is made", async () => {
    expect([...READ_METHODS].sort()).toEqual([
      "eth_blockNumber",
      "eth_call",
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_getLogs",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
    ]);
    const calls: Call[] = [];
    const rpc = new Rpc(["https://one.example"], {
      post: node(calls, () => "0x1"),
      sleep: noSleep,
    });
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "personal_sign",
      "eth_sign",
      "debug_setHead",
    ]) {
      await expect(rpc.requestOn(0, method as ReadMethod, [])).rejects.toThrow(
        /is not a read: this client refuses it/,
      );
    }
    expect(calls).toEqual([]);
  });

  it("asks the next node when the first cannot serve a read, and names hosts, never URLs, when all fail", async () => {
    const calls: Call[] = [];
    const post = node(calls, (call) =>
      call.url.includes("one") ? refuse("method not available") : "0x1",
    );
    const rpc = new Rpc(
      ["https://one.example/v2/SECRET-KEY", "https://two.example"],
      {
        post,
        sleep: noSleep,
      },
    );
    expect(
      await rpc.read(
        "eth_chainId",
        [],
        (r) => quantity(r, "the chain id"),
        "the chain id",
      ),
    ).toBe(1);
    expect(calls.map((call) => new URL(call.url).host)).toEqual([
      "one.example",
      "two.example",
    ]);

    const dead = new Rpc(["https://one.example/v2/SECRET-KEY"], {
      post: node([], () => refuse("method not available")),
      sleep: noSleep,
    });
    const failure = await dead
      .read(
        "eth_chainId",
        [],
        (r) => quantity(r, "the chain id"),
        "the chain id",
      )
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ReadFailedError);
    expect((failure as Error).message).toContain("one.example");
    expect((failure as Error).message).not.toContain("SECRET-KEY");
  });

  it("treats an answer that fails its check like no answer", async () => {
    const calls: Call[] = [];
    const post = node(calls, (call) =>
      call.url.includes("one") ? "not a number" : "0x10",
    );
    const rpc = new Rpc(["https://one.example", "https://two.example"], {
      post,
      sleep: noSleep,
    });
    expect(
      await rpc.read(
        "eth_blockNumber",
        [],
        (r) => quantity(r, "the head"),
        "the head",
      ),
    ).toBe(16);
    expect(calls).toHaveLength(2);
  });

  it("tries a failure that may pass again: a busy node, a machine of the pool that is behind", async () => {
    let tries = 0;
    const post = node([], () =>
      ++tries < 3
        ? refuse(
            "block range extends beyond current head block: requested 26184869, head 26184110",
          )
        : [],
    );
    const rpc = new Rpc(["https://one.example"], { post, sleep: noSleep });
    expect((await rpc.logs([A], 100, 150, 2000)).logs).toEqual([]);
    expect(tries).toBe(3);

    // A network failure is tried again too, and gives up after three tries.
    let failures = 0;
    const down: HttpPost = async () => {
      failures++;
      throw new Error("fetch failed");
    };
    await expect(
      new Rpc(["https://one.example"], { post: down, sleep: noSleep }).read(
        "eth_chainId",
        [],
        (r) => r,
        "the chain id",
      ),
    ).rejects.toThrow(
      /the chain id could not be read: one.example: the request failed/,
    );
    expect(failures).toBe(3);
  });

  it("reads logs in chunks of the size asked for, in chain order", async () => {
    const calls: Call[] = [];
    const post = node(calls, (call) => {
      const [from, to] = range(call);
      // Served out of order on purpose.
      return [log(A, to, 1), log(B, from, 0)].filter(
        (entry) => Number(BigInt(entry.blockNumber)) >= from,
      );
    });
    const rpc = new Rpc(["https://one.example"], { post, sleep: noSleep });
    const read = await rpc.logs([A, B], 1000, 5999, 2000);
    expect(calls.map(range)).toEqual([
      [1000, 2999],
      [3000, 4999],
      [5000, 5999],
    ]);
    expect((calls[0]?.params[0] as { address: string[] }).address).toEqual([
      A,
      B,
    ]);
    expect(read.chunks).toBe(3);
    expect(read.logs.map((entry) => entry.blockNumber)).toEqual([
      1000, 2999, 3000, 4999, 5000, 5999,
    ]);
    expect(read.logs[0]).toMatchObject({
      address: B,
      logIndex: 0,
      blockTime: 0x6ace02ff,
    });
  });

  it("halves a range the node finds too large, and keeps to the size that worked", async () => {
    const calls: Call[] = [];
    const post = node(calls, (call) => {
      const [from, to] = range(call);
      return to - from + 1 > 500
        ? refuse("query exceeds max block range 500")
        : [log(A, from, 0)];
    });
    const rpc = new Rpc(["https://one.example"], { post, sleep: noSleep });
    const read = await rpc.logs([A], 0, 1499, 2000);
    expect(read.logs.map((entry) => entry.blockNumber)).toEqual([
      0, 375, 750, 1125,
    ]);
    expect(read.smallestChunk).toBe(375);
    // 1500 and 750 blocks were refused once each; after that every request is 375 blocks wide.
    expect(calls.map(range)).toEqual([
      [0, 1499],
      [0, 749],
      [0, 374],
      [375, 749],
      [750, 1124],
      [1125, 1499],
    ]);
  });

  it("asks the next node for history the first does not keep, and says what to do when none keeps it", async () => {
    const calls: Call[] = [];
    const post = node(calls, (call) =>
      call.url.includes("recent")
        ? refuse("Archive requests require a personal token")
        : [log(A, range(call)[0], 0)],
    );
    const rpc = new Rpc(["https://recent.example", "https://history.example"], {
      post,
      sleep: noSleep,
    });
    expect((await rpc.logs([A], 10, 19, 2000)).logs).toHaveLength(1);
    // History refused is not asked for in a smaller range on the same node.
    expect(calls.map((call) => new URL(call.url).host)).toEqual([
      "recent.example",
      "history.example",
    ]);

    const only = new Rpc(["https://recent.example"], { post, sleep: noSleep });
    await expect(only.logs([A], 10, 19, 2000)).rejects.toThrow(
      /the logs of blocks 10 to 19 could not be read: recent.example: eth_getLogs was refused: Archive requests require a personal token\. A node that keeps old logs is needed: set RPC_URL/,
    );
  });

  it("does not believe a log of another address, of a block outside the range, or one that is not a log", async () => {
    const stray = "0x00000000000000000000000000000000000000cc" as Address;
    for (const bad of [
      [log(stray, 12, 0)],
      [log(A, 99, 0)],
      [{ ...log(A, 12, 0), topics: ["0x12"] }],
      "not a list",
    ]) {
      const calls: Call[] = [];
      const post = node(calls, (call) =>
        call.url.includes("one") ? bad : [log(A, 12, 0)],
      );
      const rpc = new Rpc(["https://one.example", "https://two.example"], {
        post,
        sleep: noSleep,
      });
      const read = await rpc.logs([A], 10, 19, 2000);
      expect(read.logs).toHaveLength(1);
      expect(calls).toHaveLength(2);
      await expect(
        new Rpc(["https://one.example"], { post, sleep: noSleep }).logs(
          [A],
          10,
          19,
          2000,
        ),
      ).rejects.toBeInstanceOf(ReadFailedError);
    }
  });

  it("leaves out a log the node marks as removed", async () => {
    const post = node([], () => [
      { ...log(A, 12, 0), removed: true },
      log(A, 13, 1),
    ]);
    const read = await new Rpc(["https://one.example"], {
      post,
      sleep: noSleep,
    }).logs([A], 10, 19, 2000);
    expect(read.logs.map((entry) => entry.blockNumber)).toEqual([13]);
  });

  it("needs at least one URL", () => {
    expect(() => new Rpc([])).toThrow(/no RPC URL was given/);
  });
});
