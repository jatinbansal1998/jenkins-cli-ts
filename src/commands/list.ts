/**
 * List command implementation.
 * Displays all cached Jenkins jobs with optional search filtering.
 */
import { CliError, printError, printHint, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import type { JenkinsJob } from "../types/jenkins";
import { MIN_SCORE } from "../config/fuzzy";
import { listDeps } from "./list-deps";
import { runFlow } from "../flows/runner";
import { flows } from "../flows/definition";
import { listFlowHandlers } from "../flows/handlers";
import { withPromptTarget } from "../tui-target";
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
    confirmRefresh: (reason) => confirmRefresh(reason, options.env),
  });

  if (options.nonInteractive) {
    const search = options.search?.trim() ?? "";
    printJobs(getFilteredJobs(jobs, search), search);
    return;
  }

  let pendingSearch = options.search?.trim() ?? "";
  while (true) {
    const search = await promptSearch(pendingSearch, options.env);
    pendingSearch = "";
    if (isExitToken(search)) {
      return;
    }

    const filteredJobs = getFilteredJobs(jobs, search);
    if (filteredJobs.length === 0) {
      printOk(`No jobs match "${search}".`);
      continue;
    }
    printJobs(filteredJobs, search);

    const listAction = await runListActionMenu({
      client: options.client,
      env: options.env,
      jobs: filteredJobs,
    });
    if (listAction === "exit") {
      return;
    }
  }
}

function getFilteredJobs(jobs: JenkinsJob[], search: string): JenkinsJob[] {
  if (!search) {
    return jobs
      .slice()
      .sort((a, b) =>
        listDeps
          .getJobDisplayName(a)
          .localeCompare(listDeps.getJobDisplayName(b)),
      );
  }
  return listDeps
    .rankJobs(search, jobs)
    .filter((match) => match.score >= MIN_SCORE)
    .map((match) => match.job);
}

async function promptSearch(
  initialSearch: string,
  env: EnvConfig,
): Promise<string> {
  if (initialSearch) {
    return initialSearch;
  }
  const response = await listDeps.text({
    message: withPromptTarget("Search jobs (optional, q to exit)", env),
    placeholder: "e.g. api prod",
  });
  if (listDeps.isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return String(response).trim();
}

async function runListActionMenu(
  options: ListActionMenuOptions,
): Promise<"search" | "exit"> {
  const context: ListInteractiveContext = {
    env: options.env,
    jobs: options.jobs,
    performAction: (action, selectedJob) =>
      performListAction(options, action, selectedJob),
  };

  const result = await runFlow({
    definition: flows.listInteractive,
    handlers: listFlowHandlers,
    prompts: {
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
  return "search";
}

async function confirmRefresh(
  reason: string,
  env: EnvConfig,
): Promise<boolean> {
  const response = await listDeps.confirm({
    message: withPromptTarget(`${reason} Refresh now?`, env),
    initialValue: true,
  });
  if (listDeps.isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return response;
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

function isExitToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "q" || normalized === "quit" || normalized === "exit";
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
      return await runMenuAction(runBuildAction, context);
    case "status":
      return await runMenuAction(runStatusAction, context);
    case "watch":
      return await runMenuAction(runWatchAction, context);
    case "logs":
      return await runMenuAction(runLogsAction, context);
    case "cancel":
      return await runMenuAction(runCancelAction, context);
    case "rerun":
      return await runMenuAction(runRerunAction, context);
    default:
      return "action_error";
  }
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
