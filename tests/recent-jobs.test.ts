import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnvConfig } from "../src/env";
import type { JenkinsJob } from "../src/types/jenkins";

// Keep the cache inside the per-file test home even when the runner sets one.
process.env.XDG_CACHE_HOME = join(process.env.HOME ?? "", ".cache");
process.env.LOCALAPPDATA = join(process.env.HOME ?? "", "AppData", "Local");

const jobsModule = await import("../src/jobs");

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

const statePath = jobsModule.getJobStatePath(env.jenkinsUrl);

const cachedJobs: JenkinsJob[] = [
  {
    name: "api",
    fullName: "platform/api",
    url: "https://jenkins.example.com/job/api/",
  },
  {
    name: "worker",
    fullName: "platform/worker",
    url: "https://jenkins.example.com/job/worker/",
  },
  {
    name: "zeta",
    fullName: "platform/zeta",
    url: "https://jenkins.example.com/job/zeta/",
  },
];

describe("recent jobs", () => {
  beforeEach(async () => {
    await rm(jobsModule.getJobCacheDir(), { recursive: true, force: true });
    await mkdir(jobsModule.getJobCacheDir(), { recursive: true });
  });

  test("recordRecentJob moves the job to the front of the state file", async () => {
    const recentJobsModule = await loadRecentJobsModule();
    await seedState({ recentJobs: ["https://jenkins.example.com/job/worker"] });

    await recentJobsModule.recordRecentJob({
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
    });

    const raw = await Bun.file(statePath).text();
    expect(raw).not.toContain("\n");
    expect(JSON.parse(raw).recentJobs).toEqual([
      "https://jenkins.example.com/job/api",
      "https://jenkins.example.com/job/worker",
    ]);
  });

  test("recordRecentJob leaves the job list untouched", async () => {
    const recentJobsModule = await loadRecentJobsModule();
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    const jobCache = JSON.stringify({
      jenkinsUrl: env.jenkinsUrl,
      user: env.jenkinsUser,
      fetchedAt: "2026-02-12T00:00:00.000Z",
      jobs: cachedJobs,
    });
    await writeFile(cachePath, jobCache);

    await recentJobsModule.recordRecentJob({
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
    });

    expect(await Bun.file(cachePath).text()).toBe(jobCache);
  });

  test("recordRecentJob skips the write when the job is already first", async () => {
    const recentJobsModule = await loadRecentJobsModule();
    const seeded = await seedState({
      recentJobs: ["https://jenkins.example.com/job/api"],
    });

    await recentJobsModule.recordRecentJob({
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
    });

    expect(await Bun.file(statePath).text()).toBe(seeded);
  });

  test("concurrent recordRecentJob calls keep every job", async () => {
    const recentJobsModule = await loadRecentJobsModule();
    const jobUrls = Array.from(
      { length: 8 },
      (_, index) => `https://jenkins.example.com/job/job-${index}`,
    );

    await Promise.all(
      jobUrls.map((jobUrl) =>
        recentJobsModule.recordRecentJob({ env, jobUrl }),
      ),
    );

    const state = JSON.parse(await Bun.file(statePath).text()) as {
      recentJobs: string[];
    };
    expect(state.recentJobs.toSorted()).toEqual(jobUrls);
  });

  test("recordRecentJob ignores state write failures", async () => {
    const recentJobsModule = await loadRecentJobsModule();
    // A file where the cache directory should be makes every write fail.
    await rm(jobsModule.getJobCacheDir(), { recursive: true, force: true });
    await writeFile(jobsModule.getJobCacheDir(), "");

    try {
      await expect(
        recentJobsModule.recordRecentJob({
          env,
          jobUrl: "https://jenkins.example.com/job/api/",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(jobsModule.getJobCacheDir(), { force: true });
    }
  });

  test("loadPreferredJobs sorts recent jobs by recency", async () => {
    const recentJobsModule = await loadRecentJobsModule();
    await seedState({
      recentJobs: [
        "https://jenkins.example.com/job/api",
        "https://jenkins.example.com/job/worker",
      ],
    });

    const orderedJobs = await recentJobsModule.loadPreferredJobs({
      env,
      jobs: [
        cachedJobs[2] as JenkinsJob,
        cachedJobs[0] as JenkinsJob,
        cachedJobs[1] as JenkinsJob,
      ],
    });

    expect(orderedJobs.map((job: JenkinsJob) => job.name)).toEqual([
      "api",
      "worker",
      "zeta",
    ]);
  });
});

/** Pretty-printed on purpose: any rewrite would come back compact. */
async function seedState(data: { recentJobs: string[] }): Promise<string> {
  const raw = JSON.stringify(data, null, 2);
  await writeFile(statePath, raw);
  return raw;
}

// Cache-busting import so another file's mock.module of this module cannot
// leak into these tests under a shared `bun test` run.
async function loadRecentJobsModule(): Promise<
  typeof import("../src/recent-jobs")
> {
  return await import(
    `../src/recent-jobs.ts?recent-jobs-test=${crypto.randomUUID()}`
  );
}
