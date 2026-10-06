import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import * as flowRunnerModule from "../src/flows/runner";
import * as opsHelpersModule from "../src/commands/ops-helpers";
import * as recentJobsModule from "../src/recent-jobs";
import * as stageCountCacheModule from "../src/stage-count-cache";
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

const STATUS_READ_DELAY_MS = 100;
const multiJobTargets = ["alpha", "bravo", "charlie", "delta", "echo"].map(
  (name) => ({
    jobUrl: `https://jenkins.example.com/job/${name}`,
    jobLabel: name,
  }),
);

/** Stubs the interactive picker and the post-status menu around the loop. */
function stubInteractiveMultiJob() {
  const logSpy = trackRestore(spyOn(console, "log")).mockImplementation(
    () => undefined,
  );
  const recordSpy = trackRestore(
    spyOn(recentJobsModule, "recordRecentJob"),
  ).mockResolvedValue();
  trackRestore(
    spyOn(stageCountCacheModule, "getKnownStageTotal"),
  ).mockResolvedValue(undefined);
  trackRestore(
    spyOn(stageCountCacheModule, "persistKnownTotalStages"),
  ).mockResolvedValue();
  trackRestore(spyOn(opsHelpersModule, "resolveJobTargets")).mockResolvedValue(
    multiJobTargets,
  );
  trackRestore(spyOn(flowRunnerModule, "runFlow")).mockResolvedValue({
    terminal: "exit_command",
    stateId: "again_confirm",
    context: {},
  });
  return { logSpy, recordSpy };
}

function delayedJobStatus(
  failingJobUrl?: string,
): JenkinsClient["getJobStatus"] {
  return mock(async (jobUrl: string) => {
    await Bun.sleep(STATUS_READ_DELAY_MS);
    if (jobUrl === failingJobUrl) {
      throw new Error(`read failed for ${jobUrl}`);
    }
    return {
      buildNumber: 7,
      buildUrl: `${jobUrl}/7/`,
      result: "SUCCESS",
      building: false,
    };
  });
}

function printedOutput(logSpy: { mock: { calls: unknown[][] } }): string {
  return logSpy.mock.calls.map(([line]) => String(line)).join("\n");
}

function expectedOutput(jobLabels: string[]): string {
  return jobLabels
    .map(
      (label) =>
        `OK: Last build for ${label}: #7 SUCCESS\nURL: https://jenkins.example.com/job/${label}/7/`,
    )
    .join(`\n\n${"-".repeat(60)}\n`);
}

describe("status command", () => {
  afterEach(() => {
    while (restoreFns.length > 0) {
      restoreFns.pop()?.();
    }
  });

  test("reports disabled state for a job with no builds", async () => {
    const logSpy = trackRestore(spyOn(console, "log")).mockImplementation(
      () => undefined,
    );
    trackRestore(
      spyOn(recentJobsModule, "recordRecentJob"),
    ).mockResolvedValue();

    await runStatus({
      client: createClient({
        getJobStatus: mock(async () => ({ disabled: true })),
      }),
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: true,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Job state: DISABLED"),
    );
  });

  test("reports enabled state separately from the latest build result", async () => {
    const logSpy = trackRestore(spyOn(console, "log")).mockImplementation(
      () => undefined,
    );
    trackRestore(
      spyOn(recentJobsModule, "recordRecentJob"),
    ).mockResolvedValue();
    trackRestore(
      spyOn(stageCountCacheModule, "getKnownStageTotal"),
    ).mockResolvedValue(undefined);
    trackRestore(
      spyOn(stageCountCacheModule, "persistKnownTotalStages"),
    ).mockResolvedValue();

    await runStatus({
      client: createClient({
        getJobStatus: mock(async () => ({
          disabled: false,
          buildNumber: 42,
          result: "SUCCESS",
          building: false,
        })),
      }),
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: true,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Job state: ENABLED"),
    );
  });

  test("persists known stage totals for completed unstable builds", async () => {
    trackRestore(spyOn(console, "log")).mockImplementation(() => undefined);
    const stages = [{ id: "1", name: "Deploy", status: "UNSTABLE" }];

    trackRestore(
      spyOn(recentJobsModule, "recordRecentJob"),
    ).mockResolvedValue();
    trackRestore(
      spyOn(stageCountCacheModule, "getKnownStageTotal"),
    ).mockResolvedValue(undefined);
    const persistKnownTotalStagesSpy = trackRestore(
      spyOn(stageCountCacheModule, "persistKnownTotalStages"),
    ).mockResolvedValue();

    await runStatus({
      client: createClient({
        getJobStatus: mock(async () => ({
          buildNumber: 42,
          buildUrl: "https://jenkins.example.com/job/api/42/",
          result: "UNSTABLE",
          building: false,
          timestampMs: 1_700_000_000_000,
          durationMs: 12_000,
          stages,
        })),
      }),
      env,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: true,
    });

    expect(persistKnownTotalStagesSpy).toHaveBeenCalledTimes(1);
    expect(persistKnownTotalStagesSpy).toHaveBeenCalledWith({
      env,
      jobUrl: "https://jenkins.example.com/job/api",
      buildUrl: "https://jenkins.example.com/job/api/42/",
      stages,
      jobLabel: "https://jenkins.example.com/job/api",
    });
  });

  test("reads every selected job at once and prints them in order", async () => {
    const { logSpy, recordSpy } = stubInteractiveMultiJob();

    const startedAt = performance.now();
    await runStatus({
      client: createClient({ getJobStatus: delayedJobStatus() }),
      env,
      nonInteractive: false,
    });
    const elapsedMs = performance.now() - startedAt;

    // One read at a time would take 5 x 100ms.
    expect(elapsedMs).toBeLessThan(STATUS_READ_DELAY_MS * 2.5);
    expect(printedOutput(logSpy)).toBe(
      expectedOutput(multiJobTargets.map((target) => target.jobLabel)),
    );
    expect(recordSpy.mock.calls.map(([options]) => options.jobUrl)).toEqual(
      multiJobTargets.map((target) => target.jobUrl),
    );
  });

  test("stops at the first failed job in list order", async () => {
    const { logSpy, recordSpy } = stubInteractiveMultiJob();
    const failing = multiJobTargets[2]!;

    await expect(
      runStatus({
        client: createClient({
          getJobStatus: delayedJobStatus(failing.jobUrl),
        }),
        env,
        nonInteractive: false,
      }),
    ).rejects.toThrow(`read failed for ${failing.jobUrl}`);

    // The separator before the failed job prints, as in the one-by-one loop.
    expect(printedOutput(logSpy)).toBe(
      `${expectedOutput(["alpha", "bravo"])}\n\n${"-".repeat(60)}`,
    );
    expect(recordSpy.mock.calls.map(([options]) => options.jobUrl)).toEqual(
      multiJobTargets.slice(0, 3).map((target) => target.jobUrl),
    );
  });
});
