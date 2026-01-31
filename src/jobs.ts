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
export type JobCache = {
  jenkinsUrl: string;
  user: string;
  fetchedAt: string;
  jobs: JenkinsJob[];
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

  // Analyze token frequencies across all jobs to identify trivial/common tokens
  const tokenFrequencies = analyzeTokenFrequencies(jobs);

  // Tokenize query - keep ALL tokens, we'll weight them differently
  const queryTokens = tokenize(normalizedQuery);

  // First pass: check if any job has an exact or prefix match
  // This helps us penalize substring matches when a better match exists
  let hasExactOrPrefixMatch = false;
  for (const job of jobs) {
    const candidates = [job.name, job.fullName].filter(
      (value): value is string => Boolean(value),
    );
    for (const candidate of candidates) {
      const candidateNormalized = normalizeText(candidate);
      if (
        candidateNormalized === normalizedQuery ||
        candidateNormalized.startsWith(normalizedQuery)
      ) {
        hasExactOrPrefixMatch = true;
        break;
      }
    }
    if (hasExactOrPrefixMatch) break;
  }

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
        tokenFrequencies,
        hasExactOrPrefixMatch, // Pass this to apply stricter substring penalties
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
    // When scores are equal, prefer shorter job names (more specific matches)
    // This ensures "payment-service-prod" ranks higher than "credit-card-payment-service-prod"
    // when both have the same substring match score
    const aLength = getJobDisplayName(a.job).length;
    const bLength = getJobDisplayName(b.job).length;
    if (aLength !== bLength) {
      return aLength - bLength;
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
  if (queryTokens.length > 0) {
    const allTokensPresent = hasAllQueryTokens(queryTokens, candidateTokens);
    if (!allTokensPresent) {
      return 0;
    }
  }

  if (candidate === normalizedQuery) {
    return 100;
  }

  if (candidate.startsWith(normalizedQuery)) {
    return 80;
  }

  if (candidate.includes(normalizedQuery)) {
    // For substring matches, penalize if job has significantly more tokens than query
    // This prevents "payment-service-prod" from matching "credit-card-payment-service-prod"
    const queryTokenCount = normalizedQuery.split(" ").length;
    const candidateTokenCount = candidate.split(" ").length;

    if (candidateTokenCount > queryTokenCount) {
      const extraTokens = candidateTokenCount - queryTokenCount;
      const isSingleTokenQuery = queryTokenCount === 1;

      // If there's an exact/prefix match available, be more strict with substring matches
      // This ensures "payment-service-prod" doesn't match "credit-card-payment-service-prod"
      // when "payment-service-prod" exists as an exact match
      if (hasExactOrPrefixMatch) {
        // Aggressive penalty: -20 points per extra token when better match exists
        // For single-token queries, reduce the penalty to avoid over-filtering long names.
        const penalty = extraTokens * (isSingleTokenQuery ? 10 : 20);
        return Math.max(0, 60 - penalty);
      } else {
        // Lighter penalty when no better match exists: -8 points per extra token
        // For single-token queries, reduce the penalty to avoid over-filtering long names.
        const perTokenPenalty = isSingleTokenQuery ? 4 : 8;
        const penalty = extraTokens * perTokenPenalty;
        // This allows "analytics ml" to match "data-analytics-ml-pipeline-prod"
        return Math.max(25, 60 - penalty);
      }
    }
    return 60;
  }

  if (queryTokens.length === 0) {
    return 0;
  }

  const candidateTokenSet = new Set(candidateTokens);

  // Calculate weighted overlap score
  // Rare tokens (low frequency) contribute more to the score
  // Common/trivial tokens (high frequency) contribute less
  let weightedOverlap = 0;
  let totalWeight = 0;

  for (const queryToken of queryTokens) {
    const frequency = tokenFrequencies?.get(queryToken) ?? 0.5;
    // Weight = inverse of frequency (rare tokens get higher weight)
    // Add 0.1 to avoid division by zero and ensure all tokens have some weight
    const weight = 1.1 - frequency;
    totalWeight += weight;

    if (candidateTokenSet.has(queryToken)) {
      weightedOverlap += weight;
    }
  }

  if (weightedOverlap === 0) {
    return 0;
  }

  // Score based on weighted ratio (0-40 scale)
  const weightedRatio = weightedOverlap / totalWeight;
  return Math.round(weightedRatio * 40);
}
