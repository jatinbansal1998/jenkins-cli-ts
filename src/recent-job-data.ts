import type { JenkinsJob } from "./types/jenkins";
import { getJobUrlKey, normalizeJobUrl } from "./job-url";

export const MAX_RECENT_JOBS = 20;

export function normalizeRecentJobUrl(value: string): string {
  return normalizeJobUrl(value);
}

export function normalizeRecentJobs(entries: unknown[] | undefined): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  const deduped = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }

    const canonical = normalizeRecentJobUrl(entry);
    if (!canonical) {
      continue;
    }

    const key = getJobUrlKey(canonical);
    if (!key) {
      continue;
    }
    if (deduped.has(key)) {
      continue;
    }

    deduped.add(key);
    normalized.push(canonical);
  }

  return normalized;
}

export function pruneRecentJobs(options: {
  jobs: Pick<JenkinsJob, "url">[];
  recentJobs?: unknown[];
}): string[] | undefined {
  const activeUrls = buildCanonicalUrlMap(options.jobs);
  const recentJobs = normalizeRecentJobs(options.recentJobs)
    .map((jobUrl) => activeUrls.get(getJobUrlKey(jobUrl) ?? ""))
    .filter((jobUrl): jobUrl is string => Boolean(jobUrl));

  return recentJobs.length > 0 ? recentJobs : undefined;
}

export function buildCanonicalUrlMap(
  jobs: Pick<JenkinsJob, "url">[],
): Map<string, string> {
  const activeUrls = new Map<string, string>();
  for (const job of jobs) {
    const canonicalUrl = normalizeRecentJobUrl(job.url);
    if (!canonicalUrl) {
      continue;
    }
    const key = getJobUrlKey(canonicalUrl);
    if (!key) {
      continue;
    }
    activeUrls.set(key, canonicalUrl);
  }
  return activeUrls;
}
