/**
 * List command implementation.
 * Displays all cached Jenkins jobs with optional search filtering.
 */
import { confirm, isCancel } from "@clack/prompts";
import { createInterface } from "node:readline/promises";
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

  const printJobs = (search: string): void => {
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
  };

  const isExitToken = (value: string): boolean => {
    const normalized = value.trim().toLowerCase();
    return normalized === "q" || normalized === "quit" || normalized === "exit";
  };

  if (options.nonInteractive) {
    const search = options.search?.trim() ?? "";
    printJobs(search);
    return;
  }

  const hasInitialSearch = typeof options.search === "string";
  let pendingSearch = hasInitialSearch ? options.search!.trim() : null;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 1000,
  });

  let cancelled = false;
  rl.on("SIGINT", () => {
    cancelled = true;
    rl.close();
  });

  const promptSearch = async (): Promise<string> => {
    // `readline` gives you Up/Down arrow history navigation automatically.
    const response = await rl.question(
      "Search jobs (optional, type q to exit) [e.g. api prod]: ",
    );
    return response.trim();
  };

  try {
    while (true) {
      let search = "";
      if (pendingSearch !== null) {
        search = pendingSearch;
        pendingSearch = null;
        // Make the initial search available via the Up-arrow history too.
        if (search) {
          rl.history.unshift(search);
        }
      } else {
        try {
          search = await promptSearch();
        } catch (err) {
          if (cancelled) {
            throw new CliError("Operation cancelled.");
          }
          // Treat EOF / closed input as exit from the interactive loop.
          if (err instanceof Error && /closed/i.test(err.message)) {
            return;
          }
          throw err;
        }
      }

      if (isExitToken(search)) {
        return;
      }

      printJobs(search);
    }
  } finally {
    rl.close();
  }
}
