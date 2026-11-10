<#
.SYNOPSIS
  Warns a person when the update mirror's HTTPS certificate is near expiry or broken.

.DESCRIPTION
  An expired certificate sends mainland users back to GitHub with no visible error, so nothing else
  reveals it. This reads the certificate served by the CDN edges DNS returns to this machine, so it
  also catches a renewal that was issued but never deployed. It needs no key.

  Run once with -Install to copy this file to ~/.moss-release and schedule it daily. A missed run
  starts when the machine is next on. Saved as UTF-8 with a BOM because Windows PowerShell 5.1 would
  otherwise misread the Chinese text.

  Exit code: 0 healthy or this machine is offline, 1 alert raised.
#>
[CmdletBinding()]
param(
  [string]$HostName = 'moss-update.comiction.cn',
  # Tencent's 证书托管 is set to swap the certificate 15 days before expiry, so 14 means it missed.
  [int]$WarnDays = 14,
  [string]$ControlHost = 'www.qq.com',
  [int]$RetrySeconds = 30,
  [string]$StateDir = (Join-Path $env:USERPROFILE '.moss-release'),
  [string]$AlertFile = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Moss更新证书告警.txt'),
  [switch]$NoToast,
  [switch]$Install
)

$ErrorActionPreference = 'Stop'
$TaskName = 'MossUpdateCertCheck'
$TimeoutMs = 10000
$LogFile = Join-Path $StateDir 'update-cert-check.log'
$ToastAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

function Write-CheckLog([string]$Line) {
  if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
  Add-Content -LiteralPath $LogFile -Value "$stamp $Line" -Encoding UTF8
  $lines = @(Get-Content -LiteralPath $LogFile -Encoding UTF8)
  if ($lines.Count -gt 1000) { Set-Content -LiteralPath $LogFile -Value $lines[-500..-1] -Encoding UTF8 }
  Write-Output $Line
}

function Test-Reachable([string]$Name) {
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $tcp.BeginConnect($Name, 443, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $tcp.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    $tcp.Close()
  }
}

function Get-EdgeAddresses([string]$Name) {
  try {
    return @([System.Net.Dns]::GetHostAddresses($Name) |
      Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
      ForEach-Object { $_.ToString() })
  } catch {
    return @()
  }
}

# Validation errors are recorded rather than thrown, so an expired or mismatched certificate is still
# read and can be described.
function Get-ServedCertificate([string]$Address, [string]$Sni) {
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $tcp.BeginConnect($Address, 443, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne($TimeoutMs)) { throw 'connection timed out' }
    $tcp.EndConnect($connect)
    $tcp.ReceiveTimeout = $TimeoutMs
    $tcp.SendTimeout = $TimeoutMs
    $script:PolicyErrors = 'None'
    $callback = [System.Net.Security.RemoteCertificateValidationCallback] {
      param($source, $certificate, $chain, $errors)
      $script:PolicyErrors = $errors.ToString()
      return $true
    }
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $callback)
    try {
      $ssl.AuthenticateAsClient($Sni, $null, [System.Security.Authentication.SslProtocols]::Tls12, $false)
      $served = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
      return [pscustomobject]@{
        Address    = $Address
        NotAfter   = $served.NotAfter.ToUniversalTime()
        Thumbprint = $served.Thumbprint
        Errors     = $script:PolicyErrors
      }
    } finally {
      $ssl.Dispose()
    }
  } finally {
    $tcp.Close()
  }
}

function Get-AllEdges([string[]]$Addresses, [string]$Sni) {
  foreach ($address in $Addresses) {
    try {
      Get-ServedCertificate $address $Sni
    } catch {
      Write-CheckLog "edge $address unreadable: $($_.Exception.Message)" | Out-Null
    }
  }
}

function Show-Toast([string]$Title, [string]$Body) {
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $safeTitle = [System.Security.SecurityElement]::Escape($Title)
    $safeBody = [System.Security.SecurityElement]::Escape($Body)
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast scenario='reminder'><visual><binding template='ToastGeneric'><text>$safeTitle</text><text>$safeBody</text></binding></visual><actions><action activationType='system' arguments='dismiss' content='知道了'/></actions></toast>")
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    # A fixed tag makes each day's alert replace the last one instead of piling up.
    $toast.Tag = 'update-cert'
    $toast.Group = 'moss'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($ToastAppId).Show($toast)
  } catch {
    Write-CheckLog "toast failed: $($_.Exception.Message)" | Out-Null
  }
}

function Send-Alert([string]$Problem) {
  $text = @"
Moss 国内更新源的证书出问题了（$((Get-Date).ToString('yyyy-MM-dd HH:mm'))）

问题：$Problem
域名：$HostName

影响：证书失效后，手机号和企业 Key 账号的应用会悄悄退回 GitHub 下载更新，国内用户可能下不动，而且不会有任何报错。

怎么处理：把这个文件的内容发给 Claude，说明要修 Moss 更新证书。处理方法写在 docs/ops/moss-cn-update-mirror.md。
也可以自己看：腾讯云 SSL 证书控制台 https://console.cloud.tencent.com/ssl ，检查账户余额够不够自动续费，以及证书托管是否正常。

这里每天检查一次，问题解决后这个文件会自动删除。
"@
  Set-Content -LiteralPath $AlertFile -Value $text -Encoding UTF8
  Write-CheckLog "ALERT $HostName $Problem"
  if (-not $NoToast) { Show-Toast 'Moss 更新证书需要处理' "$Problem 详情见桌面的告警文件。" }
  exit 1
}

if ($Install) {
  if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }
  $target = Join-Path $StateDir 'check-update-mirror-cert.ps1'
  if ($PSCommandPath -ne $target) { Copy-Item -LiteralPath $PSCommandPath -Destination $target -Force }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$target`""
  $trigger = New-ScheduledTaskTrigger -Daily -At '10:00'
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Warns when the Moss update mirror HTTPS certificate is near expiry or broken.' -Force | Out-Null
  Write-Output "Scheduled $TaskName daily at 10:00, running $target"
  exit 0
}

try {
  $addresses = Get-EdgeAddresses $HostName
  $edges = @(if ($addresses.Count -gt 0) { Get-AllEdges $addresses $HostName })
  if ($edges.Count -eq 0 -and $RetrySeconds -gt 0) {
    Start-Sleep -Seconds $RetrySeconds
    $addresses = Get-EdgeAddresses $HostName
    $edges = @(if ($addresses.Count -gt 0) { Get-AllEdges $addresses $HostName })
  }

  if ($edges.Count -eq 0) {
    if (-not (Test-Reachable $ControlHost)) {
      Write-CheckLog "SKIP this machine looks offline ($ControlHost unreachable too)"
      exit 0
    }
    if ($addresses.Count -eq 0) { Send-Alert '查不到这个域名的地址，可能是解析记录出了问题。' }
    Send-Alert '连不上这个域名的任何节点，HTTPS 打不开。'
  }

  $broken = @($edges | Where-Object { $_.Errors -ne 'None' })
  if ($broken.Count -gt 0) {
    $first = $broken[0]
    Send-Alert "证书校验不通过（$($first.Errors)），到期时间 $($first.NotAfter.ToString('yyyy-MM-dd'))，节点 $($first.Address)。"
  }

  $soonest = ($edges | Sort-Object NotAfter)[0]
  $daysLeft = [int][math]::Floor(($soonest.NotAfter - (Get-Date).ToUniversalTime()).TotalDays)
  if ($daysLeft -le $WarnDays) {
    Send-Alert "证书还剩 $daysLeft 天到期（$($soonest.NotAfter.ToString('yyyy-MM-dd'))），已经过了自动更换的时间，自动续期可能失败了。"
  }

  $distinct = @($edges | Select-Object -ExpandProperty Thumbprint -Unique)
  Write-CheckLog "OK $HostName days=$daysLeft notAfter=$($soonest.NotAfter.ToString('yyyy-MM-dd')) edges=$($edges.Count)/$($addresses.Count) certs=$($distinct.Count) thumbprint=$($soonest.Thumbprint)"
  if (Test-Path -LiteralPath $AlertFile) { Remove-Item -LiteralPath $AlertFile -Force }
  exit 0
} catch {
  Send-Alert "检查程序自身出错：$($_.Exception.Message)"
}
