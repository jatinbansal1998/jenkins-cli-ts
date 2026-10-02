/**
 * Branch selection cache for build command.
 * Stores recently used branches per job in the job state file.
 */
import type { EnvConfig } from "./env";
import { getJobUrlKey } from "./job-url";
import { readJobState, updateJobState } from "./job-state";

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
  const jobKey = getJobUrlKey(options.jobUrl);
  if (!jobKey) {
    return [];
  }
  const { branches } = await readJobState(options.env.jenkinsUrl);
  const normalized = (branches[jobKey] ?? [])
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
  const jobKey = getJobUrlKey(options.jobUrl);
  if (!target || isDefaultBranch(target) || !jobKey) {
    return false;
  }
  let removed = false;
  await updateJobState(options.env.jenkinsUrl, (state) => {
    const existing = state.branches[jobKey] ?? [];
    const updated = removeBranch(existing, target);
    if (updated.length === existing.length) {
      return undefined;
    }
    removed = true;
    return { ...state, branches: { ...state.branches, [jobKey]: updated } };
  });
  return removed;
}

export async function recordBranchSelection(options: {
  env: EnvConfig;
  jobUrl: string;
  branch: string;
}): Promise<void> {
  const branch = options.branch.trim();
  const jobKey = getJobUrlKey(options.jobUrl);
  if (!branch || !jobKey) {
    return;
  }
  await updateJobState(options.env.jenkinsUrl, (state) => {
    const existing = state.branches[jobKey] ?? [];
    if (existing[0] === branch) {
      return undefined;
    }
    const updated = [branch, ...removeBranch(existing, branch)].slice(
      0,
      MAX_BRANCHES_PER_JOB,
    );
    return { ...state, branches: { ...state.branches, [jobKey]: updated } };
  });
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
