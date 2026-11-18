# Configuration

This page covers the config keys a hub owner changes. When you finish it you know what each part
of the installer's `config.yaml` does and where to look for everything else.

The full reference is [`config.example.yaml`](../config.example.yaml); every option is commented
there. The installers start from the shorter
[`config.hub.example.yaml`](../config.hub.example.yaml).

## Where the config lives

| Install | Config file |
| --- | --- |
| Linux and macOS installer | `~/.local/share/t3code-proxy/config.yaml` |
| Windows installer | `%LOCALAPPDATA%\t3code-proxy\config.yaml` |
| Docker Compose | `./data/config.yaml` (`/data/config.yaml` in the container) |
| From source | `config.yaml` in the working directory, or the path given with `-config` |

The hub watches the file and applies most changes without a restart. A `.env` file in the working
directory is loaded at startup.

The file uses the v8 layout (`config-version: 8`). Files in the older flat layout, such as
`port:`, `auth-dir:` and `remote-management:` at the top level, still load unchanged. The end of
`config.example.yaml` maps each old spelling to its new place.

## Listener

```yaml
server:
  host: "127.0.0.1"
  port: 8317
  trusted-proxies: ["127.0.0.1", "::1"]
```

- `host`: the interface to bind. Keep `127.0.0.1` and let `tailscale serve` publish the port. An
  empty value binds every interface; use that only inside a container, where the port mapping
  keeps it on the host's loopback.
- `port`: the API and panel port.
- `trusted-proxies`: addresses allowed to set forwarded client IP headers. `tailscale serve`
  connects from loopback, so trust loopback. Restart after changing this key.

## Management

```yaml
management:
  allow-remote: true
  secret-key: "<management secret>"
```

- `secret-key`: the password for the web panel, the management API and the T3 Code usage
  provider. A plaintext value is replaced with its bcrypt hash in the file when the hub loads it,
  so keep the plaintext in your password manager. An empty value turns the panel and the whole
  management API off.
- `allow-remote`: allow management requests from addresses other than localhost. Requests over
  `tailscale serve` need this. The secret is still required.
- `disable-control-panel`: set `true` to stop serving `/management.html` while keeping the API.
- `panel-github-repository`: leave empty to serve the panel compiled into the binary. When set,
  the hub downloads `management.html` from that repository's latest release instead.

## Client keys

```yaml
access:
  api-keys:
    - "<access key>"
```

The keys Claude Code, Codex and other clients send as a bearer token. They are not provider keys.
Use long random values; the installers generate one from 40 random bytes. You can add one key per
machine to tell them apart in the logs, and remove a key to revoke it.

## Accounts directory

```yaml
oauth:
  auth-dir: "~/.t3code-proxy"
```

Where account logins are stored, one JSON file per account. When the key is absent the hub uses
`~/.t3code-proxy`, or `~/.cli-proxy-api` if only that older directory exists. Treat the directory
as secret.

## Routing

```yaml
routing:
  strategy: "soonest-reset-first"
  session-affinity: true
  session-affinity-ttl: "1h"
  plan-headroom-reserve: 10 # default; 0 disables the 5-hour headroom guard
  plan-weights:             # optional overrides of the built-in plan weights
    codex:
      pro: 12
  retry:
    request-retry: 3
    max-retry-interval: 30
```

See [routing](routing.md) for the strategies, plan weights, affinity and retries.

## Quota history

```yaml
quota-history:
  enabled: true
  interval: 10m
  retention: 35d
```

See [quota history](quota-history.md).

## Logs and usage statistics

```yaml
observability:
  logs:
    logging-to-file: true
    request-log: true
    logs-max-total-size-mb: 0
    error-logs-max-files: 0
    debug: false
  usage:
    usage-statistics-enabled: true
```

- `logging-to-file`: write rotating application log files under `logs/` instead of stdout.
- `request-log`: retain proxy requests, responses, upstream attempts, streamed events (including
  provider-supplied reasoning), WebSocket timelines, and errors. Authentication headers are masked;
  management requests are excluded. Providers cannot expose reasoning they do not send.
- `error-logs-max-files`: cap forced error logs when request logging is off; `0` retains all of them.
- `logs-max-total-size-mb`: delete the oldest log files above this total. `0` disables the cap.
- `debug`: verbose logging. Turn it off again after you have the logs you need.
- `usage-statistics-enabled`: aggregate request and token statistics in memory for the panel.

The hub template enables request and application logging with automatic deletion disabled.
Existing installations keep their configuration; apply the settings above to enable this policy.
Keep `server.commercial-mode` disabled so request logging middleware runs, and leave the Home
control-plane integration disabled when local retention is required: Home mode forwards request
logs to that separate service instead of saving local copies.

Completed logs can be compressed or copied to backup storage to recover space. Verify the backup
before removing a local copy, and retain the backup indefinitely. Do not move active `main.log`,
`response-body-*.tmp`, or request detail spool directories while requests are running. No automatic
backup destination is configured by this template; provision storage before the disk fills.

## Outbound proxy

```yaml
requests:
  proxy-url: ""
```

Routes the hub's own requests to providers through an HTTP, HTTPS or SOCKS5 proxy. Leave it empty
on a home hub; provider traffic should leave from your home connection. `-login-proxy <url>` sets
a proxy for one login only.

## Model catalogs

```yaml
models:
  catalog: ""
  codex-catalog: ""
  devin-catalog: ""
```

The hub keeps model catalogs up to date from remote sources and refreshes them every three hours.
By default these are community-maintained catalogs published by the CLIProxyAPI project
(`raw.githubusercontent.com/router-for-me/models` and `models.router-for.me`); see
[NOTICE](../NOTICE). To change that:

- set a key to an `http(s)` URL or an absolute file path to use your own catalog;
- start the hub with `-local-model` to use the catalogs embedded in the binary and make no catalog
  requests. A key you set explicitly still overrides `-local-model`.

A failed refresh keeps the last good catalog.

## Plugins

```yaml
plugins:
  enabled: false
```

Dynamic library plugins run as trusted code inside the hub and are off by default. The plugin
store in the panel lists plugins from a community registry
(`router-for-me/CLIProxyAPI-Plugins-Store`) and from any extra `plugins.store-sources`; the
registry is fetched only when you open the store. See the
[plugin examples](../examples/plugin/README.md).

## Command-line flags

`t3code-proxy -h` lists every flag. The ones a hub owner uses:

| Flag | Purpose |
| --- | --- |
| `-config <path>` | Config file to use. |
| `-claude-login` | Sign a Claude account in (browser, callback port 54545). |
| `-codex-login` | Sign a Codex account in (browser, callback port 1455). |
| `-codex-device-login` | Sign a Codex account in with a device code. |
| `-no-browser` | Print the login URL instead of opening a browser. |
| `-oauth-callback-port <n>` | Use a different local callback port for a login. |
| `-login-proxy <url>` | Proxy for one login; saved as that account's proxy. |
| `-local-model` | Use the embedded model catalogs. |
| `-tui` | Terminal management UI. Add `-standalone` to start a server with it. |

`t3code-proxy doctor -h` lists the checker's flags: `-config`, `-auth-dir`, `-port`, `-json` and
`-offline`.
