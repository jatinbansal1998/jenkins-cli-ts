import { confirm, isCancel, select, text } from "../clack";
import { markAnalyticsPollingCommand } from "../analytics";
import { resolveBuildSelector } from "../build-selector";
import { CliError, printHint } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import {
  filterTimestampedLog,
  parseSinceCutoff,
  parseTimestampResponse,
  splitLogLines,
  tailLogLines,
  timestampCapabilityError,
  transformLogLine,
} from "../log-filters";
import {
  resolvePipelineLogSelection,
  type PipelineLogIdentity,
  type PipelineLogSelection,
  type PipelineLogSource,
} from "../pipeline-logs";
import {
  emitJsonLine,
  toJsonError,
  type JsonLogIdentity,
  type JsonWrite,
} from "../json-output";
import type {
  BuildHistoryEntry,
  BuildStatus,
  ConsoleChunk,
} from "../types/jenkins";
import { parseOptionalDurationMs } from "./ops-helpers";

export const DEFAULT_LOG_POLL_MS = 1_000;
const INTERACTIVE_HISTORY_LIMIT = 10;

export type LogCancellationSignal = {
  isCancelled: () => boolean;
  readonly wait: Promise<void>;
};

type LogsRunResult = {
  cancelled: boolean;
  buildUrl?: string;
};

type LogsOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  build?: number;
  buildUrl?: string;
  queueUrl?: string;
  follow?: boolean;
  poll?: string;
  tail?: number;
  since?: string;
  stage?: string;
  stageId?: string;
  failed?: boolean;
  plain?: boolean;
  noTimestamps?: boolean;
  grep?: string;
  context?: number;
  nonInteractive: boolean;
  jsonl?: boolean;
  write?: JsonWrite;
  writeText?: (text: string) => unknown;
  cancelSignal?: LogCancellationSignal;
};

type ResolvedLogTarget = {
  buildUrl: string;
  jobLabel: string;
  build?: BuildHistoryEntry;
};

type EffectiveLogOptions = {
  follow: boolean;
  tail?: number;
  since?: string;
  stage?: string;
  stageId?: string;
  failed?: boolean;
  plain: boolean;
  noTimestamps: boolean;
  grep?: RegExp;
  context: number;
};

type LogEmitter = {
  start: (options: {
    buildUrl: string;
    buildNumber?: number;
    offset: number;
    identity?: PipelineLogIdentity;
  }) => void;
  chunk: (options: {
    text: string;
    offset: number;
    nextOffset: number;
    more: boolean;
    identity?: PipelineLogIdentity;
  }) => void;
  complete: (options: {
    buildUrl: string;
    offset: number;
    result?: string | null;
    identity?: PipelineLogIdentity;
  }) => void;
};

// flush drains any buffered partial line on paths that never reach complete
// (cancellation, streaming errors).
type PostProcessingEmitter = LogEmitter & { flush?: () => void };

type LogsDependencies = {
  select: typeof select;
  confirm: typeof confirm;
  text: typeof text;
  isCancel: typeof isCancel;
};

const defaultLogsDependencies: LogsDependencies = {
  select,
  confirm,
  text,
  isCancel,
};
let activeLogsDependencies = defaultLogsDependencies;

export function setLogsDependenciesForTesting(
  overrides: Partial<LogsDependencies> | null,
): void {
  activeLogsDependencies = overrides
    ? { ...defaultLogsDependencies, ...overrides }
    : defaultLogsDependencies;
}

export async function runLogs(options: LogsOptions): Promise<void> {
  if (options.jsonl) {
    try {
      await runLogsCore(
        { ...options, nonInteractive: true },
        createJsonlEmitter(options.write),
      );
      return;
    } catch (error) {
      emitJsonLine({ type: "error", error: toJsonError(error) }, options.write);
      process.exitCode ||= 1;
      return;
    }
  }
  await runLogsCore(options, createTextEmitter(options.writeText));
}

async function runLogsCore(
  options: LogsOptions,
  emitter: LogEmitter,
): Promise<LogsRunResult> {
  const grepRegex = validateLogOptions(options);
  const pollMs = parseOptionalDurationMs(
    options.poll,
    DEFAULT_LOG_POLL_MS,
    "poll",
  );
  if (pollMs <= 0) {
    throw new CliError("Invalid --poll value.", [
      "Use an interval greater than 0ms (e.g. --poll 1s).",
    ]);
  }

  const interactive =
    !options.nonInteractive &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY);
  const target = await resolveLogTarget(options, pollMs, interactive);
  if (!target) {
    return { cancelled: true };
  }
  const status = await options.client.getBuildStatus(target.buildUrl);
  const effective = await resolveEffectiveOptions(
    options,
    target,
    status.building === true,
    interactive,
    grepRegex,
  );
  if (!effective) {
    return { cancelled: true, buildUrl: target.buildUrl };
  }
  const outputEmitter = createPostProcessingEmitter(emitter, effective);
  if (effective.follow) {
    markAnalyticsPollingCommand();
  }

  if (!options.jsonl) {
    printHint(`Reading logs for ${target.jobLabel}.`);
  }

  const localCancellation = options.cancelSignal
    ? null
    : createLocalCancellationSignal();
  const cancelSignal = options.cancelSignal ?? localCancellation?.signal;
  let cancelled = false;
  try {
    if (effective.stage || effective.stageId || effective.failed) {
      if (effective.since) {
        throw timestampCapabilityError(
          "Jenkins Pipeline node logs do not expose per-line timestamps.",
        );
      }
      cancelled = await streamPipelineLogs({
        client: options.client,
        buildUrl: target.buildUrl,
        effective,
        pollMs,
        emitter: outputEmitter,
        cancelSignal,
        initialStatus: status,
      });
    } else {
      cancelled = await streamWholeBuildLogs({
        client: options.client,
        buildUrl: target.buildUrl,
        effective,
        pollMs,
        emitter: outputEmitter,
        cancelSignal,
        initialStatus: status,
      });
    }
  } finally {
    outputEmitter.flush?.();
    localCancellation?.cleanup();
  }

  if (cancelled) {
    if (!options.jsonl) {
      printHint(
        "Stopped local log following; the Jenkins build was not cancelled.",
      );
    }
    if (options.nonInteractive) {
      process.exitCode ||= 130;
    }
  }
  return { cancelled, buildUrl: target.buildUrl };
}

async function resolveLogTarget(
  options: LogsOptions,
  pollMs: number,
  interactive: boolean,
): Promise<ResolvedLogTarget | null> {
  const target = await resolveBuildSelector({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    build: options.build,
    buildUrl: options.buildUrl,
    queueUrl: options.queueUrl,
    nonInteractive: options.nonInteractive,
    allowQueue: true,
  });

  if (target.kind === "build") {
    return {
      buildUrl: target.buildUrl,
      jobLabel: `${target.jobLabel} #${target.buildNumber}`,
    };
  }
  if (target.kind === "queue") {
    const buildUrl = await waitForQueuedBuild(
      options.client,
      target.queueUrl,
      pollMs,
    );
    return { buildUrl, jobLabel: buildUrl };
  }

  if (interactive) {
    const page = await options.client.listBuildHistory(target.jobUrl, {
      offset: 0,
      limit: INTERACTIVE_HISTORY_LIMIT,
    });
    if (page.builds.length === 0) {
      throw noBuildsError(target.jobLabel);
    }
    const selected = await activeLogsDependencies.select({
      message: `Select a build for ${target.jobLabel}`,
      options: page.builds.map((build, index) => ({
        value: build.buildUrl,
        label: formatInteractiveBuildLabel(build, index === 0),
      })),
    });
    if (activeLogsDependencies.isCancel(selected)) {
      return null;
    }
    const build = page.builds.find((entry) => entry.buildUrl === selected);
    if (!build) {
      throw new CliError("Selected build is no longer available.");
    }
    return {
      buildUrl: build.buildUrl,
      jobLabel: `${target.jobLabel} #${build.buildNumber ?? "?"}`,
      build,
    };
  }

  const status = await options.client.getJobStatus(target.jobUrl);
  if (!status.buildUrl) {
    throw noBuildsError(target.jobLabel);
  }
  return { buildUrl: status.buildUrl, jobLabel: target.jobLabel };
}

async function resolveEffectiveOptions(
  options: LogsOptions,
  target: ResolvedLogTarget,
  building: boolean,
  interactive: boolean,
  grepRegex: RegExp | undefined,
): Promise<EffectiveLogOptions | null> {
  const effective: EffectiveLogOptions = {
    follow: options.follow ?? Boolean(process.stdout.isTTY),
    tail: options.tail,
    since: options.since,
    stage: options.stage,
    stageId: options.stageId,
    failed: options.failed,
    plain: options.plain === true,
    noTimestamps: options.noTimestamps === true,
    grep: grepRegex,
    context: options.context ?? 0,
  };
  const hasExplicitMode = Boolean(
    effective.tail ||
    effective.since ||
    effective.stage ||
    effective.stageId ||
    effective.failed ||
    effective.plain ||
    effective.noTimestamps ||
    effective.grep,
  );
  if (interactive && !hasExplicitMode) {
    const pipeline = await options.client.getPipelineDescription(
      target.buildUrl,
    );
    const mode = await activeLogsDependencies.select({
      message: "Choose log view",
      options: [
        { value: "full", label: "Full logs" },
        { value: "tail", label: "Last N lines" },
        ...(pipeline?.stages?.length
          ? [
              { value: "failed", label: "Failed section" },
              { value: "stage", label: "Pipeline stage" },
            ]
          : []),
      ],
    });
    if (activeLogsDependencies.isCancel(mode)) {
      return null;
    }
    if (mode === "tail") {
      const value = await activeLogsDependencies.text({
        message: "Number of existing lines",
        defaultValue: "100",
      });
      if (activeLogsDependencies.isCancel(value)) {
        return null;
      }
      effective.tail = parseTailValue(value);
    } else if (mode === "failed") {
      effective.failed = true;
    } else if (mode === "stage") {
      const stage = await activeLogsDependencies.select({
        message: "Select a Pipeline stage",
        options: (pipeline?.stages ?? []).map((entry) => ({
          value: String(entry.id),
          label: `${entry.name ?? `Stage ${entry.id}`} (id ${entry.id})`,
        })),
      });
      if (activeLogsDependencies.isCancel(stage)) {
        return null;
      }
      effective.stageId = String(stage);
    }
  }

  if (interactive && building && options.follow === undefined) {
    const follow = await activeLogsDependencies.confirm({
      message: "This build is running. Continue following new log output?",
      initialValue: true,
    });
    if (activeLogsDependencies.isCancel(follow)) {
      return null;
    }
    effective.follow = Boolean(follow);
  }
  return effective;
}

async function streamWholeBuildLogs(options: {
  client: JenkinsClient;
  buildUrl: string;
  effective: EffectiveLogOptions;
  pollMs: number;
  emitter: LogEmitter;
  cancelSignal?: LogCancellationSignal;
  initialStatus: BuildStatus;
}): Promise<boolean> {
  const initial = options.initialStatus;
  let offset = 0;
  options.emitter.start({
    buildUrl: initial.buildUrl ?? options.buildUrl,
    buildNumber: initial.buildNumber,
    offset,
  });

  if (options.effective.tail || options.effective.since) {
    const snapshot = await readSnapshot(
      (start) => options.client.getConsoleChunk(options.buildUrl, start),
      options.cancelSignal,
    );
    if (snapshot.cancelled) {
      return true;
    }
    let filtered = { text: snapshot.text, skippedBytes: 0 };
    if (options.effective.since) {
      const completeLines = splitLogLines(snapshot.text).filter((line) =>
        /(?:\r\n|\n|\r)$/.test(line),
      ).length;
      const duration = /^(\d+)(ms|s|m|h|d)$/i.test(options.effective.since);
      const controllerNow = duration
        ? parseTimestampResponse(
            await options.client.getConsoleTimestamps(options.buildUrl, {
              currentTime: true,
            }),
          )
        : Date.now();
      if (controllerNow === null) {
        throw timestampCapabilityError(
          "Jenkins timestamp metadata is unavailable for this build.",
        );
      }
      const timestamps = await options.client.getConsoleTimestamps(
        options.buildUrl,
        { endLine: completeLines, appendLog: true },
      );
      if (timestamps === null) {
        throw timestampCapabilityError(
          "Jenkins timestamp metadata is unavailable for this build.",
        );
      }
      filtered = filterTimestampedLog(
        timestamps,
        parseSinceCutoff(options.effective.since, controllerNow),
      );
    }
    if (options.effective.tail) {
      const tailed = tailLogLines(filtered.text, options.effective.tail);
      filtered = {
        text: tailed.text,
        skippedBytes: filtered.skippedBytes + tailed.skippedBytes,
      };
    }
    offset = snapshot.offset;
    if (filtered.text) {
      options.emitter.chunk({
        text: filtered.text,
        offset: filtered.skippedBytes,
        nextOffset: offset,
        more: options.effective.follow || snapshot.hasMore,
      });
    }
  } else {
    const streamed = await readAvailableChunks({
      getChunk: (start) =>
        options.client.getConsoleChunk(options.buildUrl, start),
      offset,
      onChunk: (chunk, start) =>
        options.emitter.chunk({
          text: chunk.text,
          offset: start,
          nextOffset: chunk.nextStart,
          more: chunk.hasMore || options.effective.follow,
        }),
      cancelSignal: options.cancelSignal,
    });
    if (streamed.cancelled) {
      return true;
    }
    offset = streamed.offset;
  }

  while (options.effective.follow) {
    if (options.cancelSignal?.isCancelled()) {
      return true;
    }
    const status = await options.client.getBuildStatus(options.buildUrl);
    if (!status.building) {
      options.emitter.complete({
        buildUrl: status.buildUrl ?? options.buildUrl,
        offset,
        result: status.result,
      });
      return false;
    }
    if (await waitForPoll(options.pollMs, options.cancelSignal)) {
      return true;
    }
    const streamed = await readAvailableChunks({
      getChunk: (start) =>
        options.client.getConsoleChunk(options.buildUrl, start),
      offset,
      onChunk: (chunk, start) =>
        options.emitter.chunk({
          text: chunk.text,
          offset: start,
          nextOffset: chunk.nextStart,
          more: true,
        }),
      cancelSignal: options.cancelSignal,
    });
    if (streamed.cancelled) {
      return true;
    }
    offset = streamed.offset;
  }

  const status = await options.client.getBuildStatus(options.buildUrl);
  options.emitter.complete({
    buildUrl: status.buildUrl ?? options.buildUrl,
    offset,
    result: status.building ? undefined : status.result,
  });
  return false;
}

async function streamPipelineLogs(options: {
  client: JenkinsClient;
  buildUrl: string;
  effective: EffectiveLogOptions;
  pollMs: number;
  emitter: LogEmitter;
  cancelSignal?: LogCancellationSignal;
  initialStatus: BuildStatus;
}): Promise<boolean> {
  let selection = await loadPipelineSelection(options);
  const identity = selectionIdentity(selection);
  const status = options.initialStatus;
  options.emitter.start({
    buildUrl: status.buildUrl ?? options.buildUrl,
    buildNumber: status.buildNumber,
    offset: 0,
    identity,
  });
  if (selection.failureReason) {
    printHint(`Pipeline failure: ${selection.failureReason}`);
  }

  const states = new Map<string, PipelineSourceState>();
  mergePipelineSources(states, selection.sources);
  let emittedBytes = 0;

  if (options.effective.tail) {
    let snapshotText = "";
    for (const state of states.values()) {
      const snapshot = await readPipelineSourceSnapshot(
        options.client,
        state,
        options.cancelSignal,
      );
      if (snapshot.cancelled) {
        return true;
      }
      state.offset = snapshot.offset;
      snapshotText += snapshot.text;
    }
    const tailed = tailLogLines(snapshotText, options.effective.tail);
    if (tailed.text) {
      const bytes = Buffer.byteLength(tailed.text);
      options.emitter.chunk({
        text: tailed.text,
        offset: tailed.skippedBytes,
        nextOffset: tailed.skippedBytes + bytes,
        more: options.effective.follow,
        identity,
      });
      emittedBytes = tailed.skippedBytes + bytes;
    }
  } else {
    for (const state of states.values()) {
      const streamed = await streamPipelineSource(
        options.client,
        state,
        options.cancelSignal,
        (textValue) => {
          const start = emittedBytes;
          emittedBytes += Buffer.byteLength(textValue);
          options.emitter.chunk({
            text: textValue,
            offset: start,
            nextOffset: emittedBytes,
            more: options.effective.follow,
            identity: state.source.identity,
          });
        },
      );
      if (streamed) {
        return true;
      }
    }
  }

  while (options.effective.follow) {
    if (options.cancelSignal?.isCancelled()) {
      return true;
    }
    const current = await options.client.getBuildStatus(options.buildUrl);
    if (!current.building) {
      options.emitter.complete({
        buildUrl: current.buildUrl ?? options.buildUrl,
        offset: emittedBytes,
        result: current.result,
        identity,
      });
      return false;
    }
    if ([...states.values()].some((entry) => !entry.source.consoleUrl)) {
      throw new CliError(
        "Jenkins exposes only a completed Pipeline node log for this running build.",
        ["Retry after the node completes, or omit --follow."],
        "PIPELINE_STAGE_LOG_UNAVAILABLE",
      );
    }
    if (await waitForPoll(options.pollMs, options.cancelSignal)) {
      return true;
    }
    selection = await loadPipelineSelection(options);
    mergePipelineSources(states, selection.sources);
    for (const state of states.values()) {
      const streamed = await streamPipelineSource(
        options.client,
        state,
        options.cancelSignal,
        (textValue) => {
          const start = emittedBytes;
          emittedBytes += Buffer.byteLength(textValue);
          options.emitter.chunk({
            text: textValue,
            offset: start,
            nextOffset: emittedBytes,
            more: true,
            identity: state.source.identity,
          });
        },
      );
      if (streamed) {
        return true;
      }
    }
  }

  options.emitter.complete({
    buildUrl: status.buildUrl ?? options.buildUrl,
    offset: emittedBytes,
    result: status.building ? undefined : status.result,
    identity,
  });
  return false;
}

type PipelineSourceState = {
  source: PipelineLogSource;
  offset: number;
  completeEmitted: boolean;
};

function mergePipelineSources(
  states: Map<string, PipelineSourceState>,
  sources: PipelineLogSource[],
): void {
  for (const source of sources) {
    const existing = states.get(source.identity.nodeId);
    if (existing) {
      existing.source = source;
      continue;
    }
    states.set(source.identity.nodeId, {
      source,
      offset: 0,
      completeEmitted: false,
    });
  }
}

async function loadPipelineSelection(options: {
  client: JenkinsClient;
  buildUrl: string;
  effective: EffectiveLogOptions;
}): Promise<PipelineLogSelection> {
  return await resolvePipelineLogSelection({
    client: options.client,
    buildUrl: options.buildUrl,
    stage: options.effective.stage,
    stageId: options.effective.stageId,
    failed: options.effective.failed,
  });
}

async function streamPipelineSource(
  client: JenkinsClient,
  state: PipelineSourceState,
  cancelSignal: LogCancellationSignal | undefined,
  onText: (text: string) => void,
): Promise<boolean> {
  if (state.source.completeText !== undefined) {
    if (!state.completeEmitted && state.source.completeText) {
      onText(state.source.completeText);
    }
    state.completeEmitted = true;
    state.offset = Buffer.byteLength(state.source.completeText);
    return false;
  }
  const streamed = await readAvailableChunks({
    getChunk: (start) =>
      client.getPipelineNodeConsoleChunk(state.source.consoleUrl!, start),
    offset: state.offset,
    onChunk: (chunk) => {
      if (chunk.text) {
        onText(chunk.text);
      }
    },
    cancelSignal,
  });
  state.offset = streamed.offset;
  return streamed.cancelled;
}

async function readPipelineSourceSnapshot(
  client: JenkinsClient,
  state: PipelineSourceState,
  cancelSignal?: LogCancellationSignal,
): Promise<SnapshotResult> {
  if (state.source.completeText !== undefined) {
    state.completeEmitted = true;
    return {
      text: state.source.completeText,
      offset: Buffer.byteLength(state.source.completeText),
      hasMore: false,
      cancelled: false,
    };
  }
  return await readSnapshot(
    (start) =>
      client.getPipelineNodeConsoleChunk(state.source.consoleUrl!, start),
    cancelSignal,
  );
}

type SnapshotResult = {
  text: string;
  offset: number;
  hasMore: boolean;
  cancelled: boolean;
};

async function readSnapshot(
  getChunk: (offset: number) => Promise<ConsoleChunk>,
  cancelSignal?: LogCancellationSignal,
): Promise<SnapshotResult> {
  let offset = 0;
  let value = "";
  while (true) {
    if (cancelSignal?.isCancelled()) {
      return { text: value, offset, hasMore: false, cancelled: true };
    }
    const chunk = await getChunk(offset);
    value += chunk.text;
    const previousOffset = offset;
    offset = chunk.nextStart;
    if (!chunk.hasMore || (offset <= previousOffset && !chunk.text)) {
      return {
        text: value,
        offset,
        hasMore: chunk.hasMore,
        cancelled: false,
      };
    }
  }
}

async function readAvailableChunks(options: {
  getChunk: (offset: number) => Promise<ConsoleChunk>;
  offset: number;
  onChunk: (chunk: ConsoleChunk, start: number) => void;
  cancelSignal?: LogCancellationSignal;
}): Promise<{ offset: number; cancelled: boolean }> {
  let offset = options.offset;
  while (true) {
    if (options.cancelSignal?.isCancelled()) {
      return { offset, cancelled: true };
    }
    const start = offset;
    const chunk = await options.getChunk(offset);
    if (chunk.text) {
      options.onChunk(chunk, start);
    }
    offset = chunk.nextStart;
    if (!chunk.hasMore || (offset <= start && !chunk.text)) {
      return { offset, cancelled: false };
    }
  }
}

async function waitForPoll(
  pollMs: number,
  signal?: LogCancellationSignal,
): Promise<boolean> {
  if (!signal) {
    await Bun.sleep(pollMs);
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, pollMs);
  });
  try {
    await Promise.race([timeout, signal.wait]);
    return signal.isCancelled();
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function createLocalCancellationSignal(): {
  signal: LogCancellationSignal;
  cleanup: () => void;
} {
  let cancelled = false;
  let resolveWait: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const onSigint = () => {
    cancelled = true;
    resolveWait?.();
  };
  process.on("SIGINT", onSigint);
  return {
    signal: { isCancelled: () => cancelled, wait },
    cleanup: () => process.off("SIGINT", onSigint),
  };
}

async function waitForQueuedBuild(
  client: JenkinsClient,
  queueUrl: string,
  pollMs: number,
): Promise<string> {
  while (true) {
    const queueBuild = await client.getQueueBuild(queueUrl);
    if (queueBuild?.buildUrl) {
      return queueBuild.buildUrl;
    }
    await Bun.sleep(pollMs);
  }
}

function validateLogOptions(options: LogsOptions): RegExp | undefined {
  const selectors = [options.stage, options.stageId, options.failed]
    .map(Boolean)
    .filter(Boolean).length;
  if (selectors > 1) {
    throw new CliError(
      "--stage, --stage-id, and --failed are mutually exclusive.",
      ["Choose exactly one Pipeline log selector."],
      "INVALID_LOG_SELECTOR",
    );
  }
  if (
    options.jsonl &&
    (options.plain || options.noTimestamps || options.grep !== undefined)
  ) {
    throw new CliError(
      "Cannot combine --jsonl with --plain, --no-timestamps, or --grep.",
      [
        "The JSONL stream reports raw console text with exact byte offsets.",
        "Filter it downstream (for example with jq), or drop --jsonl.",
      ],
      "INVALID_USAGE",
    );
  }
  if (options.tail !== undefined) {
    tailLogLines("", options.tail);
  }
  if (options.since !== undefined && !options.since.trim()) {
    throw new CliError("Invalid --since value.", [
      "Use a duration like 30m or an ISO-8601 timestamp.",
    ]);
  }
  const grep =
    options.grep !== undefined ? compileLogRegex(options.grep) : undefined;
  if (options.context !== undefined) {
    if (!Number.isSafeInteger(options.context) || options.context < 0) {
      throw new CliError("Invalid --context value.", [
        "Provide a non-negative integer number of lines, for example --context 2.",
      ]);
    }
    if (grep === undefined) {
      throw new CliError("--context requires --grep.", [
        "Provide a regular expression with --grep <regex>.",
      ]);
    }
  }
  return grep;
}

function compileLogRegex(value: string): RegExp {
  try {
    return new RegExp(value);
  } catch (error) {
    throw new CliError(`Invalid --grep regular expression "${value}".`, [
      error instanceof Error
        ? error.message
        : "Use a valid JavaScript regular expression.",
    ]);
  }
}

function parseTailValue(value: unknown): number {
  const parsed = Number(String(value).trim());
  tailLogLines("", parsed);
  return parsed;
}

function noBuildsError(jobLabel: string): CliError {
  return new CliError(`No builds found for ${jobLabel}.`, [
    "Trigger a build first, then run logs again.",
  ]);
}

function formatInteractiveBuildLabel(
  build: BuildHistoryEntry,
  latest: boolean,
): string {
  const prefix = build.building ? "Running" : latest ? "Latest" : "Recent";
  const result = build.building ? "running" : (build.result ?? "unknown");
  return `${prefix}: #${build.buildNumber ?? "?"} (${result})`;
}

function selectionIdentity(
  selection: PipelineLogSelection,
): PipelineLogIdentity {
  return {
    stageId: selection.stage.id,
    stageName: selection.stage.name,
    nodeId: selection.selected.id,
    nodeName: selection.selected.name,
    path: selection.selected.path,
  };
}

function toJsonIdentity(
  identity: PipelineLogIdentity | undefined,
): JsonLogIdentity | undefined {
  return identity ? { ...identity } : undefined;
}

function createTextEmitter(
  write: (text: string) => unknown = (value) => process.stdout.write(value),
): LogEmitter {
  return {
    start: () => undefined,
    chunk: ({ text: value }) => {
      if (value) {
        write(value);
      }
    },
    complete: () => undefined,
  };
}

function createPostProcessingEmitter(
  emitter: LogEmitter,
  options: EffectiveLogOptions,
): PostProcessingEmitter {
  if (!options.plain && !options.noTimestamps && !options.grep) {
    return emitter;
  }

  type ChunkEvent = Parameters<LogEmitter["chunk"]>[0];
  // Pipeline streaming interleaves chunks from several node logs through this
  // one emitter. A line belongs to exactly one node, so partial-line assembly
  // is keyed per node; grep context is shared because within a stage every
  // step is its own node and context must span adjacent steps. Surviving
  // lines are batched into one downstream chunk per incoming chunk; --jsonl
  // never reaches this path, so per-line offsets are not needed.
  const partials = new Map<string, string>();
  let before: string[] = [];
  let after = 0;
  let pending: string[] = [];
  let lastEvent: ChunkEvent | undefined;

  const processLine = (line: string): void => {
    const transformed = transformLogLine(line, options);
    if (transformed === null) {
      return;
    }
    if (!options.grep) {
      pending.push(transformed);
      return;
    }

    const matches = options.grep.test(
      transformed.replace(/(?:\r\n|\n|\r)$/, ""),
    );
    if (matches) {
      pending.push(...before, transformed);
      before = [];
      after = options.context;
      return;
    }
    if (after > 0) {
      pending.push(transformed);
      after--;
      return;
    }
    if (options.context > 0) {
      before.push(transformed);
      if (before.length > options.context) {
        before.shift();
      }
    }
  };
  const emitPending = (): void => {
    if (pending.length > 0 && lastEvent) {
      emitter.chunk({ ...lastEvent, text: pending.join("") });
    }
    pending = [];
  };
  const flush = (): void => {
    for (const partial of partials.values()) {
      processLine(partial);
    }
    partials.clear();
    emitPending();
  };

  return {
    start: (event) => emitter.start(event),
    chunk: (event) => {
      lastEvent = event;
      const key = event.identity?.nodeId ?? "";
      const lines = splitLogLines(`${partials.get(key) ?? ""}${event.text}`);
      partials.delete(key);
      for (const [index, lineText] of lines.entries()) {
        // The final line is carried even when it ends in a lone \r: the \n
        // half of a \r\n pair may arrive in the next chunk.
        if (index < lines.length - 1 || lineText.endsWith("\n")) {
          processLine(lineText);
        } else {
          partials.set(key, lineText);
        }
      }
      emitPending();
    },
    complete: (event) => {
      flush();
      emitter.complete(event);
    },
    flush,
  };
}

function createJsonlEmitter(write?: JsonWrite): LogEmitter {
  return {
    start: (event) =>
      emitJsonLine(
        {
          type: "start",
          buildUrl: event.buildUrl,
          buildNumber: event.buildNumber,
          offset: event.offset,
          stage: toJsonIdentity(event.identity),
        },
        write,
      ),
    chunk: (event) =>
      emitJsonLine(
        {
          type: "chunk",
          offset: event.offset,
          nextOffset: event.nextOffset,
          text: event.text,
          more: event.more,
          stage: toJsonIdentity(event.identity),
        },
        write,
      ),
    complete: (event) =>
      emitJsonLine(
        {
          type: "complete",
          buildUrl: event.buildUrl,
          offset: event.offset,
          result: event.result,
          stage: toJsonIdentity(event.identity),
        },
        write,
      ),
  };
}
