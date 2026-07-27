export type NativeExecutableInvocation = {
  cmd: string[];
  env: Record<string, string | undefined>;
};

/**
 * Bun on Windows can lose the output of another compiled Bun executable when
 * it is spawned directly. Route the executable through the same native
 * PowerShell host used by GitHub Actions so stdout, stderr, and the exit code
 * remain observable.
 */
export function nativeExecutableInvocation(
  executable: string,
  args: string[],
  env: Record<string, string | undefined>,
): NativeExecutableInvocation {
  if (process.platform !== "win32") {
    return {
      cmd: [executable, ...args],
      env,
    };
  }

  const powershell =
    Bun.which("pwsh.exe") ?? Bun.which("powershell.exe") ?? "powershell.exe";
  return {
    cmd: [
      powershell,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$stdoutPath = [IO.Path]::GetTempFileName()",
        "$stderrPath = [IO.Path]::GetTempFileName()",
        "$cliExitCode = 1",
        "try {",
        "if (-not (Test-Path -LiteralPath $env:JENKINS_CLI_TEST_EXECUTABLE -PathType Leaf)) { throw 'CLI executable does not exist' }",
        "[string[]]$cliArgs = @(ConvertFrom-Json $env:JENKINS_CLI_TEST_ARGUMENTS)",
        "& $env:JENKINS_CLI_TEST_EXECUTABLE @cliArgs 1> $stdoutPath 2> $stderrPath",
        "$cliExitCode = $LASTEXITCODE",
        "if ($null -eq $cliExitCode) { throw 'CLI process did not report an exit code' }",
        "[Console]::Out.Write([IO.File]::ReadAllText($stdoutPath))",
        "[Console]::Error.Write([IO.File]::ReadAllText($stderrPath))",
        "} catch { [Console]::Error.WriteLine($_.Exception.Message) }",
        "finally { Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue }",
        "exit $cliExitCode",
      ].join("\n"),
    ],
    env: {
      ...env,
      JENKINS_CLI_TEST_EXECUTABLE: executable,
      JENKINS_CLI_TEST_ARGUMENTS: JSON.stringify(args),
    },
  };
}
