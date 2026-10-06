import { normalizeOptionalString, parseBooleanFlag } from "./strings";
/**
 * Environment configuration loader.
 * Validates and loads JENKINS_URL, JENKINS_USER, and JENKINS_API_TOKEN.
 */
import { CliError } from "./cli";
import {
  CONFIG_FILE,
  type JenkinsConfig,
  type JenkinsProfileConfig,
  type LoadedConfig,
  migrateLegacyConfigSyncIfNeeded,
  resolveDefaultProfileName,
  type TokenStorage,
} from "./config";
import { parseDurationMs } from "./duration";
import { ENV_KEYS } from "./env-keys";
import { normalizeUrl } from "./jenkins-url";
import {
  buildSecureStoreAccount,
  getToken,
  secureStoreLabel,
  type SecureStoreDeps,
} from "./secure-store";

type LoadEnvOptions = {
  profile?: string;
  url?: string;
  user?: string;
  apiToken?: string;
  confirmProtected?: boolean;
  /** Raw `--timeout` value; beats JENKINS_TIMEOUT_MS and the profile. */
  timeout?: string;
  /** Raw `--retries` value; beats JENKINS_RETRIES and the profile. */
  retries?: string;
};

/** Jenkins connection configuration. */
export type EnvConfig = {
  jenkinsUrl: string;
  jenkinsUser: string;
  jenkinsApiToken: string;
  profileName?: string;
  /**
   * Default parameter name used by `buildWithParameters` to pass the branch/tag.
   * Can be overridden per-invocation via `--branch-param`.
   */
  branchParamDefault: string;
  /** Whether Jenkins CSRF crumb should be used for POST requests. */
  useCrumb: boolean;
  /** How many levels deep to pre-fetch folder children in a single API call. */
  folderDepth: number;
  /** Per-request HTTP timeout; unset leaves the client default. */
  timeoutMs?: number;
  /**
   * Transport retries for idempotent requests; unset leaves the client
   * default. Non-idempotent POSTs never retry, whatever this says.
   */
  transportRetries?: number;
  /**
   * How `jenkinsApiToken` is backed. When "keychain", `jenkinsApiToken` holds a
   * sentinel and the real token must be resolved via `resolveApiToken`.
   */
  tokenStorage?: TokenStorage;
  /**
   * Name of the configured protected profile governing this controller, when
   * the effective target is read-only. Absent means writes are unrestricted.
   */
  protectedProfileName?: string;
  /** `--confirm-protected` was passed for this invocation only. */
  confirmProtected?: boolean;
};

export { normalizeUrl } from "./jenkins-url";

/**
 * Rejects Jenkins writes (builds, cancels, reruns, input approvals) against a read-only profile
 * unless the invocation acknowledged them with `--confirm-protected`.
 */
export function assertProtectedMutationAllowed(env: EnvConfig): void {
  if (!env.protectedProfileName || env.confirmProtected === true) {
    return;
  }
  throw new CliError(
    `Profile "${env.protectedProfileName}" is read-only.`,
    [
      "Re-run with --confirm-protected to allow builds, cancels, creates, reruns, and input approvals or aborts.",
    ],
    "PROFILE_PROTECTED",
  );
}

export function loadEnv(
  loadedConfig: LoadedConfig | null,
  options: LoadEnvOptions = {},
): EnvConfig {
  const cliUrl = normalizeOptionalString(options.url);
  const cliUser = normalizeOptionalString(options.user);
  const cliToken = normalizeOptionalString(options.apiToken);
  const profileName = normalizeOptionalString(options.profile);
  const confirmProtected = options.confirmProtected === true;

  const providedCliCredentialCount = [cliUrl, cliUser, cliToken].filter(
    Boolean,
  ).length;
  if (
    providedCliCredentialCount > 0 &&
    providedCliCredentialCount < REQUIRED_CLI_CREDENTIAL_COUNT
  ) {
    throw new CliError(
      "Incomplete Jenkins CLI credentials.",
      [
        "Pass --url, --user, and --token together when using one-off credentials.",
      ],
      "INVALID_USAGE",
    );
  }

  const config = migrateLegacyConfigSyncIfNeeded(loadedConfig)?.config;

  if (
    providedCliCredentialCount === REQUIRED_CLI_CREDENTIAL_COUNT &&
    cliUrl &&
    cliUser &&
    cliToken
  ) {
    // One-off credentials do not bypass protection: the effective controller
    // URL decides, so `--url` against a protected controller stays protected.
    const directUrl = normalizeUrl(cliUrl);
    const protectedProfileName = findProtectedProfileNameForUrl(
      config,
      directUrl,
    );
    return {
      jenkinsUrl: directUrl,
      jenkinsUser: cliUser,
      jenkinsApiToken: cliToken,
      branchParamDefault: resolveBranchParamDefault(),
      useCrumb: parseUseCrumb(process.env[ENV_KEYS.JENKINS_USE_CRUMB]),
      folderDepth: DEFAULT_FOLDER_DEPTH,
      ...resolveHttpSettings(options),
      ...(protectedProfileName ? { protectedProfileName } : {}),
      confirmProtected,
    };
  }

  const activeProfileName = resolveActiveProfileName(config, profileName);
  const activeProfile =
    activeProfileName && config
      ? config.profiles[activeProfileName]
      : undefined;
  if (activeProfile) {
    return {
      jenkinsUrl: normalizeUrl(activeProfile.jenkinsUrl),
      jenkinsUser: activeProfile.jenkinsUser,
      jenkinsApiToken: activeProfile.jenkinsApiToken,
      profileName: activeProfileName,
      branchParamDefault: resolveBranchParamDefault(activeProfile.branchParam),
      useCrumb: parseUseCrumb(
        process.env[ENV_KEYS.JENKINS_USE_CRUMB] ?? activeProfile.useCrumb,
      ),
      folderDepth: activeProfile.folderDepth ?? DEFAULT_FOLDER_DEPTH,
      ...resolveHttpSettings(options, activeProfile),
      ...(activeProfile.tokenStorage
        ? { tokenStorage: activeProfile.tokenStorage }
        : {}),
      ...(activeProfile.protected === true && activeProfileName
        ? { protectedProfileName: activeProfileName }
        : {}),
      confirmProtected,
    };
  }

  const rawUrl = process.env[ENV_KEYS.JENKINS_URL];
  const rawUser = process.env[ENV_KEYS.JENKINS_USER];
  const rawToken = process.env[ENV_KEYS.JENKINS_API_TOKEN];
  if (!rawUrl || rawUrl.trim() === "") {
    throw new CliError(
      `Missing ${ENV_KEYS.JENKINS_URL}.`,
      [
        `Set ${ENV_KEYS.JENKINS_URL} to your Jenkins base URL (e.g., https://jenkins.example.com).`,
        `Or add it to ${CONFIG_FILE}.`,
      ],
      "CREDENTIALS_MISSING",
    );
  }

  if (!rawUser || rawUser.trim() === "") {
    throw new CliError(
      `Missing ${ENV_KEYS.JENKINS_USER}.`,
      [
        `Set ${ENV_KEYS.JENKINS_USER} to your Jenkins username or service account.`,
        `Or add it to ${CONFIG_FILE}.`,
      ],
      "CREDENTIALS_MISSING",
    );
  }

  if (!rawToken || rawToken.trim() === "") {
    throw new CliError(
      `Missing ${ENV_KEYS.JENKINS_API_TOKEN}.`,
      [
        `Set ${ENV_KEYS.JENKINS_API_TOKEN} to your Jenkins API token.`,
        `Or add it to ${CONFIG_FILE}.`,
      ],
      "CREDENTIALS_MISSING",
    );
  }

  // Environment-only credentials are not associated with a configured profile
  // and stay unrestricted.
  return {
    jenkinsUrl: normalizeUrl(rawUrl),
    jenkinsUser: rawUser.trim(),
    jenkinsApiToken: rawToken.trim(),
    branchParamDefault: resolveBranchParamDefault(),
    useCrumb: parseUseCrumb(process.env[ENV_KEYS.JENKINS_USE_CRUMB]),
    folderDepth: DEFAULT_FOLDER_DEPTH,
    ...resolveHttpSettings(options),
    confirmProtected,
  };
}

/**
 * Resolves the effective API token for a loaded env config, transparently
 * reading keychain-backed tokens from the OS secure store. For plaintext
 * profiles, env vars, and one-off credentials this returns the token as-is.
 *
 * Throws a CliError with actionable hints when a keychain-backed token cannot
 * be resolved (keyring locked, missing entry, or backend unavailable). The
 * token is read on the first Jenkins request, so the error carries the auth
 * code that best-effort lookups rethrow instead of swallowing.
 */
export async function resolveApiToken(
  env: EnvConfig,
  deps: SecureStoreDeps = {},
): Promise<string> {
  if (env.tokenStorage !== "keychain") {
    return env.jenkinsApiToken;
  }

  const profileName = env.profileName ?? "";
  const account = buildSecureStoreAccount(profileName, env.jenkinsUrl);
  const relogin = `jenkins-cli auth login --profile ${profileName}`;
  let token: string | null;
  try {
    token = await getToken(account, deps);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `Unable to read the Jenkins API token from the ${await secureStoreLabel(deps)}.`,
      [
        detail,
        "Ensure your login keychain / keyring is unlocked and accessible.",
        `Or run \`${relogin} --no-keychain\` to store the token in the config file.`,
      ],
      "JENKINS_AUTH_ERROR",
    );
  }

  if (!token) {
    throw new CliError(
      `No Jenkins API token found in the ${await secureStoreLabel(deps)} for profile "${profileName}".`,
      [
        `Run \`${relogin}\` to store the token again.`,
        `Or run \`${relogin} --no-keychain\` to store it in the config file.`,
      ],
      "JENKINS_AUTH_ERROR",
    );
  }
  return token;
}

/**
 * Get the debug setting from environment variable or config file.
 * Returns true if JENKINS_DEBUG is set to "true" or "1".
 * This is used as the default value when --debug flag is not explicitly passed.
 * The config is passed as a loader so a set JENKINS_DEBUG never reads the file.
 */
export function getDebugDefault(
  loadConfig: () => LoadedConfig | null,
): boolean {
  const rawDebug = normalizeOptionalString(process.env[ENV_KEYS.JENKINS_DEBUG]);
  if (rawDebug) {
    return parseBooleanFlag(rawDebug) ?? false;
  }

  return Boolean(loadConfig()?.config.debug);
}

const REQUIRED_CLI_CREDENTIAL_COUNT = 3;
const DEFAULT_BRANCH_PARAM = "BRANCH";
const DEFAULT_FOLDER_DEPTH = 3;

function resolveActiveProfileName(
  config:
    | {
        profiles: Record<
          string,
          {
            jenkinsUrl: string;
            jenkinsUser: string;
            jenkinsApiToken: string;
            branchParam?: string;
            useCrumb?: boolean;
          }
        >;
        defaultProfile?: string;
      }
    | undefined,
  requestedProfileName: string | undefined,
): string | undefined {
  if (!config) {
    if (requestedProfileName) {
      throw missingProfileError(requestedProfileName, []);
    }
    return undefined;
  }

  const availableProfiles = Object.keys(config.profiles);
  if (requestedProfileName) {
    if (!config.profiles[requestedProfileName]) {
      throw missingProfileError(requestedProfileName, availableProfiles);
    }
    return requestedProfileName;
  }

  return resolveDefaultProfileName(config);
}

/**
 * Finds the configured protected profile whose controller matches a normalized
 * URL. Object key order makes the first matching config entry deterministic
 * when several protected profiles share a controller.
 */
function findProtectedProfileNameForUrl(
  config: JenkinsConfig | undefined,
  normalizedUrl: string,
): string | undefined {
  if (!config) {
    return undefined;
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (profile.protected !== true) {
      continue;
    }
    let profileUrl: string;
    try {
      profileUrl = normalizeUrl(profile.jenkinsUrl);
    } catch {
      continue;
    }
    if (profileUrl === normalizedUrl) {
      return name;
    }
  }
  return undefined;
}

function parseUseCrumb(value: string | boolean | undefined): boolean {
  return parseBooleanFlag(value) ?? true;
}

function resolveBranchParamDefault(profileBranchParam?: string): string {
  const envBranchParam = normalizeOptionalString(
    process.env[ENV_KEYS.JENKINS_BRANCH_PARAM],
  );
  if (envBranchParam) {
    return envBranchParam;
  }
  if (profileBranchParam) {
    return profileBranchParam;
  }
  return DEFAULT_BRANCH_PARAM;
}

/** Precedence: flag, then env var, then profile field. */
function resolveHttpSettings(
  options: LoadEnvOptions,
  profile?: JenkinsProfileConfig,
): Pick<EnvConfig, "timeoutMs" | "transportRetries"> {
  const timeout = pickSetting(
    options.timeout,
    "--timeout",
    ENV_KEYS.JENKINS_TIMEOUT_MS,
  );
  const retries = pickSetting(
    options.retries,
    "--retries",
    ENV_KEYS.JENKINS_RETRIES,
  );
  const timeoutMs = timeout
    ? parseTimeoutMs(timeout.value, timeout.label)
    : profile?.timeoutMs;
  const transportRetries = retries
    ? parseRetries(retries.value, retries.label)
    : profile?.retries;
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(transportRetries !== undefined ? { transportRetries } : {}),
  };
}

function pickSetting(
  flagValue: string | undefined,
  flagName: string,
  envKey: string,
): { value: string; label: string } | undefined {
  // A passed flag is validated even when empty; an empty env var means unset.
  if (flagValue !== undefined) {
    return { value: flagValue, label: flagName };
  }
  const envValue = normalizeOptionalString(process.env[envKey]);
  return envValue ? { value: envValue, label: envKey } : undefined;
}

function parseTimeoutMs(value: string, label: string): number {
  const timeoutMs = parseDurationMs(value, label);
  // The request timer treats 0 as "no deadline", so a hung controller would
  // block the command forever.
  if (timeoutMs <= 0) {
    throw new CliError(
      `Invalid ${label} value "${value}".`,
      ["Use a timeout greater than 0ms (e.g. 30s)."],
      "INVALID_USAGE",
    );
  }
  return timeoutMs;
}

function parseRetries(value: string, label: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CliError(
      `Invalid ${label} value "${value}".`,
      ["Use a whole number of retries, 0 or more (e.g. 3)."],
      "INVALID_USAGE",
    );
  }
  return Number(trimmed);
}

function missingProfileError(
  requestedProfileName: string,
  availableProfiles: string[],
): CliError {
  const hints: string[] = ["Run `jenkins-cli auth list` to view profiles."];
  if (availableProfiles.length > 0) {
    hints.push(`Available profiles: ${availableProfiles.join(", ")}.`);
  } else {
    hints.push(
      "No profiles are configured yet. Run `jenkins-cli auth login --profile <name>`.",
    );
  }
  return new CliError(
    `Profile "${requestedProfileName}" was not found.`,
    hints,
    "PROFILE_NOT_FOUND",
  );
}
