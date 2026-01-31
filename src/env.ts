import { CliError } from "./cli";

export type EnvConfig = {
  jenkinsUrl: string;
  jenkinsUser: string;
  jenkinsApiToken: string;
};

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CliError("Invalid JENKINS_URL.", [
      "Use a full URL like https://jenkins.example.com.",
    ]);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("Invalid JENKINS_URL protocol.", [
      "Use http:// or https:// for JENKINS_URL.",
    ]);
  }

  const normalized = url.toString().replace(/\/+$/, "");
  return normalized;
}

export function loadEnv(): EnvConfig {
  const rawUrl = process.env.JENKINS_URL;
  const rawUser = process.env.JENKINS_USER;
  const rawToken = process.env.JENKINS_API_TOKEN;

  if (!rawUrl || rawUrl.trim() === "") {
    throw new CliError("Missing JENKINS_URL.", [
      "Set JENKINS_URL to your Jenkins base URL (e.g., https://jenkins.example.com).",
    ]);
  }

  if (!rawUser || rawUser.trim() === "") {
    throw new CliError("Missing JENKINS_USER.", [
      "Set JENKINS_USER to your Jenkins username or service account.",
    ]);
  }

  if (!rawToken || rawToken.trim() === "") {
    throw new CliError("Missing JENKINS_API_TOKEN.", [
      "Set JENKINS_API_TOKEN to your Jenkins API token.",
    ]);
  }

  return {
    jenkinsUrl: normalizeUrl(rawUrl),
    jenkinsUser: rawUser.trim(),
    jenkinsApiToken: rawToken.trim(),
  };
}
