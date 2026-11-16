# T3 Code

After this page, T3 Code sends its configured providers' requests through your hub, and
**Usage → Limits** shows pooled limits for the accounts its usage reader supports. You need a
working hub from the [setup guide](setup.md). [Providers](providers.md) lists every subscription
and API-key upstream, its login flow and its client API surface.

Subscription proxying may violate provider terms and can lead to suspension or a ban. Never
serve other people's traffic with your subscriptions. Use Claude subscriptions only through
Claude Code, including the Claude Code instance T3 Code runs.

T3 Code needs no plugin and no change on the hub. Requests go through the clients' own config
files, and limits come from the hub's management API.

## Where providers run

T3 Code runs a provider on the machine of the environment that owns the thread, with that
machine's Claude Code and Codex configuration. Configure the hub on that machine. Phones and other
devices that only view the thread do not matter here.

[Environments](environments.md) covers the verified `t3 serve`, `t3 connect`, service and pairing
commands, including Windows and WSL 2 on one PC. [Box setup](box-setup.md) gives an ordered SSH
checklist. Once you select a remote environment, its terminals and agents run on that box.

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

## Antigravity (Gemini)

T3 Code's Antigravity provider runs the Antigravity CLI (`agy`). With its **Gemini API key** sign-in
the CLI sends Gemini API requests, and it reads the endpoint from `GOOGLE_GEMINI_BASE_URL`. That
lets the stock provider use the hub's Antigravity account. It needs an `agy` release that knows
this variable; 1.5.9 does.

1. Open **Settings → Providers → Antigravity**.
2. Set the sign-in method to **Gemini API key** and enter a hub access key, not a Google key.
3. Add the environment variable `GOOGLE_GEMINI_BASE_URL` with the hub's root URL, such as
   `https://<hub>.<tailnet>.ts.net:8317`.

The model list comes from the CLI, not from the hub, so it also shows Gemini models your
Antigravity account does not serve. Those fail with `unknown provider for model`. Hide them in
the model picker and keep the ones `GET /v1beta/models` on the hub returns. The Google account
sign-in method does not go through the hub.

## Mistral (OpenCode and Vibe)

Mistral has two monthly budgets on one account: API usage and Vibe Code. Which one a request
draws on is decided by Mistral from the client that sent it.

- **OpenCode** pointed at the hub uses the hub's Mistral upstream (an `api-keys.openai-compatibility`
  entry for `https://api.mistral.ai/v1`) and draws on the API budget.
- **Mistral Vibe**, added in T3 Code as an ACP agent and signed in with Mistral, talks to Mistral
  directly and draws on the Vibe Code budget. It does not pass through the hub.

The hub reads both budgets with its Mistral key and shows them on the Overview page as money
spent of the monthly amount, with the reset date, whichever client did the spending. See
[quota history](quota-history.md).

## Other upstream providers

The hub also serves Antigravity, Kimi, xAI, Devin, Meta, Google API keys, Vertex and
OpenAI-compatible upstreams. Use the client configuration and model selection in
[providers](providers.md#point-clients-at-the-hub). For example, a Codex instance pointed at the
hub can select an exposed model from another upstream. Check the model's supported tools and
modalities before relying on it for a coding task.

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

The hub web panel has its own quota views and plan-aware pool charts. Its Claude and Codex
charts let you weight accounts by plan. Configure those weights to match your subscriptions.
The [capability table](providers.md#capability-table) gives the panel's coverage, and
[quota history](quota-history.md) describes the recorder. T3 Code reads provider usage through
the management endpoints below. The panel's chart weights are stored in that browser.

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
