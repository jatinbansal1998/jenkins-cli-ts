import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScriptName } from "../src/cli";

function runCli(
  args: string[],
  config?: Record<string, unknown>,
): { exitCode: number; output: string } {
  const home = mkdtempSync(join(tmpdir(), "jenkins-cli-auth-home-"));
  try {
    if (config) {
      const configDir = join(home, ".config", "jenkins-cli");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "jenkins-cli-config.json"),
        JSON.stringify(config),
      );
    }
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("auth CLI routing and help", () => {
  test("uses the product name for source and compiled Bun entry points", () => {
    expect(getScriptName("/workspace/src/index.ts")).toBe("jenkins-cli");
    expect(getScriptName("/snapshot/index.js")).toBe("jenkins-cli");
  });

  test("primary help lists the auth command and compatibility login alias", () => {
    const result = runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("jenkins-cli auth");
    expect(result.output).toContain("Configure and troubleshoot Jenkins");
    expect(result.output).toContain("jenkins-cli login");
    expect(result.output).toContain("compatibility");
    expect(result.output).toContain("alias for auth login");
  });

  test("auth help lists login and status subcommands", () => {
    const result = runCli(["auth", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("jenkins-cli auth login");
    expect(result.output).toContain("jenkins-cli auth status");
  });

  test("auth login and legacy login expose the same command options", () => {
    const canonical = runCli(["auth", "login", "--help"]);
    const legacy = runCli(["login", "--help"]);

    for (const option of [
      "--url",
      "--user",
      "--token",
      "--branch-param",
      "--profile",
      "--keychain",
    ]) {
      expect(canonical.output).toContain(option);
      expect(legacy.output).toContain(option);
    }
  });

  test("auth login and legacy login route to the same implementation", () => {
    const canonical = runCli(["auth", "login", "--non-interactive"]);
    const legacy = runCli(["login", "--non-interactive"]);

    expect(canonical.exitCode).toBe(1);
    expect(legacy.exitCode).toBe(1);
    expect(canonical.output).toContain("Missing required --url.");
    expect(legacy.output).toContain("Missing required --url.");
  });

  test("auth status renders known configuration fields before failing", () => {
    const result = runCli(["auth", "status", "--non-interactive"]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Profile:          Environment");
    expect(result.output).toContain("Controller:       Unknown");
    expect(result.output).toContain("Token storage:    Environment variables");
    expect(result.output).toContain("ERROR: Missing JENKINS_URL.");
  });

  test("auth status recognizes a configured profile whose plaintext token is missing", () => {
    const result = runCli(["auth", "status", "--non-interactive"], {
      version: 2,
      defaultProfile: "work",
      profiles: {
        work: {
          jenkinsUrl: "http://127.0.0.1:1",
          jenkinsUser: "ci",
          jenkinsApiToken: "",
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Profile:          work");
    expect(result.output).toContain("Token storage:    Config file");
    expect(result.output).toContain("Token present:    No");
    expect(result.output).toContain("ERROR: No Jenkins API token was found.");
  });
});
