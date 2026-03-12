import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";

const CANCEL = Symbol("cancel");
const NEXT_PAGE_VALUE = "__jenkins_cli_history_next__";
const REBUILD_VALUE = "__jenkins_cli_history_rebuild__";

const selectMock = mock(async (): Promise<unknown> => CANCEL);
const isCancelMock = mock((value: unknown) => value === CANCEL);
const runLogsMock = mock(async () => undefined);
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

mock.module("../src/commands/history-deps", () => ({
  historyDeps: {
    select: selectMock,
    isCancel: isCancelMock,
    runLogs: runLogsMock,
    recordRecentJob: recordRecentJobMock,
    recordBranchSelection: recordBranchSelectionMock,
    resolveJobTarget: resolveJobTargetMock,
  },
}));

const { runHistory } = await import("../src/commands/history");

const TEST_ENV: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "ci-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
};

describe("runHistory", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockImplementation(async (): Promise<unknown> => CANCEL);
    isCancelMock.mockReset();
    isCancelMock.mockImplementation((value: unknown) => value === CANCEL);
    runLogsMock.mockReset();
    runLogsMock.mockImplementation(async () => undefined);
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
  });

  afterEach(() => {
    mock.restore();
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
      .mockImplementationOnce(async (): Promise<unknown> => NEXT_PAGE_VALUE)
      .mockImplementationOnce(async (): Promise<unknown> => CANCEL);

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
        async (): Promise<unknown> => "https://jenkins.example.com/job/api/57/",
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
});
