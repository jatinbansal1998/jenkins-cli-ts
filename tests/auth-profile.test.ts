import { describe, expect, test } from "bun:test";
import { CliError } from "../src/cli";
import type { JenkinsConfig } from "../src/config";
import { buildSecureStoreAccount } from "../src/secure-store";
import {
  runAuthCurrent,
  runAuthList,
  runAuthLogout,
  runAuthRename,
  runAuthUse,
  type AuthCommandDeps,
} from "../src/commands/auth-profile";
import {
  runProfileDelete,
  runProfileList,
  runProfileUse,
} from "../src/commands/profile";

const URL_A = "https://jenkins-a.example.com";
const URL_B = "https://jenkins-b.example.com";

function baseConfig(): JenkinsConfig {
  return {
    version: 2,
    defaultProfile: "work",
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
        jenkinsApiToken: "plain-secret-token",
      },
    },
  };
}

function makeDeps(
  initialConfig: JenkinsConfig | null,
  initialStore: Record<string, string> = {},
  overrides: Partial<AuthCommandDeps> = {},
): AuthCommandDeps & { config: () => JenkinsConfig | null } {
  let current = initialConfig;
  const store = new Map(Object.entries(initialStore));
  return {
    readConfig: async () =>
      current
        ? { config: structuredClone(current), legacyDetected: false }
        : null,
    writeConfig: async (config) => {
      current = structuredClone(config);
      return "/tmp/jenkins-cli-config.json";
    },
    getToken: async (account) => store.get(account) ?? null,
    setToken: async (account, token) => {
      store.set(account, token);
    },
    deleteToken: async (account) => store.delete(account),
    config: () => current,
    ...overrides,
  };
}

function collect(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("runAuthList", () => {
  test("prints a successful empty-state message", async () => {
    const out = collect();
    await runAuthList(makeDeps(null), out.write);
    expect(out.lines).toEqual(["OK: No profiles configured."]);
  });

  test("prints name, url, username, and storage with the default marked", async () => {
    const out = collect();
    await runAuthList(makeDeps(baseConfig()), out.write);
    expect(out.lines).toEqual([
      `work (default)  ${URL_A}  ci-work  keychain`,
      `home  ${URL_B}  ci-home  plaintext`,
    ]);
  });

  test("profile list renders the same information", async () => {
    const authOut = collect();
    const profileOut = collect();
    await runAuthList(makeDeps(baseConfig()), authOut.write);
    await runProfileList(makeDeps(baseConfig()), profileOut.write);
    expect(profileOut.lines).toEqual(authOut.lines);
  });
});

describe("runAuthUse", () => {
  test("switches the default profile", async () => {
    const deps = makeDeps(baseConfig());
    const out = collect();
    await runAuthUse("home", deps, out.write);
    expect(out.lines).toEqual(['OK: Default profile set to "home".']);
    expect(deps.config()?.defaultProfile).toBe("home");
  });

  test("selecting the active profile is a no-op", async () => {
    const out = collect();
    await runAuthUse("work", makeDeps(baseConfig()), out.write);
    expect(out.lines).toEqual(['OK: Profile "work" is already the default.']);
  });

  test("profile use routes through the same operation", async () => {
    const deps = makeDeps(baseConfig());
    const out = collect();
    await runProfileUse({ name: "home" }, deps, out.write);
    expect(out.lines).toEqual(['OK: Default profile set to "home".']);
    expect(deps.config()?.defaultProfile).toBe("home");
  });
});

describe("runAuthCurrent", () => {
  test("resolves complete direct command-line credentials without network access", async () => {
    const out = collect();
    await runAuthCurrent(
      { url: URL_A, user: "direct-user", apiToken: "direct-secret" },
      { readConfig: async () => null, env: {} },
      out.write,
    );
    const text = out.lines.join("\n");
    expect(text).toContain("Source:           Command-line credentials");
    expect(text).toContain("Username:         direct-user");
    expect(text).toContain("Token present:    Yes");
    expect(text).not.toContain("direct-secret");
  });

  test("resolves an explicit profile", async () => {
    const out = collect();
    await runAuthCurrent(
      { profile: "home" },
      {
        readConfig: async () => ({ config: baseConfig() }),
        env: {},
      },
      out.write,
    );
    const text = out.lines.join("\n");
    expect(text).toContain("Source:           Explicit profile (--profile)");
    expect(text).toContain("Profile:          home");
    expect(text).toContain(`Controller:       ${URL_B}`);
    expect(text).toContain("Token storage:    Config file");
    expect(text).toContain("Token present:    Yes");
    expect(text).not.toContain("plain-secret-token");
  });

  test("resolves the configured default profile", async () => {
    const out = collect();
    await runAuthCurrent(
      {},
      {
        readConfig: async () => ({ config: baseConfig() }),
        env: {},
        getToken: async () => "keychain-secret",
        secureStoreLabel: async () => "macOS Keychain",
      },
      out.write,
    );
    const text = out.lines.join("\n");
    expect(text).toContain("Source:           Default profile");
    expect(text).toContain("Profile:          work");
    expect(text).toContain("Token storage:    macOS Keychain");
    expect(text).toContain("Token present:    Yes");
    expect(text).not.toContain("keychain-secret");
  });

  test("resolves environment credentials when no profile exists", async () => {
    const out = collect();
    await runAuthCurrent(
      {},
      {
        readConfig: async () => null,
        env: {
          JENKINS_URL: URL_A,
          JENKINS_USER: "env-user",
          JENKINS_API_TOKEN: "env-secret",
        },
      },
      out.write,
    );
    const text = out.lines.join("\n");
    expect(text).toContain("Source:           Environment variables");
    expect(text).toContain("Profile:          Environment");
    expect(text).toContain("Token present:    Yes");
    expect(text).not.toContain("env-secret");
  });

  test("reports an unavailable keychain token without secure-store details", async () => {
    const out = collect();
    await runAuthCurrent(
      {},
      {
        readConfig: async () => ({ config: baseConfig() }),
        env: {},
        getToken: async () => {
          throw new Error("dbus secret leaked-detail");
        },
        secureStoreLabel: async () => "OS secure store",
      },
      out.write,
    );
    const text = out.lines.join("\n");
    expect(text).toContain("Token present:    Unavailable");
    expect(text).not.toContain("leaked-detail");
  });

  test("an unknown explicitly requested profile exits with a configuration error", async () => {
    await expect(
      runAuthCurrent(
        { profile: "missing" },
        { readConfig: async () => ({ config: baseConfig() }), env: {} },
        () => {},
      ),
    ).rejects.toThrow('Profile "missing" is not configured.');
  });

  test("no resolvable credential source exits with a configuration error", async () => {
    await expect(
      runAuthCurrent({}, { readConfig: async () => null, env: {} }, () => {}),
    ).rejects.toThrow("Missing JENKINS_URL.");
  });
});

describe("runAuthLogout", () => {
  test("rejects --all combined with --profile", async () => {
    await expect(
      runAuthLogout(
        { all: true, profile: "work", nonInteractive: true },
        makeDeps(baseConfig()),
        () => {},
      ),
    ).rejects.toThrow("--all and --profile are mutually exclusive.");
  });

  test("targets the active profile by default", async () => {
    const workAccount = buildSecureStoreAccount("work", URL_A);
    const deps = makeDeps(baseConfig(), { [workAccount]: "secret" });
    const out = collect();
    await runAuthLogout({ nonInteractive: true }, deps, out.write);
    expect(out.lines).toEqual([
      'OK: Logged out profile "work".',
      'OK: Default profile is "home".',
    ]);
    expect(deps.config()?.profiles.work).toBeUndefined();
  });

  test("targets an exact stored profile with --profile", async () => {
    const deps = makeDeps(baseConfig());
    const out = collect();
    await runAuthLogout(
      { profile: "home", nonInteractive: true },
      deps,
      out.write,
    );
    expect(out.lines).toEqual([
      'OK: Logged out profile "home".',
      'OK: Default profile is "work".',
    ]);
  });

  test("rejects an unknown --profile", async () => {
    await expect(
      runAuthLogout(
        { profile: "missing", nonInteractive: true },
        makeDeps(baseConfig()),
        () => {},
      ),
    ).rejects.toThrow('Profile "missing" was not found.');
  });

  test("rejects when no active profile exists", async () => {
    await expect(
      runAuthLogout({ nonInteractive: true }, makeDeps(null), () => {}),
    ).rejects.toThrow("No active profile to log out.");
  });

  test("asks for confirmation on interactive runs and aborts on decline", async () => {
    const messages: string[] = [];
    const deps = makeDeps(baseConfig(), {}, {
      confirm: async (options: { message: string }) => {
        messages.push(options.message);
        return false;
      },
    } as Partial<AuthCommandDeps>);
    await expect(
      runAuthLogout({ nonInteractive: false }, deps, () => {}),
    ).rejects.toThrow("Operation cancelled.");
    expect(messages).toEqual([
      'Log out profile "work"? This deletes its stored credentials.',
    ]);
    expect(deps.config()?.profiles.work).toBeDefined();
  });

  test("logout --all deletes every profile after one confirmation", async () => {
    const workAccount = buildSecureStoreAccount("work", URL_A);
    const messages: string[] = [];
    const deps = makeDeps(baseConfig(), { [workAccount]: "secret" }, {
      confirm: async (options: { message: string }) => {
        messages.push(options.message);
        return true;
      },
    } as Partial<AuthCommandDeps>);
    const out = collect();
    await runAuthLogout({ all: true, nonInteractive: false }, deps, out.write);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("all 2 profile(s)");
    expect(out.lines).toEqual(["OK: Logged out 2 profile(s)."]);
    expect(deps.config()?.profiles).toEqual({});
  });

  test("logout --all with no profiles is a successful no-op", async () => {
    const out = collect();
    await runAuthLogout(
      { all: true, nonInteractive: true },
      makeDeps(null),
      out.write,
    );
    expect(out.lines).toEqual(["OK: No profiles configured."]);
  });
});

describe("runAuthRename", () => {
  test("renames a profile and reports the active profile", async () => {
    const deps = makeDeps(baseConfig());
    const out = collect();
    await runAuthRename("work", "corp", deps, out.write);
    expect(out.lines).toEqual([
      'OK: Renamed profile "work" to "corp".',
      'OK: Default profile is "corp".',
    ]);
    expect(deps.config()?.defaultProfile).toBe("corp");
  });

  test("a same-name rename is a successful no-op", async () => {
    const out = collect();
    await runAuthRename("home", " home ", makeDeps(baseConfig()), out.write);
    expect(out.lines).toEqual(['OK: Profile "home" already has that name.']);
  });
});

describe("profile delete compatibility", () => {
  test("uses the strict deletion operation and reports the next default", async () => {
    const workAccount = buildSecureStoreAccount("work", URL_A);
    const deps = makeDeps(baseConfig(), { [workAccount]: "secret" });
    const out = collect();
    await runProfileDelete(
      { name: "work", nonInteractive: true },
      deps,
      out.write,
    );
    expect(out.lines).toEqual([
      'OK: Deleted profile "work".',
      'OK: Default profile is "home".',
    ]);
    expect(deps.config()?.profiles.work).toBeUndefined();
  });

  test("fails strictly when the secure store is inaccessible", async () => {
    const deps = makeDeps(baseConfig(), {}, {
      getToken: async () => {
        throw new Error("keyring locked");
      },
    } as Partial<AuthCommandDeps>);
    await expect(
      runProfileDelete({ name: "work", nonInteractive: true }, deps, () => {}),
    ).rejects.toThrow("Unable to access the OS secure store");
    expect(deps.config()?.profiles.work).toBeDefined();
  });

  test("preserves debug and analyticsDisabled through a delete", async () => {
    const config = baseConfig();
    config.debug = true;
    config.analyticsDisabled = true;
    const deps = makeDeps(config);
    await runProfileDelete(
      { name: "home", nonInteractive: true },
      deps,
      () => {},
    );
    expect(deps.config()?.debug).toBe(true);
    expect(deps.config()?.analyticsDisabled).toBe(true);
  });

  test("rejects an unknown profile with available names", async () => {
    const error = await runProfileDelete(
      { name: "missing", nonInteractive: true },
      makeDeps(baseConfig()),
      () => {},
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).hints.join(" ")).toContain("work, home");
  });
});
