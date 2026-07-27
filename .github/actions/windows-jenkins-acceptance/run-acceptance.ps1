param(
  [Parameter(Mandatory = $true)]
  [string]$CliExecutable,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedTarget,
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,
  [Parameter(Mandatory = $true)]
  [string]$DownloadDirectory,
  [Parameter(Mandatory = $true)]
  [string]$ProfileName,
  [Parameter(Mandatory = $true)]
  [string]$LoginMarkerPath
)

$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Invoke-AcceptanceCli {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Context,
    [Parameter(Mandatory = $true)]
    [string[]]$CliArguments
  )

  & $CliExecutable @CliArguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Context exited with $LASTEXITCODE."
  }
}

$CliExecutable = (Resolve-Path -LiteralPath $CliExecutable).Path
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$adminToken = (
  Get-Content -LiteralPath ([string]$Manifest.adminTokenFile) -Raw
).Trim()
Write-Output "::add-mask::$adminToken"

foreach ($name in @(
    "JENKINS_URL",
    "JENKINS_USER",
    "JENKINS_API_TOKEN",
    "TS_KEYRING_BACKEND",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy"
  )) {
  [Environment]::SetEnvironmentVariable($name, $null, "Process")
}
$env:NO_PROXY = "127.0.0.1,localhost"
$env:no_proxy = $env:NO_PROXY

$binaryText = [Text.Encoding]::Latin1.GetString(
  [IO.File]::ReadAllBytes($CliExecutable)
)
foreach ($expectedIdentity in @($ExpectedVersion, $ExpectedTarget)) {
  if (-not $binaryText.Contains($expectedIdentity)) {
    throw "The Windows executable does not contain expected identity '$expectedIdentity'."
  }
}
$binaryText = $null

Invoke-AcceptanceCli "Version command" @("--version")
Invoke-AcceptanceCli "Help command" @("--help")

[IO.File]::WriteAllText(
  $LoginMarkerPath,
  $ProfileName,
  [Text.UTF8Encoding]::new($false)
)
Invoke-AcceptanceCli "Secure-store login" @(
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

$configPath = bun -e `
  'import { CONFIG_FILE } from "./src/config"; console.log(CONFIG_FILE);'
if ($LASTEXITCODE -ne 0) {
  throw "Config path resolution exited with $LASTEXITCODE."
}
$configPath = ($configPath | Out-String).Trim()
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

$secureStoreAccount = bun -e `
  'import { buildSecureStoreAccount } from "./src/secure-store"; console.log(buildSecureStoreAccount(process.argv[1], process.argv[2]));' `
  $ProfileName `
  ([string]$Manifest.jenkinsUrl)
if ($LASTEXITCODE -ne 0) {
  throw "Secure-store account derivation exited with $LASTEXITCODE."
}
$secureStoreAccount = ($secureStoreAccount | Out-String).Trim()
$env:JENKINS_CLI_ACCEPTANCE_ACCOUNT = $secureStoreAccount
$env:JENKINS_CLI_ACCEPTANCE_TOKEN = $adminToken
$credentialRoundTripScript = @'
import { getPassword, listBackends } from "cross-keychain";
const backends = await listBackends();
if (!backends.some(({ id }) => id === "native-windows" || id === "windows")) {
  throw new Error("Windows Credential Manager backend is unavailable");
}
const token = await getPassword(
  "jenkins-cli",
  process.env.JENKINS_CLI_ACCEPTANCE_ACCOUNT,
);
if (token !== process.env.JENKINS_CLI_ACCEPTANCE_TOKEN) {
  throw new Error("Credential Manager did not return the stored Jenkins token");
}
'@
bun -e $credentialRoundTripScript
if ($LASTEXITCODE -ne 0) {
  throw "Credential Manager round trip exited with $LASTEXITCODE."
}
[Environment]::SetEnvironmentVariable(
  "JENKINS_CLI_ACCEPTANCE_TOKEN",
  $null,
  "Process"
)

$credentials = [Convert]::ToBase64String(
  [Text.Encoding]::UTF8.GetBytes("integration-test:$adminToken")
)
$headers = @{ Authorization = "Basic $credentials" }
$identity = Invoke-RestMethod `
  -Uri "$($Manifest.jenkinsUrl)/whoAmI/api/json" `
  -Headers $headers `
  -TimeoutSec 20
if (-not $identity.authenticated) {
  throw "Disposable Jenkins stopped responding before CLI network acceptance."
}

Invoke-AcceptanceCli "auth current" @(
  "auth",
  "current",
  "--profile",
  $ProfileName,
  "--non-interactive"
)
Invoke-AcceptanceCli "auth status" @(
  "auth",
  "status",
  "--profile",
  $ProfileName,
  "--non-interactive"
)
Invoke-AcceptanceCli "Job list" @(
  "list",
  "--refresh",
  "--json",
  "--profile",
  $ProfileName
)

$marker = "windows-acceptance-$([guid]::NewGuid().ToString('N'))"
$jobUrl = "$($Manifest.jenkinsUrl)/job/cli-structured/"
$jobState = Invoke-RestMethod `
  -Uri "${jobUrl}api/json" `
  -Headers $headers `
  -TimeoutSec 20
$expectedBuildNumber = [int]$jobState.nextBuildNumber

Invoke-AcceptanceCli "Build command" @(
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

$buildUrl = "$jobUrl$expectedBuildNumber/"
$buildState = Invoke-RestMethod `
  -Uri "${buildUrl}api/json" `
  -Headers $headers `
  -TimeoutSec 20
if ($buildState.building -or $buildState.result -cne "SUCCESS") {
  throw "The Windows acceptance build did not finish successfully."
}
if (
  "structured-artifact.txt" -notin
    @($buildState.artifacts | ForEach-Object { $_.fileName })
) {
  throw "Real Jenkins did not publish structured-artifact.txt."
}
$jenkinsConsole = (
  Invoke-WebRequest `
    -Uri "${buildUrl}consoleText" `
    -Headers $headers `
    -TimeoutSec 20
).Content
if (-not $jenkinsConsole.Contains("structured:$marker")) {
  throw "Real Jenkins did not receive the Windows CLI build parameter."
}

Invoke-AcceptanceCli "Exact-build status" @(
  "status",
  "--build-url",
  $buildUrl,
  "--json",
  "--profile",
  $ProfileName
)
Invoke-AcceptanceCli "Exact-build logs" @(
  "logs",
  "--build-url",
  $buildUrl,
  "--no-follow",
  "--profile",
  $ProfileName,
  "--non-interactive"
)
Invoke-AcceptanceCli "Exact-build artifacts" @(
  "artifacts",
  "--build-url",
  $buildUrl,
  "--json",
  "--profile",
  $ProfileName
)
Invoke-AcceptanceCli "Exact-build artifact download" @(
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

Invoke-AcceptanceCli "Credential logout" @(
  "auth",
  "logout",
  "--profile",
  $ProfileName,
  "--non-interactive"
)
Remove-Item -LiteralPath $LoginMarkerPath -Force

$credentialDeletionScript = @'
import { getPassword } from "cross-keychain";
const token = await getPassword(
  "jenkins-cli",
  process.env.JENKINS_CLI_ACCEPTANCE_ACCOUNT,
);
if (token !== null) {
  throw new Error("Credential Manager retained the Jenkins token after logout");
}
'@
bun -e $credentialDeletionScript
if ($LASTEXITCODE -ne 0) {
  throw "Credential Manager deletion exited with $LASTEXITCODE."
}
[Environment]::SetEnvironmentVariable(
  "JENKINS_CLI_ACCEPTANCE_ACCOUNT",
  $null,
  "Process"
)

if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  $configAfterLogout =
    Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if (
    $configAfterLogout.profiles.PSObject.Properties.Name -contains $ProfileName
  ) {
    throw "Windows Credential Manager cleanup left the acceptance profile configured."
  }
}

Write-Host "Windows CLI, Credential Manager, and real Jenkins acceptance passed."
