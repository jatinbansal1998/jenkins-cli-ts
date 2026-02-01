/**
 * File-based API logger.
 * Logs Jenkins API requests to ~/.config/jenkins-cli/api.log
 * Optionally logs to console when debug mode is enabled.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".config", "jenkins-cli");
const LOG_FILE = path.join(CONFIG_DIR, "api.log");

/** Whether debug mode is enabled (logs to console). */
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

function logToConsole(line: string): void {
  if (debugMode) {
    // Remove trailing newline for console output
    console.error(`[DEBUG] ${line.trimEnd()}`);
  }
}

/**
 * Log an API request to the log file and optionally console.
 */
export function logApiRequest(method: string, url: string): void {
  const line = `[${getTimestamp()}] REQUEST ${method} ${url}\n`;
  safeAppendLine(line);
  logToConsole(line);
}

/**
 * Log an API response (success) to the log file and optionally console.
 */
export function logApiResponse(
  method: string,
  url: string,
  status: number,
): void {
  const line = `[${getTimestamp()}] RESPONSE ${method} ${url} -> ${status}\n`;
  safeAppendLine(line);
  logToConsole(line);
}

/**
 * Log an API error to the log file and optionally console.
 */
export function logApiError(method: string, url: string, status: number): void {
  const line = `[${getTimestamp()}] ERROR ${method} ${url} -> HTTP ${status}\n`;
  safeAppendLine(line);
  logToConsole(line);
}

/**
 * Log a network/timeout error to the log file and optionally console.
 */
export function logNetworkError(
  method: string,
  url: string,
  error: string,
): void {
  const line = `[${getTimestamp()}] NETWORK_ERROR ${method} ${url} -> ${error}\n`;
  safeAppendLine(line);
  logToConsole(line);
}
