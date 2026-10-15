/**
 * What the tests of the evidence builder share: fixtures, a house list, and a way to make a log of
 * any event of any of our contracts.
 *
 * A made-up log is encoded under the contract's real ABI with viem and then read back with the
 * builder's own decoder, so a test that counts it goes through the same names and types as a log
 * from the chain. When an ABI is regenerated and an event or an argument changes, these tests are
 * where it shows.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Abi,
  type AbiEvent,
} from "viem";
import { contractSpec } from "../contracts.js";
import type { DecodedLog } from "../fold.js";
import { houseList, parseHouseFile, type HouseList } from "../house.js";
import {
  decodeLogUnder,
  type Address,
  type ContractName,
  type Hex,
} from "../shared.js";
import type { Tape } from "../tape.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..", "..");

export function readJson<T = unknown>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(...parts), "utf8")) as T;
}

export const fixture = <T = unknown>(name: string): T =>
  readJson<T>(HERE, "fixtures", name);

/** The recording of a real run on 13 October 2026 (see fixtures/README.md). */
export const TAPE_FILE = "run-2026-10-13.json";
/** Launch A's own record, as IdentityMD served it on 15 October 2026 (see fixtures/README.md). */
export const LAUNCH_RECORD_FILE = "launch-1531-2026-10-15.json";
/**
 * The recording, with launch A's own record beside it: the builder of 13 October read only the
 * list of launches, and the builder now also reads the launch's record for its contracts.
 */
export const tape = (): Tape => {
  const recorded = structuredClone(fixture<Tape>(TAPE_FILE));
  const record = fixture<Pick<Tape, "api">>(LAUNCH_RECORD_FILE);
  return {
    ...recorded,
    api: { ...recorded.api, ...structuredClone(record.api) },
  };
};

/** The house list as it was published on the day of the recording. */
export const HOUSE_FILE = fixture("house-wallets.json");

export const W1 = "0x871e507b6a70f858ad4b414bddb77473630c366b" as Address;
export const H1 = "0x60ccc928eb8eee1d64ca0164565bfa9858669560" as Address;
/** Accounts nobody on the house list controls. */
export const OUTSIDER = "0x00000000000000000000000000000000000a11ce" as Address;
export const STRANGER = "0x0000000000000000000000000000000000000b0b" as Address;
export const RUNNER = "0x00000000000000000000000000000000000c0de5" as Address;

/** Made-up addresses for contracts that are not launched, one per contract. */
export const ADDRESSES: Record<ContractName, Address> = {
  questions: "0xeece4628ceb091c13393fc64056be8b8501fd3f6",
  jobsReport: "0x58963b57e179f7fe4e95090c21e8e9d75353bce4",
  payroll: "0x6e4362a5cec59eb3f611af6b2d81915cf5b45f1f",
  workProof: "0x00000000000000000000000000000000000b0001",
  workOrders: "0x00000000000000000000000000000000000b0002",
  crowdPots: "0x00000000000000000000000000000000000b0003",
  doorbell: "0x00000000000000000000000000000000000b0004",
  rules: "0x00000000000000000000000000000000000c0001",
  endowments: "0x00000000000000000000000000000000000c0002",
  zap: "0x00000000000000000000000000000000000c0003",
};

export function house(
  contracts: readonly ContractName[] = Object.keys(ADDRESSES) as ContractName[],
): HouseList {
  return houseList(
    parseHouseFile(HOUSE_FILE),
    contracts.map((name) => ({
      name,
      launch: contractSpec(name).launch,
      address: ADDRESSES[name],
    })),
  );
}

const eventOf = (abi: Abi, name: string): AbiEvent => {
  const found = abi.find((item) => item.type === "event" && item.name === name);
  if (!found || found.type !== "event")
    throw new Error(`the ABI has no event ${name}`);
  return found;
};

/** Makes logs one after another: each call is a new block unless a transaction is named. */
export class Chain {
  #block = 26_190_000;
  #index = 0;
  #tx = 0;
  readonly logs: DecodedLog[] = [];

  /** A fresh transaction hash, to put several logs in one transaction. */
  tx(): Hex {
    return `0x${(++this.#tx).toString(16).padStart(64, "0")}` as Hex;
  }

  /**
   * Logs `event` of `contract` with the given arguments, sent by `from`. Arguments are given by
   * name, as the ABI names them; indexed ones go into topics, the rest into data.
   */
  emit(
    contract: ContractName,
    event: string,
    args: Record<string, unknown>,
    from: Address,
    tx?: Hex,
  ): DecodedLog {
    const abi = contractSpec(contract).abi;
    const item = eventOf(abi, event);
    for (const input of item.inputs) {
      if (!(input.name && input.name in args))
        throw new Error(`${contract}.${event}: the test gave no ${input.name}`);
    }
    const topics = encodeEventTopics({
      abi,
      eventName: event,
      args,
    } as Parameters<typeof encodeEventTopics>[0]);
    const plain = item.inputs.filter((input) => !input.indexed);
    const data = encodeAbiParameters(
      plain,
      plain.map((input) => args[input.name as string]),
    );
    const named = decodeLogUnder(abi, topics as string[], data);
    if (named === null || Array.isArray(named.args))
      throw new Error(`${contract}.${event} did not decode again`);
    const log: DecodedLog = {
      contract,
      event: named.event,
      args: named.args as Record<string, unknown>,
      txHash: tx ?? this.tx(),
      txFrom: from,
      blockNumber: tx ? this.#block : ++this.#block,
      blockTime: 1_791_900_000 + (this.#block - 26_190_000) * 12,
      logIndex: this.#index++,
    };
    this.logs.push(log);
    return log;
  }
}

export const IMD = 10n ** 18n;
export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;
export const ZERO_WORD = `0x${"00".repeat(32)}` as Hex;

/** `OrderParams` with ordinary values; a test overrides what it cares about. */
export function orderParams(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kindHash: `0x${"11".repeat(32)}`,
    minPay: 1n * IMD,
    maxPay: 2n * IMD,
    rampSecs: 3600,
    deliverySecs: 259_200,
    expiresAt: 1_792_000_000,
    bond: IMD / 4n,
    flags: 0,
    runnerOnly: ZERO_ADDRESS,
    arbiter: ZERO_ADDRESS,
    condTarget: ZERO_ADDRESS,
    condSelector: "0x00000000",
    condArg: ZERO_WORD,
    condCmp: 0,
    condThreshold: 0n,
    ...over,
  };
}

export const JOB = "0xe9efec1656f340d3924352c453effc7d" as Hex;
export const RECORD = `0x${"3d".repeat(32)}` as Hex;

/**
 * The words IdentityMD's launch pipeline reads as an instruction to break something. Nothing we
 * write may hold one. They are spelled backwards here so that this file passes its own check.
 */
const REFUSED_BACKWARDS = [
  "tiolpxe",
  "kcatta",
  "kcah",
  "laets",
  "niard",
  "gur",
  "suoicilam",
  "roodkcab",
  "gnihsihp",
];
export const REFUSED = new RegExp(
  `\\b(${REFUSED_BACKWARDS.map((word) => [...word].reverse().join("")).join("|")})`,
  "i",
);

/**
 * What must never be in a file we publish: a path on somebody's machine, an e-mail address, the
 * names of working notes. The needles are built from pieces, so that this file does not hold what
 * it looks for. Returns what was found, or null.
 */
const PRIVATE_NEEDLES = [
  ["/Us", "ers/"].join(""),
  ["/ho", "me/"].join(""),
  ["/pri", "vate/"].join(""),
  [".bu", "ild/"].join(""),
  ["build", "plan"].join(""),
];
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}\.[a-z]{2,}/;

export function privateText(text: string): string | null {
  for (const needle of PRIVATE_NEEDLES)
    if (text.includes(needle)) return needle;
  // An address is looked for around each "@" only: a file can hold 40,000 hex characters in a row.
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    const found = EMAIL.exec(text.slice(Math.max(0, at - 64), at + 80));
    if (found) return found[0];
  }
  return null;
}

export const EM_DASH = /\u2014/;
