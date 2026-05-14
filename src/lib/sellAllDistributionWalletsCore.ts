import BN from "bn.js";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { CpAmm, SwapMode, getTokenDecimals } from "@meteora-ag/cp-amm-sdk";
import { getCurrentPointResilient } from "./getCurrentPointResilient";
import { getSwapABMintInfos } from "./cpAmmMintInfos";
import { sendAndConfirmTransactionWithRetry } from "./sendAndConfirmWithRetry";

export type SellAllWalletInput = {
  publicKey: string;
  secretKeyBase58: string;
};

export type SellAllTokenAOptions = {
  baseSlippageBps: number;
  maxRetries: number;
  slippageStepBps: number;
  concurrency: number;
  staggerMs: number;
};

export type SellAllProgress = {
  phase: "preparing" | "selling" | "complete";
  completed: number;
  total: number;
};

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_SELL_ALL_RETRY_MAX = 5;
const DEFAULT_SELL_ALL_RETRY_STEP_BPS = 150;
const DEFAULT_STAGGER_MS = 180;

export const sellAllDefaults: SellAllTokenAOptions = {
  baseSlippageBps: 100,
  maxRetries: DEFAULT_SELL_ALL_RETRY_MAX,
  slippageStepBps: DEFAULT_SELL_ALL_RETRY_STEP_BPS,
  concurrency: DEFAULT_CONCURRENCY,
  staggerMs: DEFAULT_STAGGER_MS,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function keypairFromWallet(w: SellAllWalletInput): Keypair {
  const sk = w.secretKeyBase58.trim();
  if (sk.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(sk) as number[]));
  if (sk.includes(",")) {
    return Keypair.fromSecretKey(Uint8Array.from(sk.split(",").map((x) => Number(x.trim()))));
  }
  return Keypair.fromSecretKey(bs58.decode(sk));
}

function isExceededSlippageError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.includes("ExceededSlippage") ||
    text.includes("custom program error: 0x1772") ||
    text.includes('"Custom":6002')
  );
}

export async function runSellAllTokenAFromWallets(params: {
  connection: Connection;
  poolAddress: string;
  wallets: SellAllWalletInput[];
  options: SellAllTokenAOptions;
  log: (line: string) => void;
  onProgress?: (p: SellAllProgress) => void;
}): Promise<{ soldCount: number; failedCount: number; skippedEmpty: number }> {
  const { connection, poolAddress, wallets, options, log, onProgress } = params;
  const { baseSlippageBps, maxRetries, slippageStepBps, concurrency, staggerMs } = options;

  if (wallets.length === 0) {
    throw new Error("No wallets to sell from.");
  }

  onProgress?.({ phase: "preparing", completed: 0, total: 1 });

  const cpAmm = new CpAmm(connection);
  const poolPk = new PublicKey(poolAddress);
  const poolState = await cpAmm.fetchPoolState(poolPk);
  const tokenAMint = poolState.tokenAMint;
  const tokenBMint = poolState.tokenBMint;
  const tokenAProgram = poolState.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenBProgram = poolState.tokenBFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  log(`Selling token A from ${wallets.length} distribution wallet(s)...`);
  log(`Pool: ${poolAddress}`);
  log(`Token A mint: ${tokenAMint.toBase58()}`);
  const maxSlippageBps = baseSlippageBps + maxRetries * slippageStepBps;
  log(
    `Slippage: ${baseSlippageBps} bps (up to ${maxSlippageBps} bps after retries) | ` +
      `Concurrency: ${concurrency}${staggerMs ? ` | Stagger: ${staggerMs} ms` : ""}`
  );

  const [tokenADecimals, tokenBDecimals, mintInfos] = await Promise.all([
    getTokenDecimals(connection, tokenAMint, tokenAProgram),
    getTokenDecimals(connection, tokenBMint, tokenBProgram),
    getSwapABMintInfos(connection, tokenAMint, tokenBMint, tokenAProgram, tokenBProgram),
  ]);
  const { inputTokenInfo, outputTokenInfo } = mintInfos;

  const atas = wallets.map((w) =>
    getAssociatedTokenAddressSync(
      tokenAMint,
      new PublicKey(w.publicKey),
      false,
      tokenAProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );

  const BATCH_SIZE = 100;
  const tokenBalances: string[] = [];
  for (let i = 0; i < atas.length; i += BATCH_SIZE) {
    const chunk = atas.slice(i, i + BATCH_SIZE);
    const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    for (const info of infos) {
      if (!info || info.data.length < 72) {
        tokenBalances.push("0");
      } else {
        const amount = info.data.readBigUInt64LE(64);
        tokenBalances.push(amount.toString());
      }
    }
  }

  const swappable = wallets
    .map((w, i) => ({ ...w, tokenBalance: tokenBalances[i] ?? "0" }))
    .filter((w) => BigInt(w.tokenBalance) > 0n);

  const skippedCount = wallets.length - swappable.length;
  log(`Wallets with balance: ${swappable.length} | Skipped (empty): ${skippedCount}`);

  let soldCount = 0;
  let failedCount = 0;

  if (swappable.length === 0) {
    onProgress?.({ phase: "complete", completed: 1, total: 1 });
    log(`Done. Sold: ${soldCount}, failed: ${failedCount}, skipped: ${skippedCount}`);
    return { soldCount, failedCount, skippedEmpty: skippedCount };
  }

  onProgress?.({ phase: "selling", completed: 0, total: swappable.length });

  const totalWaves = Math.ceil(swappable.length / concurrency);
  let sellFinished = 0;
  for (let waveIdx = 0; waveIdx < totalWaves; waveIdx++) {
    const start = waveIdx * concurrency;
    const batch = swappable.slice(start, start + concurrency);

    log(`Wave ${waveIdx + 1}/${totalWaves}: selling ${batch.length} wallets...`);

    const wavePromises = batch.map(async (wallet, batchIdx) => {
      if (staggerMs > 0) {
        await sleep(batchIdx * staggerMs);
      }

      try {
        const kp = keypairFromWallet(wallet);

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const slippageBps = baseSlippageBps + attempt * slippageStepBps;
          try {
            const freshPoolState = await cpAmm.fetchPoolState(poolPk);
            const currentPoint = await getCurrentPointResilient(connection, freshPoolState.activationType);
            const amountIn = new BN(wallet.tokenBalance, 10);

            const quote = cpAmm.getQuote2({
              inputTokenMint: tokenAMint,
              slippage: slippageBps,
              currentPoint,
              poolState: freshPoolState,
              inputTokenInfo,
              outputTokenInfo,
              tokenADecimal: tokenADecimals,
              tokenBDecimal: tokenBDecimals,
              hasReferral: false,
              swapMode: SwapMode.ExactIn,
              amountIn,
            });
            const minimumAmountOut = quote.minimumAmountOut ?? new BN(0);

            const swapTx = await cpAmm.swap2({
              payer: kp.publicKey,
              pool: poolPk,
              inputTokenMint: tokenAMint,
              outputTokenMint: tokenBMint,
              tokenAMint: freshPoolState.tokenAMint,
              tokenBMint: freshPoolState.tokenBMint,
              tokenAVault: freshPoolState.tokenAVault,
              tokenBVault: freshPoolState.tokenBVault,
              tokenAProgram,
              tokenBProgram,
              referralTokenAccount: null,
              poolState: freshPoolState,
              swapMode: SwapMode.ExactIn,
              amountIn,
              minimumAmountOut,
            });

            const sig = await sendAndConfirmTransactionWithRetry(
              connection,
              swapTx,
              [kp],
              { commitment: "confirmed", skipPreflight: false },
              { label: "sellAllDistributionWalletsCore" }
            );
            soldCount += 1;
            log(`  [ok] ${wallet.publicKey} sold ${wallet.tokenBalance} raw (tx: ${sig})`);
            return;
          } catch (e) {
            if (attempt < maxRetries && isExceededSlippageError(e)) {
              const nextBps = baseSlippageBps + (attempt + 1) * slippageStepBps;
              log(
                `  [retry] ${wallet.publicKey} slippage (6002), next attempt ${slippageBps}→${nextBps} bps...`
              );
              await sleep(Math.min(3000, 250 + attempt * 500));
            } else {
              failedCount += 1;
              log(`  [fail] ${wallet.publicKey}: ${e instanceof Error ? e.message : String(e)}`);
              return;
            }
          }
        }
      } finally {
        sellFinished += 1;
        onProgress?.({ phase: "selling", completed: sellFinished, total: swappable.length });
      }
    });

    await Promise.all(wavePromises);
  }

  onProgress?.({ phase: "complete", completed: 1, total: 1 });
  log(`Done. Sold: ${soldCount}, failed: ${failedCount}, skipped: ${skippedCount}`);
  return { soldCount, failedCount, skippedEmpty: skippedCount };
}
