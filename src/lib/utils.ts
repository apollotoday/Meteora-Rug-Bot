import bs58 from "bs58";

export type ClusterType = "devnet" | "mainnet-beta";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key]?.trim() || defaultValue;
}

export function getRequiredEnv(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function parseWalletSecret(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) return Uint8Array.from(JSON.parse(trimmed) as number[]);
  if (trimmed.includes(",")) return Uint8Array.from(trimmed.split(",").map((x) => Number(x.trim())));
  return bs58.decode(trimmed);
}

export function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return raw.toLowerCase() === "true";
}

export function inferCluster(rpcUrl: string): ClusterType {
  const input = rpcUrl.toLowerCase();
  if (input.includes("mainnet")) return "mainnet-beta";
  return "devnet";
}
