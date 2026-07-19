import type { Argv } from "yargs";
import { CliError } from "../cli";
import { runCancel } from "../commands/cancel";
import { runNodes } from "../commands/nodes";
import {
  runProfileDelete,
  runProfileList,
  runProfileUse,
} from "../commands/profile";
import { runQueue } from "../commands/queue";
import { runRerun } from "../commands/rerun";
import { runRunningBuilds } from "../commands/run";
import {
  addBuildUrlOption,
  addJobOptions,
  addQueueUrlOption,
  optionalString,
} from "./options";
import type { CommandRegistrationDependencies } from "./registration-types";

export function registerOperationsCommands(
  parser: Argv,
  dependencies: CommandRegistrationDependencies,
): Argv {
  const { runTrackedCommand, runTrackedCommandWithContext } = dependencies;

  return parser
    .command(
      "run",
      "List running builds and open one in the browser",
      () => {},
      async (argv) => {
        await runTrackedCommandWithContext(
          "run",
          argv,
          async ({ env, client }) => {
            await runRunningBuilds({
              client,
              env,
              nonInteractive: Boolean(argv.nonInteractive),
            });
          },
        );
      },
    )
    .command(
      "cancel",
      "Cancel a queued or running build",
      (yargsInstance) =>
        addQueueUrlOption(addBuildUrlOption(addJobOptions(yargsInstance))),
      async (argv) => {
        await runTrackedCommandWithContext(
          "cancel",
          argv,
          async ({ env, client }) => {
            await runCancel({
              client,
              env,
              job: optionalString(argv.job),
              jobUrl: optionalString(argv.jobUrl),
              buildUrl: optionalString(argv.buildUrl),
              queueUrl: optionalString(argv.queueUrl),
              nonInteractive: Boolean(argv.nonInteractive),
            });
          },
        );
      },
    )
    .command(
      "queue",
      "Show the Jenkins build queue",
      (yargsInstance) =>
        yargsInstance.option("job", {
          type: "string",
          describe: "Filter queued items to a job name",
        }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "queue",
          argv,
          async ({ env, client }) => {
            await runQueue({
              client,
              env,
              job: optionalString(argv.job),
              nonInteractive: Boolean(argv.nonInteractive),
            });
          },
        );
      },
    )
    .command(
      "nodes",
      "Show Jenkins agents and executor usage",
      (yargsInstance) =>
        yargsInstance.option("offline-only", {
          type: "boolean",
          default: false,
          describe: "Show only offline nodes",
        }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "nodes",
          argv,
          async ({ env, client }) => {
            await runNodes({
              client,
              env,
              offlineOnly: Boolean(argv.offlineOnly),
              nonInteractive: Boolean(argv.nonInteractive),
            });
          },
        );
      },
    )
    .command(
      "rerun",
      "Rerun the last failed build for a job",
      addJobOptions,
      async (argv) => {
        await runTrackedCommandWithContext(
          "rerun",
          argv,
          async ({ env, client }) => {
            await runRerun({
              client,
              env,
              job: optionalString(argv.job),
              jobUrl: optionalString(argv.jobUrl),
              nonInteractive: Boolean(argv.nonInteractive),
            });
          },
        );
      },
    )
    .command(
      "profile <action> [name]",
      "Manage Jenkins profiles",
      (yargsInstance) =>
        yargsInstance
          .positional("action", {
            type: "string",
            describe: "Profile action",
            choices: ["list", "use", "delete"],
          })
          .positional("name", {
            type: "string",
            describe: "Profile name (required for use/delete)",
          }),
      async (argv) => {
        const action = optionalString(argv.action) ?? "";
        const name = optionalString(argv.name);
        await runTrackedCommand(
          `profile:${action || "unknown"}`,
          argv,
          async ({ showIntro }) => {
            switch (action) {
              case "list":
                await runProfileList();
                return;
              case "use":
                if (!name) {
                  throw new CliError(
                    "Missing required <name> for profile use.",
                    ["Run `jenkins-cli profile use <name>`."],
                  );
                }
                await runProfileUse({ name });
                return;
              case "delete":
                if (!name) {
                  throw new CliError(
                    "Missing required <name> for profile delete.",
                    ["Run `jenkins-cli profile delete <name>`."],
                  );
                }
                showIntro();
                await runProfileDelete({
                  name,
                  nonInteractive: Boolean(argv.nonInteractive),
                });
                return;
              default:
                throw new CliError("Unknown profile action.", [
                  "Use one of: list, use, delete.",
                ]);
            }
          },
        );
      },
    );
}
