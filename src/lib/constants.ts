import { PublicKey } from "@solana/web3.js";

export const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const MAINNET_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** Meteora: deposit join closes this many seconds before pool activation */
export const DEPOSIT_END_TO_ACTIVATION_SEC = 3900;
