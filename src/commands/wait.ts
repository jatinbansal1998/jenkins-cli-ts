import { spinner } from "../clack";
import { markAnalyticsPollingCommand } from "../analytics";
import { CliError, printError, printHint, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import type { BuildStatus, JobStatus } from "../types/jenkins";
import {
  getKnownStageTotal,
  recordKnownStageTotal,
} from "../stage-count-cache";
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
import {
  createWatchControlSignal,
  DEFAULT_WATCH_INTERVAL_MS,
  requestCancellationForWatchTarget,
  waitForPollIntervalOrCancel,
} from "./watch-utils";

export const DEFAULT_WAIT_INTERVAL_MS = DEFAULT_WATCH_INTERVAL_MS;

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
  cancelIssued?: boolean;
  timedOut?: boolean;
  durationMs?: number;
  queueTimeMs?: number;
  hadStageInfo?: boolean;
};

export async function runWait(options: WaitOptions): Promise<WaitResult> {
  validateWaitOptions(options);
  markAnalyticsPollingCommand();

  const intervalMs = parseOptionalDurationMs(
    options.interval,
    DEFAULT_WAIT_INTERVAL_MS,
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
      "Use an interval greater than 0ms (e.g. --interval 5s).",
    ]);
  }

  const resolved = await resolveWaitTarget(options);
  const result = await waitForBuild({
    client: options.client,
    env: options.env,
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
  if (result.cancelIssued) {
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
  env?: EnvConfig;
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
  const cancelSignal = createWatchControlSignal();
  const startedAt = Date.now();
  const watchPrompt = cancelSignal
    ? `Waiting for ${options.jobLabel} (Esc to stop, c to cancel)`
    : `Waiting for ${options.jobLabel}`;
  if (cancelSignal) {
    printHint("Controls: Esc stops watching. Press c to cancel the build.");
  }
  let cancelIssued = false;

  if (statusSpinner) {
    statusSpinner.start(watchPrompt);
  }

  let buildUrl = options.buildUrl;
  let buildNumber = options.buildNumber;
  let queueUrl = options.queueUrl;
  let baselineBuildNumber: number | undefined;
  let targetBuildNumber: number | undefined;
  let knownTotalStages = await getKnownStageTotal({
    env: options.env,
    jobUrl: options.jobUrl,
    buildUrl,
  });

  try {
    if (!buildUrl && !queueUrl && options.jobUrl) {
      const initialStatus = await options.client.getJobStatus(options.jobUrl);
      baselineBuildNumber = initialStatus.lastBuildNumber;
      if (initialStatus.lastBuildNumber && !initialStatus.building) {
        if (statusSpinner) {
          statusSpinner.stop("Build already completed.");
        }
        const finalBuildUrl = initialStatus.lastBuildUrl || options.jobUrl;
        const resolvedTotalStages =
          initialStatus.stages?.length || knownTotalStages;
        if (initialStatus.result === "SUCCESS") {
          await persistKnownTotalStages({
            env: options.env,
            jobUrl: options.jobUrl,
            buildUrl: finalBuildUrl,
            stages: initialStatus.stages,
            jobLabel: options.jobLabel,
          });
        }
        printFinalJobStatus(
          options.jobLabel,
          initialStatus.lastBuildNumber,
          initialStatus,
          finalBuildUrl,
          resolvedTotalStages,
        );
        return {
          result: initialStatus.result || "UNKNOWN",
          buildNumber: initialStatus.lastBuildNumber,
          buildUrl: finalBuildUrl,
          durationMs: initialStatus.lastBuildDurationMs,
          queueTimeMs: initialStatus.queueTimeMs,
          hadStageInfo: Boolean(initialStatus.stages?.length),
        };
      }
      if (initialStatus.building && initialStatus.lastBuildNumber) {
        targetBuildNumber = initialStatus.lastBuildNumber;
      }
    }

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

      const watchAction = cancelSignal?.getAction();
      if (watchAction === "stop") {
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
          cancelIssued,
        };
      }
      if (watchAction === "cancel" && cancelSignal) {
        cancelSignal.clearAction();
        try {
          const cancelResult = await requestCancellationForWatchTarget({
            client: options.client,
            jobUrl: options.jobUrl,
            buildUrl,
            queueUrl,
          });
          cancelIssued = true;
          if (cancelResult.kind === "build") {
            buildUrl = cancelResult.buildUrl;
            buildNumber = cancelResult.buildNumber ?? buildNumber;
            queueUrl = undefined;
            persistWatchMessage({
              spinnerInstance: statusSpinner,
              watchPrompt,
              message: cancelResult.message,
            });
            continue;
          }
          persistWatchMessage({
            spinnerInstance: statusSpinner,
            watchPrompt,
            message: cancelResult.message,
          });
          return {
            result: "ABORTED",
            buildNumber,
            buildUrl,
            cancelIssued: true,
          };
        } catch (error) {
          if (statusSpinner) {
            statusSpinner.stop("Cancel failed.");
          }
          if (error instanceof CliError) {
            printError(error.message);
            for (const hint of error.hints) {
              printHint(hint);
            }
          } else {
            printError(
              error instanceof Error ? error.message : "Unexpected error.",
            );
          }
          if (statusSpinner) {
            statusSpinner.start(watchPrompt);
          }
        }
      }

      if (queueUrl) {
        const queued = await options.client.getQueueBuild(queueUrl);
        if (queued?.buildUrl) {
          buildUrl = queued.buildUrl;
          buildNumber = queued.buildNumber;
          queueUrl = undefined;
          if (knownTotalStages === undefined) {
            knownTotalStages = await getKnownStageTotal({
              env: options.env,
              jobUrl: options.jobUrl,
              buildUrl,
            });
          }
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
          knownTotalStages,
        );
        emitProgress({ spinnerInstance: statusSpinner, message });
        if (!status.building) {
          if (statusSpinner) {
            statusSpinner.stop("Build completed.");
          }
          const finalBuildUrl = status.buildUrl || buildUrl;
          const resolvedTotalStages = status.stages?.length || knownTotalStages;
          if (currentResult === "SUCCESS") {
            await persistKnownTotalStages({
              env: options.env,
              jobUrl: options.jobUrl,
              buildUrl: finalBuildUrl,
              stages: status.stages,
              jobLabel: options.jobLabel,
            });
          }
          printFinalStatus(
            options.jobLabel,
            status,
            finalBuildUrl,
            resolvedTotalStages,
          );
          return {
            result: currentResult,
            buildNumber: status.buildNumber ?? buildNumber,
            buildUrl: finalBuildUrl,
            cancelIssued,
            durationMs: status.durationMs,
            queueTimeMs: status.queueTimeMs,
            hadStageInfo: Boolean(status.stages?.length),
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
          if (knownTotalStages === undefined) {
            knownTotalStages = await getKnownStageTotal({
              env: options.env,
              jobUrl: options.jobUrl,
              buildUrl: status.lastBuildUrl,
            });
          }
          const currentResult = status.building
            ? "RUNNING"
            : status.result || "UNKNOWN";
          const message = formatJobProgress(
            options.jobLabel,
            currentNumber,
            currentResult,
            status,
            knownTotalStages,
          );
          emitProgress({ spinnerInstance: statusSpinner, message });
          if (!status.building) {
            if (statusSpinner) {
              statusSpinner.stop("Build completed.");
            }
            const finalBuildUrl = status.lastBuildUrl || options.jobUrl;
            const resolvedTotalStages =
              status.stages?.length || knownTotalStages;
            if (currentResult === "SUCCESS") {
              await persistKnownTotalStages({
                env: options.env,
                jobUrl: options.jobUrl,
                buildUrl: finalBuildUrl,
                stages: status.stages,
                jobLabel: options.jobLabel,
              });
            }
            printFinalJobStatus(
              options.jobLabel,
              currentNumber,
              status,
              finalBuildUrl,
              resolvedTotalStages,
            );
            return {
              result: currentResult,
              buildNumber: currentNumber,
              buildUrl: finalBuildUrl,
              cancelIssued,
              durationMs: status.lastBuildDurationMs,
              queueTimeMs: status.queueTimeMs,
              hadStageInfo: Boolean(status.stages?.length),
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

      await waitForPollIntervalOrCancel(options.intervalMs, cancelSignal);
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

function persistWatchMessage(options: {
  spinnerInstance: ReturnType<typeof spinner> | null;
  watchPrompt: string;
  message: string;
}): void {
  if (options.spinnerInstance) {
    options.spinnerInstance.stop(options.message);
    options.spinnerInstance.start(options.watchPrompt);
    return;
  }
  printOk(options.message);
}

function formatBuildProgress(
  jobLabel: string,
  buildNumber: number | undefined,
  result: string,
  status: BuildStatus,
  knownTotalStages?: number,
): string {
  return `${jobLabel}: ${formatCompactStatus({
    buildNumber,
    result,
    status: toStatusDetailsFromBuild(status, { knownTotalStages }),
  })}`;
}

function formatJobProgress(
  jobLabel: string,
  buildNumber: number,
  result: string,
  status: JobStatus,
  knownTotalStages?: number,
): string {
  return `${jobLabel}: ${formatCompactStatus({
    buildNumber,
    result,
    status: toStatusDetailsFromJob(status, { knownTotalStages }),
  })}`;
}

function printFinalStatus(
  jobLabel: string,
  status: BuildStatus,
  buildUrl: string,
  knownTotalStages?: number,
): void {
  const result = status.result || "UNKNOWN";
  const buildNumberText =
    typeof status.buildNumber === "number" ? ` #${status.buildNumber}` : "";
  const summary = `Build for ${jobLabel}${buildNumberText}: ${result}`;
  const details = formatStatusDetails(
    toStatusDetailsFromBuild(status, { knownTotalStages }),
    buildUrl,
  );
  printOk(details ? `${summary}\n${details}` : summary);
}

function printFinalJobStatus(
  jobLabel: string,
  buildNumber: number,
  status: JobStatus,
  buildUrl: string,
  knownTotalStages?: number,
): void {
  const result = status.result || "UNKNOWN";
  const summary = `Build for ${jobLabel} #${buildNumber}: ${result}`;
  const details = formatStatusDetails(
    toStatusDetailsFromJob(status, { knownTotalStages }),
    buildUrl,
  );
  printOk(details ? `${summary}\n${details}` : summary);
}

async function persistKnownTotalStages(options: {
  env?: EnvConfig;
  jobUrl?: string;
  buildUrl?: string;
  stages?: BuildStatus["stages"] | JobStatus["stages"];
  jobLabel: string;
}): Promise<void> {
  try {
    await recordKnownStageTotal({
      env: options.env,
      jobUrl: options.jobUrl,
      buildUrl: options.buildUrl,
      totalStages: options.stages?.length,
      jobName: options.jobLabel,
    });
  } catch {
    // Ignore stage cache write failures while printing status.
  }
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
