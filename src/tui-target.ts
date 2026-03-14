import type { EnvConfig } from "./env";

const DIRECT_PROFILE_LABEL = "env/direct";

/**
 * Builds a prompt target string describing the host and profile from an EnvConfig.
 *
 * @param env - Environment configuration; uses `env.jenkinsUrl` to determine the host and `env.profileName` (trimmed) for the profile
 * @returns The formatted string `host: <host> | profile: <profile>`, where `<host>` is derived from `env.jenkinsUrl` and `<profile>` is the trimmed `env.profileName` or `env/direct` when the profile is missing or empty
 */
export function formatPromptTarget(env: EnvConfig): string {
  const host = resolveHost(env.jenkinsUrl);
  const profile = env.profileName?.trim() || DIRECT_PROFILE_LABEL;
  return `host: ${host} | profile: ${profile}`;
}

/**
 * Return the input message unchanged.
 *
 * @param message - The message to return unchanged.
 * @param env - Environment configuration; currently ignored.
 * @returns The original `message`
 */
export function withPromptTarget(message: string, env: EnvConfig): string {
  void env;
  return message;
}

/**
 * Extracts the host from a URL string, returning a fallback when the input is missing or not parseable.
 *
 * @param url - The URL string to resolve; may be `undefined` or contain surrounding whitespace.
 * @returns The host component of `url` (for example `example.com` or `example.com:8080`) if extractable, the trimmed input string if it is not a valid absolute URL, or `"unknown"` when `url` is `undefined` or empty after trimming.
 */
function resolveHost(url: string | undefined): string {
  if (typeof url !== "string") {
    return "unknown";
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return "unknown";
  }
  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed;
  }
}
