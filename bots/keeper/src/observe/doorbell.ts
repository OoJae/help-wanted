/** Reads the Doorbell for the status file, at one block. Sends nothing. */
import type { Abi, Address, Hex } from "viem";
import { doorbellAbi, erc20Abi, orderStateName, workOrdersAbi } from "@help-wanted/shared";
import type { DoorbellSnapshot } from "../modules/doorbell.js";
import { readAt, readOnce, type ObserveContext } from "./common.js";
import { big, num } from "./questions.js";

const DOORBELL_ABI = doorbellAbi as unknown as Abi;
const ERC20_ABI = erc20Abi as unknown as Abi;
const DESK_ABI = workOrdersAbi as unknown as Abi;

export async function observeDoorbell(
  ctx: ObserveContext,
  targets: { doorbell: Address },
): Promise<DoorbellSnapshot> {
  const { doorbell } = targets;
  const once = <T>(name: string) => readOnce<T>(ctx, doorbell, DOORBELL_ABI, name);
  const [imd, workOrders, maxPay, minPay, bond, deliverySecs, kindHash, allowClaimed] = await Promise.all([
    once<Address>("IMD"),
    once<Address>("WORK_ORDERS"),
    once<unknown>("MAX_PAY"),
    once<unknown>("MIN_PAY"),
    once<unknown>("BOND"),
    once<unknown>("DELIVERY_SECS"),
    once<Hex>("KIND_HASH"),
    once<boolean>("ALLOW_CLAIMED"),
  ]);
  const [rings, hires, receipts, ringsUntilHire, funded, lastOrderId, balance] = await Promise.all([
    readAt(ctx, doorbell, DOORBELL_ABI, "rings"),
    readAt(ctx, doorbell, DOORBELL_ABI, "hires"),
    readAt(ctx, doorbell, DOORBELL_ABI, "receipts"),
    readAt(ctx, doorbell, DOORBELL_ABI, "ringsUntilHire"),
    readAt(ctx, doorbell, DOORBELL_ABI, "funded"),
    readAt(ctx, doorbell, DOORBELL_ABI, "lastOrderId"),
    readAt(ctx, imd, ERC20_ABI, "balanceOf", [doorbell]),
  ]);
  let lastOrderState: string | null = null;
  if (big(hires) > 0n) {
    lastOrderState = orderStateName(
      num(await readAt(ctx, workOrders, DESK_ABI, "stateOf", [big(lastOrderId)])),
    );
  }
  return {
    doorbell,
    workOrders,
    rings: big(rings),
    hires: big(hires),
    receipts: big(receipts),
    ringsUntilHire: big(ringsUntilHire),
    funded: funded === true,
    balance: big(balance),
    maxPay: big(maxPay),
    minPay: big(minPay),
    bond: big(bond),
    deliverySecs: big(deliverySecs),
    kindHash,
    allowClaimed,
    lastOrderId: big(lastOrderId),
    lastOrderState,
  };
}
