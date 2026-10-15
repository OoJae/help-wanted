/**
 * The human-readable source of the ABIs of contracts that are not ours.
 *
 * `pnpm --filter @help-wanted/shared abis` turns these signatures into the `as const` files directly
 * under `src/abi`, and a test fails when the two drift apart. They are IdentityMD's contracts and
 * the token standards: there is no build output of ours to take them from, so they are written
 * here, from the verified sources under REF/protocol (Sourcify) and the interface files in
 * `launches/<project>/src/interfaces/external`.
 *
 * HELP WANTED's own contracts are not listed here. Their ABIs come from the compiler's output:
 * see `abi-build.ts` and `pnpm --filter @help-wanted/shared abi:gen`.
 */

const ERC20 = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
] as const;

const ERC721 = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
] as const;

/** ERC-4626 with the two extras of sIMD (a Solady vault) that our contracts and pages rely on. */
const ERC4626 = [
  ...ERC20,
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256 assets)",
  "function convertToShares(uint256 assets) view returns (uint256 shares)",
  "function convertToAssets(uint256 shares) view returns (uint256 assets)",
  "function maxDeposit(address to) view returns (uint256)",
  "function maxMint(address to) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewMint(uint256 shares) view returns (uint256 assets)",
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function deposit(uint256 assets, address to) returns (uint256 shares)",
  "function mint(uint256 shares, address to) returns (uint256 assets)",
  "function withdraw(uint256 assets, address to, address owner) returns (uint256 shares)",
  "function redeem(uint256 shares, address to, address owner) returns (uint256 assets)",
  "event Deposit(address indexed by, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed by, address indexed to, address indexed owner, uint256 assets, uint256 shares)",
  // sIMD only: the block of a holder's last mint or deposit, which blocks a redeem in that block.
  "function lastDepositBlock(address holder) view returns (uint256)",
  "error SameBlockRedeem()",
] as const;

const INTAKE = [
  "struct Callback { address target; bytes4 selector; }",
  "function request(bytes32 action, bytes body, Callback callback, address asset, uint256 amount) payable returns (bytes32 requestId)",
  // Version 2 only: the same request, naming a function to call when it is refused or fails.
  "function requestWithFailure(bytes32 action, bytes body, Callback callback, bytes4 onFailure, address asset, uint256 amount) payable returns (bytes32 requestId)",
  "function failureSelectorOf(bytes32 requestId) view returns (bytes4 selector)",
  "function priceOf(bytes32 action, address asset) view returns (uint256 amount)",
  "function callbackGas() view returns (uint64)",
  "function requests(bytes32 requestId) view returns (address payer, address callbackTarget, bytes4 callbackSelector, bool completed)",
  "function nonce() view returns (uint256)",
  "function payTo() view returns (address)",
  "function writer() view returns (address)",
  "function signer() view returns (address)",
  "function MAX_BODY_BYTES() view returns (uint256)",
  "function complete(bytes32 requestId, uint8 status, bytes32 resultHash, string uri, bytes args)",
  "event Requested(bytes32 indexed requestId, address indexed payer, bytes32 indexed action, bytes body, address callbackTarget, bytes4 callbackSelector, address asset, uint256 amount)",
  "event Completed(bytes32 indexed requestId, uint8 status, bytes32 resultHash, string uri, bool delivered)",
  "event FailureHookSet(bytes32 indexed requestId, bytes4 selector)",
  "error ActionNotSold(bytes32 action, address asset)",
  "error PriceNotMet(uint256 price, uint256 amount)",
  "error BodyTooLong(uint256 length)",
  "error EmptyBody()",
  "error AlreadyCompleted(bytes32 requestId)",
  "error UnknownRequest(bytes32 requestId)",
  "error NotWriter()",
  "error WrongValue(uint256 expected, uint256 sent)",
  "error ForwardFailed()",
  "error ZeroAddress()",
  "error CallbackGasShort(uint256 needed, uint256 left)",
  "error FailureHookWithoutTarget()",
  "error FailureArgsMismatch(bytes32 requestId, uint8 status)",
] as const;

const WORK_REGISTRY = [
  "function latest(bytes16 jobId) view returns (bytes32 documentHash)",
  "event WorkRecorded(bytes16 indexed jobId, bytes32 indexed documentHash, bytes32 previousHash, string uri)",
] as const;

const SEAT_ADAPTER = [
  "struct Binding { uint8 standard; address tokenContract; uint256 tokenId; }",
  "function bindingOf(uint256 agentId) view returns (Binding)",
  "error UnknownAgent(uint256 agentId)",
] as const;

export interface AbiSource {
  /** File name under `src/abi`, and the exported constant is `<name>Abi`. */
  name: string;
  comment: string;
  signatures: readonly string[];
}

export const ABI_SOURCES: readonly AbiSource[] = [
  { name: "erc20", comment: "ERC-20, as IMD implements it (no permit, no hooks).", signatures: ERC20 },
  { name: "erc721", comment: "The ERC-721 reads the seat pages and payouts need.", signatures: ERC721 },
  {
    name: "erc4626",
    comment: "ERC-4626, as sIMD implements it, with its same-block redeem hold.",
    signatures: ERC4626,
  },
  {
    name: "intake",
    comment:
      "The IdentityMD Intake as a consumer sees it: version 2 (verified source). Version 1 has all of it except `requestWithFailure`, `failureSelectorOf` and `FailureHookSet`.",
    signatures: INTAKE,
  },
  {
    name: "workRegistry",
    comment: "The IdentityMD WorkRegistry: `latest(bytes16)` and its receipt event.",
    signatures: WORK_REGISTRY,
  },
  {
    name: "seatAdapter",
    comment: "The agent-to-seat Adapter: `bindingOf(agentId)`.",
    signatures: SEAT_ADAPTER,
  },
];
