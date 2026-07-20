import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYCHAIN_TOKEN_SENTINEL } from "../src/config";
import {
  buildSecureStoreAccount,
  deleteToken,
  getToken,
  isSecureStoreAvailable,
  secureStoreLabel,
  setToken,
} from "../src/secure-store";

type StoredProfile = {
  jenkinsUrl: string;
  jenkinsUser: string;
  jenkinsApiToken: string;
  tokenStorage?: string;
  secureStorageOptOut?: boolean;
};

type StoredConfig = {
  version: number;
  defaultProfile?: string;
  profiles: Record<string, StoredProfile>;
};

type CliResult = {
  exitCode: number;
  output: string;
};

const tempRoot = mkdtempSync(join(tmpdir(), "jenkins-cli-secure-e2e-"));
const accountsToClean = new Set<string>();
let nextHomeId = 0;

function createIdentity(prefix: string): {
  profileName: string;
  url: string;
  account: string;
  token: string;
} {
  const id = randomUUID();
  const profileName = `${prefix}-${id}`;
  const url = `https://${prefix}-${id}.invalid`;
  const account = buildSecureStoreAccount(profileName, url);
  accountsToClean.add(account);
  return {
    profileName,
    url,
    account,
    token: `token-${id}`,
  };
}

function makeHome(config?: StoredConfig): string {
  const home = join(tempRoot, `home-${nextHomeId++}`);
  mkdirSync(home, { recursive: true });
  if (config) {
    const configDir = join(home, ".config", "jenkins-cli");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "jenkins-cli-config.json"),
      JSON.stringify(config, null, 2),
    );
  }
  return home;
}

function readStoredConfig(home: string): StoredConfig {
  return JSON.parse(
    readFileSync(
      join(home, ".config", "jenkins-cli", "jenkins-cli-config.json"),
      "utf8",
    ),
  ) as StoredConfig;
}

function runCli(
  args: string[],
  home: string,
  env: Record<string, string | undefined> = {},
): CliResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "src/index.ts", ...args],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      JENKINS_URL: undefined,
      JENKINS_USER: undefined,
      JENKINS_API_TOKEN: undefined,
      JENKINS_ANALYTICS_DISABLED: "true",
      TS_KEYRING_BACKEND: undefined,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output:
      new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
  };
}

async function probeSecureStore(): Promise<boolean> {
  if (process.env.SKIP_KEYCHAIN_INTEGRATION === "1") {
    return false;
  }
  if (!(await isSecureStoreAvailable())) {
    return false;
  }
  const account = `__e2e_probe__${randomUUID()}`;
  try {
    await setToken(account, "probe-token");
    return (await getToken(account)) === "probe-token";
  } catch {
    return false;
  } finally {
    await deleteToken(account).catch(() => undefined);
  }
}

const integrationAvailable = await probeSecureStore();
const integrationRequired = process.env.REQUIRE_KEYCHAIN_INTEGRATION === "1";

afterAll(async () => {
  for (const account of accountsToClean) {
    await deleteToken(account).catch(() => undefined);
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("secure-store CLI lifecycle (real OS keychain)", () => {
  test.skipIf(!integrationRequired)(
    "has a usable OS keychain when integration coverage is required",
    () => {
      expect(integrationAvailable).toBeTrue();
    },
  );

  test.skipIf(!integrationAvailable)(
    "login stores and resolves a token without echoing it",
    async () => {
      const identity = createIdentity("login-e2e");
      const home = makeHome();

      const login = runCli(
        [
          "auth",
          "login",
          "--non-interactive",
          "--profile",
          identity.profileName,
          "--url",
          identity.url,
          "--user",
          "ci-user",
          "--token",
          identity.token,
        ],
        home,
      );

      expect(login.exitCode).toBe(0);
      expect(login.output).toContain("API token stored securely");
      expect(login.output).not.toContain(identity.token);
      expect(login.output).not.toContain("export JENKINS_API_TOKEN");

      const profile = readStoredConfig(home).profiles[identity.profileName];
      expect(profile?.jenkinsApiToken).toBe(KEYCHAIN_TOKEN_SENTINEL);
      expect(profile?.tokenStorage).toBe("keychain");
      expect(await getToken(identity.account)).toBe(identity.token);

      const current = runCli(
        [
          "auth",
          "current",
          "--non-interactive",
          "--profile",
          identity.profileName,
        ],
        home,
      );
      expect(current.exitCode).toBe(0);
      expect(current.output).toContain("Token present:    Yes");
      expect(current.output).toContain(
        `Token storage:    ${await secureStoreLabel()}`,
      );
      expect(current.output).not.toContain(identity.token);
    },
  );

  test.skipIf(!integrationAvailable)(
    "using a plaintext profile automatically migrates it before the command",
    async () => {
      const identity = createIdentity("migration-e2e");
      const home = makeHome({
        version: 2,
        defaultProfile: identity.profileName,
        profiles: {
          [identity.profileName]: {
            jenkinsUrl: identity.url,
            jenkinsUser: "ci-user",
            jenkinsApiToken: identity.token,
          },
        },
      });

      const result = runCli(
        ["list", "--non-interactive", "--profile", identity.profileName],
        home,
      );

      // The command reaches its normal cache error after migration; migration
      // itself stays silent because this is a non-interactive invocation.
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Job cache is missing");
      expect(result.output).not.toContain("Migrated");
      expect(result.output).not.toContain(identity.token);

      const profile = readStoredConfig(home).profiles[identity.profileName];
      expect(profile?.jenkinsApiToken).toBe(KEYCHAIN_TOKEN_SENTINEL);
      expect(profile?.tokenStorage).toBe("keychain");
      expect(await getToken(identity.account)).toBe(identity.token);
    },
  );

  test.skipIf(!integrationAvailable)(
    "--no-keychain stays plaintext and is not migrated on later use",
    async () => {
      const identity = createIdentity("optout-e2e");
      const home = makeHome();

      const login = runCli(
        [
          "auth",
          "login",
          "--non-interactive",
          "--no-keychain",
          "--profile",
          identity.profileName,
          "--url",
          identity.url,
          "--user",
          "ci-user",
          "--token",
          identity.token,
        ],
        home,
      );
      expect(login.exitCode).toBe(0);

      const use = runCli(
        ["list", "--non-interactive", "--profile", identity.profileName],
        home,
      );
      expect(use.exitCode).toBe(1);

      const profile = readStoredConfig(home).profiles[identity.profileName];
      expect(profile?.jenkinsApiToken).toBe(identity.token);
      expect(profile?.tokenStorage).toBeUndefined();
      expect(profile?.secureStorageOptOut).toBeTrue();
      expect(await getToken(identity.account)).toBeNull();
    },
  );
});

describe("secure-store CLI fallback", () => {
  test("an unusable backend leaves login credentials in plaintext", async () => {
    const identity = createIdentity("fallback-e2e");
    const home = makeHome();

    const result = runCli(
      [
        "auth",
        "login",
        "--non-interactive",
        "--profile",
        identity.profileName,
        "--url",
        identity.url,
        "--user",
        "ci-user",
        "--token",
        identity.token,
      ],
      home,
      { TS_KEYRING_BACKEND: "null" },
    );

    expect(result.exitCode).toBe(0);
    const profile = readStoredConfig(home).profiles[identity.profileName];
    expect(profile?.jenkinsApiToken).toBe(identity.token);
    expect(profile?.tokenStorage).toBeUndefined();
    expect(result.output).toContain("export JENKINS_API_TOKEN");
  });

  test("an unusable backend leaves an existing plaintext profile active", () => {
    const identity = createIdentity("migration-fallback-e2e");
    const home = makeHome({
      version: 2,
      defaultProfile: identity.profileName,
      profiles: {
        [identity.profileName]: {
          jenkinsUrl: identity.url,
          jenkinsUser: "ci-user",
          jenkinsApiToken: identity.token,
        },
      },
    });

    const result = runCli(
      ["list", "--non-interactive", "--profile", identity.profileName],
      home,
      { TS_KEYRING_BACKEND: "null" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Job cache is missing");
    expect(result.output).not.toContain(identity.token);
    const profile = readStoredConfig(home).profiles[identity.profileName];
    expect(profile?.jenkinsApiToken).toBe(identity.token);
    expect(profile?.tokenStorage).toBeUndefined();
  });
});
