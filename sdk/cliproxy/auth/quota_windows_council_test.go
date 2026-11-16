package auth

import (
	"fmt"
	"testing"
	"time"
)

func forgetReadings(t *testing.T, ids ...string) {
	t.Helper()
	t.Cleanup(func() {
		for _, id := range ids {
			ForgetQuotaWindows(id)
			ForgetScopedWeeklyWindows(id)
			ForgetShortWindowUsage(id)
		}
	})
}

// A spent shorter window makes the account unusable even when the longest
// window that governs the model still has allowance.
func TestSpentShorterWindowExcludesAccount(t *testing.T) {
	setPlanRouting(t, nil, nil)
	now := time.Unix(1_800_000_000, 0)
	forgetReadings(t, "xai-spent", "xai-open")
	week, month := 7*24*time.Hour, 30*24*time.Hour
	ObserveQuotaWindows("xai-spent", now.Add(-time.Minute), []QuotaWindow{
		{Key: "weekly", UsedPercent: 100, ResetAt: now.Add(3 * 24 * time.Hour), Period: week},
		{Key: "monthly", UsedPercent: 20, ResetAt: now.Add(5 * 24 * time.Hour), Period: month},
	})
	ObserveQuotaWindows("xai-open", now.Add(-time.Minute), []QuotaWindow{
		{Key: "weekly", UsedPercent: 10, ResetAt: now.Add(4 * 24 * time.Hour), Period: week},
		{Key: "monthly", UsedPercent: 20, ResetAt: now.Add(20 * 24 * time.Hour), Period: month},
	})
	spent := &Auth{ID: "xai-spent", Provider: "xai"}
	open := &Auth{ID: "xai-open", Provider: "xai"}
	state, ok := governingQuotaWindowFor(spent, "grok-4", now)
	if !ok || !state.exhausted || !state.reset.Equal(now.Add(3*24*time.Hour)) {
		t.Fatalf("spent state = %+v, %v; want exhausted until the weekly reset", state, ok)
	}
	selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
	// The spent account's monthly reset is sooner, so it would otherwise win.
	if got := countPicks(t, selector, "xai", "grok-4", []*Auth{spent, open}, 10); got["xai-open"] != 10 {
		t.Fatalf("picks = %v, want all on xai-open", got)
	}
}

// Newer response headers that show allowance overrule an older spent poll, as
// after an early reset; ranking then uses the header's weekly reset.
func TestNewerPassiveHeadersOverruleSpentPoll(t *testing.T) {
	setPlanRouting(t, nil, nil)
	now := time.Unix(1_800_000_000, 0)
	forgetReadings(t, "codex-reset", "codex-other")
	week := 7 * 24 * time.Hour
	ObserveQuotaWindows("codex-reset", now.Add(-2*24*time.Hour), []QuotaWindow{
		{Key: "seven_day", UsedPercent: 100, ResetAt: now.Add(24 * time.Hour), Period: week},
	})
	fresh := resetAuth("codex-reset", "codex", now.Add(6*24*time.Hour))
	fresh.Quota.ObservedAt = now.Add(-time.Minute)
	fresh.Quota.Signals["X-Codex-Secondary-Used-Percent"] = "3"
	if state, ok := governingQuotaWindowFor(fresh, "gpt-6", now); !ok || state.exhausted {
		t.Fatalf("state = %+v, %v; want usable after newer headers", state, ok)
	}
	if reset := observedWeeklyReset(fresh, "gpt-6", now); !reset.Equal(now.Add(6 * 24 * time.Hour)) {
		t.Fatalf("reset = %v, want the header's weekly reset", reset)
	}
	// Headers older than the poll change nothing.
	stale := resetAuth("codex-reset", "codex", now.Add(6*24*time.Hour))
	stale.Quota.ObservedAt = now.Add(-3 * 24 * time.Hour)
	stale.Quota.Signals["X-Codex-Secondary-Used-Percent"] = "3"
	if state, ok := governingQuotaWindowFor(stale, "gpt-6", now); !ok || !state.exhausted {
		t.Fatalf("state = %+v, %v; want still exhausted with older headers", state, ok)
	}
	// A manual quota reset forgets the spent poll.
	ForgetQuotaWindows("codex-reset")
	if _, ok := governingQuotaWindowFor(stale, "gpt-6", now); ok {
		t.Fatal("reading survived ForgetQuotaWindows")
	}
}

// A scoped cap that only response headers report stays in force when a newer
// poll does not read that family.
func TestHeaderScopedCapSurvivesPollWithoutThatFamily(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	forgetReadings(t, "claude-sonnet-cap")
	auth := resetAuth("claude-sonnet-cap", "claude", now.Add(4*24*time.Hour))
	auth.Quota.ObservedAt = now.Add(-10 * time.Minute)
	auth.Quota.Signals["Anthropic-Ratelimit-Unified-7d_sonnet-Reset"] = fmt.Sprint(now.Add(2 * 24 * time.Hour).Unix())
	auth.Quota.Signals["Anthropic-Ratelimit-Unified-7d_sonnet-Status"] = "rejected"
	ObserveQuotaWindows(auth.ID, now.Add(-time.Minute), []QuotaWindow{
		{Key: "seven_day", UsedPercent: 30, ResetAt: now.Add(4 * 24 * time.Hour), Period: 7 * 24 * time.Hour},
	})
	if state, ok := governingQuotaWindowFor(auth, "claude-sonnet-5", now); !ok || !state.exhausted {
		t.Fatalf("sonnet state = %+v, %v; want exhausted from headers", state, ok)
	}
	if state, ok := governingQuotaWindowFor(auth, "claude-opus-5-5", now); !ok || state.exhausted {
		t.Fatalf("opus state = %+v, %v; want usable", state, ok)
	}
}

// A usage-only account whose poll failed is not starved by a sibling that has
// a reading; accounts of other providers do not change that.
func TestUsageOnlyAccountWithoutReadingIsNotStarved(t *testing.T) {
	setPlanRouting(t, nil, nil)
	now := time.Unix(1_800_000_000, 0)
	forgetReadings(t, "agy-read", "agy-unread")
	ObserveQuotaWindows("agy-read", now.Add(-time.Minute), []QuotaWindow{
		{Key: "group_pro_weekly", UsedPercent: 99, ResetAt: now.Add(24 * time.Hour), Period: 7 * 24 * time.Hour},
	})
	read := &Auth{ID: "agy-read", Provider: "antigravity"}
	unread := &Auth{ID: "agy-unread", Provider: "antigravity"}
	selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
	if got := countPicks(t, selector, "antigravity", "gemini-pro", []*Auth{read, unread}, 20); got["agy-read"] != 10 || got["agy-unread"] != 10 {
		t.Fatalf("picks = %v, want an even rotation", got)
	}
	// Once both have readings the pool is ranked again.
	ObserveQuotaWindows("agy-unread", now.Add(-time.Minute), []QuotaWindow{
		{Key: "group_pro_weekly", UsedPercent: 5, ResetAt: now.Add(3 * 24 * time.Hour), Period: 7 * 24 * time.Hour},
	})
	if got := countPicks(t, selector, "antigravity", "gemini-pro", []*Auth{read, unread}, 10); got["agy-read"] != 10 {
		t.Fatalf("picks = %v, want the sooner reset", got)
	}
}

// A poll that carries no usable reset does not stop the account from being
// probed: only passive readings count for the probe interval.
func TestEmptyPollDoesNotSuppressProbe(t *testing.T) {
	setPlanRouting(t, nil, nil)
	now := time.Unix(1_800_000_000, 0)
	forgetReadings(t, "claude-fresh", "claude-ranked")
	ranked := resetAuth("claude-ranked", "claude", now.Add(2*24*time.Hour))
	ranked.Quota.ObservedAt = now.Add(-time.Minute)
	fresh := &Auth{ID: "claude-fresh", Provider: "claude"}
	ObserveQuotaWindows(fresh.ID, now.Add(-time.Minute), nil)
	selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
	if got := countPicks(t, selector, "claude", "claude-sonnet-5", []*Auth{ranked, fresh}, 5); got["claude-fresh"] != 5 {
		t.Fatalf("picks = %v, want the unread account probed", got)
	}
}

// Devin sends no reset in response headers, so an account without a reading
// rotates with its siblings instead of winning every pick as a probe.
func TestDevinAccountWithoutReadingRotates(t *testing.T) {
	setPlanRouting(t, nil, nil)
	now := time.Unix(1_800_000_000, 0)
	forgetReadings(t, "devin-read", "devin-unread")
	ObserveQuotaWindows("devin-read", now.Add(-time.Minute), []QuotaWindow{
		{Key: "weekly", UsedPercent: 10, ResetAt: now.Add(3 * 24 * time.Hour), Period: 7 * 24 * time.Hour},
	})
	read := &Auth{ID: "devin-read", Provider: "devin"}
	unread := &Auth{ID: "devin-unread", Provider: "devin"}
	selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
	if got := countPicks(t, selector, "devin", "devin-1", []*Auth{read, unread}, 10); got["devin-read"] != 5 || got["devin-unread"] != 5 {
		t.Fatalf("picks = %v, want an even rotation", got)
	}
}

// An unread account of one usage-only provider does not take ranking away from
// the other providers in a mixed pool.
func TestUnreadUsageOnlyAccountLeavesOtherProvidersRanked(t *testing.T) {
	setPlanRouting(t, nil, nil)
	now := time.Unix(1_800_000_000, 0)
	forgetReadings(t, "agy-mixed-read", "agy-mixed-unread")
	sooner := resetAuth("claude-sooner", "claude", now.Add(24*time.Hour))
	sooner.Quota.ObservedAt = now.Add(-time.Minute)
	later := resetAuth("claude-later", "claude", now.Add(4*24*time.Hour))
	later.Quota.ObservedAt = now.Add(-time.Minute)
	ObserveQuotaWindows("agy-mixed-read", now.Add(-time.Minute), []QuotaWindow{
		{Key: "group_pro_weekly", UsedPercent: 5, ResetAt: now.Add(2 * time.Hour), Period: 7 * 24 * time.Hour},
	})
	read := &Auth{ID: "agy-mixed-read", Provider: "antigravity"}
	unread := &Auth{ID: "agy-mixed-unread", Provider: "antigravity"}
	selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
	if got := countPicks(t, selector, "mixed", "shared-model", []*Auth{later, read, unread, sooner}, 20); got["claude-sooner"] != 20 {
		t.Fatalf("picks = %v, want all on the soonest-reset Claude account", got)
	}
}
