/**
 * Helpers for the modules of our own contracts.
 *
 * Launch A's three (Questions, JobsReport, Payroll) are finished: the contracts are on mainnet,
 * their events can no longer change, and each module folds them with the ABI the compiler wrote
 * (`launchedModule`). The modules of launches B and C are still stubs (`ownModule`).
 *
 * Launch B (WorkOrders, CrowdPots, Doorbell) has been on mainnet since 13 October 2026 (IdentityMD
 * launch 1573, block 26,184,581), so its events are final too and its three modules can now be
 * finished the same way; their handlers are simply not written yet. Launch C is not launched and
 * its events can still change.
 *
 * What works for a stub: its tables exist, it has a cursor, and from the moment its address is in
 * the deployments book (or the environment) every log of the contract is stored in `events` (raw
 * topics and data included), from the launch block on. What does not exist yet is the fold from
 * those events into the tables. For a contract that is not launched that is on purpose: guessing
 * at signatures that can still move would write wrong rows later.
 *
 * Finishing one module is three steps and no migration of data:
 *   1. set `abi` to the contract's events (from the compiled artifact or `@help-wanted/shared`);
 *   2. replace `stubHandler()` with the fold described in the module's header, and drop
 *      `stub: true`;
 *   3. run `pnpm reproject --module <name>`, which decodes everything stored so far under the new
 *      ABI and folds it through the new handler.
 *
 * Until then every answer about these tables says so: the status route, each route's `coverage`
 * and each snapshot file carry `handler: "stub"`, so an empty list is never read as "nothing
 * happened on chain".
 */
import type { PgTable } from "drizzle-orm/pg-core";
import type { Abi } from "viem";
import type { OwnContract } from "../../deployments.js";
import type { ContractModule } from "../../engine/module.js";

/** The names of the events an ABI declares, in the ABI's order (the shared package's function). */
export { eventNamesOf } from "@help-wanted/shared";

/**
 * A module for one of our own contracts that is launched: every log of its address, decoded with
 * the contract's generated ABI and folded by `apply`.
 *
 * `folded` and `kept` between them must name every event of the ABI: `folded` are the events the
 * handler writes into a table, `kept` the ones that are stored in `events` and deliberately go no
 * further (each with its reason beside the list). A test fails when the ABI has an event that is in
 * neither list, so a new event cannot be ignored without anybody deciding to.
 */
export function launchedModule(spec: {
  name: string;
  title: string;
  contract: OwnContract;
  abi: Abi;
  tables: PgTable[];
  folded: readonly string[];
  kept: readonly string[];
  apply: ContractModule["apply"];
}): ContractModule & { folded: readonly string[]; kept: readonly string[] } {
  return {
    name: spec.name,
    title: spec.title,
    abi: spec.abi,
    // Feeds, rounds and prints exist only because their first events were seen, so the module
    // begins at the block its launch was mined in (the deployments book gives it).
    needsStartBlock: true,
    filter: (deployments) => {
      const address = deployments[spec.contract];
      return address ? { address } : null;
    },
    tables: spec.tables,
    folded: spec.folded,
    kept: spec.kept,
    apply: spec.apply,
  };
}

/** STUB: a handler that folds nothing. Every use of it is a handler still to be written. */
export function stubHandler(): ContractModule["apply"] {
  return async () => {
    // STUB: intentionally empty. The event is already stored in `events`.
  };
}

/** A module for one of our own contracts: every log of its address, no topic filter. */
export function ownModule(spec: {
  name: string;
  title: string;
  contract: OwnContract;
  tables: PgTable[];
}): ContractModule {
  return {
    name: spec.name,
    title: spec.title,
    // STUB: no ABI yet, so logs are stored undecoded (`event` is topic0, `args` is null).
    abi: [],
    stub: true,
    // Orders, pots, feeds and rules exist only because their creation events were seen, so the
    // module must begin at the contract's deployment block and the engine insists on being told it.
    needsStartBlock: true,
    filter: (deployments) => {
      const address = deployments[spec.contract];
      return address ? { address } : null;
    },
    tables: spec.tables,
    apply: stubHandler(),
  };
}
