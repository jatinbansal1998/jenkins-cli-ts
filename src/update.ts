import os from "node:os";
import path from "node:path";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { CliError, printHint } from "./cli";
import { CONFIG_DIR } from "./config";

const REPO_SLUG = "jatinbansal1998/jenkins-cli-ts";
const API_ROOT = `https://api.github.com/repos/${REPO_SLUG}`;
const ASSET_NAME = "jenkins-cli";
const AUTO_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_STATE_FILE = path.join(CONFIG_DIR, "update-state.json");

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type ReleaseInfo = {
  tag_name: string;
  assets: ReleaseAsset[];
};

export type UpdateState = {
  autoUpdate?: boolean;
  autoInstall?: boolean;
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  pendingVersion?: string;
  pendingDetectedAt?: string;
  dismissedVersion?: string;
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
  const main = cleaned.split("-")[0];
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
      "Install the global CLI and re-run `jenkins-cli update`.",
    ]);
  }
  return resolved;
}

export async function fetchLatestRelease(options?: {
  timeoutMs?: number;
}): Promise<ReleaseInfo> {
  return await fetchRelease("releases/latest", options);
}

export async function fetchReleaseByTag(
  tag: string,
  options?: { timeoutMs?: number },
): Promise<ReleaseInfo> {
  const normalized = normalizeVersionTag(tag);
  return await fetchRelease(`releases/tags/${normalized}`, options);
}

function getTimer(timeoutMs?: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timeout.unref === "function") {
      timeout.unref();
    }
  }
  return {
    controller,
    cleanup: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  };
}

async function fetchRelease(
  endpoint: string,
  options?: { timeoutMs?: number },
): Promise<ReleaseInfo> {
  const { controller, cleanup } = getTimer(options?.timeoutMs);
  try {
    const response = await fetch(`${API_ROOT}/${endpoint}`, {
      headers: {
        "User-Agent": "jenkins-cli",
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CliError(
        `Failed to fetch release info (HTTP ${response.status}).`,
        [
          "Check your network connection.",
          "GitHub API rate limits can also cause failures.",
        ],
      );
    }
    const payload = (await response.json()) as ReleaseInfo;
    if (!payload.tag_name || !Array.isArray(payload.assets)) {
      throw new CliError("Unexpected release payload from GitHub.");
    }
    return payload;
  } finally {
    cleanup();
  }
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
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jenkins-cli-"));
  const tempFile = path.join(tempDir, "jenkins-cli");
  try {
    const response = await fetch(assetUrl, {
      headers: {
        "User-Agent": "jenkins-cli",
      },
    });
    if (!response.ok) {
      throw new CliError(`Failed to download CLI (HTTP ${response.status}).`, [
        "Check the release assets or try again later.",
      ]);
    }
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
  const skipFlags = new Set([
    "--help",
    "-h",
    "--version",
    "-v",
    "--non-interactive",
    "--nonInteractive",
  ]);
  if (rawArgs.some((arg) => skipFlags.has(arg))) {
    return true;
  }
  if (rawArgs.some((arg) => arg === "update" || arg === "upgrade")) {
    return true;
  }
  return false;
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

    const release = await fetchLatestRelease({ timeoutMs: 800 });
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
    if (autoInstallEnabled) {
      try {
        const assetUrl = resolveAssetUrl(release);
        const targetPath = resolveExecutablePath();
        await downloadAndInstall(assetUrl, targetPath);
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
      `New version available: ${release.tag_name}. Run \`jenkins-cli update\`.`,
    );

    await writeUpdateState({
      ...pendingState,
      lastNotifiedVersion: release.tag_name,
    });
  } catch {
    // Best-effort only; ignore failures.
  }
}
