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
import * as recentJobsModule from "../src/recent-jobs";
import { runStatus } from "../src/commands/status";

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

describe("status --json", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = 0;
    trackRestore(
      spyOn(recentJobsModule, "recordRecentJob"),
    ).mockResolvedValue();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    while (restoreFns.length > 0) {
      restoreFns.pop()?.();
    }
  });

  test("emits the latest build info as a single JSON document", async () => {
    const logSpy = trackRestore(spyOn(console, "log")).mockImplementation(
      () => undefined,
    );
    const sink = capture();

    await runStatus({
      client: createClient({
        getJobStatus: mock(async () => ({
          lastBuildNumber: 42,
          lastBuildUrl: "https://jenkins.example.com/job/api/42/",
          result: "SUCCESS",
          building: false,
          lastBuildTimestamp: 1_700_000_000_000,
          lastBuildDurationMs: 12_000,
        })),
      }),
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
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
        job: string;
        build: {
          number: number;
          url: string;
          result: string | null;
          building: boolean;
          durationMs?: number;
          timestampMs?: number;
        } | null;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("status");
    expect(parsed.data.job).toBe("https://jenkins.example.com/job/api");
    expect(parsed.data.build).toMatchObject({
      number: 42,
      url: "https://jenkins.example.com/job/api/42/",
      result: "SUCCESS",
      building: false,
      durationMs: 12_000,
      timestampMs: 1_700_000_000_000,
    });
    expect(logSpy).toHaveBeenCalledTimes(0);
  });

  test("reports a null build when the job has no builds", async () => {
    const sink = capture();

    await runStatus({
      client: createClient({
        getJobStatus: mock(async () => ({})),
      }),
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: true,
      json: true,
      write: sink.write,
    });

    const parsed = JSON.parse(sink.output()) as {
      ok: boolean;
      data: { build: unknown };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.build).toBeNull();
  });

  test("rejects --json combined with --watch", async () => {
    const sink = capture();

    await runStatus({
      client: createClient({
        getJobStatus: mock(async () => {
          throw new Error("should not be called");
        }),
      }),
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: true,
      watch: true,
      json: true,
      write: sink.write,
    });

    const parsed = JSON.parse(sink.output()) as {
      ok: boolean;
      error: { message: string; code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("INVALID_USAGE");
    expect(parsed.error.message).toContain("--watch");
    expect(process.exitCode).toBe(1);
  });

  test("emits a JSON error envelope and non-zero exit code on failure", async () => {
    const sink = capture();

    await runStatus({
      client: createClient({
        getJobStatus: mock(async () => {
          throw new CliError("Resource not found while trying to job status.", [
            "Verify the job URL.",
          ]);
        }),
      }),
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: true,
      json: true,
      write: sink.write,
    });

    const parsed = JSON.parse(sink.output()) as {
      ok: boolean;
      error: { message: string; code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CLI_ERROR");
    expect(process.exitCode).toBe(1);
  });
});
