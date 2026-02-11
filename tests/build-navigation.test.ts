import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { EnvConfig } from "../src/env";
import {
  BUILD_WITHOUT_PARAMS_VALUE,
  BUILD_WITH_PARAMS_VALUE,
  SEARCH_ALL_JOBS_VALUE,
} from "../src/flows/constants";
import type { JenkinsClient } from "../src/jenkins/client";

const CANCEL = "__mock_cancel__";
const JOB_URL = "https://jenkins.example.com/job/alpha/";
const BUILD_URL = "https://jenkins.example.com/job/alpha/42/";
const QUEUE_URL = "https://jenkins.example.com/queue/item/123/";

const confirmMock = mock(async () => false);
const selectMock = mock(async () => "done");
const textMock = mock(async () => "");
const isCancelMock = mock((value: unknown) => value === CANCEL);
const spinnerMock = mock(() => ({
  start: () => undefined,
  stop: () => undefined,
  message: () => undefined,
}));

const runCancelMock = mock(async (..._args: unknown[]) => undefined);
const runLogsMock = mock(async () => undefined);
const notifyBuildCompleteMock = mock(async () => undefined);
const loadRecentJobsMock = mock(async () => [{ url: JOB_URL, label: "alpha" }]);
const recordRecentJobMock = mock(async (..._args: unknown[]) => undefined);
const loadCachedBranchesMock = mock(async () => ["development", "master"]);
const loadCachedBranchHistoryMock = mock(async () => []);
const recordBranchSelectionMock = mock(
  async (..._args: unknown[]) => undefined,
);
const removeCachedBranchMock = mock(async () => true);
const loadJobsMock = mock(async () => [{ name: "alpha", url: JOB_URL }]);

mock.module("@clack/prompts", () => ({
  confirm: confirmMock,
  select: selectMock,
  text: textMock,
  isCancel: isCancelMock,
  spinner: spinnerMock,
}));

mock.module("../src/commands/cancel", () => ({
  runCancel: runCancelMock,
}));

mock.module("../src/commands/logs", () => ({
  runLogs: runLogsMock,
}));

mock.module("../src/notify", () => ({
  notifyBuildComplete: notifyBuildCompleteMock,
}));

mock.module("../src/recent-jobs.ts", () => ({
  loadRecentJobs: loadRecentJobsMock,
  recordRecentJob: recordRecentJobMock,
}));

mock.module("../src/branches.ts", () => ({
  loadCachedBranches: loadCachedBranchesMock,
  loadCachedBranchHistory: loadCachedBranchHistoryMock,
  recordBranchSelection: recordBranchSelectionMock,
  removeCachedBranch: removeCachedBranchMock,
}));

mock.module("../src/jobs", () => ({
  getJobDisplayName: (job: { name: string; fullName?: string }) =>
    job.fullName || job.name,
  loadJobs: loadJobsMock,
  resolveJobCandidates: (
    _query: string,
    jobs: { name: string; url: string }[],
  ) => jobs,
  resolveJobMatch: async (options: { jobs: { name: string; url: string }[] }) =>
    options.jobs[0],
}));

const { runBuild } = await import("../src/commands/build");

function createClient(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

describe("build command navigation", () => {
  beforeEach(() => {

    confirmMock.mockReset();
    confirmMock.mockImplementation(async () => false);

    selectMock.mockReset();
    selectMock.mockImplementation(async () => "done");

    textMock.mockReset();
    textMock.mockImplementation(async () => "");

    isCancelMock.mockReset();
    isCancelMock.mockImplementation((value: unknown) => value === CANCEL);

    spinnerMock.mockReset();
    spinnerMock.mockImplementation(() => ({
      start: () => undefined,
      stop: () => undefined,
      message: () => undefined,
    }));

    runCancelMock.mockReset();
    runCancelMock.mockImplementation(async () => undefined);

    runLogsMock.mockReset();
    runLogsMock.mockImplementation(async () => undefined);

    notifyBuildCompleteMock.mockReset();
    notifyBuildCompleteMock.mockImplementation(async () => undefined);

    loadRecentJobsMock.mockReset();
    loadRecentJobsMock.mockImplementation(async () => [
      { url: JOB_URL, label: "alpha" },
    ]);

    recordRecentJobMock.mockReset();
    recordRecentJobMock.mockImplementation(async () => undefined);

    loadCachedBranchesMock.mockReset();
    loadCachedBranchesMock.mockImplementation(async () => [
      "development",
      "master",
    ]);

    loadCachedBranchHistoryMock.mockReset();
    loadCachedBranchHistoryMock.mockImplementation(async () => []);

    recordBranchSelectionMock.mockReset();
    recordBranchSelectionMock.mockImplementation(async () => undefined);

    removeCachedBranchMock.mockReset();
    removeCachedBranchMock.mockImplementation(async () => true);

    loadJobsMock.mockReset();
    loadJobsMock.mockImplementation(async () => [
      { name: "alpha", url: JOB_URL },
    ]);
  });

  test("Esc in job search goes back to recent job menu", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 41 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 42,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    selectMock
      .mockImplementationOnce(async () => SEARCH_ALL_JOBS_VALUE)
      .mockImplementationOnce(async () => JOB_URL)
      .mockImplementationOnce(async () => BUILD_WITHOUT_PARAMS_VALUE);
    textMock.mockImplementationOnce(async () => CANCEL);

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      nonInteractive: false,
      watch: false,
    });

    const selectCalls = selectMock.mock.calls as unknown as Array<
      Array<unknown>
    >;
    expect(selectCalls[0]?.[0]).toEqual(
      expect.objectContaining({ message: "Recent jobs" }),
    );
    expect(selectCalls[1]?.[0]).toEqual(
      expect.objectContaining({ message: "Recent jobs" }),
    );
    expect(triggerBuild).toHaveBeenCalledTimes(1);
    expect(triggerBuild).toHaveBeenCalledWith(JOB_URL, {});
  });


  test("interactive branch selection supports using job without parameters", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 41 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 42,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    selectMock
      .mockImplementationOnce(async () => JOB_URL)
      .mockImplementationOnce(async () => BUILD_WITHOUT_PARAMS_VALUE);

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      nonInteractive: false,
      watch: false,
    });

    expect(triggerBuild).toHaveBeenCalledTimes(1);
    expect(triggerBuild).toHaveBeenCalledWith(JOB_URL, {});
  });

  test("interactive build with parameters retries on blank branch", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 41 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 42,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    loadCachedBranchesMock.mockImplementationOnce(async () => []);
    selectMock
      .mockImplementationOnce(async () => JOB_URL)
      .mockImplementationOnce(async () => BUILD_WITH_PARAMS_VALUE);
    textMock
      .mockImplementationOnce(async () => "")
      .mockImplementationOnce(async () => "development");

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      nonInteractive: false,
      watch: false,
    });

    expect(triggerBuild).toHaveBeenCalledTimes(1);
    expect(triggerBuild).toHaveBeenCalledWith(JOB_URL, {
      BRANCH: "development",
    });
  });

  test("Esc in branch selection returns to recent job menu", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 41 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 42,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    selectMock
      .mockImplementationOnce(async () => JOB_URL)
      .mockImplementationOnce(async () => BUILD_WITH_PARAMS_VALUE)
      .mockImplementationOnce(async () => CANCEL)
      .mockImplementationOnce(async () => JOB_URL)
      .mockImplementationOnce(async () => BUILD_WITH_PARAMS_VALUE)
      .mockImplementationOnce(async () => "development");

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      nonInteractive: false,
      watch: false,
    });

    expect(triggerBuild).toHaveBeenCalledTimes(1);
    expect(triggerBuild).toHaveBeenCalledWith(JOB_URL, {
      BRANCH: "development",
    });
    const selectCalls = selectMock.mock.calls as unknown as Array<
      Array<unknown>
    >;
    expect(selectCalls[3]?.[0]).toEqual(
      expect.objectContaining({ message: "Recent jobs" }),
    );
    expect(selectCalls[3]?.[0]).toEqual(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ label: "Search all jobs" }),
        ]),
      }),
    );
  });
});
