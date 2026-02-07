import { confirm, isCancel } from "@clack/prompts";
import { CliError, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import type { QueueItemSummary } from "../types/jenkins";
import { ensureValidUrl, resolveJobTarget } from "./ops-helpers";

type CancelOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  buildUrl?: string;
  queueUrl?: string;
  nonInteractive: boolean;
};

type CancelTarget =
  | { kind: "build"; buildUrl: string; label: string }
  | { kind: "queue"; queueUrl: string; label: string };

export async function runCancel(options: CancelOptions): Promise<void> {
  validateCancelOptions(options);
  const target = await resolveCancelTarget(options);

  if (!options.nonInteractive) {
    const response = await confirm({
      message: `Cancel ${target.label}?`,
      initialValue: true,
    });
    if (isCancel(response)) {
      throw new CliError("Operation cancelled.");
    }
    if (!response) {
      printOk("Cancel skipped.");
      return;
    }
  }

  if (target.kind === "build") {
    await options.client.stopBuild(target.buildUrl);
    printOk(`Cancelled build: ${target.buildUrl}`);
    return;
  }

  const cancelled = await options.client.cancelQueueItem(target.queueUrl);
  if (!cancelled) {
    throw new CliError("Queue item not found.", [
      "The queue item may have already started or finished.",
    ]);
  }
  printOk(`Cancelled queue item: ${target.queueUrl}`);
}

function validateCancelOptions(options: CancelOptions): void {
  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }
  if (options.buildUrl && options.queueUrl) {
    throw new CliError("Provide either --build-url or --queue-url, not both.", [
      "Use a single cancel target at a time.",
    ]);
  }
  if (options.buildUrl && (options.job || options.jobUrl)) {
    throw new CliError(
      "When --build-url is provided, do not pass --job or --job-url.",
      ["Use a single cancel target at a time."],
    );
  }
  if (options.queueUrl && (options.job || options.jobUrl)) {
    throw new CliError(
      "When --queue-url is provided, do not pass --job or --job-url.",
      ["Use a single cancel target at a time."],
    );
  }
}

async function resolveCancelTarget(
  options: CancelOptions,
): Promise<CancelTarget> {
  const buildUrl = options.buildUrl?.trim() ?? "";
  if (buildUrl) {
    ensureValidUrl(buildUrl, "build-url");
    return {
      kind: "build",
      buildUrl,
      label: `build ${buildUrl}`,
    };
  }

  const queueUrl = options.queueUrl?.trim() ?? "";
  if (queueUrl) {
    ensureValidUrl(queueUrl, "queue-url");
    return {
      kind: "queue",
      queueUrl,
      label: `queue item ${queueUrl}`,
    };
  }

  const target = await resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: options.nonInteractive,
  });
  const jobStatus = await options.client.getJobStatus(target.jobUrl);
  if (jobStatus.building && jobStatus.lastBuildUrl) {
    return {
      kind: "build",
      buildUrl: jobStatus.lastBuildUrl,
      label: `running build for ${target.jobLabel}`,
    };
  }

  const queueItems = await options.client.listQueueItems();
  const queueItem = findQueueItemForJob(queueItems, target.jobUrl);
  if (queueItem) {
    return {
      kind: "queue",
      queueUrl: queueItem.queueUrl,
      label: `queued build for ${target.jobLabel}`,
    };
  }

  throw new CliError(
    `No running or queued build found for ${target.jobLabel}.`,
    ["Trigger a build first, then try cancelling again."],
  );
}

function findQueueItemForJob(
  queueItems: QueueItemSummary[],
  jobUrl: string,
): QueueItemSummary | undefined {
  const normalized = jobUrl.toLowerCase();
  const matches = queueItems.filter(
    (item) => item.jobUrl && item.jobUrl.toLowerCase() === normalized,
  );
  if (matches.length === 0) {
    return undefined;
  }
  matches.sort((a, b) => {
    const aTs = a.inQueueSince ?? 0;
    const bTs = b.inQueueSince ?? 0;
    return bTs - aTs;
  });
  return matches[0];
}
