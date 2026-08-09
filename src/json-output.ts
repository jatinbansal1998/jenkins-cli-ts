/**
 * Structured JSON output helpers for the read commands (`--json`).
 *
 * When `--json` is set, a command must print EXACTLY one JSON document to
 * stdout and nothing else. These helpers own the success/error envelope and a
 * single Jenkins build mapper so that `status`, `history`, and `wait` all agree
 * on field names.
 *
 * Following the repo convention, the emit helpers accept an optional `write`
 * callback so tests can capture stdout without spying on `process.stdout`.
 */
import { CliError } from "./cli";
import type {
  ArtifactEntry,
  BuildHistoryEntry,
  BuildStatus,
  JenkinsBuildParameter,
  JenkinsPipelineStage,
  JenkinsRevision,
  JobStatus,
  NodeSummary,
  NodesSummary,
  QueueItemSummary,
  RunningBuildSummary,
  TriggerBuildResult,
} from "./types/jenkins";
import type { AuthDiagnosticsResult } from "./auth-diagnostics";
import type { ProfileListResult } from "./profile-operations";

/** Sink for the single JSON document. Defaults to stdout. */
export type JsonWrite = (text: string) => void;

const defaultWrite: JsonWrite = (text) => {
  process.stdout.write(text);
};

/** Normalized pipeline stage in JSON output. */
type JsonStage = {
  name?: string;
  status?: string;
  durationMs?: number;
};

/** Normalized Jenkins build in JSON output. Shared by status/history/wait. */
export type JsonBuild = {
  number?: number;
  url?: string;
  result: string | null;
  building: boolean;
  durationMs?: number;
  timestampMs?: number;
  estimatedDurationMs?: number;
  queueTimeMs?: number;
  branch?: string;
  revisions: JenkinsRevision[];
  parameters?: JenkinsBuildParameter[];
  stages?: JsonStage[];
};

type JsonSuccess<T> = {
  ok: true;
  command: string;
  data: T;
};

type JsonErrorBody = {
  message: string;
  code: string;
};

type JsonError = {
  ok: false;
  error: JsonErrorBody;
};

type JsonQueueItem = {
  id: number;
  url: string;
  jobName?: string;
  jobUrl?: string;
  state: "stuck" | "blocked" | "buildable" | "waiting";
  reason?: string;
  inQueueSinceMs?: number;
};

type JsonNode = {
  name: string;
  status: "online" | "offline" | "temporarily-offline";
  offlineReason?: string;
  labels: string[];
  executors: { busy: number; total: number };
};

type JsonNodes = {
  nodes: JsonNode[];
  summary: {
    totalNodes: number;
    offlineNodes: number;
    busyExecutors: number;
    totalExecutors: number;
  };
};

type JsonRunningBuild = {
  jobName: string;
  fullJobName?: string;
  number: number;
  url: string;
};

type JsonArtifact = {
  fileName: string;
  relativePath: string;
};

type JsonMutationTarget = {
  queueUrl?: string;
  queueId?: number;
  buildUrl?: string;
  buildNumber?: number;
  jobUrl?: string;
};

export type JsonBuildReceipt = JsonMutationTarget & {
  job: string;
  queued: boolean;
  result?: string | null;
};

export type JsonCancelReceipt = {
  targetType: "build" | "queue";
  url: string;
  buildNumber?: number;
};

export type JsonRerunReceipt = {
  source: { buildUrl?: string; buildNumber?: number };
  target: JsonMutationTarget;
};

export type JsonAuthStatus = Omit<AuthDiagnosticsResult, "problemHints">;

export type JsonAuthCurrent = {
  source: string;
  profile: string;
  controller?: string;
  username?: string;
  tokenStorage?: string;
  tokenPresent?: boolean;
  keychainReadError?: boolean;
};

export type JsonUpdateCheck = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  channel: string;
  installReason?: string;
  checkedAt: string;
};

type JsonLogEvent =
  | {
      type: "start";
      buildUrl: string;
      buildNumber?: number;
      offset: number;
      stage?: JsonLogIdentity;
    }
  | {
      type: "chunk";
      offset: number;
      nextOffset: number;
      text: string;
      more: boolean;
      stage?: JsonLogIdentity;
    }
  | {
      type: "complete";
      buildUrl: string;
      offset: number;
      result?: string | null;
      stage?: JsonLogIdentity;
    }
  | {
      type: "error";
      error: JsonErrorBody;
    };

export type JsonLogIdentity = {
  stageId: string;
  stageName: string;
  nodeId?: string;
  nodeName?: string;
  path: string;
};

/** Emit a success envelope: `{ ok: true, command, data }`. */
export function emitJsonSuccess<T>(
  command: string,
  data: T,
  write: JsonWrite = defaultWrite,
): void {
  const payload: JsonSuccess<T> = { ok: true, command, data };
  write(`${JSON.stringify(payload)}\n`);
}

/** Emit an error envelope: `{ ok: false, error: { message, code } }`. */
export function emitJsonError(
  error: JsonErrorBody,
  write: JsonWrite = defaultWrite,
): void {
  const payload: JsonError = { ok: false, error };
  write(`${JSON.stringify(payload)}\n`);
}

/** Emit one compact JSON event followed by a newline. */
export function emitJsonLine(
  event: JsonLogEvent,
  write: JsonWrite = defaultWrite,
): void {
  write(`${JSON.stringify(event)}\n`);
}

/** Convert an arbitrary thrown value into a stable JSON error body. */
export function toJsonError(error: unknown): JsonErrorBody {
  if (error instanceof CliError) {
    return { message: error.message, code: error.code ?? "CLI_ERROR" };
  }
  if (error instanceof Error) {
    return {
      message: error.message || "Unexpected error.",
      code: "UNEXPECTED_ERROR",
    };
  }
  return { message: "Unexpected error.", code: "UNEXPECTED_ERROR" };
}

/**
 * Run a read command in JSON mode. Emits exactly one document: the success
 * envelope produced by `run`, or an error envelope if `run` throws. On error,
 * sets a non-zero exit code unless one was already set (preserves command
 * specific exit codes such as `wait`'s 124/130).
 */
export async function runJsonCommand<T>(
  command: string,
  run: () => Promise<T>,
  options: { write?: JsonWrite } = {},
): Promise<void> {
  const write = options.write ?? defaultWrite;
  try {
    const data = await run();
    emitJsonSuccess(command, data, write);
  } catch (error) {
    emitJsonError(toJsonError(error), write);
    if (!process.exitCode) {
      process.exitCode = 1;
    }
  }
}

type MapBuildInput = {
  number?: number;
  url?: string;
  result?: string | null;
  building?: boolean;
  timestampMs?: number;
  durationMs?: number;
  estimatedDurationMs?: number;
  queueTimeMs?: number;
  branch?: string;
  revisions?: JenkinsRevision[];
  parameters?: JenkinsBuildParameter[];
  stages?: JenkinsPipelineStage[];
};

function mapStages(
  stages: JenkinsPipelineStage[] | undefined,
): JsonStage[] | undefined {
  if (!Array.isArray(stages) || stages.length === 0) {
    return undefined;
  }
  return stages.map((stage) => ({
    name: stage.name,
    status: stage.status,
    durationMs: stage.durationMillis,
  }));
}

/**
 * Single source of truth for serializing a Jenkins build to JSON. Undefined
 * fields are dropped by `JSON.stringify`, keeping the document compact.
 */
export function mapBuild(input: MapBuildInput): JsonBuild {
  return {
    number: input.number,
    url: input.url,
    result: input.result ?? null,
    building: input.building ?? false,
    durationMs: input.durationMs,
    timestampMs: input.timestampMs,
    estimatedDurationMs: input.estimatedDurationMs,
    queueTimeMs: input.queueTimeMs,
    branch: input.branch,
    revisions: input.revisions ?? [],
    parameters: input.parameters,
    stages: mapStages(input.stages),
  };
}

export function jsonBuildFromJobStatus(status: JobStatus): JsonBuild {
  return mapBuild({
    number: status.lastBuildNumber,
    url: status.lastBuildUrl,
    result: status.result,
    building: status.building,
    timestampMs: status.lastBuildTimestamp,
    durationMs: status.lastBuildDurationMs,
    estimatedDurationMs: status.lastBuildEstimatedDurationMs,
    queueTimeMs: status.queueTimeMs,
    branch: status.branch,
    revisions: status.revisions,
    parameters: status.parameters,
    stages: status.stages,
  });
}

export function jsonBuildFromBuildStatus(status: BuildStatus): JsonBuild {
  return mapBuild({
    number: status.buildNumber,
    url: status.buildUrl,
    result: status.result,
    building: status.building,
    timestampMs: status.timestampMs,
    durationMs: status.durationMs,
    estimatedDurationMs: status.estimatedDurationMs,
    queueTimeMs: status.queueTimeMs,
    branch: status.branch,
    revisions: status.revisions,
    parameters: status.parameters,
    stages: status.stages,
  });
}

export function jsonBuildFromHistoryEntry(entry: BuildHistoryEntry): JsonBuild {
  return mapBuild({
    number: entry.buildNumber,
    url: entry.buildUrl,
    result: entry.result,
    building: entry.building,
    timestampMs: entry.timestampMs,
    durationMs: entry.durationMs,
    estimatedDurationMs: entry.estimatedDurationMs,
    branch: entry.branch,
    revisions: entry.revisions,
    parameters: entry.parameters,
    stages: entry.stages,
  });
}

export function jsonQueueItem(item: QueueItemSummary): JsonQueueItem {
  return {
    id: item.id,
    url: item.queueUrl,
    jobName: item.jobName,
    jobUrl: item.jobUrl,
    state: item.stuck
      ? "stuck"
      : item.blocked
        ? "blocked"
        : item.buildable
          ? "buildable"
          : "waiting",
    reason: item.reason,
    inQueueSinceMs: item.inQueueSince,
  };
}

export function jsonNodes(
  summary: NodesSummary,
  nodes: NodeSummary[] = summary.nodes,
): JsonNodes {
  return {
    nodes: nodes.map((node) => ({
      name: node.displayName,
      status: node.temporarilyOffline
        ? "temporarily-offline"
        : node.offline
          ? "offline"
          : "online",
      offlineReason: node.offlineCauseReason,
      labels: node.labels,
      executors: {
        busy: node.busyExecutors,
        total: node.totalExecutors,
      },
    })),
    summary: {
      totalNodes: summary.totalNodes,
      offlineNodes: summary.offlineNodes,
      busyExecutors: summary.busyExecutors,
      totalExecutors: summary.totalExecutors,
    },
  };
}

export function jsonRunningBuild(build: RunningBuildSummary): JsonRunningBuild {
  return {
    jobName: build.jobName,
    fullJobName: build.fullJobName,
    number: build.buildNumber,
    url: build.buildUrl,
  };
}

export function jsonArtifact(artifact: ArtifactEntry): JsonArtifact {
  return {
    fileName: artifact.fileName,
    relativePath: artifact.relativePath,
  };
}

export function jsonTriggerTarget(
  result: TriggerBuildResult,
): JsonMutationTarget {
  return {
    queueUrl: result.queueUrl,
    queueId: result.queueId ?? queueIdFromUrl(result.queueUrl),
    buildUrl: result.buildUrl,
    buildNumber: result.buildNumber,
    jobUrl: result.jobUrl,
  };
}

export function jsonAuthProfiles(result: ProfileListResult): ProfileListResult {
  return result;
}

function queueIdFromUrl(url: string | undefined): number | undefined {
  const match = url?.match(/\/queue\/item\/(\d+)\/?$/);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}
