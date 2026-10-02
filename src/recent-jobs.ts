/**
 * Recent job history stored in the per-controller job state file.
 */
import type { JenkinsJob } from "./types/jenkins";
import type { EnvConfig } from "./env";
import { getJobUrlKey, normalizeJobUrl } from "./job-url";
import { readJobState, updateJobState } from "./job-state";
import { sortJobsByDisplayName } from "./jobs";
import { MAX_RECENT_JOBS } from "./recent-job-data";

export async function loadPreferredJobs(options: {
  env: EnvConfig;
  jobs: JenkinsJob[];
}): Promise<JenkinsJob[]> {
  const { recentJobs } = await readJobState(options.env.jenkinsUrl);
  const jobsByUrl = buildJobsByUrl(options.jobs);
  const preferredJobs = recentJobs
    .map((url) => jobsByUrl.get(getJobUrlKey(url) ?? ""))
    .filter((job): job is JenkinsJob => Boolean(job));
  if (preferredJobs.length === 0) {
    return sortJobsByDisplayName(options.jobs);
  }

  const seen = new Set(preferredJobs.map((job) => getJobUrlKey(job.url) ?? ""));
  const remainingJobs = sortJobsByDisplayName(options.jobs).filter(
    (job) => !seen.has(getJobUrlKey(job.url) ?? ""),
  );
  return [...preferredJobs, ...remainingJobs];
}

export async function recordRecentJob(options: {
  env: EnvConfig;
  jobUrl: string;
}): Promise<void> {
  try {
    const jobUrl = normalizeJobUrl(options.jobUrl);
    if (!jobUrl) {
      return;
    }

    const jobUrlKey = getJobUrlKey(jobUrl);
    await updateJobState(options.env.jenkinsUrl, (state) => {
      if (state.recentJobs[0] === jobUrl) {
        return undefined;
      }
      const recentJobs = [
        jobUrl,
        ...state.recentJobs.filter(
          (entry) => getJobUrlKey(entry) !== jobUrlKey,
        ),
      ].slice(0, MAX_RECENT_JOBS);
      return { ...state, recentJobs };
    });
  } catch {
    // Ignore recent job cache write failures.
  }
}

function buildJobsByUrl(jobs: JenkinsJob[]): Map<string, JenkinsJob> {
  const jobsByUrl = new Map<string, JenkinsJob>();
  for (const job of jobs) {
    const key = getJobUrlKey(job.url);
    if (!key) {
      continue;
    }
    jobsByUrl.set(key, job);
  }

  return jobsByUrl;
}
