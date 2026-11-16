package management

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/watcher/synthesizer"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

func TestQuotaHistoryMistralAPIKeyEndpoint(t *testing.T) {
	budget := `{"vibe_budget":{"usage_percentage":0.0,"initial_budget":150.0,"currency":"USD","reset_at":"2026-12-01T00:00:00Z","payg_enabled":false},"api_budget":{"usage_percentage":2.59892596,"initial_budget":15.0,"currency":"USD","reset_at":"2026-12-01T00:00:00Z","payg_enabled":false},"usage_percentage":2.59892596,"initial_budget":15.0,"currency":"USD","reset_at":"2026-12-01T00:00:00Z"}`
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "GET" || (req.Host != "api.mistral.ai" && req.Host != "console.mistral.ai") || req.Header.Get("Authorization") != "Bearer fixture-mistral-key" {
			t.Error("billing request must use the upstream's own Bearer key and host")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch req.URL.Path {
		case "/v1/billing/budget":
			_, _ = w.Write([]byte(budget))
		case "/v1/billing/subscription":
			_, _ = w.Write([]byte(`{"plan_name":"EDU","payg_enabled":false,"vibe_payg_enabled":false,"enterprise":false}`))
		case "/api/vibe/whoami":
			_, _ = w.Write([]byte(`{"customer_id":"fixture-customer"}`))
		default:
			t.Errorf("unexpected billing path %q", req.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)
	// Route the real billing URLs to the TLS fixture while exercising the
	// management transport's credential substitution and HTTP request path.
	transport := upstream.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig.ServerName = "127.0.0.1"
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
	}
	previous := http.DefaultTransport
	http.DefaultTransport = transport
	t.Cleanup(func() {
		http.DefaultTransport = previous
		transport.CloseIdleConnections()
	})
	dir := t.TempDir()
	cfg := &config.Config{
		AuthDir:      filepath.Join(dir, "auths"),
		QuotaHistory: config.QuotaHistoryConfig{Enabled: true, Providers: []string{"mistral"}},
		OpenAICompatibility: []config.OpenAICompatibility{
			{Name: "Campus account", BaseURL: "https://api.mistral.ai/v1", APIKeyEntries: []config.OpenAICompatibilityAPIKey{{APIKey: "fixture-mistral-key"}}},
			{Name: "mistral", BaseURL: "https://other.example/v1", APIKeyEntries: []config.OpenAICompatibilityAPIKey{{APIKey: "fixture-other-key"}}},
		},
	}
	auths, err := synthesizer.NewConfigSynthesizer().Synthesize(&synthesizer.SynthesisContext{Config: cfg, Now: time.Now(), IDGenerator: synthesizer.NewStableIDGenerator()})
	if err != nil {
		t.Fatal(err)
	}
	manager := coreauth.NewManager(nil, nil, nil)
	for _, auth := range auths {
		if _, errRegister := manager.Register(context.Background(), auth); errRegister != nil {
			t.Fatal(errRegister)
		}
	}
	h := NewHandler(cfg, filepath.Join(dir, "config.yaml"), manager)
	h.ApplyQuotaHistoryConfig(cfg)
	t.Cleanup(h.CloseQuotaHistory)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/v8/management/quota-history", h.GetQuotaHistory)
	router.POST("/v8/management/quota-history/refresh", h.RefreshQuotaHistory)
	router.GET("/v0/management/auth-files", h.ListAuthFiles)
	request := func(method, path string) ojson.Result {
		t.Helper()
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(method, path, nil))
		if response.Code != http.StatusOK || !ojson.ValidBytes(response.Body.Bytes()) {
			t.Fatalf("%s %s = %d %s", method, path, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "fixture-") {
			t.Fatal("history response leaked an API key")
		}
		return ojson.Parse(response.Body.String())
	}
	if files := request("GET", "/v0/management/auth-files").Get("files"); !files.IsArray() || len(files.Array()) != 0 {
		t.Fatal("API-key upstreams must stay out of auth-files")
	}
	if refresh := request("POST", "/v8/management/quota-history/refresh"); refresh.Get("samples").Int() != 1 || !refresh.Get("done").Bool() {
		t.Fatalf("refresh = %s", refresh.Raw)
	}
	history := request("GET", "/v8/management/quota-history")
	if len(history.Get("accounts").Array()) != 1 || len(history.Get("samples").Array()) != 1 {
		t.Fatalf("history = %s", history.Raw)
	}
	account, sample := history.Get("accounts.0"), history.Get("samples.0")
	if account.Get("provider").String() != "mistral" || account.Get("label").String() != "Campus account" || account.Get("plan").String() != "EDU" || account.Get("weight").Float() != 1 || account.Get("auth_index").String() == "" || account.Get("auth_index").String() != sample.Get("auth_index").String() {
		t.Fatalf("account = %s", account.Raw)
	}
	now := time.UnixMilli(sample.Get("t").Int()).UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	hours := start.AddDate(0, 1, 0).Sub(start).Hours()
	for _, tc := range []struct {
		id, label    string
		budget, used float64
	}{
		{"api_monthly", "API usage", 15, 2.59892596},
		{"vibe_monthly", "Vibe Code", 150, 0},
	} {
		window := sample.Get("windows." + tc.id)
		if window.Get("budget").Float() != tc.budget || window.Get("currency").String() != "USD" || window.Get("used_percent").Float() != tc.used || window.Get("label").String() != tc.label || window.Get("period_hours").Float() != hours || window.Get("resets_at").Int() != 1796083200000 {
			t.Errorf("window = %s", window.Raw)
		}
	}
	t.Logf("history account %s", account.Raw)
	t.Logf("history sample %s", sample.Raw)
	if files := request("GET", "/v0/management/auth-files").Get("files"); len(files.Array()) != 0 {
		t.Fatal("polling exposed API-key upstreams in auth-files")
	}
}

func TestQuotaHistoryAPIKeyUsesAccountProxy(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.String() != "http://api.mistral.ai/v1/billing/budget" || req.Header.Get("Authorization") != "Bearer fixture-proxy-key" {
			t.Error("proxy did not receive the authenticated billing request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(proxy.Close)
	h := NewHandler(&config.Config{SDKConfig: config.SDKConfig{ProxyURL: "http://127.0.0.1:1"}}, "", nil)
	auth := &coreauth.Auth{ID: t.Name(), Provider: "openai-compatible-campus", ProxyURL: proxy.URL, Attributes: map[string]string{"api_key": "fixture-proxy-key"}}
	status, _, err := h.quotaHistoryRequest(context.Background(), auth, "GET", "http://api.mistral.ai/v1/billing/budget", map[string]string{"Authorization": "Bearer $TOKEN$"}, nil)
	if err != nil || status != http.StatusOK {
		t.Fatalf("request through account proxy = %d, %v", status, err)
	}
}
