/**
 * Everything the evidence builder takes from the shared package, through one door.
 *
 * The repository root has no dependencies of its own, so the files of this folder import nothing
 * by package name: the addresses, the ABIs, the deployments book, the IdentityMD client and the
 * small chain-reading helpers all come from `packages/shared` by path, and the third-party code
 * they need (viem, zod) is resolved from that package's own install.
 */
export * from "../../packages/shared/src/index.js";
