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

The hub can serve a Google account's whole Antigravity catalogue (Gemini, and the Claude and
GPT-OSS models Google offers) to T3 Code's Antigravity provider. Two pieces make that work.

- **The Antigravity-only endpoint.** The Antigravity CLI's gateway mode takes its model list from
  the endpoint it is pointed at. `https://<hub>/provider/antigravity` lists only the hub's
  Antigravity accounts, so the CLI never offers your Claude or Codex subscription models.
- **The standalone CLI.** T3 Code's bundled Antigravity runtime ignores gateway mode and always
  offers its own fixed Gemini list. The standalone `agy` CLI (1.5.9 or later) honours it.
  [`deploy/t3code/agy-acp`](../deploy/t3code/agy-acp) starts `agy acp` for T3 Code and renames
  the session modes between the two runtimes (`auto_edit` and `yolo` become `accept-edits`);
  everything else passes through unchanged.

Setup on the machine running T3 Code:

1. Install the standalone CLI so `~/.local/bin/agy` exists.
2. Copy `deploy/t3code/agy-acp` to a folder of its own, for example `~/.local/share/t3-hub/`,
   and link T3 Code's `localharness_external` next to it (T3 Code checks for it before it accepts
   a custom runtime):

   ```sh
   ln -s ~/.t3/tools/antigravity-acp/<platform>/versions/<version>/localharness_external \
     ~/.local/share/t3-hub/localharness_external
   ```

3. In **Settings → Providers → Antigravity**: sign-in method **Gemini API key** with a hub access
   key, **Binary path** set to the copied `agy-acp`, and these environment variables (mark the
   key as sensitive):

   ```text
   AGY_LLM_GATEWAY_URL=https://<hub>/provider/antigravity
   AGY_LLM_GATEWAY_API_KEY=<hub access key>
   GOOGLE_GEMINI_BASE_URL=https://<hub>/provider/antigravity
   ```

4. Start one Antigravity thread. T3 Code fills the model picker from the first session.

Clearing the binary path returns to T3 Code's bundled runtime and its fixed Gemini list.

## OpenCode

OpenCode takes its model catalog from a models.dev-style URL. The hub serves its own catalog at
`https://<hub>/opencode/<access key>/api.json`: every model the hub serves, under one provider
called `t3code-proxy`, refreshed by OpenCode every few minutes. Claude models use the Anthropic
Messages API, Codex models the Responses API, and the rest OpenAI chat completions, all on the hub.
OpenCode cannot send a header with that fetch, so the access key is in the path; the hub masks it
in its logs.

1. Enable OpenCode in **Settings → Providers** on the environment's machine. Its driver is off
   until you do.
2. Give the instance these environment variables, the first two marked sensitive:

   ```sh
   OPENCODE_MODELS_URL=https://<hub>.<tailnet>.ts.net:8317/opencode/<access key>
   T3CODE_PROXY_API_KEY=<access key>
   OPENCODE_AUTH_CONTENT={}
   ```

   `OPENCODE_AUTH_CONTENT={}` hides OpenCode's own saved logins from this instance. OpenCode
   1.18 fails to load its providers when a saved login names a provider the catalog lacks.

3. Pick a `t3code-proxy/<model>` model in the thread. The instance lists only the hub's models;
   your own OpenCode setup outside T3 Code is unchanged.

Claude subscription accounts are meant for Claude Code (see the note at the top of this page).
OpenCode can reach them through this catalog, so exclude Claude models for it, or keep it to
API-key accounts, if that matters to you.

## Mistral (OpenCode and Vibe)

Mistral has two monthly budgets on one account: API usage and Vibe Code. Which one a request
draws on depends on the key that sends it: a key made in the Mistral console draws on the API
budget, and the key Mistral Vibe gets when you sign in with Mistral draws on the Vibe Code budget.
To run both through the hub, give the hub both keys as two upstreams.

1. Keep the console key as the `mistral` upstream (`api-keys.openai-compatibility`, base URL
   `https://api.mistral.ai/v1`). OpenCode and other clients use it as `<model>`.
2. Add the Vibe key as a second upstream with the same base URL and models and `prefix: vibe`, and
   set `force-model-prefix: true`. Its models are then reachable only as `vibe/<model>`, so nothing
   else spends the Vibe budget by accident. On macOS, Vibe keeps its key in the keychain under the
   service `ai.mistral.vibe`.
3. Declare the reasoning levels Mistral accepts on models that have them, for example
   `thinking: {levels: [none, high], zero-allowed: true}` on `mistral-vibe-cli-latest`. Without it
   the hub turns "thinking off" into `reasoning_effort: low`, which Mistral rejects.
4. Point Vibe at the hub in `~/.vibe/config.toml`: a `mistral` provider with
   `api_base = "https://<hub>.<tailnet>.ts.net:8317/v1"`, `backend = "mistral"`,
   `preserve_api_base = true`, and `api_key_env_var = "MISTRAL_API_KEY"`, with the hub access key
   in `~/.vibe/.env`. Add each model as `[[models]]` with `name = "vibe/<model>"` and the alias Vibe
   shows, such as `mistral-medium-3.5` for `vibe/mistral-vibe-cli-latest`.

T3 Code's Mistral Vibe agent (ACP) reads the same files, so it follows.

The hub reads both budgets and shows them on the Overview page as money spent of the monthly
amount, with the reset date. Two keys of one Mistral customer are recorded as one account, so
neither allowance is counted twice. See [quota history](quota-history.md).

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
