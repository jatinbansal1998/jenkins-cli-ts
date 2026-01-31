#!/usr/bin/env bun
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { CliError, handleCliError } from "./cli";
import { runBuild } from "./commands/build";
import { runList } from "./commands/list";
import { runStatus } from "./commands/status";
import { loadEnv } from "./env";
import { JenkinsClient } from "./jenkins/client";

async function main(): Promise<void> {
  const parser = yargs(hideBin(process.argv))
    .scriptName("jenkins-cli")
    .usage("Usage: $0 <command> [options]")
    .option("non-interactive", {
      type: "boolean",
      default: false,
      describe: "Disable prompts and fail fast",
    })
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
      "build",
      "Trigger a Jenkins build",
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
        await runBuild({
          client,
          env,
          job: typeof argv.job === "string" ? argv.job : undefined,
          jobUrl: typeof argv.jobUrl === "string" ? argv.jobUrl : undefined,
          branch: typeof argv.branch === "string" ? argv.branch : undefined,
          branchParam:
            typeof argv.branchParam === "string" ? argv.branchParam : undefined,
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
    .demandCommand(1, "Missing command. Use --help to see usage.")
    .strict()
    .help()
    .fail((message, error) => {
      if (error) {
        throw error;
      }
      throw new CliError(message, ["Run with --help to see usage."]);
    });

  await parser.parseAsync();
}

function createContext(): { env: ReturnType<typeof loadEnv>; client: JenkinsClient } {
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
