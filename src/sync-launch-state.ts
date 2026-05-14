import "dotenv/config";

import { clusterApiUrl } from "@solana/web3.js";
import { syncLaunchStateFromArtifacts } from "./lib/sync-launch-state-from-artifacts";
import { getEnvOrDefault } from "./lib/utils";

const DEFAULT_TOKEN_MINT_OUTPUT_PATH = "data/latest-token-mint.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";
const DEFAULT_ALPHA_VAULT_OUTPUT_PATH = "data/latest-alpha-vault.json";
const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";

async function main(): Promise<void> {
  const rpcUrl = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  await syncLaunchStateFromArtifacts({
    statePath: getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH),
    poolPath: getEnvOrDefault("POOL_OUTPUT_PATH", DEFAULT_POOL_OUTPUT_PATH),
    alphaVaultPath: getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", DEFAULT_ALPHA_VAULT_OUTPUT_PATH),
    tokenMintPath: getEnvOrDefault("TOKEN_MINT_OUTPUT_PATH", DEFAULT_TOKEN_MINT_OUTPUT_PATH),
    rpcUrl,
  });
  console.log("Launch state synced from pool + alpha vault artifacts.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
