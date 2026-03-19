/**
 * Update command implementation.
 */
import { CliError, printHint, printOk } from "../cli";
import { UPDATE_COMMAND_BREW } from "../cli-constants";
import {
  clearPendingUpdateState,
  compareVersions,
  downloadAndInstall,
  fetchLatestRelease,
  fetchReleaseByTag,
  getPreferredUpdateCommand,
  isHomebrewManagedPath,
  normalizeVersionTag,
  parseUpdateChannel,
  readUpdateState,
  resolveReleaseAsset,
  resolveUpdateChannel,
  resolveExecutablePath,
  type UpdateState,
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
  channel?: string;
};

export async function runUpdate(options: UpdateOptions): Promise<void> {
  const preferredUpdateCommand = getPreferredUpdateCommand();
  const homebrewManaged = preferredUpdateCommand === UPDATE_COMMAND_BREW;
  const requestedChannel =
    typeof options.channel === "string"
      ? parseUpdateChannel(options.channel)
      : undefined;

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
  if (options.channel && !requestedChannel) {
    throw new CliError(`Unknown update channel "${options.channel}".`, [
      "Use one of: stable, prerelease.",
    ]);
  }

  const state = await readUpdateState();
  const nextState: UpdateState = { ...state };
  if (requestedChannel) {
    nextState.updateChannel = requestedChannel;
  }

  const hasSettingsChange =
    options.enableAuto ||
    options.disableAuto ||
    options.enableAutoInstall ||
    options.disableAutoInstall ||
    requestedChannel !== undefined;

  if (hasSettingsChange) {
    if (options.enableAutoInstall && homebrewManaged) {
      throw new CliError(
        "Auto-install is not supported for Homebrew-managed installs.",
        [`Use \`${UPDATE_COMMAND_BREW}\` to apply updates.`],
      );
    }

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
    if (!options.check && !options.tag) {
      printUpdatePreferences(nextState);
      return;
    }
  }

  const effectiveState = hasSettingsChange ? nextState : state;
  const updateChannel = resolveUpdateChannel(effectiveState);

  if (options.check) {
    const latest = await fetchLatestRelease({
      currentVersion: options.currentVersion,
      channel: updateChannel,
    });
    const nowIso = new Date().toISOString();
    const comparison = compareVersions(latest.tag_name, options.currentVersion);
    const checkedState: UpdateState = {
      ...effectiveState,
      lastCheckedAt: nowIso,
    };
    if (comparison !== null && comparison <= 0) {
      printOk(`Already on latest version (${options.currentVersion}).`);
      await writeUpdateState(clearPendingUpdateState(checkedState));
    } else {
      printOk(`Latest version is ${latest.tag_name}.`);
      printHint(`Run \`${preferredUpdateCommand}\` to install it.`);
      await writeUpdateState(
        withPendingUpdateState(checkedState, latest.tag_name, nowIso),
      );
    }
    printUpdatePreferences(effectiveState);
    return;
  }

  const requestedVersion = options.tag?.trim();
  const release = requestedVersion
    ? await fetchReleaseByTag(normalizeVersionTag(requestedVersion), {
        currentVersion: options.currentVersion,
      })
    : await fetchLatestRelease({
        currentVersion: options.currentVersion,
        channel: updateChannel,
      });

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

  const asset = resolveReleaseAsset(release);
  const targetPath = resolveExecutablePath();
  if (isHomebrewManagedPath(targetPath)) {
    throw new CliError(
      "This jenkins-cli installation is managed by Homebrew.",
      [
        `Use \`${UPDATE_COMMAND_BREW}\` to update.`,
        requestedVersion
          ? "Installing a specific tag is not supported via Homebrew installs."
          : "Homebrew keeps the installed binary and metadata in sync.",
      ],
    );
  }
  await downloadAndInstall(asset.url, targetPath, options.currentVersion);

  await recordSuccessfulUpdate(release.tag_name);
  printOk(`Updated jenkins-cli to ${release.tag_name}.`);
  if (asset.isLegacyBundle) {
    printHint(
      "Native binary not available for this platform/version. Installed the generic jenkins-cli bundle instead.",
    );
    printHint("Bun must be installed on this machine to run this CLI.");
  }
}

function printUpdatePreferences(state: UpdateState): void {
  const autoUpdateEnabled = state.autoUpdate !== false;
  const autoInstallEnabled = state.autoInstall === true;
  const updateChannel = resolveUpdateChannel(state);
  printOk(
    `Auto-update checks: ${autoUpdateEnabled ? "enabled (notify only)" : "disabled"}.`,
  );
  printOk(`Auto-install: ${autoInstallEnabled ? "enabled" : "disabled"}.`);
  printOk(`Update channel: ${updateChannel}.`);
}

async function recordSuccessfulUpdate(version: string): Promise<void> {
  const state = await readUpdateState();
  await writeUpdateState({
    ...clearPendingUpdateState(state),
    lastCheckedAt: new Date().toISOString(),
    lastNotifiedVersion: version,
  });
}
