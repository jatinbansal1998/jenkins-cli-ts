import { describe, expect, test } from "bun:test";
import { FULL_HELP_COMMANDS } from "../src/cli/full-help";
import {
  commandPathSupportsJson,
  commandPathSupportsJsonl,
} from "../src/cli/json-commands";
import packageJson from "../package.json";
import { runCli } from "./helpers.cli";

type HelpCatalogDocument = {
  ok: boolean;
  command: string;
  data: {
    version: string;
    commands: Array<{
      path: string[];
      invocation: string;
      json: boolean;
      jsonl: boolean;
      help: string;
    }>;
  };
};

function parseHelpCatalog(output: string): HelpCatalogDocument {
  const line = output.split("\n").find((entry) => entry.startsWith('{"ok":'));
  expect(line).toBeDefined();
  return JSON.parse(line as string) as HelpCatalogDocument;
}

/**
 * Tests for the agent-friendly help surface: the enriched root help epilog
 * and the aggregated `help --full` reference.
 */

describe("root help for agents", () => {
  test("documents job selection, scripting conventions, and examples", () => {
    const result = runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Examples:");
    expect(result.output).toContain("Job selection (build, status, history,");
    expect(result.output).toContain("Fuzzy match on job name or description");
    expect(result.output).toContain("Scripting and AI agents:");
    expect(result.output).toContain(
      "--json: list, params, build, status, history, wait, tests, changes, artifacts",
    );
    expect(result.output).toContain("--jsonl: logs.");
    expect(result.output).toContain(
      "OK: (success), ERROR: (failure), HINT: (guidance)",
    );
    expect(result.output).toContain("Exit code is 0 on success and 1 on any");
    // Internal worker command spawned for background cache refreshes.
    expect(result.output).not.toContain("refresh-job-cache");
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

describe("help --json", () => {
  test("emits one catalog document covering every command", () => {
    const result = runCli(["help", "--json"]);

    expect(result.exitCode).toBe(0);
    const document = parseHelpCatalog(result.output);
    expect(document).toMatchObject({
      ok: true,
      command: "help",
      data: { version: packageJson.version },
    });
    expect(document.data.commands.map((entry) => entry.path)).toEqual(
      FULL_HELP_COMMANDS,
    );
    for (const entry of document.data.commands) {
      expect(entry.invocation).toBe(
        ["jenkins-cli", ...entry.path, "--help"].join(" "),
      );
      expect(entry.json).toBe(commandPathSupportsJson(entry.path));
      expect(entry.jsonl).toBe(commandPathSupportsJsonl(entry.path));
      expect(entry.help.length).toBeGreaterThan(0);
    }
    const list = document.data.commands.find(
      (entry) => entry.path.length === 1 && entry.path[0] === "list",
    );
    const logs = document.data.commands.find(
      (entry) => entry.path.length === 1 && entry.path[0] === "logs",
    );
    const login = document.data.commands.find(
      (entry) => entry.path.length === 2 && entry.path[1] === "login",
    );
    const help = document.data.commands.find(
      (entry) => entry.path.length === 1 && entry.path[0] === "help",
    );
    expect(list?.json).toBe(true);
    expect(logs?.jsonl).toBe(true);
    expect(logs?.json).toBe(false);
    expect(login?.json).toBe(false);
    expect(help?.json).toBe(true);
  }, 60_000);

  test.each([
    { args: ["--json", "help"] },
    { args: ["--profile", "help", "--json", "help"] },
    { args: ["--non-interactive", "--json", "help"] },
  ])(
    "accepts global options before help: %j",
    ({ args }) => {
      const result = runCli([...args]);
      expect(result.exitCode).toBe(0);
      expect(parseHelpCatalog(result.output).command).toBe("help");
    },
    60_000,
  );

  test("help --full --json is the same catalog", () => {
    const plain = runCli(["help", "--json"]);
    const full = runCli(["help", "--full", "--json"]);
    expect(plain.exitCode).toBe(0);
    expect(full.exitCode).toBe(0);
    const plainDoc = parseHelpCatalog(plain.output);
    const fullDoc = parseHelpCatalog(full.output);
    expect(fullDoc.data.version).toBe(plainDoc.data.version);
    expect(fullDoc.data.commands.map((entry) => entry.path)).toEqual(
      plainDoc.data.commands.map((entry) => entry.path),
    );
    expect(
      fullDoc.data.commands.map((entry) => [entry.json, entry.jsonl]),
    ).toEqual(plainDoc.data.commands.map((entry) => [entry.json, entry.jsonl]));
  }, 60_000);

  test("help --jsonl stays unsupported", () => {
    const result = runCli(["help", "--jsonl"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toStartWith('{"type":"error","error":');
    expect(result.output).toContain("does not support --jsonl");
  });
});

describe("help --full", () => {
  test("honors explicit boolean values for --full", () => {
    const enabled = runCli(["help", "--full=true"]);
    expect(enabled.exitCode).toBe(0);
    expect(enabled.output).toContain("\njenkins-cli auth login --help\n");

    const disabled = runCli(["help", "--full", "false"]);
    expect(disabled.exitCode).toBe(0);
    expect(disabled.output).not.toContain("\njenkins-cli auth login --help\n");
  }, 60_000);

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
    expect(result.output).toContain("--channel"); // update
  }, 60_000);
});
