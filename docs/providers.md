# Providers

The hub serves subscription accounts, provider API keys and OpenAI-compatible upstreams through
one endpoint. Keep subscription logins on your always-on home hub. Clients send the hub's access
key. The hub keeps upstream credentials and refreshes OAuth tokens.

Using subscriptions this way may violate provider terms, and accounts can be suspended or banned.
Two hard rules apply throughout this page.

1. Never serve other people's traffic with your subscriptions.
2. Use Claude subscription models only through Claude Code.

Follow [setup](setup.md) for installation and keys. [Environments](environments.md) covers machines
that run agents, and [box setup](box-setup.md) gives an ordered checklist.

## Capability table

The table describes this checkout. **Text APIs** means the hub's translated Chat Completions,
Responses, Claude Messages and Gemini generateContent surfaces. Select a model returned by
`/v1/models`. Tools, reasoning, images and other modalities depend on that model and its executor.
Claude subscription requests must still come from Claude Code.

**Ranked routing** means soonest-reset-first ranking from observed quota resets. All providers
can use ordinary account selection, priority, retries and affinity. See [routing](routing.md).
**Pooled limits** refers to the web panel's recorded pool charts. The per-account quota views have
broader coverage. T3 Code has its own [usage-provider coverage](t3code.md#what-appears-under-limits).

| Provider | Login or credential | Served API surface | Quota shown in panel | Pooled limits | Ranked routing |
| --- | --- | --- | --- | --- | --- |
| Claude subscription | `-claude-login` | Text APIs, use Claude Code | Yes, account windows | Yes, plan-weighted | Yes, weekly and model-scoped caps |
| Codex / ChatGPT subscription | `-codex-login`, `-codex-device-login` | Text APIs, Responses WebSocket, Codex routes | Yes, account windows and reset credits | Yes, plan-weighted | Yes, weekly |
| Antigravity / Google account | `-antigravity-login` | Text APIs | Yes, model quota | Yes, per model group | Yes, when the recorder has a reading |
| Kimi.com | `-kimi-login` | Text APIs | Yes, account quota and plan | Yes | Yes, when the recorder has a reading |
| Kimi.ai | `-kimi-ai-login` | Text APIs | Yes, account quota and plan | Yes | Yes, when the recorder has a reading |
| xAI / Grok | `-xai-login` | Text APIs, Responses WebSocket, xAI media routes | Yes, account quota | Yes, weekly and monthly | Yes, when billing windows are reported |
| Devin / Cognition | `-devin-login` | Text APIs, translated Interactions | Yes, daily/weekly status | Yes, daily and weekly | Yes |
| Meta / Muse | `-meta-login` | Text APIs, Muse Code helper routes | Yes, account usage | Yes | Yes, when the recorder has a reading |
| Gemini API key | `api-keys.gemini` | Text APIs | No subscription quota view | No | No |
| Native Gemini Interactions key | `api-keys.interactions` | `/v1beta/interactions` | No | No | No |
| Vertex | `-vertex-import` or `api-keys.vertex` | Text APIs, optional native Interactions | No | No | No |
| AI Studio browser relay | Connected AI Studio relay session | Text APIs over the browser relay | No | No | No |
| Claude, Codex, xAI, Meta API keys | Respective `api-keys` groups | Text APIs and executor-specific routes | No subscription quota guarantee | No | Only where supported reset signals exist |
| Mistral | API key under `api-keys.openai-compatibility`, host `api.mistral.ai` | Text APIs | Monthly API and Vibe budgets through the recorder | Recorded monthly windows | No |
| OpenAI-compatible upstream | `api-keys.openai-compatibility` | Text APIs, configured image models | No | No | No |
| Plugin provider | Plugin-defined login or credentials | Plugin-defined executor or compatibility API | When the plugin supplies quota | When the plugin supplies renewing windows | When the plugin supplies renewing windows |

Pooled limits and ranked routing for providers other than Claude and Codex come from the
[quota history](quota-history.md) recorder, which polls each provider's usage endpoint. With the
recorder off, those providers rotate by plan weight without ranking.

Accounts on different plans do not count equally. The hub resolves each account's plan and gives
it a capacity weight (Claude Pro 1, Max 5x 5, Max 20x 20; Codex Plus 1, the $100 Pro tier 5, the $200 Pro tier 20), used by both
the pool charts and routing. Override the weights under `routing.plan-weights`. They are separate
from the integer credential `weight` used by weighted-round-robin. See [routing](routing.md).

## Subscription logins

Run these commands on the hub with the service's config. Repeat once per account. The human
finishes authorization in a browser. On Windows, use the config path from [setup](setup.md).

```sh
CONFIG=~/.local/share/t3code-proxy/config.yaml
t3code-proxy -config "$CONFIG" -claude-login
t3code-proxy -config "$CONFIG" -codex-login
t3code-proxy -config "$CONFIG" -codex-device-login
t3code-proxy -config "$CONFIG" -antigravity-login
t3code-proxy -config "$CONFIG" -kimi-login
t3code-proxy -config "$CONFIG" -kimi-ai-login
t3code-proxy -config "$CONFIG" -xai-login
t3code-proxy -config "$CONFIG" -devin-login
t3code-proxy -config "$CONFIG" -meta-login
```

| Account | What you authorize | Clients through the hub |
| --- | --- | --- |
| Claude | Anthropic Claude subscription OAuth | Claude Code, including Claude Code run by T3 Code |
| Codex | ChatGPT account's Codex access | Codex CLI, including T3 Code's **Use existing CLI** instance, and compatible Responses clients |
| Antigravity | Google OAuth and Antigravity model access | Claude Code or Codex using an exposed model, or a compatible text API client |
| Kimi.com / Kimi.ai | Moonshot's device authorization on the selected domain | Claude Code, Codex or a compatible text API client using a Kimi model |
| xAI | Grok device authorization | Claude Code, Codex or a compatible text API client using a Grok model |
| Devin | Cognition authorization code or session token | Claude Code, Codex or a compatible text API client using a Devin catalog model |
| Meta | Muse device authorization | Claude Code, Codex or a compatible text API client using a Muse model |

The client setup below applies to each row. The provider name selects the upstream account pool
through the chosen model. Logging into a provider on the hub does not configure that provider's
native application on another machine.

### Headless logins and callbacks

For Claude, Codex browser login and Antigravity, open an SSH tunnel from your laptop before
starting the login on the hub. Choose the matching row.

| Login | Callback | Tunnel from laptop |
| --- | --- | --- |
| Claude | `http://localhost:54545/callback` | `ssh -L 54545:localhost:54545 <user>@<box>.<tailnet>.ts.net` |
| Codex browser | `http://localhost:1455/auth/callback` | `ssh -L 1455:localhost:1455 <user>@<box>.<tailnet>.ts.net` |
| Antigravity | `http://localhost:51121/oauth-callback` | `ssh -L 51121:localhost:51121 <user>@<box>.<tailnet>.ts.net` |

In that SSH session, use the corresponding command with `-no-browser` and open its printed URL
on your laptop.

```sh
t3code-proxy -config ~/.local/share/t3code-proxy/config.yaml -claude-login -no-browser
t3code-proxy -config ~/.local/share/t3code-proxy/config.yaml -codex-login -no-browser
t3code-proxy -config ~/.local/share/t3code-proxy/config.yaml -antigravity-login -no-browser
```

Use the default ports above for Claude and Codex. Their authorization URLs use fixed callback
URIs in this checkout. Antigravity builds its callback URI from the listener port and supports
`-oauth-callback-port <port>`. Forward that same port if you change it. A busy callback port
usually means another login is running.

Codex device login, Kimi, Kimi.ai, xAI and Meta print a verification URL and device code. Add
`-no-browser` on SSH and authorize on your laptop. They need no callback tunnel.

```sh
t3code-proxy -config "$CONFIG" -codex-device-login -no-browser
t3code-proxy -config "$CONFIG" -kimi-login -no-browser
t3code-proxy -config "$CONFIG" -kimi-ai-login -no-browser
t3code-proxy -config "$CONFIG" -xai-login -no-browser
t3code-proxy -config "$CONFIG" -meta-login -no-browser
```

Devin's `-no-browser` flow prompts for an authorization code or session token in the hub terminal.
Enter it there privately.

```sh
t3code-proxy -config "$CONFIG" -devin-login -no-browser
```

Its browser flow uses an ephemeral callback port by default. For a tunneled browser flow,
forward a fixed port from your laptop.

```sh
ssh -L 54546:localhost:54546 <user>@<box>.<tailnet>.ts.net
```

In that SSH session, run the browser flow with the matching listener port and open the printed
URL on your laptop.

```sh
t3code-proxy -config ~/.local/share/t3code-proxy/config.yaml -devin-login -oauth-callback-port 54546
```

## Point clients at the hub

Back up existing settings and merge these entries with the rest of each file. The URL belongs to
the hub. The access key is from `access.api-keys`. Keep the management secret for the panel and
the T3 Code usage provider.

For Claude Code, put this in `~/.claude/settings.json`, or `%USERPROFILE%\.claude\settings.json`
on Windows.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<box>.<tailnet>.ts.net:8317",
    "ANTHROPIC_AUTH_TOKEN": "<your access key>"
  }
}
```

For Codex, use `~/.codex/config.toml`, or `%USERPROFILE%\.codex\config.toml` on Windows.

```toml
model_provider = "t3code-proxy"

[model_providers.t3code-proxy]
name = "t3code-proxy"
base_url = "https://<box>.<tailnet>.ts.net:8317/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
experimental_bearer_token = "<your access key>"
```

Choose an available model from the hub's catalog. These flags are supported by both installed
clients.

```sh
claude --model <hub model id>
codex --model <hub model id>
```

A general OpenAI-compatible client takes base URL
`https://<box>.<tailnet>.ts.net:8317/v1` and the access key as its API key. A Messages client
takes the root hub URL and calls `/v1/messages`. A Gemini-compatible client calls
`/v1beta/models/<model>:generateContent` or `:streamGenerateContent` and can send the access key
in `X-Goog-Api-Key`. Native Interactions calls use `/v1beta/interactions`.

T3 Code uses these settings on the machine running the environment. See [T3 Code](t3code.md).

## API-key providers and custom upstreams

The v8 config has two key areas. `access.api-keys` authenticates your clients. The top-level
`api-keys` mapping holds upstream provider groups. Its supported groups are `gemini`,
`interactions`, `vertex`, `claude`, `codex`, `xai`, `meta` and `openai-compatibility`.

For example, merge this into your hub config to add Gemini and an OpenAI-compatible upstream.
Replace the example model with one your upstream actually serves.

```yaml
api-keys:
  gemini:
    - name: google-api
      keys:
        - api-key: "<Google API key>"
  openai-compatibility:
    - name: custom
      base-url: "https://<upstream>/v1"
      keys:
        - api-key: "<upstream API key>"
      models:
        - name: "<upstream model id>"
          alias: "<hub model id>"
```

Use `api-keys.claude` for Anthropic Messages endpoints, `api-keys.codex` for Codex-compatible
Responses endpoints, and `api-keys.xai` or `api-keys.meta` for their native executors. Use
`openai-compatibility` for OpenAI, OpenRouter, local servers or another Chat Completions upstream.
Its models can declare image support. Each group supports multiple keys, model aliases and
per-key routing settings. Follow the commented examples for endpoint paths and optional fields.
See [configuration](configuration.md) and [config.example.yaml](../config.example.yaml).

### Mistral

Configure Mistral under `api-keys.openai-compatibility` with base URL
`https://api.mistral.ai/v1`, the account's API key and its models. The quota-history recorder
recognizes the `api.mistral.ai` host regardless of the configured upstream name. Select
`mistral` in `quota-history.providers`, or leave the list empty to poll all supported providers.
The configured name labels the account. Monthly API and Vibe Code budgets and the subscription
plan come from Mistral's billing endpoints using the same API key. Each budget resets on the
first day of the month, UTC. These are usage-only windows, and each account has weight 1.
See [quota history](quota-history.md) for the recorded fields.

### Google AI Studio and Vertex

Gemini API keys issued through Google AI Studio go in `api-keys.gemini`. Keys for direct native
Interactions execution go in `api-keys.interactions`.

The separate `aistudio` provider is a browser WebSocket relay. A connected channel whose ID begins
with `aistudio-` at `/v1/ws` creates a runtime account and forwards requests through that browser
session. It requires a compatible connected relay client. This checkout has no AI Studio login
flag or bundled browser-client installer. See the
[relay registration](../sdk/cliproxy/service_auth.go) and
[executor](../internal/runtime/executor/aistudio_executor.go).

Vertex accepts API keys under `api-keys.vertex` or a Google Cloud service-account JSON import.

```sh
t3code-proxy -config "$CONFIG" -vertex-import /secure/path/service-account.json
```

The import stores the key in the auth directory, requires a `project_id`, and defaults the
location to `global`. `-vertex-import-prefix <prefix>` gives its models a namespace. There is no
browser callback for the import. Native Vertex Interactions is opt-in through
`interactions: true` on the key group or imported credential. Treat the original JSON and stored
account file as secrets. See the [import implementation](../internal/cmd/vertex_import.go).

## Check coverage in source

The CLI flags live in [cmd/server](../cmd/server/main.go), the login flows in
[sdk/auth](../sdk/auth), and executor registration in
[service_executors.go](../sdk/cliproxy/service_executors.go). The
[HTTP routes](../internal/api/server_routes.go),
[quota adapters](../web/src/features/quota/providers/index.ts),
[pool model](../web/src/features/quota/poolModel.ts) and
[reset selector](../sdk/cliproxy/auth/selector_reset.go) define the capability table above.
