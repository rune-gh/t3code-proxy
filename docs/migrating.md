# Migrating

This page moves an existing CLIProxyAPI hub, or an earlier `v8.x-t3code` build of this hub, to
t3code-proxy. When you finish, the new binary runs as the new service with your existing config
and account logins, and the old service is gone.

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

## Steps

### 1. Stop the old service

Linux:

```sh
systemctl --user disable --now cliproxyapi    # or cli-proxy-api, depending on how you installed
```

macOS with Homebrew:

```sh
brew services stop cliproxyapi
```

Windows: stop and disable the Scheduled Task or service that runs `cli-proxy-api.exe`.

Keep the old binary until the new hub works, so you can go back.

### 2. Install t3code-proxy

The installer writes a new `config.yaml` with new keys only when none exists in the install
directory. To keep your existing keys and settings, copy your old config there first, then run
the installer for your platform from the [setup guide](setup.md#2-install):

```sh
mkdir -p ~/.local/share/t3code-proxy
cp <old config.yaml> ~/.local/share/t3code-proxy/config.yaml
curl -fsSL https://raw.githubusercontent.com/rune-oai/t3code-proxy/main/scripts/install.sh | sh
```

On Windows, copy the old config to `%LOCALAPPDATA%\t3code-proxy\config.yaml` before you run
`install.ps1`.

### 3. Review the config

Optional changes that match the new defaults:

- `routing.strategy: "soonest-reset-first"` for [soonest-reset-first routing](routing.md).
- `quota-history.enabled: true` for the [quota history](quota-history.md) recorder.
- `server.host: "127.0.0.1"` if the old hub listened on every interface.

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

On Windows, run `Start-ScheduledTask -TaskName t3code-proxy`. The `accounts` line of `doctor`
shows which auth directory the hub uses and how many accounts of each provider it found. Open the
panel and confirm every account is listed.

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
