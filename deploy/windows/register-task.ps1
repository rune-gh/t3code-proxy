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
  [string]$TaskPath = "\",
  [string]$WorkingDirectory,
  [string]$TemplateXml,
  [PSCredential]$Credential,
  [switch]$Unregister,
  [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
    Write-Information "Removed scheduled task $TaskName." -InformationAction Continue
  } else {
    Write-Information "Scheduled task $TaskName is not registered." -InformationAction Continue
  }
  return
}

if (-not $Exe -or -not $Config) { throw "-Exe and -Config are required." }
$workDir = Split-Path -Parent $Exe
if ($WorkingDirectory) { $workDir = $WorkingDirectory }

# Migration clones the original principal, triggers and settings. Registration
# stays disabled until the caller has proved the old process has exited.
if ($TemplateXml) {
  if (Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue) {
    throw "Migration: Refusing to replace an existing destination task."
  }
  [xml]$xml = [IO.File]::ReadAllText($TemplateXml)
  $ns = New-Object Xml.XmlNamespaceManager($xml.NameTable)
  $namespace = $xml.DocumentElement.NamespaceURI
  $ns.AddNamespace("t", $namespace)
  # The exported URI names the old task; Task Scheduler sets it for the new one.
  $uri = $xml.SelectSingleNode("/t:Task/t:RegistrationInfo/t:URI", $ns)
  if ($null -ne $uri) { $null = $uri.ParentNode.RemoveChild($uri) }
  $actions = $xml.SelectSingleNode("/t:Task/t:Actions", $ns)
  while ($actions.HasChildNodes) { $null = $actions.RemoveChild($actions.FirstChild) }
  $execNode = $xml.CreateElement("Exec", $namespace)
  foreach ($pair in @(@("Command", $Exe), @("Arguments", ('-config "' + $Config + '"')), @("WorkingDirectory", $workDir))) {
    $node = $xml.CreateElement($pair[0], $namespace)
    $node.InnerText = $pair[1]
    $null = $execNode.AppendChild($node)
  }
  $null = $actions.AppendChild($execNode)
  $settingsNode = $xml.SelectSingleNode("/t:Task/t:Settings", $ns)
  foreach ($pair in @(@("Enabled", "false"), @("ExecutionTimeLimit", "PT0S"), @("MultipleInstancesPolicy", "IgnoreNew"))) {
    $node = $settingsNode.SelectSingleNode("t:" + $pair[0], $ns)
    if ($null -eq $node) {
      $node = $xml.CreateElement($pair[0], $namespace)
      $null = $settingsNode.AppendChild($node)
    }
    $node.InnerText = $pair[1]
  }
  if ($null -eq $settingsNode.SelectSingleNode("t:RestartOnFailure", $ns)) {
    $restart = $xml.CreateElement("RestartOnFailure", $namespace)
    foreach ($pair in @(@("Interval", "PT1M"), @("Count", "999"))) {
      $node = $xml.CreateElement($pair[0], $namespace)
      $node.InnerText = $pair[1]
      $null = $restart.AppendChild($node)
    }
    $null = $settingsNode.AppendChild($restart)
  }
  $registration = @{ TaskName = $TaskName; TaskPath = $TaskPath; Xml = $xml.OuterXml }
  if ($null -ne $Credential) {
    $registration.User = $Credential.UserName
    $registration.Password = $Credential.GetNetworkCredential().Password
  }
  Register-ScheduledTask @registration | Out-Null
  if (-not $NoStart) {
    Enable-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath | Out-Null
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
  }
  return
}
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

if (Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
}

$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute $Exe -Argument $arguments -WorkingDirectory $workDir
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Description $description -Action $action `
    -Trigger $triggers -Settings $settings -Principal $principal | Out-Null
  $registered = $true
  Write-Information "Registered scheduled task $TaskName (runs without a logged-on session)." -InformationAction Continue
} catch {
  Write-Verbose "S4U registration failed: $($_.Exception.Message)"
}

if (-not $registered) {
  $logonOnly = @(New-ScheduledTaskTrigger -AtLogOn -User $user)
  $action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument "--headless `"$Exe`" $arguments" -WorkingDirectory $workDir
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Description $description -Action $action `
    -Trigger $logonOnly -Settings $settings -Principal $principal | Out-Null
  Write-Information "Registered scheduled task $TaskName (starts at logon; run elevated to also start at boot)." -InformationAction Continue
}

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
}
