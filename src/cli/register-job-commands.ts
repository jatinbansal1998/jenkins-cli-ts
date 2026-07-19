import type { Argv } from "yargs";
import { runList } from "../commands/list";
import { runParams } from "../commands/params";
import { addJobOptions, addJsonOption, optionalString } from "./options";
import type {
  CommandRegistrationDependencies,
  RunTrackedCommandWithContext,
} from "./registration-types";

export function registerJobCommands(
  parser: Argv,
  dependencies: CommandRegistrationDependencies,
): Argv {
  const listHandler = createListHandler(
    dependencies.runTrackedCommandWithContext,
  );

  return parser
    .command("list", "List Jenkins jobs", configureListOptions, listHandler)
    .command(
      "$0",
      "List Jenkins jobs (default)",
      configureListOptions,
      listHandler,
    )
    .command(
      "params",
      "Show parameter definitions for a Jenkins job",
      (yargsInstance) => addJsonOption(addJobOptions(yargsInstance)),
      async (argv) => {
        await dependencies.runTrackedCommandWithContext(
          "params",
          argv,
          async ({ env, client }) => {
            await runParams({
              client,
              env,
              job: optionalString(argv.job),
              jobUrl: optionalString(argv.jobUrl),
              nonInteractive:
                Boolean(argv.nonInteractive) || Boolean(argv.json),
              json: Boolean(argv.json),
            });
          },
        );
      },
    );
}

export function configureListOptions(yargsInstance: Argv): Argv {
  return yargsInstance
    .option("search", {
      type: "string",
      describe: "Search jobs by name or description",
    })
    .option("refresh", {
      type: "boolean",
      default: false,
      describe: "Refresh the job cache from Jenkins",
    })
    .option("json", {
      type: "boolean",
      default: false,
      describe: "Output a single JSON document (implies non-interactive)",
    });
}

function createListHandler(
  runTrackedCommandWithContext: RunTrackedCommandWithContext,
) {
  return async (argv: {
    _?: unknown;
    $0?: unknown;
    search?: unknown;
    refresh?: unknown;
    nonInteractive?: unknown;
    json?: unknown;
    banner?: unknown;
    profile?: unknown;
    url?: unknown;
    user?: unknown;
    token?: unknown;
    apiToken?: unknown;
    folderDepth?: unknown;
  }): Promise<void> => {
    await runTrackedCommandWithContext(
      "list",
      argv,
      async ({ env, client }) => {
        await runList({
          client,
          env,
          search: optionalString(argv.search),
          refresh: Boolean(argv.refresh),
          nonInteractive: Boolean(argv.nonInteractive),
          json: Boolean(argv.json),
        });
      },
    );
  };
}
