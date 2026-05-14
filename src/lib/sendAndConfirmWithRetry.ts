import type {
  ConfirmOptions,
  Connection,
  Signer,
  Transaction,
  TransactionSignature,
} from "@solana/web3.js";
import { sendAndConfirmTransaction } from "@solana/web3.js";
import { sleep } from "./utils";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 400;

function solanaSendErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isRetriableSolanaSendError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("transactionexpiredblockheightexceeded")) return true;
  if (m.includes("block height exceeded")) return true;
  if (m.includes("expired blockhash")) return true;
  if (m.includes("blockhash not found")) return true;
  if (m.includes("transaction expired")) return true;
  if (m.includes("timed out waiting")) return true;
  if (m.includes("timeout")) return true;
  if (m.includes("429")) return true;
  if (m.includes("too many requests")) return true;
  if (m.includes("rate limit")) return true;
  if (m.includes("econnreset")) return true;
  if (m.includes("fetch failed")) return true;
  if (m.includes("socket hang up")) return true;
  if (m.includes("enotfound")) return true;
  if (m.includes("econnrefused")) return true;
  if (m.includes("transient")) return true;
  return false;
}

export interface SendAndConfirmRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
}

export async function sendAndConfirmTransactionWithRetry(
  connection: Connection,
  transaction: Transaction,
  signers: Signer[],
  confirmOptions: ConfirmOptions = {
    commitment: "confirmed",
    skipPreflight: false,
  },
  retry: SendAndConfirmRetryOptions = {}
): Promise<TransactionSignature> {
  const maxAttempts = retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const label = retry.label ?? "sendAndConfirm";
  const commitment = confirmOptions.commitment ?? "confirmed";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { blockhash } = await connection.getLatestBlockhash(commitment);
      transaction.recentBlockhash = blockhash;
      if (signers.length > 0 && !transaction.feePayer) {
        transaction.feePayer = signers[0].publicKey;
      }
      return await sendAndConfirmTransaction(connection, transaction, signers, confirmOptions);
    } catch (e) {
      lastErr = e;
      const msg = solanaSendErrorMessage(e);
      if (!isRetriableSolanaSendError(msg) || attempt === maxAttempts) {
        throw e;
      }
      console.warn(
        `${label}: attempt ${attempt}/${maxAttempts} failed (${msg.slice(0, 200)}), refreshing blockhash and retrying...`
      );
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastErr;
}

export async function sendAndConfirmTransactionBuiltWithRetry(
  connection: Connection,
  buildTx: () => Transaction | Promise<Transaction>,
  signers: Signer[],
  confirmOptions: ConfirmOptions = {
    commitment: "confirmed",
    skipPreflight: false,
  },
  retry: SendAndConfirmRetryOptions = {}
): Promise<TransactionSignature> {
  const maxAttempts = retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const label = retry.label ?? "sendAndConfirmBuilt";
  const commitment = confirmOptions.commitment ?? "confirmed";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tx = await Promise.resolve(buildTx());
      const { blockhash } = await connection.getLatestBlockhash(commitment);
      tx.recentBlockhash = blockhash;
      if (signers.length > 0 && !tx.feePayer) {
        tx.feePayer = signers[0].publicKey;
      }
      return await sendAndConfirmTransaction(connection, tx, signers, confirmOptions);
    } catch (e) {
      lastErr = e;
      const msg = solanaSendErrorMessage(e);
      if (!isRetriableSolanaSendError(msg) || attempt === maxAttempts) {
        throw e;
      }
      console.warn(
        `${label}: attempt ${attempt}/${maxAttempts} failed (${msg.slice(0, 200)}), rebuilding tx...`
      );
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastErr;
}
