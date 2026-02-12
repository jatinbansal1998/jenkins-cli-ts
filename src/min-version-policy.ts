import { CliError } from "./cli";
import { CLI_FLAGS, isUpdateCommandAlias } from "./cli-constants";
import { runUpdate } from "./commands/update";
import { GITHUB_VERSION_POLICY_URL } from "./github-constants";
import { fetchVersionPolicy } from "./github/api-wrapper";
import {
  compareVersions,
  getPreferredUpdateCommand,
  normalizeVersionTag,
  readUpdateState,
  writeUpdateState,
} from "./update";

const POLICY_URL = GITHUB_VERSION_POLICY_URL;
const POLICY_FETCH_TIMEOUT_MS = 800;
const POLICY_REFRESH_TTL_MS = 60 * 60 * 1000;

type EnforceMinimumVersionOptions = {
  currentVersion: string;
  rawArgs: string[];
};

type RefreshMinimumVersionOptions = {
  currentVersion: string;
};

type MinimumVersionPolicy = {
  minVersion: string;
  message?: string;
};

export async function enforceMinimumVersionFromCache(
  options: EnforceMinimumVersionOptions,
): Promise<void> {
  if (isUpdateCommand(options.rawArgs)) {
    return;
  }

  const state = await readUpdateState();
  const minAllowedVersion = state.minAllowedVersion?.trim();
  if (!minAllowedVersion) {
    return;
  }

  const comparison = compareVersions(options.currentVersion, minAllowedVersion);
  if (comparison === null || comparison >= 0) {
    return;
  }

  const updateCommand = getPreferredUpdateCommand();
  const mandatoryMessage = buildMandatoryUpdateMessage({
    currentVersion: options.currentVersion,
    minAllowedVersion,
    updateCommand,
    policyMessage: state.minAllowedMessage,
  });

  const error = new CliError(mandatoryMessage, [
    `Current version: ${options.currentVersion}.`,
    `Minimum required version: ${minAllowedVersion}.`,
    `Run \`${updateCommand}\` to update.`,
  ]);

  if (!isInteractive(options.rawArgs)) {
    throw error;
  }

  try {
    await runUpdate({ currentVersion: options.currentVersion });
  } catch {
    throw error;
  }
}

export function kickOffMinimumVersionRefresh(
  options: RefreshMinimumVersionOptions,
): void {
  void refreshMinimumVersionPolicy(options.currentVersion);
}

async function refreshMinimumVersionPolicy(
  currentVersion: string,
): Promise<void> {
  try {
    const state = await readUpdateState();
    if (!shouldRefreshPolicy(state.minAllowedFetchedAt)) {
      return;
    }

    const policy = await fetchMinimumVersionPolicy(currentVersion);
    if (!policy) {
      return;
    }

    await writeUpdateState({
      ...state,
      minAllowedVersion: policy.minVersion,
      minAllowedMessage: policy.message,
      minAllowedFetchedAt: new Date().toISOString(),
      minAllowedSourceUrl: POLICY_URL,
    });
  } catch {
    // Best-effort only; ignore failures.
  }
}

function shouldRefreshPolicy(lastFetchedAt: string | undefined): boolean {
  if (!lastFetchedAt) {
    return true;
  }
  const lastFetched = Date.parse(lastFetchedAt);
  if (Number.isNaN(lastFetched)) {
    return true;
  }
  return Date.now() - lastFetched >= POLICY_REFRESH_TTL_MS;
}

async function fetchMinimumVersionPolicy(
  currentVersion: string,
): Promise<MinimumVersionPolicy | null> {
  const payload = await fetchVersionPolicy({
    currentVersion,
    timeoutMs: POLICY_FETCH_TIMEOUT_MS,
    policyUrl: POLICY_URL,
  });
  if (!payload) {
    return null;
  }
  return parseMinimumVersionPolicy(payload);
}

function parseMinimumVersionPolicy(
  payload: unknown,
): MinimumVersionPolicy | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const minVersionValue =
    typeof record.minVersion === "string" ? record.minVersion.trim() : "";
  if (!minVersionValue) {
    return null;
  }

  const normalizedMinVersion = normalizeVersionTag(minVersionValue);
  if (compareVersions(normalizedMinVersion, "0.0.0") === null) {
    return null;
  }

  const messageValue =
    typeof record.message === "string" ? record.message.trim() : "";

  return {
    minVersion: normalizedMinVersion,
    ...(messageValue ? { message: messageValue } : {}),
  };
}

function isUpdateCommand(rawArgs: string[]): boolean {
  return rawArgs.some((arg) => isUpdateCommandAlias(arg));
}

function isInteractive(rawArgs: string[]): boolean {
  if (
    rawArgs.includes(CLI_FLAGS.NON_INTERACTIVE) ||
    rawArgs.includes(CLI_FLAGS.NON_INTERACTIVE_CAMEL)
  ) {
    return false;
  }
  return process.stdin.isTTY && process.stdout.isTTY;
}

function buildMandatoryUpdateMessage(options: {
  currentVersion: string;
  minAllowedVersion: string;
  updateCommand: string;
  policyMessage: string | undefined;
}): string {
  const policyMessage = options.policyMessage?.trim();
  if (policyMessage) {
    return `${policyMessage} (current: ${options.currentVersion}, required: ${options.minAllowedVersion}, update: ${options.updateCommand})`;
  }
  return `Minimum supported jenkins-cli version is ${options.minAllowedVersion}. Current version is ${options.currentVersion}. Run \`${options.updateCommand}\` to update.`;
}
