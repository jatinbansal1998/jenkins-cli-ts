import { CliError } from "./cli";
import { ENV_KEYS } from "./env-keys";

/** Normalizes and validates a Jenkins controller URL. */
export function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CliError(`Invalid ${ENV_KEYS.JENKINS_URL}.`, [
      "Use a full URL like https://jenkins.example.com.",
    ]);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`Invalid ${ENV_KEYS.JENKINS_URL} protocol.`, [
      `Use http:// or https:// for ${ENV_KEYS.JENKINS_URL}.`,
    ]);
  }

  return url.toString().replace(/\/+$/, "");
}
