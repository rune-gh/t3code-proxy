package auth

import (
	"context"
	"testing"
	"time"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

// Session affinity over soonest-reset-first: a bound conversation keeps its
// account (prompt caches are per account) even when another account now
// resets sooner, and moves only when the bound account becomes unavailable.
func TestSoonestResetFirstSessionAffinity(t *testing.T) {
	const model = "claude-sonnet-5"
	for _, rebindOn := range []string{SessionAffinityRebindOnAny, SessionAffinityRebindOnQuota} {
		t.Run(rebindOn, func(t *testing.T) {
			now := time.Now()
			day := 24 * time.Hour
			a := resetAuth("a", "claude", now.Add(4*day))
			b := resetAuth("b", "claude", now.Add(day))
			auths := []*Auth{a, b}
			selector := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{
				Fallback: &SoonestResetFirstSelector{},
				TTL:      time.Hour,
				RebindOn: rebindOn,
			})
			t.Cleanup(selector.Stop)
			session := cliproxyexecutor.Options{OriginalRequest: []byte(`{"metadata":{"user_id":"user_xxx_account__session_ac980658-63bd-4fb3-97ba-8da64cb1e344"}}`)}
			other := cliproxyexecutor.Options{OriginalRequest: []byte(`{"metadata":{"user_id":"user_xxx_account__session_0f1e2d3c-4b5a-4968-8776-655443322110"}}`)}
			pick := func(opts cliproxyexecutor.Options, want, step string) {
				t.Helper()
				got, err := selector.Pick(context.Background(), "claude", model, opts, auths)
				if err != nil || got == nil || got.ID != want {
					t.Fatalf("%s: Pick() = %v, %v; want %s", step, got, err, want)
				}
			}

			pick(session, "b", "new conversation binds to soonest reset")
			// a now resets sooner than b.
			a.Quota = resetAuth("a", "claude", now.Add(time.Hour)).Quota
			pick(other, "a", "a new conversation follows the new ranking")
			for range 3 {
				pick(session, "b", "bound conversation stays on its account across turns")
			}

			// b hits its limit for this model: the conversation moves.
			future := now.Add(2 * day)
			b.ModelStates = map[string]*ModelState{model: {
				Status:         StatusError,
				Unavailable:    true,
				NextRetryAfter: future,
				Quota:          QuotaState{Exceeded: true, Reason: "quota", NextRecoverAt: future},
				LastError:      &Error{HTTPStatus: 429, Message: "rate limited"},
			}}
			pick(session, "a", "exhausted bound account fails over")

			// After b recovers the conversation stays on its new account.
			b.ModelStates = nil
			for range 2 {
				pick(session, "a", "rebound conversation stays after old account recovers")
			}

			// A disabled bound account also fails over.
			a.Disabled = true
			pick(session, "b", "disabled bound account fails over")
		})
	}
}
