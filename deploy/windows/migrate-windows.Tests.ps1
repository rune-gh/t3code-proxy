BeforeAll {
  . (Join-Path $PSScriptRoot '../../scripts/migrate-windows.ps1')
}

Describe 'Migration path and task discovery' {
  It 'reads a quoted config path and preserves the working directory' {
    $directory = Join-Path $TestDrive 'old hub'
    [xml]$taskXml = @"
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Actions><Exec>
<Command>cli-proxy-api.exe</Command><Arguments>-config &quot;config with spaces.yaml&quot;</Arguments>
<WorkingDirectory>$directory</WorkingDirectory></Exec></Actions></Task>
"@
    $install = Get-TaskInstall $taskXml '' '' ''
    $install.WorkingDirectory | Should -Be $directory
    $install.Config | Should -Be (Join-Path $directory 'config with spaces.yaml')
    $install.OldExe | Should -Be (Join-Path $directory 'cli-proxy-api.exe')
  }

  It 'requires an override for additional legacy arguments' {
    [xml]$taskXml = @"
<Task xmlns="urn:test"><Actions><Exec><Command>old.exe</Command>
<Arguments>-config config.yaml -login</Arguments><WorkingDirectory>$TestDrive</WorkingDirectory></Exec></Actions></Task>
"@
    { Get-TaskInstall $taskXml '' '' '' } | Should -Throw '*Supply -Config*'
    (Get-TaskInstall $taskXml '' 'reviewed.yaml' '').Config | Should -Be (Join-Path $TestDrive 'reviewed.yaml')
  }

  It 'rejects multiple actions' {
    [xml]$taskXml = '<Task xmlns="urn:test"><Actions><Exec/><Exec/></Actions></Task>'
    { Get-TaskInstall $taskXml '' '' '' } | Should -Throw '*one direct executable*'
  }

  It 'quotes native arguments including a trailing backslash' {
    ConvertTo-NativeArgument 'C:\old hub\' | Should -Be '"C:\old hub\\"'
    ConvertTo-NativeArgument '\' | Should -Be '"\\"'
    { ConvertTo-NativeArgument 'a"b' } | Should -Throw
  }
}

Describe 'Verified backups' {
  It 'copies hidden state and empty directories and detects a different file' {
    $source = Join-Path $TestDrive 'auth'
    $destination = Join-Path $TestDrive 'backup'
    New-Item -ItemType Directory -Path (Join-Path $source '.codex-refresh'), (Join-Path $source 'empty') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $source '.codex-refresh/journal') -Value 'rotation-state'
    Set-Content -LiteralPath (Join-Path $source 'account.json') -Value '{"type":"codex","refresh_token":"do-not-print"}'
    $manifest = @(Copy-VerifiedTree $source $destination)
    $manifest.Count | Should -Be 4
    (Get-Content -LiteralPath (Join-Path $destination '.codex-refresh/journal') -Raw).Trim() | Should -Be 'rotation-state'
    Test-Path -LiteralPath (Join-Path $destination 'empty') | Should -BeTrue
    Get-MigrationAccountCount $destination | Should -Be 1
    Set-Content -LiteralPath (Join-Path $destination 'account.json') -Value 'different'
    (@(Get-TreeManifest $destination) | ConvertTo-Json -Compress) | Should -Not -Be ($manifest | ConvertTo-Json -Compress)
  }

  It 'tolerates a file the running hub holds open in a live copy, but never an account file' {
    $source = Join-Path $TestDrive 'live-auth'
    New-Item -ItemType Directory -Path (Join-Path $source 'logs') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $source 'account.json') -Value '{"type":"codex"}'
    Set-Content -LiteralPath (Join-Path $source 'kv.db') -Value 'store'
    Set-Content -LiteralPath (Join-Path $source 'logs/error.log') -Value 'log'
    $held = [IO.File]::Open((Join-Path $source 'kv.db'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
      { Copy-VerifiedTree $source (Join-Path $TestDrive 'strict-copy') } | Should -Throw '*cannot be read*'
      $manifest = @(Copy-VerifiedTree $source (Join-Path $TestDrive 'live-copy') -Live)
      ($manifest | Where-Object Path -eq 'kv.db').Hash | Should -Be 'unreadable'
      Test-Path -LiteralPath (Join-Path $TestDrive 'live-copy/kv.db') | Should -BeFalse
      Test-Path -LiteralPath (Join-Path $TestDrive 'live-copy/account.json') | Should -BeTrue
      Test-Path -LiteralPath (Join-Path $TestDrive 'live-copy/logs/error.log') | Should -BeTrue
    } finally { $held.Dispose() }
    $heldAccount = [IO.File]::Open((Join-Path $source 'account.json'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
      { Copy-VerifiedTree $source (Join-Path $TestDrive 'live-copy-2') -Live } | Should -Throw '*account file could not be backed up*'
    } finally { $heldAccount.Dispose() }
  }

  It 'ignores listeners on other addresses for a loopback hub' {
    function Get-NetTCPConnection { param($State, $ErrorAction) }
    Mock Get-NetTCPConnection {
      return @(
        [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8317; OwningProcess = 10 },
        [pscustomobject]@{ LocalAddress = '100.64.0.1'; LocalPort = 8317; OwningProcess = 20 },
        [pscustomobject]@{ LocalAddress = 'fd7a::1'; LocalPort = 8317; OwningProcess = 20 },
        [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 9000; OwningProcess = 30 }
      )
    }
    $script:bindHost = '127.0.0.1'
    @(Get-HubListener 8317).Count | Should -Be 1
    $script:bindHost = ''
    @(Get-HubListener 8317).Count | Should -Be 3
  }

  It 'counts root account JSON without counting journals or unrelated JSON' {
    $source = Join-Path $TestDrive 'count'
    New-Item -ItemType Directory -Path (Join-Path $source '.codex-refresh') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $source 'one.json') -Value '{"type":"claude"}'
    Set-Content -LiteralPath (Join-Path $source 'cache.json') -Value '{}'
    Set-Content -LiteralPath (Join-Path $source '.codex-refresh/state.json') -Value '{"type":"codex"}'
    Get-MigrationAccountCount $source | Should -Be 1
  }

  It 'redacts malformed auth content' {
    $source = Join-Path $TestDrive 'invalid'
    New-Item -ItemType Directory -Path $source | Out-Null
    Set-Content -LiteralPath (Join-Path $source 'bad.json') -Value 'secret-content-malformed-json'
    { Get-MigrationAccountCount $source } | Should -Throw 'Migration: An auth JSON file is invalid or unreadable.'
  }
}

Describe 'Rollback process barriers' {
  BeforeAll {
    # Cmdlet stubs make the same checks runnable on macOS without Windows access.
    function Get-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction) return $true }
    function Disable-ScheduledTask { param($TaskName, $TaskPath) }
    function Stop-ScheduledTask { param($TaskName, $TaskPath) }
    function Enable-ScheduledTask { param($TaskName, $TaskPath) }
    function Start-ScheduledTask { param($TaskName, $TaskPath) }
    function Register-ScheduledTask { param($TaskName, $TaskPath, $Xml, $Force) }
  }
  BeforeEach {
    $script:events = New-Object 'Collections.Generic.List[string]'
    $script:taskCredential = $null
    $script:BackupPath = $TestDrive
    Set-Content -LiteralPath (Join-Path $TestDrive 'old-task.xml') -Value '<Task />'
    $state = [pscustomobject]@{ NewTaskName = 'new'; OldTaskName = 'old'; TaskPath = '\'; NewExe = 'new.exe'; OldExe = 'old.exe'; Port = 8317; AccountCount = 2; AuthDir = 'auth'; TaskXmlHash = 'checksum'; BackupPath = $TestDrive }
    Mock Get-FileHash { return [pscustomobject]@{ Hash = 'checksum' } }
    Mock Get-Content { return '<Task />' }
    Mock Register-ScheduledTask { $script:events.Add('register-' + $TaskName) }
    Mock Disable-ScheduledTask { $script:events.Add('disable-' + $TaskName) }
    Mock Stop-ScheduledTask { $script:events.Add('stop-' + $TaskName) }
    Mock Enable-ScheduledTask { $script:events.Add('enable-' + $TaskName) }
    Mock Start-ScheduledTask { $script:events.Add('start-' + $TaskName) }
    Mock Wait-MigrationStopped { $script:events.Add('barrier-' + $Executable) }
    Mock Get-MigrationAccountCount { return 2 }
    Mock Wait-MigrationHealthy { $script:events.Add('verify-old') }
  }
  It 'starts the old task only after both executable barriers, without re-registering it' {
    Mock Get-ExeProcess { return @() }
    Invoke-MigrationRollback $state
    ($script:events -join ',') | Should -Be 'disable-new,stop-new,barrier-new.exe,barrier-old.exe,enable-old,start-old,verify-old'
  }
  It 'keeps the old task stopped and re-enables the new one if the new process cannot be proved gone' {
    Mock Get-ExeProcess { return @() }
    Mock Wait-MigrationStopped { throw 'Migration: still running' }
    { Invoke-MigrationRollback $state } | Should -Throw '*still running*'
    Should -Invoke Start-ScheduledTask -Times 0
    ($script:events -join ',') | Should -Be 'disable-new,stop-new,enable-new'
  }
  It 'still enables and starts the old task when the port stays held after both hubs exited' {
    Mock Get-ExeProcess { return @() }
    Mock Wait-MigrationStopped { if ($Port -gt 0) { throw 'Migration: port held' } }
    { Invoke-MigrationRollback $state } | Should -Throw '*port held*'
    Should -Invoke Enable-ScheduledTask -Times 1
    Should -Invoke Start-ScheduledTask -Times 1
  }
  It 're-enables the old task without starting it when the old hub never exited' {
    Mock Get-ExeProcess { if ($Executable -eq 'old.exe') { return @(1) } return @() }
    Invoke-MigrationRollback $state
    ($script:events -join ',') | Should -Be 'disable-new,stop-new,barrier-new.exe,enable-old,verify-old'
  }
  It 'starts the old task after a lingering old process has gone, never beside it' {
    Mock Get-ExeProcess { if ($Executable -eq 'old.exe') { return @(1) } return @() }
    $script:healthChecks = 0
    Mock Wait-MigrationHealthy { $script:healthChecks++; $script:events.Add('verify-old'); if ($script:healthChecks -eq 1) { throw 'Migration: not serving' } }
    Invoke-MigrationRollback $state
    ($script:events -join ',') | Should -Be 'disable-new,stop-new,barrier-new.exe,enable-old,verify-old,barrier-old.exe,start-old,verify-old'
  }
  It 'registers the old task again only when it is missing' {
    Mock Get-ExeProcess { return @() }
    Mock Get-ScheduledTask { if ($TaskName -eq 'old' -and -not $script:events.Contains('register-old')) { return $null } return $true }
    Invoke-MigrationRollback $state
    ($script:events -join ',') | Should -Be 'disable-new,stop-new,barrier-new.exe,barrier-old.exe,register-old,enable-old,start-old,verify-old'
  }
  It 'still starts the old task when restoring the config fails' {
    Mock Get-ExeProcess { return @() }
    $bad = [pscustomobject]@{ NewTaskName = 'new'; OldTaskName = 'old'; TaskPath = '\'; NewExe = 'new.exe'; OldExe = 'old.exe'; Port = 8317; AuthDir = 'auth'; ConfigHash = 'different'; BackupPath = $TestDrive }
    { Invoke-MigrationRollback $bad -RestoreConfig } | Should -Throw '*Saved config checksum failed*'
    Should -Invoke Start-ScheduledTask -Times 1
    Should -Invoke Enable-ScheduledTask -Times 1
  }
}

Describe 'Migration task registration' {
  BeforeAll {
    function Get-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction) }
    function Register-ScheduledTask { param($TaskName, $TaskPath, $Xml) }
    function Start-ScheduledTask { param($TaskName, $TaskPath) }
  }
  It 'clones the principal, logon type, working directory and restart policy while registering disabled' {
    $template = Join-Path $TestDrive 'task.xml'
    @'
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task" version="1.2">
<Principals><Principal id="hub-user"><UserId>example</UserId><LogonType>S4U</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
<Settings><Enabled>true</Enabled><ExecutionTimeLimit>PT72H</ExecutionTimeLimit><RestartOnFailure><Interval>PT2M</Interval><Count>12</Count></RestartOnFailure></Settings>
<Actions Context="hub-user"><Exec><Command>old.exe</Command><Arguments>-config old.yaml</Arguments><WorkingDirectory>C:\hub</WorkingDirectory></Exec></Actions>
</Task>
'@ | Set-Content -LiteralPath $template
    Mock Get-ScheduledTask { return $null }
    Mock Register-ScheduledTask {
      [xml]$registered = $Xml
      $registered.Task.Principals.Principal.LogonType | Should -Be 'S4U'
      $registered.Task.Principals.Principal.RunLevel | Should -Be 'HighestAvailable'
      $registered.Task.Actions.Context | Should -Be 'hub-user'
      $registered.Task.Actions.Exec.Command | Should -Be 'C:\staged\t3code-proxy.exe'
      $registered.Task.Actions.Exec.WorkingDirectory | Should -Be 'C:\hub'
      $registered.Task.Settings.Enabled | Should -Be 'false'
      $registered.Task.Settings.ExecutionTimeLimit | Should -Be 'PT0S'
      $registered.Task.Settings.RestartOnFailure.Interval | Should -Be 'PT2M'
      $registered.Task.Settings.RestartOnFailure.Count | Should -Be '12'
    }
    Mock Start-ScheduledTask { throw 'Task must remain stopped' }
    & (Join-Path $PSScriptRoot 'register-task.ps1') -Exe 'C:\staged\t3code-proxy.exe' -Config 'C:\hub\config.yaml' `
      -WorkingDirectory 'C:\hub' -TemplateXml $template -NoStart
    Should -Invoke Register-ScheduledTask -Times 1
    Should -Invoke Start-ScheduledTask -Times 0
  }
}

Describe 'Result file encoding and empty manifests' {
  It 'writes JSON arrays and UTF-8 paths that round-trip on Windows PowerShell' {
    $path = Join-Path $TestDrive 'empty.json'
    Write-MigrationJson $path @()
    [IO.File]::ReadAllText($path).Trim() | Should -Be '[]'
    $unicodePath = [string][char]0x00E9 + '-hub'
    Write-MigrationJson $path @{ BackupPath = $unicodePath }
    ([IO.File]::ReadAllText($path) | ConvertFrom-Json).BackupPath | Should -Be $unicodePath
  }
}

Describe 'Credential snapshot for post-start probes' {
  It 'uses the saved config after the live server has hashed its management key' {
    $script:install = [pscustomobject]@{ Config = (Join-Path $TestDrive 'live.yaml'); WorkingDirectory = $TestDrive }
    $script:probeConfigPath = Join-Path $TestDrive 'saved.yaml'
    $script:baseUrl = 'http://127.0.0.1:8317'
    $stdout = New-Object 'Threading.Tasks.TaskCompletionSource[string]'
    $stdout.SetResult('{"ok":true}')
    $stderr = New-Object 'Threading.Tasks.TaskCompletionSource[string]'
    $stderr.SetResult('')
    $readerOut = [pscustomobject]@{ Task = $stdout.Task }
    $readerOut | Add-Member ScriptMethod ReadToEndAsync { return $this.Task }
    $readerErr = [pscustomobject]@{ Task = $stderr.Task }
    $readerErr | Add-Member ScriptMethod ReadToEndAsync { return $this.Task }
    $script:fakeProcess = [pscustomobject]@{ StartInfo = $null; StandardOutput = $readerOut; StandardError = $readerErr; ExitCode = 0 }
    $script:fakeProcess | Add-Member ScriptMethod Start { return $true }
    $script:fakeProcess | Add-Member ScriptMethod WaitForExit { return $true }
    $script:fakeProcess | Add-Member ScriptMethod Dispose { }
    # One unfiltered mock: Pester 6 rejects calls that match no filtered mock.
    Mock New-Object {
      if ($TypeName -eq 'Diagnostics.Process') { return $script:fakeProcess }
      if ($null -eq $ArgumentList) { return [Activator]::CreateInstance([type]$TypeName) }
      return [Activator]::CreateInstance([type]$TypeName, [object[]]$ArgumentList)
    }
    (Invoke-MigrationDoctor -Probe).ok | Should -BeTrue
    $script:fakeProcess.StartInfo.Arguments | Should -Match ([regex]::Escape($script:probeConfigPath))
    $script:fakeProcess.StartInfo.Arguments | Should -Not -Match 'live.yaml'
  }
}
