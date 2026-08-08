import { extractBranchFromParams, toParamRecord } from "../job-parameters";
import { recordBranchSelection } from "../branches";
import { CliError, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import { recordRecentJob } from "../recent-jobs";
import type {
  BuildStatus,
  JobStatus,
  TriggerBuildResult,
} from "../types/jenkins";

type RerunBuildResult = {
  params: Record<string, string>;
  result: TriggerBuildResult;
  sourceBuildUrl?: string;
  sourceBuildNumber?: number;
};

type RerunSharedOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  jobUrl: string;
  jobLabel: string;
};

export async function rerunLastBuildForJob(
  options: RerunSharedOptions,
): Promise<RerunBuildResult> {
  const status = await options.client.getJobStatus(options.jobUrl);
  if (typeof status.lastBuildNumber !== "number" && !status.lastBuildUrl) {
    throw new CliError(`No previous build found for ${options.jobLabel}.`, [
      "Run a build first, then rerun once a previous build exists.",
    ]);
  }

  return await triggerBuildWithRecordedParams({
    client: options.client,
    env: options.env,
    jobUrl: options.jobUrl,
    status,
    sourceBuildUrl: status.lastBuildUrl,
    sourceBuildNumber: status.lastBuildNumber,
  });
}

export async function rerunLastFailedBuildForJob(
  options: RerunSharedOptions,
): Promise<RerunBuildResult> {
  const lastFailed = await options.client.getLastFailedBuild(options.jobUrl);
  if (!lastFailed) {
    throw new CliError(`No failed build found for ${options.jobLabel}.`, [
      "Run a build first, then rerun once a failed build exists.",
    ]);
  }

  const failedStatus = await options.client.getBuildStatus(lastFailed.buildUrl);
  return await triggerBuildWithRecordedParams({
    client: options.client,
    env: options.env,
    jobUrl: options.jobUrl,
    status: failedStatus,
    sourceBuildUrl: lastFailed.buildUrl,
    sourceBuildNumber: lastFailed.buildNumber,
  });
}

export async function rerunExactBuild(
  options: RerunSharedOptions & {
    buildUrl: string;
    buildNumber: number;
  },
): Promise<RerunBuildResult> {
  const status = await options.client.getBuildStatus(options.buildUrl);
  return await triggerBuildWithRecordedParams({
    client: options.client,
    env: options.env,
    jobUrl: options.jobUrl,
    status,
    sourceBuildUrl: status.buildUrl ?? options.buildUrl,
    sourceBuildNumber: status.buildNumber ?? options.buildNumber,
  });
}

export function printRerunResult(options: {
  jobLabel: string;
  jobUrl?: string;
  source: "last build" | "failed build" | "selected build";
  rerun: RerunBuildResult;
}): void {
  const sourceReference = formatBuildReference(
    options.source,
    options.rerun.sourceBuildNumber,
    options.rerun.sourceBuildUrl,
  );
  printOk(`Rerunning ${options.jobLabel} from ${sourceReference}.`);

  if (options.rerun.result.buildUrl) {
    printOk(`Build started at ${options.rerun.result.buildUrl}.`);
    return;
  }
  if (options.rerun.result.queueUrl) {
    const trackingUrl = options.rerun.result.jobUrl || options.jobUrl;
    if (trackingUrl) {
      printOk(`Build queued for ${options.jobLabel}. Track at ${trackingUrl}.`);
      return;
    }
    printOk(`Build queued for ${options.jobLabel}.`);
    return;
  }
  printOk(`Build triggered for ${options.jobLabel}.`);
}

function formatBuildReference(
  source: "last build" | "failed build" | "selected build",
  buildNumber?: number,
  buildUrl?: string,
): string {
  if (typeof buildNumber === "number") {
    return `${source} #${buildNumber}`;
  }
  if (buildUrl) {
    return `${source} ${buildUrl}`;
  }
  return `the ${source}`;
}

async function triggerBuildWithRecordedParams(options: {
  client: JenkinsClient;
  env: EnvConfig;
  jobUrl: string;
  status: Pick<JobStatus, "parameters"> | Pick<BuildStatus, "parameters">;
  sourceBuildUrl?: string;
  sourceBuildNumber?: number;
}): Promise<RerunBuildResult> {
  const params = toParamRecord(options.status.parameters);
  const result = await options.client.triggerBuild(options.jobUrl, params);

  await recordRecentJob({
    env: options.env,
    jobUrl: options.jobUrl,
  });

  const branch = extractBranchFromParams(params);
  if (branch) {
    try {
      await recordBranchSelection({
        env: options.env,
        jobUrl: options.jobUrl,
        branch,
      });
    } catch {
      // Ignore cache write failures for rerun success.
    }
  }

  return {
    params,
    result,
    sourceBuildUrl: options.sourceBuildUrl,
    sourceBuildNumber: options.sourceBuildNumber,
  };
}
