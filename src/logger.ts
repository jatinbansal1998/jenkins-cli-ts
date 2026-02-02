/**
 * File-based API logger.
 * Logs Jenkins API requests to ~/.config/jenkins-cli/api.log
 * Includes headers and body when available.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".config", "jenkins-cli");
const LOG_FILE = path.join(CONFIG_DIR, "api.log");

/** Whether debug mode is enabled (kept for backward compatibility). */
let debugMode = false;

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
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function getTimestamp(): string {
  return new Date().toISOString();
}

function safeAppendLine(line: string): void {
  try {
    ensureConfigDir();
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Best-effort logging; never fail the caller.
  }
}

function normalizeHeaders(headers?: HeadersInit): Array<[string, string]> {
  if (!headers) {
    return [];
  }
  if (headers instanceof Headers) {
    const entries: Array<[string, string]> = [];
    headers.forEach((value, key) => entries.push([key, value]));
    return entries;
  }
  if (Array.isArray(headers)) {
    return headers.map(([key, value]) => [key, value]);
  }
  return Object.entries(headers);
}

function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function formatHeadersBlock(headers?: HeadersInit): string | null {
  const entries = normalizeHeaders(headers);
  if (entries.length === 0) {
    return null;
  }
  const lines = entries.map(([key, value]) => `  ${key}: ${value}`);
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
  headers?: HeadersInit,
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
  headers?: HeadersInit,
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
  headers?: HeadersInit,
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
