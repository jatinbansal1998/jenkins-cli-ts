import { CliError } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import { resolveJobTarget } from "./ops-helpers";
import {
  printRerunResult,
  rerunLastBuildForJob,
  rerunLastFailedBuildForJob,
} from "./rerun-core";

type RerunOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
};

export async function runRerun(options: RerunOptions): Promise<void> {
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

  const rerun = await rerunLastFailedBuildForJob({
    client: options.client,
    env: options.env,
    jobUrl: target.jobUrl,
    jobLabel: target.jobLabel,
  });
  printRerunResult({
    jobLabel: target.jobLabel,
    jobUrl: target.jobUrl,
    source: "failed build",
    rerun,
  });
}

export async function runRerunLastBuild(options: RerunOptions): Promise<void> {
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

  const rerun = await rerunLastBuildForJob({
    client: options.client,
    env: options.env,
    jobUrl: target.jobUrl,
    jobLabel: target.jobLabel,
  });
  printRerunResult({
    jobLabel: target.jobLabel,
    jobUrl: target.jobUrl,
    source: "last build",
    rerun,
  });
}
