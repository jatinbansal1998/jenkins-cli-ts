import type { Argv } from "yargs";
import { runCreate } from "../commands/create";
import { runJobConfig } from "../commands/job-config";
import { runList } from "../commands/list";
import { runParams } from "../commands/params";
import { runJobCacheRefresh } from "../commands/refresh-job-cache";
import { JOB_CACHE_REFRESH_COMMAND } from "../jobs";
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

  // Internal: the detached worker `loadJobs` spawns for a stale cache.
  parser.command(JOB_CACHE_REFRESH_COMMAND, false, {}, async () => {
    await runJobCacheRefresh();
  });

  return parser
    .command("list", "List Jenkins jobs", configureListOptions, listHandler)
    .command(
      "$0",
      "List Jenkins jobs (default)",
      configureListOptions,
      listHandler,
    )
    .command(
      "params [job-name]",
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
    )
    .command(
      "config [job-name]",
      "Print a job or folder's raw config.xml",
      addJobOptions,
      async (argv) => {
        await dependencies.runTrackedCommandWithContext(
          "config",
          argv,
          async ({ env, client }) => {
            await runJobConfig({
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
      "create <name>",
      "Create a Jenkins item from a config.xml file or by copying a job",
      (yargsInstance) =>
        addJsonOption(
          yargsInstance
            .positional("name", {
              type: "string",
              describe: "Name for the new item",
            })
            .option("config", {
              type: "string",
              describe: "Path to a config.xml file for the new item",
            })
            .option("copy-from", {
              type: "string",
              describe: "Job name or URL to copy the new item from",
            })
            .option("folder-url", {
              type: "string",
              describe: "Folder URL to create the item in (default: root)",
            }),
        ),
      async (argv) => {
        await dependencies.runTrackedCommandWithContext(
          "create",
          argv,
          async ({ env, client }) => {
            await runCreate({
              client,
              env,
              name: optionalString(argv.name),
              configPath: optionalString(argv.config),
              copyFrom: optionalString(argv.copyFrom),
              folderUrl: optionalString(argv.folderUrl),
              nonInteractive:
                Boolean(argv.nonInteractive) || Boolean(argv.json),
              json: Boolean(argv.json),
            });
          },
        );
      },
    );
}

function configureListOptions(yargsInstance: Argv): Argv {
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
    .option("active-only", {
      type: "boolean",
      default: false,
      describe: "Show built jobs not marked disabled by Jenkins",
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
    activeOnly?: unknown;
    nonInteractive?: unknown;
    json?: unknown;
    banner?: unknown;
    profile?: unknown;
    url?: unknown;
    user?: unknown;
    token?: unknown;
    apiToken?: unknown;
    folderDepth?: unknown;
    confirmProtected?: unknown;
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
          activeOnly: Boolean(argv.activeOnly),
          nonInteractive: Boolean(argv.nonInteractive),
          json: Boolean(argv.json),
        });
      },
    );
  };
}
