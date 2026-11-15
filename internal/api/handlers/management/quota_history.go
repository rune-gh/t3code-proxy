package management

// Quota history recorder endpoints (t3code fork addition). The recorder lives
// in internal/quotahistory; this file wires it to the handler's auth manager
// and to the same token/transport path APICall uses.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/quotahistory"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
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
			ListAuths: h.quotaHistoryAuths,
			Do:        h.quotaHistoryDo,
			Label:     authEmail,
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
	token, errToken := h.resolveTokenForAuth(ctx, auth, "")
	if token == "" {
		if errToken != nil {
			return 0, nil, errors.New("auth token refresh failed")
		}
		return 0, nil, errors.New("auth token not found")
	}
	req, errReq := http.NewRequestWithContext(ctx, method, url, nil)
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
