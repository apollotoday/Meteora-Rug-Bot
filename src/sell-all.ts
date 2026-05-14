import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { tryLoadLaunchState } from "./lib/launch-state-file";
import type { DistributionWallet } from "./lib/types";
import { getEnvOrDefault } from "./lib/utils";
import {
  runSellAllTokenAFromWallets,
  sellAllDefaults,
  type SellAllTokenAOptions,
} from "./lib/sellAllDistributionWalletsCore";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";
const DEFAULT_DISTRIBUTION_KEYSTORE_PATH = "data/distribution-wallets.keystore.json";

function intEnv(primary: string, legacy: string, defaultVal: number): number {
  const p = process.env[primary]?.trim();
  if (p !== undefined && p !== "") {
    const n = Number(p);
    return Number.isFinite(n) ? Math.max(0, n) : defaultVal;
  }
  const l = process.env[legacy]?.trim();
  if (l !== undefined && l !== "") {
    const n = Number(l);
    return Number.isFinite(n) ? Math.max(0, n) : defaultVal;
  }
  return defaultVal;
}

function intEnvMin(primary: string, legacy: string, defaultVal: number, min: number): number {
  const n = intEnv(primary, legacy, defaultVal);
  return Math.max(min, n);
}

async function getPoolAddress(): Promise<string> {
  const poolOverride = process.env.POOL_ADDRESS?.trim() || process.env.TARGET_POOL_ADDRESS?.trim();
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", DEFAULT_POOL_OUTPUT_PATH);

  if (poolOverride) return poolOverride;
  const state = await tryLoadLaunchState(statePath);
  if (state?.poolAddress) return state.poolAddress;
  const raw = await readFile(resolve(poolPath), "utf8");
  const pool = JSON.parse(raw) as { poolAddress?: string };
  if (pool?.poolAddress) return pool.poolAddress;
  throw new Error("Pool address not found; set POOL_ADDRESS or ensure pool output / launch state exists.");
}

async function loadDistributionWallets(): Promise<DistributionWallet[]> {
  const launchPath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const keystorePath = getEnvOrDefault(
    "DISTRIBUTION_WALLETS_KEYSTORE_PATH",
    DEFAULT_DISTRIBUTION_KEYSTORE_PATH
  );
  const state = await tryLoadLaunchState(launchPath);
  if (state?.distributionWallets?.length) return state.distributionWallets;
  const raw = await readFile(resolve(keystorePath), "utf8");
  const parsed = JSON.parse(raw) as {
    wallets?: { publicKey: string; secretKeyBase58: string }[];
  };
  const rows = parsed.wallets ?? [];
  return rows.map((w) => ({
    publicKey: w.publicKey,
    secretKeyBase58: w.secretKeyBase58,
    amountRaw: "0",
  }));
}

function optionsFromEnv(): SellAllTokenAOptions {
  const baseSlippageBps = Number(getEnvOrDefault("SLIPPAGE_BPS", String(sellAllDefaults.baseSlippageBps)));
  const maxRetries = intEnv("SELL_ALL_RETRY_MAX", "SELL_RETRY_MAX", sellAllDefaults.maxRetries);
  const slippageStepBps = intEnvMin(
    "SELL_ALL_RETRY_STEP_BPS",
    "SELL_RETRY_STEP_BPS",
    sellAllDefaults.slippageStepBps,
    25
  );
  const concurrency = Math.max(
    1,
    Number(getEnvOrDefault("SELL_ALL_CONCURRENCY", String(sellAllDefaults.concurrency)))
  );
  const staggerMs = Math.max(
    0,
    Number(process.env.SELL_ALL_STAGGER_MS?.trim() || String(sellAllDefaults.staggerMs))
  );
  return {
    baseSlippageBps,
    maxRetries,
    slippageStepBps,
    concurrency,
    staggerMs,
  };
}

export async function runSellAll(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const connection = new Connection(rpc, "confirmed");
  const poolAddress = await getPoolAddress();
  const wallets = await loadDistributionWallets();

  if (wallets.length === 0) {
    throw new Error("No distribution wallets found to sell from.");
  }

  await runSellAllTokenAFromWallets({
    connection,
    poolAddress,
    wallets,
    options: optionsFromEnv(),
    log: (line) => console.log(line),
  });
}

async function main(): Promise<void> {
  await runSellAll();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
