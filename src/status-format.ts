import type {
  BuildStatus,
  JenkinsPipelineStage,
  JobStatus,
} from "./types/jenkins";

const ANSI_BOLD = "\u001b[1m";
const ANSI_RESET = "\u001b[0m";

export type StatusDetails = {
  building?: boolean;
  timestampMs?: number;
  durationMs?: number;
  estimatedDurationMs?: number;
  queueTimeMs?: number;
  parameters?: { name: string; value: string }[];
  stages?: JenkinsPipelineStage[];
  knownTotalStages?: number;
};

export function toStatusDetailsFromBuild(
  status: BuildStatus,
  options: { knownTotalStages?: number } = {},
): StatusDetails {
  return {
    building: status.building,
    timestampMs: status.timestampMs,
    durationMs: status.durationMs,
    estimatedDurationMs: status.estimatedDurationMs,
    queueTimeMs: status.queueTimeMs,
    parameters: status.parameters,
    stages: status.stages,
    knownTotalStages: options.knownTotalStages,
  };
}

export function toStatusDetailsFromJob(
  status: JobStatus,
  options: { knownTotalStages?: number } = {},
): StatusDetails {
  return {
    building: status.building,
    timestampMs: status.lastBuildTimestamp,
    durationMs: status.lastBuildDurationMs,
    estimatedDurationMs: status.lastBuildEstimatedDurationMs,
    queueTimeMs: status.queueTimeMs,
    parameters: status.parameters,
    stages: status.stages,
    knownTotalStages: options.knownTotalStages,
  };
}

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

  const stageText = formatStageText({
    stages: status.stages,
    building: status.building,
    knownTotalStages: status.knownTotalStages,
  });
  if (stageText) {
    lines.push(formatLabelValue("Stage:", stageText));
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

  const stageText = formatStageText({
    stages: options.status.stages,
    building: options.status.building,
    knownTotalStages: options.status.knownTotalStages,
  });
  if (stageText) {
    parts.push(stageText);
  }

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

function formatStageText(options: {
  stages: JenkinsPipelineStage[] | undefined;
  building?: boolean;
  knownTotalStages?: number;
}): string | undefined {
  const stageDisplay = resolveStageDisplay(options.stages);
  if (!stageDisplay.stage?.name) {
    return undefined;
  }
  const stageStatus = stageDisplay.stage.status
    ? ` (${stageDisplay.stage.status})`
    : "";
  if (options.building) {
    const knownTotalStages = resolveKnownTotalStages({
      knownTotalStages: options.knownTotalStages,
      observedStageCount: options.stages?.length,
      stageNumber: stageDisplay.stageNumber,
    });
    if (
      typeof stageDisplay.stageNumber === "number" &&
      typeof knownTotalStages === "number" &&
      knownTotalStages > 1
    ) {
      return `[${stageDisplay.stageNumber}/${knownTotalStages}] ${stageDisplay.stage.name}${stageStatus}`;
    }
    if (typeof stageDisplay.stageNumber === "number") {
      return `${stageDisplay.stageNumber}: ${stageDisplay.stage.name}${stageStatus}`;
    }
    return `${stageDisplay.stage.name}${stageStatus}`;
  }

  const totalStages =
    stageDisplay.totalStages ??
    resolveKnownTotalStages({
      knownTotalStages: options.knownTotalStages,
      observedStageCount: options.stages?.length,
      stageNumber: stageDisplay.stageNumber,
    });
  const progressPrefix =
    typeof stageDisplay.stageNumber === "number" &&
    typeof totalStages === "number" &&
    totalStages > 1
      ? `[${stageDisplay.stageNumber}/${totalStages}] `
      : "";
  return `${progressPrefix}${stageDisplay.stage.name}${stageStatus}`;
}

function resolveStageDisplay(stages: JenkinsPipelineStage[] | undefined): {
  stage?: JenkinsPipelineStage;
  stageNumber?: number;
  totalStages?: number;
} {
  if (!Array.isArray(stages) || stages.length === 0) {
    return {};
  }
  const activeStageIndex = stages.findIndex((stage) =>
    isActiveStageStatus(stage.status),
  );
  if (activeStageIndex >= 0) {
    return {
      stage: stages[activeStageIndex],
      stageNumber: activeStageIndex + 1,
      totalStages: stages.length,
    };
  }

  const completedStageCount = stages.filter((stage) =>
    isTerminalStageStatus(stage.status),
  ).length;
  const lastStage =
    stages.findLast((stage) => Boolean(stage.name || stage.status)) ??
    stages.at(-1);
  return {
    stage: lastStage,
    stageNumber:
      completedStageCount > 0
        ? Math.min(completedStageCount, stages.length)
        : 1,
    totalStages: stages.length,
  };
}

function isActiveStageStatus(status: string | undefined): boolean {
  const normalized = (status ?? "").trim().toUpperCase();
  return normalized === "IN_PROGRESS" || normalized === "PAUSED_PENDING_INPUT";
}

function isTerminalStageStatus(status: string | undefined): boolean {
  const normalized = (status ?? "").trim().toUpperCase();
  return (
    normalized === "SUCCESS" ||
    normalized === "UNSTABLE" ||
    normalized === "FAILED" ||
    normalized === "FAILURE" ||
    normalized === "ABORTED" ||
    normalized === "NOT_EXECUTED" ||
    normalized === "SKIPPED_FOR_CONDITIONAL"
  );
}

function resolveKnownTotalStages(options: {
  knownTotalStages?: number;
  observedStageCount?: number;
  stageNumber?: number;
}): number | undefined {
  if (
    typeof options.knownTotalStages !== "number" ||
    options.knownTotalStages <= 0
  ) {
    return undefined;
  }
  if (
    typeof options.observedStageCount === "number" &&
    options.knownTotalStages < options.observedStageCount
  ) {
    return undefined;
  }
  if (
    typeof options.stageNumber === "number" &&
    options.knownTotalStages < options.stageNumber
  ) {
    return undefined;
  }
  return options.knownTotalStages;
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
