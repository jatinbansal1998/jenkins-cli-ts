import { CliError } from "./cli";

/**
 * Parses `500ms`, `30s`, `5m`, `1h`; a bare number is milliseconds. `label`
 * names the source in errors, e.g. `--timeout` or `JENKINS_TIMEOUT_MS`.
 */
export function parseDurationMs(
  input: string | undefined,
  label: string,
): number {
  const value = input?.trim() ?? "";
  if (!value) {
    throw new CliError(
      `Missing ${label}.`,
      [`Provide ${label} with a duration like 30s, 5m, or 1h.`],
      "INVALID_USAGE",
    );
  }
  const match = value.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    throw new CliError(
      `Invalid ${label} value "${value}".`,
      ["Use duration values like 500ms, 30s, 5m, or 1h."],
      "INVALID_USAGE",
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  const multiplier = multipliers[unit];
  if (!multiplier || !Number.isFinite(amount) || amount < 0) {
    throw new CliError(
      `Invalid ${label} value "${value}".`,
      ["Use duration values like 500ms, 30s, 5m, or 1h."],
      "INVALID_USAGE",
    );
  }
  return Math.floor(amount * multiplier);
}

export function parseOptionalDurationMs(
  input: string | undefined,
  fallbackMs: number,
  label: string,
): number {
  if (!input || !input.trim()) {
    return fallbackMs;
  }
  return parseDurationMs(input, label);
}
