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

1. Takes the accounts in the highest available priority tier. The per-account `weight` is
   ignored; [plan weights](#plan-capacity) are used instead.
2. Reads each account's most recent weekly reset time. Claude accounts report it in the
   `Anthropic-Ratelimit-Unified-7d-Reset` response header; Codex accounts report a 7-day window in
   their rate-limit headers. A reading stays valid until its reset time passes.
3. Sends the request to the account whose weekly window resets first. Ties are spread in
   proportion to plan weight.

Two cases change that order:

- **Accounts without a reading.** An account the hub has not observed yet, or whose last reading
  is older than one hour and no longer has a future reset, is tried first. This collects a fresh
  reading after a restart or a reset. When several accounts need a reading, they are spread by
  plan weight too. Providers whose limits the hub only learns from the
  [quota history](quota-history.md) recorder, such as xAI, Antigravity, Kimi and Meta, are ranked
  once every available account of that provider has a reading. Until then, or with the recorder
  off, that provider's accounts rotate by plan weight when the pool holds only that provider, so
  one account whose reading failed is not starved by the others. In a pool shared with a provider
  that is ranked, the ranked provider's accounts come first and the unread provider's accounts
  serve as fallback until every one of them has a reading. This lasts as long as the reading keeps failing: fix or disable that
  account to get ranking back. The Overview page shows which account has no reading.
- **Spent windows.** An account is skipped, while another eligible account exists, when any window
  that governs the requested model is spent, not only the longest one: a spent 5-hour or weekly
  window makes the account unusable whatever its monthly window says. The longest window still
  gives the reset used for ranking. If Claude's or Codex's response headers are newer than the
  recorder's reading and show the window with allowance left, as after an early reset, the headers
  win. Resetting an account's quota state from the panel also clears its recorded readings.
- **Spent accounts while another is on hold.** When every account that could take a request is
  known to be spent, and an account with allowance left is only held back for a while (a quota
  cooldown, or the short hold after an upstream error such as "overloaded"), the hub answers
  with its own cooldown error and a `Retry-After` for when that account is back. It does not send
  the request to a spent account, whose refusal would tell the client to wait for that account's
  reset, often days away. When every account really is spent the request still goes to the one
  that resets first, so the client gets the provider's own answer.
- **Nearly spent 5-hour window.** An account whose 5-hour window has almost no headroom left is
  skipped for new conversations while another account has more. See
  [5-hour headroom](#5-hour-headroom).
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

### Plan capacity

Accounts in one pool are not equal. A Claude Max 20x account has about twenty times the
allowance of a Pro account, so it should take about twenty times as many conversations. The hub
gives each account a plan weight: its capacity relative to the provider's base paid plan, which
weighs `1`.

The plan comes from what the hub already knows about the account, newest first:

- the plan read by the [quota history](quota-history.md) recorder (Claude's OAuth profile, the
  `plan_type` in Codex's usage reply),
- the `X-Codex-Plan-Type` response header,
- the fields stored with the credential: Codex `plan_type` from the ID token, or a Claude
  `subscription_type` / `rate_limit_tier`.

Built-in weights:

| Provider | Plan | Weight |
| --- | --- | --- |
| Claude | `pro`, `team` | 1 |
| Claude | `max_5x`, or `max` with an unknown tier | 5 |
| Claude | `max_20x` | 20 |
| Claude | any `max_<N>x` tier, such as `default_claude_max_40x` | N |
| Codex | `plus`, `team`, `business`, `enterprise`, `edu` | 1 |
| Codex | `prolite` (the $100 Pro tier) | 5 (approximate) |
| Codex | `pro` (the $200 Pro tier) | 20 (approximate) |
| Codex | `promax` (the $500 tier) | 50 (approximate) |
| Codex | `free`, `go` and other names not listed | 1 (not known; set your own) |
| xAI | `supergrok` | 1 |
| xAI | `supergrok_heavy` | 10 |
| any | unknown plan or provider | 1 |

The Codex ratios are approximate. OpenAI describes its tiers as multiples of Plus usage (5x for
the $100 tier, 20x for the $200 tier) and changes them over time; `promax` is set to 2.5 times
`pro`. SuperGrok Heavy carries ten times the monthly credit of SuperGrok. A plan
name that is not in the table weighs 1, including tiers these defaults do not know yet. The
panel's Overview page shows each account's plan name and its capacity in the pool (the heaviest
plan in the pool is 100%; hover the figure for the weight), so check it after adding an account
and add a weight for any plan that reads as large as your base plan but should not. Write plan names lower case
with underscores (`max_20x`, not `Max 20x`). Both spellings are read, but the panel can only
change or clear an override written in that form. Override any weight with
`routing.plan-weights`:

```yaml
routing:
  plan-weights:
    codex:
      pro: 10
    claude:
      max_20x: 18
```

Provider and plan names are case-insensitive, and spaces and hyphens count as underscores
(`Max 20x` is `max_20x`). A weight must be greater than 0 and at most 1000. Listed entries replace
the built-in value; other plans keep theirs. Changes apply on config reload.
`GET /v8/management/routing/plan-weights` returns the built-in, configured and effective tables.

Where soonest-reset-first has several equal choices (tied resets, accounts that need a reading,
providers that report no quota), it spreads new conversations with smooth weighted round-robin:
with a Pro and a Max 20x account tied, 1 of every 21 new conversations goes to the Pro account,
and the picks are interleaved rather than batched. With equal weights this is plain round-robin.
The proportion holds while the same accounts stay tied; when the set changes (a cooldown, a spent
window), the rotation starts over from the heaviest account.
Ranking still comes first: an account whose weekly window resets sooner takes every new
conversation regardless of weight.

### 5-hour headroom

Claude and Codex accounts also have a 5-hour window. A conversation started on an account whose
5-hour window is nearly spent runs into that limit within a few turns. The hub therefore does
not start a new conversation on such an account while another eligible account has headroom.

Headroom is plan weight times the percent of the 5-hour window left. 10% left on a Pro account is
10; 10% left on a Max 20x account is 200. An account is tight when its headroom is below
`routing.plan-headroom-reserve`:

```yaml
routing:
  plan-headroom-reserve: 10 # default; 0 disables the guard
```

With the default of 10, a Pro account is tight below 10% left, a Max 5x account below 2%, and a
Max 20x account below 0.5%. The value must be between 0 and 1000.

The guard uses only readings the hub already has: Claude's
`Anthropic-Ratelimit-Unified-5h-*` and Codex's 300-minute window in its rate-limit response
headers, and the 5-hour readings the quota history recorder takes. It makes no extra upstream
call. A reading whose window has since reset no longer counts. If every account is tight, the
guard does nothing and the normal order applies. Conversations already bound by session affinity
are not moved by it.

The web panel's Overview page marks the account expected to receive the next new conversation as
**Next**. It is an estimate that follows the same order and the default headroom reserve. The Routing page sets the strategy, session affinity, priority tiers and weights, and
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

When the hub already knows that a window governing the requested model is spent on the bound
account, and another eligible account exists, it rebinds the conversation before sending instead
of first collecting a 429. That covers Claude's model-scoped weekly caps (such as the Fable weekly
window) and any spent window the recorder has read for the account, on every provider. With
`session-affinity-rebind-on: never` the binding is kept.

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
