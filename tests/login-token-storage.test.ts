import { describe, expect, test } from "bun:test";
import {
  getLoginInstructions,
  planTokenPersistence,
  type LoginOptions,
} from "../src/commands/login";
import { KEYCHAIN_TOKEN_SENTINEL } from "../src/config";
import {
  buildSecureStoreAccount,
  type SecureStoreDeps,
} from "../src/secure-store";

const TOKEN = "jenkins-secret";
const PROFILE = "work";
const URL = "https://jenkins.example.com";
const ACCOUNT = buildSecureStoreAccount(PROFILE, URL);

function loginOptions(overrides: Partial<LoginOptions> = {}): LoginOptions {
  return {
    nonInteractive: true,
    ...overrides,
  };
}

function secureStore(options: { verifyAs?: string | null } = {}): {
  deps: SecureStoreDeps;
  stored: Map<string, string>;
} {
  const stored = new Map<string, string>();
  return {
    stored,
    deps: {
      keychain: {
        listBackends: async () => [
          {
            id: "native-linux",
            name: "Native Freedesktop Secret Service",
            priority: 10,
          },
        ],
        setPassword: async (_service, account, token) => {
          stored.set(account, token);
        },
        getPassword: async (_service, account) =>
          options.verifyAs !== undefined
            ? options.verifyAs
            : (stored.get(account) ?? null),
        deletePassword: async (_service, account) => {
          stored.delete(account);
        },
      },
    },
  };
}

describe("login token persistence", () => {
  test("stores and verifies a new login token in the secure store", async () => {
    const store = secureStore();

    const plan = await planTokenPersistence(
      {
        options: loginOptions(),
        profileName: PROFILE,
        normalizedUrl: URL,
        apiToken: TOKEN,
        existingProfile: undefined,
      },
      { secureStore: store.deps },
    );

    expect(store.stored.get(ACCOUNT)).toBe(TOKEN);
    expect(plan).toMatchObject({
      tokenStorage: "keychain",
      tokenForConfig: KEYCHAIN_TOKEN_SENTINEL,
    });
    expect(plan.rollback).toBeFunction();

    await plan.rollback?.();
    expect(store.stored.size).toBe(0);
  });

  test("verification failure falls back without suppressing later migration", async () => {
    const store = secureStore({ verifyAs: null });
    const hints: string[] = [];

    const plan = await planTokenPersistence(
      {
        options: loginOptions(),
        profileName: PROFILE,
        normalizedUrl: URL,
        apiToken: TOKEN,
        existingProfile: undefined,
      },
      { secureStore: store.deps, hint: (message) => hints.push(message) },
    );

    expect(plan).toEqual({ tokenStorage: undefined, tokenForConfig: TOKEN });
    expect(plan.secureStorageOptOut).toBeUndefined();
    expect(store.stored.size).toBe(0);
    expect(hints.join("\n")).toContain("could not be verified");
  });

  test("an unavailable secure store keeps the profile migration-eligible", async () => {
    const plan = await planTokenPersistence(
      {
        options: loginOptions(),
        profileName: PROFILE,
        normalizedUrl: URL,
        apiToken: TOKEN,
        existingProfile: undefined,
      },
      {
        secureStore: {
          keychain: { listBackends: async () => [] },
        },
        hint: () => undefined,
      },
    );

    expect(plan.tokenForConfig).toBe(TOKEN);
    expect(plan.secureStorageOptOut).toBeUndefined();
  });

  test("--no-keychain records the explicit plaintext choice", async () => {
    const store = secureStore();

    const plan = await planTokenPersistence(
      {
        options: loginOptions({ noKeychain: true }),
        profileName: PROFILE,
        normalizedUrl: URL,
        apiToken: TOKEN,
        existingProfile: undefined,
      },
      { secureStore: store.deps },
    );

    expect(plan.secureStorageOptOut).toBeTrue();
    expect(store.stored.size).toBe(0);
  });

  test("rollback restores a previous secure token after config failure", async () => {
    const store = secureStore();
    store.stored.set(ACCOUNT, "previous-token");

    const plan = await planTokenPersistence(
      {
        options: loginOptions(),
        profileName: PROFILE,
        normalizedUrl: URL,
        apiToken: TOKEN,
        existingProfile: {
          jenkinsUrl: URL,
          jenkinsUser: "ci-user",
          jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
          tokenStorage: "keychain",
        },
      },
      { secureStore: store.deps },
    );

    expect(store.stored.get(ACCOUNT)).toBe(TOKEN);
    await plan.rollback?.();
    expect(store.stored.get(ACCOUNT)).toBe("previous-token");
  });

  test("plaintext conversion deletes the prior entry only after commit", async () => {
    const store = secureStore();
    store.stored.set(ACCOUNT, "previous-token");

    const plan = await planTokenPersistence(
      {
        options: loginOptions({ noKeychain: true }),
        profileName: PROFILE,
        normalizedUrl: URL,
        apiToken: TOKEN,
        existingProfile: {
          jenkinsUrl: URL,
          jenkinsUser: "ci-user",
          jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
          tokenStorage: "keychain",
        },
      },
      { secureStore: store.deps },
    );

    expect(store.stored.get(ACCOUNT)).toBe("previous-token");
    await plan.commit?.();
    expect(store.stored.has(ACCOUNT)).toBeFalse();
  });

  test("changing a host moves the existing token only after config commit", async () => {
    const store = secureStore();
    const previousAccount = buildSecureStoreAccount(
      PROFILE,
      "https://old.example.com",
    );
    store.stored.set(previousAccount, TOKEN);

    const plan = await planTokenPersistence(
      {
        options: loginOptions(),
        profileName: PROFILE,
        normalizedUrl: URL,
        apiToken: KEYCHAIN_TOKEN_SENTINEL,
        existingProfile: {
          jenkinsUrl: "https://old.example.com",
          jenkinsUser: "ci-user",
          jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
          tokenStorage: "keychain",
        },
      },
      { secureStore: store.deps },
    );

    expect(store.stored.get(ACCOUNT)).toBe(TOKEN);
    expect(store.stored.get(previousAccount)).toBe(TOKEN);
    await plan.commit?.();
    expect(store.stored.has(previousAccount)).toBeFalse();
  });
});

describe("post-login guidance", () => {
  test("secure profiles do not show exports or echo the token", () => {
    const output = getLoginInstructions({
      profileName: PROFILE,
      normalizedUrl: URL,
      user: "ci-user",
      branchParam: "BRANCH",
      plan: {
        tokenStorage: "keychain",
        tokenForConfig: KEYCHAIN_TOKEN_SENTINEL,
      },
      secureStoreName: "Freedesktop Secret Service",
    }).join("\n");

    expect(output).toContain("--profile 'work'");
    expect(output).toContain("Freedesktop Secret Service");
    expect(output).not.toContain("export");
    expect(output).not.toContain(TOKEN);
  });

  test("plaintext fallback retains shell export guidance", () => {
    const output = getLoginInstructions({
      profileName: PROFILE,
      normalizedUrl: URL,
      user: "ci-user",
      branchParam: "BRANCH",
      plan: { tokenForConfig: TOKEN },
    }).join("\n");

    expect(output).toContain("export JENKINS_API_TOKEN='jenkins-secret'");
  });
});
