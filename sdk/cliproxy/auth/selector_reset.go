package auth

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

// SoonestResetFirstSelector spends the earliest weekly allowance first. The
// session-affinity wrapper keeps existing conversations on their bound account.
// A weekly reset is an absolute time, so an observation remains usable until
// that reset passes. Accounts without a usable reset whose last observation is
// absent or older than probeInterval are probed first, so every account gets
// observed after restarts and resets. Accounts that never report a weekly
// window keep round-robin behavior until the recorder publishes a reading.
//
// When the requested model is governed by a model-scoped weekly cap (see
// selector_reset_scoped.go), accounts whose latest observation shows that cap
// spent are skipped while another eligible account exists, and the scoped
// cap's reset replaces the overall weekly reset for ranking.
//
// Plan capacity (see plan_weight.go) shapes two decisions. Accounts whose
// plan-weighted 5-hour headroom is below routing.plan-headroom-reserve are
// skipped for new conversations while another eligible account has headroom
// (see plan_headroom.go). Where several accounts remain equal (tied resets,
// probes, or pools that report no quota), new conversations are spread in
// proportion to plan weight with smooth weighted round-robin, so a Max 20x
// account takes twenty conversations for every one on a Pro account. With equal
// weights this is plain round-robin in ID order.
type SoonestResetFirstSelector struct {
	mu sync.Mutex
	// credits holds the smooth weighted round-robin state per provider and model.
	credits map[string]map[string]float64
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
	// Skip accounts whose governing allowance for this model is spent. When every account
	// is spent, keep them all so ranking picks the one whose cap resets first.
	scoped := make(map[*Auth]scopedWeeklyState)
	usable := make([]*Auth, 0, len(available))
	for _, auth := range available {
		state, ok := governingQuotaWindowFor(auth, model, now)
		if ok {
			scoped[auth] = state
		}
		if !ok || !state.exhausted {
			usable = append(usable, auth)
		}
	}
	if len(usable) > 0 {
		available = usable
	} else if wait, ok := waitForCoolingSibling(ctx, scoped, model, now); ok {
		// Every account that can take the request is known to be spent, and one with
		// allowance left is only cooling down. Sending the request to a spent account
		// would hand the client that account's "limit reached until its reset" instead
		// of the short wait that is actually ahead.
		if provider == "mixed" {
			provider = ""
		}
		return nil, newModelCooldownError(model, provider, wait)
	}
	available = withShortWindowHeadroom(available, planHeadroomReserve(), now)
	type rankedAuth struct {
		auth  *Auth
		reset time.Time
	}
	var ranked []rankedAuth
	var probes []*Auth
	// Providers with a usage-only account that has no reading.
	unread := make(map[string]bool)
	for _, auth := range available {
		reset := observedWeeklyReset(auth, model, now)
		if state, ok := scoped[auth]; ok && (state.scoped || state.exhausted) {
			reset = state.reset
		}
		if !reset.IsZero() {
			ranked = append(ranked, rankedAuth{auth: auth, reset: reset})
			continue
		}
		// A usage-only account gets readings only from the recorder.
		if !quotaObservationCanProbe(auth) {
			unread[strings.ToLower(auth.Provider)] = true
			continue
		}
		if observed := lastObservation(auth, model); observed.IsZero() || now.Sub(observed) > probeInterval {
			probes = append(probes, auth)
		}
	}
	// While one account of a usage-only provider has no reading, ranking its
	// siblings would starve it, so that provider is left out of ranking. Other
	// providers in the same pool are still ranked.
	var earliest time.Time
	var candidates []*Auth
	for _, entry := range ranked {
		if unread[strings.ToLower(entry.auth.Provider)] {
			continue
		}
		if earliest.IsZero() || entry.reset.Before(earliest) {
			earliest = entry.reset
			candidates = []*Auth{entry.auth}
		} else if entry.reset.Equal(earliest) {
			candidates = append(candidates, entry.auth)
		}
	}
	switch {
	case len(probes) > 0:
		return s.pickWeighted(provider, model, probes), nil
	case len(candidates) > 0:
		return s.pickWeighted(provider, model, candidates), nil
	default:
		return s.pickWeighted(provider, model, available), nil
	}
}

// coolingCandidate is an account kept out of a pick only until a known time: a
// quota cooldown, or the hold after a transient upstream error.
type coolingCandidate struct {
	auth  *Auth
	until time.Time
}

type coolingCandidatesKey struct{}

// withCoolingCandidates tells the selector which candidates are cooling down.
// The manager hands selectors only the available accounts, so without this a
// selector cannot tell "every account is spent" from "the account with
// allowance left is unavailable for a moment".
func withCoolingCandidates(ctx context.Context, cooling []coolingCandidate) context.Context {
	if len(cooling) == 0 {
		return ctx
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, coolingCandidatesKey{}, cooling)
}

// waitForCoolingSibling reports how long to wait when a cooling account still
// has allowance: until the first such account is back, or until the first
// spent account resets if that comes sooner. spent holds the governing state
// of the available accounts, all of which are exhausted.
func waitForCoolingSibling(ctx context.Context, spent map[*Auth]scopedWeeklyState, model string, now time.Time) (time.Duration, bool) {
	if ctx == nil {
		return 0, false
	}
	cooling, _ := ctx.Value(coolingCandidatesKey{}).([]coolingCandidate)
	var back time.Time
	for _, candidate := range cooling {
		if candidate.auth == nil || !candidate.until.After(now) {
			continue
		}
		if state, ok := governingQuotaWindowFor(candidate.auth, model, now); ok && state.exhausted {
			continue
		}
		if back.IsZero() || candidate.until.Before(back) {
			back = candidate.until
		}
	}
	if back.IsZero() {
		return 0, false
	}
	for _, state := range spent {
		if state.exhausted && state.reset.After(now) && state.reset.Before(back) {
			back = state.reset
		}
	}
	return back.Sub(now), true
}

// maxWeightedKeys bounds the number of provider/model credit tables kept.
const maxWeightedKeys = 4096

// pickWeighted picks one of auths with smooth weighted round-robin by plan
// weight: every candidate earns its weight, the richest is picked (ties go to
// the lowest ID) and pays the candidates' total. The result is deterministic
// and spreads picks in proportion to weight. Credits of accounts outside the
// current candidate set are dropped, so a set change starts them fresh.
func (s *SoonestResetFirstSelector) pickWeighted(provider, model string, auths []*Auth) *Auth {
	if len(auths) == 1 {
		return auths[0]
	}
	ordered := make([]*Auth, len(auths))
	copy(ordered, auths)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	key := provider + ":" + canonicalModelLookupKey(model)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.credits == nil || (s.credits[key] == nil && len(s.credits) >= maxWeightedKeys) {
		s.credits = make(map[string]map[string]float64)
	}
	previous := s.credits[key]
	credits := make(map[string]float64, len(ordered))
	var total float64
	var picked *Auth
	for _, auth := range ordered {
		weight := PlanWeightOf(auth)
		total += weight
		credits[auth.ID] = previous[auth.ID] + weight
		if picked == nil || credits[auth.ID] > credits[picked.ID] {
			picked = auth
		}
	}
	credits[picked.ID] -= total
	s.credits[key] = credits
	return picked
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

// lastObservation is the time of the newest passive reading. Usage polls do
// not count: a poll that carries no usable reset arrives every interval and
// would otherwise keep an account from ever being probed.
func lastObservation(auth *Auth, model string) time.Time {
	return latestQuota(auth, model).ObservedAt
}

// observedWeeklyReset returns the reset used to rank the account: the polled
// governing window, or the weekly reset from response headers when those are
// newer (a window can reset early) or no poll exists.
func observedWeeklyReset(auth *Auth, model string, now time.Time) time.Time {
	passive := passiveWeeklyReset(auth, model, now)
	state, ok := observedGoverningWindow(auth, model, now)
	if !ok || (!passive.IsZero() && latestQuota(auth, model).ObservedAt.After(state.observedAt)) {
		return passive
	}
	return state.reset
}

// passiveWeeklyReset reads the weekly reset from passive response headers.
func passiveWeeklyReset(auth *Auth, model string, now time.Time) time.Time {
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
