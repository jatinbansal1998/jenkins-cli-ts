/**
 * CLI output utilities and error handling.
 * Provides standardized output prefixes (OK:, ERROR:, WARN:, HINT:) for easy parsing.
 */
import path from "node:path";
import type { ErrorCode } from "./error-codes";
import { logCliError } from "./logger";
import { NATIVE_RELEASE_TARGETS } from "./release-targets";

/** Structured error with hints for user guidance. `code` sets the exit code. */
export class CliError extends Error {
  public readonly hints: string[];
  public readonly code: ErrorCode;

  constructor(
    message: string,
    hints: string[],
    code: ErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
    this.hints = hints;
    this.code = code;
  }
}

const DEFAULT_SCRIPT_NAME = "jenkins-cli";
const PRODUCT_BINARY_NAMES = new Set([
  DEFAULT_SCRIPT_NAME,
  "index.ts",
  "index.js",
  ...NATIVE_RELEASE_TARGETS.map((target) =>
    target.assetName.replace(/\.exe$/i, ""),
  ),
]);

export function getScriptName(
  scriptPath: string | undefined = process.argv[1],
): string {
  const rawScriptName = scriptPath
    ? path.basename(scriptPath)
    : DEFAULT_SCRIPT_NAME;
  const withoutExe = rawScriptName.replace(/\.exe$/i, "");
  return PRODUCT_BINARY_NAMES.has(withoutExe)
    ? DEFAULT_SCRIPT_NAME
    : rawScriptName;
}

let quietMode = false;

/** `--quiet` leaves only errors on stderr, for scripts that read the exit code. */
export function setQuietMode(quiet: boolean): void {
  quietMode = quiet;
}

/** Prints one line of command output to stdout unless `--quiet` is set. */
export function printLine(text = ""): void {
  if (!quietMode) {
    console.log(text);
  }
}

/** Writes raw command output to stdout unless `--quiet` is set. */
export function writeStdout(text: string): void {
  if (!quietMode) {
    process.stdout.write(text);
  }
}

export function printOk(message: string): void {
  printLine(`OK: ${message}`);
}

export function printError(message: string): void {
  console.error(`ERROR: ${message}`);
}

export function printWarning(message: string): void {
  if (!quietMode) {
    console.error(`WARN: ${message}`);
  }
}

export function printHint(message: string): void {
  if (!quietMode) {
    printErrorHint(message);
  }
}

function printErrorHint(message: string): void {
  console.error(`HINT: ${message}`);
}

export function handleCliError(err: unknown): void {
  logCliError(err);
  if (err instanceof CliError) {
    printError(err.message);
    for (const hint of err.hints) {
      printErrorHint(hint);
    }
    return;
  }

  if (err instanceof Error) {
    printError(err.message || "Unexpected error.");
    return;
  }

  printError("Unexpected error.");
}
