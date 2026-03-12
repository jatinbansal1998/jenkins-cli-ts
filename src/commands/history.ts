import { CliError, printError, printHint, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import type { BuildHistoryEntry, BuildHistoryPage } from "../types/jenkins";
import { runFlow } from "../flows/runner";
import { flows } from "../flows/definition";
import { buildFlowHandlers } from "../flows/handlers";
import type { ActionEffectResult, BuildPostContext } from "../flows/types";
import { historyDeps } from "./history-deps";
import { printRerunResult, rerunLastBuildForJob } from "./rerun-core";
import { withPromptTarget } from "../tui-target";

const HISTORY_PAGE_SIZE = 5;
const NEXT_PAGE_VALUE = "__jenkins_cli_history_next__";
const PREVIOUS_PAGE_VALUE = "__jenkins_cli_history_previous__";
const BACK_VALUE = "__jenkins_cli_history_back__";
const REBUILD_VALUE = "__jenkins_cli_history_rebuild__";
const RERUN_LAST_VALUE = "__jenkins_cli_history_rerun_last__";
const LOGS_VALUE = "__jenkins_cli_history_logs__";
const URL_VALUE = "__jenkins_cli_history_url__";

export type HistoryActiveBuild = {
  buildUrl?: string;
  buildNumber?: number;
  queueUrl?: string;
};

type HistoryOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
  offset?: number;
};

export type HistoryRunResult = {
  activeBuild?: HistoryActiveBuild;
};

let activeHistoryDeps = historyDeps;

export function setHistoryDepsForTesting(overrides?: typeof historyDeps): void {
  activeHistoryDeps = overrides ?? historyDeps;
}

export async function runHistory(
  options: HistoryOptions,
): Promise<HistoryRunResult> {
  const deps = activeHistoryDeps;
  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }

  const target = await deps.resolveJobTarget({
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
    return {};
  }

  let offset = initialOffset;
  let latestActiveBuild: HistoryActiveBuild | undefined;
  while (true) {
    const page = await options.client.listBuildHistory(target.jobUrl, {
      offset,
      limit: HISTORY_PAGE_SIZE,
    });

    if (page.builds.length === 0) {
      printOk(`No builds found for ${target.jobLabel}.`);
      return latestActiveBuild ? { activeBuild: latestActiveBuild } : {};
    }

    renderBuildHistory(page, target.jobLabel);
    const selection = await deps.select({
      message: withPromptTarget("Select a build or action", options.env),
      options: buildHistoryOptions(page),
    });
    if (deps.isCancel(selection) || selection === BACK_VALUE) {
      return latestActiveBuild ? { activeBuild: latestActiveBuild } : {};
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

    const result = await runBuildHistoryAction({
      client: options.client,
      env: options.env,
      jobLabel: target.jobLabel,
      jobUrl: target.jobUrl,
      build: selectedBuild,
    });
    if (result.activeBuild) {
      latestActiveBuild = result.activeBuild;
    }
  }
}

async function runBuildHistoryAction(options: {
  client: JenkinsClient;
  env: EnvConfig;
  jobLabel: string;
  jobUrl: string;
  build: BuildHistoryEntry;
}): Promise<HistoryRunResult> {
  const deps = activeHistoryDeps;
  while (true) {
    const selection = await deps.select({
      message: withPromptTarget(
        `Build #${options.build.buildNumber ?? "?"} for ${options.jobLabel}`,
        options.env,
      ),
      options: [
        { value: REBUILD_VALUE, label: "Rebuild selected build" },
        { value: RERUN_LAST_VALUE, label: "Rerun last build for job" },
        { value: LOGS_VALUE, label: "Logs" },
        { value: URL_VALUE, label: "Show URL" },
        { value: BACK_VALUE, label: "Back" },
      ],
    });
    if (deps.isCancel(selection) || selection === BACK_VALUE) {
      return {};
    }
    if (selection === URL_VALUE) {
      printOk(`Build URL: ${options.build.buildUrl}`);
      continue;
    }
    if (selection === LOGS_VALUE) {
      await deps.runLogs({
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

      await recordHistoryRebuildSuccess({
        env: options.env,
        jobUrl: options.jobUrl,
        branch: options.build.branch,
      });

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

      const activeBuild = await runHistoryRebuildPostFlow({
        client: options.client,
        env: options.env,
        jobLabel: options.jobLabel,
        jobUrl: options.jobUrl,
        params,
        branch: extractBranchFromParams(params) ?? options.build.branch,
        activeBuild: {
          buildUrl: result.buildUrl,
          buildNumber: result.buildNumber,
          queueUrl: result.queueUrl,
        },
      });
      return { activeBuild };
    }
    if (selection === RERUN_LAST_VALUE) {
      const rerun = await rerunLastBuildForJob({
        client: options.client,
        env: options.env,
        jobUrl: options.jobUrl,
        jobLabel: options.jobLabel,
      });
      printRerunResult({
        jobLabel: options.jobLabel,
        jobUrl: options.jobUrl,
        source: "last build",
        rerun,
      });

      const activeBuild = await runHistoryRebuildPostFlow({
        client: options.client,
        env: options.env,
        jobLabel: options.jobLabel,
        jobUrl: options.jobUrl,
        params: rerun.params,
        branch: extractBranchFromParams(rerun.params) ?? options.build.branch,
        activeBuild: {
          buildUrl: rerun.result.buildUrl,
          buildNumber: rerun.result.buildNumber,
          queueUrl: rerun.result.queueUrl,
        },
      });
      return { activeBuild };
    }
  }
}

async function runHistoryRebuildPostFlow(options: {
  client: JenkinsClient;
  env: EnvConfig;
  jobLabel: string;
  jobUrl: string;
  params: Record<string, string>;
  branch?: string;
  activeBuild: HistoryActiveBuild;
}): Promise<HistoryActiveBuild> {
  const deps = activeHistoryDeps;
  let activeBuild = { ...options.activeBuild };
  const context: BuildPostContext = {
    env: options.env,
    jobLabel: options.jobLabel,
    returnToCaller: true,
    performAction: async (action): Promise<ActionEffectResult> => {
      if (action === "watch") {
        const result = await runHistoryMenuAction(async () =>
          deps.runWait({
            client: options.client,
            env: options.env,
            buildUrl: activeBuild.buildUrl,
            queueUrl: activeBuild.queueUrl,
            jobUrl:
              !activeBuild.buildUrl && !activeBuild.queueUrl
                ? options.jobUrl
                : undefined,
            nonInteractive: false,
            suppressExitCode: true,
          }),
        );
        if (!result) {
          return "action_error";
        }
        activeBuild = {
          buildUrl: result.buildUrl ?? activeBuild.buildUrl,
          buildNumber: result.buildNumber ?? activeBuild.buildNumber,
          queueUrl: result.buildUrl ? undefined : activeBuild.queueUrl,
        };
        return result.cancelled ? "watch_cancelled" : "action_ok";
      }

      if (action === "logs") {
        const result = await runHistoryMenuAction(async () => {
          await deps.runLogs({
            client: options.client,
            env: options.env,
            buildUrl: activeBuild.buildUrl,
            queueUrl: activeBuild.queueUrl,
            jobUrl:
              !activeBuild.buildUrl && !activeBuild.queueUrl
                ? options.jobUrl
                : undefined,
            follow: true,
            nonInteractive: false,
          });
          return "action_ok";
        });
        return (result ?? "action_error") as ActionEffectResult;
      }

      if (action === "history") {
        const result = await runHistoryMenuAction(async () => {
          const historyResult = await runHistory({
            client: options.client,
            env: options.env,
            jobUrl: options.jobUrl,
            nonInteractive: false,
          });
          if (historyResult.activeBuild) {
            activeBuild = { ...historyResult.activeBuild };
          }
          return "action_ok";
        });
        return (result ?? "action_error") as ActionEffectResult;
      }

      if (action === "cancel") {
        const result = await runHistoryMenuAction(async () => {
          await deps.runCancel({
            client: options.client,
            env: options.env,
            buildUrl: activeBuild.buildUrl,
            queueUrl: activeBuild.queueUrl,
            jobUrl:
              !activeBuild.buildUrl && !activeBuild.queueUrl
                ? options.jobUrl
                : undefined,
            nonInteractive: false,
          });
          return "action_ok";
        });
        return (result ?? "action_error") as ActionEffectResult;
      }

      if (action === "rerun") {
        const result = await runHistoryMenuAction(async () => {
          const rerunResult = await options.client.triggerBuild(
            options.jobUrl,
            options.params,
          );
          activeBuild = {
            buildUrl: rerunResult.buildUrl,
            buildNumber: rerunResult.buildNumber,
            queueUrl: rerunResult.queueUrl,
          };
          await recordHistoryRebuildSuccess({
            env: options.env,
            jobUrl: options.jobUrl,
            branch: options.branch,
          });
          if (rerunResult.buildUrl) {
            printOk(`Build started at ${rerunResult.buildUrl}.`);
          } else if (rerunResult.queueUrl) {
            printOk(`Build queued for ${options.jobLabel}.`);
          } else {
            printOk(`Build triggered for ${options.jobLabel}.`);
          }
          return "action_ok";
        });
        return (result ?? "action_error") as ActionEffectResult;
      }

      if (action === "rerun_last") {
        const result = await runHistoryMenuAction(async () => {
          const rerun = await rerunLastBuildForJob({
            client: options.client,
            env: options.env,
            jobUrl: options.jobUrl,
            jobLabel: options.jobLabel,
          });
          activeBuild = {
            buildUrl: rerun.result.buildUrl,
            buildNumber: rerun.result.buildNumber,
            queueUrl: rerun.result.queueUrl,
          };
          printRerunResult({
            jobLabel: options.jobLabel,
            jobUrl: options.jobUrl,
            source: "last build",
            rerun,
          });
          return "action_ok";
        });
        return (result ?? "action_error") as ActionEffectResult;
      }

      return "action_error";
    },
  };

  await runFlow({
    definition: flows.buildPost,
    handlers: buildFlowHandlers,
    prompts: {
      confirm: deps.confirm,
      isCancel: deps.isCancel,
      select: deps.select,
      text: deps.text,
    },
    context,
  });
  return activeBuild;
}

async function runHistoryMenuAction<T>(
  action: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CliError) {
      printError(error.message);
      for (const hint of error.hints) {
        printHint(hint);
      }
      return undefined;
    }
    throw error;
  }
}

async function recordHistoryRebuildSuccess(options: {
  env: EnvConfig;
  jobUrl: string;
  branch?: string;
}): Promise<void> {
  const deps = activeHistoryDeps;
  try {
    await deps.recordRecentJob({
      env: options.env,
      jobUrl: options.jobUrl,
    });
  } catch {
    // Ignore cache write failures for rebuild success.
  }

  if (!options.branch) {
    return;
  }

  try {
    await deps.recordBranchSelection({
      env: options.env,
      jobUrl: options.jobUrl,
      branch: options.branch,
    });
  } catch {
    // Ignore cache write failures for rebuild success.
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

function extractBranchFromParams(
  params: Record<string, string>,
): string | undefined {
  const candidates = [
    "BRANCH",
    "BRANCH_TAG",
    "GIT_BRANCH",
    "BRANCH_NAME",
    "REF",
    "TAG",
  ];

  for (const key of candidates) {
    const value = params[key];
    if (value) {
      return value;
    }
  }

  const fallback = Object.entries(params).find(
    ([name, value]) => name.toLowerCase().includes("branch") && value,
  );
  return fallback?.[1];
}
