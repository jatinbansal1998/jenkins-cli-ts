import { describe, expect, test } from "bun:test";
import {
  type JenkinsConfig,
  type JenkinsProfileConfig,
  KEYCHAIN_TOKEN_SENTINEL,
} from "../src/config";
import type { EnvConfig } from "../src/env";
import type { SecureStoreDeps } from "../src/secure-store";
import {
  maybePromptTokenMigration,
  shouldPromptTokenMigration,
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
  confirmCalls: string[];
  logs: string[];
  hints: string[];
  deps: TokenMigrationDeps;
};

function harness(options: {
  config: JenkinsConfig | null;
  answer: boolean | null;
  available?: boolean;
  secureStore?: SecureStoreDeps;
}): Harness {
  const saved: JenkinsConfig[] = [];
  const confirmCalls: string[] = [];
  const logs: string[] = [];
  const hints: string[] = [];
  const deps: TokenMigrationDeps = {
    isAvailable: () => options.available ?? true,
    secureStore: options.secureStore ?? linuxSecureStore(TOKEN),
    confirm: async (message) => {
      confirmCalls.push(message);
      return options.answer;
    },
    loadConfig: async () => options.config,
    saveConfig: async (config) => {
      saved.push(config);
      return "ok";
    },
    log: (line) => logs.push(line),
    hint: (line) => hints.push(line),
  };
  return { saved, confirmCalls, logs, hints, deps };
}

describe("shouldPromptTokenMigration", () => {
  const base = {
    interactive: true,
    available: true,
    env: { profileName: "work", tokenStorage: undefined },
    profile: plaintextProfile(),
  };

  test("true for an eligible plaintext profile", () => {
    expect(shouldPromptTokenMigration(base)).toBeTrue();
  });

  test("false when non-interactive", () => {
    expect(
      shouldPromptTokenMigration({ ...base, interactive: false }),
    ).toBeFalse();
  });

  test("false when secure store unavailable", () => {
    expect(
      shouldPromptTokenMigration({ ...base, available: false }),
    ).toBeFalse();
  });

  test("false without a profile name (env/one-off credentials)", () => {
    expect(
      shouldPromptTokenMigration({
        ...base,
        env: { profileName: undefined, tokenStorage: undefined },
      }),
    ).toBeFalse();
  });

  test("false when already keychain-backed", () => {
    expect(
      shouldPromptTokenMigration({
        ...base,
        profile: plaintextProfile({ tokenStorage: "keychain" }),
      }),
    ).toBeFalse();
  });

  test("false when already answered", () => {
    expect(
      shouldPromptTokenMigration({
        ...base,
        profile: plaintextProfile({ keychainPromptAnswered: true }),
      }),
    ).toBeFalse();
  });
});

describe("maybePromptTokenMigration", () => {
  test("accept: verified round-trip then config rewritten to the sentinel", async () => {
    const h = harness({
      config: configWith(plaintextProfile()),
      answer: true,
      secureStore: linuxSecureStore(TOKEN),
    });

    await maybePromptTokenMigration({
      env: env(),
      interactive: true,
      deps: h.deps,
    });

    expect(h.confirmCalls).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
    const profile = h.saved[0]?.profiles.work;
    expect(profile?.jenkinsApiToken).toBe(KEYCHAIN_TOKEN_SENTINEL);
    expect(profile?.tokenStorage).toBe("keychain");
    expect(h.logs.join("\n")).toContain("Migrated");
    expect(h.hints).toHaveLength(0);
  });

  test("decline: records the answer and leaves the token in plaintext", async () => {
    const h = harness({
      config: configWith(plaintextProfile()),
      answer: false,
    });

    await maybePromptTokenMigration({
      env: env(),
      interactive: true,
      deps: h.deps,
    });

    expect(h.confirmCalls).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
    const profile = h.saved[0]?.profiles.work;
    expect(profile?.keychainPromptAnswered).toBeTrue();
    expect(profile?.jenkinsApiToken).toBe(TOKEN);
    expect(profile?.tokenStorage).toBeUndefined();
  });

  test("decline is durable: not asked again once recorded", async () => {
    // Second run sees the recorded flag and never prompts.
    const h = harness({
      config: configWith(plaintextProfile({ keychainPromptAnswered: true })),
      answer: true,
    });

    await maybePromptTokenMigration({
      env: env(),
      interactive: true,
      deps: h.deps,
    });

    expect(h.confirmCalls).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  test("verification failure: config left unchanged, HINT printed", async () => {
    const h = harness({
      config: configWith(plaintextProfile()),
      answer: true,
      // Round-trip read returns a different value than what we stored.
      secureStore: linuxSecureStore("something-else"),
    });

    await maybePromptTokenMigration({
      env: env(),
      interactive: true,
      deps: h.deps,
    });

    expect(h.confirmCalls).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
    expect(h.hints.join("\n")).toMatch(/did not match/);
  });

  test("store failure (locked keyring): config left unchanged, HINT printed", async () => {
    const h = harness({
      config: configWith(plaintextProfile()),
      answer: true,
      secureStore: linuxSecureStore(
        TOKEN,
        new Error("the collection is locked"),
      ),
    });

    await maybePromptTokenMigration({
      env: env(),
      interactive: true,
      deps: h.deps,
    });

    expect(h.saved).toHaveLength(0);
    expect(h.hints.join("\n")).toMatch(/Could not migrate/);
  });

  test("non-interactive: never prompts and never migrates", async () => {
    const h = harness({ config: configWith(plaintextProfile()), answer: true });

    await maybePromptTokenMigration({
      env: env(),
      interactive: false,
      deps: h.deps,
    });

    expect(h.confirmCalls).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  test("secure store unavailable: never prompts and never migrates", async () => {
    const h = harness({
      config: configWith(plaintextProfile()),
      answer: true,
      available: false,
    });

    await maybePromptTokenMigration({
      env: env(),
      interactive: true,
      deps: h.deps,
    });

    expect(h.confirmCalls).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  test("env/one-off credentials (no profile): never prompts", async () => {
    const h = harness({ config: configWith(plaintextProfile()), answer: true });

    await maybePromptTokenMigration({
      env: env({ profileName: undefined }),
      interactive: true,
      deps: h.deps,
    });

    expect(h.confirmCalls).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  test("cancel: does not record and does not migrate", async () => {
    const h = harness({ config: configWith(plaintextProfile()), answer: null });

    await maybePromptTokenMigration({
      env: env(),
      interactive: true,
      deps: h.deps,
    });

    expect(h.confirmCalls).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
  });
});
