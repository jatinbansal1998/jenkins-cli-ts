/**
 * List command implementation.
 * Displays all cached Jenkins jobs with optional search filtering.
 */
import { runInteractiveSubcommandWithAnalytics } from "../analytics";
import { CliError, printError, printHint, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import type { JenkinsJob } from "../types/jenkins";
import { MIN_SCORE } from "../config/fuzzy";
import { listDeps } from "./list-deps";
import { runFlow } from "../flows/runner";
import { flows } from "../flows/definition";
import { listFlowHandlers } from "../flows/handlers";
import type {
  ActionEffectResult,
  ListInteractiveContext,
} from "../flows/types";

/** Options for the list command. */
type ListOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  search?: string;
  refresh?: boolean;
  nonInteractive: boolean;
};

type ListActionMenuOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  jobs: JenkinsJob[];
};

type ListActionContext = {
  client: JenkinsClient;
  env: EnvConfig;
  selectedJob: JenkinsJob;
};

export async function runList(options: ListOptions): Promise<void> {
  const jobs = await listDeps.loadJobs({
    client: options.client,
    env: options.env,
    refresh: options.refresh,
    nonInteractive: options.nonInteractive,
  });

  if (options.nonInteractive) {
    const search = options.search?.trim() ?? "";
    const filteredJobs = getFilteredJobs(jobs, search);
    printJobs(filteredJobs, search);
    return;
  }

  if (
    (await runListActionMenu({
      client: options.client,
      env: options.env,
      jobs,
      searchQuery: options.search?.trim() ?? "",
    })) === "exit"
  ) {
    return;
  }
}

function getFilteredJobs(jobs: JenkinsJob[], search: string): JenkinsJob[] {
  if (!search) {
    return listDeps.sortJobsByDisplayName(jobs);
  }
  return listDeps
    .rankJobs(search, jobs)
    .filter((match) => match.score >= MIN_SCORE)
    .map((match) => match.job);
}

async function runListActionMenu(
  options: ListActionMenuOptions & { searchQuery: string },
): Promise<"exit" | void> {
  const preferredJobs = options.searchQuery
    ? listDeps.sortJobsByDisplayName(options.jobs)
    : await listDeps.loadPreferredJobs({
        env: options.env,
        jobs: options.jobs,
      });
  const context: ListInteractiveContext = {
    env: options.env,
    jobs: options.jobs,
    preferredJobs,
    searchQuery: options.searchQuery,
    performAction: (action, selectedJob) =>
      performListAction(options, action, selectedJob),
  };

  const result = await runFlow({
    definition: flows.listInteractive,
    handlers: listFlowHandlers,
    prompts: {
      autocomplete: listDeps.autocomplete,
      select: listDeps.select,
      confirm: listDeps.confirm,
      text: listDeps.text,
      isCancel: listDeps.isCancel,
    },
    context,
  });

  if (result.terminal === "exit_command") {
    return "exit";
  }
}

function printJobs(entries: JenkinsJob[], search: string): void {
  if (search && entries.length === 0) {
    printOk(`No jobs match "${search}".`);
    return;
  }

  for (const job of entries) {
    console.log(`${listDeps.getJobDisplayName(job)}  ${job.url}`);
  }
}

async function performListAction(
  options: ListActionMenuOptions,
  action: string,
  selectedJob: JenkinsJob,
): Promise<ActionEffectResult> {
  const context: ListActionContext = {
    client: options.client,
    env: options.env,
    selectedJob,
  };

  switch (action) {
    case "build":
      return await runTrackedListAction("build", () =>
        runMenuAction(runBuildAction, context),
      );
    case "status":
      return await runTrackedListAction("status", () =>
        runMenuAction(runStatusAction, context),
      );
    case "history":
      return await runTrackedListAction("history", () =>
        runMenuAction(runHistoryAction, context),
      );
    case "watch":
      return await runTrackedListAction("wait", () =>
        runMenuAction(runWatchAction, context),
      );
    case "logs":
      return await runTrackedListAction("logs", () =>
        runMenuAction(runLogsAction, context),
      );
    case "cancel":
      return await runTrackedListAction("cancel", () =>
        runMenuAction(runCancelAction, context),
      );
    case "rerun":
      return await runTrackedListAction("rerun", () =>
        runMenuAction(runRerunAction, context),
      );
    case "rerun_last":
      return await runTrackedListAction("rerun-last", () =>
        runMenuAction(runRerunLastBuildAction, context),
      );
    default:
      return "action_error";
  }
}

async function runTrackedListAction<T>(
  command: string,
  action: () => Promise<T>,
): Promise<T> {
  return await runInteractiveSubcommandWithAnalytics(command, action);
}

async function runBuildAction(
  context: ListActionContext,
): Promise<ActionEffectResult> {
  const result = await listDeps.runBuild({
    client: context.client,
    env: context.env,
    jobUrl: context.selectedJob.url,
    branchParam: context.env.branchParamDefault,
    nonInteractive: false,
    returnToCaller: true,
  });
  return result?.rootRequested ? "root" : "action_ok";
}

async function runStatusAction(
  context: ListActionContext,
): Promise<"action_ok"> {
  await listDeps.runStatus({
    client: context.client,
    env: context.env,
    jobUrl: context.selectedJob.url,
    nonInteractive: true,
  });
  return "action_ok";
}

async function runHistoryAction(
  context: ListActionContext,
): Promise<"action_ok"> {
  await listDeps.runHistory({
    client: context.client,
    env: context.env,
    jobUrl: context.selectedJob.url,
    nonInteractive: false,
  });
  return "action_ok";
}

async function runWatchAction(
  context: ListActionContext,
): Promise<ActionEffectResult> {
  const result = await listDeps.runWait({
    client: context.client,
    env: context.env,
    jobUrl: context.selectedJob.url,
    nonInteractive: false,
    suppressExitCode: true,
  });
  if (!result) {
    return "action_error";
  }
  return result.cancelled ? "watch_cancelled" : "action_ok";
}

async function runLogsAction(context: ListActionContext): Promise<"action_ok"> {
  await listDeps.runLogs({
    client: context.client,
    env: context.env,
    jobUrl: context.selectedJob.url,
    follow: true,
    nonInteractive: false,
  });
  return "action_ok";
}

async function runCancelAction(
  context: ListActionContext,
): Promise<"action_ok"> {
  await listDeps.runCancel({
    client: context.client,
    env: context.env,
    jobUrl: context.selectedJob.url,
    nonInteractive: false,
  });
  return "action_ok";
}

async function runRerunAction(
  context: ListActionContext,
): Promise<"action_ok"> {
  await listDeps.runRerun({
    client: context.client,
    env: context.env,
    jobUrl: context.selectedJob.url,
    nonInteractive: false,
  });
  return "action_ok";
}

async function runRerunLastBuildAction(
  context: ListActionContext,
): Promise<"action_ok"> {
  await listDeps.runRerunLastBuild({
    client: context.client,
    env: context.env,
    jobUrl: context.selectedJob.url,
    nonInteractive: false,
  });
  return "action_ok";
}

async function runMenuAction<
  T extends ActionEffectResult,
  TArgs extends unknown[],
>(
  action: (...args: TArgs) => Promise<T>,
  ...args: TArgs
): Promise<T | "action_error"> {
  try {
    return await action(...args);
  } catch (error) {
    if (error instanceof CliError) {
      printError(error.message);
      for (const hint of error.hints) {
        printHint(hint);
      }
      return "action_error";
    }
    throw error;
  }
}
