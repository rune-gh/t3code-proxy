<#
.SYNOPSIS
  Install, update, or remove the t3code-proxy hub on Windows.

.DESCRIPTION
  irm https://raw.githubusercontent.com/rune-oai/t3code-proxy/main/scripts/install.ps1 | iex
  .\install.ps1 [-Version 0.1.0] [-Dir <path>] [-Archive <zip>] [-NoService] [-DryRun] [-Uninstall]

  Downloads the release zip for this CPU, verifies it against checksums.txt,
  installs to %LOCALAPPDATA%\t3code-proxy, adds that directory to the user
  PATH, writes config.yaml from the hub template with a freshly generated
  access key and management secret (only if no config exists; never
  overwritten, never printed), and registers a Scheduled Task that starts the
  hub at logon (and at boot when run elevated) and restarts it on failure.

  Safe to re-run to upgrade in place.

.PARAMETER Version
  Release to install, e.g. 0.1.0 or v0.1.0. Default: the latest release.
.PARAMETER Dir
  Install directory. Default: %LOCALAPPDATA%\t3code-proxy.
.PARAMETER Archive
  Install from a local release zip instead of downloading. Verified against
  checksums.txt next to it when present.
.PARAMETER NoService
  Do not register or restart the Scheduled Task.
.PARAMETER DryRun
  Print what would be done without changing anything.
.PARAMETER Uninstall
  Remove the binary, PATH entry, and Scheduled Task; keep config, logs, and accounts.
#>
[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$Dir = (Join-Path $env:LOCALAPPDATA "t3code-proxy"),
  [string]$Archive = "",
  [switch]$NoService,
  [switch]$DryRun,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Repo = "rune-oai/t3code-proxy"
$Name = "t3code-proxy"
$TaskName = "t3code-proxy"

function Invoke-Step([string]$Description, [scriptblock]$Action) {
  if ($DryRun) { Write-Host "[dry-run] $Description" } else { & $Action }
}

function New-Secret {
  # 40 random bytes as 54 URL-safe characters.
  $bytes = New-Object byte[] 40
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Get-Arch {
  $a = $env:PROCESSOR_ARCHITEW6432
  if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
  switch ($a) {
    "AMD64" { return "amd64" }
    "ARM64" { return "arm64" }
    default { throw "Unsupported CPU architecture: $a" }
  }
}

function Get-LatestVersion {
  $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest" `
    -Headers @{ "User-Agent" = "$Name-installer" }
  return $release.tag_name.TrimStart("v")
}

function Set-UserPath([string]$PathDir, [bool]$Add) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if ($current) { $parts = $current.Split(";") | Where-Object { $_ -and ($_.TrimEnd("\") -ne $PathDir.TrimEnd("\")) } }
  if ($Add) { $parts += $PathDir }
  $updated = $parts -join ";"
  if ($updated -ne $current) {
    Invoke-Step "update user PATH ($(if ($Add) { 'add' } else { 'remove' }) $PathDir)" {
      [Environment]::SetEnvironmentVariable("Path", $updated, "User")
    }
  }
}

function Remove-Task {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Invoke-Step "stop and remove scheduled task $TaskName" {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
  }
}

$Dir = [System.IO.Path]::GetFullPath($Dir)
$exe = Join-Path $Dir "$Name.exe"
$config = Join-Path $Dir "config.yaml"

if ($Uninstall) {
  Remove-Task
  foreach ($f in @("$Name.exe", "config.example.yaml", "config.hub.example.yaml")) {
    $p = Join-Path $Dir $f
    if (Test-Path $p) { Invoke-Step "remove $p" { Remove-Item -Force $p } }
  }
  $deploy = Join-Path $Dir "deploy"
  if (Test-Path $deploy) { Invoke-Step "remove $deploy" { Remove-Item -Recurse -Force $deploy } }
  Set-UserPath $Dir $false
  Write-Host "Removed $Name. Kept your config, logs, and accounts:"
  Write-Host "  $Dir (config.yaml, logs\)"
  Write-Host "  the auth dir set in config.yaml (default ~\.t3code-proxy)"
  return
}

# --- fetch and verify ---------------------------------------------------------

$arch = Get-Arch
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("$Name-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ($Archive) {
    if (-not (Test-Path $Archive)) { throw "Archive not found: $Archive" }
    $file = Split-Path -Leaf $Archive
    Copy-Item $Archive (Join-Path $tmp $file)
    $sums = Join-Path (Split-Path -Parent (Resolve-Path $Archive)) "checksums.txt"
    if (Test-Path $sums) { Copy-Item $sums (Join-Path $tmp "checksums.txt") }
    else { Write-Warning "No checksums.txt next to $Archive; skipping verification." }
  } else {
    if (-not $Version) { $Version = Get-LatestVersion }
    $Version = $Version.TrimStart("v")
    $file = "${Name}_${Version}_windows_${arch}.zip"
    $base = "https://github.com/$Repo/releases/download/v$Version"
    Write-Host "Downloading $file"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile (Join-Path $tmp $file)
    Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile (Join-Path $tmp "checksums.txt")
  }

  $sumsFile = Join-Path $tmp "checksums.txt"
  if (Test-Path $sumsFile) {
    $line = Get-Content $sumsFile | Where-Object { ($_ -split "\s+")[1] -in @($file, "*$file") } | Select-Object -First 1
    if (-not $line) { throw "$file is not listed in checksums.txt" }
    $expected = ($line -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $file)).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "Checksum mismatch for $file (expected $expected, got $actual)" }
    Write-Host "Checksum verified: $file"
  }

  $extract = Join-Path $tmp "x"
  Expand-Archive -Path (Join-Path $tmp $file) -DestinationPath $extract
  $src = Get-ChildItem -Path $extract -Recurse -Filter "$Name.exe" | Select-Object -First 1
  if (-not $src) { throw "Archive does not contain $Name.exe" }
  $pkg = $src.DirectoryName
  foreach ($f in @("config.hub.example.yaml", "deploy")) {
    if (-not (Test-Path (Join-Path $pkg $f))) { throw "Archive is missing $f" }
  }

  # --- install ----------------------------------------------------------------

  if (-not $NoService) { Remove-Task }
  Invoke-Step "create $Dir and $Dir\logs" { New-Item -ItemType Directory -Force -Path (Join-Path $Dir "logs") | Out-Null }
  Invoke-Step "copy $Name.exe to $exe" { Copy-Item -Force $src.FullName $exe }
  Invoke-Step "copy config templates and deploy files to $Dir" {
    Copy-Item -Force (Join-Path $pkg "config.hub.example.yaml"), (Join-Path $pkg "config.example.yaml") $Dir
    $deploy = Join-Path $Dir "deploy"
    if (Test-Path $deploy) { Remove-Item -Recurse -Force $deploy }
    Copy-Item -Recurse (Join-Path $pkg "deploy") $deploy
  }
  Set-UserPath $Dir $true

  if (Test-Path $config) {
    Write-Host "Keeping existing config: $config"
  } else {
    Invoke-Step "write $config with a new access key and management secret" {
      $text = Get-Content -Raw (Join-Path $pkg "config.hub.example.yaml")
      $text = $text.Replace("replace-with-a-54-char-url-safe-key", (New-Secret))
      $text = $text.Replace('"replace-me"', '"' + (New-Secret) + '"')
      # A scheduled task has no console, so log to files under logs\.
      $text = $text.Replace("logging-to-file: false", "logging-to-file: true")
      [System.IO.File]::WriteAllText($config, $text, (New-Object System.Text.UTF8Encoding $false))
      # Restrict the config to the current user.
      $acl = Get-Acl $config
      $acl.SetAccessRuleProtection($true, $false)
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, "FullControl", "Allow")))
      Set-Acl $config $acl
      Write-Host "Wrote new config: $config"
    }
  }

  if (-not $NoService) {
    $register = Join-Path $pkg "deploy\windows\register-task.ps1"
    Invoke-Step "register scheduled task $TaskName via $register" {
      & $register -Exe $exe -Config $config -TaskName $TaskName
    }
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
if ($DryRun) { Write-Host "Dry run complete; nothing was changed. Would install $file to $Dir" }
else { Write-Host "Installed $file to $Dir (open a new terminal to pick up PATH)" }
Write-Host @"

Next steps:
  1. Your client API key and management panel secret are in:
       $config
  2. Sign in your subscriptions on this machine (not from a datacenter IP):
       $Name -config "$config" -claude-login -no-browser
       $Name -config "$config" -codex-device-login
  3. Publish the hub to your tailnet:
       tailscale serve --bg --https=8317 http://127.0.0.1:8317
  4. Check the setup:
       $Name doctor -config "$config"
  Logs: $Dir\logs
"@
