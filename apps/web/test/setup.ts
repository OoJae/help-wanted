/**
 * No test may touch the network. Any code path that reaches the real `fetch` fails the test loudly
 * instead of quietly calling api.imd.fun or an RPC.
 */
import { beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("fetch", (input: unknown) => {
    throw new Error(`a test tried to reach the network: ${String(input)}`);
  });
});
