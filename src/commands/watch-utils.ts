import { CliError } from "../cli";
import { parseDurationMs } from "../duration";
import { assertProtectedMutationAllowed, type EnvConfig } from "../env";
import { areSameJobUrls, normalizeOptionalJobUrl } from "../job-url";
import { isJenkinsUnavailable, type JenkinsClient } from "../jenkins/client";
import { formatDuration } from "../status-format";
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

/** How long a watch keeps polling while Jenkins cannot answer. */
export const JENKINS_UNAVAILABLE_LIMIT_MS = 10 * 60_000;
/** While Jenkins is unavailable, polls back off up to this delay. */
const UNAVAILABLE_MAX_DELAY_MS = 30_000;

type JenkinsOutage = {
  /**
   * Returns how long to wait before the next poll, or rethrows `error` when it
   * does not mean Jenkins is unavailable or the outage outlasted the limit.
   */
  retryDelayMs: (error: unknown) => number;
  /** Call after a poll succeeds. */
  recovered: () => void;
};

/**
 * Keeps a watch polling while Jenkins is temporarily unavailable, as while
 * the controller restarts. Watches only read an existing build or queue item,
 * so repeating a poll is safe.
 */
export function trackJenkinsOutage(options: {
  /** The watch's explicit interval; undefined backs off from the default. */
  intervalMs: number | undefined;
  report: (message: string) => void;
}): JenkinsOutage {
  const pollIntervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  let startedAt: number | undefined;
  let delayMs = pollIntervalMs;
  return {
    retryDelayMs(error) {
      if (!isJenkinsUnavailable(error)) {
        throw error;
      }
      const now = Date.now();
      if (startedAt === undefined) {
        startedAt = now;
        delayMs = pollIntervalMs;
        options.report(
          `Jenkins is unavailable, retrying for up to ${formatDuration(JENKINS_UNAVAILABLE_LIMIT_MS)}. ${error.message}`,
        );
        return delayMs;
      }
      const elapsedMs = now - startedAt;
      if (elapsedMs >= JENKINS_UNAVAILABLE_LIMIT_MS) {
        throw new CliError(
          `Jenkins stayed unavailable for ${formatDuration(elapsedMs)}, so the watch stopped. ${error.message}`,
          [
            "The build may still be running. Check it with `status`, or resume with `wait`.",
          ],
          "JENKINS_UNREACHABLE",
          { cause: error },
        );
      }
      delayMs = Math.min(
        delayMs * 2,
        Math.max(pollIntervalMs, UNAVAILABLE_MAX_DELAY_MS),
      );
      return delayMs;
    },
    recovered() {
      if (startedAt === undefined) {
        return;
      }
      options.report(
        `Jenkins is reachable again after ${formatDuration(Date.now() - startedAt)}.`,
      );
      startedAt = undefined;
    },
  };
}

/**
 * The job's newest build, if it is the one a watch is waiting for: a build
 * newer than the one seen before the trigger. The baseline itself is never
 * the watched build, even while it is still running: a build queued behind it
 * has not started yet.
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
    lastBuild.buildNumber > baselineBuildNumber;
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
