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
		coreauth.ForgetScopedWeeklyWindows(spent.ID)
		coreauth.ForgetScopedWeeklyWindows(open.ID)
	})
	r := NewRecorder(Deps{Do: func(_ context.Context, auth *coreauth.Auth, _, url string, _ map[string]string) (int, []byte, error) {
		if url != ClaudeUsageURL {
			return 404, nil, nil
		}
		used := 20
		if auth.ID == spent.ID {
			used = 100
		}
		return 200, []byte(fmt.Sprintf(`{"seven_day":{"utilization":10,"resets_at":%q},"limits":[{"kind":"weekly_scoped","scope":{"model":{"display_name":"Fable"}},"percent":%d,"resets_at":%q,"is_active":true}]}`,
			now.Add(5*24*time.Hour).UTC().Format(time.RFC3339), used, fableReset)), nil
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
