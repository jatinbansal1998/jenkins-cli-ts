import { describe, expect, test } from "bun:test";
import { CliError } from "../src/cli";
import { KEYCHAIN_TOKEN_SENTINEL } from "../src/config";
import { type EnvConfig, resolveApiToken } from "../src/env";
import type { SecureStoreDeps } from "../src/secure-store";

function baseEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    jenkinsUrl: "https://jenkins.example.com",
    jenkinsUser: "user",
    jenkinsApiToken: "plain-token",
    profileName: "work",
    branchParamDefault: "BRANCH",
    useCrumb: false,
    folderDepth: 3,
    ...overrides,
  };
}

function secureStoreDeps(options: {
  token?: string | null;
  error?: Error;
}): SecureStoreDeps {
  return {
    keychain: {
      getPassword: async () => {
        if (options.error) {
          throw options.error;
        }
        return options.token ?? null;
      },
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

describe("resolveApiToken", () => {
  test("returns the plaintext token unchanged for non-keychain profiles", async () => {
    const env = baseEnv({ jenkinsApiToken: "plain-token" });
    expect(await resolveApiToken(env)).toBe("plain-token");
  });

  test("resolves keychain-backed tokens from the secure store", async () => {
    const env = baseEnv({
      jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
      tokenStorage: "keychain",
    });
    const token = await resolveApiToken(
      env,
      secureStoreDeps({ token: "resolved-secret" }),
    );
    expect(token).toBe("resolved-secret");
  });

  test("throws a CliError with hints when the entry is missing", async () => {
    const env = baseEnv({
      jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
      tokenStorage: "keychain",
    });
    // Absent item: non-zero exit with empty stderr => getToken returns null.
    const promise = resolveApiToken(env, secureStoreDeps({ token: null }));
    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow(/No Jenkins API token found/);
  });

  test("throws a CliError when the keyring is locked/unavailable", async () => {
    const env = baseEnv({
      jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
      tokenStorage: "keychain",
    });
    const promise = resolveApiToken(
      env,
      secureStoreDeps({ error: new Error("the collection is locked") }),
    );
    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow(
      /Unable to read the Jenkins API token/,
    );
  });
});
