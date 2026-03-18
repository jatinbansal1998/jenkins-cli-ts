import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as clack from "../src/clack";
import type { EnvConfig } from "../src/env";
import type { AutocompletePromptResult } from "../src/flows/types";
import type { JenkinsClient } from "../src/jenkins/client";
import { runHistory, setHistoryDepsForTesting } from "../src/commands/history";

const CANCEL = Symbol("cancel");
const NEXT_PAGE_VALUE = "__jenkins_cli_history_next__";
const REBUILD_VALUE = "__jenkins_cli_history_rebuild__";
const RERUN_LAST_VALUE = "__jenkins_cli_history_rerun_last__";

const autocompleteMock = mock(
  async (): Promise<AutocompletePromptResult> => CANCEL,
);
const confirmMock = mock(async (): Promise<boolean> => false);
const selectMock = mock(
  async (..._args: unknown[]): Promise<unknown> => CANCEL,
);
const textMock = mock(async (): Promise<string> => "");
const isCancelMock = mock((value: unknown) => value === CANCEL);
const selectPrompt = ((options: Parameters<typeof clack.select>[0]) =>
  selectMock(options)) as typeof clack.select;
const isCancelPrompt = ((value: unknown): value is symbol =>
  Boolean(isCancelMock(value))) as typeof clack.isCancel;
const runCancelMock = mock(async () => undefined);
const runLogsMock = mock(async () => undefined);
const runWaitMock = mock(
  async (): Promise<{
    result: string;
    buildNumber?: number;
    buildUrl?: string;
    cancelled?: boolean;
  }> => ({
    result: "SUCCESS",
  }),
);
const recordRecentJobMock = mock(async () => undefined);
const recordBranchSelectionMock = mock(async () => undefined);
const resolveJobTargetMock = mock(
  async ({
    jobUrl,
  }: {
    jobUrl?: string;
  }): Promise<{ jobUrl: string; jobLabel: string }> => ({
    jobUrl: jobUrl ?? "https://jenkins.example.com/job/api/",
    jobLabel: jobUrl ?? "https://jenkins.example.com/job/api/",
  }),
);

const TEST_ENV: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "ci-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

describe("runHistory", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    autocompleteMock.mockReset();
    autocompleteMock.mockImplementation(
      async (): Promise<AutocompletePromptResult> => CANCEL,
    );
    confirmMock.mockReset();
    confirmMock.mockImplementation(async (): Promise<boolean> => false);
    selectMock.mockReset();
    selectMock.mockImplementation(async (): Promise<unknown> => CANCEL);
    textMock.mockReset();
    textMock.mockImplementation(async (): Promise<string> => "");
    isCancelMock.mockReset();
    isCancelMock.mockImplementation((value: unknown) => value === CANCEL);
    runCancelMock.mockReset();
    runCancelMock.mockImplementation(async () => undefined);
    runLogsMock.mockReset();
    runLogsMock.mockImplementation(async () => undefined);
    runWaitMock.mockReset();
    runWaitMock.mockImplementation(
      async (): Promise<{
        result: string;
        buildNumber?: number;
        buildUrl?: string;
        cancelled?: boolean;
      }> => ({
        result: "SUCCESS",
      }),
    );
    recordRecentJobMock.mockReset();
    recordRecentJobMock.mockImplementation(async () => undefined);
    recordBranchSelectionMock.mockReset();
    recordBranchSelectionMock.mockImplementation(async () => undefined);
    resolveJobTargetMock.mockReset();
    resolveJobTargetMock.mockImplementation(
      async ({
        jobUrl,
      }: {
        jobUrl?: string;
      }): Promise<{ jobUrl: string; jobLabel: string }> => ({
        jobUrl: jobUrl ?? "https://jenkins.example.com/job/api/",
        jobLabel: jobUrl ?? "https://jenkins.example.com/job/api/",
      }),
    );
    setHistoryDepsForTesting({
      autocomplete: autocompleteMock,
      confirm: confirmMock,
      select: selectPrompt,
      text: textMock,
      isCancel: isCancelPrompt,
      runCancel: runCancelMock,
      runLogs: runLogsMock,
      runWait: runWaitMock,
      recordRecentJob: recordRecentJobMock,
      recordBranchSelection: recordBranchSelectionMock,
      resolveJobTarget: resolveJobTargetMock,
    });
  });

  afterEach(() => {
    setHistoryDepsForTesting();
  });

  test("non-interactive prints a tabular build history page", async () => {
    const logSpy = spyOn(console, "log");
    const client = {
      listBuildHistory: mock(async () => ({
        builds: [
          {
            buildNumber: 42,
            buildUrl: "https://jenkins.example.com/job/api/42/",
            result: "FAILURE",
            timestampMs: Date.UTC(2026, 2, 12, 10, 30),
            durationMs: 75_000,
            branch: "main",
            failure: {
              stageName: "Deploy",
              stepName: "Deploy to ECS",
              reason: "task definition validation failed",
            },
          },
        ],
        total: 1,
        offset: 0,
        limit: 5,
        hasNext: false,
        hasPrevious: false,
      })),
    } as unknown as JenkinsClient;

    await runHistory({
      client,
      env: TEST_ENV,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: true,
    });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("OK: Showing builds 1-1 of 1");
    expect(output).toContain("Failed Step");
    expect(output).toContain("Deploy to ECS");
    expect(output).toContain("task definition validation failed");
    logSpy.mockRestore();
  });

  test("interactive supports fetching the next page of builds", async () => {
    const listBuildHistory = mock(
      async (jobUrl: string, options?: { offset?: number }) => ({
        builds: [
          {
            buildNumber: (options?.offset ?? 0) + 100,
            buildUrl: `${jobUrl}${options?.offset ?? 0}/`,
            result: "SUCCESS",
          },
        ],
        total: 10,
        offset: options?.offset ?? 0,
        limit: 5,
        hasNext: (options?.offset ?? 0) === 0,
        hasPrevious: (options?.offset ?? 0) > 0,
      }),
    );
    const client = {
      listBuildHistory,
    } as unknown as JenkinsClient;

    selectMock
      .mockImplementationOnce(
        async (): Promise<AutocompletePromptResult> => NEXT_PAGE_VALUE,
      )
      .mockImplementationOnce(
        async (): Promise<AutocompletePromptResult> => CANCEL,
      );

    await runHistory({
      client,
      env: TEST_ENV,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: false,
    });

    expect(listBuildHistory).toHaveBeenCalledTimes(2);
    expect(listBuildHistory).toHaveBeenNthCalledWith(
      1,
      "https://jenkins.example.com/job/api/",
      { offset: 0, limit: 5 },
    );
    expect(listBuildHistory).toHaveBeenNthCalledWith(
      2,
      "https://jenkins.example.com/job/api/",
      { offset: 5, limit: 5 },
    );
  });

  test("interactive can rebuild a selected historical build with its parameters", async () => {
    const listBuildHistory = mock(async () => ({
      builds: [
        {
          buildNumber: 57,
          buildUrl: "https://jenkins.example.com/job/api/57/",
          result: "FAILURE",
          branch: "release/42",
          parameters: [
            { name: "BRANCH", value: "release/42" },
            { name: "DEPLOY_ENV", value: "staging" },
          ],
        },
      ],
      total: 1,
      offset: 0,
      limit: 5,
      hasNext: false,
      hasPrevious: false,
    }));
    const triggerBuild = mock(async () => ({
      queueUrl: "https://jenkins.example.com/queue/item/123/",
    }));
    const client = {
      listBuildHistory,
      triggerBuild,
    } as unknown as JenkinsClient;

    selectMock
      .mockImplementationOnce(
        async (): Promise<AutocompletePromptResult> =>
          "https://jenkins.example.com/job/api/57/",
      )
      .mockImplementationOnce(async (): Promise<unknown> => REBUILD_VALUE)
      .mockImplementationOnce(async (): Promise<unknown> => CANCEL);

    await runHistory({
      client,
      env: TEST_ENV,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: false,
    });

    expect(triggerBuild).toHaveBeenCalledTimes(1);
    expect(triggerBuild).toHaveBeenCalledWith(
      "https://jenkins.example.com/job/api/",
      {
        BRANCH: "release/42",
        DEPLOY_ENV: "staging",
      },
    );
  });

  test("interactive can rerun the latest job build from history", async () => {
    const listBuildHistory = mock(async () => ({
      builds: [
        {
          buildNumber: 57,
          buildUrl: "https://jenkins.example.com/job/api/57/",
          result: "FAILURE",
          branch: "release/42",
          parameters: [{ name: "BRANCH", value: "release/42" }],
        },
      ],
      total: 1,
      offset: 0,
      limit: 5,
      hasNext: false,
      hasPrevious: false,
    }));
    const getJobStatus = mock(async () => ({
      lastBuildNumber: 99,
      lastBuildUrl: "https://jenkins.example.com/job/api/99/",
      parameters: [
        { name: "BRANCH", value: "release/99" },
        { name: "DEPLOY_ENV", value: "prod" },
      ],
    }));
    const triggerBuild = mock(async () => ({
      queueUrl: "https://jenkins.example.com/queue/item/999/",
    }));
    const client = {
      listBuildHistory,
      getJobStatus,
      triggerBuild,
    } as unknown as JenkinsClient;

    selectMock
      .mockImplementationOnce(
        async (): Promise<AutocompletePromptResult> =>
          "https://jenkins.example.com/job/api/57/",
      )
      .mockImplementationOnce(async (): Promise<unknown> => RERUN_LAST_VALUE)
      .mockImplementationOnce(async (): Promise<unknown> => CANCEL);

    await runHistory({
      client,
      env: TEST_ENV,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: false,
    });

    expect(getJobStatus).toHaveBeenCalledTimes(1);
    expect(triggerBuild).toHaveBeenCalledWith(
      "https://jenkins.example.com/job/api/",
      {
        BRANCH: "release/99",
        DEPLOY_ENV: "prod",
      },
    );
  });

  test("interactive rebuild returns the rebuilt run to the caller after exiting history", async () => {
    const listBuildHistory = mock(async () => ({
      builds: [
        {
          buildNumber: 57,
          buildUrl: "https://jenkins.example.com/job/api/57/",
          result: "FAILURE",
          branch: "release/42",
          parameters: [
            { name: "BRANCH", value: "release/42" },
            { name: "DEPLOY_ENV", value: "staging" },
          ],
        },
      ],
      total: 1,
      offset: 0,
      limit: 5,
      hasNext: false,
      hasPrevious: false,
    }));
    const triggerBuild = mock(async () => ({
      queueUrl: "https://jenkins.example.com/queue/item/123/",
    }));
    const client = {
      listBuildHistory,
      triggerBuild,
    } as unknown as JenkinsClient;

    selectMock
      .mockImplementationOnce(
        async (): Promise<AutocompletePromptResult> =>
          "https://jenkins.example.com/job/api/57/",
      )
      .mockImplementationOnce(async (): Promise<unknown> => REBUILD_VALUE)
      .mockImplementationOnce(async (): Promise<unknown> => "done")
      .mockImplementationOnce(async (): Promise<unknown> => CANCEL);

    const result = await runHistory({
      client,
      env: TEST_ENV,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: false,
    });

    expect(result).toEqual({
      activeBuild: {
        buildUrl: undefined,
        buildNumber: undefined,
        queueUrl: "https://jenkins.example.com/queue/item/123/",
      },
    });
  });

  test("interactive rebuild enters the shared post-build flow with watch", async () => {
    const listBuildHistory = mock(async () => ({
      builds: [
        {
          buildNumber: 57,
          buildUrl: "https://jenkins.example.com/job/api/57/",
          result: "FAILURE",
          branch: "release/42",
          parameters: [
            { name: "BRANCH", value: "release/42" },
            { name: "DEPLOY_ENV", value: "staging" },
          ],
        },
      ],
      total: 1,
      offset: 0,
      limit: 5,
      hasNext: false,
      hasPrevious: false,
    }));
    const triggerBuild = mock(async () => ({
      queueUrl: "https://jenkins.example.com/queue/item/123/",
    }));
    const client = {
      listBuildHistory,
      triggerBuild,
    } as unknown as JenkinsClient;

    selectMock
      .mockImplementationOnce(
        async (): Promise<AutocompletePromptResult> =>
          "https://jenkins.example.com/job/api/57/",
      )
      .mockImplementationOnce(async (): Promise<unknown> => REBUILD_VALUE)
      .mockImplementationOnce(async (): Promise<unknown> => "watch")
      .mockImplementationOnce(async (): Promise<unknown> => "done")
      .mockImplementationOnce(async (): Promise<unknown> => CANCEL);

    await runHistory({
      client,
      env: TEST_ENV,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: false,
    });

    expect(selectMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        message: expect.stringContaining("Next action for"),
        options: expect.arrayContaining([
          expect.objectContaining({ value: "watch", label: "Watch" }),
          expect.objectContaining({ value: "history", label: "Build history" }),
          expect.objectContaining({ value: "logs", label: "Logs" }),
          expect.objectContaining({ value: "cancel", label: "Cancel" }),
          expect.objectContaining({
            value: "rerun",
            label: "Rerun same inputs",
          }),
          expect.objectContaining({
            value: "rerun_last",
            label: "Rerun last build",
          }),
          expect.objectContaining({ value: "done", label: "Done" }),
        ]),
      }),
    );
    expect(runWaitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        env: TEST_ENV,
        queueUrl: "https://jenkins.example.com/queue/item/123/",
        nonInteractive: false,
        suppressExitCode: true,
      }),
    );
  });
});
