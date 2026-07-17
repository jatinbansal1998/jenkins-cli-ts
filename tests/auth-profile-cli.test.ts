import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end routing tests for the auth profile management commands. These
 * spawn the real CLI against an isolated HOME so config reads/writes are
 * exercised for plaintext profiles; keychain flows are covered by the
 * dependency-injected unit tests instead.
 */

type CliRun = { exitCode: number; output: string };

const homes: string[] = [];

function makeHome(config?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "jenkins-cli-auth-profile-home-"));
  homes.push(home);
  if (config) {
    writeHomeConfig(home, config);
  }
  return home;
}

function writeHomeConfig(home: string, config: Record<string, unknown>): void {
  const configDir = join(home, ".config", "jenkins-cli");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "jenkins-cli-config.json"),
    JSON.stringify(config),
  );
}

function readHomeConfig(home: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(home, ".config", "jenkins-cli", "jenkins-cli-config.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

function runCli(home: string, args: string[]): CliRun {
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
  });
  return {
    exitCode: result.exitCode,
    output:
      new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
  };
}

afterAll(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
});

const TWO_PROFILE_CONFIG = {
  version: 2,
  defaultProfile: "work",
  debug: true,
  analyticsDisabled: true,
  profiles: {
    work: {
      jenkinsUrl: "https://jenkins-a.example.com",
      jenkinsUser: "ci-work",
      jenkinsApiToken: "work-secret-token",
    },
    home: {
      jenkinsUrl: "https://jenkins-b.example.com",
      jenkinsUser: "ci-home",
      jenkinsApiToken: "home-secret-token",
    },
  },
};

describe("auth profile management CLI", () => {
  test("auth help lists the profile management subcommands", () => {
    const result = runCli(makeHome(), ["auth", "--help"]);

    expect(result.exitCode).toBe(0);
    for (const command of [
      "auth login",
      "auth status",
      "auth list",
      "auth use <name>",
      "auth current",
      "auth rename <old> <new>",
      "auth logout",
    ]) {
      expect(result.output).toContain(command);
    }
  });

  test("root help documents auth profile management and compatibility commands", () => {
    const result = runCli(makeHome(), ["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("auth profile management:");
    expect(result.output).toContain("auth logout --all");
    expect(result.output).toContain("profile (compatibility):");
  });

  test("auth list prints profiles with default marker and storage type", () => {
    const result = runCli(makeHome(TWO_PROFILE_CONFIG), ["auth", "list"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      "work (default)  https://jenkins-a.example.com  ci-work  plaintext",
    );
    expect(result.output).toContain(
      "home  https://jenkins-b.example.com  ci-home  plaintext",
    );
  });

  test("auth list with no profiles prints a successful empty state", () => {
    const result = runCli(makeHome(), ["auth", "list"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("OK: No profiles configured.");
  });

  test("profile list renders the same rows as auth list", () => {
    const home = makeHome(TWO_PROFILE_CONFIG);
    const canonical = runCli(home, ["auth", "list"]);
    const compat = runCli(home, ["profile", "list"]);

    expect(compat.exitCode).toBe(0);
    expect(compat.output).toBe(canonical.output);
  });

  test("auth use switches the default profile and profile use matches", () => {
    const home = makeHome(TWO_PROFILE_CONFIG);
    const result = runCli(home, ["auth", "use", "home"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('OK: Default profile set to "home".');
    expect(readHomeConfig(home).defaultProfile).toBe("home");

    const compat = runCli(home, ["profile", "use", "work"]);
    expect(compat.exitCode).toBe(0);
    expect(compat.output).toContain('OK: Default profile set to "work".');
    expect(readHomeConfig(home).defaultProfile).toBe("work");
  });

  test("auth use rejects an unknown profile with available names", () => {
    const result = runCli(makeHome(TWO_PROFILE_CONFIG), [
      "auth",
      "use",
      "missing",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('ERROR: Profile "missing" was not found.');
    expect(result.output).toContain("Available profiles: work, home.");
  });

  test("auth current reports the default profile without printing the token", () => {
    const result = runCli(makeHome(TWO_PROFILE_CONFIG), ["auth", "current"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Source:           Default profile");
    expect(result.output).toContain("Profile:          work");
    expect(result.output).toContain(
      "Controller:       https://jenkins-a.example.com",
    );
    expect(result.output).toContain("Username:         ci-work");
    expect(result.output).toContain("Token storage:    Config file");
    expect(result.output).toContain("Token present:    Yes");
    expect(result.output).not.toContain("work-secret-token");
  });

  test("auth current fails with a configuration error for an unknown profile", () => {
    const result = runCli(makeHome(TWO_PROFILE_CONFIG), [
      "auth",
      "current",
      "--profile",
      "missing",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      'ERROR: Profile "missing" is not configured.',
    );
  });

  test("auth current fails when no credential source is resolvable", () => {
    const result = runCli(makeHome(), ["auth", "current"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("ERROR: Missing JENKINS_URL.");
  });

  test("auth logout removes the active plaintext profile", () => {
    const home = makeHome(TWO_PROFILE_CONFIG);
    const result = runCli(home, ["auth", "logout", "--non-interactive"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('OK: Logged out profile "work".');
    expect(result.output).toContain('OK: Default profile is "home".');
    expect(result.output).toContain("not revoked");

    const config = readHomeConfig(home);
    const profiles = config.profiles as Record<string, unknown>;
    expect(profiles.work).toBeUndefined();
    expect(profiles.home).toBeDefined();
    expect(config.defaultProfile).toBe("home");
    // Top-level settings survive the rewrite.
    expect(config.debug).toBe(true);
    expect(config.analyticsDisabled).toBe(true);
  });

  test("auth logout rejects --all combined with --profile", () => {
    const result = runCli(makeHome(TWO_PROFILE_CONFIG), [
      "auth",
      "logout",
      "--all",
      "--profile",
      "work",
      "--non-interactive",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "ERROR: --all and --profile are mutually exclusive.",
    );
  });

  test("auth logout --all removes every profile", () => {
    const home = makeHome(TWO_PROFILE_CONFIG);
    const result = runCli(home, [
      "auth",
      "logout",
      "--all",
      "--non-interactive",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("OK: Logged out 2 profile(s).");
    expect(readHomeConfig(home).profiles).toEqual({});
  });

  test("auth logout --all with no profiles is a successful no-op", () => {
    const result = runCli(makeHome(), [
      "auth",
      "logout",
      "--all",
      "--non-interactive",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("OK: No profiles configured.");
  });

  test("auth rename renames the active profile and updates the default", () => {
    const home = makeHome(TWO_PROFILE_CONFIG);
    const result = runCli(home, ["auth", "rename", "work", "corp"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('OK: Renamed profile "work" to "corp".');
    expect(result.output).toContain('OK: Default profile is "corp".');

    const config = readHomeConfig(home);
    const profiles = config.profiles as Record<
      string,
      { jenkinsApiToken: string }
    >;
    expect(profiles.work).toBeUndefined();
    expect(profiles.corp?.jenkinsApiToken).toBe("work-secret-token");
    expect(config.defaultProfile).toBe("corp");
  });

  test("auth rename rejects an existing destination", () => {
    const result = runCli(makeHome(TWO_PROFILE_CONFIG), [
      "auth",
      "rename",
      "work",
      "home",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('ERROR: Profile "home" already exists.');
  });

  test("profile delete routes through the strict deletion operation", () => {
    const home = makeHome(TWO_PROFILE_CONFIG);
    const result = runCli(home, [
      "profile",
      "delete",
      "home",
      "--non-interactive",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('OK: Deleted profile "home".');
    expect(result.output).toContain('OK: Default profile is "work".');

    const config = readHomeConfig(home);
    expect((config.profiles as Record<string, unknown>).home).toBeUndefined();
    expect(config.analyticsDisabled).toBe(true);
  });
});
