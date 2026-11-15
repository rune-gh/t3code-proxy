# t3code-proxy

A personal fork of [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) that recreates
the hub from Theo Browne's token-maxing setup ([video](https://www.youtube.com/watch?v=D8PikZ1KhUo),
[gist](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af)), whose own fork ("prox") is private.
One always-on box on the home network holds every Claude and Codex account; every other machine reaches it
over Tailscale. It runs on a Windows home hub.

**Rules**
- The hub (this repo) can be forked and modified freely. Keep upstream files' diffs to small hooks and put
  fork code in new files so rebasing onto new releases stays easy.
- **T3 Code, Claude Code, Codex and other clients are never code-modified.** Only their config files and
  environment variables point them at the hub. T3 Code changes are left to the T3 devs.
- Follow Theo's two hard rules: never serve other people's traffic with your subs, and only use Claude models
  through Claude subs in Claude Code.

## What the fork adds

Theo: "Stock CLIProxyAPI works if you set it up right. Affinity and websockets are just config. Routing is
the one I had to fork for." Plus: "Want a better dashboard? Congrats, you have your first token maxing task."

| Feature | Where | Notes |
|---|---|---|
| Session affinity | config | `routing.session-affinity: true`, TTL 1h (stock) |
| Codex websockets | client config | `supports_websockets = true` in the Codex model provider (stock) |
| **Soonest-reset-first routing** | `sdk/cliproxy/auth/selector_reset.go` | `routing.strategy: soonest-reset-first` |
| **Quota history recorder** | `internal/quotahistory/` | `quota-history.enabled: true`; polls each Claude/Codex account's usage endpoint every 10 min into `quota-history.db` |
| **Pooled quota dashboard** | `web/` (vendored Management Center) | Theo-style Quota Management page, branded t3code-proxy |

**Routing.** A new conversation goes to the Claude or Codex account whose weekly limit resets soonest, so
allowance that would expire unused is spent first. Accounts without a fresh reading are probed first (at
most once an hour); Grok/Antigravity never report quota and are excluded from ranking; ties round-robin;
session affinity keeps threads on their account. `strategy: round-robin` restores stock behaviour.
Known gap: Claude's per-model Fable weekly cap is not ranked (a request can land on an account whose Fable
cap is spent, get a 429 and retry elsewhere). The recorder now has that data; wiring it into the selector
is the next routing task.

**Recorder.** `GET /v8/management/quota-history?since=&until=` and `POST /v8/management/quota-history/refresh`
(also under `/v0/management`). Windows: `five_hour`, `seven_day`, `seven_day_fable`, `seven_day_opus` (Claude);
`five_hour`, `seven_day` (Codex). Off by default, hot-reloadable, refuses a db path inside `auth-dir`.

**Dashboard.** One pool card per provider: pooled remaining (sum of accounts × plan weight), recorded line
plus a projection that simulates soonest-reset-first drain and refills at each reset, pool-empty / first-empty
/ next-reset / burn-rate stats, Remaining vs Drain rate, 1h/3h/6h burn window, future-usage scaling,
per-account overlay, labels blurred until "Show emails". Dev preview without a hub:
`cd web && bun run dev`, open `/?fixture=quota-history#/quota`.

## Branches and remotes

| Ref | What |
|---|---|
| `upstream` | `router-for-me/CLIProxyAPI` |
| `origin` | `rune-oai/t3code-proxy` (public) |
| `main` | tracks `upstream/main`, never committed to |
| `t3code` | upstream release tag + fork commits (default branch, what the hub runs) |

`t3code` is based on **v8.0.72**. `web/` is a git subtree of
[Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center); pull
upstream panel changes with
`git subtree pull --prefix=web https://github.com/router-for-me/Cli-Proxy-API-Management-Center.git main --squash`.

## Build and release

```sh
sh fork/build.sh                 # Go tests, windows/amd64 exe, web verify + build, SHA256s
gh release create v8.0.72-t3code.N fork/out/management.html fork/out/cli-proxy-api.exe \
  --title "t3code-proxy v8.0.72-t3code.N" --notes "..."
```

The hub's `management.panel-github-repository` points at this repo, so the stock panel updater installs
`management.html` from the latest release (verified against GitHub's asset digest).

## Updating to a new upstream release

```sh
git fetch upstream --tags
git rebase --onto v8.0.73 v8.0.72 t3code   # old base -> new base (fork commits only; see below)
sh fork/build.sh v8.0.73
```

The `web/` subtree merge doesn't survive a plain rebase. If the rebase stops in `web/`, abort, rebase the
non-web fork commits, then re-add the subtree and cherry-pick the `feat(web)` commits.

## Deploying to the hub

Follow "Updating the hub" in `HUB-SETUP.md` (`C:\Users\Daniel\cliproxyapi\` on the hub,
`~/.config/cliproxy-windows/` on the Mac): stop the scheduled task, keep the old exe as
`cli-proxy-api.prev.exe`, copy the new exe in, merge [`fork/config.hub.example.yaml`](fork/config.hub.example.yaml)
settings into `config.yaml`, start the task, run the health check. Real keys live only in the hub's
`config.yaml`, which is gitignored.
