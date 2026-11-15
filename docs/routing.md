# Routing

This page explains how the hub picks an account for each request, so you can choose a strategy,
confirm that session affinity works, and take an account out of rotation.

Routing happens per provider. A Claude request picks among the Claude accounts, a Codex request
among the Codex accounts. Accounts that are disabled, cooling down after an error, or that do not
serve the requested model are left out before any strategy runs.

## Strategies

Set the strategy in `config.yaml`:

```yaml
routing:
  strategy: "soonest-reset-first"
```

| Strategy | Behavior |
| --- | --- |
| `round-robin` | Rotates through the accounts in turn. This is the default when the key is unset. |
| `weighted-round-robin` | Rotates in proportion to each account's `weight`. |
| `fill-first` | Uses the first account until it is unavailable, then the next one. |
| `soonest-reset-first` | Sends new conversations to the account whose weekly limit resets first. The hub config from the installer uses this. |

All strategies respect `priority`. Each account file can carry a top-level integer `"priority"`;
only the accounts in the highest available priority tier are considered, and lower tiers are used
when every account above them is unavailable. The default priority is `0`.

`weight` is a top-level integer in the account file (default `1`). Only `weighted-round-robin`
reads it.

## Soonest-reset-first

Weekly allowance that is left when a reset arrives is lost. Soonest-reset-first spends the
allowance that expires first, so less of it goes unused.

For each new conversation the hub:

1. Takes the accounts in the highest available priority tier. Weights are ignored.
2. Reads each account's most recent weekly reset time. Claude accounts report it in the
   `Anthropic-Ratelimit-Unified-7d-Reset` response header; Codex accounts report a 7-day window in
   their rate-limit headers. A reading stays valid until its reset time passes.
3. Sends the request to the account whose weekly window resets first. Ties rotate round-robin.

Two cases change that order:

- **Accounts without a reading.** An account the hub has not observed yet, or whose last reading
  is older than one hour and no longer has a future reset, is tried first. This collects a fresh
  reading after a restart or a reset. Providers that never report a weekly window, such as xAI and
  Antigravity, are not ranked; a pool of only those accounts rotates round-robin.
- **Model-scoped weekly caps.** Claude has weekly caps that apply to one model family, such as the
  Fable and Opus weekly windows, next to the overall weekly window. When the requested model
  belongs to such a family, the hub skips accounts whose cap for that family is spent, as long as
  another account is left. For the remaining accounts it ranks by the reset of that scoped cap
  instead of the overall weekly reset. If every account has spent the cap, the one whose cap
  resets first is chosen. The family is matched against the words of the model ID, so a window
  named `7d_opus` governs any model whose ID contains `opus`.

The hub learns about scoped caps from Claude's response headers and, when
[quota history](quota-history.md) is enabled, from the usage readings the recorder takes. With the
recorder on, the hub can see a spent cap before it sends a request to that account.

For Codex, accounts that support the WebSocket transport are preferred when the request arrives
over a WebSocket.

The web panel's Overview page marks the account that receives the next new conversation as
**Next**. The Routing page sets the strategy, session affinity, priority tiers and weights, and
shows the current reset order.

## Session affinity

Prompt caches belong to one account. If a conversation moves to another account, the provider
writes the cache again at full cost. Session affinity keeps each conversation on the account it
started on.

```yaml
routing:
  session-affinity: true
  session-affinity-ttl: "1h"
```

The strategy decides only where a new conversation starts. Once a conversation is bound, the hub
keeps it on that account until the binding expires (`session-affinity-ttl` after its last use) or
the account fails. On failure it moves the conversation and binds it to the new account.

The hub identifies a conversation from the session headers that Claude Code and Codex send, and
falls back to other request fields when those are missing. Subagents inherit their parent's
account by default (`session-affinity-subagents: true`). `session-affinity-rebind-on` controls
which failures move a bound conversation: `any` (default), `quota` (only quota and auth errors
move it; transient errors fail over for one request), or `never`. The comments in
[`config.example.yaml`](../config.example.yaml) describe every option.

### Check that affinity works

Watch the cache numbers your client reports for each turn of a long conversation. Claude reports
`cache_read_input_tokens` and `cache_creation_input_tokens`; Codex reports cached input tokens.

- **Working:** after the first turn, most input is cache reads and cache writes stay small.
- **Broken:** cache writes stay large on every turn, as if each turn started a new conversation.
  That usually means the conversation moves between accounts. Check that
  `routing.session-affinity` is `true` and that the hub was restarted or reloaded after the change.

## Retries

When a request fails on one account, the hub tries another.

```yaml
routing:
  retry:
    request-retry: 3
    max-retry-interval: 30
```

`request-retry` is the number of extra rounds after the first round has tried every eligible
account. Extra rounds apply to HTTP 403, 408, 429, 500, 502, 503 and 504 responses.
`max-retry-interval` is the longest wait, in seconds, for an account to come out of cooldown
between rounds. `max-retry-credentials` caps how many accounts each round tries (`0` means all).

A pool with one account has nowhere to go when that account hits a limit. Add a second account
for each provider you rely on.

## Take an account out of rotation

To bench an account, set `"disabled": true` in its JSON file in the auth directory
(`~/.t3code-proxy` by default):

```json
{
  "type": "claude",
  "email": "<account email>",
  "disabled": true
}
```

Change only the `disabled` field and leave the rest of the file as it is. The hub watches the
directory and drops the account from rotation without a restart. Set it back to `false`, or
remove the field, to return the account. The Accounts page in the web panel can enable and
disable accounts too.
