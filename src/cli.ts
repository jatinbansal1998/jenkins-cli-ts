/**
 * CLI output utilities and error handling.
 * Provides standardized output prefixes (OK:, ERROR:, HINT:) for easy parsing.
 */
import path from "node:path";

/** Structured error with optional hints for user guidance. */
export class CliError extends Error {
  public readonly hints: string[];

  constructor(message: string, hints: string[] = []) {
    super(message);
    this.name = "CliError";
    this.hints = hints;
  }
}

const DEFAULT_SCRIPT_NAME = "jenkins-cli";

export function getScriptName(): string {
  const rawScriptName = process.argv[1]
    ? path.basename(process.argv[1])
    : DEFAULT_SCRIPT_NAME;
  return rawScriptName === "index.ts" ? DEFAULT_SCRIPT_NAME : rawScriptName;
}

export function printOk(message: string): void {
  console.log(`OK: ${message}`);
}

export function printError(message: string): void {
  console.error(`ERROR: ${message}`);
}

export function printHint(message: string): void {
  console.error(`HINT: ${message}`);
}

export function handleCliError(err: unknown): void {
  if (err instanceof CliError) {
    printError(err.message);
    for (const hint of err.hints) {
      printHint(hint);
    }
    return;
  }

  if (err instanceof Error) {
    printError(err.message || "Unexpected error.");
    return;
  }

  printError("Unexpected error.");
}
