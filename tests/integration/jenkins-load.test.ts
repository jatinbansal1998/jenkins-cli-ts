import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readdir } from "node:fs/promises";
import {
  integrationCliExecutable,
  invokeCli,
  jenkinsUrl,
  parseJson,
  withCliHome,
} from "./jenkins/harness";
import {
  loadFailures,
  loadSettings,
  summarizeSamples,
  type Sample,
} from "./jenkins/load";

describe.skipIf(process.env.JENKINS_INTEGRATION_LOAD !== "1")(
  "compiled CLI load against disposable Jenkins",
  () => {
    test(
      "keeps read output and shared caches correct under concurrent processes",
      async () => {
        const settings = loadSettings(process.env);
        if (
          !jenkinsUrl ||
          !process.env.JENKINS_INTEGRATION_RUNTIME_DIR ||
          !process.env.JENKINS_INTEGRATION_ARTIFACT_DIR
        ) {
          throw new Error(
            "Run bun run test:load:jenkins to provision a disposable controller.",
          );
        }
        const url = new URL(jenkinsUrl);
        if (url.hostname !== "127.0.0.1" || url.protocol !== "http:")
          throw new Error(
            "Load tests only support the disposable loopback controller.",
          );
        const samples: Sample[] = [];
        const resources: { at: string; cpu: string; memory: string }[] = [];
        const scenarios = [
          { name: "list-refresh", args: ["list", "--refresh", "--json"] },
          { name: "list-cached", args: ["list", "--json"] },
          {
            name: "status",
            args: [
              "status",
              "--job-url",
              `${jenkinsUrl}/job/cli-network/`,
              "--json",
            ],
          },
          {
            name: "history",
            args: [
              "history",
              "--job-url",
              `${jenkinsUrl}/job/cli-network/`,
              "--json",
            ],
          },
          { name: "queue", args: ["queue", "--json"] },
          { name: "nodes", args: ["nodes", "--json"] },
        ];
        await withCliHome(async (home) => {
          const seed = await invokeCli(home, [
            "build",
            "--job-url",
            `${jenkinsUrl}/job/cli-network/`,
            "--without-params",
            "--watch",
            "--json",
          ]);
          expect(seed.exitCode, seed.output).toBe(0);
          expect(parseJson(seed)).toMatchObject({
            ok: true,
            data: { result: "SUCCESS" },
          });
          const baseline = new Map<string, unknown>();
          for (const scenario of scenarios) {
            const result = await invokeCli(home, scenario.args);
            expect(result.exitCode, result.output).toBe(0);
            const payload = parseJson(result);
            expect(payload).toMatchObject({ ok: true });
            baseline.set(scenario.name, payload);
          }
          const sampling = { active: true };
          const container = process.env.JENKINS_INTEGRATION_CONTAINER;
          const resourcePump = (async () => {
            if (!container) return;
            while (sampling.active) {
              const child = Bun.spawn({
                cmd: [
                  "docker",
                  "stats",
                  "--no-stream",
                  "--format",
                  "{{json .}}",
                  container,
                ],
                stdout: "pipe",
                stderr: "pipe",
              });
              const [exit, output] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
              ]);
              if (exit !== 0)
                throw new Error("Docker resource sampling failed.");
              const stats = JSON.parse(output) as {
                CPUPerc: string;
                MemUsage: string;
              };
              resources.push({
                at: new Date().toISOString(),
                cpu: stats.CPUPerc,
                memory: stats.MemUsage,
              });
              if (sampling.active) await Bun.sleep(1_000);
            }
          })();
          // Attach the rejection handler immediately while the workers run.
          const resourceResult = resourcePump.then(
            () => undefined,
            (error: unknown) => error,
          );
          const started = performance.now();
          const deadline = started + settings.durationSeconds * 1_000;
          let sequence = 0;
          let workers: PromiseSettledResult<void>[] = [];
          try {
            workers = await Promise.allSettled(
              Array.from({ length: settings.concurrency }, async () => {
                while (performance.now() < deadline) {
                  const scenario = scenarios[sequence++ % scenarios.length]!;
                  const start = performance.now();
                  // Audit the serial probes above. Exclude strace overhead from measured load.
                  const env = {
                    ...process.env,
                    HOME: home,
                    XDG_CONFIG_HOME: join(home, ".config"),
                    XDG_CACHE_HOME: join(home, ".cache"),
                    JENKINS_URL: jenkinsUrl,
                    JENKINS_USER: process.env.JENKINS_INTEGRATION_USER,
                    JENKINS_API_TOKEN: process.env.JENKINS_INTEGRATION_TOKEN,
                    JENKINS_ANALYTICS_DISABLED: "true",
                    JENKINS_ERROR_REPORTING_DISABLED: "true",
                    NO_COLOR: "1",
                  };
                  const child = Bun.spawn({
                    cmd: [
                      integrationCliExecutable,
                      ...scenario.args,
                      "--non-interactive",
                      "--no-banner",
                    ],
                    env,
                    stdout: "pipe",
                    stderr: "pipe",
                    timeout: settings.timeoutMs,
                    killSignal: "SIGKILL",
                  });
                  const [exitCode, stdout, stderr] = await Promise.all([
                    child.exited,
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                  ]);
                  let error: string | undefined;
                  if (exitCode !== 0)
                    error = `exit ${exitCode}${child.signalCode ? `, signal ${child.signalCode}` : ""}`;
                  else if (stderr.trim()) error = "unexpected stderr";
                  else {
                    try {
                      if (
                        !isDeepStrictEqual(
                          JSON.parse(stdout),
                          baseline.get(scenario.name),
                        )
                      )
                        error = "response differs from serial baseline";
                    } catch {
                      error = "invalid JSON";
                    }
                  }
                  samples.push({
                    command: scenario.name,
                    durationMs: performance.now() - start,
                    ok: error === undefined,
                    ...(error ? { error } : {}),
                    cpuTimeMs:
                      Number(child.resourceUsage()?.cpuTime.total ?? 0) / 1_000,
                    maxRssBytes: child.resourceUsage()?.maxRSS,
                  });
                }
              }),
            );
          } finally {
            sampling.active = false;
          }
          const elapsedMs = performance.now() - started;
          const resourceError = await resourceResult;
          const failures = loadFailures(
            samples,
            scenarios.map((scenario) => scenario.name),
            settings.p95LimitMs,
          );
          if (resourceError) failures.push(String(resourceError));
          for (const worker of workers) {
            if (worker.status === "rejected")
              failures.push(`Load worker failed: ${String(worker.reason)}`);
          }
          const cacheRoot =
            process.platform === "darwin"
              ? join(home, "Library", "Caches", "jenkins-cli")
              : join(home, ".cache", "jenkins-cli");
          const cacheFiles = (await readdir(cacheRoot).catch(() => [])).filter(
            (name) => /^jobs-.*\.json$/.test(name),
          );
          if (cacheFiles.length !== 1)
            failures.push(
              `Expected one controller cache, found ${cacheFiles.length}`,
            );
          for (const name of cacheFiles) {
            try {
              const cache = await Bun.file(join(cacheRoot, name)).json();
              if (
                cache.jenkinsUrl !== jenkinsUrl ||
                !Array.isArray(cache.jobs) ||
                !cache.jobs.some(
                  (job: { name: string }) => job.name === "cli-network",
                )
              )
                failures.push("Shared job cache has invalid content");
            } catch {
              failures.push("Shared job cache is not valid JSON");
            }
          }
          const report = {
            schemaVersion: 1,
            settings,
            elapsedMs,
            commandsPerSecond: samples.length / (elapsedMs / 1_000),
            binarySha256: new Bun.CryptoHasher("sha256")
              .update(await Bun.file(integrationCliExecutable).arrayBuffer())
              .digest("hex"),
            platform: `${process.platform}-${process.arch}`,
            bunVersion: Bun.version,
            summary: summarizeSamples(samples),
            byCommand: Object.fromEntries(
              scenarios.map(({ name }) => [
                name,
                summarizeSamples(
                  samples.filter((sample) => sample.command === name),
                ),
              ]),
            ),
            resourceScope: container
              ? "Jenkins Docker container"
              : "unavailable for native Jenkins",
            resources,
            cacheFiles: cacheFiles.length,
            failures,
            samples,
          };
          const path = join(
            process.env.JENKINS_INTEGRATION_ARTIFACT_DIR!,
            "load.json",
          );
          await Bun.write(path, JSON.stringify(report, null, 2) + "\n");
          console.log(
            `Load report: ${path}\n${JSON.stringify(report.byCommand, null, 2)}`,
          );
          expect(failures, failures.join("\n")).toEqual([]);
        });
      },
      15 * 60_000,
    );
  },
);
