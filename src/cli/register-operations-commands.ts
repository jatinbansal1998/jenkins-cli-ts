import type { Argv } from "yargs";
import { runCancel } from "../commands/cancel";
import { runNodes } from "../commands/nodes";
import { runQueue } from "../commands/queue";
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
            build: typeof argv.build === "number" ? argv.build : undefined,
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
            build: typeof argv.build === "number" ? argv.build : undefined,
            buildUrl: optionalString(argv.buildUrl),
            nonInteractive: Boolean(argv.nonInteractive || argv.json),
            json: Boolean(argv.json),
          });
        });
      },
    );
}
