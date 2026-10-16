import type { Argv } from "yargs";
import { parseBuildSelection } from "../build-selector";
import { runCancel } from "../commands/cancel";
import { runNodes } from "../commands/nodes";
import { runQueue } from "../commands/queue";
import { runReplay } from "../commands/replay";
import { runRerun } from "../commands/rerun";
import { runRunningBuilds } from "../commands/run";
import {
  addBuildOption,
  addBuildUrlOption,
  addJobOptions,
  addJsonOption,
  addQueueUrlOption,
  optionalString,
} from "./options";
import { REPLAY_HELP } from "./help-epilog";
import type { CommandRegistrationDependencies } from "./registration-types";

export function registerOperationsCommands(
  parser: Argv,
  dependencies: CommandRegistrationDependencies,
): Argv {
  const { runCommandWithContext } = dependencies;

  return parser
    .command(
      "run",
      "List running builds and open one in the browser",
      addJsonOption,
      async (argv) => {
        await runCommandWithContext("run", argv, async ({ client }) => {
          await runRunningBuilds({
            client,
            nonInteractive: Boolean(argv.nonInteractive || argv.json),
            json: Boolean(argv.json),
          });
        });
      },
    )
    .command(
      "cancel [job-name]",
      "Cancel a queued or running build",
      (yargsInstance) =>
        addJsonOption(
          addQueueUrlOption(
            addBuildUrlOption(addBuildOption(addJobOptions(yargsInstance))),
          ),
        ),
      async (argv) => {
        await runCommandWithContext("cancel", argv, async ({ env, client }) => {
          await runCancel({
            client,
            env,
            job: optionalString(argv.job),
            jobUrl: optionalString(argv.jobUrl),
            build: parseBuildSelection(argv.build),
            buildUrl: optionalString(argv.buildUrl),
            queueUrl: optionalString(argv.queueUrl),
            nonInteractive: Boolean(argv.nonInteractive || argv.json),
            json: Boolean(argv.json),
          });
        });
      },
    )
    .command(
      "queue",
      "Show the Jenkins build queue",
      (yargsInstance) =>
        addJsonOption(
          yargsInstance.option("job", {
            type: "string",
            describe: "Filter queued items to a job name",
          }),
        ),
      async (argv) => {
        await runCommandWithContext("queue", argv, async ({ env, client }) => {
          await runQueue({
            client,
            env,
            job: optionalString(argv.job),
            nonInteractive: Boolean(argv.nonInteractive || argv.json),
            json: Boolean(argv.json),
          });
        });
      },
    )
    .command(
      "nodes",
      "Show Jenkins agents and executor usage",
      (yargsInstance) =>
        addJsonOption(
          yargsInstance.option("offline-only", {
            type: "boolean",
            default: false,
            describe: "Show only offline nodes",
          }),
        ),
      async (argv) => {
        await runCommandWithContext("nodes", argv, async ({ env, client }) => {
          await runNodes({
            client,
            env,
            offlineOnly: Boolean(argv.offlineOnly),
            nonInteractive: Boolean(argv.nonInteractive || argv.json),
            json: Boolean(argv.json),
          });
        });
      },
    )
    .command(
      "rerun [job-name]",
      "Rerun the last failed build for a job",
      (yargsInstance) =>
        addJsonOption(
          addBuildUrlOption(addBuildOption(addJobOptions(yargsInstance))),
        ),
      async (argv) => {
        await runCommandWithContext("rerun", argv, async ({ env, client }) => {
          await runRerun({
            client,
            env,
            job: optionalString(argv.job),
            jobUrl: optionalString(argv.jobUrl),
            build: parseBuildSelection(argv.build),
            buildUrl: optionalString(argv.buildUrl),
            nonInteractive: Boolean(argv.nonInteractive || argv.json),
            json: Boolean(argv.json),
          });
        });
      },
    )
    .command(
      "replay [job-name]",
      "Run a Pipeline build again with an edited Jenkinsfile",
      configureReplayOptions,
      async (argv) => {
        await runCommandWithContext("replay", argv, async ({ env, client }) => {
          await runReplay({
            client,
            env,
            job: optionalString(argv.job),
            jobUrl: optionalString(argv.jobUrl),
            build: parseBuildSelection(argv.build),
            buildUrl: optionalString(argv.buildUrl),
            script: optionalString(argv.script),
            loaded: Array.isArray(argv.loaded) ? argv.loaded.map(String) : [],
            printScript: Boolean(argv.printScript),
            printLoaded: optionalString(argv.printLoaded),
            follow: Boolean(argv.follow),
            nonInteractive: Boolean(argv.nonInteractive || argv.json),
            json: Boolean(argv.json),
          });
        });
      },
    );
}

function configureReplayOptions(yargsInstance: Argv): Argv {
  return addJsonOption(
    addBuildUrlOption(addBuildOption(addJobOptions(yargsInstance))),
  )
    .option("script", {
      type: "string",
      describe: "Edited main script to run (a file path, or - for stdin)",
    })
    .option("loaded", {
      type: "string",
      array: true,
      describe:
        "Replace a script the build loaded with `load`, as NAME=file (repeatable)",
    })
    .option("print-script", {
      type: "boolean",
      default: false,
      describe: "Print the build's main script to stdout and exit",
    })
    .option("print-loaded", {
      type: "string",
      describe: "Print one loaded script, such as Script1, to stdout and exit",
    })
    .option("follow", {
      type: "boolean",
      default: false,
      describe: "Stream the new build's logs and exit with its result",
    })
    .epilog(REPLAY_HELP);
}
