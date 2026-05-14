import "dotenv/config";

import BN from "bn.js";
import bs58 from "bs58";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import AlphaVault from "@meteora-ag/alpha-vault";
import { DEPOSIT_END_TO_ACTIVATION_SEC } from "./lib/constants";
import { loadLaunchState, saveLaunchState } from "./lib/launch-state-file";
import type { LaunchState } from "./lib/types";
import { getEnvOrDefault, inferCluster } from "./lib/utils";
import { sendAndConfirmTransactionBuiltWithRetry } from "./lib/sendAndConfirmWithRetry";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";
const DEFAULT_ALPHA_VAULT_OUTPUT_PATH = "data/latest-alpha-vault.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";

async function resolveAlphaVaultPkString(state: LaunchState): Promise<string> {
  const direct = state.alphaVaultAddress?.trim();
  if (direct) return direct;
  const avPath = getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", DEFAULT_ALPHA_VAULT_OUTPUT_PATH);
  const raw = await readFile(resolve(avPath), "utf8");
  const av = JSON.parse(raw) as { alphaVaultAddress?: string };
  const fromArt = av?.alphaVaultAddress?.trim();
  if (fromArt) return fromArt;
  throw new Error(
    `Missing alphaVaultAddress in launch state and in ${avPath}. Run sync:launch-state or create the vault first.`
  );
}

async function resolveDepositTiming(state: LaunchState): Promise<{
  depositingPoint: number;
  poolActivation: number;
}> {
  let depositingPoint = Number(state.depositingPoint);
  let poolActivation = Number(state.poolActivationPointTs);

  const alphaPath = getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", DEFAULT_ALPHA_VAULT_OUTPUT_PATH);
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", DEFAULT_POOL_OUTPUT_PATH);

  if (!Number.isFinite(depositingPoint) || depositingPoint <= 0) {
    try {
      const raw = await readFile(resolve(alphaPath), "utf8");
      const av = JSON.parse(raw) as { depositingPoint?: string };
      if (av.depositingPoint) depositingPoint = Number(av.depositingPoint);
    } catch {
      /* ignore */
    }
  }

  if (!Number.isFinite(poolActivation) || poolActivation <= 0) {
    try {
      const raw = await readFile(resolve(poolPath), "utf8");
      const pool = JSON.parse(raw) as { poolActivationPointTs?: string | null };
      if (pool.poolActivationPointTs != null && String(pool.poolActivationPointTs).trim() !== "") {
        poolActivation = Number(pool.poolActivationPointTs);
      }
    } catch {
      /* ignore */
    }
  }

  return { depositingPoint, poolActivation };
}

function depositLamportsAfterFeeBuffer(balanceLamports: number, feeReserveLamports: BN): BN {
  const balance = new BN(balanceLamports);
  const afterReserve = balance.sub(feeReserveLamports);
  if (afterReserve.lte(new BN(0))) return new BN(0);
  return afterReserve;
}

async function sendDepositWithRetry(
  connection: Connection,
  alphaVault: AlphaVault,
  amount: BN,
  owner: PublicKey,
  signer: Keypair,
  maxAttempts: number
): Promise<string> {
  return sendAndConfirmTransactionBuiltWithRetry(
    connection,
    () => alphaVault.deposit(amount, owner),
    [signer],
    { commitment: "confirmed", skipPreflight: false },
    { maxAttempts, baseDelayMs: 600, label: "deposit-to-vault" }
  );
}

export async function runDepositToVault(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("devnet"));
  const cluster = inferCluster(rpc);
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);

  const connection = new Connection(rpc, "confirmed");
  const state = await loadLaunchState(statePath);

  if (state.distributionWallets.length === 0) {
    throw new Error("No distribution wallets. Run distribute:from-main first.");
  }

  const expectedDist = state.distributionExpectedCount;
  if (expectedDist != null && expectedDist > 0 && state.distributionWallets.length < expectedDist) {
    console.log(
      `Distribution incomplete (${state.distributionWallets.length}/${expectedDist} wallets). Finish distributing first.`
    );
    return;
  }

  const vaultAddr = await resolveAlphaVaultPkString(state);

  let alphaVault: AlphaVault;
  try {
    alphaVault = await AlphaVault.create(connection, new PublicKey(vaultAddr), { cluster });
  } catch (e) {
    throw new Error(
      `Alpha Vault not found at ${vaultAddr}. Ensure pool and alpha vault exist on ${cluster}. ` +
        (e instanceof Error ? e.message : String(e))
    );
  }

  const feeReserveLamports = new BN(
    getEnvOrDefault("DISTRIBUTION_WALLET_SOL_FEE_BUFFER_LAMPORTS", "10000000")
  );
  const depositSendMaxAttempts = Math.max(
    1,
    Number(getEnvOrDefault("DEPOSIT_SEND_MAX_ATTEMPTS", getEnvOrDefault("DISTRIBUTION_SEND_MAX_ATTEMPTS", "6")))
  );

  const now = Math.floor(Date.now() / 1000);
  const { depositingPoint, poolActivation } = await resolveDepositTiming(state);
  if (depositingPoint > 0 && now < depositingPoint) {
    console.log(`Deposit period not yet open. Starts at ${new Date(depositingPoint * 1000).toISOString()}`);
    return;
  }

  let lastJoinPoint: number;
  if (poolActivation > 0) {
    lastJoinPoint = poolActivation - DEPOSIT_END_TO_ACTIVATION_SEC;
  } else {
    console.warn(
      "poolActivationPointTs unknown; cannot compute deposit deadline. Attempting deposits anyway (may fail on-chain)."
    );
    lastJoinPoint = Number.POSITIVE_INFINITY;
  }
  if (poolActivation > 0 && now > lastJoinPoint) {
    console.log("Deposit period has ended. Skipping deposits.");
    return;
  }

  const depositsByWallet = { ...state.depositsByWallet };

  for (const w of state.distributionWallets) {
    if (depositsByWallet[w.publicKey]) {
      console.log(`Wallet ${w.publicKey} already deposited. Skipping.`);
      continue;
    }

    const planned = new BN(w.amountRaw);
    if (planned.isZero()) {
      depositsByWallet[w.publicKey] = "0";
      continue;
    }

    const kp = Keypair.fromSecretKey(bs58.decode(w.secretKeyBase58));

    let amount: BN;
    if (state.quoteMintType !== "USDC") {
      const balanceLamports = await connection.getBalance(kp.publicKey, "confirmed");
      amount = depositLamportsAfterFeeBuffer(balanceLamports, feeReserveLamports);
      if (amount.isZero()) {
        console.warn(
          `Skip ${w.publicKey}: insufficient SOL after ${feeReserveLamports.toString()} lamport fee buffer (balance ${balanceLamports}).`
        );
        continue;
      }
    } else {
      amount = planned;
    }

    const sig = await sendDepositWithRetry(connection, alphaVault, amount, kp.publicKey, kp, depositSendMaxAttempts);
    depositsByWallet[w.publicKey] = amount.toString();
    console.log(`Deposited ${amount.toString()} to vault from ${w.publicKey} (tx: ${sig})`);
  }

  state.phase = "deposited";
  state.depositsByWallet = depositsByWallet;
  await saveLaunchState(statePath, state);

  console.log("Deposits complete.");
}

async function main(): Promise<void> {
  await runDepositToVault();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
