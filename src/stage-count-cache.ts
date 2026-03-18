import type { EnvConfig } from "./env";
import { normalizeOptionalJobUrl, resolveJobUrlFromBuildUrl } from "./job-url";
import { readJobCache, writeJobCache, type JobCache } from "./jobs";

export async function getKnownStageTotal(options: {
  env?: EnvConfig;
  jobUrl?: string;
  buildUrl?: string;
}): Promise<number | undefined> {
  if (!options.env) {
    return undefined;
  }
  const jobUrl = resolveStageCacheJobUrl(options);
  if (!jobUrl) {
    return undefined;
  }
  const cache = await readJobCache(options.env);
  if (!cache || !cacheMatchesEnv(cache, options.env)) {
    return undefined;
  }
  return cache.knownStageTotals?.[jobUrl]?.totalStages;
}

export async function recordKnownStageTotal(options: {
  env?: EnvConfig;
  jobUrl?: string;
  buildUrl?: string;
  totalStages?: number;
}): Promise<void> {
  if (!options.env) {
    return;
  }
  if (
    typeof options.totalStages !== "number" ||
    !Number.isFinite(options.totalStages) ||
    options.totalStages <= 0
  ) {
    return;
  }
  const jobUrl = resolveStageCacheJobUrl(options);
  if (!jobUrl) {
    return;
  }
  const cache = await readJobCache(options.env);
  if (cache && !cacheMatchesEnv(cache, options.env)) {
    return;
  }
  const baseCache: JobCache =
    cache ??
    ({
      jenkinsUrl: options.env.jenkinsUrl,
      user: options.env.jenkinsUser,
      fetchedAt: new Date().toISOString(),
      jobs: [],
      knownStageTotals: {},
    } satisfies JobCache);
  const newCache = {
    ...baseCache,
    knownStageTotals: {
      ...baseCache.knownStageTotals,
      [jobUrl]: {
        totalStages: options.totalStages,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  await writeJobCache(newCache);
}

export async function persistKnownTotalStages(options: {
  env?: EnvConfig;
  jobUrl?: string;
  buildUrl?: string;
  stages?: { length?: number };
  jobLabel: string;
}): Promise<void> {
  try {
    await recordKnownStageTotal({
      env: options.env,
      jobUrl: options.jobUrl,
      buildUrl: options.buildUrl,
      totalStages: options.stages?.length,
    });
  } catch {
    // Ignore stage cache write failures for status output.
  }
}

export function resolveStageCacheJobUrl(options: {
  jobUrl?: string;
  buildUrl?: string;
}): string | undefined {
  const explicitJobUrl = normalizeOptionalJobUrl(options.jobUrl);
  if (explicitJobUrl) {
    return explicitJobUrl;
  }
  return resolveJobUrlFromBuildUrl(options.buildUrl);
}

function cacheMatchesEnv(
  cache: { jenkinsUrl: string; user: string },
  env: EnvConfig,
): boolean {
  return cache.jenkinsUrl === env.jenkinsUrl && cache.user === env.jenkinsUser;
}
