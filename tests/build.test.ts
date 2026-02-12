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
import { BUILD_WITHOUT_PARAMS_VALUE } from "../src/flows/constants";
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
        message: expect.stringContaining(
          "Next action for https://jenkins.example.com/job/crypto-order-matching-engine/",
        ),
      }),
    );
    expect(notifyBuildCompleteMock).toHaveBeenCalledTimes(0);
  });

  test("tip command keeps --watch for without-params builds", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 381,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));
    const getBuildStatus = mock(async () => ({
      buildNumber: 381,
      buildUrl: BUILD_URL,
      result: "SUCCESS",
      building: false,
    }));
    const logSpy = spyOn(console, "log");

    selectMock
      .mockImplementationOnce(async () => BUILD_WITHOUT_PARAMS_VALUE)
      .mockImplementationOnce(async () => "done");

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
        getBuildStatus,
      }),
      env: {} as EnvConfig,
      jobUrl: JOB_URL,
      nonInteractive: false,
      watch: true,
    });

    const commandLine = logSpy.mock.calls
      .map((call) => call[0])
      .find(
        (entry): entry is string =>
          typeof entry === "string" &&
          entry.includes("build --non-interactive") &&
          entry.includes("--without-params"),
      );

    expect(commandLine).toContain("--without-params");
    expect(commandLine).toContain("--watch");
  });

  test("tip command prints repeatable --param flags for custom parameters", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 381,
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));
    const logSpy = spyOn(console, "log");

    await runBuild({
      client: createClient({
        getJobStatus,
        triggerBuild,
      }),
      env: {} as EnvConfig,
      jobUrl: JOB_URL,
      customParams: {
        DEPLOY_ENV: "staging",
        FORCE: "true",
      },
      nonInteractive: false,
      returnToCaller: true,
    });

    const commandLine = logSpy.mock.calls
      .map((call) => call[0])
      .find(
        (entry): entry is string =>
          typeof entry === "string" &&
          entry.includes("build --non-interactive") &&
          entry.includes("--param"),
      );

    expect(commandLine).toContain("--param 'DEPLOY_ENV=staging'");
    expect(commandLine).toContain("--param 'FORCE=true'");
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

  test("non-interactive build with custom params triggers parameterized build", async () => {
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
      customParams: {
        DEPLOY_ENV: "staging",
        FORCE: "true",
      },
      nonInteractive: true,
    });

    expect(triggerBuild).toHaveBeenCalledTimes(1);
    const triggerCalls = triggerBuild.mock.calls as unknown as Array<
      Array<unknown>
    >;
    expect(triggerCalls[0]?.[0]).toBe(JOB_URL);
    expect(triggerCalls[0]?.[1]).toEqual({
      DEPLOY_ENV: "staging",
      FORCE: "true",
    });
  });

  test("non-interactive build merges branch and custom params", async () => {
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
      branch: "staging",
      customParams: {
        DEPLOY_ENV: "staging",
      },
      nonInteractive: true,
    });

    expect(triggerBuild).toHaveBeenCalledTimes(1);
    const triggerCalls = triggerBuild.mock.calls as unknown as Array<
      Array<unknown>
    >;
    expect(triggerCalls[0]?.[0]).toBe(JOB_URL);
    expect(triggerCalls[0]?.[1]).toEqual({
      DEPLOY_ENV: "staging",
      BRANCH: "staging",
    });
  });

  test("non-interactive build fails when branch param key conflicts with custom params", async () => {
    const getJobStatus = mock(async () => ({ lastBuildNumber: 380 }));
    const triggerBuild = mock(async () => ({
      queueUrl: QUEUE_URL,
      jobUrl: JOB_URL,
    }));

    await expect(
      runBuild({
        client: createClient({
          getJobStatus,
          triggerBuild,
        }),
        env: {} as EnvConfig,
        jobUrl: JOB_URL,
        branch: "staging",
        customParams: {
          BRANCH: "main",
        },
        nonInteractive: true,
      }),
    ).rejects.toThrow('Parameter key "BRANCH" conflicts with --branch.');

    expect(triggerBuild).not.toHaveBeenCalled();
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
        message: expect.stringContaining("Trigger another build?"),
      }),
    );
  });
});
