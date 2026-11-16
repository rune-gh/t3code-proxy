# Guide for coding agents

This page is for a coding agent that sets up a t3code-proxy hub for a person. When you finish,
the person has a hub on an always-on home machine with their accounts signed in, published to
their tailnet, and the clients they chose pointed at it. The hub supports subscription and
API-key providers with plan-aware pooling for supported quota windows. Follow
[providers](providers.md) for every login and current quota coverage, and the
[setup guide](setup.md) for installation.

For a new machine that runs agents, follow [set up a box](box-setup.md). For T3 Code services,
remote pairing and Windows plus WSL 2, follow [environments](environments.md).

## Tell the user what you are doing

Start with a short explanation in your own words. Cover these points:

- One machine at home holds the chosen subscription logins and upstream API keys and keeps OAuth
  tokens fresh. Every other machine sends its configured provider traffic there over Tailscale.
  Agents can run on home or cloud T3 Code environments using that hub.
- This avoids signing in on every device and keeps the traffic coming from one home connection.
- The setup follows the one Theo Browne describes in his
  [token maxing video](https://www.youtube.com/watch?v=D8PikZ1KhUo) and
  [gist](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af). t3code-proxy is not
  affiliated with T3, Anthropic or OpenAI.
- Using subscriptions this way may violate the providers' terms, and accounts can be suspended or
  banned. The user carries that risk.
- The user does the browser sign-ins. You run the commands.

## Ask first

Get answers to these before you change anything:

1. Which machine is the hub? It must stay on and sit at home on a residential connection. It must
   not be a VPS or a cloud server, and it must not route through a VPN. Tailscale is required and
   is fine.
2. What operating system does the hub run?
3. Is Tailscale installed on the hub and on every client, signed in to the same tailnet?
4. Which provider accounts and API-key upstreams should be configured? Use the
   [provider table](providers.md#capability-table) to establish login and client support.
5. Which machines should use the hub?
6. Should you edit their normal Claude Code and Codex config, or use a second config directory and
   leave the normal setup alone?
7. Do they use T3 Code, and on which machines do its environments run?
8. Do they accept the ban risk and the two rules: never serve other people's traffic with these
   subscriptions, and use Claude subscription models only through Claude Code? If not, stop.

## Check the environment

Run these on the hub unless the item says client.

| Check | Command |
| --- | --- |
| Operating system | `uname -a` (PowerShell: `Get-ComputerInfo OsName`) |
| Hosting provider | `curl -s https://ipinfo.io/org` |
| Tailscale | `tailscale status` and `tailscale serve status` |
| Port 8317 free | `ss -ltn \| grep 8317` (Linux), `lsof -iTCP:8317 -sTCP:LISTEN` (macOS) |
| Existing install | `ls ~/.t3code-proxy ~/.cli-proxy-api`, `systemctl --user status t3code-proxy` |
| Clients | `claude --version` and `codex --version` on each client |

If the hosting provider is a cloud or datacenter company, stop and tell the user. Do not sign in
there.

After installing, run the built-in checker. It covers the network, sleep settings, Tailscale,
`tailscale serve`, the port, the config, the accounts, the service and (on Linux) linger:

```sh
t3code-proxy doctor -config ~/.local/share/t3code-proxy/config.yaml
```

It prints one line per check with a fix hint and exits with status 1 if any check fails. Use
`-json` if you want to parse the result, and `-offline` to skip the public IP lookup. The report
never prints secret values.

If an earlier CLIProxyAPI install exists, read [migrating](migrating.md) before you install.

## Do the setup

Follow the [setup guide](setup.md) in order:

1. Install with the script for the hub's platform.
2. Confirm the config. The installer generates the access key and management secret.
3. Confirm the service runs and the machine does not sleep.
4. Sign accounts in on the hub.
5. Run `tailscale serve`.
6. Edit the client config files. Back each file up first. Check for an existing
   `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` and an existing `model_provider` in
   `~/.codex/config.toml`, and tell the user before you replace them.
7. If they use T3 Code, follow [T3 Code](t3code.md) and configure each execution machine using
   [environments](environments.md). Windows and WSL 2 need separate provider settings.
8. Confirm panel quota coverage and set plan weights for pooled charts where supported. See
   [providers](providers.md#capability-table), [quota history](quota-history.md) and
   [routing](routing.md).

## Rules for you

- Never print, paste, log or commit the contents of `config.yaml`, account JSON files, access keys
  or the management secret. Do not echo them into the conversation. When a client file needs the
  access key, have the user paste it, or copy it between files without displaying it.
- Do not put `config.yaml`, the auth directory or client config files under version control.
- Sign-ins are OAuth. You start the login command on the hub; the user finishes it in their own
  browser with the URL or device code the command prints. Do not try to complete a login
  yourself.
- On a headless hub, set up the SSH tunnel described in the setup guide before a browser login,
  and pass `-no-browser`. The Codex device login (`-codex-device-login`) needs no tunnel.
- Do not open the hub to the internet. Do not use `tailscale funnel`, and do not change
  `server.host` from `127.0.0.1` on a non-container install.

## Verify from another machine

Finish on a client machine, not on the hub:

```sh
curl -s https://<hub>.<tailnet>.ts.net:8317/v1/models -H "Authorization: Bearer <access key>" | head -c 300
```

The output should start with a JSON model list. Then ask the user to open
`https://<hub>.<tailnet>.ts.net:8317/management.html`, log in with the management secret, and
confirm every account appears under Accounts. Last, send one prompt from Claude Code and one from
Codex on that client.

If anything fails, see [troubleshooting](troubleshooting.md).
