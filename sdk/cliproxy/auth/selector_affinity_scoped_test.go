package auth

import (
	"context"
	"testing"
	"time"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

// A conversation bound to an account whose model-scoped weekly cap the hub
// already knows is spent rebinds before the request is sent, instead of being
// sent once, getting a 429, and only then rebinding.
func TestSessionAffinityRebindsBeforeSendingOnKnownSpentScopedCap(t *testing.T) {
	for _, rebindOn := range []string{SessionAffinityRebindOnAny, SessionAffinityRebindOnQuota, SessionAffinityRebindOnNever} {
		t.Run(rebindOn, func(t *testing.T) {
			now := time.Now()
			day := 24 * time.Hour
			a := resetAuth("affinity-scoped-a-"+rebindOn, "claude", now.Add(day))
			b := resetAuth("affinity-scoped-b-"+rebindOn, "claude", now.Add(4*day))
			auths := []*Auth{a, b}
			t.Cleanup(func() { ForgetScopedWeeklyWindows(a.ID) })
			selector := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{
				Fallback: &SoonestResetFirstSelector{},
				TTL:      time.Hour,
				RebindOn: rebindOn,
			})
			t.Cleanup(selector.Stop)
			session := cliproxyexecutor.Options{Headers: map[string][]string{"X-Session-Id": {"affinity-scoped-" + rebindOn}}}
			pick := func(model, want, step string) {
				t.Helper()
				got, err := selector.Pick(context.Background(), "claude", model, session, auths)
				if err != nil || got == nil || got.ID != want {
					t.Fatalf("%s: Pick() = %v, %v; want %s", step, got, err, want)
				}
			}

			pick(fableModel, a.ID, "conversation binds to the soonest reset")
			// The quota-history recorder learns that a's Fable weekly cap is spent.
			// No request result (and no 429) is reported to the selector.
			ObserveScopedWeeklyWindows(a.ID, now, map[string]ScopedWeeklyWindow{"fable": {UsedPercent: 100, ResetAt: now.Add(3 * day)}})
			if rebindOn == SessionAffinityRebindOnNever {
				pick(fableModel, a.ID, "never mode keeps the binding")
				return
			}
			pick(fableModel, b.ID, "bound conversation rebinds before sending")
			// The new binding sticks, also once the reading is gone.
			ForgetScopedWeeklyWindows(a.ID)
			pick(fableModel, b.ID, "rebound conversation stays on its new account")
		})
	}
}

// The spent cap only governs its model family and only matters when another
// eligible account exists.
func TestSessionAffinityScopedCapRebindScope(t *testing.T) {
	now := time.Now()
	day := 24 * time.Hour
	a := resetAuth("affinity-scope-a", "claude", now.Add(day))
	b := resetAuth("affinity-scope-b", "claude", now.Add(4*day))
	t.Cleanup(func() { ForgetScopedWeeklyWindows(a.ID) })
	selector := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{Fallback: &SoonestResetFirstSelector{}, TTL: time.Hour})
	t.Cleanup(selector.Stop)
	session := cliproxyexecutor.Options{Headers: map[string][]string{"X-Session-Id": {"affinity-scope"}}}
	pick := func(model string, auths []*Auth, want, step string) {
		t.Helper()
		got, err := selector.Pick(context.Background(), "claude", model, session, auths)
		if err != nil || got == nil || got.ID != want {
			t.Fatalf("%s: Pick() = %v, %v; want %s", step, got, err, want)
		}
	}
	pick("claude-sonnet-5", []*Auth{a, b}, a.ID, "sonnet conversation binds")
	pick(fableModel, []*Auth{a}, a.ID, "fable conversation binds")
	ObserveScopedWeeklyWindows(a.ID, now, map[string]ScopedWeeklyWindow{"fable": {UsedPercent: 100, ResetAt: now.Add(3 * day)}})
	pick("claude-sonnet-5", []*Auth{a, b}, a.ID, "a fable cap does not move a sonnet conversation")
	pick(fableModel, []*Auth{a}, a.ID, "the only account is kept")
}
