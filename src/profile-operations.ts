/**
 * Shared profile management operations behind the `auth` command group and the
 * compatibility `profile` commands. Command handlers own argument parsing,
 * confirmation prompts, text output, and analytics; this module owns config
 * validation, secure-store changes, default-profile selection, rollback, and
 * result data.
 *
 * Cross-store changes (config file + OS secure store) use compensation so a
 * caller never observes success after a partial operation:
 *   1. Read and retain affected keychain tokens in memory.
 *   2. Delete the affected secure-store entries and verify they are absent.
 *   3. Atomically write the updated config.
 *   4. If the config write fails, restore the deleted secure-store entries
 *      and report whether that rollback also failed.
 *
 * Error messages never include tokens or secure-store backend details.
 */
import { CliError } from "./cli";
import {
  migrateLegacyConfigIfNeeded,
  normalizeProfileName,
  resolveDefaultProfileName,
  writeConfig,
  type JenkinsConfig,
  type JenkinsProfileConfig,
  type LoadedConfig,
} from "./config";
import {
  buildSecureStoreAccount,
  deleteToken,
  getToken,
  setToken,
} from "./secure-store";

export type ProfileOperationsDeps = {
  readConfig?: () => Promise<LoadedConfig | null>;
  writeConfig?: (config: JenkinsConfig) => Promise<string>;
  getToken?: (account: string) => Promise<string | null>;
  setToken?: (account: string, token: string) => Promise<void>;
  deleteToken?: (account: string) => Promise<boolean>;
};

export type ProfileTokenStorage = "keychain" | "plaintext";

export type ProfileSummary = {
  name: string;
  jenkinsUrl: string;
  jenkinsUser: string;
  tokenStorage: ProfileTokenStorage;
  isDefault: boolean;
};

export type ProfileListResult = {
  profiles: ProfileSummary[];
  defaultProfile?: string;
};

export type SelectProfileResult = {
  profileName: string;
  changed: boolean;
};

export type DeleteProfilesResult = {
  deleted: string[];
  nextDefault?: string;
};

export type RenameProfileResult = {
  from: string;
  to: string;
  isDefault: boolean;
  changed: boolean;
};

export function unknownProfileError(
  profileName: string,
  availableProfiles: string[],
): CliError {
  const hints =
    availableProfiles.length > 0
      ? [`Available profiles: ${availableProfiles.join(", ")}.`]
      : [
          "No profiles are configured yet. Run `jenkins-cli auth login --profile <name>`.",
        ];
  return new CliError(`Profile "${profileName}" was not found.`, hints);
}

export async function listProfiles(
  deps: ProfileOperationsDeps = {},
): Promise<ProfileListResult> {
  const loaded = await readCurrentConfig(deps);
  const config = loaded?.config;
  const profiles = config?.profiles ?? {};
  const defaultProfile = resolveDefaultProfileName({
    profiles,
    defaultProfile: config?.defaultProfile,
  });
  return {
    profiles: Object.entries(profiles).map(([name, profile]) => ({
      name,
      jenkinsUrl: profile.jenkinsUrl,
      jenkinsUser: profile.jenkinsUser,
      tokenStorage:
        profile.tokenStorage === "keychain" ? "keychain" : "plaintext",
      isDefault: name === defaultProfile,
    })),
    ...(defaultProfile ? { defaultProfile } : {}),
  };
}

/** Sets an existing profile as the default. Already-active selection is a no-op. */
export async function selectProfile(
  name: string,
  deps: ProfileOperationsDeps = {},
): Promise<SelectProfileResult> {
  const profileName = normalizeProfileName(name);
  if (!profileName) {
    throw new CliError("Profile name is required.");
  }

  const config = (await readCurrentConfig(deps))?.config;
  const profiles = config?.profiles ?? {};
  const names = Object.keys(profiles);
  if (names.length === 0) {
    throw new CliError("No profiles are configured.", [
      "Run `jenkins-cli auth login --profile <name>` to add one.",
    ]);
  }
  if (!profiles[profileName]) {
    throw unknownProfileError(profileName, names);
  }

  const activeProfile = resolveDefaultProfileName({
    profiles,
    defaultProfile: config?.defaultProfile,
  });
  if (activeProfile === profileName) {
    return { profileName, changed: false };
  }

  await writeUpdatedConfig(
    buildConfigPayload(config, profiles, profileName),
    deps,
  );
  return { profileName, changed: true };
}

/**
 * Deletes the named profiles and their matching secure-store entries with
 * strict semantics: a missing secure-store token counts as already absent, and
 * any secure-store access, deletion, or verification error fails the operation
 * before the config is changed.
 */
export async function deleteProfilesStrict(
  names: string[],
  deps: ProfileOperationsDeps = {},
): Promise<DeleteProfilesResult> {
  const config = (await readCurrentConfig(deps))?.config;
  const profiles = config?.profiles ?? {};
  const available = Object.keys(profiles);
  const targets = names.map((name) => normalizeProfileName(name));
  for (const target of targets) {
    if (!target) {
      throw new CliError("Profile name is required.");
    }
    if (!profiles[target]) {
      throw unknownProfileError(target, available);
    }
  }

  return await performDelete(config as JenkinsConfig, targets, deps);
}

/** Deletes every configured profile. An empty profile set is a successful no-op. */
export async function deleteAllProfiles(
  deps: ProfileOperationsDeps = {},
): Promise<DeleteProfilesResult> {
  const config = (await readCurrentConfig(deps))?.config;
  const names = Object.keys(config?.profiles ?? {});
  if (!config || names.length === 0) {
    return { deleted: [] };
  }
  return await performDelete(config, names, deps);
}

/**
 * Renames a profile, migrating any keychain-backed token to the account
 * derived from the new name. A rename to the same normalized name is a no-op.
 */
export async function renameProfile(
  oldNameRaw: string,
  newNameRaw: string,
  deps: ProfileOperationsDeps = {},
): Promise<RenameProfileResult> {
  const oldName = normalizeProfileName(oldNameRaw);
  const newName = normalizeProfileName(newNameRaw);
  if (!oldName || !newName) {
    throw new CliError("Profile names are required.", [
      "Run `jenkins-cli auth rename <old> <new>`.",
    ]);
  }

  const config = (await readCurrentConfig(deps))?.config;
  const profiles = config?.profiles ?? {};
  const source = profiles[oldName];
  if (!config || !source) {
    throw unknownProfileError(oldName, Object.keys(profiles));
  }
  const isDefault =
    resolveDefaultProfileName({
      profiles,
      defaultProfile: config.defaultProfile,
    }) === oldName;
  if (oldName === newName) {
    return { from: oldName, to: newName, isDefault, changed: false };
  }
  if (profiles[newName]) {
    throw new CliError(`Profile "${newName}" already exists.`, [
      "Choose a different name or delete the existing profile first.",
    ]);
  }

  // Rebuild the profile map in place so the renamed profile keeps its position.
  const renamedProfiles: Record<string, JenkinsProfileConfig> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    renamedProfiles[name === oldName ? newName : name] = profile;
  }
  const nextDefault =
    config.defaultProfile === oldName ? newName : config.defaultProfile;
  const payload = buildConfigPayload(config, renamedProfiles, nextDefault);
  const result: RenameProfileResult = {
    from: oldName,
    to: newName,
    isDefault,
    changed: true,
  };

  if (source.tokenStorage !== "keychain") {
    await writeUpdatedConfig(payload, deps);
    return result;
  }

  const oldAccount = buildSecureStoreAccount(oldName, source.jenkinsUrl);
  const newAccount = buildSecureStoreAccount(newName, source.jenkinsUrl);

  let token: string | null;
  try {
    token = await (deps.getToken ?? getToken)(oldAccount);
  } catch {
    throw secureStoreAccessError();
  }

  if (token === null) {
    // The source token is already missing; rename the profile while
    // preserving that missing-token state.
    await writeUpdatedConfig(payload, deps);
    return result;
  }

  // Write and verify the destination entry before touching anything else.
  try {
    await (deps.setToken ?? setToken)(newAccount, token);
    const stored = await (deps.getToken ?? getToken)(newAccount);
    if (stored !== token) {
      throw new Error("verification failed");
    }
  } catch {
    // Best-effort cleanup of a possibly partial destination entry.
    await (deps.deleteToken ?? deleteToken)(newAccount).catch(() => false);
    throw new CliError(
      "Unable to write the renamed token to the OS secure store; no changes were made.",
      ["Ensure your login keychain / keyring is unlocked and try again."],
    );
  }

  try {
    await writeUpdatedConfig(payload, deps, { rethrow: true });
  } catch {
    let rollbackFailed = false;
    try {
      await strictDeleteToken(newAccount, deps);
    } catch {
      rollbackFailed = true;
    }
    throw new CliError(
      "Failed to update the config file; the rename was not applied.",
      rollbackFailed
        ? [
            `Rollback also failed: an extra secure-store entry for "${newName}" may remain.`,
            "Check the config file permissions and your keychain, then try again.",
          ]
        : ["Check the config file permissions and try again."],
    );
  }

  try {
    await strictDeleteToken(oldAccount, deps);
  } catch {
    // The config already points at the new name but the old secure-store
    // entry could not be removed. Restore the original state where possible.
    const rollbackFailures: string[] = [];
    try {
      await writeUpdatedConfig(config, deps, { rethrow: true });
    } catch {
      rollbackFailures.push(
        `Rollback also failed: the config now uses "${newName}" while a stale secure-store entry for "${oldName}" remains.`,
      );
    }
    try {
      await strictDeleteToken(newAccount, deps);
    } catch {
      rollbackFailures.push(
        `Rollback also failed: a duplicate secure-store entry for "${newName}" remains.`,
      );
    }
    throw new CliError(
      "Failed to remove the old secure-store entry; the rename was rolled back.",
      [
        ...rollbackFailures,
        "Ensure your login keychain / keyring is unlocked and try again.",
      ],
    );
  }

  return result;
}

type RetainedEntry = {
  profileName: string;
  account: string;
  token: string;
};

async function performDelete(
  config: JenkinsConfig,
  names: string[],
  deps: ProfileOperationsDeps,
): Promise<DeleteProfilesResult> {
  const profiles = config.profiles;

  // 1. Read and retain affected keychain tokens in memory so a failed config
  //    write can restore them.
  const retained: RetainedEntry[] = [];
  for (const name of names) {
    const profile = profiles[name];
    if (!profile || profile.tokenStorage !== "keychain") {
      continue;
    }
    const account = buildSecureStoreAccount(name, profile.jenkinsUrl);
    let token: string | null;
    try {
      token = await (deps.getToken ?? getToken)(account);
    } catch {
      throw secureStoreAccessError();
    }
    if (token !== null) {
      retained.push({ profileName: name, account, token });
    }
  }

  // 2. Delete the secure-store entries and verify they are absent. A missing
  //    token counts as already absent (it was never retained).
  const deletedEntries: RetainedEntry[] = [];
  for (const entry of retained) {
    try {
      await strictDeleteToken(entry.account, deps);
    } catch {
      const restoreFailures = await restoreEntries(deletedEntries, deps);
      throw new CliError(
        `Unable to delete the secure-store token for profile "${entry.profileName}"; the config was not changed.`,
        [
          ...describeRestoreFailures(restoreFailures),
          "Ensure your login keychain / keyring is unlocked and try again.",
        ],
      );
    }
    deletedEntries.push(entry);
  }

  // 3. Atomically write the updated config.
  const remaining: Record<string, JenkinsProfileConfig> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (!names.includes(name)) {
      remaining[name] = profile;
    }
  }
  const nextDefault = resolveDefaultProfileName({
    profiles: remaining,
    defaultProfile:
      config.defaultProfile && names.includes(config.defaultProfile)
        ? undefined
        : config.defaultProfile,
  });

  try {
    await writeUpdatedConfig(
      buildConfigPayload(config, remaining, nextDefault),
      deps,
      { rethrow: true },
    );
  } catch {
    // 4. Restore the deleted secure-store entries and report whether the
    //    rollback also failed.
    const restoreFailures = await restoreEntries(deletedEntries, deps);
    throw new CliError(
      "Failed to update the config file; no profiles were removed.",
      [
        ...describeRestoreFailures(restoreFailures),
        "Check the config file permissions and try again.",
      ],
    );
  }

  return {
    deleted: names,
    ...(nextDefault ? { nextDefault } : {}),
  };
}

/**
 * Deletes a secure-store entry and verifies it is gone. The underlying
 * `deleteToken` is best-effort and never throws, so the verification read is
 * what turns a silently failed deletion into an error.
 */
async function strictDeleteToken(
  account: string,
  deps: ProfileOperationsDeps,
): Promise<void> {
  await (deps.deleteToken ?? deleteToken)(account);
  const remaining = await (deps.getToken ?? getToken)(account);
  if (remaining !== null) {
    throw new Error("secure-store entry is still present");
  }
}

async function restoreEntries(
  entries: RetainedEntry[],
  deps: ProfileOperationsDeps,
): Promise<string[]> {
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      await (deps.setToken ?? setToken)(entry.account, entry.token);
    } catch {
      failures.push(entry.profileName);
    }
  }
  return failures;
}

function describeRestoreFailures(failedProfiles: string[]): string[] {
  if (failedProfiles.length === 0) {
    return [];
  }
  return [
    `Rollback also failed: secure-store tokens for ${failedProfiles
      .map((name) => `"${name}"`)
      .join(
        ", ",
      )} could not be restored. Run \`jenkins-cli auth login\` for them.`,
  ];
}

/**
 * Rebuilds the full config payload for a write, preserving every top-level
 * setting (including `debug` and `analyticsDisabled`).
 */
function buildConfigPayload(
  config: JenkinsConfig | undefined,
  profiles: Record<string, JenkinsProfileConfig>,
  defaultProfile: string | undefined,
): JenkinsConfig {
  return {
    version: 2,
    profiles,
    ...(defaultProfile ? { defaultProfile } : {}),
    ...(typeof config?.debug === "boolean" ? { debug: config.debug } : {}),
    ...(typeof config?.analyticsDisabled === "boolean"
      ? { analyticsDisabled: config.analyticsDisabled }
      : {}),
  };
}

async function readCurrentConfig(
  deps: ProfileOperationsDeps,
): Promise<LoadedConfig | null> {
  return await (deps.readConfig ?? migrateLegacyConfigIfNeeded)();
}

async function writeUpdatedConfig(
  config: JenkinsConfig,
  deps: ProfileOperationsDeps,
  options: { rethrow?: boolean } = {},
): Promise<void> {
  try {
    await (deps.writeConfig ?? writeConfig)(config);
  } catch (error) {
    if (options.rethrow) {
      throw error;
    }
    throw new CliError("Failed to update the config file.", [
      "Check the config file permissions and try again.",
    ]);
  }
}

function secureStoreAccessError(): CliError {
  return new CliError(
    "Unable to access the OS secure store; no changes were made.",
    ["Ensure your login keychain / keyring is unlocked and try again."],
  );
}
