import { copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 3 * 60_000;

export type NativeExecutableResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type NativeExecutableOptions = {
  executable: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
};

type NativeRunnerResponse = NativeExecutableResult & {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  timedOut: boolean;
};

export async function runNativeExecutable(
  options: NativeExecutableOptions,
): Promise<NativeExecutableResult> {
  if (process.platform !== "win32") {
    return await runWithBunPipes(options);
  }

  const runnerDirectory = process.env.JENKINS_CLI_NATIVE_RUNNER_DIR?.trim();
  const runnerToken = process.env.JENKINS_CLI_NATIVE_RUNNER_TOKEN?.trim();
  const runnerProtocol = process.env.JENKINS_CLI_NATIVE_RUNNER_PROTOCOL?.trim();
  const configuredParts = [runnerDirectory, runnerToken, runnerProtocol].filter(
    Boolean,
  ).length;
  if (configuredParts > 0 && configuredParts < 3) {
    throw new Error(
      "Windows native runner configuration is incomplete. Run this command through scripts/run-with-windows-native-runner.ps1.",
    );
  }
  if (runnerDirectory && runnerToken && runnerProtocol) {
    if (Number(runnerProtocol) !== PROTOCOL_VERSION) {
      throw new Error(
        `Unsupported Windows native runner protocol version: ${runnerProtocol}`,
      );
    }
    return await runWindowsExecutableCopy(options, async (executable) => {
      return await runThroughWindowsSidecar(
        { ...options, executable },
        {
          directory: runnerDirectory,
          token: runnerToken,
        },
      );
    });
  }
  throw new Error(
    "Windows compiled-executable tests must run through scripts/run-with-windows-native-runner.ps1.",
  );
}

async function runWindowsExecutableCopy(
  options: NativeExecutableOptions,
  run: (executable: string) => Promise<NativeExecutableResult>,
): Promise<NativeExecutableResult> {
  const directory = await mkdtemp(
    join(tmpdir(), "jenkins-cli-windows-executable-"),
  );
  const executable = join(directory, basename(options.executable));
  try {
    // A Bun-compiled executable can exit without running when launched from the
    // original output file on Windows. The same bytes execute correctly after
    // a normal filesystem copy, which also matches downloaded release assets.
    await copyFile(options.executable, executable);
    return await run(executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runWithBunPipes(
  options: NativeExecutableOptions,
): Promise<NativeExecutableResult> {
  const subprocess = Bun.spawn({
    cmd: [options.executable, ...options.args],
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runThroughWindowsSidecar(
  options: NativeExecutableOptions,
  runner: { directory: string; token: string },
): Promise<NativeExecutableResult> {
  const ready = (await Bun.file(
    join(runner.directory, "ready.json"),
  ).json()) as {
    protocolVersion?: number;
  };
  if (ready.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Windows native runner is not ready.");
  }

  const requestId = crypto.randomUUID();
  const requestPath = join(runner.directory, `request-${requestId}.json`);
  const temporaryRequestPath = `${requestPath}.${process.pid}.tmp`;
  const responsePath = join(runner.directory, `response-${requestId}.json`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const request = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    token: runner.token,
    executable: options.executable,
    args: options.args,
    env: Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !entry[0].startsWith("JENKINS_CLI_NATIVE_RUNNER_"),
      ),
    ),
    cwd: options.cwd ?? process.cwd(),
    timeoutMs,
  };

  try {
    await Bun.write(temporaryRequestPath, JSON.stringify(request));
    await rename(temporaryRequestPath, requestPath);
    const deadline = Date.now() + timeoutMs + 15_000;
    while (Date.now() < deadline) {
      if (await Bun.file(responsePath).exists()) {
        const response = (await Bun.file(
          responsePath,
        ).json()) as NativeRunnerResponse;
        if (
          response.protocolVersion !== PROTOCOL_VERSION ||
          response.requestId !== requestId
        ) {
          throw new Error(
            "Windows native runner returned an invalid response.",
          );
        }
        if (!response.ok) {
          throw new Error(response.stderr || "Windows native runner failed.");
        }
        return {
          exitCode: response.exitCode,
          stdout: response.stdout,
          stderr: response.stderr,
        };
      }
      if (!(await Bun.file(join(runner.directory, "ready.json")).exists())) {
        throw new Error(
          "Windows native runner stopped before returning a response.",
        );
      }
      await Bun.sleep(10);
    }
    throw new Error(
      `Timed out waiting for Windows native runner response ${requestId}.`,
    );
  } finally {
    await Promise.all([
      rm(temporaryRequestPath, { force: true }),
      rm(requestPath, { force: true }),
      rm(responsePath, { force: true }),
    ]);
  }
}
