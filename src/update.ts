import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import parseSemver from "semver/functions/parse";
import { lock } from "proper-lockfile";
import {
  CLI_FLAGS,
  UPDATE_COMMAND_BREW,
  UPDATE_COMMAND_SELF,
} from "./cli-constants";
import {
  isJsonLinesOutputRequested,
  isJsonOutputRequested,
} from "./cli/options";
import { CliError, printHint } from "./cli";
import { CONFIG_DIR } from "./config";
import { selfInvocation } from "./self-invocation";
import {
  downloadReleaseAsset,
  fetchLatestRelease,
  type GitHubReleaseInfo as ReleaseInfo,
} from "./github/api-wrapper";
import {
  isSupportedRuntimeArch,
  isSupportedRuntimePlatform,
  resolveNativeReleaseTarget,
} from "./release-targets";

export function parseLddProbeOutput(text: string): boolean | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("musl")) {
    return true;
  }
  if (
    normalized.includes("glibc") ||
    normalized.includes("gnu libc") ||
    normalized.includes("gnu c library")
  ) {
    return false;
  }
  return null;
}

function runProbe(cmd: string[]): { success: boolean; text: string } | null {
  try {
    const proc = Bun.spawnSync({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text =
      new TextDecoder().decode(proc.stdout ?? undefined) +
      new TextDecoder().decode(proc.stderr ?? undefined);
    return {
      success: proc.success,
      text,
    };
  } catch {
    return null;
  }
}

function detectMusl(): boolean | null {
  const versionProbe = runProbe(["ldd", "--version"]);
  if (versionProbe) {
    const parsed = parseLddProbeOutput(versionProbe.text);
    if (parsed !== null) {
      return parsed;
    }
  }

  const shellProbe = runProbe(["ldd", "/bin/sh"]);
  if (shellProbe) {
    const parsed = parseLddProbeOutput(shellProbe.text);
    if (parsed !== null) {
      return parsed;
    }
  }

  try {
    const selfExe = readFileSync("/proc/self/exe", "latin1");
    if (selfExe.toLowerCase().includes("musl")) {
      return true;
    }
  } catch {}

  return null;
}

export function resolveAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (!isSupportedRuntimePlatform(platform)) {
    throw new CliError(`Unsupported platform: ${platform}`);
  }

  if (!isSupportedRuntimeArch(arch)) {
    throw new CliError(`Unsupported architecture: ${arch}`);
  }

  let libc: "gnu" | "musl" | undefined;
  if (platform === "linux") {
    const isMusl = detectMusl();
    if (isMusl === null) {
      throw new CliError("Unable to reliably detect libc on Linux.", [
        "Cannot determine if the system uses glibc or musl.",
        "Please download the binary manually from GitHub Releases.",
      ]);
    }
    libc = isMusl ? "musl" : "gnu";
  }

  const target = resolveNativeReleaseTarget({
    platform,
    arch,
    libc,
  });
  if (!target) {
    throw new CliError(
      `No release target found for platform ${platform} (${arch}).`,
    );
  }
  return target.assetName;
}

const HOMEBREW_CELLAR_SEGMENT = `${path.sep}Cellar${path.sep}jenkins-cli${path.sep}`;
const AUTO_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_STATE_FILE = path.join(CONFIG_DIR, "update-state.json");

type UpdateChannel = "stable" | "prerelease";

export type UpdateState = {
  updateChannel?: UpdateChannel;
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  minAllowedVersion?: string;
  minAllowedMessage?: string;
  minAllowedFetchedAt?: string;
  minAllowedSourceUrl?: string;
};

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

export function compareVersions(a: string, b: string): number | null {
  const aVersion = parseSemver(stripVersionPrefix(a));
  const bVersion = parseSemver(stripVersionPrefix(b));
  return aVersion && bVersion ? aVersion.compare(bVersion) : null;
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

export async function patchUpdateState(patch: UpdateState): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const release = await lock(UPDATE_STATE_FILE, {
    realpath: false,
    retries: { retries: 12, minTimeout: 20, maxTimeout: 100 },
  });
  const temporaryPath = `${UPDATE_STATE_FILE}.${process.pid}.tmp`;
  try {
    const state = await readUpdateState();
    const payload = `${JSON.stringify({ ...state, ...patch }, null, 2)}\n`;
    await Bun.write(temporaryPath, payload, { mode: 0o600 });
    await rename(temporaryPath, UPDATE_STATE_FILE);
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } finally {
      await release();
    }
  }
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

export function resolveReleaseAsset(release: ReleaseInfo): string {
  const assetName = resolveAssetName();
  const platformAsset = release.assets.find((item) => item.name === assetName);
  if (platformAsset) {
    return platformAsset.browser_download_url;
  }

  throw new CliError(
    `Release asset "${assetName}" not found for ${release.tag_name}.`,
    [
      "Ensure the GitHub release includes a platform-specific binary.",
      `Expected asset name: ${assetName}`,
    ],
  );
}

export function getReleaseInstallDecision(options: {
  release: ReleaseInfo;
  currentVersion: string;
}): boolean {
  const comparison = compareVersions(
    options.release.tag_name,
    options.currentVersion,
  );
  return comparison === null || comparison > 0;
}

export function extractInstalledBinaryVersionOutput(
  stdout: Uint8Array | undefined,
  stderr: Uint8Array | undefined,
): string | null {
  const text =
    new TextDecoder().decode(stdout ?? undefined) +
    new TextDecoder().decode(stderr ?? undefined);
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? null;
}

export function describeInstalledBinary(executablePath: string): string | null {
  try {
    const proc = Bun.spawnSync({
      cmd: [executablePath, "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    return extractInstalledBinaryVersionOutput(
      proc.stdout ?? undefined,
      proc.stderr ?? undefined,
    );
  } catch {
    return null;
  }
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
    const bytes = await response.bytes();
    await Bun.write(tempFile, bytes);

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
  if (isJsonOutputRequested(rawArgs) || isJsonLinesOutputRequested(rawArgs)) {
    return true;
  }
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
  return rawArgs.includes("update");
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
    const checkedState: UpdateState = { lastCheckedAt: nowIso };

    const updateCommand = getPreferredUpdateCommand();
    const homebrewManaged = updateCommand === UPDATE_COMMAND_BREW;
    const shouldInstall = getReleaseInstallDecision({
      release,
      currentVersion,
    });
    if (!shouldInstall) {
      await patchUpdateState(checkedState);
      return;
    }
    if (
      (homebrewManaged || process.platform === "win32") &&
      state.lastNotifiedVersion === release.tag_name
    ) {
      await patchUpdateState(checkedState);
      return;
    }
    if (homebrewManaged) {
      printHint(
        `New version available: ${release.tag_name}. Run \`${updateCommand}\`.`,
      );
      await patchUpdateState({
        ...checkedState,
        lastNotifiedVersion: release.tag_name,
      });
      return;
    }
    if (process.platform !== "win32") {
      try {
        // Source checkouts cannot be replaced with a release binary.
        resolveExecutablePath();
        await patchUpdateState(checkedState);
        Bun.spawn({
          cmd: selfInvocation(["update", release.tag_name]),
          stdio: ["ignore", "ignore", "ignore"],
          detached: true,
          windowsHide: true,
        }).unref();
      } catch {
        await patchUpdateState(checkedState);
      }
      return;
    }

    printHint(
      `New version available: ${release.tag_name}. Run \`${updateCommand}\`.`,
    );

    await patchUpdateState({
      ...checkedState,
      lastNotifiedVersion: release.tag_name,
    });
  } catch {
    // Best-effort only; ignore failures.
  }
}
