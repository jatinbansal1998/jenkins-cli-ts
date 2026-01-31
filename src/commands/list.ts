/**
 * List command implementation.
 * Displays all cached Jenkins jobs with optional search filtering.
 */
import { confirm, isCancel, text } from "@clack/prompts";
import { CliError, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import { MIN_SCORE } from "../config/fuzzy";
import { getJobDisplayName, loadJobs, rankJobs } from "../jobs";

/** Options for the list command. */
type ListOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  search?: string;
  refresh?: boolean;
  nonInteractive: boolean;
};

export async function runList(options: ListOptions): Promise<void> {
  const jobs = await loadJobs({
    client: options.client,
    env: options.env,
    refresh: options.refresh,
    nonInteractive: options.nonInteractive,
    confirmRefresh: async (reason) => {
      const response = await confirm({
        message: `${reason} Refresh now?`,
        initialValue: true,
      });
      if (isCancel(response)) {
        throw new CliError("Operation cancelled.");
      }
      return response;
    },
  });

  let search = options.search?.trim() ?? "";
  if (!search && !options.nonInteractive) {
    const response = await text({
      message: "Search jobs (optional)",
      placeholder: "e.g. api prod",
    });
    if (isCancel(response)) {
      throw new CliError("Operation cancelled.");
    }
    search = String(response).trim();
  }

  const jobsToPrint = search
    ? rankJobs(search, jobs)
        .filter((match) => match.score >= MIN_SCORE)
        .map((match) => match.job)
    : jobs
        .slice()
        .sort((a, b) =>
          getJobDisplayName(a).localeCompare(getJobDisplayName(b)),
        );

  if (search && jobsToPrint.length === 0) {
    printOk(`No jobs match "${search}".`);
    return;
  }

  for (const job of jobsToPrint) {
    console.log(`${getJobDisplayName(job)}  ${job.url}`);
  }
}
