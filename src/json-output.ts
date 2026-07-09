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
  BuildHistoryEntry,
  BuildStatus,
  JenkinsBuildParameter,
  JenkinsPipelineStage,
  JobStatus,
} from "./types/jenkins";

/** Sink for the single JSON document. Defaults to stdout. */
export type JsonWrite = (text: string) => void;

const defaultWrite: JsonWrite = (text) => {
  process.stdout.write(text);
};

/** Normalized pipeline stage in JSON output. */
export type JsonStage = {
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
  parameters?: JenkinsBuildParameter[];
  stages?: JsonStage[];
};

export type JsonSuccess<T> = {
  ok: true;
  command: string;
  data: T;
};

export type JsonErrorBody = {
  message: string;
  code: string;
};

export type JsonError = {
  ok: false;
  error: JsonErrorBody;
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
    parameters: entry.parameters,
    stages: entry.stages,
  });
}
