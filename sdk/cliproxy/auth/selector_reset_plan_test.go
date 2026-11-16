package auth

import (
	"context"
	"fmt"
	"testing"
	"time"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

// planAuth is resetAuth with a plan and an optional 5-hour reading taken
// from passive headers (usedPercent < 0 means none).
func planAuth(id, provider, plan string, observedAt, weekly time.Time, usedPercent float64, fiveHourReset time.Time) *Auth {
	auth := resetAuth(id, provider, weekly)
	auth.Quota.ObservedAt = observedAt
	auth.Attributes = map[string]string{"plan_type": plan}
	if usedPercent < 0 {
		return auth
	}
	switch provider {
	case "claude":
		auth.Quota.Signals["Anthropic-Ratelimit-Unified-5h-Utilization"] = fmt.Sprint(usedPercent / 100)
		auth.Quota.Signals["Anthropic-Ratelimit-Unified-5h-Reset"] = fmt.Sprint(fiveHourReset.Unix())
	case "codex":
		auth.Quota.Signals["X-Codex-Primary-Window-Minutes"] = "300"
		auth.Quota.Signals["X-Codex-Primary-Used-Percent"] = fmt.Sprint(usedPercent)
		auth.Quota.Signals["X-Codex-Primary-Reset-At"] = fmt.Sprint(fiveHourReset.Unix())
	}
	return auth
}

func countPicks(t *testing.T, selector *SoonestResetFirstSelector, provider, model string, auths []*Auth, n int) map[string]int {
	t.Helper()
	counts := make(map[string]int)
	for range n {
		got, err := selector.Pick(context.Background(), provider, model, cliproxyexecutor.Options{}, auths)
		if err != nil || got == nil {
			t.Fatalf("Pick() = %v, %v", got, err)
		}
		counts[got.ID]++
	}
	return counts
}

func TestSoonestResetFirstSpreadsTiesByPlanWeight(t *testing.T) {
	setPlanRouting(t, nil, nil)
	now := time.Unix(1_800_000_000, 0)
	observed := now.Add(-time.Minute)
	weekly := now.Add(2 * 24 * time.Hour)
	selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}

	// Tied weekly resets: 1 + 5 + 20 = 26 picks land exactly in proportion.
	pro := planAuth("pro", "claude", "pro", observed, weekly, -1, time.Time{})
	max5 := planAuth("max5", "claude", "max_5x", observed, weekly, -1, time.Time{})
	max20 := planAuth("max20", "claude", "default_claude_max_20x", observed, weekly, -1, time.Time{})
	auths := []*Auth{max20, pro, max5}
	if got := countPicks(t, selector, "claude", "claude-sonnet-5", auths, 2*26); got["pro"] != 2 || got["max5"] != 10 || got["max20"] != 40 {
		t.Fatalf("tied picks = %v, want pro:2 max5:10 max20:40", got)
	}

	// The spread is smooth and deterministic: weights 1 and 2 give b, a, b.
	a := planAuth("a", "codex", "plus", observed, weekly, -1, time.Time{})
	a.Attributes["plan_type"] = "plus"
	b := planAuth("b", "codex", "plus", observed, weekly, -1, time.Time{})
	setPlanRouting(t, map[string]map[string]float64{"codex": {"double": 2}}, nil)
	b.Attributes["plan_type"] = "double"
	fresh := &SoonestResetFirstSelector{now: func() time.Time { return now }}
	var sequence string
	for range 6 {
		got, err := fresh.Pick(context.Background(), "codex", "gpt-5", cliproxyexecutor.Options{}, []*Auth{a, b})
		if err != nil {
			t.Fatal(err)
		}
		sequence += got.ID
	}
	if sequence != "babbab" {
		t.Fatalf("sequence = %s, want babbab", sequence)
	}

	// Ranking still wins over weight: a sooner weekly reset takes every pick.
	soon := planAuth("soon", "claude", "pro", observed, now.Add(time.Hour), -1, time.Time{})
	if got := countPicks(t, selector, "claude", "claude-sonnet-5", []*Auth{max20, soon}, 5); got["soon"] != 5 {
		t.Fatalf("ranked picks = %v, want soon:5", got)
	}

	// Probes and pools without quota reports are spread by weight too.
	probeSmall := &Auth{ID: "probe-small", Provider: "codex", Attributes: map[string]string{"plan_type": "plus"}}
	probeBig := &Auth{ID: "probe-big", Provider: "codex", Attributes: map[string]string{"plan_type": "prolite"}}
	if got := countPicks(t, selector, "codex", "gpt-5", []*Auth{probeSmall, probeBig}, 6); got["probe-small"] != 1 || got["probe-big"] != 5 {
		t.Fatalf("probe picks = %v, want probe-small:1 probe-big:5", got)
	}
	grokA := &Auth{ID: "grok-a", Provider: "grok"}
	grokB := &Auth{ID: "grok-b", Provider: "grok"}
	if got := countPicks(t, selector, "grok", "grok-4", []*Auth{grokA, grokB}, 4); got["grok-a"] != 2 || got["grok-b"] != 2 {
		t.Fatalf("unranked picks = %v, want round-robin", got)
	}
}

func TestSoonestResetFirstPlanHeadroomGuard(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	observed := now.Add(-time.Minute)
	weekly := now.Add(2 * 24 * time.Hour)
	fiveHour := now.Add(2 * time.Hour)
	const model = "claude-sonnet-5"
	tests := []struct {
		name     string
		provider string
		reserve  *float64
		auths    func() []*Auth
		want     map[string]int // exact counts over 4 picks
	}{
		{
			name: "tight pro skipped for a roomy pro", provider: "claude",
			auths: func() []*Auth {
				return []*Auth{
					planAuth("a", "claude", "pro", observed, weekly, 95, fiveHour),
					planAuth("b", "claude", "pro", observed, weekly, 50, fiveHour),
				}
			},
			want: map[string]int{"b": 4},
		},
		{
			name: "tight account skipped even with the soonest weekly reset", provider: "claude",
			auths: func() []*Auth {
				return []*Auth{
					planAuth("a", "claude", "pro", observed, now.Add(time.Hour), 95, fiveHour),
					planAuth("b", "claude", "pro", observed, weekly, 50, fiveHour),
				}
			},
			want: map[string]int{"b": 4},
		},
		{
			name: "same percent left is tight on pro but not on max 20x", provider: "claude",
			auths: func() []*Auth {
				return []*Auth{
					// Pro with 5% left has headroom 5; Max 20x with 3% left has 60.
					planAuth("a", "claude", "pro", observed, now.Add(time.Hour), 95, fiveHour),
					planAuth("b", "claude", "max_20x", observed, weekly, 97, fiveHour),
				}
			},
			want: map[string]int{"b": 4},
		},
		{
			name: "every account tight keeps ranking", provider: "claude",
			auths: func() []*Auth {
				return []*Auth{
					planAuth("a", "claude", "pro", observed, now.Add(time.Hour), 95, fiveHour),
					planAuth("b", "claude", "pro", observed, weekly, 99, fiveHour),
				}
			},
			want: map[string]int{"a": 4},
		},
		{
			name: "zero reserve disables the guard", provider: "claude", reserve: new(0.0),
			auths: func() []*Auth {
				return []*Auth{
					planAuth("a", "claude", "pro", observed, weekly, 95, fiveHour),
					planAuth("b", "claude", "pro", observed, weekly, 50, fiveHour),
				}
			},
			want: map[string]int{"a": 2, "b": 2},
		},
		{
			name: "reading whose window already reset is ignored", provider: "claude",
			auths: func() []*Auth {
				return []*Auth{
					planAuth("a", "claude", "pro", observed.Add(-3*time.Hour), weekly, 95, now.Add(-time.Minute)),
					planAuth("b", "claude", "pro", observed, weekly, 50, fiveHour),
				}
			},
			want: map[string]int{"a": 2, "b": 2},
		},
		{
			name: "codex primary 5-hour window", provider: "codex",
			auths: func() []*Auth {
				return []*Auth{
					planAuth("a", "codex", "plus", observed, weekly, 95, fiveHour),
					planAuth("b", "codex", "plus", observed, weekly, 10, fiveHour),
				}
			},
			want: map[string]int{"b": 4},
		},
		{
			name: "codex pro tolerates a low percent", provider: "codex",
			auths: func() []*Auth {
				return []*Auth{
					// Pro (weight 6) with 5% left has headroom 30.
					planAuth("a", "codex", "pro", observed, now.Add(time.Hour), 95, fiveHour),
					planAuth("b", "codex", "plus", observed, weekly, 10, fiveHour),
				}
			},
			want: map[string]int{"a": 4},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setPlanRouting(t, nil, tt.reserve)
			selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
			got := countPicks(t, selector, tt.provider, model, tt.auths(), 4)
			if fmt.Sprint(got) != fmt.Sprint(tt.want) {
				t.Fatalf("picks = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestShortWindowUsageReadingFeedsHeadroomGuard(t *testing.T) {
	setPlanRouting(t, nil, nil)
	now := time.Unix(1_800_000_000, 0)
	weekly := now.Add(2 * 24 * time.Hour)
	// Header readings say both accounts are roomy; a newer usage-endpoint reading
	// says a is nearly spent.
	a := planAuth("headroom-usage-a", "claude", "pro", now.Add(-time.Hour), weekly, 20, now.Add(time.Hour))
	b := planAuth("headroom-usage-b", "claude", "pro", now.Add(-time.Hour), weekly, 20, now.Add(time.Hour))
	t.Cleanup(func() { ForgetShortWindowUsage(a.ID) })
	ObserveShortWindowUsage(a.ID, now.Add(-time.Minute), 97, now.Add(time.Hour))
	// An older reading never replaces a newer one.
	ObserveShortWindowUsage(a.ID, now.Add(-2*time.Hour), 0, now.Add(time.Hour))
	selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
	if got := countPicks(t, selector, "claude", "claude-sonnet-5", []*Auth{a, b}, 3); got[b.ID] != 3 {
		t.Fatalf("picks = %v, want only %s", got, b.ID)
	}
}

// The headroom guard only shapes new conversations: a bound conversation stays
// on its account when that account becomes tight.
func TestPlanHeadroomGuardKeepsBoundConversations(t *testing.T) {
	setPlanRouting(t, nil, nil)
	const model = "claude-sonnet-5"
	now := time.Now()
	weekly := now.Add(2 * 24 * time.Hour)
	a := planAuth("a", "claude", "pro", now.Add(-time.Minute), now.Add(24*time.Hour), 10, now.Add(time.Hour))
	b := planAuth("b", "claude", "pro", now.Add(-time.Minute), weekly, 10, now.Add(time.Hour))
	auths := []*Auth{a, b}
	selector := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{Fallback: &SoonestResetFirstSelector{}, TTL: time.Hour})
	t.Cleanup(selector.Stop)
	session := cliproxyexecutor.Options{Headers: map[string][]string{"X-Session-Id": {"plan-headroom-bound"}}}
	other := cliproxyexecutor.Options{Headers: map[string][]string{"X-Session-Id": {"plan-headroom-new"}}}
	pick := func(opts cliproxyexecutor.Options, want, step string) {
		t.Helper()
		got, err := selector.Pick(context.Background(), "claude", model, opts, auths)
		if err != nil || got == nil || got.ID != want {
			t.Fatalf("%s: Pick() = %v, %v; want %s", step, got, err, want)
		}
	}
	pick(session, "a", "new conversation binds to the soonest reset")
	a.Quota.Signals["Anthropic-Ratelimit-Unified-5h-Utilization"] = "0.96"
	pick(other, "b", "a new conversation avoids the tight account")
	pick(session, "a", "the bound conversation is not moved")
}
