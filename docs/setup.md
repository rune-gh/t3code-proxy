# Setup guide

At the end of this guide you have one always-on machine at home running t3code-proxy with your
Claude and Codex accounts signed in, reachable from your other machines over Tailscale, and
Claude Code and Codex on those machines sending their requests through it.

If a coding agent is doing the setup for you, point it at the [guide for agents](agents.md).

## Before you start: risks and rules

Using subscriptions through a hub may violate the providers' terms of service, and accounts can be
suspended or banned. Decide whether you accept that before you continue. Two rules apply:

1. Never serve other people's traffic with your subscriptions.
2. Use Claude subscription models only through Claude Code.

## 1. Pick the hub machine

The hub must:

- stay on all the time. If it sleeps, every client pointed at it stops working;
- sit at home on a residential connection. Do not use a VPS or a cloud server, and do not run it
  behind a VPN. Providers treat sign-ins from datacenter addresses with suspicion;
- run Linux, macOS or Windows. An old desktop or a small home server is enough; the hub does no
  inference.

Why one machine: OAuth logins need regular refreshes, and one machine refreshing them avoids
several laptops fighting over the same grant. It also keeps your traffic coming from one home
address.

Install [Tailscale](https://tailscale.com/download) on the hub and on every machine that should
use it, all signed in to the same tailnet.

## 2. Install

### Linux and macOS

```sh
curl -fsSL https://raw.githubusercontent.com/rune-oai/t3code-proxy/main/scripts/install.sh | sh
```

The installer downloads the release archive for your CPU, verifies it against `checksums.txt`,
and installs to `~/.local/share/t3code-proxy` with a `t3code-proxy` link in `~/.local/bin`. On a
first install it writes `config.yaml` from `config.hub.example.yaml` with a freshly generated
client API key and management secret. It never overwrites an existing `config.yaml`, so you can
re-run it to upgrade. It then installs and starts the service (see step 4).

Options, from `sh install.sh --help`:

| Option | Effect |
| --- | --- |
| `--version <x>` | Install a specific release, for example `0.1.0`. Default: the latest. |
| `--dir <dir>` | Install directory. Default: `~/.local/share/t3code-proxy`. |
| `--bin-dir <dir>` | Where the command is linked. Default: `~/.local/bin`. |
| `--archive <file>` | Install from a local release archive. |
| `--no-service` | Do not install or restart the systemd or launchd service. |
| `--dry-run` | Print what would happen without changing anything. |
| `--uninstall` | Remove the binary and service; keep config, logs and accounts. |

To pass options through the pipe, use `sh -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/rune-oai/t3code-proxy/main/scripts/install.sh | sh -s -- --version 0.1.0
```

### Windows

In PowerShell:

```powershell
irm https://raw.githubusercontent.com/rune-oai/t3code-proxy/main/scripts/install.ps1 | iex
```

This installs to `%LOCALAPPDATA%\t3code-proxy`, adds that directory to your user `PATH`, writes
`config.yaml` the same way as on Linux (with `logging-to-file: true`, because a Scheduled Task has
no console), and registers a Scheduled Task named `t3code-proxy`. Run it from an elevated
PowerShell if you also want the task to start at boot, not only at logon. Download the script
first to pass options: `.\install.ps1 -Version 0.1.0`, `-Dir`, `-Archive`, `-NoService`,
`-DryRun`, `-Uninstall`.

### Docker

The image is `ghcr.io/rune-oai/t3code-proxy`. The repository's `docker-compose.yml` keeps every
mutable file in `./data` and publishes the API and the two OAuth callback ports on the host's
loopback only:

```sh
mkdir -p data
cp config.hub.example.yaml data/config.yaml
```

Edit `data/config.yaml`: replace both placeholder values and set `server.host` to `""`. Inside the
container the server must listen on all interfaces; the compose port mapping still binds it to
`127.0.0.1` on the host. The container runs as uid 10001; set `T3CODE_PROXY_UID` and
`T3CODE_PROXY_GID` to your own `id -u` and `id -g` so it can write to `./data`. Then:

```sh
docker compose up -d
```

`restart: unless-stopped` in the compose file keeps it running. Account files go to
`data/.t3code-proxy` because the container's home directory is `/data`.

### From source

You need Go 1.26 and, for the web panel, Bun. See [development](development.md).

```sh
make web
make build
```

This produces `bin/t3code-proxy` with the panel embedded.

## 3. Review the config

The installer's `config.yaml` is a copy of [`config.hub.example.yaml`](../config.hub.example.yaml).
The parts that matter:

```yaml
server:
  host: "127.0.0.1"          # loopback only; Tailscale is the front door
  port: 8317
  trusted-proxies: ["127.0.0.1", "::1"]
management:
  allow-remote: true         # lets you open the panel over Tailscale
  secret-key: "<management secret>"
access:
  api-keys:
    - "<access key>"         # what Claude Code and Codex send
routing:
  strategy: "soonest-reset-first"
  session-affinity: true
  session-affinity-ttl: "1h"
quota-history:
  enabled: true
```

[Configuration](configuration.md) explains each key.

### Save the management secret

The management secret is the password for the web panel and the management API. The hub replaces
a plaintext `management.secret-key` with its bcrypt hash when it loads the config. The installers
start the service immediately, so on a fresh install the value is probably already a hash (it
starts with `$2`). If so, set a new one:

1. Generate a secret and store it in your password manager:

   ```sh
   openssl rand -base64 40 | tr -d '\n=' | tr '+/' '-_'
   ```

2. Put it in `config.yaml` as `management.secret-key: "<management secret>"`.
3. Restart the hub (see the next step). The hub hashes it again; you keep the plaintext.

The access key under `access.api-keys` stays in plaintext. Treat `config.yaml` as a secret file.

## 4. Run it always-on

The installers set up a service that restarts the hub when it exits.

### Linux

The hub runs as a systemd user unit, `~/.config/systemd/user/t3code-proxy.service`. The installer
enables it and turns on linger so it runs without anyone logged in.

```sh
systemctl --user status t3code-proxy
systemctl --user restart t3code-proxy
journalctl --user -u t3code-proxy -f
```

If the installer could not enable linger, run `sudo loginctl enable-linger "$USER"`. Stop the
machine from suspending:

```sh
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

### macOS

The hub runs as the launchd agent `com.t3code-proxy.hub`, loaded from
`~/Library/LaunchAgents/com.t3code-proxy.hub.plist`. It starts at login, so set the Mac to log in
automatically after a restart. Logs go to `~/.local/share/t3code-proxy/logs/launchd.log`.

```sh
launchctl kickstart -k "gui/$(id -u)/com.t3code-proxy.hub"
```

Disable system sleep (check the result with `pmset -g | grep sleep`):

```sh
sudo pmset -a sleep 0
```

### Windows

The Scheduled Task `t3code-proxy` starts the hub at logon (and at boot when installed from an
elevated shell) and restarts it on failure. Logs are in `%LOCALAPPDATA%\t3code-proxy\logs`.

```powershell
Stop-ScheduledTask -TaskName t3code-proxy
Start-ScheduledTask -TaskName t3code-proxy
```

Set the machine never to sleep on AC power:

```powershell
powercfg /change standby-timeout-ac 0
```

## 5. Sign your accounts in

Run the logins on the hub, not on your laptop, so the tokens are issued to the hub's connection.
Pass the same config the service uses so the accounts land in the right directory. The running
hub picks up new account files without a restart.

```sh
CONFIG=~/.local/share/t3code-proxy/config.yaml
t3code-proxy -config "$CONFIG" -codex-device-login   # device code; works on a headless hub
t3code-proxy -config "$CONFIG" -codex-login          # browser flow, callback on port 1455
t3code-proxy -config "$CONFIG" -claude-login         # browser flow, callback on port 54545
```

On Windows the config is `%LOCALAPPDATA%\t3code-proxy\config.yaml`. With Docker, run the login
inside the container:

```sh
docker compose exec t3code-proxy t3code-proxy -config /data/config.yaml -claude-login -no-browser
```

Repeat each login once per account. Each OAuth login ends in a browser where you sign in to that
account.

### Headless hub: tunnel the callback

The Claude login redirects your browser to `http://localhost:54545/callback` on the machine
running the login. When the hub has no browser, forward that port from your laptop first:

```sh
ssh -L 54545:localhost:54545 <user>@<hub>
```

In that SSH session, start the login with `-no-browser`. It prints the URL and tunnel instructions
instead of opening a browser:

```sh
t3code-proxy -config ~/.local/share/t3code-proxy/config.yaml -claude-login -no-browser
```

Open the URL on your laptop and finish the sign-in. The Codex browser login works the same way on
port 1455 (`ssh -L 1455:localhost:1455 <user>@<hub>`); the device login needs no tunnel.

New accounts are stored as JSON files in `~/.t3code-proxy` (or `~/.cli-proxy-api` if only that
older directory exists), unless `oauth.auth-dir` says otherwise. Never share or commit them.

## 6. Publish the hub with Tailscale

On the hub:

```sh
tailscale serve --bg --https=8317 http://127.0.0.1:8317
```

The hub is now at `https://<hub>.<tailnet>.ts.net:8317`, reachable only from your tailnet. Check
with `tailscale serve status`. Do not use `tailscale funnel`, which publishes to the internet.

## 7. Point your clients at the hub

Back up each file before you edit it.

### Claude Code

In `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<hub>.<tailnet>.ts.net:8317",
    "ANTHROPIC_AUTH_TOKEN": "<access key>"
  }
}
```

### Codex

In `~/.codex/config.toml`:

```toml
model_provider = "t3code-proxy"

[model_providers.t3code-proxy]
name = "t3code-proxy"
base_url = "https://<hub>.<tailnet>.ts.net:8317/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
experimental_bearer_token = "<access key>"
```

`supports_websockets = true` lets Codex use the WebSocket transport through the hub, which is
noticeably faster than plain HTTP streaming.

### Keep your normal setup: a second config directory

To leave your existing Claude Code and Codex setup alone, put the settings above in a separate
directory and start the clients with it:

```sh
CLAUDE_CONFIG_DIR=~/.claude-hub claude
CODEX_HOME=~/.codex-hub codex
```

Here `~/.claude-hub/settings.json` and `~/.codex-hub/config.toml` hold the hub settings.

For T3 Code, see [T3 Code](t3code.md).

## 8. Verify

On the hub:

```sh
t3code-proxy doctor -config ~/.local/share/t3code-proxy/config.yaml
```

`doctor` prints one line per check (network, sleep, Tailscale, `tailscale serve`, port, config,
accounts, service, linger) with a fix for anything that is not right. It exits with status 1 when
a check fails. Its flags are `-config <path>`, `-auth-dir <path>`, `-port <n>`, `-json` and
`-offline` (skips the public network lookup).

From another machine on the tailnet:

```sh
curl -s https://<hub>.<tailnet>.ts.net:8317/v1/models -H "Authorization: Bearer <access key>" | head -c 300
```

You should see the start of a JSON model list. Then open
`https://<hub>.<tailnet>.ts.net:8317/management.html`, log in with the management secret, and
check that every account you signed in is listed. Finally, send one prompt from Claude Code and
one from Codex.

If something fails, see [troubleshooting](troubleshooting.md).
