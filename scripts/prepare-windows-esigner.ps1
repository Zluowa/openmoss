# FILE: prepare-windows-esigner.ps1
# Purpose: Downloads and verifies the exact SSL.com CodeSignTool payload before it can execute.
# Layer: Release/build setup

[CmdletBinding()]
param(
  [string]$DestinationPath = (Join-Path $env:RUNNER_TEMP "CodeSignTool-v1.3.0-verified")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

$archiveUrl = "https://github.com/SSLcom/CodeSignTool/releases/download/v1.3.0/CodeSignTool-v1.3.0-windows.zip"
$archiveSize = 218271514
$archiveSha256 = "e22094505decbe622afe5b0c27abc618ed2ba179bd94f3450490352399d5ef2a"
$jarSha256 = "00608c4d1fa3e68b4861a49ee701e6fdba1ff1e41da4ddc61076d845ff23767e"
$javaSize = 272736
$javaSha256 = "bb8df03053f4f60ff36ec9df61eadc75bcd551cf94210d96896129b1ab6239a0"
$archivePath = Join-Path $env:RUNNER_TEMP "CodeSignTool-v1.3.0-windows.zip"

Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
$downloadedArchive = Get-Item -LiteralPath $archivePath
if ($downloadedArchive.Length -ne $archiveSize) {
  throw "SSL.com CodeSignTool archive size mismatch."
}
$actualArchiveSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualArchiveSha256 -ne $archiveSha256) {
  throw "SSL.com CodeSignTool archive SHA-256 mismatch."
}

if (Test-Path -LiteralPath $DestinationPath) {
  Remove-Item -LiteralPath $DestinationPath -Recurse -Force
}
Expand-Archive -LiteralPath $archivePath -DestinationPath $DestinationPath

$jarPath = Join-Path $DestinationPath "jar/code_sign_tool-1.3.0.jar"
if (-not (Test-Path -LiteralPath $jarPath -PathType Leaf)) {
  throw "Verified SSL.com CodeSignTool archive does not contain the pinned JAR."
}
$actualJarSha256 = (Get-FileHash -LiteralPath $jarPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualJarSha256 -ne $jarSha256) {
  throw "SSL.com CodeSignTool JAR SHA-256 mismatch."
}

$javaPath = Join-Path $DestinationPath "jdk-11.0.2/bin/java.exe"
if (-not (Test-Path -LiteralPath $javaPath -PathType Leaf)) {
  throw "Verified SSL.com CodeSignTool archive does not contain its pinned Java runtime."
}
$javaExecutable = Get-Item -LiteralPath $javaPath
if ($javaExecutable.Length -ne $javaSize) {
  throw "SSL.com CodeSignTool Java runtime size mismatch."
}
$actualJavaSha256 = (Get-FileHash -LiteralPath $javaPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualJavaSha256 -ne $javaSha256) {
  throw "SSL.com CodeSignTool Java runtime SHA-256 mismatch."
}

$configPath = Join-Path $DestinationPath "conf/code_sign_tool.properties"
$productionConfig = @(
  "CLIENT_ID=kaXTRACNijSWsFdRKg_KAfD3fqrBlzMbWs6TwWHwAn8"
  "OAUTH2_ENDPOINT=https://login.ssl.com/oauth2/token"
  "CSC_API_ENDPOINT=https://cs.ssl.com"
  "TSA_URL=http://ts.ssl.com"
  "TSA_LEGACY_URL=http://ts.ssl.com/legacy"
) -join "`n"
[System.IO.File]::WriteAllText(
  $configPath,
  $productionConfig,
  [System.Text.UTF8Encoding]::new($false)
)

$versionOutput = (& $javaPath -Xmx256M -jar $jarPath --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Verified SSL.com CodeSignTool failed its version probe with exit code $LASTEXITCODE."
}
if ($versionOutput -match "Error|Exception|Missing required option|Unmatched argument") {
  throw "Verified SSL.com CodeSignTool reported an error during its version probe."
}

"CODE_SIGN_TOOL_PATH=$DestinationPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Remove-Item -LiteralPath $archivePath -Force
Write-Host $versionOutput
Write-Host "Verified SSL.com CodeSignTool v1.3.0 archive, executable JAR, and bundled Java runtime."
