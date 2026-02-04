/**
 * Status command implementation.
 * Shows the last build status (number, result, URL) for a job.
 */
import { confirm, isCancel, select, text, multiselect } from "@clack/prompts";
import { CliError, printError, printHint, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient, JenkinsJob } from "../jenkins/client";
import {
  getJobDisplayName,
  loadJobs,
  resolveJobCandidates,
  resolveJobMatch,
} from "../jobs";
import { loadRecentJobs, recordRecentJob } from "../recent-jobs";

/** Options for the status command. */
type StatusOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
};

type StatusSelectionResult =
  | { kind: "jobs"; jobs: JenkinsJob[] }
  | { kind: "search" };

class SearchAgainError extends Error {
  constructor() {
    super("Search again");
    this.name = "SearchAgainError";
  }
}

class BackToRecentMenuError extends Error {
  constructor() {
    super("Back to recent menu");
    this.name = "BackToRecentMenuError";
  }
}

const ANSI_BOLD = "\u001b[1m";
const ANSI_RESET = "\u001b[0m";
const SEPARATOR_LINE = "-".repeat(60);

function bold(value: string): string {
  return `${ANSI_BOLD}${value}${ANSI_RESET}`;
}

function formatLabelValue(label: string, value: string): string {
  return `${bold(label)} ${value}`;
}

function formatStatusSummary(options: {
  jobLabel: string;
  buildNumber: number;
  result: string;
}): string {
  return `Last build for ${options.jobLabel}: #${options.buildNumber} ${bold(
    options.result,
  )}`;
}

export async function runStatus(options: StatusOptions): Promise<void> {
  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }

  if (options.nonInteractive) {
    await runStatusOnce(options);
    return;
  }

  let jobUrl = options.jobUrl?.trim() ?? "";
  let jobQuery = options.job?.trim() ?? "";
  let jobs: JenkinsJob[] | null = null;

  while (true) {
    let targets: { jobUrl: string; jobLabel: string }[] = [];

    if (jobUrl) {
      ensureValidUrl(jobUrl, "job-url");
      targets = [{ jobUrl, jobLabel: jobUrl }];
    } else {
      if (!jobs) {
        jobs = await loadJobsForStatus({
          client: options.client,
          env: options.env,
          nonInteractive: false,
        });
      }

      if (jobs.length === 0) {
        throw new CliError("No jobs found in cache.", [
          "Run `jenkins-cli list --refresh` to fetch jobs from Jenkins.",
        ]);
      }

      const selection = await resolveJobSelection({
        env: options.env,
        job: jobQuery,
        nonInteractive: false,
      });

      if (selection.kind === "recent") {
        targets = selection.jobs.map((recentJob) => {
          const selectedJob = jobs.find((job) => job.url === recentJob.jobUrl);
          return {
            jobUrl: recentJob.jobUrl,
            jobLabel: selectedJob
              ? getJobDisplayName(selectedJob)
              : recentJob.label,
          };
        });
      } else {
        try {
          const selectedJobs = await resolveJobSearch({
            initialQuery: selection.query,
            jobs,
            nonInteractive: false,
            allowBackToRecent: selection.allowBackToRecent,
          });
          targets = selectedJobs.map((job) => ({
            jobUrl: job.url,
            jobLabel: getJobDisplayName(job),
          }));
        } catch (err) {
          if (
            err instanceof BackToRecentMenuError &&
            selection.allowBackToRecent
          ) {
            jobQuery = "";
            continue;
          }
          throw err;
        }
      }
    }

    const showSeparators = targets.length > 1;
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (showSeparators && index > 0) {
        console.log("");
        console.log(SEPARATOR_LINE);
      }
      try {
        await recordRecentJob({
          env: options.env,
          jobUrl: target.jobUrl,
        });
      } catch {
        // Ignore cache write failures for status output.
      }

      const status = await options.client.getJobStatus(target.jobUrl);
      if (!status.lastBuildNumber) {
        printOk(`No builds found for ${target.jobLabel || target.jobUrl}.`);
        continue;
      }

      const result = status.building ? "RUNNING" : status.result || "UNKNOWN";
      const url = status.lastBuildUrl || target.jobUrl;
      const summary = formatStatusSummary({
        jobLabel: target.jobLabel || target.jobUrl,
        buildNumber: status.lastBuildNumber,
        result,
      });
      const details = formatStatusDetails(status, url);
      printOk(details ? `${summary}\n${details}` : summary);
    }

    const runAgain = await confirm({
      message: "Check another job?",
      initialValue: false,
    });
    if (isCancel(runAgain)) {
      throw new CliError("Operation cancelled.");
    }
    if (!runAgain) {
      return;
    }

    jobUrl = "";
    jobQuery = "";
  }
}

async function runStatusOnce(options: StatusOptions): Promise<void> {
  let jobUrl = options.jobUrl?.trim() ?? "";
  let jobLabel = jobUrl;

  if (jobUrl) {
    ensureValidUrl(jobUrl, "job-url");
  } else {
    const jobs = await loadJobsForStatus({
      client: options.client,
      env: options.env,
      nonInteractive: options.nonInteractive,
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
      const recentJob = selection.jobs[0];
      if (!recentJob) {
        throw new CliError("No jobs selected.", [
          "Choose at least one job and try again.",
        ]);
      }
      const selectedJob = jobs.find((job) => job.url === recentJob.jobUrl);
      jobUrl = recentJob.jobUrl;
      jobLabel = selectedJob ? getJobDisplayName(selectedJob) : recentJob.label;
    } else {
      const selectedJob = await resolveJobMatch({
        query: selection.query,
        jobs,
        nonInteractive: options.nonInteractive,
      });

      jobUrl = selectedJob.url;
      jobLabel = getJobDisplayName(selectedJob);
    }
  }

  try {
    await recordRecentJob({
      env: options.env,
      jobUrl,
    });
  } catch {
    // Ignore cache write failures for status output.
  }

  const status = await options.client.getJobStatus(jobUrl);
  if (!status.lastBuildNumber) {
    printOk(`No builds found for ${jobLabel || jobUrl}.`);
    return;
  }

  const result = status.building ? "RUNNING" : status.result || "UNKNOWN";
  const url = status.lastBuildUrl || jobUrl;
  const summary = formatStatusSummary({
    jobLabel: jobLabel || jobUrl,
    buildNumber: status.lastBuildNumber,
    result,
  });
  const details = formatStatusDetails(status, url);
  printOk(details ? `${summary}\n${details}` : summary);
}

async function promptForJobSelection(
  candidates: JenkinsJob[],
): Promise<StatusSelectionResult> {
  const response = await multiselect({
    message: "Select jobs (press Esc to search again)",
    options: candidates.map((job) => ({
      value: job.url,
      label: getJobDisplayName(job),
    })),
  });

  if (isCancel(response)) {
    return { kind: "search" };
  }

  const selectedValues = new Set(
    Array.isArray(response) ? response.map(String) : [],
  );
  const selected = candidates.filter((job) => selectedValues.has(job.url));
  if (selected.length === 0) {
    return { kind: "search" };
  }

  return { kind: "jobs", jobs: selected };
}

async function resolveJobSelection(options: {
  env: EnvConfig;
  job?: string;
  nonInteractive: boolean;
}): Promise<
  | { kind: "query"; query: string; allowBackToRecent: boolean }
  | { kind: "recent"; jobs: { jobUrl: string; label: string }[] }
> {
  const query = options.job?.trim() ?? "";
  if (query) {
    return { kind: "query", query, allowBackToRecent: false };
  }
  if (options.nonInteractive) {
    throw new CliError("Missing required --job.", [
      "Pass --job <name> or use --job-url <url>.",
    ]);
  }
  const recentJobs = await loadRecentJobs({ env: options.env });
  const allowBackToRecent = recentJobs.length > 0;
  while (true) {
    if (allowBackToRecent) {
      const selection = await promptForRecentJobSelection(recentJobs);
      if (selection.kind === "recent") {
        return selection;
      }
    }
    try {
      return {
        kind: "query",
        query: await promptForJobSearch({ allowBack: allowBackToRecent }),
        allowBackToRecent,
      };
    } catch (err) {
      if (err instanceof BackToRecentMenuError && allowBackToRecent) {
        continue;
      }
      throw err;
    }
  }
}

async function promptForRecentJobSelection(
  recentJobs: { url: string; label: string }[],
): Promise<
  | { kind: "recent"; jobs: { jobUrl: string; label: string }[] }
  | { kind: "search" }
> {
  while (true) {
    const mode = await select({
      message: "Recent jobs",
      options: [
        { value: "recent", label: "Select from recent jobs" },
        { value: "search", label: "Search all jobs" },
      ],
    });
    if (isCancel(mode)) {
      throw new CliError("Operation cancelled.");
    }
    if (mode === "search") {
      return { kind: "search" };
    }

    const response = await multiselect({
      message: "Select recent jobs",
      options: recentJobs.map((job) => ({
        value: job.url,
        label: job.label,
      })),
    });
    if (isCancel(response)) {
      continue;
    }
    const selectedValues = new Set(
      Array.isArray(response) ? response.map(String) : [],
    );
    if (selectedValues.size === 0) {
      return { kind: "search" };
    }
    const selected = recentJobs.filter((job) => selectedValues.has(job.url));
    if (selected.length === 0) {
      return { kind: "search" };
    }
    return {
      kind: "recent",
      jobs: selected.map((job) => ({ jobUrl: job.url, label: job.label })),
    };
  }
}

async function promptForJobSearch(options?: {
  allowBack?: boolean;
}): Promise<string> {
  const response = await text({
    message: "Job name or description",
    placeholder: "e.g. api prod deploy",
  });
  if (isCancel(response)) {
    if (options?.allowBack) {
      throw new BackToRecentMenuError();
    }
    throw new CliError("Operation cancelled.");
  }
  return String(response).trim();
}

async function loadJobsForStatus(options: {
  client: JenkinsClient;
  env: EnvConfig;
  nonInteractive: boolean;
}): Promise<JenkinsJob[]> {
  return loadJobs({
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
}

async function resolveJobSearch(options: {
  initialQuery: string;
  jobs: JenkinsJob[];
  nonInteractive: boolean;
  allowBackToRecent: boolean;
}): Promise<JenkinsJob[]> {
  if (options.nonInteractive) {
    const job = await resolveJobMatch({
      query: options.initialQuery,
      jobs: options.jobs,
      nonInteractive: options.nonInteractive,
    });
    return [job];
  }

  let query = options.initialQuery.trim();
  while (true) {
    if (!query) {
      query = await promptForJobSearch({
        allowBack: options.allowBackToRecent,
      });
    }

    try {
      const candidates = resolveJobCandidates(query, options.jobs);
      if (candidates.length === 1) {
        return candidates;
      }

      const selection = await promptForJobSelection(candidates);
      if (selection.kind === "search") {
        throw new SearchAgainError();
      }
      return selection.jobs;
    } catch (err) {
      if (err instanceof SearchAgainError) {
        query = await promptForJobSearch({
          allowBack: options.allowBackToRecent,
        });
        continue;
      }
      if (err instanceof CliError && shouldRetryJobSearch(err)) {
        printError(err.message);
        for (const hint of err.hints) {
          printHint(hint);
        }
        query = await promptForJobSearch({
          allowBack: options.allowBackToRecent,
        });
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

function ensureValidUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw new CliError(`Invalid --${label} value.`, [
      `Provide a full URL like https://jenkins.example.com/job/example/.`,
    ]);
  }
}

function formatStatusDetails(
  status: {
    building?: boolean;
    lastBuildTimestamp?: number;
    lastBuildDurationMs?: number;
    lastBuildEstimatedDurationMs?: number;
    queueTimeMs?: number;
    parameters?: { name: string; value: string }[];
    stage?: { name?: string; status?: string };
  },
  url: string,
): string {
  const lines: string[] = [];
  lines.push(formatLabelValue("URL:", url));

  const timingParts: string[] = [];
  if (typeof status.lastBuildTimestamp === "number") {
    timingParts.push(
      formatLabelValue("Started:", formatLocalTime(status.lastBuildTimestamp)),
    );
  }
  if (typeof status.queueTimeMs === "number" && status.queueTimeMs > 0) {
    timingParts.push(
      formatLabelValue("Queue:", formatDuration(status.queueTimeMs)),
    );
  }
  const duration = resolveDurationMs(status);
  if (duration > 0) {
    const label = status.building ? "Elapsed" : "Duration";
    let durationValue = formatDuration(duration);
    if (
      status.building &&
      typeof status.lastBuildEstimatedDurationMs === "number" &&
      status.lastBuildEstimatedDurationMs > 0
    ) {
      durationValue += ` (est ${formatDuration(status.lastBuildEstimatedDurationMs)})`;
    }
    timingParts.push(formatLabelValue(`${label}:`, durationValue));
  }
  if (timingParts.length > 0) {
    lines.push(timingParts.join(" | "));
  }

  const stageBranchParts: string[] = [];
  if (status.stage?.name) {
    const stageStatus = status.stage.status ? ` (${status.stage.status})` : "";
    stageBranchParts.push(
      formatLabelValue("Stage:", `${status.stage.name}${stageStatus}`),
    );
  }
  if (stageBranchParts.length > 0) {
    lines.push(stageBranchParts.join(" | "));
  }

  const paramsLines = formatParams(status.parameters);
  if (paramsLines.length > 0) {
    lines.push(...paramsLines);
  }

  return lines.join("\n");
}

function resolveDurationMs(status: {
  building?: boolean;
  lastBuildTimestamp?: number;
  lastBuildDurationMs?: number;
}): number {
  if (
    status.building &&
    typeof status.lastBuildTimestamp === "number" &&
    status.lastBuildTimestamp > 0
  ) {
    return Math.max(0, Date.now() - status.lastBuildTimestamp);
  }
  if (typeof status.lastBuildDurationMs === "number") {
    return status.lastBuildDurationMs;
  }
  return 0;
}

function formatLocalTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString();
}

function formatParams(
  params: { name: string; value: string }[] | undefined,
): string[] {
  if (!params || params.length === 0) {
    return [];
  }
  const entries = params
    .map((param) => `${param.name}=${sanitizeInline(param.value)}`)
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return [];
  }
  const prefixLabel = "Params:";
  const prefix = `${bold(prefixLabel)} `;
  const indent = " ".repeat(prefixLabel.length + 1);
  const chunks = chunkEntries(entries, 4);
  return chunks.map((chunk, index) => {
    const label = index === 0 ? prefix : indent;
    return `${label}${chunk.join(", ")}`;
  });
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function chunkEntries(entries: string[], maxItems: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < entries.length; i += maxItems) {
    chunks.push(entries.slice(i, i + maxItems));
  }
  return chunks;
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
