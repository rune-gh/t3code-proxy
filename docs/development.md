# Development

This page gets you from a fresh clone to a running hub built from source, a live-reloading web
panel, and a tagged release. Read [CONTRIBUTING.md](../CONTRIBUTING.md) for the rules a change
has to follow.

## Requirements

- Go 1.26 or later (the exact version is in `go.mod`).
- Bun 1.4.3 for the web panel (pinned in `web/package.json`).
- Optional: `shellcheck` for `make lint`, Docker for `make docker`.

## Repository layout

| Path | Contents |
| --- | --- |
| `cmd/server/` | The `t3code-proxy` entrypoint, including the `doctor` and `discover` commands. |
| `cmd/fetch_*`, `cmd/validate_codex_models/` | Utilities that refresh and check the embedded model catalogs. |
| `internal/api/` | Gin HTTP server: proxy routes, middleware and the management API. |
| `internal/runtime/executor/` | One executor per provider, including Codex over WebSockets. |
| `internal/translator/` | Protocol translators between the OpenAI, Claude, Gemini and Codex formats. |
| `internal/thinking/` | The reasoning-effort pipeline shared by all providers. |
| `internal/auth/` | OAuth login and refresh for each provider. |
| `internal/doctor/` | The `t3code-proxy doctor` checks. |
| `internal/quotahistory/` | The [quota-history](quota-history.md) recorder and its store. |
| `internal/managementasset/` | Serves the web panel: embedded copy, optional download, placeholder. |
| `internal/registry/` | Model registry and the remote catalog updater. |
| `internal/watcher/` | Config and auth-directory hot reload. |
| `sdk/cliproxy/` | Embeddable service, auth manager and selectors, including soonest-reset-first. |
| `web/` | The React web panel. See [`web/README.md`](../web/README.md). |
| `deploy/` | systemd unit, launchd agent and Windows Scheduled Task script. |
| `scripts/` | Build, web, release and install scripts. |
| `test/` | Cross-package tests, including the T3 Code contract test. |
| `examples/` | SDK and plugin examples. |

## Makefile targets

Run `make` or `make help` for the list:

| Target | What it does |
| --- | --- |
| `make build` | Build `bin/t3code-proxy` for this machine. Embeds the panel if one is staged. |
| `make web` | Build the web panel and stage it for embedding. |
| `make test` | Run the Go tests. |
| `make test-web` | Run the panel's tests, lint and build (`bun run verify`). |
| `make lint` | Check `gofmt`, run `go vet`, and run `shellcheck` on the scripts. |
| `make fmt` | Format the Go code with `gofmt`. |
| `make verify` | Everything CI runs: `lint`, `test`, `build`, `test-web`. |
| `make run` | Run the server from source with `CONFIG` (default `config.yaml`). |
| `make release` | Cross-build archives and `checksums.txt` into `dist/`. |
| `make docker` | Build the container image `ghcr.io/rune-oai/t3code-proxy:dev`. |
| `make clean` | Remove build outputs. |

A typical loop:

```sh
cp config.example.yaml config.yaml   # edit the keys first
make web
make build
./bin/t3code-proxy -config config.yaml
```

## Web panel

The panel is a Vite app in `web/`. The production build is a single `web/dist/index.html`.
`make web` copies it to `internal/managementasset/embedded/management.html`, which the Go build
embeds. That file is not committed; a binary built without it serves a placeholder page at
`/management.html`.

For panel work, run the Vite dev server:

```sh
cd web
bun install --frozen-lockfile
bun run dev
```

Open `http://localhost:5173/?fixture=quota-history#/quota` for a logged-in dev session backed by
sample data, with no hub running. The fixture works on the other routes too, such as
`#/auth-files`, `#/routing`, `#/ai-providers` and `#/config`. It is compiled out of production
builds.

To work against a real hub, open `http://localhost:5173/`, enter the hub's URL under **Hub
address**, and log in with its management secret. A local `make run` hub at
`http://127.0.0.1:8317` works well for this.

Before you push panel changes, run `make test-web`.

## Tests

```sh
make test
go test -v -run <TestName> ./<path/to/package>
```

`test/t3code_contract_test.go` pins the three `/v0/management` endpoints T3 Code depends on. If it
fails, the change breaks T3 Code.

## Releases

Releases are cut from a version tag. The version comes from the exact `v*` tag on `HEAD`;
untagged builds report `dev`.

1. Update [CHANGELOG.md](../CHANGELOG.md): move the entries under `Unreleased` to a new version
   heading.
2. Commit, then tag and push:

   ```sh
   git tag v<version>
   git push origin v<version>
   ```

3. The `release` workflow runs the tests, builds the archives with `make release`, attests their
   provenance, and publishes a GitHub release with the archives and `checksums.txt`. A tag that
   contains `-`, such as `v0.2.0-rc.1`, is published as a prerelease.
4. The same workflow builds and pushes the multi-platform image to `ghcr.io/rune-oai/t3code-proxy`.

To build release archives locally, run `make release`. Set `TARGETS` to limit the platforms, for
example `make release TARGETS="linux/amd64 darwin/arm64"`. Cross-built Linux and macOS archives
are built without CGO and cannot load dynamic library plugins; the container image is built with
CGO and can.
