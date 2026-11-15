package auth

import (
	"context"
	"fmt"
	"testing"
	"time"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

const fableModel = "claude-fable-5-1"

// scopedAuth builds an observed account whose overall weekly window resets at
// weekly; scoped adds "7d_<family>" header signals (utilization 0-1).
func scopedAuth(id, provider string, observedAt, weekly time.Time, scoped map[string]scopedSignal) *Auth {
	auth := resetAuth(id, provider, weekly)
	auth.Quota.ObservedAt = observedAt
	for family, sig := range scoped {
		prefix := "Anthropic-Ratelimit-Unified-7d_" + family + "-"
		auth.Quota.Signals[prefix+"Reset"] = fmt.Sprint(sig.reset.Unix())
		auth.Quota.Signals[prefix+"Utilization"] = fmt.Sprint(sig.utilization)
		if sig.utilization >= 1 {
			auth.Quota.Signals[prefix+"Status"] = "rejected"
		} else {
			auth.Quota.Signals[prefix+"Status"] = "allowed"
		}
	}
	return auth
}

type scopedSignal struct {
	utilization float64
	reset       time.Time
}

func TestSoonestResetFirstModelScopedWeeklyCaps(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	observed := now.Add(-time.Minute)
	day := 24 * time.Hour
	spent := func(reset time.Duration) map[string]scopedSignal {
		return map[string]scopedSignal{"fable": {utilization: 1, reset: now.Add(reset)}}
	}
	open := func(reset time.Duration) map[string]scopedSignal {
		return map[string]scopedSignal{"fable": {utilization: 0.4, reset: now.Add(reset)}}
	}
	tests := []struct {
		name     string
		provider string
		model    string
		auths    func() []*Auth
		// recorder publishes usage-endpoint readings (percent 0-100) by auth ID.
		recorder map[string]map[string]ScopedWeeklyWindow
		want     []string // accepted picks; more than one means rotation is allowed
	}{
		{
			name: "exhausted scoped cap skipped even with sooner overall reset", provider: "claude", model: fableModel,
			auths: func() []*Auth {
				return []*Auth{
					scopedAuth("a", "claude", observed, now.Add(day), spent(3*day)),
					scopedAuth("b", "claude", observed, now.Add(5*day), open(5*day)),
				}
			},
			want: []string{"b"},
		},
		{
			name: "ranking uses scoped reset for scoped model", provider: "claude", model: fableModel,
			auths: func() []*Auth {
				return []*Auth{
					scopedAuth("a", "claude", observed, now.Add(day), open(6*day)),
					scopedAuth("b", "claude", observed, now.Add(5*day), open(2*day)),
				}
			},
			want: []string{"b"},
		},
		{
			name: "all exhausted falls back to soonest scoped reset", provider: "claude", model: fableModel,
			auths: func() []*Auth {
				return []*Auth{
					scopedAuth("a", "claude", observed, now.Add(day), spent(4*day)),
					scopedAuth("b", "claude", observed, now.Add(5*day), spent(2*day)),
				}
			},
			want: []string{"b"},
		},
		{
			name: "stale observation after scoped reset passes", provider: "claude", model: fableModel,
			auths: func() []*Auth {
				return []*Auth{
					// Spent cap reset an hour ago: the account is usable again and ranks on its overall reset.
					scopedAuth("a", "claude", now.Add(-3*day), now.Add(day), spent(-time.Hour)),
					scopedAuth("b", "claude", observed, now.Add(5*day), open(5*day)),
				}
			},
			want: []string{"a"},
		},
		{
			name: "non-scoped model unaffected by spent fable cap", provider: "claude", model: "claude-sonnet-5",
			auths: func() []*Auth {
				return []*Auth{
					scopedAuth("a", "claude", observed, now.Add(day), spent(3*day)),
					scopedAuth("b", "claude", observed, now.Add(5*day), open(5*day)),
				}
			},
			want: []string{"a"},
		},
		{
			name: "overage window does not scope any model", provider: "claude", model: fableModel,
			auths: func() []*Auth {
				return []*Auth{
					scopedAuth("a", "claude", observed, now.Add(day), map[string]scopedSignal{"oi": {utilization: 1, reset: now.Add(3 * day)}}),
					scopedAuth("b", "claude", observed, now.Add(5*day), nil),
				}
			},
			want: []string{"a"},
		},
		{
			name: "opus cap governs opus model only", provider: "claude", model: "claude-opus-5-5",
			auths: func() []*Auth {
				return []*Auth{
					scopedAuth("a", "claude", observed, now.Add(day), map[string]scopedSignal{"opus": {utilization: 1, reset: now.Add(3 * day)}}),
					scopedAuth("b", "claude", observed, now.Add(5*day), nil),
				}
			},
			want: []string{"b"},
		},
		{
			name: "codex unaffected", provider: "codex", model: "gpt-5-fable",
			auths: func() []*Auth {
				a := scopedAuth("a", "codex", observed, now.Add(day), nil)
				a.Quota.Signals["Anthropic-Ratelimit-Unified-7d_fable-Status"] = "rejected"
				a.Quota.Signals["Anthropic-Ratelimit-Unified-7d_fable-Reset"] = fmt.Sprint(now.Add(3 * day).Unix())
				return []*Auth{a, scopedAuth("b", "codex", observed, now.Add(5*day), nil)}
			},
			recorder: map[string]map[string]ScopedWeeklyWindow{"scoped-test-a": {"fable": {UsedPercent: 100, ResetAt: now.Add(3 * day)}}},
			want:     []string{"a"},
		},
		{
			name: "recorder reading marks cap spent", provider: "claude", model: fableModel,
			auths: func() []*Auth {
				return []*Auth{
					scopedAuth("a", "claude", observed, now.Add(day), nil),
					scopedAuth("b", "claude", observed, now.Add(5*day), nil),
				}
			},
			recorder: map[string]map[string]ScopedWeeklyWindow{"scoped-test-a": {"fable": {UsedPercent: 100, ResetAt: now.Add(3 * day)}}},
			want:     []string{"b"},
		},
		{
			name: "newer header observation overrides older spent recorder reading", provider: "claude", model: fableModel,
			auths: func() []*Auth {
				return []*Auth{
					scopedAuth("a", "claude", observed, now.Add(day), open(3*day)),
					scopedAuth("b", "claude", observed, now.Add(5*day), nil),
				}
			},
			recorder: map[string]map[string]ScopedWeeklyWindow{"scoped-test-a": {"fable": {UsedPercent: 100, ResetAt: now.Add(3 * day)}}},
			want:     []string{"a"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			auths := tt.auths()
			for _, auth := range auths {
				// Unique IDs keep the package-level recorder readings isolated per test.
				auth.ID = "scoped-test-" + auth.ID
				ForgetScopedWeeklyWindows(auth.ID)
				t.Cleanup(func() { ForgetScopedWeeklyWindows(auth.ID) })
			}
			for id, windows := range tt.recorder {
				// Recorder readings are older than the header observations.
				ObserveScopedWeeklyWindows(id, observed.Add(-10*time.Minute), windows)
			}
			selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
			for range 4 {
				got, err := selector.Pick(context.Background(), tt.provider, tt.model, cliproxyexecutor.Options{}, auths)
				if err != nil || got == nil {
					t.Fatalf("Pick() = %v, %v", got, err)
				}
				ok := false
				for _, want := range tt.want {
					ok = ok || got.ID == "scoped-test-"+want
				}
				if !ok {
					t.Fatalf("Pick() = %s, want one of %v", got.ID, tt.want)
				}
			}
		})
	}
}

func TestObserveScopedWeeklyWindowsKeepsNewest(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	const id = "scoped-newest"
	t.Cleanup(func() { ForgetScopedWeeklyWindows(id) })
	auth := &Auth{ID: id, Provider: "claude"}
	ObserveScopedWeeklyWindows(id, now.Add(-time.Minute), map[string]ScopedWeeklyWindow{"Fable": {UsedPercent: 20, ResetAt: now.Add(time.Hour)}})
	ObserveScopedWeeklyWindows(id, now.Add(-time.Hour), map[string]ScopedWeeklyWindow{"fable": {UsedPercent: 100, ResetAt: now.Add(time.Hour)}})
	state, ok := scopedWeeklyWindowFor(auth, fableModel, now)
	if !ok || state.exhausted || !state.reset.Equal(now.Add(time.Hour)) {
		t.Fatalf("state = %+v, %v; want newest open reading", state, ok)
	}
	if _, ok = scopedWeeklyWindowFor(auth, "claude-sonnet-5", now); ok {
		t.Fatal("fable reading applied to sonnet")
	}
}

func TestModelScopeTokens(t *testing.T) {
	for model, want := range map[string]string{
		"claude-fable-5-1":            "fable",
		"claude-opus-5-5(high)":       "opus",
		"anthropic/claude-sonnet-5":   "sonnet",
		"us.anthropic.claude-fable-5": "fable",
	} {
		if _, ok := modelScopeTokens(model)[want]; !ok {
			t.Fatalf("modelScopeTokens(%q) missing %q", model, want)
		}
	}
	if _, ok := modelScopeTokens("claude-fableish-5")["fable"]; ok {
		t.Fatal("partial word matched a family")
	}
}
