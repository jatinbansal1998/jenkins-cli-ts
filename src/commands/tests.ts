import { resolveBuildSelector } from "../build-selector";
import { CliError } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import { runJsonCommand, type JsonWrite } from "../json-output";
import { formatDuration } from "../status-format";
import type { BuildTestReport, TestFailure } from "../types/jenkins";

type TestsOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  build?: number;
  buildUrl?: string;
  failed?: boolean;
  nonInteractive: boolean;
  json?: boolean;
  write?: JsonWrite;
};

const defaultWrite: JsonWrite = (text) => {
  process.stdout.write(text);
};

export async function runTests(options: TestsOptions): Promise<void> {
  if (options.json) {
    await runJsonCommand(
      "tests",
      async () => toJsonTestReport(await loadTestReport(options)),
      { write: options.write },
    );
    return;
  }

  const report = await loadTestReport(options);
  (options.write ?? defaultWrite)(renderTestReport(report));
}

async function loadTestReport(options: TestsOptions): Promise<BuildTestReport> {
  const target = await resolveBuildSelector({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    build: options.build,
    buildUrl: options.buildUrl,
    nonInteractive: options.nonInteractive,
  });
  const resolved = await resolveCompletedBuild(options.client, target);
  const status = await options.client.getBuildStatus(resolved.buildUrl);
  return await options.client.getTestReport(resolved.buildUrl, {
    includeFailures: Boolean(options.failed),
    buildNumber: status.buildNumber ?? resolved.buildNumber,
    buildResult: status.result,
  });
}

async function resolveCompletedBuild(
  client: JenkinsClient,
  target: Awaited<ReturnType<typeof resolveBuildSelector>>,
): Promise<{ buildUrl: string; buildNumber?: number }> {
  if (target.kind === "build") {
    return { buildUrl: target.buildUrl, buildNumber: target.buildNumber };
  }
  if (target.kind !== "job") {
    throw new CliError("Tests require a build or job target.");
  }
  const completed = await client.getLastCompletedBuild(target.jobUrl);
  if (!completed) {
    throw new CliError(
      `No completed builds found for ${target.jobLabel}.`,
      ["Trigger a build first, or pass --build <number> or --build-url <url>."],
      "NO_COMPLETED_BUILD",
    );
  }
  return completed;
}

function toJsonTestReport(report: BuildTestReport): object {
  return {
    build: {
      number: report.buildNumber,
      url: report.buildUrl,
      result: report.buildResult,
    },
    summary: {
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      skipped: report.skipped,
      durationMs: report.durationMs,
    },
    ...(report.failures ? { failures: report.failures } : {}),
    reportUrl: report.reportUrl,
  };
}

function renderTestReport(report: BuildTestReport): string {
  const build = report.buildNumber ? `#${report.buildNumber}` : report.buildUrl;
  const result = report.buildResult ? ` (${report.buildResult})` : "";
  const lines = [
    `Build: ${build}${result}`,
    `Tests: ${report.total} total | ${report.passed} passed | ${report.failed} failed | ${report.skipped} skipped`,
  ];
  if (report.durationMs !== undefined) {
    lines.push(`Duration: ${formatDuration(report.durationMs)}`);
  }
  lines.push(`Report: ${report.reportUrl}`);

  if (report.failures) {
    lines.push("");
    if (report.failures.length === 0) {
      lines.push("No failing tests.");
    } else {
      lines.push(...report.failures.flatMap(renderFailure));
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderFailure(failure: TestFailure, index: number): string[] {
  const identity = [failure.suite, failure.className, failure.name]
    .filter(Boolean)
    .join(" > ");
  const duration =
    failure.durationMs === undefined
      ? ""
      : ` (${formatDuration(failure.durationMs)})`;
  const lines = [`FAIL ${index + 1}: ${identity}${duration}`];
  if (failure.message) {
    lines.push(failure.message);
  }
  if (failure.stackTrace) {
    lines.push(failure.stackTrace);
  }
  lines.push("");
  return lines;
}
