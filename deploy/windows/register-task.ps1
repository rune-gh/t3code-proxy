<#
.SYNOPSIS
  Registers (or removes) the t3code-proxy Scheduled Task on Windows.

.DESCRIPTION
  Used by scripts/install.ps1; can also be run on its own.

  The task runs the hub at logon of the current user and, when this script
  runs elevated, also at system startup. It restarts on failure every minute
  (the Task Scheduler minimum), has no run-time limit, and keeps running on
  battery power.

  It first tries the S4U logon type ("run whether the user is logged on or
  not", no stored password, no console window). If that is refused (usually
  because the shell is not elevated) it falls back to an interactive task
  started through "conhost.exe --headless" so no console window appears.

.EXAMPLE
  .\register-task.ps1 -Exe "$env:LOCALAPPDATA\t3code-proxy\t3code-proxy.exe" -Config "$env:LOCALAPPDATA\t3code-proxy\config.yaml"

.EXAMPLE
  .\register-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
  [string]$Exe,
  [string]$Config,
  [string]$TaskName = "t3code-proxy",
  [switch]$Unregister,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task $TaskName."
  } else {
    Write-Host "Scheduled task $TaskName is not registered."
  }
  return
}

if (-not $Exe -or -not $Config) { throw "-Exe and -Config are required." }
$workDir = Split-Path -Parent $Exe
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew

$triggers = @(New-ScheduledTaskTrigger -AtLogOn -User $user)
if ($elevated) { $triggers += New-ScheduledTaskTrigger -AtStartup }

$arguments = "-config `"$Config`""
$description = "t3code-proxy hub (https://github.com/rune-oai/t3code-proxy)"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute $Exe -Argument $arguments -WorkingDirectory $workDir
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Description $description -Action $action `
    -Trigger $triggers -Settings $settings -Principal $principal | Out-Null
  $registered = $true
  Write-Host "Registered scheduled task $TaskName (runs without a logged-on session)."
} catch {
  Write-Verbose "S4U registration failed: $($_.Exception.Message)"
}

if (-not $registered) {
  $logonOnly = @(New-ScheduledTaskTrigger -AtLogOn -User $user)
  $action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument "--headless `"$Exe`" $arguments" -WorkingDirectory $workDir
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Description $description -Action $action `
    -Trigger $logonOnly -Settings $settings -Principal $principal | Out-Null
  Write-Host "Registered scheduled task $TaskName (starts at logon; run elevated to also start at boot)."
}

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
}
