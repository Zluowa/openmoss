# FILE: verify-windows-authenticode.ps1
# Purpose: Fails closed unless a Windows artifact has the intended trusted signer and timestamp.
# Layer: Release/build verification

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedPublisher,

  [string]$ExpectedThumbprint = "",

  [switch]$RequireTimestamp
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
  throw "Authenticode input file does not exist: $FilePath"
}

$securityModulePath = Join-Path `
  $PSHOME `
  "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
if (-not (Test-Path -LiteralPath $securityModulePath -PathType Leaf)) {
  throw "Trusted Microsoft.PowerShell.Security module does not exist: $securityModulePath"
}
Import-Module -Name $securityModulePath -Force -ErrorAction Stop

$signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $FilePath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Authenticode verification failed: $($signature.Status) $($signature.StatusMessage)"
}
if ($null -eq $signature.SignerCertificate) {
  throw "Authenticode verification did not return a signer certificate."
}

$actualPublisher = [string]$signature.SignerCertificate.Subject
$publisherMatches = if ($ExpectedPublisher.Contains("=")) {
  # Full DN mode is deliberately exact. Copy SignerCertificate.Subject into
  # the repository variable so updater config and release verification agree.
  [string]::Equals(
    $actualPublisher.Trim(),
    $ExpectedPublisher.Trim(),
    [System.StringComparison]::OrdinalIgnoreCase
  )
} else {
  $actualCommonName = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  [string]::Equals(
    $actualCommonName.Trim(),
    $ExpectedPublisher.Trim(),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}
if (-not $publisherMatches) {
  throw "Authenticode publisher mismatch. Expected '$ExpectedPublisher', received '$actualPublisher'."
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedThumbprint)) {
  $normalizedExpectedThumbprint = ($ExpectedThumbprint -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
  $normalizedActualThumbprint = ([string]$signature.SignerCertificate.Thumbprint `
      -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
  if ($normalizedExpectedThumbprint.Length -ne 40) {
    throw "Expected Authenticode certificate thumbprint must contain exactly 40 hexadecimal characters."
  }
  if ($normalizedActualThumbprint -ne $normalizedExpectedThumbprint) {
    throw "Authenticode certificate thumbprint mismatch."
  }
}

if ($RequireTimestamp) {
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Authenticode signature is missing a trusted timestamp."
  }
  $now = [DateTime]::UtcNow
  if (
    $signature.TimeStamperCertificate.NotBefore.ToUniversalTime() -gt $now -or
    $signature.TimeStamperCertificate.NotAfter.ToUniversalTime() -lt $now
  ) {
    throw "Authenticode timestamp certificate is not currently valid."
  }
}

Write-Host "Verified Authenticode signer: $actualPublisher"
Write-Host "Verified Authenticode thumbprint: $($signature.SignerCertificate.Thumbprint)"
if ($RequireTimestamp) {
  Write-Host "Verified Authenticode timestamp authority: $($signature.TimeStamperCertificate.Subject)"
}
