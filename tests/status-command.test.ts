import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import * as recentJobsModule from "../src/recent-jobs";
import * as stageCountCacheModule from "../src/stage-count-cache";
import { runStatus } from "../src/commands/status";

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

function createClient(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

describe("status command", () => {
  afterEach(() => {
    while (restoreFns.length > 0) {
      restoreFns.pop()?.();
    }
  });

  test("persists known stage totals for completed unstable builds", async () => {
    trackRestore(spyOn(console, "log")).mockImplementation(() => undefined);
    const stages = [{ id: "1", name: "Deploy", status: "UNSTABLE" }];

    trackRestore(
      spyOn(recentJobsModule, "recordRecentJob"),
    ).mockResolvedValue();
    trackRestore(
      spyOn(stageCountCacheModule, "getKnownStageTotal"),
    ).mockResolvedValue(undefined);
    const persistKnownTotalStagesSpy = trackRestore(
      spyOn(stageCountCacheModule, "persistKnownTotalStages"),
    ).mockResolvedValue();

    await runStatus({
      client: createClient({
        getJobStatus: mock(async () => ({
          lastBuildNumber: 42,
          lastBuildUrl: "https://jenkins.example.com/job/api/42/",
          result: "UNSTABLE",
          building: false,
          lastBuildTimestamp: 1_700_000_000_000,
          lastBuildDurationMs: 12_000,
          stages,
        })),
      }),
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: true,
    });

    expect(persistKnownTotalStagesSpy).toHaveBeenCalledTimes(1);
    expect(persistKnownTotalStagesSpy).toHaveBeenCalledWith({
      env,
      jobUrl: "https://jenkins.example.com/job/api",
      buildUrl: "https://jenkins.example.com/job/api/42/",
      stages,
      jobLabel: "https://jenkins.example.com/job/api",
    });
  });
});
