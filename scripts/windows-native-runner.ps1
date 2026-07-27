param()

$ErrorActionPreference = "Stop"
$ProtocolVersion = 1
$QueueDirectory = $env:JENKINS_CLI_NATIVE_RUNNER_DIR
$RunnerToken = $env:JENKINS_CLI_NATIVE_RUNNER_TOKEN

if ([string]::IsNullOrWhiteSpace($QueueDirectory)) {
  throw "JENKINS_CLI_NATIVE_RUNNER_DIR is required."
}
if ([string]::IsNullOrWhiteSpace($RunnerToken)) {
  throw "JENKINS_CLI_NATIVE_RUNNER_TOKEN is required."
}

$Utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
$ReadyPath = Join-Path $QueueDirectory "ready.json"
$StopPath = Join-Path $QueueDirectory "stop"

function Test-StopRequested {
  if (-not (Test-Path -LiteralPath $StopPath -PathType Leaf)) {
    return $false
  }
  try {
    if ((Get-Content -LiteralPath $StopPath -Raw) -ceq $RunnerToken) {
      return $true
    }
  } catch {
    # The wrapper may still be finishing its small stop file.
    return $false
  }
  Remove-Item -LiteralPath $StopPath -Force -ErrorAction SilentlyContinue
  return $false
}

function Write-AtomicJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [object]$Value
  )

  $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  $json = $Value | ConvertTo-Json -Compress -Depth 8
  [IO.File]::WriteAllText($temporaryPath, $json, $Utf8WithoutBom)
  Move-Item -LiteralPath $temporaryPath -Destination $Path
}

function Invoke-NativeRequest {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Request
  )

  if ($Request.protocolVersion -ne $ProtocolVersion) {
    throw "Unsupported native runner protocol version."
  }
  if ($Request.token -cne $RunnerToken) {
    throw "Invalid native runner token."
  }
  if ([string]::IsNullOrWhiteSpace([string]$Request.executable)) {
    throw "Native runner request is missing an executable."
  }
  if (-not (Test-Path -LiteralPath $Request.executable -PathType Leaf)) {
    throw "Native executable does not exist: $($Request.executable)"
  }

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = [string]$Request.executable
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  if (-not [string]::IsNullOrWhiteSpace([string]$Request.cwd)) {
    $startInfo.WorkingDirectory = [string]$Request.cwd
  }

  foreach ($argument in @($Request.args)) {
    $startInfo.ArgumentList.Add([string]$argument)
  }

  $startInfo.Environment.Clear()
  foreach ($property in $Request.env.PSObject.Properties) {
    $startInfo.Environment[$property.Name] = [string]$property.Value
  }

  $timeoutMs = [Math]::Max(1, [int]$Request.timeoutMs)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw "The native process did not start."
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($timeoutMs)
    if ($timedOut) {
      try {
        $process.Kill($true)
      } catch {
        # The process may have exited between the timeout and the kill call.
      }
    }
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($timedOut) {
      $stderr += "Windows native runner timed out after $timeoutMs ms.`n"
    }
    return @{
      exitCode = if ($timedOut) { 124 } else { $process.ExitCode }
      stdout = $stdout
      stderr = $stderr
      timedOut = $timedOut
    }
  } finally {
    $process.Dispose()
  }
}

New-Item -ItemType Directory -Force -Path $QueueDirectory | Out-Null
try {
  Write-AtomicJson -Path $ReadyPath -Value @{
    protocolVersion = $ProtocolVersion
    processId = $PID
  }

  while (-not (Test-StopRequested)) {
    $requests = @(Get-ChildItem -LiteralPath $QueueDirectory -Filter "request-*.json" -File)
    if ($requests.Count -eq 0) {
      Start-Sleep -Milliseconds 10
      continue
    }

    foreach ($requestFile in $requests) {
      $requestId = $requestFile.BaseName.Substring("request-".Length)
      $processingPath = Join-Path $QueueDirectory "processing-$requestId.json"
      $responsePath = Join-Path $QueueDirectory "response-$requestId.json"
      try {
        Move-Item -LiteralPath $requestFile.FullName -Destination $processingPath
      } catch {
        continue
      }

      $response = @{
        protocolVersion = $ProtocolVersion
        requestId = $requestId
        ok = $false
        exitCode = 1
        stdout = ""
        stderr = ""
        timedOut = $false
      }
      try {
        $request = Get-Content -LiteralPath $processingPath -Raw | ConvertFrom-Json
        if ([string]$request.requestId -cne $requestId) {
          throw "Native runner request ID does not match its filename."
        }
        $result = Invoke-NativeRequest -Request $request
        $response.ok = $true
        $response.exitCode = $result.exitCode
        $response.stdout = $result.stdout
        $response.stderr = $result.stderr
        $response.timedOut = $result.timedOut
      } catch {
        $response.stderr = "Windows native runner failed: $($_.Exception.Message)"
      } finally {
        Remove-Item -LiteralPath $processingPath -Force -ErrorAction SilentlyContinue
      }
      Write-AtomicJson -Path $responsePath -Value $response
    }
  }
} finally {
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
}
