import { CliError, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import type { BuildHistoryEntry, BuildHistoryPage } from "../types/jenkins";
import { historyDeps } from "./history-deps";
import { withPromptTarget } from "../tui-target";

const HISTORY_PAGE_SIZE = 5;
const NEXT_PAGE_VALUE = "__jenkins_cli_history_next__";
const PREVIOUS_PAGE_VALUE = "__jenkins_cli_history_previous__";
const BACK_VALUE = "__jenkins_cli_history_back__";
const REBUILD_VALUE = "__jenkins_cli_history_rebuild__";
const LOGS_VALUE = "__jenkins_cli_history_logs__";
const URL_VALUE = "__jenkins_cli_history_url__";

type HistoryOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
  offset?: number;
};

export async function runHistory(options: HistoryOptions): Promise<void> {
  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }

  const target = await historyDeps.resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: options.nonInteractive,
  });
  const initialOffset = normalizeOffset(options.offset);

  if (options.nonInteractive) {
    const page = await options.client.listBuildHistory(target.jobUrl, {
      offset: initialOffset,
      limit: HISTORY_PAGE_SIZE,
    });
    renderBuildHistory(page, target.jobLabel);
    return;
  }

  let offset = initialOffset;
  while (true) {
    const page = await options.client.listBuildHistory(target.jobUrl, {
      offset,
      limit: HISTORY_PAGE_SIZE,
    });

    if (page.builds.length === 0) {
      printOk(`No builds found for ${target.jobLabel}.`);
      return;
    }

    renderBuildHistory(page, target.jobLabel);
    const selection = await historyDeps.select({
      message: withPromptTarget("Select a build or action", options.env),
      options: buildHistoryOptions(page),
    });
    if (historyDeps.isCancel(selection) || selection === BACK_VALUE) {
      return;
    }
    if (selection === NEXT_PAGE_VALUE) {
      offset += HISTORY_PAGE_SIZE;
      continue;
    }
    if (selection === PREVIOUS_PAGE_VALUE) {
      offset = Math.max(0, offset - HISTORY_PAGE_SIZE);
      continue;
    }

    const selectedBuild = page.builds.find(
      (entry) => entry.buildUrl === String(selection),
    );
    if (!selectedBuild) {
      continue;
    }

    await runBuildHistoryAction({
      client: options.client,
      env: options.env,
      jobLabel: target.jobLabel,
      jobUrl: target.jobUrl,
      build: selectedBuild,
    });
  }
}

async function runBuildHistoryAction(options: {
  client: JenkinsClient;
  env: EnvConfig;
  jobLabel: string;
  jobUrl: string;
  build: BuildHistoryEntry;
}): Promise<void> {
  while (true) {
    const selection = await historyDeps.select({
      message: withPromptTarget(
        `Build #${options.build.buildNumber ?? "?"} for ${options.jobLabel}`,
        options.env,
      ),
      options: [
        { value: REBUILD_VALUE, label: "Rebuild with same parameters" },
        { value: LOGS_VALUE, label: "Logs" },
        { value: URL_VALUE, label: "Show URL" },
        { value: BACK_VALUE, label: "Back" },
      ],
    });
    if (historyDeps.isCancel(selection) || selection === BACK_VALUE) {
      return;
    }
    if (selection === URL_VALUE) {
      printOk(`Build URL: ${options.build.buildUrl}`);
      continue;
    }
    if (selection === LOGS_VALUE) {
      await historyDeps.runLogs({
        client: options.client,
        env: options.env,
        buildUrl: options.build.buildUrl,
        follow: true,
        nonInteractive: false,
      });
      continue;
    }
    if (selection === REBUILD_VALUE) {
      const params = toParamRecord(options.build.parameters);
      const result = await options.client.triggerBuild(options.jobUrl, params);

      try {
        await historyDeps.recordRecentJob({
          env: options.env,
          jobUrl: options.jobUrl,
        });
      } catch {
        // Ignore cache write failures for rebuild success.
      }

      if (options.build.branch) {
        try {
          await historyDeps.recordBranchSelection({
            env: options.env,
            jobUrl: options.jobUrl,
            branch: options.build.branch,
          });
        } catch {
          // Ignore cache write failures for rebuild success.
        }
      }

      const buildNumber =
        typeof options.build.buildNumber === "number"
          ? `#${options.build.buildNumber}`
          : options.build.buildUrl;
      printOk(`Rebuilding ${options.jobLabel} from ${buildNumber}.`);
      if (result.buildUrl) {
        printOk(`Build started at ${result.buildUrl}.`);
      } else if (result.queueUrl) {
        printOk(
          `Build queued for ${options.jobLabel}. Track at ${result.queueUrl}.`,
        );
      } else {
        printOk(`Build triggered for ${options.jobLabel}.`);
      }
      return;
    }
  }
}

function renderBuildHistory(page: BuildHistoryPage, jobLabel: string): void {
  if (page.builds.length === 0) {
    printOk(`No builds found for ${jobLabel}.`);
    return;
  }

  const rangeStart = page.offset + 1;
  const rangeEnd = page.offset + page.builds.length;
  printOk(
    `Showing builds ${rangeStart}-${rangeEnd} of ${page.total} for ${jobLabel}.`,
  );
  console.log(formatBuildHistoryTable(page.builds));
  const failureDetails = formatFailureDetails(page.builds);
  if (failureDetails) {
    console.log("");
    console.log(failureDetails);
  }
}

function buildHistoryOptions(
  page: BuildHistoryPage,
): { value: string; label: string }[] {
  const options = page.builds.map((build) => ({
    value: build.buildUrl,
    label: formatBuildOptionLabel(build),
  }));
  if (page.hasPrevious) {
    options.push({ value: PREVIOUS_PAGE_VALUE, label: "Previous 5" });
  }
  if (page.hasNext) {
    options.push({ value: NEXT_PAGE_VALUE, label: "Next 5" });
  }
  options.push({ value: BACK_VALUE, label: "Back" });
  return options;
}

function formatBuildOptionLabel(build: BuildHistoryEntry): string {
  const status = resolveBuildResult(build);
  const failedStep = build.failure?.stepName || build.failure?.stageName || "-";
  return `#${build.buildNumber ?? "?"} ${status} ${failedStep}`;
}

function formatBuildHistoryTable(builds: BuildHistoryEntry[]): string {
  const rows = [
    ["#", "Status", "Started", "Duration", "Branch", "Failed Step"],
    ...builds.map((build) => [
      String(build.buildNumber ?? "-"),
      resolveBuildResult(build),
      formatHistoryTimestamp(build.timestampMs),
      formatHistoryDuration(build),
      truncateCell(build.branch || "-", 18),
      truncateCell(
        build.failure?.stepName || build.failure?.stageName || "-",
        24,
      ),
    ]),
  ];
  const widths = rows[0]?.map((_, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  ) ?? [1, 1, 1, 1, 1, 1];
  return rows
    .map((row) =>
      row
        .map((cell, cellIndex) =>
          padCell(cell, widths[cellIndex] ?? cell.length),
        )
        .join("  "),
    )
    .map((line, index) =>
      index === 1 ? `${"-".repeat(line.length)}\n${line}` : line,
    )
    .join("\n");
}

function formatFailureDetails(builds: BuildHistoryEntry[]): string {
  const failedBuilds = builds.filter((build) => build.failure);
  if (failedBuilds.length === 0) {
    return "";
  }
  const lines = ["Failed build details:"];
  for (const build of failedBuilds) {
    const identifier =
      typeof build.buildNumber === "number"
        ? `#${build.buildNumber}`
        : build.buildUrl;
    const step =
      build.failure?.stepName || build.failure?.stageName || "Unknown step";
    const reason =
      build.failure?.reason || "No failure reason returned by Jenkins.";
    lines.push(`${identifier} | ${step}`);
    lines.push(`Reason: ${reason}`);
    lines.push(`URL: ${build.buildUrl}`);
    lines.push("");
  }
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function resolveBuildResult(build: BuildHistoryEntry): string {
  if (build.building) {
    return "RUNNING";
  }
  return build.result || "UNKNOWN";
}

function formatHistoryTimestamp(timestampMs: number | undefined): string {
  if (typeof timestampMs !== "number" || timestampMs <= 0) {
    return "-";
  }
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function formatHistoryDuration(build: BuildHistoryEntry): string {
  const durationMs = resolveHistoryDuration(build);
  if (durationMs <= 0) {
    return "-";
  }
  return formatDuration(durationMs);
}

function resolveHistoryDuration(build: BuildHistoryEntry): number {
  if (
    build.building &&
    typeof build.timestampMs === "number" &&
    build.timestampMs > 0
  ) {
    return Math.max(0, Date.now() - build.timestampMs);
  }
  return typeof build.durationMs === "number" ? build.durationMs : 0;
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

function padCell(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function truncateCell(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) {
    return value;
  }
  if (maxWidth <= 3) {
    return value.slice(0, maxWidth);
  }
  return `${value.slice(0, maxWidth - 3)}...`;
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value) || typeof value !== "number") {
    return 0;
  }
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : 0;
}

function toParamRecord(
  params: { name: string; value: string }[] | undefined,
): Record<string, string> {
  if (!params || params.length === 0) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const param of params) {
    const key = param.name.trim();
    if (!key) {
      continue;
    }
    result[key] = param.value;
  }
  return result;
}
