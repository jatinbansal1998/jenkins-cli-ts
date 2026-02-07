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

/** Options for the list command. */
type ListOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  search?: string;
  refresh?: boolean;
  nonInteractive: boolean;
};

export async function runList(options: ListOptions): Promise<void> {
  const jobs = await listDeps.loadJobs({
    client: options.client,
    env: options.env,
    refresh: options.refresh,
    nonInteractive: options.nonInteractive,
    confirmRefresh: async (reason) => {
      const response = await listDeps.confirm({
        message: `${reason} Refresh now?`,
        initialValue: true,
      });
      if (listDeps.isCancel(response)) {
        throw new CliError("Operation cancelled.");
      }
      return response;
    },
  });

  const printJobs = (entries: JenkinsJob[], search: string): void => {
    const jobsToPrint = entries;

    if (search && jobsToPrint.length === 0) {
      printOk(`No jobs match "${search}".`);
      return;
    }

    for (const job of jobsToPrint) {
      console.log(`${listDeps.getJobDisplayName(job)}  ${job.url}`);
    }
  };

  const isExitToken = (value: string): boolean => {
    const normalized = value.trim().toLowerCase();
    return normalized === "q" || normalized === "quit" || normalized === "exit";
  };

  if (options.nonInteractive) {
    const search = options.search?.trim() ?? "";
    printJobs(getFilteredJobs(jobs, search), search);
    return;
  }

  let pendingSearch = options.search?.trim() ?? "";
  while (true) {
    const search = await promptSearch(pendingSearch);
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

async function promptSearch(initialSearch: string): Promise<string> {
  if (initialSearch) {
    return initialSearch;
  }
  const response = await listDeps.text({
    message: "Search jobs (optional, q to exit)",
    placeholder: "e.g. api prod",
  });
  if (listDeps.isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return String(response).trim();
}

async function runListActionMenu(options: {
  client: JenkinsClient;
  env: EnvConfig;
  jobs: JenkinsJob[];
}): Promise<"search" | "exit"> {
  const searchAgainValue = "__jenkins_cli_search_again__";
  const exitValue = "__jenkins_cli_exit__";

  const choice = await listDeps.select({
    message: "Select a job to operate on",
    options: [
      ...options.jobs.map((job) => ({
        value: job.url,
        label: listDeps.getJobDisplayName(job),
      })),
      { value: searchAgainValue, label: "Search again" },
      { value: exitValue, label: "Exit" },
    ],
  });
  if (listDeps.isCancel(choice) || choice === exitValue) {
    return "exit";
  }
  if (choice === searchAgainValue) {
    return "search";
  }

  const selectedJob = options.jobs.find((job) => job.url === choice);
  if (!selectedJob) {
    throw new CliError("Selected job is no longer available.", [
      "Run `jenkins-cli list --refresh` to update the cache.",
    ]);
  }
  const action = await runJobActionMenu({
    client: options.client,
    env: options.env,
    job: selectedJob,
  });
  return action;
}

async function runJobActionMenu(options: {
  client: JenkinsClient;
  env: EnvConfig;
  job: JenkinsJob;
}): Promise<"search" | "exit"> {
  while (true) {
    const action = await listDeps.select({
      message: `Action for ${listDeps.getJobDisplayName(options.job)}`,
      options: [
        { value: "build", label: "Build" },
        { value: "status", label: "Status" },
        { value: "watch", label: "Watch" },
        { value: "logs", label: "Logs" },
        { value: "cancel", label: "Cancel" },
        { value: "rerun", label: "Rerun last failed" },
        { value: "search", label: "Back to search" },
        { value: "exit", label: "Exit" },
      ],
    });
    if (listDeps.isCancel(action) || action === "exit") {
      return "exit";
    }
    if (action === "search") {
      return "search";
    }

    if (action === "build") {
      await runMenuAction(async () =>
        listDeps.runBuild({
          client: options.client,
          env: options.env,
          jobUrl: options.job.url,
          branchParam: options.env.branchParamDefault,
          nonInteractive: false,
          returnToCaller: true,
        }),
      );
      continue;
    }
    if (action === "status") {
      await runMenuAction(async () =>
        listDeps.runStatus({
          client: options.client,
          env: options.env,
          jobUrl: options.job.url,
          nonInteractive: true,
        }),
      );
      continue;
    }
    if (action === "watch") {
      await runMenuAction(async () =>
        listDeps.runWait({
          client: options.client,
          env: options.env,
          jobUrl: options.job.url,
          nonInteractive: false,
          suppressExitCode: true,
        }),
      );
      continue;
    }
    if (action === "logs") {
      await runMenuAction(async () =>
        listDeps.runLogs({
          client: options.client,
          env: options.env,
          jobUrl: options.job.url,
          follow: true,
          nonInteractive: false,
        }),
      );
      continue;
    }
    if (action === "cancel") {
      await runMenuAction(async () =>
        listDeps.runCancel({
          client: options.client,
          env: options.env,
          jobUrl: options.job.url,
          nonInteractive: false,
        }),
      );
      continue;
    }
    if (action === "rerun") {
      await runMenuAction(async () =>
        listDeps.runRerun({
          client: options.client,
          env: options.env,
          jobUrl: options.job.url,
          nonInteractive: false,
        }),
      );
      continue;
    }
  }
}

async function runMenuAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof CliError) {
      printError(error.message);
      for (const hint of error.hints) {
        printHint(hint);
      }
      return;
    }
    throw error;
  }
}
