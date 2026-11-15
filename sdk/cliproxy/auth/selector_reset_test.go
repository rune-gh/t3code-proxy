package auth

import (
	"context"
	"fmt"
	"testing"
	"time"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

func resetAuth(id, provider string, reset time.Time) *Auth {
	signals := map[string]string{"Anthropic-Ratelimit-Unified-7d-Reset": fmt.Sprint(reset.Unix())}
	if provider == "codex" {
		signals = map[string]string{
			"X-Codex-Secondary-Window-Minutes": "10080",
			"X-Codex-Secondary-Reset-At":       fmt.Sprint(reset.Unix()),
		}
	}
	return &Auth{ID: id, Provider: provider, Quota: QuotaState{ObservedAt: time.Now().Add(-time.Minute), Signals: signals}}
}

func TestSoonestResetFirst(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			now := time.Now()
			later := resetAuth("a", provider, now.Add(4*24*time.Hour))
			sooner := resetAuth("b", provider, now.Add(24*time.Hour))
			selector := &SoonestResetFirstSelector{}
			pick := func(want string) {
				t.Helper()
				got, err := selector.Pick(context.Background(), provider, "", cliproxyexecutor.Options{}, []*Auth{later, sooner})
				if err != nil || got == nil || got.ID != want {
					t.Fatalf("Pick() = %v, %v; want %s", got, err, want)
				}
			}
			rotates := func() {
				t.Helper()
				seen := map[string]bool{}
				for range 2 {
					got, err := selector.Pick(context.Background(), provider, "", cliproxyexecutor.Options{}, []*Auth{later, sooner})
					if err != nil || got == nil {
						t.Fatalf("Pick() = %v, %v", got, err)
					}
					seen[got.ID] = true
				}
				if len(seen) != 2 {
					t.Fatalf("expected rotation across both accounts, got %v", seen)
				}
			}
			pick("b")
			pick("b")
			sooner.Disabled = true
			pick("a")
			sooner.Disabled = false
			sooner.Quota.ObservedAt = now.Add(-2 * time.Hour)
			pick("b") // A reset stays valid until it passes, regardless of observation age.
			sooner.Quota.Signals = map[string]string{}
			pick("b") // An account without a usable reset and a stale observation is probed.
			sooner.Quota.ObservedAt = now
			pick("a") // A freshly probed account without a weekly window yields to ranked peers.
			sooner.Quota = QuotaState{}
			pick("b") // Never-observed accounts are probed after restarts.
			later.Quota = QuotaState{}
			rotates() // Round robin among unobserved accounts.
			later = resetAuth("a", provider, now.Add(4*24*time.Hour))
			sooner = resetAuth("b", provider, now.Add(4*24*time.Hour))
			rotates() // Equal resets rotate.
		})
	}
}

func TestWeeklyResetParsing(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	for _, raw := range []string{"", "NaN", "Inf", "-1", "999999999999999999999", fmt.Sprint(now.Unix()), now.Add(9 * 24 * time.Hour).Format(time.RFC3339)} {
		if !futureResetTime(raw, now).IsZero() {
			t.Fatalf("accepted invalid reset %q", raw)
		}
	}
	auth := resetAuth("a", "codex", now.Add(time.Hour))
	auth.Quota.ObservedAt = now.Add(-time.Minute)
	auth.Quota.Signals = map[string]string{"X-Codex-Primary-Window-Minutes": "10080", "X-Codex-Primary-Reset-After-Seconds": "3600"}
	if got := observedWeeklyReset(auth, "", now); !got.Equal(now.Add(59 * time.Minute)) {
		t.Fatalf("relative reset = %v", got)
	}
	auth.Quota.Signals["X-Codex-Primary-Window-Minutes"] = "300"
	if !observedWeeklyReset(auth, "", now).IsZero() {
		t.Fatal("five-hour window treated as weekly")
	}
}

func TestSoonestResetFirstIgnoresUnobservableProvidersInMixedPools(t *testing.T) {
	now := time.Now()
	claude := resetAuth("claude", "claude", now.Add(24*time.Hour))
	antigravity := &Auth{ID: "antigravity", Provider: "antigravity"}
	selector := &SoonestResetFirstSelector{}
	for range 5 {
		got, err := selector.Pick(context.Background(), "", "", cliproxyexecutor.Options{}, []*Auth{antigravity, claude})
		if err != nil || got == nil || got.ID != "claude" {
			t.Fatalf("Pick() = %v, %v; want claude", got, err)
		}
	}
	// A pool of only unobservable providers keeps plain round-robin.
	xai := &Auth{ID: "xai", Provider: "xai"}
	seen := map[string]bool{}
	for range 2 {
		got, err := selector.Pick(context.Background(), "", "", cliproxyexecutor.Options{}, []*Auth{antigravity, xai})
		if err != nil || got == nil {
			t.Fatalf("Pick() = %v, %v", got, err)
		}
		seen[got.ID] = true
	}
	if len(seen) != 2 {
		t.Fatalf("expected rotation across unobservable accounts, got %v", seen)
	}
}
