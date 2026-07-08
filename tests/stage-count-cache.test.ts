import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { EnvConfig } from "../src/env";
import * as jobsModule from "../src/jobs";
import * as stageCountCacheModule from "../src/stage-count-cache";

const restoreFns: Array<() => void> = [];

function trackRestore<T extends { mockRestore(): void }>(
  mockWithRestore: T,
): T {
  restoreFns.push(() => mockWithRestore.mockRestore());
  return mockWithRestore;
}

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

describe("stage count cache", () => {
  afterEach(() => {
    while (restoreFns.length > 0) {
      restoreFns.pop()?.();
    }
  });

  test("recordKnownStageTotal does not mutate the loaded cache when write fails", async () => {
    const cache = {
      jenkinsUrl: env.jenkinsUrl,
      user: env.jenkinsUser,
      fetchedAt: "2026-03-17T00:00:00.000Z",
      jobs: [],
      knownStageTotals: {
        "https://jenkins.example.com/job/demo": {
          totalStages: 3,
          updatedAt: "2026-03-16T00:00:00.000Z",
        },
      },
    };

    trackRestore(spyOn(jobsModule, "readJobCache")).mockResolvedValue(cache);
    const writeJobCacheSpy = trackRestore(
      spyOn(jobsModule, "writeJobCache"),
    ).mockRejectedValue(new Error("write failed"));
    writeJobCacheSpy.mockClear();

    await expect(
      stageCountCacheModule.recordKnownStageTotal({
        env,
        jobUrl: " https://jenkins.example.com/job/demo/ ",
        totalStages: 5,
      }),
    ).rejects.toThrow("write failed");

    expect(
      cache.knownStageTotals["https://jenkins.example.com/job/demo"]
        ?.totalStages,
    ).toBe(3);
    expect(writeJobCacheSpy).toHaveBeenCalledTimes(1);
    expect(writeJobCacheSpy.mock.calls[0]?.[0]).not.toBe(cache);
    expect(
      writeJobCacheSpy.mock.calls[0]?.[0]?.knownStageTotals?.[
        "https://jenkins.example.com/job/demo"
      ]?.totalStages,
    ).toBe(5);
  });

  test("persistKnownTotalStages swallows write errors and derives job URL from build URL", async () => {
    trackRestore(spyOn(jobsModule, "readJobCache")).mockResolvedValue({
      jenkinsUrl: env.jenkinsUrl,
      user: env.jenkinsUser,
      fetchedAt: "2026-03-17T00:00:00.000Z",
      jobs: [],
    });
    const writeJobCacheSpy = trackRestore(
      spyOn(jobsModule, "writeJobCache"),
    ).mockRejectedValue(new Error("disk full"));
    writeJobCacheSpy.mockClear();

    await expect(
      stageCountCacheModule.persistKnownTotalStages({
        env,
        buildUrl: " https://jenkins.example.com/job/demo/12/ ",
        stages: [{}, {}],
        jobLabel: "demo",
      }),
    ).resolves.toBeUndefined();

    expect(writeJobCacheSpy).toHaveBeenCalledTimes(1);
    expect(
      writeJobCacheSpy.mock.calls[0]?.[0]?.knownStageTotals?.[
        "https://jenkins.example.com/job/demo"
      ]?.totalStages,
    ).toBe(2);
  });

  test("recordKnownStageTotal creates a cache entry when no cache exists yet", async () => {
    trackRestore(spyOn(jobsModule, "readJobCache")).mockResolvedValue(null);
    const writeJobCacheSpy = trackRestore(
      spyOn(jobsModule, "writeJobCache"),
    ).mockResolvedValue();
    writeJobCacheSpy.mockClear();

    await stageCountCacheModule.recordKnownStageTotal({
      env,
      jobUrl: "https://jenkins.example.com/job/demo/",
      totalStages: 4,
    });

    expect(writeJobCacheSpy).toHaveBeenCalledTimes(1);
    expect(writeJobCacheSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        jenkinsUrl: env.jenkinsUrl,
        user: env.jenkinsUser,
        jobs: [],
        knownStageTotals: {
          "https://jenkins.example.com/job/demo": expect.objectContaining({
            totalStages: 4,
          }),
        },
      }),
    );
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
