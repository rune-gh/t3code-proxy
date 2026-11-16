<#
.SYNOPSIS
Safely replace a CLIProxyAPI Scheduled Task, or roll back a named migration.
.DESCRIPTION
Run -WhatIf first. Use -Detached to hand the operation to Task Scheduler before
stopping the hub. See docs/migrating.md for credentials, backups and recovery.
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'The script entry point calls ShouldProcess before any helper mutates state.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'TaskCredentialFile', Justification = 'This string is the path to a DPAPI encrypted PSCredential file.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$NewExe,
  [string]$OldTaskName = 'CLIProxyAPI Hub',
  [string]$TaskPath = '\',
  [string]$NewTaskName = 't3code-proxy',
  [string]$OldExe,
  [string]$Config,
  [string]$WorkingDirectory,
  [string]$BackupRoot,
  [string]$BackupPath,
  [string]$ManagementKeyFile,
  [string]$TaskCredentialFile,
  [switch]$AllowUnknownInFlight,
  [switch]$Detached,
  [switch]$Rollback,
  [switch]$Worker,
  [string]$LaunchTaskName,
  [ValidateRange(10, 900)][int]$WaitSeconds = 90
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FullMigrationPath([string]$Path, [string]$Base) {
  $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim('"'))
  if (-not [IO.Path]::IsPathRooted($expanded)) { $expanded = Join-Path $Base $expanded }
  return [IO.Path]::GetFullPath($expanded)
}

function Get-TaskInstall([xml]$Xml, [string]$ExeOverride, [string]$ConfigOverride, [string]$DirectoryOverride) {
  $ns = New-Object Xml.XmlNamespaceManager($Xml.NameTable)
  $ns.AddNamespace('t', $Xml.DocumentElement.NamespaceURI)
  $actions = @($Xml.SelectNodes('/t:Task/t:Actions/*', $ns))
  if ($actions.Count -ne 1 -or $actions[0].LocalName -ne 'Exec') {
    throw 'Migration: The old task must have one direct executable action.'
  }
  $action = $actions[0]
  $dirNode = $action.SelectSingleNode('t:WorkingDirectory', $ns)
  $directory = ''
  if ($null -ne $dirNode) { $directory = $dirNode.InnerText }
  if ($DirectoryOverride) { $directory = $DirectoryOverride }
  if (-not $directory) { throw 'Migration: Supply -WorkingDirectory for a task without one.' }
  $directory = Get-FullMigrationPath $directory (Get-Location).Path
  $executable = $action.SelectSingleNode('t:Command', $ns).InnerText
  if ($ExeOverride) { $executable = $ExeOverride }
  $executable = Get-FullMigrationPath $executable $directory
  $configPath = $ConfigOverride
  if (-not $configPath) {
    $argumentsNode = $action.SelectSingleNode('t:Arguments', $ns)
    if ($null -eq $argumentsNode) { throw 'Migration: Supply -Config for a task without config arguments.' }
    $match = [regex]::Match($argumentsNode.InnerText, '^\s*--?config(?:=|\s+)(?:"([^"]+)"|(\S+))\s*$')
    if (-not $match.Success) { throw 'Migration: Supply -Config after reviewing the old task arguments. Only -config is inferred.' }
    $configPath = $match.Groups[1].Value
    if (-not $configPath) { $configPath = $match.Groups[2].Value }
  }
  return [pscustomobject]@{
    OldExe = $executable
    Config = (Get-FullMigrationPath $configPath $directory)
    WorkingDirectory = $directory
  }
}

function Get-MigrationAccountCount([string]$Directory) {
  $count = 0
  foreach ($file in @(Get-ChildItem -LiteralPath $Directory -File -Force -Filter '*.json')) {
    try { $record = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json }
    catch { throw 'Migration: An auth JSON file is invalid or unreadable.' }
    if ($null -ne $record -and $null -ne $record.PSObject.Properties['type'] -and $record.type) { $count++ }
  }
  return $count
}

function Get-TreeManifest([string]$Directory, [string]$Base = '', [switch]$Live) {
  # -Live is for a tree a running hub still owns: a file it holds open (its
  # key-value store) is listed as unreadable instead of failing the walk.
  if (-not $Base) { $Base = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/') }
  if (((Get-Item -LiteralPath $Directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Migration: Backup trees must not contain junctions or symbolic links.'
  }
  foreach ($entry in @(Get-ChildItem -LiteralPath $Directory -Force)) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Migration: Backup trees must not contain junctions or symbolic links.'
    }
    $relative = $entry.FullName.Substring($Base.Length + 1)
    if ($entry.PSIsContainer) {
      [pscustomobject]@{ Path = $relative; Hash = 'directory' }
      Get-TreeManifest -Directory $entry.FullName -Base $Base -Live:$Live
    } else {
      $hash = 'unreadable'
      try { $hash = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash }
      catch { if (-not $Live) { throw 'Migration: A file in the backup tree cannot be read.' } }
      [pscustomobject]@{ Path = $relative; Hash = $hash }
    }
  }
}

function Copy-VerifiedTree([string]$Source, [string]$Destination, [switch]$Live) {
  # Strict (default): the hub is stopped, so every file must copy and the tree
  # must not change. -Live: the hub is running, so a file it holds open or is
  # still writing (logs, its key-value store) is recorded as such and captured
  # by the strict copy taken after the stop. Account files must copy either way.
  $before = @(Get-TreeManifest $Source -Live:$Live | Sort-Object Path)
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  New-Item -ItemType Directory -Path $Destination | Out-Null
  foreach ($item in $before) {
    $target = Join-Path $Destination $item.Path
    if ($item.Hash -eq 'directory') {
      New-Item -ItemType Directory -Path $target -Force | Out-Null
      continue
    }
    if ($item.Hash -eq 'unreadable') { continue }
    $parent = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $copied = $true
    try { Copy-Item -LiteralPath (Join-Path $Source $item.Path) -Destination $target -Force }
    catch { $copied = $false }
    if ($copied -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $item.Hash) { continue }
    if (-not $Live) { throw 'Migration: Auth files changed during backup or copy verification failed. Re-run after activity settles.' }
    $item.Hash = 'changed'
  }
  if ($Live) {
    foreach ($item in $before) {
      if ($item.Hash -in @('unreadable', 'changed') -and $item.Path -notmatch '[\\/]' -and $item.Path -like '*.json') {
        throw 'Migration: An account file could not be backed up while the hub is running. Re-run after activity settles.'
      }
    }
    return $before
  }
  $after = @(Get-TreeManifest $Source | Sort-Object Path)
  $copy = @(Get-TreeManifest $Destination | Sort-Object Path)
  if (($before | ConvertTo-Json -Depth 4 -Compress) -cne ($after | ConvertTo-Json -Depth 4 -Compress) -or
      ($after | ConvertTo-Json -Depth 4 -Compress) -cne ($copy | ConvertTo-Json -Depth 4 -Compress)) {
    throw 'Migration: Auth files changed during backup or copy verification failed. Re-run after activity settles.'
  }
  return $copy
}

function Protect-MigrationDirectory([string]$Directory) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($identity)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($identity, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Directory -AclObject $acl
}

function Write-MigrationJson([string]$Path, $Value) {
  $temporary = $Path + '.tmp'
  [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Value -Depth 12), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function ConvertTo-NativeArgument([string]$Value) {
  if ($Value -match '["\r\n]') { throw 'Migration: Quoted or multiline arguments are unsupported.' }
  # CommandLineToArgvW doubles trailing backslashes inside quoted arguments.
  return '"' + [regex]::Replace($Value, '(\\+)$', '$1$1') + '"'
}

function Invoke-MigrationDoctor([switch]$Probe, [string]$ConfigPath = '') {
  if (-not $ConfigPath) {
    $ConfigPath = $script:install.Config
    if ($script:probeConfigPath) { $ConfigPath = $script:probeConfigPath }
  }
  $arguments = @('doctor', '-check-config', '-config', $ConfigPath)
  if ($Probe) {
    $arguments += @('-probe-url', $script:baseUrl)
    if ($ManagementKeyFile) { $arguments += @('-management-key-file', $ManagementKeyFile) }
  }
  # Capture native output in memory. Bound a hung diagnostic without touching
  # either hub process. No temporary stdout file can contain config secrets.
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $NewExe
  $start.Arguments = ($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
  $start.WorkingDirectory = $script:install.WorkingDirectory
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  try {
    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(15000)) {
      $process.Kill()
      $process.WaitForExit()
      throw 'Migration: Read-only doctor probe exceeded 15 seconds.'
    }
    $output = $stdout.GetAwaiter().GetResult()
    $null = $stderr.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
  } finally { $process.Dispose() }
  try { $report = $output | ConvertFrom-Json }
  catch { throw 'Migration: New binary did not return a config-check JSON report.' }
  if ($exitCode -ne 0 -or -not $report.ok) {
    # The doctor's reason is a fixed, redacted string. Do not print its raw output.
    throw 'Migration: Config check or authenticated probe failed. Run doctor -check-config directly for its redacted reason.'
  }
  return $report
}

function Get-ExeProcess([string]$Executable) {
  # Failure to inspect processes fails closed. Match the full executable path.
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $Executable, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-HubListener([int]$Port) {
  # Listeners that a hub bound to the configured address would collide with.
  # A loopback hub shares its port with listeners on other addresses, such as
  # Tailscale Serve on the tailnet address, and those never go away.
  $all = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port })
  $bind = ''
  if (Test-Path -LiteralPath variable:script:bindHost) { $bind = [string]$script:bindHost }
  if ($bind -in @('127.0.0.1', 'localhost')) {
    return @($all | Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1') })
  }
  return $all
}

function Wait-MigrationStopped([string]$Executable, [int]$Port = 0) {
  # Port 0 waits for the process only; the other hub may still own the port.
  $until = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  do {
    $processes = @(Get-ExeProcess $Executable)
    $listeners = @()
    if ($Port -gt 0) { $listeners = @(Get-HubListener $Port) }
    if ($processes.Count -eq 0 -and $listeners.Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $until)
  throw 'Migration: Process exit and free-port barrier failed. The other hub will remain stopped.'
}

function Wait-MigrationHealthy([int]$ExpectedAccounts, [switch]$RequireHealth) {
  $until = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  $lastStatus = 'Authenticated endpoints did not respond.'
  do {
    try {
      $report = Invoke-MigrationDoctor -Probe
      $lastStatus = "Health $($report.probe.health), models $($report.probe.models), file accounts $($report.probe.accounts), expected $ExpectedAccounts, outside the auth directory $($report.probe.accounts_outside_auth_dir)."
      if ($report.probe.models -and $report.probe.accounts -eq $ExpectedAccounts -and $report.probe.accounts_outside_auth_dir -eq 0 -and
          (-not $RequireHealth -or $report.probe.health)) { return }
    } catch { Write-Verbose 'Authenticated readiness checks are still pending.' }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $until)
  throw ('Migration: Hub verification failed. ' + $lastStatus)
}

function Assert-MigrationPrincipal([xml]$Xml) {
  $ns = New-Object Xml.XmlNamespaceManager($Xml.NameTable)
  $ns.AddNamespace('t', $Xml.DocumentElement.NamespaceURI)
  $userNode = $Xml.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:UserId', $ns)
  if ($null -eq $userNode) { throw 'Migration: Group principals are unsupported. Run as the hub task user.' }
  $userId = $userNode.InnerText
  if ($userId -match '^S-1-') { $sid = New-Object Security.Principal.SecurityIdentifier($userId) }
  else { $sid = (New-Object Security.Principal.NTAccount($userId)).Translate([Security.Principal.SecurityIdentifier]) }
  if ($sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User) {
    throw 'Migration: Run this migration as the same Windows user as the old task.'
  }
  $logon = $Xml.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:LogonType', $ns)
  if ($null -eq $logon -or $logon.InnerText -notin @('S4U', 'InteractiveToken', 'Password')) {
    throw 'Migration: Unsupported task logon type.'
  }
  if ($null -ne $script:taskCredential) {
    if ($logon.InnerText -ne 'Password' -or $script:taskCredential -isnot [PSCredential]) { throw 'Migration: A task credential is valid only for Password-logon tasks.' }
    $credentialSid = (New-Object Security.Principal.NTAccount($script:taskCredential.UserName)).Translate([Security.Principal.SecurityIdentifier])
    if ($credentialSid -ne $sid) { throw 'Migration: Task credential must belong to the old task user.' }
  }
  if ($logon.InnerText -eq 'Password' -and $null -eq $script:taskCredential) {
    throw 'Migration: Password-logon tasks require -TaskCredentialFile (same-user DPAPI Export-Clixml).'
  }
}

function Set-MigrationPhase([string]$Name) {
  $script:phase = $Name
  Write-Information "Phase $Name" -InformationAction Continue
  if ($null -ne $script:result) {
    $script:result.Phase = $Name
    Write-MigrationJson (Join-Path $BackupPath 'result.json') $script:result
  }
}

function New-MigrationResult {
  return [ordered]@{ Phase = $script:phase; Success = $false; StartedAt = [DateTime]::UtcNow.ToString('o'); FinishedAt = $null; Reason = ''; BackupPath = $BackupPath; RolledBack = $false }
}

function Start-DetachedMigration {
  $launchName = 't3code-migration-' + [guid]::NewGuid().ToString('N')
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (ConvertTo-NativeArgument $PSCommandPath))
  $forward = @{
    NewExe = $NewExe; OldTaskName = $OldTaskName; TaskPath = $TaskPath; NewTaskName = $NewTaskName
    OldExe = $script:install.OldExe; Config = $script:install.Config; WorkingDirectory = $script:install.WorkingDirectory
    BackupRoot = $BackupRoot; BackupPath = $BackupPath; ManagementKeyFile = $ManagementKeyFile; TaskCredentialFile = $TaskCredentialFile
    WaitSeconds = [string]$WaitSeconds
  }
  foreach ($key in $forward.Keys) {
    if ($forward[$key]) {
      if ([string]$forward[$key] -match '["\r\n]') { throw 'Migration: Quoted or multiline task arguments are unsupported.' }
      $arguments += @('-' + $key, (ConvertTo-NativeArgument ([string]$forward[$key])))
    }
  }
  if ($AllowUnknownInFlight) { $arguments += '-AllowUnknownInFlight' }
  if ($Rollback) { $arguments += '-Rollback' }
  $arguments += @('-Worker', '-LaunchTaskName', (ConvertTo-NativeArgument $launchName))
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
    -Argument ($arguments -join ' ') -WorkingDirectory $script:install.WorkingDirectory
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  $task = Get-ScheduledTask -TaskName $OldTaskName -TaskPath $TaskPath
  $principal = $task.Principal
  $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($elevated) {
    # The worker registers and stops tasks, which a limited token is often not
    # allowed to do. Launched from an elevated shell, it runs elevated too.
    $principal = New-ScheduledTaskPrincipal -UserId $task.Principal.UserId -LogonType $task.Principal.LogonType -RunLevel Highest
  }
  $definition = New-ScheduledTask -Action $action -Settings $settings -Principal $principal
  if ($null -ne $script:taskCredential) {
    Register-ScheduledTask -TaskName $launchName -InputObject $definition -User $script:taskCredential.UserName `
      -Password $script:taskCredential.GetNetworkCredential().Password | Out-Null
  } else { Register-ScheduledTask -TaskName $launchName -InputObject $definition | Out-Null }
  Start-ScheduledTask -TaskName $launchName
  Write-Information "Detached migration task $launchName started." -InformationAction Continue
  Write-Information "Result directory $BackupPath" -InformationAction Continue
}

function Invoke-MigrationRollback($State, [switch]$RestoreConfig) {
  # Stop the new hub first and wait for its process only.
  if (Get-ScheduledTask -TaskName $State.NewTaskName -TaskPath $State.TaskPath -ErrorAction SilentlyContinue) {
    Disable-ScheduledTask -TaskName $State.NewTaskName -TaskPath $State.TaskPath | Out-Null
    Stop-ScheduledTask -TaskName $State.NewTaskName -TaskPath $State.TaskPath
  }
  try { Wait-MigrationStopped $State.NewExe }
  catch {
    # The new hub would not stop, so it is still the one serving. Put its task
    # back in charge before giving up, or a reboot would start no hub at all.
    if (Get-ScheduledTask -TaskName $State.NewTaskName -TaskPath $State.TaskPath -ErrorAction SilentlyContinue) {
      Enable-ScheduledTask -TaskName $State.NewTaskName -TaskPath $State.TaskPath | Out-Null
    }
    throw
  }
  $oldTask = Get-ScheduledTask -TaskName $State.OldTaskName -TaskPath $State.TaskPath -ErrorAction SilentlyContinue
  if (@(Get-ExeProcess $State.OldExe).Count -ne 0) {
    # The old hub never exited. Leave its files alone and put its task back in
    # charge, so a reboot or crash still starts a hub.
    if ($null -eq $oldTask) { throw 'Migration: The old hub is running but its task is missing. Use manual recovery in docs/migrating.md.' }
    Enable-ScheduledTask -TaskName $State.OldTaskName -TaskPath $State.TaskPath | Out-Null
    $serving = $true
    try { Wait-MigrationHealthy (Get-MigrationAccountCount $State.AuthDir) } catch { $serving = $false }
    if ($serving) { return }
    # It is running but not serving: it is still shutting down. Start its task
    # only after that process is gone, so two copies never run together.
    Wait-MigrationStopped $State.OldExe
    Start-ScheduledTask -TaskName $State.OldTaskName -TaskPath $State.TaskPath
    Wait-MigrationHealthy (Get-MigrationAccountCount $State.AuthDir)
    return
  }
  try {
    # Inside the try: if the port stays held, the old task is still enabled and
    # started below, and its restart policy brings the hub up once the port frees.
    Wait-MigrationStopped $State.OldExe $State.Port
    if ($RestoreConfig) {
      $savedConfig = Join-Path $State.BackupPath 'config.yaml'
      if ((Get-FileHash -LiteralPath $savedConfig -Algorithm SHA256).Hash -ne $State.ConfigHash) {
        throw 'Migration: Saved config checksum failed.'
      }
      # Preserve the later config before restoring. Live auth is always retained.
      if (Test-Path -LiteralPath $State.Config) {
        Copy-Item -LiteralPath $State.Config -Destination (Join-Path $State.BackupPath ('config-before-rollback-' + [guid]::NewGuid().ToString('N') + '.yaml'))
      }
      Copy-Item -LiteralPath $savedConfig -Destination $State.Config -Force
      $environmentPath = Join-Path $State.WorkingDirectory '.env'
      $savedEnvironment = Join-Path $State.BackupPath 'environment.env'
      if ($State.EnvironmentHash -and (Get-FileHash -LiteralPath $savedEnvironment -Algorithm SHA256).Hash -ne $State.EnvironmentHash) {
        throw 'Migration: Saved environment checksum failed.'
      }
      if (Test-Path -LiteralPath $environmentPath) {
        Move-Item -LiteralPath $environmentPath -Destination (Join-Path $State.BackupPath ('environment-before-rollback-' + [guid]::NewGuid().ToString('N') + '.env'))
      }
      if ($State.EnvironmentHash) { Copy-Item -LiteralPath $savedEnvironment -Destination $environmentPath }
    }
    if ($null -eq $oldTask) {
      # The migration only ever disables the old task. Register it again only
      # when something else removed it.
      $taskXmlPath = Join-Path $State.BackupPath 'old-task.xml'
      if ((Get-FileHash -LiteralPath $taskXmlPath -Algorithm SHA256).Hash -ne $State.TaskXmlHash) {
        throw 'Migration: Saved task XML checksum failed.'
      }
      $registration = @{ TaskName = $State.OldTaskName; TaskPath = $State.TaskPath; Xml = [IO.File]::ReadAllText($taskXmlPath); Force = $true }
      if ($null -ne $script:taskCredential) {
        $registration.User = $script:taskCredential.UserName
        $registration.Password = $script:taskCredential.GetNetworkCredential().Password
      }
      Register-ScheduledTask @registration | Out-Null
    }
  } finally {
    # Whatever failed above, the old task must end up enabled and started: with
    # the new hub stopped it is the only thing that can serve.
    if (Get-ScheduledTask -TaskName $State.OldTaskName -TaskPath $State.TaskPath -ErrorAction SilentlyContinue) {
      Enable-ScheduledTask -TaskName $State.OldTaskName -TaskPath $State.TaskPath | Out-Null
      Start-ScheduledTask -TaskName $State.OldTaskName -TaskPath $State.TaskPath
    }
  }
  Wait-MigrationHealthy (Get-MigrationAccountCount $State.AuthDir)
}

function Get-MigrationAccountNote($State) {
  # A rollback is verified against the accounts that exist now. Say so when
  # that differs from what the migration recorded before the switch.
  $live = Get-MigrationAccountCount $State.AuthDir
  if ($live -eq $State.AccountCount) { return '' }
  return " Warning: the auth directory now holds $live account files; $($State.AccountCount) were recorded before the switch. Compare it with auth-final in the backup."
}

# Dot sourcing exposes only pure/support functions to Pester.
if ($MyInvocation.InvocationName -eq '.') { return }

# -WhatIf is this script's dry-run switch. Windows PowerShell 5.1 hands the
# preference down to script cmdlets such as Get-FileHash, which then return
# nothing, so the read-only preflight runs with it off and the switch is
# honored at the single point where changes would begin.
$dryRun = [bool]$WhatIfPreference
$WhatIfPreference = $false
$phase = 'preflight'
$stopped = $false
$accountNote = ''
$registeredNew = $false
$transcribing = $false
$lock = $null
$result = $null
$exitCode = 1
$script:taskCredential = $null
$script:probeConfigPath = ''
try {
  if ($Worker) {
    if (-not $BackupPath -or -not (Test-Path -LiteralPath (Join-Path $BackupPath 'result.json'))) {
      throw 'Migration: Detached worker requires its prepared result directory.'
    }
    Start-Transcript -LiteralPath (Join-Path $BackupPath ('transcript-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.log')) | Out-Null
    $transcribing = $true
    $result = New-MigrationResult
    Write-MigrationJson (Join-Path $BackupPath 'result.json') $result
  }
  if ($env:OS -ne 'Windows_NT') { throw 'Migration: Run this script on Windows.' }
  Write-Verbose "Readiness wait budget $WaitSeconds seconds."
  if ($TaskCredentialFile) { $script:taskCredential = Import-Clixml -LiteralPath $TaskCredentialFile }
  $oldTask = Get-ScheduledTask -TaskName $OldTaskName -TaskPath $TaskPath
  [xml]$oldXml = Export-ScheduledTask -TaskName $OldTaskName -TaskPath $TaskPath
  Assert-MigrationPrincipal $oldXml
  $script:install = Get-TaskInstall -Xml $oldXml -ExeOverride $OldExe -ConfigOverride $Config -DirectoryOverride $WorkingDirectory
  $oldArguments = [string]$oldTask.Actions[0].Arguments
  if ($Config -and $oldArguments -notmatch '^\s*--?config(?:=|\s+)(?:"[^"]+"|\S+)\s*$') {
    Write-Warning 'The old task runs with arguments other than -config. The replacement task will run with -config only; add anything else it needs to the config file.'
  }
  if ($Rollback) {
    if (-not $BackupPath) { throw 'Migration: -Rollback requires a named -BackupPath.' }
    $BackupPath = [IO.Path]::GetFullPath($BackupPath)
    $state = [IO.File]::ReadAllText((Join-Path $BackupPath 'migration.json')) | ConvertFrom-Json
    if ($state.OldTaskName -ne $OldTaskName -or $state.TaskPath -ne $TaskPath) { throw 'Migration: Backup belongs to another task.' }
    foreach ($pair in @(@('config.yaml', $state.ConfigHash), @('old-task.xml', $state.TaskXmlHash))) {
      if ((Get-FileHash -LiteralPath (Join-Path $BackupPath $pair[0]) -Algorithm SHA256).Hash -ne $pair[1]) { throw 'Migration: Backup config or task XML checksum failed.' }
    }
    if ($state.EnvironmentHash -and (Get-FileHash -LiteralPath (Join-Path $BackupPath 'environment.env') -Algorithm SHA256).Hash -ne $state.EnvironmentHash) { throw 'Migration: Backup environment checksum failed.' }
    $state.BackupPath = $BackupPath
    $script:probeConfigPath = Join-Path $BackupPath 'config.yaml'
    $NewExe = $state.NewExe
    $NewTaskName = $state.NewTaskName
    $script:install = [pscustomobject]@{ OldExe = $state.OldExe; Config = $state.Config; WorkingDirectory = $state.WorkingDirectory }
  }
  if (-not $NewExe) { throw 'Migration: Supply an already staged -NewExe.' }
  $NewExe = Get-FullMigrationPath $NewExe (Get-Location).Path
  if ($NewExe -eq $script:install.OldExe) { throw 'Migration: Stage the new binary at a different path from the old binary.' }
  if ($NewTaskName -eq $OldTaskName) { throw 'Migration: Old and new task names must differ.' }
  $requiredInstallPaths = @($NewExe, $script:install.OldExe, $script:install.WorkingDirectory)
  if (-not $Rollback) { $requiredInstallPaths += $script:install.Config }
  foreach ($path in $requiredInstallPaths) {
    if (-not (Test-Path -LiteralPath $path)) { throw 'Migration: A binary, config or working-directory path is missing.' }
  }
  if ($ManagementKeyFile) { $ManagementKeyFile = Get-FullMigrationPath $ManagementKeyFile (Get-Location).Path }
  if ($TaskCredentialFile) { $TaskCredentialFile = Get-FullMigrationPath $TaskCredentialFile (Get-Location).Path }
  $registerScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy\windows\register-task.ps1'
  if (-not (Test-Path -LiteralPath $registerScript)) { throw 'Migration: Keep deploy/windows/register-task.ps1 alongside scripts/.' }
  Push-Location $script:install.WorkingDirectory
  try {
    if ($Rollback) { $check = Invoke-MigrationDoctor -ConfigPath (Join-Path $BackupPath 'config.yaml') }
    else { $check = Invoke-MigrationDoctor }
  } finally { Pop-Location }
  if ($check.settings.tls -or $check.settings.port -lt 1 -or $check.settings.port -gt 65535) {
    throw 'Migration: This procedure requires a local HTTP hub on a valid port.'
  }
  if ($check.settings.host -notin @('127.0.0.1', 'localhost', '', '0.0.0.0', '::', '[::]')) { throw 'Migration: The configured bind address does not include loopback.' }
  if ($Rollback -and ($check.settings.auth_dir -ne $state.AuthDir -or $check.settings.port -ne $state.Port)) { throw 'Migration: Auth directory or port changed since backup. Review manual recovery before restoring config.' }
  $script:baseUrl = 'http://127.0.0.1:' + $check.settings.port
  $script:bindHost = [string]$check.settings.host
  foreach ($path in $check.settings.required_paths) {
    $resolved = Get-FullMigrationPath $path $script:install.WorkingDirectory
    if (-not (Test-Path -LiteralPath $resolved)) { throw 'Migration: A configured auth, catalog, TLS or plugin path is missing.' }
  }
  if ($oldXml.OuterXml -notmatch '<RestartOnFailure>') {
    Write-Warning 'The old task has no restart-on-failure setting, so after a rollback it starts once and is not retried if the port is briefly held.'
  }
  foreach ($key in $check.unknown_keys) { Write-Warning "Ignored configuration key $key" }
  foreach ($issue in $check.issues) { Write-Warning "Configuration diagnostic $issue" }
  $environmentFile = Join-Path $script:install.WorkingDirectory '.env'
  $environmentHash = ''
  if (Test-Path -LiteralPath $environmentFile) { $environmentHash = (Get-FileHash -LiteralPath $environmentFile -Algorithm SHA256).Hash }
  $authDir = $check.settings.auth_dir
  $null = @(Get-TreeManifest $authDir -Live)
  $accountCount = Get-MigrationAccountCount $authDir
  $helper = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -like '*Catalog*Refresh*' })
  foreach ($helperTask in $helper) { Write-Information "Catalog helper task $($helperTask.TaskPath)$($helperTask.TaskName) remains registered." -InformationAction Continue }
  Write-Information "Catalog helper tasks found $($helper.Count)." -InformationAction Continue
  if (-not $BackupRoot) { $BackupRoot = Join-Path (Split-Path -Parent $script:install.WorkingDirectory) 't3code-migration-backups' }
  $BackupRoot = Get-FullMigrationPath $BackupRoot (Get-Location).Path
  if (-not $BackupPath) { $BackupPath = Join-Path $BackupRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
  $BackupPath = [IO.Path]::GetFullPath($BackupPath)
  $authPrefix = [IO.Path]::GetFullPath($authDir).TrimEnd('\') + '\'
  if (($BackupPath + '\').StartsWith($authPrefix, [StringComparison]::OrdinalIgnoreCase) -or $authPrefix.StartsWith($BackupPath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Migration: Backups must be outside the auth directory.' }
  $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($BackupPath))
  $authSize = (Get-ChildItem -LiteralPath $authDir -File -Force -Recurse | Measure-Object Length -Sum).Sum
  if ($null -eq $authSize) { $authSize = 0 }
  # A rollback copies no auth tree, so a full backup volume must not refuse it.
  if (-not $Rollback -and $drive.AvailableFreeSpace -lt (2 * $authSize + 64MB)) { throw 'Migration: Backup volume needs twice the auth size plus 64 MiB free.' }
  if (-not $Rollback) {
    $existingNew = Get-ScheduledTask -TaskName $NewTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if ($null -ne $existingNew) {
      $previousStatePath = Join-Path $BackupPath 'migration.json'
      $previousResultPath = Join-Path $BackupPath 'result.json'
      if (-not $Worker -and (Test-Path -LiteralPath $previousStatePath) -and (Test-Path -LiteralPath $previousResultPath)) {
        $previousState = [IO.File]::ReadAllText($previousStatePath) | ConvertFrom-Json
        $previousResult = [IO.File]::ReadAllText($previousResultPath) | ConvertFrom-Json
        if ($previousResult.Success -and -not $previousResult.RolledBack -and $previousState.NewExe -eq $NewExe -and
            $previousState.Config -eq $script:install.Config -and $previousState.OldTaskName -eq $OldTaskName -and
            $previousState.NewTaskName -eq $NewTaskName -and $previousState.TaskPath -eq $TaskPath -and -not $oldTask.Settings.Enabled) {
          $savedConfig = Join-Path $BackupPath 'config.yaml'
          if ((Get-FileHash -LiteralPath $savedConfig -Algorithm SHA256).Hash -ne $previousState.ConfigHash) { throw 'Migration: Named migration config backup checksum failed.' }
          $script:probeConfigPath = $savedConfig
          Wait-MigrationHealthy (Get-MigrationAccountCount $authDir) -RequireHealth
          Write-Information 'This named migration already succeeded and the new hub still passes authenticated checks.' -InformationAction Continue
          return
        }
      }
      throw 'Migration: New task already exists. Use its named backup for rollback or choose another new task name.'
    }
    if (@(Get-ExeProcess $NewExe).Count -ne 0) { throw 'Migration: The staged binary is already running.' }
    $oldProcesses = @(Get-ExeProcess $script:install.OldExe)
    if ($oldProcesses.Count -ne 1 -or $oldTask.State -ne 'Running') { throw 'Migration: Expected exactly one running old hub owned by its running task.' }
    $listeners = @(Get-HubListener $check.settings.port)
    if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.OwningProcess -ne $oldProcesses[0].ProcessId }).Count -ne 0) {
      throw 'Migration: The old executable must own every listener on the configured port.'
    }
    Push-Location $script:install.WorkingDirectory
    try { $probe = Invoke-MigrationDoctor -Probe } finally { Pop-Location }
    if ($probe.probe.accounts -ne $accountCount) { throw 'Migration: Old management account count differs from auth files. Resolve this before switching.' }
    if ($probe.probe.accounts_outside_auth_dir -ne 0) { throw 'Migration: The old hub serves accounts that are not files in the auth directory the new hub would use. Set oauth.auth-dir explicitly before switching.' }
    Write-Information "Preflight found $accountCount file-backed accounts on port $($check.settings.port)." -InformationAction Continue
    if ($probe.probe.in_flight -lt 0) {
      Write-Warning 'In-flight requests are unavailable on this hub. Pause clients and use -AllowUnknownInFlight to accept this gap.'
      if (-not $AllowUnknownInFlight -and -not $dryRun) { throw 'Migration: In-flight status unavailable; -AllowUnknownInFlight is required.' }
    } elseif ($probe.probe.in_flight -gt 0) {
      Write-Warning "In-flight request count $($probe.probe.in_flight)."
      if (-not $dryRun) { throw 'Migration: Requests are in flight. Pause clients and re-run when idle.' }
    }
  }
  Write-Information 'Plan includes verified backup, disabling/stopping old, process exit and free-port checks, registering/starting new, authenticated verification and automatic rollback on failure.' -InformationAction Continue
  Write-Information "Backup and result directory $BackupPath" -InformationAction Continue
  if ($dryRun) {
    Write-Information ('Dry run complete. Preflight passed and nothing was changed. A real run would ' + $(if ($Rollback) { 'roll back the named migration.' } else { 'migrate the hub.' })) -InformationAction Continue
    return
  }
  if (-not $PSCmdlet.ShouldProcess($OldTaskName, $(if ($Rollback) { 'Roll back named migration' } else { 'Migrate hub' }))) { return }
  if ($Detached) {
    if (-not $Rollback) {
      if (Test-Path -LiteralPath $BackupPath) { throw 'Migration: Backup directory already exists.' }
      New-Item -ItemType Directory -Path $BackupPath | Out-Null
    }
    Protect-MigrationDirectory $BackupPath
    $result = New-MigrationResult
    Set-MigrationPhase 'detached-launch'
    Start-DetachedMigration
    # The worker owns subsequent result updates, including preflight failures.
    $result = $null
    return
  }
  $lockPath = Join-Path $script:install.WorkingDirectory '.t3code-migration.lock'
  $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  if (-not $Rollback -and -not $Worker) {
    if (Test-Path -LiteralPath $BackupPath) { throw 'Migration: Backup directory already exists. Choose a new path.' }
    New-Item -ItemType Directory -Path $BackupPath | Out-Null
  }
  Protect-MigrationDirectory $BackupPath
  if (-not $transcribing) {
    Start-Transcript -LiteralPath (Join-Path $BackupPath ('transcript-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.log')) | Out-Null
    $transcribing = $true
    $result = New-MigrationResult
    Write-MigrationJson (Join-Path $BackupPath 'result.json') $result
  }
  Push-Location $script:install.WorkingDirectory
  try {
    if ($Rollback) {
      Set-MigrationPhase 'rollback'
      Invoke-MigrationRollback $state -RestoreConfig
      $result.RolledBack = $true
      $accountNote = Get-MigrationAccountNote $state
    } else {
      Set-MigrationPhase 'backup'
      Copy-Item -LiteralPath $script:install.Config -Destination (Join-Path $BackupPath 'config.yaml')
      # Use the immutable config snapshot for authenticated probes. Startup can
      # replace the live plaintext management key with its bcrypt hash.
      $script:probeConfigPath = Join-Path $BackupPath 'config.yaml'
      $configHash = (Get-FileHash -LiteralPath (Join-Path $BackupPath 'config.yaml') -Algorithm SHA256).Hash
      if ($configHash -ne $check.settings.config_sha256) { throw 'Migration: Config changed after preflight.' }
      [IO.File]::WriteAllText((Join-Path $BackupPath 'old-task.xml'), $oldXml.OuterXml, [Text.Encoding]::Unicode)
      $exportCheck = [xml]([IO.File]::ReadAllText((Join-Path $BackupPath 'old-task.xml')))
      if ($exportCheck.OuterXml -cne $oldXml.OuterXml) { throw 'Migration: Task XML backup verification failed.' }
      $environmentFile = Join-Path $script:install.WorkingDirectory '.env'
      if ($environmentHash) {
        Copy-Item -LiteralPath $environmentFile -Destination (Join-Path $BackupPath 'environment.env')
        if ((Get-FileHash -LiteralPath (Join-Path $BackupPath 'environment.env') -Algorithm SHA256).Hash -ne $environmentHash) { throw 'Migration: Environment file changed during backup.' }
      }
      # The hub is still running here, so this first copy tolerates the files it
      # holds open; the strict copy after the stop captures everything.
      $manifest = @(Copy-VerifiedTree $authDir (Join-Path $BackupPath 'auth') -Live)
      Write-MigrationJson (Join-Path $BackupPath 'auth-manifest.json') $manifest
      $deferred = @($manifest | Where-Object { $_.Hash -in @('unreadable', 'changed') }).Count
      if ($deferred -gt 0) { Write-Information "$deferred file(s) in use by the running hub will be captured after it stops." -InformationAction Continue }
      $state = [ordered]@{
        OldTaskName = $OldTaskName; NewTaskName = $NewTaskName; TaskPath = $TaskPath
        OldExe = $script:install.OldExe; NewExe = $NewExe; Config = $script:install.Config
        WorkingDirectory = $script:install.WorkingDirectory; AuthDir = $authDir; Port = $check.settings.port
        ConfigHash = $configHash; AccountCount = $accountCount; EnvironmentHash = $environmentHash; BackupPath = $BackupPath
        TaskXmlHash = (Get-FileHash -LiteralPath (Join-Path $BackupPath 'old-task.xml') -Algorithm SHA256).Hash
      }
      Write-MigrationJson (Join-Path $BackupPath 'migration.json') $state
      $lastProbe = Invoke-MigrationDoctor -Probe
      if ((Get-FileHash -LiteralPath $script:install.Config -Algorithm SHA256).Hash -ne $check.settings.config_sha256) { throw 'Migration: Config changed during backup.' }
      if ($lastProbe.probe.in_flight -gt 0 -or ($lastProbe.probe.in_flight -lt 0 -and -not $AllowUnknownInFlight)) {
        throw 'Migration: Requests appeared or in-flight status became unavailable during backup.'
      }
      $currentEnvironmentHash = ''
      if (Test-Path -LiteralPath $environmentFile) { $currentEnvironmentHash = (Get-FileHash -LiteralPath $environmentFile -Algorithm SHA256).Hash }
      if ($currentEnvironmentHash -ne $environmentHash) { throw 'Migration: Working-directory environment changed after preflight.' }
      [xml]$currentTaskXml = Export-ScheduledTask -TaskName $OldTaskName -TaskPath $TaskPath
      if ($currentTaskXml.OuterXml -cne $oldXml.OuterXml) { throw 'Migration: Old task definition changed during backup.' }
      Set-MigrationPhase 'register-new'
      # Register the replacement, still disabled, while the old hub is serving.
      # A registration this account is not allowed to make fails here, before
      # anything has been stopped.
      & $registerScript -Exe $NewExe -Config $script:install.Config -WorkingDirectory $script:install.WorkingDirectory `
        -TaskName $NewTaskName -TaskPath $TaskPath -TemplateXml (Join-Path $BackupPath 'old-task.xml') -Credential $script:taskCredential -NoStart
      $registeredNew = $true
      if ((Get-ScheduledTask -TaskName $NewTaskName -TaskPath $TaskPath).Settings.Enabled) { throw 'Migration: The replacement task must be registered disabled.' }
      Set-MigrationPhase 'switch-stop-old'
      # Disable before stopping so task triggers and restart policy cannot relaunch it.
      Disable-ScheduledTask -TaskName $OldTaskName -TaskPath $TaskPath | Out-Null
      $stopped = $true
      Stop-ScheduledTask -TaskName $OldTaskName -TaskPath $TaskPath
      Wait-MigrationStopped $script:install.OldExe $state.Port
      if ((Get-FileHash -LiteralPath $script:install.Config -Algorithm SHA256).Hash -ne $state.ConfigHash) { throw 'Migration: Config changed while stopping the old hub.' }
      # Capture the last token rotations after the process-exit barrier, next to
      # the first verified copy instead of over it.
      $manifest = @(Copy-VerifiedTree $authDir (Join-Path $BackupPath 'auth-final'))
      Write-MigrationJson (Join-Path $BackupPath 'auth-final-manifest.json') $manifest
      if ((Get-MigrationAccountCount (Join-Path $BackupPath 'auth-final')) -ne $state.AccountCount) { throw 'Migration: Account set changed during the switch.' }
      Set-MigrationPhase 'switch-start-new'
      Enable-ScheduledTask -TaskName $NewTaskName -TaskPath $TaskPath | Out-Null
      Start-ScheduledTask -TaskName $NewTaskName -TaskPath $TaskPath
      Set-MigrationPhase 'verify'
      Wait-MigrationHealthy $state.AccountCount -RequireHealth
      if (@(Get-ExeProcess $script:install.OldExe).Count -ne 0) { throw 'Migration: Old executable reappeared during verification.' }
    }
    $result.Success = $true
    $result.Reason = 'Completed and authenticated checks passed.' + $accountNote
    $result.FinishedAt = [DateTime]::UtcNow.ToString('o')
    Write-MigrationJson (Join-Path $BackupPath 'result.json') $result
    $exitCode = 0
  } finally { Pop-Location }
} catch {
  $reason = "Phase $phase failed ($($_.Exception.GetType().Name))."
  if ($_.Exception.Message.StartsWith('Migration:')) { $reason = $_.Exception.Message }
  Write-Information $reason -InformationAction Continue
  if ($null -ne $result) {
    $result.Success = $false
    $result.Reason = $reason
    if ($stopped -and -not $Rollback) {
      try {
        Push-Location $script:install.WorkingDirectory
        try { Invoke-MigrationRollback $state -RestoreConfig } finally { Pop-Location }
        $result.RolledBack = $true
        $result.Reason += ' Old hub restarted and authenticated checks passed.' + (Get-MigrationAccountNote $state)
      } catch {
        $rollbackReason = 'Rollback task operation or verification failed.'
        if ($_.Exception.Message.StartsWith('Migration:')) { $rollbackReason = $_.Exception.Message }
        $result.Reason += ' Automatic rollback failed. ' + $rollbackReason + ' Use manual recovery in docs/migrating.md.'
        # Last resort: with the new hub not running, leave the old task enabled
        # so the next boot or crash restart brings a hub back.
        try {
          if (@(Get-ExeProcess $NewExe).Count -eq 0 -and (Get-ScheduledTask -TaskName $OldTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue)) {
            Enable-ScheduledTask -TaskName $OldTaskName -TaskPath $TaskPath | Out-Null
            $result.Reason += ' The old task was left enabled.'
          } elseif (@(Get-ExeProcess $NewExe).Count -ne 0 -and (Get-ScheduledTask -TaskName $NewTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue)) {
            # The new hub would not stop and is still the one serving. Leave its
            # task enabled so a reboot does not come up with no hub at all.
            Enable-ScheduledTask -TaskName $NewTaskName -TaskPath $TaskPath | Out-Null
            $result.Reason += ' The new hub is still running and its task was left enabled.'
          }
        } catch { $result.Reason += ' The old task could not be re-enabled.' }
      }
    } elseif ($registeredNew -and -not $Rollback) {
      # Nothing was stopped. Remove the disabled replacement so a re-run starts clean.
      try {
        Unregister-ScheduledTask -TaskName $NewTaskName -TaskPath $TaskPath -Confirm:$false
        $result.Reason += ' The old hub was not touched.'
      } catch { $result.Reason += ' The disabled replacement task could not be removed; remove it before re-running.' }
    }
  }
} finally {
  if ($null -ne $result) {
    $result.Phase = $phase
    $result.FinishedAt = [DateTime]::UtcNow.ToString('o')
    try { Write-MigrationJson (Join-Path $BackupPath 'result.json') $result }
    catch { Write-Warning 'Could not persist the final result. Check disk space and the task/log state.' }
    Write-Information "Success $($result.Success). Rolled back $($result.RolledBack). Result $(Join-Path $BackupPath 'result.json')" -InformationAction Continue
  }
  try {
    if ($transcribing) { Stop-Transcript | Out-Null }
  } finally {
    if ($null -ne $lock) { $lock.Dispose() }
    # The one-shot launch task has done its job; its definition holds file paths.
    if ($Worker -and $LaunchTaskName -like 't3code-migration-*') {
      Unregister-ScheduledTask -TaskName $LaunchTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
  }
}
exit $exitCode
