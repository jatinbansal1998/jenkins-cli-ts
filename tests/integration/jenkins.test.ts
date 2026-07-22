import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const jenkinsUrl = process.env.JENKINS_INTEGRATION_URL;
const integrationEnabled = Boolean(jenkinsUrl);

test.skipIf(!integrationEnabled)(
  "compiled CLI completes a real Jenkins build flow",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "jenkins-cli-integration-home-"));
    const artifactDir = join(home, "artifacts");
    const jobUrl = `${jenkinsUrl}/job/cli-smoke/`;

    try {
      const auth = await runCli(home, ["auth", "status"]);
      expect(auth.output).toContain("Authenticated:    Yes");
      expect(auth.output).toContain("Jenkins user:     integration-test");

      const list = parseJson(
        await runCli(home, ["list", "--refresh", "--json"]),
      );
      expect(list).toMatchObject({
        ok: true,
        command: "list",
        data: [{ name: "cli-smoke", url: jobUrl }],
      });

      const params = parseJson(
        await runCli(home, ["params", "--job-url", jobUrl, "--json"]),
      );
      expect(params).toMatchObject({
        ok: true,
        command: "params",
        data: [
          {
            name: "MESSAGE",
            type: "string",
            defaultValue: "default-message",
            sensitive: false,
          },
        ],
      });

      const build = await runCli(home, [
        "build",
        "--job-url",
        jobUrl,
        "--param",
        "MESSAGE=from-jenkins-cli",
        "--watch",
      ]);
      expect(build.output).toContain("Build queued");
      expect(build.output).toContain("SUCCESS");

      const status = parseJson(
        await runCli(home, ["status", "--job-url", jobUrl, "--json"]),
      );
      expect(status).toMatchObject({
        ok: true,
        command: "status",
        data: {
          build: { result: "SUCCESS", building: false },
        },
      });

      const history = parseJson(
        await runCli(home, ["history", "--job-url", jobUrl, "--json"]),
      );
      expect(history).toMatchObject({
        ok: true,
        command: "history",
      });
      const builds = history.data as Array<Record<string, unknown>>;
      expect(builds[0]).toMatchObject({
        result: "SUCCESS",
        building: false,
      });

      const logs = await runCli(home, [
        "logs",
        "--job-url",
        jobUrl,
        "--no-follow",
      ]);
      expect(logs.output).toContain("cli-integration:from-jenkins-cli");

      const artifacts = await runCli(home, [
        "artifacts",
        "--job-url",
        jobUrl,
        "--download",
        "--dest",
        artifactDir,
      ]);
      expect(artifacts.output).toContain("Downloaded artifact.txt");
      expect(await Bun.file(join(artifactDir, "artifact.txt")).text()).toBe(
        "from-jenkins-cli\n",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  120_000,
);

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
};

async function runCli(home: string, args: string[]): Promise<CliResult> {
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
  expect(result.exitCode, result.output).toBe(0);
  return result;
}

function parseJson(result: CliResult): Record<string, unknown> {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
