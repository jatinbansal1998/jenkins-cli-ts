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

function Invoke-AcceptanceCli {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [int[]]$ExpectedExitCodes = @(0)
  )

  # Do not merge native stderr here. Bun-compiled Windows executables can exit
  # silently when PowerShell applies 2>&1, while stdout capture alone preserves
  # the direct invocation path used by the workflow's successful version probe.
  $lines = @(& $script:CliExecutable @Arguments)
  $exitCode = $LASTEXITCODE
  $output = ($lines | Out-String).Trim()
  if ($exitCode -notin $ExpectedExitCodes) {
    $displayArguments = @($Arguments)
    $safeOutput = $output
    for ($index = 0; $index -lt $displayArguments.Count; $index++) {
      if ($displayArguments[$index] -ceq "--token") {
        if ($index + 1 -lt $displayArguments.Count) {
          $safeOutput = $safeOutput.Replace(
            $displayArguments[$index + 1],
            "<redacted>"
          )
          $displayArguments[$index + 1] = "<redacted>"
        }
        break
      }
    }
    throw "jenkins-cli $($displayArguments -join ' ') exited with $exitCode.`n$safeOutput"
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = $output
  }
}

function Assert-OutputContains {
  param(
    [Parameter(Mandatory = $true)]
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

  $identity = Invoke-AcceptanceCli -Arguments @("--version")
  Assert-OutputContains $identity.Output $ExpectedVersion "Version output"
  Assert-OutputContains $identity.Output $ExpectedTarget "Version output"
  $null = Invoke-AcceptanceCli -Arguments @("--help")

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
  $login = Invoke-AcceptanceCli -Arguments @(
    "auth",
    "login",
    "--profile",
    $ProfileName,
    "--url",
    [string]$Manifest.jenkinsUrl,
    "--user",
    "integration-test",
    "--token",
    $adminToken,
    "--non-interactive"
  )
  Assert-OutputContains `
    $login.Output `
    "API token stored securely" `
    "Windows secure-store login"
  if ($login.Output.Contains($adminToken)) {
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

  $current = Invoke-AcceptanceCli -Arguments @(
    "auth",
    "current",
    "--profile",
    $ProfileName,
    "--non-interactive"
  )
  Assert-OutputContains $current.Output "Token present:    Yes" "auth current"
  Assert-OutputContains `
    $current.Output `
    "Windows Credential Manager" `
    "auth current"

  $status = Invoke-AcceptanceCli -Arguments @(
    "auth",
    "status",
    "--profile",
    $ProfileName,
    "--non-interactive"
  )
  Assert-OutputContains $status.Output "Authenticated:    Yes" "auth status"
  Assert-OutputContains `
    $status.Output `
    "Jenkins user:     integration-test" `
    "auth status"

  $list = Invoke-AcceptanceCli -Arguments @(
    "list",
    "--refresh",
    "--json",
    "--profile",
    $ProfileName
  )
  $listPayload = $list.Output | ConvertFrom-Json
  if ("cli-structured" -notin @($listPayload.data.name)) {
    throw "Real Jenkins job discovery did not return cli-structured."
  }

  $marker = "windows-acceptance-$RunId"
  $jobUrl = "$($Manifest.jenkinsUrl)/job/cli-structured/"
  $build = Invoke-AcceptanceCli -Arguments @(
    "build",
    "--job-url",
    $jobUrl,
    "--param",
    "MESSAGE=$marker",
    "--watch",
    "--json",
    "--profile",
    $ProfileName
  )
  $buildPayload = $build.Output | ConvertFrom-Json
  if ($buildPayload.data.result -cne "SUCCESS") {
    throw "The Windows acceptance build did not succeed.`n$($build.Output)"
  }
  $buildUrl = [string]$buildPayload.data.buildUrl
  if ([string]::IsNullOrWhiteSpace($buildUrl)) {
    throw "The Windows acceptance build did not return a build URL."
  }

  $buildStatus = Invoke-AcceptanceCli -Arguments @(
    "status",
    "--build-url",
    $buildUrl,
    "--json",
    "--profile",
    $ProfileName
  )
  $statusPayload = $buildStatus.Output | ConvertFrom-Json
  if ($statusPayload.data.build.result -cne "SUCCESS") {
    throw "Exact-build status did not report SUCCESS."
  }

  $logs = Invoke-AcceptanceCli -Arguments @(
    "logs",
    "--build-url",
    $buildUrl,
    "--no-follow",
    "--profile",
    $ProfileName,
    "--non-interactive"
  )
  Assert-OutputContains $logs.Output "structured:$marker" "Exact-build logs"

  $artifacts = Invoke-AcceptanceCli -Arguments @(
    "artifacts",
    "--build-url",
    $buildUrl,
    "--json",
    "--profile",
    $ProfileName
  )
  Assert-OutputContains `
    $artifacts.Output `
    "structured-artifact.txt" `
    "Exact-build artifacts"

  $null = Invoke-AcceptanceCli -Arguments @(
    "artifacts",
    "--build-url",
    $buildUrl,
    "--download",
    "--dest",
    $DownloadDirectory,
    "--profile",
    $ProfileName,
    "--non-interactive"
  )
  $downloadedArtifact = Join-Path $DownloadDirectory "structured-artifact.txt"
  if (
    -not (Test-Path -LiteralPath $downloadedArtifact -PathType Leaf) -or
    -not (Get-Content -LiteralPath $downloadedArtifact -Raw).Contains(
      "structured-artifact"
    )
  ) {
    throw "The exact-build artifact was not downloaded correctly."
  }

  $null = Invoke-AcceptanceCli -Arguments @(
    "auth",
    "logout",
    "--profile",
    $ProfileName,
    "--non-interactive"
  )
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
      $null = Invoke-AcceptanceCli -Arguments @(
        "auth",
        "logout",
        "--profile",
        $ProfileName,
        "--non-interactive"
      )
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
