#!/usr/bin/env bun
/** CLI entry point for jenkins-cli. */
import type { Argv } from "yargs";
import yargs from "yargs/yargs";
import parseArgs from "yargs-parser";
import { hideBin } from "yargs/helpers";

import { CliError, getScriptName, handleCliError } from "./cli";
import {
  parseArtifactFilters as parseArtifactFiltersValue,
  parseBuildCustomParams as parseBuildCustomParamsValue,
} from "./cli/argument-values";
import { printFullHelp, printJsonHelp } from "./cli/full-help";
import { JSON_COMMANDS } from "./cli/json-commands";
import { getRootHelpEpilog } from "./cli/help-epilog";
import {
  GLOBAL_OPTIONS,
  isJsonLinesOutputRequested,
  isJsonOutputRequested,
  optionalString,
} from "./cli/options";
import { registerAuthCommands } from "./cli/register-auth-commands";
import { registerBuildCommands } from "./cli/register-build-commands";
import { registerJobCommands } from "./cli/register-job-commands";
import { registerOperationsCommands } from "./cli/register-operations-commands";
import { registerInputCommands } from "./cli/register-input-commands";
import { registerUpdateHelpCommands } from "./cli/register-update-help-commands";
import type {
  CommandContext,
  CommandRegistrationDependencies,
  ContextArgv,
  ContextualCommandArgv,
  CommandArgv,
} from "./cli/registration-types";
import { printCliIntro } from "./cli-intro";
import { loadEnv, getDebugDefault, resolveApiToken } from "./env";

import { JenkinsClient } from "./jenkins/client";
import { logCliError, pruneOldLogs, setDebugMode } from "./logger";
import {
  enforceMinimumVersionFromCache,
  kickOffMinimumVersionRefresh,
} from "./min-version-policy";
import { maybeMigrateToken } from "./token-migration";
import { formatPromptTarget } from "./tui-target";
import { kickOffAutoUpdate } from "./update";
import { BUILD_TARGET } from "./build-target";
import { emitJsonError, emitJsonLine, toJsonError } from "./json-output";
import packageJson from "../package.json";

// Keep these public helpers as declarations owned by this entry point. Bun's
// compiled-binary bundler can otherwise emit an invalid ESM export when an
// imported binding is re-exported and also consumed by another bundled module.
export function parseArtifactFilters(value: unknown): string[] | undefined {
  return parseArtifactFiltersValue(value);
}

export function parseBuildCustomParams(
  value: unknown,
): Record<string, string> | undefined {
  return parseBuildCustomParamsValue(value);
}

const VERSION = packageJson.version;
const scriptName = getScriptName();

declare const __COMPILED_ENTRYPOINT__: boolean | undefined;

async function main(): Promise<void> {
  const rawArgs = hideBin(process.argv);
  // yargs treats a trailing positional "help" as --help before dispatching
  // command handlers. Parse global option types before handling the catalog.
  const helpRequest = parseArgs(rawArgs, {
    boolean: [
      ...Object.entries(GLOBAL_OPTIONS)
        .filter(([, option]) => option.type === "boolean")
        .map(([name]) => name),
      "full",
      "jsonl",
      "help",
      "h",
      "version",
      "v",
    ],
  });
  const isHelpCommand = helpRequest._[0] === "help";
  if (isHelpCommand && isJsonLinesOutputRequested(rawArgs)) {
    throw new CliError("'help' does not support --jsonl output.");
  }
  if (isHelpCommand && isJsonOutputRequested(rawArgs)) {
    await printJsonHelp(scriptName, VERSION);
    return;
  }
  if (isHelpCommand && rawArgs.includes("--full")) {
    await printFullHelp(scriptName);
    return;
  }

  kickOffMinimumVersionRefresh({ currentVersion: VERSION });
  await enforceMinimumVersionFromCache({ currentVersion: VERSION, rawArgs });
  kickOffAutoUpdate(VERSION, rawArgs);

  const dependencies: CommandRegistrationDependencies = {
    runCommand,
    runCommandWithContext,
  };
  let parser: Argv = yargs(rawArgs)
    .scriptName(scriptName)
    .usage("Usage: $0 [command] [options]")
    .options(GLOBAL_OPTIONS)
    .middleware((argv) => {
      // Check if --debug or --no-debug was explicitly passed.
      const debugExplicitlyPassed = rawArgs.some(
        (arg) => arg === "--debug" || arg === "--no-debug",
      );

      if (debugExplicitlyPassed) {
        setDebugMode(Boolean(argv.debug));
      } else {
        setDebugMode(getDebugDefault());
      }
    });

  parser = registerAuthCommands(parser, dependencies);
  parser = registerJobCommands(parser, dependencies);
  parser = registerBuildCommands(parser, dependencies, rawArgs);
  parser = registerOperationsCommands(parser, dependencies);
  parser = registerInputCommands(parser, dependencies);
  parser = registerUpdateHelpCommands(parser, dependencies, VERSION);
  parser = parser
    .version(
      "version",
      `Show version (${VERSION})`,
      `${VERSION} (${BUILD_TARGET})`,
    )
    .alias("version", "v")
    .strict()
    .help()
    .epilog(getRootHelpEpilog())
    .fail((message, error) => {
      if (error) {
        throw error;
      }
      throw new CliError(message, ["Run with --help to see usage."]);
    });

  await parser.parseAsync();
}

function loadContextEnv(argv?: ContextArgv): ReturnType<typeof loadEnv> {
  const env = loadEnv({
    profile: optionalString(argv?.profile),
    url: optionalString(argv?.url),
    user: optionalString(argv?.user),
    apiToken: optionalString(argv?.token) ?? optionalString(argv?.apiToken),
    confirmProtected: argv?.confirmProtected === true,
  });
  const folderDepth =
    typeof argv?.folderDepth === "number" && Number.isFinite(argv.folderDepth)
      ? Math.max(1, Math.floor(argv.folderDepth))
      : env.folderDepth;
  env.folderDepth = folderDepth;
  return env;
}

async function buildContext(
  env: ReturnType<typeof loadEnv>,
): Promise<CommandContext> {
  // Resolve keychain-backed tokens transparently for downstream API calls.
  const apiToken = await resolveApiToken(env);
  env.jenkinsApiToken = apiToken;
  const client = new JenkinsClient({
    baseUrl: env.jenkinsUrl,
    user: env.jenkinsUser,
    apiToken,
    useCrumb: env.useCrumb,
    folderDepth: env.folderDepth,
  });

  return { env, client };
}

async function prepareContext(
  argv: ContextArgv | undefined,
  showIntro: (target?: string) => void,
  interactive: boolean,
): Promise<CommandContext> {
  // Show the intro before the potentially slower keychain read.
  const env = loadContextEnv(argv);
  showIntro(formatPromptTarget(env));
  // Automatically migrate an eligible plaintext profile before command work.
  // Non-interactive runs stay silent to preserve structured output contracts.
  await maybeMigrateToken({ env, report: interactive });
  return await buildContext(env);
}

async function runCommand(
  command: string,
  argv: CommandArgv | undefined,
  action: (helpers: {
    showIntro: (target?: string) => void;
    interactive: boolean;
  }) => Promise<void>,
): Promise<void> {
  // --json implies non-interactive: no prompts, no banner on stdout.
  const interactive =
    !argv?.nonInteractive &&
    !argv?.json &&
    !argv?.jsonl &&
    isInteractiveTerminal();
  if (argv?.json && !JSON_COMMANDS.has(command)) {
    throw new CliError(
      `'${command.replaceAll(":", " ")}' does not support --json output.`,
    );
  }
  let introShown = false;
  const showIntro = (target?: string): void => {
    if (introShown || !interactive) {
      return;
    }
    introShown = true;
    printCliIntro({
      showAsciiBanner: argv?.banner === true,
      version: VERSION,
      target,
    });
  };
  await action({ showIntro, interactive });
}

async function runCommandWithContext<TArgv extends ContextualCommandArgv>(
  command: string,
  argv: TArgv,
  action: (
    helpers: CommandContext & {
      argv: TArgv;
      showIntro: (target?: string) => void;
    },
  ) => Promise<void>,
): Promise<void> {
  await runCommand(command, argv, async ({ showIntro, interactive }) => {
    try {
      const context = await prepareContext(argv, showIntro, interactive);
      await action({
        ...context,
        argv,
        showIntro,
      });
    } catch (error) {
      if (argv.json) {
        logCliError(error);
        emitJsonError(toJsonError(error));
        process.exitCode ||= 1;
        return;
      }
      if (argv.jsonl) {
        logCliError(error);
        emitJsonLine({ type: "error", error: toJsonError(error) });
        process.exitCode ||= 1;
        return;
      }
      throw error;
    }
  });
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

// Bun currently reports import.meta.main as false in compiled Windows
// executables (oven-sh/bun#30084). Build scripts replace this marker with true
// so the compiled CLI still runs, while source imports retain normal
// import.meta.main behavior.
const shouldRunCli =
  import.meta.main ||
  (typeof __COMPILED_ENTRYPOINT__ !== "undefined" && __COMPILED_ENTRYPOINT__);

function reportError(error: unknown): void {
  const rawArgs = hideBin(process.argv);
  if (isJsonOutputRequested(rawArgs)) {
    logCliError(error);
    emitJsonError(toJsonError(error));
  } else if (isJsonLinesOutputRequested(rawArgs)) {
    logCliError(error);
    emitJsonLine({ type: "error", error: toJsonError(error) });
  } else {
    handleCliError(error);
  }
  process.exitCode = 1;
}

function fatalError(error: unknown): void {
  reportError(error);
  process.exit(1);
}

if (shouldRunCli) {
  process.on("uncaughtException", fatalError);
  process.on("unhandledRejection", fatalError);

  process.stdout.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
  // Exit handlers must be synchronous; pruneOldLogs is. This also runs
  // after explicit process.exit() calls (e.g. yargs --help).
  process.on("exit", () => pruneOldLogs());
  await main().catch(reportError);
}
