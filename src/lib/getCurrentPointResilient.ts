import BN from "bn.js";
import type { Connection } from "@solana/web3.js";
import { ActivationType } from "@meteora-ag/cp-amm-sdk";

export async function getCurrentPointResilient(
  connection: Connection,
  activationType: ActivationType
): Promise<BN> {
  const currentSlot = await connection.getSlot("confirmed");
  if (activationType === ActivationType.Slot) {
    return new BN(currentSlot);
  }

  const blockTimeForSlot = async (slot: number): Promise<number | null> => {
    try {
      return await connection.getBlockTime(slot);
    } catch {
      return null;
    }
  };

  let t = await blockTimeForSlot(currentSlot);
  if (t != null) return new BN(t);

  for (let back = 1; back <= 64; back++) {
    t = await blockTimeForSlot(currentSlot - back);
    if (t != null) return new BN(t);
  }

  return new BN(Math.floor(Date.now() / 1000));
}
