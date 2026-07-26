import { markAnalyticsPollingCommand } from "../analytics";
import { CliError, printOk } from "../cli";
import { resolveBuildSelector } from "../build-selector";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import { parseOptionalDurationMs } from "./ops-helpers";
import { emitJsonLine, toJsonError, type JsonWrite } from "../json-output";

export const DEFAULT_LOG_POLL_MS = 1_000;

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
  nonInteractive: boolean;
  jsonl?: boolean;
  write?: JsonWrite;
};

export async function runLogs(options: LogsOptions): Promise<void> {
  if (options.jsonl) {
    await runLogsJsonl({ ...options, nonInteractive: true }, options.write);
    return;
  }
  const follow = options.follow !== false;
  if (follow) {
    markAnalyticsPollingCommand();
  }
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

  const { buildUrl, jobLabel } = await resolveBuildUrl(options, pollMs);
  printOk(`Streaming logs for ${jobLabel}.`);
  await streamLogs({
    client: options.client,
    buildUrl,
    follow,
    pollMs,
  });
}

async function runLogsJsonl(
  options: LogsOptions,
  write?: JsonWrite,
): Promise<void> {
  try {
    const follow = options.follow !== false;
    if (follow) {
      markAnalyticsPollingCommand();
    }
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
    const { buildUrl } = await resolveBuildUrl(options, pollMs);
    const initial = await options.client.getBuildStatus(buildUrl);
    emitJsonLine(
      {
        type: "start",
        buildUrl: initial.buildUrl ?? buildUrl,
        buildNumber: initial.buildNumber,
        offset: 0,
      },
      write,
    );

    let offset = 0;
    while (true) {
      const chunk = await options.client.getConsoleChunk(buildUrl, offset);
      const status =
        !chunk.hasMore || !follow
          ? await options.client.getBuildStatus(buildUrl)
          : undefined;
      if (chunk.text) {
        emitJsonLine(
          {
            type: "chunk",
            offset,
            nextOffset: chunk.nextStart,
            text: chunk.text,
            more: chunk.hasMore || Boolean(follow && status?.building),
          },
          write,
        );
      }
      offset = chunk.nextStart;
      if (!follow) {
        emitJsonLine(
          {
            type: "complete",
            buildUrl: status?.buildUrl ?? buildUrl,
            offset,
            result: status?.building ? undefined : status?.result,
          },
          write,
        );
        return;
      }
      if (chunk.hasMore) {
        await Bun.sleep(pollMs);
        continue;
      }
      if (!status?.building) {
        emitJsonLine(
          {
            type: "complete",
            buildUrl: status?.buildUrl ?? buildUrl,
            offset,
            result: status?.result,
          },
          write,
        );
        return;
      }
      await Bun.sleep(pollMs);
    }
  } catch (error) {
    emitJsonLine({ type: "error", error: toJsonError(error) }, write);
    if (!process.exitCode) {
      process.exitCode = 1;
    }
  }
}

async function resolveBuildUrl(
  options: LogsOptions,
  pollMs: number,
): Promise<{ buildUrl: string; jobLabel: string }> {
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
    return {
      buildUrl,
      jobLabel: buildUrl,
    };
  }

  const status = await options.client.getJobStatus(target.jobUrl);
  if (!status.lastBuildUrl) {
    throw new CliError(`No builds found for ${target.jobLabel}.`, [
      "Trigger a build first, then run logs again.",
    ]);
  }
  return {
    buildUrl: status.lastBuildUrl,
    jobLabel: target.jobLabel,
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

async function streamLogs(options: {
  client: JenkinsClient;
  buildUrl: string;
  follow: boolean;
  pollMs: number;
}): Promise<number> {
  let start = 0;
  let streamedBytes = 0;

  while (true) {
    const chunk = await options.client.getConsoleChunk(options.buildUrl, start);
    if (chunk.text) {
      process.stdout.write(chunk.text);
      streamedBytes += Buffer.byteLength(chunk.text);
    }
    start = chunk.nextStart;
    if (!options.follow) {
      return streamedBytes;
    }

    if (chunk.hasMore) {
      await Bun.sleep(options.pollMs);
      continue;
    }

    const status = await options.client.getBuildStatus(options.buildUrl);
    if (!status.building) {
      return streamedBytes;
    }
    await Bun.sleep(options.pollMs);
  }
}
