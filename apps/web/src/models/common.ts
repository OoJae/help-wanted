/** Pieces several page models share. */
import type { Abi } from "viem";
import {
  LAUNCH_KEYS,
  NOT_LAUNCHED,
  type ContractKey,
  type Deployments,
  type LaunchKey,
} from "~/config/deployments";
import { DEFAULT_RPC_URL, etherscanAddress } from "~/config/chain";
import type { Live } from "~/data/house";
import { callSignatureOf, signatureOf } from "~/lib/contracts";
import type { SourceNote } from "./types";

export interface ContractStatus {
  key: ContractKey;
  name: string;
  launch: string;
  role: string;
  /** Null until the contract is launched. */
  address: string | null;
  /** The address, or the words "not launched yet". */
  label: string;
  url: string | null;
}

export function contractStatus(deployments: Deployments, key: ContractKey): ContractStatus {
  const c = deployments.contracts[key];
  return {
    key,
    name: c.name,
    launch: c.launch,
    role: c.role,
    address: c.address,
    label: c.address ?? NOT_LAUNCHED,
    url: c.address ? etherscanAddress(c.address) : null,
  };
}

export function allContracts(deployments: Deployments): ContractStatus[] {
  return (Object.keys(deployments.contracts) as ContractKey[]).map((key) => contractStatus(deployments, key));
}

/** True when every contract of a launch has an address. A launch with only some is not launched. */
export function launchIsLive(deployments: Deployments, key: LaunchKey): boolean {
  return deployments.launches[key].contracts.every((c) => deployments.contracts[c].address !== null);
}

/**
 * True when a launch is live and the deployments book records the transaction that created it.
 * Addresses given by the environment for a fork or a rehearsal are live without being recorded:
 * what a page says of IdentityMD's launch of a project (its number, its pipeline's audit) is said
 * only of a recorded one.
 */
export function launchRecorded(deployments: Deployments, key: LaunchKey): boolean {
  return launchIsLive(deployments, key) && deployments.launches[key].txHash !== null;
}

/**
 * "IdentityMD launch 1573": the launch that created a contract, as the deployments book numbers it.
 * Null while the contract's launch is not live or the book records no number for it.
 */
export function launchWords(deployments: Deployments, key: ContractKey): string | null {
  const launch = deployments.launches[deployments.contracts[key].launch];
  if (!launchIsLive(deployments, launch.key) || launch.launchNumber === null) return null;
  return `IdentityMD launch ${launch.launchNumber}`;
}

/**
 * What a page says about the launches it leans on that are not live: one plain sentence for each
 * launch that is not written into the deployments book, naming the launch and its contracts, then
 * what that means for this page. A launch that is live, and one the page says nothing about, add
 * no sentence, so the list empties by itself as the book fills in.
 */
export function notLiveNotes(
  deployments: Deployments,
  meaning: Partial<Record<LaunchKey, string>>,
): string[] {
  const notes: string[] = [];
  for (const key of LAUNCH_KEYS) {
    const what = meaning[key];
    if (what === undefined || launchIsLive(deployments, key)) continue;
    const launch = deployments.launches[key];
    const contracts = launch.contracts.map((c) => deployments.contracts[c].name).join(", ");
    notes.push(`${launch.name} (launch ${key}: ${contracts}) is ${NOT_LAUNCHED}. ${what}`);
  }
  return notes;
}

/** A source note for one of our own contracts' read-outs. */
export function liveNote<T>(name: string, read: Live<T>): SourceNote {
  if (!read.live) {
    return { name, detail: NOT_LAUNCHED, fetchedAt: null, stale: false, error: null };
  }
  if ("sample" in read && read.sample) {
    return {
      name,
      detail: "SAMPLE DATA, made up for design work and read from no chain",
      fetchedAt: null,
      stale: false,
      error: null,
    };
  }
  return {
    name,
    detail: `read from ${read.address} on Ethereum mainnet`,
    fetchedAt: new Date(read.fetchedAt).toISOString(),
    stale: read.stale,
    error: read.error,
  };
}

/**
 * When the hire desk pays, in the one wording every page uses. The desk has two settlement paths
 * and the second is the employer's choice, so no page may say "only on a receipt" without it.
 * Follows "the escrow …" or "the desk …".
 */
export const PAYS_WHEN =
  "pays when the job's work record is proven on chain against IdentityMD's WorkRegistry or, only if the employer chose to allow it, when a bonded delivery claim goes unchallenged for 24 hours";

/**
 * The RPC printed in commands a reader is meant to copy. Always the public endpoint, never the
 * server's own `RPC_URL`, which may carry a key.
 */
export const PUBLIC_RPC = DEFAULT_RPC_URL;

/** `cast send` line for a contract that may not exist yet. */
export function castSend(
  address: string | null,
  placeholder: string,
  signature: string,
  args: string[],
): string {
  const to = address ?? `$${placeholder}`;
  const tail = args.length ? ` ${args.join(" ")}` : "";
  return `cast send ${to} "${signature}"${tail} --rpc-url ${PUBLIC_RPC} --account <your-keystore-account>`;
}

export function castCall(
  address: string | null,
  placeholder: string,
  signature: string,
  args: string[] = [],
): string {
  const to = address ?? `$${placeholder}`;
  const tail = args.length ? ` ${args.join(" ")}` : "";
  return `cast call ${to} "${signature}"${tail} --rpc-url ${PUBLIC_RPC}`;
}

/** `cast call` for a view of one of our contracts, its signature read from the shared ABI. */
export function castView(
  address: string | null,
  placeholder: string,
  abi: Abi,
  functionName: string,
  args: string[] = [],
): string {
  return castCall(address, placeholder, callSignatureOf(abi, functionName), args);
}

/** `cast send` for a function of one of our contracts, its signature read from the shared ABI. */
export function castWrite(
  address: string | null,
  placeholder: string,
  abi: Abi,
  functionName: string,
  args: string[] = [],
  extra = "",
): string {
  const to = address ?? `$${placeholder}`;
  const tail = args.length ? ` ${args.join(" ")}` : "";
  return `cast send ${to} "${signatureOf(abi, functionName)}"${tail}${extra} --rpc-url ${PUBLIC_RPC} --account <your-keystore-account>`;
}
