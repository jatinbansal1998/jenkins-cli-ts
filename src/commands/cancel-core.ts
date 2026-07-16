import { CliError, printError, printHint, printOk } from "../cli";
import type { EnvConfig } from "../env";
import { areSameJobUrls } from "../job-url";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import type { QueueItemSummary, RunningBuildSummary } from "../types/jenkins";
import { ensureValidUrl } from "./ops-helpers";
import { cancelDeps } from "./cancel-deps";
import { DEFAULT_WATCH_INTERVAL_MS } from "./watch-utils";

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

const MULTIPLE_VALUE = "__jenkins_cli_cancel_multiple__";
const ALL_VALUE = "__jenkins_cli_cancel_all__";
const SEARCH_VALUE = "__jenkins_cli_cancel_search__";

let activeCancelDeps = cancelDeps;

export function setCancelDepsForTesting(overrides?: typeof cancelDeps): void {
  activeCancelDeps = overrides ?? cancelDeps;
}

export async function runCancel(options: CancelOptions): Promise<void> {
  validateCancelOptions(options);
  const targets = await resolveCancelTargets(options);

  if (targets.length > 1) {
    await cancelBuildBatch(options, targets);
    return;
  }

  const target = targets[0];
  if (!target) {
    throw new CliError("No cancellation target selected.");
  }

  if (!options.nonInteractive) {
    const response = await activeCancelDeps.confirm({
      message: `Cancel ${target.label}?`,
      initialValue: true,
    });
    if (activeCancelDeps.isCancel(response)) {
      throw new CliError("Operation cancelled.");
    }
    if (!response) {
      printOk("Cancel skipped.");
      return;
    }
  }

  if (target.kind === "build") {
    await options.client.stopBuild(target.buildUrl);
    printOk(`Cancellation requested for build: ${target.buildUrl}`);
    await activeCancelDeps.waitForBuild({
      client: options.client,
      jobLabel: target.label,
      buildUrl: target.buildUrl,
      intervalMs: DEFAULT_WATCH_INTERVAL_MS,
      nonInteractive: options.nonInteractive,
    });
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

async function resolveCancelTargets(
  options: CancelOptions,
): Promise<CancelTarget[]> {
  if (options.nonInteractive || hasExplicitCancelTarget(options)) {
    return [await resolveCancelTarget(options)];
  }

  let runningBuilds: RunningBuildSummary[];
  try {
    runningBuilds = await options.client.listRunningBuilds();
  } catch {
    printHint("Could not load running builds; searching all jobs instead.");
    return [await resolveCancelTarget(options)];
  }

  if (runningBuilds.length === 0) {
    return [await resolveCancelTarget(options)];
  }

  while (true) {
    const selection = await activeCancelDeps.select({
      message: "Select a running build to cancel",
      options: [
        ...runningBuilds.map((build) => ({
          value: build.buildUrl,
          label: formatRunningBuildLabel(build),
        })),
        { value: MULTIPLE_VALUE, label: "Select multiple running builds" },
        { value: ALL_VALUE, label: "Select all running builds" },
        { value: SEARCH_VALUE, label: "Search all jobs" },
      ],
    });
    if (activeCancelDeps.isCancel(selection)) {
      throw new CliError("Operation cancelled.");
    }
    if (selection === SEARCH_VALUE) {
      return [await resolveCancelTarget(options)];
    }
    if (selection === ALL_VALUE) {
      return runningBuilds.map(toCancelTarget);
    }
    if (selection === MULTIPLE_VALUE) {
      const selected = await activeCancelDeps.multiselect({
        message: "Select running builds to cancel",
        required: false,
        options: runningBuilds.map((build) => ({
          value: build.buildUrl,
          label: formatRunningBuildLabel(build),
        })),
      });
      if (activeCancelDeps.isCancel(selected)) {
        continue;
      }
      const selectedUrls = Array.isArray(selected)
        ? new Set(selected.map(String))
        : new Set<string>();
      const selectedBuilds = runningBuilds.filter((build) =>
        selectedUrls.has(build.buildUrl),
      );
      if (selectedBuilds.length === 0) {
        continue;
      }
      return selectedBuilds.map(toCancelTarget);
    }

    const selectedBuild = runningBuilds.find(
      (build) => build.buildUrl === selection,
    );
    if (selectedBuild) {
      return [toCancelTarget(selectedBuild)];
    }
  }
}

async function cancelBuildBatch(
  options: CancelOptions,
  targets: CancelTarget[],
): Promise<void> {
  const builds = targets.filter(
    (target): target is Extract<CancelTarget, { kind: "build" }> =>
      target.kind === "build",
  );
  const response = await activeCancelDeps.confirm({
    message: `Cancel ${builds.length} running builds?`,
    initialValue: true,
  });
  if (activeCancelDeps.isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  if (!response) {
    printOk("Cancel skipped.");
    return;
  }

  const requested: typeof builds = [];
  let failed = 0;
  for (const build of builds) {
    try {
      await options.client.stopBuild(build.buildUrl);
      printOk(`Cancellation requested for build: ${build.buildUrl}`);
      requested.push(build);
    } catch (error) {
      failed++;
      printError(`Failed to cancel ${build.label}: ${errorMessage(error)}`);
    }
  }

  let succeeded = 0;
  for (const build of requested) {
    try {
      await activeCancelDeps.waitForBuild({
        client: options.client,
        jobLabel: build.label,
        buildUrl: build.buildUrl,
        intervalMs: DEFAULT_WATCH_INTERVAL_MS,
        nonInteractive: options.nonInteractive,
      });
      succeeded++;
    } catch (error) {
      failed++;
      printError(
        `Failed while waiting for ${build.label}: ${errorMessage(error)}`,
      );
    }
  }

  printOk(`Cancellation summary: ${succeeded} succeeded, ${failed} failed.`);
  if (failed > 0) {
    throw new CliError("One or more running builds could not be cancelled.");
  }
}

function hasExplicitCancelTarget(options: CancelOptions): boolean {
  return Boolean(
    options.job?.trim() ||
    options.jobUrl?.trim() ||
    options.buildUrl?.trim() ||
    options.queueUrl?.trim(),
  );
}

function toCancelTarget(build: RunningBuildSummary): CancelTarget {
  return {
    kind: "build",
    buildUrl: build.buildUrl,
    label: `running build for ${formatRunningBuildLabel(build)}`,
  };
}

function formatRunningBuildLabel(build: RunningBuildSummary): string {
  return `${build.fullJobName?.trim() || build.jobName} #${build.buildNumber}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
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

  const target = await activeCancelDeps.resolveJobTarget({
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
  const matches = queueItems.filter((item) =>
    areSameJobUrls(item.jobUrl, jobUrl),
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
