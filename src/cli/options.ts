import type { Argv } from "yargs";

export function addJobOptions(yargsInstance: Argv): Argv {
  return yargsInstance
    .option("job", {
      type: "string",
      describe: "Job name or description",
    })
    .option("job-url", {
      type: "string",
      describe: "Full Jenkins job URL",
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
