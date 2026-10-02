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
  applyOutputOptions,
  GLOBAL_BOOLEAN_OPTIONS,
  GLOBAL_OPTIONS,
  isJsonLinesOutputRequested,
  isJsonOutputRequested,
  optionalString,
  validateOutputOptions,
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
import { type LoadedConfig, readConfigSync } from "./config";
import { loadEnv, getDebugDefault, resolveApiToken } from "./env";

import { JenkinsClient } from "./jenkins/client";
import { logCliError, pruneOldLogs, setDebugMode } from "./logger";
import {
  enforceMinimumVersionFromCache,
  kickOffMinimumVersionRefresh,
  MIN_VERSION_REFRESH_COMMAND,
  refreshMinimumVersionPolicy,
} from "./min-version-policy";
import { maybeMigrateToken } from "./token-migration";
import { formatPromptTarget } from "./tui-target";
import { kickOffAutoUpdate, readUpdateState } from "./update";
import { BUILD_TARGET } from "./build-target";
import { emitJsonError, emitJsonLine, toJsonError } from "./json-output";
import { exitCodeFor } from "./error-codes";
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
  // The detached policy worker must bypass the startup gate below, or it would
  // spawn another worker and could be blocked by the very policy it refreshes.
  if (rawArgs[0] === MIN_VERSION_REFRESH_COMMAND) {
    await refreshMinimumVersionPolicy(VERSION);
    return;
  }
  // yargs treats a trailing positional "help" as --help before dispatching
  // command handlers. Parse global option types before handling the catalog.
  const startupFlags = parseArgs(rawArgs, {
    boolean: [
      ...GLOBAL_BOOLEAN_OPTIONS,
      "full",
      "jsonl",
      "help",
      "h",
      "version",
      "v",
    ],
  });
  validateOutputOptions(startupFlags);
  const isHelpCommand = startupFlags._[0] === "help";
  if (isHelpCommand && isJsonLinesOutputRequested(rawArgs)) {
    throw new CliError(
      "'help' does not support --jsonl output.",
      [],
      "INVALID_USAGE",
    );
  }
  if (isHelpCommand && isJsonOutputRequested(rawArgs)) {
    await printJsonHelp(scriptName, VERSION, createParser);
    return;
  }
  if (isHelpCommand && startupFlags.full === true) {
    await printFullHelp(scriptName, createParser);
    return;
  }
  // Help was explicitly asked for, so --quiet only silences what follows.
  applyOutputOptions(startupFlags);

  const updateState = await readUpdateState();
  kickOffMinimumVersionRefresh({ rawArgs, state: updateState });
  await enforceMinimumVersionFromCache({
    currentVersion: VERSION,
    rawArgs,
    state: updateState,
  });
  kickOffAutoUpdate(VERSION, rawArgs, updateState);

  await createParser(rawArgs).parseAsync();
}

function createParser(rawArgs: string[]): Argv {
  const dependencies: CommandRegistrationDependencies = {
    runCommand,
    runCommandWithContext,
  };
  let parser: Argv = yargs(rawArgs)
    .scriptName(scriptName)
    .usage("Usage: $0 [command] [options]")
    .options(GLOBAL_OPTIONS)
    .middleware((argv) => {
      if (argv.quiet) {
        argv.nonInteractive = true;
      }
    });

  parser = registerAuthCommands(parser, dependencies);
  parser = registerJobCommands(parser, dependencies);
  parser = registerBuildCommands(parser, dependencies, rawArgs);
  parser = registerOperationsCommands(parser, dependencies);
  parser = registerInputCommands(parser, dependencies);
  parser = registerUpdateHelpCommands(parser, dependencies, VERSION);
  return parser
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
      throw new CliError(
        message,
        ["Run with --help to see usage."],
        "INVALID_USAGE",
      );
    });
}

function loadContextEnv(
  loadedConfig: LoadedConfig | null,
  argv?: ContextArgv,
): ReturnType<typeof loadEnv> {
  const env = loadEnv(loadedConfig, {
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

function buildContext(env: ReturnType<typeof loadEnv>): CommandContext {
  // Keychain-backed tokens are read on the first Jenkins request, so commands
  // served from the local cache never unlock the keychain.
  const client = new JenkinsClient({
    baseUrl: env.jenkinsUrl,
    user: env.jenkinsUser,
    apiToken: () => resolveApiToken(env),
    useCrumb: env.useCrumb,
    folderDepth: env.folderDepth,
  });

  return { env, client };
}

async function prepareContext(
  argv: ContextArgv | undefined,
  showIntro: (target?: string) => void,
  interactive: boolean,
  loadedConfig: LoadedConfig | null,
): Promise<CommandContext> {
  const env = loadContextEnv(loadedConfig, argv);
  showIntro(formatPromptTarget(env));
  // Automatically migrate an eligible plaintext profile before command work.
  // Non-interactive runs stay silent to preserve structured output contracts.
  await maybeMigrateToken({
    env,
    config: loadedConfig?.config,
    report: interactive,
  });
  return buildContext(env);
}

async function runCommand(
  command: string,
  argv: CommandArgv | undefined,
  action: (helpers: {
    showIntro: (target?: string) => void;
    interactive: boolean;
    loadConfig: () => LoadedConfig | null;
  }) => Promise<void>,
): Promise<void> {
  // The config file is read at most once per command, and only when needed.
  let loadedConfig: LoadedConfig | null | undefined;
  const loadConfig = (): LoadedConfig | null => {
    if (loadedConfig === undefined) {
      loadedConfig = readConfigSync();
    }
    return loadedConfig;
  };
  setDebugMode(
    typeof argv?.debug === "boolean" ? argv.debug : getDebugDefault(loadConfig),
  );
  // --json implies non-interactive: no prompts, no banner on stdout.
  const interactive =
    !argv?.nonInteractive &&
    !argv?.json &&
    !argv?.jsonl &&
    isInteractiveTerminal();
  if (argv?.json && !JSON_COMMANDS.has(command)) {
    throw new CliError(
      `'${command.replaceAll(":", " ")}' does not support --json output.`,
      [],
      "INVALID_USAGE",
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
  await action({ showIntro, interactive, loadConfig });
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
  await runCommand(
    command,
    argv,
    async ({ showIntro, interactive, loadConfig }) => {
      try {
        const context = await prepareContext(
          argv,
          showIntro,
          interactive,
          loadConfig(),
        );
        await action({
          ...context,
          argv,
          showIntro,
        });
      } catch (error) {
        if (argv.json) {
          logCliError(error);
          emitJsonError(toJsonError(error));
          process.exitCode ||= exitCodeFor(error);
          return;
        }
        if (argv.jsonl) {
          logCliError(error);
          emitJsonLine({ type: "error", error: toJsonError(error) });
          process.exitCode ||= exitCodeFor(error);
          return;
        }
        throw error;
      }
    },
  );
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
  process.exitCode = exitCodeFor(error);
}

function fatalError(error: unknown): void {
  reportError(error);
  process.exit(exitCodeFor(error));
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
