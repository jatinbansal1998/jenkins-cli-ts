import { CliError } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import { normalizeOptionalJobUrl } from "../job-url";
import { pickJobs, type JobPickerResult } from "../job-picker";
import type { JenkinsJob } from "../types/jenkins";
import { getJobDisplayName, loadJobs, resolveJobMatch } from "../jobs";

export function ensureValidUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw new CliError(`Invalid --${label} value.`, [
      `Provide a full URL like https://jenkins.example.com/job/example/.`,
    ]);
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
    throw new CliError("Operation cancelled.");
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
    ensureValidUrl(providedUrl, "job-url");
    return [
      {
        jobUrl: providedUrl,
        jobLabel: providedUrl,
      },
    ];
  }

  const jobs = await loadJobs({
    client: options.client,
    env: options.env,
    nonInteractive: options.nonInteractive,
  });
  if (jobs.length === 0) {
    throw new CliError("No jobs found in cache.", [
      "Run `jenkins-cli list --refresh` to fetch jobs from Jenkins.",
    ]);
  }

  const query = options.job?.trim() ?? "";
  if (!query && options.nonInteractive) {
    throw new CliError("Missing required --job.", [
      "Pass --job <name> or use --job-url <url>.",
    ]);
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
    throw new CliError("Operation cancelled.");
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
    throw new CliError("Selected job has an invalid URL.", [
      "Run `jenkins-cli list --refresh` to update the cache.",
    ]);
  }
  ensureValidUrl(normalizedJobUrl, "job-url");
  return {
    jobUrl: normalizedJobUrl,
    jobLabel: getJobDisplayName({ ...job, url: normalizedJobUrl }),
  };
}

export function parseDurationMs(
  input: string | undefined,
  label: string,
): number {
  const value = input?.trim() ?? "";
  if (!value) {
    throw new CliError(`Missing --${label}.`, [
      `Provide --${label} with a duration like 30s, 5m, or 1h.`,
    ]);
  }
  const match = value.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    throw new CliError(`Invalid --${label} value "${value}".`, [
      "Use duration values like 500ms, 30s, 5m, or 1h.",
    ]);
  }

  const amount = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  const multiplier = multipliers[unit];
  if (!multiplier || !Number.isFinite(amount) || amount < 0) {
    throw new CliError(`Invalid --${label} value "${value}".`, [
      "Use duration values like 500ms, 30s, 5m, or 1h.",
    ]);
  }
  return Math.floor(amount * multiplier);
}

export function parseOptionalDurationMs(
  input: string | undefined,
  fallbackMs: number,
  label: string,
): number {
  if (!input || !input.trim()) {
    return fallbackMs;
  }
  return parseDurationMs(input, label);
}
