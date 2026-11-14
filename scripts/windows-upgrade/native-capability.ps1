# FILE: scripts/windows-upgrade/native-capability.ps1
# Purpose: Observe identities and operate only an explicitly enrolled window.
# Layer: release validation tooling
# Exports: allowlisted JSON lines; never creates another process
param(
  [Parameter(Mandatory=$true)][ValidateSet('host','identity','window','invoke','close','paths')][string]$Mode,
  [int]$TargetPid, [string]$CreatedAt, [string]$Executable,
  [string]$Button, [string]$CheckPath
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function Identity([int]$ProcessId) {
  try {
    $p=[Diagnostics.Process]::GetProcessById($ProcessId)
    try { return @{pid=$p.Id; createdAt=$p.StartTime.ToUniversalTime().Ticks.ToString(); executable=$p.MainModule.FileName} }
    finally { $p.Dispose() }
  } catch [ArgumentException] { return $null }
}
function Emit($Value) { [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 5 -Compress)); [Console]::Out.Flush() }
Emit @{event='hello'; identity=(Identity $PID)}
if ($Mode -eq 'identity') { Emit @{event='result'; identity=(Identity $TargetPid)}; exit 0 }
if ($Mode -eq 'paths') {
  if ($CheckPath -notmatch '^[a-zA-Z]:[\\/]' -or $CheckPath.Substring(2).Contains(':') -or
      $CheckPath -match '[\x00-\x1f<>"|?*]' -or $CheckPath -match '(^|[\\/])\.{1,2}([\\/]|$)' -or
      $CheckPath -match '[. ]([\\/]|$)') { throw 'Noncanonical path' }
  $current=[IO.Path]::GetFullPath($CheckPath)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item=Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse ancestor rejected' }
    }
    $parent=[IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }; $current=$parent.FullName
  }
  Emit @{event='result'; status='passed'; scope='no-reparse-ancestors'}; exit 0
}
if ($Mode -eq 'host') {
  $os=Get-CimInstance Win32_OperatingSystem
  $machine=Get-CimInstance Win32_ComputerSystem
  $self=[Diagnostics.Process]::GetCurrentProcess()
  $ancestor=$PID; $runner=$null
  for($i=0; $i -lt 12 -and $ancestor -gt 0; $i++) {
    $entry=Get-CimInstance Win32_Process -Filter "ProcessId=$ancestor"
    if ($null -eq $entry) { break }
    if ([IO.Path]::GetFileName($entry.ExecutablePath) -in @('Runner.Worker.exe','Runner.Listener.exe')) { $runner=$entry.ExecutablePath; break }
    $ancestor=$entry.ParentProcessId
  }
  $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='D:'"
  Emit @{event='result'; status='observed'; scope='read-only-host-evidence'; host=@{
    manufacturer=$machine.Manufacturer; model=$machine.Model; osBuild=$os.BuildNumber
    osProductType=[int]$os.ProductType; userName=[Environment]::UserName; sessionId=$self.SessionId
    runnerServicePath=$runner; runnerImageVersion=$env:ImageVersion; runnerTemp=$env:RUNNER_TEMP
    freeBytes=$disk.FreeSpace
  }}; exit 0
}
$identity=Identity $TargetPid
if ($null -eq $identity -or $identity.createdAt -cne $CreatedAt -or $identity.executable -ine $Executable) { throw 'Enrolled window identity mismatch' }
$process=[Diagnostics.Process]::GetProcessById($TargetPid)
try {
  if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Enrolled process has no window' }
  Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
  $window=[Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  if ($window.Current.ProcessId -ne $TargetPid) { throw 'Window PID mismatch' }
  $title=$window.Current.Name
  if ($Mode -eq 'invoke') {
    $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$Button)
    $element=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
    if ($null -eq $element -or -not $element.Current.IsEnabled) { throw 'Expected control unavailable' }
    $element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  } elseif ($Mode -eq 'close') {
    $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close()
  }
  Emit @{event='result'; status='passed'; title=$title; windowPid=$TargetPid}
} finally { $process.Dispose() }
