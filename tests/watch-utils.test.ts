import { describe, expect, mock, test } from "bun:test";
import {
  findWatchedBuild,
  waitForPollIntervalOrCancel,
} from "../src/commands/watch-utils";
import type { JenkinsClient } from "../src/jenkins/client";
import type { LastBuildSummary } from "../src/types/jenkins";

describe("waitForPollIntervalOrCancel", () => {
  test("returns quickly when cancel signal is already resolved", async () => {
    const cancelSignal = {
      wait: Promise.resolve(),
    };
    const startedAt = Date.now();

    await waitForPollIntervalOrCancel(500, cancelSignal);

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(100);
  });

  test("returns quickly when cancel signal resolves before poll interval", async () => {
    let resolveCancel: (() => void) | undefined;
    const cancelSignal = {
      wait: new Promise<void>((resolve) => {
        resolveCancel = resolve;
      }),
    };

    setTimeout(() => {
      resolveCancel?.();
    }, 30);

    const startedAt = Date.now();
    await waitForPollIntervalOrCancel(500, cancelSignal);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(200);
  });

  test("waits for poll interval when cancel signal is absent", async () => {
    const startedAt = Date.now();
    await waitForPollIntervalOrCancel(40);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(30);
  });
});

function clientReturning(lastBuild: LastBuildSummary | null): JenkinsClient {
  return {
    getLastBuild: mock(async () => lastBuild),
  } as unknown as JenkinsClient;
}

describe("findWatchedBuild", () => {
  const jobUrl = "https://jenkins.example.com/job/api/";

  function build(buildNumber: number, building: boolean): LastBuildSummary {
    return {
      buildNumber,
      buildUrl: `${jobUrl}${buildNumber}/`,
      building,
      result: building ? null : "SUCCESS",
    };
  }

  test("ignores the finished build seen before the trigger", async () => {
    expect(
      await findWatchedBuild(clientReturning(build(5, false)), jobUrl, 5),
    ).toBeNull();
  });

  test("returns the baseline build while it is still running", async () => {
    expect(
      await findWatchedBuild(clientReturning(build(5, true)), jobUrl, 5),
    ).toEqual(build(5, true));
  });

  test("returns any newer build, running or finished", async () => {
    expect(
      await findWatchedBuild(clientReturning(build(6, false)), jobUrl, 5),
    ).toEqual(build(6, false));
  });

  test("returns the newest build when there was no baseline", async () => {
    expect(
      await findWatchedBuild(
        clientReturning(build(1, false)),
        jobUrl,
        undefined,
      ),
    ).toEqual(build(1, false));
  });

  test("returns null when the job has never built", async () => {
    expect(
      await findWatchedBuild(clientReturning(null), jobUrl, undefined),
    ).toBeNull();
  });
});
