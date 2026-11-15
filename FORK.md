# t3code-proxy

A personal fork of [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), run on the
Windows home hub. It follows Theo's setup: one always-on box on the home network holds every Claude and
Codex account, and every other machine reaches it over Tailscale.

**Rule: this fork adds soonest-reset-first routing and nothing else.** Everything else (session affinity,
Codex websockets, catalogs, keys) is stock upstream configuration. Keep the diff to upstream small so rebasing
onto new releases stays trivial.

## Branches and remotes

| Ref | What |
|---|---|
| `upstream` | `router-for-me/CLIProxyAPI` |
| `main` | tracks `upstream/main`, never committed to |
| `t3code` | upstream release tag + the fork commits; this is what the hub runs |

`t3code` currently sits on **v8.0.69**. `fork/build.sh` rebuilds the deployed hub exe byte for byte
(SHA256 `6dedfab305e071458f6c5dd06d9b6125d3467efdf516dae37790fc0f48dcf932`, verified 2026-11-14).

## What the fork changes

One commit, `feat(routing): add soonest-reset-first strategy`:

- `sdk/cliproxy/auth/selector_reset.go`: the new selector (plus tests).
- Two `case` lines that register the name `soonest-reset-first` (alias `srf`) in
  `sdk/cliproxy/service_config.go` and `internal/api/handlers/management/config_basic.go`, and a comment in
  `internal/config/config_types.go`.

How it picks: a new conversation goes to the Claude or Codex account whose **weekly** limit resets soonest.
Accounts without a fresh reading are probed first (at most once an hour). Grok and Antigravity never report
quota, so they are excluded from ranking. Ties round-robin. Session affinity keeps existing threads on their
account. Setting `strategy: round-robin` restores stock behaviour without a rebuild.

Known gap: only the overall weekly window is ranked. A per-model weekly cap (Claude's Fable bucket) is not,
so a request can land on an account whose Fable cap is spent, get a 429, and retry elsewhere.

## Updating to a new upstream release

```sh
git fetch upstream --tags
git rebase --onto v8.0.72 v8.0.69 t3code   # old base -> new base
sh fork/build.sh v8.0.72                    # tests + windows/amd64 exe + SHA256
```

Then deploy `fork/out/cli-proxy-api.exe` following "Updating the hub" in `HUB-SETUP.md`
(`C:\Users\Daniel\cliproxyapi\` on the hub, `~/.config/cliproxy-windows/` on the Mac). Read the release
notes for routing or scheduler changes first. As of 2026-11-14 the routing commit rebases cleanly onto
v8.0.72 and its tests pass there.

## Hub config

See [`fork/config.hub.example.yaml`](fork/config.hub.example.yaml) for the routing settings the hub uses.
Real keys live only in the hub's `config.yaml`, which is gitignored.
