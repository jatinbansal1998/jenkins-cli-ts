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
import { JENKINS_UNAVAILABLE_LIMIT_MS } from "../src/commands/watch-utils";
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

function unavailable(): CliError {
  return new CliError(
    "Jenkins returned HTTP 503 while trying to fetch build status.",
    [],
    "JENKINS_HTTP_ERROR",
    { details: { httpStatus: 503 } },
  );
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
          parameters: [{ name: "BRANCH", value: "main" }],
          branch: "main",
          revisions: [
            {
              repo: "api",
              remoteUrl: "https://github.com/acme/api.git",
              remoteUrls: ["https://github.com/acme/api.git"],
              branch: "refs/remotes/origin/main",
              sha: "a1b2c3d4",
            },
          ],
          triggeredBy: "Jane Doe",
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
      branch: "main",
      parameters: [{ name: "BRANCH", value: "main" }],
      revisions: [{ repo: "api", sha: "a1b2c3d4" }],
      triggeredBy: "Jane Doe",
    });
    expect(typeof parsed.data.waitedMs).toBe("number");
    expect(process.exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(0);
  });

  test.each([
    ["FAILURE", 1],
    ["UNSTABLE", 7],
    ["ABORTED", 8],
    ["NOT_BUILT", 9],
  ])(
    "emits the JSON document when the build ends %s, with exit code %d",
    async (buildResult, exitCode) => {
      const sink = capture();

      await runWait({
        client: createClient({
          getBuildStatus: mock(async () => ({
            buildNumber: 9,
            buildUrl: "https://jenkins.example.com/job/api/9/",
            result: buildResult,
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
      expect(parsed.data.result).toBe(buildResult);
      expect(process.exitCode).toBe(exitCode);
      process.exitCode = 0;
    },
  );

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

  test("reports a cancelled queue item as an aborted result with exit code 8", async () => {
    const sink = capture();

    await runWait({
      client: createClient({
        getQueueBuild: mock(async (_queueUrl: string) => ({
          cancelled: true,
        })),
        getLastBuild: mock(async (_jobUrl: string) => ({
          buildNumber: 7,
          buildUrl: "https://jenkins.example.com/job/api/7/",
          result: "SUCCESS",
          building: false,
        })),
      }),
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
      queueUrl: "https://jenkins.example.com/queue/item/123/",
      interval: "1ms",
      nonInteractive: true,
      json: true,
      write: sink.write,
    });

    const parsed = JSON.parse(sink.output()) as {
      ok: boolean;
      data: { result: string; build: { number?: number } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.result).toBe("ABORTED");
    expect(parsed.data.build.number).toBeUndefined();
    expect(process.exitCode).toBe(8);
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
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  describe("while Jenkins is unavailable", () => {
    const buildUrl = "https://jenkins.example.com/job/api/9/";
    const running = { buildNumber: 9, buildUrl, result: null, building: true };

    test.each([
      ["while the build still runs", [running]],
      ["when the build ends during it", []],
    ])("reports recovery %s", async (_case, afterOutage) => {
      const errorSpy = trackRestore(spyOn(console, "error")).mockImplementation(
        () => undefined,
      );
      const sink = capture();
      const getBuildStatus = mock().mockResolvedValueOnce(running);
      getBuildStatus.mockRejectedValueOnce(unavailable());
      for (const status of afterOutage) {
        getBuildStatus.mockResolvedValueOnce(status);
      }
      getBuildStatus.mockResolvedValueOnce({
        ...running,
        result: "SUCCESS",
        building: false,
      });

      await runWait({
        client: createClient({ getBuildStatus }),
        env,
        buildUrl,
        interval: "1ms",
        nonInteractive: true,
        json: true,
        write: sink.write,
      });

      expect(JSON.parse(sink.output()).data.result).toBe("SUCCESS");
      const warnings = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(warnings).toEqual([
        "WARN: Jenkins is unavailable, retrying for up to 10m 0s. Jenkins returned HTTP 503 while trying to fetch build status.",
        expect.stringMatching(
          /^WARN: Jenkins is reachable again after \d+ms\.$/,
        ),
      ]);
    });

    test("keeps waiting through a restart and reports the final result", async () => {
      const errorSpy = trackRestore(spyOn(console, "error")).mockImplementation(
        () => undefined,
      );
      const sink = capture();
      const getBuildStatus = mock()
        .mockResolvedValueOnce(running)
        .mockRejectedValueOnce(unavailable())
        .mockRejectedValueOnce(
          new CliError(
            "Network error while trying to fetch build status.",
            [],
            "JENKINS_UNREACHABLE",
          ),
        )
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce({
          ...running,
          result: "SUCCESS",
          building: false,
        });

      await runWait({
        client: createClient({ getBuildStatus }),
        env,
        buildUrl,
        interval: "1ms",
        nonInteractive: true,
        json: true,
        write: sink.write,
      });

      const parsed = JSON.parse(sink.output()) as {
        ok: boolean;
        data: { result: string };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.result).toBe("SUCCESS");
      expect(process.exitCode).toBe(0);
      expect(getBuildStatus).toHaveBeenCalledTimes(5);
      const warnings = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(warnings).toEqual([
        "WARN: Jenkins is unavailable, retrying for up to 10m 0s. Jenkins returned HTTP 503 while trying to fetch build status.",
        expect.stringMatching(
          /^WARN: Jenkins is reachable again after \d+ms\.$/,
        ),
      ]);
    });

    test("starts by job while Jenkins is still unavailable", async () => {
      const errorSpy = trackRestore(spyOn(console, "error")).mockImplementation(
        () => undefined,
      );
      const sink = capture();
      const getLastBuild = mock()
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValueOnce({
          buildNumber: 9,
          buildUrl,
          building: false,
          result: "SUCCESS",
        });
      const getBuildStatus = mock(async () => ({
        ...running,
        result: "SUCCESS",
        building: false,
      }));

      await runWait({
        client: createClient({ getLastBuild, getBuildStatus }),
        env,
        jobUrl: "https://jenkins.example.com/job/api/",
        interval: "1ms",
        nonInteractive: true,
        json: true,
        write: sink.write,
      });

      expect(JSON.parse(sink.output()).data.result).toBe("SUCCESS");
      expect(process.exitCode).toBe(0);
      const warnings = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(warnings).toEqual([
        "WARN: Jenkins is unavailable, retrying for up to 10m 0s. Jenkins returned HTTP 503 while trying to fetch build status.",
        expect.stringMatching(
          /^WARN: Jenkins is reachable again after \d+ms\.$/,
        ),
      ]);
    });

    test("exits 6 once Jenkins stays unavailable past the limit", async () => {
      trackRestore(spyOn(console, "error")).mockImplementation(() => undefined);
      let now = 1_700_000_000_000;
      trackRestore(spyOn(Date, "now")).mockImplementation(() => now);
      const sink = capture();
      const getBuildStatus = mock(async () => {
        now += JENKINS_UNAVAILABLE_LIMIT_MS / 4;
        throw unavailable();
      });

      await runWait({
        client: createClient({ getBuildStatus }),
        env,
        buildUrl,
        interval: "1ms",
        nonInteractive: true,
        json: true,
        write: sink.write,
      });

      const parsed = JSON.parse(sink.output()) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("JENKINS_UNREACHABLE");
      expect(parsed.error.message).toBe(
        "Jenkins stayed unavailable for 10m 0s, so the watch stopped. Jenkins returned HTTP 503 while trying to fetch build status.",
      );
      expect(process.exitCode).toBe(6);
      expect(getBuildStatus).toHaveBeenCalledTimes(5);
      process.exitCode = 0;
    });

    test.each<[string, CliError, number]>([
      [
        "401",
        new CliError(
          "Jenkins returned HTTP 401 while trying to fetch build status.",
          [],
          "JENKINS_AUTH_ERROR",
        ),
        3,
      ],
      [
        "404",
        new CliError(
          "Jenkins returned HTTP 404 while trying to fetch build status.",
          [],
          "BUILD_NOT_FOUND",
        ),
        4,
      ],
    ])("fails at once on HTTP %s", async (_status, error, exitCode) => {
      const errorSpy = trackRestore(spyOn(console, "error")).mockImplementation(
        () => undefined,
      );
      const sink = capture();
      const getBuildStatus = mock()
        .mockResolvedValueOnce(running)
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ ...running, result: "SUCCESS", building: false });

      await runWait({
        client: createClient({ getBuildStatus }),
        env,
        buildUrl,
        interval: "1ms",
        nonInteractive: true,
        json: true,
        write: sink.write,
      });

      const parsed = JSON.parse(sink.output()) as {
        ok: boolean;
        error: { code: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe(error.code);
      expect(process.exitCode).toBe(exitCode);
      expect(getBuildStatus).toHaveBeenCalledTimes(2);
      expect(errorSpy).not.toHaveBeenCalled();
      process.exitCode = 0;
    });
  });
});
