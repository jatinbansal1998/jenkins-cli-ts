param()

$ErrorActionPreference = "Stop"
$CliPath = (Resolve-Path "dist\jenkins-cli.exe").Path
$DiagnosticHome = Join-Path $env:RUNNER_TEMP "jenkins-cli-native-diagnostic-home"
$EnvironmentNames = @("NODE_ENV", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA")
$OriginalEnvironment = @{}

New-Item -ItemType Directory -Force -Path $DiagnosticHome | Out-Null
foreach ($name in $EnvironmentNames) {
  $OriginalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Invoke-NativeCliProbe {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [hashtable]$Overrides = @{}
  )

  foreach ($name in $EnvironmentNames) {
    [Environment]::SetEnvironmentVariable(
      $name,
      $OriginalEnvironment[$name],
      "Process"
    )
  }
  foreach ($entry in $Overrides.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable(
      $entry.Key,
      [string]$entry.Value,
      "Process"
    )
  }

  try {
    $output = (& $CliPath --version 2>&1 | Out-String).Trim()
    $exitCode = $LASTEXITCODE
    Write-Host "[$Label] exit=$exitCode output=$output"

    return @{
      Label = $Label
      Passed = $exitCode -eq 0 -and
        -not [string]::IsNullOrWhiteSpace($output) -and
        $output.Contains("bun-win32-")
    }
  } finally {
    foreach ($name in $EnvironmentNames) {
      [Environment]::SetEnvironmentVariable(
        $name,
        $OriginalEnvironment[$name],
        "Process"
      )
    }
  }
}

$results = @(
  Invoke-NativeCliProbe -Label "baseline"
  Invoke-NativeCliProbe -Label "NODE_ENV=test" -Overrides @{
    NODE_ENV = "test"
  }
  Invoke-NativeCliProbe -Label "HOME override" -Overrides @{
    HOME = $DiagnosticHome
  }
  Invoke-NativeCliProbe -Label "USERPROFILE override" -Overrides @{
    USERPROFILE = $DiagnosticHome
  }
  Invoke-NativeCliProbe -Label "app data overrides" -Overrides @{
    LOCALAPPDATA = Join-Path $DiagnosticHome "AppData\Local"
    APPDATA = Join-Path $DiagnosticHome "AppData\Roaming"
  }
  Invoke-NativeCliProbe -Label "complete test environment" -Overrides @{
    NODE_ENV = "test"
    HOME = $DiagnosticHome
    USERPROFILE = $DiagnosticHome
    LOCALAPPDATA = Join-Path $DiagnosticHome "AppData\Local"
    APPDATA = Join-Path $DiagnosticHome "AppData\Roaming"
  }
)

if ($results.Where({ -not $_.Passed }).Count -gt 0) {
  throw "One or more Windows native-execution probes failed."
}
