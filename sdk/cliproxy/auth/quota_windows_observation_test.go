package auth

import (
	"context"
	"math"
	"testing"
	"time"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

func TestQuotaWindowsSnapshot(t *testing.T) {
	id := t.Name()
	t.Cleanup(func() { ForgetQuotaWindows(id) })
	now := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	windows := []QuotaWindow{{Key: "weekly", UsedPercent: 42, ResetAt: now.Add(time.Hour), Period: 168 * time.Hour, ModelScope: []string{"gemini-*"}}}
	ObserveQuotaWindows(id, now, windows)
	windows[0].ModelScope[0] = "claude-*"
	windows[0].UsedPercent = 100
	ObserveQuotaWindows(id, now.Add(-time.Second), nil)
	observed, got := ObservedQuotaWindows(id)
	if !observed.Equal(now) || len(got) != 1 || got[0].UsedPercent != 42 || got[0].ModelScope[0] != "gemini-*" {
		t.Fatalf("snapshot = %v %+v", observed, got)
	}
	got[0].ModelScope[0] = "gpt-*"
	_, got = ObservedQuotaWindows(id)
	if got[0].ModelScope[0] != "gemini-*" {
		t.Fatal("reader mutated stored scope")
	}
	ObserveQuotaWindows(id, now.Add(time.Second), []QuotaWindow{{Key: "invalid", Period: time.Hour, ResetAt: now, UsedPercent: math.NaN()}})
	observed, got = ObservedQuotaWindows(id)
	if !observed.Equal(now.Add(time.Second)) || len(got) != 0 {
		t.Fatal("invalid windows were retained")
	}
	ForgetQuotaWindows(id)
	observed, got = ObservedQuotaWindows(id)
	if !observed.IsZero() || len(got) != 0 {
		t.Fatal("forgotten windows were retained")
	}
}

func TestSoonestResetFirstUsageWindows(t *testing.T) {
	now := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	for _, provider := range []string{"xai", "kimi", "meta", "devin", "antigravity", "fixture-plugin"} {
		t.Run(provider, func(t *testing.T) {
			a := &Auth{ID: t.Name() + "-a", Provider: provider}
			b := &Auth{ID: t.Name() + "-b", Provider: provider}
			t.Cleanup(func() { ForgetQuotaWindows(a.ID); ForgetQuotaWindows(b.ID) })
			selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
			publish := func(auth *Auth, used float64, reset time.Duration) {
				ObserveQuotaWindows(auth.ID, now, []QuotaWindow{
					{Key: "weekly", UsedPercent: used, ResetAt: now.Add(reset), Period: 168 * time.Hour},
					{Key: "daily", UsedPercent: 10, ResetAt: now.Add(2 * time.Hour), Period: 24 * time.Hour},
				})
			}
			pick := func(model string, want *Auth) {
				t.Helper()
				got, err := selector.Pick(context.Background(), provider, model, cliproxyexecutor.Options{}, []*Auth{a, b})
				if err != nil || got != want {
					t.Fatalf("Pick(%s) = %v %v, want %s", model, got, err, want.ID)
				}
			}
			publish(a, 20, 72*time.Hour)
			publish(b, 20, 48*time.Hour)
			pick("gemini-3-pro", b) // Longest window determines rank, despite equal daily resets.
			publish(b, 100, 48*time.Hour)
			pick("gemini-3-pro", a)
			publish(a, 100, 72*time.Hour)
			pick("gemini-3-pro", b) // Every account is spent, so keep earliest reset.
			ObserveQuotaWindows(a.ID, now, []QuotaWindow{
				{Key: "monthly", UsedPercent: 10, ResetAt: now.Add(10 * 24 * time.Hour), Period: 30 * 24 * time.Hour},
				{Key: "weekly", UsedPercent: 20, ResetAt: now.Add(24 * time.Hour), Period: 168 * time.Hour},
			})
			publish(b, 20, 48*time.Hour)
			pick("gemini-3-pro", b) // Monthly observations are usable beyond eight days.
			ObserveQuotaWindows(a.ID, now, []QuotaWindow{
				{Key: "gemini", UsedPercent: 100, ResetAt: now.Add(time.Hour), Period: 168 * time.Hour, ModelScope: []string{"gemini-*"}},
				{Key: "claude", UsedPercent: 10, ResetAt: now.Add(time.Hour), Period: 168 * time.Hour, ModelScope: []string{"claude-*"}},
			})
			pick("gemini-3-pro", b)
			pick("claude-opus-4", a)
		})
	}
}

func TestObservedQuotaWindowExpiryAndScope(t *testing.T) {
	now := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	auth := &Auth{ID: t.Name(), Provider: "antigravity"}
	t.Cleanup(func() { ForgetQuotaWindows(auth.ID) })
	cases := []struct {
		name            string
		observed, reset time.Time
		period          time.Duration
		scopes          []string
		want            bool
	}{
		{"expired", now.Add(-time.Hour), now, time.Hour, nil, false},
		{"future observation", now.Add(time.Second), now.Add(time.Hour), time.Hour, nil, false},
		{"stale", now.Add(-48 * time.Hour), now.Add(time.Hour), time.Hour, nil, false},
		{"implausible reset", now, now.Add(48 * time.Hour), time.Hour, nil, false},
		{"different model", now, now.Add(time.Hour), 168 * time.Hour, []string{"claude-*"}, false},
		{"unknown scope", now, now.Add(time.Hour), 168 * time.Hour, []string{""}, false},
		{"matching scope", now, now.Add(time.Hour), 168 * time.Hour, []string{"gemini-*"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ForgetQuotaWindows(auth.ID)
			ObserveQuotaWindows(auth.ID, tc.observed, []QuotaWindow{{Key: "cap", UsedPercent: 100, ResetAt: tc.reset, Period: tc.period, ModelScope: tc.scopes}})
			if _, ok := observedGoverningWindow(auth, "gemini-3-pro", now); ok != tc.want {
				t.Fatalf("usable = %v, want %v", ok, tc.want)
			}
		})
	}
}

func TestUsageOnlyProvidersWithoutReadingsKeepRoundRobin(t *testing.T) {
	now := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
	a, b := &Auth{ID: t.Name() + "-a", Provider: "xai"}, &Auth{ID: t.Name() + "-b", Provider: "xai"}
	counts := map[string]int{}
	for range 4 {
		got, err := selector.Pick(context.Background(), "xai", "grok-4", cliproxyexecutor.Options{}, []*Auth{a, b})
		if err != nil {
			t.Fatal(err)
		}
		counts[got.ID]++
	}
	if counts[a.ID] != 2 || counts[b.ID] != 2 {
		t.Fatalf("counts = %v", counts)
	}
}
