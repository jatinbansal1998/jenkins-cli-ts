/**
 * Build command implementation.
 * Triggers a Jenkins build for a specified job with branch parameter support.
 */
import { confirm, isCancel, select, text } from "@clack/prompts";
import { CliError, printOk } from "../cli";
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

  const branchParam = (options.branchParam || "BRANCH").trim();
  if (!branchParam) {
    throw new CliError("Invalid --branch-param value.", [
      "Provide a non-empty parameter name (e.g., BRANCH).",
    ]);
  }

  let jobUrl = options.jobUrl?.trim() ?? "";
  let jobLabel = jobUrl;

  if (jobUrl) {
    ensureValidUrl(jobUrl, "job-url");
  } else {
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

    let query = options.job?.trim() ?? "";
    if (!query) {
      if (options.nonInteractive) {
        throw new CliError("Missing required --job.", [
          "Pass --job <name> or use --job-url <url>.",
        ]);
      }
      const response = await text({
        message: "Job name or description",
        placeholder: "e.g. api prod deploy",
      });
      if (isCancel(response)) {
        throw new CliError("Operation cancelled.");
      }
      query = String(response).trim();
    }

    const selectedJob = await resolveJobMatch({
      query,
      jobs,
      nonInteractive: options.nonInteractive,
      selectFromOptions: async (candidates) =>
        promptForJobSelection(candidates),
    });

    jobUrl = selectedJob.url;
    jobLabel = getJobDisplayName(selectedJob);
  }

  let branch = options.branch?.trim() ?? "";
  if (!options.defaultBranch && !branch) {
    const response = await text({
      message: "Branch name",
      placeholder: "e.g. main",
    });
    if (isCancel(response)) {
      throw new CliError("Operation cancelled.");
    }
    branch = String(response).trim();
  }

  if (!options.defaultBranch && !branch) {
    throw new CliError("Branch is required to trigger a build.", [
      "Pass --branch <name> or use --default-branch to use the job default.",
    ]);
  }

  const params = options.defaultBranch ? {} : { [branchParam]: branch };
  const result = await options.client.triggerBuild(jobUrl, params);

  if (result.queueUrl) {
    printOk(`Build queued at ${result.queueUrl}.`);
  } else {
    printOk(`Build triggered for ${jobLabel || jobUrl}.`);
  }
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

function ensureValidUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw new CliError(`Invalid --${label} value.`, [
      `Provide a full URL like https://jenkins.example.com/job/example/.`,
    ]);
  }
}
