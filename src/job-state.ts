/**
 * Small per-controller user state: recent jobs, branch history and known
 * stage totals. It lives apart from the job list so everyday commands never
 * rewrite that large file, and every change is a read-modify-write under a
 * lock so concurrent commands cannot drop each other's updates.
 */
import { mkdir } from "node:fs/promises";
import { lock } from "proper-lockfile";
import { getJobCacheDir, getJobStatePath, writeJsonFile } from "./jobs";
import { normalizeRecentJobs } from "./recent-job-data";

export type KnownStageTotal = {
  totalStages: number;
  updatedAt: string;
};

/** `branches` and `knownStageTotals` are keyed by `getJobUrlKey`. */
export type JobState = {
  recentJobs: string[];
  branches: Record<string, string[]>;
  knownStageTotals: Record<string, KnownStageTotal>;
};

export async function readJobState(jenkinsUrl: string): Promise<JobState> {
  try {
    const raw = await Bun.file(getJobStatePath(jenkinsUrl)).text();
    return parseJobState(JSON.parse(raw));
  } catch {
    return { recentJobs: [], branches: {}, knownStageTotals: {} };
  }
}

/**
 * `update` returns the next state, or undefined when nothing changed so the
 * write is skipped.
 */
export async function updateJobState(
  jenkinsUrl: string,
  update: (state: JobState) => JobState | undefined,
): Promise<void> {
  const statePath = getJobStatePath(jenkinsUrl);
  await mkdir(getJobCacheDir(), { recursive: true });
  const release = await lock(statePath, {
    realpath: false,
    retries: { retries: 12, minTimeout: 20, maxTimeout: 100 },
  });
  try {
    const next = update(await readJobState(jenkinsUrl));
    if (next) {
      await writeJsonFile(statePath, next);
    }
  } finally {
    await release();
  }
}

function parseJobState(value: unknown): JobState {
  const record = isRecord(value) ? value : {};
  return {
    recentJobs: normalizeRecentJobs(record.recentJobs),
    branches: parseBranches(record.branches),
    knownStageTotals: parseKnownStageTotals(record.knownStageTotals),
  };
}

function parseBranches(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!isRecord(value)) {
    return result;
  }
  for (const [jobKey, entries] of Object.entries(value)) {
    if (Array.isArray(entries)) {
      result[jobKey] = entries.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }
  }
  return result;
}

function parseKnownStageTotals(
  value: unknown,
): Record<string, KnownStageTotal> {
  const result: Record<string, KnownStageTotal> = {};
  if (!isRecord(value)) {
    return result;
  }
  for (const [jobKey, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      continue;
    }
    const { totalStages, updatedAt } = entry;
    if (
      typeof totalStages === "number" &&
      Number.isFinite(totalStages) &&
      totalStages > 0 &&
      typeof updatedAt === "string"
    ) {
      result[jobKey] = { totalStages, updatedAt };
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
