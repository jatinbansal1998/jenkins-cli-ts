import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  integrationEnabled,
  integrationCliExecutable,
  integrationRuntimeDir,
  invokeCli,
  invokeCliAndInterrupt,
  jenkinsUrl,
  parseJson,
  pollCli,
  runCli,
  runCliExpectFailure,
  observeInteractiveCli,
  stripTerminalCodes,
  waitForNewBuild,
  withCliHome,
} from "./jenkins/harness";

const keychainIntegrationRequired =
  process.env.REQUIRE_KEYCHAIN_INTEGRATION === "1";

/** Run git with a fixed synthetic identity; fails loudly on a non-zero exit. */
async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: [
      "git",
      "-c",
      "user.name=Jenkins CLI Integration",
      "-c",
      "user.email=integration@example.invalid",
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if ((await child.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}

describe.skipIf(!integrationEnabled)(
  "compiled CLI against real Jenkins",
  () => {
    test("uses a compiled CLI with the Credential Manager helper embedded", async () => {
      const binaryText = Buffer.from(
        await Bun.file(integrationCliExecutable).arrayBuffer(),
      ).toString("latin1");

      expect(binaryText).toContain("CredMan.CredentialManager");
      expect(binaryText).not.toContain('"scripts", "credman.ps1"');
    });

    test("covers discovery, authentication, nodes, and empty operational state", async () => {
      await withCliHome(async (home) => {
        const auth = await runCli(home, ["auth", "status"]);
        expect(auth.output).toContain("Authenticated:    Yes");
        expect(auth.output).toContain("Jenkins user:     integration-test");

        const list = parseJson(
          await runCli(home, ["list", "--refresh", "--json"]),
        );
        expect(list).toMatchObject({ ok: true, command: "list" });
        expect(list.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "cli-smoke" }),
            expect.objectContaining({ name: "cli-failure" }),
            expect.objectContaining({ name: "cli-no-params" }),
            expect.objectContaining({ name: "cli space job" }),
            expect.objectContaining({ name: "cli-always-queued" }),
            expect.objectContaining({ name: "cli-slow" }),
          ]),
        );

        const nodes = await runCli(home, ["nodes"]);
        expect(nodes.output).toContain("built-in");
        expect(nodes.output).toContain("offline-agent");
        expect(nodes.output).toMatch(/\d+\/\d+ executors busy/);
        const offlineNodes = await runCli(home, ["nodes", "--offline-only"]);
        expect(offlineNodes.output).toContain("offline-agent");
        expect(offlineNodes.output).not.toContain("built-in");

        expect((await runCli(home, ["queue"])).output).toContain(
          "queue is empty",
        );
        expect((await runCli(home, ["run"])).output).toContain(
          "no running builds",
        );

        const disabledPipelineUrl = `${jenkinsUrl}/job/cli-pipeline-disabled/`;
        const disabledStatus = parseJson(
          await runCli(home, [
            "status",
            "--job-url",
            disabledPipelineUrl,
            "--json",
          ]),
        );
        expect(disabledStatus).toMatchObject({
          ok: true,
          command: "status",
          data: {
            jobState: "DISABLED",
            build: null,
          },
        });
        expect(
          (await runCli(home, ["status", "--job-url", disabledPipelineUrl]))
            .output,
        ).toContain("Job state: DISABLED");
      });
    }, 30_000);

    test("keeps expanded JSON and JSONL contracts pure against real Jenkins", async () => {
      await withCliHome(async (home) => {
        const authStatus = parseJson(
          await runCli(home, ["auth", "status", "--json"]),
        );
        expect(authStatus).toMatchObject({
          ok: true,
          command: "auth status",
          data: { success: true, tokenPresent: true },
        });
        expect(
          parseJson(await runCli(home, ["auth", "list", "--json"])),
        ).toMatchObject({
          ok: true,
          command: "auth list",
          data: { profiles: [] },
        });
        expect(
          parseJson(await runCli(home, ["auth", "current", "--json"])),
        ).toMatchObject({
          ok: true,
          command: "auth current",
          data: { source: "Environment variables", tokenPresent: true },
        });

        const nodes = parseJson<{ data: { nodes: unknown[] } }>(
          await runCli(home, ["nodes", "--json"]),
        );
        expect(nodes.data.nodes.length).toBeGreaterThan(0);
        expect(
          parseJson(await runCli(home, ["queue", "--json"])),
        ).toMatchObject({ ok: true, command: "queue", data: [] });
        expect(parseJson(await runCli(home, ["run", "--json"]))).toMatchObject({
          ok: true,
          command: "run",
          data: [],
        });

        const build = parseJson<{
          data: { buildUrl: string; buildNumber: number; result: string };
        }>(
          await runCli(home, [
            "build",
            "--job-url",
            `${jenkinsUrl}/job/cli-structured/`,
            "--param",
            "MESSAGE=structured-output",
            "--watch",
            "--json",
          ]),
        );
        expect(build).toMatchObject({
          ok: true,
          command: "build",
          data: { result: "SUCCESS", queued: false },
        });

        const artifacts = parseJson<{ data: { artifacts: unknown[] } }>(
          await runCli(home, [
            "artifacts",
            "--build-url",
            build.data.buildUrl,
            "--json",
          ]),
        );
        expect(artifacts.data.artifacts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              relativePath: "structured-artifact.txt",
            }),
          ]),
        );

        const logs = await runCli(home, [
          "logs",
          "--build-url",
          build.data.buildUrl,
          "--no-follow",
          "--jsonl",
        ]);
        expect(logs.stderr).toBe("");
        const events = logs.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { type: string });
        expect(events.map((event) => event.type)).toEqual([
          "start",
          "chunk",
          "complete",
        ]);

        const queued = parseJson<{
          data: { queueUrl: string; queued: boolean };
        }>(
          await runCli(home, [
            "build",
            "--job-url",
            `${jenkinsUrl}/job/cli-structured-queued/`,
            "--without-params",
            "--json",
          ]),
        );
        expect(queued.data.queued).toBe(true);
        expect(
          parseJson(
            await runCli(home, [
              "cancel",
              "--queue-url",
              queued.data.queueUrl,
              "--json",
            ]),
          ),
        ).toMatchObject({
          ok: true,
          command: "cancel",
          data: { targetType: "queue", url: queued.data.queueUrl },
        });

        const failed = parseJson<{
          data: { result: string; buildNumber: number };
        }>(
          await runCliExpectFailure(home, [
            "build",
            "--job-url",
            `${jenkinsUrl}/job/cli-structured-failure/`,
            "--param",
            "REASON=structured-output",
            "--watch",
            "--json",
          ]),
        );
        expect(failed.data.result).toBe("FAILURE");
        expect(
          parseJson(
            await runCli(home, [
              "rerun",
              "--job-url",
              `${jenkinsUrl}/job/cli-structured-failure/`,
              "--json",
            ]),
          ),
        ).toMatchObject({
          ok: true,
          command: "rerun",
          data: {
            source: { buildNumber: failed.data.buildNumber },
            target: expect.objectContaining({ jobUrl: expect.any(String) }),
          },
        });

        const denied = await runCliExpectFailure(home, ["nodes", "--json"], {
          JENKINS_API_TOKEN: "invalid-token",
        });
        const deniedDocument = parseJson<{
          ok: boolean;
          error: { code: string };
        }>(denied);
        expect(deniedDocument.ok).toBe(false);
        expect(deniedDocument.error.code).toBe("JENKINS_AUTH_ERROR");
      });
    }, 90_000);

    test("fetches a missing job cache itself and refreshes a stale one in the background", async () => {
      await withCliHome(async (home) => {
        // No `list --refresh` first: a job-scoped command builds the cache.
        const params = parseJson(
          await runCli(home, ["params", "--job", "cli-smoke", "--json"]),
        );
        expect(params).toMatchObject({ ok: true, command: "params" });

        const cachePath = await findJobCachePath(home);
        const lockPath = `${cachePath}.refreshing`;
        const cache = JSON.parse(await Bun.file(cachePath).text()) as {
          fetchedAt: string;
          jobs: Array<{ name: string }>;
        };
        expect(cache.jobs.map((job) => job.name)).toContain("cli-failure");

        // Age the cache past its TTL and hide a job so the refresh is visible.
        const staleFetchedAt = "2020-01-01T00:00:00.000Z";
        await Bun.write(
          cachePath,
          JSON.stringify({
            ...cache,
            fetchedAt: staleFetchedAt,
            jobs: cache.jobs.filter((job) => job.name !== "cli-failure"),
          }),
        );

        const stale = await runCli(home, ["list", "--json"]);
        expect(stale.stderr).toContain("refreshing it in the background");
        const staleNames = (
          JSON.parse(stale.stdout) as { data: Array<{ name: string }> }
        ).data.map((job) => job.name);
        expect(staleNames).toContain("cli-smoke");
        expect(staleNames).not.toContain("cli-failure");

        // The detached worker completes after the command already returned.
        const deadline = Date.now() + 30_000;
        let refreshed = cache;
        while (Date.now() < deadline) {
          refreshed = JSON.parse(await Bun.file(cachePath).text());
          if (
            refreshed.fetchedAt !== staleFetchedAt &&
            !(await Bun.file(lockPath).exists())
          ) {
            break;
          }
          await Bun.sleep(250);
        }
        expect(refreshed.fetchedAt).not.toBe(staleFetchedAt);
        expect(refreshed.jobs.map((job) => job.name)).toContain("cli-failure");
        expect(await Bun.file(lockPath).exists()).toBe(false);

        const fresh = parseJson<{ data: Array<{ name: string }> }>(
          await runCli(home, ["list", "--json"]),
        );
        expect(fresh.data.map((job) => job.name)).toContain("cli-failure");
      });
    }, 90_000);

    test("uses positional job names through real Jenkins operations", async () => {
      await withCliHome(async (home) => {
        await runCli(home, ["list", "--refresh", "--json"]);

        const positionalParams = parseJson(
          await runCli(home, ["params", "cli-smoke", "--json"]),
        );
        const optionParams = parseJson(
          await runCli(home, ["params", "--job", "cli-smoke", "--json"]),
        );
        expect(positionalParams.data).toEqual(optionParams.data);

        const built = await runCli(home, [
          "build",
          "cli-smoke",
          "--param",
          "MESSAGE=positional-message",
          "--param",
          "NOTES=positional-notes",
          "--param",
          "ENABLED=no",
          "--param",
          "MODE=safe",
          "--param",
          "SECRET=positional-secret",
          "--watch",
        ]);
        expect(built.output).toContain("SUCCESS");

        const status = parseJson(
          await runCli(home, ["status", "cli-smoke", "--json"]),
        );
        expect(status).toMatchObject({
          ok: true,
          command: "status",
          data: { build: { result: "SUCCESS", building: false } },
        });

        const history = parseJson(
          await runCli(home, ["history", "cli-smoke", "--json"]),
        );
        expect(history).toMatchObject({
          ok: true,
          command: "history",
        });
        expect(history.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ result: "SUCCESS" }),
          ]),
        );

        const waited = parseJson(
          await runCli(home, [
            "wait",
            "cli-smoke",
            "--timeout",
            "30s",
            "--json",
          ]),
        );
        expect(waited).toMatchObject({
          ok: true,
          command: "wait",
          data: { result: "SUCCESS" },
        });

        expect(
          (await runCli(home, ["logs", "cli-smoke", "--no-follow"])).output,
        ).toContain("cli-integration:positional-message");
        expect(
          (await runCli(home, ["artifacts", "cli-smoke"])).output,
        ).toContain("artifact.txt");

        const failed = await runCliExpectFailure(home, [
          "build",
          "cli-failure",
          "--param",
          "REASON=positional-target",
          "--watch",
        ]);
        expect(failed.output).toContain("FAILURE");
        const beforeRerun = parseJson<{
          data: Array<{ number: number }>;
        }>(await runCli(home, ["history", "cli-failure", "--json"])).data[0]!
          .number;

        expect((await runCli(home, ["rerun", "cli-failure"])).output).toContain(
          "from failed build #",
        );
        await waitForNewBuild(
          home,
          `${jenkinsUrl}/job/cli-failure/`,
          beforeRerun,
        );
        const rerunWait = parseJson(
          await runCliExpectFailure(home, [
            "wait",
            "cli-failure",
            "--timeout",
            "30s",
            "--json",
          ]),
        );
        expect(rerunWait).toMatchObject({
          ok: true,
          command: "wait",
          data: { result: "FAILURE" },
        });

        await runCli(home, ["build", "cli-always-queued", "--without-params"]);
        expect(
          (await runCli(home, ["cancel", "cli-always-queued"])).output,
        ).toContain("Cancelled queue item");
      });
    }, 180_000);

    test("creates items from config.xml and by copy, then reads config back", async () => {
      await withCliHome(async (home) => {
        const suffix = Date.now().toString(36);

        const jobName = `cli-created-${suffix}`;
        const configPath = join(home, "created-config.xml");
        await Bun.write(
          configPath,
          [
            "<?xml version='1.1' encoding='UTF-8'?>",
            "<project>",
            "  <builders>",
            "    <hudson.tasks.Shell>",
            "      <command>echo created-by-cli</command>",
            "    </hudson.tasks.Shell>",
            "  </builders>",
            "</project>",
            "",
          ].join("\n"),
        );
        const created = parseJson<{ data: { name: string; url: string } }>(
          await runCli(home, [
            "create",
            jobName,
            "--config",
            configPath,
            "--json",
          ]),
        );
        expect(created).toMatchObject({
          ok: true,
          command: "create",
          data: { name: jobName, url: `${jenkinsUrl}/job/${jobName}/` },
        });

        const createdConfig = await runCli(home, [
          "config",
          "--job-url",
          created.data.url,
        ]);
        expect(createdConfig.output).toContain("echo created-by-cli");

        const built = await runCli(home, [
          "build",
          "--job-url",
          created.data.url,
          "--without-params",
          "--watch",
        ]);
        expect(built.output).toContain("SUCCESS");
        expect(
          (
            await runCli(home, [
              "logs",
              "--job-url",
              created.data.url,
              "--no-follow",
            ])
          ).output,
        ).toContain("created-by-cli");

        const copyName = `cli-copied-${suffix}`;
        const copied = parseJson<{ data: { url: string } }>(
          await runCli(home, [
            "create",
            copyName,
            "--copy-from",
            "cli-exact",
            "--json",
          ]),
        );
        const copiedConfig = await runCli(home, [
          "config",
          "--job-url",
          copied.data.url,
        ]);
        expect(copiedConfig.output).toContain("exact-build");

        const nestedName = `cli-copied-nested-${suffix}`;
        const nested = parseJson<{ data: { url: string } }>(
          await runCli(home, [
            "create",
            nestedName,
            "--copy-from",
            `${jenkinsUrl}/job/team/job/nested%20smoke/`,
            "--folder-url",
            `${jenkinsUrl}/job/team/`,
            "--json",
          ]),
        );
        expect(nested.data.url).toBe(
          `${jenkinsUrl}/job/team/job/${nestedName}/`,
        );
        expect(
          (await runCli(home, ["config", "--job-url", nested.data.url])).output,
        ).toContain("<project>");

        const duplicate = await runCliExpectFailure(home, [
          "create",
          jobName,
          "--config",
          configPath,
          "--json",
        ]);
        expect(duplicate.output).toContain("HTTP 400");
      });
    }, 180_000);

    test("targets one immutable build across every build-scoped command", async () => {
      await withCliHome(async (home) => {
        const exactUrl = `${jenkinsUrl}/job/cli-exact/`;
        const first = parseJson<{
          data: { buildNumber: number; buildUrl: string };
        }>(
          await runCli(home, [
            "build",
            "--job-url",
            exactUrl,
            "--param",
            "MESSAGE=exact-first",
            "--watch",
            "--json",
          ]),
        );
        const second = parseJson<{
          data: { buildNumber: number; buildUrl: string };
        }>(
          await runCli(home, [
            "build",
            "--job-url",
            exactUrl,
            "--param",
            "MESSAGE=exact-second",
            "--watch",
            "--json",
          ]),
        );
        expect(second.data.buildNumber).toBeGreaterThan(first.data.buildNumber);
        await runCli(home, ["list", "--refresh", "--json"]);

        for (const args of [
          [
            "status",
            "--job",
            "cli-exact",
            "--build",
            String(first.data.buildNumber),
            "--json",
          ],
          [
            "status",
            "--job-url",
            exactUrl,
            "--build",
            String(first.data.buildNumber),
            "--json",
          ],
          ["status", "--build-url", first.data.buildUrl, "--json"],
        ]) {
          expect(parseJson(await runCli(home, args))).toMatchObject({
            ok: true,
            command: "status",
            data: {
              jobState: "ENABLED",
              build: {
                number: first.data.buildNumber,
                url: first.data.buildUrl,
                triggeredBy: "integration-test",
              },
            },
          });
        }

        const humanStatus = await runCli(home, [
          "status",
          "--job-url",
          exactUrl,
          "--build",
          String(first.data.buildNumber),
        ]);
        const plainStatus = stripTerminalCodes(humanStatus.output);
        expect(plainStatus).toMatch(/Started: \d{1,2} [A-Z][a-z]+ \d{4},/);
        expect(plainStatus).toContain("By: integration-test");
        expect(plainStatus).toContain("Job state: ENABLED");

        expect(
          parseJson(
            await runCli(home, [
              "wait",
              "--job-url",
              exactUrl,
              "--build",
              String(first.data.buildNumber),
              "--json",
            ]),
          ),
        ).toMatchObject({
          ok: true,
          command: "wait",
          data: {
            build: {
              number: first.data.buildNumber,
              triggeredBy: "integration-test",
            },
          },
        });

        const logs = await runCli(home, [
          "logs",
          "--job-url",
          exactUrl,
          "--build",
          String(first.data.buildNumber),
          "--no-follow",
        ]);
        expect(logs.output).toContain("exact-build:exact-first");
        expect(logs.output).not.toContain("exact-build:exact-second");

        expect(
          parseJson(
            await runCli(home, [
              "artifacts",
              "--job-url",
              exactUrl,
              "--build",
              String(first.data.buildNumber),
              "--json",
            ]),
          ),
        ).toMatchObject({
          ok: true,
          command: "artifacts",
          data: { buildNumber: first.data.buildNumber },
        });

        const rerun = parseJson<{
          data: { source: { buildNumber: number } };
        }>(
          await runCli(home, [
            "rerun",
            "--job-url",
            exactUrl,
            "--build",
            String(first.data.buildNumber),
            "--json",
          ]),
        );
        expect(rerun.data.source.buildNumber).toBe(first.data.buildNumber);
        const rerunBuildUrl = await waitForNewBuild(
          home,
          exactUrl,
          second.data.buildNumber,
        );
        await runCli(home, [
          "wait",
          "--build-url",
          rerunBuildUrl,
          "--timeout",
          "30s",
        ]);
        expect(
          (
            await runCli(home, [
              "logs",
              "--build-url",
              rerunBuildUrl,
              "--no-follow",
            ])
          ).output,
        ).toContain("exact-build:exact-first");

        const nestedUrl = `${jenkinsUrl}/job/team/job/nested%20smoke/`;
        await runCli(home, [
          "build",
          "--job-url",
          nestedUrl,
          "--without-params",
          "--watch",
        ]);
        const nestedNumber = parseJson<{
          data: Array<{ number: number }>;
        }>(await runCli(home, ["history", "--job-url", nestedUrl, "--json"]))
          .data[0]!.number;
        expect(
          parseJson(
            await runCli(home, [
              "status",
              "--job-url",
              nestedUrl,
              "--build",
              String(nestedNumber),
              "--json",
            ]),
          ),
        ).toMatchObject({
          ok: true,
          data: { build: { number: nestedNumber } },
        });

        const missing = parseJson<{
          error: { code: string };
        }>(
          await runCliExpectFailure(home, [
            "status",
            "--job-url",
            exactUrl,
            "--build",
            "999999",
            "--json",
          ]),
        );
        expect(missing.error.code).toBe("BUILD_NOT_FOUND");

        const crossController = parseJson<{
          error: { code: string };
        }>(
          await runCliExpectFailure(home, [
            "status",
            "--build-url",
            "http://127.0.0.1:1/job/cli-smoke/1/",
            "--json",
          ]),
        );
        expect(crossController.error.code).toBe("CROSS_CONTROLLER_URL");

        const readerDenied = parseJson<{
          error: { code: string };
        }>(
          await runCliExpectFailure(
            home,
            [
              "rerun",
              "--job-url",
              exactUrl,
              "--build",
              String(first.data.buildNumber),
              "--json",
            ],
            {
              JENKINS_USER:
                process.env.JENKINS_INTEGRATION_READER_USER ??
                "integration-reader",
              JENKINS_API_TOKEN:
                process.env.JENKINS_INTEGRATION_READER_TOKEN ?? "",
            },
          ),
        );
        expect(readerDenied.error.code).toBe("JENKINS_AUTH_ERROR");

        const slowUrl = `${jenkinsUrl}/job/cli-slow/`;
        await runCli(home, ["build", "--job-url", slowUrl, "--without-params"]);
        const running = await pollCli(home, ["run", "--json"], (result) => {
          const payload = parseJson<{
            data: Array<{ url: string; number: number }>;
          }>(result);
          return payload.data.some((build) => build.url.startsWith(slowUrl));
        });
        const slowBuild = parseJson<{
          data: Array<{ url: string; number: number }>;
        }>(running).data.find((build) => build.url.startsWith(slowUrl))!;
        expect(
          parseJson(
            await runCli(home, [
              "cancel",
              "--job-url",
              slowUrl,
              "--build",
              String(slowBuild.number),
              "--json",
            ]),
          ),
        ).toMatchObject({
          ok: true,
          command: "cancel",
          data: {
            targetType: "build",
            url: slowBuild.url,
            buildNumber: slowBuild.number,
          },
        });
      });
    }, 180_000);

    test("inspects published freestyle and Pipeline test results", async () => {
      await withCliHome(async (home) => {
        const mixedJobUrl = `${jenkinsUrl}/job/cli-test-results/`;
        const mixedRun = await invokeCli(home, [
          "build",
          "--job-url",
          mixedJobUrl,
          "--without-params",
          "--watch",
          "--json",
        ]);
        expect(mixedRun.exitCode, mixedRun.output).toBe(1);
        const mixedBuild = parseJson<{
          data: { buildNumber: number; buildUrl: string; result: string };
        }>(mixedRun);
        expect(mixedBuild.data.result).toBe("UNSTABLE");

        const summary = parseJson<{
          data: {
            build: { number: number; url: string; result: string };
            summary: {
              total: number;
              passed: number;
              failed: number;
              skipped: number;
              durationMs: number;
            };
            failures?: unknown[];
            reportUrl: string;
          };
        }>(await runCli(home, ["tests", "--job-url", mixedJobUrl, "--json"]));
        expect(summary).toMatchObject({
          ok: true,
          command: "tests",
          data: {
            build: {
              number: mixedBuild.data.buildNumber,
              url: mixedBuild.data.buildUrl,
              result: "UNSTABLE",
            },
            summary: { total: 3, passed: 1, failed: 1, skipped: 1 },
          },
        });
        expect(summary.data.summary.durationMs).toBeGreaterThan(0);
        expect(summary.data.failures).toBeUndefined();
        expect(summary.data.reportUrl).toBe(
          `${mixedBuild.data.buildUrl}testReport/`,
        );

        const failures = parseJson<{
          data: {
            failures: Array<{
              suite: string;
              className: string;
              name: string;
              message: string;
              stackTrace: string;
            }>;
          };
        }>(
          await runCli(home, [
            "tests",
            "--build-url",
            mixedBuild.data.buildUrl,
            "--failed",
            "--json",
          ]),
        );
        expect(failures.data.failures).toEqual([
          expect.objectContaining({
            suite: "checkout",
            className: "CartTest",
            name: "rejects expired card é",
            message: "expected true but got false",
            stackTrace: expect.stringContaining(
              "at CartTest.rejectsExpiredCard(CartTest.java:42)",
            ),
          }),
        ]);

        const human = await runCli(home, [
          "tests",
          "--build-url",
          mixedBuild.data.buildUrl,
          "--failed",
        ]);
        expect(human.output).toContain("Build: #");
        expect(human.output).toContain(
          "3 total | 1 passed | 1 failed | 1 skipped",
        );
        expect(human.output).toContain("rejects expired card é");
        expect(human.output).toContain("expected true but got false");
        expect(human.output).toContain(
          "at CartTest.rejectsExpiredCard(CartTest.java:42)",
        );

        const successfulJobUrl = `${jenkinsUrl}/job/cli-test-results-success/`;
        const successfulBuild = parseJson<{
          data: { buildUrl: string };
        }>(
          await runCli(home, [
            "build",
            "--job-url",
            successfulJobUrl,
            "--without-params",
            "--watch",
            "--json",
          ]),
        );
        expect(
          parseJson(
            await runCli(home, [
              "tests",
              "--build-url",
              successfulBuild.data.buildUrl,
              "--failed",
              "--json",
            ]),
          ),
        ).toMatchObject({
          ok: true,
          data: {
            summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
            failures: [],
          },
        });

        const pipelineJobUrl = `${jenkinsUrl}/job/cli-pipeline-test-results/`;
        const pipelineBuild = parseJson<{
          data: { buildUrl: string };
        }>(
          await runCli(home, [
            "build",
            "--job-url",
            pipelineJobUrl,
            "--without-params",
            "--watch",
            "--json",
          ]),
        );
        expect(
          parseJson(
            await runCli(home, [
              "tests",
              "--build-url",
              pipelineBuild.data.buildUrl,
              "--json",
            ]),
          ),
        ).toMatchObject({
          ok: true,
          data: {
            summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
          },
        });

        const matrixJobUrl = `${jenkinsUrl}/job/cli-matrix-test-results/`;
        const matrixRun = await invokeCli(home, [
          "build",
          "--job-url",
          matrixJobUrl,
          "--without-params",
          "--watch",
          "--json",
        ]);
        expect(matrixRun.exitCode, matrixRun.output).toBe(1);
        const matrixBuild = parseJson<{
          data: { buildUrl: string; result: string };
        }>(matrixRun);
        expect(matrixBuild.data.result).toBe("UNSTABLE");
        expect(
          parseJson(
            await runCli(home, [
              "tests",
              "--build-url",
              matrixBuild.data.buildUrl,
              "--failed",
              "--json",
            ]),
          ),
        ).toMatchObject({
          ok: true,
          data: {
            summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
            failures: [
              expect.objectContaining({
                suite: "matrix",
                className: "MatrixTest",
                name: "fails on linux",
                message: "matrix expected true",
              }),
            ],
          },
        });

        const noReportJobUrl = `${jenkinsUrl}/job/cli-no-params/`;
        const noReportBuild = parseJson<{
          data: { buildUrl: string };
        }>(
          await runCli(home, [
            "build",
            "--job-url",
            noReportJobUrl,
            "--without-params",
            "--watch",
            "--json",
          ]),
        );
        expect(
          parseJson(
            await runCliExpectFailure(home, [
              "tests",
              "--build-url",
              noReportBuild.data.buildUrl,
              "--json",
            ]),
          ),
        ).toMatchObject({
          ok: false,
          error: { code: "TEST_REPORT_NOT_FOUND" },
        });

        expect(
          parseJson(
            await runCli(
              home,
              ["tests", "--build-url", successfulBuild.data.buildUrl, "--json"],
              {
                JENKINS_USER:
                  process.env.JENKINS_INTEGRATION_READER_USER ??
                  "integration-reader",
                JENKINS_API_TOKEN:
                  process.env.JENKINS_INTEGRATION_READER_TOKEN ?? "",
              },
            ),
          ),
        ).toMatchObject({
          ok: true,
          data: { summary: { total: 1, passed: 1 } },
        });
      });
    }, 180_000);

    test("validates typed parameters and preserves complex values through artifacts", async () => {
      await withCliHome(async (home) => {
        const artifactDir = join(home, "artifacts");
        const jobUrl = `${jenkinsUrl}/job/cli-smoke/`;

        const params = parseJson(
          await runCli(home, ["params", "--job-url", jobUrl, "--json"]),
        );
        expect(params).toMatchObject({
          ok: true,
          command: "params",
          data: [
            { name: "MESSAGE", type: "string", sensitive: false },
            { name: "NOTES", type: "text", sensitive: false },
            { name: "ENABLED", type: "boolean", sensitive: false },
            {
              name: "MODE",
              type: "choice",
              choices: ["safe", "fast"],
              sensitive: false,
            },
            { name: "SECRET", type: "password", sensitive: true },
          ],
        });
        expect(JSON.stringify(params)).not.toContain("default-secret");

        const message = `quotes ' " unicode 雪 & equals=a=b`;
        const notes = "first line\nsecond line";
        const secret = "integration-secret-value";
        const build = await runCli(home, [
          "build",
          "--job-url",
          jobUrl,
          "--param",
          `MESSAGE=${message}`,
          "--param",
          `NOTES=${notes}`,
          "--param",
          "ENABLED=yes",
          "--param",
          "MODE=fast",
          "--param",
          `SECRET=${secret}`,
          "--watch",
        ]);
        expect(build.output).toMatch(/Build (?:queued|started)/);
        expect(build.output).toContain("SUCCESS");
        expect(build.output).not.toContain(secret);

        const status = parseJson(
          await runCli(home, ["status", "--job-url", jobUrl, "--json"]),
        );
        expect(status).toMatchObject({
          ok: true,
          command: "status",
          data: { build: { result: "SUCCESS", building: false } },
        });

        const logs = await runCli(home, [
          "logs",
          "--job-url",
          jobUrl,
          "--no-follow",
        ]);
        expect(logs.output).toContain(`cli-integration:${message}`);

        const artifacts = await runCli(home, [
          "artifacts",
          "--job-url",
          jobUrl,
          "--download",
          "--dest",
          artifactDir,
        ]);
        expect(artifacts.output).toContain("Downloaded artifact.txt");
        expect(artifacts.output).toContain("Downloaded reports/values.txt");
        expect(await Bun.file(join(artifactDir, "artifact.txt")).text()).toBe(
          "root-artifact\n",
        );
        expect(
          await Bun.file(join(artifactDir, "reports", "values.txt")).text(),
        ).toBe(
          `message=${message}\nnotes=${notes}\nenabled=true\nmode=fast\nsecret-length=${secret.length}\n`,
        );

        const collision = await runCli(home, [
          "artifacts",
          "--job-url",
          jobUrl,
          "--download",
          "--dest",
          artifactDir,
        ]);
        expect(collision.output).toContain("already exists");
        expect(collision.output).toContain("Downloaded 0 artifacts");
        await runCli(home, [
          "artifacts",
          "--job-url",
          jobUrl,
          "--artifact",
          "reports/values.txt",
          "--dest",
          artifactDir,
          "--force",
        ]);
      });
    }, 120_000);

    test("rejects invalid choices before triggering Jenkins and rejects bad auth", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-smoke/`;
        const before = parseJson(
          await runCli(home, ["history", "--job-url", jobUrl, "--json"]),
        ).data as Array<Record<string, unknown>>;
        const invalid = await runCliExpectFailure(home, [
          "build",
          "--job-url",
          jobUrl,
          "--param",
          "MODE=turbo",
        ]);
        expect(invalid.output).toContain(
          'Invalid value for choice parameter "MODE"',
        );
        const after = parseJson(
          await runCli(home, ["history", "--job-url", jobUrl, "--json"]),
        ).data as Array<Record<string, unknown>>;
        expect(after).toHaveLength(before.length);

        const badToken = "token-that-must-never-be-printed";
        const denied = await runCliExpectFailure(
          home,
          ["list", "--refresh", "--json"],
          { JENKINS_API_TOKEN: badToken },
        );
        expect(JSON.parse(denied.stdout)).toMatchObject({
          ok: false,
          error: { code: "JENKINS_AUTH_ERROR" },
        });
        expect(denied.output).not.toContain(badToken);
      });
    }, 30_000);

    test("reports failures, logs them, and reruns the last failed build", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-failure/`;
        const failed = await runCliExpectFailure(home, [
          "build",
          "--job-url",
          jobUrl,
          "--param",
          "REASON=live-regression",
          "--watch",
        ]);
        expect(failed.output).toContain("FAILURE");

        const history = parseJson(
          await runCli(home, ["history", "--job-url", jobUrl, "--json"]),
        );
        expect(history).toMatchObject({ ok: true, command: "history" });
        expect(history.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ result: "FAILURE", building: false }),
          ]),
        );
        expect(
          (await runCli(home, ["logs", "--job-url", jobUrl, "--no-follow"]))
            .output,
        ).toContain("deliberate-failure:live-regression");

        const beforeNumber = Number(
          (history.data as Array<{ number: number }>)[0]?.number,
        );
        const rerun = await runCli(home, ["rerun", "--job-url", jobUrl]);
        expect(rerun.output).toContain("from failed build #");
        const rerunBuildUrl = await waitForNewBuild(home, jobUrl, beforeNumber);
        const waited = await runCliExpectFailure(home, [
          "wait",
          "--build-url",
          rerunBuildUrl,
          "--interval",
          "250ms",
          "--timeout",
          "30s",
          "--json",
        ]);
        const waitPayload = JSON.parse(waited.stdout) as Record<
          string,
          unknown
        >;
        expect(waitPayload).toMatchObject({
          ok: true,
          command: "wait",
          data: {
            result: "FAILURE",
            build: { result: "FAILURE", building: false },
          },
        });
      });
    }, 90_000);

    test("handles non-parameterized and URL-encoded job names", async () => {
      await withCliHome(async (home) => {
        for (const name of ["cli-no-params", "cli space job"]) {
          const jobUrl = `${jenkinsUrl}/job/${encodeURIComponent(name)}/`;
          const build = await runCli(home, [
            "build",
            "--job-url",
            jobUrl,
            "--without-params",
            "--watch",
          ]);
          expect(build.output).toContain("SUCCESS");
          expect(
            (await runCli(home, ["status", "--job-url", jobUrl, "--json"]))
              .stdout,
          ).toContain('"result":"SUCCESS"');
        }
      });
    }, 90_000);

    test("observes and cancels queued and running work", async () => {
      await withCliHome(async (home) => {
        const queuedJobUrl = `${jenkinsUrl}/job/cli-always-queued/`;
        await runCli(home, [
          "build",
          "--job-url",
          queuedJobUrl,
          "--without-params",
        ]);
        const queueOutput = await pollCli(
          home,
          ["queue", "--job", "cli-always-queued"],
          (result) => result.output.includes("cli-always-queued"),
        );
        expect(queueOutput.output).toContain("stuck");
        expect(queueOutput.output).toContain(
          "integration-agent-that-does-not-exist",
        );
        const queueId = queueOutput.output.match(
          /^\s*(\d+)\s+cli-always-queued/m,
        )?.[1];
        expect(queueId).toBeDefined();
        await runCli(home, [
          "cancel",
          "--queue-url",
          `${jenkinsUrl}/queue/item/${queueId}/`,
        ]);
        const emptyQueue = await pollCli(
          home,
          ["queue", "--job", "cli-always-queued"],
          (result) => result.output.includes("No queued items match"),
        );
        expect(emptyQueue.output).toContain("No queued items match");

        const slowJobUrl = `${jenkinsUrl}/job/cli-slow/`;
        await runCli(home, [
          "build",
          "--job-url",
          slowJobUrl,
          "--without-params",
        ]);
        const running = await pollCli(home, ["run"], (result) =>
          result.output.includes("cli-slow #"),
        );
        const buildUrl = running.output.match(
          /(http:\/\/[^\s]+\/job\/cli-slow\/\d+\/)/,
        )?.[1];
        expect(buildUrl).toBeDefined();
        await runCli(home, ["cancel", "--build-url", buildUrl!]);
        const status = await pollCli(
          home,
          ["status", "--job-url", slowJobUrl, "--json"],
          (result) => result.stdout.includes('"building":false'),
        );
        expect(JSON.parse(status.stdout)).toMatchObject({
          data: { build: { result: "ABORTED", building: false } },
        });
      });
    }, 90_000);

    test("persists and switches multiple live Jenkins profiles", async () => {
      await withCliHome(async (home) => {
        const withoutCredentialEnv = {
          JENKINS_URL: undefined,
          JENKINS_USER: undefined,
          JENKINS_API_TOKEN: undefined,
          JENKINS_BRANCH_PARAM: undefined,
        };
        const adminToken = process.env.JENKINS_INTEGRATION_TOKEN ?? "";
        const readerUser =
          process.env.JENKINS_INTEGRATION_READER_USER ?? "integration-reader";
        const readerToken = process.env.JENKINS_INTEGRATION_READER_TOKEN ?? "";

        const adminLogin = await runCli(
          home,
          [
            "auth",
            "login",
            "--profile",
            "admin",
            "--url",
            jenkinsUrl!,
            "--user",
            "integration-test",
            "--token",
            adminToken,
            "--no-keychain",
          ],
          withoutCredentialEnv,
        );
        expect(adminLogin.output).not.toContain(adminToken);
        expect(adminLogin.output).not.toContain("export");

        const readerLogin = await runCli(
          home,
          [
            "auth",
            "login",
            "--profile",
            "reader",
            "--url",
            jenkinsUrl!,
            "--user",
            readerUser,
            "--token",
            readerToken,
            "--no-keychain",
          ],
          withoutCredentialEnv,
        );
        expect(readerLogin.output).not.toContain(readerToken);
        expect(readerLogin.output).not.toContain("export");

        const profiles = await runCli(
          home,
          ["auth", "list"],
          withoutCredentialEnv,
        );
        expect(profiles.output).toContain("admin (default)");
        expect(profiles.output).toContain("reader");
        expect(profiles.output).toContain("plaintext");

        const readerStatus = await runCli(
          home,
          ["auth", "status", "--profile", "reader"],
          withoutCredentialEnv,
        );
        expect(readerStatus.output).toContain("Authenticated:    Yes");
        expect(readerStatus.output).toContain(
          "Jenkins user:     integration-reader",
        );
        const readerList = parseJson<{
          data: Array<{ name: string }>;
        }>(
          await runCli(
            home,
            ["list", "--refresh", "--json", "--profile", "reader"],
            withoutCredentialEnv,
          ),
        );
        expect(readerList.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "cli-smoke" }),
          ]),
        );
        const denied = await runCliExpectFailure(
          home,
          [
            "build",
            "--job",
            "cli-no-params",
            "--without-params",
            "--profile",
            "reader",
          ],
          withoutCredentialEnv,
        );
        expect(denied.output).toContain(
          "Jenkins returned HTTP 403 while trying to trigger build:",
        );
        expect(denied.output).not.toContain(readerToken);

        await runCli(home, ["auth", "use", "reader"], withoutCredentialEnv);
        expect(
          (await runCli(home, ["auth", "current"], withoutCredentialEnv))
            .output,
        ).toContain("Profile:          reader");
        await runCli(
          home,
          ["auth", "rename", "reader", "observer"],
          withoutCredentialEnv,
        );
        const renamed = await runCli(
          home,
          ["auth", "status", "--profile", "observer"],
          withoutCredentialEnv,
        );
        expect(renamed.output).toContain("Authenticated:    Yes");

        await runCli(home, ["auth", "use", "admin"], withoutCredentialEnv);
        const adminStatus = await runCli(
          home,
          ["auth", "status"],
          withoutCredentialEnv,
        );
        expect(adminStatus.output).toContain(
          "Jenkins user:     integration-test",
        );
      });
    }, 60_000);

    test.skipIf(!keychainIntegrationRequired || process.platform === "win32")(
      "stores and resolves a real Jenkins token through the OS keychain",
      async () => {
        await withCliHome(async (home) => {
          const profile = "default";
          const token = process.env.JENKINS_INTEGRATION_TOKEN ?? "";
          expect(token).not.toBe("");
          const withoutCredentialEnv = {
            JENKINS_URL: undefined,
            JENKINS_USER: undefined,
            JENKINS_API_TOKEN: undefined,
            TS_KEYRING_BACKEND: undefined,
          };
          const login = await runCli(
            home,
            [
              "auth",
              "login",
              "--profile",
              profile,
              "--url",
              jenkinsUrl ?? "",
              "--user",
              "integration-test",
              "--token",
              token,
            ],
            withoutCredentialEnv,
          );
          expect(login.exitCode, login.output).toBe(0);
          expect(login.output).toContain(`Saved profile "${profile}"`);
          expect(login.output).toContain("API token stored securely");
          expect(login.output).not.toContain(token);

          const config = (await Bun.file(
            join(home, ".config", "jenkins-cli", "jenkins-cli-config.json"),
          ).json()) as {
            profiles: Record<
              string,
              { jenkinsApiToken: string; tokenStorage?: string }
            >;
          };
          expect(config.profiles[profile]).toMatchObject({
            jenkinsApiToken: "@keychain",
            tokenStorage: "keychain",
          });

          const status = await runCli(
            home,
            ["auth", "status", "--profile", profile],
            withoutCredentialEnv,
          );
          expect(status.output).toContain("Authenticated:    Yes");
          expect(status.output).toContain("Jenkins user:     integration-test");
          expect(status.output).not.toContain(token);

          const jobs = parseJson<{ data: Array<{ name: string }> }>(
            await runCli(
              home,
              ["list", "--refresh", "--json", "--profile", profile],
              withoutCredentialEnv,
            ),
          );
          expect(jobs.data).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: "cli-smoke" }),
            ]),
          );

          await runCli(
            home,
            ["auth", "logout", "--profile", profile],
            withoutCredentialEnv,
          );
        });
      },
      90_000,
    );

    test("discovers nested jobs and preserves branch parameters through reruns", async () => {
      await withCliHome(async (home) => {
        const list = parseJson<{
          data: Array<{ name: string; fullName?: string; url: string }>;
        }>(
          await runCli(home, [
            "list",
            "--refresh",
            "--json",
            "--folder-depth",
            "2",
          ]),
        );
        expect(list.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "nested smoke",
              fullName: "team/nested smoke",
            }),
          ]),
        );

        const nested = await runCli(home, [
          "build",
          "--job",
          "team/nested smoke",
          "--without-params",
          "--watch",
          "--folder-depth",
          "2",
        ]);
        expect(nested.output).toContain("SUCCESS");

        const branch = `feature/integration-${Date.now()}`;
        const branchBuild = await runCliExpectFailure(home, [
          "build",
          "--job",
          "cli-branch",
          "--branch",
          branch,
          "--param",
          "EXTRA=preserved",
          "--watch",
          "--folder-depth",
          "2",
        ]);
        expect(branchBuild.output).toContain("FAILURE");

        const branchJobUrl = `${jenkinsUrl}/job/cli-branch/`;
        const history = parseJson<{
          data: Array<{
            number: number;
            branch?: string;
            parameters?: Array<{ name: string; value: string }>;
          }>;
        }>(
          await runCli(home, ["history", "--job-url", branchJobUrl, "--json"]),
        );
        expect(history.data[0]?.branch).toBe(branch);
        expect(history.data[0]?.parameters).toEqual(
          expect.arrayContaining([
            { name: "BRANCH", value: branch },
            { name: "EXTRA", value: "preserved" },
          ]),
        );

        const beforeRerunNumber = history.data[0]?.number ?? 0;
        await runCli(home, ["rerun", "--job-url", branchJobUrl]);
        const rerunBuildUrl = await waitForNewBuild(
          home,
          branchJobUrl,
          beforeRerunNumber,
        );
        await runCliExpectFailure(home, [
          "wait",
          "--build-url",
          rerunBuildUrl,
          "--interval",
          "250ms",
          "--timeout",
          "30s",
        ]);
        const rerunLogs = await runCli(home, [
          "logs",
          "--build-url",
          rerunBuildUrl,
          "--no-follow",
        ]);
        expect(rerunLogs.output).toContain(`branch=${branch}`);
        expect(rerunLogs.output).toContain("extra=preserved");
      });
    }, 120_000);

    test("reports job activity metadata in listings and filters with --active-only", async () => {
      type ListedJob = {
        name: string;
        fullName?: string;
        url: string;
        disabled?: boolean;
        lastBuild?: {
          number: number;
          url: string;
          result?: string | null;
          building?: boolean;
          timestampMs?: number;
          durationMs?: number;
          estimatedDurationMs?: number;
        } | null;
      };

      await withCliHome(async (home) => {
        const listJobs = async (
          args: string[],
        ): Promise<Map<string, ListedJob>> => {
          const listed = parseJson<{ data: ListedJob[] }>(
            await runCli(home, ["list", ...args, "--json"]),
          );
          return new Map(
            listed.data.map((job) => [job.fullName ?? job.name, job]),
          );
        };

        const discovered = await listJobs(["--refresh"]);
        const nestedJobUrl = discovered.get("team/nested smoke")?.url;
        expect(nestedJobUrl).toBeString();

        for (const jobUrl of [
          `${jenkinsUrl}/job/cli-activity/`,
          String(nestedJobUrl),
        ]) {
          await runCli(home, [
            "build",
            "--job-url",
            jobUrl,
            "--without-params",
            "--watch",
          ]);
        }

        const jobs = await listJobs(["--refresh"]);

        const built = jobs.get("cli-activity");
        expect(built?.disabled).toBe(false);
        expect(built?.lastBuild).toMatchObject({
          result: "SUCCESS",
          building: false,
        });
        expect(built?.lastBuild?.number).toBeGreaterThan(0);
        expect(built?.lastBuild?.url).toContain("/job/cli-activity/");
        expect(built?.lastBuild?.timestampMs).toBeNumber();
        expect(built?.lastBuild?.durationMs).toBeNumber();

        const nested = jobs.get("team/nested smoke");
        expect(nested?.name).toBe("nested smoke");
        expect(nested?.disabled).toBe(false);
        expect(nested?.lastBuild?.number).toBeGreaterThan(0);

        expect(jobs.get("cli-pipeline-disabled")).toMatchObject({
          name: "cli-pipeline-disabled",
          disabled: true,
          lastBuild: null,
        });
        expect(jobs.get("cli-never-built")).toMatchObject({
          name: "cli-never-built",
          disabled: false,
          lastBuild: null,
        });

        const active = await listJobs(["--active-only"]);
        expect(active.has("cli-activity")).toBe(true);
        expect(active.has("team/nested smoke")).toBe(true);
        expect(active.has("cli-pipeline-disabled")).toBe(false);
        expect(active.has("cli-never-built")).toBe(false);

        const plain = await runCli(home, ["list"]);
        expect(plain.output).toContain("cli-pipeline-disabled [disabled]");
        expect(plain.output).toContain(
          `cli-activity  ${jenkinsUrl}/job/cli-activity`,
        );
        expect(plain.output).not.toContain("cli-never-built [disabled]");
      });
    }, 180_000);

    test("reports real Pipeline stages and failure details", async () => {
      await withCliHome(async (home) => {
        const pipelineUrl = `${jenkinsUrl}/job/cli-pipeline/`;
        const built = await runCli(home, [
          "build",
          "--job-url",
          pipelineUrl,
          "--branch",
          "release/integration",
          "--watch",
        ]);
        expect(built.output).toContain("SUCCESS");

        const status = parseJson<{
          data: {
            build: {
              branch: string;
              durationMs: number;
              overheadMs: number;
              stages: Array<{
                name: string;
                status: string;
                durationMs: number;
              }>;
            };
          };
        }>(await runCli(home, ["status", "--job-url", pipelineUrl, "--json"]));
        expect(status.data.build.branch).toBe("release/integration");
        expect(status.data.build.stages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "Prepare", status: "SUCCESS" }),
            expect.objectContaining({ name: "Verify", status: "SUCCESS" }),
          ]),
        );
        const stageDurationMs = status.data.build.stages.reduce(
          (total, stage) => total + stage.durationMs,
          0,
        );
        expect(status.data.build.overheadMs).toBe(
          Math.max(0, status.data.build.durationMs - stageDurationMs),
        );

        const failureUrl = `${jenkinsUrl}/job/cli-pipeline-failure/`;
        const failed = await runCliExpectFailure(home, [
          "build",
          "--job-url",
          failureUrl,
          "--without-params",
          "--watch",
        ]);
        expect(failed.output).toContain("FAILURE");
        const failedStatus = parseJson<{
          data: {
            build: {
              stages: Array<{ name: string; status: string }>;
            };
          };
        }>(await runCli(home, ["status", "--job-url", failureUrl, "--json"]));
        expect(failedStatus.data.build.stages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "Deploy", status: "FAILED" }),
          ]),
        );
        const history = await runCli(home, [
          "history",
          "--job-url",
          failureUrl,
        ]);
        expect(history.output).toContain("pipeline-deploy-failure");
      });
    }, 120_000);

    test("reports attributable git revisions for status and history", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-git-revisions/`;
        const build = await runCli(home, [
          "build",
          "--job-url",
          jobUrl,
          "--without-params",
          "--watch",
        ]);
        expect(build.output).toContain("SUCCESS");

        type Revision = {
          repo?: string;
          remoteUrl?: string;
          remoteUrls: string[];
          branch?: string;
          sha: string;
        };
        const status = parseJson<{
          data: { build: { number: number; revisions: Revision[] } };
        }>(await runCli(home, ["status", "--job-url", jobUrl, "--json"]));
        expect(status.data.build.revisions).toHaveLength(2);

        const statusByRepo = new Map(
          status.data.build.revisions.map((revision) => [
            revision.repo,
            revision,
          ]),
        );
        for (const repo of ["pipeline-definitions", "backend-api"]) {
          const revision = statusByRepo.get(repo);
          if (!revision) {
            throw new Error(`Missing revision for ${repo}`);
          }
          expect(revision.remoteUrl ?? "").toEndWith(`/${repo}.git`);
          expect(revision.remoteUrls).toContain(revision.remoteUrl ?? "");
          expect(revision.branch ?? "").toContain("main");
          expect(revision.sha).toMatch(/^[0-9a-f]{40}$/);
        }

        const history = parseJson<{
          data: Array<{ number: number; revisions: Revision[] }>;
        }>(await runCli(home, ["history", "--job-url", jobUrl, "--json"]));
        expect(history.data[0]?.number).toBe(status.data.build.number);
        const historyByRepo = new Map(
          history.data[0]?.revisions.map((revision) => [
            revision.repo,
            revision,
          ]),
        );
        expect(historyByRepo.get("pipeline-definitions")?.sha).toBe(
          statusByRepo.get("pipeline-definitions")?.sha,
        );
        expect(historyByRepo.get("backend-api")?.sha).toBe(
          statusByRepo.get("backend-api")?.sha,
        );

        const wait = parseJson<{
          data: { result: string; build: { revisions: Revision[] } };
        }>(await runCli(home, ["wait", "--job-url", jobUrl, "--json"]));
        expect(wait.data.result).toBe("SUCCESS");
        expect(
          wait.data.build.revisions.map((revision) => revision.sha).toSorted(),
        ).toEqual(
          status.data.build.revisions
            .map((revision) => revision.sha)
            .toSorted(),
        );

        const noScmJobUrl = `${jenkinsUrl}/job/cli-no-params/`;
        await runCli(home, [
          "build",
          "--job-url",
          noScmJobUrl,
          "--without-params",
          "--watch",
        ]);
        const noScmStatus = parseJson<{
          data: { build: { revisions: Revision[] } };
        }>(await runCli(home, ["status", "--job-url", noScmJobUrl, "--json"]));
        expect(noScmStatus.data.build.revisions).toEqual([]);
      });
    }, 120_000);

    test("explains build causes and contained commits", async () => {
      await withCliHome(async (home) => {
        // A build without SCM: causes are reported, empty changes succeed.
        const noScmJobUrl = `${jenkinsUrl}/job/cli-no-params/`;
        await runCli(home, [
          "build",
          "--job-url",
          noScmJobUrl,
          "--without-params",
          "--watch",
        ]);
        type ChangesDocument = {
          ok: boolean;
          command: string;
          data: {
            build: { number: number; url: string };
            causes: Array<{
              type: string;
              summary?: string;
              userId?: string;
            }>;
            changes: Array<{
              id?: string;
              author?: string;
              timestampMs?: number;
              message?: string;
              paths?: string[];
              sourceType: string;
            }>;
            pagination: {
              limit: number;
              returned: number;
              total?: number;
              truncated: boolean;
            };
          };
        };
        const noScmChanges = parseJson<ChangesDocument>(
          await runCli(home, ["changes", "--job-url", noScmJobUrl, "--json"]),
        );
        expect(noScmChanges).toMatchObject({ ok: true, command: "changes" });
        expect(noScmChanges.data.causes[0]).toMatchObject({
          type: "user",
          userId: "integration-test",
        });
        expect(noScmChanges.data.changes).toEqual([]);
        expect(noScmChanges.data.pagination).toEqual({
          limit: 20,
          returned: 0,
          total: 0,
          truncated: false,
        });

        // Baseline build so the next one has a previous checkout to diff from.
        const revisionsJobUrl = `${jenkinsUrl}/job/cli-git-revisions/`;
        await runCli(home, [
          "build",
          "--job-url",
          revisionsJobUrl,
          "--without-params",
          "--watch",
        ]);

        // Land one commit in the backend-api fixture repo, then rebuild: the
        // new build must contain exactly that commit.
        if (!integrationRuntimeDir) {
          throw new Error(
            "JENKINS_INTEGRATION_RUNTIME_DIR is required for the changes scenario.",
          );
        }
        const bareRepository = join(integrationRuntimeDir, "backend-api.git");
        const clone = join(home, "backend-api-clone");
        await git("clone", bareRepository, clone);
        await Bun.write(
          join(clone, "release-notes.md"),
          "# Release notes\n\nSynthetic change for the changes command.\n",
        );
        await git("-C", clone, "add", "release-notes.md");
        await git(
          "-C",
          clone,
          "commit",
          "-m",
          "Add synthetic release notes",
          "-m",
          "Body line for the changes command.",
        );
        const commitSha = await git("-C", clone, "rev-parse", "HEAD");
        await git("-C", clone, "push", "origin", "main");
        if (process.platform !== "win32") {
          // The container's jenkins user reads the pushed objects.
          Bun.spawnSync({ cmd: ["chmod", "-R", "a+rX", bareRepository] });
        }

        await runCli(home, [
          "build",
          "--job-url",
          revisionsJobUrl,
          "--without-params",
          "--watch",
        ]);
        const commitChanges = parseJson<ChangesDocument>(
          await runCli(home, [
            "changes",
            "--job-url",
            revisionsJobUrl,
            "--json",
          ]),
        );
        expect(commitChanges.data.causes[0]).toMatchObject({
          type: "user",
          userId: "integration-test",
        });
        expect(commitChanges.data.changes).toHaveLength(1);
        expect(commitChanges.data.changes[0]).toMatchObject({
          id: commitSha,
          author: "Jenkins CLI Integration",
          message:
            "Add synthetic release notes\n\nBody line for the changes command.",
          sourceType: "git",
        });
        expect(commitChanges.data.changes[0]?.paths).toBeUndefined();
        expect(commitChanges.data.pagination).toEqual({
          limit: 20,
          returned: 1,
          total: 1,
          truncated: false,
        });

        // Affected paths appear only with --paths, and the exact-build
        // selector pins the same immutable answer.
        const commitBuild = commitChanges.data.build.number;
        const pinnedWithPaths = parseJson<ChangesDocument>(
          await runCli(home, [
            "changes",
            "--job-url",
            revisionsJobUrl,
            "--build",
            String(commitBuild),
            "--paths",
            "--json",
          ]),
        );
        expect(pinnedWithPaths.data.build.number).toBe(commitBuild);
        expect(pinnedWithPaths.data.changes[0]?.paths).toEqual([
          "release-notes.md",
        ]);

        const human = await runCli(home, [
          "changes",
          "--job-url",
          revisionsJobUrl,
        ]);
        expect(human.output).toContain(`Build: #${commitBuild}`);
        expect(human.output).toContain("user: Started by user");
        expect(human.output).toContain(commitSha.slice(0, 12));
        expect(human.output).toContain("Add synthetic release notes");
        expect(human.output).not.toContain("Body line for the changes");

        // Re-running the same revision is a successful empty result.
        await runCli(home, [
          "build",
          "--job-url",
          revisionsJobUrl,
          "--without-params",
          "--watch",
        ]);
        const rerunChanges = parseJson<ChangesDocument>(
          await runCli(home, [
            "changes",
            "--job-url",
            revisionsJobUrl,
            "--json",
          ]),
        );
        expect(rerunChanges.data.build.number).toBe(commitBuild + 1);
        expect(rerunChanges.data.changes).toEqual([]);

        // A missing build keeps its stable error code in JSON.
        const missing = parseJson<{ ok: boolean; error: { code: string } }>(
          await runCliExpectFailure(home, [
            "changes",
            "--job-url",
            revisionsJobUrl,
            "--build",
            "99999",
            "--json",
          ]),
        );
        expect(missing).toMatchObject({
          ok: false,
          error: { code: "BUILD_NOT_FOUND" },
        });
      });
    }, 240_000);

    test("filters and selects real whole-build and Pipeline logs", async () => {
      await withCliHome(async (home) => {
        const pipelineJobUrl = `${jenkinsUrl}/job/cli-pipeline-logs/`;
        await runCli(home, [
          "build",
          "--job-url",
          pipelineJobUrl,
          "--without-params",
          "--watch",
        ]);
        const pipelineStatus = parseJson<{
          data: { build: { url: string } };
        }>(
          await runCli(home, ["status", "--job-url", pipelineJobUrl, "--json"]),
        );
        const pipelineBuildUrl = pipelineStatus.data.build.url;

        const tail = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--tail",
          "2",
          "--no-follow",
        ]);
        expect(tail.stdout.split("\n").filter(Boolean)).toHaveLength(2);
        expect(tail.stdout).not.toContain("HINT:");
        expect(tail.stderr).toContain("HINT: Reading logs");

        const queried = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--plain",
          "--no-timestamps",
          "--grep",
          "pipeline-logs-context-target",
          "--context",
          "1",
          "--no-follow",
        ]);
        expect(queried.stdout.replaceAll("\r\n", "\n")).toBe(
          [
            "pipeline-logs-context-before",
            "pipeline-logs-context-target",
            "pipeline-logs-context-after",
            "",
          ].join("\n"),
        );
        expect(queried.stdout).not.toContain("\x1b");
        expect(queried.stdout).not.toContain("ha:////");
        expect(queried.stdout).not.toContain("[Pipeline]");
        expect(queried.stdout).not.toMatch(/^\[\d{4}-\d{2}-\d{2}T/m);

        const oscPlain = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--plain",
          "--no-timestamps",
          "--grep",
          "pipeline-logs-osc",
          "--no-follow",
        ]);
        expect(oscPlain.stdout.replaceAll("\r\n", "\n")).toBe(
          "pipeline-logs-osc pipeline-logs-link-label end\n",
        );

        const prepare = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage",
          "Prepare",
          "--no-follow",
        ]);
        expect(prepare.stdout).toContain("pipeline-logs-prepare");
        expect(prepare.stdout).not.toContain("pipeline-logs-test-first");

        const preparedContext = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage",
          "Prepare",
          "--plain",
          "--grep",
          "pipeline-logs-context-target",
          "--context",
          "1",
          "--no-follow",
        ]);
        expect(preparedContext.stdout).toContain(
          "pipeline-logs-context-before",
        );
        expect(preparedContext.stdout).toContain(
          "pipeline-logs-context-target",
        );
        expect(preparedContext.stdout).toContain("pipeline-logs-context-after");
        expect(preparedContext.stdout).not.toContain("ha:////");
        expect(preparedContext.stdout).not.toContain("\x1b");

        const parallel = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage",
          "Parallel",
          "--no-follow",
        ]);
        expect(parallel.stdout).toContain("pipeline-logs-linux");
        expect(parallel.stdout).toContain("pipeline-logs-windows");

        const stageEvents = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage",
          "Prepare",
          "--no-follow",
          "--jsonl",
        ]);
        expect(
          stageEvents.stdout
            .split("\n")
            .filter(Boolean)
            .map(
              (line) => JSON.parse(line) as { stage?: { stageName: string } },
            )
            .filter((event) => event.stage)
            .every((event) => event.stage?.stageName === "Prepare"),
        ).toBeTrue();

        const ambiguous = await runCliExpectFailure(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage",
          "Test",
          "--no-follow",
        ]);
        expect(ambiguous.stderr).toContain("is ambiguous");
        const firstTestStageId =
          ambiguous.stderr.match(/Test \(id (\d+)\)/)?.[1];
        expect(firstTestStageId).toBeDefined();
        const exactStage = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage-id",
          firstTestStageId!,
          "--no-follow",
        ]);
        expect(exactStage.stdout).toContain("pipeline-logs-test-");

        const failureJobUrl = `${jenkinsUrl}/job/cli-pipeline-failure/`;
        await runCliExpectFailure(home, [
          "build",
          "--job-url",
          failureJobUrl,
          "--without-params",
          "--watch",
        ]);
        const failed = await runCli(home, [
          "logs",
          "--job-url",
          failureJobUrl,
          "--failed",
          "--no-follow",
        ]);
        expect(failed.stdout).toContain("pipeline-deploy-context");
        expect(failed.stderr).toContain("pipeline-deploy-failure");
        const failedContext = await runCli(home, [
          "logs",
          "--job-url",
          failureJobUrl,
          "--failed",
          "--grep",
          "pipeline-deploy-context",
          "--context",
          "1",
          "--no-follow",
        ]);
        expect(failedContext.stdout).toContain("pipeline-deploy-before");
        expect(failedContext.stdout).toContain("pipeline-deploy-context");
        expect(failedContext.stdout).toContain("pipeline-deploy-after");
        const unsupportedSince = await runCliExpectFailure(home, [
          "logs",
          "--job-url",
          failureJobUrl,
          "--since",
          "1h",
          "--no-follow",
        ]);
        expect(unsupportedSince.stderr).toContain("did not expose timestamps");

        const timestampedJobUrl = `${jenkinsUrl}/job/cli-timestamped-logs/`;
        await runCli(home, [
          "build",
          "--job-url",
          timestampedJobUrl,
          "--without-params",
          "--watch",
        ]);
        const timestamped = await runCli(home, [
          "logs",
          "--job-url",
          timestampedJobUrl,
          "--since",
          "1h",
          "--no-follow",
        ]);
        expect(timestamped.stdout).toContain("timestamped-log-old");
        expect(timestamped.stdout).toContain("timestamped-log-new");

        const future = await runCli(home, [
          "logs",
          "--job-url",
          timestampedJobUrl,
          "--since",
          new Date(Date.now() + 60_000).toISOString(),
          "--no-follow",
        ]);
        expect(future.stdout).toBe("");
      });
    }, 180_000);

    test("defaults redirected logs to a one-shot read while a build is running", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-log-follow/`;
        await runCli(home, ["build", "--job-url", jobUrl, "--without-params"]);
        const running = await pollCli(
          home,
          ["status", "--job-url", jobUrl, "--json"],
          (result) => {
            const payload = JSON.parse(result.stdout) as {
              data?: { build?: { building?: boolean; url?: string } };
            };
            return payload.data?.build?.building === true;
          },
        );
        const runningBuildUrl = (
          JSON.parse(running.stdout) as {
            data: { build: { url: string } };
          }
        ).data.build.url;

        const logs = await runCli(home, [
          "logs",
          "--build-url",
          runningBuildUrl,
          "--tail",
          "1",
        ]);
        expect(logs.stdout).toContain("tail-follow-bootstrap-2");
        expect(logs.stdout).not.toContain("tail-follow-finished");

        const stillRunning = JSON.parse(
          (
            await runCli(home, [
              "status",
              "--build-url",
              runningBuildUrl,
              "--json",
            ])
          ).stdout,
        ) as { data: { build: { building: boolean } } };
        expect(stillRunning.data.build.building).toBe(true);

        await runCli(home, [
          "wait",
          "--build-url",
          runningBuildUrl,
          "--timeout",
          "30s",
          "--interval",
          "250ms",
          "--json",
        ]);
      });
    }, 90_000);

    test.skipIf(process.platform === "win32")(
      "defaults redirected logs to one shot while explicit follow keeps streaming",
      async () => {
        await withCliHome(async (home) => {
          const jobUrl = `${jenkinsUrl}/job/cli-log-follow/`;
          await runCli(home, [
            "build",
            "--job-url",
            jobUrl,
            "--without-params",
          ]);
          const running = await pollCli(
            home,
            ["status", "--job-url", jobUrl, "--json"],
            (result) => {
              const payload = JSON.parse(result.stdout) as {
                data?: { build?: { building?: boolean; url?: string } };
              };
              return payload.data?.build?.building === true;
            },
          );
          const runningBuildUrl = (
            JSON.parse(running.stdout) as {
              data: { build: { url: string } };
            }
          ).data.build.url;
          const redirected = await runCli(home, [
            "logs",
            "--build-url",
            runningBuildUrl,
            "--tail",
            "1",
            "--poll",
            "100ms",
          ]);
          expect(redirected.stdout).toContain("tail-follow-bootstrap");
          const stillRunning = parseJson<{
            data: { build: { building: boolean } };
          }>(
            await runCli(home, [
              "status",
              "--build-url",
              runningBuildUrl,
              "--json",
            ]),
          );
          expect(stillRunning.data.build.building).toBe(true);

          const interrupted = await invokeCliAndInterrupt(
            home,
            [
              "logs",
              "--build-url",
              runningBuildUrl,
              "--tail",
              "1",
              "--follow",
              "--poll",
              "100ms",
            ],
            "HINT: Reading logs",
          );
          expect(interrupted.exitCode).toBe(130);
          expect(interrupted.stderr).toContain(
            "the Jenkins build was not cancelled",
          );

          const completed = await runCli(home, [
            "wait",
            "--build-url",
            runningBuildUrl,
            "--timeout",
            "30s",
            "--interval",
            "250ms",
            "--json",
          ]);
          expect(JSON.parse(completed.stdout)).toMatchObject({
            data: { result: "SUCCESS" },
          });
        });
      },
      90_000,
    );

    test("follows logs while a queued item becomes a build", async () => {
      await withCliHome(async (home) => {
        const slowJobUrl = `${jenkinsUrl}/job/cli-slow/`;
        await runCli(home, [
          "build",
          "--job-url",
          slowJobUrl,
          "--without-params",
        ]);
        const running = await pollCli(home, ["run"], (result) =>
          result.output.includes("cli-slow #"),
        );
        const slowBuildUrl = running.output.match(
          /(http:\/\/[^\s]+\/job\/cli-slow\/\d+\/)/,
        )?.[1];
        expect(slowBuildUrl).toBeDefined();

        const transitionJobUrl = `${jenkinsUrl}/job/cli-transition/`;
        await runCli(home, [
          "build",
          "--job-url",
          transitionJobUrl,
          "--without-params",
        ]);
        const queued = await pollCli(
          home,
          ["queue", "--job", "cli-transition"],
          (result) => result.output.includes("cli-transition"),
        );
        const queueId = queued.output.match(/^\s*(\d+)\s+cli-transition/m)?.[1];
        expect(queueId).toBeDefined();
        const queueUrl = `${jenkinsUrl}/queue/item/${queueId}/`;

        const waitPromise = invokeCli(home, [
          "wait",
          "--queue-url",
          queueUrl,
          "--interval",
          "250ms",
          "--timeout",
          "30s",
          "--json",
        ]);
        const logsPromise = invokeCli(home, [
          "logs",
          "--queue-url",
          queueUrl,
          "--follow",
          "--poll",
          "100ms",
        ]);
        await runCli(home, ["cancel", "--build-url", slowBuildUrl!]);

        const [waited, logs] = await Promise.all([waitPromise, logsPromise]);
        expect(waited.exitCode, waited.output).toBe(0);
        expect(JSON.parse(waited.stdout)).toMatchObject({
          data: { result: "SUCCESS", build: { result: "SUCCESS" } },
        });
        expect(logs.exitCode, logs.output).toBe(0);
        expect(logs.output).toContain("transition-started");
        expect(logs.output).toContain("transition-finished");
        expect(logs.output.match(/^transition-started$/gm)).toHaveLength(1);
      });
    }, 90_000);

    test("uses CSRF crumbs, history offsets, and exact artifact targets", async () => {
      await withCliHome(async (home) => {
        const historyJobUrl = `${jenkinsUrl}/job/cli-history/`;
        for (let index = 0; index < 11; index++) {
          await runCli(
            home,
            [
              "build",
              "--job-url",
              historyJobUrl,
              "--without-params",
              "--watch",
            ],
            index === 0 ? { JENKINS_USE_CRUMB: "1" } : {},
          );
        }

        const secondPage = await pollCli(
          home,
          ["history", "--job-url", historyJobUrl, "--offset", "5", "--json"],
          (result) => {
            const payload = JSON.parse(result.stdout) as {
              data?: Array<{ number?: number; result?: string }>;
            };
            return (
              payload.data?.length === 5 &&
              payload.data[0]?.number === 6 &&
              payload.data.every((build) => build.result === "SUCCESS")
            );
          },
          30_000,
        );
        const secondPageBuilds = parseJson<{
          data: Array<{ number: number; result: string }>;
        }>(secondPage).data;
        expect(secondPageBuilds.map((build) => build.number)).toEqual([
          6, 5, 4, 3, 2,
        ]);
        expect(
          secondPageBuilds.every((build) => build.result === "SUCCESS"),
        ).toBe(true);
        const firstPage = parseJson<{ data: Array<{ number: number }> }>(
          await runCli(home, [
            "history",
            "--job-url",
            historyJobUrl,
            "--offset",
            "0",
            "--json",
          ]),
        );
        expect(firstPage.data).toHaveLength(5);
        expect(firstPage.data.map((build) => build.number)).toEqual([
          11, 10, 9, 8, 7,
        ]);
        const finalPage = parseJson<{ data: Array<{ number: number }> }>(
          await runCli(home, [
            "history",
            "--job-url",
            historyJobUrl,
            "--offset",
            "10",
            "--json",
          ]),
        );
        expect(finalPage.data.map((build) => build.number)).toEqual([1]);

        const smokeUrl = `${jenkinsUrl}/job/cli-smoke/`;
        await runCli(home, [
          "build",
          "--job-url",
          smokeUrl,
          "--param",
          "MESSAGE=exact-artifact-target",
          "--watch",
        ]);
        const smokeStatus = parseJson<{
          data: { build: { number: number; url: string } };
        }>(await runCli(home, ["status", "--job-url", smokeUrl, "--json"]));
        const byNumber = await runCli(home, [
          "artifacts",
          "--job-url",
          smokeUrl,
          "--build",
          String(smokeStatus.data.build.number),
        ]);
        expect(byNumber.output).toContain("reports/values.txt");

        const destination = join(home, "exact-artifact");
        await runCli(home, [
          "artifacts",
          "--build-url",
          smokeStatus.data.build.url,
          "--artifact",
          "artifact.txt",
          "--dest",
          destination,
        ]);
        expect(await Bun.file(join(destination, "artifact.txt")).text()).toBe(
          "root-artifact\n",
        );
      });
    }, 120_000);

    test("blocks mutations for a protected profile until confirmed", async () => {
      await withCliHome(async (home) => {
        await writeProtectedProfile(home);
        const jobUrl = `${jenkinsUrl}/job/cli-no-params/`;

        const list = parseJson(
          await runCli(home, ["list", "--refresh", "--json"]),
        );
        expect(list).toMatchObject({ ok: true, command: "list" });

        const buildNumber = async (): Promise<number | null> => {
          const status = parseJson<{
            data: { build: { number: number } | null };
          }>(await runCli(home, ["status", "--job-url", jobUrl, "--json"]));
          return status.data.build?.number ?? null;
        };
        const before = await buildNumber();

        for (const args of [
          ["build", "--job-url", jobUrl, "--json"],
          ["cancel", "--job-url", jobUrl, "--json"],
          ["rerun", "--job-url", jobUrl, "--json"],
          [
            "build",
            "--job-url",
            jobUrl,
            "--url",
            `${jenkinsUrl}/`,
            "--user",
            process.env.JENKINS_INTEGRATION_USER ?? "",
            "--token",
            process.env.JENKINS_INTEGRATION_TOKEN ?? "",
            "--json",
          ],
        ]) {
          const blocked = await runCliExpectFailure(home, args);
          expect(blocked.stdout.split("\n").filter(Boolean)).toHaveLength(1);
          expect(JSON.parse(blocked.stdout)).toEqual({
            ok: false,
            error: {
              message: 'Profile "release" is read-only.',
              code: "PROFILE_PROTECTED",
            },
          });
        }
        expect(await buildNumber()).toBe(before);

        const confirmed = parseJson<{ data: { result: string } }>(
          await runCli(home, [
            "build",
            "--job-url",
            jobUrl,
            "--watch",
            "--json",
            "--confirm-protected",
          ]),
        );
        expect(confirmed).toMatchObject({
          ok: true,
          command: "build",
          data: { result: "SUCCESS" },
        });
        expect(await buildNumber()).toBe((before ?? 0) + 1);
      });
    }, 120_000);

    test.skipIf(process.platform === "win32")(
      "keeps the interactive list action menu open after a protected block",
      async () => {
        await withCliHome(async (home) => {
          await writeProtectedProfile(home);
          await runCli(home, ["list", "--refresh", "--json"]);

          const session = await observeInteractiveCli(
            home,
            ["list", "--no-banner"],
            [
              {
                text: "Job name or description",
                input: "cli-no-params\r",
              },
              // Build is the first action: Enter triggers the blocked mutation.
              { text: "Action for cli-no-params", input: "\r" },
              // Synchronize after the completed action prompt, then observe the
              // repeated menu to prove the flow stayed on the selected job.
              {
                text: 'ERROR: Profile "release" is read-only.',
                input: "",
              },
              { text: "Action for cli-no-params", input: "" },
            ],
          );

          expect(session.output).toContain(
            'ERROR: Profile "release" is read-only.',
          );
          expect(session.output).toContain(
            "HINT: Re-run with --confirm-protected to allow builds, cancels, creates, and reruns.",
          );
        });
      },
      120_000,
    );
  },
);

async function writeProtectedProfile(home: string): Promise<void> {
  const configDir = join(home, ".config", "jenkins-cli");
  mkdirSync(configDir, { recursive: true });
  await Bun.write(
    join(configDir, "jenkins-cli-config.json"),
    `${JSON.stringify(
      {
        version: 2,
        defaultProfile: "release",
        profiles: {
          release: {
            jenkinsUrl: jenkinsUrl,
            jenkinsUser: process.env.JENKINS_INTEGRATION_USER,
            jenkinsApiToken: process.env.JENKINS_INTEGRATION_TOKEN,
            protected: true,
          },
        },
        analyticsDisabled: true,
      },
      null,
      2,
    )}\n`,
  );
}

async function findJobCachePath(home: string): Promise<string> {
  const glob = new Bun.Glob("**/jenkins-cli/jobs-*.json");
  for await (const match of glob.scan({ cwd: home, dot: true })) {
    return join(home, match);
  }
  throw new Error(`No job cache written under ${home}`);
}
