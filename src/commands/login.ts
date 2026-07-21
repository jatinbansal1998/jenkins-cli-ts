/**
 * Login command implementation.
 * Prompts for Jenkins credentials and saves them to a named profile.
 */
import { openInBrowser } from "../browser";
import { confirm, isCancel, password, text } from "../clack";
import { CliError, printHint, printOk } from "../cli";
import {
  CONFIG_FILE,
  DEFAULT_PROFILE_NAME,
  KEYCHAIN_TOKEN_SENTINEL,
  readConfigSync,
  type TokenStorage,
  writeConfigFile,
} from "../config";
import type { JenkinsProfileConfig } from "../config";
import { ENV_KEYS } from "../env-keys";
import { normalizeUrl } from "../env";
import {
  buildSecureStoreAccount,
  deleteToken,
  getToken,
  isSecureStoreAvailable,
  secureStoreLabel,
  setToken,
  type SecureStoreDeps,
} from "../secure-store";

export type LoginOptions = {
  url?: string;
  user?: string;
  apiToken?: string;
  branchParam?: string;
  profile?: string;
  nonInteractive: boolean;
  noKeychain?: boolean;
};

export type TokenPersistencePlan = {
  tokenStorage?: TokenStorage;
  tokenForConfig: string;
  /**
   * Mark the profile only when the user explicitly chose plaintext storage.
   * Automatic fallback must remain eligible for migration if the secure store
   * becomes available on a later invocation.
   */
  secureStorageOptOut?: boolean;
  /** Finalizes secure-store cleanup after the config rewrite succeeds. */
  commit?: () => Promise<void>;
  /** Restores secure-store state when the config rewrite fails. */
  rollback?: () => Promise<void>;
};

export type LoginDeps = {
  confirm?: typeof confirm;
  openInBrowser?: (url: string) => Promise<void>;
  secureStore?: SecureStoreDeps;
  hint?: (message: string) => void;
};

export async function runLogin(
  options: LoginOptions,
  deps: LoginDeps = {},
): Promise<void> {
  const existingConfig = readConfigSync()?.config;
  const profileName = await resolveProfileName(options, existingConfig);
  const existingProfile = existingConfig?.profiles[profileName];
  const profileAlreadyExists = Boolean(existingProfile);

  const url = await resolveUrl(options, existingProfile?.jenkinsUrl);
  // Validate the URL right after entry so an invalid value is reported before
  // the remaining prompts.
  const normalizedUrl = normalizeUrl(url);
  await offerToOpenHostInBrowser(
    { url: normalizedUrl, nonInteractive: options.nonInteractive },
    deps,
  );
  const user = await resolveUser(options, existingProfile?.jenkinsUser);
  await offerToOpenUserSecurityPageInBrowser(
    {
      url: normalizedUrl,
      user,
      nonInteractive: options.nonInteractive,
    },
    deps,
  );
  const apiToken = await resolveApiToken(
    options,
    existingProfile?.jenkinsApiToken,
  );
  const branchParam = await resolveBranchParam(
    options,
    profileName,
    existingProfile?.branchParam,
    existingConfig,
  );
  const makeDefault = await resolveDefaultDecision({
    options,
    profileName,
    profileAlreadyExists,
    existingDefault: existingConfig?.defaultProfile,
    profileCount: Object.keys(existingConfig?.profiles ?? {}).length,
  });

  const plan = await planTokenPersistence(
    {
      options,
      profileName,
      normalizedUrl,
      apiToken,
      existingProfile,
    },
    deps,
  );

  let configPath: string;
  try {
    configPath = await writeConfigFile({
      profile: profileName,
      jenkinsUrl: normalizedUrl,
      jenkinsUser: user,
      jenkinsApiToken: plan.tokenForConfig,
      ...(branchParam !== DEFAULT_BRANCH_PARAM ? { branchParam } : {}),
      ...(makeDefault !== undefined ? { makeDefault } : {}),
      ...(plan.tokenStorage ? { tokenStorage: plan.tokenStorage } : {}),
      ...(plan.secureStorageOptOut ? { secureStorageOptOut: true } : {}),
    });
  } catch (error) {
    await plan.rollback?.();
    throw error;
  }
  await plan.commit?.();

  printOk(`Saved profile "${profileName}" to ${configPath}.`);
  const secureStoreName =
    plan.tokenStorage === "keychain"
      ? await secureStoreLabel(deps.secureStore)
      : undefined;
  if (plan.tokenStorage === "keychain") {
    printOk(`API token stored securely in the ${secureStoreName}.`);
  }
  if (makeDefault === true) {
    printOk(`Default profile set to "${profileName}".`);
  }
  for (const line of getLoginInstructions({
    profileName,
    normalizedUrl,
    user,
    branchParam,
    plan,
    secureStoreName,
  })) {
    console.log(line);
  }
}

/** Builds post-login guidance without exposing a securely persisted token. */
export function getLoginInstructions(input: {
  profileName: string;
  normalizedUrl: string;
  user: string;
  branchParam: string;
  plan: TokenPersistencePlan;
  secureStoreName?: string;
}): string[] {
  const profileArg = shellEscape(input.profileName);
  if (input.plan.tokenStorage === "keychain") {
    return [
      "",
      `Credentials are ready. Use --profile ${profileArg} to target this profile.`,
      `The CLI reads ${CONFIG_FILE} directly and loads the API token from the ${input.secureStoreName ?? "OS secure store"}.`,
    ];
  }

  const lines = [
    "",
    "To set env vars in your current shell, run:",
    `  export ${ENV_KEYS.JENKINS_URL}=${shellEscape(input.normalizedUrl)}`,
    `  export ${ENV_KEYS.JENKINS_USER}=${shellEscape(input.user)}`,
    `  export ${ENV_KEYS.JENKINS_API_TOKEN}=${shellEscape(input.plan.tokenForConfig)}`,
  ];
  if (input.branchParam !== DEFAULT_BRANCH_PARAM) {
    lines.push(
      `  export ${ENV_KEYS.JENKINS_BRANCH_PARAM}=${shellEscape(input.branchParam)}`,
    );
  }
  lines.push(
    "",
    "To persist them, add the exports to your shell profile manually.",
    `The CLI also reads ${CONFIG_FILE} directly.`,
    `Use --profile ${profileArg} to target this profile.`,
  );
  return lines;
}

/**
 * Builds the standard Jenkins security-page URL for a user.
 */
export function buildJenkinsUserSecurityUrl(url: string, user: string): string {
  return `${normalizeUrl(url)}/user/${encodeURIComponent(user.trim())}/security/`;
}

/**
 * Offers to open the Jenkins host so the user can sign in and confirm their
 * Jenkins username before the username prompt appears.
 */
export async function offerToOpenHostInBrowser(
  input: { url: string; nonInteractive: boolean },
  deps: LoginDeps = {},
): Promise<void> {
  await offerToOpenUrlInBrowser(
    {
      targetUrl: input.url,
      message: `Open ${input.url} in your browser? (useful for finding your Jenkins username)`,
      nonInteractive: input.nonInteractive,
    },
    deps,
  );
}

/**
 * Offers to open the user's Jenkins security page so they can create an API
 * token before the token prompt appears.
 */
export async function offerToOpenUserSecurityPageInBrowser(
  input: { url: string; user: string; nonInteractive: boolean },
  deps: LoginDeps = {},
): Promise<void> {
  const securityUrl = buildJenkinsUserSecurityUrl(input.url, input.user);
  await offerToOpenUrlInBrowser(
    {
      targetUrl: securityUrl,
      message: `Open ${securityUrl} in your browser? (useful for creating an API token)`,
      nonInteractive: input.nonInteractive,
    },
    deps,
  );
}

/** Shared browser offer used by both interactive login navigation prompts. */
async function offerToOpenUrlInBrowser(
  input: {
    targetUrl: string;
    message: string;
    nonInteractive: boolean;
  },
  deps: LoginDeps,
): Promise<void> {
  if (input.nonInteractive) {
    return;
  }
  const response = await (deps.confirm ?? confirm)({
    message: input.message,
    initialValue: false,
  });
  // confirm resolves to a boolean or clack's cancel symbol; anything that is
  // not an explicit boolean counts as a cancellation.
  if (isCancel(response) || typeof response !== "boolean") {
    throw new CliError("Operation cancelled.");
  }
  if (!response) {
    return;
  }
  try {
    await (deps.openInBrowser ?? openInBrowser)(input.targetUrl);
  } catch {
    printHint(
      `Could not open the browser automatically. Visit ${input.targetUrl} manually.`,
    );
  }
}

/**
 * Decides how to persist the API token (OS keychain vs plaintext config) and
 * performs the required secure-store side effects. Falls back to plaintext
 * (with a HINT) when secure storage is unavailable or a store attempt fails,
 * and best-effort removes stale keychain entries when switching to plaintext.
 */
export async function planTokenPersistence(
  input: {
    options: LoginOptions;
    profileName: string;
    normalizedUrl: string;
    apiToken: string;
    existingProfile: JenkinsProfileConfig | undefined;
  },
  deps: LoginDeps = {},
): Promise<TokenPersistencePlan> {
  const { options, profileName, normalizedUrl, apiToken, existingProfile } =
    input;
  const account = buildSecureStoreAccount(profileName, normalizedUrl);
  const existingIsKeychain = existingProfile?.tokenStorage === "keychain";
  const previousAccount =
    existingIsKeychain && existingProfile
      ? buildSecureStoreAccount(profileName, existingProfile.jenkinsUrl)
      : undefined;
  // When re-running login for a keychain profile without entering a new token,
  // resolveApiToken echoes the stored sentinel rather than a real secret.
  const tokenUnchanged = apiToken === existingProfile?.jenkinsApiToken;

  const plaintextPlan = async (
    secureStorageOptOut: boolean,
  ): Promise<TokenPersistencePlan> => {
    let token = apiToken;
    if (tokenUnchanged && existingIsKeychain && previousAccount) {
      // The prompt returned the sentinel; recover the real token from the
      // keychain so we can write it to the config in plaintext.
      const stored = await getToken(previousAccount, deps.secureStore).catch(
        () => null,
      );
      if (!stored) {
        throw new CliError(
          "Cannot move the existing keychain token to plaintext automatically.",
          [
            `Re-run \`jenkins-cli auth login --profile ${profileName} --no-keychain --token <token>\` with the token.`,
          ],
        );
      }
      token = stored;
    }
    return {
      tokenStorage: undefined,
      tokenForConfig: token,
      ...(secureStorageOptOut ? { secureStorageOptOut: true } : {}),
      ...(previousAccount
        ? {
            commit: async () => {
              await deleteToken(previousAccount, deps.secureStore);
            },
          }
        : {}),
    };
  };

  if (options.noKeychain) {
    return await plaintextPlan(true);
  }

  if (!(await isSecureStoreAvailable(deps.secureStore))) {
    (deps.hint ?? printHint)(
      `Secure token storage is unavailable on this system; the token is saved in plaintext at ${CONFIG_FILE}.`,
    );
    return await plaintextPlan(false);
  }

  // Keychain is preferred and available.
  if (tokenUnchanged && existingIsKeychain && previousAccount === account) {
    // Nothing changed; keep the existing keychain entry and rewrite the
    // sentinel. Real token is not printed since we did not read it.
    return {
      tokenStorage: "keychain",
      tokenForConfig: KEYCHAIN_TOKEN_SENTINEL,
    };
  }

  let tokenToStore = apiToken;
  if (tokenUnchanged && existingIsKeychain && previousAccount) {
    const previousToken = await getToken(
      previousAccount,
      deps.secureStore,
    ).catch(() => null);
    if (!previousToken) {
      throw new CliError(
        "Cannot move the existing keychain token to the updated Jenkins host.",
        [
          `Re-run \`jenkins-cli auth login --profile ${profileName} --token <token>\` with the token.`,
        ],
      );
    }
    tokenToStore = previousToken;
  }

  let priorTokenAtAccount: string | null;
  try {
    priorTokenAtAccount = await getToken(account, deps.secureStore);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    (deps.hint ?? printHint)(
      `Could not prepare the ${await secureStoreLabel(deps.secureStore)} for a verified token update (${detail}); falling back to plaintext in ${CONFIG_FILE}.`,
    );
    return await plaintextPlan(false);
  }
  const restoreAccount = async (): Promise<void> => {
    if (priorTokenAtAccount === null) {
      await deleteToken(account, deps.secureStore);
      return;
    }
    await setToken(account, priorTokenAtAccount, deps.secureStore).catch(
      () => undefined,
    );
  };

  try {
    await setToken(account, tokenToStore, deps.secureStore);
    const stored = await getToken(account, deps.secureStore);
    if (stored !== tokenToStore) {
      throw new Error("the stored token could not be verified");
    }
    return {
      tokenStorage: "keychain",
      tokenForConfig: KEYCHAIN_TOKEN_SENTINEL,
      rollback: restoreAccount,
      ...(previousAccount && previousAccount !== account
        ? {
            commit: async () => {
              await deleteToken(previousAccount, deps.secureStore);
            },
          }
        : {}),
    };
  } catch (error) {
    await restoreAccount();
    const detail = error instanceof Error ? error.message : String(error);
    (deps.hint ?? printHint)(
      `Could not store the token in the ${await secureStoreLabel(deps.secureStore)} (${detail}); falling back to plaintext in ${CONFIG_FILE}.`,
    );
    return await plaintextPlan(false);
  }
}

async function resolveProfileName(
  options: LoginOptions,
  config:
    | {
        defaultProfile?: string;
        profiles: Record<string, { jenkinsUrl: string }>;
      }
    | undefined,
): Promise<string> {
  const provided = options.profile?.trim();
  if (provided) {
    return provided;
  }

  const fallback = config?.defaultProfile ?? DEFAULT_PROFILE_NAME;
  if (options.nonInteractive) {
    return fallback;
  }

  const response = await text({
    message: "Profile name",
    placeholder: fallback,
    initialValue: fallback,
    validate: (value) => (value?.trim() ? undefined : "Value required."),
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return String(response).trim();
}

async function resolveUrl(
  options: LoginOptions,
  existingValue?: string,
): Promise<string> {
  const provided = options.url?.trim();
  if (provided) {
    return provided;
  }
  if (options.nonInteractive) {
    if (existingValue?.trim()) {
      return existingValue.trim();
    }
    throw new CliError("Missing required --url.", [
      "Run `jenkins-cli auth login --url <url> --user <user> --token <token>`.",
    ]);
  }
  const response = await text({
    message: "Jenkins URL",
    placeholder: "https://jenkins.example.com",
    initialValue: existingValue,
    validate: (value) => validateLoginUrl(value, existingValue),
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  const value = String(response).trim();
  return value || existingValue?.trim() || "";
}

/** Returns concise inline guidance for invalid interactive login URLs. */
export function validateLoginUrl(
  value: string | undefined,
  existingValue?: string,
): string | undefined {
  const candidate = value?.trim();
  if (!candidate) {
    return existingValue?.trim() ? undefined : "Value required.";
  }

  try {
    normalizeUrl(candidate);
    return undefined;
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    return [error.message, error.hints[0]].filter(Boolean).join(" ");
  }
}

async function resolveUser(
  options: LoginOptions,
  existingValue?: string,
): Promise<string> {
  const provided = options.user?.trim();
  if (provided) {
    return provided;
  }
  if (options.nonInteractive) {
    if (existingValue?.trim()) {
      return existingValue.trim();
    }
    throw new CliError("Missing required --user.", [
      "Run `jenkins-cli auth login --url <url> --user <user> --token <token>`.",
    ]);
  }
  const response = await text({
    message: "Jenkins username",
    placeholder: "e.g. your-username",
    initialValue: existingValue,
    validate: (value) =>
      value?.trim() || existingValue?.trim() ? undefined : "Value required.",
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  const value = String(response).trim();
  return value || existingValue?.trim() || "";
}

async function resolveApiToken(
  options: LoginOptions,
  existingValue?: string,
): Promise<string> {
  const provided = options.apiToken?.trim();
  if (provided) {
    return provided;
  }
  if (options.nonInteractive) {
    if (existingValue?.trim()) {
      return existingValue.trim();
    }
    throw new CliError("Missing required --token.", [
      "Run `jenkins-cli auth login --url <url> --user <user> --token <token>`.",
    ]);
  }
  const response = await password({
    message: existingValue
      ? "Jenkins API token (leave blank to keep current token)"
      : "Jenkins API token",
    validate: (value) =>
      value?.trim() || existingValue?.trim() ? undefined : "Value required.",
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  const value = String(response).trim();
  return value || existingValue?.trim() || "";
}

const DEFAULT_BRANCH_PARAM = "BRANCH";

function getBranchParamDefault(
  profileBranchParam?: string,
  config?: {
    defaultProfile?: string;
    profiles: Record<string, { branchParam?: string }>;
  },
): string {
  const envValue = process.env[ENV_KEYS.JENKINS_BRANCH_PARAM]?.trim();
  if (envValue) {
    return envValue;
  }
  if (profileBranchParam) {
    return profileBranchParam;
  }
  if (config?.defaultProfile) {
    const defaultProfile = config.profiles[config.defaultProfile];
    const branchParam = defaultProfile?.branchParam?.trim();
    if (branchParam) {
      return branchParam;
    }
  }
  return DEFAULT_BRANCH_PARAM;
}

async function resolveDefaultDecision(options: {
  options: LoginOptions;
  profileName: string;
  profileAlreadyExists: boolean;
  existingDefault?: string;
  profileCount: number;
}): Promise<boolean | undefined> {
  if (options.profileCount === 0) {
    return true;
  }
  if (options.profileAlreadyExists) {
    return undefined;
  }
  if (options.options.nonInteractive) {
    return false;
  }

  const response = await confirm({
    message: `Set "${options.profileName}" as the default profile?`,
    initialValue: false,
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  if (response) {
    return true;
  }
  return !options.existingDefault;
}

function shellEscape(value: string): string {
  if (value === "") {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function resolveBranchParam(
  options: LoginOptions,
  profileName: string,
  profileBranchParam: string | undefined,
  config:
    | {
        defaultProfile?: string;
        profiles: Record<string, { branchParam?: string }>;
      }
    | undefined,
): Promise<string> {
  const provided = options.branchParam?.trim();
  if (provided) {
    return provided;
  }
  const defaultParam = getBranchParamDefault(profileBranchParam, config);
  if (options.nonInteractive) {
    return defaultParam;
  }
  const response = await text({
    message: `Branch parameter name (default: ${defaultParam})`,
    placeholder: DEFAULT_BRANCH_PARAM,
    initialValue:
      profileBranchParam ??
      (config?.defaultProfile === profileName
        ? config.profiles[profileName]?.branchParam
        : undefined),
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  const value = String(response).trim();
  return value ? value : defaultParam;
}
