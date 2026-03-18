import { CliError } from "../cli";
import { areSameJobUrls, normalizeOptionalJobUrl } from "../job-url";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import type { QueueItemSummary } from "../types/jenkins";

export const DEFAULT_WATCH_INTERVAL_MS = 5_000;

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

export type WatchControlAction = "stop" | "cancel";

export type WatchControlSignal = {
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
    const jobStatus = await options.client.getJobStatus(jobUrl);
    if (jobStatus.building && jobStatus.lastBuildUrl) {
      await options.client.stopBuild(jobStatus.lastBuildUrl);
      return {
        kind: "build",
        buildUrl: jobStatus.lastBuildUrl,
        buildNumber: jobStatus.lastBuildNumber,
        message: `Cancellation requested for build: ${jobStatus.lastBuildUrl}`,
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
