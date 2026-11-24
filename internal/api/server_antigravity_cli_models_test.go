package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/home"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/runtime/executor"
	_ "github.com/rune-oai/t3code-proxy/internal/thinking/provider/antigravity"
	_ "github.com/rune-oai/t3code-proxy/internal/translator"
	"github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	"github.com/rune-oai/t3code-proxy/sdk/pluginapi"
)

const testAntigravityCLIUA = "antigravity/cli/1.5.14 (aidev_client; os_type=linux; arch=amd64; auth_method=gateway)"

func registerAntigravityCLICatalogForTest(t *testing.T, server *Server) *auth.Auth {
	t.Helper()
	a := &auth.Auth{
		ID:       "antigravity-cli-test-auth",
		Provider: "antigravity",
		Status:   auth.StatusActive,
		Metadata: map[string]any{
			"access_token": "test-access-token",
			"expired":      time.Now().Add(24 * time.Hour).Format(time.RFC3339),
			"project_id":   "test-project",
		},
	}
	if _, errRegister := server.handlers.AuthManager.Register(context.Background(), a); errRegister != nil {
		t.Fatal(errRegister)
	}
	models := []*registry.ModelInfo{
		{
			ID:                  "claude-opus-4-6-thinking",
			DisplayName:         "Claude Opus 4.6 (Thinking)",
			Description:         "Claude Opus 4.6 (Thinking)",
			ContextLength:       200000,
			MaxCompletionTokens: 64000,
			OwnedBy:             "antigravity",
			Type:                "antigravity",
			Thinking:            &registry.ThinkingSupport{Min: 1024, Max: 64000, ZeroAllowed: true, DynamicAllowed: true},
		},
		{
			ID:                  "claude-opus-5-5-high",
			DisplayName:         "Claude Opus 5.5 (High)",
			Description:         "Claude Opus 5.5 (High)",
			ContextLength:       1000000,
			MaxCompletionTokens: 128000,
			OwnedBy:             "antigravity",
			Type:                "antigravity",
			Thinking:            &registry.ThinkingSupport{Min: 1024, Max: 64000, ZeroAllowed: true, DynamicAllowed: true, Levels: []string{"low", "medium", "high"}},
		},
		{
			ID:                  "gemini-4-hydrogen-xhigh",
			DisplayName:         "Gemini 4 Hydrogen",
			Description:         "Gemini 4 Hydrogen (XHigh)",
			ContextLength:       1048576,
			MaxCompletionTokens: 1048576,
			OwnedBy:             "antigravity",
			Type:                "antigravity",
			Thinking:            &registry.ThinkingSupport{Min: 1, Max: 65535, DynamicAllowed: true, Levels: []string{"low", "medium", "high", "xhigh"}},
		},
		// Forked alias alongside upstream model — should collapse to one model group.
		{
			ID:                  "gemini-4-hydrogen",
			MetadataModelID:     "gemini-4-hydrogen-xhigh",
			DisplayName:         "Gemini 4 Hydrogen",
			Description:         "Gemini 4 Hydrogen (XHigh)",
			ContextLength:       1048576,
			MaxCompletionTokens: 1048576,
			OwnedBy:             "antigravity",
			Type:                "antigravity",
			Thinking:            &registry.ThinkingSupport{Min: 1, Max: 65535, DynamicAllowed: true, Levels: []string{"low", "medium", "high", "xhigh"}},
		},
		{
			ID:                  "gemini-3-flash",
			DisplayName:         "Gemini 3 Flash",
			Description:         "Gemini 3 Flash",
			ContextLength:       1048576,
			MaxCompletionTokens: 65536,
			OwnedBy:             "antigravity",
			Type:                "antigravity",
			Thinking:            &registry.ThinkingSupport{Min: 128, Max: 32768, DynamicAllowed: true, Levels: []string{"minimal", "low", "medium", "high"}},
		},
		{
			ID:                  "gpt-oss-120b-medium",
			DisplayName:         "GPT-OSS 120B (Medium)",
			Description:         "GPT-OSS 120B (Medium)",
			ContextLength:       114000,
			MaxCompletionTokens: 32768,
			OwnedBy:             "antigravity",
			Type:                "antigravity",
		},
	}
	registry.GetGlobalRegistry().RegisterClient(a.ID, "antigravity", models)
	t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(a.ID) })
	return a
}

func TestAntigravityCLIGeminiModelsEndpoint(t *testing.T) {
	server := newTestServer(t)
	registerAntigravityCLICatalogForTest(t, server)

	// Antigravity CLI User-Agent receives expanded effort variants and deduplicated aliases.
	cliResp := scopedRequest(server, http.MethodGet, "/provider/antigravity/v1beta/models", "", map[string]string{
		"User-Agent": testAntigravityCLIUA,
	})
	if cliResp.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", cliResp.Code, cliResp.Body.String())
	}
	if !strings.Contains(strings.ToLower(cliResp.Header().Get("Vary")), "user-agent") {
		t.Fatalf("expected Vary: User-Agent, got %q", cliResp.Header().Get("Vary"))
	}

	var listBody struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(cliResp.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("unmarshal CLI models: %v", err)
	}
	byName := make(map[string]map[string]any, len(listBody.Models))
	for _, m := range listBody.Models {
		name, _ := m["name"].(string)
		byName[name] = m
		if strings.Contains(name, "(minimal)") {
			t.Fatalf("unsupported level leaked into CLI catalog: %q", name)
		}
	}

	if gotFirst := listBody.Models[0]["name"]; gotFirst != "models/claude-opus-4-6-thinking(low)" {
		t.Fatalf("first model = %v, want models/claude-opus-4-6-thinking(low)", gotFirst)
	}
	for _, lvl := range []string{"low", "medium", "high"} {
		entry, ok := byName["models/claude-opus-5-5-high("+lvl+")"]
		if !ok || entry["displayName"] != "Claude Opus 5.5 ("+lvl+")" {
			t.Fatalf("claude-opus-5-5-high(%s) = %#v", lvl, entry)
		}
	}
	for _, lvl := range []string{"low", "medium", "high", "xhigh"} {
		entry, ok := byName["models/gemini-4-hydrogen-xhigh("+lvl+")"]
		if !ok || entry["displayName"] != "Gemini 4 Hydrogen ("+lvl+")" {
			t.Fatalf("gemini-4-hydrogen-xhigh(%s) = %#v", lvl, entry)
		}
		if _, dup := byName["models/gemini-4-hydrogen("+lvl+")"]; dup {
			t.Fatalf("duplicate alias models/gemini-4-hydrogen(%s) should be collapsed", lvl)
		}
	}
	if _, ok := byName["models/gpt-oss-120b-medium"]; !ok {
		t.Fatalf("non-thinking model gpt-oss-120b-medium missing")
	}

	// Single-model GET supports expanded names (bare or models/-prefixed) and 404s unknown models.
	for _, path := range []string{
		"/provider/antigravity/v1beta/models/claude-opus-5-5-high(high)",
		"/provider/antigravity/v1beta/models/models/gemini-4-hydrogen-xhigh(xhigh)",
	} {
		getResp := scopedRequest(server, http.MethodGet, path, "", map[string]string{
			"User-Agent": testAntigravityCLIUA,
		})
		if getResp.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d body = %s", path, getResp.Code, getResp.Body.String())
		}
	}
	notFound := scopedRequest(server, http.MethodGet, "/provider/antigravity/v1beta/models/no-such-model(high)", "", map[string]string{
		"User-Agent": testAntigravityCLIUA,
	})
	if notFound.Code != http.StatusNotFound {
		t.Fatalf("GET unknown status = %d, want 404", notFound.Code)
	}

	// Standard Gemini clients keep the original unexpanded catalog.
	stdResp := scopedRequest(server, http.MethodGet, "/provider/antigravity/v1beta/models", "", map[string]string{
		"User-Agent": "curl/8.7.1",
	})
	if stdResp.Code != http.StatusOK {
		t.Fatalf("standard GET status = %d body = %s", stdResp.Code, stdResp.Body.String())
	}
	if strings.Contains(stdResp.Body.String(), "claude-opus-5-5-high(low)") {
		t.Fatalf("standard client should not receive CLI effort expansion: %s", stdResp.Body.String())
	}
	if !strings.Contains(stdResp.Body.String(), `"models/claude-opus-5-5-high"`) {
		t.Fatalf("standard client should receive base model entry: %s", stdResp.Body.String())
	}
}

func TestAntigravityCLIExpandedModelExecutionAppliesThinkingSuffix(t *testing.T) {
	var capturedBodies []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		capturedBodies = append(capturedBodies, string(raw))
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}]}}\n\n")
	}))
	defer upstream.Close()

	server := newTestServer(t)
	server.handlers.AuthManager.RegisterExecutor(executor.NewAntigravityExecutor(server.cfg))
	a := registerAntigravityCLICatalogForTest(t, server)
	a.Attributes = map[string]string{"base_url": upstream.URL}
	if _, errUpdate := server.handlers.AuthManager.Update(context.Background(), a); errUpdate != nil {
		t.Fatal(errUpdate)
	}

	cases := []struct {
		name         string
		pathModel    string
		body         string
		wantModel    string
		wantLevel    string
		wantBudget   int64
		wantNoBudget bool
		wantNoLevel  bool
	}{
		{
			name:         "level model suffix overrides body thinkingBudget",
			pathModel:    "claude-opus-5-5-high(low)",
			body:         `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"thinkingBudget":0,"includeThoughts":true}}}`,
			wantModel:    "claude-opus-5-5-high",
			wantLevel:    "LOW",
			wantNoBudget: true,
		},
		{
			name:         "xhigh level suffix on gemini-4-hydrogen-xhigh",
			pathModel:    "gemini-4-hydrogen-xhigh(xhigh)",
			body:         `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"thinkingLevel":"low","includeThoughts":true}}}`,
			wantModel:    "gemini-4-hydrogen-xhigh",
			wantLevel:    "XHIGH",
			wantNoBudget: true,
		},
		{
			name:        "budget-only claude-opus-4-6-thinking converts medium to budget",
			pathModel:   "claude-opus-4-6-thinking(medium)",
			body:        `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}`,
			wantModel:   "claude-opus-4-6-thinking",
			wantBudget:  8192,
			wantNoLevel: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := len(capturedBodies)
			path := "/provider/antigravity/v1beta/models/" + tc.pathModel + ":streamGenerateContent?alt=sse"
			resp := scopedRequest(server, http.MethodPost, path, tc.body, map[string]string{
				"User-Agent": testAntigravityCLIUA,
			})
			if resp.Code != http.StatusOK {
				t.Fatalf("POST %s status = %d body = %s", path, resp.Code, resp.Body.String())
			}
			if len(capturedBodies) != before+1 {
				t.Fatalf("upstream call count = %d, want %d", len(capturedBodies)-before, 1)
			}
			sent := capturedBodies[len(capturedBodies)-1]
			if gotModel := ojson.Get(sent, "model").String(); gotModel != tc.wantModel {
				t.Fatalf("upstream model = %q, want %q; body=%s", gotModel, tc.wantModel, sent)
			}
			if tc.wantLevel != "" {
				if gotLevel := ojson.Get(sent, "request.generationConfig.thinkingConfig.thinkingLevel").String(); gotLevel != tc.wantLevel {
					t.Fatalf("thinkingLevel = %q, want %q; body=%s", gotLevel, tc.wantLevel, sent)
				}
			}
			if tc.wantNoBudget && ojson.Get(sent, "request.generationConfig.thinkingConfig.thinkingBudget").Exists() {
				t.Fatalf("expected thinkingBudget to be stripped; body=%s", sent)
			}
			if tc.wantBudget > 0 {
				if gotBudget := ojson.Get(sent, "request.generationConfig.thinkingConfig.thinkingBudget").Int(); gotBudget != tc.wantBudget {
					t.Fatalf("thinkingBudget = %d, want %d; body=%s", gotBudget, tc.wantBudget, sent)
				}
			}
			if tc.wantNoLevel && ojson.Get(sent, "request.generationConfig.thinkingConfig.thinkingLevel").Exists() {
				t.Fatalf("expected thinkingLevel to be stripped; body=%s", sent)
			}
		})
	}
}

func TestAntigravityCLIGeminiModels_HomeModeAndPluginInterceptor(t *testing.T) {
	server := newTestServer(t)
	server.cfg.Home.Enabled = true

	var intercepted bool
	server.handlers.SetPluginHost(&mockModelListInterceptorHost{
		interceptResponse: func(_ context.Context, req pluginapi.ResponseInterceptRequest) pluginapi.ResponseInterceptResponse {
			intercepted = true
			headers := req.ResponseHeaders.Clone()
			headers.Set("X-CLI-Intercepted", "yes")
			return pluginapi.ResponseInterceptResponse{Headers: headers, Body: req.Body}
		},
	})

	client := newHomeCatalogClient(t, `{
		"antigravity": [
			{
				"id": "claude-opus-5-5-high",
				"display_name": "Claude Opus 5.5 (High)",
				"context_length": 1000000,
				"max_completion_tokens": 128000,
				"thinking": {"levels": ["low", "medium", "high"]}
			}
		]
	}`)
	previousHome := home.Current()
	home.SetCurrent(client)
	t.Cleanup(func() { home.SetCurrent(previousHome) })

	engine := gin.New()
	engine.GET("/v1beta/models", server.geminiModelsHandler(nil))
	engine.GET("/v1beta/models/*action", server.geminiGetHandler(nil))

	listReq := httptest.NewRequest(http.MethodGet, "/v1beta/models", nil)
	listReq.Header.Set("User-Agent", testAntigravityCLIUA)
	listRec := httptest.NewRecorder()
	engine.ServeHTTP(listRec, listReq)

	if listRec.Code != http.StatusOK {
		t.Fatalf("Home CLI list status = %d body = %s", listRec.Code, listRec.Body.String())
	}
	if !intercepted || listRec.Header().Get("X-CLI-Intercepted") != "yes" {
		t.Fatalf("expected plugin interceptor to run for Antigravity CLI model list")
	}
	if !strings.Contains(listRec.Body.String(), `"models/claude-opus-5-5-high(high)"`) {
		t.Fatalf("expected expanded Home model list, got: %s", listRec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/v1beta/models/claude-opus-5-5-high(medium)", nil)
	getReq.Header.Set("User-Agent", testAntigravityCLIUA)
	getRec := httptest.NewRecorder()
	engine.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK || !strings.Contains(getRec.Body.String(), `"Claude Opus 5.5 (medium)"`) {
		t.Fatalf("Home CLI get status = %d body = %s", getRec.Code, getRec.Body.String())
	}
}
