import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LaunchState } from "./types";

export async function loadLaunchState(statePath: string): Promise<LaunchState> {
  const abs = resolve(statePath);
  const raw = await readFile(abs, "utf8");
  return JSON.parse(raw) as LaunchState;
}

export async function saveLaunchState(statePath: string, state: LaunchState): Promise<void> {
  const abs = resolve(statePath);
  await writeFile(
    abs,
    JSON.stringify(
      {
        ...state,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
}

export async function tryLoadLaunchState(statePath: string): Promise<LaunchState | null> {
  try {
    return await loadLaunchState(statePath);
  } catch {
    return null;
  }
}
