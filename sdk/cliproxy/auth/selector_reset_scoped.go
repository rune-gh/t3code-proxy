package auth

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

// Model-scoped weekly caps.
//
// Claude accounts carry weekly caps that apply only to one model family (for
// example the Fable and Opus weekly windows) next to the overall 7-day window.
// Anthropic names each such window after the family it governs: the unified
// rate-limit headers use "Anthropic-Ratelimit-Unified-7d_<family>-*" and the
// OAuth usage endpoint reports "seven_day_<family>" (and weekly_scoped limits
// keyed by model display name). The family token is matched against the tokens
// of the requested model ID, so no per-model list is maintained here: a window
// named "7d_fable" governs "claude-fable-5-1", and a window whose name matches
// no model token (such as "7d_oi", overage included) governs nothing.

// ScopedWeeklyWindow is one reading of a model-scoped weekly cap.
type ScopedWeeklyWindow struct {
	// UsedPercent is the used share of the cap, 0-100.
	UsedPercent float64
	// ResetAt is when the cap resets. Readings without a reset are ignored.
	ResetAt time.Time
}

type scopedWeeklyReading struct {
	observedAt time.Time
	windows    map[string]ScopedWeeklyWindow
}

var scopedWeeklyReadings = struct {
	sync.RWMutex
	byAuth map[string]scopedWeeklyReading
}{byAuth: make(map[string]scopedWeeklyReading)}

// ObserveScopedWeeklyWindows records the model-scoped weekly caps of one
// account, keyed by family token (for example "fable" or "opus"), replacing
// any previous reading for that account. The quota-history recorder publishes
// its usage-endpoint readings here so the soonest-reset-first selector can see
// a spent scoped cap before a request is sent to that account.
func ObserveScopedWeeklyWindows(authID string, observedAt time.Time, windows map[string]ScopedWeeklyWindow) {
	authID = strings.TrimSpace(authID)
	if authID == "" || observedAt.IsZero() {
		return
	}
	normalized := make(map[string]ScopedWeeklyWindow, len(windows))
	for scope, window := range windows {
		if scope = strings.ToLower(strings.TrimSpace(scope)); scope != "" && !window.ResetAt.IsZero() {
			normalized[scope] = window
		}
	}
	scopedWeeklyReadings.Lock()
	defer scopedWeeklyReadings.Unlock()
	if previous, ok := scopedWeeklyReadings.byAuth[authID]; ok && previous.observedAt.After(observedAt) {
		return
	}
	scopedWeeklyReadings.byAuth[authID] = scopedWeeklyReading{observedAt: observedAt, windows: normalized}
}

// ForgetScopedWeeklyWindows drops the recorded scoped readings of an account.
func ForgetScopedWeeklyWindows(authID string) {
	scopedWeeklyReadings.Lock()
	delete(scopedWeeklyReadings.byAuth, strings.TrimSpace(authID))
	scopedWeeklyReadings.Unlock()
}

// scopedWeeklyState is the newest usable observation of the scoped cap that
// governs a model on one account.
type scopedWeeklyState struct {
	exhausted  bool
	reset      time.Time
	observedAt time.Time
}

// modelScopeTokens splits a model ID into lower-case alphanumeric tokens.
func modelScopeTokens(model string) map[string]struct{} {
	tokens := make(map[string]struct{})
	for _, token := range strings.FieldsFunc(strings.ToLower(model), func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < '0' || r > '9')
	}) {
		tokens[token] = struct{}{}
	}
	return tokens
}

// scopedWeeklyWindowFor returns the newest observation, with a reset still in
// the future, of a Claude model-scoped weekly cap governing model. Accounts of
// other providers and models without a matching window return ok=false.
func scopedWeeklyWindowFor(auth *Auth, model string, now time.Time) (scopedWeeklyState, bool) {
	if auth == nil || !strings.EqualFold(strings.TrimSpace(auth.Provider), "claude") || strings.TrimSpace(model) == "" {
		return scopedWeeklyState{}, false
	}
	tokens := modelScopeTokens(model)
	var best scopedWeeklyState
	found := false
	consider := func(state scopedWeeklyState) {
		if state.observedAt.IsZero() || state.observedAt.After(now) || state.reset.IsZero() {
			return
		}
		if !found || state.observedAt.After(best.observedAt) {
			best, found = state, true
		}
	}

	consider(scopedStateFromSignals(auth.Quota, tokens, now))
	for _, modelState := range auth.ModelStates {
		if modelState != nil {
			consider(scopedStateFromSignals(modelState.Quota, tokens, now))
		}
	}

	scopedWeeklyReadings.RLock()
	reading, ok := scopedWeeklyReadings.byAuth[auth.ID]
	scopedWeeklyReadings.RUnlock()
	if ok {
		for scope, window := range reading.windows {
			if _, match := tokens[scope]; !match || !window.ResetAt.After(now) || window.ResetAt.Sub(now) > 8*24*time.Hour {
				continue
			}
			consider(scopedWeeklyState{exhausted: window.UsedPercent >= 100, reset: window.ResetAt, observedAt: reading.observedAt})
		}
	}
	return best, found
}

// scopedStateFromSignals reads a "7d_<family>" window from passive Claude
// response headers when the family is one of the model's tokens.
func scopedStateFromSignals(quota QuotaState, tokens map[string]struct{}, now time.Time) scopedWeeklyState {
	if quota.ObservedAt.IsZero() || len(quota.Signals) == 0 {
		return scopedWeeklyState{}
	}
	const prefix = "anthropic-ratelimit-unified-7d_"
	signals := make(map[string]string, len(quota.Signals))
	for key, value := range quota.Signals {
		signals[strings.ToLower(key)] = strings.TrimSpace(value)
	}
	var state scopedWeeklyState
	for key := range signals {
		rest, hasPrefix := strings.CutPrefix(key, prefix)
		if !hasPrefix {
			continue
		}
		scope, field, hasField := strings.Cut(rest, "-")
		if !hasField || field != "reset" {
			continue
		}
		if _, match := tokens[scope]; !match {
			continue
		}
		reset := futureResetTime(signals[prefix+scope+"-reset"], now)
		if reset.IsZero() {
			continue
		}
		exhausted := strings.EqualFold(signals[prefix+scope+"-status"], "rejected")
		if utilization, errParse := strconv.ParseFloat(signals[prefix+scope+"-utilization"], 64); errParse == nil && utilization >= 1 {
			exhausted = true
		}
		// Several matching windows are unlikely; prefer an exhausted one.
		if state.reset.IsZero() || (exhausted && !state.exhausted) {
			state = scopedWeeklyState{exhausted: exhausted, reset: reset, observedAt: quota.ObservedAt}
		}
	}
	return state
}
