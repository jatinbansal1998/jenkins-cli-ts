/**
 * Status command implementation.
 * Shows the last build status (number, result, URL) for a job.
 */
import { confirm, isCancel, select, text, multiselect } from "@clack/prompts";
import { CliError, printError, printHint, printOk } from "../cli";
import { runBuild } from "./build";
import { runCancel } from "./cancel";
import { runLogs } from "./logs";
import { runRerun } from "./rerun";
import { runWait } from "./wait";
import {
  formatStatusDetails,
  formatStatusSummary,
  toStatusDetailsFromJob,
} from "../status-format";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import type { JenkinsJob } from "../types/jenkins";
import {
  getJobDisplayName,
  loadJobs,
  resolveJobCandidates,
  resolveJobMatch,
} from "../jobs";
import { loadRecentJobs, recordRecentJob } from "../recent-jobs";
import { runFlow } from "../flows/runner";
import { flows } from "../flows/definition";
import { statusFlowHandlers } from "../flows/handlers";
import type { ActionEffectResult, StatusPostContext } from "../flows/types";
import { withPromptTarget } from "../tui-target";

/** Options for the status command. */
type StatusOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
  watch?: boolean;
};

type StatusSelectionResult =
  | { kind: "jobs"; jobs: JenkinsJob[] }
  | { kind: "search" };

class BackToRecentMenuError extends Error {
  constructor() {
    super("Back to recent menu");
    this.name = "BackToRecentMenuError";
  }
}

const SEPARATOR_LINE = "-".repeat(60);

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
      const loadedJobs = (jobs ??= await loadJobsForStatus({
        client: options.client,
        env: options.env,
        nonInteractive: false,
      }));

      if (loadedJobs.length === 0) {
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
          const selectedJob = loadedJobs.find(
            (job) => job.url === recentJob.jobUrl,
          );
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
            jobs: loadedJobs,
            nonInteractive: false,
            allowBackToRecent: selection.allowBackToRecent,
            env: options.env,
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
    for (const [index, target] of targets.entries()) {
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
      const details = formatStatusDetails(toStatusDetailsFromJob(status), url);
      printOk(details ? `${summary}\n${details}` : summary);

      if (options.watch) {
        await runWait({
          client: options.client,
          env: options.env,
          jobUrl: target.jobUrl,
          nonInteractive: false,
          suppressExitCode: true,
        });
      }
    }

    const primaryTarget = targets.length === 1 ? targets[0] : undefined;
    const postContext: StatusPostContext = {
      env: options.env,
      targetLabel: primaryTarget?.jobLabel || "selected jobs",
      performAction: async (action): Promise<ActionEffectResult> => {
        if (!primaryTarget) {
          return "action_error";
        }
        if (action === "watch") {
          const result = await runMenuAction(async () =>
            runWait({
              client: options.client,
              env: options.env,
              jobUrl: primaryTarget.jobUrl,
              nonInteractive: false,
              suppressExitCode: true,
            }),
          );
          if (!result) {
            return "action_error";
          }
          return result.cancelled ? "watch_cancelled" : "action_ok";
        }
        if (action === "logs") {
          const result = await runMenuAction(async () => {
            await runLogs({
              client: options.client,
              env: options.env,
              jobUrl: primaryTarget.jobUrl,
              follow: true,
              nonInteractive: false,
            });
            return "action_ok";
          });
          return (result ?? "action_error") as ActionEffectResult;
        }
        if (action === "cancel") {
          const result = await runMenuAction(async () => {
            await runCancel({
              client: options.client,
              env: options.env,
              jobUrl: primaryTarget.jobUrl,
              nonInteractive: false,
            });
            return "action_ok";
          });
          return (result ?? "action_error") as ActionEffectResult;
        }
        if (action === "rerun") {
          const result = await runMenuAction(async () => {
            await runRerun({
              client: options.client,
              env: options.env,
              jobUrl: primaryTarget.jobUrl,
              nonInteractive: false,
            });
            return "action_ok";
          });
          return (result ?? "action_error") as ActionEffectResult;
        }
        if (action === "build") {
          const result = await runMenuAction(async () => {
            const buildResult = await runBuild({
              client: options.client,
              env: options.env,
              jobUrl: primaryTarget.jobUrl,
              branchParam: options.env.branchParamDefault,
              defaultBranch: false,
              nonInteractive: false,
              returnToCaller: true,
            });
            return buildResult.rootRequested ? "root" : "action_ok";
          });
          return (result ?? "action_error") as ActionEffectResult;
        }
        return "action_error";
      },
    };

    const postResult = await runFlow({
      definition: flows.statusPost,
      handlers: statusFlowHandlers,
      prompts: { confirm, isCancel, select, text },
      context: postContext,
      ...(primaryTarget ? {} : { startStateId: "again_confirm" }),
    });

    if (postResult.terminal === "repeat") {
      jobUrl = "";
      jobQuery = "";
      continue;
    }

    return;
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
  const details = formatStatusDetails(toStatusDetailsFromJob(status), url);
  printOk(details ? `${summary}\n${details}` : summary);

  if (options.watch) {
    await runWait({
      client: options.client,
      env: options.env,
      jobUrl,
      nonInteractive: true,
      suppressExitCode: false,
    });
  }
}

async function promptForJobSelection(
  candidates: JenkinsJob[],
  env: EnvConfig,
): Promise<StatusSelectionResult> {
  const response = await multiselect({
    message: withPromptTarget("Select jobs (press Esc to search again)", env),
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
      const selection = await promptForRecentJobSelection(
        recentJobs,
        options.env,
      );
      if (selection.kind === "recent") {
        return selection;
      }
    }
    try {
      return {
        kind: "query",
        query: await promptForJobSearch({
          allowBack: allowBackToRecent,
          env: options.env,
        }),
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
  env: EnvConfig,
): Promise<
  | { kind: "recent"; jobs: { jobUrl: string; label: string }[] }
  | { kind: "search" }
> {
  while (true) {
    const mode = await select({
      message: withPromptTarget("Recent jobs", env),
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
      message: withPromptTarget("Select recent jobs", env),
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

async function promptForJobSearch(options: {
  allowBack?: boolean;
  env: EnvConfig;
}): Promise<string> {
  const response = await text({
    message: withPromptTarget("Job name or description", options.env),
    placeholder: "e.g. api prod deploy",
  });
  if (isCancel(response)) {
    if (options.allowBack) {
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
        message: withPromptTarget(`${reason} Refresh now?`, options.env),
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
  env: EnvConfig;
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
        env: options.env,
      });
    }

    try {
      const candidates = resolveJobCandidates(query, options.jobs);
      if (candidates.length === 1) {
        return candidates;
      }

      const selection = await promptForJobSelection(candidates, options.env);
      if (selection.kind === "search") {
        query = await promptForJobSearch({
          allowBack: options.allowBackToRecent,
          env: options.env,
        });
        continue;
      }
      return selection.jobs;
    } catch (err) {
      if (err instanceof CliError && shouldRetryJobSearch(err)) {
        printError(err.message);
        for (const hint of err.hints) {
          printHint(hint);
        }
        query = await promptForJobSearch({
          allowBack: options.allowBackToRecent,
          env: options.env,
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

function ensureValidUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw new CliError(`Invalid --${label} value.`, [
      `Provide a full URL like https://jenkins.example.com/job/example/.`,
    ]);
  }
}
