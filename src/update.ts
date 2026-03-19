import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
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

function detectMusl(): boolean | null {
  try {
    const proc = Bun.spawnSync({
      cmd: ["ldd", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const text =
      new TextDecoder().decode(proc.stdout ?? undefined) +
      new TextDecoder().decode(proc.stderr ?? undefined);
    if (text.toLowerCase().includes("musl")) {
      return true;
    }
    if (!proc.success) {
      try {
        const selfExe = readFileSync("/proc/self/exe", "latin1");
        if (selfExe.toLowerCase().includes("musl")) {
          return true;
        }
      } catch {}
    }
    return false;
  } catch {
    return null;
  }
}

export function isBunAvailable(): boolean {
  try {
    const proc = Bun.spawnSync({
      cmd: ["bun", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.success;
  } catch {
    return false;
  }
}

export function resolveAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    if (arch !== "x64") {
      throw new CliError(`Unsupported architecture on Windows: ${arch}`);
    }
    return "jenkins-cli-windows-x64.exe";
  }

  if (platform !== "darwin" && platform !== "linux") {
    throw new CliError(`Unsupported platform: ${platform}`);
  }

  if (arch !== "x64" && arch !== "arm64") {
    throw new CliError(`Unsupported architecture: ${arch}`);
  }

  if (platform === "linux") {
    const isMusl = detectMusl();
    if (isMusl === null) {
      throw new CliError("Unable to reliably detect libc on Linux.", [
        "Cannot determine if the system uses glibc or musl.",
        "Please download the binary manually from GitHub Releases.",
      ]);
    }
    if (isMusl) {
      return `jenkins-cli-linux-${arch}-musl`;
    }
  }

  return `jenkins-cli-${platform}-${arch}`;
}

const HOMEBREW_CELLAR_SEGMENT = `${path.sep}Cellar${path.sep}jenkins-cli${path.sep}`;
const AUTO_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_STATE_FILE = path.join(CONFIG_DIR, "update-state.json");

export type UpdateChannel = "stable" | "prerelease";

export type UpdateState = {
  autoUpdate?: boolean;
  autoInstall?: boolean;
  updateChannel?: UpdateChannel;
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

export function parseUpdateChannel(input: string): UpdateChannel | null {
  const normalized = input.trim().toLowerCase();
  switch (normalized) {
    case "stable":
      return "stable";
    case "prerelease":
    case "pre-release":
      return "prerelease";
    default:
      return null;
  }
}

export function resolveUpdateChannel(
  state: Pick<UpdateState, "updateChannel">,
): UpdateChannel {
  return state.updateChannel === "prerelease" ? "prerelease" : "stable";
}

function stripVersionPrefix(input: string): string {
  return input.trim().replace(/^v/i, "");
}

type ParsedVersion = {
  main: number[];
  prerelease: string[] | null;
};

function parseVersion(input: string): ParsedVersion | null {
  const cleaned = stripVersionPrefix(input).split("+")[0]?.trim();
  if (!cleaned) {
    return null;
  }
  const match =
    /^(?<main>\d+(?:\.\d+)*)(?:-(?<prerelease>[0-9A-Za-z.-]+))?$/.exec(cleaned);
  const main = match?.groups?.main;
  if (!main) {
    return null;
  }
  const numbers = main.split(".").map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN;
    }
    return Number(part);
  });
  if (numbers.some((part) => Number.isNaN(part))) {
    return null;
  }
  const prerelease = match?.groups?.prerelease?.split(".") ?? null;
  return {
    main: numbers,
    prerelease,
  };
}

export function compareVersions(a: string, b: string): number | null {
  const aVersion = parseVersion(a);
  const bVersion = parseVersion(b);
  if (!aVersion || !bVersion) {
    return null;
  }
  const length = Math.max(aVersion.main.length, bVersion.main.length, 3);
  for (let i = 0; i < length; i += 1) {
    const aValue = aVersion.main[i] ?? 0;
    const bValue = bVersion.main[i] ?? 0;
    if (aValue > bValue) {
      return 1;
    }
    if (aValue < bValue) {
      return -1;
    }
  }

  if (!aVersion.prerelease && !bVersion.prerelease) {
    return 0;
  }
  if (!aVersion.prerelease) {
    return 1;
  }
  if (!bVersion.prerelease) {
    return -1;
  }

  const prereleaseLength = Math.max(
    aVersion.prerelease.length,
    bVersion.prerelease.length,
  );
  for (let i = 0; i < prereleaseLength; i += 1) {
    const aIdentifier = aVersion.prerelease[i];
    const bIdentifier = bVersion.prerelease[i];
    if (aIdentifier === undefined) {
      return -1;
    }
    if (bIdentifier === undefined) {
      return 1;
    }
    if (aIdentifier === bIdentifier) {
      continue;
    }

    const aNumeric = /^\d+$/.test(aIdentifier);
    const bNumeric = /^\d+$/.test(bIdentifier);
    if (aNumeric && bNumeric) {
      const aValue = Number(aIdentifier);
      const bValue = Number(bIdentifier);
      if (aValue > bValue) {
        return 1;
      }
      if (aValue < bValue) {
        return -1;
      }
      continue;
    }
    if (aNumeric) {
      return -1;
    }
    if (bNumeric) {
      return 1;
    }
    return aIdentifier.localeCompare(bIdentifier);
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

  // Bun compiled binaries expose an embedded entrypoint (e.g. /$bunfs/root/...)
  // in process.argv[1], whereas process.execPath points to the actual executable.
  const resolved = argv1.startsWith("/$bunfs/")
    ? process.execPath
    : path.resolve(argv1);

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
  const resolved = argv1.startsWith("/$bunfs/")
    ? process.execPath
    : path.resolve(argv1);
  return isHomebrewManagedPath(resolved)
    ? UPDATE_COMMAND_BREW
    : UPDATE_COMMAND_SELF;
}

export async function fetchLatestRelease(options: {
  currentVersion: string;
  channel?: UpdateChannel;
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

export type ResolvedReleaseAsset = {
  url: string;
  isLegacyBundle: boolean;
};

export function resolveReleaseAsset(
  release: ReleaseInfo,
): ResolvedReleaseAsset {
  const assetName = resolveAssetName();
  const platformAsset = release.assets.find((item) => item.name === assetName);
  if (platformAsset) {
    return {
      url: platformAsset.browser_download_url,
      isLegacyBundle: false,
    };
  }

  const legacyNames = ["jenkins-cli"];
  const legacyAsset = release.assets.find((item) =>
    legacyNames.includes(item.name),
  );
  if (legacyAsset && isBunAvailable()) {
    return {
      url: legacyAsset.browser_download_url,
      isLegacyBundle: true,
    };
  }

  throw new CliError(
    `Release asset "${assetName}" not found for ${release.tag_name}.`,
    [
      "Ensure the GitHub release includes either a platform-specific binary or the generic jenkins-cli bundle.",
      `Expected asset name: ${assetName}`,
    ],
  );
}

export async function downloadAndInstall(
  assetUrl: string,
  targetPath: string,
  currentVersion: string,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jenkins-cli-"));
  const isWindows = process.platform === "win32";
  const tempFile = path.join(
    tempDir,
    isWindows ? "jenkins-cli.exe" : "jenkins-cli",
  );
  try {
    const response = await downloadReleaseAsset({
      assetUrl,
      currentVersion,
    });
    await Bun.write(tempFile, response);

    if (isWindows) {
      throw new CliError(
        "In-place updates are not yet perfectly supported on Windows.",
        [
          `The update was downloaded to a temporary location: ${tempFile}`,
          `Please close the application and replace your executable (${targetPath}) manually.`,
        ],
      );
    }

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
    if (!isWindows) {
      await rm(tempDir, { recursive: true, force: true });
    }
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
      channel: resolveUpdateChannel(state),
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
    if (autoInstallEnabled && process.platform !== "win32") {
      try {
        const asset = resolveReleaseAsset(release);
        const targetPath = resolveExecutablePath();
        await downloadAndInstall(asset.url, targetPath, currentVersion);
        printHint(`Auto-updated jenkins-cli to ${release.tag_name}.`);
        if (asset.isLegacyBundle) {
          printHint(
            "Native binary not available for this platform/version. Installed the generic jenkins-cli bundle instead.",
          );
          printHint("Bun must be installed on this machine to run this CLI.");
        }
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
