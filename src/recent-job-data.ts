import { getJobUrlKey, normalizeJobUrl } from "./job-url";

export const MAX_RECENT_JOBS = 20;

export function normalizeRecentJobs(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  const deduped = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }

    const canonical = normalizeJobUrl(entry);
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
