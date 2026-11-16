package management

// Quota history recorder endpoints (t3code fork addition). The recorder lives
// in internal/quotahistory; this file wires it to the handler's auth manager
// and to the same token/transport path APICall uses.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/quotahistory"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	"github.com/rune-oai/t3code-proxy/sdk/pluginapi"
	log "github.com/sirupsen/logrus"
)

const (
	quotaHistoryRefreshWait  = 60 * time.Second
	quotaHistoryMaxBodyBytes = 2 << 20
)

type quotaHistoryState struct {
	once sync.Once
	rec  *quotahistory.Recorder
}

func (h *Handler) quotaHistoryRecorder() *quotahistory.Recorder {
	h.quotaHistory.once.Do(func() {
		h.quotaHistory.rec = quotahistory.NewRecorder(quotahistory.Deps{
			ListAuths:       h.quotaHistoryAuths,
			Do:              h.quotaHistoryDo,
			DoRequest:       h.quotaHistoryRequest,
			PluginProviders: h.quotaHistoryPluginProviders,
			FetchPlugin:     h.quotaHistoryPlugin,
			Label:           authEmail,
		})
	})
	return h.quotaHistory.rec
}

// ApplyQuotaHistoryConfig starts, reconfigures or stops the quota history
// recorder from cfg. It must not be called while holding h.mu.
func (h *Handler) ApplyQuotaHistoryConfig(cfg *config.Config) {
	if h == nil {
		return
	}
	if cfg == nil || (!cfg.QuotaHistory.Enabled && !h.quotaHistoryRecorder().Enabled()) {
		return
	}
	settings, errSettings := quotahistory.SettingsFromConfig(cfg, h.configFilePath)
	if errSettings != nil {
		log.WithError(errSettings).Error("quota-history: recorder not started")
		settings.Enabled = false
	}
	if errApply := h.quotaHistoryRecorder().Apply(settings); errApply != nil {
		log.WithError(errApply).Error("quota-history: recorder not started")
	}
}

// CloseQuotaHistory stops the recorder and closes its database.
func (h *Handler) CloseQuotaHistory() {
	if h == nil {
		return
	}
	h.quotaHistoryRecorder().Close()
}

func (h *Handler) quotaHistoryAuths() []*coreauth.Auth {
	h.mu.Lock()
	manager := h.authManager
	h.mu.Unlock()
	if manager == nil {
		return nil
	}
	return manager.List()
}

// quotaHistoryDo sends one request with the credential's token, using the same
// token resolution and proxy selection as APICall.
func (h *Handler) quotaHistoryDo(ctx context.Context, auth *coreauth.Auth, method, url string, header map[string]string) (int, []byte, error) {
	return h.quotaHistoryRequest(ctx, auth, method, url, header, nil)
}

func (h *Handler) quotaHistoryRequest(ctx context.Context, auth *coreauth.Auth, method, url string, header map[string]string, data []byte) (int, []byte, error) {
	if auth == nil {
		return 0, nil, errors.New("auth token not found")
	}
	needsToken := !strings.EqualFold(auth.Provider, "meta") || bytes.Contains(data, []byte("$TOKEN$"))
	for _, value := range header {
		needsToken = needsToken || strings.Contains(value, "$TOKEN$")
	}
	// The hub's refresh loop renews OAuth tokens. A usage read never starts a
	// second refresh of the same token, which could invalidate a single-use
	// refresh token; it reports the account as due and reads it next round.
	if needsToken && quotaHistoryTokenRefreshDue(auth) {
		return 0, nil, errors.New("token refresh due")
	}
	var token string
	var errToken error
	if needsToken {
		// Credential acquisition has its own deadline. The usage request remains
		// cancellable by recorder shutdown without a network timeout.
		acquireCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		token, errToken = h.resolveTokenForAuth(acquireCtx, auth, "")
		cancel()
	}
	if needsToken && token == "" {
		if errToken != nil {
			return 0, nil, errors.New("auth token refresh failed")
		}
		return 0, nil, errors.New("auth token not found")
	}
	if needsToken && len(data) > 0 {
		// Replace JSON string values through a document so tokens are escaped.
		doc := ojson.NewDoc(data)
		if strings.EqualFold(auth.Provider, "devin") {
			if errSet := doc.Set("metadata.apiKey", token); errSet != nil {
				return 0, nil, errors.New("failed to build request")
			}
		}
		data = doc.Bytes()
	}
	req, errReq := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(data))
	if errReq != nil {
		return 0, nil, errors.New("failed to build request")
	}
	for key, value := range header {
		req.Header.Set(key, strings.ReplaceAll(value, "$TOKEN$", token))
	}
	client := &http.Client{Transport: h.apiCallTransport(auth, "")}
	resp, errDo := client.Do(req)
	if errDo != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return 0, nil, ctxErr
		}
		return 0, nil, errors.New("request failed")
	}
	defer func() {
		if errClose := resp.Body.Close(); errClose != nil {
			log.Errorf("quota-history: response body close error: %v", errClose)
		}
	}()
	body, errRead := io.ReadAll(io.LimitReader(resp.Body, quotaHistoryMaxBodyBytes))
	if errRead != nil {
		return resp.StatusCode, nil, errors.New("failed to read response")
	}
	return resp.StatusCode, body, nil
}

func quotaHistoryTokenRefreshDue(auth *coreauth.Auth) bool {
	switch strings.ToLower(strings.TrimSpace(auth.Provider)) {
	case "xai":
		return xaiRefreshToken(auth) != "" && (xaiTokenValue(auth) == "" || xaiOAuthTokenNeedsRefresh(auth))
	case "antigravity":
		return len(auth.Metadata) > 0 && (strings.TrimSpace(tokenValueFromMetadata(auth.Metadata)) == "" || antigravityTokenNeedsRefresh(auth.Metadata))
	}
	return false
}

func (h *Handler) quotaHistoryPluginProviders(ctx context.Context) map[string]string {
	h.mu.Lock()
	host := h.pluginHost
	h.mu.Unlock()
	if host == nil {
		return nil
	}
	return host.QuotaProviderPluginIDs(ctx)
}

func (h *Handler) quotaHistoryPlugin(ctx context.Context, auth *coreauth.Auth) ([]byte, error) {
	h.mu.Lock()
	host := h.pluginHost
	h.mu.Unlock()
	if host == nil {
		return nil, errors.New("no quota plugin")
	}
	response, handled, errFetch := host.FetchQuota(ctx, pluginapi.QuotaFetchRequest{
		AuthIndex: auth.Index, AuthID: auth.ID, Provider: auth.Provider,
		Metadata: auth.Metadata, Attributes: auth.Attributes,
	})
	if errFetch != nil || !handled {
		return nil, errors.New("plugin quota request failed")
	}
	doc := ojson.NewDocString(`{}`)
	if errSet := doc.Set("groups", response.Groups); errSet != nil {
		return nil, errors.New("invalid plugin quota groups")
	}
	if errSet := doc.Set("subscription", response.Subscription); errSet != nil {
		return nil, errors.New("invalid plugin quota subscription")
	}
	return doc.Bytes(), nil
}

// GetQuotaHistory returns recorded quota samples.
//
//	GET /v0/management/quota-history?since=<unix ms>&until=<unix ms>
//	GET /v8/management/quota-history?since=<unix ms>&until=<unix ms>
//
// Defaults: since = until - 14 days, until = now. When the recorder is disabled
// the response is 200 with "enabled": false and empty arrays.
func (h *Handler) GetQuotaHistory(c *gin.Context) {
	since, okSince := parseUnixMsQuery(c, "since")
	until, okUntil := parseUnixMsQuery(c, "until")
	if !okSince || !okUntil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "since and until must be unix milliseconds"})
		return
	}
	if since > 0 && until > 0 && since > until {
		c.JSON(http.StatusBadRequest, gin.H{"error": "since must not be after until"})
		return
	}
	history, errHistory := h.quotaHistoryRecorder().History(since, until)
	if errHistory != nil {
		log.WithError(errHistory).Warn("quota-history: query failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read quota history"})
		return
	}
	c.JSON(http.StatusOK, history)
}

// RefreshQuotaHistory polls every Claude/Codex account now.
//
//	POST /v0/management/quota-history/refresh
//	POST /v8/management/quota-history/refresh
//
// It returns when the poll finishes or after 60s with {"samples": n, "done": bool}.
// Returns 409 when the recorder is disabled.
func (h *Handler) RefreshQuotaHistory(c *gin.Context) {
	samples, done, errRefresh := h.quotaHistoryRecorder().Refresh(c.Request.Context(), quotaHistoryRefreshWait)
	if errors.Is(errRefresh, quotahistory.ErrDisabled) {
		c.JSON(http.StatusConflict, gin.H{"error": "quota history is disabled"})
		return
	}
	if errRefresh != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "refresh failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"samples": samples, "done": done})
}

func parseUnixMsQuery(c *gin.Context, key string) (int64, bool) {
	raw := strings.TrimSpace(c.Query(key))
	if raw == "" {
		return 0, true
	}
	v, errParse := strconv.ParseInt(raw, 10, 64)
	if errParse != nil || v < 0 {
		return 0, false
	}
	return v, true
}
