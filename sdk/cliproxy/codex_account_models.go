package cliproxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/rune-oai/t3code-proxy/internal/registry"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

// Codex account model discovery asks each ChatGPT (Codex OAuth) credential for
// the models it can use, so models OpenAI ships before the community catalogs
// list them (for example gpt-6.2-sol) still reach clients. The registry merges
// the answers; see internal/registry/codex_account_models.go.

const (
	codexAccountModelsURL      = "https://chatgpt.com/backend-api/codex/models"
	codexAccountModelsMaxBytes = 8 << 20
	codexAccountModelsOrigin   = "codex-tui"
	codexAccountModelsAgent    = "codex-tui/0.169.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.169.0)"
	// codexAccountModelsMinInterval stops re-registrations from re-reading a
	// credential's models; the periodic sweep runs every ModelsRefreshInterval.
	codexAccountModelsMinInterval = time.Hour
	// codexAccountModelsRetryInterval is the wait after a failed read, for
	// example while an expired access token is being refreshed.
	codexAccountModelsRetryInterval = 10 * time.Minute
)

// codexAccountModelsState tracks model list reads per credential ID.
type codexAccountModelsState struct {
	mu       sync.Mutex
	inFlight map[string]struct{}
	next     map[string]time.Time
	now      func() time.Time
}

func (st *codexAccountModelsState) clock() time.Time {
	if st.now != nil {
		return st.now()
	}
	return time.Now()
}

// claim reserves a read for authID unless one is running or not yet due.
func (st *codexAccountModelsState) claim(authID string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, running := st.inFlight[authID]; running {
		return false
	}
	if due, ok := st.next[authID]; ok && st.clock().Before(due) {
		return false
	}
	if st.inFlight == nil {
		st.inFlight = make(map[string]struct{})
	}
	st.inFlight[authID] = struct{}{}
	return true
}

// finish releases authID and schedules its next read; forget drops its state.
func (st *codexAccountModelsState) finish(authID string, wait time.Duration, forget bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.inFlight, authID)
	if forget {
		delete(st.next, authID)
		return
	}
	if st.next == nil {
		st.next = make(map[string]time.Time)
	}
	st.next[authID] = st.clock().Add(wait)
}

// codexAccountModelsEligible reports whether a credential can list Codex
// models: an enabled ChatGPT login, not an API key.
func codexAccountModelsEligible(a *coreauth.Auth) bool {
	return a != nil && a.ID != "" && !a.Disabled &&
		strings.EqualFold(strings.TrimSpace(a.Provider), "codex") &&
		a.AuthKind() == coreauth.AuthKindOAuth
}

// serviceLifetime returns the context of the running service, or nil before Run.
func (s *Service) serviceLifetime() context.Context {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.antigravityContext
}

// refreshCodexAccountModelsAsync reads the credential's model list in the
// background when a read is due. It does nothing before the service runs.
func (s *Service) refreshCodexAccountModelsAsync(a *coreauth.Auth) {
	if s == nil || s.coreManager == nil || !codexAccountModelsEligible(a) || !registry.CodexAccountModelDiscoveryEnabled() {
		return
	}
	lifetime := s.serviceLifetime()
	if lifetime == nil || lifetime.Err() != nil {
		return
	}
	authID := a.ID
	if !s.codexAccountModels.claim(authID) {
		return
	}
	go func() {
		wait, forget := codexAccountModelsMinInterval, false
		if errRefresh := s.refreshCodexAccountModels(lifetime, authID); errRefresh != nil {
			wait = codexAccountModelsRetryInterval
			forget = errors.Is(errRefresh, errCodexAccountGone)
			if lifetime.Err() == nil && !forget {
				log.WithError(errRefresh).WithField("auth_id", authID).Debug("codex account models: read failed")
			}
		}
		s.codexAccountModels.finish(authID, wait, forget)
	}()
}

var errCodexAccountGone = errors.New("codex account no longer eligible")

// refreshCodexAccountModels reads one credential's model list and merges it.
func (s *Service) refreshCodexAccountModels(ctx context.Context, authID string) error {
	auth, ok := s.coreManager.GetByID(authID)
	if !ok || !codexAccountModelsEligible(auth) {
		return errCodexAccountGone
	}
	query := url.Values{"client_version": {registry.CodexAccountModelsClientVersion}}
	req, errReq := http.NewRequestWithContext(ctx, http.MethodGet, codexAccountModelsURL+"?"+query.Encode(), nil)
	if errReq != nil {
		return errReq
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Originator", codexAccountModelsOrigin)
	req.Header.Set("User-Agent", codexAccountModelsAgent)
	if accountID, _ := auth.Metadata["account_id"].(string); strings.TrimSpace(accountID) != "" {
		req.Header.Set("Chatgpt-Account-Id", strings.TrimSpace(accountID))
	}
	resp, errDo := s.coreManager.HttpRequest(ctx, auth, req)
	if errDo != nil {
		return errDo
	}
	body, errRead := io.ReadAll(io.LimitReader(resp.Body, codexAccountModelsMaxBytes+1))
	if errClose := resp.Body.Close(); errClose != nil {
		log.WithError(errClose).Debug("codex account models: close response body")
	}
	if errRead != nil {
		return errRead
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		// The body can echo account details; report the status only.
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if len(body) > codexAccountModelsMaxBytes {
		return fmt.Errorf("response exceeds %d bytes", codexAccountModelsMaxBytes)
	}
	changed, errMerge := registry.MergeCodexAccountModels(auth.Attributes["plan_type"], body)
	if errMerge != nil {
		return errMerge
	}
	if changed {
		log.WithField("auth_id", authID).Info("codex account models: added models the catalog does not list yet")
	}
	return nil
}

// startCodexAccountModelsRefresher re-reads every Codex credential's model
// list on the shared catalog cadence until ctx ends.
func (s *Service) startCodexAccountModelsRefresher(ctx context.Context) {
	if s == nil || s.coreManager == nil {
		return
	}
	go func() {
		ticker := time.NewTicker(registry.ModelsRefreshInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				for _, auth := range s.coreManager.List() {
					s.refreshCodexAccountModelsAsync(auth)
				}
			}
		}
	}()
}
