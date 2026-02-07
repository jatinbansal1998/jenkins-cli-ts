import { spinner } from "@clack/prompts";
import { CliError, printError, printHint, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import type { BuildStatus, JobStatus } from "../types/jenkins";
import {
  formatCompactStatus,
  formatStatusDetails,
  toStatusDetailsFromBuild,
  toStatusDetailsFromJob,
} from "../status-format";
import {
  ensureValidUrl,
  parseOptionalDurationMs,
  resolveJobTarget,
} from "./ops-helpers";

type WaitOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  buildUrl?: string;
  queueUrl?: string;
  interval?: string;
  timeout?: string;
  nonInteractive: boolean;
  suppressExitCode?: boolean;
};

type WaitResult = {
  result: string;
  buildNumber?: number;
  buildUrl?: string;
  cancelled?: boolean;
  timedOut?: boolean;
};

export async function runWait(options: WaitOptions): Promise<WaitResult> {
  validateWaitOptions(options);

  const intervalMs = parseOptionalDurationMs(
    options.interval,
    10_000,
    "interval",
  );
  const timeoutMs = options.timeout
    ? parseOptionalDurationMs(options.timeout, 0, "timeout")
    : undefined;
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new CliError("Invalid --timeout value.", [
      "Use a timeout greater than 0ms (e.g. --timeout 10m).",
    ]);
  }
  if (intervalMs <= 0) {
    throw new CliError("Invalid --interval value.", [
      "Use an interval greater than 0ms (e.g. --interval 10s).",
    ]);
  }

  const resolved = await resolveWaitTarget(options);
  const result = await waitForBuild({
    client: options.client,
    jobUrl: resolved.jobUrl,
    jobLabel: resolved.jobLabel,
    buildUrl: resolved.buildUrl,
    buildNumber: resolved.buildNumber,
    queueUrl: resolved.queueUrl,
    intervalMs,
    timeoutMs,
    nonInteractive: options.nonInteractive,
  });

  if (options.suppressExitCode) {
    return result;
  }
  if (result.timedOut) {
    process.exitCode = 124;
    return result;
  }
  if (result.cancelled) {
    process.exitCode = 130;
    return result;
  }
  if (result.result !== "SUCCESS") {
    process.exitCode = 1;
  }
  return result;
}

function validateWaitOptions(options: WaitOptions): void {
  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }
  if (options.buildUrl && (options.job || options.jobUrl || options.queueUrl)) {
    throw new CliError(
      "When --build-url is provided, do not pass --job, --job-url, or --queue-url.",
      ["Use a single wait target at a time."],
    );
  }
}

async function resolveWaitTarget(options: WaitOptions): Promise<{
  jobUrl?: string;
  jobLabel: string;
  buildUrl?: string;
  buildNumber?: number;
  queueUrl?: string;
}> {
  const buildUrl = options.buildUrl?.trim() ?? "";
  if (buildUrl) {
    ensureValidUrl(buildUrl, "build-url");
    return {
      buildUrl,
      jobLabel: buildUrl,
    };
  }

  const queueUrl = options.queueUrl?.trim() ?? "";
  if (queueUrl) {
    ensureValidUrl(queueUrl, "queue-url");
    return {
      queueUrl,
      jobLabel: queueUrl,
      jobUrl: options.jobUrl?.trim() || undefined,
    };
  }

  const jobTarget = await resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: options.nonInteractive,
  });
  return {
    jobUrl: jobTarget.jobUrl,
    jobLabel: jobTarget.jobLabel,
  };
}

export async function waitForBuild(options: {
  client: JenkinsClient;
  jobUrl?: string;
  jobLabel: string;
  buildUrl?: string;
  buildNumber?: number;
  queueUrl?: string;
  intervalMs: number;
  timeoutMs?: number;
  nonInteractive: boolean;
}): Promise<WaitResult> {
  const useSpinner = Boolean(process.stdout.isTTY) && !options.nonInteractive;
  const statusSpinner = useSpinner ? spinner() : null;
  const cancelSignal = createWatchCancelSignal();
  const startedAt = Date.now();

  if (statusSpinner) {
    const hint = cancelSignal ? " (Esc to stop)" : "";
    statusSpinner.start(`Waiting for ${options.jobLabel}${hint}`);
  }

  let buildUrl = options.buildUrl;
  let buildNumber = options.buildNumber;
  let queueUrl = options.queueUrl;
  let baselineBuildNumber: number | undefined;
  let targetBuildNumber: number | undefined;

  if (!buildUrl && !queueUrl && options.jobUrl) {
    const initialStatus = await options.client.getJobStatus(options.jobUrl);
    baselineBuildNumber = initialStatus.lastBuildNumber;
    if (initialStatus.lastBuildNumber && !initialStatus.building) {
      if (statusSpinner) {
        statusSpinner.stop("Build already completed.");
      }
      const finalBuildUrl = initialStatus.lastBuildUrl || options.jobUrl;
      printFinalJobStatus(
        options.jobLabel,
        initialStatus.lastBuildNumber,
        initialStatus,
        finalBuildUrl,
      );
      return {
        result: initialStatus.result || "UNKNOWN",
        buildNumber: initialStatus.lastBuildNumber,
        buildUrl: finalBuildUrl,
      };
    }
    if (initialStatus.building && initialStatus.lastBuildNumber) {
      targetBuildNumber = initialStatus.lastBuildNumber;
    }
  }

  try {
    while (true) {
      const elapsedMs = Date.now() - startedAt;
      if (options.timeoutMs !== undefined && elapsedMs >= options.timeoutMs) {
        const message = `Timed out after ${formatDuration(elapsedMs)} while waiting for ${options.jobLabel}.`;
        if (statusSpinner) {
          statusSpinner.error(message);
        } else {
          printError(message);
        }
        return {
          result: "TIMEOUT",
          buildNumber,
          buildUrl,
          timedOut: true,
        };
      }

      if (cancelSignal?.isCancelled()) {
        const message = "Wait stopped.";
        if (statusSpinner) {
          statusSpinner.stop(message);
        } else {
          printHint(message);
        }
        return {
          result: "CANCELLED",
          buildNumber,
          buildUrl,
          cancelled: true,
        };
      }

      if (queueUrl) {
        const queued = await options.client.getQueueBuild(queueUrl);
        if (queued?.buildUrl) {
          buildUrl = queued.buildUrl;
          buildNumber = queued.buildNumber;
          queueUrl = undefined;
          continue;
        }
        if (options.jobUrl) {
          const fallbackStatus = await options.client.getJobStatus(
            options.jobUrl,
          );
          const currentNumber = fallbackStatus.lastBuildNumber;
          if (
            targetBuildNumber === undefined &&
            typeof currentNumber === "number" &&
            (baselineBuildNumber === undefined ||
              currentNumber !== baselineBuildNumber ||
              fallbackStatus.building)
          ) {
            targetBuildNumber = currentNumber;
          }
          if (
            typeof currentNumber === "number" &&
            typeof targetBuildNumber === "number" &&
            currentNumber === targetBuildNumber
          ) {
            queueUrl = undefined;
            buildNumber = currentNumber;
            if (fallbackStatus.lastBuildUrl) {
              buildUrl = fallbackStatus.lastBuildUrl;
            }
            continue;
          }
        }
        emitProgress({
          spinnerInstance: statusSpinner,
          message: `${options.jobLabel}: queued | elapsed ${formatDuration(elapsedMs)}`,
        });
      } else if (buildUrl) {
        const status = await options.client.getBuildStatus(buildUrl);
        const currentResult = status.building
          ? "RUNNING"
          : status.result || "UNKNOWN";
        const message = formatBuildProgress(
          options.jobLabel,
          status.buildNumber ?? buildNumber,
          currentResult,
          status,
        );
        emitProgress({ spinnerInstance: statusSpinner, message });
        if (!status.building) {
          if (statusSpinner) {
            statusSpinner.stop("Build completed.");
          }
          const finalBuildUrl = status.buildUrl || buildUrl;
          printFinalStatus(options.jobLabel, status, finalBuildUrl);
          return {
            result: currentResult,
            buildNumber: status.buildNumber ?? buildNumber,
            buildUrl: finalBuildUrl,
          };
        }
      } else if (options.jobUrl) {
        const status = await options.client.getJobStatus(options.jobUrl);
        const currentNumber = status.lastBuildNumber;
        if (
          targetBuildNumber === undefined &&
          typeof currentNumber === "number" &&
          (baselineBuildNumber === undefined ||
            currentNumber !== baselineBuildNumber ||
            status.building)
        ) {
          targetBuildNumber = currentNumber;
        }

        if (
          typeof currentNumber === "number" &&
          typeof targetBuildNumber === "number" &&
          currentNumber === targetBuildNumber
        ) {
          const currentResult = status.building
            ? "RUNNING"
            : status.result || "UNKNOWN";
          const message = formatJobProgress(
            options.jobLabel,
            currentNumber,
            currentResult,
            status,
          );
          emitProgress({ spinnerInstance: statusSpinner, message });
          if (!status.building) {
            if (statusSpinner) {
              statusSpinner.stop("Build completed.");
            }
            const finalBuildUrl = status.lastBuildUrl || options.jobUrl;
            printFinalJobStatus(
              options.jobLabel,
              currentNumber,
              status,
              finalBuildUrl,
            );
            return {
              result: currentResult,
              buildNumber: currentNumber,
              buildUrl: finalBuildUrl,
            };
          }
        } else {
          emitProgress({
            spinnerInstance: statusSpinner,
            message: `${options.jobLabel}: waiting for build start | elapsed ${formatDuration(elapsedMs)}`,
          });
        }
      } else {
        throw new CliError("Missing wait target.", [
          "Provide --job, --job-url, --build-url, or --queue-url.",
        ]);
      }

      if (cancelSignal) {
        await Promise.race([Bun.sleep(options.intervalMs), cancelSignal.wait]);
      } else {
        await Bun.sleep(options.intervalMs);
      }
    }
  } finally {
    cancelSignal?.cleanup();
  }
}

function emitProgress(options: {
  spinnerInstance: ReturnType<typeof spinner> | null;
  message: string;
}): void {
  if (options.spinnerInstance) {
    options.spinnerInstance.message(options.message);
    return;
  }
  printOk(options.message);
}

function formatBuildProgress(
  jobLabel: string,
  buildNumber: number | undefined,
  result: string,
  status: BuildStatus,
): string {
  return `${jobLabel}: ${formatCompactStatus({
    buildNumber,
    result,
    status: toStatusDetailsFromBuild(status),
  })}`;
}

function formatJobProgress(
  jobLabel: string,
  buildNumber: number,
  result: string,
  status: JobStatus,
): string {
  return `${jobLabel}: ${formatCompactStatus({
    buildNumber,
    result,
    status: toStatusDetailsFromJob(status),
  })}`;
}

function printFinalStatus(
  jobLabel: string,
  status: BuildStatus,
  buildUrl: string,
): void {
  const result = status.result || "UNKNOWN";
  const buildNumberText =
    typeof status.buildNumber === "number" ? ` #${status.buildNumber}` : "";
  const summary = `Build for ${jobLabel}${buildNumberText}: ${result}`;
  const details = formatStatusDetails(
    toStatusDetailsFromBuild(status),
    buildUrl,
  );
  printOk(details ? `${summary}\n${details}` : summary);
}

function printFinalJobStatus(
  jobLabel: string,
  buildNumber: number,
  status: JobStatus,
  buildUrl: string,
): void {
  const result = status.result || "UNKNOWN";
  const summary = `Build for ${jobLabel} #${buildNumber}: ${result}`;
  const details = formatStatusDetails(toStatusDetailsFromJob(status), buildUrl);
  printOk(details ? `${summary}\n${details}` : summary);
}

type WatchCancelSignal = {
  isCancelled: () => boolean;
  wait: Promise<void>;
  cleanup: () => void;
};

function createWatchCancelSignal(): WatchCancelSignal | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }

  let cancelled = false;
  let resolveWait: (() => void) | null = null;
  const wait = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;

  const onData = (data: Buffer | string) => {
    const value = data.toString();
    if (value.includes("\u001b")) {
      cancelled = true;
      resolveWait?.();
    }
  };

  try {
    stdin.setRawMode(true);
  } catch {
    // Ignore raw mode errors.
  }
  stdin.on("data", onData);
  stdin.resume();

  return {
    isCancelled: () => cancelled,
    wait,
    cleanup: () => {
      stdin.off("data", onData);
      if (stdin.isTTY) {
        try {
          stdin.setRawMode(Boolean(wasRaw));
        } catch {
          // Ignore cleanup errors.
        }
      }
      stdin.pause();
    },
  };
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
