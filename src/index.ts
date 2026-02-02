#!/usr/bin/env bun
/**
 * CLI entry point for jenkins-cli.
 * Registers commands (list, build, status) and handles argument parsing via yargs.
 */
import path from "node:path";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { CliError, handleCliError } from "./cli";
import { runBuild } from "./commands/build";
import { runLogin } from "./commands/login";
import { runList } from "./commands/list";
import { runStatus } from "./commands/status";
import { loadEnv, getDebugDefault } from "./env";
import { JenkinsClient } from "./jenkins/client";
import { getJobCachePath } from "./jobs";
import { setDebugMode } from "./logger";
import packageJson from "../package.json";

const VERSION = packageJson.version;

const DEFAULT_SCRIPT_NAME = "jenkins-cli";
const rawScriptName = process.argv[1]
  ? path.basename(process.argv[1])
  : DEFAULT_SCRIPT_NAME;
const scriptName =
  rawScriptName === "index.ts" ? DEFAULT_SCRIPT_NAME : rawScriptName;

async function main(): Promise<void> {
  const parser = yargs(hideBin(process.argv))
    .scriptName(scriptName)
    .usage("Usage: $0 <command> [options]")
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
      const rawArgs = hideBin(process.argv);
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
          .option("default-branch", {
            type: "boolean",
            default: false,
            describe: "Use the job's default branch",
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
        await runBuild({
          client,
          env,
          job: typeof argv.job === "string" ? argv.job : undefined,
          jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
          branch: typeof argv.branch === "string" ? argv.branch : undefined,
          branchParam: branchParamExplicitlyPassed
            ? typeof argv.branchParam === "string"
              ? argv.branchParam
              : undefined
            : env.branchParamDefault,
          defaultBranch: Boolean(argv.defaultBranch),
          nonInteractive: Boolean(argv.nonInteractive),
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
          }),
      async (argv) => {
        const { env, client } = createContext();
        await runStatus({
          client,
          env,
          job: typeof argv.job === "string" ? argv.job : undefined,
          jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
          nonInteractive: Boolean(argv.nonInteractive),
        });
      },
    )
    .version("version", `Show version (${VERSION})`, VERSION)
    .alias("version", "v")
    .demandCommand(1, "Missing command. Use --help to see usage.")
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
    --default-branch  Use the job's default branch

  status:
    --job      Job name or description
    --job-url  Full Jenkins job URL

  login:
    --url           Jenkins base URL
    --user          Jenkins username
    --token         Jenkins API token
    --branch-param  Branch parameter name

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

function createContext(): {
  env: ReturnType<typeof loadEnv>;
  client: JenkinsClient;
} {
  const env = loadEnv();
  const client = new JenkinsClient({
    baseUrl: env.jenkinsUrl,
    user: env.jenkinsUser,
    apiToken: env.jenkinsApiToken,
  });
  return { env, client };
}

main().catch((error) => {
  handleCliError(error);
  process.exitCode = 1;
});
