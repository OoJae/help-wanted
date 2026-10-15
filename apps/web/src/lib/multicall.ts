/**
 * Several view calls in one `eth_call`, through Multicall3. A page that shows twenty jobs asks the
 * WorkRegistry about all of them with one request instead of twenty.
 */
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  type Abi,
  type Hex,
} from "viem";
import { MULTICALL3 } from "~/config/chain";
import type { EthReader } from "./jsonrpc";

/**
 * The one function of Multicall3 this site calls. Multicall3 is a public utility, not part of the
 * IdentityMD protocol and not a contract of ours, so its interface is written here and nowhere else.
 */
export const multicall3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export interface ViewCall {
  to: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type ViewResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Runs every call and reports each one's own outcome: a call that reverts, or whose answer does not
 * decode, fails alone. Throws only when the multicall itself cannot be made.
 */
export async function readMany(reader: EthReader, calls: readonly ViewCall[]): Promise<ViewResult[]> {
  if (calls.length === 0) return [];
  const data = encodeFunctionData({
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [
      calls.map((call) => ({
        target: call.to as Hex,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: call.abi,
          functionName: call.functionName,
          args: call.args ?? [],
        }),
      })),
    ],
  });
  const raw = await reader.call(MULTICALL3, data);
  const results = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: raw });
  return calls.map((call, index): ViewResult => {
    const result = results[index];
    if (!result) return { ok: false, error: "no result" };
    if (!result.success) return { ok: false, error: "the call reverted" };
    if (result.returnData === "0x") return { ok: false, error: "no contract answered at this address" };
    try {
      return {
        ok: true,
        value: decodeFunctionResult({
          abi: call.abi,
          functionName: call.functionName,
          data: result.returnData,
        }),
      };
    } catch {
      return { ok: false, error: "the answer did not decode" };
    }
  });
}

/** One view call on its own. */
export async function readOne(reader: EthReader, call: ViewCall): Promise<unknown> {
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] });
  const raw = await reader.call(call.to, data);
  if (raw === "0x") throw new Error("no contract answered at this address");
  return decodeFunctionResult({ abi: call.abi, functionName: call.functionName, data: raw });
}

/**
 * For tests: answers a Multicall3 `aggregate3` call by handing each inner call to `answer`, which
 * returns the ABI-encoded result or null for a revert.
 */
export function answerMulticall(data: Hex, answer: (target: string, callData: Hex) => Hex | null): Hex {
  const { args } = decodeFunctionData({ abi: multicall3Abi, data });
  const calls = args[0] as readonly { target: string; allowFailure: boolean; callData: Hex }[];
  return encodeFunctionResult({
    abi: multicall3Abi,
    functionName: "aggregate3",
    result: calls.map((call) => {
      const out = answer(call.target.toLowerCase(), call.callData);
      return out === null ? { success: false, returnData: "0x" as Hex } : { success: true, returnData: out };
    }),
  });
}
