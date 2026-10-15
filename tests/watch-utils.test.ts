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
import {
  findWatchedBuild,
  JENKINS_UNAVAILABLE_LIMIT_MS,
  trackJenkinsOutage,
  nextWatchPollMs,
  parseWatchIntervalMs,
  waitForPollIntervalOrCancel,
} from "../src/commands/watch-utils";
import { EXIT_CODES, exitCodeFor, type ErrorCode } from "../src/error-codes";
import type { JenkinsClient } from "../src/jenkins/client";
import type { LastBuildSummary } from "../src/types/jenkins";

describe("nextWatchPollMs", () => {
  test("starts at 1s and grows by 1s until it settles at 5s", () => {
    const delays = Array.from({ length: 7 }, (_, completedPolls) =>
      nextWatchPollMs(completedPolls, undefined),
    );
    expect(delays).toEqual([1_000, 2_000, 3_000, 4_000, 5_000, 5_000, 5_000]);
  });

  test("uses an explicit interval for every poll", () => {
    expect(nextWatchPollMs(0, 30_000)).toBe(30_000);
    expect(nextWatchPollMs(10, 250)).toBe(250);
  });
});

describe("parseWatchIntervalMs", () => {
  test("leaves the interval unset when the flag is absent or blank", () => {
    expect(parseWatchIntervalMs(undefined)).toBeUndefined();
    expect(parseWatchIntervalMs("  ")).toBeUndefined();
  });

  test("parses a duration", () => {
    expect(parseWatchIntervalMs("2s")).toBe(2_000);
    expect(parseWatchIntervalMs("1m")).toBe(60_000);
  });

  test("rejects a zero or malformed interval", () => {
    expect(() => parseWatchIntervalMs("0s")).toThrow(
      "Invalid --interval value.",
    );
    expect(() => parseWatchIntervalMs("soon")).toThrow(
      'Invalid --interval value "soon".',
    );
  });
});

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

function jenkinsError(code: ErrorCode, httpStatus?: number): CliError {
  const message = `Jenkins request failed (${httpStatus ?? code}).`;
  return code === "JENKINS_HTTP_ERROR" && httpStatus !== undefined
    ? new CliError(message, [], code, { details: { httpStatus } })
    : new CliError(message, [], code);
}

describe("trackJenkinsOutage", () => {
  let now = 0;
  let nowSpy: ReturnType<typeof spyOn<DateConstructor, "now">>;

  beforeEach(() => {
    now = 1_700_000_000_000;
    nowSpy = spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  test("reports an outage once, backs off, and reports recovery", () => {
    const reports: string[] = [];
    const outage = trackJenkinsOutage({
      intervalMs: 5_000,
      report: (message) => reports.push(message),
    });

    const delays = [
      jenkinsError("JENKINS_HTTP_ERROR", 503),
      jenkinsError("JENKINS_HTTP_ERROR", 502),
      jenkinsError("JENKINS_UNREACHABLE"),
      jenkinsError("JENKINS_HTTP_ERROR", 504),
      jenkinsError("JENKINS_UNREACHABLE"),
    ].map((error) => outage.retryDelayMs(error));

    expect(delays).toEqual([5_000, 10_000, 20_000, 30_000, 30_000]);
    expect(reports).toEqual([
      "Jenkins is unavailable, retrying for up to 10m 0s. Jenkins request failed (503).",
    ]);

    now += 65_000;
    outage.recovered();
    outage.recovered();
    expect(reports.slice(1)).toEqual([
      "Jenkins is reachable again after 1m 5s.",
    ]);
  });

  test.each<[ErrorCode, number | undefined]>([
    ["JENKINS_AUTH_ERROR", undefined],
    ["BUILD_NOT_FOUND", undefined],
    ["JENKINS_NOT_FOUND", undefined],
    ["JENKINS_HTTP_ERROR", 500],
    ["JENKINS_TIMEOUT", undefined],
    ["JENKINS_INVALID_RESPONSE", undefined],
  ])("rethrows %s %p at once", (code, httpStatus) => {
    const reports: string[] = [];
    const outage = trackJenkinsOutage({
      intervalMs: 5_000,
      report: (message) => reports.push(message),
    });
    const error = jenkinsError(code, httpStatus);

    expect(() => outage.retryDelayMs(error)).toThrow(error);
    expect(reports).toEqual([]);
  });

  test("gives up with a Jenkins error once the outage outlasts the limit", () => {
    const outage = trackJenkinsOutage({
      intervalMs: 5_000,
      report: () => undefined,
    });
    const unavailable = jenkinsError("JENKINS_HTTP_ERROR", 503);

    outage.retryDelayMs(unavailable);
    now += JENKINS_UNAVAILABLE_LIMIT_MS - 1;
    expect(outage.retryDelayMs(unavailable)).toBe(10_000);
    now += 1;

    let thrown: unknown;
    try {
      outage.retryDelayMs(unavailable);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const error = thrown as CliError;
    expect(error.code).toBe("JENKINS_UNREACHABLE");
    expect(exitCodeFor(error)).toBe(EXIT_CODES.JENKINS);
    expect(error.message).toBe(
      "Jenkins stayed unavailable for 10m 0s, so the watch stopped. Jenkins request failed (503).",
    );
    expect(error.cause).toBe(unavailable);
  });

  test("a new outage after recovery gets its own time limit", () => {
    const outage = trackJenkinsOutage({
      intervalMs: 5_000,
      report: () => undefined,
    });
    const unavailable = jenkinsError("JENKINS_UNREACHABLE");

    outage.retryDelayMs(unavailable);
    now += JENKINS_UNAVAILABLE_LIMIT_MS - 1;
    outage.recovered();
    now += 1;

    expect(outage.retryDelayMs(unavailable)).toBe(5_000);
    now += JENKINS_UNAVAILABLE_LIMIT_MS - 1;
    expect(outage.retryDelayMs(unavailable)).toBe(10_000);
  });
});
