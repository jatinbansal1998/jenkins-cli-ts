/**
 * Update command implementation.
 */
import { CliError, printHint, printOk } from "../cli";
import { UPDATE_COMMAND_BREW } from "../cli-constants";
import { fetchLatestRelease } from "../github/api-wrapper";
import {
  clearPendingUpdateState,
  describeInstalledBinary,
  downloadAndInstall,
  fetchReleaseByTag,
  getReleaseInstallDecision,
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
import {
  type JsonUpdateCheck,
  runJsonCommand,
  type JsonWrite,
} from "../json-output";

type UpdateOptions = {
  currentVersion: string;
  tag?: string;
  check?: boolean;
  channel?: string;
  json?: boolean;
  write?: JsonWrite;
};

export async function runUpdate(options: UpdateOptions): Promise<void> {
  if (options.json) {
    await runJsonCommand("update", async () => runUpdateCheckJson(options), {
      write: options.write,
    });
    return;
  }
  const preferredUpdateCommand = getPreferredUpdateCommand();
  const requestedChannel =
    typeof options.channel === "string"
      ? parseUpdateChannel(options.channel)
      : undefined;

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

  const hasSettingsChange = requestedChannel !== undefined;

  if (hasSettingsChange) {
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
    const installDecision = getReleaseInstallDecision({
      release: latest,
      currentVersion: options.currentVersion,
    });
    const checkedState: UpdateState = {
      ...effectiveState,
      lastCheckedAt: nowIso,
    };
    if (!installDecision.shouldInstall) {
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
  const installDecision = requestedVersion
    ? undefined
    : getReleaseInstallDecision({
        release,
        currentVersion: options.currentVersion,
      });

  if (!requestedVersion && installDecision && !installDecision.shouldInstall) {
    printOk(`Already on latest version (${options.currentVersion}).`);
    return;
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
  const installedBinaryDescription =
    describeInstalledBinary(targetPath) ?? release.tag_name;
  printOk(`Updated jenkins-cli: ${installedBinaryDescription}.`);
}

async function runUpdateCheckJson(
  options: UpdateOptions,
): Promise<JsonUpdateCheck> {
  if (!options.check) {
    throw new CliError("--json is supported only with update --check.", [
      "Pass --check to inspect update availability without installing.",
    ]);
  }
  if (options.tag) {
    throw new CliError("--json --check cannot be combined with a version tag.");
  }
  const requestedChannel =
    typeof options.channel === "string"
      ? parseUpdateChannel(options.channel)
      : undefined;
  if (options.channel && !requestedChannel) {
    throw new CliError(`Unknown update channel "${options.channel}".`, [
      "Use one of: stable, prerelease.",
    ]);
  }
  const state = await readUpdateState();
  const effectiveState = requestedChannel
    ? { ...state, updateChannel: requestedChannel }
    : state;
  const channel = resolveUpdateChannel(effectiveState);
  const latest = await fetchLatestRelease({
    currentVersion: options.currentVersion,
    channel,
  });
  const installDecision = getReleaseInstallDecision({
    release: latest,
    currentVersion: options.currentVersion,
  });
  const checkedAt = new Date().toISOString();
  const checkedState = { ...effectiveState, lastCheckedAt: checkedAt };
  await writeUpdateState(
    installDecision.shouldInstall
      ? withPendingUpdateState(checkedState, latest.tag_name, checkedAt)
      : clearPendingUpdateState(checkedState),
  );
  return {
    currentVersion: options.currentVersion,
    latestVersion: latest.tag_name,
    updateAvailable: installDecision.shouldInstall,
    channel,
    installReason: installDecision.reason,
    checkedAt,
  };
}

function printUpdatePreferences(state: UpdateState): void {
  printOk(`Update channel: ${resolveUpdateChannel(state)}.`);
}

async function recordSuccessfulUpdate(version: string): Promise<void> {
  const state = await readUpdateState();
  await writeUpdateState({
    ...clearPendingUpdateState(state),
    lastCheckedAt: new Date().toISOString(),
    lastNotifiedVersion: version,
  });
}
