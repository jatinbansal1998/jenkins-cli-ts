/**
 * Config command implementation.
 * Prints a job or folder's raw config.xml. Read-only.
 */
import { CliError } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import { resolveJobTarget } from "./ops-helpers";

type JobConfigOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
};

export async function runJobConfig(options: JobConfigOptions): Promise<void> {
  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }
  const target = await resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: options.nonInteractive,
  });
  const xml = await options.client.getJobConfigXml(target.jobUrl);
  process.stdout.write(xml.endsWith("\n") ? xml : `${xml}\n`);
}
