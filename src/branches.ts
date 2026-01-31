/**
 * Branch selection cache for build command.
 * Stores recently used branches per job inside jobs.json.
 */
import type { EnvConfig } from "./env";
import { readJobCache, writeJobCache } from "./jobs";

const MAX_BRANCHES_PER_JOB = 10;
const DEFAULT_BRANCHES = ["development", "staging", "master"];
const DEFAULT_BRANCH_SET = new Set(
  DEFAULT_BRANCHES.map((branch) => branch.toLowerCase()),
);

export async function loadCachedBranches(options: {
  env: EnvConfig;
  jobUrl: string;
}): Promise<string[]> {
  const cached = await loadCachedBranchHistory(options);
  return dedupePreserveOrder([...cached, ...DEFAULT_BRANCHES]);
}

export async function loadCachedBranchHistory(options: {
  env: EnvConfig;
  jobUrl: string;
}): Promise<string[]> {
  const cache = await readJobCache();
  if (!cache || !cacheMatchesEnv(cache, options.env)) {
    return [];
  }
  const job = cache.jobs.find((entry) => entry.url === options.jobUrl);
  const entries = job?.branches;
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized = entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !isDefaultBranch(entry));
  return dedupePreserveOrder(normalized);
}

export async function removeCachedBranch(options: {
  env: EnvConfig;
  jobUrl: string;
  branch: string;
}): Promise<boolean> {
  const target = options.branch.trim();
  if (!target || isDefaultBranch(target)) {
    return false;
  }
  const cache = await readJobCache();
  if (!cache || !cacheMatchesEnv(cache, options.env)) {
    return false;
  }
  const job = cache.jobs.find((entry) => entry.url === options.jobUrl);
  if (!job || !Array.isArray(job.branches) || job.branches.length === 0) {
    return false;
  }
  const updated = job.branches.filter(
    (entry) => entry.toLowerCase() !== target.toLowerCase(),
  );
  if (updated.length === job.branches.length) {
    return false;
  }
  job.branches = updated;
  await writeJobCache(cache);
  return true;
}

export async function recordBranchSelection(options: {
  env: EnvConfig;
  jobUrl: string;
  branch: string;
}): Promise<void> {
  const normalizedBranch = options.branch.trim();
  if (!normalizedBranch) {
    return;
  }
  const cache = await readJobCache();
  if (!cache || !cacheMatchesEnv(cache, options.env)) {
    return;
  }
  const job = cache.jobs.find((entry) => entry.url === options.jobUrl);
  if (!job) {
    return;
  }
  const existingBranches = Array.isArray(job.branches)
    ? job.branches
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  const deduped = existingBranches.filter(
    (entry) => entry.toLowerCase() !== normalizedBranch.toLowerCase(),
  );
  job.branches = [normalizedBranch, ...deduped].slice(0, MAX_BRANCHES_PER_JOB);
  await writeJobCache(cache);
}

function cacheMatchesEnv(
  cache: { jenkinsUrl: string; user: string },
  env: EnvConfig,
): boolean {
  return cache.jenkinsUrl === env.jenkinsUrl && cache.user === env.jenkinsUser;
}

function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCH_SET.has(branch.toLowerCase());
}

function dedupePreserveOrder(entries: string[]): string[] {
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
