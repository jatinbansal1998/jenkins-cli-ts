import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runNativeExecutable } from "../../helpers.native-executable";

export const jenkinsUrl = process.env.JENKINS_INTEGRATION_URL;
export const integrationEnabled = Boolean(jenkinsUrl);
const requestedIntegrationCliPath =
  process.env.JENKINS_INTEGRATION_CLI_PATH?.trim();
export const integrationCliExecutable = requestedIntegrationCliPath
  ? resolve(requestedIntegrationCliPath)
  : resolve(
      "dist",
      process.platform === "win32" ? "jenkins-cli.exe" : "jenkins-cli",
    );

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
const EXPECT_STEP_TIMEOUT_MS = 20_000;
const EXPECT_WRAPPER_BUFFER_MS = 5_000;

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
  text: string;
  input: string;
};

export async function observeInteractiveCli(
  home: string,
  args: string[],
  steps: InteractiveStep[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<Omit<CliResult, "exitCode">> {
  if (process.platform === "win32") {
    throw new Error(
      "Interactive Jenkins integration scenarios require a POSIX pseudo-terminal and are not supported on Windows.",
    );
  }
  const interactiveCommand = [
    "stty cols 120 rows 40",
    `exec ${[integrationCliExecutable, ...args].map(shellEscape).join(" ")}`,
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
  let transcript = "";
  const stdoutPump = collectStream(subprocess.stdout, (chunk) => {
    stdout += chunk;
    transcript += chunk;
  });
  const stderrPump = collectStream(subprocess.stderr, (chunk) => {
    stderr += chunk;
    transcript += chunk;
  });
  let stdinEnded = false;
  const endStdin = () => {
    if (stdinEnded) return;
    stdinEnded = true;
    subprocess.stdin.end();
  };

  try {
    if (!useMacOsExpect) {
      // Consume complete semantic lines in arrival order. A step therefore
      // cannot match a phrase inside an earlier line or a partially rendered
      // prompt, and repeated text requires an intervening synchronization line.
      let scannedUpTo = 0;
      for (const step of steps) {
        scannedUpTo = await waitForInteractiveLine(
          () => stripTerminalCodes(transcript),
          step.text,
          subprocess,
          scannedUpTo,
        );
        subprocess.stdin.write(step.input);
        subprocess.stdin.flush();
      }
    }
    if (useMacOsExpect) {
      const exitCode = await waitForExpectExit(
        subprocess,
        () => stripTerminalCodes(transcript),
        steps.length * EXPECT_STEP_TIMEOUT_MS + EXPECT_WRAPPER_BUFFER_MS,
      );
      if (exitCode !== 0) {
        throw new Error(
          `macOS Expect exited with code ${exitCode}.\n${stripTerminalCodes(transcript)}`,
        );
      }
    } else {
      endStdin();
      if (subprocess.exitCode === null) subprocess.kill();
      await subprocess.exited;
    }
    await Promise.all([stdoutPump, stderrPump]);
    return {
      stdout,
      stderr,
      output: stripTerminalCodes(transcript),
    };
  } catch (error) {
    endStdin();
    if (subprocess.exitCode === null) {
      subprocess.kill();
    }
    await subprocess.exited;
    await Promise.all([stdoutPump, stderrPump]);
    throw error;
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
  return invokeCliExecutable(
    home,
    integrationCliExecutable,
    args,
    envOverrides,
  );
}

export async function invokeCliAndInterrupt(
  home: string,
  args: string[],
  waitForOutput: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const subprocess = Bun.spawn({
    cmd: [
      integrationCliExecutable,
      ...args,
      "--non-interactive",
      "--no-banner",
    ],
    env: cliEnv(home, envOverrides),
    stdin: "ignore",
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
  const deadline = Date.now() + 20_000;
  while (!(stdout + stderr).includes(waitForOutput)) {
    if (subprocess.exitCode !== null) {
      throw new Error(
        `CLI exited before interruption marker "${waitForOutput}".\n${stdout}${stderr}`,
      );
    }
    if (Date.now() >= deadline) {
      subprocess.kill();
      throw new Error(
        `Timed out waiting for interruption marker "${waitForOutput}".\n${stdout}${stderr}`,
      );
    }
    await Bun.sleep(20);
  }
  await Bun.sleep(250);
  subprocess.kill("SIGINT");
  const exitCode = await subprocess.exited;
  await Promise.all([stdoutPump, stderrPump]);
  return { exitCode, stdout, stderr, output: stdout + stderr };
}

export async function invokeCliExecutable(
  home: string,
  executable: string,
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const result = await runNativeExecutable({
    executable,
    args: [...args, "--non-interactive", "--no-banner"],
    env: cliEnv(home, envOverrides),
  });
  return { ...result, output: result.stdout + result.stderr };
}

function cliEnv(
  home: string,
  envOverrides: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: home,
    ...(process.platform === "win32"
      ? {
          USERPROFILE: home,
          LOCALAPPDATA: join(home, "AppData", "Local"),
          APPDATA: join(home, "AppData", "Roaming"),
        }
      : {}),
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

/**
 * Waits for a complete semantic line after `scannedUpTo` and returns the
 * offset to resume scanning from.
 */
async function waitForInteractiveLine(
  output: () => string,
  text: string,
  subprocess: ReturnType<typeof Bun.spawn>,
  scannedUpTo: number,
): Promise<number> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pending = output().slice(scannedUpTo);
    const offset = completedLineEnd(pending, text);
    if (offset !== null) {
      return scannedUpTo + offset;
    }
    if (subprocess.exitCode !== null) {
      throw new Error(
        `Interactive CLI exited before line "${text}".\n${output()}`,
      );
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for line "${text}".\n${output()}`);
}

export function completedLineEnd(pending: string, text: string): number | null {
  let lineStart = 0;
  while (lineStart < pending.length) {
    const newline = pending.indexOf("\n", lineStart);
    if (newline === -1) return null;
    const line = pending.slice(lineStart, newline);
    if (line === text || line.endsWith(`  ${text}`)) {
      return newline + 1;
    }
    lineStart = newline + 1;
  }
  return null;
}

async function waitForExpectExit(
  subprocess: ReturnType<typeof Bun.spawn>,
  output: () => string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (subprocess.exitCode === null && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  if (subprocess.exitCode === null) {
    throw new Error(
      `Timed out waiting for macOS Expect to finish.\n${output()}`,
    );
  }
  return subprocess.exited;
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

export function macOsExpectScript(
  interactiveCommand: string,
  steps: InteractiveStep[],
  env: Record<string, string | undefined>,
): string {
  env.JENKINS_CLI_EXPECT_COMMAND = interactiveCommand;
  env.JENKINS_CLI_EXPECT_STEP_COUNT = String(steps.length);
  for (const [index, step] of steps.entries()) {
    env[`JENKINS_CLI_EXPECT_TEXT_${index}`] = step.text;
    env[`JENKINS_CLI_EXPECT_INPUT_${index}`] = step.input;
  }
  return `
set timeout ${EXPECT_STEP_TIMEOUT_MS / 1_000}
spawn -noecho /bin/sh -c $env(JENKINS_CLI_EXPECT_COMMAND)
for {set index 0} {$index < $env(JENKINS_CLI_EXPECT_STEP_COUNT)} {incr index} {
  set textKey [format "JENKINS_CLI_EXPECT_TEXT_%d" $index]
  set inputKey [format "JENKINS_CLI_EXPECT_INPUT_%d" $index]
  expect {
    -exact "$env($textKey)\\r\\n" {}
    -exact "$env($textKey)\\n" {}
    eof {
      puts stderr "Interactive CLI exited before text \\"$env($textKey)\\"."
      exit 97
    }
    timeout {
      puts stderr "Timed out waiting for text \\"$env($textKey)\\"."
      exit 98
    }
  }
  send -- $env($inputKey)
}
catch close
catch wait
exit 0
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
