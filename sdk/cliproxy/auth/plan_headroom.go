package auth

import (
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Plan-weighted short-window headroom.
//
// Claude and Codex accounts carry a 5-hour window next to the weekly one. A new
// conversation started on an account whose 5-hour window is nearly spent hits
// that limit within a few turns. Absolute headroom is the account's plan weight
// times its remaining percent, so 10% left on a Pro account is 10 while 10% left
// on a Max 20x account is 200: a small plan is considered tight far earlier.
// Only readings the hub already has are used: passive response headers and the
// usage-endpoint readings published through ObserveShortWindowUsage.

// shortWindowLength is the length of the Claude and Codex short window.
const shortWindowLength = 5 * time.Hour

// shortWindowReading is one observation of an account's 5-hour window.
type shortWindowReading struct {
	usedPercent float64
	resetAt     time.Time
	observedAt  time.Time
}

var shortWindowReadings = struct {
	sync.RWMutex
	byAuth map[string]shortWindowReading
}{byAuth: make(map[string]shortWindowReading)}

// ObserveShortWindowUsage records a usage-endpoint reading of an account's
// 5-hour window: usedPercent is 0-100 and resetAt may be zero when unknown. An
// older reading never replaces a newer one.
func ObserveShortWindowUsage(authID string, observedAt time.Time, usedPercent float64, resetAt time.Time) {
	authID = strings.TrimSpace(authID)
	if authID == "" || observedAt.IsZero() || math.IsNaN(usedPercent) || math.IsInf(usedPercent, 0) {
		return
	}
	shortWindowReadings.Lock()
	defer shortWindowReadings.Unlock()
	if previous, ok := shortWindowReadings.byAuth[authID]; ok && previous.observedAt.After(observedAt) {
		return
	}
	shortWindowReadings.byAuth[authID] = shortWindowReading{usedPercent: usedPercent, resetAt: resetAt, observedAt: observedAt}
}

// ForgetShortWindowUsage drops the recorded usage reading of an account.
func ForgetShortWindowUsage(authID string) {
	shortWindowReadings.Lock()
	delete(shortWindowReadings.byAuth, strings.TrimSpace(authID))
	shortWindowReadings.Unlock()
}

// shortWindowFor returns the newest still-current reading of the account's
// 5-hour window. A reading whose reset has passed, or that is older than one
// window when its reset is unknown, is not current: the window has refilled.
func shortWindowFor(auth *Auth, now time.Time) (shortWindowReading, bool) {
	if auth == nil {
		return shortWindowReading{}, false
	}
	var best shortWindowReading
	found := false
	consider := func(reading shortWindowReading, ok bool) {
		if !ok || reading.observedAt.IsZero() || reading.observedAt.After(now) {
			return
		}
		if reading.resetAt.IsZero() {
			if now.Sub(reading.observedAt) > shortWindowLength {
				return
			}
		} else if !reading.resetAt.After(now) {
			return
		}
		if !found || reading.observedAt.After(best.observedAt) {
			best, found = reading, true
		}
	}
	consider(shortWindowFromSignals(auth.Provider, auth.Quota))
	for _, state := range auth.ModelStates {
		if state != nil {
			consider(shortWindowFromSignals(auth.Provider, state.Quota))
		}
	}
	shortWindowReadings.RLock()
	reading, ok := shortWindowReadings.byAuth[auth.ID]
	shortWindowReadings.RUnlock()
	consider(reading, ok)
	return best, found
}

// shortWindowFromSignals reads the 5-hour window from passive response headers.
func shortWindowFromSignals(provider string, quota QuotaState) (shortWindowReading, bool) {
	if quota.ObservedAt.IsZero() || len(quota.Signals) == 0 {
		return shortWindowReading{}, false
	}
	signal := func(name string) string { return strings.TrimSpace(quota.Signals[name]) }
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "claude":
		const prefix = "Anthropic-Ratelimit-Unified-5h-"
		reading := shortWindowReading{observedAt: quota.ObservedAt, usedPercent: -1}
		// Utilization is a fraction (0-1) in the unified headers.
		if utilization, errParse := strconv.ParseFloat(signal(prefix+"Utilization"), 64); errParse == nil && !math.IsNaN(utilization) && !math.IsInf(utilization, 0) {
			reading.usedPercent = utilization * 100
		}
		if strings.EqualFold(signal(prefix+"Status"), "rejected") {
			reading.usedPercent = 100
		}
		if reading.usedPercent < 0 {
			return shortWindowReading{}, false
		}
		reading.resetAt = parseResetInstant(signal(prefix + "Reset"))
		return reading, true
	case "codex":
		for _, window := range []string{"Primary", "Secondary"} {
			prefix := "X-Codex-" + window + "-"
			minutes, errMinutes := strconv.ParseFloat(signal(prefix+"Window-Minutes"), 64)
			if errMinutes != nil || minutes != shortWindowLength.Minutes() {
				continue
			}
			used, errUsed := strconv.ParseFloat(signal(prefix+"Used-Percent"), 64)
			if errUsed != nil || math.IsNaN(used) || math.IsInf(used, 0) {
				continue
			}
			reading := shortWindowReading{observedAt: quota.ObservedAt, usedPercent: used}
			if reading.resetAt = parseResetInstant(signal(prefix + "Reset-At")); !reading.resetAt.IsZero() {
				return reading, true
			}
			if after, errAfter := strconv.ParseFloat(signal(prefix+"Reset-After-Seconds"), 64); errAfter == nil && after > 0 && after <= shortWindowLength.Seconds() {
				reading.resetAt = quota.ObservedAt.Add(time.Duration(after * float64(time.Second)))
			}
			return reading, true
		}
	}
	return shortWindowReading{}, false
}

// parseResetInstant parses an RFC 3339 or unix-seconds reset time. Unlike
// futureResetTime it keeps resets that have passed, so a stale reading is
// recognized as refilled instead of being treated as having no reset.
func parseResetInstant(raw string) time.Time {
	if reset, errParse := time.Parse(time.RFC3339, raw); errParse == nil {
		return reset
	}
	if seconds, errParse := strconv.ParseInt(raw, 10, 64); errParse == nil && seconds > 0 {
		return time.Unix(seconds, 0)
	}
	return time.Time{}
}

// shortWindowHeadroom returns the account's plan-weighted 5-hour headroom
// (plan weight x remaining percent) and whether a current reading exists.
func shortWindowHeadroom(auth *Auth, now time.Time) (float64, bool) {
	reading, ok := shortWindowFor(auth, now)
	if !ok {
		return 0, false
	}
	remaining := math.Max(0, math.Min(100, 100-reading.usedPercent))
	return PlanWeightOf(auth) * remaining, true
}

// withShortWindowHeadroom drops accounts whose plan-weighted 5-hour headroom is
// below reserve, as long as at least one account keeps enough headroom (or has
// no current reading). It returns auths unchanged when reserve is not positive
// or every account is tight. It is applied to new conversations only: the
// session-affinity wrapper does not consult the inner selector for a bound
// conversation whose account is still available.
func withShortWindowHeadroom(auths []*Auth, reserve float64, now time.Time) []*Auth {
	if reserve <= 0 || len(auths) < 2 {
		return auths
	}
	roomy := make([]*Auth, 0, len(auths))
	for _, auth := range auths {
		if headroom, ok := shortWindowHeadroom(auth, now); !ok || headroom >= reserve {
			roomy = append(roomy, auth)
		}
	}
	if len(roomy) == 0 {
		return auths
	}
	return roomy
}
