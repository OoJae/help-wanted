/**
 * IMD transfers to the fee payee: the raw material of the Robot Jobs Report.
 *
 * Every paid action on IdentityMD (a job, an oracle request, a launch, a schedule top-up) moves
 * IMD to one address. An x402 payment moves it straight from the buyer's wallet through Permit2,
 * and the Intake forwards a contract's payment with `transferFrom(msg.sender, payTo, amount)`
 * (verified source), so in both cases the log's `from` is whoever paid. Counting these logs per day
 * gives the report's three numbers: IMD paid, payments made, distinct payers.
 *
 * The node filters by recipient (topic 2), so only these transfers are ever downloaded.
 */
import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { pad, parseAbi } from "viem";
import { z } from "zod";
import { FEE_PAYEE, IMD, TOPIC } from "../constants.js";
import { logOrigin, wei } from "../db/columns.js";
import { address, parseArgs, uint } from "../engine/args.js";
import type { ContractModule } from "../engine/module.js";

export const feeTransfers = pgTable(
  "fee_transfers",
  {
    ...logOrigin(),
    /** Who paid. */
    from: text("from_address").notNull(),
    /** Always the fee payee; kept so a row can be checked on its own. */
    to: text("to_address").notNull(),
    /** IMD in wei (18 decimals). */
    value: wei("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("fee_transfers_block_idx").on(t.blockNumber, t.logIndex),
    index("fee_transfers_time_idx").on(t.blockTime),
    index("fee_transfers_from_idx").on(t.from),
  ],
);

export const erc20TransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const Transfer = z.object({ from: address, to: address, value: uint });

const PAYEE = FEE_PAYEE.toLowerCase();

export const feeTransfersModule: ContractModule = {
  name: "fee_transfers",
  title: "IMD Transfer to the fee payee (Robot Jobs Report)",
  abi: erc20TransferAbi,
  filter: () => ({
    address: IMD,
    topics: [TOPIC.Transfer, null, pad(FEE_PAYEE, { size: 32 }).toLowerCase() as `0x${string}`],
  }),
  tables: [feeTransfers],
  async apply(db, event) {
    if (event.event !== "Transfer") return;
    const args = parseArgs(Transfer, event);
    // The node was asked for transfers to the payee only. A node is not trusted to have filtered
    // correctly: a transfer to anyone else would inflate the report, so it is dropped here.
    if (args.to !== PAYEE) return;
    const row = {
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      blockTime: event.blockTime,
      from: args.from,
      to: args.to,
      value: args.value,
    };
    await db
      .insert(feeTransfers)
      .values(row)
      .onConflictDoUpdate({ target: [feeTransfers.txHash, feeTransfers.logIndex], set: row });
  },
};
