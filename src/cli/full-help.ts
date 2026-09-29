import type { Argv } from "yargs";
import { CliError } from "../cli";
import { emitJsonSuccess } from "../json-output";
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

type CreateParser = (rawArgs: string[]) => Argv;

/**
 * Prints the --help output of every command in one document so automation and
 * AI agents can learn the complete CLI surface from a single invocation.
 */
export async function printFullHelp(
  scriptName: string,
  createParser: CreateParser,
): Promise<void> {
  const sections = await collectCommandHelp(scriptName, createParser);
  const rule = "=".repeat(72);
  console.log(
    sections
      .map(
        (section) => `${rule}\n${section.invocation}\n${rule}\n${section.help}`,
      )
      .join("\n\n"),
  );
}

export async function printJsonHelp(
  scriptName: string,
  version: string,
  createParser: CreateParser,
): Promise<void> {
  const sections = await collectCommandHelp(scriptName, createParser);
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
  createParser: CreateParser,
): Promise<CommandHelpSection[]> {
  const sections: CommandHelpSection[] = [];
  for (const commandPath of FULL_HELP_COMMANDS) {
    const args = [...commandPath, "--help"];
    const invocation = [scriptName, ...args].join(" ");
    const help = await renderHelp(createParser(args), args).catch(
      (error: unknown) => {
        throw new CliError(`Failed to collect help for "${invocation}".`, [
          error instanceof Error ? error.message : String(error),
        ]);
      },
    );
    sections.push({ path: commandPath, invocation, help: help.trim() });
  }
  return sections;
}

// A parse callback makes yargs hand back the help text instead of printing it
// and exiting the process.
function renderHelp(parser: Argv, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    void parser.parse(args, {}, (error, _argv, output) => {
      if (error) {
        reject(error);
      } else {
        resolve(output);
      }
    });
  });
}
