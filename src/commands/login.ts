/**
 * Login command implementation.
 * Prompts for Jenkins credentials, saves config, and prints export commands.
 */
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
} from "../secure-store";

type LoginOptions = {
  url?: string;
  user?: string;
  apiToken?: string;
  branchParam?: string;
  profile?: string;
  nonInteractive: boolean;
  noKeychain?: boolean;
};

type TokenPersistencePlan = {
  tokenStorage?: TokenStorage;
  tokenForConfig: string;
  tokenForExport?: string;
  /**
   * When the token is written in plaintext, mark the profile so the proactive
   * migration prompt does not nag the user who just chose (or fell back to)
   * plaintext storage.
   */
  keychainPromptAnswered?: boolean;
};

export async function runLogin(options: LoginOptions): Promise<void> {
  const existingConfig = readConfigSync()?.config;
  const profileName = await resolveProfileName(options, existingConfig);
  const existingProfile = existingConfig?.profiles[profileName];
  const profileAlreadyExists = Boolean(existingProfile);

  const url = await resolveUrl(options, existingProfile?.jenkinsUrl);
  const user = await resolveUser(options, existingProfile?.jenkinsUser);
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

  const normalizedUrl = normalizeUrl(url);
  const plan = await planTokenPersistence({
    options,
    profileName,
    normalizedUrl,
    apiToken,
    existingProfile,
  });

  const configPath = await writeConfigFile({
    profile: profileName,
    jenkinsUrl: normalizedUrl,
    jenkinsUser: user,
    jenkinsApiToken: plan.tokenForConfig,
    ...(branchParam !== DEFAULT_BRANCH_PARAM ? { branchParam } : {}),
    ...(makeDefault !== undefined ? { makeDefault } : {}),
    ...(plan.tokenStorage ? { tokenStorage: plan.tokenStorage } : {}),
    ...(plan.keychainPromptAnswered ? { keychainPromptAnswered: true } : {}),
  });

  printOk(`Saved profile "${profileName}" to ${configPath}.`);
  if (plan.tokenStorage === "keychain") {
    printOk(`API token stored securely in the ${secureStoreLabel()}.`);
  }
  if (makeDefault === true) {
    printOk(`Default profile set to "${profileName}".`);
  }
  console.log("");
  console.log("To set env vars in your current shell, run:");
  console.log(`  export ${ENV_KEYS.JENKINS_URL}=${shellEscape(normalizedUrl)}`);
  console.log(`  export ${ENV_KEYS.JENKINS_USER}=${shellEscape(user)}`);
  if (plan.tokenForExport !== undefined) {
    console.log(
      `  export ${ENV_KEYS.JENKINS_API_TOKEN}=${shellEscape(plan.tokenForExport)}`,
    );
  } else {
    console.log(
      `  # ${ENV_KEYS.JENKINS_API_TOKEN} is stored in the ${secureStoreLabel()}; re-run login to view or change it.`,
    );
  }
  if (branchParam !== DEFAULT_BRANCH_PARAM) {
    console.log(
      `  export ${ENV_KEYS.JENKINS_BRANCH_PARAM}=${shellEscape(branchParam)}`,
    );
  }
  console.log("");
  console.log(
    "To persist them, add the exports to your shell profile manually.",
  );
  console.log(`The CLI also reads ${CONFIG_FILE} directly.`);
  console.log(
    `Use --profile ${shellEscape(profileName)} to target this profile.`,
  );
}

/**
 * Decides how to persist the API token (OS keychain vs plaintext config) and
 * performs the required secure-store side effects. Falls back to plaintext
 * (with a HINT) when secure storage is unavailable or a store attempt fails,
 * and best-effort removes stale keychain entries when switching to plaintext.
 */
async function planTokenPersistence(input: {
  options: LoginOptions;
  profileName: string;
  normalizedUrl: string;
  apiToken: string;
  existingProfile: JenkinsProfileConfig | undefined;
}): Promise<TokenPersistencePlan> {
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

  const plaintextPlan = async (): Promise<TokenPersistencePlan> => {
    let token = apiToken;
    if (tokenUnchanged && existingIsKeychain && previousAccount) {
      // The prompt returned the sentinel; recover the real token from the
      // keychain so we can write it to the config in plaintext.
      const stored = await getToken(previousAccount).catch(() => null);
      if (!stored) {
        throw new CliError(
          "Cannot move the existing keychain token to plaintext automatically.",
          [
            `Re-run \`jenkins-cli login --profile ${profileName} --no-keychain --token <token>\` with the token.`,
          ],
        );
      }
      token = stored;
    }
    if (previousAccount) {
      await deleteToken(previousAccount);
    }
    return {
      tokenStorage: undefined,
      tokenForConfig: token,
      tokenForExport: token,
      keychainPromptAnswered: true,
    };
  };

  if (options.noKeychain) {
    return await plaintextPlan();
  }

  if (!isSecureStoreAvailable()) {
    printHint(
      `Secure token storage is unavailable on this system; the token is saved in plaintext at ${CONFIG_FILE}.`,
    );
    return await plaintextPlan();
  }

  // Keychain is preferred and available.
  if (tokenUnchanged && existingIsKeychain) {
    // Nothing changed; keep the existing keychain entry and rewrite the
    // sentinel. Real token is not printed since we did not read it.
    return {
      tokenStorage: "keychain",
      tokenForConfig: KEYCHAIN_TOKEN_SENTINEL,
      tokenForExport: undefined,
    };
  }

  try {
    await setToken(account, apiToken);
    if (previousAccount && previousAccount !== account) {
      await deleteToken(previousAccount);
    }
    return {
      tokenStorage: "keychain",
      tokenForConfig: KEYCHAIN_TOKEN_SENTINEL,
      tokenForExport: apiToken,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    printHint(
      `Could not store the token in the ${secureStoreLabel()} (${detail}); falling back to plaintext in ${CONFIG_FILE}.`,
    );
    return {
      tokenStorage: undefined,
      tokenForConfig: apiToken,
      tokenForExport: apiToken,
      keychainPromptAnswered: true,
    };
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
      "Run `jenkins-cli login --url <url> --user <user> --token <token>`.",
    ]);
  }
  const response = await text({
    message: "Jenkins URL",
    placeholder: "https://jenkins.example.com",
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
      "Run `jenkins-cli login --url <url> --user <user> --token <token>`.",
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
      "Run `jenkins-cli login --url <url> --user <user> --token <token>`.",
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
