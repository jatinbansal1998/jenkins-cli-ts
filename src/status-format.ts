const ANSI_BOLD = "\u001b[1m";
const ANSI_RESET = "\u001b[0m";

export type StatusDetails = {
  building?: boolean;
  timestampMs?: number;
  durationMs?: number;
  estimatedDurationMs?: number;
  queueTimeMs?: number;
  parameters?: { name: string; value: string }[];
  stage?: { name?: string; status?: string };
};

type StatusSummaryInput = {
  jobLabel: string;
  buildNumber: number;
  result: string;
};

export function formatStatusSummary(options: StatusSummaryInput): string {
  return `Last build for ${options.jobLabel}: #${options.buildNumber} ${bold(
    options.result,
  )}`;
}

export function formatStatusDetails(
  status: StatusDetails,
  url: string,
): string {
  const lines: string[] = [];
  lines.push(formatLabelValue("URL:", url));

  const timingParts: string[] = [];
  if (typeof status.timestampMs === "number") {
    timingParts.push(
      formatLabelValue("Started:", formatLocalTime(status.timestampMs)),
    );
  }
  if (typeof status.queueTimeMs === "number" && status.queueTimeMs > 0) {
    timingParts.push(
      formatLabelValue("Queue:", formatDuration(status.queueTimeMs)),
    );
  }
  const duration = resolveDurationMs(status);
  if (duration > 0) {
    const label = status.building ? "Elapsed" : "Duration";
    let durationValue = formatDuration(duration);
    if (
      status.building &&
      typeof status.estimatedDurationMs === "number" &&
      status.estimatedDurationMs > 0
    ) {
      durationValue += ` (est ${formatDuration(status.estimatedDurationMs)})`;
    }
    timingParts.push(formatLabelValue(`${label}:`, durationValue));
  }
  if (timingParts.length > 0) {
    lines.push(timingParts.join(" | "));
  }

  const stageBranchParts: string[] = [];
  if (status.stage?.name) {
    const stageStatus = status.stage.status ? ` (${status.stage.status})` : "";
    stageBranchParts.push(
      formatLabelValue("Stage:", `${status.stage.name}${stageStatus}`),
    );
  }
  if (stageBranchParts.length > 0) {
    lines.push(stageBranchParts.join(" | "));
  }

  const paramsLines = formatParams(status.parameters);
  if (paramsLines.length > 0) {
    lines.push(...paramsLines);
  }

  return lines.join("\n");
}

export function formatCompactStatus(options: {
  buildNumber?: number;
  result: string;
  status: StatusDetails;
}): string {
  const parts: string[] = [];
  if (typeof options.buildNumber === "number") {
    parts.push(`#${options.buildNumber}`);
  }
  parts.push(options.result);

  const duration = resolveDurationMs(options.status);
  if (duration > 0) {
    const label = options.status.building ? "Elapsed" : "Duration";
    let durationValue = formatDuration(duration);
    if (
      options.status.building &&
      typeof options.status.estimatedDurationMs === "number" &&
      options.status.estimatedDurationMs > 0
    ) {
      durationValue += ` (est ${formatDuration(options.status.estimatedDurationMs)})`;
    }
    parts.push(`${label}: ${durationValue}`);
  }

  if (options.status.stage?.name) {
    const stageStatus = options.status.stage.status
      ? ` (${options.status.stage.status})`
      : "";
    parts.push(`Stage: ${options.status.stage.name}${stageStatus}`);
  }

  return parts.join(" | ");
}

function bold(value: string): string {
  return `${ANSI_BOLD}${value}${ANSI_RESET}`;
}

function formatLabelValue(label: string, value: string): string {
  return `${bold(label)} ${value}`;
}

function resolveDurationMs(status: StatusDetails): number {
  if (
    status.building &&
    typeof status.timestampMs === "number" &&
    status.timestampMs > 0
  ) {
    return Math.max(0, Date.now() - status.timestampMs);
  }
  if (typeof status.durationMs === "number") {
    return status.durationMs;
  }
  return 0;
}

function formatLocalTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString();
}

function formatParams(
  params: { name: string; value: string }[] | undefined,
): string[] {
  if (!params || params.length === 0) {
    return [];
  }
  const entries = params
    .map((param) => `${param.name}=${sanitizeInline(param.value)}`)
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return [];
  }
  const prefixLabel = "Params:";
  const prefix = `${bold(prefixLabel)} `;
  const indent = " ".repeat(prefixLabel.length + 1);
  const chunks = chunkEntries(entries, 4);
  return chunks.map((chunk, index) => {
    const label = index === 0 ? prefix : indent;
    return `${label}${chunk.join(", ")}`;
  });
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function chunkEntries(entries: string[], maxItems: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < entries.length; i += maxItems) {
    chunks.push(entries.slice(i, i + maxItems));
  }
  return chunks;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
