/**
 * Job caching and fuzzy matching.
 * Caches jobs locally in .jenkins-cli/jobs.json and provides
 * natural language search with scoring for job lookups.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./cli";
import { MIN_SCORE, AMBIGUITY_GAP, MAX_OPTIONS } from "./config/fuzzy";
import type { EnvConfig } from "./env";
import type { JenkinsClient, JenkinsJob } from "./jenkins/client";

/** Cached job data with metadata. */
export type CachedJob = JenkinsJob & {
  branches?: string[];
};

export type JobCache = {
  jenkinsUrl: string;
  user: string;
  fetchedAt: string;
  jobs: CachedJob[];
  recentJobs?: string[];
};

const CACHE_DIR = path.join(process.cwd(), ".jenkins-cli");
const CACHE_FILE = path.join(CACHE_DIR, "jobs.json");

/** Analyze all jobs to identify frequently-occurring (trivial) tokens.
 * Tokens appearing in >30% of jobs are considered trivial and weighted lower.
 */
function analyzeTokenFrequencies(jobs: JenkinsJob[]): Map<string, number> {
  const tokenCounts = new Map<string, number>();
  const totalJobs = jobs.length;

  for (const job of jobs) {
    const tokens = new Set(
      job.name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 0),
    );
    for (const token of tokens) {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }
  }

  // Convert counts to frequencies (0-1)
  const tokenFrequencies = new Map<string, number>();
  for (const [token, count] of tokenCounts) {
    tokenFrequencies.set(token, count / totalJobs);
  }

  return tokenFrequencies;
}

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
    normalizeCachedJobs(parsed.jobs);
    return parsed;
  } catch {
    return null;
  }
}

export async function writeJobCache(cache: JobCache): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

async function fetchAndCacheJobs(
  client: JenkinsClient,
  env: EnvConfig,
): Promise<JenkinsJob[]> {
  const jobs = await client.listJobs();
  const existingCache = await readJobCache();
  const cachedJobs = mergeCachedBranches(jobs, existingCache);
  const recentJobs =
    existingCache && cacheMatchesEnv(existingCache, env)
      ? existingCache.recentJobs
      : undefined;
  const payload: JobCache = {
    jenkinsUrl: env.jenkinsUrl,
    user: env.jenkinsUser,
    fetchedAt: new Date().toISOString(),
    jobs: cachedJobs,
    recentJobs,
  };
  await writeJobCache(payload);
  return jobs;
}

function cacheMatchesEnv(cache: JobCache, env: EnvConfig): boolean {
  return cache.jenkinsUrl === env.jenkinsUrl && cache.user === env.jenkinsUser;
}

function isValidCache(cache: JobCache | null): cache is JobCache {
  if (!cache) {
    return false;
  }
  if (
    typeof cache.jenkinsUrl !== "string" ||
    typeof cache.user !== "string" ||
    typeof cache.fetchedAt !== "string" ||
    !Array.isArray(cache.jobs)
  ) {
    return false;
  }
  return true;
}

function normalizeCachedJobs(jobs: CachedJob[]): void {
  for (const job of jobs) {
    if (Array.isArray(job.branches)) {
      job.branches = normalizeBranches(job.branches);
    } else if (job.branches) {
      job.branches = undefined;
    }
  }
}

function mergeCachedBranches(
  jobs: JenkinsJob[],
  existingCache: JobCache | null,
): CachedJob[] {
  return jobs.map((job) => {
    const existing = existingCache?.jobs.find((entry) => entry.url === job.url);
    if (!Array.isArray(existing?.branches) || existing.branches.length === 0) {
      return { ...job };
    }
    return { ...job, branches: normalizeBranches(existing.branches) };
  });
}

function normalizeBranches(entries: string[]): string[] {
  const deduped = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (deduped.has(key)) {
      continue;
    }
    deduped.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

export type RankedJob = {
  job: JenkinsJob;
  score: number;
};

export function rankJobs(query: string, jobs: JenkinsJob[]): RankedJob[] {
  const normalizedQuery = normalizeText(query);
  const tokenFrequencies = analyzeTokenFrequencies(jobs);
  const queryTokens = tokenize(normalizedQuery);
  const hasExactOrPrefixMatch = hasExactOrPrefixMatchInJobs(
    jobs,
    normalizedQuery,
  );
  const ranked = collectRankedJobs(jobs, {
    normalizedQuery,
    queryTokens,
    tokenFrequencies,
    hasExactOrPrefixMatch,
  });
  ranked.sort(compareRankedJobs);
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
    (match) =>
      match.score >= MIN_SCORE && topScore - match.score <= AMBIGUITY_GAP,
  );

  const firstMatch = closeMatches[0];
  if (closeMatches.length === 1 && firstMatch) {
    return firstMatch.job;
  }

  const optionsList = closeMatches
    .slice(0, MAX_OPTIONS)
    .map((match) => match.job);
  if (options.nonInteractive || !options.selectFromOptions) {
    const optionNames = optionsList.map(getJobDisplayName).join(", ");
    throw new CliError(`Job name is ambiguous for "${trimmedQuery}".`, [
      `Options: ${optionNames}`,
      "Pass `--job <exact name>` or `--job-url <url>`.",
    ]);
  }

  return options.selectFromOptions(optionsList);
}

/**
 * Normalizes text for case-insensitive comparison and fuzzy matching.
 *
 * Regex breakdown:
 * - `/[^a-z0-9]+/g` - Matches one or more non-alphanumeric characters
 *   (anything that's not a-z or 0-9) and replaces with a single space
 * - `/\s+/g` - Matches one or more whitespace characters and collapses
 *   them into a single space
 *
 * @param input - The string to normalize
 * @returns Lowercased string with non-alphanum chars as spaces, collapsed
 */
function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function tokenize(input: string): string[] {
  if (!input) {
    return [];
  }
  return input
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function hasAllQueryTokens(
  queryTokens: string[],
  candidateTokens: string[],
): boolean {
  if (queryTokens.length === 0) {
    return false;
  }
  return queryTokens.every((queryToken) =>
    candidateTokens.some(
      (candidateToken) =>
        candidateToken === queryToken || candidateToken.startsWith(queryToken),
    ),
  );
}

function scoreCandidate(
  normalizedQuery: string,
  queryTokens: string[],
  candidate: string,
  tokenFrequencies?: Map<string, number>,
  hasExactOrPrefixMatch?: boolean,
): number {
  if (!normalizedQuery || !candidate) {
    return 0;
  }

  const candidateTokens = candidate.split(" ");
  if (!passesTokenFilter(queryTokens, candidateTokens)) {
    return 0;
  }

  const directScore = scoreDirectMatch(normalizedQuery, candidate);
  if (directScore !== null) {
    return directScore;
  }

  const substringScore = scoreSubstringMatch(
    normalizedQuery,
    candidateTokens.length,
    candidate,
    hasExactOrPrefixMatch,
  );
  if (substringScore !== null) {
    return substringScore;
  }

  if (queryTokens.length === 0) {
    return 0;
  }

  return scoreTokenOverlap(queryTokens, candidateTokens, tokenFrequencies);
}

function hasExactOrPrefixMatchInJobs(
  jobs: JenkinsJob[],
  normalizedQuery: string,
): boolean {
  for (const job of jobs) {
    for (const candidate of getJobCandidates(job)) {
      const candidateNormalized = normalizeText(candidate);
      if (
        candidateNormalized === normalizedQuery ||
        candidateNormalized.startsWith(normalizedQuery)
      ) {
        return true;
      }
    }
  }
  return false;
}

function collectRankedJobs(
  jobs: JenkinsJob[],
  options: {
    normalizedQuery: string;
    queryTokens: string[];
    tokenFrequencies: Map<string, number>;
    hasExactOrPrefixMatch: boolean;
  },
): RankedJob[] {
  const ranked: RankedJob[] = [];
  for (const job of jobs) {
    const bestScore = scoreJobCandidates(job, options);
    if (bestScore > 0) {
      ranked.push({ job, score: bestScore });
    }
  }
  return ranked;
}

function scoreJobCandidates(
  job: JenkinsJob,
  options: {
    normalizedQuery: string;
    queryTokens: string[];
    tokenFrequencies: Map<string, number>;
    hasExactOrPrefixMatch: boolean;
  },
): number {
  let bestScore = 0;
  for (const candidate of getJobCandidates(job)) {
    const candidateNormalized = normalizeText(candidate);
    const score = scoreCandidate(
      options.normalizedQuery,
      options.queryTokens,
      candidateNormalized,
      options.tokenFrequencies,
      options.hasExactOrPrefixMatch,
    );
    if (score > bestScore) {
      bestScore = score;
    }
  }
  return bestScore;
}

function getJobCandidates(job: JenkinsJob): string[] {
  return [job.name, job.fullName].filter(isNonEmptyString);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function compareRankedJobs(a: RankedJob, b: RankedJob): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  const aLength = getJobDisplayName(a.job).length;
  const bLength = getJobDisplayName(b.job).length;
  if (aLength !== bLength) {
    return aLength - bLength;
  }
  return getJobDisplayName(a.job).localeCompare(getJobDisplayName(b.job));
}

function passesTokenFilter(
  queryTokens: string[],
  candidateTokens: string[],
): boolean {
  if (queryTokens.length === 0) {
    return true;
  }
  return hasAllQueryTokens(queryTokens, candidateTokens);
}

function scoreDirectMatch(
  normalizedQuery: string,
  candidate: string,
): number | null {
  if (candidate === normalizedQuery) {
    return 100;
  }
  if (candidate.startsWith(normalizedQuery)) {
    return 80;
  }
  return null;
}

function scoreSubstringMatch(
  normalizedQuery: string,
  candidateTokenCount: number,
  candidate: string,
  hasExactOrPrefixMatch?: boolean,
): number | null {
  if (!candidate.includes(normalizedQuery)) {
    return null;
  }
  const queryTokenCount = normalizedQuery.split(" ").length;
  if (candidateTokenCount <= queryTokenCount) {
    return 60;
  }
  const extraTokens = candidateTokenCount - queryTokenCount;
  const isSingleTokenQuery = queryTokenCount === 1;
  if (hasExactOrPrefixMatch) {
    const penalty = extraTokens * (isSingleTokenQuery ? 10 : 20);
    return Math.max(0, 60 - penalty);
  }
  const perTokenPenalty = isSingleTokenQuery ? 4 : 8;
  const penalty = extraTokens * perTokenPenalty;
  return Math.max(25, 60 - penalty);
}

function scoreTokenOverlap(
  queryTokens: string[],
  candidateTokens: string[],
  tokenFrequencies?: Map<string, number>,
): number {
  const candidateTokenSet = new Set(candidateTokens);
  let weightedOverlap = 0;
  let totalWeight = 0;

  for (const queryToken of queryTokens) {
    const frequency = tokenFrequencies?.get(queryToken) ?? 0.5;
    const weight = 1.1 - frequency;
    totalWeight += weight;

    if (candidateTokenSet.has(queryToken)) {
      weightedOverlap += weight;
    }
  }

  if (weightedOverlap === 0) {
    return 0;
  }

  const weightedRatio = weightedOverlap / totalWeight;
  return Math.round(weightedRatio * 40);
}
