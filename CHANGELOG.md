# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/provider/<name>/v1` serves the Responses WebSocket, `/responses/compact` and `/alpha/search`,
  so Codex can use `/provider/codex/v1` as its base URL. With `model_catalog_url` pointed at
  `/provider/codex/v1/models`, Codex signed in with a hub access key reads its model list live
  from the hub, so new models appear without a fixed catalog file.
- Codex models now appear as soon as your ChatGPT accounts can use them, before the community
  catalog lists them (GPT-6.2-Sol and GPT-6.2-Astra were missing from T3 Code and Codex model
  pickers). Each Codex login reads its own model list from ChatGPT when it registers and every
  3 hours, and models the catalog lacks are added for that account's plan with the capabilities
  of their closest catalog sibling. Catalog entries keep precedence. Discovery is off with
  `--local-model` and in Home mode.
- Models newer than the catalog now route instead of failing with `unknown provider for model`.
  A request for a model no credential lists is adopted on the provider it belongs to: the
  request's `/provider/<name>` scope, a credential prefix or ID namespace (`vibe/...`,
  `devin/...`), or otherwise the provider serving the most models of its family (`claude`,
  `gpt`, `gemini`, `grok`, `mistral`, `devstral`, ...). This covers every provider, including
  Antigravity, plugins and OpenAI-compatible upstreams. The model copies the capabilities of
  its closest sibling, survives catalog and token refreshes, and reaches credentials added
  later. Excluded-models settings still apply and there is no cap; the provider's own error
  answers names it does not know. Claude Mythos 5.1 and 5.2 are also built-in Claude models.
- `GET /opencode/<access key>/api.json` serves the hub's models as a models.dev catalog for
  OpenCode's `OPENCODE_MODELS_URL`, so OpenCode lists models available to that client. The key in the path
  is masked in logs.

- Provider-scoped client endpoints under `/provider/<name>` with filtered OpenAI, Anthropic and
  Gemini model catalogs, provider-pinned text execution and isolated session affinity. Named
  OpenAI-compatible upstreams such as `mistral` are supported. Antigravity CLI setup now uses
  its enterprise model gateway environment variables.

- Mistral monthly API and Vibe Code budget history for API-key upstreams on `api.mistral.ai`,
  with cached subscription plans and optional `budget` and `currency` window fields. These
  usage-only windows use account weight 1.
- Plan-aware routing and pooling. Each account's plan is resolved (Claude Pro, Max 5x, Max 20x;
  Codex Plus, Pro, and so on) and given a capacity weight, overridable under
  `routing.plan-weights` and readable at `GET /v8/management/routing/plan-weights`.
  `soonest-reset-first` spreads new conversations by plan weight where accounts are otherwise
  equal, and `routing.plan-headroom-reserve` keeps new conversations off accounts whose 5-hour
  window is nearly used while another account has room.
- Quota history and `soonest-reset-first` ranking for xAI, Antigravity, Kimi, Meta, Devin and
  quota plugins, next to Claude and Codex. With `quota-history.enabled: true`, an upgraded hub now
  polls the usage endpoints of all of these providers by default; `quota-history.providers`
  limits which ones.
- Web panel: the same pool card for every provider that reports renewing limits (from recorded
  history, or from the latest live read when the recorder does not sample that provider), with
  pooled figures in percent of the heaviest plan in the pool ("38% of 120%" for Max 5x + Pro),
  plan weights saved on the hub, a group picker for providers with many windows such as
  Antigravity, and Connect snippets for OpenAI-compatible tools, OpenCode, Gemini clients and
  Muse Code.
- Web panel Overview: a **Pools** / **Resets** switch. Resets is a calendar of every account
  window across providers (current, upcoming and elapsed windows with what was left unspent at
  each reset, banked Codex reset expiries with **Use reset**, monthly windows on the calendar
  month), with a **Next resets** list of the soonest resets and their unspent allowance, a window
  filter, and the Pools view's span controls. It replaces the old "Quota windows" timeline.
- Web panel: Mistral, read by the hub with an API key and present only in the quota history, gets
  a tab, a pool and calendar lanes; windows with a budget read in money beside percent.
- `scripts/migrate-windows.ps1`, which replaces a running CLIProxyAPI Scheduled Task with
  t3code-proxy: verified backup, detached switch, authenticated checks, automatic rollback, and a
  named-backup rollback. `t3code-proxy doctor -check-config` validates a config without starting
  a server.
- Guides for every provider, for T3 Code environments over Tailscale (including Windows with
  WSL 2), and an agent-readable box-setup checklist.

### Changed

- The standalone hub reserves its Claude subscription credentials for Claude Code. OpenCode and other hub clients
  list and use models supplied by their eligible credentials, including Anthropic API keys.

- Web panel Overview: account cards are gone. Each row of an accounts table opens that account's
  full read in place (windows and resets, plan details, Claude extra usage, Codex banked resets
  and credit overage, xAI usage breakdown and pay-as-you-go, Antigravity groups, errors, and the
  per-account actions); accounts without a renewing window list in the same table form. The plan
  shares caption under the pool headline is removed (the weight editor stays behind the card's
  sliders button), and account emails are shown by default with a **Hide emails** toggle.

- A conversation bound by session affinity moves to another account before sending when the hub
  already knows a window governing that model is spent on the bound account.
- `soonest-reset-first` skips an account when any window governing the model is spent, and
  response headers newer than a recorded reading overrule it.
- Behavior change for hubs already on `soonest-reset-first`: the 5-hour headroom guard is on by
  default (`routing.plan-headroom-reserve: 10`; `0` turns it off), and tied accounts are spread
  by plan weight instead of evenly.
- New logo: a fox head in profile, white and silver on the black tile.

### Added

- `deploy/t3code/agy-acp`: runs the standalone Antigravity CLI as T3 Code's Antigravity runtime,
  so T3 Code shows the hub's whole Antigravity catalogue. Setup in `docs/t3code.md`.

### Fixed

- `deploy/t3code/agy-acp`: preserve `yolo` (Full access) when `agy` reports `accept-edits` back to
  T3 Code instead of unconditionally rewriting it to `auto_edit` (Accept edits), and clamp
  out-of-range `thought_level` updates to the active model's offered levels.
- Antigravity CLI `/v1beta/models` catalog: deduplicate effort-suffixed/aliased models and expand
  thinking-capable models into `agy`-supported effort levels (within `agy`'s 32-entry cap) so T3
  Code shows thinking levels under **Effort** instead of separate models.
- Config hot reload keeps working after the config file is saved by renaming a temp file over
  it, as many editors and tools do. The watcher used to watch the file itself, so after one
  such save every later change was ignored until the hub restarted. It now watches the config
  file's directory and filters events down to the config path.
- Two Mistral keys of one customer (a console key and a Vibe key) are recorded as one account,
  so the monthly API and Vibe Code budgets are not counted twice.

- `soonest-reset-first` no longer sends new work to an account it knows is spent while the
  account with allowance left is only on a short hold. Seen on a live hub: one "overloaded"
  answer put the usable Codex account on a five-minute hold and the next conversations were
  refused by the spent account with "usage limit reached", valid for two days. The hub now
  answers with a cooldown error and the short wait.

## [0.1.0]

First release as t3code-proxy. The code base starts from CLIProxyAPI v8.0.72; see
[NOTICE](NOTICE).

### Added

- `soonest-reset-first` routing strategy: new conversations go to the account whose weekly limit
  resets first. Accounts without a recent reading are probed first, priority tiers still apply,
  and weights are ignored.
- Model-scoped weekly caps in `soonest-reset-first`: Claude accounts whose cap for the requested
  model family is spent are skipped while another account is available, and the scoped reset is
  used for ranking.
- Quota-history recorder (`quota-history.*`) that polls each Claude and Codex account's usage and
  stores it in a local database, with `GET /v8/management/quota-history` and
  `POST /v8/management/quota-history/refresh` (mirrored under `/v0/management`).
- `t3code-proxy doctor`, which checks the network, sleep settings, Tailscale, `tailscale serve`,
  the port, the config, the accounts, the service and linger.
- Installers for Linux and macOS (`scripts/install.sh`) and Windows (`scripts/install.ps1`) that
  verify the release checksum, generate the access key and management secret, and install a
  systemd user unit, a launchd agent or a Scheduled Task.
- `config.hub.example.yaml`, a minimal hub configuration.
- A new web panel compiled into the binary and served at `/management.html`, with Overview
  (pooled limits, quota charts and banked Codex reset credits), Accounts, Add account, Routing,
  Connect (ready-to-paste client config), Activity, Providers, Logs, Settings and System pages.
- Contract tests that pin the `/v0/management` endpoints T3 Code uses.
- Makefile, reproducible build and release scripts, CI and release workflows, and a container
  image at `ghcr.io/rune-oai/t3code-proxy` that runs as a non-root user.

### Changed

- The product, binary and container image are named `t3code-proxy`. The Go module is
  `github.com/rune-oai/t3code-proxy`.
- New installs store account logins in `~/.t3code-proxy`. An existing `~/.cli-proxy-api` is used
  when the new directory does not exist.
- The panel is served from the binary by default instead of being downloaded from a GitHub
  release. `management.panel-github-repository` still selects a downloaded panel when set.
- The web panel is English only.

### Removed

- Sponsor content, translated READMEs and the upstream provider logo set.

[Unreleased]: https://github.com/rune-oai/t3code-proxy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rune-oai/t3code-proxy/releases/tag/v0.1.0
