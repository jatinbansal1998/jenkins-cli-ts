/**
 * Recent job cache stored inside jobs.json.
 */
import type { EnvConfig } from "./env";
import { getJobDisplayName, readJobCache, writeJobCache } from "./jobs";

const MAX_RECENT_JOBS = 15;

type RecentJob = {
  url: string;
  label: string;
};

export async function loadRecentJobs(options: {
  env: EnvConfig;
}): Promise<RecentJob[]> {
  const cache = await readJobCache();
  if (!cache || !cacheMatchesEnv(cache, options.env)) {
    return [];
  }
  const recentJobs = normalizeRecentJobs(cache.recentJobs);
  if (recentJobs.length === 0) {
    return [];
  }
  return recentJobs.map((url) => ({
    url,
    label: resolveJobLabel(cache.jobs, url),
  }));
}

export async function recordRecentJob(options: {
  env: EnvConfig;
  jobUrl: string;
}): Promise<void> {
  const jobUrl = options.jobUrl.trim();
  if (!jobUrl) {
    return;
  }
  const cache = await readJobCache();
  if (!cache || !cacheMatchesEnv(cache, options.env)) {
    return;
  }
  const existing = normalizeRecentJobs(cache.recentJobs);
  const deduped = existing.filter(
    (url) => url.toLowerCase() !== jobUrl.toLowerCase(),
  );
  cache.recentJobs = [jobUrl, ...deduped].slice(0, MAX_RECENT_JOBS);
  await writeJobCache(cache);
}

function cacheMatchesEnv(
  cache: { jenkinsUrl: string; user: string },
  env: EnvConfig,
): boolean {
  return cache.jenkinsUrl === env.jenkinsUrl && cache.user === env.jenkinsUser;
}

function normalizeRecentJobs(recentJobs: string[] | undefined): string[] {
  if (!Array.isArray(recentJobs)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of recentJobs) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function resolveJobLabel(
  jobs: { url: string; name: string; fullName?: string }[],
  url: string,
): string {
  const job = jobs.find((entry) => entry.url === url);
  return job ? getJobDisplayName(job) : url;
}
