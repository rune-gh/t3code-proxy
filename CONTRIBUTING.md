# Contributing

Thank you for helping. This page explains how to set up the project, what a change needs before
it can be merged, and the rules that keep the hub safe to run.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md). To report a security
problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Before you start

- For a bug, open an issue with the bug report form. Include the output of
  `t3code-proxy doctor -json` and the relevant log lines, with keys, tokens and email addresses
  removed.
- For a feature or a larger change, open a feature request first so the approach can be agreed
  before you write the code.
- Small fixes to docs or typos can go straight to a pull request.

## Set up

You need Go (version in `go.mod`), Bun 1.4.3 for the web panel, and optionally `shellcheck`.
[Development](docs/development.md) covers the repository layout, the Makefile targets and the
web panel dev loop.

```sh
git clone https://github.com/rune-oai/t3code-proxy.git
cd t3code-proxy
make verify
```

## What a pull request needs

- `make verify` passes. It runs `gofmt`, `go vet`, `shellcheck`, the Go tests, the build and the
  web panel's tests, lint and build, the same as CI.
- Tests for behavior changes. Request-building paths need regression tests that show user payload
  rules are applied last.
- Docs and `config.example.yaml` updated for user-visible changes, and an entry under
  `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
- No secrets, tokens, account files or personal data in code, tests, fixtures or logs.
- Small, focused commits with [Conventional Commits](https://www.conventionalcommits.org/)
  messages, such as `fix(routing): ...` or `docs: ...`.

## Rules for changes

[AGENTS.md](AGENTS.md) holds the full engineering rules; they apply to human contributors too.
The ones most often missed:

- Do not change or remove the `/v0/management` endpoints that T3 Code uses. They are a supported
  compatibility contract, pinned by `test/t3code_contract_test.go`.
- Use `github.com/MoeForge/moego/ojson` and `github.com/MoeForge/moego/base64`, not
  `tidwall/gjson`, `tidwall/sjson` or `encoding/base64`.
- Do not add network timeouts after an upstream connection is established, except where
  `AGENTS.md` lists them.
- Do not use `log.Fatal`; return errors and log through logrus. Never log secrets.
- Keep `internal/runtime/executor/` to executors and their tests; helpers go in
  `internal/runtime/executor/helps/`.
- Comments and docs are in English.

## Licensing

The project is MIT licensed. By submitting a contribution you agree that it is licensed under the
same terms. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
