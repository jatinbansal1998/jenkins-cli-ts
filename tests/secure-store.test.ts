import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildSecureStoreAccount,
  deleteToken,
  getToken,
  isSecureStoreAvailable,
  secureStoreLabel,
  SecureStoreError,
  setToken,
  type SecureStoreDeps,
} from "../src/secure-store";

const osBackends = [
  {
    id: "native-linux",
    name: "Native Freedesktop Secret Service",
    priority: 10,
  },
];

function makeDeps(options: {
  getPassword?: SecureStoreDeps["keychain"] extends infer K
    ? K extends { getPassword?: infer F }
      ? F
      : never
    : never;
  setPassword?: SecureStoreDeps["keychain"] extends infer K
    ? K extends { setPassword?: infer F }
      ? F
      : never
    : never;
  deletePassword?: SecureStoreDeps["keychain"] extends infer K
    ? K extends { deletePassword?: infer F }
      ? F
      : never
    : never;
  listBackends?: SecureStoreDeps["keychain"] extends infer K
    ? K extends { listBackends?: infer F }
      ? F
      : never
    : never;
}): SecureStoreDeps {
  return {
    keychain: {
      getPassword: options.getPassword,
      setPassword: options.setPassword,
      deletePassword: options.deletePassword,
      listBackends: options.listBackends,
    },
  };
}

describe("buildSecureStoreAccount", () => {
  test("combines profile name and host", () => {
    expect(
      buildSecureStoreAccount("work", "https://jenkins.example.com/ci"),
    ).toBe("work@jenkins.example.com");
  });

  test("falls back to default name and raw value for bad URLs", () => {
    expect(buildSecureStoreAccount("  ", "not a url")).toBe(
      "default@not a url",
    );
  });
});

describe("isSecureStoreAvailable", () => {
  test("true when cross-keychain reports an OS credential backend", async () => {
    expect(
      await isSecureStoreAvailable(
        makeDeps({ listBackends: async () => osBackends }),
      ),
    ).toBeTrue();
  });

  test("false for cross-keychain file/null fallback backends", async () => {
    expect(
      await isSecureStoreAvailable(
        makeDeps({
          listBackends: async () => [
            { id: "file", name: "Encrypted file storage", priority: 0.5 },
            { id: "null", name: "Null keyring", priority: -1 },
          ],
        }),
      ),
    ).toBeFalse();
  });

  test("false when backend detection fails", async () => {
    expect(
      await isSecureStoreAvailable(
        makeDeps({
          listBackends: async () => {
            throw new Error("no keyring");
          },
        }),
      ),
    ).toBeFalse();
  });
});

describe("secureStoreLabel", () => {
  test("uses the preferred cross-keychain OS backend name", async () => {
    await expect(
      secureStoreLabel(makeDeps({ listBackends: async () => osBackends })),
    ).resolves.toBe("Freedesktop Secret Service");
  });
});

describe("setToken", () => {
  test("delegates storage to cross-keychain", async () => {
    const calls: unknown[][] = [];
    await setToken(
      "work@host",
      "secret-token",
      makeDeps({
        setPassword: async (...args) => {
          calls.push(args);
        },
      }),
    );
    expect(calls).toEqual([["jenkins-cli", "work@host", "secret-token"]]);
  });

  test("throws SecureStoreError when cross-keychain cannot store", async () => {
    await expect(
      setToken(
        "work@host",
        "t",
        makeDeps({
          setPassword: async () => {
            throw new Error("keyring locked");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SecureStoreError);
  });
});

describe("getToken", () => {
  test("returns the stored token from cross-keychain", async () => {
    await expect(
      getToken(
        "work@host",
        makeDeps({
          getPassword: async (service, account) =>
            service === "jenkins-cli" && account === "work@host"
              ? "secret-token"
              : null,
        }),
      ),
    ).resolves.toBe("secret-token");
  });

  test("returns null when cross-keychain finds no token", async () => {
    await expect(
      getToken("missing@host", makeDeps({ getPassword: async () => null })),
    ).resolves.toBeNull();
  });

  test("throws SecureStoreError when cross-keychain reports an error", async () => {
    await expect(
      getToken(
        "work@host",
        makeDeps({
          getPassword: async () => {
            throw new Error("cannot unlock keyring");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SecureStoreError);
  });
});

describe("deleteToken", () => {
  test("delegates deletion to cross-keychain", async () => {
    const calls: unknown[][] = [];
    await expect(
      deleteToken(
        "work@host",
        makeDeps({
          deletePassword: async (...args) => {
            calls.push(args);
          },
        }),
      ),
    ).resolves.toBeTrue();
    expect(calls).toEqual([["jenkins-cli", "work@host"]]);
  });

  test("returns false and never throws when deletion fails", async () => {
    await expect(
      deleteToken(
        "missing@host",
        makeDeps({
          deletePassword: async () => {
            throw new Error("no such item");
          },
        }),
      ),
    ).resolves.toBeFalse();
  });
});

/**
 * Integration probe: exercises the REAL cross-keychain backend once to decide
 * whether the store is usable in this environment (backend present AND the
 * keyring/session unlocked). Skips otherwise.
 */
async function probeSecureStore(): Promise<boolean> {
  if (process.env.SKIP_KEYCHAIN_INTEGRATION === "1") {
    return false;
  }
  if (!(await isSecureStoreAvailable())) {
    return false;
  }
  const account = `__probe__${randomUUID()}`;
  try {
    await setToken(account, "probe-token");
    const got = await getToken(account);
    await deleteToken(account);
    return got === "probe-token";
  } catch {
    await deleteToken(account).catch(() => undefined);
    return false;
  }
}

const integrationAvailable = await probeSecureStore();

describe("secure store integration (real OS keychain)", () => {
  test.skipIf(!integrationAvailable)(
    "round-trips store -> lookup -> clear",
    async () => {
      const account = `jenkins-cli-test-${randomUUID()}`;
      const token = `tok-${randomUUID()}`;

      await setToken(account, token);
      expect(await getToken(account)).toBe(token);

      const updated = `tok2-${randomUUID()}`;
      await setToken(account, updated);
      expect(await getToken(account)).toBe(updated);

      expect(await deleteToken(account)).toBeTrue();
      expect(await getToken(account)).toBeNull();
    },
  );
});
