package quotahistory

import (
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func quotaFixture(t *testing.T, provider string) []byte {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", provider+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestProviderUsageFixtures(t *testing.T) {
	now := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	reset := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC).UnixMilli()
	type expected struct {
		used, hours float64
		reset       int64
		scope       []string
	}
	cases := []struct {
		provider string
		parse    func([]byte) (map[string]Window, error)
		want     map[string]expected
	}{
		{"xai", parseXAIUsage, map[string]expected{
			"weekly":  {used: 25, hours: 168, reset: reset},
			"monthly": {used: 45, hours: 720, reset: now.AddDate(0, 0, 16).UnixMilli()},
		}},
		{"meta", parseMetaUsage, map[string]expected{
			"window": {used: 2, hours: 5, reset: 1794726000000},
			"weekly": {used: 65, hours: 168, reset: reset},
		}},
		{"devin", parseDevinUsage, map[string]expected{
			"daily":  {used: 46, hours: 24, reset: now.AddDate(0, 0, 1).UnixMilli()},
			"weekly": {used: 23, hours: 168, reset: reset},
		}},
		{"kimi", func(body []byte) (map[string]Window, error) { return parseKimiUsage(body, now) }, map[string]expected{
			"limit_session": {used: 60, hours: 5, reset: now.Add(time.Hour).UnixMilli()},
			"limit_daily":   {used: 20, hours: 24, reset: now.AddDate(0, 0, 1).UnixMilli()},
			"limit_168h":    {used: 10, hours: 168, reset: reset},
			"summary":       {used: 50, hours: 168, reset: reset},
			"monthly":       {used: 75, hours: 720, reset: now.AddDate(0, 0, 16).UnixMilli()},
		}},
		{"antigravity", func(body []byte) (map[string]Window, error) { return parseQuotaGroups(body, true) }, map[string]expected{
			"group_gemini_models_gemini_weekly": {used: 75, hours: 168, reset: reset + 123, scope: []string{"gemini-*"}},
			"group_gemini_models_gemini_5h":     {used: 30, hours: 5, reset: now.Add(4 * time.Hour).UnixMilli(), scope: []string{"gemini-*"}},
			"group_claude_models_claude_weekly": {used: 100, hours: 168, reset: now.AddDate(0, 0, 4).UnixMilli(), scope: []string{"claude-*"}},
			"group_unknown_pool_opaque":         {used: 0, hours: 0, scope: []string{""}},
		}},
		{"plugin", func(body []byte) (map[string]Window, error) { return parseQuotaGroups(body, false) }, map[string]expected{
			"group_account_weekly": {used: 75, hours: 168, reset: reset},
			"group_account_5h":     {used: 50, hours: 5, reset: now.Add(4 * time.Hour).UnixMilli()},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			windows, err := tc.parse(quotaFixture(t, tc.provider))
			if err != nil {
				t.Fatal(err)
			}
			if len(windows) != len(tc.want) {
				t.Fatalf("windows = %+v, want %d windows", windows, len(tc.want))
			}
			for key, want := range tc.want {
				got, ok := windows[key]
				if !ok || math.Abs(got.UsedPercent-want.used) > 1e-9 || got.PeriodHours != want.hours || !reflect.DeepEqual(got.modelScope, want.scope) {
					t.Errorf("window %s = %+v, want %+v", key, got, want)
				}
				if want.reset == 0 {
					if got.ResetsAt != nil {
						t.Errorf("window %s reset = %d, want unknown", key, *got.ResetsAt)
					}
				} else if got.ResetsAt == nil || *got.ResetsAt != want.reset {
					t.Errorf("window %s reset = %v, want %d", key, got.ResetsAt, want.reset)
				}
			}
			for _, invalid := range []string{"null", "[]", "not json", `{"groups": [`} {
				if _, err := tc.parse([]byte(invalid)); err == nil {
					t.Errorf("accepted invalid payload %s", invalid)
				}
			}
		})
	}
}

func TestProviderUnknownUsageIsNotZero(t *testing.T) {
	for _, parse := range []func([]byte) (map[string]Window, error){parseMetaUsage, parseXAIUsage, parseDevinUsage, func(body []byte) (map[string]Window, error) { return parseKimiUsage(body, time.Unix(0, 0)) }} {
		windows, _ := parse([]byte(`{"config":{"currentPeriod":{"type":"weekly"}},"subs_usage":{"window":{"used_percent":"NaN"},"weekly":{"used_percent":null}},"usage":{"limit":100},"userStatus":{"planStatus":{"weeklyQuotaRemainingPercent":null}}}`))
		if len(windows) != 0 {
			t.Fatalf("unknown usage produced windows %+v", windows)
		}
	}
}
