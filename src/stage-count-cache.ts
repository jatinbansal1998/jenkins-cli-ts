import type { EnvConfig } from "./env";
import {
  getJobUrlKey,
  normalizeOptionalJobUrl,
  resolveJobUrlFromBuildUrl,
} from "./job-url";
import { readJobState, updateJobState } from "./job-state";

export async function getKnownStageTotal(options: {
  env?: EnvConfig;
  jobUrl?: string;
  buildUrl?: string;
}): Promise<number | undefined> {
  if (!options.env) {
    return undefined;
  }
  const jobKey = getJobUrlKey(resolveStageCacheJobUrl(options));
  if (!jobKey) {
    return undefined;
  }
  const state = await readJobState(options.env.jenkinsUrl);
  return state.knownStageTotals[jobKey]?.totalStages;
}

export async function recordKnownStageTotal(options: {
  env?: EnvConfig;
  jobUrl?: string;
  buildUrl?: string;
  totalStages?: number;
}): Promise<void> {
  const totalStages = options.totalStages;
  if (
    !options.env ||
    typeof totalStages !== "number" ||
    !Number.isFinite(totalStages) ||
    totalStages <= 0
  ) {
    return;
  }
  const jobKey = getJobUrlKey(resolveStageCacheJobUrl(options));
  if (!jobKey) {
    return;
  }
  await updateJobState(options.env.jenkinsUrl, (state) => {
    if (state.knownStageTotals[jobKey]?.totalStages === totalStages) {
      return undefined;
    }
    return {
      ...state,
      knownStageTotals: {
        ...state.knownStageTotals,
        [jobKey]: { totalStages, updatedAt: new Date().toISOString() },
      },
    };
  });
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
