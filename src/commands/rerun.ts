import { CliError } from "../cli";
import { resolveBuildSelector } from "../build-selector";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import { resolveJobTarget } from "./ops-helpers";
import {
  printRerunResult,
  rerunExactBuild,
  rerunLastBuildForJob,
  rerunLastFailedBuildForJob,
} from "./rerun-core";
import {
  jsonTriggerTarget,
  type JsonRerunReceipt,
  runJsonCommand,
  type JsonWrite,
} from "../json-output";

type RerunOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  build?: number;
  buildUrl?: string;
  nonInteractive: boolean;
  json?: boolean;
  write?: JsonWrite;
};

export async function runRerun(options: RerunOptions): Promise<void> {
  if (options.json) {
    await runJsonCommand(
      "rerun",
      async (): Promise<JsonRerunReceipt> => {
        const target = await resolveBuildSelector({
          client: options.client,
          env: options.env,
          job: options.job,
          jobUrl: options.jobUrl,
          build: options.build,
          buildUrl: options.buildUrl,
          nonInteractive: true,
        });
        if (target.kind === "queue") {
          throw new CliError("Rerun requires a build or job target.");
        }
        const rerun =
          target.kind === "build"
            ? await rerunExactBuild({
                client: options.client,
                env: options.env,
                jobUrl: target.jobUrl,
                jobLabel: target.jobLabel,
                buildUrl: target.buildUrl,
                buildNumber: target.buildNumber,
              })
            : await rerunLastFailedBuildForJob({
                client: options.client,
                env: options.env,
                jobUrl: target.jobUrl,
                jobLabel: target.jobLabel,
              });
        return {
          source: {
            buildUrl: rerun.sourceBuildUrl,
            buildNumber: rerun.sourceBuildNumber,
          },
          target: jsonTriggerTarget(rerun.result),
        };
      },
      { write: options.write },
    );
    return;
  }
  await runRerunInteractive(options);
}

async function runRerunInteractive(options: RerunOptions): Promise<void> {
  const target = await resolveBuildSelector({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    build: options.build,
    buildUrl: options.buildUrl,
    nonInteractive: options.nonInteractive,
  });
  if (target.kind === "queue") {
    throw new CliError("Rerun requires a build or job target.");
  }

  const rerun =
    target.kind === "build"
      ? await rerunExactBuild({
          client: options.client,
          env: options.env,
          jobUrl: target.jobUrl,
          jobLabel: target.jobLabel,
          buildUrl: target.buildUrl,
          buildNumber: target.buildNumber,
        })
      : await rerunLastFailedBuildForJob({
          client: options.client,
          env: options.env,
          jobUrl: target.jobUrl,
          jobLabel: target.jobLabel,
        });
  printRerunResult({
    jobLabel: target.jobLabel,
    jobUrl: target.jobUrl,
    source: target.kind === "build" ? "selected build" : "failed build",
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
