import { CliError, printOk } from "../cli";
import { recordBranchSelection } from "../branches";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import { recordRecentJob } from "../recent-jobs";
import { resolveJobTarget } from "./ops-helpers";

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

  const lastFailed = await options.client.getLastFailedBuild(target.jobUrl);
  if (!lastFailed) {
    throw new CliError(`No failed build found for ${target.jobLabel}.`, [
      "Run a build first, then rerun once a failed build exists.",
    ]);
  }

  const failedStatus = await options.client.getBuildStatus(lastFailed.buildUrl);
  const params = toParamRecord(failedStatus.parameters);
  const result = await options.client.triggerBuild(target.jobUrl, params);

  try {
    await recordRecentJob({
      env: options.env,
      jobUrl: target.jobUrl,
    });
  } catch {
    // Ignore cache write failures for rerun success.
  }

  const branchParam = failedStatus.parameters?.find((entry) =>
    entry.name.toLowerCase().includes("branch"),
  );
  if (branchParam?.value) {
    try {
      await recordBranchSelection({
        env: options.env,
        jobUrl: target.jobUrl,
        branch: branchParam.value,
      });
    } catch {
      // Ignore cache write failures for rerun success.
    }
  }

  const lastFailedNumber =
    typeof lastFailed.buildNumber === "number"
      ? `#${lastFailed.buildNumber}`
      : lastFailed.buildUrl;
  printOk(
    `Rerunning ${target.jobLabel} from failed build ${lastFailedNumber}.`,
  );

  if (result.buildUrl) {
    printOk(`Build started at ${result.buildUrl}.`);
    return;
  }
  if (result.queueUrl) {
    const trackingUrl = result.jobUrl || target.jobUrl;
    printOk(`Build queued for ${target.jobLabel}. Track at ${trackingUrl}.`);
    return;
  }
  printOk(`Build triggered for ${target.jobLabel}.`);
}

function toParamRecord(
  params: { name: string; value: string }[] | undefined,
): Record<string, string> {
  if (!params || params.length === 0) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const param of params) {
    const key = param.name.trim();
    if (!key) {
      continue;
    }
    result[key] = param.value;
  }
  return result;
}
