export type Sample = {
  command: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  cpuTimeMs?: number;
  maxRssBytes?: number;
};

export function loadSettings(env: Record<string, string | undefined>) {
  function integer(
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    }
    return value;
  }
  return {
    concurrency: integer("JENKINS_LOAD_CONCURRENCY", 4, 1, 32),
    durationSeconds: integer("JENKINS_LOAD_SECONDS", 30, 1, 600),
    timeoutMs: integer("JENKINS_LOAD_TIMEOUT_MS", 15_000, 100, 120_000),
    p95LimitMs: integer("JENKINS_LOAD_P95_MS", 5_000, 1, 120_000),
  };
}

export function summarizeSamples(samples: Sample[]) {
  const sorted = samples
    .map((sample) => sample.durationMs)
    .toSorted((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  const errors = samples.filter((sample) => !sample.ok).length;
  return {
    count: samples.length,
    errors,
    errorRate: samples.length ? errors / samples.length : null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1) ?? null,
  };
}

export function loadFailures(
  samples: Sample[],
  commands: string[],
  p95LimitMs: number,
): string[] {
  return commands.flatMap((command) => {
    const summary = summarizeSamples(
      samples.filter((sample) => sample.command === command),
    );
    if (summary.count === 0) return [`${command}: no measured samples`];
    const failures: string[] = [];
    if (summary.errors)
      failures.push(`${command}: ${summary.errors} failed samples`);
    if (summary.p95Ms !== null && summary.p95Ms > p95LimitMs)
      failures.push(
        `${command}: p95 ${summary.p95Ms.toFixed(1)}ms exceeds ${p95LimitMs}ms`,
      );
    return failures;
  });
}
