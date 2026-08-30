import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs/yargs";
import { FULL_HELP_COMMANDS } from "../src/cli/full-help";
import {
  isJsonLinesOutputRequested,
  isJsonOutputRequested,
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

    await parse([
      "list",
      "--search",
      "api",
      "--refresh",
      "--active-only",
      "--json",
    ]);
    await parse(["--search", "api", "--refresh", "--active-only", "--json"]);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.command).toBe("list");
      expect(call.argv).toEqual(
        expect.objectContaining({
          search: "api",
          refresh: true,
          activeOnly: true,
          json: true,
          nonInteractive: false,
        }),
      );
    }
  });

  test("list help documents --active-only", () => {
    const help = runCli(["list", "--help"]);

    expect(help.exitCode).toBe(0);
    expect(help.output).toContain("--active-only");
    expect(help.output).toContain(
      "Show built jobs not marked disabled by Jenkins",
    );
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

describe("structured output registration", () => {
  test("documents JSON on supported commands and JSONL on logs", () => {
    for (const command of [
      ["build"],
      ["artifacts"],
      ["run"],
      ["cancel"],
      ["queue"],
      ["nodes"],
      ["rerun"],
      ["auth", "status"],
      ["auth", "list"],
      ["auth", "current"],
      ["update"],
    ]) {
      const result = runCli([...command, "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("--json");
    }

    const logs = runCli(["logs", "--help"]);
    expect(logs.exitCode).toBe(0);
    expect(logs.output).toContain("--jsonl");
    expect(logs.output).toContain("[default: stdout is a TTY]");
    for (const option of [
      "--tail",
      "--since",
      "--stage",
      "--stage-id",
      "--failed",
      "--plain",
      "--no-timestamps",
      "--grep",
      "--context",
    ]) {
      expect(logs.output).toContain(option);
    }
  });

  test("documents the stdout-sensitive follow default", () => {
    const logs = runCli(["logs", "--help"]);

    expect(logs.exitCode).toBe(0);
    expect(logs.output).toContain("[default: stdout is a TTY]");
  });

  test("documents JSON on the tests command", () => {
    const result = runCli(["tests", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("--json");
  });

  test("rejects conflicting Pipeline log selectors at registration", () => {
    for (const args of [
      ["--stage", "Test", "--failed"],
      ["--stage", "Test", "--stage-id", "42"],
      ["--stage-id", "42", "--failed"],
    ]) {
      const result = runCli(["logs", ...args, "--non-interactive"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("mutually exclusive");
    }
  });

  test("unsupported commands recognize --json and fail informatively", () => {
    for (const command of [
      ["auth", "login"],
      ["auth", "use", "work"],
      ["auth", "rename", "old", "new"],
      ["auth", "logout"],
      ["login"],
      ["profile", "list"],
      ["logs"],
      ["help"],
    ]) {
      const result = runCli([...command, "--json", "--non-interactive"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).not.toContain("Unknown argument: json");
      expect(result.output).toContain("does not support --json");
    }

    expect(
      runCli(["auth", "login", "--json", "--non-interactive"]).output,
    ).toContain("'auth login' does not support --json");
    expect(
      runCli(["profile", "list", "--json", "--non-interactive"]).output,
    ).toContain("'profile list' does not support --json");
  });

  test("keeps structured errors for explicit boolean syntax and help shortcuts", () => {
    for (const args of [
      ["auth", "login", "--json=true", "--non-interactive"],
      ["help", "--json=true"],
      ["help", "--full", "--json"],
      ["does-not-exist", "--json=true"],
    ]) {
      const result = runCli(args);
      expect(result.exitCode).toBe(1);
      expect(result.output).toStartWith('{"ok":false,"error":');
    }

    for (const args of [
      ["help", "--jsonl=true"],
      ["help", "--full", "--jsonl"],
    ]) {
      const result = runCli(args);
      expect(result.exitCode).toBe(1);
      expect(result.output).toStartWith('{"type":"error","error":');
    }
  });
});

describe("command help and global options", () => {
  test("all exact-build commands expose the shared selectors", () => {
    for (const command of [
      "status",
      "wait",
      "logs",
      "artifacts",
      "tests",
      "cancel",
      "rerun",
    ]) {
      const result = runCli([command, "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("--build");
      expect(result.output).toContain("--build-url");
    }
  });

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
        "--confirm-protected",
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
  test("keeps the ASCII banner opt-in", () => {
    const result = runCli(["--help"]);
    const bannerStart = result.output.indexOf("--banner");
    const jsonStart = result.output.indexOf("--json", bannerStart);
    const bannerHelp = result.output.slice(bannerStart, jsonStart);

    expect(result.exitCode).toBe(0);
    expect(bannerHelp).toContain("[default: false]");
  });

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

    expect(isJsonOutputRequested(["--json"])).toBe(true);
    expect(isJsonOutputRequested(["--json=true"])).toBe(true);
    expect(isJsonOutputRequested(["--json=false"])).toBe(false);
    expect(isJsonLinesOutputRequested(["--jsonl"])).toBe(true);
    expect(isJsonLinesOutputRequested(["--jsonl=true"])).toBe(true);
    expect(isJsonLinesOutputRequested(["--jsonl=false"])).toBe(false);
  });
});
