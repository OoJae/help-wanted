// No test of the evidence builder may reach the network: every read comes from a recording or
// from a node played by the test itself. A test that reaches for `fetch` fails here.
globalThis.fetch = (() => {
  throw new Error("a test reached for the network");
}) as typeof fetch;
