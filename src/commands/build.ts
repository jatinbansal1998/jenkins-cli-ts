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
import type {
  BuildStatus,
  JenkinsClient,
  JenkinsJob,
  JobStatus,
} from "../jenkins/client";
import {
  getJobDisplayName,
  loadJobs,
  resolveJobCandidates,
  resolveJobMatch,
} from "../jobs";
import { notifyBuildComplete } from "../notify";
import {
  formatCompactStatus,
  formatStatusDetails,
  formatStatusSummary,
  type StatusDetails,
} from "../status-format";

/** Options for the build command. */
type BuildOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  branch?: string;
  branchParam?: string;
  defaultBranch?: boolean;
  nonInteractive: boolean;
  watch?: boolean;
};

type JobSelectionResult = { kind: "job"; job: JenkinsJob } | { kind: "search" };

class SearchAgainError extends Error {
  constructor() {
    super("Search again");
    this.name = "SearchAgainError";
  }
}

export async function runBuild(options: BuildOptions): Promise<void> {
  validateBuildOptions(options);
  const branchParam = normalizeBranchParam(options.branchParam);

  if (options.nonInteractive) {
    await runBuildOnce({
      client: options.client,
      env: options.env,
      job: options.job,
      jobUrl: options.jobUrl,
      branch: options.branch,
      defaultBranch: options.defaultBranch ?? false,
      branchParam,
      watch: options.watch,
    });
    return;
  }

  let job = options.job;
  let jobUrl = options.jobUrl;
  let branch = options.branch;
  let defaultBranch = options.defaultBranch ?? false;
  const watchFixed = options.watch;

  while (true) {
    const {
      jobUrl: resolvedJobUrl,
      jobLabel,
      matchedFromSearch,
    } = await resolveJobTarget({
      client: options.client,
      env: options.env,
      job,
      jobUrl,
      nonInteractive: false,
    });

    if (matchedFromSearch) {
      printOk(`Selected job: ${jobLabel || resolvedJobUrl}.`);
    }

    const resolvedBranch = await resolveBranchValue({
      env: options.env,
      jobUrl: resolvedJobUrl,
      branch,
      defaultBranch,
    });

    if (!defaultBranch && !resolvedBranch) {
      throw new CliError("Branch is required to trigger a build.", [
        "Pass --branch <name> or use --default-branch to use the job default.",
      ]);
    }

    const params = defaultBranch ? {} : { [branchParam]: resolvedBranch };
    const result = await options.client.triggerBuild(resolvedJobUrl, params);

    if (!defaultBranch && resolvedBranch) {
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
      nonInteractive: false,
    });
    if (shouldWatch) {
      const finalStatus = await watchBuildStatus({
        client: options.client,
        jobUrl: resolvedJobUrl,
        jobLabel: displayJob,
        buildUrl: result.buildUrl,
        buildNumber: result.buildNumber,
        queueUrl: result.queueUrl,
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

    const rerunCommand = formatNonInteractiveBuildCommand({
      scriptName: getScriptName(),
      jobUrl: resolvedJobUrl,
      branch: resolvedBranch,
      defaultBranch,
      branchParam,
      watch: shouldWatch,
    });
    printOk("TIP: Non-interactive equivalent:");
    console.log(rerunCommand);

    const runAgain = await confirm({
      message: "Trigger another build?",
      initialValue: false,
    });
    if (isCancel(runAgain)) {
      throw new CliError("Operation cancelled.");
    }
    if (!runAgain) {
      return;
    }

    job = undefined;
    jobUrl = undefined;
    branch = undefined;
    defaultBranch = false;
  }
}

async function runBuildOnce(options: {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  branch?: string;
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
  });

  if (!options.defaultBranch && !branch) {
    throw new CliError("Branch is required to trigger a build.", [
      "Pass --branch <name> or use --default-branch to use the job default.",
    ]);
  }

  const params = options.defaultBranch ? {} : { [options.branchParam]: branch };
  const result = await options.client.triggerBuild(jobUrl, params);

  if (!options.defaultBranch && branch) {
    try {
      await recordBranchSelection({
        env: options.env,
        jobUrl,
        branch,
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
}

function validateBuildOptions(options: BuildOptions): void {
  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }

  if (options.branch && options.defaultBranch) {
    throw new CliError("Use either --branch or --default-branch, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }

  if (options.nonInteractive && !options.defaultBranch && !options.branch) {
    throw new CliError("Missing required --branch.", [
      "Pass --branch <name> or use --default-branch to use the job default.",
    ]);
  }
}

function formatNonInteractiveBuildCommand(options: {
  scriptName: string;
  jobUrl: string;
  branch?: string;
  defaultBranch: boolean;
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

  if (options.defaultBranch) {
    parts.push("--default-branch");
    return parts.join(" ");
  }

  if (options.branch && options.branch.trim()) {
    parts.push("--branch", shellEscape(options.branch.trim()));
  }

  if (options.branchParam && options.branchParam !== "BRANCH") {
    parts.push("--branch-param", shellEscape(options.branchParam));
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
  const escaped = value.replace(/'/g, singleQuoteEscape);
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

async function resolveWatchDecision(options: {
  watch?: boolean;
  nonInteractive: boolean;
}): Promise<boolean> {
  if (typeof options.watch === "boolean") {
    return options.watch;
  }
  if (options.nonInteractive) {
    return false;
  }
  const response = await confirm({
    message: "Watch build status until completion?",
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

  let baselineBuildNumber: number | undefined;
  let targetBuildNumber: number | undefined;

  if (!buildUrl && !queueUrl) {
    const initialStatus = await options.client.getJobStatus(options.jobUrl);
    baselineBuildNumber = initialStatus.lastBuildNumber;
    if (initialStatus.lastBuildNumber && initialStatus.building) {
      targetBuildNumber = initialStatus.lastBuildNumber;
    }
  }

  try {
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

      if (cancelSignal) {
        await Promise.race([Bun.sleep(pollIntervalMs), cancelSignal.wait]);
      } else {
        await Bun.sleep(pollIntervalMs);
      }
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
        message: `${reason} Refresh now?`,
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

  const selection = await resolveJobSelection({
    env: options.env,
    job: options.job,
    nonInteractive: options.nonInteractive,
  });
  if (selection.kind === "recent") {
    const selectedJob = jobs.find((job) => job.url === selection.jobUrl);
    return {
      jobUrl: selection.jobUrl,
      jobLabel: selectedJob ? getJobDisplayName(selectedJob) : selection.label,
      matchedFromSearch: true,
    };
  }

  const selectedJob = await resolveJobSearch({
    initialQuery: selection.query,
    jobs,
    nonInteractive: options.nonInteractive,
  });

  return {
    jobUrl: selectedJob.url,
    jobLabel: getJobDisplayName(selectedJob),
    matchedFromSearch: true,
  };
}

async function resolveJobSelection(options: {
  env: EnvConfig;
  job?: string;
  nonInteractive: boolean;
}): Promise<
  | { kind: "query"; query: string }
  | { kind: "recent"; jobUrl: string; label: string }
> {
  let query = options.job?.trim() ?? "";
  if (query) {
    return { kind: "query", query };
  }
  if (options.nonInteractive) {
    throw new CliError("Missing required --job.", [
      "Pass --job <name> or use --job-url <url>.",
    ]);
  }
  const recentJobs = await loadRecentJobs({ env: options.env });
  if (recentJobs.length > 0) {
    const selection = await promptForRecentJobSelection(recentJobs);
    if (selection.kind === "recent") {
      return selection;
    }
  }
  return { kind: "query", query: await promptForJobSearch() };
}

async function resolveJobSearch(options: {
  initialQuery: string;
  jobs: JenkinsJob[];
  nonInteractive: boolean;
}): Promise<JenkinsJob> {
  if (options.nonInteractive) {
    return resolveJobMatch({
      query: options.initialQuery,
      jobs: options.jobs,
      nonInteractive: options.nonInteractive,
    });
  }

  let query = options.initialQuery.trim();
  while (true) {
    if (!query) {
      query = await promptForJobSearch();
    }

    try {
      const candidates = resolveJobCandidates(query, options.jobs);
      if (candidates.length === 1) {
        return candidates[0];
      }

      const selection = await promptForJobSelection(candidates);
      if (selection.kind === "search") {
        throw new SearchAgainError();
      }
      return selection.job;
    } catch (err) {
      if (err instanceof SearchAgainError) {
        query = await promptForJobSearch();
        continue;
      }
      if (err instanceof CliError && shouldRetryJobSearch(err)) {
        printError(err.message);
        for (const hint of err.hints) {
          printHint(hint);
        }
        query = await promptForJobSearch();
        continue;
      }
      throw err;
    }
  }
}

function shouldRetryJobSearch(error: CliError): boolean {
  if (error.message === "Job name is required.") {
    return true;
  }
  return error.message.startsWith("No jobs match ");
}

async function resolveBranchValue(options: {
  env: EnvConfig;
  jobUrl: string;
  branch?: string;
  defaultBranch?: boolean;
}): Promise<string> {
  let branch = options.branch?.trim() ?? "";
  if (options.defaultBranch || branch) {
    return branch;
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

  return await promptForBranchEntry();
}

async function promptForJobSelection(
  candidates: JenkinsJob[],
): Promise<JobSelectionResult> {
  const response = await select({
    message: "Select a job (press Esc to search again)",
    options: candidates.map((job) => ({
      value: job.url,
      label: getJobDisplayName(job),
    })),
  });

  if (isCancel(response)) {
    return { kind: "search" };
  }

  const selected = candidates.find((job) => job.url === response);
  if (!selected) {
    throw new CliError("Selected job is no longer available.", [
      "Run `jenkins-cli list --refresh` to update the cache.",
    ]);
  }

  return { kind: "job", job: selected };
}

async function promptForRecentJobSelection(
  recentJobs: { url: string; label: string }[],
): Promise<
  { kind: "recent"; jobUrl: string; label: string } | { kind: "search" }
> {
  const searchAction = "__jenkins_cli_search_all__";
  const options = [
    { value: searchAction, label: "Search all jobs" },
    ...recentJobs.map((job) => ({ value: job.url, label: job.label })),
  ];
  const response = await select({
    message: "Recent jobs",
    options,
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  if (response === searchAction) {
    return { kind: "search" };
  }
  const selected = recentJobs.find((job) => job.url === response);
  if (!selected) {
    throw new CliError("Selected job is no longer available.", [
      "Run `jenkins-cli list --refresh` to update the cache.",
    ]);
  }
  return { kind: "recent", jobUrl: selected.url, label: selected.label };
}

async function promptForJobSearch(): Promise<string> {
  const response = await text({
    message: "Job name or description",
    placeholder: "e.g. api prod deploy",
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return String(response).trim();
}

async function promptForBranchSelection(options: {
  env: EnvConfig;
  jobUrl: string;
  choices: string[];
  removableBranches: string[];
}): Promise<string> {
  const customValue = "__jenkins_cli_custom_branch__";
  const removeValue = "__jenkins_cli_remove_branch__";
  let choices = dedupeCaseInsensitive(options.choices);
  let removableBranches = dedupeCaseInsensitive(options.removableBranches);

  while (true) {
    const selectOptions = [
      ...(removableBranches.length > 0
        ? [{ value: removeValue, label: "Remove cached branch" }]
        : []),
      ...choices.map((choice) => ({
        value: choice,
        label: choice,
      })),
      {
        value: customValue,
        label: "Type a different branch",
      },
    ];
    const response = await select({
      message: "Branch name",
      options: selectOptions,
    });

    if (isCancel(response)) {
      throw new CliError("Operation cancelled.");
    }

    if (response === removeValue) {
      const toRemove = await promptForBranchRemoval(removableBranches);
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

    if (response === customValue) {
      return await promptForBranchEntry();
    }

    return String(response).trim();
  }
}

async function promptForBranchRemoval(
  removableBranches: string[],
): Promise<string> {
  const response = await select({
    message: "Remove cached branch",
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

async function promptForBranchEntry(): Promise<string> {
  const response = await text({
    message: "Branch name",
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
