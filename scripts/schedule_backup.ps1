<#
.SYNOPSIS
  Register (or remove) a daily Windows Scheduled Task that runs the ledger
  backup. Also serves as the Supabase free-tier keep-alive -- the daily
  connection stops the project pausing after 7 idle days.

.EXAMPLE
  # daily 02:00, backups under <repo>/backups, keep 30 days
  powershell -ExecutionPolicy Bypass -File scripts\schedule_backup.ps1

.EXAMPLE
  # write into a cloud-synced folder so the backup leaves this machine
  powershell -ExecutionPolicy Bypass -File scripts\schedule_backup.ps1 -Time 01:30 -KeepDays 60 `
       -OutDir "$env:OneDrive\jho_collects_backups"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\schedule_backup.ps1 -Unregister
#>
[CmdletBinding()]
param(
  [string] $Time = "02:00",
  [int]    $KeepDays = 30,
  [string] $OutDir,
  [string] $TaskName = "jho_collects backup",
  [switch] $Unregister
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "removed scheduled task '$TaskName'"
  return
}

$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pyCmd) { throw "python not found on PATH" }
$python = $pyCmd.Source

if (-not (Test-Path (Join-Path $repo ".env.local"))) {
  Write-Warning "no .env.local at $repo -- the task will fail until it exists"
}

$pyArgs = @("`"$repo\scripts\backup.py`"", "--keep", $KeepDays)
if ($OutDir) { $pyArgs += @("--out", "`"$OutDir`"") }

$action = New-ScheduledTaskAction -Execute $python -Argument ($pyArgs -join " ") `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -DontStopOnIdleEnd -RunOnlyIfNetworkAvailable
# Runs as the current user, only while logged on -- no stored password. A
# personal machine is usually on well within the 7-day keep-alive window.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force `
  -Description "Nightly CSV backup of the card ledger + Supabase keep-alive" | Out-Null

$outNote = if ($OutDir) { " --out `"$OutDir`"" } else { "" }
Write-Host "scheduled '$TaskName' daily at $Time"
Write-Host "  python : $python"
Write-Host "  backup : $repo\scripts\backup.py --keep $KeepDays$outNote"
Write-Host "run now to test:  Start-ScheduledTask -TaskName '$TaskName'"
