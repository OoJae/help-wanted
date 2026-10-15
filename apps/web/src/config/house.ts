/**
 * Every wallet and contract the HELP WANTED team controls. Activity from these addresses is
 * labelled HOUSE in every count the site prints; everything else is OUTSIDE.
 *
 * The source of truth is `evidence/house-wallets.json` at the repository root. This copy lets the
 * web app run without reading outside its folder; `test/config.test.ts` fails when the two differ.
 * Our own contracts are added automatically from `deployments.ts` once they have addresses.
 */
import type { Deployments } from "./deployments";

export interface HouseWallet {
  label: string;
  address: `0x${string}`;
  role: string;
}

export const HOUSE_WALLETS: readonly HouseWallet[] = [
  {
    label: "W1",
    address: "0x871e507B6a70F858Ad4B414bddb77473630C366b",
    role: "Pays for every launch and paid action; the prize wallet; the team's depositor",
  },
  {
    label: "H1",
    address: "0x60CcC928eb8EEE1d64CA0164565BfA9858669560",
    role: "Hot key for the runner and keeper bots; holds a small float only",
  },
];

/** Lowercase addresses that count as HOUSE: the wallets above and every contract of ours that exists. */
export function houseSet(deployments: Deployments): Set<string> {
  const set = new Set<string>(HOUSE_WALLETS.map((w) => w.address.toLowerCase()));
  for (const contract of Object.values(deployments.contracts)) {
    if (contract.address) set.add(contract.address.toLowerCase());
  }
  return set;
}
