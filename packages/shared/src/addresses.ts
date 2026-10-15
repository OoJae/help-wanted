/**
 * Ethereum mainnet addresses and chain constants HELP WANTED reads or pays.
 *
 * The contract side of this list is `src/interfaces/external/Mainnet.sol` in the three launch
 * projects. Each project keeps only the constants its own tests use, so no one copy holds them
 * all: a test reads every copy, requires each constant here to be declared in at least one of
 * them with this value, and fails when two copies disagree. Addresses are EIP-55 checksummed here
 * and lowercase in everything the IdentityMD API returns, so compare with `sameAddress`, never `===`.
 */
import { getAddress, isAddressEqual, type Address, type Hex } from "viem";

export const CHAIN_ID = 1 as const;
/** The x402 name for the same chain, as quotes and challenges spell it. */
export const CAIP2_NETWORK = "eip155:1" as const;

/** Mirrors `library Mainnet` constant for constant (the union of the three projects' copies). */
export const MAINNET = {
  IMD: "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7",
  SIMD: "0x9Efa934D9fAd4AE28c998a40195646b965a97247",
  SEATS: "0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D",
  SEAT_COUNT: 2000,

  /**
   * The IdentityMD Intake, version 2: the address IdentityMD names for anything new, the same on
   * Ethereum, Robinhood Chain and Sepolia, and the one launch A's `Questions` is built on.
   */
  INTAKE: "0xa43e6F75ee006411F79Ac1C84120606C2330DE82",
  /**
   * The Intake, version 1: legacy, still served. It has the same `request`, `requests(id)`,
   * `priceOf`, `callbackGas` and events as version 2. Nothing of ours is launched against it; the
   * three house feed bodies were proven through it before version 2 was adopted.
   */
  INTAKE_V1: "0x1397434cd35e8a9C8aC312A61D3A285EB31dea56",
  INTAKE_WRITER: "0x3d3C0Df7C1a17d384545e9D7C8228897bD9625CB",
  INTAKE_DELIVERY: "0xCE0E6a670AA75E161d02aca3C7F00B94cA428CCb",
  ORACLE_SIGNER: "0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982",
  /** `bytes32("oracle.request@oracle-1")`: the UTF-8 bytes right-padded with zeros, not a hash. */
  ORACLE_ACTION: "0x6f7261636c652e72657175657374406f7261636c652d31000000000000000000",
  /** Where every paid action's fee lands. */
  FEE_PAYEE: "0x4e0fA57Bde726079356537E2F34d671E9F41ADbc",

  WORK_REGISTRY: "0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775",
  WORK_REGISTRY_WRITER: "0x5dA3054201BC7E241875Ac68173e49C269F76D44",
  SEAT_ADAPTER: "0xde152AfB7db5373F34876E1499fbD893A82dD336",
  IDENTITY_REGISTRY: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  REPUTATION_REGISTRY: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",

  PROJECT_FACTORY: "0xfF03410d0Fe5fa8f7F59F743de35E333D9857120",
  LAUNCH_DEPLOYER: "0xcECc29B037f5064fCdF45a5C318F132ef76aA551",
  /**
   * HELP WANTED's own `Payroll`, created by launch A. It is here because launch B's `Mainnet.sol`
   * declares it (the desk takes it as a constructor argument); `DEPLOYMENT_BOOK` is where code
   * should read it from, and a test keeps the two the same.
   */
  PAYROLL: "0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F",
  /**
   * Three more of HELP WANTED's own contracts, here because launch C's `Mainnet.sol` declares them
   * (Rules, Endowments and Zap take them as constructor arguments). `DEPLOYMENT_BOOK` is where code
   * should read them from, and a test keeps the two the same.
   */
  QUESTIONS: "0xEECE4628ceb091C13393fc64056Be8b8501fD3F6",
  WORK_ORDERS: "0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2",
  CROWD_POTS: "0x8C2FfCdcb103659aa05c772b8F2059868B496EB5",

  POOL_MANAGER: "0x000000000004444c5dc75cB358380D2e3dE08A90",
  UNIVERSAL_ROUTER: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
  V4_QUOTER: "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203",
  STATE_VIEW: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const satisfies Record<string, Address | Hex | number>;

/**
 * Off-chain constants that have no place in `Mainnet.sol` because no contract of ours touches them.
 */
export const OFFCHAIN = {
  /**
   * The Permit2 spender an x402 "exact" payment names. It is `x402ExactPermit2ProxyAddress` in
   * `@x402/evm@2.28.0`; a runner test pins the two together.
   */
  X402_EXACT_PERMIT2_PROXY: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
  /** Signs the off-chain quotes `Intake.pay` checks. Not the oracle attester. */
  QUOTE_SIGNER: "0x169B08ea234d7819EeAbb246E34d8Cd81E32279F",
  /** `GET /health` names it as the wallet that pays gas for x402 settlements; equal to FEE_PAYEE. */
  X402_GAS_WALLET: "0x4e0fA57Bde726079356537E2F34d671E9F41ADbc",
} as const satisfies Record<string, Address>;

/**
 * Every Intake a reader may meet in a log or in an IdentityMD API answer, the current one first.
 * `GET /intake/:chainId/:tx` names, per entry, which of them logged the event.
 */
export const INTAKES: readonly Address[] = [MAINNET.INTAKE, MAINNET.INTAKE_V1];

/** True for version 2 or the legacy version 1, in any letter case. */
export function isIntake(address: string | null | undefined): boolean {
  return INTAKES.some((intake) => sameAddress(intake, address));
}

/** IMD has 18 decimals; sIMD shares have 24. */
export const IMD_DECIMALS = 18 as const;
export const SIMD_DECIMALS = 24 as const;

/** What every paid action costs today: 0.5 IMD, in atomic units. Read the live price before paying. */
export const PAID_ACTION_PRICE = 500_000_000_000_000_000n;

/** `WorkRegistry.latest(bytes16)`. */
export const WORK_REGISTRY_LATEST_SELECTOR = "0xebe9712c" as const;
/** topic0 of `WorkRecorded(bytes16 indexed jobId, bytes32 indexed documentHash, bytes32 previousHash, string uri)`. */
export const WORK_RECORDED_TOPIC =
  "0xc3e4ffeab3a1fc840bb179d634166017188a59d5df2db3c5f563052a5f6f2f86" as const;

export const IMD_API_BASE = "https://api.imd.fun" as const;
export const IMD_EXPLORER_BASE = "https://explorer.imd.fun" as const;

/** Case-insensitive address comparison; false for anything that is not an address. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return isAddressEqual(getAddress(a), getAddress(b));
  } catch {
    return false;
  }
}

/** The lowercase spelling the IdentityMD API uses for addresses. */
export function lowerAddress(a: string): Address {
  return getAddress(a).toLowerCase() as Address;
}
