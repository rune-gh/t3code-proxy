# AGENTS.md

t3code-proxy: a Go 1.26+ hub that holds Claude and Codex subscription logins on one always-on machine and exposes OpenAI/Claude/Gemini/Codex-compatible APIs, with OAuth refresh, soonest-reset-first routing, session affinity, a quota-history recorder and an embedded web panel.

## Repository
- GitHub: https://github.com/rune-oai/t3code-proxy
- Go module: `github.com/rune-oai/t3code-proxy`

## Commands
```bash
make help # List targets
make fmt # Format Go code with gofmt (required after Go changes)
make build # Build bin/t3code-proxy (embeds the staged web panel if present)
make web # Build the web panel and stage it for embedding
make test # Run all Go tests
make lint # gofmt check, go vet, shellcheck
make verify # Everything CI runs (lint, test, build, test-web)
make run # Run the server from source with $(CONFIG), default config.yaml
go test -v -run TestName ./path/to/pkg # Run single test
go build -o test-output ./cmd/server && rm test-output # Verify compile (REQUIRED after changes)
```
- Common flags: `-config <path>`, `-tui`, `-standalone`, `-local-model`, `-no-browser`, `-oauth-callback-port <port>`, `-claude-login`, `-codex-login`, `-codex-device-login`
- Subcommands: `t3code-proxy doctor` (hub readiness checks), `t3code-proxy discover` (LAN discovery)

## Config
- Default config: `config.yaml` (full template: `config.example.yaml`; minimal hub template: `config.hub.example.yaml`)
- `.env` is auto-loaded from the working directory
- Auth material defaults to `~/.t3code-proxy`, or the legacy `~/.cli-proxy-api` when only that directory exists; `oauth.auth-dir` overrides
- Storage backends: file-based default; optional Postgres/git/object store (`PGSTORE_*`, `GITSTORE_*`, `OBJECTSTORE_*`)

## Architecture
- `cmd/server/` — Server entrypoint (flags, `doctor` and `discover` subcommands)
- `internal/api/` — Gin HTTP API (routes, middleware, management API under `/v0/management` and `/v8/management`)
- `internal/thinking/` — Main thinking/reasoning pipeline. `ApplyThinking()` (apply.go) parses suffixes (`suffix.go`, suffix overrides body), normalizes config to canonical `ThinkingConfig` (`types.go`), normalizes and validates centrally (`validate.go`/`convert.go`), then applies provider-specific output via `ProviderApplier`. Do not break this "canonical representation → per-provider translation" architecture.
- `internal/runtime/executor/` — Per-provider runtime executors (incl. Codex WebSocket)
- `internal/translator/` — Provider protocol translators (and shared `common`)
- `internal/registry/` — Model registry + remote updater (`StartModelsUpdater`); `--local-model` disables remote updates
- `internal/store/` — Storage implementations and secret resolution
- `internal/managementasset/` — Config snapshots and management assets; serves the web panel compiled into the binary (`embedded/management.html`, staged by `make web`), an optional downloaded panel, or a placeholder page
- `internal/doctor/` — `t3code-proxy doctor` environment checks
- `internal/quotahistory/` — Quota-history recorder (polls Claude/Codex usage, bbolt store, feeds scoped weekly caps to the selector)
- `internal/cache/` — Request signature caching
- `internal/watcher/` — Config hot-reload and watchers
- `internal/wsrelay/` — WebSocket relay sessions
- `sdk/cliproxy/usage/` — Usage and token accounting
- `internal/home/` — CLIProxyAPIHome control plane integration (bootstrap, RESP communication, dispatch coordination)
- `internal/tui/` — Bubbletea terminal UI (`--tui`, `--standalone`)
- `sdk/cliproxy/` — Embeddable SDK entry (service/builder/watchers/pipeline); `sdk/cliproxy/auth/` holds the selectors, including soonest-reset-first (`selector_reset*.go`)
- `web/` — React web panel (Bun + Vite); built to a single `web/dist/index.html` that the Go binary embeds
- `deploy/` — systemd user unit, launchd agent and Windows Scheduled Task definitions
- `scripts/` — Build, web, release and install scripts (`install.sh`, `install.ps1`)
- `test/` — Cross-module integration tests, including `t3code_contract_test.go`

## Code Conventions
- Keep changes small and simple (KISS)
- Comments in English only
- If editing code that already contains non-English comments, translate them to English (don’t add new non-English comments)
- For user-visible strings, keep the existing language used in that file/area
- New Markdown docs should be in English unless the file is explicitly language-specific
- As a rule, do not make standalone changes to `internal/translator/`. You may modify it only as part of broader changes elsewhere.
- If a task requires changing only `internal/translator/`, run `gh repo view --json viewerPermission -q .viewerPermission` to confirm you have `WRITE`, `MAINTAIN`, or `ADMIN`. If you do, you may proceed; otherwise, file a GitHub issue including the goal, rationale, and the intended implementation code, then stop further work.
- `internal/runtime/executor/` should contain executors and their unit tests only. Place any helper/supporting files under `internal/runtime/executor/helps/`.
- Do not use `github.com/tidwall/gjson`, `github.com/tidwall/sjson`, or Go's standard `encoding/base64`. Always use `github.com/MoeForge/moego/ojson` and `github.com/MoeForge/moego/base64` for all JSON and Base64 operations. All JSON write operations (`Set`, `SetRaw`, `Delete`, etc.) MUST be performed on `*ojson.Doc` (`ojson.NewDoc` / `ojson.NewDocString`), passing `*ojson.Doc` across mutation stages and serializing only once at the final exit (`doc.Bytes()` / `doc.String()`), rather than mutating raw `[]byte` or `string` payloads directly.
- Payload configuration MUST be the final semantic barrier before sending requests in every executor, including streaming, WebSocket, continuation, retry/fallback, image, and token-count paths where applicable. Complete all built-in payload translation, normalization, injection, and cleanup first, then evaluate and apply user payload rules exactly once to the final business payload. No subsequent logic may overwrite configured values or restore filtered fields. Only necessary transport framing, serialization, signature calculation, and read-only validation may follow without changing business payload semantics. Add regression tests when introducing or changing request-building paths to enforce this ordering.
- Follow `gofmt`; keep imports goimports-style; wrap errors with context where helpful
- Do not use `log.Fatal`/`log.Fatalf` (terminates the process); prefer returning errors and logging via logrus
- Shadowed variables: use method suffix (`errStart := server.Start()`)
- Wrap defer errors: `defer func() { if err := f.Close(); err != nil { log.Errorf(...) } }()`
- Use logrus structured logging; avoid leaking secrets/tokens in logs
- Avoid panics in HTTP handlers; prefer logged errors and meaningful HTTP status codes
- Timeouts are allowed only during credential acquisition; after an upstream connection is established, do not set timeouts for any subsequent network behavior. Intentional exceptions that must remain allowed are the Codex websocket liveness deadlines in `internal/runtime/executor/codex_websockets_executor.go`, the wsrelay session deadlines in `internal/wsrelay/session.go`, the management APICall timeout in `internal/api/handlers/management/api_tools.go`, and the `cmd/fetch_antigravity_models` utility timeouts
- Avoid wall-clock `time.Sleep` in TTL, expiration, ordering, or cache-eviction unit tests due to platform timer granularity (e.g. Windows default timer resolution of ~15.6ms) and CI jitter under load; prefer controllable clocks (`nowFunc` / mock clock), explicit timestamp manipulation, or deterministic synchronization primitives.
- Note: `internal/home/` integrates with the separate CLIProxyAPIHome control plane. If you change features that involve it, check whether the CLIProxyAPIHome repository needs a matching update.
- Endpoints under the `/v0/management` base URL are a supported compatibility contract: T3 Code reads the hub through `GET /v0/management/auth-files`, `POST /v0/management/api-call` and `POST /v0/management/reset-quota`, pinned by `test/t3code_contract_test.go`. Do not remove them or change their request or response shapes. Add new management features under `/v8/management`.
