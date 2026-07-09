import { describe, expect, test } from "bun:test";
import { CliError } from "../src/cli";
import { KEYCHAIN_TOKEN_SENTINEL } from "../src/config";
import { type EnvConfig, resolveApiToken } from "../src/env";
import type {
  SecureStoreCommandResult,
  SecureStoreDeps,
} from "../src/secure-store";

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

function linuxDeps(result: SecureStoreCommandResult): SecureStoreDeps {
  return {
    platform: "linux",
    hasBinary: () => true,
    run: async () => result,
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
      linuxDeps({ exitCode: 0, stdout: "resolved-secret\n", stderr: "" }),
    );
    expect(token).toBe("resolved-secret");
  });

  test("throws a CliError with hints when the entry is missing", async () => {
    const env = baseEnv({
      jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
      tokenStorage: "keychain",
    });
    // Absent item: non-zero exit with empty stderr => getToken returns null.
    const promise = resolveApiToken(
      env,
      linuxDeps({ exitCode: 1, stdout: "", stderr: "" }),
    );
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
      linuxDeps({
        exitCode: 1,
        stdout: "",
        stderr: "the collection is locked",
      }),
    );
    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow(
      /Unable to read the Jenkins API token/,
    );
  });
});
