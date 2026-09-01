import { normalizeOptionalString, parseBooleanFlag } from "./strings";
/**
 * Environment configuration loader.
 * Validates and loads JENKINS_URL, JENKINS_USER, and JENKINS_API_TOKEN.
 */
import { CliError } from "./cli";
import {
  CONFIG_FILE,
  type JenkinsConfig,
  migrateLegacyConfigSyncIfNeeded,
  readConfigSync,
  resolveDefaultProfileName,
  type TokenStorage,
} from "./config";
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
};

/** Stable error code for a write blocked by a read-only profile. */
export const PROFILE_PROTECTED_CODE = "PROFILE_PROTECTED";

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
 * Rejects Jenkins writes (builds, cancels, reruns) against a read-only profile
 * unless the invocation acknowledged them with `--confirm-protected`.
 */
export function assertProtectedMutationAllowed(env: EnvConfig): void {
  if (!env.protectedProfileName || env.confirmProtected === true) {
    return;
  }
  throw new CliError(
    `Profile "${env.protectedProfileName}" is read-only.`,
    [
      "Re-run with --confirm-protected to allow builds, cancels, creates, and reruns.",
    ],
    PROFILE_PROTECTED_CODE,
  );
}

export function loadEnv(options: LoadEnvOptions = {}): EnvConfig {
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
    throw new CliError("Incomplete Jenkins CLI credentials.", [
      "Pass --url, --user, and --token together when using one-off credentials.",
    ]);
  }

  const loadedConfig = migrateLegacyConfigSyncIfNeeded() ?? readConfigSync();
  const config = loadedConfig?.config;

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
    throw new CliError(`Missing ${ENV_KEYS.JENKINS_URL}.`, [
      `Set ${ENV_KEYS.JENKINS_URL} to your Jenkins base URL (e.g., https://jenkins.example.com).`,
      `Or add it to ${CONFIG_FILE}.`,
    ]);
  }

  if (!rawUser || rawUser.trim() === "") {
    throw new CliError(`Missing ${ENV_KEYS.JENKINS_USER}.`, [
      `Set ${ENV_KEYS.JENKINS_USER} to your Jenkins username or service account.`,
      `Or add it to ${CONFIG_FILE}.`,
    ]);
  }

  if (!rawToken || rawToken.trim() === "") {
    throw new CliError(`Missing ${ENV_KEYS.JENKINS_API_TOKEN}.`, [
      `Set ${ENV_KEYS.JENKINS_API_TOKEN} to your Jenkins API token.`,
      `Or add it to ${CONFIG_FILE}.`,
    ]);
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
    confirmProtected,
  };
}

/**
 * Resolves the effective API token for a loaded env config, transparently
 * reading keychain-backed tokens from the OS secure store. For plaintext
 * profiles, env vars, and one-off credentials this returns the token as-is.
 *
 * Throws a CliError with actionable hints when a keychain-backed token cannot
 * be resolved (keyring locked, missing entry, or backend unavailable).
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
    );
  }

  if (!token) {
    throw new CliError(
      `No Jenkins API token found in the ${await secureStoreLabel(deps)} for profile "${profileName}".`,
      [
        `Run \`${relogin}\` to store the token again.`,
        `Or run \`${relogin} --no-keychain\` to store it in the config file.`,
      ],
    );
  }
  return token;
}

/**
 * Get the debug setting from environment variable or config file.
 * Returns true if JENKINS_DEBUG is set to "true" or "1".
 * This is used as the default value when --debug flag is not explicitly passed.
 */
export function getDebugDefault(): boolean {
  const rawDebug = normalizeOptionalString(process.env[ENV_KEYS.JENKINS_DEBUG]);
  if (rawDebug) {
    return parseBooleanFlag(rawDebug) ?? false;
  }

  const loadedConfig = readConfigSync();
  return Boolean(loadedConfig?.config.debug);
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
  return parseBooleanFlag(value) ?? false;
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

function missingProfileError(
  requestedProfileName: string,
  availableProfiles: string[],
): CliError {
  const hints: string[] = ["Run `jenkins-cli profile list` to view profiles."];
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
  );
}
