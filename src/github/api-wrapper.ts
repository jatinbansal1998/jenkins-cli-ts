import { CliError } from "../cli";
import {
  GITHUB_API_ROOT,
  GITHUB_VERSION_POLICY_URL,
} from "../github-constants";
import { createGitHubHeaders } from "../github-http";

const RELEASES_LATEST_ENDPOINT = "releases/latest";
const RELEASES_TAGS_ENDPOINT = "releases/tags";

export type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

export type GitHubReleaseInfo = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};

type TimedRequestOptions = {
  timeoutMs?: number;
};

type GitHubReleaseRequestOptions = TimedRequestOptions & {
  currentVersion: string;
};

type VersionPolicyRequestOptions = TimedRequestOptions & {
  currentVersion: string;
  policyUrl?: string;
};

export async function fetchLatestRelease(
  options: GitHubReleaseRequestOptions,
): Promise<GitHubReleaseInfo> {
  return await fetchRelease(RELEASES_LATEST_ENDPOINT, options);
}

export async function fetchReleaseByTag(
  tag: string,
  options: GitHubReleaseRequestOptions,
): Promise<GitHubReleaseInfo> {
  return await fetchRelease(`${RELEASES_TAGS_ENDPOINT}/${tag}`, options);
}

export async function downloadReleaseAsset(options: {
  assetUrl: string;
  currentVersion: string;
}): Promise<Response> {
  const response = await fetch(options.assetUrl, {
    headers: createGitHubHeaders({
      version: options.currentVersion,
    }),
  });
  if (!response.ok) {
    throw new CliError(`Failed to download CLI (HTTP ${response.status}).`, [
      "Check the release assets or try again later.",
    ]);
  }
  return response;
}

export async function fetchVersionPolicy(
  options: VersionPolicyRequestOptions,
): Promise<unknown | null> {
  const url = options.policyUrl ?? GITHUB_VERSION_POLICY_URL;
  const { controller, cleanup } = withTimeout(options.timeoutMs);
  try {
    const response = await fetch(url, {
      headers: createGitHubHeaders({
        version: options.currentVersion,
        headers: {
          Accept: "application/json",
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

async function fetchRelease(
  endpoint: string,
  options: GitHubReleaseRequestOptions,
): Promise<GitHubReleaseInfo> {
  const { controller, cleanup } = withTimeout(options.timeoutMs);
  try {
    const response = await fetch(`${GITHUB_API_ROOT}/${endpoint}`, {
      headers: createGitHubHeaders({
        version: options.currentVersion,
        headers: {
          Accept: "application/vnd.github+json",
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CliError(
        `Failed to fetch release info (HTTP ${response.status}).`,
        [
          "Check your network connection.",
          "GitHub API rate limits can also cause failures.",
        ],
      );
    }
    const payload = (await response.json()) as GitHubReleaseInfo;
    if (!payload.tag_name || !Array.isArray(payload.assets)) {
      throw new CliError("Unexpected release payload from GitHub.");
    }
    return payload;
  } finally {
    cleanup();
  }
}

function withTimeout(timeoutMs?: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timeout.unref === "function") {
      timeout.unref();
    }
  }
  return {
    controller,
    cleanup: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  };
}
