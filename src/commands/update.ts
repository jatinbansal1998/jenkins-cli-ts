/**
 * Update command implementation.
 */
import { CliError, printHint, printOk } from "../cli";
import {
  clearPendingUpdateState,
  compareVersions,
  downloadAndInstall,
  fetchLatestRelease,
  fetchReleaseByTag,
  normalizeVersionTag,
  readUpdateState,
  resolveAssetUrl,
  resolveExecutablePath,
  withPendingUpdateState,
  writeUpdateState,
} from "../update";

type UpdateOptions = {
  currentVersion: string;
  tag?: string;
  check?: boolean;
  enableAuto?: boolean;
  disableAuto?: boolean;
  enableAutoInstall?: boolean;
  disableAutoInstall?: boolean;
};

export async function runUpdate(options: UpdateOptions): Promise<void> {
  if (options.enableAuto && options.disableAuto) {
    throw new CliError("Cannot use --enable-auto and --disable-auto together.");
  }
  if (options.enableAutoInstall && options.disableAutoInstall) {
    throw new CliError(
      "Cannot use --enable-auto-install and --disable-auto-install together.",
    );
  }
  if (options.check && options.tag) {
    throw new CliError("Cannot use --check with a version tag.");
  }

  if (
    options.enableAuto ||
    options.disableAuto ||
    options.enableAutoInstall ||
    options.disableAutoInstall
  ) {
    const state = await readUpdateState();
    const nextState = { ...state };

    if (options.enableAuto) {
      nextState.autoUpdate = true;
    }
    if (options.disableAuto) {
      nextState.autoUpdate = false;
      nextState.autoInstall = false;
    }
    if (options.enableAutoInstall) {
      nextState.autoInstall = true;
      nextState.autoUpdate = true;
    }
    if (options.disableAutoInstall) {
      nextState.autoInstall = false;
    }

    await writeUpdateState(nextState);
    const autoUpdateEnabled = nextState.autoUpdate !== false;
    const autoInstallEnabled = nextState.autoInstall === true;
    printOk(
      `Auto-update checks: ${autoUpdateEnabled ? "enabled (notify only)" : "disabled"}.`,
    );
    printOk(`Auto-install: ${autoInstallEnabled ? "enabled" : "disabled"}.`);
    return;
  }

  if (options.check) {
    const state = await readUpdateState();
    const autoUpdateEnabled = state.autoUpdate !== false;
    const autoInstallEnabled = state.autoInstall === true;
    const latest = await fetchLatestRelease();
    const nowIso = new Date().toISOString();
    const comparison = compareVersions(latest.tag_name, options.currentVersion);
    if (comparison !== null && comparison <= 0) {
      printOk(`Already on latest version (${options.currentVersion}).`);
      await writeUpdateState(
        clearPendingUpdateState({
          ...state,
          lastCheckedAt: nowIso,
        }),
      );
    } else {
      printOk(`Latest version is ${latest.tag_name}.`);
      printHint("Run `jenkins-cli update` to install it.");
      await writeUpdateState(
        withPendingUpdateState(
          {
            ...state,
            lastCheckedAt: nowIso,
          },
          latest.tag_name,
          nowIso,
        ),
      );
    }
    printOk(
      `Auto-update checks: ${autoUpdateEnabled ? "enabled (notify only)" : "disabled"}.`,
    );
    printOk(`Auto-install: ${autoInstallEnabled ? "enabled" : "disabled"}.`);
    return;
  }

  const requestedVersion = options.tag?.trim();
  const release = requestedVersion
    ? await fetchReleaseByTag(normalizeVersionTag(requestedVersion))
    : await fetchLatestRelease();

  if (!requestedVersion) {
    const comparison = compareVersions(
      release.tag_name,
      options.currentVersion,
    );
    if (comparison !== null && comparison <= 0) {
      printOk(`Already on latest version (${options.currentVersion}).`);
      return;
    }
  }

  const assetUrl = resolveAssetUrl(release);
  const targetPath = resolveExecutablePath();
  await downloadAndInstall(assetUrl, targetPath);

  await recordSuccessfulUpdate(release.tag_name);
  printOk(`Updated jenkins-cli to ${release.tag_name}.`);
}

async function recordSuccessfulUpdate(version: string): Promise<void> {
  const state = await readUpdateState();
  await writeUpdateState({
    ...clearPendingUpdateState(state),
    lastCheckedAt: new Date().toISOString(),
    lastNotifiedVersion: version,
  });
}
