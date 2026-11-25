package auth

import (
	"context"
	"net/http"
	"time"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

type antigravityModelStateContextKey struct{}

func (m *Manager) withAntigravityModelState(ctx context.Context, auth *Auth) context.Context {
	if m == nil || auth == nil || auth.Provider != "antigravity" || !m.localExecutionAllowed() {
		return ctx
	}
	return context.WithValue(ctx, antigravityModelStateContextKey{}, m)
}

// CheckAntigravityTargetModel checks model-level admission for a late variant
// without reinterpreting credential-level admission or reopening the catalog.
func CheckAntigravityTargetModel(ctx context.Context, auth *Auth, model string, now time.Time, useCredits bool) error {
	if ctx != nil && auth != nil {
		if m, ok := ctx.Value(antigravityModelStateContextKey{}).(*Manager); ok {
			m.mu.RLock()
			defer m.mu.RUnlock()
			// The source model's scheduler shard may have an older copy of the
			// target state. Use the live state only for the same credential.
			if current := m.auths[auth.ID]; current != nil && current.RegistrationEpoch == auth.RegistrationEpoch && current.CredentialVersion == auth.CredentialVersion {
				auth = current
			}
		}
	}
	if state := existingModelState(auth, model); state != nil {
		blocked, _, next := availabilityBlock(state.Unavailable, state.Quota.Exceeded, state.NextRetryAfter, state.Quota.NextRecoverAt, now)
		if state.Status == StatusDisabled || (blocked && next.IsZero()) {
			return &Error{Message: "selected Antigravity model is unavailable", HTTPStatus: http.StatusServiceUnavailable}
		}
		if blocked && !(useCredits && antigravityCreditsAllowsTargetQuota(auth, state, now)) {
			return &trustedRetryAfterError{cause: newModelCooldownError(model, "antigravity", next.Sub(now)), deadline: next}
		}
	}
	return nil
}

// An admitted credits retry can pay for model quota, but not bypass an
// independent, forced, or credential-level cooldown on the selected variant.
func antigravityCreditsAllowsTargetQuota(auth *Auth, state *ModelState, now time.Time) bool {
	if auth == nil || state == nil {
		return false
	}
	if auth.Disabled || auth.Status == StatusDisabled || hasUnauthorizedAuthFailure(auth) ||
		!state.Quota.Exceeded || state.Quota.Reason != "quota" || !state.Quota.NextRecoverAt.After(now) ||
		state.NextRetryAfter.After(state.Quota.NextRecoverAt) || effectiveModelForceUntil(state).After(now) {
		return false
	}
	if state.LastError == nil {
		return true
	}
	return state.LastError.HTTPStatus == http.StatusTooManyRequests || state.LastError.HTTPStatus == http.StatusServiceUnavailable
}

const antigravityTargetRejectedCode = "antigravity_target_rejected"

type antigravityTargetRejectedError struct{ error }

func (e antigravityTargetRejectedError) Unwrap() error { return e.error }

// RejectAntigravityTarget marks an already-blocked target as a routing miss,
// preserving the status and retry information without generating new feedback.
func RejectAntigravityTarget(err error) error {
	return antigravityTargetRejectedError{error: err}
}

func antigravityResultModel(ctx context.Context, result Result) string {
	if result.Provider != "antigravity" {
		return ""
	}
	return canonicalModelKey(cliproxyexecutor.UpstreamAttemptModel(ctx))
}

func antigravityTargetRejected(result Result) bool {
	return result.Provider == "antigravity" && result.Error != nil && result.Error.Code == antigravityTargetRejectedCode
}
