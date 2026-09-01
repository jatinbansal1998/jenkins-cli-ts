export function normalizeJobUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function normalizeOptionalJobUrl(
  value: string | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return normalizeJobUrl(value) || undefined;
}

export function getJobUrlKey(value: string | undefined): string | undefined {
  return normalizeOptionalJobUrl(value)?.toLowerCase();
}

export function areSameJobUrls(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const leftKey = getJobUrlKey(left);
  return leftKey !== undefined && leftKey === getJobUrlKey(right);
}

export function findJobByUrl<T extends { url: string }>(
  jobs: T[],
  jobUrl: string | undefined,
): T | undefined {
  return jobs.find((job) => areSameJobUrls(job.url, jobUrl));
}

/**
 * Derives an item's full name ("folder/job") from its URL by collecting the
 * path segment after each "/job/", so controllers served under a path prefix
 * still resolve correctly.
 */
export function jobUrlToFullName(jobUrl: string): string | undefined {
  let segments: string[];
  try {
    segments = new URL(jobUrl).pathname.split("/").filter(Boolean);
  } catch {
    return undefined;
  }
  const names: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === "job") {
      try {
        names.push(decodeURIComponent(segments[index + 1] as string));
      } catch {
        return undefined;
      }
      index += 1;
    }
  }
  return names.length > 0 ? names.join("/") : undefined;
}

export function resolveJobUrlFromBuildUrl(
  buildUrl: string | undefined,
): string | undefined {
  const normalizedBuildUrl = normalizeOptionalJobUrl(buildUrl);
  if (!normalizedBuildUrl) {
    return undefined;
  }

  try {
    const url = new URL(normalizedBuildUrl);
    const jobPath = url.pathname.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
    if (!jobPath) {
      return undefined;
    }

    return normalizeOptionalJobUrl(`${url.origin}${jobPath}`);
  } catch {
    return undefined;
  }
}
