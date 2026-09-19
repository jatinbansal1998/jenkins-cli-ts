/**
 * Update command implementation.
 */
import { CliError, printHint, printOk } from "../cli";
import { withTimeout } from "../with-timeout";
import { UPDATE_COMMAND_BREW } from "../cli-constants";
import { fetchLatestRelease, fetchReleaseByTag } from "../github/api-wrapper";
import {
  describeInstalledBinary,
  downloadAndInstall,
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
  patchUpdateState,
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
  const { controller, cleanup } = withTimeout(5 * 60_000);
  // The updater owns this deadline so it survives the foreground CLI exiting.
  // Allow cancellation to remove temporary downloads before forcing termination.
  const exitDeadline = setTimeout(() => process.exit(1), 5 * 60_000 + 5_000);
  exitDeadline.unref();
  try {
    if (options.json) {
      await runJsonCommand(
        "update",
        async () => runUpdateCheckJson(options, controller.signal),
        {
          write: options.write,
        },
      );
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
    if (requestedChannel) {
      state.updateChannel = requestedChannel;
      await patchUpdateState({ updateChannel: requestedChannel });
      if (!options.check && !options.tag) {
        printUpdateChannel(state);
        return;
      }
    }

    const updateChannel = resolveUpdateChannel(state);
    const requestedVersion = options.tag?.trim();
    console.log(`Current version: ${options.currentVersion}`);
    if (requestedVersion) {
      console.log(
        `Checking for version ${normalizeVersionTag(requestedVersion)}...`,
      );
    } else if (updateChannel === "prerelease") {
      console.log("Checking for updates on prerelease channel...");
    } else {
      console.log("Checking for updates to latest version...");
    }

    if (options.check) {
      const latest = await fetchLatestRelease({
        currentVersion: options.currentVersion,
        signal: controller.signal,
        channel: updateChannel,
      });
      const nowIso = new Date().toISOString();
      const shouldInstall = getReleaseInstallDecision({
        release: latest,
        currentVersion: options.currentVersion,
      });
      await patchUpdateState({ lastCheckedAt: nowIso });
      if (!shouldInstall) {
        printOk(`Already on latest version (${options.currentVersion}).`);
      } else {
        printOk(`Latest version is ${latest.tag_name}.`);
        printHint(`Run \`${preferredUpdateCommand}\` to install it.`);
      }
      printUpdateChannel(state);
      return;
    }

    const release = requestedVersion
      ? await fetchReleaseByTag(normalizeVersionTag(requestedVersion), {
          currentVersion: options.currentVersion,
          signal: controller.signal,
        })
      : await fetchLatestRelease({
          currentVersion: options.currentVersion,
          signal: controller.signal,
          channel: updateChannel,
        });
    const shouldInstall = requestedVersion
      ? true
      : getReleaseInstallDecision({
          release,
          currentVersion: options.currentVersion,
        });

    if (!shouldInstall) {
      printOk(`Already on latest version (${options.currentVersion}).`);
      return;
    }

    const assetUrl = resolveReleaseAsset(release);
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
    const targetVersion = release.tag_name.replace(/^v/, "");
    console.log(`Updating to ${targetVersion}...`);
    await downloadAndInstall(
      assetUrl,
      targetPath,
      options.currentVersion,
      controller.signal,
    );

    await recordSuccessfulUpdate(release.tag_name);
    const installedBinaryDescription =
      describeInstalledBinary(targetPath) ?? targetVersion;
    printOk(
      `Successfully updated from ${options.currentVersion} to version ${installedBinaryDescription}.`,
    );
  } finally {
    cleanup();
    clearTimeout(exitDeadline);
  }
}

async function runUpdateCheckJson(
  options: UpdateOptions,
  signal: AbortSignal,
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
    signal,
  });
  const shouldInstall = getReleaseInstallDecision({
    release: latest,
    currentVersion: options.currentVersion,
  });
  const checkedAt = new Date().toISOString();
  await patchUpdateState({
    ...(requestedChannel ? { updateChannel: requestedChannel } : {}),
    lastCheckedAt: checkedAt,
  });
  return {
    currentVersion: options.currentVersion,
    latestVersion: latest.tag_name,
    updateAvailable: shouldInstall,
    channel,
    checkedAt,
  };
}

function printUpdateChannel(state: UpdateState): void {
  printOk(`Update channel: ${resolveUpdateChannel(state)}.`);
}

async function recordSuccessfulUpdate(version: string): Promise<void> {
  await patchUpdateState({
    lastCheckedAt: new Date().toISOString(),
    lastNotifiedVersion: version,
  });
}
