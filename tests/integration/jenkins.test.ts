import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const jenkinsUrl = process.env.JENKINS_INTEGRATION_URL;
const integrationEnabled = Boolean(jenkinsUrl);

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
        expect(nodes.output).toMatch(/\d+\/\d+ executors busy/);

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
  },
);

async function withCliHome(
  action: (home: string) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "jenkins-cli-integration-home-"));
  try {
    await action(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
};

async function runCli(
  home: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<CliResult> {
  const result = await invokeCli(home, args, envOverrides);
  expect(result.exitCode, result.output).toBe(0);
  return result;
}

async function runCliExpectFailure(
  home: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<CliResult> {
  const result = await invokeCli(home, args, envOverrides);
  expect(result.exitCode, result.output).not.toBe(0);
  return result;
}

async function invokeCli(
  home: string,
  args: string[],
  envOverrides: Record<string, string>,
): Promise<CliResult> {
  const executable = resolve(
    "dist",
    process.platform === "win32" ? "jenkins-cli.exe" : "jenkins-cli",
  );
  const subprocess = Bun.spawn({
    cmd: [executable, ...args, "--non-interactive", "--no-banner"],
    env: {
      ...process.env,
      HOME: home,
      JENKINS_URL: jenkinsUrl,
      JENKINS_USER: process.env.JENKINS_INTEGRATION_USER,
      JENKINS_API_TOKEN: process.env.JENKINS_INTEGRATION_TOKEN,
      JENKINS_ANALYTICS_DISABLED: "true",
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  const result = { exitCode, stdout, stderr, output: stdout + stderr };
  return result;
}

async function pollCli(
  home: string,
  args: string[],
  done: (result: CliResult) => boolean,
  timeoutMs = 15_000,
): Promise<CliResult> {
  const deadline = Date.now() + timeoutMs;
  let latest: CliResult | undefined;
  while (Date.now() < deadline) {
    latest = await runCli(home, args);
    if (done(latest)) return latest;
    await Bun.sleep(250);
  }
  throw new Error(
    `Timed out polling CLI: ${args.join(" ")}\n${latest?.output ?? "no output"}`,
  );
}

async function waitForNewBuild(
  home: string,
  jobUrl: string,
  previousNumber: number,
): Promise<string> {
  const result = await pollCli(
    home,
    ["status", "--job-url", jobUrl, "--json"],
    (candidate) => {
      const payload = JSON.parse(candidate.stdout) as {
        data?: { build?: { number?: number } };
      };
      return Number(payload.data?.build?.number) > previousNumber;
    },
  );
  const payload = JSON.parse(result.stdout) as {
    data: { build: { url: string } };
  };
  return payload.data.build.url;
}

function parseJson(result: CliResult): Record<string, unknown> {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
