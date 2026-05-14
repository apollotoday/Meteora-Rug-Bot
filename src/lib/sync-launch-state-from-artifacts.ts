import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NATIVE_MINT } from "@solana/spl-token";
import { DEVNET_USDC_MINT, MAINNET_USDC_MINT } from "./constants";
import { saveLaunchState, tryLoadLaunchState } from "./launch-state-file";
import type { LaunchState, QuoteMintType } from "./types";
import { getEnvOrDefault, inferCluster } from "./utils";

function quoteMintFromEnv(rpcUrl: string): { quoteMintType: QuoteMintType; quoteMint: string } {
  const t = (getEnvOrDefault("QUOTE_MINT_TYPE", "WSOL").toUpperCase() || "WSOL") as QuoteMintType;
  if (t === "WSOL") {
    return { quoteMintType: "WSOL", quoteMint: NATIVE_MINT.toBase58() };
  }
  const cluster = inferCluster(rpcUrl);
  const mint = cluster === "mainnet-beta" ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;
  return { quoteMintType: "USDC", quoteMint: mint.toBase58() };
}

function phaseOrder(p: LaunchState["phase"]): number {
  const map: Record<string, number> = {
    initial: 0,
    "token-minted": 1,
    "funds-distributed": 2,
    distributed: 2,
    "pool-created": 3,
    "vault-created": 4,
    deposited: 5,
    filled: 6,
    launched: 7,
    activated: 7,
    claimed: 8,
  };
  return map[p] ?? 0;
}

function mergePhase(existing: LaunchState["phase"] | undefined, candidate: LaunchState["phase"]): LaunchState["phase"] {
  if (!existing) return candidate;
  return phaseOrder(existing) >= phaseOrder(candidate) ? existing : candidate;
}

/**
 * Merge pool + alpha-vault JSON artifacts into `latest-launch-state.json`, preserving distribution wallets.
 */
export async function syncLaunchStateFromArtifacts(params: {
  statePath: string;
  poolPath: string;
  alphaVaultPath: string;
  tokenMintPath: string;
  rpcUrl: string;
}): Promise<LaunchState> {
  const poolRaw = await readFile(resolve(params.poolPath), "utf8");
  const pool = JSON.parse(poolRaw) as {
    poolAddress?: string;
    baseMint?: string;
    quoteMint?: string;
    quoteMintType?: QuoteMintType;
    poolActivationPointTs?: string | null;
  };

  const avRaw = await readFile(resolve(params.alphaVaultPath), "utf8");
  const av = JSON.parse(avRaw) as {
    alphaVaultAddress?: string;
    depositingPoint?: string;
    startVestingPoint?: string;
    endVestingPoint?: string;
    maxDepositingCap?: string;
  };

  const tokenRaw = await readFile(resolve(params.tokenMintPath), "utf8");
  const token = JSON.parse(tokenRaw) as { tokenMint?: string };
  if (!token.tokenMint) throw new Error(`tokenMint missing in ${params.tokenMintPath}`);
  if (!pool.poolAddress || !pool.baseMint) throw new Error(`pool output missing fields in ${params.poolPath}`);
  if (!av.alphaVaultAddress) throw new Error(`alphaVaultAddress missing in ${params.alphaVaultPath}`);

  const q =
    pool.quoteMintType && pool.quoteMint
      ? { quoteMintType: pool.quoteMintType, quoteMint: pool.quoteMint }
      : quoteMintFromEnv(params.rpcUrl);

  const prev = await tryLoadLaunchState(params.statePath);
  const poolAct =
    pool.poolActivationPointTs != null && String(pool.poolActivationPointTs).trim() !== ""
      ? String(pool.poolActivationPointTs)
      : "0";

  const next: LaunchState = {
    phase: mergePhase(prev?.phase, "vault-created"),
    updatedAt: new Date().toISOString(),
    tokenMint: pool.baseMint,
    poolAddress: pool.poolAddress,
    alphaVaultAddress: av.alphaVaultAddress,
    quoteMintType: q.quoteMintType,
    quoteMint: pool.quoteMint ?? q.quoteMint,
    poolActivationPointTs: poolAct,
    depositingPoint: av.depositingPoint ?? prev?.depositingPoint ?? "0",
    startVestingPoint: av.startVestingPoint ?? prev?.startVestingPoint ?? "0",
    endVestingPoint: av.endVestingPoint ?? prev?.endVestingPoint ?? "0",
    maxDepositingCap: av.maxDepositingCap ?? prev?.maxDepositingCap ?? "0",
    distributionExpectedCount: prev?.distributionExpectedCount,
    distributionWallets: prev?.distributionWallets ?? [],
    totalDistributedRaw: prev?.totalDistributedRaw ?? "0",
    depositsByWallet: prev?.depositsByWallet ?? {},
    fillTxSignature: prev?.fillTxSignature ?? null,
    claimsByWallet: prev?.claimsByWallet ?? {},
    tokenMintOutputPath: resolve(params.tokenMintPath),
    poolOutputPath: resolve(params.poolPath),
    alphaVaultOutputPath: resolve(params.alphaVaultPath),
  };

  await saveLaunchState(params.statePath, next);
  return next;
}
