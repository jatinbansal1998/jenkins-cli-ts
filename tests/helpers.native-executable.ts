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
        "try {",
        "if (-not (Test-Path -LiteralPath $env:JENKINS_CLI_TEST_EXECUTABLE -PathType Leaf)) { throw 'CLI executable does not exist' }",
        "[string[]]$cliArgs = @(ConvertFrom-Json $env:JENKINS_CLI_TEST_ARGUMENTS)",
        "& $env:JENKINS_CLI_TEST_EXECUTABLE @cliArgs",
        "$cliExitCode = $LASTEXITCODE",
        "if ($null -eq $cliExitCode) { throw 'CLI process did not report an exit code' }",
        "exit $cliExitCode",
        "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
      ].join("; "),
    ],
    env: {
      ...env,
      JENKINS_CLI_TEST_EXECUTABLE: executable,
      JENKINS_CLI_TEST_ARGUMENTS: JSON.stringify(args),
    },
  };
}
