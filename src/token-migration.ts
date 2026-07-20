/**
 * Automatic migration of plaintext API tokens into the OS secure store.
 *
 * When a secure store is available, the token is written and read back for
 * verification before the config is changed. Any failure leaves the working
 * plaintext profile untouched. Non-interactive commands migrate silently so
 * structured output is not contaminated.
 */
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
  deleteToken,
  getToken,
  isSecureStoreAvailable,
  secureStoreLabel,
  setToken,
  type SecureStoreDeps,
} from "./secure-store";

export type TokenMigrationDeps = {
  secureStore?: SecureStoreDeps;
  isAvailable?: (deps?: SecureStoreDeps) => boolean | Promise<boolean>;
  loadConfig?: () => Promise<JenkinsConfig | null>;
  saveConfig?: (config: JenkinsConfig) => Promise<unknown>;
  log?: (line: string) => void;
  hint?: (line: string) => void;
};

/**
 * Decides whether a selected profile is eligible for automatic migration.
 */
export function shouldMigrateToken(input: {
  available: boolean;
  env: Pick<EnvConfig, "profileName" | "tokenStorage">;
  profile: JenkinsProfileConfig | undefined;
}): boolean {
  const { available, env, profile } = input;
  if (!available) {
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
  if (profile.secureStorageOptOut === true) {
    return false;
  }
  return Boolean(profile.jenkinsApiToken);
}

/**
 * Automatically performs a verified migration for an eligible profile.
 * A no-op when no secure store is available or plaintext was explicitly
 * requested with --no-keychain.
 */
export async function maybeMigrateToken(params: {
  env: EnvConfig;
  report: boolean;
  deps?: TokenMigrationDeps;
}): Promise<void> {
  const deps = params.deps ?? {};
  const isAvailable = deps.isAvailable ?? isSecureStoreAvailable;
  const loadConfig =
    deps.loadConfig ?? (async () => (await readConfig())?.config ?? null);
  const saveConfig = deps.saveConfig ?? writeConfig;
  const log = params.report ? (deps.log ?? printOk) : () => undefined;
  const hint = params.report ? (deps.hint ?? printHint) : () => undefined;

  const available = await isAvailable(deps.secureStore);
  const profileName = params.env.profileName;

  if (!available || !profileName || params.env.tokenStorage === "keychain") {
    return;
  }

  const config = await loadConfig();
  const profile = config?.profiles[profileName];
  if (
    !config ||
    !shouldMigrateToken({
      available,
      env: params.env,
      profile,
    }) ||
    !profile
  ) {
    return;
  }

  const token = profile.jenkinsApiToken;
  const account = buildSecureStoreAccount(profileName, profile.jenkinsUrl);
  const label = await secureStoreLabel(deps.secureStore);
  try {
    await setToken(account, token, deps.secureStore);
    const readBack = await getToken(account, deps.secureStore);
    if (readBack !== token) {
      await deleteToken(account, deps.secureStore);
      hint(
        `Could not verify the migrated token in the ${label}. Your plaintext config remains active.`,
      );
      return;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await deleteToken(account, deps.secureStore);
    hint(
      `Could not migrate the token to the ${label} (${detail}). Your plaintext config remains active.`,
    );
    return;
  }

  try {
    await persistProfile(saveConfig, config, profileName, {
      ...profile,
      jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
      tokenStorage: "keychain",
      secureStorageOptOut: undefined,
    });
  } catch (error) {
    await deleteToken(account, deps.secureStore);
    const detail = error instanceof Error ? error.message : String(error);
    hint(
      `Could not update the profile after securing its token (${detail}). Your plaintext config remains active.`,
    );
    return;
  }
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
