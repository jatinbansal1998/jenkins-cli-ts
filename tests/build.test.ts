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

const confirmMock = mock(async () => false);
const selectMock = mock(async () => "done");
const textMock = mock(async () => "");
const isCancelMock = mock(() => false);
const spinnerMock = mock(() => ({
  start: () => undefined,
  stop: () => undefined,
  message: () => undefined,
}));

const runCancelMock = mock(async (..._args: unknown[]) => undefined);
const runLogsMock = mock(async () => undefined);
const notifyBuildCompleteMock = mock(async () => undefined);

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

const { runBuild } = await import("../src/commands/build");

const JOB_URL = "https://jenkins.example.com/job/crypto-order-matching-engine/";
const BUILD_URL =
  "https://jenkins.example.com/job/crypto-order-matching-engine/381/";
const QUEUE_URL = "https://jenkins.example.com/queue/item/9042/";

function createClient(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

describe("build command", () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    mock.clearAllMocks();

    confirmMock.mockReset();
    confirmMock.mockImplementation(async () => false);

    selectMock.mockReset();
    selectMock.mockImplementation(async () => "done");

    textMock.mockReset();
    textMock.mockImplementation(async () => "");

    isCancelMock.mockReset();
    isCancelMock.mockImplementation(() => false);

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

    process.argv = [...originalArgv];
    process.argv[1] = "jenkins-cli";
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    mock.restore();
  });

  test("cancel action passes only build URL when build and queue URLs are both present", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 381,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    confirmMock
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => false);
    selectMock
      .mockImplementationOnce(async () => "cancel")
      .mockImplementationOnce(async () => "done");

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      jobUrl: JOB_URL,
      branch: "staging",
      nonInteractive: false,
    });

    expect(runCancelMock).toHaveBeenCalledTimes(1);
    expect(runCancelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buildUrl: BUILD_URL,
        queueUrl: undefined,
        jobUrl: undefined,
      }),
    );
  });

  test("prints non-interactive command when build is triggered in return-to-caller flow", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 381,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));
    const logSpy = spyOn(console, "log");

    confirmMock.mockImplementationOnce(async () => false);
    selectMock.mockImplementationOnce(async () => "done");

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      jobUrl: JOB_URL,
      branch: "staging",
      nonInteractive: false,
      returnToCaller: true,
    });

    const commandLine = logSpy.mock.calls
      .map((call) => call[0])
      .find(
        (entry): entry is string =>
          typeof entry === "string" &&
          entry.includes("build --non-interactive") &&
          entry.includes("--job-url") &&
          entry.includes("--branch 'staging'"),
      );

    expect(commandLine).toContain("jenkins-cli build --non-interactive");
  });
});
