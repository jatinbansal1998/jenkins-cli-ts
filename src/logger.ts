/**
 * Local error stacks and opt-in API metadata logs, retained for seven days.
 * Error messages are preserved in full. API credential headers are redacted;
 * request and response bodies are omitted. Nothing is uploaded.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveUserHome } from "./user-home";
import packageJson from "../package.json";

const CONFIG_DIR = path.join(resolveUserHome(), ".config", "jenkins-cli");
const LEGACY_LOG_FILE = path.join(CONFIG_DIR, "api.log");
const DATED_LOG_FILE_PATTERN = /^(?:api|error)-(\d{4}-\d{2}-\d{2})\.log$/;
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

function appendLogFile(kind: "api" | "error", payload: string): void {
  ensureConfigDir();
  const descriptor = fs.openSync(
    path.join(CONFIG_DIR, `${kind}-${getTimestamp().slice(0, 10)}.log`),
    fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0),
    0o600,
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) return;
    fs.fchmodSync(descriptor, 0o600);
    fs.appendFileSync(descriptor, payload);
  } finally {
    fs.closeSync(descriptor);
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
 * Delete API and error log files older than the retention window. Runs on CLI
 * shutdown, so it is synchronous and best-effort (exit handlers cannot
 * await, and cleanup must never fail the process).
 */
export function pruneOldLogs(now = Date.now()): void {
  const cutoff = now - LOG_RETENTION_DAYS * DAY_MS;
  let entries: string[];
  try {
    entries = fs.readdirSync(CONFIG_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "analytics-id") {
      removeFileQuietly(path.join(CONFIG_DIR, entry));
      continue;
    }
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

export function logCliError(error: unknown): void {
  try {
    const entries: string[] = [];
    const seen = new Set<Error>();
    let current = error;
    while (current instanceof Error && !seen.has(current) && seen.size < 8) {
      seen.add(current);
      entries.push(current.stack || `${current.name}: ${current.message}`);
      current = current.cause;
      if (current instanceof Error && !seen.has(current) && seen.size < 8)
        entries.push("Caused by");
    }
    if (entries.length === 0) entries.push(String(error));
    appendLogFile(
      "error",
      `[${getTimestamp()}] jenkins-cli ${packageJson.version}\n${entries.join("\n")}\n\n`,
    );
  } catch {
    // Disk failures must not mask the original command failure.
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

function logBlock(lines: Array<string | null>): void {
  if (!debugMode) {
    return;
  }
  const payload = lines.filter((line) => line && line.length > 0).join("\n");
  if (!payload) {
    return;
  }
  try {
    appendLogFile("api", `${payload}\n\n`);
  } catch {
    // Disk failures must not affect the request.
  }
}

/**
 * Log an API request to the log file and optionally console.
 */
export function logApiRequest(
  method: string,
  url: string,
  headers?: LogHeaders,
  hasBody = false,
): void {
  logBlock([
    `[${getTimestamp()}] REQUEST ${method} ${url}`,
    formatHeadersBlock(headers),
    hasBody ? "Body:\n  <omitted>" : null,
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
): void {
  logBlock([
    `[${getTimestamp()}] RESPONSE ${method} ${url} -> ${status}`,
    formatHeadersBlock(headers),
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
): void {
  logBlock([
    `[${getTimestamp()}] ERROR ${method} ${url} -> HTTP ${status}`,
    formatHeadersBlock(headers),
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
