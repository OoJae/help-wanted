/**
 * HOUSE and OUTSIDE.
 *
 * The team publishes every wallet it controls in `evidence/house-wallets.json`. Activity of those
 * wallets, and of HELP WANTED's own contracts, is HOUSE; everything else is OUTSIDE. Every count
 * in the evidence is split that way and never added up without the split beside it.
 *
 * The contracts need no list of their own: every address in the deployments book is HOUSE the
 * moment it is written there. The file's `contracts` section is read too, so that an address named
 * there and missing from the book still counts as ours and never as an outsider.
 */
import { checksumAddress, type Address } from "./shared.js";

export type Side = "HOUSE" | "OUTSIDE";

export interface HouseEntry {
  label: string;
  /** Checksummed. */
  address: Address;
  kind: "wallet" | "contract";
  /** A wallet's role, or the launch a contract belongs to, as the list or the book gives it. */
  note: string;
}

export interface HouseList {
  entries: HouseEntry[];
  /** True for an address on the list, in any letter case. */
  has(address: string | null | undefined): boolean;
  /** The label of an address on the list, or null. */
  labelOf(address: string | null | undefined): string | null;
  sideOf(address: string | null | undefined): Side;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function entryOf(
  raw: unknown,
  kind: HouseEntry["kind"],
  where: string,
): HouseEntry {
  if (typeof raw !== "object" || raw === null)
    throw new Error(`${where}: an entry is not an object`);
  const entry = raw as Record<string, unknown>;
  if (typeof entry.label !== "string" || entry.label.trim() === "")
    throw new Error(`${where}: an entry has no label`);
  if (typeof entry.address !== "string" || !ADDRESS.test(entry.address)) {
    throw new Error(`${where}: ${entry.label} has no address`);
  }
  const note = kind === "wallet" ? entry.role : entry.launch;
  return {
    label: entry.label,
    address: checksumAddress(entry.address),
    kind,
    note: typeof note === "string" ? note : "",
  };
}

/** The published list as written. Throws a sentence when the file is not what it should be. */
export function parseHouseFile(
  raw: unknown,
  where = "evidence/house-wallets.json",
): HouseEntry[] {
  if (typeof raw !== "object" || raw === null)
    throw new Error(`${where} is not an object`);
  const file = raw as Record<string, unknown>;
  if (!Array.isArray(file.wallets) || file.wallets.length === 0)
    throw new Error(`${where} lists no wallets`);
  const wallets = file.wallets.map((entry) => entryOf(entry, "wallet", where));
  const contracts = Array.isArray(file.contracts)
    ? file.contracts.map((entry) => entryOf(entry, "contract", where))
    : [];
  return [...wallets, ...contracts];
}

/**
 * The house list: the published wallets, then every contract the book holds an address for, then
 * any contract the published file names that the book does not.
 */
export function houseList(
  published: readonly HouseEntry[],
  bookContracts: readonly { name: string; launch: string; address: Address }[],
): HouseList {
  const entries: HouseEntry[] = [];
  const byAddress = new Map<string, HouseEntry>();
  const add = (entry: HouseEntry) => {
    const key = entry.address.toLowerCase();
    if (byAddress.has(key)) return;
    byAddress.set(key, entry);
    entries.push(entry);
  };
  for (const entry of published) if (entry.kind === "wallet") add(entry);
  for (const contract of bookContracts) {
    add({
      label: contract.name,
      address: checksumAddress(contract.address),
      kind: "contract",
      note: `launch ${contract.launch.toUpperCase()}, from the deployments book`,
    });
  }
  for (const entry of published) if (entry.kind === "contract") add(entry);
  const find = (address: string | null | undefined) =>
    typeof address === "string"
      ? (byAddress.get(address.toLowerCase()) ?? null)
      : null;
  return {
    entries,
    has: (address) => find(address) !== null,
    labelOf: (address) => find(address)?.label ?? null,
    sideOf: (address) => (find(address) !== null ? "HOUSE" : "OUTSIDE"),
  };
}

/** A count with its split. A zero is a zero: all three numbers are always present. */
export interface Split {
  total: number;
  house: number;
  outside: number;
}

/**
 * Transactions by sender. `byIdentityMd` counts those sent by IdentityMD's own service accounts
 * (the Intake's writer delivering an oracle answer, the WorkRegistry's writer): a delivery of
 * something that was paid for, which is nobody's use of our contracts, HOUSE or OUTSIDE.
 * `total` is all three together.
 */
export interface TransactionSplit extends Split {
  byIdentityMd: number;
}

/** An amount of IMD in wei, as decimal strings, with its split. */
export interface AmountSplit {
  totalWei: string;
  houseWei: string;
  outsideWei: string;
}

export interface Counted extends Split {
  /** Present when the thing counted carries an amount. */
  imd?: AmountSplit;
}

/** Adds things up, HOUSE and OUTSIDE apart. */
export class Tally {
  #house = 0;
  #outside = 0;
  #houseWei = 0n;
  #outsideWei = 0n;
  readonly #withAmount: boolean;

  constructor(withAmount = false) {
    this.#withAmount = withAmount;
  }

  add(side: Side, wei: bigint = 0n): this {
    if (side === "HOUSE") {
      this.#house++;
      this.#houseWei += wei;
    } else {
      this.#outside++;
      this.#outsideWei += wei;
    }
    return this;
  }

  get total(): number {
    return this.#house + this.#outside;
  }

  get totalWei(): bigint {
    return this.#houseWei + this.#outsideWei;
  }

  split(): Split {
    return {
      total: this.#house + this.#outside,
      house: this.#house,
      outside: this.#outside,
    };
  }

  amounts(): AmountSplit {
    return {
      totalWei: (this.#houseWei + this.#outsideWei).toString(10),
      houseWei: this.#houseWei.toString(10),
      outsideWei: this.#outsideWei.toString(10),
    };
  }

  counted(): Counted {
    return this.#withAmount
      ? { ...this.split(), imd: this.amounts() }
      : this.split();
  }
}
