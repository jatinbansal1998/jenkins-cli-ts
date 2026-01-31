/**
 * Job caching and fuzzy matching.
 * Caches jobs locally in .jenkins-cli/jobs.json and provides
 * natural language search with scoring for job lookups.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./cli";
import type { EnvConfig } from "./env";
import type { JenkinsClient, JenkinsJob } from "./jenkins/client";

/** Cached job data with metadata. */
export type JobCache = {
  jenkinsUrl: string;
  user: string;
  fetchedAt: string;
  jobs: JenkinsJob[];
};

const CACHE_DIR = path.join(process.cwd(), ".jenkins-cli");
const CACHE_FILE = path.join(CACHE_DIR, "jobs.json");

const TRIVIAL_TOKENS = new Set(["job", "jobs", "build", "trigger"]);
const MIN_SCORE = 30;
const AMBIGUITY_GAP = 8;
const MAX_OPTIONS = 10;

export function getJobDisplayName(job: JenkinsJob): string {
  return job.fullName || job.name;
}

export async function loadJobs(options: {
  client: JenkinsClient;
  env: EnvConfig;
  refresh?: boolean;
  nonInteractive: boolean;
  confirmRefresh?: (reason: string) => Promise<boolean>;
}): Promise<JenkinsJob[]> {
  const cache = await readJobCache();
  const isCacheUsable = cache && cacheMatchesEnv(cache, options.env);

  if (options.refresh) {
    return await fetchAndCacheJobs(options.client, options.env);
  }

  if (isCacheUsable) {
    return cache.jobs;
  }

  const reason = cache
    ? "Job cache does not match the current Jenkins URL or user."
    : "Job cache is missing.";

  const hints = [
    "Run `jenkins-cli list --refresh` to rebuild the cache.",
    "Or pass `--job-url` to skip cache matching.",
  ];

  if (options.nonInteractive) {
    throw new CliError(reason, hints);
  }

  if (options.confirmRefresh) {
    const shouldRefresh = await options.confirmRefresh(reason);
    if (shouldRefresh) {
      return await fetchAndCacheJobs(options.client, options.env);
    }
  }

  throw new CliError(reason, hints);
}

export async function readJobCache(): Promise<JobCache | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as JobCache;
    if (!isValidCache(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function fetchAndCacheJobs(
  client: JenkinsClient,
  env: EnvConfig,
): Promise<JenkinsJob[]> {
  const jobs = await client.listJobs();
  const payload: JobCache = {
    jenkinsUrl: env.jenkinsUrl,
    user: env.jenkinsUser,
    fetchedAt: new Date().toISOString(),
    jobs,
  };
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(payload, null, 2), "utf-8");
  return jobs;
}

function cacheMatchesEnv(cache: JobCache, env: EnvConfig): boolean {
  return cache.jenkinsUrl === env.jenkinsUrl && cache.user === env.jenkinsUser;
}

function isValidCache(cache: JobCache | null): cache is JobCache {
  if (!cache) {
    return false;
  }
  return (
    typeof cache.jenkinsUrl === "string" &&
    typeof cache.user === "string" &&
    typeof cache.fetchedAt === "string" &&
    Array.isArray(cache.jobs)
  );
}

export type RankedJob = {
  job: JenkinsJob;
  score: number;
};

export function rankJobs(query: string, jobs: JenkinsJob[]): RankedJob[] {
  const normalizedQuery = normalizeText(query);
  const queryTokens = tokenize(normalizedQuery);

  const ranked: RankedJob[] = [];
  for (const job of jobs) {
    const candidates = [job.name, job.fullName].filter(
      (value): value is string => Boolean(value),
    );
    let bestScore = 0;
    for (const candidate of candidates) {
      const candidateNormalized = normalizeText(candidate);
      const score = scoreCandidate(
        normalizedQuery,
        queryTokens,
        candidateNormalized,
      );
      if (score > bestScore) {
        bestScore = score;
      }
    }

    if (bestScore > 0) {
      ranked.push({ job, score: bestScore });
    }
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return getJobDisplayName(a.job).localeCompare(getJobDisplayName(b.job));
  });

  return ranked;
}

export async function resolveJobMatch(options: {
  query: string;
  jobs: JenkinsJob[];
  nonInteractive: boolean;
  selectFromOptions?: (options: JenkinsJob[]) => Promise<JenkinsJob>;
}): Promise<JenkinsJob> {
  const trimmedQuery = options.query.trim();
  if (!trimmedQuery) {
    throw new CliError("Job name is required.", [
      "Pass --job <name> or use --job-url <url>.",
    ]);
  }

  const ranked = rankJobs(trimmedQuery, options.jobs);
  const topMatch = ranked[0];

  if (!topMatch || topMatch.score < MIN_SCORE) {
    throw new CliError(`No jobs match "${trimmedQuery}".`, [
      "Try a different description or run `jenkins-cli list --refresh`.",
      "Or pass `--job-url` to skip cache matching.",
    ]);
  }

  const topScore = topMatch.score;
  const closeMatches = ranked.filter(
    (match) => match.score >= MIN_SCORE && topScore - match.score <= AMBIGUITY_GAP,
  );

  const firstMatch = closeMatches[0];
  if (closeMatches.length === 1 && firstMatch) {
    return firstMatch.job;
  }

  const optionsList = closeMatches.slice(0, MAX_OPTIONS).map((match) => match.job);
  if (options.nonInteractive || !options.selectFromOptions) {
    const optionNames = optionsList.map(getJobDisplayName).join(", ");
    throw new CliError(`Job name is ambiguous for "${trimmedQuery}".`, [
      `Options: ${optionNames}`,
      "Pass `--job <exact name>` or `--job-url <url>`.",
    ]);
  }

  return options.selectFromOptions(optionsList);
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input: string): string[] {
  if (!input) {
    return [];
  }
  return input
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !TRIVIAL_TOKENS.has(token));
}

function scoreCandidate(
  normalizedQuery: string,
  queryTokens: string[],
  candidate: string,
): number {
  if (!normalizedQuery || !candidate) {
    return 0;
  }

  if (candidate === normalizedQuery) {
    return 100;
  }

  if (candidate.startsWith(normalizedQuery)) {
    return 80;
  }

  if (candidate.includes(normalizedQuery)) {
    return 60;
  }

  if (queryTokens.length === 0) {
    return 0;
  }

  const candidateTokens = new Set(candidate.split(" "));
  const overlap = queryTokens.filter((token) => candidateTokens.has(token)).length;
  if (overlap === 0) {
    return 0;
  }

  const ratio = overlap / queryTokens.length;
  return Math.round(ratio * 40);
}
