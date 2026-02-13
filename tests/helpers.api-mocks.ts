import { mock } from "bun:test";
import type { GitHubReleaseInfo } from "../src/github/api-wrapper";
import {
  GITHUB_API_ROOT,
  GITHUB_VERSION_POLICY_URL,
} from "../src/github-constants";
import type { JobCache } from "../src/jobs";
import type { JenkinsJob } from "../src/types/jenkins";

const DUMMY_JOB_CACHE_PATH = `${import.meta.dir}/fixtures/dummy-jobs-cache.json`;
const DEFAULT_RELEASE_ASSET_URL =
  "https://github.com/jatinbansal1998/jenkins-cli-ts/releases/download/v9.9.9/jenkins-cli";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export type ApiMocksOptions = {
  jenkinsUrl?: string;
  latestRelease?: GitHubReleaseInfo;
  versionPolicy?: {
    minVersion: string;
    message?: string;
    updatedAt?: string;
  };
};

export type InstalledApiMocks = {
  cacheFixture: JobCache;
  fetchMock: ReturnType<typeof mock>;
  restore: () => void;
};

export async function loadDummyJobCacheFixture(): Promise<JobCache> {
  return (await Bun.file(DUMMY_JOB_CACHE_PATH).json()) as JobCache;
}

export async function installApiMocks(
  options: ApiMocksOptions = {},
): Promise<InstalledApiMocks> {
  const cacheFixture = await loadDummyJobCacheFixture();
  const jobs = toJenkinsJobs(cacheFixture.jobs);
  const jenkinsUrl = normalizeUrl(
    options.jenkinsUrl ?? cacheFixture.jenkinsUrl,
  );
  const latestRelease =
    options.latestRelease ??
    ({
      tag_name: "v9.9.9",
      assets: [
        {
          name: "jenkins-cli",
          browser_download_url: DEFAULT_RELEASE_ASSET_URL,
        },
      ],
    } satisfies GitHubReleaseInfo);
  const versionPolicy =
    options.versionPolicy ??
    ({
      minVersion: "0.6.0",
      message: "Mocked policy for tests.",
      updatedAt: "2026-02-12T00:00:00.000Z",
    } as const);

  const realFetch = globalThis.fetch;
  const fetchMock = mock(async (input: FetchInput, init?: FetchInit) => {
    const requestUrl = getRequestUrl(input);
    const parsed = safeParseUrl(requestUrl);
    const normalizedPath = parsed?.pathname.replace(/\/+$/, "") ?? "";
    const isJenkinsRequest = requestUrl.startsWith(`${jenkinsUrl}/`);

    if (
      isJenkinsRequest &&
      (requestUrl === `${jenkinsUrl}/api/json?tree=jobs[name,fullName,url]` ||
        (normalizedPath === "/api/json" &&
          parsed?.searchParams.get("tree") === "jobs[name,fullName,url]"))
    ) {
      return jsonResponse({ jobs });
    }

    if (isJenkinsRequest && normalizedPath === "/crumbIssuer/api/json") {
      return new Response("", { status: 404 });
    }

    if (requestUrl === `${GITHUB_API_ROOT}/releases/latest`) {
      return jsonResponse(latestRelease);
    }

    if (requestUrl.startsWith(`${GITHUB_API_ROOT}/releases/tags/`)) {
      const tag = requestUrl.slice(`${GITHUB_API_ROOT}/releases/tags/`.length);
      return jsonResponse({ ...latestRelease, tag_name: tag });
    }

    if (requestUrl === GITHUB_VERSION_POLICY_URL) {
      return jsonResponse(versionPolicy);
    }

    if (
      latestRelease.assets.some(
        (asset) => asset.browser_download_url === requestUrl,
      )
    ) {
      return new Response("binary", { status: 200 });
    }

    throw new Error(
      `Unhandled mocked fetch URL: ${requestUrl} (method=${init?.method ?? "GET"})`,
    );
  });

  globalThis.fetch = fetchMock as unknown as typeof fetch;

  return {
    cacheFixture,
    fetchMock,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

function toJenkinsJobs(
  jobs: Array<{ name: string; fullName?: string; url: string }>,
): JenkinsJob[] {
  return jobs.map((job) => ({
    name: job.name,
    fullName: job.fullName,
    url: job.url,
  }));
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function getRequestUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
