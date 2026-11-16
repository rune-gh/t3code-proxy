package auth

import (
	"math"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

// QuotaWindow is a renewing allowance read from a provider's usage endpoint.
type QuotaWindow struct {
	Key         string
	UsedPercent float64
	ResetAt     time.Time
	Period      time.Duration
	// ModelScope contains model IDs or path.Match patterns. Empty means all models.
	ModelScope []string
}

type quotaWindowReading struct {
	observedAt time.Time
	windows    []QuotaWindow
}

var quotaWindowReadings = struct {
	sync.RWMutex
	byAuth map[string]quotaWindowReading
}{byAuth: make(map[string]quotaWindowReading)}

// ObserveQuotaWindows replaces an account's usage reading, including an empty
// reading. Older observations cannot replace newer ones. Inputs are copied.
func ObserveQuotaWindows(authID string, observedAt time.Time, windows []QuotaWindow) {
	authID = strings.TrimSpace(authID)
	if authID == "" || observedAt.IsZero() {
		return
	}
	normalized := make([]QuotaWindow, 0, len(windows))
	for _, window := range windows {
		if window.Key == "" || window.Period <= 0 || window.ResetAt.IsZero() || math.IsNaN(window.UsedPercent) || math.IsInf(window.UsedPercent, 0) || window.UsedPercent < 0 {
			continue
		}
		window.ModelScope = append([]string(nil), window.ModelScope...)
		normalized = append(normalized, window)
	}
	quotaWindowReadings.Lock()
	defer quotaWindowReadings.Unlock()
	if previous := quotaWindowReadings.byAuth[authID]; previous.observedAt.After(observedAt) {
		return
	}
	quotaWindowReadings.byAuth[authID] = quotaWindowReading{observedAt: observedAt, windows: normalized}
}

// ObservedQuotaWindows returns an independent copy of the latest account reading.
func ObservedQuotaWindows(authID string) (time.Time, []QuotaWindow) {
	quotaWindowReadings.RLock()
	reading := quotaWindowReadings.byAuth[strings.TrimSpace(authID)]
	quotaWindowReadings.RUnlock()
	windows := append([]QuotaWindow(nil), reading.windows...)
	for i := range windows {
		windows[i].ModelScope = append([]string(nil), windows[i].ModelScope...)
	}
	return reading.observedAt, windows
}

// ForgetQuotaWindows removes an account's usage-endpoint observations.
func ForgetQuotaWindows(authID string) {
	quotaWindowReadings.Lock()
	delete(quotaWindowReadings.byAuth, strings.TrimSpace(authID))
	quotaWindowReadings.Unlock()
}

func quotaWindowMatches(window QuotaWindow, model string) bool {
	if len(window.ModelScope) == 0 {
		return true
	}
	model = strings.ToLower(strings.TrimSpace(model))
	for _, scope := range window.ModelScope {
		if match, _ := path.Match(strings.ToLower(scope), model); match {
			return true
		}
	}
	return false
}

// passiveUsage is one allowance window read from passive response headers.
type passiveUsage struct {
	period      time.Duration
	scoped      bool
	usedPercent float64
}

// passiveWindowUsage returns the windows that the newest passive observation of
// the account reports for model, when that observation is newer than after.
// Only Claude and Codex send such headers.
func passiveWindowUsage(auth *Auth, model string, after time.Time) []passiveUsage {
	quota := latestQuota(auth, model)
	if !quota.ObservedAt.After(after) || len(quota.Signals) == 0 {
		return nil
	}
	signals := make(map[string]string, len(quota.Signals))
	for key, value := range quota.Signals {
		signals[strings.ToLower(key)] = strings.TrimSpace(value)
	}
	number := func(key string) (float64, bool) {
		value, errParse := strconv.ParseFloat(signals[key], 64)
		return value, errParse == nil && !math.IsNaN(value) && !math.IsInf(value, 0)
	}
	var out []passiveUsage
	switch strings.ToLower(strings.TrimSpace(auth.Provider)) {
	case "claude":
		const prefix = "anthropic-ratelimit-unified-"
		tokens := modelScopeTokens(model)
		for key := range signals {
			name, isUtilization := strings.CutSuffix(key, "-utilization")
			name, hasPrefix := strings.CutPrefix(name, prefix)
			if !isUtilization || !hasPrefix {
				continue
			}
			usage := passiveUsage{period: 7 * 24 * time.Hour}
			switch family, scoped := strings.CutPrefix(name, "7d_"); {
			case name == "5h":
				usage.period = shortWindowLength
			case name == "7d":
			case scoped:
				if _, match := tokens[family]; !match {
					continue
				}
				usage.scoped = true
			default:
				continue
			}
			// Utilization is a fraction (0-1) in the unified headers.
			fraction, ok := number(key)
			if !ok {
				continue
			}
			usage.usedPercent = fraction * 100
			if strings.EqualFold(signals[prefix+name+"-status"], "rejected") {
				usage.usedPercent = 100
			}
			out = append(out, usage)
		}
	case "codex":
		for _, window := range []string{"primary", "secondary"} {
			minutes, okMinutes := number("x-codex-" + window + "-window-minutes")
			used, okUsed := number("x-codex-" + window + "-used-percent")
			if okMinutes && okUsed && minutes > 0 {
				out = append(out, passiveUsage{period: time.Duration(minutes * float64(time.Minute)), usedPercent: used})
			}
		}
	}
	return out
}

// passiveShowsHeadroom reports whether a newer passive observation shows the
// same window with allowance left, which happens when a window resets early.
func passiveShowsHeadroom(passive []passiveUsage, window QuotaWindow) bool {
	for _, usage := range passive {
		difference := usage.period - window.Period
		if difference < 0 {
			difference = -difference
		}
		if usage.scoped == (len(window.ModelScope) > 0) && difference <= window.Period/10 && usage.usedPercent < 100 {
			return true
		}
	}
	return false
}

// observedGoverningWindow reads the account's polled windows for model. The
// longest window that governs the model gives the reset used for ranking. The
// account is exhausted when any governing window is spent, unless a newer
// passive observation shows that window with allowance left; its reset is then
// the time the last spent window renews.
func observedGoverningWindow(auth *Auth, model string, now time.Time) (scopedWeeklyState, bool) {
	observedAt, windows := ObservedQuotaWindows(auth.ID)
	if observedAt.IsZero() || observedAt.After(now) {
		return scopedWeeklyState{}, false
	}
	passive := passiveWindowUsage(auth, model, observedAt)
	var best QuotaWindow
	var usableAt time.Time
	for _, window := range windows {
		if !quotaWindowMatches(window, model) || !window.ResetAt.After(now) || window.ResetAt.Sub(now) > window.Period+24*time.Hour || now.Sub(observedAt) > window.Period+24*time.Hour {
			continue
		}
		if window.UsedPercent >= 100 && !passiveShowsHeadroom(passive, window) && window.ResetAt.After(usableAt) {
			usableAt = window.ResetAt
		}
		if best.Period > window.Period {
			continue
		}
		if best.Period == window.Period {
			// Prefer a model-scoped cap over an account-wide cap of equal length.
			if len(best.ModelScope) > 0 && len(window.ModelScope) == 0 {
				continue
			}
			if (len(best.ModelScope) > 0) == (len(window.ModelScope) > 0) && !window.ResetAt.Before(best.ResetAt) {
				continue
			}
		}
		best = window
	}
	if best.Period == 0 {
		return scopedWeeklyState{}, false
	}
	state := scopedWeeklyState{reset: best.ResetAt, observedAt: observedAt, scoped: len(best.ModelScope) > 0}
	if !usableAt.IsZero() {
		state.exhausted, state.reset = true, usableAt
	}
	return state, true
}

// governingQuotaWindowFor combines the polled windows with Claude's
// model-scoped weekly cap, which is also read from response headers. The scoped
// cap decides ranking; a poll replaces a header reading of it only when the
// poll is newer and itself read a scoped cap for the model. Another spent
// window from the poll still marks the account exhausted.
func governingQuotaWindowFor(auth *Auth, model string, now time.Time) (scopedWeeklyState, bool) {
	state, ok := observedGoverningWindow(auth, model, now)
	scoped, hasScoped := scopedWeeklyWindowFor(auth, model, now)
	if !hasScoped {
		return state, ok
	}
	scoped.scoped = true
	if !ok {
		return scoped, true
	}
	if state.scoped && state.observedAt.After(scoped.observedAt) {
		return state, true
	}
	if state.exhausted && !scoped.exhausted {
		scoped.exhausted, scoped.reset = true, state.reset
	}
	return scoped, true
}

// quotaObservationCanProbe reports whether serving a request yields a reset
// the selector can rank by. Only Claude and Codex send one in response
// headers; every other provider is ranked from the quota-history recorder.
func quotaObservationCanProbe(auth *Auth) bool {
	provider := strings.ToLower(strings.TrimSpace(auth.Provider))
	return provider == "claude" || provider == "codex"
}
