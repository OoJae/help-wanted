/**
 * What an amount of ETH buys through launch C's Zap right now, without a wallet and without sending
 * anything: an `eth_call` of `Zap.buy(1, deadline)` carrying the ETH, from an address given a
 * balance for the length of the call (a state override), so the quote does not depend on who asks
 * or on what they hold. The server makes it for the amount a form starts with; the browser makes
 * it again whenever the visitor changes the amount.
 *
 * Zap swaps on the one Uniswap v4 ETH/IMD pool and reverts `TooLittleOut(imdOut, minImdOut)` when the
 * swap gives less than the caller's minimum. A form fills its minimum with 99% of the quote, and
 * asks the visitor to tick "accept any price" before it sends a minimum below 95% of it.
 */
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { zapAbi } from "@help-wanted/shared";
import { formatUnits } from "./format";

/** The amount of ETH a form starts with, and the one the server quotes. */
export const QUOTE_ETH = 10n ** 16n;
export const QUOTE_ETH_TEXT = "0.01";

/** Who the simulated swap is sent from: an address nobody holds a key to, given ETH for the call. */
export const QUOTE_FROM = "0x00000000000000000000000000000000000fee00";
/** The balance the state override gives that address: 1,000 ETH, far more than any form asks. */
const QUOTE_BALANCE = `0x${(1000n * 10n ** 18n).toString(16)}`;

/** The minimum a form fills in: 99% of the quote. */
export const PREFILL_BPS = 9_900n;
/** Below this share of the quote, a form asks the visitor to tick "accept any price". */
export const ACCEPT_FLOOR_BPS = 9_500n;

/** The `eth_call` that quotes `ethWei`: Zap.buy(1, a deadline ten minutes ahead), with the ETH attached. */
export function zapQuoteRequest(
  zap: string,
  ethWei: bigint,
  nowSeconds: number,
): { to: string; from: string; value: bigint; data: Hex; overrides: Record<string, { balance: string }> } {
  return {
    to: zap,
    from: QUOTE_FROM,
    value: ethWei,
    data: encodeFunctionData({ abi: zapAbi, functionName: "buy", args: [1n, BigInt(nowSeconds + 600)] }),
    overrides: { [QUOTE_FROM]: { balance: QUOTE_BALANCE } },
  };
}

/** The IMD the simulated swap returned, in IMD-wei. */
export function decodeZapQuote(result: Hex): bigint {
  return decodeFunctionResult({ abi: zapAbi, functionName: "buy", data: result }) as bigint;
}

/** `share` of `amount` in basis points, rounded down. */
export function shareOf(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / 10_000n;
}

/**
 * An amount as a person types it: a point, no grouping, rounded down to `decimals` places (more for
 * an amount that would otherwise read zero). Rounding down keeps a minimum on the safe side.
 */
export function plainDown(wei: bigint, decimals = 4): string {
  const exact = formatUnits(wei, 18);
  const [whole = "0", fraction = ""] = exact.split(".");
  let places = decimals;
  while (places < 18 && whole === "0" && /^0*$/.test(fraction.slice(0, places)) && wei > 0n) places += 1;
  const cut = fraction.slice(0, places).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
}

/** What the server read for a page: the ETH quoted, the IMD it buys, and when. */
export interface ZapQuote {
  ethWei: bigint;
  imdWei: bigint;
  readAt: string;
}

/**
 * The values a Zap form starts with: the amount of ETH, its quote, and a minimum of 99% of the
 * quote. With no quote, only the amount; the form then asks the visitor to run the quote command.
 */
export function zapPreset(quote: ZapQuote | null): Record<string, string> {
  if (!quote) return { eth: QUOTE_ETH_TEXT };
  return {
    eth: plainDown(quote.ethWei, 18),
    quoteEth: plainDown(quote.ethWei, 18),
    quoteImd: plainDown(quote.imdWei, 18),
    quoteAt: quote.readAt,
    minImdOut: plainDown(shareOf(quote.imdWei, PREFILL_BPS)),
  };
}

/**
 * About how much ETH `imdWei` costs at the quote, as text with a few significant figures. Linear in
 * the quote, so it is a floor for amounts much larger than the one quoted: a larger swap moves the
 * pool's price against the buyer.
 */
export function ethFor(imdWei: bigint, quote: ZapQuote | null): string | null {
  if (!quote || quote.imdWei === 0n) return null;
  const wei = (imdWei * quote.ethWei) / quote.imdWei;
  return plainDown(wei, 4);
}
