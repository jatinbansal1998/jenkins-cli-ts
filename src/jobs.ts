/**
 * Job caching and fuzzy matching.
 * Caches jobs locally in an OS-specific cache directory and provides
 * natural language search with scoring for job lookups.
 */
import { mkdir, open, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { CliError, printHint } from "./cli";
import { MIN_SCORE, AMBIGUITY_GAP, MAX_OPTIONS, SCORES } from "./config/fuzzy";
import type { EnvConfig } from "./env";
import type { JenkinsClient } from "./jenkins/client";
import { normalizeRecentJobs, pruneRecentJobs } from "./recent-job-data";
import { findJobByUrl, getJobUrlKey, normalizeOptionalJobUrl } from "./job-url";
import { selfInvocation } from "./self-invocation";
import type { JenkinsJob, JenkinsJobLastBuild } from "./types/jenkins";
import { resolveUserHome } from "./user-home";

/** Cached job data with metadata. */
type CachedJob = JenkinsJob & {
  branches?: string[];
};

type CachedStageTotal = {
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
  const home = resolveUserHome();
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

/**
 * Terminal-only presentation of a job name. Never use it for ranking, matching,
 * JSON, cache identity, URLs, or recent-job keys.
 */
export function getJobDisplayLabel(job: JenkinsJob): string {
  const displayName = getJobDisplayName(job);
  return job.disabled === true ? `${displayName} [disabled]` : displayName;
}

export function sortJobsByDisplayName(jobs: JenkinsJob[]): JenkinsJob[] {
  return jobs
    .slice()
    .toSorted((a, b) =>
      getJobDisplayName(a).localeCompare(getJobDisplayName(b)),
    );
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

/** The slice of EnvConfig the job cache needs; also the background refresh payload. */
export type JobCacheEnv = Pick<
  EnvConfig,
  "jenkinsUrl" | "jenkinsUser" | "jenkinsApiToken" | "useCrumb" | "folderDepth"
>;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** A refresh that has not finished within this window is assumed dead. */
const REFRESH_LOCK_TTL_MS = 10 * 60 * 1000;
export const JOB_CACHE_REFRESH_ENV = "JENKINS_CLI_JOB_CACHE_REFRESH";
export const JOB_CACHE_REFRESH_COMMAND = "refresh-job-cache";

type JobsDeps = {
  spawnDetached: (command: string[], env: Record<string, string>) => void;
};

const defaultJobsDeps: JobsDeps = {
  spawnDetached(command, env) {
    Bun.spawn({
      cmd: command,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      windowsHide: true,
    }).unref();
  },
};

let jobsDeps = defaultJobsDeps;

export function setJobsDepsForTesting(
  overrides: Partial<JobsDeps>,
): () => void {
  jobsDeps = { ...defaultJobsDeps, ...overrides };
  return () => {
    jobsDeps = defaultJobsDeps;
  };
}

/**
 * Serves the cached job list. A missing or mismatched cache is fetched
 * synchronously; a stale one is returned as-is while a detached CLI process
 * refreshes it, so the caller never waits on Jenkins for data it already has.
 */
export async function loadJobs(options: {
  client: JenkinsClient;
  env: JobCacheEnv;
  refresh?: boolean;
}): Promise<JenkinsJob[]> {
  if (options.refresh) {
    return await fetchAndCacheJobs(options.client, options.env);
  }

  const cache = await readJobCache(options.env);
  if (!cache || !cacheMatchesEnv(cache, options.env)) {
    return await fetchAndCacheJobs(options.client, options.env);
  }

  const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
  if (ageMs > CACHE_TTL_MS) {
    await scheduleBackgroundRefresh(options.env);
    printHint(
      `Job cache is ${formatAge(ageMs)} old; refreshing it in the background. Run \`jenkins-cli list --refresh\` to wait for fresh data.`,
    );
  }
  return cache.jobs;
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
  env: JobCacheEnv,
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

/**
 * Spawns `jenkins-cli refresh-job-cache` detached from this process. A lock
 * file next to the cache stops concurrent commands from each spawning their
 * own refresh. Failures are swallowed: the stale cache is still usable.
 */
async function scheduleBackgroundRefresh(env: JobCacheEnv): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    if (!(await acquireRefreshLock(getRefreshLockPath(env.jenkinsUrl)))) {
      return;
    }
    const payload: JobCacheEnv = {
      jenkinsUrl: env.jenkinsUrl,
      jenkinsUser: env.jenkinsUser,
      jenkinsApiToken: env.jenkinsApiToken,
      useCrumb: env.useCrumb,
      folderDepth: env.folderDepth,
    };
    jobsDeps.spawnDetached(
      selfInvocation([JOB_CACHE_REFRESH_COMMAND, "--non-interactive"]),
      { [JOB_CACHE_REFRESH_ENV]: JSON.stringify(payload) },
    );
  } catch {
    // Best-effort only.
  }
}

export async function clearJobCacheRefreshLock(
  jenkinsUrl: string,
): Promise<void> {
  await rm(getRefreshLockPath(jenkinsUrl), { force: true });
}

function getRefreshLockPath(jenkinsUrl: string): string {
  return `${getJobCachePath(jenkinsUrl)}.refreshing`;
}

/**
 * Exclusive create makes the check and the claim one operation, so parallel
 * commands cannot both win. A lock older than its TTL belongs to a worker
 * that died and is removed before one retry.
 */
async function acquireRefreshLock(lockPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(new Date().toISOString());
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await isRefreshInProgress(lockPath)) {
        return false;
      }
      await rm(lockPath, { force: true });
    }
  }
  return false;
}

async function isRefreshInProgress(lockPath: string): Promise<boolean> {
  try {
    const startedAt = Date.parse(await Bun.file(lockPath).text());
    return (
      !Number.isNaN(startedAt) && Date.now() - startedAt < REFRESH_LOCK_TTL_MS
    );
  } catch {
    return false;
  }
}

function formatAge(ageMs: number): string {
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
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

export function jobCacheMatchesEnv(
  cache: { jenkinsUrl: string; user: string },
  env: Pick<EnvConfig, "jenkinsUrl" | "jenkinsUser">,
): boolean {
  return cache.jenkinsUrl === env.jenkinsUrl && cache.user === env.jenkinsUser;
}

export async function readUsableJobCache(
  env: EnvConfig,
): Promise<JobCache | null> {
  const cache = await readJobCache(env);
  return cache && jobCacheMatchesEnv(cache, env) ? cache : null;
}

function cacheMatchesEnv(cache: JobCache, env: JobCacheEnv): boolean {
  return (
    jobCacheMatchesEnv(cache, env) && cache.folderDepth === env.folderDepth
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
    if (job.disabled !== undefined && typeof job.disabled !== "boolean") {
      job.disabled = undefined;
    }
    if (job.lastBuild !== undefined) {
      job.lastBuild = normalizeCachedLastBuild(job.lastBuild);
    }
  }
}

/**
 * Malformed activity metadata is dropped back to "unknown" so one bad entry
 * cannot invalidate an otherwise usable cache.
 */
function normalizeCachedLastBuild(
  value: unknown,
): JenkinsJobLastBuild | null | undefined {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const number = record.number;
  const url = record.url;
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < 0 ||
    typeof url !== "string" ||
    !url.trim()
  ) {
    return undefined;
  }
  const result = record.result;
  const building = record.building;
  return {
    number,
    url,
    ...(result === null || typeof result === "string" ? { result } : {}),
    ...(typeof building === "boolean" ? { building } : {}),
    ...pickFiniteNumber(record, "timestampMs"),
    ...pickFiniteNumber(record, "durationMs"),
    ...pickFiniteNumber(record, "estimatedDurationMs"),
  };
}

function pickFiniteNumber(
  record: Record<string, unknown>,
  key: "timestampMs" | "durationMs" | "estimatedDurationMs",
): Partial<Record<typeof key, number>> {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? { [key]: value }
    : {};
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

type RankedJob = {
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
    const closest = findClosestJobs(trimmedQuery, jobs).map(getJobDisplayName);
    throw new CliError(`No jobs match "${trimmedQuery}".`, [
      ...(closest.length > 0 ? [`Closest: ${closest.join(", ")}.`] : []),
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

const MAX_CLOSEST_JOBS = 5;
const MIN_PARTIAL_TOKEN_LENGTH = 3;

/**
 * Loose pass behind the "No jobs match" error: ranking requires every query
 * token to hit, so a single wrong token hides the whole namespace. Listing
 * jobs that share any token lets a caller correct the name without a `list`
 * round trip.
 */
function findClosestJobs(query: string, jobs: JenkinsJob[]): JenkinsJob[] {
  const queryTokens = tokenize(normalizeText(query));
  const scored: RankedJob[] = [];
  for (const job of jobs) {
    const candidateTokens = getJobCandidates(job).flatMap((candidate) =>
      tokenize(normalizeText(candidate)),
    );
    const matched = queryTokens.filter((queryToken) =>
      candidateTokens.some((candidateToken) =>
        isPartialTokenMatch(queryToken, candidateToken),
      ),
    ).length;
    if (matched > 0) {
      scored.push({ job, score: matched });
    }
  }
  scored.sort(compareRankedJobs);
  return scored.slice(0, MAX_CLOSEST_JOBS).map((match) => match.job);
}

function isPartialTokenMatch(
  queryToken: string,
  candidateToken: string,
): boolean {
  if (getTokenMatchCredit(queryToken, candidateToken) !== null) {
    return true;
  }
  return (
    queryToken.length >= MIN_PARTIAL_TOKEN_LENGTH &&
    candidateToken.includes(queryToken)
  );
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
  // A genuine substring match must never fall below MIN_SCORE: otherwise a
  // more specific query can hide jobs that a shorter query still shows.
  return Math.max(MIN_SCORE, SCORES.SUBSTRING - penalty);
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
