import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

const OSC_TERMINAL_SEQUENCE = new RegExp(
  String.raw`\u001B\][^\u0007]*(?:\u0007|\u001B\\)`,
  "g",
);
const CSI_TERMINAL_SEQUENCE = new RegExp(
  String.raw`\u001B\[[0-?]*[ -/]*[@-~]`,
  "g",
);

export async function withCliHome(
  action: (home: string) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "jenkins-cli-integration-home-"));
  configureMacOsTestKeychain(home);
  try {
    await action(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export type InteractiveStep = {
  prompt: string;
  input: string;
};

export async function runInteractiveCli(
  home: string,
  args: string[],
  steps: InteractiveStep[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const executable = resolve(
    "dist",
    process.platform === "win32" ? "jenkins-cli.exe" : "jenkins-cli",
  );
  const interactiveCommand = [
    "stty cols 120 rows 40",
    `exec ${[executable, ...args].map(shellEscape).join(" ")}`,
  ].join("; ");
  const useMacOsExpect = process.platform === "darwin";
  const env = cliEnv(home, envOverrides);
  const command = useMacOsExpect
    ? [
        "/usr/bin/expect",
        "-c",
        macOsExpectScript(interactiveCommand, steps, env),
      ]
    : ["script", "-qefc", interactiveCommand, "/dev/null"];
  const subprocess = Bun.spawn({
    cmd: command,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  let stderr = "";
  const stdoutPump = collectStream(subprocess.stdout, (chunk) => {
    stdout += chunk;
  });
  const stderrPump = collectStream(subprocess.stderr, (chunk) => {
    stderr += chunk;
  });

  if (!useMacOsExpect) {
    for (const step of steps) {
      await waitForInteractivePrompt(
        () => stripTerminalCodes(stdout + stderr),
        step.prompt,
        subprocess,
      );
      subprocess.stdin.write(step.input);
      subprocess.stdin.flush();
    }
  }
  subprocess.stdin.end();

  const exitCode = await subprocess.exited;
  await Promise.all([stdoutPump, stderrPump]);
  return {
    exitCode,
    stdout,
    stderr,
    output: stripTerminalCodes(stdout + stderr),
  };
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
    env: cliEnv(home, envOverrides),
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

function cliEnv(
  home: string,
  envOverrides: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: home,
    JENKINS_URL: jenkinsUrl,
    JENKINS_USER: process.env.JENKINS_INTEGRATION_USER,
    JENKINS_API_TOKEN: process.env.JENKINS_INTEGRATION_TOKEN,
    JENKINS_ANALYTICS_DISABLED: "true",
    NO_COLOR: "1",
    ...envOverrides,
  };
}

function configureMacOsTestKeychain(home: string): void {
  const keychain = process.env.JENKINS_CLI_TEST_KEYCHAIN;
  if (process.platform !== "darwin" || !keychain) {
    return;
  }
  mkdirSync(join(home, "Library", "Preferences"), { recursive: true });
  for (const args of [
    ["list-keychains", "-d", "user", "-s", keychain],
    ["default-keychain", "-d", "user", "-s", keychain],
  ]) {
    const result = Bun.spawnSync({
      cmd: ["/usr/bin/security", ...args],
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not configure the macOS test keychain: ${new TextDecoder().decode(result.stderr).trim()}`,
      );
    }
  }
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  append: (chunk: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    append(decoder.decode(value, { stream: true }));
  }
  append(decoder.decode());
}

async function waitForInteractivePrompt(
  output: () => string,
  prompt: string,
  subprocess: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (
      output()
        .split("\n")
        .some(
          (line) =>
            line.startsWith(`◆  ${prompt}`) || line.startsWith(`*  ${prompt}`),
        )
    ) {
      return;
    }
    if (subprocess.exitCode !== null) {
      throw new Error(
        `Interactive CLI exited before prompt "${prompt}".\n${output()}`,
      );
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for prompt "${prompt}".\n${output()}`);
}

function stripTerminalCodes(value: string): string {
  return value
    .replace(OSC_TERMINAL_SEQUENCE, "")
    .replace(CSI_TERMINAL_SEQUENCE, "")
    .replace(/\r/g, "");
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function macOsExpectScript(
  interactiveCommand: string,
  steps: InteractiveStep[],
  env: Record<string, string | undefined>,
): string {
  env.JENKINS_CLI_EXPECT_COMMAND = interactiveCommand;
  env.JENKINS_CLI_EXPECT_STEP_COUNT = String(steps.length);
  for (const [index, step] of steps.entries()) {
    env[`JENKINS_CLI_EXPECT_PROMPT_${index}`] = step.prompt;
    env[`JENKINS_CLI_EXPECT_INPUT_${index}`] = step.input;
  }
  return `
set timeout 20
spawn -noecho /bin/sh -c $env(JENKINS_CLI_EXPECT_COMMAND)
for {set index 0} {$index < $env(JENKINS_CLI_EXPECT_STEP_COUNT)} {incr index} {
  set promptKey [format "JENKINS_CLI_EXPECT_PROMPT_%d" $index]
  set inputKey [format "JENKINS_CLI_EXPECT_INPUT_%d" $index]
  expect {
    -exact $env($promptKey) {}
    eof {
      puts stderr "Interactive CLI exited before prompt \\"$env($promptKey)\\"."
      exit 97
    }
    timeout {
      puts stderr "Timed out waiting for prompt \\"$env($promptKey)\\"."
      exit 98
    }
  }
  send -- $env($inputKey)
}
expect eof
set status [wait]
exit [lindex $status 3]
`.trim();
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
