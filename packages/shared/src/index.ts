/**
 * @help-wanted/shared: the one place the bots, the indexer and the web app get protocol facts from.
 *
 * - `addresses`    Ethereum mainnet addresses and constants (mirrors `Mainnet.sol`)
 * - `canonical`    canonical JSON exactly as IdentityMD writes it
 * - `chainRead`    naming a log under an ABI, view calls, and why a node refused a log query
 * - `order`        the order ticket, the 85-byte header and the spec character rules
 * - `desk`         states, flags and arithmetic of the hire desk
 * - `jobInput`     from an order's spec to the body of the swarm job
 * - `workRecord`   fetch a work record by hash, check it, and scan it as the contract does
 * - `settlement`   what a work record means for one claim of an order, by the desk's own tests
 * - `oracle`       the question hash, the request body and the attestation
 * - `questions`    Standing Questions: its enums and waits, the three house feeds, the feed id
 * - `deployments`  the book of our own contracts' addresses (empty until each launch)
 * - `api`          a typed, rate-limited client for the public IdentityMD routes
 * - `abi`          ABIs, one file per contract (also at `@help-wanted/shared/abi`): ours are
 *                  generated from the launch projects' build output, the protocol's from signatures
 *
 * Nothing in this package signs, sends a transaction or holds a key.
 *
 * The package exports these TypeScript sources as they are (see `exports` in package.json), so it
 * is consumed through a bundler, vitest or tsx. Plain `node` cannot import it: the sources use `.js`
 * specifiers for `.ts` files. `pnpm --filter @help-wanted/shared build` emits JavaScript to `dist/`
 * for a consumer that needs it.
 */
export * from "./addresses.js";
export * from "./canonical.js";
export * from "./chainRead.js";
export * from "./deployments.js";
export * from "./desk.js";
export * from "./jobInput.js";
export * from "./oracle.js";
export * from "./order.js";
export * from "./questions.js";
export * from "./settlement.js";
export * from "./uuid.js";
export * from "./workRecord.js";
export * from "./api/index.js";
export * from "./abi/index.js";
