import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clusterApiUrl } from "@solana/web3.js";
import { runAlphaVaultFcfs } from "./alpha-vault-fcfs";
import { runClaimTokens } from "./claim-tokens";
import { runDammV2Launch } from "./damm-v2-launch";
import { runDepositToVault } from "./deposit-to-vault";
import { runDistributeFromMain } from "./distribute-from-main";
import { loadLaunchState } from "./lib/launch-state-file";
import { syncLaunchStateFromArtifacts } from "./lib/sync-launch-state-from-artifacts";
import { getEnvOrDefault, parseBool, sleep } from "./lib/utils";
import { runTokenMint } from "./token_mint";

const DEFAULT_TOKEN_MINT_OUTPUT_PATH = "data/latest-token-mint.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";
const DEFAULT_ALPHA_VAULT_OUTPUT_PATH = "data/latest-alpha-vault.json";
const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";

function isMainModule(): boolean {
  try {
    return require.main === module;
  } catch {
    return true;
  }
}

/**
 * Full bundler flow: mint → distribute to N wallets → DAMM v2 + Alpha Vault → sync state →
 * wait for deposit window → deposit from each wallet → wait for vesting → claim.
 */
export async function runStartPipeline(): Promise<void> {
  const rpcUrl = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const tokenMintPath = getEnvOrDefault("TOKEN_MINT_OUTPUT_PATH", DEFAULT_TOKEN_MINT_OUTPUT_PATH);
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", DEFAULT_POOL_OUTPUT_PATH);
  const alphaPath = getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", DEFAULT_ALPHA_VAULT_OUTPUT_PATH);
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);

  const skipMint = parseBool(process.env.START_SKIP_MINT, false);
  if (!skipMint) {
    console.log("[start] Minting token…");
    await runTokenMint();
  } else {
    console.log("[start] START_SKIP_MINT=true — skipping mint.");
    try {
      await readFile(resolve(tokenMintPath), "utf8");
    } catch {
      throw new Error(`START_SKIP_MINT but ${tokenMintPath} is missing or unreadable.`);
    }
  }

  console.log("[start] Distributing SOL/tokens to distribution wallets…");
  await runDistributeFromMain();

  console.log("[start] Creating DAMM v2 pool (custom pool + Alpha Vault flag)…");
  await runDammV2Launch();

  console.log("[start] Creating FCFS Alpha Vault…");
  await runAlphaVaultFcfs();

  console.log("[start] Syncing launch state from pool + alpha vault artifacts…");
  await syncLaunchStateFromArtifacts({
    statePath,
    poolPath,
    alphaVaultPath: alphaPath,
    tokenMintPath,
    rpcUrl,
  });

  const pollSec = Math.max(5, Number(getEnvOrDefault("ORCHESTRATOR_POLL_SEC", "15")));
  const maxWaitSec = Number(getEnvOrDefault("ORCHESTRATOR_MAX_WAIT_SEC", String(6 * 3600)));
  const deadline = maxWaitSec <= 0 ? Number.POSITIVE_INFINITY : Date.now() + maxWaitSec * 1000;

  let state = await loadLaunchState(statePath);
  let depositingPoint = Number(state.depositingPoint);
  let startVesting = Number(state.startVestingPoint);

  if (!Number.isFinite(depositingPoint) || depositingPoint <= 0) {
    console.warn("[start] depositingPoint missing or invalid; deposit step may skip immediately.");
  } else {
    while (Math.floor(Date.now() / 1000) < depositingPoint) {
      if (Date.now() > deadline) {
        throw new Error("ORCHESTRATOR_MAX_WAIT_SEC exceeded while waiting for deposit window.");
      }
      console.log(
        `[start] Waiting for deposit window (opens ${new Date(depositingPoint * 1000).toISOString()})…`
      );
      await sleep(pollSec * 1000);
    }
  }

  console.log("[start] Depositing into Alpha Vault from distribution wallets…");
  await runDepositToVault();

  state = await loadLaunchState(statePath);
  startVesting = Number(state.startVestingPoint);

  if (!Number.isFinite(startVesting) || startVesting <= 0) {
    console.warn("[start] startVestingPoint missing; claim step may no-op.");
  } else {
    while (Math.floor(Date.now() / 1000) < startVesting) {
      if (Date.now() > deadline) {
        throw new Error("ORCHESTRATOR_MAX_WAIT_SEC exceeded while waiting for vesting / claim.");
      }
      console.log(
        `[start] Waiting for claim / vesting start (${new Date(startVesting * 1000).toISOString()})…`
      );
      await sleep(pollSec * 1000);
    }
  }

  console.log("[start] Claiming tokens from Alpha Vault…");
  await runClaimTokens();

  console.log("[start] Pipeline finished.");
}

if (isMainModule()) {
  runStartPipeline().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
