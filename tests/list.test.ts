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
import type { JenkinsClient, JenkinsJob } from "../src/jenkins/client";

const jobs: JenkinsJob[] = [
  { name: "beta", url: "https://jenkins.example.com/job/beta" },
  { name: "alpha", url: "https://jenkins.example.com/job/alpha" },
];

const loadJobsMock = mock(async () => jobs);
const confirmMock = mock(() => true);
const isCancelMock = mock(() => false);
const questionMock = mock(async () => "");
const closeMock = mock(() => undefined);
const onMock = mock(() => undefined);
const createInterfaceMock = mock(() => ({
  question: questionMock,
  close: closeMock,
  history: [] as string[],
  on: onMock,
}));

mock.module("../src/jobs", () => ({
  loadJobs: loadJobsMock,
  getJobDisplayName: (job: { name: string; fullName?: string }) =>
    job.fullName || job.name,
  rankJobs: (query: string, entries: { name: string; url: string }[]) =>
    entries
      .filter((job) => job.name.includes(query))
      .map((job) => ({ job, score: 100 })),
}));

mock.module("@clack/prompts", () => ({
  confirm: confirmMock,
  isCancel: isCancelMock,
}));

mock.module("node:readline/promises", () => ({
  createInterface: createInterfaceMock,
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
    questionMock.mockReset();
    questionMock.mockImplementation(async () => "");
    closeMock.mockReset();
    closeMock.mockImplementation(() => undefined);
    onMock.mockReset();
    onMock.mockImplementation(() => undefined);
    createInterfaceMock.mockReset();
    createInterfaceMock.mockImplementation(() => ({
      question: questionMock,
      close: closeMock,
      history: [] as string[],
      on: onMock,
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  test("non-interactive runs once without prompting", async () => {
    const logSpy = spyOn(console, "log");

    await runList({
      client: {} as JenkinsClient,
      env: {} as EnvConfig,
      search: "alpha",
      refresh: false,
      nonInteractive: true,
    });

    expect(createInterfaceMock).toHaveBeenCalledTimes(0);
    expect(questionMock).toHaveBeenCalledTimes(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe(
      "alpha  https://jenkins.example.com/job/alpha",
    );
  });

  test("interactive empty input lists all and continues until exit", async () => {
    questionMock.mockImplementationOnce(async () => "");
    questionMock.mockImplementationOnce(async () => "q");

    const logSpy = spyOn(console, "log");

    await runList({
      client: {} as JenkinsClient,
      env: {} as EnvConfig,
      refresh: false,
      nonInteractive: false,
    });

    expect(createInterfaceMock).toHaveBeenCalledTimes(1);
    expect(questionMock).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toBe(
      "alpha  https://jenkins.example.com/job/alpha",
    );
    expect(logSpy.mock.calls[1]?.[0]).toBe(
      "beta  https://jenkins.example.com/job/beta",
    );
  });

  test("interactive uses initial search before prompting again", async () => {
    questionMock.mockImplementationOnce(async () => "q");

    const logSpy = spyOn(console, "log");

    await runList({
      client: {} as JenkinsClient,
      env: {} as EnvConfig,
      search: "beta",
      refresh: false,
      nonInteractive: false,
    });

    expect(createInterfaceMock).toHaveBeenCalledTimes(1);
    expect(questionMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe(
      "beta  https://jenkins.example.com/job/beta",
    );
  });
});
