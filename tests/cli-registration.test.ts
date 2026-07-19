import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs/yargs";
import { FULL_HELP_COMMANDS } from "../src/cli/full-help";
import {
  wasBranchParamExplicitlyPassed,
  wasWatchExplicitlyPassed,
} from "../src/cli/options";
import { registerJobCommands } from "../src/cli/register-job-commands";
import type { CommandRegistrationDependencies } from "../src/cli/registration-types";

function runCli(args: string[]): { exitCode: number; output: string } {
  const home = mkdtempSync(join(tmpdir(), "jenkins-cli-registration-home-"));
  try {
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

describe("list command registration", () => {
  test("list and the default command use the same parsed options and handler", async () => {
    const calls: Array<{ command: string; argv: Record<string, unknown> }> = [];
    const dependencies = {
      runTrackedCommand: async () => undefined,
      runTrackedCommandWithContext: async (command, argv) => {
        calls.push({ command, argv });
      },
    } as CommandRegistrationDependencies;

    const parse = async (args: string[]): Promise<void> => {
      await registerJobCommands(
        yargs(args).option("non-interactive", {
          type: "boolean",
          default: false,
        }),
        dependencies,
      )
        .exitProcess(false)
        .parseAsync();
    };

    await parse(["list", "--search", "api", "--refresh", "--json"]);
    await parse(["--search", "api", "--refresh", "--json"]);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.command).toBe("list");
      expect(call.argv).toEqual(
        expect.objectContaining({
          search: "api",
          refresh: true,
          json: true,
          nonInteractive: false,
        }),
      );
    }
  });
});

describe("command aliases", () => {
  test("all compatibility aliases expose their canonical command surface", () => {
    for (const [canonical, alias, option] of [
      [["build"], ["deploy"], "--without-params"],
      [["history"], ["builds"], "--offset"],
      [["update"], ["upgrade"], "--enable-auto-install"],
      [["auth", "login"], ["login"], "--keychain"],
    ] as const) {
      const canonicalHelp = runCli([...canonical, "--help"]);
      const aliasHelp = runCli([...alias, "--help"]);

      expect(canonicalHelp.exitCode).toBe(0);
      expect(aliasHelp.exitCode).toBe(0);
      expect(canonicalHelp.output).toContain(option);
      expect(aliasHelp.output).toContain(option);
    }

    const longVersion = runCli(["--version"]);
    const shortVersion = runCli(["-v"]);
    expect(shortVersion).toEqual(longVersion);
  });
});

describe("command help and global options", () => {
  test("every canonical command keeps command help and inherited global options", () => {
    for (const commandPath of FULL_HELP_COMMANDS) {
      const result = runCli([...commandPath, "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("jenkins-cli");
      for (const option of [
        "--non-interactive",
        "--banner",
        "--debug",
        "--profile",
        "--url",
        "--user",
        "--token",
        "--api-token",
        "--folder-depth",
      ]) {
        expect(result.output).toContain(option);
      }
    }
  }, 60_000);

  test("help --full covers every registered canonical command", () => {
    const result = runCli(["help", "--full"]);

    expect(result.exitCode).toBe(0);
    for (const commandPath of FULL_HELP_COMMANDS) {
      const header = ["jenkins-cli", ...commandPath, "--help"].join(" ");
      expect(result.output).toContain(`\n${header}\n`);
    }
  }, 60_000);
});

describe("hidden defaults and explicit flags", () => {
  test("keeps default-branch hidden while preserving visible build defaults", () => {
    const result = runCli(["build", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("--default-branch");
    expect(result.output).toContain("BRANCH");
    expect(result.output).toContain("[default: false]");
  });

  test("recognizes every supported explicit watch and branch-param spelling", () => {
    expect(wasWatchExplicitlyPassed([])).toBe(false);
    expect(wasWatchExplicitlyPassed(["--watch"])).toBe(true);
    expect(wasWatchExplicitlyPassed(["--no-watch"])).toBe(true);
    expect(wasWatchExplicitlyPassed(["--watch=false"])).toBe(true);
    expect(wasWatchExplicitlyPassed(["--no-watch=true"])).toBe(true);

    expect(wasBranchParamExplicitlyPassed([])).toBe(false);
    expect(wasBranchParamExplicitlyPassed(["--branch-param", "GIT_REF"])).toBe(
      true,
    );
    expect(wasBranchParamExplicitlyPassed(["--branch-param=GIT_REF"])).toBe(
      true,
    );
    expect(wasBranchParamExplicitlyPassed(["--branchParam", "GIT_REF"])).toBe(
      true,
    );
    expect(wasBranchParamExplicitlyPassed(["--branchParam=GIT_REF"])).toBe(
      true,
    );
  });
});
