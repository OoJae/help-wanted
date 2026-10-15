/**
 * The few contract facts this app writes down itself, because the shared package does not carry
 * them: the names of three enums, the codes of a rule, the bounds of a pot, the split of Payroll,
 * the gas limits the launch documents say to send. Each is compared here with the Solidity source
 * or the document it comes from, when the launch projects are in the repository beside this app.
 *
 * The ABIs themselves are not tested here: they are the shared package's, generated from the launch
 * projects' build output, and tested there. What is checked is that this app's signatures, topics
 * and selectors are derived from them.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toEventSelector, toFunctionSelector, type AbiEvent } from "viem";
import { describe, expect, it } from "vitest";
import {
  CONDITION_CMP,
  crowdPotsAbi,
  DESK,
  endowmentsAbi,
  erc20Abi,
  intakeAbi,
  MAINNET,
  ORDER_STATE,
  payrollAbi,
  questionsAbi,
  rulesAbi,
  WORK_RECORDED_TOPIC,
  WORK_REGISTRY_LATEST_SELECTOR,
  workOrdersAbi,
  workRegistryAbi,
  zapAbi,
} from "@help-wanted/shared";
import { TOPIC } from "~/config/chain";
import {
  callSignatureOf,
  COMPARISONS,
  ENDOWMENT,
  ENDOWMENT_KINDS,
  GAS_LIMIT,
  inputNamesOf,
  isPayable,
  ORDER_STATES,
  PAYROLL_SPLIT,
  POT_STAGES,
  POTS,
  RULE,
  RULE_STATUSES,
  signatureOf,
} from "~/lib/contracts";
import { multicall3Abi } from "~/lib/multicall";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const source = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
const has = (path: string) => existsSync(`${ROOT}${path}`);

/** The members of a Solidity enum, in declaration order. */
function enumOf(text: string, name: string): string[] {
  const match = text.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`no enum ${name}`);
  return (match[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line !== "")
    .map((line) => line.replace(/,$/, ""));
}

/** The value of a `constant`, as Solidity writes it (`30 days`, `1e18`, `3_000`), in base units. */
function constantOf(text: string, name: string): bigint {
  const match = text.match(new RegExp(`constant ${name} = ([^;]+);`));
  if (!match) throw new Error(`no constant ${name}`);
  const raw = (match[1] ?? "").trim().replace(/_/g, "");
  const unit = raw.match(/^([\d.e]+) (hours|days)$/);
  if (unit) return BigInt(Number(unit[1])) * (unit[2] === "days" ? 86_400n : 3_600n);
  const sci = raw.match(/^([\d.]+)e(\d+)$/);
  if (sci) {
    const [whole, frac = ""] = (sci[1] ?? "").split(".");
    return BigInt(`${whole}${frac}`) * 10n ** BigInt(Number(sci[2]) - frac.length);
  }
  return BigInt(raw);
}

describe("signatures, topics and selectors come from the ABIs", () => {
  it("a signature is the ABI's own, and a read's signature carries what it returns", () => {
    expect(signatureOf(workOrdersAbi, "claim")).toBe("claim(uint256)");
    expect(signatureOf(zapAbi, "chipIn")).toBe("chipIn(uint256,uint256,uint256)");
    expect(signatureOf(zapAbi, "fundMeter")).toBe("fundMeter(bytes32,uint256,uint256)");
    expect(signatureOf(zapAbi, "buy")).toBe("buy(uint256,uint256)");
    expect(signatureOf(questionsAbi, "collectTips")).toBe("collectTips()");
    expect(signatureOf(payrollAbi, "claimSeat")).toBe("claimSeat(uint256)");
    expect(callSignatureOf(questionsAbi, "tipsOf")).toBe("tipsOf(address)(uint256,uint256)");
    expect(callSignatureOf(workRegistryAbi, "latest")).toBe("latest(bytes16)(bytes32)");
    expect(() => signatureOf(zapAbi, "noSuchFunction")).toThrow();
    // Zap's three entry points take ETH and name the minimum and the deadline.
    for (const name of ["chipIn", "fundMeter", "buy"]) {
      expect(isPayable(zapAbi, name), name).toBe(true);
      expect(inputNamesOf(zapAbi, name).slice(-2)).toEqual(["minImdOut", "deadline"]);
    }
    expect(isPayable(questionsAbi, "fund")).toBe(false);
    // A pot's terms begin with the job kind in text.
    const openPot = crowdPotsAbi.find((item) => item.type === "function" && item.name === "openPot");
    const terms =
      openPot && "inputs" in openPot
        ? (openPot.inputs[0] as unknown as { components?: { name: string; type: string }[] })
        : null;
    expect(terms?.components?.[0]).toMatchObject({ name: "kind", type: "string" });
  });

  it("the log topics this site filters by are the events' own", () => {
    const topic = (abi: readonly unknown[], name: string) =>
      toEventSelector(
        abi.find(
          (item) => (item as AbiEvent).type === "event" && (item as AbiEvent).name === name,
        ) as AbiEvent,
      );
    expect(TOPIC.TRANSFER).toBe(topic(erc20Abi, "Transfer"));
    expect(TOPIC.TRANSFER).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(TOPIC.INTAKE_REQUESTED).toBe(topic(intakeAbi, "Requested"));
    expect(TOPIC.INTAKE_REQUESTED).toBe("0x1c521a43c9b0f72a335bc80a6918abce08af7949ebbd1c41fe2a576074379063");
    expect(TOPIC.INTAKE_COMPLETED).toBe(topic(intakeAbi, "Completed"));
    expect(TOPIC.INTAKE_COMPLETED).toBe("0xd4ad2d2ef4e8ea9995103f34e322dbefb2534f3a52984a308f7db8e257b76fa1");
    expect(TOPIC.WORK_RECORDED).toBe(WORK_RECORDED_TOPIC);
    expect(TOPIC.WORK_RECORDED).toBe(topic(workRegistryAbi, "WorkRecorded"));
    expect(TOPIC.WORK_RECORDED).toBe("0xc3e4ffeab3a1fc840bb179d634166017188a59d5df2db3c5f563052a5f6f2f86");
  });

  it("the registry read and Multicall3's one function have the selectors computed with cast", () => {
    expect(WORK_REGISTRY_LATEST_SELECTOR).toBe("0xebe9712c");
    expect(toFunctionSelector(signatureOf(workRegistryAbi, "latest"))).toBe("0xebe9712c");
    expect(toFunctionSelector(signatureOf(multicall3Abi, "aggregate3"))).toBe("0x82ad56cb");
    // The oracle action id is the text right-padded with zeros, not a hash.
    const hex = [...new TextEncoder().encode("oracle.request@oracle-1")]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(MAINNET.ORACLE_ACTION).toBe(`0x${hex.padEnd(64, "0")}`);
  });

  it("order states and comparison codes are the shared package's, in code order", () => {
    expect(ORDER_STATES.map((name) => ORDER_STATE[name])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(COMPARISONS.map((c) => c.code)).toEqual([
      CONDITION_CMP.gte,
      CONDITION_CMP.lte,
      CONDITION_CMP.gt,
      CONDITION_CMP.lt,
      CONDITION_CMP.eq,
      CONDITION_CMP.neq,
    ]);
    expect(COMPARISONS.map((c) => c.symbol)).toEqual([">=", "<=", ">", "<", "==", "!="]);
  });
});

describe("what this app writes down itself, against the Solidity sources", () => {
  const pots = "launches/b-desk/src/pots/CrowdPots.sol";
  const desk = "launches/b-desk/src/desk/WorkOrders.sol";
  const deskInterface = "launches/b-desk/src/interfaces/IWorkOrders.sol";
  const rules = "launches/c-company/src/rules/Rules.sol";
  const endowments = "launches/c-company/src/endowments/Endowments.sol";
  const payroll = "launches/a-payroll/src/payroll/Payroll.sol";

  it.skipIf(!has(pots))("CrowdPots.Stage and the bounds of a pot", () => {
    const text = source(pots);
    expect([...POT_STAGES]).toEqual(enumOf(text, "Stage"));
    expect(POTS.MIN_TARGET).toBe(constantOf(text, "MIN_TARGET"));
    expect(BigInt(POTS.MIN_FUND_SECS)).toBe(constantOf(text, "MIN_FUND_SECS"));
    expect(BigInt(POTS.MAX_FUND_SECS)).toBe(constantOf(text, "MAX_FUND_SECS"));
    expect(BigInt(POTS.MIN_HIRE_SECS)).toBe(constantOf(text, "MIN_HIRE_SECS"));
    expect(BigInt(POTS.MAX_HIRE_SECS)).toBe(constantOf(text, "MAX_HIRE_SECS"));
    expect(BigInt(POTS.MAX_DELIVERY_SECS)).toBe(constantOf(text, "MAX_DELIVERY_SECS"));
    expect(BigInt(POTS.MAX_KIND_LENGTH)).toBe(constantOf(text, "MAX_KIND_LENGTH"));
  });

  it.skipIf(!has(deskInterface))("IWorkOrders.State is the shared order of states", () => {
    expect([...ORDER_STATES]).toEqual(enumOf(source(deskInterface), "State"));
  });

  it.skipIf(!has(desk))("the desk's constants the shared package mirrors are the contract's", () => {
    const text = source(desk);
    expect(DESK.MIN_BOND).toBe(constantOf(text, "MIN_BOND"));
    expect(BigInt(DESK.MIN_DELIVERY)).toBe(constantOf(text, "MIN_DELIVERY"));
    expect(BigInt(DESK.CLAIM_WINDOW)).toBe(constantOf(text, "CLAIM_WINDOW"));
    expect(BigInt(DESK.CHALLENGE_WINDOW)).toBe(constantOf(text, "CHALLENGE_WINDOW"));
    expect(BigInt(DESK.DISPUTE_WINDOW)).toBe(constantOf(text, "DISPUTE_WINDOW"));
    expect(DESK.FEE_BPS).toBe(constantOf(text, "FEE_BPS"));
    expect(DESK.TIP_BPS).toBe(constantOf(text, "TIP_BPS"));
    // The gas this site tells a runner to send covers the desk's two Payroll calls with room over.
    const payrollGas = constantOf(text, "PAYROLL_GAS");
    expect(GAS_LIMIT.SETTLE).toBeGreaterThanOrEqual(2n * payrollGas);
    expect(GAS_LIMIT.FINALIZE).toBeGreaterThanOrEqual(payrollGas);
  });

  it.skipIf(!has(rules))("Rules.Status and the codes of a rule's condition and action", () => {
    const text = source(rules);
    expect([...RULE_STATUSES]).toEqual(enumOf(text, "Status"));
    expect(BigInt(RULE.COND_VIEW)).toBe(constantOf(text, "COND_VIEW"));
    expect(BigInt(RULE.COND_FEED)).toBe(constantOf(text, "COND_FEED"));
    expect(BigInt(RULE.ACT_HIRE)).toBe(constantOf(text, "ACT_HIRE"));
    expect(BigInt(RULE.ACT_PAY)).toBe(constantOf(text, "ACT_PAY"));
    // Each is a public constant, so the launched contract can be asked too.
    for (const name of ["COND_VIEW", "COND_FEED", "ACT_HIRE", "ACT_PAY"]) {
      expect(signatureOf(rulesAbi, name)).toBe(`${name}()`);
    }
  });

  it.skipIf(!has(endowments))(
    "Endowments.Kind, the seed, the stake interval and the runway of 30 requests",
    () => {
      const text = source(endowments);
      expect([...ENDOWMENT_KINDS]).toEqual(enumOf(text, "Kind"));
      expect(ENDOWMENT.SEED).toBe(constantOf(text, "SEED"));
      expect(BigInt(ENDOWMENT.STAKE_INTERVAL_BLOCKS)).toBe(constantOf(text, "STAKE_INTERVAL"));
      expect(BigInt(ENDOWMENT.METER_RUNWAY)).toBe(constantOf(text, "METER_RUNWAY"));
      expect(ENDOWMENT.METER_RUNWAY).toBe(30);
      expect(signatureOf(endowmentsAbi, "METER_RUNWAY")).toBe("METER_RUNWAY()");
    },
  );

  it.skipIf(!has(payroll))(
    "Payroll's split: 30% to seats, 20% to the feeds, the rest to stakers over seven days",
    () => {
      const text = source(payroll);
      expect(BigInt(PAYROLL_SPLIT.seatsBps)).toBe(constantOf(text, "SEAT_BPS"));
      expect(BigInt(PAYROLL_SPLIT.feedsBps)).toBe(constantOf(text, "FEED_BPS"));
      expect(PAYROLL_SPLIT.stakersBps + PAYROLL_SPLIT.seatsBps + PAYROLL_SPLIT.feedsBps).toBe(10_000);
      expect(BigInt(PAYROLL_SPLIT.streamDays) * 86_400n).toBe(constantOf(text, "STREAM_DURATION"));
    },
  );

  const launchB = "launches/b-desk/docs/LAUNCH.md";
  const launchC = "launches/c-company/docs/LAUNCH.md";
  it.skipIf(!has(launchB) || !has(launchC))(
    "the gas limits are the ones the launch documents say to send",
    () => {
      // The documents are prose: a sentence may break across lines, so they are read with every run
      // of white space as one space.
      const b = source(launchB).replace(/\s+/g, " ");
      const c = source(launchC).replace(/\s+/g, " ");
      expect(b).toContain(`--gas-limit ${GAS_LIMIT.SETTLE}`);
      expect(b).toContain(`"finalize(uint256)" $ID --gas-limit ${GAS_LIMIT.FINALIZE}`);
      expect(b).toContain(`gas limit of ${Number(GAS_LIMIT.RING).toLocaleString("en-US")}`);
      expect(c).toContain(
        `send ${Number(GAS_LIMIT.FIRE_PAY).toLocaleString("en-US")} for a PAY rule and ${Number(GAS_LIMIT.FIRE_HIRE).toLocaleString("en-US")} for a HIRE rule`,
      );
      expect(c).toContain(`--gas-limit ${ENDOWMENT.POT_HARVEST_GAS}`);
    },
  );
});
