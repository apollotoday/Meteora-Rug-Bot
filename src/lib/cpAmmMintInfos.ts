import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, type Mint } from "@solana/spl-token";

export async function getSwapABMintInfos(
  connection: Connection,
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
  tokenAProgram: PublicKey,
  tokenBProgram: PublicKey
): Promise<{
  inputTokenInfo: { mint: Mint; currentEpoch: number };
  outputTokenInfo: { mint: Mint; currentEpoch: number };
}> {
  const [epochInfo, mintA, mintB] = await Promise.all([
    connection.getEpochInfo(),
    getMint(connection, tokenAMint, "confirmed", tokenAProgram),
    getMint(connection, tokenBMint, "confirmed", tokenBProgram),
  ]);
  const currentEpoch = epochInfo.epoch;
  return {
    inputTokenInfo: { mint: mintA, currentEpoch },
    outputTokenInfo: { mint: mintB, currentEpoch },
  };
}
