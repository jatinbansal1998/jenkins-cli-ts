import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type NativeExecutableResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type NativeExecutableOptions = {
  executable: string;
  args: string[];
  env: Record<string, string | undefined>;
};

/**
 * Bun-managed pipes can report EPIPE to another compiled Bun executable on
 * Windows. The CLI deliberately treats EPIPE as a successful early exit, which
 * makes the child appear to have produced no output. Give the child real file
 * handles on Windows, then read the captured output after it exits.
 */
export function runNativeExecutableSync(
  options: NativeExecutableOptions,
): NativeExecutableResult {
  if (process.platform !== "win32") {
    const result = Bun.spawnSync({
      cmd: [options.executable, ...options.args],
      env: options.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  }

  return withOutputFiles((stdout, stderr) => {
    const result = Bun.spawnSync({
      cmd: [options.executable, ...options.args],
      env: options.env,
      stdout,
      stderr,
    });
    return result.exitCode;
  });
}

export async function runNativeExecutable(
  options: NativeExecutableOptions,
): Promise<NativeExecutableResult> {
  if (process.platform !== "win32") {
    const subprocess = Bun.spawn({
      cmd: [options.executable, ...options.args],
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

  return await withOutputFilesAsync(async (stdout, stderr) => {
    const subprocess = Bun.spawn({
      cmd: [options.executable, ...options.args],
      env: options.env,
      stdout,
      stderr,
    });
    return await subprocess.exited;
  });
}

function withOutputFiles(
  run: (stdout: number, stderr: number) => number,
): NativeExecutableResult {
  const capture = openOutputFiles();
  try {
    const exitCode = run(capture.stdout, capture.stderr);
    capture.closed = true;
    closeOutputFiles(capture);
    return readOutputFiles(capture.directory, exitCode);
  } finally {
    if (!capture.closed) {
      closeOutputFiles(capture);
    }
    rmSync(capture.directory, { recursive: true, force: true });
  }
}

async function withOutputFilesAsync(
  run: (stdout: number, stderr: number) => Promise<number>,
): Promise<NativeExecutableResult> {
  const capture = openOutputFiles();
  try {
    const exitCode = await run(capture.stdout, capture.stderr);
    capture.closed = true;
    closeOutputFiles(capture);
    return readOutputFiles(capture.directory, exitCode);
  } finally {
    if (!capture.closed) {
      closeOutputFiles(capture);
    }
    rmSync(capture.directory, { recursive: true, force: true });
  }
}

function openOutputFiles(): {
  directory: string;
  stdout: number;
  stderr: number;
  closed: boolean;
} {
  const directory = mkdtempSync(join(tmpdir(), "jenkins-cli-output-"));
  let stdout: number | undefined;
  try {
    stdout = openSync(join(directory, "stdout"), "w");
    return {
      directory,
      stdout,
      stderr: openSync(join(directory, "stderr"), "w"),
      closed: false,
    };
  } catch (error) {
    if (stdout !== undefined) closeSync(stdout);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function closeOutputFiles(capture: { stdout: number; stderr: number }): void {
  let firstError: unknown;
  for (const descriptor of [capture.stdout, capture.stderr]) {
    try {
      closeSync(descriptor);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

function readOutputFiles(
  directory: string,
  exitCode: number,
): NativeExecutableResult {
  return {
    exitCode,
    stdout: readFileSync(join(directory, "stdout"), "utf8"),
    stderr: readFileSync(join(directory, "stderr"), "utf8"),
  };
}
