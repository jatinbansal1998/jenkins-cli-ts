import { describe, expect, test } from "bun:test";
import {
  loadFailures,
  loadSettings,
  summarizeSamples,
} from "./integration/jenkins/load";

describe("Jenkins load measurement", () => {
  test("uses nearest-rank percentiles and includes failed requests", () => {
    const samples = Array.from({ length: 100 }, (_, index) => ({
      command: "nodes",
      durationMs: index + 1,
      ok: index !== 99,
    }));
    expect(summarizeSamples(samples)).toEqual({
      count: 100,
      errors: 1,
      errorRate: 0.01,
      p50Ms: 50,
      p95Ms: 95,
      p99Ms: 99,
      maxMs: 100,
    });
    expect(loadFailures(samples, ["nodes", "queue"], 94)).toEqual([
      "nodes: 1 failed samples",
      "nodes: p95 95.0ms exceeds 94ms",
      "queue: no measured samples",
    ]);
    expect(
      loadFailures(
        samples.map((sample) => ({ ...sample, ok: true })),
        ["nodes"],
        95,
      ),
    ).toEqual([]);
    expect(summarizeSamples([])).toMatchObject({
      count: 0,
      errorRate: null,
      p95Ms: null,
    });
  });

  test("rejects invalid or unbounded workload settings", () => {
    expect(loadSettings({})).toEqual({
      concurrency: 4,
      durationSeconds: 30,
      timeoutMs: 15_000,
      p95LimitMs: 5_000,
    });
    for (const value of ["", "0", "-1", "33", "1.5", "NaN", "Infinity"]) {
      expect(() => loadSettings({ JENKINS_LOAD_CONCURRENCY: value })).toThrow();
    }
    expect(() => loadSettings({ JENKINS_LOAD_SECONDS: "601" })).toThrow();
    expect(() => loadSettings({ JENKINS_LOAD_TIMEOUT_MS: "99" })).toThrow();
    expect(() => loadSettings({ JENKINS_LOAD_P95_MS: "0" })).toThrow();
  });
});
