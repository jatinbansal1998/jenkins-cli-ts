import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";

const recordRecentJobMock = mock(async () => undefined);
const recordBranchSelectionMock = mock(async () => undefined);

mock.module("../src/recent-jobs", () => ({
  loadRecentJobs: mock(async () => []),
  recordRecentJob: recordRecentJobMock,
}));

mock.module("../src/branches", () => ({
  loadCachedBranches: mock(async () => []),
  loadCachedBranchHistory: mock(async () => []),
  removeCachedBranch: mock(async () => false),
  recordBranchSelection: recordBranchSelectionMock,
}));

const { rerunLastBuildForJob, rerunLastFailedBuildForJob } =
  await import("../src/commands/rerun-core");

const TEST_ENV = {} as EnvConfig;
const JOB_URL = "https://jenkins.example.com/job/api/";

describe("rerun-core", () => {
  beforeEach(() => {
    recordRecentJobMock.mockReset();
    recordRecentJobMock.mockImplementation(async () => undefined);
    recordBranchSelectionMock.mockReset();
    recordBranchSelectionMock.mockImplementation(async () => undefined);
  });

  test("rerunLastBuildForJob retriggers the latest build parameters", async () => {
    const getJobStatus = mock(async () => ({
      lastBuildNumber: 42,
      lastBuildUrl: `${JOB_URL}42/`,
      parameters: [
        { name: "BRANCH", value: "release/42" },
        { name: "DEPLOY_ENV", value: "staging" },
      ],
    }));
    const triggerBuild = mock(async () => ({
      queueUrl: "https://jenkins.example.com/queue/item/123/",
    }));
    const client = {
      getJobStatus,
      triggerBuild,
    } as unknown as JenkinsClient;

    const result = await rerunLastBuildForJob({
      client,
      env: TEST_ENV,
      jobUrl: JOB_URL,
      jobLabel: "api",
    });

    expect(triggerBuild).toHaveBeenCalledWith(JOB_URL, {
      BRANCH: "release/42",
      DEPLOY_ENV: "staging",
    });
    expect(recordRecentJobMock).toHaveBeenCalledWith({
      env: TEST_ENV,
      jobUrl: JOB_URL,
    });
    expect(recordBranchSelectionMock).toHaveBeenCalledWith({
      env: TEST_ENV,
      jobUrl: JOB_URL,
      branch: "release/42",
    });
    expect(result.sourceBuildNumber).toBe(42);
    expect(result.params).toEqual({
      BRANCH: "release/42",
      DEPLOY_ENV: "staging",
    });
  });

  test("rerunLastBuildForJob errors when the job has no previous build", async () => {
    const getJobStatus = mock(async () => ({}));
    const client = {
      getJobStatus,
    } as unknown as JenkinsClient;

    await expect(
      rerunLastBuildForJob({
        client,
        env: TEST_ENV,
        jobUrl: JOB_URL,
        jobLabel: "api",
      }),
    ).rejects.toThrow("No previous build found for api.");
  });

  test("rerunLastFailedBuildForJob reuses the last failed build parameters", async () => {
    const getLastFailedBuild = mock(async () => ({
      buildUrl: `${JOB_URL}41/`,
      buildNumber: 41,
    }));
    const getBuildStatus = mock(async () => ({
      parameters: [
        { name: "BRANCH", value: "release/41" },
        { name: "DEPLOY_ENV", value: "prod" },
      ],
    }));
    const triggerBuild = mock(async () => ({
      buildUrl: `${JOB_URL}42/`,
      buildNumber: 42,
    }));
    const client = {
      getLastFailedBuild,
      getBuildStatus,
      triggerBuild,
    } as unknown as JenkinsClient;

    const result = await rerunLastFailedBuildForJob({
      client,
      env: TEST_ENV,
      jobUrl: JOB_URL,
      jobLabel: "api",
    });

    expect(getBuildStatus).toHaveBeenCalledWith(`${JOB_URL}41/`);
    expect(triggerBuild).toHaveBeenCalledWith(JOB_URL, {
      BRANCH: "release/41",
      DEPLOY_ENV: "prod",
    });
    expect(result.sourceBuildNumber).toBe(41);
    expect(result.result.buildNumber).toBe(42);
  });
});
