import type { Argv } from "yargs";
import { CliError } from "../cli";

export function addJobOptions(yargsInstance: Argv): Argv {
  return yargsInstance
    .positional("job-name", {
      type: "string",
      describe: "Job name or description",
    })
    .option("job", {
      type: "string",
      describe: "Job name or description",
    })
    .option("job-url", {
      type: "string",
      describe: "Full Jenkins job URL",
    })
    .middleware((argv) => {
      const positionalJob =
        optionalString(argv.jobName) ?? optionalString(argv["job-name"]);
      const optionJob = optionalString(argv.job);

      if (positionalJob && optionJob && positionalJob !== optionJob) {
        throw new CliError(
          `Positional job "${positionalJob}" conflicts with --job "${optionJob}".`,
          ["Pass the job once, or use the same value for both forms."],
        );
      }

      if (positionalJob) {
        argv.job = positionalJob;
      }
    });
}

export function addBuildUrlOption(yargsInstance: Argv): Argv {
  return yargsInstance.option("build-url", {
    type: "string",
    describe: "Full Jenkins build URL",
  });
}

export function addQueueUrlOption(yargsInstance: Argv): Argv {
  return yargsInstance.option("queue-url", {
    type: "string",
    describe: "Full Jenkins queue item URL",
  });
}

export function addJsonOption(yargsInstance: Argv): Argv {
  return yargsInstance.option("json", {
    type: "boolean",
    default: false,
    describe: "Output a single JSON document (implies non-interactive)",
  });
}

export function addWatchOption(yargsInstance: Argv, describe: string): Argv {
  return yargsInstance.option("watch", {
    type: "boolean",
    default: false,
    describe,
  });
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function wasBranchParamExplicitlyPassed(rawArgs: string[]): boolean {
  return rawArgs.some(
    (arg) =>
      arg === "--branch-param" ||
      arg.startsWith("--branch-param=") ||
      arg === "--branchParam" ||
      arg.startsWith("--branchParam="),
  );
}

export function wasWatchExplicitlyPassed(rawArgs: string[]): boolean {
  return rawArgs.some(
    (arg) =>
      arg === "--watch" ||
      arg === "--no-watch" ||
      arg.startsWith("--watch=") ||
      arg.startsWith("--no-watch="),
  );
}
