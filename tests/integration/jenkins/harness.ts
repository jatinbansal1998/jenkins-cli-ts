import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const jenkinsUrl = process.env.JENKINS_INTEGRATION_URL;
export const integrationEnabled = Boolean(jenkinsUrl);

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
};

export async function withCliHome(
  action: (home: string) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "jenkins-cli-integration-home-"));
  try {
    await action(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export async function runCli(
  home: string,
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const result = await invokeCli(home, args, envOverrides);
  expect(result.exitCode, result.output).toBe(0);
  return result;
}

export async function runCliExpectFailure(
  home: string,
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const result = await invokeCli(home, args, envOverrides);
  expect(result.exitCode, result.output).not.toBe(0);
  return result;
}

export async function invokeCli(
  home: string,
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
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
      NO_COLOR: "1",
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
  return { exitCode, stdout, stderr, output: stdout + stderr };
}

export async function pollCli(
  home: string,
  args: string[],
  done: (result: CliResult) => boolean,
  timeoutMs = 15_000,
  envOverrides: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const deadline = Date.now() + timeoutMs;
  let latest: CliResult | undefined;
  while (Date.now() < deadline) {
    latest = await runCli(home, args, envOverrides);
    if (done(latest)) return latest;
    await Bun.sleep(250);
  }
  throw new Error(
    `Timed out polling CLI: ${args.join(" ")}\n${latest?.output ?? "no output"}`,
  );
}

export async function waitForNewBuild(
  home: string,
  jobUrl: string,
  previousNumber: number,
  envOverrides: Record<string, string | undefined> = {},
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
    15_000,
    envOverrides,
  );
  const payload = JSON.parse(result.stdout) as {
    data: { build: { url: string } };
  };
  return payload.data.build.url;
}

export function parseJson<T = Record<string, unknown>>(result: CliResult): T {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}
