/**
 * Status command implementation.
 * Shows the last build status (number, result, URL) for a job.
 */
import { autocomplete, confirm, isCancel, select, text } from "../clack";
import { runInteractiveSubcommandWithAnalytics } from "../analytics";
import { CliError, printError, printHint, printOk } from "../cli";
import {
  jsonBuildFromJobStatus,
  type JsonBuild,
  type JsonWrite,
  runJsonCommand,
} from "../json-output";
import { runBuild } from "./build";
import { runCancel } from "./cancel";
import { runHistory } from "./history";
import { runLogs } from "./logs";
import { resolveJobTarget, resolveJobTargets } from "./ops-helpers";
import { runRerun, runRerunLastBuild } from "./rerun";
import { runWait } from "./wait";
import {
  getKnownStageTotal,
  persistKnownTotalStages,
} from "../stage-count-cache";
import {
  formatStatusDetails,
  formatStatusSummary,
  toStatusDetailsFromJob,
} from "../status-format";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import { normalizeOptionalJobUrl } from "../job-url";
import { recordRecentJob } from "../recent-jobs";
import { runFlow } from "../flows/runner";
import { flows } from "../flows/definition";
import { statusFlowHandlers } from "../flows/handlers";
import type { ActionEffectResult, StatusPostContext } from "../flows/types";

/** Options for the status command. */
type StatusOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
  watch?: boolean;
  json?: boolean;
  write?: JsonWrite;
};

/** JSON payload for the status command. */
type StatusJsonData = {
  job: string;
  build: JsonBuild | null;
};

const SEPARATOR_LINE = "-".repeat(60);

export async function runStatus(options: StatusOptions): Promise<void> {
  if (options.json) {
    await runStatusJson(options);
    return;
  }

  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }

  if (options.nonInteractive) {
    await runStatusOnce(options);
    return;
  }

  let jobUrl = normalizeOptionalJobUrl(options.jobUrl);
  let jobQuery = options.job?.trim() ?? "";

  while (true) {
    let targets: { jobUrl: string; jobLabel: string }[] = [];

    if (jobUrl) {
      ensureValidUrl(jobUrl, "job-url");
      targets = [{ jobUrl, jobLabel: jobUrl }];
    } else {
      targets = await resolveJobTargets({
        client: options.client,
        env: options.env,
        job: jobQuery,
        nonInteractive: false,
        mode: "multiple",
      });
    }

    const showSeparators = targets.length > 1;
    for (const [index, target] of targets.entries()) {
      if (showSeparators && index > 0) {
        console.log("");
        console.log(SEPARATOR_LINE);
      }
      await recordRecentJob({
        env: options.env,
        jobUrl: target.jobUrl,
      });

      const status = await options.client.getJobStatus(target.jobUrl);
      if (!status.lastBuildNumber) {
        printOk(`No builds found for ${target.jobLabel || target.jobUrl}.`);
        continue;
      }

      const result = status.building ? "RUNNING" : status.result || "UNKNOWN";
      const url = status.lastBuildUrl || target.jobUrl;
      const knownTotalStages = await getKnownStageTotal({
        env: options.env,
        jobUrl: target.jobUrl,
        buildUrl: url,
      });
      const summary = formatStatusSummary({
        jobLabel: target.jobLabel || target.jobUrl,
        buildNumber: status.lastBuildNumber,
        result,
      });
      const details = formatStatusDetails(
        toStatusDetailsFromJob(status, { knownTotalStages }),
        url,
      );
      printOk(details ? `${summary}\n${details}` : summary);
      if (!status.building && (result === "SUCCESS" || result === "UNSTABLE")) {
        await persistKnownTotalStages({
          env: options.env,
          jobUrl: target.jobUrl,
          buildUrl: url,
          stages: status.stages,
          jobLabel: target.jobLabel,
        });
      }

      if (options.watch) {
        await runWait({
          client: options.client,
          env: options.env,
          jobUrl: target.jobUrl,
          nonInteractive: false,
          suppressExitCode: true,
        });
      }
    }

    const primaryTarget = targets.length === 1 ? targets[0] : undefined;
    const postContext: StatusPostContext = {
      env: options.env,
      targetLabel: primaryTarget?.jobLabel || "selected jobs",
      performAction: async (action): Promise<ActionEffectResult> => {
        if (!primaryTarget) {
          return "action_error";
        }
        if (action === "watch") {
          const result = await runTrackedStatusAction("wait", () =>
            runMenuAction(async () =>
              runWait({
                client: options.client,
                env: options.env,
                jobUrl: primaryTarget.jobUrl,
                nonInteractive: false,
                suppressExitCode: true,
              }),
            ),
          );
          if (!result) {
            return "action_error";
          }
          return result.cancelled ? "watch_cancelled" : "action_ok";
        }
        if (action === "logs") {
          const result = await runTrackedStatusAction("logs", () =>
            runMenuAction(async () => {
              await runLogs({
                client: options.client,
                env: options.env,
                jobUrl: primaryTarget.jobUrl,
                follow: true,
                nonInteractive: false,
              });
              return "action_ok";
            }),
          );
          return (result ?? "action_error") as ActionEffectResult;
        }
        if (action === "history") {
          const result = await runTrackedStatusAction("history", () =>
            runMenuAction(async () => {
              await runHistory({
                client: options.client,
                env: options.env,
                jobUrl: primaryTarget.jobUrl,
                nonInteractive: false,
              });
              return "action_ok";
            }),
          );
          return (result ?? "action_error") as ActionEffectResult;
        }
        if (action === "cancel") {
          const result = await runTrackedStatusAction("cancel", () =>
            runMenuAction(async () => {
              await runCancel({
                client: options.client,
                env: options.env,
                jobUrl: primaryTarget.jobUrl,
                nonInteractive: false,
              });
              return "action_ok";
            }),
          );
          return (result ?? "action_error") as ActionEffectResult;
        }
        if (action === "rerun") {
          const result = await runTrackedStatusAction("rerun", () =>
            runMenuAction(async () => {
              await runRerun({
                client: options.client,
                env: options.env,
                jobUrl: primaryTarget.jobUrl,
                nonInteractive: false,
              });
              return "action_ok";
            }),
          );
          return (result ?? "action_error") as ActionEffectResult;
        }
        if (action === "rerun_last") {
          const result = await runTrackedStatusAction("rerun-last", () =>
            runMenuAction(async () => {
              await runRerunLastBuild({
                client: options.client,
                env: options.env,
                jobUrl: primaryTarget.jobUrl,
                nonInteractive: false,
              });
              return "action_ok";
            }),
          );
          return (result ?? "action_error") as ActionEffectResult;
        }
        if (action === "build") {
          const result = await runTrackedStatusAction("build", () =>
            runMenuAction(async () => {
              const buildResult = await runBuild({
                client: options.client,
                env: options.env,
                jobUrl: primaryTarget.jobUrl,
                branchParam: options.env.branchParamDefault,
                defaultBranch: false,
                nonInteractive: false,
                returnToCaller: true,
              });
              return buildResult.rootRequested ? "root" : "action_ok";
            }),
          );
          return (result ?? "action_error") as ActionEffectResult;
        }
        return "action_error";
      },
    };

    const postResult = await runFlow({
      definition: flows.statusPost,
      handlers: statusFlowHandlers,
      prompts: { autocomplete, confirm, isCancel, select, text },
      context: postContext,
      ...(primaryTarget ? {} : { startStateId: "again_confirm" }),
    });

    if (postResult.terminal === "repeat") {
      jobUrl = undefined;
      jobQuery = "";
      continue;
    }

    return;
  }
}

async function runStatusJson(options: StatusOptions): Promise<void> {
  await runJsonCommand(
    "status",
    async (): Promise<StatusJsonData> => {
      if (options.watch) {
        throw new CliError(
          "Cannot combine --watch with --json.",
          ["The --json output is a single document. Drop --watch or --json."],
          "INVALID_USAGE",
        );
      }
      if (options.job && options.jobUrl) {
        throw new CliError("Provide either --job or --job-url, not both.", [
          "Remove one of the flags and try again.",
        ]);
      }

      const target = await resolveJobTarget({
        client: options.client,
        env: options.env,
        job: options.job,
        jobUrl: options.jobUrl,
        nonInteractive: true,
      });

      await recordRecentJob({ env: options.env, jobUrl: target.jobUrl });

      const status = await options.client.getJobStatus(target.jobUrl);
      return {
        job: target.jobLabel,
        build: status.lastBuildNumber ? jsonBuildFromJobStatus(status) : null,
      };
    },
    { write: options.write },
  );
}

async function runStatusOnce(options: StatusOptions): Promise<void> {
  const { jobUrl, jobLabel } = await resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: options.nonInteractive,
  });

  await recordRecentJob({
    env: options.env,
    jobUrl,
  });

  const status = await options.client.getJobStatus(jobUrl);
  if (!status.lastBuildNumber) {
    printOk(`No builds found for ${jobLabel || jobUrl}.`);
    return;
  }

  const result = status.building ? "RUNNING" : status.result || "UNKNOWN";
  const url = status.lastBuildUrl || jobUrl;
  const knownTotalStages = await getKnownStageTotal({
    env: options.env,
    jobUrl,
    buildUrl: url,
  });
  const summary = formatStatusSummary({
    jobLabel: jobLabel || jobUrl,
    buildNumber: status.lastBuildNumber,
    result,
  });
  const details = formatStatusDetails(
    toStatusDetailsFromJob(status, { knownTotalStages }),
    url,
  );
  printOk(details ? `${summary}\n${details}` : summary);
  if (!status.building && (result === "SUCCESS" || result === "UNSTABLE")) {
    await persistKnownTotalStages({
      env: options.env,
      jobUrl,
      buildUrl: url,
      stages: status.stages,
      jobLabel,
    });
  }

  if (options.watch) {
    await runWait({
      client: options.client,
      env: options.env,
      jobUrl,
      nonInteractive: true,
      suppressExitCode: false,
    });
  }
}

async function runTrackedStatusAction<T>(
  command: string,
  action: () => Promise<T>,
): Promise<T> {
  return await runInteractiveSubcommandWithAnalytics(command, action);
}

async function runMenuAction<T>(
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

function ensureValidUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw new CliError(`Invalid --${label} value.`, [
      `Provide a full URL like https://jenkins.example.com/job/example/.`,
    ]);
  }
}
