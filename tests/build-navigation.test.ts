import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as clack from "../src/clack";
import type { EnvConfig } from "../src/env";
import {
  BUILD_WITH_CUSTOM_PARAMS_VALUE,
  BUILD_WITHOUT_PARAMS_VALUE,
  BUILD_WITH_PARAMS_VALUE,
  CUSTOM_MORE_BUILD_VALUE,
  CUSTOM_MORE_CANCEL_VALUE,
  SEARCH_ALL_JOBS_VALUE,
} from "../src/flows/constants";
import type { AutocompletePromptResult } from "../src/flows/types";
import type { JenkinsClient } from "../src/jenkins/client";
import type { JenkinsJob } from "../src/types/jenkins";
import { runBuild, setBuildDepsForTesting } from "../src/commands/build";
import { setBuildPreFlowDepsForTesting } from "../src/flows/handlers";

const CANCEL = Symbol("cancel");
const JOB_URL = "https://jenkins.example.com/job/alpha/";
const NORMALIZED_JOB_URL = JOB_URL.replace(/\/$/, "");
const BUILD_URL = "https://jenkins.example.com/job/alpha/42/";
const QUEUE_URL = "https://jenkins.example.com/queue/item/123/";

function createAutocompleteSelection(userInput = "alpha") {
  return {
    value: JOB_URL,
    userInput,
  };
}

const confirmMock = mock(async () => false);
const autocompleteMock = mock(
  async (): Promise<AutocompletePromptResult> => createAutocompleteSelection(),
);
const selectMock = mock(
  async (..._args: unknown[]): Promise<string | typeof CANCEL> => "done",
);
const textMock = mock(async (..._args: unknown[]): Promise<string> => "");
const isCancelMock = mock((value: unknown) => value === CANCEL);
const spinnerMock = mock((..._args: unknown[]) => ({
  start: () => undefined,
  stop: () => undefined,
  message: () => undefined,
  cancel: () => undefined,
  error: () => undefined,
  clear: () => undefined,
  isCancelled: false,
}));
const selectPrompt = ((options: Parameters<typeof clack.select>[0]) =>
  selectMock(options)) as typeof clack.select;
const textPrompt = ((options: Parameters<typeof clack.text>[0]) =>
  textMock(options)) as typeof clack.text;
const isCancelPrompt = ((value: unknown): value is symbol =>
  Boolean(isCancelMock(value))) as typeof clack.isCancel;
const spinnerPrompt = ((options?: Parameters<typeof clack.spinner>[0]) =>
  spinnerMock(options)) as typeof clack.spinner;

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

function createClient(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

describe("build command navigation", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockImplementation(async () => false);

    autocompleteMock.mockReset();
    autocompleteMock.mockImplementation(
      async (): Promise<AutocompletePromptResult> =>
        createAutocompleteSelection(),
    );

    selectMock.mockReset();
    selectMock.mockImplementation(
      async (): Promise<string | typeof CANCEL> => "done",
    );

    textMock.mockReset();
    textMock.mockImplementation(
      async (..._args: unknown[]): Promise<string> => "",
    );

    isCancelMock.mockReset();
    isCancelMock.mockImplementation((value: unknown) => value === CANCEL);

    spinnerMock.mockReset();
    spinnerMock.mockImplementation(() => ({
      start: () => undefined,
      stop: () => undefined,
      message: () => undefined,
      cancel: () => undefined,
      error: () => undefined,
      clear: () => undefined,
      isCancelled: false,
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

    setBuildDepsForTesting({
      autocomplete: autocompleteMock,
      confirm: confirmMock,
      select: selectPrompt,
      text: textPrompt,
      isCancel: isCancelPrompt,
      spinner: spinnerPrompt,
      runCancel: runCancelMock,
      runLogs: runLogsMock,
      notifyBuildComplete: notifyBuildCompleteMock,
      loadRecentJobs: loadRecentJobsMock,
      recordRecentJob: recordRecentJobMock,
      loadCachedBranches: loadCachedBranchesMock,
      loadCachedBranchHistory: loadCachedBranchHistoryMock,
      recordBranchSelection: recordBranchSelectionMock,
      removeCachedBranch: removeCachedBranchMock,
      loadJobs: loadJobsMock,
      getJobDisplayName: (job: { name: string; fullName?: string }) =>
        job.fullName || job.name,
      resolveJobMatch: async (options: {
        query: string;
        jobs: JenkinsJob[];
        nonInteractive: boolean;
        selectFromOptions?: (options: JenkinsJob[]) => Promise<JenkinsJob>;
      }) => {
        const firstJob = options.jobs[0];
        if (!firstJob) {
          throw new Error("Expected at least one job");
        }
        return firstJob;
      },
    });
    setBuildPreFlowDepsForTesting({
      loadCachedBranches: loadCachedBranchesMock,
      loadCachedBranchHistory: loadCachedBranchHistoryMock,
      removeCachedBranch: removeCachedBranchMock,
      getJobDisplayName: (job: { name: string; fullName?: string }) =>
        job.fullName || job.name,
    });
  });

  afterEach(() => {
    setBuildDepsForTesting();
    setBuildPreFlowDepsForTesting();
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
    autocompleteMock.mockImplementationOnce(async () => CANCEL);

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
      expect.objectContaining({
        message: expect.stringContaining("Recent jobs"),
      }),
    );
    expect(selectCalls[1]?.[0]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("Recent jobs"),
      }),
    );
    expect(autocompleteMock).toHaveBeenCalledTimes(1);
    expect(triggerBuild).toHaveBeenCalledTimes(1);
    expect(triggerBuild).toHaveBeenCalledWith(NORMALIZED_JOB_URL, {});
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
    expect(triggerBuild).toHaveBeenCalledWith(NORMALIZED_JOB_URL, {});
  });

  test("structured autocomplete payload preserves user input when returning to search", async () => {
    loadRecentJobsMock.mockImplementationOnce(async () => []);
    autocompleteMock
      .mockImplementationOnce(async () => createAutocompleteSelection("alp"))
      .mockImplementationOnce(async () => CANCEL);
    selectMock.mockImplementationOnce(async () => CANCEL);

    await runBuild({
      client: createClient({
        getJobStatus: mock(async () => ({ lastBuildNumber: 41 })),
        triggerBuild: mock(async () => ({
          buildUrl: BUILD_URL,
          buildNumber: 42,
          queueUrl: QUEUE_URL,
          jobUrl: JOB_URL,
        })),
      }),
      env: {} as EnvConfig,
      nonInteractive: false,
      watch: false,
    });

    const autocompleteCalls = autocompleteMock.mock.calls as unknown as Array<
      Array<unknown>
    >;
    expect(autocompleteMock).toHaveBeenCalledTimes(2);
    expect(autocompleteCalls[1]?.[0]).toEqual(
      expect.objectContaining({
        initialUserInput: "alp",
      }),
    );
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
    expect(triggerBuild).toHaveBeenCalledWith(NORMALIZED_JOB_URL, {
      BRANCH: "development",
    });
  });

  test("Esc in branch selection returns to build mode", async () => {
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
    expect(triggerBuild).toHaveBeenCalledWith(NORMALIZED_JOB_URL, {});
    const selectCalls = selectMock.mock.calls as unknown as Array<
      Array<unknown>
    >;
    expect(selectCalls[3]?.[0]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("Build mode"),
      }),
    );
  });

  test("interactive custom-params mode collects key and value", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 41 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 42,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    selectMock
      .mockImplementationOnce(async () => JOB_URL)
      .mockImplementationOnce(async () => BUILD_WITH_CUSTOM_PARAMS_VALUE)
      .mockImplementationOnce(async () => CUSTOM_MORE_BUILD_VALUE);
    textMock
      .mockImplementationOnce(async () => "DEPLOY_ENV")
      .mockImplementationOnce(async () => "staging");

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
    expect(triggerBuild).toHaveBeenCalledWith(NORMALIZED_JOB_URL, {
      DEPLOY_ENV: "staging",
    });
  });

  test("custom-params menu can cancel the build before submission", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 41 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 42,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    selectMock
      .mockImplementationOnce(async () => JOB_URL)
      .mockImplementationOnce(async () => BUILD_WITH_CUSTOM_PARAMS_VALUE)
      .mockImplementationOnce(async () => CUSTOM_MORE_CANCEL_VALUE);
    textMock
      .mockImplementationOnce(async () => "DEPLOY_ENV")
      .mockImplementationOnce(async () => "staging");

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      nonInteractive: false,
      watch: false,
    });

    expect(triggerBuild).not.toHaveBeenCalled();
  });

  test("Esc in custom-params menu returns to the previous value prompt", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 41 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 42,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    selectMock
      .mockImplementationOnce(async () => JOB_URL)
      .mockImplementationOnce(async () => BUILD_WITH_CUSTOM_PARAMS_VALUE)
      .mockImplementationOnce(async () => CANCEL)
      .mockImplementationOnce(async () => CUSTOM_MORE_BUILD_VALUE);
    textMock
      .mockImplementationOnce(async () => "DEPLOY_ENV")
      .mockImplementationOnce(async () => "staging")
      .mockImplementationOnce(async () => "production");

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
    expect(triggerBuild).toHaveBeenCalledWith(NORMALIZED_JOB_URL, {
      DEPLOY_ENV: "production",
    });
  });

  test("Esc from build mode with a locked job exits instead of reopening empty search", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 41 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 42,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    selectMock
      .mockImplementationOnce(async () => BUILD_WITH_PARAMS_VALUE)
      .mockImplementationOnce(async () => CANCEL)
      .mockImplementationOnce(async () => CANCEL);

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      jobUrl: JOB_URL,
      nonInteractive: false,
      watch: false,
    });

    expect(triggerBuild).not.toHaveBeenCalled();
    expect(textMock).not.toHaveBeenCalled();
  });

  test("interactive branch mode can add extra custom parameters", async () => {
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
      .mockImplementationOnce(async () => "development")
      .mockImplementationOnce(async () => CUSTOM_MORE_BUILD_VALUE);
    confirmMock
      .mockImplementationOnce(async () => true)
      .mockImplementationOnce(async () => false);
    textMock
      .mockImplementationOnce(async () => "DEPLOY_ENV")
      .mockImplementationOnce(async () => "staging");

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
    expect(triggerBuild).toHaveBeenCalledWith(NORMALIZED_JOB_URL, {
      BRANCH: "development",
      DEPLOY_ENV: "staging",
    });
  });
});
