import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnvConfig } from "../src/env";

// Keep the cache inside the per-file test home even when the runner sets one.
process.env.XDG_CACHE_HOME = join(process.env.HOME ?? "", ".cache");
process.env.LOCALAPPDATA = join(process.env.HOME ?? "", "AppData", "Local");

const jobsModule = await import("../src/jobs");
const stageCountCacheModule = await import("../src/stage-count-cache");

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

const statePath = jobsModule.getJobStatePath(env.jenkinsUrl);

describe("stage count cache", () => {
  beforeEach(async () => {
    await rm(jobsModule.getJobCacheDir(), { recursive: true, force: true });
    await mkdir(jobsModule.getJobCacheDir(), { recursive: true });
  });

  test("records a stage total that later reads find across URL variants", async () => {
    await stageCountCacheModule.recordKnownStageTotal({
      env,
      jobUrl: " https://jenkins.example.com/job/Demo/ ",
      totalStages: 4,
    });

    expect(
      await stageCountCacheModule.getKnownStageTotal({
        env,
        jobUrl: "https://jenkins.example.com/job/demo",
      }),
    ).toBe(4);
    expect(
      await stageCountCacheModule.getKnownStageTotal({
        env,
        buildUrl: "https://jenkins.example.com/job/demo/7/",
      }),
    ).toBe(4);
  });

  test("returns undefined when nothing is known", async () => {
    expect(
      await stageCountCacheModule.getKnownStageTotal({
        env,
        jobUrl: "https://jenkins.example.com/job/demo",
      }),
    ).toBeUndefined();
  });

  test("skips the write when the stage total did not change", async () => {
    const seeded = JSON.stringify(
      {
        knownStageTotals: {
          "https://jenkins.example.com/job/demo": {
            totalStages: 3,
            updatedAt: "2026-03-16T00:00:00.000Z",
          },
        },
      },
      null,
      2,
    );
    await writeFile(statePath, seeded);

    await stageCountCacheModule.recordKnownStageTotal({
      env,
      jobUrl: "https://jenkins.example.com/job/demo/",
      totalStages: 3,
    });

    expect(await Bun.file(statePath).text()).toBe(seeded);
  });

  test("persistKnownTotalStages derives the job URL from the build URL", async () => {
    await stageCountCacheModule.persistKnownTotalStages({
      env,
      buildUrl: " https://jenkins.example.com/job/demo/12/ ",
      stages: [{}, {}],
      jobLabel: "demo",
    });

    expect(
      await stageCountCacheModule.getKnownStageTotal({
        env,
        jobUrl: "https://jenkins.example.com/job/demo",
      }),
    ).toBe(2);
  });

  test("persistKnownTotalStages swallows write errors", async () => {
    // A file where the cache directory should be makes every write fail.
    await rm(jobsModule.getJobCacheDir(), { recursive: true, force: true });
    await writeFile(jobsModule.getJobCacheDir(), "");

    try {
      await expect(
        stageCountCacheModule.persistKnownTotalStages({
          env,
          jobUrl: "https://jenkins.example.com/job/demo",
          stages: [{}, {}],
          jobLabel: "demo",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(jobsModule.getJobCacheDir(), { force: true });
    }
  });

  test("resolveStageCacheJobUrl normalizes explicit and derived URLs", () => {
    expect(
      stageCountCacheModule.resolveStageCacheJobUrl({
        jobUrl: " https://jenkins.example.com/job/demo/// ",
      }),
    ).toBe("https://jenkins.example.com/job/demo");
    expect(
      stageCountCacheModule.resolveStageCacheJobUrl({
        buildUrl: "https://jenkins.example.com/job/demo/12/",
      }),
    ).toBe("https://jenkins.example.com/job/demo");
  });
});
