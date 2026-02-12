import os from "node:os";
import path from "node:path";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import {
  CLI_FLAGS,
  UPDATE_COMMAND_BREW,
  UPDATE_COMMAND_SELF,
  isUpdateCommandAlias,
} from "./cli-constants";
import { CliError, printHint } from "./cli";
import { CONFIG_DIR } from "./config";
import {
  downloadReleaseAsset,
  fetchLatestRelease as fetchLatestGitHubRelease,
  fetchReleaseByTag as fetchReleaseByTagFromGitHub,
  type GitHubReleaseInfo as ReleaseInfo,
} from "./github/api-wrapper";

const ASSET_NAME = "jenkins-cli";
const HOMEBREW_CELLAR_SEGMENT = `${path.sep}Cellar${path.sep}jenkins-cli${path.sep}`;
const AUTO_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_STATE_FILE = path.join(CONFIG_DIR, "update-state.json");

export type UpdateState = {
  autoUpdate?: boolean;
  autoInstall?: boolean;
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  pendingVersion?: string;
  pendingDetectedAt?: string;
  dismissedVersion?: string;
  minAllowedVersion?: string;
  minAllowedMessage?: string;
  minAllowedFetchedAt?: string;
  minAllowedSourceUrl?: string;
};

export function clearPendingUpdateState(state: UpdateState): UpdateState {
  return {
    ...state,
    pendingVersion: undefined,
    pendingDetectedAt: undefined,
    dismissedVersion: undefined,
  };
}

export function withPendingUpdateState(
  state: UpdateState,
  version: string,
  detectedAt: string,
): UpdateState {
  const samePendingVersion = state.pendingVersion === version;
  return {
    ...state,
    pendingVersion: version,
    pendingDetectedAt: samePendingVersion
      ? (state.pendingDetectedAt ?? detectedAt)
      : detectedAt,
    dismissedVersion:
      state.dismissedVersion === version ? state.dismissedVersion : undefined,
  };
}

export function getDeferredUpdatePromptVersion(
  state: UpdateState,
  currentVersion: string,
): string | null {
  const pendingVersion = state.pendingVersion?.trim();
  if (!pendingVersion) {
    return null;
  }
  const comparison = compareVersions(pendingVersion, currentVersion);
  if (comparison === null || comparison <= 0) {
    return null;
  }
  if (state.dismissedVersion === pendingVersion) {
    return null;
  }
  return pendingVersion;
}

export function normalizeVersionTag(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function stripVersionPrefix(input: string): string {
  return input.trim().replace(/^v/i, "");
}

function parseVersionParts(input: string): number[] | null {
  const cleaned = stripVersionPrefix(input);
  if (!cleaned) {
    return null;
  }
  const [main] = cleaned.split("-");
  if (!main) {
    return null;
  }
  const parts = main.split(".");
  if (parts.length === 0) {
    return null;
  }
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    numbers.push(Number(part));
  }
  return numbers;
}

export function compareVersions(a: string, b: string): number | null {
  const aParts = parseVersionParts(a);
  const bParts = parseVersionParts(b);
  if (!aParts || !bParts) {
    return null;
  }
  const length = Math.max(aParts.length, bParts.length, 3);
  for (let i = 0; i < length; i += 1) {
    const aValue = aParts[i] ?? 0;
    const bValue = bParts[i] ?? 0;
    if (aValue > bValue) {
      return 1;
    }
    if (aValue < bValue) {
      return -1;
    }
  }
  return 0;
}

export async function readUpdateState(): Promise<UpdateState> {
  try {
    const file = Bun.file(UPDATE_STATE_FILE);
    if (!(await file.exists())) {
      return {};
    }
    const contents = await file.text();
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as UpdateState;
  } catch {
    return {};
  }
}

export async function writeUpdateState(state: UpdateState): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await Bun.write(UPDATE_STATE_FILE, payload);
}

export function resolveExecutablePath(): string {
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new CliError("Unable to determine the CLI path.");
  }
  const resolved = path.resolve(argv1);
  const base = path.basename(resolved);
  const looksLikeSource =
    base === "index.ts" ||
    base === "index.js" ||
    resolved.includes(`${path.sep}src${path.sep}`);
  if (looksLikeSource) {
    throw new CliError("Update is not supported when running from source.", [
      `Install the global CLI and re-run \`${UPDATE_COMMAND_SELF}\`.`,
    ]);
  }
  return resolved;
}

export function isHomebrewManagedPath(executablePath: string): boolean {
  return path.resolve(executablePath).includes(HOMEBREW_CELLAR_SEGMENT);
}

export function getPreferredUpdateCommand(): string {
  const argv1 = process.argv[1];
  if (!argv1) {
    return UPDATE_COMMAND_SELF;
  }
  return isHomebrewManagedPath(argv1)
    ? UPDATE_COMMAND_BREW
    : UPDATE_COMMAND_SELF;
}

export async function fetchLatestRelease(options: {
  currentVersion: string;
  timeoutMs?: number;
}): Promise<ReleaseInfo> {
  return await fetchLatestGitHubRelease(options);
}

export async function fetchReleaseByTag(
  tag: string,
  options: { currentVersion: string; timeoutMs?: number },
): Promise<ReleaseInfo> {
  const normalized = normalizeVersionTag(tag);
  return await fetchReleaseByTagFromGitHub(normalized, options);
}

export function resolveAssetUrl(release: ReleaseInfo): string {
  const asset = release.assets.find((item) => item.name === ASSET_NAME);
  if (!asset) {
    throw new CliError(
      `Release asset "${ASSET_NAME}" not found for ${release.tag_name}.`,
      ["Ensure the GitHub release includes the asset named jenkins-cli."],
    );
  }
  return asset.browser_download_url;
}

export async function downloadAndInstall(
  assetUrl: string,
  targetPath: string,
  currentVersion: string,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jenkins-cli-"));
  const tempFile = path.join(tempDir, "jenkins-cli");
  try {
    const response = await downloadReleaseAsset({
      assetUrl,
      currentVersion,
    });
    await Bun.write(tempFile, response);
    await chmod(tempFile, 0o755);
    try {
      await rename(tempFile, targetPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EXDEV") {
        await copyFile(tempFile, targetPath);
        await chmod(targetPath, 0o755);
      } else if (err.code === "EACCES" || err.code === "EPERM") {
        throw new CliError("Permission denied while updating the CLI.", [
          `Check permissions for ${targetPath}.`,
          "Try reinstalling with the install script.",
        ]);
      } else {
        throw err;
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function shouldSkipAutoUpdate(rawArgs: string[]): boolean {
  const skipFlags = new Set<string>([
    CLI_FLAGS.HELP,
    CLI_FLAGS.HELP_SHORT,
    CLI_FLAGS.VERSION,
    CLI_FLAGS.VERSION_SHORT,
    CLI_FLAGS.NON_INTERACTIVE,
    CLI_FLAGS.NON_INTERACTIVE_CAMEL,
  ]);
  if (rawArgs.some((arg) => skipFlags.has(arg))) {
    return true;
  }
  return rawArgs.some((arg) => isUpdateCommandAlias(arg));
}

export function shouldPromptForDeferredUpdate(rawArgs: string[]): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  return !shouldSkipAutoUpdate(rawArgs);
}

export function kickOffAutoUpdate(
  currentVersion: string,
  rawArgs: string[],
): void {
  if (shouldSkipAutoUpdate(rawArgs)) {
    return;
  }
  void runAutoUpdate(currentVersion);
}

async function runAutoUpdate(currentVersion: string): Promise<void> {
  try {
    const state = await readUpdateState();
    const autoUpdateEnabled = state.autoUpdate !== false;
    const autoInstallEnabled = state.autoInstall === true;
    if (!autoUpdateEnabled) {
      return;
    }
    const lastChecked = state.lastCheckedAt
      ? Date.parse(state.lastCheckedAt)
      : NaN;
    if (!Number.isNaN(lastChecked)) {
      const elapsed = Date.now() - lastChecked;
      if (elapsed < AUTO_UPDATE_INTERVAL_MS) {
        return;
      }
    }

    const release = await fetchLatestRelease({
      currentVersion,
      timeoutMs: 800,
    });
    const nowIso = new Date().toISOString();
    const nextState: UpdateState = {
      ...state,
      lastCheckedAt: nowIso,
    };

    const comparison = compareVersions(release.tag_name, currentVersion);
    if (comparison !== null && comparison <= 0) {
      await writeUpdateState(clearPendingUpdateState(nextState));
      return;
    }
    const pendingState = withPendingUpdateState(
      nextState,
      release.tag_name,
      nowIso,
    );
    if (state.lastNotifiedVersion === release.tag_name) {
      await writeUpdateState(pendingState);
      return;
    }
    const updateCommand = getPreferredUpdateCommand();
    const homebrewManaged = updateCommand === UPDATE_COMMAND_BREW;
    if (homebrewManaged) {
      printHint(
        `New version available: ${release.tag_name}. Run \`${updateCommand}\`.`,
      );
      await writeUpdateState({
        ...pendingState,
        lastNotifiedVersion: release.tag_name,
      });
      return;
    }
    if (autoInstallEnabled) {
      try {
        const assetUrl = resolveAssetUrl(release);
        const targetPath = resolveExecutablePath();
        await downloadAndInstall(assetUrl, targetPath, currentVersion);
        printHint(`Auto-updated jenkins-cli to ${release.tag_name}.`);
        await writeUpdateState({
          ...clearPendingUpdateState(pendingState),
          lastNotifiedVersion: release.tag_name,
        });
      } catch {
        await writeUpdateState(pendingState);
      }
      return;
    }

    printHint(
      `New version available: ${release.tag_name}. Run \`${updateCommand}\`.`,
    );

    await writeUpdateState({
      ...pendingState,
      lastNotifiedVersion: release.tag_name,
    });
  } catch {
    // Best-effort only; ignore failures.
  }
}
