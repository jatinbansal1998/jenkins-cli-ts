param()

$ErrorActionPreference = "Stop"
$CliPath = (Resolve-Path "dist\jenkins-cli.exe").Path
$DiagnosticHome = Join-Path $env:RUNNER_TEMP "jenkins-cli-native-diagnostic-home"

New-Item -ItemType Directory -Force -Path $DiagnosticHome | Out-Null
$env:NODE_ENV = "test"
$env:HOME = $DiagnosticHome
$env:USERPROFILE = $DiagnosticHome
$env:LOCALAPPDATA = Join-Path $DiagnosticHome "AppData\Local"
$env:APPDATA = Join-Path $DiagnosticHome "AppData\Roaming"

function Invoke-NativeCliProbe {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $output = (& $CliPath --version 2>&1 | Out-String).Trim()
  $exitCode = $LASTEXITCODE
  Write-Host "[$Label] exit=$exitCode output=$output"

  return @{
    Label = $Label
    Passed = $exitCode -eq 0 -and
      -not [string]::IsNullOrWhiteSpace($output) -and
      $output.Contains("bun-win32-")
  }
}

$withoutBun = Invoke-NativeCliProbe -Label "test environment, no concurrent Bun"
$BunPath = (Get-Command bun).Source
$BackgroundBun = Start-Process `
  -FilePath $BunPath `
  -ArgumentList @("-e", "setInterval(()=>{},1000)") `
  -WindowStyle Hidden `
  -PassThru

try {
  Start-Sleep -Milliseconds 500
  if ($BackgroundBun.HasExited) {
    throw "Background Bun exited before the concurrent-execution probe."
  }
  $withBun = Invoke-NativeCliProbe -Label "test environment, concurrent Bun alive"
} finally {
  if (-not $BackgroundBun.HasExited) {
    Stop-Process -Id $BackgroundBun.Id -Force
    Wait-Process -Id $BackgroundBun.Id -ErrorAction SilentlyContinue
  }
}

if (-not $withoutBun.Passed -or -not $withBun.Passed) {
  throw "One or more Windows native-execution probes failed."
}
