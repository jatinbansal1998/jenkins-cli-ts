import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { CliError } from "../src/cli";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type { JenkinsJob } from "../src/types/jenkins";

const jobs: JenkinsJob[] = [
  { name: "beta", url: "https://jenkins.example.com/job/beta" },
  { name: "alpha", url: "https://jenkins.example.com/job/alpha" },
];

const loadJobsMock = mock(async () => jobs);
const confirmMock = mock(() => true);
const isCancelMock = mock(() => false);
const selectMock = mock(async () => "__jenkins_cli_exit__");
const textMock = mock(async () => "q");

const runBuildMock = mock(async () => undefined);
const runStatusMock = mock(async () => undefined);
const runWaitMock = mock(async (..._args: unknown[]) => undefined);
const runLogsMock = mock(async () => undefined);
const runCancelMock = mock(async () => undefined);
const runRerunMock = mock(async () => undefined);

mock.module("../src/commands/list-deps", () => ({
  listDeps: {
    confirm: confirmMock,
    isCancel: isCancelMock,
    select: selectMock,
    text: textMock,
    loadJobs: loadJobsMock,
    getJobDisplayName: (job: { name: string; fullName?: string }) =>
      job.fullName || job.name,
    rankJobs: (query: string, entries: { name: string; url: string }[]) =>
      entries
        .filter((job) => job.name.includes(query))
        .map((job) => ({ job, score: 100 })),
    runBuild: runBuildMock,
    runStatus: runStatusMock,
    runWait: runWaitMock,
    runLogs: runLogsMock,
    runCancel: runCancelMock,
    runRerun: runRerunMock,
  },
}));

const { runList } = await import("../src/commands/list");

describe("runList", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    loadJobsMock.mockReset();
    loadJobsMock.mockImplementation(async () => jobs);
    confirmMock.mockReset();
    confirmMock.mockImplementation(() => true);
    isCancelMock.mockReset();
    isCancelMock.mockImplementation(() => false);
    selectMock.mockReset();
    selectMock.mockImplementation(async () => "__jenkins_cli_exit__");
    textMock.mockReset();
    textMock.mockImplementation(async () => "q");

    runBuildMock.mockReset();
    runBuildMock.mockImplementation(async () => undefined);
    runStatusMock.mockReset();
    runStatusMock.mockImplementation(async () => undefined);
    runWaitMock.mockReset();
    runWaitMock.mockImplementation(async () => undefined);
    runLogsMock.mockReset();
    runLogsMock.mockImplementation(async () => undefined);
    runCancelMock.mockReset();
    runCancelMock.mockImplementation(async () => undefined);
    runRerunMock.mockReset();
    runRerunMock.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  test("non-interactive prints matching jobs", async () => {
    const logSpy = spyOn(console, "log");

    await runList({
      client: {} as JenkinsClient,
      env: {} as EnvConfig,
      search: "alpha",
      refresh: false,
      nonInteractive: true,
    });

    expect(textMock).toHaveBeenCalledTimes(0);
    expect(selectMock).toHaveBeenCalledTimes(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe(
      "alpha  https://jenkins.example.com/job/alpha",
    );
  });

  test("interactive uses initial search and exits from menu", async () => {
    const logSpy = spyOn(console, "log");
    selectMock.mockImplementationOnce(async () => "__jenkins_cli_exit__");

    await runList({
      client: {} as JenkinsClient,
      env: {} as EnvConfig,
      search: "beta",
      refresh: false,
      nonInteractive: false,
    });

    expect(textMock).toHaveBeenCalledTimes(0);
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe(
      "beta  https://jenkins.example.com/job/beta",
    );
  });

  test("interactive routes selected action to watch command", async () => {
    const logSpy = spyOn(console, "log");
    textMock
      .mockImplementationOnce(async () => "alpha")
      .mockImplementationOnce(async () => "q");
    selectMock
      .mockImplementationOnce(
        async () => "https://jenkins.example.com/job/alpha",
      )
      .mockImplementationOnce(async () => "watch")
      .mockImplementationOnce(async () => "search");

    await runList({
      client: {} as JenkinsClient,
      env: { branchParamDefault: "BRANCH" } as EnvConfig,
      refresh: false,
      nonInteractive: false,
    });

    expect(runWaitMock).toHaveBeenCalledTimes(1);
    expect(runWaitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobUrl: "https://jenkins.example.com/job/alpha",
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      "alpha  https://jenkins.example.com/job/alpha",
    );
  });

  test("interactive action errors are shown and menu continues", async () => {
    const errorSpy = spyOn(console, "error");

    textMock
      .mockImplementationOnce(async () => "alpha")
      .mockImplementationOnce(async () => "q");
    selectMock
      .mockImplementationOnce(
        async () => "https://jenkins.example.com/job/alpha",
      )
      .mockImplementationOnce(async () => "cancel")
      .mockImplementationOnce(async () => "search");

    runCancelMock.mockImplementationOnce(async () => {
      throw new CliError("No running or queued build found.", [
        "Trigger a build first, then try cancelling again.",
      ]);
    });

    await runList({
      client: {} as JenkinsClient,
      env: { branchParamDefault: "BRANCH" } as EnvConfig,
      refresh: false,
      nonInteractive: false,
    });

    expect(runCancelMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "ERROR: No running or queued build found.",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "HINT: Trigger a build first, then try cancelling again.",
    );
  });
});
