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
import { optionalString } from "./cli/options";
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
import { JenkinsClient } from "./jenkins/api-wrapper";
import { pruneOldApiLogs, setDebugMode } from "./logger";
import {
  enforceMinimumVersionFromCache,
  kickOffMinimumVersionRefresh,
} from "./min-version-policy";
import { maybePromptTokenMigration } from "./token-migration";
import { formatPromptTarget } from "./tui-target";
import {
  getDeferredUpdatePromptVersion,
  kickOffAutoUpdate,
  readUpdateState,
  shouldPromptForDeferredUpdate,
  writeUpdateState,
} from "./update";
import { BUILD_TARGET } from "./build-target";
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

async function main(): Promise<void> {
  const rawArgs = hideBin(process.argv);
  // yargs' built-in `help` command shadows a registered handler, so the
  // aggregated reference is dispatched here before yargs parses.
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
      default: true,
      describe: "Show the interactive ASCII intro banner",
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
  const context = await buildContext(env, argv);
  await maybePromptTokenMigration({ env: context.env, interactive });
  return context;
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
    !argv?.nonInteractive && !argv?.json && isInteractiveTerminal();
  let introShown = false;
  const showIntro = (target?: string): void => {
    if (introShown || !interactive || argv?.banner === false) {
      return;
    }
    introShown = true;
    printCliIntro({
      showAsciiBanner: true,
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
    const context = await prepareContext(argv, showIntro, interactive);
    await action({
      ...context,
      argv,
      showIntro,
    });
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

if (import.meta.main) {
  // Exit handlers must be synchronous; pruneOldApiLogs is. This also runs
  // after explicit process.exit() calls (e.g. yargs --help).
  process.on("exit", () => pruneOldApiLogs());
  main().catch((error) => {
    handleCliError(error);
    process.exitCode = 1;
  });
}
