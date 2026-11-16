# Quota history

The quota-history recorder polls supported accounts' usage on a schedule and stores
the readings on the hub. With it enabled, the web panel's Overview page charts remaining quota
over time and projects when the pool runs out, and soonest-reset-first routing sees spent
renewing caps before it sends a request.

## On the Overview page

The Overview has two views, switched next to the provider tabs; both follow the provider tab and
share the same 14-day span.

**Pools.** Every provider whose accounts report a quota window that renews gets the same pool
card: a chart of the pooled remaining quota with its projection, the time the pool and the first
account run dry, the next reset, the burn rate, and a row per account. A provider the recorder
samples is charted from its history; any other provider (the recorder is off, or it has not
sampled the provider yet) is charted from each account's latest live read, which the Refresh
button or the card's **Read quota now** takes. Selecting an account's name opens its full read
beneath the row: every window with its reset time, the plan details, Claude extra usage, Codex
banked resets and credit overage, xAI usage breakdown and pay-as-you-go state, Antigravity groups
and their models, the last read's error, and the account's actions (read again, Claude reset
grants, Codex reset quota). A provider whose accounts report no renewing window at all, such as
an API key or an account whose read failed, is listed in the same kind of table below the pools.
Account emails are shown; **Hide emails** blurs them and the choice is remembered in the browser.

**Resets.** A calendar of every account window: one lane per window, grouped by provider and
ordered the way soonest-reset-first routes (soonest reset of an account's longest window first).
Each bar runs from when a window opened to when it resets; the current one is solid with its
remaining share, upcoming ones are dashed, and elapsed ones are muted and show how much was left
unspent when they reset. 5-hour windows start on first use, so only the current one is drawn.
Monthly windows (the xAI billing month, Mistral budgets) turn over on the calendar month. Banked
Codex resets are marked at their expiry, with **Use reset** beside the account. Above the
calendar, **Next resets** lists the soonest daily-or-longer resets with the allowance still
unspent on each: whatever is left when a window resets is lost. A window filter (5-hour, Weekly,
Monthly) narrows both.

Providers the hub reads with an API key rather than a credential file, such as a Mistral EDU key
with monthly budgets, exist only in the history; they get a tab, a pool and calendar lanes all the
same, and a window with a budget reads in money beside percent ("$0.39 of $15 spent").

Pooled figures are in percent of the heaviest plan in the pool. That plan's account counts as
100% and a lighter plan by its [plan weight](routing.md#plan-capacity): a Max 5x and a Pro
account pool to 120% (Max 5x = 100%, Pro = 20%), so 38% left on the Max 5x and none on the Pro
reads as "38% of 120%". A pool whose accounts all weigh the same reads as N × 100%. The chart
axis, reset steps, burn rate and the accounts' Capacity column use the same unit. Plan weights
are edited from the sliders button on each pool card.

## Turn it on

```yaml
quota-history:
  enabled: true
  interval: 10m
  retention: 35d
  path: ""
  providers: []
```

| Key | Meaning | Default |
| --- | --- | --- |
| `enabled` | Run the recorder. When `false`, nothing is polled or written. | `false` |
| `interval` | Time between polls of each account. Go duration or `<n>d`. Minimum `5m`. | `10m` |
| `retention` | Samples older than this are deleted, checked hourly. Minimum `1d`. | `35d` |
| `providers` | Provider IDs to poll, for example `[claude, codex, kimi, mistral]`. An omitted or empty list enables every supported provider, including registered quota plugins. | `[]` |
| `path` | Database file. Relative paths resolve against the config file's directory. | `quota-history.db` next to the config file |

The installer's config enables it. Changes apply on config reload without a restart. The database
must not be inside the auth directory; the recorder refuses such a path.

## What it reads

Enabling quota history means the hub polls each selected provider's usage endpoint on the
configured interval. Disabled accounts are included in the account list and skipped during polling.
One account's reading is given at most 45 seconds; an account that does not answer in time is
recorded as an error for that round and the next account is read. A reading never refreshes an
OAuth token itself: an xAI or Antigravity account whose token is due for refresh is recorded as
`token refresh due` for that round and read again after the hub's own refresh has renewed it.

When a provider leaves `providers`, or the recorder is turned off, the readings it took for those
accounts are dropped from routing straight away.
Each request uses the account's credentials and configured proxy through the existing management
transport. Registered quota plugins use the host's per-account quota capability and HTTP client.

| Provider | Usage endpoint | Window keys |
| --- | --- | --- |
| Claude | `GET https://api.anthropic.com/api/oauth/usage` | `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_fable` |
| Codex | `GET https://chatgpt.com/backend-api/wham/usage` | `five_hour`, `seven_day` |
| xAI/Grok (`xai`) | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` and `GET https://cli-chat-proxy.grok.com/v1/billing` | `weekly`, `monthly` |
| Antigravity (`antigravity`) | `POST /v1internal:retrieveUserQuotaSummary` on the three hosts below, with `{"project":"<account project ID>"}` | `group_<group>_<bucket>`, such as `group_gemini_models_gemini_weekly` |
| Kimi (`kimi`, `kimi-ai`) | `GET https://api.kimi.com/coding/v1/usages` or `https://api.kimi.ai/coding/v1/usages`, following the credential's domain | `summary`, `monthly`, `limit_<name>` or `limit_<hours>h` |
| Meta/Muse (`meta`) | `POST https://api.meta.ai/muse-code/key` with `{}` and the account's DCA token | `window`, `weekly` |
| Devin (`devin`) | `POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus` with the panel's Connect JSON metadata | `daily`, `weekly` |
| Mistral (`mistral`) | `GET https://api.mistral.ai/v1/billing/budget` with the upstream API key | `api_monthly`, `vibe_monthly` |
| Registered quota plugins | The existing plugin host `FetchQuota` capability selects the upstream endpoint | `group_<group>_<window>` |

Antigravity tries `daily-cloudcode-pa.googleapis.com`,
`daily-cloudcode-pa.sandbox.googleapis.com`, then `cloudcode-pa.googleapis.com`. It preserves
partial pools across responses and stops when Gemini quota is available, following the panel.
The account must have a project ID. Claude also reads its OAuth profile at most every six hours
for the cached plan label.

Mistral API-key upstreams are recognized by the `api.mistral.ai` base URL host. The configured
upstream name labels the history account. `GET /v1/billing/subscription` supplies `plan_name`,
cached for six hours. The `api_monthly` window is labeled "API usage" and `vibe_monthly` is
labeled "Vibe Code". Each records `usage_percentage` as `used_percent`, `reset_at` as `resets_at`,
and the current UTC calendar month's length as `period_hours` (672, 696, 720 or 744 hours).
Resets occur on the first day of each month, UTC. Percentages above 100 are preserved so spending
can be calculated accurately. Missing budget objects are skipped, and a response with neither
budget records an empty-payload error. A missing reset is stored as `null`.

Each sample stores used percentage, reset time and period in hours. Existing Claude/Codex
window keys and the history response shape are preserved. Group and bucket names are normalized
to lowercase with underscore separators. A missing bucket ID uses its window name, then its
array index. Kimi limit keys use the name/title/scope when available, then the explicit period,
then the array index. Duplicate keys gain an index suffix. These index fallbacks follow the
provider's response order. Unknown usage percentages produce no window, and an unknown period
is stored as `0` with an absent reset stored as `null`.

Soonest-reset-first routing uses the longest renewing window governing the requested model.
Model-scoped windows take precedence over account-wide windows of equal length. Accounts whose
governing window is spent are skipped while another eligible account exists. If all accounts
are spent, the earliest reset wins. Claude's existing scoped weekly observations remain supported.
Antigravity bucket IDs identify Gemini, Claude and GPT pools, including model-specific prefixes.
Unidentified Antigravity pools remain in history and contribute no routing rank. Plugin groups
with recognized model pools use those scopes. Other plugin groups apply account-wide because
the current plugin quota contract supplies no model-scope field. Renewing plugin windows need
a known period (`5h`, `weekly`, `daily`, or a duration such as `24h` or `7d`).

A usable reading requires a known used percentage, positive period and future reset. Providers
without such a reading retain their existing routing behavior. xAI paid-account health checks
supply no quota window, so the recorder uses billing data and leaves accounts without it
unranked. Billing periods need both start and end times to establish their duration. Kimi's
weekly summary and monthly summary use the same 7-day and 30-day periods as the panel.
Providers without a built-in usage call or registered quota capability, including standalone
Gemini CLI and declarative plugin probes, are skipped. Passive response-header parsing remains
limited to the existing supported headers.

A failed poll is stored as a sample with an `error` message, so gaps in the chart have a reason.

Mistral's API and Vibe Code allowances cover separate request types. The recorder keeps both as
usage-only windows with account weight 1. Routing continues to use ordinary account selection
and upstream failure handling for these accounts.

## API

Both endpoints need the management secret (`Authorization: Bearer <management secret>`). They are
served under `/v8/management` and mirrored under `/v0/management`.

### Read history

```sh
curl -s "https://<hub>.<tailnet>.ts.net:8317/v8/management/quota-history?since=<unix ms>&until=<unix ms>" \
  -H "Authorization: Bearer <management secret>"
```

`since` and `until` are Unix times in milliseconds. `until` defaults to now and `since` to 14 days
before `until`. The response:

```json
{
  "enabled": true,
  "interval_seconds": 600,
  "now": 1763164800000,
  "accounts": [
    { "auth_index": "<id>", "provider": "claude", "label": "<label>", "plan": "max", "disabled": false }
  ],
  "samples": [
    {
      "t": 1763164200000,
      "auth_index": "<id>",
      "windows": {
        "five_hour": { "used_percent": 42, "resets_at": 1763172000000, "period_hours": 5 },
        "seven_day": { "used_percent": 61, "resets_at": 1763510400000, "period_hours": 168 }
      },
      "error": ""
    }
  ]
}
```

Windows can also include `label`, `budget` and `currency`. `budget` is the monetary allowance
from `initial_budget`, such as `15`, and `currency` is its currency code, such as `"USD"`.
Empty values are omitted. Spending is `budget * used_percent / 100`. A Mistral API window
can therefore be returned as follows.

```json
{
  "used_percent": 2.59892596,
  "resets_at": 1796083200000,
  "period_hours": 720,
  "label": "API usage",
  "budget": 15,
  "currency": "USD"
}
```

When the recorder is off the response is `200` with `"enabled": false` and empty arrays. A bad
`since` or `until` returns `400`.

### Poll now

```sh
curl -s -X POST "https://<hub>.<tailnet>.ts.net:8317/v8/management/quota-history/refresh" \
  -H "Authorization: Bearer <management secret>"
```

This polls every account right away and returns `{"samples": <n>, "done": <bool>}` when the poll
finishes, or after 60 seconds with `"done": false` while the poll continues. It returns `409` when
the recorder is disabled. The Overview page's refresh button calls it.
