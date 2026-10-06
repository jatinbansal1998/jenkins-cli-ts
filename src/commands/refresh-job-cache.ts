/**
 * Hidden command run by the detached process that `loadJobs` spawns when the
 * job cache is stale. The parent hands over its resolved credentials through
 * an environment variable so this process never touches config or keychain.
 */
import { CliError } from "../cli";
import { JenkinsClient } from "../jenkins/client";
import {
  clearJobCacheRefreshLock,
  JOB_CACHE_REFRESH_ENV,
  type JobCacheRefreshPayload,
  loadJobs,
} from "../jobs";

export async function runJobCacheRefresh(): Promise<void> {
  const env = parseRefreshEnv(process.env[JOB_CACHE_REFRESH_ENV]);
  try {
    await loadJobs({
      client: new JenkinsClient({
        baseUrl: env.jenkinsUrl,
        user: env.jenkinsUser,
        apiToken: env.jenkinsApiToken,
        timeoutMs: env.timeoutMs,
        transportRetries: env.transportRetries,
        useCrumb: env.useCrumb,
        folderDepth: env.folderDepth,
      }),
      env,
      refresh: true,
    });
  } finally {
    await clearJobCacheRefreshLock(env.jenkinsUrl);
  }
}

function parseRefreshEnv(raw: string | undefined): JobCacheRefreshPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CliError(
      `${JOB_CACHE_REFRESH_ENV} is missing or malformed.`,
      [],
      "INVALID_USAGE",
    );
  }
  const record = parsed as Record<string, unknown>;
  const {
    jenkinsUrl,
    jenkinsUser,
    jenkinsApiToken,
    useCrumb,
    folderDepth,
    timeoutMs,
    transportRetries,
  } = record;
  if (
    typeof jenkinsUrl !== "string" ||
    typeof jenkinsUser !== "string" ||
    typeof jenkinsApiToken !== "string" ||
    typeof useCrumb !== "boolean" ||
    typeof folderDepth !== "number" ||
    (timeoutMs !== undefined && typeof timeoutMs !== "number") ||
    (transportRetries !== undefined && typeof transportRetries !== "number")
  ) {
    throw new CliError(
      `${JOB_CACHE_REFRESH_ENV} is missing or malformed.`,
      [],
      "INVALID_USAGE",
    );
  }
  return {
    jenkinsUrl,
    jenkinsUser,
    jenkinsApiToken,
    useCrumb,
    folderDepth,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(transportRetries !== undefined ? { transportRetries } : {}),
  };
}
