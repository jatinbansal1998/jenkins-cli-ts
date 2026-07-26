import type { Argv } from "yargs";
import { runArtifacts } from "../commands/artifacts";
import { runBuild } from "../commands/build";
import { runHistory } from "../commands/history";
import { DEFAULT_LOG_POLL_MS, runLogs } from "../commands/logs";
import { runStatus } from "../commands/status";
import { runWait } from "../commands/wait";
import { DEFAULT_WATCH_INTERVAL_MS } from "../commands/watch-utils";
import {
  parseArtifactFilters,
  parseBuildCustomParams,
} from "./argument-values";
import {
  addBuildOption,
  addBuildUrlOption,
  addJobOptions,
  addJsonOption,
  addJsonLinesOption,
  addQueueUrlOption,
  addWatchOption,
  optionalString,
  wasBranchParamExplicitlyPassed,
  wasWatchExplicitlyPassed,
} from "./options";
import type { CommandRegistrationDependencies } from "./registration-types";

export function registerBuildCommands(
  parser: Argv,
  dependencies: CommandRegistrationDependencies,
  rawArgs: string[],
): Argv {
  const { runTrackedCommandWithContext } = dependencies;

  return parser
    .command(
      ["build [job-name]", "deploy [job-name]"],
      "Trigger a Jenkins build (alias: deploy)",
      configureBuildOptions,
      async (argv) => {
        await runTrackedCommandWithContext(
          "build",
          argv,
          async ({ env, client }) => {
            const branchParamExplicitlyPassed =
              wasBranchParamExplicitlyPassed(rawArgs);
            const watchExplicitlyPassed = wasWatchExplicitlyPassed(rawArgs);
            await runBuild({
              client,
              env,
              job: optionalString(argv.job),
              jobUrl: optionalString(argv.jobUrl),
              branch: optionalString(argv.branch),
              customParams: parseBuildCustomParams(argv.param),
              branchParam: branchParamExplicitlyPassed
                ? optionalString(argv.branchParam)
                : env.branchParamDefault,
              defaultBranch:
                Boolean(argv.nonInteractive || argv.json) &&
                (Boolean(argv.withoutParams) || Boolean(argv.defaultBranch)),
              nonInteractive: Boolean(argv.nonInteractive || argv.json),
              watch: watchExplicitlyPassed ? Boolean(argv.watch) : undefined,
              json: Boolean(argv.json),
            });
          },
        );
      },
    )
    .command(
      "status [job-name]",
      "Show last build status for a job",
      (yargsInstance) =>
        addJsonOption(
          addWatchOption(
            addBuildUrlOption(addBuildOption(addJobOptions(yargsInstance))),
            "Watch selected build status until completion",
          ),
        ),
      async (argv) => {
        await runTrackedCommandWithContext(
          "status",
          argv,
          async ({ env, client }) => {
            const watchExplicitlyPassed = wasWatchExplicitlyPassed(rawArgs);
            await runStatus({
              client,
              env,
              job: optionalString(argv.job),
              jobUrl: optionalString(argv.jobUrl),
              build: typeof argv.build === "number" ? argv.build : undefined,
              buildUrl: optionalString(argv.buildUrl),
              nonInteractive: Boolean(argv.nonInteractive || argv.json),
              watch: watchExplicitlyPassed ? Boolean(argv.watch) : undefined,
              json: Boolean(argv.json),
            });
          },
        );
      },
    )
    .command(
      ["history [job-name]", "builds [job-name]"],
      "Show paginated build history for a job",
      (yargsInstance) =>
        addJsonOption(
          addJobOptions(yargsInstance).option("offset", {
            type: "number",
            default: 0,
            describe: "Skip the first N builds before showing the next 5",
          }),
        ),
      async (argv) => {
        await runTrackedCommandWithContext(
          "history",
          argv,
          async ({ env, client }) => {
            await runHistory({
              client,
              env,
              job: optionalString(argv.job),
              jobUrl: optionalString(argv.jobUrl),
              offset: typeof argv.offset === "number" ? argv.offset : 0,
              nonInteractive: Boolean(argv.nonInteractive || argv.json),
              json: Boolean(argv.json),
            });
          },
        );
      },
    )
    .command(
      "wait [job-name]",
      "Wait for a Jenkins build to finish",
      configureWaitOptions,
      async (argv) => {
        await runTrackedCommandWithContext(
          "wait",
          argv,
          async ({ env, client }) => {
            await runWait({
              client,
              env,
              job: optionalString(argv.job),
              jobUrl: optionalString(argv.jobUrl),
              build: typeof argv.build === "number" ? argv.build : undefined,
              buildUrl: optionalString(argv.buildUrl),
              queueUrl: optionalString(argv.queueUrl),
              interval: optionalString(argv.interval),
              timeout: optionalString(argv.timeout),
              nonInteractive: Boolean(argv.nonInteractive || argv.json),
              json: Boolean(argv.json),
            });
          },
        );
      },
    )
    .command(
      "logs [job-name]",
      "Stream Jenkins build logs",
      configureLogsOptions,
      async (argv) => {
        await runTrackedCommandWithContext(
          "logs",
          argv,
          async ({ env, client }) => {
            await runLogs({
              client,
              env,
              job: optionalString(argv.job),
              jobUrl: optionalString(argv.jobUrl),
              build: typeof argv.build === "number" ? argv.build : undefined,
              buildUrl: optionalString(argv.buildUrl),
              queueUrl: optionalString(argv.queueUrl),
              follow: Boolean(argv.follow),
              poll: optionalString(argv.poll),
              nonInteractive: Boolean(argv.nonInteractive || argv.jsonl),
              jsonl: Boolean(argv.jsonl),
            });
          },
        );
      },
    )
    .command(
      "artifacts [job-name]",
      "List or download build artifacts",
      configureArtifactsOptions,
      async (argv) => {
        await runTrackedCommandWithContext(
          "artifacts",
          argv,
          async ({ env, client }) => {
            await runArtifacts({
              client,
              env,
              job: optionalString(argv.job),
              jobUrl: optionalString(argv.jobUrl),
              build: typeof argv.build === "number" ? argv.build : undefined,
              buildUrl: optionalString(argv.buildUrl),
              download: Boolean(argv.download),
              dest: optionalString(argv.dest),
              artifact: parseArtifactFilters(argv.artifact),
              force: Boolean(argv.force),
              nonInteractive: Boolean(argv.nonInteractive || argv.json),
              json: Boolean(argv.json),
            });
          },
        );
      },
    );
}

function configureBuildOptions(yargsInstance: Argv): Argv {
  return addJsonOption(
    addWatchOption(
      addJobOptions(yargsInstance)
        .option("branch", {
          type: "string",
          describe: "Branch name to build",
        })
        .option("branch-param", {
          type: "string",
          default: "BRANCH",
          describe: "Parameter name for the branch",
        })
        .option("param", {
          type: "string",
          array: true,
          describe: "Custom build parameter in KEY=VALUE format (repeatable)",
        })
        .option("without-params", {
          type: "boolean",
          default: false,
          describe:
            "Trigger build without parameters (non-interactive only; ignored when prompts are shown)",
        })
        .option("default-branch", {
          type: "boolean",
          default: false,
          hidden: true,
        }),
      "Watch build status until completion",
    ),
  );
}

function configureWaitOptions(yargsInstance: Argv): Argv {
  return addJsonOption(
    addQueueUrlOption(
      addBuildUrlOption(addBuildOption(addJobOptions(yargsInstance))),
    )
      .option("interval", {
        type: "string",
        describe: `Polling interval (e.g. ${DEFAULT_WATCH_INTERVAL_MS / 1000}s, 1m)`,
      })
      .option("timeout", {
        type: "string",
        describe: "Timeout (e.g. 30m, 2h)",
      }),
  );
}

function configureLogsOptions(yargsInstance: Argv): Argv {
  return addJsonLinesOption(
    addQueueUrlOption(
      addBuildUrlOption(addBuildOption(addJobOptions(yargsInstance))),
    ),
  )
    .option("follow", {
      type: "boolean",
      default: true,
      describe: "Keep streaming logs until build completes",
    })
    .option("poll", {
      type: "string",
      describe: `Polling interval when following (e.g. ${DEFAULT_LOG_POLL_MS / 1000}s)`,
    });
}

function configureArtifactsOptions(yargsInstance: Argv): Argv {
  return addJsonOption(
    addBuildUrlOption(addBuildOption(addJobOptions(yargsInstance))),
  )
    .option("download", {
      type: "boolean",
      default: false,
      describe: "Download artifacts instead of only listing them",
    })
    .option("dest", {
      type: "string",
      describe: "Destination directory for downloads (default: cwd)",
    })
    .option("artifact", {
      type: "string",
      array: true,
      describe:
        "Restrict downloads to a relativePath (repeatable). Implies --download",
    })
    .option("force", {
      type: "boolean",
      default: false,
      describe: "Overwrite existing files when downloading",
    });
}
