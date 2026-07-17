import { describe, expect, test } from "bun:test";
import { CliError } from "../src/cli";
import type { JenkinsConfig } from "../src/config";
import { buildSecureStoreAccount } from "../src/secure-store";
import {
  deleteAllProfiles,
  deleteProfilesStrict,
  listProfiles,
  renameProfile,
  selectProfile,
  type ProfileOperationsDeps,
} from "../src/profile-operations";

type Harness = {
  deps: ProfileOperationsDeps;
  /** Current config as last written (null when never written / no config). */
  config: () => JenkinsConfig | null;
  store: Map<string, string>;
  writes: JenkinsConfig[];
};

function makeHarness(
  initialConfig: JenkinsConfig | null,
  initialStore: Record<string, string> = {},
  overrides: Partial<ProfileOperationsDeps> = {},
): Harness {
  let current = initialConfig;
  const store = new Map(Object.entries(initialStore));
  const writes: JenkinsConfig[] = [];
  const deps: ProfileOperationsDeps = {
    readConfig: async () =>
      current
        ? { config: structuredClone(current), legacyDetected: false }
        : null,
    writeConfig: async (config) => {
      current = structuredClone(config);
      writes.push(structuredClone(config));
      return "/tmp/jenkins-cli-config.json";
    },
    getToken: async (account) => store.get(account) ?? null,
    setToken: async (account, token) => {
      store.set(account, token);
    },
    deleteToken: async (account) => store.delete(account),
    ...overrides,
  };
  return { deps, config: () => current, store, writes };
}

const URL_A = "https://jenkins-a.example.com";
const URL_B = "https://jenkins-b.example.com";

function twoProfileConfig(): JenkinsConfig {
  return {
    version: 2,
    defaultProfile: "work",
    debug: true,
    analyticsDisabled: true,
    profiles: {
      work: {
        jenkinsUrl: URL_A,
        jenkinsUser: "ci-work",
        jenkinsApiToken: "@keychain",
        tokenStorage: "keychain",
      },
      home: {
        jenkinsUrl: URL_B,
        jenkinsUser: "ci-home",
        jenkinsApiToken: "plain-token",
        branchParam: "GIT_BRANCH",
      },
    },
  };
}

const WORK_ACCOUNT = buildSecureStoreAccount("work", URL_A);

describe("listProfiles", () => {
  test("returns an empty collection when no config exists", async () => {
    const harness = makeHarness(null);
    const result = await listProfiles(harness.deps);
    expect(result.profiles).toEqual([]);
    expect(result.defaultProfile).toBeUndefined();
  });

  test("marks the default profile and reports token storage", async () => {
    const harness = makeHarness(twoProfileConfig());
    const result = await listProfiles(harness.deps);
    expect(result.defaultProfile).toBe("work");
    expect(result.profiles).toEqual([
      {
        name: "work",
        jenkinsUrl: URL_A,
        jenkinsUser: "ci-work",
        tokenStorage: "keychain",
        isDefault: true,
      },
      {
        name: "home",
        jenkinsUrl: URL_B,
        jenkinsUser: "ci-home",
        tokenStorage: "plaintext",
        isDefault: false,
      },
    ]);
  });

  test("falls back to the first profile when defaultProfile is unset", async () => {
    const config = twoProfileConfig();
    delete config.defaultProfile;
    const harness = makeHarness(config);
    const result = await listProfiles(harness.deps);
    expect(result.defaultProfile).toBe("work");
    expect(result.profiles[0]?.isDefault).toBe(true);
  });
});

describe("selectProfile", () => {
  test("rejects an empty name", async () => {
    const harness = makeHarness(twoProfileConfig());
    await expect(selectProfile("   ", harness.deps)).rejects.toThrow(
      "Profile name is required.",
    );
  });

  test("rejects an unknown name and lists available profiles", async () => {
    const harness = makeHarness(twoProfileConfig());
    const error = await selectProfile("missing", harness.deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      'Profile "missing" was not found.',
    );
    expect((error as CliError).hints.join(" ")).toContain("work, home");
    expect(harness.writes).toHaveLength(0);
  });

  test("rejects when no profiles are configured", async () => {
    const harness = makeHarness(null);
    await expect(selectProfile("work", harness.deps)).rejects.toThrow(
      "No profiles are configured.",
    );
  });

  test("selecting the already-active profile is a successful no-op", async () => {
    const harness = makeHarness(twoProfileConfig());
    const result = await selectProfile("work", harness.deps);
    expect(result).toEqual({ profileName: "work", changed: false });
    expect(harness.writes).toHaveLength(0);
  });

  test("sets the default profile and preserves top-level settings", async () => {
    const harness = makeHarness(twoProfileConfig());
    const result = await selectProfile("home", harness.deps);
    expect(result).toEqual({ profileName: "home", changed: true });
    const written = harness.config();
    expect(written?.defaultProfile).toBe("home");
    expect(written?.debug).toBe(true);
    expect(written?.analyticsDisabled).toBe(true);
    expect(Object.keys(written?.profiles ?? {})).toEqual(["work", "home"]);
  });
});

describe("deleteProfilesStrict", () => {
  test("rejects unknown profiles before making any change", async () => {
    const harness = makeHarness(twoProfileConfig(), {
      [WORK_ACCOUNT]: "secret",
    });
    await expect(
      deleteProfilesStrict(["missing"], harness.deps),
    ).rejects.toThrow('Profile "missing" was not found.');
    expect(harness.writes).toHaveLength(0);
    expect(harness.store.get(WORK_ACCOUNT)).toBe("secret");
  });

  test("deletes a plaintext profile without touching the secure store", async () => {
    const harness = makeHarness(twoProfileConfig(), {
      [WORK_ACCOUNT]: "secret",
    });
    const result = await deleteProfilesStrict(["home"], harness.deps);
    expect(result).toEqual({ deleted: ["home"], nextDefault: "work" });
    expect(harness.config()?.profiles.home).toBeUndefined();
    expect(harness.store.get(WORK_ACCOUNT)).toBe("secret");
  });

  test("deletes a keychain profile and its secure-store entry", async () => {
    const harness = makeHarness(twoProfileConfig(), {
      [WORK_ACCOUNT]: "secret",
    });
    const result = await deleteProfilesStrict(["work"], harness.deps);
    expect(result).toEqual({ deleted: ["work"], nextDefault: "home" });
    expect(harness.store.has(WORK_ACCOUNT)).toBe(false);
    const written = harness.config();
    expect(Object.keys(written?.profiles ?? {})).toEqual(["home"]);
    expect(written?.defaultProfile).toBe("home");
    expect(written?.debug).toBe(true);
    expect(written?.analyticsDisabled).toBe(true);
  });

  test("succeeds when the keychain token is already absent", async () => {
    const harness = makeHarness(twoProfileConfig());
    const result = await deleteProfilesStrict(["work"], harness.deps);
    expect(result.deleted).toEqual(["work"]);
    expect(harness.config()?.profiles.work).toBeUndefined();
  });

  test("a secure-store read error fails before the config is changed", async () => {
    const harness = makeHarness(
      twoProfileConfig(),
      {},
      {
        getToken: async () => {
          throw new Error("keyring locked: secret-detail");
        },
      },
    );
    const error = await deleteProfilesStrict(["work"], harness.deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain(
      "Unable to access the OS secure store",
    );
    expect((error as CliError).message).not.toContain("secret-detail");
    expect(harness.writes).toHaveLength(0);
  });

  test("a silently failed deletion is caught by verification and the config is unchanged", async () => {
    const harness = makeHarness(
      twoProfileConfig(),
      { [WORK_ACCOUNT]: "secret" },
      {
        // Simulates a backend that reports success without deleting.
        deleteToken: async () => false,
      },
    );
    const error = await deleteProfilesStrict(["work"], harness.deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain(
      'Unable to delete the secure-store token for profile "work"',
    );
    expect(harness.writes).toHaveLength(0);
    expect(harness.store.get(WORK_ACCOUNT)).toBe("secret");
  });

  test("a verification read error fails the operation before the config write", async () => {
    let reads = 0;
    const store = new Map([[WORK_ACCOUNT, "secret"]]);
    const harness = makeHarness(
      twoProfileConfig(),
      {},
      {
        getToken: async (account) => {
          reads += 1;
          if (reads > 1) {
            throw new Error("keyring became unavailable");
          }
          return store.get(account) ?? null;
        },
        deleteToken: async (account) => store.delete(account),
      },
    );
    await expect(deleteProfilesStrict(["work"], harness.deps)).rejects.toThrow(
      /Unable to delete the secure-store token/,
    );
    expect(harness.writes).toHaveLength(0);
  });

  test("restores deleted secure-store entries when the config write fails", async () => {
    const harness = makeHarness(
      twoProfileConfig(),
      { [WORK_ACCOUNT]: "secret" },
      {
        writeConfig: async () => {
          throw new Error("disk full");
        },
      },
    );
    const error = await deleteProfilesStrict(["work"], harness.deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      "Failed to update the config file; no profiles were removed.",
    );
    expect((error as CliError).hints.join(" ")).not.toContain("Rollback");
    expect(harness.store.get(WORK_ACCOUNT)).toBe("secret");
  });

  test("reports when the rollback after a failed config write also fails", async () => {
    const harness = makeHarness(
      twoProfileConfig(),
      { [WORK_ACCOUNT]: "secret" },
      {
        writeConfig: async () => {
          throw new Error("disk full");
        },
        setToken: async () => {
          throw new Error("keyring rejected the write");
        },
      },
    );
    const error = await deleteProfilesStrict(["work"], harness.deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).hints.join(" ")).toContain(
      "Rollback also failed",
    );
    expect((error as CliError).hints.join(" ")).toContain('"work"');
  });

  test("preserves unrelated profiles and top-level settings", async () => {
    const config = twoProfileConfig();
    const harness = makeHarness(config, { [WORK_ACCOUNT]: "secret" });
    await deleteProfilesStrict(["work"], harness.deps);
    const written = harness.config();
    expect(written?.profiles.home).toEqual(config.profiles.home!);
    expect(written?.debug).toBe(true);
    expect(written?.analyticsDisabled).toBe(true);
  });
});

describe("deleteAllProfiles", () => {
  test("an empty profile set is a successful no-op", async () => {
    const harness = makeHarness(null);
    const result = await deleteAllProfiles(harness.deps);
    expect(result).toEqual({ deleted: [] });
    expect(harness.writes).toHaveLength(0);
  });

  test("deletes every profile and all matching secure-store entries", async () => {
    const harness = makeHarness(twoProfileConfig(), {
      [WORK_ACCOUNT]: "secret",
    });
    const result = await deleteAllProfiles(harness.deps);
    expect(result.deleted.sort()).toEqual(["home", "work"]);
    expect(result.nextDefault).toBeUndefined();
    expect(harness.store.size).toBe(0);
    expect(harness.config()?.profiles).toEqual({});
    expect(harness.config()?.debug).toBe(true);
    expect(harness.config()?.analyticsDisabled).toBe(true);
  });

  test("restores already-deleted entries when a later deletion fails", async () => {
    const config: JenkinsConfig = {
      version: 2,
      defaultProfile: "one",
      profiles: {
        one: {
          jenkinsUrl: URL_A,
          jenkinsUser: "u1",
          jenkinsApiToken: "@keychain",
          tokenStorage: "keychain",
        },
        two: {
          jenkinsUrl: URL_B,
          jenkinsUser: "u2",
          jenkinsApiToken: "@keychain",
          tokenStorage: "keychain",
        },
      },
    };
    const oneAccount = buildSecureStoreAccount("one", URL_A);
    const twoAccount = buildSecureStoreAccount("two", URL_B);
    const store = new Map([
      [oneAccount, "token-one"],
      [twoAccount, "token-two"],
    ]);
    const harness = makeHarness(
      config,
      {},
      {
        getToken: async (account) => store.get(account) ?? null,
        setToken: async (account, token) => {
          store.set(account, token);
        },
        deleteToken: async (account) => {
          if (account === twoAccount) {
            return false; // deletion silently fails; entry remains
          }
          return store.delete(account);
        },
      },
    );

    const error = await deleteAllProfiles(harness.deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('profile "two"');
    // The first entry was restored and the config never changed.
    expect(store.get(oneAccount)).toBe("token-one");
    expect(store.get(twoAccount)).toBe("token-two");
    expect(harness.writes).toHaveLength(0);
  });
});

describe("renameProfile", () => {
  test("rejects empty names", async () => {
    const harness = makeHarness(twoProfileConfig());
    await expect(renameProfile("", "next", harness.deps)).rejects.toThrow(
      "Profile names are required.",
    );
    await expect(renameProfile("work", "  ", harness.deps)).rejects.toThrow(
      "Profile names are required.",
    );
  });

  test("rejects an unknown source", async () => {
    const harness = makeHarness(twoProfileConfig());
    await expect(
      renameProfile("missing", "next", harness.deps),
    ).rejects.toThrow('Profile "missing" was not found.');
  });

  test("rejects an already-existing destination", async () => {
    const harness = makeHarness(twoProfileConfig());
    await expect(renameProfile("work", "home", harness.deps)).rejects.toThrow(
      'Profile "home" already exists.',
    );
    expect(harness.writes).toHaveLength(0);
  });

  test("a rename to the same normalized name is a successful no-op", async () => {
    const harness = makeHarness(twoProfileConfig(), {
      [WORK_ACCOUNT]: "secret",
    });
    const result = await renameProfile("work", "  work  ", harness.deps);
    expect(result).toEqual({
      from: "work",
      to: "work",
      isDefault: true,
      changed: false,
    });
    expect(harness.writes).toHaveLength(0);
    expect(harness.store.get(WORK_ACCOUNT)).toBe("secret");
  });

  test("renames a plaintext profile atomically in the config", async () => {
    const harness = makeHarness(twoProfileConfig());
    const result = await renameProfile("home", "personal", harness.deps);
    expect(result).toEqual({
      from: "home",
      to: "personal",
      isDefault: false,
      changed: true,
    });
    const written = harness.config();
    expect(Object.keys(written?.profiles ?? {})).toEqual(["work", "personal"]);
    expect(written?.profiles.personal?.jenkinsApiToken).toBe("plain-token");
    expect(written?.profiles.personal?.branchParam).toBe("GIT_BRANCH");
    expect(written?.defaultProfile).toBe("work");
    expect(written?.debug).toBe(true);
    expect(written?.analyticsDisabled).toBe(true);
  });

  test("renames the default profile reference when the source is active", async () => {
    const harness = makeHarness(twoProfileConfig(), {
      [WORK_ACCOUNT]: "secret",
    });
    const result = await renameProfile("work", "corp", harness.deps);
    expect(result.isDefault).toBe(true);
    expect(harness.config()?.defaultProfile).toBe("corp");
  });

  test("migrates the keychain token to the new account", async () => {
    const harness = makeHarness(twoProfileConfig(), {
      [WORK_ACCOUNT]: "secret",
    });
    await renameProfile("work", "corp", harness.deps);
    const corpAccount = buildSecureStoreAccount("corp", URL_A);
    expect(harness.store.get(corpAccount)).toBe("secret");
    expect(harness.store.has(WORK_ACCOUNT)).toBe(false);
    expect(harness.config()?.profiles.corp?.tokenStorage).toBe("keychain");
  });

  test("renames a keychain profile whose token is already missing", async () => {
    const harness = makeHarness(twoProfileConfig());
    await renameProfile("work", "corp", harness.deps);
    expect(harness.store.size).toBe(0);
    expect(harness.config()?.profiles.corp?.tokenStorage).toBe("keychain");
  });

  test("a destination write failure makes no changes", async () => {
    const harness = makeHarness(
      twoProfileConfig(),
      { [WORK_ACCOUNT]: "secret" },
      {
        setToken: async () => {
          throw new Error("keyring rejected the write");
        },
      },
    );
    await expect(renameProfile("work", "corp", harness.deps)).rejects.toThrow(
      "Unable to write the renamed token to the OS secure store",
    );
    expect(harness.writes).toHaveLength(0);
    expect(harness.store.get(WORK_ACCOUNT)).toBe("secret");
  });

  test("a config write failure removes the new entry and keeps the old one", async () => {
    const harness = makeHarness(
      twoProfileConfig(),
      { [WORK_ACCOUNT]: "secret" },
      {
        writeConfig: async () => {
          throw new Error("disk full");
        },
      },
    );
    const error = await renameProfile("work", "corp", harness.deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      "Failed to update the config file; the rename was not applied.",
    );
    expect((error as CliError).hints.join(" ")).not.toContain("Rollback");
    const corpAccount = buildSecureStoreAccount("corp", URL_A);
    expect(harness.store.has(corpAccount)).toBe(false);
    expect(harness.store.get(WORK_ACCOUNT)).toBe("secret");
  });

  test("a failed old-entry deletion rolls back the config and destination entry", async () => {
    const corpAccount = buildSecureStoreAccount("corp", URL_A);
    const store = new Map([[WORK_ACCOUNT, "secret"]]);
    const harness = makeHarness(
      twoProfileConfig(),
      {},
      {
        getToken: async (account) => store.get(account) ?? null,
        setToken: async (account, token) => {
          store.set(account, token);
        },
        deleteToken: async (account) => {
          if (account === WORK_ACCOUNT) {
            return false; // old entry deletion silently fails
          }
          return store.delete(account);
        },
      },
    );

    const error = await renameProfile("work", "corp", harness.deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      "Failed to remove the old secure-store entry; the rename was rolled back.",
    );
    // Original state restored: old entry present, no duplicate, config back.
    expect(store.get(WORK_ACCOUNT)).toBe("secret");
    expect(store.has(corpAccount)).toBe(false);
    expect(harness.config()?.profiles.work).toBeDefined();
    expect(harness.config()?.profiles.corp).toBeUndefined();
  });

  test("reports a rollback failure that leaves a duplicate token", async () => {
    const corpAccount = buildSecureStoreAccount("corp", URL_A);
    const store = new Map([[WORK_ACCOUNT, "secret"]]);
    const harness = makeHarness(
      twoProfileConfig(),
      {},
      {
        getToken: async (account) => store.get(account) ?? null,
        setToken: async (account, token) => {
          store.set(account, token);
        },
        // After the config write, every deletion fails: neither the old entry
        // nor the rollback of the new entry can be removed.
        deleteToken: async () => false,
      },
    );

    const error = await renameProfile("work", "corp", harness.deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).hints.join(" ")).toContain(
      "duplicate secure-store entry",
    );
    expect(store.get(WORK_ACCOUNT)).toBe("secret");
    expect(store.get(corpAccount)).toBe("secret");
  });
});
