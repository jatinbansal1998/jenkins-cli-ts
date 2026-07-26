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
  const { runTrackedCommand, runTrackedCommandWithContext } = dependencies;

  return parser
    .command(
      "run",
      "List running builds and open one in the browser",
      addJsonOption,
      async (argv) => {
        await runTrackedCommandWithContext(
          "run",
          argv,
          async ({ env, client }) => {
            await runRunningBuilds({
              client,
              env,
              nonInteractive: Boolean(argv.nonInteractive || argv.json),
              json: Boolean(argv.json),
            });
          },
        );
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
        await runTrackedCommandWithContext(
          "cancel",
          argv,
          async ({ env, client }) => {
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
          },
        );
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
        await runTrackedCommandWithContext(
          "queue",
          argv,
          async ({ env, client }) => {
            await runQueue({
              client,
              env,
              job: optionalString(argv.job),
              nonInteractive: Boolean(argv.nonInteractive || argv.json),
              json: Boolean(argv.json),
            });
          },
        );
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
        await runTrackedCommandWithContext(
          "nodes",
          argv,
          async ({ env, client }) => {
            await runNodes({
              client,
              env,
              offlineOnly: Boolean(argv.offlineOnly),
              nonInteractive: Boolean(argv.nonInteractive || argv.json),
              json: Boolean(argv.json),
            });
          },
        );
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
        await runTrackedCommandWithContext(
          "rerun",
          argv,
          async ({ env, client }) => {
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
