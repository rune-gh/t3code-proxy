package quotahistory

import (
	"testing"
	"time"
)

const claudeUsageFixture = `{
  "five_hour": {"utilization": 12.5, "resets_at": "2025-11-14T18:00:00.123456+00:00"},
  "seven_day": {"utilization": 40, "resets_at": "2025-11-18T05:00:00Z"},
  "seven_day_oauth_apps": null,
  "seven_day_opus": {"utilization": "7", "resets_at": null},
  "seven_day_sonnet": {"utilization": 3, "resets_at": null},
  "iguana_necktie": {"utilization": 99, "resets_at": null, "limit_dollars": 50, "used_dollars": 10},
  "limits": [
    {"kind": "weekly", "percent": 40},
    {"kind": "weekly_scoped", "percent": 20, "is_active": false, "scope": {"model": {"display_name": "Fable"}}, "resets_at": "2025-11-17T00:00:00Z"},
    {"kind": "Weekly_Scoped", "percent": 55, "is_active": true, "scope": {"model": {"display_name": "Fable 5"}}, "resets_at": "2025-11-18T05:00:00Z"},
    {"kind": "weekly_scoped", "percent": 90, "is_active": true, "scope": {"model": {"display_name": "Opus"}}}
  ]
}`

func ms(t *testing.T, iso string) int64 {
	t.Helper()
	parsed, errParse := time.Parse(time.RFC3339Nano, iso)
	if errParse != nil {
		t.Fatalf("parse %q: %v", iso, errParse)
	}
	return parsed.UnixMilli()
}

func assertWindow(t *testing.T, windows map[string]Window, id string, used float64, reset *int64, period float64) {
	t.Helper()
	w, ok := windows[id]
	if !ok {
		t.Fatalf("window %s missing in %+v", id, windows)
	}
	if w.UsedPercent != used || w.PeriodHours != period {
		t.Fatalf("window %s = %+v, want used %v period %v", id, w, used, period)
	}
	switch {
	case reset == nil && w.ResetsAt != nil:
		t.Fatalf("window %s resets_at = %d, want nil", id, *w.ResetsAt)
	case reset != nil && (w.ResetsAt == nil || *w.ResetsAt != *reset):
		t.Fatalf("window %s resets_at = %v, want %d", id, w.ResetsAt, *reset)
	}
}

func ptr(v int64) *int64 { return &v }

func TestParseClaudeUsage(t *testing.T) {
	windows, errParse := ParseClaudeUsage([]byte(claudeUsageFixture))
	if errParse != nil {
		t.Fatal(errParse)
	}
	assertWindow(t, windows, WindowFiveHour, 12.5, ptr(ms(t, "2025-11-14T18:00:00.123456+00:00")), 5)
	assertWindow(t, windows, WindowSevenDay, 40, ptr(ms(t, "2025-11-18T05:00:00Z")), 168)
	assertWindow(t, windows, WindowSevenDayOpus, 7, nil, 168)
	// The active Fable limit wins over the inactive one and over the dollar pool.
	assertWindow(t, windows, WindowSevenDayFable, 55, ptr(ms(t, "2025-11-18T05:00:00Z")), 168)
	if len(windows) != 4 {
		t.Fatalf("unexpected windows: %+v", windows)
	}
}

func TestParseClaudeUsageFableFallbacks(t *testing.T) {
	// Without limits[], a non-dollar iguana_necktie is the Fable weekly window.
	windows, errParse := ParseClaudeUsage([]byte(`{"five_hour":{"utilization":1},"iguana_necktie":{"utilization":33,"resets_at":"2025-11-18T05:00:00Z"}}`))
	if errParse != nil {
		t.Fatal(errParse)
	}
	assertWindow(t, windows, WindowSevenDayFable, 33, ptr(ms(t, "2025-11-18T05:00:00Z")), 168)

	// A dollar pool is not the Fable cap, and no Fable data means no window.
	windows, errParse = ParseClaudeUsage([]byte(`{"seven_day":{"utilization":5},"iguana_necktie":{"utilization":33,"remaining_dollars":"4"}}`))
	if errParse != nil {
		t.Fatal(errParse)
	}
	if _, ok := windows[WindowSevenDayFable]; ok {
		t.Fatalf("dollar pool must not map to fable: %+v", windows)
	}

	if _, errParse = ParseClaudeUsage([]byte(`not json`)); errParse == nil {
		t.Fatal("expected error for invalid payload")
	}
}

func TestParseClaudePlan(t *testing.T) {
	cases := map[string]string{
		`{"organization":{"rate_limit_tier":"default_claude_max_20x"},"account":{"has_claude_max":true}}`: "max_20x",
		`{"organization":{"rate_limit_tier":"default_claude_max_5x"}}`:                                    "max_5x",
		`{"organization":{"organization_type":"claude_team","subscription_status":"active"}}`:             "team",
		`{"organization":{"rate_limit_tier":"default_claude_ai"},"account":{"has_claude_max":true}}`:      "max",
		`{"account":{"has_claude_max":false,"has_claude_pro":"true"}}`:                                    "pro",
		`{"account":{"has_claude_max":false,"has_claude_pro":false}}`:                                     "free",
		`{"account":{}}`: "",
		`garbage`:        "",
	}
	for body, want := range cases {
		if got := ParseClaudePlan([]byte(body)); got != want {
			t.Errorf("ParseClaudePlan(%s) = %q, want %q", body, got, want)
		}
	}
}

func TestParseCodexUsageMapsByWindowLength(t *testing.T) {
	now := time.UnixMilli(1731600000000)
	// Secondary is the 5h window here: mapping must follow the length, not the slot.
	body := `{
	  "plan_type": "Pro",
	  "rate_limit": {
	    "allowed": true,
	    "limit_reached": false,
	    "primary_window": {"used_percent": 61, "limit_window_seconds": 604800, "reset_at": 1731900000},
	    "secondary_window": {"used_percent": 7.5, "limit_window_seconds": 18000, "reset_after_seconds": 3600}
	  }
	}`
	windows, plan, errParse := ParseCodexUsage([]byte(body), now)
	if errParse != nil {
		t.Fatal(errParse)
	}
	if plan != "pro" {
		t.Fatalf("plan = %q", plan)
	}
	assertWindow(t, windows, WindowSevenDay, 61, ptr(1731900000000), 168)
	assertWindow(t, windows, WindowFiveHour, 7.5, ptr(now.Add(time.Hour).UnixMilli()), 5)
	if len(windows) != 2 {
		t.Fatalf("unexpected windows: %+v", windows)
	}
}

func TestParseCodexUsageFallbacks(t *testing.T) {
	now := time.UnixMilli(1731600000000)
	// Legacy payload without window lengths falls back to primary/secondary order;
	// a reached limit without used_percent reads as 100%.
	body := `{"planType":"plus","rateLimit":{"limitReached":true,
	  "primaryWindow":{"resetAt":1731610000000},
	  "secondaryWindow":{"usedPercent":"80"}}}`
	windows, plan, errParse := ParseCodexUsage([]byte(body), now)
	if errParse != nil {
		t.Fatal(errParse)
	}
	if plan != "plus" {
		t.Fatalf("plan = %q", plan)
	}
	assertWindow(t, windows, WindowFiveHour, 100, ptr(1731610000000), 5)
	assertWindow(t, windows, WindowSevenDay, 80, nil, 168)

	// Unknown window lengths (e.g. a monthly team window) are skipped.
	windows, _, errParse = ParseCodexUsage([]byte(`{"rate_limit":{"primary_window":{"used_percent":5,"limit_window_seconds":2592000}}}`), now)
	if errParse != nil {
		t.Fatal(errParse)
	}
	if len(windows) != 0 {
		t.Fatalf("unexpected windows: %+v", windows)
	}
}
