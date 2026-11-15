# T3 Code

After this page, T3 Code sends its Claude and Codex requests through your hub, and **Usage →
Limits** shows the pooled limits of every account on the hub. You need a working hub from the
[setup guide](setup.md).

T3 Code needs no plugin and no change on the hub. Requests go through the clients' own config
files, and limits come from the hub's management API.

## Where providers run

T3 Code runs a provider on the machine of the environment that owns the thread, with that
machine's Claude Code and Codex configuration. Configure the hub on that machine. Phones and other
devices that only view the thread do not matter here.

## Claude

Pick one of these on the environment's machine:

- Point that machine's Claude Code at the hub as in the setup guide (`ANTHROPIC_BASE_URL` and
  `ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`). Claude in T3 Code then uses the hub too.
- Add a separate Claude instance under **Settings → Providers** with its own config directory that
  holds the hub settings, such as `~/.claude-hub`.
- Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` as environment variables on a Claude
  instance in **Settings → Providers**, and mark the token as sensitive.

## Codex

Point the machine's Codex at the hub in `~/.codex/config.toml` as in the setup guide. In T3 Code,
choose **Use existing CLI** for Codex. That option reads `config.toml`. **Continue with ChatGPT**
signs in directly and does not go through the hub.

## Add the hub as a usage provider

A Claude connection that uses `ANTHROPIC_AUTH_TOKEN` does not report subscription limits by
itself. To see the limits of the accounts behind the hub, add the hub:

1. Open **Settings → Providers → Usage providers → Add hub**.
2. Choose the environment that connects to the hub. Its machine must be on your tailnet.
3. Enter the hub URL, `https://<hub>.<tailnet>.ts.net:8317`, and the management secret (not the
   access key).

Remove the hub from the same section when you no longer need it. The usage provider only reads
limits; it does not route requests.

## What appears under Limits

**Usage → Limits** pools the accounts per provider. You read one figure per window, such as the
5-hour and weekly windows, with a bar that has one segment per account. Claude's model-scoped
weekly limits, such as the Opus weekly limit, keep their own values. An account that is signed in
on an environment and also on the hub counts once.

T3 Code reads the hub's Codex, Claude, xAI (shown as Grok) and Antigravity accounts. Accounts for
other providers on the hub are not shown.

## Reset credits

Codex accounts can hold banked reset credits. T3 Code shows the count in each account's details.
Select an account and choose **Use reset** to redeem one; the account's Codex limits are restored
right away.

The web panel's Overview page shows the same banked resets and has its own **Use reset** action.

## How T3 Code talks to the hub

T3 Code calls three endpoints under `/v0/management`, each with
`Authorization: Bearer <management secret>`:

| Endpoint | Purpose |
| --- | --- |
| `GET /v0/management/auth-files` | List the accounts on the hub. |
| `POST /v0/management/api-call` | Have the hub call a provider endpoint with an account's token. The token stays on the hub. |
| `POST /v0/management/reset-quota` | Clear an account's cooldown on the hub. |

These endpoints are a supported compatibility contract. `test/t3code_contract_test.go` pins their
request and response shapes, so a change that would break T3 Code fails the test suite.

T3 Code reaches them over Tailscale, so `management.allow-remote` must be `true`. The installer's
config sets it.
