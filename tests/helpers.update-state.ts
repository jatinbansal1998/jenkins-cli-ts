import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Marks the background update and version-policy checks as just done, so a CLI
 * spawned against this HOME does not start a detached GitHub refresh that
 * outlives the test and writes into its deleted HOME.
 */
export function stampFreshUpdateState(home: string): void {
  const configDir = join(home, ".config", "jenkins-cli");
  mkdirSync(configDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(configDir, "update-state.json"),
    JSON.stringify({ lastCheckedAt: now, minAllowedFetchedAt: now }),
  );
}
