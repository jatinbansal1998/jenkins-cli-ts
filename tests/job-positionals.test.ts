import { describe, expect, test } from "bun:test";
import yargs from "yargs/yargs";
import { registerBuildCommands } from "../src/cli/register-build-commands";
import { registerJobCommands } from "../src/cli/register-job-commands";
import { registerOperationsCommands } from "../src/cli/register-operations-commands";
import type { CommandRegistrationDependencies } from "../src/cli/registration-types";
import { runCli } from "./helpers.cli";

const jobCommands = [
  "params",
  "build",
  "deploy",
  "status",
  "history",
  "builds",
  "wait",
  "logs",
  "artifacts",
  "cancel",
  "rerun",
];

const canonicalJobCommands = [
  "params",
  "build",
  "status",
  "history",
  "wait",
  "logs",
  "artifacts",
  "cancel",
  "rerun",
];

async function parseJobCommand(
  args: string[],
): Promise<Record<string, unknown>> {
  let parsedArgv: Record<string, unknown> | undefined;
  const dependencies = {
    runTrackedCommand: async () => undefined,
    runTrackedCommandWithContext: async (_command, argv) => {
      parsedArgv = argv;
    },
  } as CommandRegistrationDependencies;

  let parser = yargs(args);
  parser = registerJobCommands(parser, dependencies);
  parser = registerBuildCommands(parser, dependencies, args);
  parser = registerOperationsCommands(parser, dependencies);
  await parser.strict().exitProcess(false).parseAsync();

  if (!parsedArgv) {
    throw new Error(`Command handler did not run for: ${args.join(" ")}`);
  }
  return parsedArgv;
}

describe("job positionals", () => {
  test("normalizes positional and --job forms uniformly", async () => {
    for (const command of jobCommands) {
      const positional = await parseJobCommand([command, "demo-app"]);
      expect(positional.job).toBe("demo-app");

      const option = await parseJobCommand([command, "--job", "demo-app"]);
      expect(option.job).toBe("demo-app");

      const matching = await parseJobCommand([
        command,
        "demo-app",
        "--job",
        "demo-app",
      ]);
      expect(matching.job).toBe("demo-app");
    }
  });

  test("rejects conflicting positional and --job values uniformly", async () => {
    for (const command of jobCommands) {
      await expect(
        parseJobCommand([command, "demo-app", "--job", "other-app"]),
      ).rejects.toThrow(
        'Positional job "demo-app" conflicts with --job "other-app".',
      );
    }
  });

  test("documents the positional job name on every canonical command", () => {
    for (const command of canonicalJobCommands) {
      const result = runCli([command, "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`${command} [job-name]`);
      expect(result.output).toContain("Positionals:");
      expect(result.output).toContain("job-name  Job name or description");
    }
  });
});
