# Migrating

This page moves an existing CLIProxyAPI hub, or an earlier `v8.x-t3code` build of this hub, to
t3code-proxy. When you finish, the new binary runs as the new service with your existing config
and account logins. On Windows, the old task remains disabled for recovery.

t3code-proxy started from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and reads
the same config and account files, so nothing needs converting.

## What changes

| | CLIProxyAPI and `v8.x-t3code` builds | t3code-proxy |
| --- | --- | --- |
| Binary | `cli-proxy-api` (`cli-proxy-api.exe`) | `t3code-proxy` (`t3code-proxy.exe`) |
| Linux service | `cliproxyapi` or `cli-proxy-api` user unit | `t3code-proxy` user unit |
| macOS service | `brew services` (`cliproxyapi`) | launchd agent `com.t3code-proxy.hub` |
| Windows service | a Scheduled Task you created | Scheduled Task `t3code-proxy` |
| Default auth directory | `~/.cli-proxy-api` | `~/.t3code-proxy`, falling back to `~/.cli-proxy-api` |
| Web panel | downloaded from a GitHub release into `static/` | compiled into the binary |
| Config | `config.yaml` | the same file, unchanged |

## What stays the same

- **Config.** Existing `config.yaml` files load as they are, in both the flat layout and the v8
  layout. The `/v0/management` API is still served.
- **Accounts.** When `~/.t3code-proxy` does not exist and `~/.cli-proxy-api` does, the hub uses
  `~/.cli-proxy-api` and logs that it did. If your config sets `auth-dir` or `oauth.auth-dir`, that
  value wins. You do not need to move any files.
- **Clients.** The API, port and paths are the same. Client configs keep working once the new hub
  listens on the same port.

## Windows one-command migration

Use `scripts/migrate-windows.ps1` from this checkout with its sibling
`deploy/windows/register-task.ps1`. Stage a release `t3code-proxy.exe` at a separate,
permanent path first, using a verified release archive or `install.ps1 -NoService`.
Keep that binary, this checkout and the old install available through recovery.
The normal installer registers and starts a hub by default. Use `-NoService` when
staging it for this procedure.

Run Windows PowerShell 5.1 as the same Windows account that owns the old task.
Use elevation if task permissions or process inspection require it. The migration
must be able to export, disable, stop, register and start tasks and inspect full
process paths and TCP listener owners.

### Confirm the machine before switching

- The old hub is a single running executable launched by one Scheduled Task. By
  default the task is `CLIProxyAPI Hub` in `\`. Its action supplies `-config` and a
  working directory. Use `-OldTaskName`, `-TaskPath`, `-OldExe`, `-Config` and
  `-WorkingDirectory` to override discovery. When supplying `-Config`, review any
  additional old arguments yourself. The replacement action uses only `-config`.
- The config uses local file storage and HTTP loopback on the existing port. Home,
  cloud and Postgres/git/object-store deployments need their own migration procedure.
  The check considers both the process environment and the working directory's `.env`.
  Task Scheduler must see the same required environment. Put persistent settings
  in the existing `.env` or machine/user environment before launching.
- The configured auth directory and local model catalogs exist. Auth accounts are
  root-level JSON files with a `type` field. Their count must match the old
  `/v0/management/auth-files` response. Virtual API-key credentials are excluded.
  Custom account layouts or plugin-generated accounts can fail this comparison.
- Both hub tasks are the only launchers of their binaries. Pause client traffic
  and other tools that modify config or auth files for the switch. The script
  rechecks activity before stopping, but incoming requests can race a snapshot.
  The inference session launching the migration will disconnect during the switch.
- Review each reported Catalog Refresh task and confirm its helper only maintains
  catalogs. The migration leaves these tasks and user scripts registered. Catalogs
  under the old install continue to be used, so retain that folder. No automatic
  deletion is performed.
- A local backup volume has twice the auth directory size plus 64 MiB available.
  Auth directories and their contents must be ordinary files/directories. Junctions
  and symbolic links are rejected so backups cannot omit external credential state.
- The old task uses S4U, InteractiveToken or Password logon. InteractiveToken still
  needs the user's interactive Windows session to remain logged on. S4U and Password
  can run after logout. SSH disconnect survival is handled by Task Scheduler.

The config path, working directory, bind port, access keys, management key and auth
path carry over. Keep the existing Tailscale Serve mapping and client URLs. The
script validates the config using the new binary's production loader on a private,
disposable temporary copy. It never starts a second hub for preflight. Unknown
patched-build keys are reported and kept in the original file. The server loader
continues to apply its normal startup behavior, including hashing a plaintext
management key and removing conflicting legacy fields.

### Supply a hashed management key securely

The migration reads an access key from the config inside the doctor subprocess.
A plaintext management key can also be read from the config or `MANAGEMENT_PASSWORD`.
After backup, probes use the immutable config snapshot so startup hashing of the
live config cannot discard the plaintext needed for verification.
A bcrypt management hash cannot authenticate an API request. If the file holds a
hash, create a user-private file containing the original plaintext management key
and pass `-ManagementKeyFile`. For example, read it interactively without echoing it
and restrict the containing directory first.

```powershell
$private = Join-Path $env:USERPROFILE 't3-migration-private'
New-Item -ItemType Directory -Path $private -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $private /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
$secret = Read-Host 'Existing management key' -AsSecureString
$credential = New-Object PSCredential('management', $secret)
[IO.File]::WriteAllText((Join-Path $private 'management.key'), $credential.GetNetworkCredential().Password)
Remove-Variable secret,credential
```

Password-logon tasks also require a DPAPI-encrypted credential file created as the
same user on the hub. Add `-TaskCredentialFile "$private\task.credential.xml"` to
each command below. The principal and logon type carry over to the new task.

```powershell
Get-Credential | Export-Clixml -LiteralPath (Join-Path $private 'task.credential.xml')
```

Keep these files available for verification and rollback. Remove them when the
recovery window closes. Their contents are never passed in task arguments or
written to the migration log/result. The backup contains credentials and uses an
ACL restricted to the migrating user and SYSTEM.

### Dry-run and launch detached

Use a permanent checkout path on the hub. The following paths are examples to
replace with your staged binary, private key file and a fresh backup directory.
Omit `-ManagementKeyFile` when plaintext is available from the config/environment.

```powershell
Set-Location C:\src\t3code-proxy
$migration = @{ NewExe = 'C:\tools\t3code-proxy\t3code-proxy.exe'; BackupPath = 'C:\hub-backups\migration-20261115'; ManagementKeyFile = "$private\management.key" }
.\scripts\migrate-windows.ps1 @migration -WhatIf
.\scripts\migrate-windows.ps1 @migration -Detached -AllowUnknownInFlight
```

`-WhatIf` performs read-only discovery, config checking and authenticated probes,
prints the plan, and leaves the install and task definitions untouched. It creates
no backup or persistent log. Config checking creates and removes a private
operating-system temporary copy because the production loader can write config.

The old hub may expose the read-only
`/v8/management/observability/requests/in-flight` endpoint. A positive count blocks
the switch. If the endpoint is absent or its result is unusable, the script reports
that gap and requires `-AllowUnknownInFlight` for a real run. Supply this switch
only after pausing clients and accepting that live traffic cannot be measured.

`-Detached` completes preflight before registering an on-demand, one-shot
`t3code-migration-<random>` task. The worker repeats preflight and owns the switch
and automatic recovery. It inherits the old task's user and logon type, and runs
elevated when you launch it from an elevated shell: registering and stopping
tasks usually needs that, so launch from an elevated PowerShell. It
has no recurring trigger, restart policy or execution-time limit, and survives the
launching SSH session disconnecting. Do not log out an InteractiveToken principal.
The launcher prints its task name and the backup/result directory before returning.
Keep the checkout at the same path until completion. The worker removes its
one-shot launch task when it finishes; `result.json` is the record of the outcome.

During the operation the worker takes an exclusive migration lock in the old
working directory. In order, it:

1. Verifies copies of config, `.env` when present, every auth file/subdirectory
   including `.codex-refresh`, and the exported old task XML (`auth/`). The hub is
   still running at this point, so a file it holds open or is still writing, such
   as its `kv.db` store or a log, is listed in the manifest as `unreadable` or
   `changed` and left for step 4. Account files must copy here or the run stops.
2. Registers the replacement task, disabled, using the old task's principal,
   triggers and restart settings, while the old hub is still serving. A missing
   restart policy gains one-minute retries and the task has no execution-time
   limit. If this account is not allowed to register the task, the migration
   stops here with the old hub untouched.
3. Disables the old task, stops it and waits for its process to exit and the port
   to become free. For a hub bound to loopback, only listeners on loopback or on
   all interfaces count: Tailscale Serve keeps listening on the tailnet address
   for the same port and is ignored.
4. Takes a second, strict auth snapshot that includes the final token rotations
   and every file (`auth-final/`). The first snapshot is kept.
5. Enables and starts the replacement task.

Verification requires `/healthz`, authenticated `/v1/models`, and authenticated
`/v0/management/auth-files` with the backed-up file-account count, and every
account the hub lists must be a file in the auth directory the config resolves to.
That last check runs against the old hub before the switch as well, so a hub
reading `~/.cli-proxy-api` is not replaced by one reading a different
`~/.t3code-proxy` that happens to hold the same number of accounts. The new binary
uses the original config in the original working directory. The old task stays
present and disabled. Failed switching or verification invokes rollback and exits
with a failure result even when recovery succeeds.

Automatic rollback stops the new hub, restores the saved config and `.env`, then
enables and starts the old task; the old task is registered again only if it has
gone missing. Once the new hub's process is confirmed gone, the old task is
enabled and started even if a later rollback step fails, including when the port
is still held: if the old task has a restart-on-failure setting, Task Scheduler
then retries until the port is free (preflight warns when it has none). If the new
process cannot be confirmed gone, neither hub is started, the result says so, and
recovery is manual. If the old hub never exited in the first place, its files are
left alone and its task is re-enabled; if it is still shutting down, the task is
started once that process has gone.

### Read the outcome

```powershell
Get-Content -LiteralPath 'C:\hub-backups\migration-20261115\result.json' -Encoding UTF8 -Raw | ConvertFrom-Json | Format-List
Get-Content -Path 'C:\hub-backups\migration-20261115\transcript-*.log' -Tail 100
```

`result.json` records `Phase`, `Success`, `StartedAt`, `FinishedAt`, `Reason`,
`BackupPath` and `RolledBack`. An unset `FinishedAt` means completion has not been
recorded. A launcher failure is recorded after its result directory is prepared.
Read-only preflight failures before launch appear in the calling console.
Transcripts contain phase changes and redacted failure descriptions. Raw config,
HTTP bodies, access keys, management secrets and auth content are excluded from
both artifacts. SHA-256 manifests and `migration.json` accompany the backups.

Re-running a completed migration with the same `-BackupPath` checks the running new
hub and returns without switching again. Other runs refuse an existing destination
task or backup directory. After a failed attempt, inspect its result and recover
from that named backup before starting another migration. An automatic rollback
leaves the replacement task registered and disabled, so the next run needs a fresh
`-BackupPath` and either a different `-NewTaskName` or the disabled task removed
first (`Unregister-ScheduledTask -TaskName t3code-proxy`).

### Roll back a named backup

Rollback disables and stops the new task and checks both executable/port barriers
before restoring the saved config and `.env`. It saves the later
config/environment in the backup folder, enables the old task, starts it and
verifies authenticated models and the current file-account count; `result.json`
carries a warning when that count differs from the one recorded before the switch.
`-Rollback`
reads the old task to find the install, so the old task must still be registered;
if you deleted it, use the manual recovery below, which registers it from the
saved XML. Keep the old
binary and task available, and retain the staged new binary for read-only checks.

```powershell
.\scripts\migrate-windows.ps1 -Rollback -BackupPath 'C:\hub-backups\migration-20261115' -ManagementKeyFile "$private\management.key" -WhatIf
.\scripts\migrate-windows.ps1 -Rollback -BackupPath 'C:\hub-backups\migration-20261115' -ManagementKeyFile "$private\management.key" -Detached
```

Include custom `-OldTaskName`/`-TaskPath` and `-TaskCredentialFile` when applicable.
Automatic and explicit rollback retain the latest live auth directory. OAuth
refresh tokens rotate, so replaying the backup's older tokens can invalidate
logins. The auth snapshot is available for disaster recovery and forensic checks.
Restoring it requires assessing token rotation and may require signing in again.

For manual recovery, open PowerShell as the task owner and use the saved paths
and names. Disable both launchers before stopping either. Confirm that both full
executable paths have disappeared and that the saved port has no listener before
starting either hub. If a process remains, resolve its shutdown first.

```powershell
$backup = 'C:\hub-backups\migration-20261115'
$state = Get-Content -LiteralPath (Join-Path $backup 'migration.json') -Encoding UTF8 -Raw | ConvertFrom-Json
Disable-ScheduledTask -TaskName $state.NewTaskName -TaskPath $state.TaskPath
Disable-ScheduledTask -TaskName $state.OldTaskName -TaskPath $state.TaskPath
Stop-ScheduledTask -TaskName $state.NewTaskName -TaskPath $state.TaskPath
Stop-ScheduledTask -TaskName $state.OldTaskName -TaskPath $state.TaskPath
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -in @($state.OldExe, $state.NewExe) } | Select-Object ProcessId,ExecutablePath
# For a hub bound to 127.0.0.1, only loopback and all-interface listeners matter.
# Tailscale Serve keeps listening on the tailnet address for the same port.
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq $state.Port -and $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1') }
```

Once both checks are empty, verify the saved config and task XML, preserve the
current config/environment, then restore the saved files. Restore `.env` only
when the backup has one. If it was added after migration, move it aside before
starting the old hub so it cannot override the saved config.

```powershell
foreach ($pair in @(@('config.yaml', $state.ConfigHash), @('old-task.xml', $state.TaskXmlHash))) {
  if ((Get-FileHash -LiteralPath (Join-Path $backup $pair[0]) -Algorithm SHA256).Hash -ne $pair[1]) {
    throw 'Backup checksum failed'
  }
}
if ($state.EnvironmentHash -and (Get-FileHash -LiteralPath (Join-Path $backup 'environment.env') -Algorithm SHA256).Hash -ne $state.EnvironmentHash) {
  throw 'Environment backup checksum failed'
}
$before = Join-Path $backup ('manual-before-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
New-Item -ItemType Directory -Path $before | Out-Null
Copy-Item -LiteralPath $state.Config -Destination (Join-Path $before 'config.yaml')
Copy-Item -LiteralPath (Join-Path $backup 'config.yaml') -Destination $state.Config -Force
$environmentPath = Join-Path $state.WorkingDirectory '.env'
if (Test-Path -LiteralPath $environmentPath) {
  Move-Item -LiteralPath $environmentPath -Destination (Join-Path $before 'environment.env')
}
if ($state.EnvironmentHash) {
  Copy-Item -LiteralPath (Join-Path $backup 'environment.env') -Destination $environmentPath
}
$registration = @{ TaskName = $state.OldTaskName; TaskPath = $state.TaskPath; Xml = [IO.File]::ReadAllText((Join-Path $backup 'old-task.xml')); Force = $true }
# For Password logon, populate User and Password from the same-user PSCredential.
Register-ScheduledTask @registration | Out-Null
Enable-ScheduledTask -TaskName $state.OldTaskName -TaskPath $state.TaskPath
Start-ScheduledTask -TaskName $state.OldTaskName -TaskPath $state.TaskPath
Push-Location $state.WorkingDirectory
try {
  & $state.NewExe doctor -check-config -config $state.Config -probe-url ("http://127.0.0.1:" + $state.Port) -management-key-file "$private\management.key"
} finally { Pop-Location }
```

Password-logon task registration requires the original account credentials. Use
`Import-Clixml` on the private credential file and pass its username/password to
`Register-ScheduledTask` in memory. Keep the auth directory live throughout this
recovery. Confirm `probe.models` and the expected `probe.accounts` in the redacted
doctor output, then verify clients through Tailscale.

A machine crash, power loss or forced termination of the migration worker can
leave both tasks disabled. Use the recorded phase and manual stop barriers to
recover. Keep the backup and the old folder until you finish validating clients
through the existing Tailscale URL.

## Manual migration on Linux and macOS

### 1. Stop the old service

Linux:

```sh
systemctl --user disable --now cliproxyapi    # or cli-proxy-api, depending on how you installed
```

macOS with Homebrew:

```sh
brew services stop cliproxyapi
```

For Windows, use the detached migration procedure above.

Keep the old binary until the new hub works, so you can go back.

### 2. Install t3code-proxy

The installer writes a new `config.yaml` with new keys only when none exists in the install
directory. To keep your existing keys and settings, copy your old config there first, then run
the installer for your platform from the [setup guide](setup.md#2-install):

```sh
mkdir -p ~/.local/share/t3code-proxy
cp <old config.yaml> ~/.local/share/t3code-proxy/config.yaml
curl -fsSL https://raw.githubusercontent.com/rune-gh/t3code-proxy/main/scripts/install.sh | sh
```

The Windows migration keeps the original config path and working directory.

### 3. Review the config

An old config keeps its old behavior. Two settings turn on what this project adds, and plan-aware
routing needs both:

- `routing.strategy: "soonest-reset-first"` for [soonest-reset-first routing](routing.md). Plan
  weights and the 5-hour headroom guard only act inside this strategy. If your old config
  already used this strategy, two things change on upgrade: tied accounts are spread by plan
  weight, and an account with little 5-hour headroom left stops taking new conversations while
  another has room. Set `routing.plan-headroom-reserve: 0` to turn the guard off.
- `quota-history.enabled: true` for the [quota history](quota-history.md) recorder. Claude plans
  are learned from it, so without it every Claude account weighs 1. The recorder polls every
  supported provider you have accounts for; list the ones you want under
  `quota-history.providers` to limit that.

Also consider `server.host: "127.0.0.1"` if the old hub listened on every interface.

Earlier `v8.x-t3code` builds set `management.panel-github-repository` so the hub downloaded the
panel from this repository's releases. Releases no longer publish a separate `management.html`.
Set the key to `""` and delete `static/management.html` next to the config so the hub serves the
embedded panel. A key that still names the old CLIProxyAPI panel repository is ignored, so stock
CLIProxyAPI configs need no change here.

### 4. Start and check

```sh
systemctl --user restart t3code-proxy                     # Linux
launchctl kickstart -k "gui/$(id -u)/com.t3code-proxy.hub"  # macOS
t3code-proxy doctor -config ~/.local/share/t3code-proxy/config.yaml
```

The `accounts` line of `doctor` shows which auth directory the hub uses and how many accounts
of each provider it found. Open the panel and confirm every account is listed.

`tailscale serve` forwards to the port, not to a program, so it needs no change.

### 5. Remove the old install

Once the new hub works, remove the old binary, its service definition and its install directory.
Do not delete the auth directory if the new hub uses it.

To move the accounts to the new default directory, stop the hub and move the whole directory, so
the Codex refresh journal in `.codex-refresh/` and other state files go with the accounts:

```sh
mv ~/.cli-proxy-api ~/.t3code-proxy
```

If your config sets `auth-dir: "~/.cli-proxy-api"` (the old template did), change it to
`~/.t3code-proxy` or remove it. Then start the hub again.
