import { CliError } from "../cli";
import { emitJsonSuccess } from "../json-output";
import { selfInvocation } from "../self-invocation";
import {
  commandPathSupportsJson,
  commandPathSupportsJsonl,
} from "./json-commands";

/** Every command whose --help output `help --full` aggregates, in display order. */
export const FULL_HELP_COMMANDS: string[][] = [
  [],
  ["auth"],
  ["auth", "login"],
  ["auth", "status"],
  ["auth", "list"],
  ["auth", "use"],
  ["auth", "current"],
  ["auth", "rename"],
  ["auth", "logout"],
  ["list"],
  ["params"],
  ["config"],
  ["create"],
  ["build"],
  ["status"],
  ["history"],
  ["wait"],
  ["logs"],
  ["tests"],
  ["changes"],
  ["artifacts"],
  ["run"],
  ["cancel"],
  ["queue"],
  ["nodes"],
  ["rerun"],
  ["input"],
  ["input", "list"],
  ["input", "approve"],
  ["input", "abort"],
  ["update"],
  ["help"],
];

type HelpCatalogCommand = {
  path: string[];
  invocation: string;
  json: boolean;
  jsonl: boolean;
  help: string;
};

type HelpCatalog = {
  version: string;
  commands: HelpCatalogCommand[];
};

type CommandHelpSection = {
  path: string[];
  invocation: string;
  help: string;
};

/**
 * Prints the --help output of every command in one document so automation and
 * AI agents can learn the complete CLI surface from a single invocation.
 * Children are spawned concurrently; each `--help` run skips the update
 * prompt/auto-update paths and never touches Jenkins.
 */
export async function printFullHelp(scriptName: string): Promise<void> {
  const sections = await collectCommandHelp(scriptName);
  const rule = "=".repeat(72);
  console.log(
    sections
      .map(
        (section) => `${rule}\n${section.invocation}\n${rule}\n${section.help}`,
      )
      .join("\n\n"),
  );
}

/** One JSON document: version plus every command's help, json, and jsonl flags. */
export async function printJsonHelp(
  scriptName: string,
  version: string,
): Promise<void> {
  const sections = await collectCommandHelp(scriptName);
  const data: HelpCatalog = {
    version,
    commands: sections.map((section) => ({
      path: section.path,
      invocation: section.invocation,
      json: commandPathSupportsJson(section.path),
      jsonl: commandPathSupportsJsonl(section.path),
      help: section.help,
    })),
  };
  emitJsonSuccess("help", data);
}

async function collectCommandHelp(
  scriptName: string,
): Promise<CommandHelpSection[]> {
  return await Promise.all(
    FULL_HELP_COMMANDS.map(async (commandPath) => {
      const invocation = [scriptName, ...commandPath, "--help"].join(" ");
      const child = Bun.spawn({
        cmd: selfInvocation([...commandPath, "--help"]),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) {
        throw new CliError(
          `Failed to collect help for "${invocation}".`,
          stderr.trim() ? [stderr.trim()] : [],
        );
      }
      return {
        path: commandPath,
        invocation,
        help: stdout.trim(),
      };
    }),
  );
}
