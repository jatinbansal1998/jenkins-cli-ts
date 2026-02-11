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

  test("watch cancellation still opens post-build action menu", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 381,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));
    const getBuildStatus = mock(async () => {
      process.stdin.emit("data", "\u001b");
      return {
        buildNumber: 381,
        buildUrl: BUILD_URL,
        result: undefined,
        building: true,
      };
    });

    selectMock.mockImplementationOnce(async () => "done");

    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutIsTTY = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      await runBuild({
        client: createClient({
          getJobStatus,
          triggerBuild,
          getBuildStatus,
        }),
        env: {} as EnvConfig,
        jobUrl: JOB_URL,
        branch: "staging",
        nonInteractive: false,
        watch: true,
        returnToCaller: true,
      });
    } finally {
      if (stdinIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
      if (stdoutIsTTY) {
        Object.defineProperty(process.stdout, "isTTY", stdoutIsTTY);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }

    expect(getBuildStatus).toHaveBeenCalledTimes(1);
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Next action for https://jenkins.example.com/job/crypto-order-matching-engine/",
      }),
    );
    expect(notifyBuildCompleteMock).toHaveBeenCalledTimes(0);
  });



  test("non-interactive build without branch triggers without parameters", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      jobUrl: JOB_URL,
      nonInteractive: true,
    });

    expect(triggerBuild).toHaveBeenCalledTimes(1);
    const triggerCalls = triggerBuild.mock.calls as unknown as Array<
      Array<unknown>
    >;
    expect(triggerCalls[0]?.[0]).toBe(JOB_URL);
    expect(triggerCalls[0]?.[1]).toEqual({});
  });

  test("non-interactive build with blank branch triggers without parameters", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      jobUrl: JOB_URL,
      branch: "   ",
      nonInteractive: true,
    });

    expect(triggerBuild).toHaveBeenCalledTimes(1);
    const triggerCalls = triggerBuild.mock.calls as unknown as Array<
      Array<unknown>
    >;
    expect(triggerCalls[0]?.[0]).toBe(JOB_URL);
    expect(triggerCalls[0]?.[1]).toEqual({});
  });



  test("non-interactive build without branch triggers default branch", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      jobUrl: JOB_URL,
      nonInteractive: true,
    });

    expect(triggerBuild).toHaveBeenCalledTimes(1);
    expect(triggerBuild.mock.calls[0]?.[0]).toBe(JOB_URL);
    expect(triggerBuild.mock.calls[0]?.[1]).toEqual({});
  });

  test("non-interactive build with blank branch triggers default branch", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      jobUrl: JOB_URL,
      branch: "   ",
      nonInteractive: true,
    });

    expect(triggerBuild).toHaveBeenCalledTimes(1);
    expect(triggerBuild.mock.calls[0]?.[0]).toBe(JOB_URL);
    expect(triggerBuild.mock.calls[0]?.[1]).toEqual({});
  });

  test("watch cancellation still reaches trigger-another-build confirmation", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 381,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));
    const getBuildStatus = mock(async () => {
      process.stdin.emit("data", "\u001b");
      return {
        buildNumber: 381,
        buildUrl: BUILD_URL,
        result: undefined,
        building: true,
      };
    });

    // First confirm is "Trigger another build?" because watch is fixed by flag.
    confirmMock.mockImplementationOnce(async () => false);
    selectMock.mockImplementationOnce(async () => "done");

    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutIsTTY = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      await runBuild({
        client: createClient({
          getJobStatus,
          triggerBuild,
          getBuildStatus,
        }),
        env: {} as EnvConfig,
        jobUrl: JOB_URL,
        branch: "staging",
        nonInteractive: false,
        watch: true,
      });
    } finally {
      if (stdinIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
      if (stdoutIsTTY) {
        Object.defineProperty(process.stdout, "isTTY", stdoutIsTTY);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }

    expect(getBuildStatus).toHaveBeenCalledTimes(1);
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Trigger another build?",
      }),
    );
  });
});
