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

export async function runNativeExecutable(
  options: NativeExecutableOptions,
): Promise<NativeExecutableResult> {
  if (process.platform === "win32") {
    throw new Error(
      "Windows native executables must be validated by the windows-jenkins-acceptance composite action.",
    );
  }

  const subprocess = Bun.spawn({
    cmd: [options.executable, ...options.args],
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
