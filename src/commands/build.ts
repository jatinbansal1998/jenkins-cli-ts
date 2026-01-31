/**
 * Build command implementation.
 * Triggers a Jenkins build for a specified job with branch parameter support.
 */
import { confirm, isCancel, select, text } from "@clack/prompts";
import { CliError, printOk } from "../cli";
import {
  loadCachedBranchHistory,
  loadCachedBranches,
  recordBranchSelection,
  removeCachedBranch,
} from "../branches.ts";
import { loadRecentJobs, recordRecentJob } from "../recent-jobs.ts";
import type { EnvConfig } from "../env";
import type { JenkinsClient, JenkinsJob } from "../jenkins/client";
import { getJobDisplayName, loadJobs, resolveJobMatch } from "../jobs";

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
};

export async function runBuild(options: BuildOptions): Promise<void> {
  validateBuildOptions(options);
  const branchParam = normalizeBranchParam(options.branchParam);

  const { jobUrl, jobLabel, matchedFromSearch } = await resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: options.nonInteractive,
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

  const params = options.defaultBranch ? {} : { [branchParam]: branch };
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

  if (result.queueUrl) {
    printOk(`Build queued at ${result.queueUrl}.`);
  } else {
    printOk(`Build triggered for ${jobLabel || jobUrl}.`);
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

function normalizeBranchParam(value?: string): string {
  const branchParam = (value || "BRANCH").trim();
  if (!branchParam) {
    throw new CliError("Invalid --branch-param value.", [
      "Provide a non-empty parameter name (e.g., BRANCH).",
    ]);
  }
  return branchParam;
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

  const selectedJob = await resolveJobMatch({
    query: selection.query,
    jobs,
    nonInteractive: options.nonInteractive,
    selectFromOptions: async (candidates) => promptForJobSelection(candidates),
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
): Promise<JenkinsJob> {
  const response = await select({
    message: "Select a job",
    options: candidates.map((job) => ({
      value: job.url,
      label: getJobDisplayName(job),
    })),
  });

  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }

  const selected = candidates.find((job) => job.url === response);
  if (!selected) {
    throw new CliError("Selected job is no longer available.", [
      "Run `jenkins-cli list --refresh` to update the cache.",
    ]);
  }

  return selected;
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
