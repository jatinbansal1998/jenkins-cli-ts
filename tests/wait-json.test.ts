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
import * as stageCountCacheModule from "../src/stage-count-cache";
import { runWait } from "../src/commands/wait";

const restoreFns: Array<() => void> = [];

function trackRestore<T extends { mockRestore(): void }>(
  mockWithRestore: T,
): T {
  restoreFns.push(() => mockWithRestore.mockRestore());
  return mockWithRestore;
}

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

function createClient(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

function capture(): { write: (text: string) => void; output: () => string } {
  const chunks: string[] = [];
  return {
    write: (text) => {
      chunks.push(text);
    },
    output: () => chunks.join(""),
  };
}

describe("wait --json", () => {
  beforeEach(() => {
    process.exitCode = 0;
    trackRestore(
      spyOn(stageCountCacheModule, "getKnownStageTotal"),
    ).mockResolvedValue(undefined);
    trackRestore(
      spyOn(stageCountCacheModule, "persistKnownTotalStages"),
    ).mockResolvedValue();
  });

  afterEach(() => {
    process.exitCode = undefined;
    while (restoreFns.length > 0) {
      restoreFns.pop()?.();
    }
  });

  test("emits the final outcome as a single JSON document on success", async () => {
    const logSpy = trackRestore(spyOn(console, "log")).mockImplementation(
      () => undefined,
    );
    const sink = capture();

    await runWait({
      client: createClient({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl: "https://jenkins.example.com/job/api/9/",
          result: "SUCCESS",
          building: false,
          timestampMs: 1_700_000_000_000,
          durationMs: 5_000,
        })),
      }),
      env,
      buildUrl: "https://jenkins.example.com/job/api/9/",
      nonInteractive: true,
      json: true,
      write: sink.write,
    });

    const lines = sink.output().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as {
      ok: boolean;
      command: string;
      data: {
        result: string;
        build: { number: number; url: string; durationMs?: number };
        waitedMs: number;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("wait");
    expect(parsed.data.result).toBe("SUCCESS");
    expect(parsed.data.build).toMatchObject({
      number: 9,
      url: "https://jenkins.example.com/job/api/9/",
      durationMs: 5_000,
    });
    expect(typeof parsed.data.waitedMs).toBe("number");
    expect(process.exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(0);
  });

  test("emits the JSON document with exit code 1 on a non-success build", async () => {
    const sink = capture();

    await runWait({
      client: createClient({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl: "https://jenkins.example.com/job/api/9/",
          result: "FAILURE",
          building: false,
          timestampMs: 1_700_000_000_000,
          durationMs: 5_000,
        })),
      }),
      env,
      buildUrl: "https://jenkins.example.com/job/api/9/",
      nonInteractive: true,
      json: true,
      write: sink.write,
    });

    const parsed = JSON.parse(sink.output()) as {
      ok: boolean;
      data: { result: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.result).toBe("FAILURE");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("emits the JSON document with exit code 124 on timeout", async () => {
    const sink = capture();

    await runWait({
      client: createClient({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl: "https://jenkins.example.com/job/api/9/",
          result: null,
          building: true,
        })),
      }),
      env,
      buildUrl: "https://jenkins.example.com/job/api/9/",
      interval: "20ms",
      timeout: "5ms",
      nonInteractive: true,
      json: true,
      write: sink.write,
    });

    const parsed = JSON.parse(sink.output()) as {
      ok: boolean;
      data: { result: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.result).toBe("TIMEOUT");
    expect(process.exitCode).toBe(124);
    process.exitCode = 0;
  });

  test("emits a JSON error envelope and non-zero exit code on invalid input", async () => {
    const sink = capture();

    await runWait({
      client: createClient({
        getBuildStatus: mock(async () => {
          throw new Error("should not be called");
        }),
      }),
      env,
      buildUrl: "https://jenkins.example.com/job/api/9/",
      interval: "0s",
      nonInteractive: true,
      json: true,
      write: sink.write,
    });

    const parsed = JSON.parse(sink.output()) as {
      ok: boolean;
      error: { message: string; code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("INVALID_USAGE");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
