import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/cli";
import { assertProtectedMutationAllowed, type EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import { runBuild } from "../src/commands/build";
import { runCancel } from "../src/commands/cancel";
import { runRerun, runRerunLastBuild } from "../src/commands/rerun";
import { runParams } from "../src/commands/params";
import { runQueue } from "../src/commands/queue";

const PROTECTED_URL = "https://jenkins-release.example.com";
const JOB_URL = `${PROTECTED_URL}/job/api/`;

function protectedEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    jenkinsUrl: PROTECTED_URL,
    jenkinsUser: "ci-bot",
    jenkinsApiToken: "test-token",
    profileName: "release",
    protectedProfileName: "release",
    branchParamDefault: "BRANCH",
    useCrumb: false,
    folderDepth: 3,
    ...overrides,
  };
}

/** Every mutating client method, so a blocked run can assert zero calls. */
function mutationSpies() {
  return {
    triggerBuild: mock(async () => ({ queueUrl: `${PROTECTED_URL}/queue/1/` })),
    stopBuild: mock(async () => undefined),
    cancelQueueItem: mock(async () => true),
  };
}

function client(stubs: Record<string, unknown>): JenkinsClient {
  return stubs as unknown as JenkinsClient;
}

function sink(): { write: (text: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    write: (text) => chunks.push(text),
    text: () => chunks.join(""),
  };
}

function spawnCli(
  home: string,
  args: string[],
): { exitCode: number; stdout: string; stderr: string; output: string } {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "src/index.ts", ...args],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      JENKINS_URL: undefined,
      JENKINS_USER: undefined,
      JENKINS_API_TOKEN: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return { exitCode: result.exitCode, stdout, stderr, output: stdout + stderr };
}

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("assertProtectedMutationAllowed", () => {
  test("throws a coded CliError only for unconfirmed protected targets", () => {
    expect(() => assertProtectedMutationAllowed(protectedEnv())).toThrow(
      CliError,
    );
    const error = (() => {
      try {
        assertProtectedMutationAllowed(protectedEnv());
        return undefined;
      } catch (thrown) {
        return thrown as CliError;
      }
    })();
    expect(error?.code).toBe("PROFILE_PROTECTED");
    expect(error?.message).toBe('Profile "release" is read-only.');
    expect(error?.hints).toEqual([
      "Re-run with --confirm-protected to allow builds, cancels, and reruns.",
    ]);

    expect(() =>
      assertProtectedMutationAllowed(protectedEnv({ confirmProtected: true })),
    ).not.toThrow();
    expect(() =>
      assertProtectedMutationAllowed(
        protectedEnv({ protectedProfileName: undefined }),
      ),
    ).not.toThrow();
  });
});

describe("direct mutation commands on a protected profile", () => {
  test("build rejects before any Jenkins call", async () => {
    const spies = mutationSpies();
    const getJobStatus = mock(async () => ({ buildNumber: 1 }));

    await expect(
      runBuild({
        client: client({ ...spies, getJobStatus }),
        env: protectedEnv(),
        jobUrl: JOB_URL,
        nonInteractive: true,
      }),
    ).rejects.toThrow('Profile "release" is read-only.');

    expect(spies.triggerBuild).not.toHaveBeenCalled();
    expect(getJobStatus).not.toHaveBeenCalled();
  });

  test("cancel rejects for queue and build targets without mutating", async () => {
    const spies = mutationSpies();

    for (const target of [
      { buildUrl: `${JOB_URL}12/` },
      { queueUrl: `${PROTECTED_URL}/queue/item/9/` },
    ]) {
      await expect(
        runCancel({
          client: client(spies),
          env: protectedEnv(),
          nonInteractive: true,
          ...target,
        }),
      ).rejects.toThrow('Profile "release" is read-only.');
    }

    expect(spies.stopBuild).not.toHaveBeenCalled();
    expect(spies.cancelQueueItem).not.toHaveBeenCalled();
  });

  test("rerun and rerun-last reject before their mutating client methods", async () => {
    const spies = mutationSpies();
    const getLastFailedBuild = mock(async () => null);
    const getJobStatus = mock(async () => ({ buildNumber: 1 }));

    await expect(
      runRerun({
        client: client({ ...spies, getLastFailedBuild, getJobStatus }),
        env: protectedEnv(),
        jobUrl: JOB_URL,
        nonInteractive: true,
      }),
    ).rejects.toThrow('Profile "release" is read-only.');

    await expect(
      runRerunLastBuild({
        client: client({ ...spies, getLastFailedBuild, getJobStatus }),
        env: protectedEnv(),
        jobUrl: JOB_URL,
        nonInteractive: true,
      }),
    ).rejects.toThrow('Profile "release" is read-only.');

    expect(spies.triggerBuild).not.toHaveBeenCalled();
    expect(getLastFailedBuild).not.toHaveBeenCalled();
    expect(getJobStatus).not.toHaveBeenCalled();
  });

  test("--confirm-protected permits each mutation", async () => {
    const env = protectedEnv({ confirmProtected: true });
    const spies = mutationSpies();
    const getJobStatus = mock(async () => ({
      buildNumber: 7,
      buildUrl: `${JOB_URL}7/`,
      parameters: [{ name: "BRANCH", value: "main" }],
    }));
    const getJobParameterDefinitions = mock(async () => []);
    const getBuildStatus = mock(async () => ({
      building: false,
      result: "ABORTED",
      buildNumber: 12,
    }));
    const jenkins = client({
      ...spies,
      getJobStatus,
      getJobParameterDefinitions,
      getBuildStatus,
    });

    await runBuild({
      client: jenkins,
      env,
      jobUrl: JOB_URL,
      nonInteractive: true,
      watch: false,
    });
    await runCancel({
      client: jenkins,
      env,
      buildUrl: `${JOB_URL}12/`,
      nonInteractive: true,
    });
    await runRerunLastBuild({
      client: jenkins,
      env,
      jobUrl: JOB_URL,
      nonInteractive: true,
    });

    expect(spies.triggerBuild).toHaveBeenCalledTimes(2);
    expect(spies.stopBuild).toHaveBeenCalledTimes(1);
  });

  test("read-only commands stay usable without confirmation", async () => {
    const paramsSink = sink();
    const queueSink = sink();

    await runParams({
      client: client({
        getJobParameterDefinitions: mock(async () => [
          { name: "BRANCH", type: "String", defaultValue: "main" },
        ]),
      }),
      env: protectedEnv(),
      jobUrl: JOB_URL,
      nonInteractive: true,
      json: true,
      write: paramsSink.write,
    });
    await runQueue({
      client: client({ listQueueItems: mock(async () => []) }),
      env: protectedEnv(),
      nonInteractive: true,
      json: true,
      write: queueSink.write,
    });

    expect(JSON.parse(paramsSink.text()).ok).toBeTrue();
    expect(JSON.parse(queueSink.text()).ok).toBeTrue();
    expect(process.exitCode).toBe(0);
  });
});

describe("protected profile CLI output", () => {
  function runCli(args: string[]): {
    exitCode: number;
    stdout: string;
    stderr: string;
  } {
    const home = mkdtempSync(join(tmpdir(), "jenkins-cli-protected-home-"));
    try {
      const configDir = join(home, ".config", "jenkins-cli");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "jenkins-cli-config.json"),
        JSON.stringify({
          version: 2,
          defaultProfile: "release",
          profiles: {
            release: {
              jenkinsUrl: PROTECTED_URL,
              jenkinsUser: "ci-bot",
              jenkinsApiToken: "test-token",
              protected: true,
            },
          },
        }),
      );
      return spawnCli(home, args);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("--json emits exactly one PROFILE_PROTECTED document and exits non-zero", () => {
    for (const args of [
      ["build", "--job-url", JOB_URL, "--json"],
      ["deploy", "--job-url", JOB_URL, "--json"],
      ["cancel", "--build-url", `${JOB_URL}12/`, "--json"],
      ["rerun", "--job-url", JOB_URL, "--json"],
    ]) {
      const result = runCli(args);
      expect(result.exitCode).toBe(1);
      const lines = result.stdout.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toEqual({
        ok: false,
        error: {
          message: 'Profile "release" is read-only.',
          code: "PROFILE_PROTECTED",
        },
      });
    }
  }, 30_000);

  test("terminal mode prints the error and the rerun hint", () => {
    const result = runCli([
      "build",
      "--job-url",
      JOB_URL,
      "--non-interactive",
      "--no-banner",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ERROR: Profile "release" is read-only.');
    expect(result.stderr).toContain(
      "HINT: Re-run with --confirm-protected to allow builds, cancels, and reruns.",
    );
  }, 30_000);

  test("--confirm-protected clears the policy block for every entry point", () => {
    for (const args of [
      ["build", "--job-url", JOB_URL, "--json", "--confirm-protected"],
      ["list", "--json", "--confirm-protected"],
      ["--json", "--confirm-protected"],
    ]) {
      const result = runCli(args);
      const lines = result.stdout.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      // The synthetic controller is unreachable, so the run fails on the
      // network instead of the policy.
      expect(lines[0]).not.toContain("PROFILE_PROTECTED");
    }
  }, 30_000);

  test("auth login marks and clears protection without re-entering credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "jenkins-cli-protected-login-"));
    const configPath = join(
      home,
      ".config",
      "jenkins-cli",
      "jenkins-cli-config.json",
    );
    // No --non-interactive: an explicit --protected/--no-protected on an
    // existing profile must not replay the credential prompts.
    const login = (extraArgs: string[]): { exitCode: number; output: string } =>
      spawnCli(home, ["auth", "login", "--profile", "release", ...extraArgs]);
    const storedProfile = (): {
      protected?: boolean;
      jenkinsUrl: string;
      jenkinsUser: string;
      jenkinsApiToken: string;
      secureStorageOptOut?: boolean;
      tokenStorage?: string;
    } => JSON.parse(readFileSync(configPath, "utf8")).profiles.release;

    try {
      const created = login([
        "--non-interactive",
        "--url",
        PROTECTED_URL,
        "--user",
        "ci-bot",
        "--token",
        "test-token",
        "--no-keychain",
        "--protected",
      ]);
      expect(created.exitCode, created.output).toBe(0);
      expect(created.output).toContain('Profile "release" is now read-only.');
      expect(storedProfile().protected).toBeTrue();

      const blocked = spawnCli(home, ["build", "--job-url", JOB_URL, "--json"]);
      expect(blocked.exitCode).toBe(1);
      expect(JSON.parse(blocked.output.trim()).error.code).toBe(
        "PROFILE_PROTECTED",
      );

      // Re-login without credentials keeps them, preserves the setting, and
      // stays quiet because nothing changed.
      const unchanged = login(["--non-interactive", "--no-keychain"]);
      expect(unchanged.exitCode).toBe(0);
      expect(unchanged.output).not.toContain("read-only");
      expect(storedProfile().protected).toBeTrue();
      expect(storedProfile().jenkinsUser).toBe("ci-bot");
      const { protected: _protected, ...credentialsBeforeToggle } =
        storedProfile();

      const cleared = login(["--no-protected"]);
      expect(cleared.exitCode, cleared.output).toBe(0);
      expect(cleared.output).toContain(
        'Profile "release" is no longer read-only.',
      );
      expect(storedProfile().protected).toBeUndefined();
      expect(storedProfile()).toEqual(credentialsBeforeToggle);

      const reset = login(["--protected", "--non-interactive"]);
      expect(reset.exitCode, reset.output).toBe(0);
      expect(reset.output).toContain('Profile "release" is now read-only.');
      expect(storedProfile().protected).toBeTrue();
      expect(storedProfile()).toEqual({
        ...credentialsBeforeToggle,
        protected: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a direct --url matching the protected controller is still blocked", () => {
    const result = runCli([
      "build",
      "--job-url",
      JOB_URL,
      "--url",
      `${PROTECTED_URL}/`,
      "--user",
      "someone-else",
      "--token",
      "one-off-token",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe(
      "PROFILE_PROTECTED",
    );
  }, 30_000);
});
