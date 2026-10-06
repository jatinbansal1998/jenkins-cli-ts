import { CliError } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import { normalizeControllerTargetUrl } from "../jenkins-target-url";
import { normalizeOptionalJobUrl } from "../job-url";
import { pickJobs, type JobPickerResult } from "../job-picker";
import type { JenkinsJob } from "../types/jenkins";
import { getJobDisplayName, loadJobs, resolveJobMatch } from "../jobs";

export function ensureValidUrl(value: string, label: string): void {
  if (!URL.canParse(value)) {
    throw new CliError(
      `Invalid --${label} value.`,
      [`Provide a full URL like https://jenkins.example.com/job/example/.`],
      "INVALID_USAGE",
    );
  }
}

export async function resolveJobTarget(options: {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
}): Promise<{ jobUrl: string; jobLabel: string }> {
  const targets = await resolveJobTargets({ ...options, mode: "single" });
  const target = targets[0];
  if (!target) {
    throw new CliError("Operation cancelled.", [], "OPERATION_CANCELLED");
  }
  return target;
}

export async function resolveJobTargets(options: {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
  mode: "single" | "multiple";
  pickJobs?: typeof pickJobs;
}): Promise<{ jobUrl: string; jobLabel: string }[]> {
  const providedUrl = normalizeOptionalJobUrl(options.jobUrl);
  if (providedUrl) {
    const controllerUrl = normalizeControllerTargetUrl(
      providedUrl,
      options.env.jenkinsUrl,
      "job-url",
    );
    return [
      {
        jobUrl: controllerUrl,
        jobLabel: controllerUrl,
      },
    ];
  }

  const jobs = await loadJobs({
    client: options.client,
    env: options.env,
  });
  if (jobs.length === 0) {
    throw new CliError(
      "No jobs found in cache.",
      ["Run `jenkins-cli list --refresh` to fetch jobs from Jenkins."],
      "JOB_CACHE_EMPTY",
    );
  }

  const query = options.job?.trim() ?? "";
  if (!query && options.nonInteractive) {
    throw new CliError(
      "Missing required --job.",
      ["Pass --job <name> or use --job-url <url>."],
      "INVALID_USAGE",
    );
  }
  let selection: JobPickerResult;
  if (options.nonInteractive) {
    selection = {
      kind: "selected",
      jobs: [
        await resolveJobMatch({
          query,
          jobs,
          nonInteractive: true,
        }),
      ],
    };
  } else if (query) {
    const candidates = await resolveInitialCandidates(query, jobs);
    if (candidates.length === 1 && options.mode === "single") {
      selection = { kind: "selected", jobs: candidates };
    } else {
      selection = await (options.pickJobs ?? pickJobs)({
        env: options.env,
        jobs: candidates,
        mode: options.mode,
        initialQuery: query,
      });
    }
  } else {
    selection = await (options.pickJobs ?? pickJobs)({
      env: options.env,
      jobs,
      mode: options.mode,
    });
  }
  if (selection.kind === "cancelled") {
    throw new CliError("Operation cancelled.", [], "OPERATION_CANCELLED");
  }
  return selection.jobs.map(toResolvedJobTarget);
}

async function resolveInitialCandidates(
  query: string,
  jobs: JenkinsJob[],
): Promise<JenkinsJob[]> {
  try {
    return [await resolveJobMatch({ query, jobs, nonInteractive: true })];
  } catch (error) {
    if (
      error instanceof CliError &&
      (error.message.startsWith("Job name is ambiguous") ||
        error.message.startsWith("No jobs match "))
    ) {
      return jobs;
    }
    throw error;
  }
}

function toResolvedJobTarget(job: JenkinsJob): {
  jobUrl: string;
  jobLabel: string;
} {
  const normalizedJobUrl = normalizeOptionalJobUrl(job.url);
  if (!normalizedJobUrl) {
    throw new CliError(
      "Selected job has an invalid URL.",
      ["Run `jenkins-cli list --refresh` to update the cache."],
      "JENKINS_INVALID_RESPONSE",
    );
  }
  ensureValidUrl(normalizedJobUrl, "job-url");
  return {
    jobUrl: normalizedJobUrl,
    jobLabel: getJobDisplayName({ ...job, url: normalizedJobUrl }),
  };
}
