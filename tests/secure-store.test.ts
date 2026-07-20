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
  test("derives the documented deterministic account", () => {
    expect(
      buildSecureStoreAccount("default", "https://jenkins.pluang.org"),
    ).toBe("v1.6wqHyJLxhkabpPotDmbQp23XKq4PPcDTbGiTq65bvWg");
  });

  test("uses a fixed-length cross-keychain-safe format", () => {
    const account = buildSecureStoreAccount(
      "dev/stage 2 !@#$%^&*() 🚀".repeat(100),
      `https://jenkins.example.com/${"nested/path/".repeat(500)}`,
    );

    expect(account).toHaveLength(46);
    expect(account).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
  });

  test("normalizes profile and controller URL equivalents", () => {
    const canonical = buildSecureStoreAccount(
      "work",
      "https://jenkins.example.com/ci",
    );

    expect(
      buildSecureStoreAccount(
        "  work  ",
        "  https://jenkins.example.com/ci///  ",
      ),
    ).toBe(canonical);
    expect(buildSecureStoreAccount("  ", "https://jenkins.example.com")).toBe(
      buildSecureStoreAccount("default", "https://jenkins.example.com/"),
    );
  });

  test("isolates every account identity dimension", () => {
    const base = buildSecureStoreAccount(
      "work",
      "https://jenkins.example.com/ci",
    );
    const variants = [
      buildSecureStoreAccount("other", "https://jenkins.example.com/ci"),
      buildSecureStoreAccount("work", "http://jenkins.example.com/ci"),
      buildSecureStoreAccount("work", "https://other.example.com/ci"),
      buildSecureStoreAccount("work", "https://jenkins.example.com:8443/ci"),
      buildSecureStoreAccount("work", "https://jenkins.example.com/other"),
    ];

    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  test("accepts punctuation, delimiters, and Unicode in profile names", () => {
    const accounts = [
      "dev/stage 2",
      "name@host",
      'name","https://example.test',
      "日本語 🚀",
    ].map((name) =>
      buildSecureStoreAccount(name, "https://jenkins.example.com"),
    );

    expect(new Set(accounts).size).toBe(accounts.length);
    for (const account of accounts) {
      expect(account).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
    }
  });

  test("uses an unambiguous tuple boundary", () => {
    expect(
      buildSecureStoreAccount("ab", "https://jenkins.example.com/c"),
    ).not.toBe(buildSecureStoreAccount("a", "https://jenkins.example.com/bc"));
  });

  test("rejects invalid controller URLs instead of deriving raw accounts", () => {
    expect(() => buildSecureStoreAccount("work", "not a url")).toThrow(
      "Invalid JENKINS_URL.",
    );
    expect(() =>
      buildSecureStoreAccount("work", "ftp://jenkins.example.com"),
    ).toThrow("Invalid JENKINS_URL protocol.");
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
const integrationRequired = process.env.REQUIRE_KEYCHAIN_INTEGRATION === "1";

describe("secure store integration (real OS keychain)", () => {
  test.skipIf(!integrationRequired)(
    "has a usable OS keychain when integration coverage is required",
    () => {
      expect(integrationAvailable).toBeTrue();
    },
  );

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
