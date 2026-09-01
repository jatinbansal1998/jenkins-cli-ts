#!/usr/bin/env bun
/** CLI entry point for jenkins-cli. */
import { confirm, isCancel } from "@clack/prompts";
import type { Argv } from "yargs";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { runWithAnalytics, updateAnalyticsContext } from "./analytics";
import { CliError, getScriptName, handleCliError, printHint } from "./cli";
import {
  parseArtifactFilters as parseArtifactFiltersValue,
  parseBuildCustomParams as parseBuildCustomParamsValue,
} from "./cli/argument-values";
import { printFullHelp } from "./cli/full-help";
import { getRootHelpEpilog } from "./cli/help-epilog";
import {
  isJsonLinesOutputRequested,
  isJsonOutputRequested,
  optionalString,
} from "./cli/options";
import { registerAuthCommands } from "./cli/register-auth-commands";
import { registerBuildCommands } from "./cli/register-build-commands";
import { registerJobCommands } from "./cli/register-job-commands";
import { registerOperationsCommands } from "./cli/register-operations-commands";
import { registerUpdateHelpCommands } from "./cli/register-update-help-commands";
import type {
  CommandContext,
  CommandRegistrationDependencies,
  ContextArgv,
  ContextualCommandArgv,
  TrackedArgv,
} from "./cli/registration-types";
import { printCliIntro } from "./cli-intro";
import { runUpdate } from "./commands/update";
import { loadEnv, getDebugDefault, resolveApiToken } from "./env";
import {
  captureUnexpectedError,
  initializeDefaultErrorReporting,
} from "./error-reporting";
import { JenkinsClient } from "./jenkins/client";
import { pruneOldApiLogs, setDebugMode } from "./logger";
import {
  enforceMinimumVersionFromCache,
  kickOffMinimumVersionRefresh,
} from "./min-version-policy";
import { maybeMigrateToken } from "./token-migration";
import { formatPromptTarget } from "./tui-target";
import {
  getDeferredUpdatePromptVersion,
  kickOffAutoUpdate,
  readUpdateState,
  shouldPromptForDeferredUpdate,
  writeUpdateState,
} from "./update";
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
let pendingPromptIntroVersion: string | undefined;

declare const __COMPILED_ENTRYPOINT__: boolean | undefined;

async function main(): Promise<void> {
  const rawArgs = hideBin(process.argv);
  // yargs' built-in `help` command shadows a registered handler, so the
  // aggregated reference is dispatched here before yargs parses.
  if (rawArgs[0] === "help" && isJsonOutputRequested(rawArgs)) {
    throw new CliError("'help' does not support --json output.");
  }
  if (rawArgs[0] === "help" && isJsonLinesOutputRequested(rawArgs)) {
    throw new CliError("'help' does not support --jsonl output.");
  }
  if (rawArgs[0] === "help" && rawArgs.includes("--full")) {
    await printFullHelp(scriptName);
    return;
  }

  kickOffMinimumVersionRefresh({ currentVersion: VERSION });
  await enforceMinimumVersionFromCache({ currentVersion: VERSION, rawArgs });
  const deferredUpdatePrompt = await promptForDeferredUpdate(VERSION, rawArgs);
  pendingPromptIntroVersion = deferredUpdatePrompt.pendingPromptIntroVersion;
  kickOffAutoUpdate(VERSION, rawArgs);

  const dependencies: CommandRegistrationDependencies = {
    runTrackedCommand,
    runTrackedCommandWithContext,
  };
  let parser: Argv = yargs(rawArgs)
    .scriptName(scriptName)
    .usage("Usage: $0 [command] [options]")
    .option("non-interactive", {
      type: "boolean",
      default: false,
      describe: "Disable prompts and fail fast",
    })
    .option("banner", {
      type: "boolean",
      default: false,
      describe: "Show the interactive ASCII intro banner",
    })
    .option("json", {
      type: "boolean",
      default: false,
      describe:
        "Output structured JSON when supported (implies non-interactive)",
    })
    .option("debug", {
      type: "boolean",
      describe:
        "Log API requests and responses to api-<date>.log (kept for 7 days)",
    })
    .option("profile", {
      type: "string",
      describe: "Use credentials from a named profile in config",
    })
    .option("url", {
      type: "string",
      describe: "One-off Jenkins base URL override for this command",
    })
    .option("user", {
      type: "string",
      describe: "One-off Jenkins username override for this command",
    })
    .option("token", {
      type: "string",
      alias: "api-token",
      describe: "One-off Jenkins API token override for this command",
    })
    .option("folder-depth", {
      type: "number",
      describe:
        "Folder traversal depth for job discovery (default: 3, from config)",
    })
    .option("confirm-protected", {
      type: "boolean",
      describe:
        "Allow builds, cancels, and reruns on a read-only profile for this run",
    })
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
  parser = registerUpdateHelpCommands(parser, dependencies, {
    version: VERSION,
    printFullHelp: () => printFullHelp(scriptName),
    showRootHelp: () => parser.showHelp("log"),
  });
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

async function promptForDeferredUpdate(
  currentVersion: string,
  rawArgs: string[],
): Promise<{
  pendingPromptIntroVersion: string | undefined;
}> {
  if (!shouldPromptForDeferredUpdate(rawArgs)) {
    return { pendingPromptIntroVersion: undefined };
  }

  const state = await readUpdateState();
  const pendingVersion =
    getDeferredUpdatePromptVersion(state, currentVersion) ?? undefined;
  if (!pendingVersion) {
    return { pendingPromptIntroVersion: pendingVersion };
  }

  const response = await confirm({
    message: `A new jenkins-cli version (${pendingVersion}) is available. Update now?`,
    initialValue: true,
  });

  if (isCancel(response) || !response) {
    const nextState = {
      ...state,
      dismissedVersion: pendingVersion,
    };
    await writeUpdateState(nextState);
    return {
      pendingPromptIntroVersion:
        getDeferredUpdatePromptVersion(nextState, currentVersion) ?? undefined,
    };
  }

  try {
    await runUpdate({ currentVersion });
    return { pendingPromptIntroVersion: undefined };
  } catch (error) {
    handleCliError(error);
    await captureUnexpectedError(error);
    printHint("Continuing with the requested command.");
    return { pendingPromptIntroVersion: pendingVersion };
  }
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
  argv?: ContextArgv,
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
  updateAnalyticsContext({
    used_profile: Boolean(env.profileName),
    used_auth_override: hasCredentialOverrides(argv),
    use_crumb: env.useCrumb,
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
  return await buildContext(env, argv);
}

async function runTrackedCommand(
  command: string,
  argv: TrackedArgv | undefined,
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
      pendingUpdateVersion: pendingPromptIntroVersion,
    });
  };
  await runWithAnalytics(
    {
      command,
      interactive,
    },
    async () => action({ showIntro, interactive }),
  );
}

const JSON_COMMANDS = new Set([
  "list",
  "params",
  "build",
  "status",
  "history",
  "wait",
  "tests",
  "artifacts",
  "run",
  "cancel",
  "create",
  "queue",
  "nodes",
  "rerun",
  "auth:status",
  "auth:list",
  "auth:current",
  "update",
]);

async function runTrackedCommandWithContext<
  TArgv extends ContextualCommandArgv,
>(
  command: string,
  argv: TArgv,
  action: (
    helpers: CommandContext & {
      argv: TArgv;
      showIntro: (target?: string) => void;
    },
  ) => Promise<void>,
): Promise<void> {
  await runTrackedCommand(command, argv, async ({ showIntro, interactive }) => {
    try {
      const context = await prepareContext(argv, showIntro, interactive);
      await action({
        ...context,
        argv,
        showIntro,
      });
    } catch (error) {
      if (argv.json) {
        emitJsonError(toJsonError(error));
        process.exitCode ||= 1;
        return;
      }
      if (argv.jsonl) {
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

function hasCredentialOverrides(argv: ContextArgv | undefined): boolean {
  return (
    typeof argv?.url === "string" ||
    typeof argv?.user === "string" ||
    typeof argv?.token === "string" ||
    typeof argv?.apiToken === "string"
  );
}

// Bun currently reports import.meta.main as false in compiled Windows
// executables (oven-sh/bun#30084). Build scripts replace this marker with true
// so the compiled CLI still runs, while source imports retain normal
// import.meta.main behavior.
const shouldRunCli =
  import.meta.main ||
  (typeof __COMPILED_ENTRYPOINT__ !== "undefined" && __COMPILED_ENTRYPOINT__);

if (shouldRunCli) {
  await initializeDefaultErrorReporting();
  process.stdout.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
  // Exit handlers must be synchronous; pruneOldApiLogs is. This also runs
  // after explicit process.exit() calls (e.g. yargs --help).
  process.on("exit", () => pruneOldApiLogs());
  await main().catch(async (error) => {
    const rawArgs = hideBin(process.argv);
    if (isJsonOutputRequested(rawArgs)) {
      emitJsonError(toJsonError(error));
    } else if (isJsonLinesOutputRequested(rawArgs)) {
      emitJsonLine({ type: "error", error: toJsonError(error) });
    } else {
      handleCliError(error);
    }
    process.exitCode = 1;
    await captureUnexpectedError(error);
  });
}
