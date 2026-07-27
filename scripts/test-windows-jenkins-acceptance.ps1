param(
  [Parameter(Mandatory = $true)]
  [string]$CliPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedTarget,
  [string]$ToolCache = (Join-Path $env:RUNNER_TEMP "jenkins-cli-integration-tools")
)

$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$CliExecutable = (Resolve-Path -LiteralPath $CliPath).Path
$RunId = [guid]::NewGuid().ToString("N")
$ManifestPath = Join-Path $env:RUNNER_TEMP "jenkins-cli-windows-$RunId.json"
$CliHome = Join-Path $env:RUNNER_TEMP "jenkins-cli-windows-home-$RunId"
$DownloadDirectory = Join-Path $env:RUNNER_TEMP "jenkins-cli-windows-artifacts-$RunId"
$ProfileName = "windows-acceptance-$RunId"
$Manifest = $null
$JenkinsProcess = $null
$LoggedIn = $false
$EnvironmentNames = @(
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "NO_COLOR",
  "JENKINS_ANALYTICS_DISABLED",
  "JENKINS_ERROR_REPORTING_DISABLED",
  "JENKINS_URL",
  "JENKINS_USER",
  "JENKINS_API_TOKEN",
  "TS_KEYRING_BACKEND",
  "JENKINS_INTEGRATION_TOOL_CACHE"
)
$PreviousEnvironment = @{}

function Assert-OutputContains {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Output,
    [Parameter(Mandatory = $true)]
    [string]$Expected,
    [Parameter(Mandatory = $true)]
    [string]$Context
  )

  if (-not $Output.Contains($Expected)) {
    throw "$Context did not contain '$Expected'.`n$Output"
  }
}

function Assert-AcceptanceCliExit {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ExitCode,
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Output,
    [Parameter(Mandatory = $true)]
    [string]$Context
  )

  if ($ExitCode -ne 0) {
    throw "$Context exited with $ExitCode.`n$Output"
  }
}

function Wait-ForToken {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [Diagnostics.Process]$Process
  )

  $deadline = [DateTime]::UtcNow.AddMinutes(4)
  while ([DateTime]::UtcNow -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "Jenkins exited during startup with code $($Process.ExitCode)."
    }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      $token = (Get-Content -LiteralPath $Path -Raw).Trim()
      if (-not [string]::IsNullOrWhiteSpace($token)) {
        return $token
      }
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Jenkins did not write the token file within 240 seconds."
}

function Wait-ForJenkins {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [string]$Token,
    [Parameter(Mandatory = $true)]
    [Diagnostics.Process]$Process
  )

  $credentials = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes("integration-test:$Token")
  )
  $deadline = [DateTime]::UtcNow.AddMinutes(4)
  $lastProblem = "Jenkins has not responded yet."
  while ([DateTime]::UtcNow -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "Jenkins exited during startup with code $($Process.ExitCode)."
    }
    try {
      $identity = Invoke-RestMethod `
        -Uri "$Url/whoAmI/api/json" `
        -Headers @{ Authorization = "Basic $credentials" } `
        -TimeoutSec 10
      if ($identity.authenticated) {
        return
      }
      $lastProblem = "Jenkins did not report an authenticated identity."
    } catch {
      $lastProblem = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Jenkins did not become ready within 240 seconds. $lastProblem"
}

foreach ($name in $EnvironmentNames) {
  $PreviousEnvironment[$name] = [Environment]::GetEnvironmentVariable(
    $name,
    "Process"
  )
}

try {
  New-Item -ItemType Directory -Force -Path $CliHome | Out-Null
  New-Item -ItemType Directory -Force -Path $DownloadDirectory | Out-Null

  # Bun-compiled Windows executables must be invoked directly from the Actions
  # PowerShell scope. Launching one from a function or child process can return
  # exit code 0 without running the CLI entrypoint.
  $identityNativeOutput = & $CliExecutable --version
  $identityExitCode = $LASTEXITCODE
  $identityOutput = ($identityNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit $identityExitCode $identityOutput "Version command"
  Assert-OutputContains $identityOutput $ExpectedVersion "Version output"
  Assert-OutputContains $identityOutput $ExpectedTarget "Version output"

  $helpNativeOutput = & $CliExecutable --help
  $helpExitCode = $LASTEXITCODE
  $helpOutput = ($helpNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit $helpExitCode $helpOutput "Help command"
  Assert-OutputContains $helpOutput "jenkins-cli" "Help output"

  $env:JENKINS_INTEGRATION_TOOL_CACHE = $ToolCache
  & bun scripts/test-jenkins-integration.ts --prepare-native $ManifestPath
  if ($LASTEXITCODE -ne 0) {
    throw "Native Jenkins preparation failed with exit code $LASTEXITCODE."
  }

  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if ($Manifest.schemaVersion -ne 1) {
    throw "Unsupported native Jenkins manifest version."
  }

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = [string]$Manifest.launch.executable
  $startInfo.WorkingDirectory = [string]$Manifest.launch.cwd
  $startInfo.UseShellExecute = $false
  foreach ($argument in @($Manifest.launch.args)) {
    $startInfo.ArgumentList.Add([string]$argument)
  }
  foreach ($property in $Manifest.launch.env.PSObject.Properties) {
    $startInfo.Environment[$property.Name] = [string]$property.Value
  }
  $JenkinsProcess = [Diagnostics.Process]::new()
  $JenkinsProcess.StartInfo = $startInfo
  try {
    if (-not $JenkinsProcess.Start()) {
      throw "The native Jenkins process did not start."
    }
  } catch {
    $JenkinsProcess.Dispose()
    $JenkinsProcess = $null
    throw
  }

  $adminToken = Wait-ForToken `
    -Path ([string]$Manifest.adminTokenFile) `
    -Process $JenkinsProcess
  Wait-ForJenkins `
    -Url ([string]$Manifest.jenkinsUrl) `
    -Token $adminToken `
    -Process $JenkinsProcess

  $env:HOME = $CliHome
  $env:USERPROFILE = $CliHome
  $env:LOCALAPPDATA = Join-Path $CliHome "AppData\Local"
  $env:APPDATA = Join-Path $CliHome "AppData\Roaming"
  $env:NO_COLOR = "1"
  $env:JENKINS_ANALYTICS_DISABLED = "true"
  $env:JENKINS_ERROR_REPORTING_DISABLED = "true"
  foreach ($name in @(
      "JENKINS_URL",
      "JENKINS_USER",
      "JENKINS_API_TOKEN",
      "TS_KEYRING_BACKEND"
    )) {
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
  }

  $LoggedIn = $true
  $loginNativeOutput = & $CliExecutable `
    "auth" `
    "login" `
    "--profile" `
    $ProfileName `
    "--url" `
    ([string]$Manifest.jenkinsUrl) `
    "--user" `
    "integration-test" `
    "--token" `
    $adminToken `
    "--non-interactive"
  $loginExitCode = $LASTEXITCODE
  $loginOutput = ($loginNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit `
    $loginExitCode `
    $loginOutput.Replace($adminToken, "<redacted>") `
    "Secure-store login"
  Assert-OutputContains `
    $loginOutput `
    "API token stored securely" `
    "Windows secure-store login"
  if ($loginOutput.Contains($adminToken)) {
    throw "Windows secure-store login exposed the Jenkins API token."
  }

  $configPath = Join-Path $CliHome ".config\jenkins-cli\jenkins-cli-config.json"
  $configText = Get-Content -LiteralPath $configPath -Raw
  if ($configText.Contains($adminToken)) {
    throw "The Jenkins API token was written to the CLI config."
  }
  $config = $configText | ConvertFrom-Json
  $profile = $config.profiles.PSObject.Properties[$ProfileName].Value
  if (
    $profile.jenkinsApiToken -cne "@keychain" -or
    $profile.tokenStorage -cne "keychain"
  ) {
    throw "The Windows profile was not backed by Credential Manager."
  }

  $currentNativeOutput = & $CliExecutable `
    "auth" `
    "current" `
    "--profile" `
    $ProfileName `
    "--non-interactive"
  $currentExitCode = $LASTEXITCODE
  $currentOutput = ($currentNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit $currentExitCode $currentOutput "auth current"
  Assert-OutputContains $currentOutput "Token present:    Yes" "auth current"
  Assert-OutputContains `
    $currentOutput `
    "Windows Credential Manager" `
    "auth current"

  $authStatusNativeOutput = & $CliExecutable `
    "auth" `
    "status" `
    "--profile" `
    $ProfileName `
    "--non-interactive"
  $authStatusExitCode = $LASTEXITCODE
  $authStatusOutput = ($authStatusNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit `
    $authStatusExitCode `
    $authStatusOutput `
    "auth status"
  Assert-OutputContains $authStatusOutput "Authenticated:    Yes" "auth status"
  Assert-OutputContains `
    $authStatusOutput `
    "Jenkins user:     integration-test" `
    "auth status"

  $listNativeOutput = & $CliExecutable `
    "list" `
    "--refresh" `
    "--json" `
    "--profile" `
    $ProfileName
  $listExitCode = $LASTEXITCODE
  $listOutput = ($listNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit $listExitCode $listOutput "Job list"
  $listPayload = $listOutput | ConvertFrom-Json
  if ("cli-structured" -notin @($listPayload.data.name)) {
    throw "Real Jenkins job discovery did not return cli-structured."
  }

  $marker = "windows-acceptance-$RunId"
  $jobUrl = "$($Manifest.jenkinsUrl)/job/cli-structured/"
  $buildNativeOutput = & $CliExecutable `
    "build" `
    "--job-url" `
    $jobUrl `
    "--param" `
    "MESSAGE=$marker" `
    "--watch" `
    "--json" `
    "--profile" `
    $ProfileName
  $buildExitCode = $LASTEXITCODE
  $buildOutput = ($buildNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit $buildExitCode $buildOutput "Build command"
  $buildPayload = $buildOutput | ConvertFrom-Json
  if ($buildPayload.data.result -cne "SUCCESS") {
    throw "The Windows acceptance build did not succeed.`n$buildOutput"
  }
  $buildUrl = [string]$buildPayload.data.buildUrl
  if ([string]::IsNullOrWhiteSpace($buildUrl)) {
    throw "The Windows acceptance build did not return a build URL."
  }

  $buildStatusNativeOutput = & $CliExecutable `
    "status" `
    "--build-url" `
    $buildUrl `
    "--json" `
    "--profile" `
    $ProfileName
  $buildStatusExitCode = $LASTEXITCODE
  $buildStatusOutput = ($buildStatusNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit `
    $buildStatusExitCode `
    $buildStatusOutput `
    "Exact-build status"
  $statusPayload = $buildStatusOutput | ConvertFrom-Json
  if ($statusPayload.data.build.result -cne "SUCCESS") {
    throw "Exact-build status did not report SUCCESS."
  }

  $logsNativeOutput = & $CliExecutable `
    "logs" `
    "--build-url" `
    $buildUrl `
    "--no-follow" `
    "--profile" `
    $ProfileName `
    "--non-interactive"
  $logsExitCode = $LASTEXITCODE
  $logsOutput = ($logsNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit $logsExitCode $logsOutput "Exact-build logs"
  Assert-OutputContains $logsOutput "structured:$marker" "Exact-build logs"

  $artifactsNativeOutput = & $CliExecutable `
    "artifacts" `
    "--build-url" `
    $buildUrl `
    "--json" `
    "--profile" `
    $ProfileName
  $artifactsExitCode = $LASTEXITCODE
  $artifactsOutput = ($artifactsNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit `
    $artifactsExitCode `
    $artifactsOutput `
    "Exact-build artifacts"
  Assert-OutputContains `
    $artifactsOutput `
    "structured-artifact.txt" `
    "Exact-build artifacts"

  $artifactDownloadNativeOutput = & $CliExecutable `
    "artifacts" `
    "--build-url" `
    $buildUrl `
    "--download" `
    "--dest" `
    $DownloadDirectory `
    "--profile" `
    $ProfileName `
    "--non-interactive"
  $artifactDownloadExitCode = $LASTEXITCODE
  $artifactDownloadOutput = ($artifactDownloadNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit `
    $artifactDownloadExitCode `
    $artifactDownloadOutput `
    "Exact-build artifact download"
  $downloadedArtifact = Join-Path $DownloadDirectory "structured-artifact.txt"
  if (
    -not (Test-Path -LiteralPath $downloadedArtifact -PathType Leaf) -or
    -not (Get-Content -LiteralPath $downloadedArtifact -Raw).Contains(
      "structured-artifact"
    )
  ) {
    throw "The exact-build artifact was not downloaded correctly."
  }

  $logoutNativeOutput = & $CliExecutable `
    "auth" `
    "logout" `
    "--profile" `
    $ProfileName `
    "--non-interactive"
  $logoutExitCode = $LASTEXITCODE
  $logoutOutput = ($logoutNativeOutput | Out-String).Trim()
  Assert-AcceptanceCliExit $logoutExitCode $logoutOutput "Credential logout"
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $configAfterLogout =
      Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($configAfterLogout.profiles.PSObject.Properties.Name -contains $ProfileName) {
      throw "Windows Credential Manager cleanup left the acceptance profile configured."
    }
  }
  $LoggedIn = $false
  Write-Host "Windows CLI, Credential Manager, and real Jenkins acceptance passed."
} finally {
  if ($LoggedIn) {
    try {
      $cleanupLogoutNativeOutput = & $CliExecutable `
        "auth" `
        "logout" `
        "--profile" `
        $ProfileName `
        "--non-interactive"
      $cleanupLogoutExitCode = $LASTEXITCODE
      $cleanupLogoutOutput = ($cleanupLogoutNativeOutput | Out-String).Trim()
      if ($cleanupLogoutExitCode -ne 0) {
        throw "Credential cleanup exited with $cleanupLogoutExitCode.`n$cleanupLogoutOutput"
      }
    } catch {
      Write-Warning "Could not remove the Windows acceptance credential."
    }
  }
  if ($null -ne $JenkinsProcess) {
    try {
      $JenkinsProcess.Refresh()
      if (-not $JenkinsProcess.HasExited) {
        & taskkill.exe /PID $JenkinsProcess.Id /T /F *> $null
        if ($LASTEXITCODE -ne 0) {
          Stop-Process -Id $JenkinsProcess.Id -Force -ErrorAction SilentlyContinue
        }
        $JenkinsProcess.WaitForExit(10000) | Out-Null
      }
    } finally {
      $JenkinsProcess.Dispose()
    }
  }
  if ($null -ne $Manifest -and $Manifest.runtimeDir) {
    Remove-Item `
      -LiteralPath ([string]$Manifest.runtimeDir) `
      -Recurse `
      -Force `
      -ErrorAction SilentlyContinue
  }
  Remove-Item `
    -LiteralPath $ManifestPath `
    -Force `
    -ErrorAction SilentlyContinue
  Remove-Item `
    -LiteralPath $CliHome `
    -Recurse `
    -Force `
    -ErrorAction SilentlyContinue
  Remove-Item `
    -LiteralPath $DownloadDirectory `
    -Recurse `
    -Force `
    -ErrorAction SilentlyContinue

  foreach ($name in $EnvironmentNames) {
    [Environment]::SetEnvironmentVariable(
      $name,
      $PreviousEnvironment[$name],
      "Process"
    )
  }
}
