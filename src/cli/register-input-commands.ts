import type { Argv } from "yargs";
import {
  runInputAbort,
  runInputApprove,
  runInputList,
} from "../commands/input";
import {
  addBuildOption,
  addBuildUrlOption,
  addJobOptions,
  addJsonOption,
  optionalString,
} from "./options";
import type { CommandRegistrationDependencies } from "./registration-types";

function addInputTargetOptions(yargsInstance: Argv): Argv {
  return addJsonOption(
    addBuildUrlOption(addBuildOption(addJobOptions(yargsInstance))),
  );
}

function addInputMutationOptions(yargsInstance: Argv): Argv {
  return addInputTargetOptions(yargsInstance)
    .option("id", {
      type: "string",
      describe: "Pending input action id (required when several are pending)",
    })
    .option("yes", {
      type: "boolean",
      default: false,
      describe:
        "Skip the confirmation prompt; required with --non-interactive or --json",
    });
}

export function registerInputCommands(
  parser: Argv,
  dependencies: CommandRegistrationDependencies,
): Argv {
  const { runCommandWithContext } = dependencies;

  return parser.command(
    "input",
    "Pending Pipeline input actions: list, approve, abort",
    (inputYargs) =>
      inputYargs
        .command(
          "list [job-name]",
          "List pending input actions for one build",
          addInputTargetOptions,
          async (argv) => {
            await runCommandWithContext(
              "input:list",
              argv,
              async ({ env, client }) => {
                await runInputList({
                  client,
                  env,
                  job: optionalString(argv.job),
                  jobUrl: optionalString(argv.jobUrl),
                  build:
                    typeof argv.build === "number" ? argv.build : undefined,
                  buildUrl: optionalString(argv.buildUrl),
                  nonInteractive: Boolean(argv.nonInteractive || argv.json),
                  json: Boolean(argv.json),
                });
              },
            );
          },
        )
        .command(
          "approve [job-name]",
          "Approve a parameterless pending input action",
          addInputMutationOptions,
          async (argv) => {
            await runCommandWithContext(
              "input:approve",
              argv,
              async ({ env, client }) => {
                await runInputApprove({
                  client,
                  env,
                  job: optionalString(argv.job),
                  jobUrl: optionalString(argv.jobUrl),
                  build:
                    typeof argv.build === "number" ? argv.build : undefined,
                  buildUrl: optionalString(argv.buildUrl),
                  id: optionalString(argv.id),
                  yes: Boolean(argv.yes),
                  nonInteractive: Boolean(argv.nonInteractive || argv.json),
                  json: Boolean(argv.json),
                });
              },
            );
          },
        )
        .command(
          "abort [job-name]",
          "Abort a pending input action",
          addInputMutationOptions,
          async (argv) => {
            await runCommandWithContext(
              "input:abort",
              argv,
              async ({ env, client }) => {
                await runInputAbort({
                  client,
                  env,
                  job: optionalString(argv.job),
                  jobUrl: optionalString(argv.jobUrl),
                  build:
                    typeof argv.build === "number" ? argv.build : undefined,
                  buildUrl: optionalString(argv.buildUrl),
                  id: optionalString(argv.id),
                  yes: Boolean(argv.yes),
                  nonInteractive: Boolean(argv.nonInteractive || argv.json),
                  json: Boolean(argv.json),
                });
              },
            );
          },
        )
        .demandCommand(1, "Choose an input command: list, approve, abort"),
    () => undefined,
  );
}
