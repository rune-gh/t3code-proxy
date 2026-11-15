package auth

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

// SoonestResetFirstSelector spends the earliest weekly allowance first. The
// session-affinity wrapper keeps existing conversations on their bound account.
// A weekly reset is an absolute time, so an observation remains usable until
// that reset passes. Accounts without a usable reset whose last observation is
// absent or older than probeInterval are probed first, so every account gets
// observed after restarts and resets. Accounts that never report a weekly
// window, such as Grok or Antigravity, therefore keep round-robin behavior.
//
// When the requested model is governed by a model-scoped weekly cap (see
// selector_reset_scoped.go), accounts whose latest observation shows that cap
// spent are skipped while another eligible account exists, and the scoped
// cap's reset replaces the overall weekly reset for ranking.
type SoonestResetFirstSelector struct {
	fallback RoundRobinSelector
	// now overrides the clock in tests.
	now func() time.Time
}

func (s *SoonestResetFirstSelector) Pick(ctx context.Context, provider, model string, opts cliproxyexecutor.Options, auths []*Auth) (*Auth, error) {
	now := time.Now()
	if s.now != nil {
		now = s.now()
	}
	available, err := getSelectorAvailableAuths(ctx, auths, provider, model, now)
	if err != nil {
		return nil, err
	}
	available = preferCodexWebsocketAuths(ctx, provider, available)
	// Skip accounts whose scoped cap for this model is spent. When every account
	// is spent, keep them all so ranking picks the one whose cap resets first.
	scoped := make(map[*Auth]scopedWeeklyState)
	usable := make([]*Auth, 0, len(available))
	for _, auth := range available {
		state, ok := scopedWeeklyWindowFor(auth, model, now)
		if ok {
			scoped[auth] = state
		}
		if !ok || !state.exhausted {
			usable = append(usable, auth)
		}
	}
	if len(usable) > 0 {
		available = usable
	}
	var earliest time.Time
	var candidates, probes []*Auth
	for _, auth := range available {
		reset := observedWeeklyReset(auth, model, now)
		if state, ok := scoped[auth]; ok {
			reset = state.reset
		}
		if reset.IsZero() {
			// Only providers that report quota can produce an observation; others (Grok,
			// Antigravity) would otherwise stay probes forever and win every mixed pool.
			if !ProviderSupportsQuotaObservation(auth.Provider) {
				continue
			}
			if observed := lastObservation(auth, model); observed.IsZero() || now.Sub(observed) > probeInterval {
				probes = append(probes, auth)
			}
			continue
		}
		if earliest.IsZero() || reset.Before(earliest) {
			earliest = reset
			candidates = []*Auth{auth}
		} else if reset.Equal(earliest) {
			candidates = append(candidates, auth)
		}
	}
	switch {
	case len(probes) > 0:
		return s.fallback.Pick(ctx, provider, model, opts, probes)
	case len(candidates) > 0:
		return s.fallback.Pick(ctx, provider, model, opts, candidates)
	default:
		return s.fallback.Pick(ctx, provider, model, opts, available)
	}
}

// probeInterval bounds how often an account without a usable weekly reset is
// preferred so a fresh observation can be collected.
const probeInterval = time.Hour

func latestQuota(auth *Auth, model string) QuotaState {
	quota := auth.Quota
	if state := existingModelState(auth, model); state != nil && state.Quota.ObservedAt.After(quota.ObservedAt) {
		quota = state.Quota
	}
	return quota
}

func lastObservation(auth *Auth, model string) time.Time {
	return latestQuota(auth, model).ObservedAt
}

func observedWeeklyReset(auth *Auth, model string, now time.Time) time.Time {
	quota := latestQuota(auth, model)
	// futureResetTime rejects resets that have passed or exceed one week.
	if quota.ObservedAt.IsZero() || quota.ObservedAt.After(now) || now.Sub(quota.ObservedAt) > 8*24*time.Hour {
		return time.Time{}
	}
	headers := make(http.Header, len(quota.Signals))
	for key, value := range quota.Signals {
		headers.Set(key, value)
	}
	switch strings.ToLower(auth.Provider) {
	case "claude":
		return futureResetTime(headers.Get("Anthropic-Ratelimit-Unified-7d-Reset"), now)
	case "codex":
		for _, window := range []string{"Primary", "Secondary"} {
			prefix := "X-Codex-" + window + "-"
			minutes, errParse := strconv.ParseFloat(headers.Get(prefix+"Window-Minutes"), 64)
			if errParse != nil || minutes != 7*24*60 {
				continue
			}
			if reset := futureResetTime(headers.Get(prefix+"Reset-At"), now); !reset.IsZero() {
				return reset
			}
			seconds, errSeconds := strconv.ParseFloat(headers.Get(prefix+"Reset-After-Seconds"), 64)
			if errSeconds == nil && seconds > 0 && seconds <= 8*24*60*60 {
				reset := quota.ObservedAt.Add(time.Duration(seconds * float64(time.Second)))
				if reset.After(now) {
					return reset
				}
			}
		}
	}
	return time.Time{}
}

func futureResetTime(raw string, now time.Time) time.Time {
	reset, errParse := time.Parse(time.RFC3339, raw)
	if errParse != nil {
		seconds, errSeconds := strconv.ParseInt(raw, 10, 64)
		if errSeconds != nil || seconds <= 0 {
			return time.Time{}
		}
		reset = time.Unix(seconds, 0)
	}
	if !reset.After(now) || reset.Sub(now) > 8*24*time.Hour {
		return time.Time{}
	}
	return reset
}
