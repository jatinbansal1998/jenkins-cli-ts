/**
 * Proactive, opt-in migration of plaintext API tokens into the OS keychain.
 *
 * Runs at most once per profile on an INTERACTIVE command (not login). It
 * prompts the user, and on acceptance stores the token in the keychain,
 * verifies the round-trip by reading it back, and only then rewrites the
 * config to replace the plaintext token with the keychain sentinel.
 *
 * Scripts, pipes, cron, CI (non-TTY / --non-interactive) and hosts without a
 * secure store are never prompted and never migrated.
 */
import { confirm, isCancel } from "./clack";
import { printHint, printOk } from "./cli";
import {
  type JenkinsConfig,
  type JenkinsProfileConfig,
  KEYCHAIN_TOKEN_SENTINEL,
  readConfig,
  writeConfig,
} from "./config";
import type { EnvConfig } from "./env";
import {
  buildSecureStoreAccount,
  getToken,
  isSecureStoreAvailable,
  secureStoreLabel,
  setToken,
  type SecureStoreDeps,
} from "./secure-store";

export type TokenMigrationDeps = {
  secureStore?: SecureStoreDeps;
  isAvailable?: (deps?: SecureStoreDeps) => boolean;
  /** Returns true (yes), false (no), or null when the user cancels. */
  confirm?: (message: string) => Promise<boolean | null>;
  loadConfig?: () => Promise<JenkinsConfig | null>;
  saveConfig?: (config: JenkinsConfig) => Promise<unknown>;
  log?: (line: string) => void;
  hint?: (line: string) => void;
};

const PROMPT_MESSAGE =
  "Store your Jenkins token in the system keychain? (recommended)";

/**
 * Decides whether the migration prompt should be shown for the active profile.
 * Pure and side-effect free so it can be unit tested directly.
 */
export function shouldPromptTokenMigration(input: {
  interactive: boolean;
  available: boolean;
  env: Pick<EnvConfig, "profileName" | "tokenStorage">;
  profile: JenkinsProfileConfig | undefined;
}): boolean {
  const { interactive, available, env, profile } = input;
  if (!interactive || !available) {
    return false;
  }
  // Only profiles resolved from the config file are eligible; env-var and
  // one-off (--url/--user/--token) credentials have no profile name.
  if (!env.profileName || !profile) {
    return false;
  }
  if (env.tokenStorage === "keychain" || profile.tokenStorage === "keychain") {
    return false;
  }
  if (profile.keychainPromptAnswered === true) {
    return false;
  }
  return Boolean(profile.jenkinsApiToken);
}

/**
 * Prompts to migrate the active profile's plaintext token to the keychain and,
 * on acceptance, performs a verified migration with an atomic config rewrite.
 * A no-op for any command that is not eligible.
 */
export async function maybePromptTokenMigration(params: {
  env: EnvConfig;
  interactive: boolean;
  deps?: TokenMigrationDeps;
}): Promise<void> {
  const deps = params.deps ?? {};
  const isAvailable = deps.isAvailable ?? isSecureStoreAvailable;
  const loadConfig =
    deps.loadConfig ?? (async () => (await readConfig())?.config ?? null);
  const saveConfig = deps.saveConfig ?? writeConfig;
  const log = deps.log ?? printOk;
  const hint = deps.hint ?? printHint;
  const confirmFn = deps.confirm ?? defaultConfirm;

  const available = isAvailable(deps.secureStore);
  const profileName = params.env.profileName;

  // Cheap gate before reading config.
  if (
    !params.interactive ||
    !available ||
    !profileName ||
    params.env.tokenStorage === "keychain"
  ) {
    return;
  }

  const config = await loadConfig();
  const profile = config?.profiles[profileName];
  if (
    !config ||
    !shouldPromptTokenMigration({
      interactive: params.interactive,
      available,
      env: params.env,
      profile,
    }) ||
    !profile
  ) {
    return;
  }

  const answer = await confirmFn(PROMPT_MESSAGE);
  if (answer === null) {
    // Cancelled (e.g. Ctrl-C): do not record; continue the current command.
    return;
  }

  if (answer === false) {
    // Record the decision so the user is never asked again for this profile.
    await persistProfile(saveConfig, config, profileName, {
      ...profile,
      keychainPromptAnswered: true,
    });
    return;
  }

  // Accepted: store -> verify round-trip -> only then rewrite the config.
  const token = profile.jenkinsApiToken;
  const account = buildSecureStoreAccount(profileName, profile.jenkinsUrl);
  const label = secureStoreLabel(deps.secureStore);
  try {
    await setToken(account, token, deps.secureStore);
    const readBack = await getToken(account, deps.secureStore);
    if (readBack !== token) {
      hint(
        `Skipped migration: the token read back from the ${label} did not match. Your config was left unchanged.`,
      );
      return;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    hint(
      `Could not migrate the token to the ${label} (${detail}). Your config was left unchanged.`,
    );
    return;
  }

  await persistProfile(saveConfig, config, profileName, {
    ...profile,
    jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
    tokenStorage: "keychain",
    keychainPromptAnswered: undefined,
  });
  log(`Migrated the "${profileName}" token to the ${label}.`);
}

async function persistProfile(
  saveConfig: (config: JenkinsConfig) => Promise<unknown>,
  config: JenkinsConfig,
  profileName: string,
  profile: JenkinsProfileConfig,
): Promise<void> {
  const next: JenkinsConfig = {
    ...config,
    profiles: {
      ...config.profiles,
      [profileName]: profile,
    },
  };
  await saveConfig(next);
}

async function defaultConfirm(message: string): Promise<boolean | null> {
  const response = await confirm({ message, initialValue: true });
  if (isCancel(response)) {
    return null;
  }
  return Boolean(response);
}
