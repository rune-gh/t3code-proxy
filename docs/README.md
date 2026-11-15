# Documentation

These pages cover running a t3code-proxy hub, connecting clients to it, and working on the code.

## Run a hub

- [Setup guide](setup.md): pick the hub machine, install, sign accounts in, publish it over
  Tailscale and point Claude Code and Codex at it.
- [Guide for coding agents](agents.md): for an agent doing the setup on someone's behalf.
- [T3 Code](t3code.md): use the hub from T3 Code and see pooled limits there.
- [Routing](routing.md): how the hub picks an account for each request.
- [Configuration](configuration.md): the config keys a hub owner changes.
- [Quota history](quota-history.md): the recorder behind the Overview charts.
- [Troubleshooting](troubleshooting.md): common failures and their fixes.
- [Migrating](migrating.md): move an existing CLIProxyAPI install or an earlier build over.

## Reference

- [v8 Management API](management-api-v8.md): the `/v8/management` endpoints the web panel uses.
- [WebSocket tunnel](websocket-tunnel.md): the `/v1/tunnel` packet relay between client and
  server devices.
- [LAN discovery](lan-discovery.md): DNS-SD advertisement and the `discover` command.
- [Codex refresh recovery](codex-refresh-recovery.md): how Codex token refreshes stay safe when a
  response is lost.

## Embed and extend

- [SDK usage](sdk/usage.md): embed the proxy in a Go program.
- [SDK advanced](sdk/advanced.md): custom executors and translators.
- [SDK access](sdk/access.md): request authentication providers.
- [SDK watcher](sdk/watcher.md): incremental auth updates from the watcher.
- [Plugin examples](../examples/plugin/README.md): dynamic library plugins.

## Work on the project

- [Development](development.md): repository layout, Makefile targets, web panel loop, releases.
- [Contributing](../CONTRIBUTING.md)
