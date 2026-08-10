import { CliError } from "./cli";

type FilteredLog = {
  text: string;
  skippedBytes: number;
};

type LogLineTransformOptions = {
  plain: boolean;
  noTimestamps: boolean;
};

const ESC = "\u001b";
const BEL = "\u0007";
const CONCEALED_JENKINS_METADATA = new RegExp(
  `${ESC}\\[8mha:/{4}.*?${ESC}\\[0m`,
  "g",
);
const OSC_SEQUENCE = new RegExp(
  `${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
);
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const ESC_SEQUENCE = new RegExp(`${ESC}[@-_]`, "g");
const LOG_TIMESTAMP_PREFIX =
  /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\]\s?/;

export function parseSinceCutoff(value: string, nowMs: number): number {
  const input = value.trim();
  const duration = input.match(/^(\d+)(ms|s|m|h|d)$/i);
  if (duration) {
    const amount = Number(duration[1]);
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return nowMs - amount * multipliers[duration[2]!.toLowerCase()]!;
  }

  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) {
    throw new CliError(`Invalid --since value "${input}".`, [
      "Use a duration like 30m or an ISO-8601 timestamp like 2026-08-01T12:00:00Z.",
    ]);
  }
  return timestamp;
}

export function filterLogSince(
  text: string,
  timestampText: string,
  cutoffMs: number,
): FilteredLog {
  const lines = splitLogLines(text);
  const completeLineCount = countCompleteLines(lines);
  const timestamps = timestampText
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (completeLineCount === 0) {
    return { text, skippedBytes: 0 };
  }
  if (timestamps.length !== completeLineCount) {
    throw timestampCapabilityError(
      `Jenkins returned ${timestamps.length} timestamps for ${completeLineCount} complete log lines.`,
    );
  }

  const parsed = timestamps.map((entry) => Date.parse(entry));
  if (parsed.some((entry) => !Number.isFinite(entry))) {
    throw timestampCapabilityError(
      "Jenkins returned timestamp metadata in an unsupported format.",
    );
  }

  const firstIncluded = parsed.findIndex((timestamp) => timestamp >= cutoffMs);
  const index = firstIncluded < 0 ? completeLineCount : firstIncluded;
  const skipped = lines.slice(0, index).join("");
  return {
    text: lines.slice(index).join(""),
    skippedBytes: Buffer.byteLength(skipped),
  };
}

export function filterTimestampedLog(
  timestampedText: string,
  cutoffMs: number,
): FilteredLog {
  const output: string[] = [];
  let timestampCount = 0;
  for (const line of splitLogLines(timestampedText)) {
    const withoutEnding = line.replace(/(?:\r\n|\n|\r)$/, "");
    const ending = line.slice(withoutEnding.length);
    const match = withoutEnding.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2}))  (.*)$/,
    );
    if (!match) {
      continue;
    }
    timestampCount++;
    const timestamp = Date.parse(match[1]!);
    if (!Number.isFinite(timestamp)) {
      throw timestampCapabilityError(
        "Jenkins returned timestamp metadata in an unsupported format.",
      );
    }
    if (timestamp >= cutoffMs) {
      output.push(`${match[2] ?? ""}${ending || "\n"}`);
    }
  }
  if (timestampCount === 0) {
    throw timestampCapabilityError(
      "Jenkins did not expose timestamps for any log lines in this build.",
    );
  }
  return { text: output.join(""), skippedBytes: 0 };
}

export function tailLogLines(text: string, count: number): FilteredLog {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new CliError("Invalid --tail value.", [
      "Provide a positive integer number of lines, for example --tail 100.",
    ]);
  }
  const lines = splitLogLines(text);
  const start = Math.max(0, lines.length - count);
  const skipped = lines.slice(0, start).join("");
  return {
    text: lines.slice(start).join(""),
    skippedBytes: Buffer.byteLength(skipped),
  };
}

export function splitLogLines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
}

export function transformLogLine(
  line: string,
  options: LogLineTransformOptions,
): string | null {
  const body = line.replace(/(?:\r\n|\n|\r)$/, "");
  const ending = line.slice(body.length);
  let transformed = body;

  if (options.plain) {
    transformed = transformed
      .replace(CONCEALED_JENKINS_METADATA, "")
      .replace(OSC_SEQUENCE, "")
      .replace(CSI_SEQUENCE, "")
      .replace(ESC_SEQUENCE, "")
      .replaceAll(ESC, "");
    if (/^\[Pipeline\](?:\s|$)/.test(stripLogTimestamp(transformed))) {
      return null;
    }
  }
  if (options.noTimestamps) {
    transformed = stripLogTimestamp(transformed);
  }

  return `${transformed}${ending}`;
}

export function parseTimestampResponse(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const first = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!first) {
    return null;
  }
  const parsed = Date.parse(first);
  return Number.isFinite(parsed) ? parsed : null;
}

export function timestampCapabilityError(message: string): CliError {
  return new CliError(
    message,
    ["Enable Jenkins Timestamper metadata for this build, or omit --since."],
    "TIMESTAMP_METADATA_UNAVAILABLE",
  );
}

function countCompleteLines(lines: string[]): number {
  return lines.filter((line) => /(?:\r\n|\n|\r)$/.test(line)).length;
}

function stripLogTimestamp(line: string): string {
  return line.replace(LOG_TIMESTAMP_PREFIX, "");
}
