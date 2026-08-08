/**
 * Branch selection cache for build command.
 * Stores recently used branches per job inside jobs.json.
 */
import type { EnvConfig } from "./env";
import { findJobByUrl } from "./job-url";
import { readUsableJobCache, writeJobCache } from "./jobs";

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
  return dedupeCaseInsensitive([...cached, ...DEFAULT_BRANCHES]);
}

export async function loadCachedBranchHistory(options: {
  env: EnvConfig;
  jobUrl: string;
}): Promise<string[]> {
  const cache = await readUsableJobCache(options.env);
  if (!cache) {
    return [];
  }
  const job = findJobByUrl(cache.jobs, options.jobUrl);
  const entries = job?.branches;
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized = entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !isDefaultBranch(entry));
  return dedupeCaseInsensitive(normalized);
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
  const cache = await readUsableJobCache(options.env);
  if (!cache) {
    return false;
  }
  const job = findJobByUrl(cache.jobs, options.jobUrl);
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
  const cache = await readUsableJobCache(options.env);
  if (!cache) {
    return;
  }
  const job = findJobByUrl(cache.jobs, options.jobUrl);
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

function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCH_SET.has(branch.toLowerCase());
}

export function dedupeCaseInsensitive(entries: string[]): string[] {
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

export function removeBranch(entries: string[], target: string): string[] {
  const key = target.toLowerCase();
  return entries.filter((entry) => entry.toLowerCase() !== key);
}
