#!/usr/bin/env node
/**
 * hw-ring: ring the Doorbell until it hires.
 *
 *   pnpm --filter @help-wanted/keeper ring
 *
 * The keeper never rings by itself: the 25th ring opens an order that anyone may take, so ringing
 * is an operator's decision. This command reads the Doorbell and says what it would send. With
 * LIVE=1 and KEEPER_PRIVATE_KEY it sends `ring()` one transaction at a time, waits for each, and
 * stops at the ring that hires.
 *
 *   RINGS   the most rings to send (default: as many as the next hire needs)
 *
 * It refuses to send the ring that would hire while the Doorbell does not hold one order's escrow:
 * that ring would be counted and hire nothing, and the next hire would be 25 rings away again.
 */
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseEventLogs,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { doorbellAbi } from "@help-wanted/shared";
import { ConfigError, loadConfig } from "./config.js";
import { redactText } from "./log.js";

/** A plain ring used about 50,000 gas in the launch project's tests; the ring that hires, 354,333. */
const RING_GAS = 120_000n;
const HIRING_RING_GAS = 600_000n;

function say(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), msg: message, ...fields })}\n`);
}

async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const bell = config.doorbell;
  if (bell === null) {
    say("the Doorbell's address is not known: set DOORBELL or record launch B in the deployments book");
    return 2;
  }
  const transport = http(config.rpcUrl);
  const reader = createPublicClient({ chain: mainnet, transport });
  const read = <T>(
    functionName: "rings" | "hires" | "ringsUntilHire" | "funded" | "MAX_PAY" | "lastOrderId",
  ) => reader.readContract({ address: bell, abi: doorbellAbi, functionName }) as Promise<T>;

  const [rings, hires, untilHire, funded, escrow] = await Promise.all([
    read<bigint>("rings"),
    read<bigint>("hires"),
    read<bigint>("ringsUntilHire"),
    read<boolean>("funded"),
    read<bigint>("MAX_PAY"),
  ]);
  const asked = process.env.RINGS === undefined ? untilHire : BigInt(process.env.RINGS);
  if (asked < 1n || asked > 100n) {
    say("RINGS must be between 1 and 100");
    return 2;
  }
  const reachesHire = asked >= untilHire;
  say("the Doorbell", {
    doorbell: bell,
    rings: rings.toString(),
    hires: hires.toString(),
    ringsUntilHire: untilHire.toString(),
    holdsAnOrdersEscrow: funded,
    escrowImd: formatUnits(escrow, 18),
    wouldSend: asked.toString(),
    lastOfThemHires: reachesHire,
  });
  if (reachesHire && !funded) {
    say("refused: the ring that hires would find the Doorbell without an order's escrow. Send it IMD first", {
      neededImd: formatUnits(escrow, 18),
    });
    return 1;
  }
  if (config.mode !== "live" || config.privateKey === null) {
    say(`DRY RUN (${config.dryRunReason ?? "no key"}): nothing was signed and nothing was sent`);
    return 0;
  }

  const account = privateKeyToAccount(config.privateKey);
  const wallet = createWalletClient({ account, chain: mainnet, transport });
  for (let sent = 0n; sent < asked; sent += 1n) {
    const left = (await read<bigint>("ringsUntilHire")) as bigint;
    const hiring = left === 1n;
    if (hiring && !(await read<boolean>("funded"))) {
      say("stopped before the ring that hires: the Doorbell no longer holds an order's escrow");
      return 1;
    }
    const fees = await reader.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas > config.maxFeePerGas ? config.maxFeePerGas : fees.maxFeePerGas;
    if (fees.maxFeePerGas > config.maxFeePerGas) {
      say("stopped: the network asks more than MAX_FEE_GWEI allows", { asked: fees.maxFeePerGas.toString() });
      return 1;
    }
    const hash = await wallet.writeContract({
      address: bell as Address,
      abi: doorbellAbi,
      functionName: "ring",
      gas: hiring ? HIRING_RING_GAS : RING_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas:
        config.maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : config.maxPriorityFeePerGas,
    });
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 300_000 });
    if (receipt.status !== "success") {
      say("stopped: a ring reverted", { hash });
      return 1;
    }
    const hired = parseEventLogs({ abi: doorbellAbi, logs: receipt.logs, eventName: "Hired" })[0];
    say(hired ? "ring: the Doorbell hired" : "ring", {
      number: (sent + 1n).toString(),
      hash,
      block: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      ...(hired ? { orderId: hired.args.orderId.toString() } : {}),
    });
    if (hired) return 0;
  }
  say("done", { ringsUntilHire: ((await read<bigint>("ringsUntilHire")) as bigint).toString() });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const text =
      error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error);
    // Only the first line, with the key taken out should a library ever have put it there.
    process.stderr.write(`${redactText(text.split("\n")[0] ?? "", [process.env.KEEPER_PRIVATE_KEY])}\n`);
    process.exit(1);
  },
);
