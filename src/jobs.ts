/**
 * Job caching and fuzzy matching.
 * Caches jobs locally in an OS-specific cache directory and provides
 * natural language search with scoring for job lookups.
 */
import { mkdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { CliError } from "./cli";
import { MIN_SCORE, AMBIGUITY_GAP, MAX_OPTIONS, SCORES } from "./config/fuzzy";
import type { EnvConfig } from "./env";
import type { JenkinsClient } from "./jenkins/api-wrapper";
import { normalizeRecentJobs, pruneRecentJobs } from "./recent-job-data";
import { findJobByUrl, getJobUrlKey, normalizeOptionalJobUrl } from "./job-url";
import type { JenkinsJob } from "./types/jenkins";

/** Cached job data with metadata. */
export type CachedJob = JenkinsJob & {
  branches?: string[];
};

export type CachedStageTotal = {
  totalStages: number;
  updatedAt: string;
};

export type JobCache = {
  jenkinsUrl: string;
  user: string;
  fetchedAt: string;
  jobs: CachedJob[];
  recentJobs?: string[];
  knownStageTotals?: Record<string, CachedStageTotal>;
  folderDepth?: number;
};

const CACHE_DIR = resolveCacheDir();
const DEFAULT_CACHE_FILE = path.join(CACHE_DIR, "jobs.json");

export function getJobCacheDir(): string {
  return CACHE_DIR;
}

export function getJobCachePath(jenkinsUrl?: string): string {
  if (!jenkinsUrl) {
    return DEFAULT_CACHE_FILE;
  }
  return path.join(CACHE_DIR, `jobs-${buildCacheKey(jenkinsUrl)}.json`);
}

function resolveCacheDir(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Caches", "jenkins-cli");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return path.join(localAppData, "jenkins-cli");
    }
    return path.join(home, "AppData", "Local", "jenkins-cli");
  }
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
  const baseDir =
    xdgCacheHome && xdgCacheHome.length > 0
      ? xdgCacheHome
      : path.join(home, ".cache");
  return path.join(baseDir, "jenkins-cli");
}

export function getJobDisplayName(job: JenkinsJob): string {
  return job.fullName || job.name;
}

export function sortJobsByDisplayName(jobs: JenkinsJob[]): JenkinsJob[] {
  return jobs
    .slice()
    .sort((a, b) => getJobDisplayName(a).localeCompare(getJobDisplayName(b)));
}

export function getSuggestedJobs(
  query: string,
  jobs: JenkinsJob[],
  options?: { limit?: number },
): JenkinsJob[] {
  const limit = options?.limit ?? MAX_OPTIONS;
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return sortJobsByDisplayName(jobs).slice(0, limit);
  }
  return rankJobs(trimmedQuery, jobs)
    .filter((match) => match.score >= MIN_SCORE)
    .slice(0, limit)
    .map((match) => match.job);
}

export async function loadJobs(options: {
  client: JenkinsClient;
  env: EnvConfig;
  refresh?: boolean;
  nonInteractive: boolean;
}): Promise<JenkinsJob[]> {
  const cache = await readJobCache(options.env);
  const isCacheUsable = cache && cacheMatchesEnv(cache, options.env);

  if (options.refresh) {
    return await fetchAndCacheJobs(options.client, options.env);
  }

  let isExpired = false;
  if (isCacheUsable && cache.fetchedAt) {
    const fetchedAt = new Date(cache.fetchedAt).getTime();
    const now = Date.now();
    isExpired = now - fetchedAt > 24 * 60 * 60 * 1000;
  }

  if (isCacheUsable && !isExpired) {
    return cache.jobs;
  }

  const reason = cache
    ? "Job cache does not match the current Jenkins URL, user, or folder depth."
    : "Job cache is missing.";

  const hints = [
    "Run `jenkins-cli list --refresh` to rebuild the cache.",
    "Or pass `--job-url` to skip cache matching.",
  ];

  if (options.nonInteractive && !isCacheUsable) {
    throw new CliError(reason, hints);
  }

  return await fetchAndCacheJobs(options.client, options.env);
}

export async function readJobCache(env: {
  jenkinsUrl: string;
}): Promise<JobCache | null> {
  const scopedPath = getJobCachePath(env.jenkinsUrl);
  return await readCacheFromPath(scopedPath);
}

export async function writeJobCache(cache: JobCache): Promise<void> {
  const cachePath = getJobCachePath(cache.jenkinsUrl);
  await writeCacheToPath(cachePath, cache);
}

async function fetchAndCacheJobs(
  client: JenkinsClient,
  env: EnvConfig,
): Promise<JenkinsJob[]> {
  const jobs = await client.listJobs();
  const existingCache = await readJobCache(env);
  const cachedJobs = mergeCachedBranches(jobs, existingCache);
  const recentJobs = existingCache?.recentJobs
    ? pruneRecentJobs({
        jobs,
        recentJobs: existingCache.recentJobs,
      })
    : undefined;
  const payload: JobCache = {
    jenkinsUrl: env.jenkinsUrl,
    user: env.jenkinsUser,
    fetchedAt: new Date().toISOString(),
    jobs: cachedJobs,
    recentJobs,
    knownStageTotals: existingCache?.knownStageTotals,
    folderDepth: env.folderDepth,
  };
  await writeJobCache(payload);
  return jobs;
}

async function readCacheFromPath(cachePath: string): Promise<JobCache | null> {
  try {
    const raw = await Bun.file(cachePath).text();
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidCache(parsed)) {
      return null;
    }
    normalizeCachedJobs(parsed.jobs);
    parsed.recentJobs = normalizeRecentJobs(parsed.recentJobs);
    parsed.knownStageTotals = normalizeKnownStageTotals(
      parsed.knownStageTotals,
    );
    return parsed;
  } catch {
    return null;
  }
}

async function writeCacheToPath(
  cachePath: string,
  cache: JobCache,
): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const tempPath = `${cachePath}.${randomUUID()}.tmp`;
  try {
    await Bun.file(tempPath).write(JSON.stringify(cache, null, 2));
    await rename(tempPath, cachePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function cacheMatchesEnv(cache: JobCache, env: EnvConfig): boolean {
  return (
    cache.jenkinsUrl === env.jenkinsUrl &&
    cache.user === env.jenkinsUser &&
    cache.folderDepth === env.folderDepth
  );
}

function buildCacheKey(jenkinsUrl: string): string {
  const normalized = jenkinsUrl.trim().toLowerCase().replace(/\/+$/, "");
  let host = "jenkins";
  try {
    host = new URL(normalized).host.toLowerCase();
  } catch {
    // URL is already validated earlier; fallback keeps cache path safe.
  }
  const safeHost = host
    .replaceAll(/[^a-z0-9.-]+/g, "-")
    .replaceAll(/^-+/g, "")
    .replaceAll(/-+$/g, "");
  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
  return `${safeHost || "jenkins"}-${digest}`;
}

function isValidCache(cache: unknown): cache is JobCache {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return false;
  }
  const record = cache as Record<string, unknown>;
  return !(
    typeof record.jenkinsUrl !== "string" ||
    typeof record.user !== "string" ||
    typeof record.fetchedAt !== "string" ||
    !Array.isArray(record.jobs)
  );
}

function normalizeKnownStageTotals(
  value: unknown,
): Record<string, CachedStageTotal> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const normalized = new Map<
    string,
    { url: string; entry: CachedStageTotal }
  >();
  for (const [jobUrl, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const totalStages = record.totalStages;
    const updatedAt = record.updatedAt;
    if (
      typeof totalStages !== "number" ||
      !Number.isFinite(totalStages) ||
      totalStages <= 0 ||
      typeof updatedAt !== "string"
    ) {
      continue;
    }
    const canonicalUrl = normalizeOptionalJobUrl(jobUrl);
    const key = getJobUrlKey(canonicalUrl);
    if (!canonicalUrl || !key) {
      continue;
    }
    const nextEntry = {
      totalStages,
      updatedAt,
    };

    const existing = normalized.get(key);
    if (!existing || updatedAt >= existing.entry.updatedAt) {
      normalized.set(key, {
        url: canonicalUrl,
        entry: nextEntry,
      });
    }
  }
  if (normalized.size === 0) {
    return undefined;
  }

  const result: Record<string, CachedStageTotal> = {};
  for (const { url, entry } of normalized.values()) {
    result[url] = entry;
  }
  return result;
}

function normalizeCachedJobs(jobs: CachedJob[]): void {
  for (const job of jobs) {
    job.url = normalizeOptionalJobUrl(job.url) ?? job.url.trim();
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
    const normalizedJob = {
      ...job,
      url: normalizeOptionalJobUrl(job.url) ?? job.url.trim(),
    };
    const existing = existingCache
      ? findJobByUrl(existingCache.jobs, normalizedJob.url)
      : undefined;
    if (!Array.isArray(existing?.branches) || existing.branches.length === 0) {
      return normalizedJob;
    }
    return {
      ...normalizedJob,
      branches: normalizeBranches(existing.branches),
    };
  });
}

function normalizeBranches(entries: unknown[]): string[] {
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
  const queryTokens = tokenize(normalizedQuery);
  const ranked = collectRankedJobs(jobs, {
    normalizedQuery,
    queryTokens,
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
  const trimmedQuery = ensureNonEmptyJobQuery(options.query);

  const optionsList = resolveJobCandidates(trimmedQuery, options.jobs);
  const firstMatch = optionsList[0];
  if (optionsList.length === 1 && firstMatch) {
    return firstMatch;
  }

  if (options.nonInteractive || !options.selectFromOptions) {
    const optionNames = optionsList.map(getJobDisplayName).join(", ");
    throw new CliError(`Job name is ambiguous for "${trimmedQuery}".`, [
      `Options: ${optionNames}`,
      "Pass `--job <exact name>` or `--job-url <url>`.",
    ]);
  }

  return options.selectFromOptions(optionsList);
}

export function resolveJobCandidates(
  query: string,
  jobs: JenkinsJob[],
): JenkinsJob[] {
  const trimmedQuery = ensureNonEmptyJobQuery(query);

  const ranked = rankJobs(trimmedQuery, jobs);
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
  return closeMatches.slice(0, MAX_OPTIONS).map((match) => match.job);
}

function ensureNonEmptyJobQuery(query: string): string {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new CliError("Job name is required.", [
      "Pass --job <name> or use --job-url <url>.",
    ]);
  }
  return trimmedQuery;
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

function scoreCandidate(
  normalizedQuery: string,
  queryTokens: string[],
  candidate: string,
): number {
  if (!normalizedQuery || !candidate) {
    return 0;
  }

  const candidateTokens = candidate.split(" ");
  const tokenMatchCredit = getBestTokenMatchCredit(
    queryTokens,
    candidateTokens,
  );
  if (tokenMatchCredit === null) {
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
  );
  if (substringScore !== null) {
    return substringScore;
  }

  if (queryTokens.length === 0) {
    return 0;
  }

  return scoreTokenOverlap(tokenMatchCredit, queryTokens.length);
}

function collectRankedJobs(
  jobs: JenkinsJob[],
  options: {
    normalizedQuery: string;
    queryTokens: string[];
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
  },
): number {
  let bestScore = 0;
  for (const candidate of getJobCandidates(job)) {
    const candidateNormalized = normalizeText(candidate);
    const score = scoreCandidate(
      options.normalizedQuery,
      options.queryTokens,
      candidateNormalized,
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

function scoreDirectMatch(
  normalizedQuery: string,
  candidate: string,
): number | null {
  if (candidate === normalizedQuery) {
    return SCORES.EXACT;
  }
  if (candidate.startsWith(normalizedQuery)) {
    return SCORES.PREFIX;
  }
  return null;
}

function scoreSubstringMatch(
  normalizedQuery: string,
  candidateTokenCount: number,
  candidate: string,
): number | null {
  if (!candidate.includes(normalizedQuery)) {
    return null;
  }
  const queryTokenCount = normalizedQuery.split(" ").length;
  if (candidateTokenCount <= queryTokenCount) {
    return SCORES.SUBSTRING;
  }
  const extraTokens = candidateTokenCount - queryTokenCount;
  const isSingleTokenQuery = queryTokenCount === 1;
  const perTokenPenalty = isSingleTokenQuery ? 4 : 8;
  const penalty = extraTokens * perTokenPenalty;
  return Math.max(25, SCORES.SUBSTRING - penalty);
}

const MIN_FUZZY_TOKEN_LENGTH = 4;
const EXACT_TOKEN_CREDIT = 1;
const PREFIX_TOKEN_CREDIT = 0.85;
const TYPO_TOKEN_CREDIT = 0.75;

type TokenMatchOption = {
  candidateIndex: number;
  credit: number;
};

function getBestTokenMatchCredit(
  queryTokens: string[],
  candidateTokens: string[],
): number | null {
  if (queryTokens.length === 0) {
    return null;
  }

  const optionsByQuery: TokenMatchOption[][] = queryTokens.map((queryToken) =>
    candidateTokens.flatMap((candidateToken, candidateIndex) => {
      const credit = getTokenMatchCredit(queryToken, candidateToken);
      return credit === null ? [] : [{ candidateIndex, credit }];
    }),
  );
  if (optionsByQuery.some((options) => options.length === 0)) {
    return null;
  }

  optionsByQuery.sort((a, b) => a.length - b.length);
  const memo = optionsByQuery.map(() => new Map<bigint, number>());

  function findBestCredit(queryIndex: number, usedCandidates: bigint): number {
    if (queryIndex === optionsByQuery.length) {
      return 0;
    }

    const cached = memo[queryIndex]?.get(usedCandidates);
    if (cached !== undefined) {
      return cached;
    }

    let bestCredit = Number.NEGATIVE_INFINITY;
    for (const option of optionsByQuery[queryIndex] ?? []) {
      const candidateMask = 1n << BigInt(option.candidateIndex);
      if ((usedCandidates & candidateMask) !== 0n) {
        continue;
      }
      const remainingCredit = findBestCredit(
        queryIndex + 1,
        usedCandidates | candidateMask,
      );
      bestCredit = Math.max(bestCredit, option.credit + remainingCredit);
    }

    memo[queryIndex]?.set(usedCandidates, bestCredit);
    return bestCredit;
  }

  const bestCredit = findBestCredit(0, 0n);
  return Number.isFinite(bestCredit) ? bestCredit : null;
}

function getTokenMatchCredit(
  queryToken: string,
  candidateToken: string,
): number | null {
  if (candidateToken === queryToken) {
    return EXACT_TOKEN_CREDIT;
  }
  if (candidateToken.startsWith(queryToken)) {
    return PREFIX_TOKEN_CREDIT;
  }
  if (
    queryToken.length >= MIN_FUZZY_TOKEN_LENGTH &&
    isOneEditApart(queryToken, candidateToken)
  ) {
    return TYPO_TOKEN_CREDIT;
  }
  return null;
}

function isOneEditApart(left: string, right: string): boolean {
  const lengthDifference = Math.abs(left.length - right.length);
  if (lengthDifference > 1) {
    return false;
  }

  if (left.length === right.length) {
    const mismatches: number[] = [];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        mismatches.push(index);
        if (mismatches.length > 2) {
          return false;
        }
      }
    }
    if (mismatches.length === 1) {
      return true;
    }
    if (mismatches.length !== 2) {
      return false;
    }
    const first = mismatches[0];
    const second = mismatches[1];
    if (first === undefined || second === undefined) {
      return false;
    }
    return (
      second === first + 1 &&
      left[first] === right[second] &&
      left[second] === right[first]
    );
  }

  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let shorterIndex = 0;
  let longerIndex = 0;
  let skippedCharacter = false;

  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    if (skippedCharacter) {
      return false;
    }
    skippedCharacter = true;
    longerIndex += 1;
  }
  return true;
}

function scoreTokenOverlap(
  totalCredit: number,
  queryTokenCount: number,
): number {
  return Math.round(
    (totalCredit / queryTokenCount) * SCORES.TOKEN_OVERLAP_BASE,
  );
}
