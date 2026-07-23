import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  integrationEnabled,
  invokeCli,
  jenkinsUrl,
  parseJson,
  pollCli,
  runCli,
  runCliExpectFailure,
  waitForNewBuild,
  withCliHome,
} from "./jenkins/harness";

describe.skipIf(!integrationEnabled)(
  "compiled CLI against real Jenkins",
  () => {
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
      });
    }, 30_000);

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
        };
        const adminToken = process.env.JENKINS_INTEGRATION_TOKEN ?? "";
        const readerUser =
          process.env.JENKINS_INTEGRATION_READER_USER ?? "integration-reader";
        const readerToken = process.env.JENKINS_INTEGRATION_READER_TOKEN ?? "";

        await runCli(home, [
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
        ]);
        await runCli(home, [
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
        ]);

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
          "Jenkins rejected the request while trying to trigger build.",
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
              stages: Array<{ name: string; status: string }>;
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
        for (let index = 0; index < 6; index++) {
          await runCli(
            home,
            [
              "build",
              "--job-url",
              historyJobUrl,
              "--without-params",
              "--watch",
            ],
            index === 0 ? { JENKINS_USE_CRUMB: "true" } : {},
          );
        }

        const secondPage = await pollCli(
          home,
          ["history", "--job-url", historyJobUrl, "--offset", "5", "--json"],
          (result) => {
            const payload = JSON.parse(result.stdout) as {
              data?: Array<{ result?: string }>;
            };
            return (
              payload.data?.length === 1 &&
              payload.data[0]?.result === "SUCCESS"
            );
          },
          30_000,
        );
        expect(
          parseJson<{ data: Array<{ result: string }> }>(secondPage).data,
        ).toHaveLength(1);
        const firstPage = parseJson<{ data: Array<unknown> }>(
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
  },
);
