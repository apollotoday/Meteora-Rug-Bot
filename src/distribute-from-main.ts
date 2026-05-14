import "dotenv/config";

import BN from "bn.js";
import bs58 from "bs58";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { saveLaunchState, tryLoadLaunchState } from "./lib/launch-state-file";
import type { DistributionWallet, LaunchState } from "./lib/types";
import { DEVNET_USDC_MINT, MAINNET_USDC_MINT } from "./lib/constants";
import {
  getEnvOrDefault,
  getRequiredEnv,
  inferCluster,
  parseBool,
  parseWalletSecret,
  sleep,
} from "./lib/utils";

const DEFAULT_TOKEN_MINT_OUTPUT_PATH = "data/latest-token-mint.json";
const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";
const DEFAULT_KEYSTORE_PATH = "data/distribution-wallets.keystore.json";

type KeystoreFile = {
  wallets: { publicKey: string; secretKeyBase58: string }[];
};

async function getTokenProgramForMint(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`);
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  throw new Error(`Unsupported token program for mint ${mint.toBase58()}`);
}

function distributeNumFromEnv(): number {
  const raw =
    process.env.DISTRIBUTE_NUM?.trim() ||
    process.env.DISTRIBUTION_WALLET_COUNT?.trim() ||
    process.env.BUNDLE_DISTRIBUTE_NUM?.trim();
  if (!raw) throw new Error("Set DISTRIBUTE_NUM (or DISTRIBUTION_WALLET_COUNT)");
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new Error("DISTRIBUTE_NUM must be a positive integer");
  return Math.floor(n);
}

function splitTotal(rawTotal: BN, parts: number): BN[] {
  if (parts <= 0) return [];
  const per = rawTotal.divn(parts);
  const out: BN[] = [];
  let sum = new BN(0);
  for (let i = 0; i < parts - 1; i++) {
    out.push(per);
    sum = sum.add(per);
  }
  out.push(rawTotal.sub(sum));
  return out;
}

async function loadOrCreateKeystore(
  path: string,
  count: number,
  regenerate: boolean
): Promise<{ wallets: Keypair[]; createdFresh: boolean }> {
  const abs = resolve(path);
  if (!regenerate) {
    try {
      const raw = await readFile(abs, "utf8");
      const parsed = JSON.parse(raw) as KeystoreFile;
      if (parsed.wallets?.length === count) {
        const wallets = parsed.wallets.map((w) =>
          Keypair.fromSecretKey(bs58.decode(w.secretKeyBase58.trim()))
        );
        return { wallets, createdFresh: false };
      }
      if (parsed.wallets?.length) {
        throw new Error(
          `${abs} has ${parsed.wallets.length} wallets but DISTRIBUTE_NUM=${count}. ` +
            `Set REGENERATE_DISTRIBUTION_WALLETS=true to replace, or match the count.`
        );
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  const wallets = Array.from({ length: count }, () => Keypair.generate());
  const payload: KeystoreFile = {
    wallets: wallets.map((kp) => ({
      publicKey: kp.publicKey.toBase58(),
      secretKeyBase58: bs58.encode(kp.secretKey),
    })),
  };
  await mkdir(resolve(abs, ".."), { recursive: true });
  await writeFile(abs, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${count} new distribution wallet(s) to ${abs}`);
  return { wallets, createdFresh: true };
}

async function buildBaseLaunchState(params: {
  statePath: string;
  tokenMintPath: string;
  poolPath: string;
  alphaVaultPath: string;
  rpcUrl: string;
  tokenMint: string;
}): Promise<LaunchState> {
  const cluster = inferCluster(params.rpcUrl);
  const quoteType = (getEnvOrDefault("QUOTE_MINT_TYPE", "WSOL").toUpperCase() as "WSOL" | "USDC");
  const quoteMint =
    quoteType === "WSOL"
      ? "So11111111111111111111111111111111111111112"
      : cluster === "mainnet-beta"
        ? MAINNET_USDC_MINT.toBase58()
        : DEVNET_USDC_MINT.toBase58();

  const prev = await tryLoadLaunchState(params.statePath);
  return {
    phase: prev?.phase && prev.phase !== "initial" ? prev.phase : "token-minted",
    updatedAt: new Date().toISOString(),
    tokenMint: params.tokenMint,
    poolAddress: prev?.poolAddress ?? "",
    alphaVaultAddress: prev?.alphaVaultAddress ?? "",
    quoteMintType: quoteType,
    quoteMint: prev?.quoteMint ?? quoteMint,
    poolActivationPointTs: prev?.poolActivationPointTs ?? "0",
    depositingPoint: prev?.depositingPoint ?? "0",
    startVestingPoint: prev?.startVestingPoint ?? "0",
    endVestingPoint: prev?.endVestingPoint ?? "0",
    maxDepositingCap: prev?.maxDepositingCap ?? "0",
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
}

export async function runDistributeFromMain(): Promise<void> {
  const rpcUrl = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const connection = new Connection(rpcUrl, "confirmed");
  const main = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));

  const n = distributeNumFromEnv();
  const keystorePath = getEnvOrDefault("DISTRIBUTION_WALLETS_KEYSTORE_PATH", DEFAULT_KEYSTORE_PATH);
  const regenerate = parseBool(process.env.REGENERATE_DISTRIBUTION_WALLETS, false);
  const { wallets } = await loadOrCreateKeystore(keystorePath, n, regenerate);

  const tokenMintPath = getEnvOrDefault("TOKEN_MINT_OUTPUT_PATH", DEFAULT_TOKEN_MINT_OUTPUT_PATH);
  const tokenRaw = await readFile(resolve(tokenMintPath), "utf8");
  const tokenJson = JSON.parse(tokenRaw) as { tokenMint?: string };
  if (!tokenJson.tokenMint) throw new Error(`tokenMint missing in ${tokenMintPath}`);
  const tokenMintPk = new PublicKey(tokenJson.tokenMint);

  const perWalletSol =
    process.env.DISTRIBUTION_SOL_PER_WALLET_LAMPORTS?.trim() ||
    process.env.DISTRIBUTION_LAMPORTS_PER_WALLET?.trim();
  const totalSol = process.env.DISTRIBUTION_TOTAL_SOL_LAMPORTS?.trim();

  let solAmounts: BN[];
  if (perWalletSol) {
    const lamports = new BN(perWalletSol, 10);
    solAmounts = Array.from({ length: n }, () => lamports);
  } else if (totalSol) {
    solAmounts = splitTotal(new BN(totalSol, 10), n);
  } else {
    throw new Error("Set DISTRIBUTION_SOL_PER_WALLET_LAMPORTS or DISTRIBUTION_TOTAL_SOL_LAMPORTS");
  }

  const tokenTotalEnv =
    process.env.BUNDLE_DISTRIBUTE_TOKEN_RAW_TOTAL?.trim() ||
    process.env.DISTRIBUTE_PROJECT_TOKEN_RAW_TOTAL?.trim();
  let tokenAmounts: BN[] | null = null;
  if (tokenTotalEnv) {
    tokenAmounts = splitTotal(new BN(tokenTotalEnv, 10), n);
  }

  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", "data/latest-pool.json");
  const alphaPath = getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", "data/latest-alpha-vault.json");

  const tokenProgram = await getTokenProgramForMint(connection, tokenMintPk);
  const mainAta = getAssociatedTokenAddressSync(
    tokenMintPk,
    main.publicKey,
    false,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const delayMs = Math.max(
    0,
    Number(getEnvOrDefault("DISTRIBUTION_TX_DELAY_SEC", "0")) * 1000 ||
      Number(getEnvOrDefault("DISTRIBUTION_TX_DELAY_MS", "0"))
  );

  for (let i = 0; i < wallets.length; i++) {
    const dest = wallets[i];
    const solLamports = solAmounts[i];
    console.log(`[${i + 1}/${n}] Funding ${dest.publicKey.toBase58()} with ${solLamports.toString()} lamports SOL`);

    {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: main.publicKey,
          toPubkey: dest.publicKey,
          lamports: Number(solLamports.toString()),
        })
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [main], {
        commitment: "confirmed",
        skipPreflight: false,
      });
      console.log(`  SOL tx: ${sig}`);
    }

    if (tokenAmounts && !tokenAmounts[i].isZero()) {
      const amt = tokenAmounts[i];
      const destAta = getAssociatedTokenAddressSync(
        tokenMintPk,
        dest.publicKey,
        false,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const tx = new Transaction();
      const destInfo = await connection.getAccountInfo(destAta);
      if (!destInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            main.publicKey,
            destAta,
            dest.publicKey,
            tokenMintPk,
            tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }
      tx.add(
        createTransferInstruction(mainAta, destAta, main.publicKey, BigInt(amt.toString()), [], tokenProgram)
      );
      const sig214 = await sendAndConfirmTransaction(connection, tx, [main], {
        commitment: "confirmed",
        skipPreflight: false,
      });
      console.log(`  Token transfer tx: ${sig214} (${amt.toString()} raw)`);
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  const distributionWallets: DistributionWallet[] = wallets.map((kp, i) => ({
    publicKey: kp.publicKey.toBase58(),
    secretKeyBase58: bs58.encode(kp.secretKey),
    amountRaw: solAmounts[i].toString(),
  }));

  const state = await buildBaseLaunchState({
    statePath,
    tokenMintPath,
    poolPath,
    alphaVaultPath: alphaPath,
    rpcUrl,
    tokenMint: tokenMintPk.toBase58(),
  });
  const preservePhases = new Set<LaunchState["phase"]>([
    "pool-created",
    "vault-created",
    "deposited",
    "filled",
    "launched",
    "claimed",
    "activated",
  ]);
  state.distributionWallets = distributionWallets;
  state.distributionExpectedCount = n;
  state.totalDistributedRaw = distributionWallets
    .reduce((acc, w) => acc.add(new BN(w.amountRaw, 10)), new BN(0))
    .toString();
  if (preservePhases.has(state.phase)) {
    console.log(`Keeping phase=${state.phase} (already past distribution). Updated wallet list only.`);
  } else {
    state.phase = "funds-distributed";
  }

  await saveLaunchState(statePath, state);
  console.log(`Launch state saved: ${resolve(statePath)}`);
}

function isMainModule(): boolean {
  try {
    return require.main === module;
  } catch {
    return true;
  }
}

if (isMainModule()) {
  runDistributeFromMain().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
