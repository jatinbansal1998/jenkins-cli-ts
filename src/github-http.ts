import { GITHUB_REPO_URL } from "./github-constants";

export function buildGitHubUserAgent(version: string): string {
  const normalizedVersion = version.trim() || "unknown";
  return `jenkins-cli/${normalizedVersion} (+${GITHUB_REPO_URL}; platform=${process.platform}; arch=${process.arch})`;
}

export function createGitHubHeaders(options: {
  version: string;
  headers?: Headers | Record<string, string>;
}): Headers {
  const headers = new Headers();
  if (options.headers instanceof Headers) {
    for (const [key, value] of options.headers.entries()) {
      headers.set(key, value);
    }
  } else if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      headers.set(key, value);
    }
  }
  headers.set("User-Agent", buildGitHubUserAgent(options.version));
  return headers;
}
