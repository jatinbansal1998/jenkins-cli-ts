import { describe, expect, test } from "bun:test";
import {
  type JenkinsConfig,
  type JenkinsProfileConfig,
  KEYCHAIN_TOKEN_SENTINEL,
} from "../src/config";
import type { EnvConfig } from "../src/env";
import type { SecureStoreDeps } from "../src/secure-store";
import {
  maybeMigrateToken,
  shouldMigrateToken,
  type TokenMigrationDeps,
} from "../src/token-migration";

const TOKEN = "plaintext-secret";

function plaintextProfile(
  overrides: Partial<JenkinsProfileConfig> = {},
): JenkinsProfileConfig {
  return {
    jenkinsUrl: "https://jenkins.example.com",
    jenkinsUser: "user",
    jenkinsApiToken: TOKEN,
    ...overrides,
  };
}

function configWith(profile: JenkinsProfileConfig): JenkinsConfig {
  return {
    version: 2,
    defaultProfile: "work",
    profiles: { work: profile },
  };
}

function env(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    jenkinsUrl: "https://jenkins.example.com",
    jenkinsUser: "user",
    jenkinsApiToken: TOKEN,
    profileName: "work",
    branchParamDefault: "BRANCH",
    useCrumb: false,
    folderDepth: 3,
    ...overrides,
  };
}

/** Fake cross-keychain adapter: store succeeds; lookup returns `lookupToken`. */
function linuxSecureStore(
  lookupToken: string | null,
  storeError?: Error,
): SecureStoreDeps {
  return {
    keychain: {
      setPassword: async () => {
        if (storeError) {
          throw storeError;
        }
      },
      getPassword: async () => lookupToken,
      deletePassword: async () => undefined,
      listBackends: async () => [
        {
          id: "native-linux",
          name: "Native Freedesktop Secret Service",
          priority: 10,
        },
      ],
    },
  };
}

type Harness = {
  saved: JenkinsConfig[];
  logs: string[];
  hints: string[];
  deps: TokenMigrationDeps;
};

function harness(options: {
  config: JenkinsConfig | null;
  available?: boolean;
  secureStore?: SecureStoreDeps;
  saveError?: Error;
}): Harness {
  const saved: JenkinsConfig[] = [];
  const logs: string[] = [];
  const hints: string[] = [];
  const deps: TokenMigrationDeps = {
    isAvailable: () => options.available ?? true,
    secureStore: options.secureStore ?? linuxSecureStore(TOKEN),
    loadConfig: async () => options.config,
    saveConfig: async (config) => {
      if (options.saveError) {
        throw options.saveError;
      }
      saved.push(config);
      return "ok";
    },
    log: (line) => logs.push(line),
    hint: (line) => hints.push(line),
  };
  return { saved, logs, hints, deps };
}

describe("shouldMigrateToken", () => {
  const base = {
    available: true,
    env: { profileName: "work", tokenStorage: undefined },
    profile: plaintextProfile(),
  };

  test("true for an eligible plaintext profile", () => {
    expect(shouldMigrateToken(base)).toBeTrue();
  });

  test("false when secure store unavailable", () => {
    expect(shouldMigrateToken({ ...base, available: false })).toBeFalse();
  });

  test("false without a profile name (env/one-off credentials)", () => {
    expect(
      shouldMigrateToken({
        ...base,
        env: { profileName: undefined, tokenStorage: undefined },
      }),
    ).toBeFalse();
  });

  test("false when already keychain-backed", () => {
    expect(
      shouldMigrateToken({
        ...base,
        profile: plaintextProfile({ tokenStorage: "keychain" }),
      }),
    ).toBeFalse();
  });

  test("false when --no-keychain was explicitly requested", () => {
    expect(
      shouldMigrateToken({
        ...base,
        profile: plaintextProfile({ secureStorageOptOut: true }),
      }),
    ).toBeFalse();
  });
});

describe("maybeMigrateToken", () => {
  test("automatically verifies and migrates an eligible profile", async () => {
    const h = harness({
      config: configWith(plaintextProfile()),
      secureStore: linuxSecureStore(TOKEN),
    });

    await maybeMigrateToken({
      env: env(),
      report: true,
      deps: h.deps,
    });

    expect(h.saved).toHaveLength(1);
    const profile = h.saved[0]?.profiles.work;
    expect(profile?.jenkinsApiToken).toBe(KEYCHAIN_TOKEN_SENTINEL);
    expect(profile?.tokenStorage).toBe("keychain");
    expect(h.logs.join("\n")).toContain("Migrated");
    expect(h.hints).toHaveLength(0);
  });

  test("an explicit --no-keychain preference skips migration", async () => {
    const h = harness({
      config: configWith(plaintextProfile({ secureStorageOptOut: true })),
    });

    await maybeMigrateToken({
      env: env(),
      report: true,
      deps: h.deps,
    });

    expect(h.saved).toHaveLength(0);
  });

  test("verification failure: config left unchanged, HINT printed", async () => {
    const h = harness({
      config: configWith(plaintextProfile()),
      // Round-trip read returns a different value than what we stored.
      secureStore: linuxSecureStore("something-else"),
    });

    await maybeMigrateToken({
      env: env(),
      report: true,
      deps: h.deps,
    });

    expect(h.saved).toHaveLength(0);
    expect(h.hints.join("\n")).toMatch(/Could not verify/);
  });

  test("store failure (locked keyring): config left unchanged, HINT printed", async () => {
    const h = harness({
      config: configWith(plaintextProfile()),
      secureStore: linuxSecureStore(
        TOKEN,
        new Error("the collection is locked"),
      ),
    });

    await maybeMigrateToken({
      env: env(),
      report: true,
      deps: h.deps,
    });

    expect(h.saved).toHaveLength(0);
    expect(h.hints.join("\n")).toMatch(/Could not migrate/);
  });

  test("non-interactive execution migrates without printing", async () => {
    const h = harness({ config: configWith(plaintextProfile()) });

    await maybeMigrateToken({
      env: env(),
      report: false,
      deps: h.deps,
    });

    expect(h.saved).toHaveLength(1);
    expect(h.logs).toHaveLength(0);
    expect(h.hints).toHaveLength(0);
  });

  test("secure store unavailable: leaves plaintext config unchanged", async () => {
    const h = harness({
      config: configWith(plaintextProfile()),
      available: false,
    });

    await maybeMigrateToken({
      env: env(),
      report: true,
      deps: h.deps,
    });

    expect(h.saved).toHaveLength(0);
  });

  test("env/one-off credentials (no profile): never migrates", async () => {
    const h = harness({ config: configWith(plaintextProfile()) });

    await maybeMigrateToken({
      env: env({ profileName: undefined }),
      report: true,
      deps: h.deps,
    });

    expect(h.saved).toHaveLength(0);
  });

  test("config write failure leaves the plaintext profile active", async () => {
    const h = harness({
      config: configWith(plaintextProfile()),
      saveError: new Error("config is read-only"),
    });

    await expect(
      maybeMigrateToken({ env: env(), report: true, deps: h.deps }),
    ).resolves.toBeUndefined();

    expect(h.saved).toHaveLength(0);
    expect(h.hints.join("\n")).toContain("plaintext config remains active");
  });
});
