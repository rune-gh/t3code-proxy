# Troubleshooting

Each section names a symptom, its usual cause and the fix. Start with the checker on the hub; it
finds most setup problems and prints a fix for each:

```sh
t3code-proxy doctor -config ~/.local/share/t3code-proxy/config.yaml
```

The hub serves subscription and API-key providers with different quota capabilities. Check
[providers](providers.md) for the login and client API you are using. [Environments](environments.md)
covers T3 Code service and pairing setup. [Box setup](box-setup.md) gives the checks in order.

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

## A provider works but has no pooled chart or reset rank

Per-account quota, recorded pool charts and soonest-reset-first ranking have different provider
coverage. Compare the [capability table](providers.md#capability-table), then check
[quota history](quota-history.md) and [routing](routing.md). For plan-aware pool charts, set the
plan weights to match your subscriptions. A missing plan weight counts as one account.

T3 Code's Limits view has its own [provider coverage](t3code.md#what-appears-under-limits).
Seeing an account in the hub's Accounts page establishes that the hub loaded its credentials.
Check a real client request and the relevant quota view as separate verification steps.

## T3 Code works locally but the remote environment is offline

On the machine that runs the environment, inspect its service and Serve target.

```sh
t3 service status
t3 status
tailscale serve status
```

Confirm the local port matches the Tailscale Serve target, and that the machine is awake. A
foreground `t3 serve` exits with its terminal. Linux services need linger. The macOS launchd
agent and Windows task need their user logged in. Follow [environments](environments.md) for
the platform-specific checks and a fresh pairing link. The hosted web client needs HTTPS.

If using T3 Connect, `t3 connect status` tests that route. `t3 status --json` only reads settings.

## T3 Code calls the provider directly on another machine

Edit the Claude Code and Codex settings on the machine that owns the thread's environment.
Check its service user and provider config directory, then start a fresh provider session.
Choose **Use existing CLI** for Codex. Follow [T3 Code](t3code.md) and
[the client settings](providers.md#point-clients-at-the-hub).

## T3 Code prompts for approval in Full access mode

Command approvals happen locally between T3 Code and each provider CLI; they do not pass through
`t3code-proxy`.

- **Antigravity (`agy-acp`):** Make sure you copied the current [`deploy/t3code/agy-acp`](../deploy/t3code/agy-acp)
  wrapper to each environment running it. Earlier copies mapped `accept-edits` back to `auto_edit`
  even when T3 Code requested `yolo` (Full access).
- **Codex (`Use existing CLI`):** On the machine running the environment, check `~/.codex/config.toml`
  and `~/.codex/rules/*.rules` for an `approval_policy`, `sandbox_mode`, `approvals_reviewer` or
  `prompt` rule forcing approvals.
- If approvals still appear across providers or after switching agents in a Full access thread with
  clean CLI config, the fix belongs in T3 Code itself rather than `t3code-proxy`.

## Windows and WSL show the wrong environment or stop after closing terminals

Use separate provider installations, user homes and T3 listener ports. Check Windows' Serve
target for the Linux port before pairing. Microsoft documents that systemd services alone do
not keep WSL running. Check the Windows task that launches the Linux foreground server and
verify `wsl --list --verbose` after closing the terminals.

For a hub on the same Windows PC, default WSL NAT has separate loopback. Use the hub's Tailscale
HTTPS URL or the documented mirrored-network path. Tailscale also documents failures when both
Windows and WSL carry nested Tailscale traffic. Follow the full
[Windows and WSL 2 section](environments.md#windows-and-wsl-2-as-two-environments) before changing
network settings.
