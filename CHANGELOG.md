# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
