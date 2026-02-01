/**
 * Environment configuration loader.
 * Validates and loads JENKINS_URL, JENKINS_USER, and JENKINS_API_TOKEN.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./cli";

const CONFIG_DIR = path.join(os.homedir(), ".config", "jenkins-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "jenkins-cli-config.json");

type RawEnv = {
  JENKINS_URL?: string;
  JENKINS_USER?: string;
  JENKINS_API_TOKEN?: string;
  JENKINS_DEBUG?: string;
};

type FileConfig = {
  jenkinsUrl?: string;
  jenkinsUser?: string;
  jenkinsApiToken?: string;
  debug?: boolean;
  JENKINS_URL?: string;
  JENKINS_USER?: string;
  JENKINS_API_TOKEN?: string;
  JENKINS_DEBUG?: string | boolean;
};

/** Jenkins connection configuration. */
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

function parseConfigFile(contents: string): RawEnv {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new CliError("Invalid config file JSON.", [
      `Fix the JSON in ${CONFIG_FILE}.`,
    ]);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Invalid config file format.", [
      `Expected a JSON object in ${CONFIG_FILE}.`,
    ]);
  }

  const record = parsed as FileConfig;
  const result: RawEnv = {};

  const url =
    typeof record.jenkinsUrl === "string"
      ? record.jenkinsUrl
      : typeof record.JENKINS_URL === "string"
        ? record.JENKINS_URL
        : undefined;
  const user =
    typeof record.jenkinsUser === "string"
      ? record.jenkinsUser
      : typeof record.JENKINS_USER === "string"
        ? record.JENKINS_USER
        : undefined;
  const token =
    typeof record.jenkinsApiToken === "string"
      ? record.jenkinsApiToken
      : typeof record.JENKINS_API_TOKEN === "string"
        ? record.JENKINS_API_TOKEN
        : undefined;

  if (url) {
    result.JENKINS_URL = url;
  }
  if (user) {
    result.JENKINS_USER = user;
  }
  if (token) {
    result.JENKINS_API_TOKEN = token;
  }

  // Parse debug setting (supports boolean or string "true"/"false")
  const debugValue = record.debug ?? record.JENKINS_DEBUG;
  if (debugValue !== undefined) {
    if (typeof debugValue === "boolean") {
      result.JENKINS_DEBUG = debugValue ? "true" : "false";
    } else if (typeof debugValue === "string") {
      result.JENKINS_DEBUG = debugValue;
    }
  }

  return result;
}

function readConfigFile(): RawEnv {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    const contents = fs.readFileSync(CONFIG_FILE, "utf8");
    return parseConfigFile(contents);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("Unable to read config file.", [
      `Check permissions for ${CONFIG_FILE}.`,
    ]);
  }
}

export function loadEnv(): EnvConfig {
  const config = readConfigFile();
  const rawUrl = process.env.JENKINS_URL ?? config.JENKINS_URL;
  const rawUser = process.env.JENKINS_USER ?? config.JENKINS_USER;
  const rawToken = process.env.JENKINS_API_TOKEN ?? config.JENKINS_API_TOKEN;

  if (!rawUrl || rawUrl.trim() === "") {
    throw new CliError("Missing JENKINS_URL.", [
      "Set JENKINS_URL to your Jenkins base URL (e.g., https://jenkins.example.com).",
      `Or add it to ${CONFIG_FILE}.`,
    ]);
  }

  if (!rawUser || rawUser.trim() === "") {
    throw new CliError("Missing JENKINS_USER.", [
      "Set JENKINS_USER to your Jenkins username or service account.",
      `Or add it to ${CONFIG_FILE}.`,
    ]);
  }

  if (!rawToken || rawToken.trim() === "") {
    throw new CliError("Missing JENKINS_API_TOKEN.", [
      "Set JENKINS_API_TOKEN to your Jenkins API token.",
      `Or add it to ${CONFIG_FILE}.`,
    ]);
  }

  return {
    jenkinsUrl: normalizeUrl(rawUrl),
    jenkinsUser: rawUser.trim(),
    jenkinsApiToken: rawToken.trim(),
  };
}

/**
 * Get the debug setting from environment variable or config file.
 * Returns true if JENKINS_DEBUG is set to "true" or "1".
 * This is used as the default value when --debug flag is not explicitly passed.
 */
export function getDebugDefault(): boolean {
  const config = readConfigFile();
  const rawDebug = process.env.JENKINS_DEBUG ?? config.JENKINS_DEBUG;

  if (!rawDebug) {
    return false;
  }

  const normalized = rawDebug.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}
