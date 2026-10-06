/**
 * CLI output utilities and error handling.
 * Provides standardized output prefixes (OK:, ERROR:, WARN:, HINT:) for easy parsing.
 */
import path from "node:path";
import type { ErrorCode } from "./error-codes";
import { logCliError } from "./logger";
import { NATIVE_RELEASE_TARGETS } from "./release-targets";

/** A job the caller may have meant. `name` is the full display name. */
export type JobCandidate = {
  name: string;
  url: string;
};

/**
 * Machine-readable context for `--json` consumers, keyed by the error code
 * that carries it. A code gets its own shape by adding an entry here.
 */
type CliErrorDetailsByCode = {
  JOB_AMBIGUOUS: { candidates: JobCandidate[] };
  JOB_NOT_FOUND: { candidates: JobCandidate[] };
};

type DetailedErrorCode = keyof CliErrorDetailsByCode;

export type CliErrorDetails = CliErrorDetailsByCode[DetailedErrorCode];

/** One `[code, options]` pair per detailed code, so details match their code. */
type DetailedCodeAndOptions = {
  [C in DetailedErrorCode]: [
    code: C,
    options?: ErrorOptions & { details?: CliErrorDetailsByCode[C] },
  ];
}[DetailedErrorCode];

/** Structured error with hints for user guidance. `code` sets the exit code. */
export class CliError extends Error {
  public readonly hints: string[];
  public readonly code: ErrorCode;
  public readonly details?: CliErrorDetails;

  constructor(
    message: string,
    hints: string[],
    ...args: DetailedCodeAndOptions
  );
  constructor(
    message: string,
    hints: string[],
    code: ErrorCode,
    options?: ErrorOptions,
  );
  constructor(
    message: string,
    hints: string[],
    code: ErrorCode,
    options?: ErrorOptions & { details?: CliErrorDetails },
  ) {
    super(message, options);
    this.name = "CliError";
    this.hints = hints;
    this.code = code;
    this.details = options?.details;
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
