/**
 * File-based API logger.
 * Logs Jenkins API requests to ~/.config/jenkins-cli/api-<date>.log when
 * debug mode is enabled. Includes headers and body when available;
 * credential headers are redacted. Files older than the retention window
 * are pruned on CLI shutdown.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".config", "jenkins-cli");
const LEGACY_LOG_FILE = path.join(CONFIG_DIR, "api.log");
const DATED_LOG_FILE_PATTERN = /^api-(\d{4}-\d{2}-\d{2})\.log$/;
const LOG_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type LogHeaders =
  Headers | string[][] | Record<string, string | readonly string[]>;

/** Whether debug mode is enabled; gates all api.log writes. */
let debugMode = false;

const REDACTED_HEADER_PATTERN = /^(authorization|cookie|set-cookie)$|crumb/i;

/**
 * Enable or disable debug mode for console output.
 */
export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
}

/**
 * Check if debug mode is enabled.
 */
export function isDebugMode(): boolean {
  return debugMode;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function getTimestamp(): string {
  return new Date().toISOString();
}

/** UTC-dated log path, matching the UTC timestamps inside the entries. */
function getLogFilePath(): string {
  return path.join(CONFIG_DIR, `api-${getTimestamp().slice(0, 10)}.log`);
}

function safeAppendLine(line: string): void {
  try {
    ensureConfigDir();
    fs.appendFileSync(getLogFilePath(), line, { mode: 0o600 });
  } catch {
    // Best-effort logging; never fail the caller.
  }
}

function removeFileQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup; never fail the caller.
  }
}

/**
 * Delete API log files older than the retention window. Runs on CLI
 * shutdown, so it is synchronous and best-effort (exit handlers cannot
 * await, and cleanup must never fail the process).
 */
export function pruneOldApiLogs(now = Date.now()): void {
  const cutoff = now - LOG_RETENTION_DAYS * DAY_MS;
  let entries: string[];
  try {
    entries = fs.readdirSync(CONFIG_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = DATED_LOG_FILE_PATTERN.exec(entry);
    if (!match) {
      continue;
    }
    const fileDate = Date.parse(`${match[1]}T00:00:00.000Z`);
    // A file dated D can hold entries up to the end of day D, so it only
    // falls out of retention once that whole day is past the cutoff.
    if (Number.isFinite(fileDate) && fileDate + DAY_MS <= cutoff) {
      removeFileQuietly(path.join(CONFIG_DIR, entry));
    }
  }
  // The undated legacy log (which may hold unredacted credentials from
  // older versions) ages by mtime instead of by name.
  try {
    if (fs.statSync(LEGACY_LOG_FILE).mtimeMs <= cutoff) {
      removeFileQuietly(LEGACY_LOG_FILE);
    }
  } catch {
    // Missing legacy log is the normal case.
  }
}

function normalizeHeaders(headers?: LogHeaders): Array<[string, string]> {
  if (!headers) {
    return [];
  }
  if (headers instanceof Headers) {
    const entries: Array<[string, string]> = [];
    headers.forEach((value, key) => entries.push([key, value]));
    return entries;
  }
  if (Array.isArray(headers)) {
    const entries: Array<[string, string]> = [];
    for (const header of headers) {
      const [key = "", value = ""] = header;
      entries.push([key, value]);
    }
    return entries;
  }
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      entries.push([key, value]);
      continue;
    }
    entries.push([key, value.join(",")]);
  }
  return entries;
}

function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function formatHeadersBlock(headers?: LogHeaders): string | null {
  const entries = normalizeHeaders(headers);
  if (entries.length === 0) {
    return null;
  }
  const lines = entries.map(([key, value]) => {
    const rendered = REDACTED_HEADER_PATTERN.test(key) ? "<redacted>" : value;
    return `  ${key}: ${rendered}`;
  });
  return `Headers:\n${lines.join("\n")}`;
}

function formatBodyBlock(body: string | null | undefined): string | null {
  if (body === null || body === undefined) {
    return null;
  }
  const rendered = body === "" ? "<empty>" : body;
  return `Body:\n${indentLines(rendered, "  ")}`;
}

function logBlock(lines: Array<string | null>): void {
  if (!debugMode) {
    return;
  }
  const payload = lines.filter((line) => line && line.length > 0).join("\n");
  if (!payload) {
    return;
  }
  safeAppendLine(`${payload}\n\n`);
}

/**
 * Log an API request to the log file and optionally console.
 */
export function logApiRequest(
  method: string,
  url: string,
  headers?: LogHeaders,
  body?: string | null,
): void {
  logBlock([
    `[${getTimestamp()}] REQUEST ${method} ${url}`,
    formatHeadersBlock(headers),
    formatBodyBlock(body),
  ]);
}

/**
 * Log an API response (success) to the log file and optionally console.
 */
export function logApiResponse(
  method: string,
  url: string,
  status: number,
  headers?: LogHeaders,
  body?: string | null,
): void {
  logBlock([
    `[${getTimestamp()}] RESPONSE ${method} ${url} -> ${status}`,
    formatHeadersBlock(headers),
    formatBodyBlock(body),
  ]);
}

/**
 * Log an API error to the log file and optionally console.
 */
export function logApiError(
  method: string,
  url: string,
  status: number,
  headers?: LogHeaders,
  body?: string | null,
): void {
  logBlock([
    `[${getTimestamp()}] ERROR ${method} ${url} -> HTTP ${status}`,
    formatHeadersBlock(headers),
    formatBodyBlock(body),
  ]);
}

/**
 * Log a network/timeout error to the log file and optionally console.
 */
export function logNetworkError(
  method: string,
  url: string,
  error: string,
): void {
  logBlock([`[${getTimestamp()}] NETWORK_ERROR ${method} ${url} -> ${error}`]);
}
