package auth

import "time"

// A conversation bound by session affinity keeps its account while that
// account is available. A spent model-scoped weekly cap (see
// selector_reset_scoped.go) does not make the account unavailable in the
// scheduler, so without this check the bound conversation would be sent once,
// get a 429, and only then rebind. When the hub already knows the cap is spent
// and another eligible account exists, the session-affinity wrapper treats the
// spent account as unavailable for that model and rebinds before sending.

// scopedWeeklyCapSpent reports whether the newest observation of the allowance
// governing model on auth shows it spent. It uses the same lookup as the
// soonest-reset-first selector, so it covers Claude's model-scoped weekly caps
// and the recorded windows of every other provider.
func scopedWeeklyCapSpent(auth *Auth, model string, now time.Time) bool {
	state, ok := governingQuotaWindowFor(auth, model, now)
	return ok && state.exhausted
}

// withoutSpentScopedWeeklyCaps drops accounts whose model-scoped weekly cap is
// known spent, as long as at least one account remains. When every account is
// spent the list is returned unchanged so the inner selector can still choose.
func withoutSpentScopedWeeklyCaps(auths []*Auth, model string, now time.Time) []*Auth {
	if len(auths) < 2 {
		return auths
	}
	usable := make([]*Auth, 0, len(auths))
	for _, auth := range auths {
		if !scopedWeeklyCapSpent(auth, model, now) {
			usable = append(usable, auth)
		}
	}
	if len(usable) == 0 || len(usable) == len(auths) {
		return auths
	}
	return usable
}

// boundAuthScopedWeeklyCapSpent reports whether the bound account authID, found
// in candidates, has a spent model-scoped weekly cap for model.
func boundAuthScopedWeeklyCapSpent(candidates []*Auth, model, authID string, now time.Time) bool {
	for _, candidate := range candidates {
		if candidate != nil && candidate.ID == authID {
			return scopedWeeklyCapSpent(candidate, model, now)
		}
	}
	return false
}
