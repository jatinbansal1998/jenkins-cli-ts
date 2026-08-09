import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for the agent-friendly help surface: the enriched root help epilog
 * and the aggregated `help --full` reference.
 */

function runCli(args: string[]): { exitCode: number; output: string } {
  const home = mkdtempSync(join(tmpdir(), "jenkins-cli-help-home-"));
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

describe("root help for agents", () => {
  test("documents job selection, scripting conventions, and examples", () => {
    const result = runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Examples:");
    expect(result.output).toContain("Job selection (build, status, history,");
    expect(result.output).toContain("Fuzzy match on job name or description");
    expect(result.output).toContain("Scripting and AI agents:");
    expect(result.output).toContain(
      "--json: list, params, build, status, history, wait, artifacts",
    );
    expect(result.output).toContain("--jsonl: logs.");
    expect(result.output).toContain(
      "OK: (success), ERROR: (failure), HINT: (guidance)",
    );
    expect(result.output).toContain("Exit code is 0 on success and 1 on any");
  });

  test("epilog covers params, run, and value hints with defaults", () => {
    const result = runCli(["--help"]);

    expect(result.output).toContain("params:");
    expect(result.output).toContain(
      "--json  List running builds as one JSON document",
    );
    expect(result.output).toContain(
      "--branch-param <name>  Parameter name for the branch [default: BRANCH]",
    );
    expect(result.output).toContain("[default: 0]");
  });

  test("epilog documents the list activity filter", () => {
    const result = runCli(["--help"]);

    expect(result.output).toContain(
      "--active-only    Show built jobs not marked disabled by Jenkins",
    );
  });

  test("status, history, and wait help distinguish branch input from git revisions", () => {
    for (const command of ["status", "history", "wait"]) {
      const result = runCli([command, "--help"]);

      expect(result.exitCode).toBe(0);
      // Full rendered lines: proves the block survives yargs' 80-column
      // wrap without orphaned fragments and the columns stay aligned.
      expect(result.output).toContain(
        "  branch       Configured branch parameter value (an input, not\n" +
          "               checkout evidence)",
      );
      expect(result.output).toContain(
        "  revisions[]  Git-plugin checkout evidence: repo, remote URL(s),\n" +
          "               branch, SHA. Duplicate checkouts are merged; omitted\n" +
          "               when the build's metadata could not be fetched.",
      );
    }
  });

  test("explains unsupported structured combinations", () => {
    const result = runCli(["--help"]);

    expect(result.output).toContain(
      "Unsupported --json combinations fail with a clear message",
    );
  });

  test("plain help command prints the root help", () => {
    const result = runCli(["help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Usage: jenkins-cli [command] [options]");
  });
});

describe("help --full", () => {
  test("aggregates every command's help into one document", () => {
    const result = runCli(["help", "--full"]);

    expect(result.exitCode).toBe(0);
    for (const header of [
      "jenkins-cli --help",
      "jenkins-cli auth login --help",
      "jenkins-cli auth logout --help",
      "jenkins-cli build --help",
      "jenkins-cli update --help",
      "jenkins-cli help --help",
    ]) {
      expect(result.output).toContain(`\n${header}\n`);
    }
    // Options that only live in subcommand help are now present in one output.
    expect(result.output).toContain("Delete every stored profile"); // logout --all
    expect(result.output).toContain("--without-params"); // build
    expect(result.output).toContain("--offline-only"); // nodes
    expect(result.output).toContain("--enable-auto-install"); // update
  }, 60_000);
});
