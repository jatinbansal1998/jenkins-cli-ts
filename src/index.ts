#!/usr/bin/env bun
/**
 * CLI entry point for jenkins-cli.
 * Registers commands (list, build, status) and handles argument parsing via yargs.
 */
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { confirm, isCancel } from "@clack/prompts";
import { CliError, getScriptName, handleCliError, printHint } from "./cli";
import { runBuild } from "./commands/build";
import { runCancel } from "./commands/cancel";
import { runLogin } from "./commands/login";
import { runList } from "./commands/list";
import { runLogs } from "./commands/logs";
import { runRerun } from "./commands/rerun";
import { runStatus } from "./commands/status";
import { runUpdate } from "./commands/update";
import { runWait } from "./commands/wait";
import { loadEnv, getDebugDefault } from "./env";
import { JenkinsClient } from "./jenkins/client";
import { getJobCachePath } from "./jobs";
import { setDebugMode } from "./logger";
import {
  getDeferredUpdatePromptVersion,
  kickOffAutoUpdate,
  readUpdateState,
  shouldPromptForDeferredUpdate,
  writeUpdateState,
} from "./update";
import packageJson from "../package.json";

const VERSION = packageJson.version;

const scriptName = getScriptName();

async function main(): Promise<void> {
  const rawArgs = hideBin(process.argv);
  await promptForDeferredUpdate(VERSION, rawArgs);
  kickOffAutoUpdate(VERSION, rawArgs);

  const parser = yargs(rawArgs)
    .scriptName(scriptName)
    .usage("Usage: $0 [command] [options]")
    .option("non-interactive", {
      type: "boolean",
      default: false,
      describe: "Disable prompts and fail fast",
    })
    .option("debug", {
      type: "boolean",
      describe: "Log API requests and responses to api.log",
    })
    .middleware((argv) => {
      // Check if --debug or --no-debug was explicitly passed
      const debugExplicitlyPassed = rawArgs.some(
        (arg) => arg === "--debug" || arg === "--no-debug",
      );

      if (debugExplicitlyPassed) {
        // Use the explicit CLI value
        setDebugMode(Boolean(argv.debug));
      } else {
        // Fall back to env/config default
        setDebugMode(getDebugDefault());
      }
    })
    .command(
      "login",
      "Save Jenkins credentials to the config file",
      (yargsInstance) =>
        yargsInstance
          .option("url", {
            type: "string",
            describe: "Jenkins base URL",
          })
          .option("user", {
            type: "string",
            describe: "Jenkins username",
          })
          .option("token", {
            type: "string",
            alias: "api-token",
            describe: "Jenkins API token",
          })
          .option("branch-param", {
            type: "string",
            describe: "Branch parameter name (default from env/config)",
          }),
      async (argv) => {
        await runLogin({
          url: typeof argv.url === "string" ? argv.url : undefined,
          user: typeof argv.user === "string" ? argv.user : undefined,
          apiToken: typeof argv.token === "string" ? argv.token : undefined,
          branchParam:
            typeof argv.branchParam === "string" ? argv.branchParam : undefined,
          nonInteractive: Boolean(argv.nonInteractive),
        });
      },
    )
    .command(
      "list",
      "List Jenkins jobs",
      (yargsInstance) =>
        yargsInstance
          .option("search", {
            type: "string",
            describe: "Search jobs by name or description",
          })
          .option("refresh", {
            type: "boolean",
            default: false,
            describe: "Refresh the job cache from Jenkins",
          }),
      async (argv) => {
        const { env, client } = createContext();
        await runList({
          client,
          env,
          search: typeof argv.search === "string" ? argv.search : undefined,
          refresh: Boolean(argv.refresh),
          nonInteractive: Boolean(argv.nonInteractive),
        });
      },
    )
    .command(
      "$0",
      "List Jenkins jobs (default)",
      (yargsInstance) =>
        yargsInstance
          .option("search", {
            type: "string",
            describe: "Search jobs by name or description",
          })
          .option("refresh", {
            type: "boolean",
            default: false,
            describe: "Refresh the job cache from Jenkins",
          }),
      async (argv) => {
        const { env, client } = createContext();
        await runList({
          client,
          env,
          search: typeof argv.search === "string" ? argv.search : undefined,
          refresh: Boolean(argv.refresh),
          nonInteractive: Boolean(argv.nonInteractive),
        });
      },
    )
    .command(
      ["build", "deploy"],
      "Trigger a Jenkins build (alias: deploy)",
      (yargsInstance) =>
        yargsInstance
          .option("job", {
            type: "string",
            describe: "Job name or description",
          })
          .option("job-url", {
            type: "string",
            describe: "Full Jenkins job URL",
          })
          .option("branch", {
            type: "string",
            describe: "Branch name to build",
          })
          .option("branch-param", {
            type: "string",
            default: "BRANCH",
            describe: "Parameter name for the branch",
          })
          .option("without-params", {
            type: "boolean",
            default: false,
            describe: "Trigger build without parameters",
          })
          .option("default-branch", {
            type: "boolean",
            default: false,
            hidden: true,
          })
          .option("watch", {
            type: "boolean",
            default: false,
            describe: "Watch build status until completion",
          }),
      async (argv) => {
        const { env, client } = createContext();
        const rawArgs = hideBin(process.argv);
        const branchParamExplicitlyPassed = rawArgs.some(
          (arg) =>
            arg === "--branch-param" ||
            arg.startsWith("--branch-param=") ||
            arg === "--branchParam" ||
            arg.startsWith("--branchParam="),
        );
        const watchExplicitlyPassed = rawArgs.some(
          (arg) =>
            arg === "--watch" ||
            arg === "--no-watch" ||
            arg.startsWith("--watch=") ||
            arg.startsWith("--no-watch="),
        );
        await runBuild({
          client,
          env,
          job: typeof argv.job === "string" ? argv.job : undefined,
          jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
          branch: typeof argv.branch === "string" ? argv.branch : undefined,
          branchParam: branchParamExplicitlyPassed
            ? argv.branchParam
            : env.branchParamDefault,
          defaultBranch:
            Boolean(argv.nonInteractive) &&
            (Boolean(argv.withoutParams) || Boolean(argv.defaultBranch)),
          nonInteractive: Boolean(argv.nonInteractive),
          watch: watchExplicitlyPassed ? Boolean(argv.watch) : undefined,
        });
      },
    )
    .command(
      "status",
      "Show last build status for a job",
      (yargsInstance) =>
        yargsInstance
          .option("job", {
            type: "string",
            describe: "Job name or description",
          })
          .option("job-url", {
            type: "string",
            describe: "Full Jenkins job URL",
          })
          .option("watch", {
            type: "boolean",
            default: false,
            describe: "Watch latest build status until completion",
          }),
      async (argv) => {
        const { env, client } = createContext();
        const rawArgs = hideBin(process.argv);
        const watchExplicitlyPassed = rawArgs.some(
          (arg) =>
            arg === "--watch" ||
            arg === "--no-watch" ||
            arg.startsWith("--watch=") ||
            arg.startsWith("--no-watch="),
        );
        await runStatus({
          client,
          env,
          job: typeof argv.job === "string" ? argv.job : undefined,
          jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
          nonInteractive: Boolean(argv.nonInteractive),
          watch: watchExplicitlyPassed ? Boolean(argv.watch) : undefined,
        });
      },
    )
    .command(
      "wait",
      "Wait for a Jenkins build to finish",
      (yargsInstance) =>
        yargsInstance
          .option("job", {
            type: "string",
            describe: "Job name or description",
          })
          .option("job-url", {
            type: "string",
            describe: "Full Jenkins job URL",
          })
          .option("build-url", {
            type: "string",
            describe: "Full Jenkins build URL",
          })
          .option("queue-url", {
            type: "string",
            describe: "Full Jenkins queue item URL",
          })
          .option("interval", {
            type: "string",
            describe: "Polling interval (e.g. 10s, 1m)",
          })
          .option("timeout", {
            type: "string",
            describe: "Timeout (e.g. 30m, 2h)",
          }),
      async (argv) => {
        const { env, client } = createContext();
        await runWait({
          client,
          env,
          job: typeof argv.job === "string" ? argv.job : undefined,
          jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
          buildUrl:
            typeof argv.buildUrl === "string" ? argv.buildUrl : undefined,
          queueUrl:
            typeof argv.queueUrl === "string" ? argv.queueUrl : undefined,
          interval:
            typeof argv.interval === "string" ? argv.interval : undefined,
          timeout: typeof argv.timeout === "string" ? argv.timeout : undefined,
          nonInteractive: Boolean(argv.nonInteractive),
        });
      },
    )
    .command(
      "logs",
      "Stream Jenkins build logs",
      (yargsInstance) =>
        yargsInstance
          .option("job", {
            type: "string",
            describe: "Job name or description",
          })
          .option("job-url", {
            type: "string",
            describe: "Full Jenkins job URL",
          })
          .option("build-url", {
            type: "string",
            describe: "Full Jenkins build URL",
          })
          .option("queue-url", {
            type: "string",
            describe: "Full Jenkins queue item URL",
          })
          .option("follow", {
            type: "boolean",
            default: true,
            describe: "Keep streaming logs until build completes",
          })
          .option("poll", {
            type: "string",
            describe: "Polling interval when following (e.g. 2s)",
          }),
      async (argv) => {
        const { env, client } = createContext();
        await runLogs({
          client,
          env,
          job: typeof argv.job === "string" ? argv.job : undefined,
          jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
          buildUrl:
            typeof argv.buildUrl === "string" ? argv.buildUrl : undefined,
          queueUrl:
            typeof argv.queueUrl === "string" ? argv.queueUrl : undefined,
          follow: Boolean(argv.follow),
          poll: typeof argv.poll === "string" ? argv.poll : undefined,
          nonInteractive: Boolean(argv.nonInteractive),
        });
      },
    )
    .command(
      "cancel",
      "Cancel a queued or running build",
      (yargsInstance) =>
        yargsInstance
          .option("job", {
            type: "string",
            describe: "Job name or description",
          })
          .option("job-url", {
            type: "string",
            describe: "Full Jenkins job URL",
          })
          .option("build-url", {
            type: "string",
            describe: "Full Jenkins build URL",
          })
          .option("queue-url", {
            type: "string",
            describe: "Full Jenkins queue item URL",
          }),
      async (argv) => {
        const { env, client } = createContext();
        await runCancel({
          client,
          env,
          job: typeof argv.job === "string" ? argv.job : undefined,
          jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
          buildUrl:
            typeof argv.buildUrl === "string" ? argv.buildUrl : undefined,
          queueUrl:
            typeof argv.queueUrl === "string" ? argv.queueUrl : undefined,
          nonInteractive: Boolean(argv.nonInteractive),
        });
      },
    )
    .command(
      "rerun",
      "Rerun the last failed build for a job",
      (yargsInstance) =>
        yargsInstance
          .option("job", {
            type: "string",
            describe: "Job name or description",
          })
          .option("job-url", {
            type: "string",
            describe: "Full Jenkins job URL",
          }),
      async (argv) => {
        const { env, client } = createContext();
        await runRerun({
          client,
          env,
          job: typeof argv.job === "string" ? argv.job : undefined,
          jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
          nonInteractive: Boolean(argv.nonInteractive),
        });
      },
    )
    .command(
      ["update [tag]", "upgrade [tag]"],
      "Update the jenkins-cli binary (alias: upgrade)",
      (yargsInstance) =>
        yargsInstance
          .positional("tag", {
            type: "string",
            describe: "Install a specific version tag (e.g. v0.2.4)",
          })
          .option("check", {
            type: "boolean",
            default: false,
            describe: "Check for updates without installing",
          })
          .option("enable-auto", {
            type: "boolean",
            describe: "Enable daily update checks (notify only)",
          })
          .option("disable-auto", {
            type: "boolean",
            describe: "Disable daily update checks",
          })
          .option("enable-auto-install", {
            type: "boolean",
            describe: "Enable auto-install of updates",
          })
          .option("disable-auto-install", {
            type: "boolean",
            describe: "Disable auto-install of updates",
          })
          .conflicts("enable-auto", ["disable-auto", "check"])
          .conflicts("disable-auto", ["enable-auto", "check"])
          .conflicts("enable-auto-install", ["disable-auto-install", "check"])
          .conflicts("disable-auto-install", ["enable-auto-install", "check"])
          .conflicts("check", [
            "enable-auto",
            "disable-auto",
            "enable-auto-install",
            "disable-auto-install",
          ]),
      async (argv) => {
        await runUpdate({
          currentVersion: VERSION,
          tag: typeof argv.tag === "string" ? argv.tag : undefined,
          check: Boolean(argv.check),
          enableAuto: Boolean(argv.enableAuto),
          disableAuto: Boolean(argv.disableAuto),
          enableAutoInstall: Boolean(argv.enableAutoInstall),
          disableAutoInstall: Boolean(argv.disableAutoInstall),
        });
      },
    )
    .version("version", `Show version (${VERSION})`, VERSION)
    .alias("version", "v")
    .strict()
    .help()
    .epilog(
      `Command-specific options:
  list:
    --search   Search jobs by name or description
    --refresh  Refresh the job cache from Jenkins

  build / deploy:
    --job             Job name or description
    --job-url         Full Jenkins job URL
    --branch          Branch name to build
    --branch-param    Parameter name for the branch [default: "BRANCH"]
    --without-params  Trigger build without parameters
    --watch           Watch build status until completion

  status:
    --job      Job name or description
    --job-url  Full Jenkins job URL
    --watch    Watch latest build status until completion

  wait:
    --job       Job name or description
    --job-url   Full Jenkins job URL
    --build-url Full Jenkins build URL
    --queue-url Full Jenkins queue item URL
    --interval  Polling interval (e.g. 10s, 1m)
    --timeout   Timeout (e.g. 30m, 2h)

  logs:
    --job       Job name or description
    --job-url   Full Jenkins job URL
    --build-url Full Jenkins build URL
    --queue-url Full Jenkins queue item URL
    --follow    Keep streaming logs until build completes [default: true]
    --poll      Polling interval when following (e.g. 2s)

  cancel:
    --job       Job name or description
    --job-url   Full Jenkins job URL
    --build-url Full Jenkins build URL
    --queue-url Full Jenkins queue item URL

  rerun:
    --job      Job name or description
    --job-url  Full Jenkins job URL

  login:
    --url           Jenkins base URL
    --user          Jenkins username
    --token         Jenkins API token
    --branch-param  Branch parameter name

  config/env:
    JENKINS_USE_CRUMB / useCrumb  Enable Jenkins CSRF crumb usage [default: disabled]

  update / upgrade:
    [tag]          Install a specific version tag (e.g. v0.2.4)
    --check        Check for updates without installing
    --enable-auto  Enable daily update checks (notify only)
    --disable-auto Disable daily update checks
    --enable-auto-install  Enable auto-install of updates
    --disable-auto-install Disable auto-install of updates

Cache file: ${getJobCachePath()}

Run "$0 <command> --help" for full details.`,
    )
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
): Promise<void> {
  if (!shouldPromptForDeferredUpdate(rawArgs)) {
    return;
  }

  const state = await readUpdateState();
  const pendingVersion = getDeferredUpdatePromptVersion(state, currentVersion);
  if (!pendingVersion) {
    return;
  }

  const response = await confirm({
    message: `A new jenkins-cli version (${pendingVersion}) is available. Update now?`,
    initialValue: true,
  });

  if (isCancel(response) || !response) {
    await writeUpdateState({
      ...state,
      dismissedVersion: pendingVersion,
    });
    return;
  }

  try {
    await runUpdate({ currentVersion });
  } catch (error) {
    handleCliError(error);
    printHint("Continuing with the requested command.");
  }
}

function createContext(): {
  env: ReturnType<typeof loadEnv>;
  client: JenkinsClient;
} {
  const env = loadEnv();
  const client = new JenkinsClient({
    baseUrl: env.jenkinsUrl,
    user: env.jenkinsUser,
    apiToken: env.jenkinsApiToken,
    useCrumb: env.useCrumb,
  });
  return { env, client };
}

main().catch((error) => {
  handleCliError(error);
  process.exitCode = 1;
});
