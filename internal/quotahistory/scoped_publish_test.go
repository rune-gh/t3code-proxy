package quotahistory

import (
	"context"
	"fmt"
	"testing"
	"time"

	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

func TestScopedWeeklyWindowsFamilies(t *testing.T) {
	reset := int64(1_800_000_000_000)
	got := scopedWeeklyWindows(map[string]Window{
		WindowFiveHour:      {UsedPercent: 100, ResetsAt: &reset},
		WindowSevenDay:      {UsedPercent: 100, ResetsAt: &reset},
		WindowSevenDayFable: {UsedPercent: 100, ResetsAt: &reset},
		WindowSevenDayOpus:  {UsedPercent: 30},
	})
	if len(got) != 1 || got["fable"].UsedPercent != 100 || got["fable"].ResetAt.UnixMilli() != reset {
		t.Fatalf("scopedWeeklyWindows = %+v; want only fable", got)
	}
}

// A spent Fable cap read from the usage endpoint steers Fable requests away
// from that account under soonest-reset-first.
func TestRecorderPublishesSpentFableCapToSelector(t *testing.T) {
	now := time.Now()
	fableReset := now.Add(3 * 24 * time.Hour).UTC().Format(time.RFC3339)
	spent := &coreauth.Auth{ID: "qh-scoped-spent", Index: "qh-scoped-spent", Provider: "claude", Metadata: map[string]any{"access_token": "a"}}
	open := &coreauth.Auth{ID: "qh-scoped-open", Index: "qh-scoped-open", Provider: "claude", Metadata: map[string]any{"access_token": "b"}}
	t.Cleanup(func() {
		coreauth.ForgetQuotaWindows(spent.ID)
		coreauth.ForgetScopedWeeklyWindows(spent.ID)
		coreauth.ForgetQuotaWindows(open.ID)
		coreauth.ForgetScopedWeeklyWindows(open.ID)
	})
	r := NewRecorder(Deps{Do: func(_ context.Context, auth *coreauth.Auth, _, url string, _ map[string]string) (int, []byte, error) {
		if url != ClaudeUsageURL {
			return 404, nil, nil
		}
		used := 20
		overallReset := now.Add(5 * 24 * time.Hour)
		if auth.ID == spent.ID {
			used = 100
			overallReset = now.Add(24 * time.Hour)
		}
		return 200, []byte(fmt.Sprintf(`{"seven_day":{"utilization":10,"resets_at":%q},"limits":[{"kind":"weekly_scoped","scope":{"model":{"display_name":"Fable"}},"percent":%d,"resets_at":%q,"is_active":true}]}`,
			overallReset.UTC().Format(time.RFC3339), used, fableReset)), nil
	}})
	r.now = func() time.Time { return now }
	for _, auth := range []*coreauth.Auth{spent, open} {
		if rec := r.sample(context.Background(), auth); rec.Error != "" {
			t.Fatalf("sample %s: %s", auth.ID, rec.Error)
		}
	}
	// The spent account would otherwise win: its overall weekly reset is sooner.
	spent.Quota = coreauth.QuotaState{ObservedAt: now.Add(-time.Minute), Signals: map[string]string{"Anthropic-Ratelimit-Unified-7d-Reset": fmt.Sprint(now.Add(24 * time.Hour).Unix())}}
	open.Quota = coreauth.QuotaState{ObservedAt: now.Add(-time.Minute), Signals: map[string]string{"Anthropic-Ratelimit-Unified-7d-Reset": fmt.Sprint(now.Add(4 * 24 * time.Hour).Unix())}}
	selector := &coreauth.SoonestResetFirstSelector{}
	for _, tc := range []struct{ model, want string }{{"claude-fable-5-1", open.ID}, {"claude-sonnet-5", spent.ID}} {
		got, err := selector.Pick(context.Background(), "claude", tc.model, cliproxyexecutor.Options{}, []*coreauth.Auth{spent, open})
		if err != nil || got == nil || got.ID != tc.want {
			t.Fatalf("Pick(%s) = %v, %v; want %s", tc.model, got, err, tc.want)
		}
	}
}

// The recorder hands routing each account's plan and 5-hour reading, and the
// account list reports the resulting plan weight.
func TestRecorderPublishesPlanAndShortWindowToRouting(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	codex := &coreauth.Auth{ID: "qh-plan-codex", Index: "qh-plan-codex", Provider: "codex", Metadata: map[string]any{"access_token": "a"}}
	claude := &coreauth.Auth{ID: "qh-plan-claude", Index: "qh-plan-claude", Provider: "claude", Metadata: map[string]any{"access_token": "b"}}
	t.Cleanup(func() {
		for _, auth := range []*coreauth.Auth{codex, claude} {
			coreauth.ObserveAuthPlan(auth.ID, "")
			coreauth.ForgetShortWindowUsage(auth.ID)
			coreauth.ForgetQuotaWindows(auth.ID)
			coreauth.ForgetScopedWeeklyWindows(auth.ID)
		}
	})
	request := func(_ context.Context, _ *coreauth.Auth, _, url string, _ map[string]string, _ []byte) (int, []byte, error) {
		switch url {
		case CodexUsageURL:
			return 200, []byte(`{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":40,"limit_window_seconds":18000,"reset_after_seconds":3600}}}`), nil
		case ClaudeUsageURL:
			return 200, []byte(`{"five_hour":{"utilization":10,"resets_at":"2027-01-15T10:00:00Z"}}`), nil
		case ClaudeProfileURL:
			return 200, []byte(`{"organization":{"rate_limit_tier":"default_claude_max_20x"}}`), nil
		}
		return 404, nil, nil
	}
	r := NewRecorder(Deps{DoRequest: request, ListAuths: func() []*coreauth.Auth { return []*coreauth.Auth{codex, claude} }})
	r.now = func() time.Time { return now }
	for _, auth := range []*coreauth.Auth{codex, claude} {
		if rec := r.sample(context.Background(), auth); rec.Error != "" {
			t.Fatalf("sample %s: %s", auth.ID, rec.Error)
		}
	}
	if got := coreauth.PlanOf(codex); got != "pro" {
		t.Fatalf("codex plan = %q, want pro", got)
	}
	if got := coreauth.PlanOf(claude); got != "max_20x" {
		t.Fatalf("claude plan = %q, want max_20x", got)
	}
	weights := map[string]float64{}
	for _, account := range r.accounts() {
		weights[account.AuthIndex] = account.Weight
	}
	if weights[codex.Index] != coreauth.PlanWeight("codex", "pro") || weights[claude.Index] != 20 {
		t.Fatalf("account weights = %v", weights)
	}
}

// An account disabled after the round's target list was taken is not polled,
// and a Codex "limit reached" reading without percentages is charted but does
// not tell routing that both windows are spent.
func TestPollRereadsAccountsAndKeepsEstimatesOutOfRouting(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	first := &coreauth.Auth{ID: "qh-live-first", Index: "qh-live-first", Provider: "codex", Metadata: map[string]any{"access_token": "a"}}
	second := &coreauth.Auth{ID: "qh-live-second", Index: "qh-live-second", Provider: "codex", Metadata: map[string]any{"access_token": "b"}}
	t.Cleanup(func() {
		for _, auth := range []*coreauth.Auth{first, second} {
			coreauth.ObserveAuthPlan(auth.ID, "")
			coreauth.ForgetShortWindowUsage(auth.ID)
			coreauth.ForgetQuotaWindows(auth.ID)
		}
	})
	var polled []string
	request := func(_ context.Context, auth *coreauth.Auth, _, _ string, _ map[string]string, _ []byte) (int, []byte, error) {
		polled = append(polled, auth.ID)
		// Reading the first account is when the second one gets disabled.
		second.Disabled = true
		return 200, []byte(`{"plan_type":"plus","rate_limit":{"limit_reached":true,"primary_window":{"limit_window_seconds":18000,"reset_after_seconds":600},"secondary_window":{"limit_window_seconds":604800,"reset_after_seconds":86400}}}`), nil
	}
	r := NewRecorder(Deps{DoRequest: request, ListAuths: func() []*coreauth.Auth { return []*coreauth.Auth{first, second} }})
	r.now = func() time.Time { return now }
	r.manualGap = 0
	t.Cleanup(r.Close)
	if err := r.Apply(enabledSettings(t)); err != nil {
		t.Fatal(err)
	}
	if stored := r.poll(context.Background(), r.store, 0, nil); stored != 1 || len(polled) != 1 || polled[0] != first.ID {
		t.Fatalf("stored %d, polled %v; want only the first account", stored, polled)
	}
	history, err := r.History(0, 0)
	if err != nil || len(history.Samples) != 1 || history.Samples[0].Windows[WindowSevenDay].UsedPercent != 100 {
		t.Fatalf("history = %+v, %v; want the assumed 100%% charted", history.Samples, err)
	}
	if _, windows := coreauth.ObservedQuotaWindows(first.ID); len(windows) != 0 {
		t.Fatalf("routing received assumed windows: %+v", windows)
	}
}

// Readings of accounts the recorder stops polling are dropped from routing,
// both when a provider leaves the allowlist and when the recorder is turned off.
func TestApplyForgetsReadingsOfUntrackedAccounts(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	xai := &coreauth.Auth{ID: "qh-forget-xai", Index: "qh-forget-xai", Provider: "xai", Metadata: map[string]any{"access_token": "a"}}
	codex := &coreauth.Auth{ID: "qh-forget-codex", Index: "qh-forget-codex", Provider: "codex", Metadata: map[string]any{"access_token": "b"}}
	spent := []coreauth.QuotaWindow{{Key: "weekly", UsedPercent: 100, ResetAt: now.Add(48 * time.Hour), Period: 168 * time.Hour}}
	observe := func() {
		coreauth.ObserveQuotaWindows(xai.ID, now, spent)
		coreauth.ObserveQuotaWindows(codex.ID, now, spent)
	}
	count := func(id string) int {
		_, windows := coreauth.ObservedQuotaWindows(id)
		return len(windows)
	}
	t.Cleanup(func() {
		coreauth.ForgetQuotaWindows(xai.ID)
		coreauth.ForgetQuotaWindows(codex.ID)
	})
	r := NewRecorder(Deps{ListAuths: func() []*coreauth.Auth { return []*coreauth.Auth{xai, codex} }})
	r.startupDelay = time.Hour
	t.Cleanup(r.Close)
	s := enabledSettings(t)

	observe()
	s.Providers = "codex"
	if err := r.Apply(s); err != nil {
		t.Fatal(err)
	}
	if count(xai.ID) != 0 || count(codex.ID) != 1 {
		t.Fatalf("after narrowing the allowlist: xai %d, codex %d; want 0 and 1", count(xai.ID), count(codex.ID))
	}
	s.Enabled = false
	if err := r.Apply(s); err != nil {
		t.Fatal(err)
	}
	if count(codex.ID) != 0 {
		t.Fatalf("after turning the recorder off: codex %d; want 0", count(codex.ID))
	}
}
