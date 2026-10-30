[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$InstallDirectory,

  [switch]$RequireRealChat
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Clear-MossKeyE2EEnvironment {
  foreach ($variableName in @(
      "MOSS_KEY_E2E_KEY",
      "MOSS_KEY_E2E_EXPECT_SAVED_KEY",
      "MOSS_KEY_E2E_EXPECT_REMOVED_KEY",
      "MOSS_KEY_E2E_KEEP_KEY",
      "MOSS_KEY_E2E_KEEP_KEY_ON_SUCCESS",
      "MOSS_KEY_LEAK_SCAN_MARKER_PATH"
    )) {
    Remove-Item -LiteralPath "Env:$variableName" -ErrorAction SilentlyContinue
  }
}

function Assert-ValidMossAcceptanceKey {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Key
  )

  $invalidKeyMessage = "The installed-app real-chat gate received an invalid acceptance Key."
  if (
    [string]::IsNullOrEmpty($Key) -or
    $Key.Length -lt 8 -or
    $Key.Length -gt 4096 -or
    $Key.IndexOf([char]0) -ge 0 -or
    $Key.IndexOf([char]13) -ge 0 -or
    $Key.IndexOf([char]10) -ge 0
  ) {
    throw $invalidKeyMessage
  }

  try {
    # Refuse malformed UTF-16 (for example, an unpaired surrogate) before a
    # downstream process could silently replace it while encoding the Key.
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    [void]$strictUtf8.GetByteCount($Key)
  } catch {
    throw $invalidKeyMessage
  }
}

function Stop-ProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process
  )

  $Process.Refresh()
  if ($Process.HasExited) {
    return
  }

  & taskkill.exe /PID $($Process.Id) /T /F | Out-Host
  if ($LASTEXITCODE -ne 0) {
    $Process.Refresh()
    if (-not $Process.HasExited) {
      throw "Failed to stop process tree $($Process.Id)."
    }
  }

  if (-not $Process.WaitForExit(10000)) {
    throw "Process tree $($Process.Id) did not exit after taskkill completed."
  }
}

function Get-InstalledMossProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationDirectory
  )

  $directoryPrefix = $InstallationDirectory.TrimEnd("\\") + "\\"
  return @(
    Get-CimInstance Win32_Process | Where-Object {
      $executablePath = $_.ExecutablePath
      $null -ne $executablePath -and
        $executablePath.StartsWith(
          $directoryPrefix,
          [System.StringComparison]::OrdinalIgnoreCase
        )
    }
  )
}

function Stop-InstalledMossProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationDirectory,

    [int]$TimeoutSeconds = 20
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $installedProcesses = @(Get-InstalledMossProcesses -InstallationDirectory $InstallationDirectory)
    if ($installedProcesses.Count -eq 0) {
      return
    }

    foreach ($installedProcess in $installedProcesses) {
      & taskkill.exe /PID $installedProcess.ProcessId /T /F 2>$null | Out-Null
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Installed Moss processes still hold the custom installation directory."
}

function Wait-ForInstalledMossProcessesExit {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationDirectory,

    [int]$TimeoutSeconds = 20
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $installedProcesses = @(Get-InstalledMossProcesses -InstallationDirectory $InstallationDirectory)
    if ($installedProcesses.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Installed Moss processes did not exit gracefully before the restart deadline."
}

function Wait-ForPathRemoval {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [int]$TimeoutSeconds = 30
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-Path -LiteralPath $Path)) {
      return
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Timed out waiting for the uninstaller to remove the custom installation directory."
}

function Remove-IsolatedMossProfile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProfileRoot
  )

  if (-not (Test-Path -LiteralPath $ProfileRoot)) {
    return
  }

  try {
    Remove-Item -LiteralPath $ProfileRoot -Recurse -Force
  } catch {
    # This path contains the test credential. Keep diagnostics generic and let
    # the final hard check fail if a retry after uninstall also cannot remove it.
    Write-Warning "Failed to remove isolated Moss profile."
  }
}

function Invoke-CheckedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,

    [int]$TimeoutSeconds = 120
  )

  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -NoNewWindow `
    -PassThru
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-ProcessTree -Process $process
      throw "Process timed out after $TimeoutSeconds seconds: $FilePath"
    }

    $process.Refresh()
    if ($process.ExitCode -ne 0) {
      throw "Process exited with code $($process.ExitCode): $FilePath"
    }
  } finally {
    $process.Dispose()
  }
}

function Write-RedactedLeakScanOutput {
  param(
    [AllowEmptyString()]
    [string]$Output,

    [Parameter(Mandatory = $true)]
    [string]$Secret,

    [switch]$ErrorStream
  )

  if ([string]::IsNullOrEmpty($Output)) {
    return
  }

  # The scanner already emits location-only reports. Redact again at the
  # PowerShell boundary so even an unexpected child-process regression cannot
  # write the acceptance Key to the runner log.
  $safeOutput = $Output.Replace($Secret, "[REDACTED_KEY]")
  if ($ErrorStream) {
    [Console]::Error.Write($safeOutput)
  } else {
    [Console]::Out.Write($safeOutput)
  }
}

function Invoke-ExactPlaintextKeyLeakScan {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable,

    [Parameter(Mandatory = $true)]
    [string]$ScanScript,

    [Parameter(Mandatory = $true)]
    [string]$Secret,

    [Parameter(Mandatory = $true)]
    [object[]]$Roots,

    [int]$TimeoutSeconds = 300
  )

  if ([string]::IsNullOrEmpty($Secret)) {
    throw "Exact plaintext Key leak scan requires in-memory Key bytes."
  }
  if ($Roots.Count -eq 0) {
    throw "Exact plaintext Key leak scan requires explicit app-owned roots."
  }

  Clear-MossKeyE2EEnvironment
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $NodeExecutable
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
  $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
  # The only argument is the reviewed scanner path. The Key is written directly
  # to redirected stdin with Write(), which does not append CR/LF.
  $startInfo.ArgumentList.Add($ScanScript)
  foreach ($variableName in @(
      "MOSS_KEY_E2E_KEY",
      "MOSS_KEY_E2E_EXPECT_SAVED_KEY",
      "MOSS_KEY_E2E_KEEP_KEY",
      "MOSS_KEY_E2E_KEEP_KEY_ON_SUCCESS"
    )) {
    $startInfo.Environment.Remove($variableName) | Out-Null
  }
  $startInfo.Environment["MOSS_KEY_LEAK_SCAN_ROOTS"] = ConvertTo-Json `
    -InputObject $Roots `
    -Compress `
    -Depth 3

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $started = $false
  try {
    $started = $process.Start()
    if (-not $started) {
      throw "Could not start exact plaintext Key leak scanner."
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($Secret)
    $process.StandardInput.Close()

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try {
        $process.Kill($true)
      } catch {
        # The fixed timeout failure below remains the acceptance result.
      }
      throw "Exact plaintext Key leak scan timed out."
    }

    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    Write-RedactedLeakScanOutput -Output $stdout -Secret $Secret
    Write-RedactedLeakScanOutput -Output $stderr -Secret $Secret -ErrorStream
    if ($process.ExitCode -ne 0) {
      throw "Exact plaintext Key leak scan failed."
    }
  } finally {
    if ($started -and -not $process.HasExited) {
      try {
        $process.Kill($true)
      } catch {
        # Cleanup is best-effort after the fail-closed scanner result.
      }
    }
    $process.Dispose()
  }
}

function Remove-PotentiallySensitiveDiagnostic {
  param(
    [AllowEmptyString()]
    [string]$DiagnosticPath
  )

  if ([string]::IsNullOrWhiteSpace($DiagnosticPath)) {
    return
  }

  try {
    if (Test-Path -LiteralPath $DiagnosticPath) {
      Remove-Item -LiteralPath $DiagnosticPath -Recurse -Force
    }
  } catch {
    # The upload verifier still fails closed without a clean, digest-bound
    # marker. Keep this warning fixed so filesystem details cannot expose Key
    # bytes embedded in an unexpected filename.
    Write-Warning "Could not delete the blocked Windows smoke diagnostic."
  }
}

function Write-MossKeyLeakScanMarker {
  param(
    [Parameter(Mandatory = $true)]
    [string]$MarkerPath,

    [Parameter(Mandatory = $true)]
    [ValidateSet("clean", "blocked")]
    [string]$Status,

    [AllowEmptyString()]
    [string]$DiagnosticPath
  )

  $fullMarkerPath = [System.IO.Path]::GetFullPath($MarkerPath)
  $markerDirectory = Split-Path -Parent $fullMarkerPath
  if (-not (Test-Path -LiteralPath $markerDirectory -PathType Container)) {
    throw "Exact plaintext Key leak scan marker directory is unavailable."
  }

  $marker = [ordered]@{
    schemaVersion = 1
    status = $Status
  }
  if ($Status -eq "blocked") {
    $marker["reason"] = "scan-not-clean"
  } elseif (
    -not [string]::IsNullOrWhiteSpace($DiagnosticPath) -and
    (Test-Path -LiteralPath $DiagnosticPath)
  ) {
    $diagnosticItem = Get-Item -LiteralPath $DiagnosticPath -Force
    if (
      $diagnosticItem.PSIsContainer -or
      (($diagnosticItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    ) {
      throw "The scanned Windows smoke diagnostic is not an ordinary file."
    }
    $diagnosticHash = Get-FileHash -LiteralPath $DiagnosticPath -Algorithm SHA256
    $diagnosticItemAfterHash = Get-Item -LiteralPath $DiagnosticPath -Force
    if (
      $diagnosticItemAfterHash.PSIsContainer -or
      (($diagnosticItemAfterHash.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
      $diagnosticItem.Length -ne $diagnosticItemAfterHash.Length -or
      $diagnosticItem.LastWriteTimeUtc -ne $diagnosticItemAfterHash.LastWriteTimeUtc
    ) {
      throw "The scanned Windows smoke diagnostic changed while binding its marker."
    }
    $marker["diagnostic"] = [ordered]@{
      path = [System.IO.Path]::GetFullPath($DiagnosticPath)
      length = [long]$diagnosticItemAfterHash.Length
      sha256 = $diagnosticHash.Hash.ToLowerInvariant()
    }
  } else {
    $marker["diagnostic"] = $null
  }

  $temporaryMarkerPath = "$fullMarkerPath.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    if (Test-Path -LiteralPath $fullMarkerPath) {
      Remove-Item -LiteralPath $fullMarkerPath -Recurse -Force
    }
    $json = ConvertTo-Json -InputObject $marker -Compress -Depth 4
    [System.IO.File]::WriteAllText(
      $temporaryMarkerPath,
      "$json`n",
      [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryMarkerPath -Destination $fullMarkerPath
  } finally {
    if (Test-Path -LiteralPath $temporaryMarkerPath) {
      Remove-Item -LiteralPath $temporaryMarkerPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-AvailableLoopbackPort {
  param(
    [int]$ExcludedPort = 0
  )

  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    $listener = [System.Net.Sockets.TcpListener]::new(
      [System.Net.IPAddress]::Loopback,
      0
    )
    try {
      $listener.Start()
      $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
      if ($port -ne $ExcludedPort) {
        return $port
      }
    } finally {
      $listener.Stop()
    }
  }

  throw "Could not reserve a loopback port different from $ExcludedPort."
}

function Wait-ForCdpEndpoint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Endpoint,

    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [int]$TimeoutSeconds = 30
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "Installed Moss exited before its CDP endpoint became ready."
    }

    try {
      $response = Invoke-WebRequest `
        -Uri "$Endpoint/json/version" `
        -Method Get `
        -TimeoutSec 2 `
        -UseBasicParsing
      if ($response.StatusCode -eq 200) {
        return
      }
    } catch {
      # CDP starts before the application UI on a healthy launch. Retry until
      # the bounded deadline without exposing response or process details.
    }

    Start-Sleep -Milliseconds 250
  }

  throw "Installed Moss CDP endpoint did not become ready within $TimeoutSeconds seconds."
}

function Start-InstalledMossWithoutAcceptanceKey {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,

    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,

    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$ArgumentList
  )

  # The acceptance Key belongs only to the first UI driver. Neither the initial
  # app process nor the restarted app/backend may inherit the credential.
  Clear-MossKeyE2EEnvironment
  if ($ArgumentList.Count -gt 0) {
    return (Start-Process `
      -FilePath $Executable `
      -WorkingDirectory $WorkingDirectory `
      -ArgumentList $ArgumentList `
      -PassThru)
  }

  return (Start-Process `
    -FilePath $Executable `
    -WorkingDirectory $WorkingDirectory `
    -PassThru)
}

function Wait-ForInstalledMossStartup {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [int]$TimeoutSeconds = 8
  )

  $startupDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $startupDeadline) {
    Start-Sleep -Milliseconds 500
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "Installed Moss exited during startup with code $($Process.ExitCode)."
    }
  }
}

function Stop-InstalledMossApp {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [Parameter(Mandatory = $true)]
    [string]$InstallationDirectory,

    [switch]$RequireGraceful
  )

  $exitTimeoutMilliseconds = 10000
  if ($RequireGraceful.IsPresent) {
    $exitTimeoutMilliseconds = 30000
  }
  $requestedClose = $Process.CloseMainWindow()
  if (-not $requestedClose -or -not $Process.WaitForExit($exitTimeoutMilliseconds)) {
    if ($RequireGraceful) {
      throw "Installed Moss did not exit gracefully before the restart deadline."
    }
    Stop-ProcessTree -Process $Process
    if (-not $Process.WaitForExit(10000)) {
      throw "Installed Moss did not exit after its process tree was stopped."
    }
  }
  if ($RequireGraceful) {
    Wait-ForInstalledMossProcessesExit -InstallationDirectory $InstallationDirectory
  } else {
    Stop-InstalledMossProcesses -InstallationDirectory $InstallationDirectory
  }
}

if ($env:OS -ne "Windows_NT") {
  throw "The Windows installer smoke test must run on Windows."
}

$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$InstallDirectory = [System.IO.Path]::GetFullPath($InstallDirectory)
if ([System.IO.Path]::GetExtension($InstallerPath) -ne ".exe") {
  throw "Expected an NSIS .exe installer, got: $InstallerPath"
}
if ($InstallDirectory -notmatch "\s") {
  throw "The smoke-test installation directory must contain a space: $InstallDirectory"
}
if (Test-Path -LiteralPath $InstallDirectory) {
  throw "The smoke-test installation directory already exists: $InstallDirectory"
}

$acceptanceKey = [Environment]::GetEnvironmentVariable("MOSS_KEY_E2E_KEY", "Process")
$hasAcceptanceKey = -not [string]::IsNullOrEmpty($acceptanceKey)
if ($RequireRealChat -and -not $hasAcceptanceKey) {
  throw "A publish release requires MOSS_KEY_E2E_KEY for the installed-app real-chat gate."
}
if ($hasAcceptanceKey) {
  # Validate before installation, app launch, or scanner preparation. The
  # failure is intentionally fixed and never includes the credential value.
  Assert-ValidMossAcceptanceKey -Key $acceptanceKey
}
$runRealChat = $hasAcceptanceKey
$diagnosticPath = [Environment]::GetEnvironmentVariable(
  "MOSS_KEY_E2E_DIAGNOSTIC_PATH",
  "Process"
)
$scanMarkerPath = [Environment]::GetEnvironmentVariable(
  "MOSS_KEY_LEAK_SCAN_MARKER_PATH",
  "Process"
)
if ($runRealChat -and [string]::IsNullOrWhiteSpace($scanMarkerPath)) {
  throw "A real-chat gate requires an explicit exact-Key scan marker path."
}
if (-not [string]::IsNullOrWhiteSpace($diagnosticPath)) {
  $diagnosticPath = [System.IO.Path]::GetFullPath($diagnosticPath)
}
if (-not [string]::IsNullOrWhiteSpace($scanMarkerPath)) {
  $scanMarkerPath = [System.IO.Path]::GetFullPath($scanMarkerPath)
  # Never permit a previous attempt's clean marker to authorize this run.
  Remove-Item `
    -LiteralPath $scanMarkerPath `
    -Recurse `
    -Force `
    -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $scanMarkerPath) {
    throw "Could not reset the exact plaintext Key leak scan marker."
  }
}
if (-not [string]::IsNullOrWhiteSpace($diagnosticPath)) {
  # A failed or cancelled prior attempt must never be authorized by this run's
  # future clean marker.
  try {
    Remove-Item `
      -LiteralPath $diagnosticPath `
      -Recurse `
      -Force `
      -ErrorAction SilentlyContinue
  } catch {
    # The postcondition below is the fail-closed decision.
  }
  if (Test-Path -LiteralPath $diagnosticPath) {
    throw "Could not reset the Windows smoke diagnostic."
  }
}
if (
  $runRealChat -and
  -not [string]::IsNullOrWhiteSpace($diagnosticPath) -and
  $diagnosticPath.Equals($scanMarkerPath, [System.StringComparison]::OrdinalIgnoreCase)
) {
  throw "The Windows smoke diagnostic and scan marker require distinct paths."
}
# Keep the secret out of every app/backend process. It is restored only around
# the first UI driver's child-process creation, then removed immediately.
Clear-MossKeyE2EEnvironment

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$realChatScript = Join-Path `
  $repositoryRoot `
  "apps\desktop\scripts\moss-key-chat-e2e.mjs"
$keyLeakScanScript = Join-Path $repositoryRoot "scripts\moss-key-leak-scan.mjs"
if ($runRealChat -and -not (Test-Path -LiteralPath $realChatScript -PathType Leaf)) {
  throw "Real-chat E2E runner is missing: $realChatScript"
}
if ($runRealChat -and -not (Test-Path -LiteralPath $keyLeakScanScript -PathType Leaf)) {
  throw "Exact plaintext Key leak scanner is missing: $keyLeakScanScript"
}
$nodeExecutable = $null
if ($runRealChat) {
  $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
}

$mossExecutable = Join-Path $InstallDirectory "Moss.exe"
$uninstallerExecutable = Join-Path $InstallDirectory "Uninstall Moss.exe"
$profileRoot = Join-Path `
  ([System.IO.Path]::GetTempPath()) `
  "Moss Installer Profile $([Guid]::NewGuid().ToString('N'))"
$desktopUserDataDirectory = Join-Path $profileRoot "electron-user-data"
$mossHome = Join-Path $profileRoot "moss-home"
$appProcess = $null
$installed = $false
$smokeBodyCompleted = $false
$scanGateFailed = $false
$successfulCleanupFailed = $false
$processExitNotProven = $false

try {
  # NSIS requires /D to be the final argument. It consumes the remainder of the
  # command line, so this also exercises an unquoted custom path containing spaces.
  $installerArguments = @("/S", "/D=$InstallDirectory")
  Write-Host "Installing Moss silently into '$InstallDirectory'..."
  Invoke-CheckedProcess -FilePath $InstallerPath -ArgumentList $installerArguments
  $installed = $true

  foreach ($requiredExecutable in @($mossExecutable, $uninstallerExecutable)) {
    if (-not (Test-Path -LiteralPath $requiredExecutable -PathType Leaf)) {
      throw "Installer did not create required executable: $requiredExecutable"
    }
  }
  Write-Host "PASS custom-installation"

  New-Item -ItemType Directory -Path $desktopUserDataDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $mossHome -Force | Out-Null
  $env:MOSS_DESKTOP_USER_DATA_DIR = $desktopUserDataDirectory
  $env:MOSS_HOME = $mossHome
  $env:DPCODE_HOME = $mossHome
  $env:T3CODE_HOME = $mossHome
  $env:T3CODE_DISABLE_AUTO_UPDATE = "1"

  $appArguments = @()
  $cdpPort = $null
  if ($runRealChat) {
    $cdpPort = Get-AvailableLoopbackPort
    $appArguments += "--remote-debugging-address=127.0.0.1"
    $appArguments += "--remote-debugging-port=$cdpPort"
  }

  Write-Host "Launching installed Moss executable with an isolated profile..."
  $appProcess = Start-InstalledMossWithoutAcceptanceKey `
    -Executable $mossExecutable `
    -WorkingDirectory $InstallDirectory `
    -ArgumentList $appArguments
  Wait-ForInstalledMossStartup -Process $appProcess

  if ($runRealChat) {
    $cdpEndpoint = "http://127.0.0.1:$cdpPort"
    Wait-ForCdpEndpoint -Endpoint $cdpEndpoint -Process $appProcess
    Write-Host "Running the first-launch Moss Key real-chat gate..."
    $env:MOSS_KEY_E2E_KEY = $acceptanceKey
    try {
      Invoke-CheckedProcess `
        -FilePath $nodeExecutable `
        -ArgumentList @(
          "`"$realChatScript`"",
          "--cdp-url",
          $cdpEndpoint,
          "--app-url",
          "moss://app/index.html",
          "--timeout-ms",
          "180000",
          "--keep-key-on-success"
        ) `
        -TimeoutSeconds 240
    } finally {
      Clear-MossKeyE2EEnvironment
    }
    Write-Host "PASS key-real-chat-first-launch"

    Write-Host "Stopping and restarting installed Moss with the same isolated profile..."
    Stop-InstalledMossApp `
      -Process $appProcess `
      -InstallationDirectory $InstallDirectory `
      -RequireGraceful
    $appProcess.Dispose()
    $appProcess = $null

    $cdpPort = Get-AvailableLoopbackPort -ExcludedPort $cdpPort
    $appArguments = @(
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=$cdpPort"
    )
    $appProcess = Start-InstalledMossWithoutAcceptanceKey `
      -Executable $mossExecutable `
      -WorkingDirectory $InstallDirectory `
      -ArgumentList $appArguments
    Wait-ForInstalledMossStartup -Process $appProcess

    $cdpEndpoint = "http://127.0.0.1:$cdpPort"
    Wait-ForCdpEndpoint -Endpoint $cdpEndpoint -Process $appProcess
    Write-Host "Verifying the saved Moss Key after app restart without re-entering it..."
    Clear-MossKeyE2EEnvironment
    Invoke-CheckedProcess `
      -FilePath $nodeExecutable `
      -ArgumentList @(
        "`"$realChatScript`"",
        "--cdp-url",
        $cdpEndpoint,
        "--app-url",
        "moss://app/index.html",
        "--timeout-ms",
        "180000",
        "--expect-saved-key"
      ) `
      -TimeoutSeconds 240
    Write-Host "PASS key-restored-after-restart-real-chat"

    Write-Host "Restarting installed Moss to prove the removed Key stays absent..."
    Stop-InstalledMossApp `
      -Process $appProcess `
      -InstallationDirectory $InstallDirectory `
      -RequireGraceful
    $appProcess.Dispose()
    $appProcess = $null

    $cdpPort = Get-AvailableLoopbackPort -ExcludedPort $cdpPort
    $appArguments = @(
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=$cdpPort"
    )
    $appProcess = Start-InstalledMossWithoutAcceptanceKey `
      -Executable $mossExecutable `
      -WorkingDirectory $InstallDirectory `
      -ArgumentList $appArguments
    Wait-ForInstalledMossStartup -Process $appProcess

    $cdpEndpoint = "http://127.0.0.1:$cdpPort"
    Wait-ForCdpEndpoint -Endpoint $cdpEndpoint -Process $appProcess
    Write-Host "Verifying the removed Moss Key stays absent after app restart..."
    Clear-MossKeyE2EEnvironment
    Invoke-CheckedProcess `
      -FilePath $nodeExecutable `
      -ArgumentList @(
        "`"$realChatScript`"",
        "--cdp-url",
        $cdpEndpoint,
        "--app-url",
        "moss://app/index.html",
        "--timeout-ms",
        "180000",
        "--expect-removed-key"
      ) `
      -TimeoutSeconds 240
    Write-Host "PASS key-removal-persisted-after-restart"
  } else {
    Write-Host "No Moss Key secret is configured; build-only lifecycle gate will skip real chat."
  }

  Write-Host "Installed Moss stayed running; requesting application exit..."
  Stop-InstalledMossApp `
    -Process $appProcess `
    -InstallationDirectory $InstallDirectory
  $appProcess.Dispose()
  $appProcess = $null
  $smokeBodyCompleted = $true

} finally {
  Clear-MossKeyE2EEnvironment

  if ($null -ne $appProcess) {
    try {
      Stop-ProcessTree -Process $appProcess
    } catch {
      Write-Warning "Failed to stop Moss during cleanup: $_"
      $processExitNotProven = $true
    } finally {
      $appProcess.Dispose()
    }
  }

  try {
    Stop-InstalledMossProcesses -InstallationDirectory $InstallDirectory
  } catch {
    Write-Warning "Failed to release the smoke-test installation directory: $_"
    $processExitNotProven = $true
  }

  if ($runRealChat) {
    try {
      # This scan belongs in the outer finally: a driver, restart, process-exit,
      # or lifecycle failure must not bypass it. Include only roots that exist
      # at this failure point, and never scan runner-wide or checkout paths.
      $scanRoots = @()
      foreach ($candidate in @(
          [PSCustomObject]@{ category = "moss-home"; path = $mossHome },
          [PSCustomObject]@{
            category = "electron-user-data"
            path = $desktopUserDataDirectory
          },
          [PSCustomObject]@{ category = "isolated-profile"; path = $profileRoot },
          [PSCustomObject]@{ category = "install-tree"; path = $InstallDirectory },
          [PSCustomObject]@{
            category = "installer-artifact"
            path = $InstallerPath
          },
          [PSCustomObject]@{ category = "diagnostic"; path = $diagnosticPath }
        )) {
        if (
          -not [string]::IsNullOrWhiteSpace($candidate.path) -and
          (Test-Path -LiteralPath $candidate.path)
        ) {
          $scanRoots += $candidate
        }
      }

      Write-Host "Scanning app-owned files for the exact plaintext Key after process exit..."
      Invoke-ExactPlaintextKeyLeakScan `
        -NodeExecutable $nodeExecutable `
        -ScanScript $keyLeakScanScript `
        -Secret $acceptanceKey `
        -Roots $scanRoots
      if ($processExitNotProven) {
        throw "Installed Moss process exit was not proven before the leak scan."
      }
      Write-MossKeyLeakScanMarker `
        -MarkerPath $scanMarkerPath `
        -Status "clean" `
        -DiagnosticPath $diagnosticPath
      Write-Host "PASS exact-plaintext-key-leak-scan"
    } catch {
      $scanGateFailed = $true
      Remove-PotentiallySensitiveDiagnostic -DiagnosticPath $diagnosticPath
      try {
        Write-MossKeyLeakScanMarker `
          -MarkerPath $scanMarkerPath `
          -Status "blocked" `
          -DiagnosticPath ""
      } catch {
        # A missing marker also blocks the workflow upload. Never include either
        # exception because a malicious path could contain acceptance Key bytes.
      }
      Write-Warning "Exact plaintext Key leak scan did not prove clean; diagnostic upload is blocked."
    } finally {
      $acceptanceKey = $null
    }
  } else {
    $acceptanceKey = $null
  }

  # If credential verification or removal did not finish, deleting the
  # isolated profile is the fail-closed cleanup. It must happen before the
  # uninstaller runs, after all installed processes have been stopped.
  Remove-IsolatedMossProfile -ProfileRoot $profileRoot

  if ($installed -and (Test-Path -LiteralPath $uninstallerExecutable -PathType Leaf)) {
    try {
      Write-Host "Uninstalling Moss silently..."
      Invoke-CheckedProcess -FilePath $uninstallerExecutable -ArgumentList @("/S")
      Wait-ForPathRemoval -Path $InstallDirectory
      $installed = $false
      Write-Host "PASS uninstall-custom-installation"
    } catch {
      Write-Warning "Failed to uninstall Moss during cleanup: $_"
      if ($smokeBodyCompleted) {
        $successfulCleanupFailed = $true
      }
    }
  }

  if (Test-Path -LiteralPath $InstallDirectory) {
    try {
      Remove-Item -LiteralPath $InstallDirectory -Recurse -Force
    } catch {
      Write-Warning "Failed to remove smoke-test installation directory: $_"
      if ($smokeBodyCompleted) {
        $successfulCleanupFailed = $true
      }
    }
  }

  # Retry after uninstall in case a transient Windows handle blocked the first
  # credential-profile deletion attempt.
  Remove-IsolatedMossProfile -ProfileRoot $profileRoot

  if ($runRealChat) {
    if ($null -ne [Environment]::GetEnvironmentVariable("MOSS_KEY_E2E_KEY", "Process")) {
      throw "The real-chat gate could not clear its acceptance Key environment variable."
    }
    $remainingInstalledProcesses = @(
      Get-InstalledMossProcesses -InstallationDirectory $InstallDirectory
    )
    if ($remainingInstalledProcesses.Count -ne 0) {
      throw "The real-chat gate left installed Moss processes running."
    }
    if (Test-Path -LiteralPath $profileRoot) {
      throw "The real-chat gate could not remove its isolated Moss profile."
    }
    if (Test-Path -LiteralPath $InstallDirectory) {
      throw "The real-chat gate could not remove its custom installation directory."
    }
    if ($scanGateFailed) {
      throw "The exact plaintext Key leak scan did not prove app-owned state clean."
    }
  }
  if ($successfulCleanupFailed) {
    throw "The Windows installer smoke test could not complete successful-run cleanup."
  }
}

Write-Host "Windows installer smoke test passed."
