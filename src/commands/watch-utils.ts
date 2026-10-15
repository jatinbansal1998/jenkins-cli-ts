import { CliError } from "../cli";
import { parseDurationMs } from "../duration";
import { assertProtectedMutationAllowed, type EnvConfig } from "../env";
import { areSameJobUrls, normalizeOptionalJobUrl } from "../job-url";
import type { JenkinsClient } from "../jenkins/client";
import type { LastBuildSummary, QueueItemSummary } from "../types/jenkins";

const DEFAULT_WATCH_INTERVAL_MS = 5_000;
const WATCH_INTERVAL_RAMP_STEP_MS = 1_000;
export const WATCH_INTERVAL_DEFAULT_LABEL = `${WATCH_INTERVAL_RAMP_STEP_MS / 1000}s rising to ${DEFAULT_WATCH_INTERVAL_MS / 1000}s`;
export const WATCH_INTERVAL_DESCRIPTION = `Polling interval (e.g. 2s, 1m) [default: ${WATCH_INTERVAL_DEFAULT_LABEL}]`;

/**
 * Delay before the next watch poll. An explicit interval is used as is.
 * Otherwise polls start at 1s and grow by 1s up to the default, so a short
 * build reports as soon as it finishes while a long one costs no extra load.
 */
export function nextWatchPollMs(
  completedPolls: number,
  intervalMs: number | undefined,
): number {
  return (
    intervalMs ??
    Math.min(
      DEFAULT_WATCH_INTERVAL_MS,
      (completedPolls + 1) * WATCH_INTERVAL_RAMP_STEP_MS,
    )
  );
}

export function parseWatchIntervalMs(
  value: string | undefined,
): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const intervalMs = parseDurationMs(value, "--interval");
  if (intervalMs <= 0) {
    throw new CliError(
      "Invalid --interval value.",
      ["Use an interval greater than 0ms (e.g. --interval 5s)."],
      "INVALID_USAGE",
    );
  }
  return intervalMs;
}

/**
 * The job's newest build, if it is the one a watch is waiting for: any build
 * other than the one seen before the trigger, or that same build while it is
 * still running.
 */
export async function findWatchedBuild(
  client: JenkinsClient,
  jobUrl: string,
  baselineBuildNumber: number | undefined,
): Promise<LastBuildSummary | null> {
  const lastBuild = await client.getLastBuild(jobUrl);
  if (!lastBuild) {
    return null;
  }
  const isWatched =
    baselineBuildNumber === undefined ||
    lastBuild.buildNumber !== baselineBuildNumber ||
    lastBuild.building;
  return isWatched ? lastBuild : null;
}

export async function waitForPollIntervalOrCancel(
  intervalMs: number,
  cancelSignal?: { wait: Promise<void> } | null,
): Promise<void> {
  if (!cancelSignal) {
    await Bun.sleep(intervalMs);
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, intervalMs);
  });

  try {
    await Promise.race([timeoutPromise, cancelSignal.wait]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

type WatchControlAction = "stop" | "cancel";

type WatchControlSignal = {
  getAction: () => WatchControlAction | null;
  clearAction: () => void;
  readonly wait: Promise<void>;
  cleanup: () => void;
};

export function createWatchControlSignal(): WatchControlSignal | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }

  let action: WatchControlAction | null = null;
  let resolveWait: (() => void) | null = null;
  let waitPromise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;

  const setAction = (nextAction: WatchControlAction) => {
    if (action) {
      return;
    }
    action = nextAction;
    resolveWait?.();
  };

  const onData = (data: Buffer | string) => {
    const value = data.toString();
    if (value.includes("\u001b")) {
      setAction("stop");
      return;
    }
    if (value.toLowerCase().includes("c")) {
      setAction("cancel");
    }
  };

  try {
    stdin.setRawMode(true);
  } catch {
    // Ignore raw mode failures.
  }
  stdin.on("data", onData);
  stdin.resume();

  return {
    getAction: () => action,
    clearAction: () => {
      action = null;
      waitPromise = new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    },
    get wait() {
      return waitPromise;
    },
    cleanup: () => {
      stdin.off("data", onData);
      if (stdin.isTTY) {
        try {
          stdin.setRawMode(Boolean(wasRaw));
        } catch {
          // Ignore cleanup failures.
        }
      }
      stdin.pause();
    },
  };
}

export async function requestCancellationForWatchTarget(options: {
  client: JenkinsClient;
  env: EnvConfig;
  jobUrl?: string;
  buildUrl?: string;
  queueUrl?: string;
}): Promise<
  | {
      kind: "build";
      buildUrl: string;
      buildNumber?: number;
      message: string;
    }
  | {
      kind: "queue";
      queueUrl: string;
      message: string;
    }
> {
  // Watching itself reads only, but the in-watch cancel key writes to Jenkins.
  assertProtectedMutationAllowed(options.env);
  const buildUrl = options.buildUrl?.trim() ?? "";
  if (buildUrl) {
    await options.client.stopBuild(buildUrl);
    return {
      kind: "build",
      buildUrl,
      message: `Cancellation requested for build: ${buildUrl}`,
    };
  }

  const queueUrl = options.queueUrl?.trim() ?? "";
  if (queueUrl) {
    const cancelled = await options.client.cancelQueueItem(queueUrl);
    if (cancelled) {
      return {
        kind: "queue",
        queueUrl,
        message: `Cancelled queue item: ${queueUrl}`,
      };
    }
  }

  const jobUrl = normalizeOptionalJobUrl(options.jobUrl);
  if (jobUrl) {
    const lastBuild = await options.client.getLastBuild(jobUrl);
    if (lastBuild?.building) {
      await options.client.stopBuild(lastBuild.buildUrl);
      return {
        kind: "build",
        buildUrl: lastBuild.buildUrl,
        buildNumber: lastBuild.buildNumber,
        message: `Cancellation requested for build: ${lastBuild.buildUrl}`,
      };
    }

    const queueItems = await options.client.listQueueItems();
    const queueItem = findQueueItemForJob(queueItems, jobUrl);
    if (queueItem) {
      const cancelled = await options.client.cancelQueueItem(
        queueItem.queueUrl,
      );
      if (cancelled) {
        return {
          kind: "queue",
          queueUrl: queueItem.queueUrl,
          message: `Cancelled queue item: ${queueItem.queueUrl}`,
        };
      }
    }
  }

  throw new CliError(
    "No running or queued build found for the current watch.",
    ["The build may have already completed."],
    "NO_ACTIVE_BUILD",
  );
}

export function findQueueItemForJob(
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
