package management

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/quotahistory"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

func quotaHistoryRouter(h *Handler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/quota-history", h.GetQuotaHistory)
	r.POST("/quota-history/refresh", h.RefreshQuotaHistory)
	return r
}

func serve(t *testing.T, r http.Handler, method, target string) (int, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(method, target, nil))
	var body map[string]any
	if errUnmarshal := json.Unmarshal(w.Body.Bytes(), &body); errUnmarshal != nil {
		t.Fatalf("%s %s: invalid JSON %q", method, target, w.Body.String())
	}
	return w.Code, body
}

func TestQuotaHistoryDisabled(t *testing.T) {
	h := NewHandler(&config.Config{}, filepath.Join(t.TempDir(), "config.yaml"), nil)
	h.ApplyQuotaHistoryConfig(&config.Config{})
	r := quotaHistoryRouter(h)

	code, body := serve(t, r, http.MethodGet, "/quota-history")
	if code != http.StatusOK || body["enabled"] != false {
		t.Fatalf("GET = %d %v", code, body)
	}
	if accounts, ok := body["accounts"].([]any); !ok || len(accounts) != 0 {
		t.Fatalf("accounts = %v", body["accounts"])
	}
	if samples, ok := body["samples"].([]any); !ok || len(samples) != 0 {
		t.Fatalf("samples = %v", body["samples"])
	}
	if _, ok := body["interval_seconds"]; !ok {
		t.Fatalf("interval_seconds missing: %v", body)
	}
	if _, ok := body["now"]; !ok {
		t.Fatalf("now missing: %v", body)
	}

	if code, body = serve(t, r, http.MethodPost, "/quota-history/refresh"); code != http.StatusConflict {
		t.Fatalf("refresh = %d %v", code, body)
	}
}

func TestQuotaHistoryRejectsPathInsideAuthDir(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{AuthDir: filepath.Join(dir, "auths")}
	cfg.QuotaHistory = config.QuotaHistoryConfig{Enabled: true, Path: filepath.Join(dir, "auths", "qh.db")}
	h := NewHandler(cfg, filepath.Join(dir, "config.yaml"), nil)
	h.ApplyQuotaHistoryConfig(cfg)
	t.Cleanup(h.CloseQuotaHistory)
	if h.quotaHistoryRecorder().Enabled() {
		t.Fatal("recorder must not start with a path inside auth-dir")
	}
}

func TestQuotaHistoryEndpoints(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{AuthDir: filepath.Join(dir, "auths")}
	cfg.QuotaHistory = config.QuotaHistoryConfig{Enabled: true, Interval: "15m"}
	h := NewHandler(cfg, filepath.Join(dir, "config.yaml"), nil)
	auth := &coreauth.Auth{ID: "a", Index: "idx-1", Provider: "codex", Metadata: map[string]any{"email": "u@example.com", "access_token": "tok"}}
	h.quotaHistory.once.Do(func() {
		h.quotaHistory.rec = quotahistory.NewRecorder(quotahistory.Deps{
			ListAuths: func() []*coreauth.Auth { return []*coreauth.Auth{auth.Clone()} },
			Do: func(_ context.Context, _ *coreauth.Auth, _, _ string, _ map[string]string) (int, []byte, error) {
				return 200, []byte(`{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":12.5,"limit_window_seconds":18000,"reset_at":1731610000}}}`), nil
			},
			Label: authEmail,
		})
	})
	h.ApplyQuotaHistoryConfig(cfg)
	t.Cleanup(h.CloseQuotaHistory)
	r := quotaHistoryRouter(h)

	if code, _ := serve(t, r, http.MethodGet, "/quota-history?since=abc"); code != http.StatusBadRequest {
		t.Fatalf("bad since = %d", code)
	}
	if code, _ := serve(t, r, http.MethodGet, "/quota-history?since=5&until=4"); code != http.StatusBadRequest {
		t.Fatalf("inverted range = %d", code)
	}

	code, body := serve(t, r, http.MethodPost, "/quota-history/refresh")
	if code != http.StatusOK || body["samples"] != 1.0 || body["done"] != true {
		t.Fatalf("refresh = %d %v", code, body)
	}

	code, body = serve(t, r, http.MethodGet, "/quota-history")
	if code != http.StatusOK || body["enabled"] != true || body["interval_seconds"] != 900.0 {
		t.Fatalf("GET = %d %v", code, body)
	}
	accounts := body["accounts"].([]any)
	if len(accounts) != 1 {
		t.Fatalf("accounts = %v", accounts)
	}
	account := accounts[0].(map[string]any)
	if account["auth_index"] != "idx-1" || account["provider"] != "codex" || account["label"] != "u@example.com" || account["plan"] != "plus" || account["disabled"] != false {
		t.Fatalf("account = %v", account)
	}
	samples := body["samples"].([]any)
	if len(samples) != 1 {
		t.Fatalf("samples = %v", samples)
	}
	sample := samples[0].(map[string]any)
	window := sample["windows"].(map[string]any)["five_hour"].(map[string]any)
	if _, exists := window["budget"]; exists {
		t.Fatalf("legacy window gained a budget: %v", window)
	}
	if _, exists := window["currency"]; exists {
		t.Fatalf("legacy window gained a currency: %v", window)
	}
	if sample["auth_index"] != "idx-1" || sample["error"] != "" || window["used_percent"] != 12.5 || window["resets_at"] != 1731610000000.0 || window["period_hours"] != 5.0 {
		t.Fatalf("sample = %v", sample)
	}
	if _, ok := sample["t"].(float64); !ok {
		t.Fatalf("sample t missing: %v", sample)
	}

	// A range in the past excludes the sample but still lists accounts.
	past := time.Now().Add(-48 * time.Hour).UnixMilli()
	_, body = serve(t, r, http.MethodGet, "/quota-history?since=1&until="+jsonNumber(past))
	if len(body["samples"].([]any)) != 0 || len(body["accounts"].([]any)) != 1 {
		t.Fatalf("past range = %v", body)
	}

	// Disabling through config hot-reload stops the recorder.
	cfg.QuotaHistory.Enabled = false
	h.ApplyQuotaHistoryConfig(cfg)
	if code, _ = serve(t, r, http.MethodPost, "/quota-history/refresh"); code != http.StatusConflict {
		t.Fatalf("refresh after disable = %d", code)
	}
}

func jsonNumber(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestQuotaHistoryDoInjectsToken(t *testing.T) {
	var gotAuth, gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotAuth = req.Header.Get("Authorization")
		gotUA = req.Header.Get("User-Agent")
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	h := NewHandler(&config.Config{}, "", nil)
	auth := &coreauth.Auth{ID: "a", Provider: "claude", Metadata: map[string]any{"access_token": "secret-token"}}
	status, body, errDo := h.quotaHistoryDo(context.Background(), auth, http.MethodGet, srv.URL, map[string]string{
		"Authorization": "Bearer $TOKEN$",
		"User-Agent":    "test-agent",
	})
	if errDo != nil || status != http.StatusTeapot || string(body) != `{"ok":true}` {
		t.Fatalf("do = %d %q %v", status, body, errDo)
	}
	if gotAuth != "Bearer secret-token" || gotUA != "test-agent" {
		t.Fatalf("headers = %q %q", gotAuth, gotUA)
	}

	if _, _, errDo = h.quotaHistoryDo(context.Background(), &coreauth.Auth{ID: "b", Provider: "claude"}, http.MethodGet, srv.URL, nil); errDo == nil {
		t.Fatal("missing token must fail")
	}
}
