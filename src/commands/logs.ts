import { CliError, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import {
  ensureValidUrl,
  parseOptionalDurationMs,
  resolveJobTarget,
} from "./ops-helpers";

type LogsOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  buildUrl?: string;
  queueUrl?: string;
  follow?: boolean;
  poll?: string;
  nonInteractive: boolean;
};

export async function runLogs(options: LogsOptions): Promise<void> {
  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }
  if (options.buildUrl && (options.job || options.jobUrl)) {
    throw new CliError(
      "When --build-url is provided, do not pass --job or --job-url.",
      ["Use a single log target at a time."],
    );
  }

  const follow = options.follow !== false;
  const pollMs = parseOptionalDurationMs(options.poll, 2_000, "poll");
  if (pollMs <= 0) {
    throw new CliError("Invalid --poll value.", [
      "Use an interval greater than 0ms (e.g. --poll 2s).",
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

async function resolveBuildUrl(
  options: LogsOptions,
  pollMs: number,
): Promise<{ buildUrl: string; jobLabel: string }> {
  const providedBuildUrl = options.buildUrl?.trim() ?? "";
  if (providedBuildUrl) {
    ensureValidUrl(providedBuildUrl, "build-url");
    return {
      buildUrl: providedBuildUrl,
      jobLabel: providedBuildUrl,
    };
  }

  const queueUrl = options.queueUrl?.trim() ?? "";
  if (queueUrl) {
    ensureValidUrl(queueUrl, "queue-url");
    const buildUrl = await waitForQueuedBuild(options.client, queueUrl, pollMs);
    return {
      buildUrl,
      jobLabel: buildUrl,
    };
  }

  const target = await resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: options.nonInteractive,
  });
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
}): Promise<void> {
  let start = 0;

  while (true) {
    const chunk = await options.client.getConsoleChunk(options.buildUrl, start);
    if (chunk.text) {
      process.stdout.write(chunk.text);
    }
    start = chunk.nextStart;
    if (!options.follow) {
      return;
    }

    if (chunk.hasMore) {
      await Bun.sleep(options.pollMs);
      continue;
    }

    const status = await options.client.getBuildStatus(options.buildUrl);
    if (!status.building) {
      return;
    }
    await Bun.sleep(options.pollMs);
  }
}
