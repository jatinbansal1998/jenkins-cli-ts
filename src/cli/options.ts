import type { Argv, Options } from "yargs";
import parseArgs from "yargs-parser";
import { CliError, setQuietMode } from "../cli";

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
  quiet: {
    type: "boolean",
    default: false,
    describe:
      "Print nothing except errors; read the result from the exit code (implies non-interactive)",
  },
  color: {
    type: "boolean",
    default: true,
    describe:
      "Color output on a terminal; --no-color turns it off (NO_COLOR and FORCE_COLOR are honored)",
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
  timeout: {
    type: "string",
    requiresArg: true,
    describe:
      "Per-request HTTP timeout, e.g. 30s or 2m; a bare number is ms (default: 10s, or JENKINS_TIMEOUT_MS / profile timeoutMs)",
  },
  retries: {
    type: "string",
    requiresArg: true,
    describe:
      "Transport retries for idempotent requests (default: 1, or JENKINS_RETRIES / profile retries); build triggers, creates, and input submits never retry",
  },
  "confirm-protected": {
    type: "boolean",
    describe:
      "Allow builds, cancels, reruns, and input approvals on a read-only profile for this run",
  },
} satisfies Record<string, Options>;

/** Lets a bare parse tell `--quiet update` apart from `--profile update`. */
export const GLOBAL_BOOLEAN_OPTIONS = Object.entries(GLOBAL_OPTIONS)
  .filter(([, option]) => option.type === "boolean")
  .map(([name]) => name);

type OutputFlags = {
  [flag: string]: unknown;
  quiet?: unknown;
  color?: unknown;
  json?: unknown;
  jsonl?: unknown;
};

export function validateOutputOptions(flags: OutputFlags): void {
  if (flags.quiet === true && (flags.json === true || flags.jsonl === true)) {
    throw new CliError(
      "--quiet cannot be combined with --json or --jsonl.",
      ["Drop --quiet; structured output already keeps stdout parseable."],
      "INVALID_USAGE",
    );
  }
}

/** Applies --quiet and --no-color for the rest of the process. */
export function applyOutputOptions(flags: OutputFlags): void {
  setQuietMode(flags.quiet === true);
  if (flags.color === false) {
    process.env.NO_COLOR = "1";
    // Bun ignores NO_COLOR, with a warning, while FORCE_COLOR is set.
    delete process.env.FORCE_COLOR;
  }
}

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
          "INVALID_USAGE",
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
    type: "string",
    describe:
      "Target a build number or lastSuccessful, lastStable, lastFailed, lastCompleted (with --job/--job-url)",
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
  return isBooleanOptionEnabled(rawArgs, "json");
}

export function isJsonLinesOutputRequested(rawArgs: string[]): boolean {
  return isBooleanOptionEnabled(rawArgs, "jsonl");
}

export function isQuietRequested(rawArgs: string[]): boolean {
  return isBooleanOptionEnabled(rawArgs, "quiet");
}

/** Parsed, not token-matched, so `--json=true` and a later `--no-json` count. */
function isBooleanOptionEnabled(rawArgs: string[], name: string): boolean {
  return parseArgs(rawArgs, { boolean: [name] })[name] === true;
}
