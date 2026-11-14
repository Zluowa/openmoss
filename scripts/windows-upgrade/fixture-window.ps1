# FILE: scripts/windows-upgrade/fixture-window.ps1
# Purpose: Provide an owned native window with an observable UIAutomation action.
# Layer: release validation fixture
# Exports: none
$ErrorActionPreference='Stop'
$self=[Diagnostics.Process]::GetCurrentProcess()
[Console]::Out.WriteLine((@{event='hello'; identity=@{pid=$PID;createdAt=$self.StartTime.ToUniversalTime().Ticks.ToString();executable=$self.MainModule.FileName}} | ConvertTo-Json -Depth 3 -Compress))
[Console]::Out.Flush()
Add-Type -AssemblyName System.Windows.Forms
$form=New-Object Windows.Forms.Form
$form.Text='Moss fixture ready'
$button=New-Object Windows.Forms.Button
$button.Text='Probe action'
$button.Dock='Fill'
$button.Add_Click({ $form.Text='Moss fixture invoked' })
$form.Controls.Add($button)
try { [Windows.Forms.Application]::Run($form) } finally { $form.Dispose() }
