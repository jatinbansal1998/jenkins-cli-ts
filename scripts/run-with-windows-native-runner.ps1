param()

$ErrorActionPreference = "Stop"
$Command = @($args)
if ($Command.Count -eq 0) {
  throw "A command is required."
}
$ProtocolVersion = 1
$RunnerScript = Join-Path $PSScriptRoot "windows-native-runner.ps1"
$QueueRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  [IO.Path]::GetTempPath()
} else {
  $env:RUNNER_TEMP
}
$QueueDirectory = Join-Path $QueueRoot "jenkins-cli-native-runner-$([guid]::NewGuid().ToString('N'))"
$RunnerToken = [guid]::NewGuid().ToString("N")
$EnvironmentNames = @(
  "JENKINS_CLI_NATIVE_RUNNER_DIR",
  "JENKINS_CLI_NATIVE_RUNNER_TOKEN",
  "JENKINS_CLI_NATIVE_RUNNER_PROTOCOL"
)
$PreviousEnvironment = @{}
$RunnerProcess = $null
$CommandExitCode = 1

foreach ($name in $EnvironmentNames) {
  $PreviousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
  New-Item -ItemType Directory -Force -Path $QueueDirectory | Out-Null
  $env:JENKINS_CLI_NATIVE_RUNNER_DIR = $QueueDirectory
  $env:JENKINS_CLI_NATIVE_RUNNER_TOKEN = $RunnerToken
  $env:JENKINS_CLI_NATIVE_RUNNER_PROTOCOL = [string]$ProtocolVersion

  $PowerShellPath = (Get-Process -Id $PID).Path
  $RunnerArguments = "-NoLogo -NoProfile -NonInteractive -File `"$RunnerScript`""
  $RunnerProcess = Start-Process `
    -FilePath $PowerShellPath `
    -ArgumentList $RunnerArguments `
    -PassThru `
    -NoNewWindow

  $ReadyPath = Join-Path $QueueDirectory "ready.json"
  $ReadyDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $ReadyPath)) {
    $RunnerProcess.Refresh()
    if ($RunnerProcess.HasExited) {
      throw "Windows native runner exited before becoming ready."
    }
    if ([DateTime]::UtcNow -ge $ReadyDeadline) {
      throw "Timed out waiting for the Windows native runner to become ready."
    }
    Start-Sleep -Milliseconds 25
  }

  $Ready = Get-Content -LiteralPath $ReadyPath -Raw | ConvertFrom-Json
  if ($Ready.protocolVersion -ne $ProtocolVersion) {
    throw "Windows native runner reported an unsupported protocol version."
  }

  $Executable = $Command[0]
  $CommandArguments = @($Command | Select-Object -Skip 1)
  & $Executable @CommandArguments
  if ($null -ne $LASTEXITCODE) {
    $CommandExitCode = $LASTEXITCODE
  } elseif ($?) {
    $CommandExitCode = 0
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $CommandExitCode = 1
} finally {
  if ($null -ne $RunnerProcess) {
    try {
      $StopPath = Join-Path $QueueDirectory "stop"
      $TemporaryStopPath = "$StopPath.tmp"
      [IO.File]::WriteAllText(
        $TemporaryStopPath,
        $RunnerToken,
        [Text.UTF8Encoding]::new($false)
      )
      Move-Item -LiteralPath $TemporaryStopPath -Destination $StopPath
      if (-not $RunnerProcess.WaitForExit(5000)) {
        Stop-Process -Id $RunnerProcess.Id -Force -ErrorAction SilentlyContinue
        $RunnerProcess.WaitForExit()
      }
    } catch {
      Stop-Process -Id $RunnerProcess.Id -Force -ErrorAction SilentlyContinue
    } finally {
      $RunnerProcess.Dispose()
    }
  }

  foreach ($name in $EnvironmentNames) {
    $previousValue = $PreviousEnvironment[$name]
    if ($null -eq $previousValue) {
      [Environment]::SetEnvironmentVariable($name, $null, "Process")
    } else {
      [Environment]::SetEnvironmentVariable($name, $previousValue, "Process")
    }
  }
  Remove-Item -LiteralPath $QueueDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

exit $CommandExitCode
