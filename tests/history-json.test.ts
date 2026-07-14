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
import { historyDeps } from "../src/commands/history-deps";
import { runHistory, setHistoryDepsForTesting } from "../src/commands/history";

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

const resolveJobTargetMock = mock(async ({ jobUrl }: { jobUrl?: string }) => ({
  jobUrl: jobUrl ?? "https://jenkins.example.com/job/api/",
  jobLabel: jobUrl ?? "https://jenkins.example.com/job/api/",
}));

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

describe("history --json", () => {
  beforeEach(() => {
    process.exitCode = 0;
    resolveJobTargetMock.mockReset();
    resolveJobTargetMock.mockImplementation(async ({ jobUrl }) => ({
      jobUrl: jobUrl ?? "https://jenkins.example.com/job/api/",
      jobLabel: jobUrl ?? "https://jenkins.example.com/job/api/",
    }));
    setHistoryDepsForTesting({
      ...historyDeps,
      resolveJobTarget: resolveJobTargetMock,
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    setHistoryDepsForTesting();
    while (restoreFns.length > 0) {
      restoreFns.pop()?.();
    }
  });

  test("emits an array of builds as a single JSON document", async () => {
    const logSpy = trackRestore(spyOn(console, "log")).mockImplementation(
      () => undefined,
    );
    const listBuildHistory = mock(async () => ({
      builds: [
        {
          buildNumber: 42,
          buildUrl: "https://jenkins.example.com/job/api/42/",
          result: "FAILURE",
          building: false,
          timestampMs: 1_700_000_000_000,
          durationMs: 75_000,
          branch: "main",
        },
        {
          buildNumber: 41,
          buildUrl: "https://jenkins.example.com/job/api/41/",
          result: "SUCCESS",
          building: false,
          timestampMs: 1_699_000_000_000,
          durationMs: 60_000,
        },
      ],
      total: 2,
      offset: 0,
      limit: 5,
      hasNext: false,
      hasPrevious: false,
    }));
    const sink = capture();

    await runHistory({
      client: createClient({ listBuildHistory }),
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
      data: Array<{ number: number; url: string; result: string | null }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("history");
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0]).toMatchObject({
      number: 42,
      url: "https://jenkins.example.com/job/api/42/",
      result: "FAILURE",
      building: false,
      durationMs: 75_000,
      branch: "main",
    });
    expect(logSpy).toHaveBeenCalledTimes(0);
  });

  test("emits a JSON error envelope and non-zero exit code on failure", async () => {
    const listBuildHistory = mock(async () => {
      throw new CliError("Jenkins returned HTTP 500 while trying to list.", [
        "Try again.",
      ]);
    });
    const sink = capture();

    await runHistory({
      client: createClient({ listBuildHistory }),
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
    process.exitCode = 0;
  });
});
