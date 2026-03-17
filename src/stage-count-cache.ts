import type { EnvConfig } from "./env";
import { readJobCache, writeJobCache } from "./jobs";

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
  jobName?: string;
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
  if (!cache || !cacheMatchesEnv(cache, options.env)) {
    return;
  }
  cache.knownStageTotals = {
    ...cache.knownStageTotals,
    [jobUrl]: {
      totalStages: options.totalStages,
      updatedAt: new Date().toISOString(),
      ...(options.jobName ? { jobName: options.jobName } : {}),
    },
  };
  await writeJobCache(cache);
}

export function resolveStageCacheJobUrl(options: {
  jobUrl?: string;
  buildUrl?: string;
}): string | undefined {
  const explicitJobUrl = normalizeUrl(options.jobUrl);
  if (explicitJobUrl) {
    return explicitJobUrl;
  }
  const buildUrl = normalizeUrl(options.buildUrl);
  if (!buildUrl) {
    return undefined;
  }
  try {
    const url = new URL(buildUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 0) {
      return undefined;
    }
    parts.pop();
    url.pathname = `/${parts.join("/")}/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") + "/" : undefined;
}

function cacheMatchesEnv(
  cache: { jenkinsUrl: string; user: string },
  env: EnvConfig,
): boolean {
  return cache.jenkinsUrl === env.jenkinsUrl && cache.user === env.jenkinsUser;
}
