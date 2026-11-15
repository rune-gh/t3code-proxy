# Quota history

The quota-history recorder polls each Claude and Codex account's usage on a schedule and stores
the readings on the hub. With it enabled, the web panel's Overview page charts remaining quota
over time and projects when the pool runs out, and soonest-reset-first routing sees spent
model-scoped caps before it sends a request.

## Turn it on

```yaml
quota-history:
  enabled: true
  interval: 10m
  retention: 35d
  path: ""
```

| Key | Meaning | Default |
| --- | --- | --- |
| `enabled` | Run the recorder. When `false`, nothing is polled or written. | `false` |
| `interval` | Time between polls of each account. Go duration or `<n>d`. Minimum `5m`. | `10m` |
| `retention` | Samples older than this are deleted, checked hourly. Minimum `1d`. | `35d` |
| `path` | Database file. Relative paths resolve against the config file's directory. | `quota-history.db` next to the config file |

The installer's config enables it. Changes apply on config reload without a restart. The database
must not be inside the auth directory; the recorder refuses such a path.

## What it reads

For each enabled Claude and Codex OAuth account, the recorder calls the provider's usage endpoint
with that account's token:

- Claude: `https://api.anthropic.com/api/oauth/usage`
- Codex: `https://chatgpt.com/backend-api/wham/usage`

Each sample stores the used percentage, reset time and length of every window the provider
reports. Window IDs:

| Window | Providers |
| --- | --- |
| `five_hour` | Claude, Codex |
| `seven_day` | Claude, Codex |
| `seven_day_opus` | Claude |
| `seven_day_fable` | Claude |

A failed poll is stored as a sample with an `error` message, so gaps in the chart have a reason.

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
