import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cliLogFiles,
  findJobCachePath,
  integrationEnabled,
  integrationCliExecutable,
  invokeCli,
  jenkinsUrl,
  parseJson,
  pollCli,
  runCli,
  runCliExpectFailure,
  startCli,
  stripTerminalCodes,
  type BackgroundCli,
  waitForNewBuild,
  withCliHome,
} from "./jenkins/harness";

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

    test("--timeout bounds each request and the error names the limit", async () => {
      // A fixed delay on every request makes the outcome depend only on
      // --timeout, not on how fast the controller happens to answer.
      const slowJenkins = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 30,
        async fetch(request) {
          await Bun.sleep(500);
          const incoming = new URL(request.url);
          const response = await fetch(
            new URL(incoming.pathname + incoming.search, jenkinsUrl),
            { headers: request.headers },
          );
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          headers.delete("content-encoding");
          return new Response(await response.arrayBuffer(), {
            status: response.status,
            headers,
          });
        },
      });
      try {
        await withCliHome(async (home) => {
          const env = { JENKINS_URL: `${slowJenkins.url.origin}/jenkins` };
          const timedOut = await invokeCli(
            home,
            ["status", "--job", "cli-smoke", "--timeout", "1ms", "--json"],
            env,
          );
          expect(timedOut.exitCode, timedOut.output).toBe(6);
          const failure = parseJson<{
            ok: boolean;
            error: { code: string; message: string };
          }>(timedOut);
          expect(failure.ok).toBeFalse();
          expect(failure.error.code).toBe("JENKINS_TIMEOUT");
          expect(failure.error.message).toContain(
            "Jenkins did not respond within 1ms",
          );

          const status = parseJson(
            await runCli(
              home,
              ["status", "--job", "cli-smoke", "--timeout", "30s", "--json"],
              env,
            ),
          );
          expect(status).toMatchObject({ ok: true, command: "status" });
        });
      } finally {
        await slowJenkins.stop(true);
      }
    }, 60_000);

    test("lists ambiguous job candidates in the --json error", async () => {
      await withCliHome(async (home) => {
        const listed = parseJson<{ data: Array<{ url: string }> }>(
          await runCli(home, ["list", "--refresh", "--json"]),
        );

        const result = await runCliExpectFailure(home, [
          "status",
          "--job",
          "cli-candidate",
          "--json",
          "--non-interactive",
        ]);
        expect(result.exitCode).toBe(2);
        expect(parseJson<unknown>(result)).toEqual({
          ok: false,
          error: {
            code: "JOB_AMBIGUOUS",
            message: 'Job name is ambiguous for "cli-candidate".',
            hints: [
              "Options: team/cli-candidate-api, team/cli-candidate-web",
              "Pass `--job <exact name>` or `--job-url <url>`.",
            ],
            details: {
              candidates: [
                {
                  name: "team/cli-candidate-api",
                  url: `${jenkinsUrl}/job/team/job/cli-candidate-api/`,
                },
                {
                  name: "team/cli-candidate-web",
                  url: `${jenkinsUrl}/job/team/job/cli-candidate-web/`,
                },
              ],
            },
          },
        });
        // The candidates came from the cache that `list --refresh` wrote, yet
        // read exactly like the freshly fetched list.
        expect(listed.data.map((job) => job.url)).toEqual(
          expect.arrayContaining([
            `${jenkinsUrl}/job/team/job/cli-candidate-api/`,
            `${jenkinsUrl}/job/team/job/cli-candidate-web/`,
          ]),
        );
      });
    }, 30_000);

    test("masks credentials echoed by a proxy around real Jenkins failures", async () => {
      const token = process.env.JENKINS_INTEGRATION_READER_TOKEN!;
      const user =
        process.env.JENKINS_INTEGRATION_READER_USER ?? "integration-reader";
      const encoded = Buffer.from(`${user}:${token}`).toString("base64");
      let deniedRequests = 0;
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const incoming = new URL(request.url);
          const target = new URL(jenkinsUrl!);
          target.pathname = incoming.pathname;
          target.search = incoming.search;
          const headers = new Headers(request.headers);
          headers.delete("host");
          const response = await fetch(target, {
            method: request.method,
            headers,
            body: ["GET", "HEAD"].includes(request.method)
              ? undefined
              : await request.arrayBuffer(),
            redirect: "manual",
          });
          const body = await response.arrayBuffer();
          const responseHeaders = new Headers(response.headers);
          responseHeaders.delete("content-length");
          responseHeaders.delete("content-encoding");
          if (response.status !== 403)
            return new Response(body, {
              status: response.status,
              headers: responseHeaders,
            });
          deniedRequests++;
          const echo = `token=${token}; Authorization: ${request.headers.get("authorization")}; diagnostic=keep-this-detail`;
          return new Response(echo, {
            status: 403,
            headers: { "Content-Type": "text/plain", "X-Proxy-Detail": echo },
          });
        },
      });
      try {
        await withCliHome(async (home) => {
          const root = `${proxy.url.origin}/jenkins`;
          const result = await invokeCli(
            home,
            [
              "build",
              "--job-url",
              `${root}/job/cli-no-params/`,
              "--non-interactive",
              "--debug",
              "--json",
            ],
            {
              JENKINS_URL: root,
              JENKINS_USER: user,
              JENKINS_API_TOKEN: token,
            },
          );
          expect(result.exitCode).toBe(3);
          expect(deniedRequests).toBeGreaterThan(0);
          expect(
            parseJson<{ error: { message: string } }>(result).error.message,
          ).toContain("diagnostic=keep-this-detail");
          for (const kind of ["api", "error"] as const) {
            const files = cliLogFiles(home, kind);
            expect(files.length).toBeGreaterThan(0);
            const log = (
              await Promise.all(files.map((file) => Bun.file(file).text()))
            ).join("\n");
            expect(log).not.toContain(token);
            expect(log).not.toContain(encoded);
            expect(log).toContain(
              "token=<redacted>; Authorization: Basic <redacted>; diagnostic=keep-this-detail",
            );
            if (kind === "error") expect(log).toMatch(/\s+at .+:\d+:\d+/);
          }
        });
      } finally {
        await proxy.stop(true);
      }
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

    test("keeps config and logs in JENKINS_CLI_CONFIG_DIR", async () => {
      await withCliHome(async (home) => {
        const homeConfigDir = join(home, ".config", "jenkins-cli");
        const homeConfigFile = join(homeConfigDir, "jenkins-cli-config.json");
        const homeConfig = JSON.stringify({
          version: 2,
          defaultProfile: "home-only",
          profiles: {
            "home-only": {
              jenkinsUrl: "http://127.0.0.1:1",
              jenkinsUser: "home-user",
              jenkinsApiToken: "home-token",
            },
          },
        });
        await Bun.write(homeConfigFile, homeConfig);
        const homeEntries = readdirSync(homeConfigDir).toSorted();
        const overrideDir = mkdtempSync(
          join(tmpdir(), "jenkins-cli-config-override-"),
        );
        try {
          await Bun.write(
            join(overrideDir, "update-state.json"),
            JSON.stringify({
              lastCheckedAt: new Date().toISOString(),
              minAllowedVersion: "0.0.0",
              minAllowedFetchedAt: new Date().toISOString(),
            }),
          );

          const status = parseJson(
            await runCli(home, ["auth", "status", "--json", "--debug"], {
              JENKINS_CLI_CONFIG_DIR: overrideDir,
            }),
          );

          expect(status).toMatchObject({
            ok: true,
            command: "auth status",
            data: {
              profileLabel: "Environment",
              configFile: join(overrideDir, "jenkins-cli-config.json"),
              success: true,
            },
          });
          expect(
            readdirSync(overrideDir).filter((file) =>
              /^api-\d{4}-\d{2}-\d{2}\.log$/.test(file),
            ),
          ).toHaveLength(1);
          expect(await Bun.file(homeConfigFile).text()).toBe(homeConfig);
          expect(readdirSync(homeConfigDir).toSorted()).toEqual(homeEntries);
        } finally {
          rmSync(overrideDir, { recursive: true, force: true });
        }
      });
    });

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

    test("selects builds by Jenkins permalink alias", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-permalinks/`;
        const buildNumbers: Record<string, number> = {};
        for (const outcome of ["SUCCESS", "UNSTABLE", "FAILURE"]) {
          const receipt = parseJson<{
            data: { result: string; buildNumber: number };
          }>(
            await invokeCli(home, [
              "build",
              "--job-url",
              jobUrl,
              "--param",
              `OUTCOME=${outcome}`,
              "--watch",
              "--json",
            ]),
          );
          expect(receipt.data.result).toBe(outcome);
          buildNumbers[outcome] = receipt.data.buildNumber;
        }

        for (const [alias, outcome] of [
          ["lastStable", "SUCCESS"],
          ["lastSuccessful", "UNSTABLE"],
          ["lastFailed", "FAILURE"],
          ["lastCompleted", "FAILURE"],
        ] as const) {
          expect(
            parseJson(
              await runCli(home, [
                "status",
                "--job-url",
                jobUrl,
                "--build",
                alias,
                "--json",
              ]),
            ),
          ).toMatchObject({
            ok: true,
            command: "status",
            data: {
              build: {
                number: buildNumbers[outcome],
                url: `${jobUrl}${buildNumbers[outcome]}/`,
                result: outcome,
              },
            },
          });
        }

        const logs = await runCli(home, [
          "logs",
          "--job-url",
          jobUrl,
          "--build",
          "lastSuccessful",
          "--no-follow",
        ]);
        expect(logs.output).toContain("permalink-outcome:UNSTABLE");
        expect(logs.output).not.toContain("permalink-outcome:FAILURE");

        const missing = parseJson<{ error: { code: string; message: string } }>(
          await runCliExpectFailure(home, [
            "status",
            "--job-url",
            `${jenkinsUrl}/job/cli-never-built/`,
            "--build",
            "lastFailed",
            "--json",
          ]),
        );
        expect(missing.error.code).toBe("BUILD_NOT_FOUND");
        expect(missing.error.message).toContain("has no lastFailed build");

        const invalid = parseJson<{ error: { code: string } }>(
          await runCliExpectFailure(home, [
            "status",
            "--job-url",
            jobUrl,
            "--build",
            "lastGreen",
            "--json",
          ]),
        );
        expect(invalid.error.code).toBe("INVALID_BUILD_NUMBER");
      });
    }, 120_000);

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

        const delayedReport = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          idleTimeout: 30,
          async fetch(request) {
            const incoming = new URL(request.url);
            if (incoming.pathname.endsWith("/testReport/api/json")) {
              await Bun.sleep(3_000);
              return new Response("delayed test report");
            }
            const response = await fetch(
              new URL(incoming.pathname + incoming.search, jenkinsUrl),
              { headers: request.headers },
            );
            const headers = new Headers(response.headers);
            headers.delete("content-length");
            headers.delete("content-encoding");
            return new Response(await response.arrayBuffer(), {
              status: response.status,
              headers,
            });
          },
        });
        try {
          const root = `${delayedReport.url.origin}/jenkins`;
          const reportFailure = await invokeCli(
            home,
            [
              "tests",
              "--build-url",
              `${root}/job/cli-test-results/${mixedBuild.data.buildNumber}/`,
              "--timeout",
              "1s",
              "--json",
            ],
            { JENKINS_URL: root },
          );
          expect(reportFailure.exitCode).toBe(6);
          expect(parseJson(reportFailure)).toMatchObject({
            error: { code: "TEST_REPORT_TRANSPORT_ERROR" },
          });
          const errorLog = (
            await Promise.all(
              cliLogFiles(home, "error").map((file) => Bun.file(file).text()),
            )
          ).join("\n");
          expect(errorLog).toContain(
            "Caused by\nCliError: Request timed out while trying to fetch test report: Jenkins did not respond within 1000ms.",
          );
          expect(errorLog.match(/Caused by\n/g)).toHaveLength(2);
        } finally {
          await delayedReport.stop(true);
        }

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

    test("keeps build requests on the selected controller when Jenkins advertises another root", async () => {
      let foreignRequests = 0;
      const foreign = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          foreignRequests++;
          return new Response("Unexpected foreign request", { status: 500 });
        },
      });
      const advertisedRoot = `${foreign.url.origin}/other`;
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const incoming = new URL(request.url);
          const target = new URL(jenkinsUrl!);
          target.pathname = incoming.pathname;
          target.search = incoming.search;
          const headers = new Headers(request.headers);
          headers.delete("host");
          const response = await fetch(target, {
            method: request.method,
            headers,
            body:
              request.method === "GET" || request.method === "HEAD"
                ? undefined
                : await request.arrayBuffer(),
            redirect: "manual",
          });
          const responseHeaders = new Headers(response.headers);
          responseHeaders.delete("content-length");
          responseHeaders.delete("content-encoding");
          const location = responseHeaders.get("location");
          if (location)
            responseHeaders.set(
              "location",
              location.replace(jenkinsUrl!, advertisedRoot),
            );
          const body = await response.text();
          return new Response(
            responseHeaders.get("content-type")?.includes("application/json")
              ? body.replaceAll(jenkinsUrl!, advertisedRoot)
              : body,
            { status: response.status, headers: responseHeaders },
          );
        },
      });
      try {
        await withCliHome(async (home) => {
          const selectedRoot = `${proxy.url.origin}/jenkins`;
          const jobUrl = `${selectedRoot}/job/cli-no-params/`;
          const env = { JENKINS_URL: selectedRoot };
          const built = await invokeCli(
            home,
            [
              "build",
              "--job-url",
              jobUrl,
              "--without-params",
              "--watch",
              "--json",
            ],
            env,
          );
          expect(built.exitCode, built.output).toBe(0);
          expect(built.output).toContain(selectedRoot);
          expect(built.output).not.toContain(advertisedRoot);
          for (const command of [
            ["status", "--json"],
            ["history", "--json"],
            ["changes", "--json"],
            ["artifacts", "--json"],
            ["logs", "--no-follow"],
          ]) {
            const result = await invokeCli(
              home,
              [...command, "--job-url", jobUrl],
              env,
            );
            expect(result.exitCode, result.output).toBe(0);
            expect(result.output).not.toContain(advertisedRoot);
            if (command[0] === "status" || command[0] === "history") {
              expect(result.output).toContain(jobUrl);
            }
          }
          expect(foreignRequests).toBe(0);
          console.log(
            "Controller URL trust: build, status, history, changes, artifacts, logs passed; foreign requests=0",
          );
        });
      } finally {
        await proxy.stop(true);
        await foreign.stop(true);
      }
    }, 90_000);

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
          "--debug",
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
        const apiLog = (
          await Promise.all(
            cliLogFiles(home, "api").map((file) => Bun.file(file).text()),
          )
        ).join("\n");
        expect(apiLog).toContain("REQUEST GET ");
        expect(apiLog).toContain("REQUEST POST ");
        expect(apiLog).toContain("RESPONSE POST ");
        expect(apiLog).toContain("Body:\n  <omitted>");
        expect(apiLog).not.toContain(secret);
        expect(apiLog).not.toContain("default-secret");
        expect(apiLog).not.toContain("default-message");
        expect(apiLog).not.toContain(message);

        const status = parseJson<{
          data: { build: { number: number; url: string } };
        }>(await runCli(home, ["status", "--job-url", jobUrl, "--json"]));
        expect(status).toMatchObject({
          ok: true,
          command: "status",
          data: { build: { result: "SUCCESS", building: false } },
        });
        // The reported build URL is derived from the job URL we were given,
        // not copied from Jenkins' lastBuild.url.
        expect(status.data.build.url).toBe(
          `${jobUrl}${status.data.build.number}/`,
        );

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

    test("build --watch and status --watch poll at an explicit --interval", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-watch-interval/`;
        const rejected = await runCliExpectFailure(home, [
          "build",
          "--job-url",
          jobUrl,
          "--without-params",
          "--watch",
          "--interval",
          "0s",
          "--json",
        ]);
        expect(rejected.exitCode).toBe(2);
        expect(
          parseJson<{ error: { code: string } }>(rejected).error.code,
        ).toBe("INVALID_USAGE");
        // An invalid interval fails before Jenkins sees a trigger.
        expect(
          parseJson<{ data: { build: unknown } }>(
            await runCli(home, ["status", "--job-url", jobUrl, "--json"]),
          ).data.build,
        ).toBeNull();

        const built = parseJson<{
          data: { result: string; buildUrl: string };
        }>(
          await runCli(home, [
            "build",
            "--job-url",
            jobUrl,
            "--without-params",
            "--watch",
            "--interval",
            "250ms",
            "--json",
          ]),
        );
        expect(built.data.result).toBe("SUCCESS");

        const watched = await runCli(home, [
          "status",
          "--build-url",
          built.data.buildUrl,
          "--watch",
          "--interval",
          "250ms",
        ]);
        expect(watched.output).toContain("SUCCESS");
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

    test("build --watch, wait, and logs --follow keep going while Jenkins restarts", async () => {
      const gateway = startRestartingGateway();
      try {
        await withCliHome(async (home) => {
          const started: BackgroundCli[] = [];
          try {
            const env = { JENKINS_URL: gateway.root };
            const jobUrl = `${gateway.root}/job/cli-restart-watch/`;
            const start = (args: string[]) => {
              const cli = startCli(home, args, env);
              started.push(cli);
              return cli;
            };
            const build = start([
              "build",
              "--job-url",
              jobUrl,
              "--without-params",
              "--watch",
            ]);
            // Started once this scenario's build runs, so the job's latest
            // build is this one whatever builds the job had before.
            await build.waitForOutput("RUNNING");
            const wait = start(["wait", "--job-url", jobUrl, "--json"]);
            const logs = start([
              "logs",
              "--job-url",
              jobUrl,
              "--follow",
              "--plain",
            ]);
            const stageLogs = start([
              "logs",
              "--job-url",
              jobUrl,
              "--stage",
              "Restart",
              "--follow",
              "--plain",
            ]);
            await logs.waitForOutput("restart-watch-started");
            await stageLogs.waitForOutput("restart-watch-started");

            await gateway.restart();
            const [built, waited, ...followed] = await Promise.all([
              build.finished,
              wait.finished,
              logs.finished,
              stageLogs.finished,
            ]);

            const unavailable =
              "WARN: Jenkins is unavailable, retrying for up to 10m 0s. Jenkins returned HTTP 503";
            const reachable =
              /^WARN: Jenkins is reachable again after (\d+m )?\d+s\.$/m;
            expect(built.exitCode, built.output).toBe(0);
            expect(built.stderr).toContain(unavailable);
            expect(built.stderr).toMatch(reachable);
            const buildNumber = Number(
              built.stdout.match(/: #(\d+) SUCCESS$/m)?.[1],
            );
            expect(buildNumber, built.output).toBeGreaterThan(0);

            expect(waited.exitCode, waited.output).toBe(0);
            expect(waited.stderr).toContain(unavailable);
            expect(waited.stderr).toMatch(reachable);
            expect(JSON.parse(waited.stdout)).toMatchObject({
              ok: true,
              command: "wait",
              data: { result: "SUCCESS", build: { number: buildNumber } },
            });

            for (const result of followed) {
              expect(result.exitCode, result.output).toBe(0);
              expect(result.stderr).toContain(unavailable);
              expect(result.stderr).toMatch(reachable);
              expect(
                result.stdout.match(/^restart-watch-started$/gm),
                result.output,
              ).toHaveLength(1);
              expect(
                result.stdout.match(/^restart-watch-finished$/gm),
                result.output,
              ).toHaveLength(1);
            }
          } finally {
            // A failed step must not leave a CLI polling after the test.
            for (const cli of started) {
              cli.kill("SIGKILL");
            }
            await Promise.all(started.map((cli) => cli.finished));
          }
        });
      } finally {
        await gateway.stop();
      }
    }, 180_000);
  },
);

/**
 * A reverse proxy in front of the controller that acts out a Jenkins restart
 * the way a gateway such as nginx shows one: HTTP 503 first, then refused
 * connections, then Jenkins again. The real controller keeps running, because
 * the Docker image cannot restart Jenkins in place.
 */
function startRestartingGateway(): {
  root: string;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
} {
  let restarting = false;
  const fetchThroughGateway = async (request: Request): Promise<Response> => {
    if (restarting) {
      return new Response("Please wait while Jenkins is restarting", {
        status: 503,
      });
    }
    const incoming = new URL(request.url);
    const target = new URL(jenkinsUrl!);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const headers = new Headers(request.headers);
    headers.delete("host");
    // Jenkins then builds its links on the gateway, as behind a real proxy.
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-port", incoming.port);
    headers.set("x-forwarded-proto", "http");
    const response = await fetch(target, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      redirect: "manual",
    });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: responseHeaders,
    });
  };
  const serve = (port: number) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 30,
      fetch: fetchThroughGateway,
    });
  let server = serve(0);
  const port = server.port!;
  return {
    root: `http://127.0.0.1:${port}/jenkins`,
    async restart() {
      // Shorter than the 15s a watch waits over its first two retries, so
      // every watch recovers on its third try.
      restarting = true;
      await Bun.sleep(8_000);
      await server.stop(true);
      await Bun.sleep(6_000);
      restarting = false;
      server = serve(port);
    },
    stop: () => server.stop(true),
  };
}
