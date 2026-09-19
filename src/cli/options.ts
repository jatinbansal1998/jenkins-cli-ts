import type { Argv, Options } from "yargs";
import { CliError } from "../cli";

export const GLOBAL_OPTIONS = {
  "non-interactive": {
    type: "boolean",
    default: false,
    describe: "Disable prompts and fail fast",
  },
  banner: {
    type: "boolean",
    default: false,
    describe: "Show the interactive ASCII intro banner",
  },
  json: {
    type: "boolean",
    default: false,
    describe: "Output structured JSON when supported (implies non-interactive)",
  },
  debug: {
    type: "boolean",
    describe:
      "Log API requests and responses to api-<date>.log (kept for 7 days)",
  },
  profile: {
    type: "string",
    describe: "Use credentials from a named profile in config",
  },
  url: {
    type: "string",
    describe: "One-off Jenkins base URL override for this command",
  },
  user: {
    type: "string",
    describe: "One-off Jenkins username override for this command",
  },
  token: {
    type: "string",
    alias: "api-token",
    describe: "One-off Jenkins API token override for this command",
  },
  "folder-depth": {
    type: "number",
    describe:
      "Folder traversal depth for job discovery (default: 3, from config)",
  },
  "confirm-protected": {
    type: "boolean",
    describe:
      "Allow builds, cancels, reruns, and input approvals on a read-only profile for this run",
  },
} satisfies Record<string, Options>;

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

export function addBuildOption(yargsInstance: Argv): Argv {
  return yargsInstance.option("build", {
    type: "number",
    describe: "Target a specific build number (with --job/--job-url)",
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

export function addJsonLinesOption(yargsInstance: Argv): Argv {
  return yargsInstance.option("jsonl", {
    type: "boolean",
    default: false,
    describe:
      "Stream one compact JSON event per line (implies non-interactive)",
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

export function isJsonOutputRequested(rawArgs: string[]): boolean {
  return isBooleanOptionEnabled(rawArgs, "--json");
}

export function isJsonLinesOutputRequested(rawArgs: string[]): boolean {
  return isBooleanOptionEnabled(rawArgs, "--jsonl");
}

function isBooleanOptionEnabled(
  rawArgs: string[],
  optionName: string,
): boolean {
  return rawArgs.some(
    (arg) => arg === optionName || arg === `${optionName}=true`,
  );
}
