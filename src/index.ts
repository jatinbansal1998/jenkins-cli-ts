#!/usr/bin/env bun
/**
 * CLI entry point for jenkins-cli.
 * Registers commands (list, build, status) and handles argument parsing via yargs.
 */
import yargs from "yargs/yargs";
import type { Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import { confirm, isCancel } from "@clack/prompts";
import { runWithAnalytics, updateAnalyticsContext } from "./analytics";
import { CliError, getScriptName, handleCliError, printHint } from "./cli";
import { runArtifacts } from "./commands/artifacts";
import {
  runAuthCurrent,
  runAuthList,
  runAuthLogout,
  runAuthRename,
  runAuthUse,
} from "./commands/auth-profile";
import { runAuthStatus } from "./commands/auth-status";
import { runBuild } from "./commands/build";
import { runCancel } from "./commands/cancel";
import { runHistory } from "./commands/history";
import { runLogin } from "./commands/login";
import { runList } from "./commands/list";
import { DEFAULT_LOG_POLL_MS, runLogs } from "./commands/logs";
import { runNodes } from "./commands/nodes";
import { runParams } from "./commands/params";
import {
  runProfileDelete,
  runProfileList,
  runProfileUse,
} from "./commands/profile";
import { runQueue } from "./commands/queue";
import { runRerun } from "./commands/rerun";
import { runRunningBuilds } from "./commands/run";
import { runStatus } from "./commands/status";
import { runUpdate } from "./commands/update";
import { runWait } from "./commands/wait";
import { DEFAULT_WATCH_INTERVAL_MS } from "./commands/watch-utils";
import { loadEnv, getDebugDefault, resolveApiToken } from "./env";
import { ENV_KEYS } from "./env-keys";
import { JenkinsClient } from "./jenkins/api-wrapper";
import { getJobCacheDir } from "./jobs";
import { pruneOldApiLogs, setDebugMode } from "./logger";
import {
  enforceMinimumVersionFromCache,
  kickOffMinimumVersionRefresh,
} from "./min-version-policy";
import {
  getDeferredUpdatePromptVersion,
  kickOffAutoUpdate,
  readUpdateState,
  shouldPromptForDeferredUpdate,
  writeUpdateState,
} from "./update";
import { printCliIntro } from "./cli-intro";
import { maybePromptTokenMigration } from "./token-migration";
import { formatPromptTarget } from "./tui-target";
import { BUILD_TARGET } from "./build-target";
import packageJson from "../package.json";

const VERSION = packageJson.version;
let pendingPromptIntroVersion: string | undefined;

const scriptName = getScriptName();

async function main(): Promise<void> {
  const rawArgs = hideBin(process.argv);
  // yargs' built-in `help` command shadows a registered handler, so the
  // aggregated reference is dispatched here before yargs parses.
  if (rawArgs[0] === "help" && rawArgs.includes("--full")) {
    await printFullHelp();
    return;
  }
  kickOffMinimumVersionRefresh({ currentVersion: VERSION });
  await enforceMinimumVersionFromCache({ currentVersion: VERSION, rawArgs });
  const deferredUpdatePrompt = await promptForDeferredUpdate(VERSION, rawArgs);
  pendingPromptIntroVersion = deferredUpdatePrompt.pendingPromptIntroVersion;
  kickOffAutoUpdate(VERSION, rawArgs);

  const parser = yargs(rawArgs)
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
      "auth",
      "Authentication commands: login, status, list, use, current, rename, logout",
      (authYargs) =>
        authYargs
          .command(
            "login",
            "Save Jenkins credentials",
            configureLoginOptions,
            async (argv) => {
              await runLoginCommand("auth:login", argv);
            },
          )
          .command(
            "status",
            "Validate credentials against Jenkins",
            (statusYargs) => statusYargs,
            async (argv) => {
              await runTrackedCommand("auth:status", argv, async () => {
                await runAuthStatus({
                  profile: toOptionalString(argv.profile),
                  url: toOptionalString(argv.url),
                  user: toOptionalString(argv.user),
                  apiToken:
                    toOptionalString(argv.token) ??
                    toOptionalString(argv.apiToken),
                });
              });
            },
          )
          .command(
            "list",
            "List stored credential profiles",
            (listYargs) => listYargs,
            async (argv) => {
              await runTrackedCommand("auth:list", argv, async () => {
                await runAuthList();
              });
            },
          )
          .command(
            "use <name>",
            "Set the default credential profile",
            (useYargs) =>
              useYargs.positional("name", {
                type: "string",
                describe: "Profile name",
              }),
            async (argv) => {
              await runTrackedCommand("auth:use", argv, async () => {
                await runAuthUse(toOptionalString(argv.name) ?? "");
              });
            },
          )
          .command(
            "current",
            "Show which credentials would be used",
            (currentYargs) => currentYargs,
            async (argv) => {
              await runTrackedCommand("auth:current", argv, async () => {
                await runAuthCurrent({
                  profile: toOptionalString(argv.profile),
                  url: toOptionalString(argv.url),
                  user: toOptionalString(argv.user),
                  apiToken:
                    toOptionalString(argv.token) ??
                    toOptionalString(argv.apiToken),
                });
              });
            },
          )
          .command(
            "rename <old> <new>",
            "Rename a stored credential profile",
            (renameYargs) =>
              renameYargs
                .positional("old", {
                  type: "string",
                  describe: "Current profile name",
                })
                .positional("new", {
                  type: "string",
                  describe: "New profile name",
                }),
            async (argv) => {
              await runTrackedCommand("auth:rename", argv, async () => {
                await runAuthRename(
                  toOptionalString(argv.old) ?? "",
                  toOptionalString(argv.new) ?? "",
                );
              });
            },
          )
          .command(
            "logout",
            "Remove local credentials (one or --all)",
            (logoutYargs) =>
              logoutYargs.option("all", {
                type: "boolean",
                default: false,
                describe: "Delete every stored profile",
              }),
            async (argv) => {
              await runTrackedCommand(
                "auth:logout",
                argv,
                async ({ showIntro }) => {
                  showIntro();
                  await runAuthLogout({
                    profile: toOptionalString(argv.profile),
                    all: Boolean(argv.all),
                    nonInteractive: Boolean(argv.nonInteractive),
                  });
                },
              );
            },
          )
          .demandCommand(
            1,
            "Choose an auth command: login, status, list, use, current, rename, or logout.",
          ),
      () => undefined,
    )
    .command(
      "login",
      "Save Jenkins credentials (compatibility alias for auth login)",
      configureLoginOptions,
      async (argv) => {
        await runLoginCommand("login", argv);
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
          })
          .option("json", {
            type: "boolean",
            default: false,
            describe: "Output a single JSON document (implies non-interactive)",
          }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "list",
          argv,
          async ({ env, client }) => {
            await runList({
              client,
              env,
              search: typeof argv.search === "string" ? argv.search : undefined,
              refresh: Boolean(argv.refresh),
              nonInteractive: Boolean(argv.nonInteractive),
              json: Boolean(argv.json),
            });
          },
        );
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
          })
          .option("json", {
            type: "boolean",
            default: false,
            describe: "Output a single JSON document (implies non-interactive)",
          }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "list",
          argv,
          async ({ env, client }) => {
            await runList({
              client,
              env,
              search: typeof argv.search === "string" ? argv.search : undefined,
              refresh: Boolean(argv.refresh),
              nonInteractive: Boolean(argv.nonInteractive),
              json: Boolean(argv.json),
            });
          },
        );
      },
    )
    .command(
      "params",
      "Show parameter definitions for a Jenkins job",
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
          .option("json", {
            type: "boolean",
            default: false,
            describe: "Output a single JSON document (implies non-interactive)",
          }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "params",
          argv,
          async ({ env, client }) => {
            await runParams({
              client,
              env,
              job: typeof argv.job === "string" ? argv.job : undefined,
              jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
              nonInteractive:
                Boolean(argv.nonInteractive) || Boolean(argv.json),
              json: Boolean(argv.json),
            });
          },
        );
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
          })
          .option("watch", {
            type: "boolean",
            default: false,
            describe: "Watch build status until completion",
          }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "build",
          argv,
          async ({ env, client }) => {
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
              customParams: parseBuildCustomParams(argv.param),
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
        );
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
          })
          .option("json", {
            type: "boolean",
            default: false,
            describe: "Output a single JSON document (implies non-interactive)",
          }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "status",
          argv,
          async ({ env, client }) => {
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
              json: Boolean(argv.json),
            });
          },
        );
      },
    )
    .command(
      ["history", "builds"],
      "Show paginated build history for a job",
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
          .option("offset", {
            type: "number",
            default: 0,
            describe: "Skip the first N builds before showing the next 5",
          })
          .option("json", {
            type: "boolean",
            default: false,
            describe: "Output a single JSON document (implies non-interactive)",
          }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "history",
          argv,
          async ({ env, client }) => {
            await runHistory({
              client,
              env,
              job: typeof argv.job === "string" ? argv.job : undefined,
              jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
              offset: argv.offset,
              nonInteractive: Boolean(argv.nonInteractive),
              json: Boolean(argv.json),
            });
          },
        );
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
            describe: `Polling interval (e.g. ${DEFAULT_WATCH_INTERVAL_MS / 1000}s, 1m)`,
          })
          .option("timeout", {
            type: "string",
            describe: "Timeout (e.g. 30m, 2h)",
          })
          .option("json", {
            type: "boolean",
            default: false,
            describe: "Output a single JSON document (implies non-interactive)",
          }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "wait",
          argv,
          async ({ env, client }) => {
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
              timeout:
                typeof argv.timeout === "string" ? argv.timeout : undefined,
              nonInteractive: Boolean(argv.nonInteractive),
              json: Boolean(argv.json),
            });
          },
        );
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
            describe: `Polling interval when following (e.g. ${DEFAULT_LOG_POLL_MS / 1000}s)`,
          }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "logs",
          argv,
          async ({ env, client }) => {
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
        );
      },
    )
    .command(
      "artifacts",
      "List or download build artifacts",
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
          .option("build", {
            type: "number",
            describe: "Target a specific build number (with --job/--job-url)",
          })
          .option("build-url", {
            type: "string",
            describe: "Full Jenkins build URL",
          })
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
          }),
      async (argv) => {
        await runTrackedCommandWithContext(
          "artifacts",
          argv,
          async ({ env, client }) => {
            await runArtifacts({
              client,
              env,
              job: typeof argv.job === "string" ? argv.job : undefined,
              jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
              build: typeof argv.build === "number" ? argv.build : undefined,
              buildUrl:
                typeof argv.buildUrl === "string" ? argv.buildUrl : undefined,
              download: Boolean(argv.download),
              dest: typeof argv.dest === "string" ? argv.dest : undefined,
              artifact: parseArtifactFilters(argv.artifact),
              force: Boolean(argv.force),
              nonInteractive: Boolean(argv.nonInteractive),
            });
          },
        );
      },
    )
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
        await runTrackedCommandWithContext(
          "cancel",
          argv,
          async ({ env, client }) => {
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
              job: typeof argv.job === "string" ? argv.job : undefined,
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
        await runTrackedCommandWithContext(
          "rerun",
          argv,
          async ({ env, client }) => {
            await runRerun({
              client,
              env,
              job: typeof argv.job === "string" ? argv.job : undefined,
              jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
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
        const action = typeof argv.action === "string" ? argv.action : "";
        const name = typeof argv.name === "string" ? argv.name : undefined;
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
          .option("channel", {
            type: "string",
            describe: "Set update channel: stable or prerelease",
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
        await runTrackedCommand("update", argv, async () => {
          await runUpdate({
            currentVersion: VERSION,
            tag: typeof argv.tag === "string" ? argv.tag : undefined,
            check: Boolean(argv.check),
            enableAuto: Boolean(argv.enableAuto),
            disableAuto: Boolean(argv.disableAuto),
            enableAutoInstall: Boolean(argv.enableAutoInstall),
            disableAutoInstall: Boolean(argv.disableAutoInstall),
            channel:
              typeof argv.channel === "string" ? argv.channel : undefined,
          });
        });
      },
    )
    .command(
      "help",
      "Show help (--full prints every command's options)",
      (helpYargs) =>
        helpYargs.option("full", {
          type: "boolean",
          default: false,
          describe:
            "Print the complete option reference for every command in one output",
        }),
      async (argv) => {
        if (argv.full) {
          await printFullHelp();
          return;
        }
        parser.showHelp("log");
      },
    )
    .version(
      "version",
      `Show version (${VERSION})`,
      `${VERSION} (${BUILD_TARGET})`,
    )
    .alias("version", "v")
    .strict()
    .help()
    .epilog(
      `Examples:
  $0 auth login
      Interactive login (prompts for URL, user, and token).
  $0 auth login --profile work --url https://jenkins.example.com --user ci --token <token> --non-interactive
      Scripted login.
  $0 build --job "api deploy" --branch main --non-interactive
      Trigger a build by fuzzy job name.
  $0 build --job-url https://jenkins.example.com/job/api/ --branch main --param ENV=staging --non-interactive
      Trigger by exact URL with a custom parameter.
  $0 status --job api --json
      Last build status as a JSON document.
  $0 wait --job api --timeout 30m --json
      Wait for the latest build to finish.
  $0 artifacts --job api --download --dest ./out --non-interactive
      Download the last build's artifacts.
  $0 auth logout --all --non-interactive
      Remove all locally stored credentials.

Job selection (build, status, history, wait, logs, artifacts, cancel, rerun, params):
  --job <text>      Fuzzy match on job name or description (uses the local job cache)
  --job-url <url>   Exact Jenkins job URL (skips the cache and search)
  With neither flag, an interactive job picker opens (requires a TTY).

Scripting and AI agents:
  Pass --non-interactive to disable every prompt and fail fast; --json implies it.
  --json is supported by: list, params, status, history, wait.
  Output lines are prefixed OK: (success), ERROR: (failure), HINT: (guidance).
  Exit code is 0 on success and 1 on any error.
  Run "$0 help --full" to print every command's full option reference at once.
  Note: the --search/--refresh/--json entries in "Options:" above belong to the
  default "list" command, not to every command.

Command-specific options:
  list:
    --search <text>  Search jobs by name or description
    --refresh        Refresh the job cache from Jenkins [default: false]
    --json           Output a single JSON document (implies non-interactive)

  params:
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL
    --json           Output a single JSON document (implies non-interactive)

  build / deploy:
    --job <text>           Job name or description
    --job-url <url>        Full Jenkins job URL
    --branch <name>        Branch name to build
    --branch-param <name>  Parameter name for the branch [default: BRANCH]
    --param KEY=VALUE      Custom build parameter (repeatable)
    --without-params       Trigger without parameters (non-interactive only)
    --watch                Watch build status until completion [default: false]

  status:
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL
    --watch          Watch latest build until completion [default: false]
    --json           Output a single JSON document (implies non-interactive)

  history / builds:
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL
    --offset <n>     Skip N builds before showing the next 5 [default: 0]
    --json           Output a single JSON document (implies non-interactive)

  wait:
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build-url <url> Full Jenkins build URL
    --queue-url <url> Full Jenkins queue item URL
    --interval <dur>  Polling interval (e.g. 30s, 1m) [default: ${DEFAULT_WATCH_INTERVAL_MS / 1000}s]
    --timeout <dur>   Timeout (e.g. 30m, 2h)
    --json            Output a single JSON document (implies non-interactive)

  logs:
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build-url <url> Full Jenkins build URL
    --queue-url <url> Full Jenkins queue item URL
    --follow          Keep streaming logs until build completes [default: true]
    --poll <dur>      Polling interval when following [default: ${DEFAULT_LOG_POLL_MS / 1000}s]

  artifacts:
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build <n>       Target a specific build number (with --job/--job-url)
    --build-url <url> Full Jenkins build URL
    --download        Download artifacts, not just list them [default: false]
    --dest <dir>      Destination directory for downloads [default: cwd]
    --artifact <path> Only this relativePath (repeatable; implies --download)
    --force           Overwrite existing files [default: false]

  run:
    (no command-specific options; interactive picker of running builds)

  cancel:
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build-url <url> Full Jenkins build URL
    --queue-url <url> Full Jenkins queue item URL

  queue:
    --job <text>  Filter queued items to a job name

  nodes:
    --offline-only  Show only offline nodes [default: false]

  rerun:
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL

  auth login / login:
    --url <url>            Jenkins base URL
    --user <name>          Jenkins username
    --token <token>        Jenkins API token
    --profile <name>       Profile name to create or update
    --branch-param <name>  Branch parameter name [default: BRANCH]
    --keychain             Store the token in the OS keychain when available
                           [default: true; use --no-keychain for plaintext]

  auth status:
    --profile <name>  Check a named profile
    --url <url>       Direct Jenkins base URL (use with --user and --token)
    --user <name>     Direct Jenkins username (use with --url and --token)
    --token <token>   Direct Jenkins API token (use with --url and --user)

  auth profile management:
    auth list                    List stored credential profiles
    auth use <name>              Set the default profile
    auth current                 Show resolved credentials (local, no network)
    auth rename <old> <new>      Rename a profile (moves its keychain token)
    auth logout                  Delete the active profile's local credentials
    auth logout --profile <name> Delete a specific profile's local credentials
    auth logout --all            Delete all profiles (logout never revokes the
                                 Jenkins-side API token)

  profile (compatibility):
    list            List configured profiles (same as auth list)
    use <name>      Set default profile (same as auth use)
    delete <name>   Delete a profile (same as auth logout --profile)

  help:
    --full  Print every command's full option reference [default: false]

  global auth overrides (any command):
    --profile <name>  Use a named profile from config
    --url <url>       One-off Jenkins base URL override
    --user <name>     One-off Jenkins username override
    --token <token>   One-off Jenkins API token override
    (--url, --user, and --token must be passed together)

  config/env:
    ${ENV_KEYS.JENKINS_USE_CRUMB} / useCrumb  Enable Jenkins CSRF crumb usage [default: disabled]
    ${ENV_KEYS.JENKINS_POSTHOG_API_KEY}       Enable analytics with a custom PostHog project token
    ${ENV_KEYS.JENKINS_POSTHOG_HOST}          Override the PostHog host
    ${ENV_KEYS.JENKINS_ANALYTICS_DISABLED}    true disables analytics, false enables bundled analytics

  update / upgrade:
    [tag]                  Install a specific version tag (e.g. v0.2.4)
    --check                Check for updates; do not install [default: false]
    --channel <name>       Set update channel (stable or prerelease)
    --enable-auto          Enable daily update checks (notify only)
    --disable-auto         Disable daily update checks
    --enable-auto-install  Enable auto-install of updates
    --disable-auto-install Disable auto-install of updates

Cache directory: ${getJobCacheDir()}
Cache files are separated by Jenkins URL.

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

function configureLoginOptions(yargsInstance: Argv): Argv {
  return yargsInstance
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
      describe: "Jenkins API token",
    })
    .option("branch-param", {
      type: "string",
      describe: "Branch parameter name (default from env/config)",
    })
    .option("profile", {
      type: "string",
      describe: "Profile name to create or update",
    })
    .option("keychain", {
      type: "boolean",
      default: true,
      describe:
        "Store the token in the OS keychain when available (use --no-keychain to force plaintext)",
    });
}

type LoginCommandArgv = {
  _?: unknown;
  $0?: unknown;
  url?: unknown;
  user?: unknown;
  token?: unknown;
  apiToken?: unknown;
  branchParam?: unknown;
  profile?: unknown;
  nonInteractive?: unknown;
  keychain?: unknown;
  banner?: unknown;
};

async function runLoginCommand(
  command: "auth:login" | "login",
  argv: LoginCommandArgv,
): Promise<void> {
  await runTrackedCommand(command, argv, async ({ showIntro }) => {
    showIntro();
    await runLogin({
      url: toOptionalString(argv.url),
      user: toOptionalString(argv.user),
      apiToken: toOptionalString(argv.token) ?? toOptionalString(argv.apiToken),
      branchParam: toOptionalString(argv.branchParam),
      profile: toOptionalString(argv.profile),
      nonInteractive: Boolean(argv.nonInteractive),
      noKeychain: argv.keychain === false,
    });
  });
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

type ContextArgv = {
  profile?: unknown;
  url?: unknown;
  user?: unknown;
  token?: unknown;
  apiToken?: unknown;
  folderDepth?: unknown;
};

type CommandContext = {
  env: ReturnType<typeof loadEnv>;
  client: JenkinsClient;
};

function loadContextEnv(argv?: ContextArgv): ReturnType<typeof loadEnv> {
  const env = loadEnv({
    profile: toOptionalString(argv?.profile),
    url: toOptionalString(argv?.url),
    user: toOptionalString(argv?.user),
    apiToken: toOptionalString(argv?.token) ?? toOptionalString(argv?.apiToken),
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
  // Resolve keychain-backed tokens transparently, replacing the sentinel with
  // the real token for downstream API calls.
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
  // Show the intro using the loaded env before the (possibly slower) keychain
  // read so the banner target still reflects host/profile immediately.
  const env = loadContextEnv(argv);
  showIntro(formatPromptTarget(env));
  const context = await buildContext(env, argv);
  // Offer to migrate a plaintext token into the OS keychain once per profile,
  // strictly on interactive runs. No-op for scripts, pipes, and CI.
  await maybePromptTokenMigration({ env: context.env, interactive });
  return context;
}

async function runTrackedCommand(
  command: string,
  argv:
    { nonInteractive?: unknown; banner?: unknown; json?: unknown } | undefined,
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

type ContextualCommandArgv = ContextArgv & {
  nonInteractive?: unknown;
  banner?: unknown;
  json?: unknown;
};

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

/** Every command whose --help output `help --full` aggregates, in display order. */
const FULL_HELP_COMMANDS: string[][] = [
  [],
  ["auth"],
  ["auth", "login"],
  ["auth", "status"],
  ["auth", "list"],
  ["auth", "use"],
  ["auth", "current"],
  ["auth", "rename"],
  ["auth", "logout"],
  ["login"],
  ["list"],
  ["params"],
  ["build"],
  ["status"],
  ["history"],
  ["wait"],
  ["logs"],
  ["artifacts"],
  ["run"],
  ["cancel"],
  ["queue"],
  ["nodes"],
  ["rerun"],
  ["profile"],
  ["update"],
  ["help"],
];

/**
 * Builds the command line to re-invoke this CLI. A compiled binary exposes its
 * embedded entry through Bun's virtual filesystem (/$bunfs on POSIX, B:\~BUN
 * on Windows) and re-runs itself directly; `bun run src/index.ts` keeps a real
 * script path in argv[1] that must be passed through.
 */
function selfInvocation(args: string[]): string[] {
  const script = process.argv[1];
  const isCompiled =
    !script || script.startsWith("/$bunfs/") || script.includes("~BUN");
  if (isCompiled) {
    return [process.execPath, ...args];
  }
  return [process.execPath, script, ...args];
}

/**
 * Prints the --help output of every command in one document so automation and
 * AI agents can learn the complete CLI surface from a single invocation.
 * Children are spawned concurrently; each `--help` run skips the update
 * prompt/auto-update paths and never touches Jenkins.
 */
async function printFullHelp(): Promise<void> {
  const sections = await Promise.all(
    FULL_HELP_COMMANDS.map(async (commandPath) => {
      const title = [scriptName, ...commandPath, "--help"].join(" ");
      const child = Bun.spawn({
        cmd: selfInvocation([...commandPath, "--help"]),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      const rule = "=".repeat(72);
      return `${rule}\n${title}\n${rule}\n${`${stdout}${stderr}`.trim()}`;
    }),
  );
  console.log(sections.join("\n\n"));
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function hasCredentialOverrides(
  argv:
    | {
        url?: unknown;
        user?: unknown;
        token?: unknown;
        apiToken?: unknown;
      }
    | undefined,
): boolean {
  return (
    typeof argv?.url === "string" ||
    typeof argv?.user === "string" ||
    typeof argv?.token === "string" ||
    typeof argv?.apiToken === "string"
  );
}

export function parseArtifactFilters(value: unknown): string[] | undefined {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const filters = entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return filters.length > 0 ? filters : undefined;
}

export function parseBuildCustomParams(
  value: unknown,
): Record<string, string> | undefined {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  if (entries.length === 0) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new CliError("Invalid --param value.", [
        "Expected each --param entry to be a string in KEY=VALUE format.",
        "Use --param KEY=VALUE (example: --param DEPLOY_ENV=staging).",
      ]);
    }
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      throw new CliError("Invalid --param value.", [
        "Use --param KEY=VALUE (example: --param DEPLOY_ENV=staging).",
      ]);
    }
    const key = entry.slice(0, equalsIndex).trim();
    const paramValue = entry.slice(equalsIndex + 1);
    if (!key) {
      throw new CliError("Invalid --param value.", [
        "Parameter name cannot be empty.",
      ]);
    }
    if (Object.hasOwn(params, key)) {
      throw new CliError(`Duplicate --param key "${key}".`, [
        "Use unique parameter names when passing --param multiple times.",
      ]);
    }
    params[key] = paramValue;
  }

  return params;
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
