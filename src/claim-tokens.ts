import "dotenv/config";

import BN from "bn.js";
import bs58 from "bs58";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import AlphaVault from "@meteora-ag/alpha-vault";
import { loadLaunchState, saveLaunchState } from "./lib/launch-state-file";
import { getEnvOrDefault, inferCluster, sleep } from "./lib/utils";
import { sendAndConfirmTransactionWithRetry } from "./lib/sendAndConfirmWithRetry";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";
const DEFAULT_ALPHA_VAULT_OUTPUT_PATH = "data/latest-alpha-vault.json";

async function resolveAlphaVaultPk(
  state: Awaited<ReturnType<typeof loadLaunchState>>
): Promise<string> {
  const direct = state.alphaVaultAddress?.trim();
  if (direct) return direct;
  const avPath =
    getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", DEFAULT_ALPHA_VAULT_OUTPUT_PATH);
  const raw = await readFile(resolve(avPath), "utf8");
  const av = JSON.parse(raw) as { alphaVaultAddress?: string };
  const fromArt = av?.alphaVaultAddress?.trim();
  if (fromArt) return fromArt;
  throw new Error(
    `Missing alphaVaultAddress in launch state and artifact at ${avPath}`
  );
}

function getClaimTxDelayMs(): number {
  const raw = getEnvOrDefault("ALPHA_FCFS_CLAIM_TX_DELAY_SEC", "").trim();
  if (raw === "") return 0;
  const s = Number(raw);
  return Number.isFinite(s) ? Math.max(0, Math.round(s * 1000)) : 0;
}

export async function runClaimTokens(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("devnet"));
  const cluster = inferCluster(rpc);
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);

  const connection = new Connection(rpc, "confirmed");
  const state = await loadLaunchState(statePath);

  const startVestingPoint = Number(state.startVestingPoint);
  const now = Math.floor(Date.now() / 1000);

  if (now < startVestingPoint) {
    console.log(`Claim not yet available. Lock-up ends at ${new Date(startVestingPoint * 1000).toISOString()}`);
    return;
  }

  const vaultAddr = await resolveAlphaVaultPk(state);
  let alphaVault: AlphaVault;
  try {
    alphaVault = await AlphaVault.create(connection, new PublicKey(vaultAddr), { cluster });
  } catch (e) {
    throw new Error(
      `Alpha Vault not found at ${vaultAddr}. ` + (e instanceof Error ? e.message : String(e))
    );
  }

  const claimsByWallet = { ...state.claimsByWallet };
  let newClaimTransactions = 0;
  const claimTxDelayMs = getClaimTxDelayMs();
  const wallets = state.distributionWallets;

  type ClaimJob = { w: (typeof wallets)[0]; kp: Keypair; claimable: BN };
  const toClaim: ClaimJob[] = [];

  for (const w of wallets) {
    const kp = Keypair.fromSecretKey(bs58.decode(w.secretKeyBase58));
    const escrow = await alphaVault.getEscrow(kp.publicKey);
    const claimInfo = alphaVault.getClaimInfo(escrow);
    const claimable = claimInfo.totalClaimable;
    if (claimable.isZero()) {
      const prev = claimsByWallet[w.publicKey];
      if (prev) {
        console.log(`Wallet ${w.publicKey} already claimed (${prev}).`);
      } else {
        console.log(`Wallet ${w.publicKey} has nothing to claim.`);
      }
      continue;
    }
    toClaim.push({ w, kp, claimable });
  }

  if (claimTxDelayMs > 0 && toClaim.length > 1) {
    console.log(
      `Claim tx delay: ${claimTxDelayMs / 1000}s between transactions — ALPHA_FCFS_CLAIM_TX_DELAY_SEC`
    );
  }

  for (let j = 0; j < toClaim.length; j++) {
    const { w, kp, claimable } = toClaim[j];
    const claimTx = await alphaVault.claimToken(kp.publicKey);
    const sig = await sendAndConfirmTransactionWithRetry(
      connection,
      claimTx,
      [kp],
      { commitment: "confirmed", skipPreflight: false },
      { label: "claim-tokens" }
    );

    newClaimTransactions += 1;
    const prevClaimed = claimsByWallet[w.publicKey] ? new BN(claimsByWallet[w.publicKey]) : new BN(0);
    claimsByWallet[w.publicKey] = prevClaimed.add(claimable).toString();
    console.log(`Claimed ${claimable.toString()} for ${w.publicKey} (tx: ${sig})`);

    if (claimTxDelayMs > 0 && j < toClaim.length - 1) {
      await sleep(claimTxDelayMs);
    }
  }

  const allClaimed = state.distributionWallets.every((w) => {
    const prev = claimsByWallet[w.publicKey];
    return prev && new BN(prev).gt(new BN(0));
  });

  state.claimsByWallet = claimsByWallet;
  if (allClaimed) state.phase = "claimed";
  await saveLaunchState(statePath, state);

  console.log("Claims processed.");
  console.log(`__CLAIM_RESULT__: ${JSON.stringify({ newClaimTransactions })}`);
}

async function main(): Promise<void> {
  await runClaimTokens();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
