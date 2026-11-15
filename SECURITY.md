# Security policy

This page explains how to report a vulnerability, what a hub holds that an attacker would want,
and how to expose a hub so that only your own devices can reach it.

## Report a vulnerability

Report vulnerabilities privately through GitHub security advisories:
[report a vulnerability](https://github.com/rune-oai/t3code-proxy/security/advisories/new).
Do not open a public issue, pull request or discussion for a security problem.

Include what you found, the version (`t3code-proxy -h` prints it on the first line), steps to
reproduce, and the impact you expect. Remove real keys, tokens and account data from anything you
send. You get a reply in the advisory thread. Once a fix is released, the advisory is published
with credit to you unless you ask otherwise.

## Supported versions

Security fixes go into the latest release. Upgrade to it before you report, if you can.

## What a hub holds

A hub is a high-value target. Anyone who can read its files or reach its management API can use
every subscription on it.

| Item | Where | What it allows |
| --- | --- | --- |
| Account logins | the auth directory, `~/.t3code-proxy` by default | OAuth access and refresh tokens for every Claude and Codex account |
| Codex refresh journal | `.codex-refresh/` in the auth directory | Refresh receipts, which contain credentials |
| Client access keys | `access.api-keys` in `config.yaml`, plaintext | Sending requests through the hub with your subscriptions |
| Management secret | `management.secret-key` in `config.yaml`, bcrypt hash | Full control: accounts, config, logs, the `api-call` proxy |
| Quota history | `quota-history.db` next to the config | Account labels and usage over time |
| Logs | stdout, or `logs/` when `logging-to-file` is on | Request metadata; request bodies when `request-log` is on |

The installers write `config.yaml` with owner-only permissions, and the service definitions set a
`0077` umask on Linux and macOS. Keep these files out of backups that others can read and out of
version control.

## Recommended exposure

- Bind to loopback: `server.host: "127.0.0.1"`. In a container, bind to all interfaces inside the
  container and publish the port on the host's loopback only, as `docker-compose.yml` does.
- Publish the port to your tailnet with `tailscale serve`. Do not use `tailscale funnel`, port
  forwarding on your router, or a public reverse proxy.
- Set `server.trusted-proxies` to loopback only, so forwarded client addresses are accepted only
  from `tailscale serve`.
- Use a long random management secret and long random access keys. The installers generate both.
- Use Tailscale ACLs if devices you do not control share your tailnet.
- Set `management.secret-key` to `""` if you do not need the panel or T3 Code limits; that turns
  the management API off.

## Scope

In scope: the `t3code-proxy` binary, the web panel, the installers, the service definitions and
the container image published from this repository.

Out of scope: weaknesses in Claude Code, Codex, T3 Code, Tailscale or the providers' services,
and setups that ignore the exposure guidance above, such as a hub bound to a public address.
