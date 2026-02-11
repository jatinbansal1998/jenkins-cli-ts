import type { EnvConfig } from "./env";

const DIRECT_PROFILE_LABEL = "env/direct";

export function formatPromptTarget(env: EnvConfig): string {
  const host = resolveHost(env.jenkinsUrl);
  const profile = env.profileName?.trim() || DIRECT_PROFILE_LABEL;
  return `host: ${host} | profile: ${profile}`;
}

export function withPromptTarget(message: string, env: EnvConfig): string {
  return `${message} [${formatPromptTarget(env)}]`;
}

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
