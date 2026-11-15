# Troubleshooting

Each section names a symptom, its usual cause and the fix. Start with the checker on the hub; it
finds most setup problems and prints a fix for each:

```sh
t3code-proxy doctor -config ~/.local/share/t3code-proxy/config.yaml
```

## Codex returns 401 `token_invalidated`

The account's OAuth grant is dead. Refreshing cannot bring it back, and restarting the hub does
not help. Sign the account in again on the hub:

```sh
t3code-proxy -config ~/.local/share/t3code-proxy/config.yaml -codex-device-login
```

Sign in with the same account in the browser. The new login replaces the dead grant. See
[Codex refresh recovery](codex-refresh-recovery.md) for how the hub handles refreshes whose
outcome is unknown.

## Requests fail as soon as one account hits a limit

If a provider has only one enabled account, a limit hit has nowhere else to go, and requests
fail until the window resets. Add a second account for that provider. Check the Overview page or
the Accounts page for accounts that are disabled or cooling down.

## A Mac client cannot resolve `*.ts.net`

With the open-source `tailscaled` on macOS, MagicDNS names may not resolve. Point the system
resolver for your tailnet at Tailscale's DNS server:

```sh
sudo mkdir -p /etc/resolver
echo "nameserver 100.100.100.100" | sudo tee /etc/resolver/<tailnet>.ts.net
```

Replace `<tailnet>` with your tailnet name, the part between the machine name and `.ts.net`.

## Every client stops working at once

The hub is probably asleep, offline or stopped.

- Check that the hub machine is on and online in `tailscale status`.
- Check the service: `systemctl --user status t3code-proxy` (Linux),
  `launchctl print "gui/$(id -u)/com.t3code-proxy.hub"` (macOS), or
  `Get-ScheduledTask -TaskName t3code-proxy` (Windows).
- Turn off sleep as described in the [setup guide](setup.md#4-run-it-always-on). `doctor` reports
  sleep settings in its `sleep` line.
- On Linux, check that linger is on: `loginctl show-user "$USER" -p Linger` should print
  `Linger=yes`. Without it the user service stops when you log out.

## The hub does not start: port in use

The log shows that it cannot bind port 8317, or `doctor` reports `8317 is in use by another
program`. Find the other program:

```sh
lsof -iTCP:8317 -sTCP:LISTEN     # macOS and Linux
ss -ltnp | grep 8317             # Linux
```

```powershell
Get-NetTCPConnection -LocalPort 8317 -State Listen
```

A common cause is an older CLIProxyAPI install still running; see [migrating](migrating.md). Stop
the other program, or set `server.port` to another port and update `tailscale serve` and your
clients to match.

## `/management.html` says "Management panel not built"

The binary was built without the web panel. Release archives and the container image include it;
a plain `go build` does not. Build the panel and rebuild:

```sh
make web
make build
```

If the panel looks out of date instead, check `management.panel-github-repository` in the config.
When it is set, the hub serves a downloaded `management.html` from the `static/` directory next to
the config instead of the embedded panel. Set it to `""` and delete that file to use the embedded
panel. The `MANAGEMENT_STATIC_PATH` environment variable also overrides the panel when it points
at an existing file.

## The panel or T3 Code rejects the management secret

- The value in `config.yaml` is a bcrypt hash once the hub has loaded it. Log in with the
  plaintext you saved, not the hash. If you lost it, set a new plaintext value and restart the hub
  (see [Save the management secret](setup.md#save-the-management-secret)).
- Requests over Tailscale need `management.allow-remote: true`.
- An empty `management.secret-key` turns the management API off.

## Claude Code or Codex gets 401 from the hub

The client sends a key that is not in `access.api-keys`. Check `ANTHROPIC_AUTH_TOKEN` in
`~/.claude/settings.json` or `experimental_bearer_token` in `~/.codex/config.toml`. Clients send
the access key, not the management secret.

## Cache writes are high on every turn

Conversations are moving between accounts. See
[check that affinity works](routing.md#check-that-affinity-works).
