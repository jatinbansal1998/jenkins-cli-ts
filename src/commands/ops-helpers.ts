import { confirm, isCancel, select, text } from "@clack/prompts";
import { CliError, printError, printHint } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import type { JenkinsJob } from "../types/jenkins";
import {
  getJobDisplayName,
  loadJobs,
  resolveJobCandidates,
  resolveJobMatch,
} from "../jobs";

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
  const providedUrl = options.jobUrl?.trim() ?? "";
  if (providedUrl) {
    ensureValidUrl(providedUrl, "job-url");
    return {
      jobUrl: providedUrl,
      jobLabel: providedUrl,
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

  const selectedJob = await resolveJobFromQuery({
    job: options.job,
    jobs,
    nonInteractive: options.nonInteractive,
  });
  return {
    jobUrl: selectedJob.url,
    jobLabel: getJobDisplayName(selectedJob),
  };
}

async function resolveJobFromQuery(options: {
  job?: string;
  jobs: JenkinsJob[];
  nonInteractive: boolean;
}): Promise<JenkinsJob> {
  let query = options.job?.trim() ?? "";

  if (!query && options.nonInteractive) {
    throw new CliError("Missing required --job.", [
      "Pass --job <name> or use --job-url <url>.",
    ]);
  }

  while (true) {
    if (!query) {
      const response = await text({
        message: "Job name or description",
        placeholder: "e.g. api prod deploy",
      });
      if (isCancel(response)) {
        throw new CliError("Operation cancelled.");
      }
      query = String(response).trim();
    }

    try {
      if (options.nonInteractive) {
        return await resolveJobMatch({
          query,
          jobs: options.jobs,
          nonInteractive: true,
        });
      }

      const candidates = resolveJobCandidates(query, options.jobs);
      if (candidates.length === 1) {
        // Length check guarantees an entry here; keep fallback for defensive flow.
        const first = candidates[0];
        if (first) {
          return first;
        }
        printError("Unable to resolve selected job.");
        query = "";
        continue;
      }
      const selected = await select({
        message: "Select a job",
        options: candidates.map((job) => ({
          value: job.url,
          label: getJobDisplayName(job),
        })),
      });
      if (isCancel(selected)) {
        query = "";
        continue;
      }
      const match = candidates.find((candidate) => candidate.url === selected);
      if (!match) {
        printError("Selected job is no longer available.");
        printHint("Run `jenkins-cli list --refresh` to update the cache.");
        query = "";
        continue;
      }
      return match;
    } catch (error) {
      if (error instanceof CliError && !options.nonInteractive) {
        printError(error.message);
        for (const hint of error.hints) {
          printHint(hint);
        }
        query = "";
        continue;
      }
      throw error;
    }
  }
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
