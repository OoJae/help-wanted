/**
 * The whole of HELP WANTED on a local node: the real contracts of launches A, B and C, deployed
 * from each launch project's own build output in launch order, on the stand-ins for everything
 * they depend on.
 *
 * Two stand-ins sit at mainnet addresses, because the runner reads them there and nowhere else:
 * the token at IMD's address and the registry at the WorkRegistry's. Their code is placed with the
 * local node's `anvil_setCode`. Nothing here touches a real network.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAddress, keccak256, stringToHex, type Abi, type Address, type Hex } from "viem";
import {
  MAINNET,
  crowdPotsAbi,
  doorbellAbi,
  endowmentsAbi,
  rulesAbi,
  workOrdersAbi,
  workProofAbi,
  zapAbi,
} from "@help-wanted/shared";
import {
  IMD,
  REPO,
  WHO,
  artifact,
  deploy,
  deployWorld,
  send,
  standIn,
  testAccount,
  type Node,
  type TestAccount,
  type World,
} from "./harness.js";

const out = (project: string, name: string) =>
  join(REPO, "launches", project, "out", `${name}.sol`, `${name}.json`);
const LAUNCH_B = ["WorkProof", "WorkOrders", "CrowdPots", "Doorbell"] as const;
const LAUNCH_C = ["Rules", "Endowments", "Zap"] as const;

/** Why the joint integration test cannot run here, or null when it can. */
export function cannotRunAll(): string | null {
  for (const tool of ["anvil", "forge"]) {
    try {
      execFileSync(tool, ["--version"], { stdio: "ignore" });
    } catch {
      return `${tool} is not installed: the integration test needs Foundry (anvil and forge) on the PATH`;
    }
  }
  const wanted: [string, readonly string[]][] = [
    ["a-payroll", ["Questions", "JobsReport", "Payroll"]],
    ["b-desk", LAUNCH_B],
    ["c-company", LAUNCH_C],
  ];
  for (const [project, names] of wanted) {
    for (const name of names) {
      if (!existsSync(out(project, name))) {
        return `launches/${project}/out/${name}.sol/${name}.json is absent: run \`forge build\` in launches/${project}`;
      }
    }
  }
  return null;
}

/** More people on the local node, beside the ones the launch A test already has. */
export const CAST = {
  runner: testAccount(7),
  employer: testAccount(8),
  alice: testAccount(9),
  bob: testAccount(10),
  /** A runner that misreports: it claims deliveries that are not true. */
  rogue: testAccount(11),
  creator: testAccount(12),
  depositor: testAccount(13),
};

export interface Company extends World {
  registry: Address;
  workProof: Address;
  workOrders: Address;
  crowdPots: Address;
  doorbell: Address;
  rules: Address;
  endowments: Address;
  zap: Address;
  gauge: Address;
  /** The Doorbell's constructor arguments, as deployed. */
  bell: {
    kindHash: Hex;
    minPay: bigint;
    maxPay: bigint;
    bond: bigint;
    deliverySecs: bigint;
    allowClaimed: boolean;
  };
}

export { IMD };

export const ABIS = {
  workProof: workProofAbi as unknown as Abi,
  workOrders: workOrdersAbi as unknown as Abi,
  crowdPots: crowdPotsAbi as unknown as Abi,
  doorbell: doorbellAbi as unknown as Abi,
  rules: rulesAbi as unknown as Abi,
  endowments: endowmentsAbi as unknown as Abi,
  zap: zapAbi as unknown as Abi,
  // The stand-ins are compiled by the test itself (`buildStandIns`), so their ABIs are read when
  // first used, not when this file is imported: a clone with nothing built must still be able to
  // import it and skip the test with its reason.
  get imd(): Abi {
    return standIn("StandInIMD", "StandInIMD").abi;
  },
  get simd(): Abi {
    return standIn("StandInSIMD", "StandInSIMD").abi;
  },
  get registry(): Abi {
    return standIn("StandInWorkRegistry", "StandInWorkRegistry").abi;
  },
  get gauge(): Abi {
    return standIn("StandInGauge", "StandInGauge").abi;
  },
};

/**
 * Deploys launch A (as the launch A test does, with the token at IMD's mainnet address), then
 * launch B, then launch C, each contract in its manifest's order with its manifest's arguments.
 * The only arguments that differ from the manifests are the addresses of stand-ins.
 */
export async function deployCompany(node: Node): Promise<Company> {
  // People beyond the ten the node funds by itself need ETH for gas.
  for (const who of Object.values(CAST)) await node.setBalance(who.address, 100n * 10n ** 18n);

  const a = await deployWorld(node, { imdAt: getAddress(MAINNET.IMD) });

  // The registry at its mainnet address; the test's writer account is its writer.
  const registryAt = await deploy(node, standIn("StandInWorkRegistry", "StandInWorkRegistry"));
  const registryCode = await node.public.getCode({ address: registryAt });
  if (!registryCode) throw new Error("the stand-in registry has no code");
  const registry = getAddress(MAINNET.WORK_REGISTRY);
  await node.setCode(registry, registryCode);
  await send(node, WHO.deployer, registry, ABIS.registry, "setWriter", [WHO.writer.address]);

  // Launch B, in manifest order: WorkProof, WorkOrders, CrowdPots, Doorbell.
  const artifactB = (name: string) => artifact(out("b-desk", name));
  const workProof = await deploy(node, artifactB("WorkProof"), [registry]);
  const workOrders = await deploy(node, artifactB("WorkOrders"), [a.imd, workProof, a.payroll]);
  const crowdPots = await deploy(node, artifactB("CrowdPots"), [a.imd, workOrders]);
  // The Doorbell's manifest values: a picture, 1 to 3 IMD, the minimum bond, seven days, claims on.
  const bell = {
    kindHash: keccak256(stringToHex("skill:create-image")),
    minPay: IMD("1"),
    maxPay: IMD("3"),
    bond: IMD("0.25"),
    deliverySecs: 604_800n,
    allowClaimed: true,
  };
  const doorbell = await deploy(node, artifactB("Doorbell"), [
    a.imd,
    workOrders,
    bell.kindHash,
    bell.minPay,
    bell.maxPay,
    bell.bond,
    bell.deliverySecs,
    bell.allowClaimed,
  ]);

  // Launch C, in manifest order: Rules, Endowments, Zap. Zap's pool manager is the mainnet
  // address, which holds no code here: nothing in these tests swaps.
  const artifactC = (name: string) => artifact(out("c-company", name));
  const rules = await deploy(node, artifactC("Rules"), [a.imd, workOrders]);
  const endowments = await deploy(node, artifactC("Endowments"), [a.imd, a.simd, a.questions, crowdPots]);
  const zap = await deploy(node, artifactC("Zap"), [a.imd, MAINNET.POOL_MANAGER, crowdPots, a.questions]);
  const gauge = await deploy(node, standIn("StandInGauge", "StandInGauge"));

  return {
    ...a,
    registry,
    workProof: getAddress(workProof),
    workOrders: getAddress(workOrders),
    crowdPots: getAddress(crowdPots),
    doorbell: getAddress(doorbell),
    rules: getAddress(rules),
    endowments: getAddress(endowments),
    zap: getAddress(zap),
    gauge: getAddress(gauge),
    bell,
  };
}

/** Mints stand-in IMD to somebody. */
export async function mint(node: Node, company: Company, to: Address, amount: bigint): Promise<void> {
  await send(node, WHO.deployer, company.imd, ABIS.imd, "mint", [to, amount]);
}

export async function imdOf(node: Node, company: Company, who: Address): Promise<bigint> {
  return (await node.public.readContract({
    address: company.imd,
    abi: ABIS.imd,
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

/** Approves a spender for IMD from one of the test accounts. */
export async function approve(
  node: Node,
  company: Company,
  who: TestAccount,
  spender: Address,
  amount: bigint,
): Promise<void> {
  await send(node, who, company.imd, ABIS.imd, "approve", [spender, amount]);
}
