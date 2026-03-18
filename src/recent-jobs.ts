/**
 * Recent job cache stored inside jobs.json.
 */
import type { JenkinsJob } from "./types/jenkins";
import type { EnvConfig } from "./env";
import type { JobCache } from "./jobs";
import { getJobUrlKey } from "./job-url";
import { readJobCache, sortJobsByDisplayName, writeJobCache } from "./jobs";
import {
  MAX_RECENT_JOBS,
  normalizeRecentJobs,
  normalizeRecentJobUrl,
} from "./recent-job-data";

export type RecentJob = {
  url: string;
  label: string;
};

export async function loadRecentJobs(options: {
  env: EnvConfig;
}): Promise<RecentJob[]> {
  const cache = await readUsableCache(options.env);
  if (!cache) {
    return [];
  }

  const jobsByUrl = buildJobsByUrl(cache.jobs);
  return normalizeRecentJobs(cache.recentJobs).map((url) =>
    toRecentJob(url, jobsByUrl),
  );
}

export async function loadPreferredJobs(options: {
  env: EnvConfig;
  jobs: JenkinsJob[];
}): Promise<JenkinsJob[]> {
  const cache = await readUsableCache(options.env);
  if (!cache) {
    return sortJobsByDisplayName(options.jobs);
  }

  const jobsByUrl = buildJobsByUrl(options.jobs);
  const preferredJobs = normalizeRecentJobs(cache.recentJobs)
    .map((url) => jobsByUrl.get(getJobUrlKey(url) ?? ""))
    .filter((job): job is JenkinsJob => Boolean(job));
  if (preferredJobs.length === 0) {
    return sortJobsByDisplayName(options.jobs);
  }

  const seen = new Set(preferredJobs.map((job) => getJobUrlKey(job.url) ?? ""));
  const remainingJobs = sortJobsByDisplayName(options.jobs).filter(
    (job) => !seen.has(getJobUrlKey(job.url) ?? ""),
  );
  return [...preferredJobs, ...remainingJobs];
}

export async function recordRecentJob(options: {
  env: EnvConfig;
  jobUrl: string;
}): Promise<void> {
  try {
    const jobUrl = normalizeRecentJobUrl(options.jobUrl);
    if (!jobUrl) {
      return;
    }

    const cache = await readUsableCache(options.env);
    if (!cache) {
      return;
    }

    const jobUrlKey = getJobUrlKey(jobUrl);
    const recentJobs = [
      jobUrl,
      ...normalizeRecentJobs(cache.recentJobs).filter(
        (entry) => getJobUrlKey(entry) !== jobUrlKey,
      ),
    ].slice(0, MAX_RECENT_JOBS);

    await writeJobCache({
      ...cache,
      recentJobs,
    });
  } catch {
    // Ignore recent job cache write failures.
  }
}

function cacheMatchesEnv(
  cache: { jenkinsUrl: string; user: string },
  env: EnvConfig,
): boolean {
  return cache.jenkinsUrl === env.jenkinsUrl && cache.user === env.jenkinsUser;
}

async function readUsableCache(env: EnvConfig): Promise<JobCache | null> {
  const cache = await readJobCache(env);
  return cache && cacheMatchesEnv(cache, env) ? cache : null;
}

function buildJobsByUrl<T extends { url: string }>(jobs: T[]): Map<string, T> {
  const jobsByUrl = new Map<string, T>();
  for (const job of jobs) {
    const key = getJobUrlKey(job.url);
    if (!key) {
      continue;
    }
    jobsByUrl.set(key, job);
  }

  return jobsByUrl;
}

function toRecentJob(
  url: string,
  jobsByUrl: Map<string, { name: string; fullName?: string }>,
): RecentJob {
  const job = jobsByUrl.get(getJobUrlKey(url) ?? "");
  return {
    url,
    label: job ? job.fullName || job.name : url,
  };
}
