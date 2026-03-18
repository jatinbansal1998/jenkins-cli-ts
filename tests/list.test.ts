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
import { EXIT_VALUE } from "../src/flows/constants";
import type { JenkinsClient } from "../src/jenkins/client";
import type { JenkinsJob } from "../src/types/jenkins";

const jobs: JenkinsJob[] = [
  { name: "beta", url: "https://jenkins.example.com/job/beta" },
  { name: "alpha", url: "https://jenkins.example.com/job/alpha" },
];

const loadJobsMock = mock(async () => jobs);
const loadPreferredJobsMock = mock(async () => jobs);
const autocompleteMock = mock(async (..._args: unknown[]) => EXIT_VALUE);
const confirmMock = mock(() => true);
const isCancelMock = mock(() => false);
const selectMock = mock(async (..._args: unknown[]) => EXIT_VALUE);
const textMock = mock(async (..._args: unknown[]) => "q");

const runBuildMock = mock(async () => undefined);
const runHistoryMock = mock(async () => undefined);
const runStatusMock = mock(async () => undefined);
const runWaitMock = mock(async (..._args: unknown[]) => undefined);
const runLogsMock = mock(async () => undefined);
const runCancelMock = mock(async () => undefined);
const runRerunMock = mock(async () => undefined);
const runRerunLastBuildMock = mock(async () => undefined);

mock.module("../src/commands/list-deps", () => ({
  listDeps: {
    autocomplete: autocompleteMock,
    confirm: confirmMock,
    isCancel: isCancelMock,
    select: selectMock,
    text: textMock,
    loadJobs: loadJobsMock,
    loadPreferredJobs: loadPreferredJobsMock,
    getJobDisplayName: (job: { name: string; fullName?: string }) =>
      job.fullName || job.name,
    rankJobs: (query: string, entries: { name: string; url: string }[]) =>
      entries
        .filter((job) => job.name.includes(query))
        .map((job) => ({ job, score: 100 })),
    sortJobsByDisplayName: (entries: { name: string; fullName?: string }[]) =>
      entries
        .slice()
        .sort((a, b) =>
          (a.fullName || a.name).localeCompare(b.fullName || b.name),
        ),
    runBuild: runBuildMock,
    runHistory: runHistoryMock,
    runStatus: runStatusMock,
    runWait: runWaitMock,
    runLogs: runLogsMock,
    runCancel: runCancelMock,
    runRerun: runRerunMock,
    runRerunLastBuild: runRerunLastBuildMock,
  },
}));

const { runList } = await import("../src/commands/list");

describe("runList", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    loadJobsMock.mockReset();
    loadJobsMock.mockImplementation(async () => jobs);
    loadPreferredJobsMock.mockReset();
    loadPreferredJobsMock.mockImplementation(async () => jobs);
    autocompleteMock.mockReset();
    autocompleteMock.mockImplementation(async () => EXIT_VALUE);
    confirmMock.mockReset();
    confirmMock.mockImplementation(() => true);
    isCancelMock.mockReset();
    isCancelMock.mockImplementation(() => false);
    selectMock.mockReset();
    selectMock.mockImplementation(async () => EXIT_VALUE);
    textMock.mockReset();
    textMock.mockImplementation(async () => "q");

    runBuildMock.mockReset();
    runBuildMock.mockImplementation(async () => undefined);
    runHistoryMock.mockReset();
    runHistoryMock.mockImplementation(async () => undefined);
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
    runRerunLastBuildMock.mockReset();
    runRerunLastBuildMock.mockImplementation(async () => undefined);
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
    expect(autocompleteMock).toHaveBeenCalledTimes(0);
    expect(selectMock).toHaveBeenCalledTimes(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe(
      "alpha  https://jenkins.example.com/job/alpha",
    );
  });

  test("interactive uses initial search and exits from menu", async () => {
    autocompleteMock.mockImplementationOnce(
      async () => "https://jenkins.example.com/job/beta",
    );
    selectMock.mockImplementationOnce(async () => "exit");

    await runList({
      client: {} as JenkinsClient,
      env: {} as EnvConfig,
      search: "beta",
      refresh: false,
      nonInteractive: false,
    });

    expect(textMock).toHaveBeenCalledTimes(0);
    expect(loadPreferredJobsMock).toHaveBeenCalledTimes(0);
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(autocompleteMock).toHaveBeenCalledTimes(1);
    const autocompleteCalls = autocompleteMock.mock.calls as unknown as Array<
      Array<unknown>
    >;
    expect(autocompleteCalls[0]?.[0]).toEqual(
      expect.objectContaining({
        initialUserInput: "beta",
      }),
    );
  });

  test("interactive blank search uses preferred jobs for default ordering", async () => {
    loadPreferredJobsMock.mockImplementationOnce(async () => [
      jobs[0] as JenkinsJob,
      jobs[1] as JenkinsJob,
    ]);
    autocompleteMock.mockImplementationOnce(async (...args: unknown[]) => {
      const [options] = args as [
        {
          options: unknown[] | ((this: { userInput: string }) => unknown[]);
        },
      ];
      const resolvedOptions =
        typeof options.options === "function"
          ? options.options.call({ userInput: "" })
          : options.options;
      expect(resolvedOptions).toEqual([
        { value: "https://jenkins.example.com/job/beta", label: "beta" },
        { value: "https://jenkins.example.com/job/alpha", label: "alpha" },
      ]);
      return EXIT_VALUE;
    });

    await runList({
      client: {} as JenkinsClient,
      env: { branchParamDefault: "BRANCH" } as EnvConfig,
      refresh: false,
      nonInteractive: false,
    });

    expect(loadPreferredJobsMock).toHaveBeenCalledTimes(1);
    expect(loadPreferredJobsMock).toHaveBeenCalledWith({
      env: expect.objectContaining({ branchParamDefault: "BRANCH" }),
      jobs,
    });
  });

  test("interactive routes selected action to watch command", async () => {
    autocompleteMock
      .mockImplementationOnce(
        async () => "https://jenkins.example.com/job/alpha",
      )
      .mockImplementationOnce(async () => EXIT_VALUE);
    selectMock
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
    expect(autocompleteMock).toHaveBeenCalledTimes(2);
  });

  test("interactive routes selected action to build history command", async () => {
    autocompleteMock
      .mockImplementationOnce(
        async () => "https://jenkins.example.com/job/alpha",
      )
      .mockImplementationOnce(async () => EXIT_VALUE);
    selectMock
      .mockImplementationOnce(async () => "history")
      .mockImplementationOnce(async () => "search");

    await runList({
      client: {} as JenkinsClient,
      env: { branchParamDefault: "BRANCH" } as EnvConfig,
      refresh: false,
      nonInteractive: false,
    });

    expect(runHistoryMock).toHaveBeenCalledTimes(1);
    expect(runHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobUrl: "https://jenkins.example.com/job/alpha",
      }),
    );
  });

  test("interactive routes selected action to rerun last build", async () => {
    autocompleteMock
      .mockImplementationOnce(
        async () => "https://jenkins.example.com/job/alpha",
      )
      .mockImplementationOnce(async () => EXIT_VALUE);
    selectMock
      .mockImplementationOnce(async () => "rerun_last")
      .mockImplementationOnce(async () => "search");

    await runList({
      client: {} as JenkinsClient,
      env: { branchParamDefault: "BRANCH" } as EnvConfig,
      refresh: false,
      nonInteractive: false,
    });

    expect(runRerunLastBuildMock).toHaveBeenCalledTimes(1);
    expect(runRerunLastBuildMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobUrl: "https://jenkins.example.com/job/alpha",
      }),
    );
  });

  test("interactive action errors are shown and menu continues", async () => {
    const errorSpy = spyOn(console, "error");

    autocompleteMock
      .mockImplementationOnce(
        async () => "https://jenkins.example.com/job/alpha",
      )
      .mockImplementationOnce(async () => EXIT_VALUE);
    selectMock
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
