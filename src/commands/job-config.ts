/**
 * Config command implementation.
 * Prints a job or folder's raw config.xml, or replaces it with --apply.
 * Applying is blocked on read-only profiles like other Jenkins writes.
 */
import { CliError, printOk, writeStdout } from "../cli";
import { assertProtectedMutationAllowed, type EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import { type JsonWrite, runJsonCommand } from "../json-output";
import { resolveJobTarget } from "./ops-helpers";

type JobConfigOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  /** Path to the config.xml to post back; `-` reads stdin. */
  apply?: string;
  nonInteractive: boolean;
  json?: boolean;
  write?: JsonWrite;
};

export async function runJobConfig(options: JobConfigOptions): Promise<void> {
  if (options.job && options.jobUrl) {
    throw new CliError(
      "Provide either --job or --job-url, not both.",
      ["Remove one of the flags and try again."],
      "INVALID_USAGE",
    );
  }
  if (options.apply === undefined) {
    if (options.json) {
      throw new CliError(
        "config prints raw XML; --json only works with --apply.",
        ["Drop --json to print the config, or pass --apply <file>."],
        "INVALID_USAGE",
      );
    }
    const target = await resolveTarget(options);
    const xml = await options.client.getJobConfigXml(target.jobUrl);
    writeStdout(xml.endsWith("\n") ? xml : `${xml}\n`);
    return;
  }
  const path = options.apply;
  if (options.json) {
    await runJsonCommand(
      "config",
      async () => await applyConfig(options, path),
      { write: options.write },
    );
    return;
  }
  const applied = await applyConfig(options, path);
  printOk(`Updated config of ${applied.url}`);
}

async function applyConfig(
  options: JobConfigOptions,
  path: string,
): Promise<{ url: string }> {
  assertProtectedMutationAllowed(options.env);
  // Read the file before contacting Jenkins so a typo fails fast.
  const configXml = await readConfigXml(path, "--apply");
  const target = await resolveTarget(options);
  await options.client.updateJobConfigXml(target.jobUrl, configXml);
  return { url: target.jobUrl };
}

async function resolveTarget(
  options: JobConfigOptions,
): Promise<{ jobUrl: string }> {
  return await resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: options.nonInteractive,
  });
}

/** Reads a config.xml from a file, or from stdin when `path` is `-`. */
export async function readConfigXml(
  path: string,
  flag: string,
): Promise<string> {
  const fromStdin = path === "-";
  let configXml: string;
  try {
    configXml = fromStdin
      ? await Bun.stdin.text()
      : await Bun.file(path).text();
  } catch (error) {
    throw new CliError(
      `Cannot read config file ${path}.`,
      [
        error instanceof Error ? error.message : String(error),
        `Pass ${flag} with a readable config.xml path, or - for stdin.`,
      ],
      "INVALID_USAGE",
    );
  }
  if (!configXml.trim()) {
    throw new CliError(
      `Config ${fromStdin ? "from stdin" : `file ${path}`} is empty.`,
      [],
      "INVALID_USAGE",
    );
  }
  return configXml;
}
