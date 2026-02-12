/**
 * Build command implementation.
 * Triggers a Jenkins build for a specified job with branch parameter support.
 */
import { confirm, isCancel, select, spinner, text } from "@clack/prompts";
import {
  CliError,
  getScriptName,
  printError,
  printHint,
  printOk,
} from "../cli";
import {
  loadCachedBranchHistory,
  loadCachedBranches,
  recordBranchSelection,
  removeCachedBranch,
} from "../branches.ts";
import { loadRecentJobs, recordRecentJob } from "../recent-jobs.ts";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import type { BuildStatus, JobStatus } from "../types/jenkins";
import { getJobDisplayName, loadJobs, resolveJobMatch } from "../jobs";
import { notifyBuildComplete } from "../notify";
import { runCancel } from "./cancel";
import { runLogs } from "./logs";
import {
  formatCompactStatus,
  formatStatusDetails,
  formatStatusSummary,
  type StatusDetails,
} from "../status-format";
import { waitForPollIntervalOrCancel } from "./watch-utils";
import { runFlow } from "../flows/runner";
import { flows } from "../flows/definition";
import { BRANCH_CUSTOM_VALUE, BRANCH_REMOVE_VALUE } from "../flows/constants";
import { buildFlowHandlers, buildPreFlowHandlers } from "../flows/handlers";
import type {
  ActionEffectResult,
  BuildPostContext,
  BuildPreContext,
} from "../flows/types";
import { withPromptTarget } from "../tui-target";

/** Options for the build command. */
type BuildOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  branch?: string;
  customParams?: Record<string, string>;
  branchParam?: string;
  defaultBranch?: boolean;
  nonInteractive: boolean;
  watch?: boolean;
  returnToCaller?: boolean;
};

type ActiveBuild = {
  buildUrl: string | undefined;
  buildNumber: number | undefined;
  queueUrl: string | undefined;
};

export type BuildRunResult = {
  rootRequested?: boolean;
};

export async function runBuild(options: BuildOptions): Promise<BuildRunResult> {
  validateBuildOptions(options);
  const branchParam = normalizeBranchParam(options.branchParam);

  if (options.nonInteractive) {
    await runBuildOnce({
      client: options.client,
      env: options.env,
      job: options.job,
      jobUrl: options.jobUrl,
      branch: options.branch,
      customParams: options.customParams,
      defaultBranch: options.defaultBranch ?? false,
      branchParam,
      watch: options.watch,
    });
    return {};
  }

  let job = options.job;
  let jobUrl = options.jobUrl;
  let branch = options.branch;
  let customParams = cloneParams(options.customParams);
  let defaultBranch = false;
  const watchFixed = options.watch;

  while (true) {
    const preBuildSelection = await resolveInteractiveBuildSelection({
      client: options.client,
      env: options.env,
      job,
      jobUrl,
      branch,
      customParams,
      defaultBranch,
      branchParam,
    });
    const resolvedJobUrl = preBuildSelection.jobUrl;
    const jobLabel = preBuildSelection.jobLabel;
    const matchedFromSearch = preBuildSelection.matchedFromSearch;
    const triggerConfig = resolveBuildTriggerConfig({
      branch: preBuildSelection.branch,
      customParams: preBuildSelection.customParams,
      defaultBranch: preBuildSelection.defaultBranch,
      branchParam,
    });
    const resolvedBranch = triggerConfig.branch;
    const useDefaultBranch = triggerConfig.defaultBranch;
    const resolvedCustomParams = triggerConfig.customParams;
    const params = triggerConfig.params;

    if (matchedFromSearch) {
      printOk(`Selected job: ${jobLabel || resolvedJobUrl}.`);
    }

    let baselineBuildNumber: number | undefined;
    try {
      const preTriggerStatus =
        await options.client.getJobStatus(resolvedJobUrl);
      baselineBuildNumber = preTriggerStatus.lastBuildNumber;
    } catch {
      // Best-effort only.
    }

    const result = await options.client.triggerBuild(resolvedJobUrl, params);

    if (resolvedBranch) {
      try {
        await recordBranchSelection({
          env: options.env,
          jobUrl: resolvedJobUrl,
          branch: resolvedBranch,
        });
      } catch {
        // Ignore cache write failures for build success.
      }
    }

    try {
      await recordRecentJob({
        env: options.env,
        jobUrl: resolvedJobUrl,
      });
    } catch {
      // Ignore cache write failures for build success.
    }

    const displayJob = jobLabel || resolvedJobUrl;
    if (result.buildUrl) {
      printOk(`Build started at ${result.buildUrl}.`);
    } else if (result.queueUrl) {
      const trackingUrl = result.jobUrl || resolvedJobUrl;
      printOk(`Build queued for ${displayJob}. Track at ${trackingUrl}.`);
    } else {
      printOk(`Build triggered for ${displayJob}.`);
    }

    const shouldWatch = await resolveWatchDecision({
      watch: watchFixed,
      env: options.env,
      nonInteractive: false,
    });
    printNonInteractiveBuildTip({
      scriptName: getScriptName(),
      jobUrl: resolvedJobUrl,
      branch: resolvedBranch,
      defaultBranch: useDefaultBranch,
      customParams: resolvedCustomParams,
      branchParam,
      watch: shouldWatch,
    });
    let activeBuild: ActiveBuild = {
      buildUrl: result.buildUrl,
      buildNumber: result.buildNumber,
      queueUrl: result.queueUrl,
    };
    if (shouldWatch) {
      const finalStatus = await watchBuildStatus({
        client: options.client,
        jobUrl: resolvedJobUrl,
        jobLabel: displayJob,
        buildUrl: activeBuild.buildUrl,
        buildNumber: activeBuild.buildNumber,
        queueUrl: activeBuild.queueUrl,
        baselineBuildNumber,
      });
      if (!finalStatus.cancelled) {
        await notifyBuildComplete({
          message: formatNotificationMessage({
            jobLabel: displayJob,
            buildNumber: finalStatus.buildNumber,
            result: finalStatus.result,
          }),
        });
        if (finalStatus.result !== "SUCCESS") {
          process.exitCode = 1;
        }
      }
    }

    const flowContext: BuildPostContext = {
      env: options.env,
      jobLabel: displayJob,
      returnToCaller: Boolean(options.returnToCaller),
      performAction: async (action): Promise<ActionEffectResult> => {
        if (action === "watch") {
          const finalStatus = await runMenuAction(async () =>
            watchBuildStatus({
              client: options.client,
              jobUrl: resolvedJobUrl,
              jobLabel: displayJob,
              buildUrl: activeBuild.buildUrl,
              buildNumber: activeBuild.buildNumber,
              queueUrl: activeBuild.queueUrl,
            }),
          );
          if (!finalStatus) {
            return "action_error";
          }
          if (finalStatus.cancelled) {
            return "watch_cancelled";
          }
          await notifyBuildComplete({
            message: formatNotificationMessage({
              jobLabel: displayJob,
              buildNumber: finalStatus.buildNumber,
              result: finalStatus.result,
            }),
          });
          if (finalStatus.result !== "SUCCESS") {
            process.exitCode = 1;
          }
          return "action_ok";
        }

        if (action === "logs") {
          const result = await runMenuAction(async () => {
            await runLogs({
              client: options.client,
              env: options.env,
              buildUrl: activeBuild.buildUrl,
              queueUrl: activeBuild.queueUrl,
              jobUrl:
                !activeBuild.buildUrl && !activeBuild.queueUrl
                  ? resolvedJobUrl
                  : undefined,
              follow: true,
              nonInteractive: false,
            });
            return "action_ok";
          });
          return (result ?? "action_error") as ActionEffectResult;
        }

        if (action === "cancel") {
          const result = await runMenuAction(async () => {
            const cancelTarget = resolveCancelTarget(activeBuild);
            await runCancel({
              client: options.client,
              env: options.env,
              buildUrl: cancelTarget.buildUrl,
              queueUrl: cancelTarget.queueUrl,
              jobUrl:
                !cancelTarget.buildUrl && !cancelTarget.queueUrl
                  ? resolvedJobUrl
                  : undefined,
              nonInteractive: false,
            });
            return "action_ok";
          });
          return (result ?? "action_error") as ActionEffectResult;
        }

        if (action === "rerun") {
          const rerunResult = await options.client.triggerBuild(
            resolvedJobUrl,
            params,
          );
          activeBuild = {
            buildUrl: rerunResult.buildUrl,
            buildNumber: rerunResult.buildNumber,
            queueUrl: rerunResult.queueUrl,
          };

          const branchValue = params[branchParam];
          if (branchValue) {
            try {
              await recordBranchSelection({
                env: options.env,
                jobUrl: resolvedJobUrl,
                branch: branchValue,
              });
            } catch {
              // Ignore cache write failures for build success.
            }
          }
          try {
            await recordRecentJob({
              env: options.env,
              jobUrl: resolvedJobUrl,
            });
          } catch {
            // Ignore cache write failures for build success.
          }

          if (rerunResult.buildUrl) {
            printOk(`Build started at ${rerunResult.buildUrl}.`);
          } else if (rerunResult.queueUrl) {
            printOk(`Build queued for ${displayJob}.`);
          } else {
            printOk(`Build triggered for ${displayJob}.`);
          }
          const tipParams = splitParamsForTip({
            params,
            branchParam,
          });
          printNonInteractiveBuildTip({
            scriptName: getScriptName(),
            jobUrl: resolvedJobUrl,
            branch: tipParams.branch,
            defaultBranch: tipParams.defaultBranch,
            customParams: tipParams.customParams,
            branchParam,
          });
          return "action_ok";
        }

        return "action_error";
      },
    };

    const postBuildResult = await runFlow({
      definition: flows.buildPost,
      handlers: buildFlowHandlers,
      prompts: { confirm, isCancel, select, text },
      context: flowContext,
    });

    if (postBuildResult.terminal === "repeat") {
      job = undefined;
      jobUrl = undefined;
      branch = undefined;
      customParams = {};
      defaultBranch = false;
      continue;
    }
    if (postBuildResult.terminal === "return_to_caller_root") {
      return { rootRequested: true };
    }
    if (postBuildResult.terminal === "return_to_caller") {
      return { rootRequested: false };
    }
    if (postBuildResult.terminal === "exit_command") {
      return {};
    }

    return {};
  }
}

async function runMenuAction<T>(
  action: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CliError) {
      printError(error.message);
      for (const hint of error.hints) {
        printHint(hint);
      }
      return undefined;
    }
    throw error;
  }
}

async function runBuildOnce(options: {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  branch?: string;
  customParams?: Record<string, string>;
  defaultBranch: boolean;
  branchParam: string;
  watch?: boolean;
}): Promise<void> {
  const { jobUrl, jobLabel, matchedFromSearch } = await resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: true,
  });

  if (matchedFromSearch) {
    printOk(`Selected job: ${jobLabel || jobUrl}.`);
  }

  const branch = await resolveBranchValue({
    env: options.env,
    jobUrl,
    branch: options.branch,
    defaultBranch: options.defaultBranch,
    nonInteractive: true,
  });

  const triggerConfig = resolveBuildTriggerConfig({
    branch,
    customParams: options.customParams,
    defaultBranch: options.defaultBranch,
    branchParam: options.branchParam,
  });

  let baselineBuildNumber: number | undefined;
  try {
    const preTriggerStatus = await options.client.getJobStatus(jobUrl);
    baselineBuildNumber = preTriggerStatus.lastBuildNumber;
  } catch {
    // Best-effort only.
  }

  const result = await options.client.triggerBuild(
    jobUrl,
    triggerConfig.params,
  );

  if (triggerConfig.branch) {
    try {
      await recordBranchSelection({
        env: options.env,
        jobUrl,
        branch: triggerConfig.branch,
      });
    } catch {
      // Ignore cache write failures for build success.
    }
  }

  try {
    await recordRecentJob({
      env: options.env,
      jobUrl,
    });
  } catch {
    // Ignore cache write failures for build success.
  }

  const displayJob = jobLabel || jobUrl;
  if (result.buildUrl) {
    printOk(`Build started at ${result.buildUrl}.`);
  } else if (result.queueUrl) {
    const trackingUrl = result.jobUrl || jobUrl;
    printOk(`Build queued for ${displayJob}. Track at ${trackingUrl}.`);
  } else {
    printOk(`Build triggered for ${displayJob}.`);
  }

  const shouldWatch = await resolveWatchDecision({
    watch: options.watch,
    env: options.env,
    nonInteractive: true,
  });
  if (shouldWatch) {
    const finalStatus = await watchBuildStatus({
      client: options.client,
      jobUrl,
      jobLabel: displayJob,
      buildUrl: result.buildUrl,
      buildNumber: result.buildNumber,
      queueUrl: result.queueUrl,
      baselineBuildNumber,
    });
    if (finalStatus.cancelled) {
      return;
    }
    if (!finalStatus.cancelled) {
      await notifyBuildComplete({
        message: formatNotificationMessage({
          jobLabel: displayJob,
          buildNumber: finalStatus.buildNumber,
          result: finalStatus.result,
        }),
      });
      if (finalStatus.result !== "SUCCESS") {
        process.exitCode = 1;
      }
    }
  }
}

function validateBuildOptions(options: BuildOptions): void {
  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }

  const hasCustomParams = hasParams(options.customParams);

  if (options.branch && options.defaultBranch) {
    throw new CliError("Use either --branch or --without-params, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }

  if (hasCustomParams && options.defaultBranch) {
    throw new CliError("Use either --param or --without-params, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }
}

function resolveCancelTarget(activeBuild: {
  buildUrl?: string;
  queueUrl?: string;
}): { buildUrl?: string; queueUrl?: string } {
  const buildUrl = activeBuild.buildUrl?.trim() ?? "";
  if (buildUrl) {
    return { buildUrl };
  }
  const queueUrl = activeBuild.queueUrl?.trim() ?? "";
  if (queueUrl) {
    return { queueUrl };
  }
  return {};
}

function printNonInteractiveBuildTip(options: {
  scriptName: string;
  jobUrl: string;
  branch?: string;
  defaultBranch: boolean;
  customParams?: Record<string, string>;
  branchParam: string;
  watch?: boolean;
}): void {
  const rerunCommand = formatNonInteractiveBuildCommand(options);
  printOk("TIP: Non-interactive equivalent:");
  console.log(rerunCommand);
}

function formatNonInteractiveBuildCommand(options: {
  scriptName: string;
  jobUrl: string;
  branch?: string;
  defaultBranch: boolean;
  customParams?: Record<string, string>;
  branchParam: string;
  watch?: boolean;
}): string {
  const parts: string[] = [
    options.scriptName,
    "build",
    "--non-interactive",
    "--job-url",
    shellEscape(options.jobUrl),
  ];

  const trimmedBranch = options.branch?.trim();
  if (options.defaultBranch || !trimmedBranch) {
    if (!hasParams(options.customParams)) {
      parts.push("--without-params");
    }
  } else {
    parts.push("--branch", shellEscape(trimmedBranch));
    if (options.branchParam && options.branchParam !== "BRANCH") {
      parts.push("--branch-param", shellEscape(options.branchParam));
    }
  }

  const customEntries = Object.entries(options.customParams ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  for (const [key, value] of customEntries) {
    parts.push("--param", shellEscape(`${key}=${value}`));
  }

  if (options.watch) {
    parts.push("--watch");
  }

  return parts.join(" ");
}

function shellEscape(value: string): string {
  if (value === "") {
    return "''";
  }
  const singleQuoteEscape = `'` + `"` + `'` + `"` + `'`;
  const escaped = value.replaceAll("'", singleQuoteEscape);
  return `'${escaped}'`;
}

function normalizeBranchParam(value?: string): string {
  const branchParam = (value || "BRANCH").trim();
  if (!branchParam) {
    throw new CliError("Invalid --branch-param value.", [
      "Provide a non-empty parameter name (e.g., BRANCH).",
    ]);
  }
  return branchParam;
}

function resolveBuildTriggerConfig(options: {
  branch?: string;
  customParams?: Record<string, string>;
  defaultBranch: boolean;
  branchParam: string;
}): {
  branch: string;
  customParams: Record<string, string>;
  defaultBranch: boolean;
  params: Record<string, string>;
} {
  const branch = options.branch?.trim() ?? "";
  const customParams = cloneParams(options.customParams);
  const hasCustom = hasParams(customParams);

  if (options.defaultBranch) {
    if (branch) {
      throw new CliError("Use either --branch or --without-params, not both.", [
        "Remove one of the flags and try again.",
      ]);
    }
    if (hasCustom) {
      throw new CliError("Use either --param or --without-params, not both.", [
        "Remove one of the flags and try again.",
      ]);
    }
    return {
      branch: "",
      customParams: {},
      defaultBranch: true,
      params: {},
    };
  }

  const params = { ...customParams };
  if (branch) {
    if (Object.prototype.hasOwnProperty.call(params, options.branchParam)) {
      throw new CliError(
        `Parameter key "${options.branchParam}" conflicts with --branch.`,
        [`Remove --param ${options.branchParam}=... or omit --branch.`],
      );
    }
    params[options.branchParam] = branch;
  }

  const isWithoutParams = !branch && !hasParams(customParams);

  return {
    branch,
    customParams,
    defaultBranch: isWithoutParams,
    params: isWithoutParams ? {} : params,
  };
}

function splitParamsForTip(options: {
  params: Record<string, string>;
  branchParam: string;
}): {
  branch?: string;
  customParams: Record<string, string>;
  defaultBranch: boolean;
} {
  const customParams = cloneParams(options.params);
  const hasBranch = Object.prototype.hasOwnProperty.call(
    customParams,
    options.branchParam,
  );
  const branch = hasBranch ? customParams[options.branchParam] : undefined;
  if (hasBranch) {
    delete customParams[options.branchParam];
  }

  return {
    branch,
    customParams,
    defaultBranch: !hasBranch && !hasParams(customParams),
  };
}

function cloneParams(value?: Record<string, string>): Record<string, string> {
  if (!value) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) {
      continue;
    }
    result[key] = rawValue;
  }
  return result;
}

function hasParams(value?: Record<string, string>): boolean {
  return Object.keys(value ?? {}).length > 0;
}

async function resolveWatchDecision(options: {
  watch?: boolean;
  env: EnvConfig;
  nonInteractive: boolean;
}): Promise<boolean> {
  if (typeof options.watch === "boolean") {
    return options.watch;
  }
  if (options.nonInteractive) {
    return false;
  }
  const response = await confirm({
    message: withPromptTarget(
      "Watch build status until completion?",
      options.env,
    ),
    initialValue: true,
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return Boolean(response);
}

async function watchBuildStatus(options: {
  client: JenkinsClient;
  jobUrl: string;
  jobLabel: string;
  buildUrl?: string;
  buildNumber?: number;
  queueUrl?: string;
  baselineBuildNumber?: number;
}): Promise<{ result: string; buildNumber?: number; cancelled?: boolean }> {
  const pollIntervalMs = 30_000;
  const useSpinner = Boolean(process.stdout.isTTY);
  const statusSpinner = useSpinner ? spinner() : null;
  const cancelSignal = createWatchCancelSignal();
  const watchStartMs = Date.now();
  if (statusSpinner) {
    const hint = cancelSignal ? " (press Esc to stop)" : "";
    statusSpinner.start(`Watching ${options.jobLabel}${hint}`);
  }

  let buildUrl = options.buildUrl;
  let buildNumber = options.buildNumber;
  let queueUrl = options.queueUrl;

  let baselineBuildNumber = options.baselineBuildNumber;
  let targetBuildNumber: number | undefined;

  try {
    if (!buildUrl && baselineBuildNumber === undefined) {
      const initialStatus = await options.client.getJobStatus(options.jobUrl);
      baselineBuildNumber = initialStatus.lastBuildNumber;
      if (initialStatus.lastBuildNumber && initialStatus.building) {
        targetBuildNumber = initialStatus.lastBuildNumber;
      }
    }

    while (true) {
      if (cancelSignal?.isCancelled()) {
        if (statusSpinner) {
          statusSpinner.stop("Watch stopped.");
        }
        return { result: "CANCELLED", buildNumber, cancelled: true };
      }

      if (buildUrl) {
        const status = await options.client.getBuildStatus(buildUrl);
        const result = status.building ? "RUNNING" : status.result || "UNKNOWN";
        const details = toStatusDetailsFromBuild(status);
        const message = formatWatchMessage({
          jobLabel: options.jobLabel,
          buildNumber: status.buildNumber ?? buildNumber,
          result,
          details,
        });
        emitWatchMessage({ spinner: statusSpinner, message });
        if (!status.building) {
          if (statusSpinner) {
            statusSpinner.stop("Build completed.");
          }
          const summary = formatCompletionSummary({
            jobLabel: options.jobLabel,
            buildNumber: status.buildNumber ?? buildNumber,
            result,
          });
          const url = status.buildUrl || buildUrl;
          const detailsText = formatStatusDetails(details, url);
          printOk(detailsText ? `${summary}\n${detailsText}` : summary);
          return { result, buildNumber: status.buildNumber ?? buildNumber };
        }
      } else if (queueUrl) {
        const queueItem = await options.client.getQueueBuild(queueUrl);
        if (queueItem?.buildUrl) {
          buildUrl = queueItem.buildUrl;
          buildNumber = queueItem.buildNumber;
          continue;
        }
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
        const elapsedMs = Date.now() - watchStartMs;
        emitWatchMessage({
          spinner: statusSpinner,
          message: formatQueueMessage({
            jobLabel: options.jobLabel,
            elapsedMs,
          }),
        });
      } else {
        const status = await options.client.getJobStatus(options.jobUrl);
        const currentNumber = status.lastBuildNumber;
        if (
          typeof currentNumber === "number" &&
          targetBuildNumber === undefined
        ) {
          if (
            baselineBuildNumber === undefined ||
            currentNumber !== baselineBuildNumber ||
            status.building
          ) {
            targetBuildNumber = currentNumber;
          }
        }

        if (
          typeof currentNumber === "number" &&
          typeof targetBuildNumber === "number" &&
          currentNumber === targetBuildNumber
        ) {
          const result = status.building
            ? "RUNNING"
            : status.result || "UNKNOWN";
          const details = toStatusDetailsFromJob(status);
          const message = formatWatchMessage({
            jobLabel: options.jobLabel,
            buildNumber: currentNumber,
            result,
            details,
          });
          emitWatchMessage({ spinner: statusSpinner, message });
          if (!status.building) {
            if (statusSpinner) {
              statusSpinner.stop("Build completed.");
            }
            const summary = formatCompletionSummary({
              jobLabel: options.jobLabel,
              buildNumber: currentNumber,
              result,
            });
            const url = status.lastBuildUrl || options.jobUrl;
            const detailsText = formatStatusDetails(details, url);
            printOk(detailsText ? `${summary}\n${detailsText}` : summary);
            return { result, buildNumber: currentNumber };
          }
        } else {
          const elapsedMs = Date.now() - watchStartMs;
          emitWatchMessage({
            spinner: statusSpinner,
            message: formatPendingMessage({
              jobLabel: options.jobLabel,
              elapsedMs,
            }),
          });
        }
      }

      await waitForPollIntervalOrCancel(pollIntervalMs, cancelSignal);
    }
  } catch (error) {
    if (statusSpinner) {
      statusSpinner.error("Watch failed.");
    }
    throw error;
  } finally {
    cancelSignal?.cleanup();
  }
}

function emitWatchMessage(options: {
  spinner: ReturnType<typeof spinner> | null;
  message: string;
}): void {
  if (options.spinner) {
    options.spinner.message(options.message);
    return;
  }
  printOk(options.message);
}

function formatWatchMessage(options: {
  jobLabel: string;
  buildNumber?: number;
  result: string;
  details: StatusDetails;
}): string {
  const compact = formatCompactStatus({
    buildNumber: options.buildNumber,
    result: options.result,
    status: options.details,
  });
  return `${options.jobLabel}: ${compact}`;
}

function formatQueueMessage(options: {
  jobLabel: string;
  elapsedMs: number;
}): string {
  return `${options.jobLabel}: Queued | Waiting for executor | Elapsed: ${formatDuration(
    options.elapsedMs,
  )}`;
}

function formatPendingMessage(options: {
  jobLabel: string;
  elapsedMs: number;
}): string {
  return `${options.jobLabel}: Waiting for build to start | Elapsed: ${formatDuration(
    options.elapsedMs,
  )}`;
}

function formatCompletionSummary(options: {
  jobLabel: string;
  buildNumber?: number;
  result: string;
}): string {
  if (typeof options.buildNumber === "number") {
    return formatStatusSummary({
      jobLabel: options.jobLabel,
      buildNumber: options.buildNumber,
      result: options.result,
    });
  }
  return `Build for ${options.jobLabel} completed: ${options.result}`;
}

function formatNotificationMessage(options: {
  jobLabel: string;
  buildNumber?: number;
  result: string;
}): string {
  const base =
    typeof options.buildNumber === "number"
      ? `Build #${options.buildNumber} ${options.result}`
      : `Build ${options.result}`;
  return options.jobLabel ? `${base} (${options.jobLabel})` : base;
}

function toStatusDetailsFromBuild(status: BuildStatus): StatusDetails {
  return {
    building: status.building,
    timestampMs: status.timestampMs,
    durationMs: status.durationMs,
    estimatedDurationMs: status.estimatedDurationMs,
    queueTimeMs: status.queueTimeMs,
    parameters: status.parameters,
    stage: status.stage,
  };
}

function toStatusDetailsFromJob(status: JobStatus): StatusDetails {
  return {
    building: status.building,
    timestampMs: status.lastBuildTimestamp,
    durationMs: status.lastBuildDurationMs,
    estimatedDurationMs: status.lastBuildEstimatedDurationMs,
    queueTimeMs: status.queueTimeMs,
    parameters: status.parameters,
    stage: status.stage,
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
    const text = data.toString();
    if (text.includes("\u001b")) {
      cancelled = true;
      resolveWait?.();
    }
  };

  try {
    stdin.setRawMode(true);
  } catch {
    // Ignore raw mode failures; cancellation won't work.
  }
  stdin.on("data", onData);
  stdin.resume();

  const cleanup = () => {
    stdin.off("data", onData);
    if (stdin.isTTY) {
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch {
        // Ignore cleanup failures.
      }
    }
    stdin.pause();
  };

  return {
    isCancelled: () => cancelled,
    wait,
    cleanup,
  };
}

async function resolveInteractiveBuildSelection(options: {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  branch?: string;
  customParams?: Record<string, string>;
  defaultBranch: boolean;
  branchParam: string;
}): Promise<{
  jobUrl: string;
  jobLabel: string;
  matchedFromSearch: boolean;
  branch: string;
  customParams: Record<string, string>;
  defaultBranch: boolean;
}> {
  const providedUrl = options.jobUrl?.trim() ?? "";
  if (providedUrl) {
    ensureValidUrl(providedUrl, "job-url");
  }

  const query = options.job?.trim() ?? "";
  let jobs: Awaited<ReturnType<typeof loadJobs>> = [];
  let recentJobs: { url: string; label: string }[] = [];
  let selectedJobLabel = providedUrl || undefined;

  if (!providedUrl) {
    jobs = await loadJobs({
      client: options.client,
      env: options.env,
      nonInteractive: false,
      confirmRefresh: async (reason) => {
        const response = await confirm({
          message: withPromptTarget(`${reason} Refresh now?`, options.env),
          initialValue: true,
        });
        if (isCancel(response)) {
          throw new CliError("Operation cancelled.");
        }
        return response;
      },
    });

    if (jobs.length === 0) {
      throw new CliError("No jobs found in cache.", [
        "Run `jenkins-cli list --refresh` to fetch jobs from Jenkins.",
      ]);
    }

    recentJobs = query ? [] : await loadRecentJobs({ env: options.env });
  }

  const context: BuildPreContext = {
    env: options.env,
    jobs,
    recentJobs,
    searchQuery: query,
    searchCandidates: [],
    selectedJobUrl: providedUrl || undefined,
    selectedJobLabel,
    branchParam: options.branchParam,
    branch: options.branch,
    customParams: cloneParams(options.customParams),
    defaultBranch: options.defaultBranch,
    parameterMode: options.defaultBranch
      ? "without"
      : options.branch
        ? "branch"
        : hasParams(options.customParams)
          ? "custom"
          : undefined,
    buildModePrompted: false,
    branchChoices: [],
    removableBranches: [],
  };

  const result = await runFlow({
    definition: flows.buildPre,
    handlers: buildPreFlowHandlers,
    prompts: { confirm, isCancel, select, text },
    context,
    ...(providedUrl ? { startStateId: "prepare_branch" } : {}),
  });

  if (result.terminal === "exit_command") {
    throw new CliError("Operation cancelled.");
  }

  if (result.terminal !== "complete") {
    throw new Error(
      `Unexpected terminal "${result.terminal}" from build pre flow.`,
    );
  }

  const selectedJobUrl = context.selectedJobUrl?.trim() ?? "";
  if (!selectedJobUrl) {
    throw new CliError("Job name is required.");
  }

  const matchedFromSearch =
    !providedUrl || selectedJobUrl.toLowerCase() !== providedUrl.toLowerCase();

  return {
    jobUrl: selectedJobUrl,
    jobLabel: context.selectedJobLabel || selectedJobUrl,
    matchedFromSearch,
    branch: context.branch?.trim() ?? "",
    customParams: cloneParams(context.customParams),
    defaultBranch: context.defaultBranch,
  };
}

async function resolveJobTarget(options: {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
}): Promise<{ jobUrl: string; jobLabel: string; matchedFromSearch: boolean }> {
  const providedUrl = options.jobUrl?.trim() ?? "";
  if (providedUrl) {
    ensureValidUrl(providedUrl, "job-url");
    return {
      jobUrl: providedUrl,
      jobLabel: providedUrl,
      matchedFromSearch: false,
    };
  }

  const jobs = await loadJobs({
    client: options.client,
    env: options.env,
    nonInteractive: options.nonInteractive,
    confirmRefresh: async (reason) => {
      const response = await confirm({
        message: withPromptTarget(`${reason} Refresh now?`, options.env),
        initialValue: true,
      });
      if (isCancel(response)) {
        throw new CliError("Operation cancelled.");
      }
      return response;
    },
  });

  if (jobs.length === 0) {
    throw new CliError("No jobs found in cache.", [
      "Run `jenkins-cli list --refresh` to fetch jobs from Jenkins.",
    ]);
  }

  const query = options.job?.trim() ?? "";
  if (!query) {
    throw new CliError("Missing required --job.", [
      "Pass --job <name> or use --job-url <url>.",
    ]);
  }

  const selectedJob = await resolveJobMatch({
    query,
    jobs,
    nonInteractive: options.nonInteractive,
  });

  return {
    jobUrl: selectedJob.url,
    jobLabel: getJobDisplayName(selectedJob),
    matchedFromSearch: true,
  };
}

async function resolveBranchValue(options: {
  env: EnvConfig;
  jobUrl: string;
  branch?: string;
  defaultBranch?: boolean;
  nonInteractive?: boolean;
}): Promise<string> {
  let branch = options.branch?.trim() ?? "";
  if (options.defaultBranch || branch) {
    return branch;
  }
  if (options.nonInteractive) {
    return "";
  }
  const cachedBranches = await loadCachedBranches({
    env: options.env,
    jobUrl: options.jobUrl,
  });
  if (cachedBranches.length > 0) {
    const removableBranches = await loadCachedBranchHistory({
      env: options.env,
      jobUrl: options.jobUrl,
    });
    return await promptForBranchSelection({
      env: options.env,
      jobUrl: options.jobUrl,
      choices: cachedBranches,
      removableBranches,
    });
  }

  return await promptForBranchEntry(options.env);
}

async function promptForBranchSelection(options: {
  env: EnvConfig;
  jobUrl: string;
  choices: string[];
  removableBranches: string[];
}): Promise<string> {
  let choices = dedupeCaseInsensitive(options.choices);
  let removableBranches = dedupeCaseInsensitive(options.removableBranches);

  while (true) {
    const selectOptions = [
      ...(removableBranches.length > 0
        ? [{ value: BRANCH_REMOVE_VALUE, label: "Remove cached branch" }]
        : []),
      ...choices.map((choice) => ({
        value: choice,
        label: choice,
      })),
      {
        value: BRANCH_CUSTOM_VALUE,
        label: "Type a different branch",
      },
    ];
    const response = await select({
      message: withPromptTarget("Branch name", options.env),
      options: selectOptions,
    });

    if (isCancel(response)) {
      throw new CliError("Operation cancelled.");
    }

    if (response === BRANCH_REMOVE_VALUE) {
      const toRemove = await promptForBranchRemoval(
        removableBranches,
        options.env,
      );
      const removed = await removeCachedBranch({
        env: options.env,
        jobUrl: options.jobUrl,
        branch: toRemove,
      });
      if (removed) {
        removableBranches = removeBranch(removableBranches, toRemove);
        choices = removeBranch(choices, toRemove);
      }
      continue;
    }

    if (response === BRANCH_CUSTOM_VALUE) {
      return await promptForBranchEntry(options.env);
    }

    return String(response).trim();
  }
}

async function promptForBranchRemoval(
  removableBranches: string[],
  env: EnvConfig,
): Promise<string> {
  const response = await select({
    message: withPromptTarget("Remove cached branch", env),
    options: removableBranches.map((branch) => ({
      value: branch,
      label: branch,
    })),
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return String(response).trim();
}

function dedupeCaseInsensitive(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const key = entry.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function removeBranch(entries: string[], target: string): string[] {
  const key = target.toLowerCase();
  return entries.filter((entry) => entry.toLowerCase() !== key);
}

async function promptForBranchEntry(env: EnvConfig): Promise<string> {
  const response = await text({
    message: withPromptTarget("Branch name", env),
    placeholder: "e.g. main",
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return String(response).trim();
}

function ensureValidUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw new CliError(`Invalid --${label} value.`, [
      `Provide a full URL like https://jenkins.example.com/job/example/.`,
    ]);
  }
}
