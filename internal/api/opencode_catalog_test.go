package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	claudemodels "github.com/rune-oai/t3code-proxy/internal/client/claude/models"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/util"
	"github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

// stubOpenCodeUpstream replaces the models.dev fetch for one test.
func stubOpenCodeUpstream(t *testing.T, fetch func(context.Context, string) ([]byte, error)) {
	t.Helper()
	previous := openCodeUpstream
	openCodeUpstream = newOpenCodeUpstreamCatalog("https://models.example/api.json", fetch)
	t.Cleanup(func() { openCodeUpstream = previous })
}

func TestOpenCodeCatalogListsHubModelsInModelsDevFormat(t *testing.T) {
	stubOpenCodeUpstream(t, func(context.Context, string) ([]byte, error) { return nil, errors.New("offline") })
	server := newTestServer(t)
	reg := registry.GetGlobalRegistry()
	for _, client := range []struct {
		id, provider string
		models       []*registry.ModelInfo
	}{
		{id: "opencode-claude", provider: "claude", models: []*registry.ModelInfo{{
			ID: "claude-opencodetest-5-5", DisplayName: "Claude OpenCode Test", Created: 1790035200, ContextLength: 1000000, MaxCompletionTokens: 128000,
			Thinking: &registry.ThinkingSupport{Levels: []string{"low", "high", "max"}}, SupportedInputModalities: []string{"text", "image"},
		}}},
		{id: "opencode-codex", provider: "codex", models: []*registry.ModelInfo{{ID: "gpt-opencodetest-5.6", ContextLength: 400000, MaxCompletionTokens: 128000, Thinking: &registry.ThinkingSupport{Levels: []string{"low", "medium", "high", "xhigh"}}}}},
		{id: "opencode-mistral", provider: "mistral", models: []*registry.ModelInfo{
			{ID: "codestral-catalog-test", DisplayName: "Codestral"},
			{ID: "codestral-catalog-alias-test", DisplayName: "Codestral"},
			{ID: "voxtral-catalog-test", SupportedInputModalities: []string{"audio"}, SupportedOutputModalities: []string{"text"}},
			{ID: "image-catalog-alias-test", MetadataModelID: "gpt-image-2"},
		}},
		{id: "opencode-xai", provider: "xai", models: []*registry.ModelInfo{
			{ID: "grok-opencodetest-4.7"},
			{ID: "grok-imagine-opencodetest", SupportedOutputModalities: []string{"image"}},
		}},
	} {
		if _, err := server.handlers.AuthManager.Register(context.Background(), &auth.Auth{ID: client.id, Provider: client.provider, Status: auth.StatusActive}); err != nil {
			t.Fatal(err)
		}
		reg.RegisterClient(client.id, client.provider, client.models)
		clientID := client.id
		t.Cleanup(func() { reg.UnregisterClient(clientID) })
	}

	request := httptest.NewRequest(http.MethodGet, "/opencode/test-key/api.json", nil)
	request.Host = "127.0.0.1:8317"
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Forwarded-Host", "hub.example.ts.net:8317")
	recorder := httptest.NewRecorder()
	server.engine.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
	}

	var catalog map[string]openCodeProvider
	if err := json.Unmarshal(recorder.Body.Bytes(), &catalog); err != nil {
		t.Fatalf("decode: %v", err)
	}
	provider, ok := catalog[openCodeProviderID]
	if !ok {
		t.Fatalf("catalog has no %s provider: %s", openCodeProviderID, recorder.Body.String())
	}
	const api = "https://hub.example.ts.net:8317/v1"
	if provider.API != api || len(provider.Env) != 1 || provider.Env[0] != openCodeAPIKeyEnv {
		t.Fatalf("provider = %+v", provider)
	}

	claude := provider.Models["claude-opencodetest-5-5"]
	if claude.Provider.NPM != openCodeNPMAnthropic || claude.Provider.API != api || claude.Name != "Claude OpenCode Test" {
		t.Fatalf("claude model = %+v", claude)
	}
	if !claude.Reasoning || len(claude.ReasoningOptions) != 1 || len(claude.ReasoningOptions[0].Values) != 3 || claude.Limit.Context != 1000000 || !claude.Attachment {
		t.Fatalf("claude capabilities = %+v", claude)
	}
	if claude.ReleaseDate != "2026-09-22" {
		t.Fatalf("release date = %q", claude.ReleaseDate)
	}
	if got := provider.Models["gpt-opencodetest-5.6"].Provider.NPM; got != openCodeNPMOpenAIResponses {
		t.Fatalf("codex npm = %q", got)
	}
	grok := provider.Models["grok-opencodetest-4.7"]
	if grok.Provider.NPM != openCodeNPMOpenAICompatible || grok.Limit.Context != openCodeDefaultContext || grok.Limit.Output != openCodeDefaultOutput {
		t.Fatalf("grok model = %+v", grok)
	}
	for _, id := range []string{"grok-imagine-opencodetest", "voxtral-catalog-test", "image-catalog-alias-test"} {
		if _, listed := provider.Models[id]; listed {
			t.Errorf("non-chat model %q offered to OpenCode", id)
		}
	}
	for _, id := range []string{"codestral-catalog-test", "codestral-catalog-alias-test"} {
		model := provider.Models[id]
		if model.ID != id || model.Name != "Codestral ("+id+")" {
			t.Errorf("OpenCode model %q = %+v", id, model)
		}
	}

	// Claude Code lists other providers' models only under cloaked IDs.
	cloakingCfg := *server.cfg
	cloakingCfg.ClaudeCode.DisableCloakingModelList = new(false)
	server.UpdateClients(&cloakingCfg)
	headers := map[string]string{"User-Agent": "claude-code/2.1.332", "Anthropic-Version": "2023-06-01"}
	response := scopedRequest(server, http.MethodGet, "/v1/models", "", headers)
	var claudeCatalog struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &claudeCatalog); response.Code != http.StatusOK || err != nil {
		t.Fatalf("Claude catalog: status %d, decode %v", response.Code, err)
	}
	labels := make(map[string]string, len(claudeCatalog.Data))
	for _, entry := range claudeCatalog.Data {
		labels[claudemodels.ResolveClaudeModelIDPrefix(entry.ID)] = entry.DisplayName
	}
	for _, id := range []string{"grok-imagine-opencodetest", "voxtral-catalog-test", "image-catalog-alias-test"} {
		if _, listed := labels[id]; listed {
			t.Errorf("non-chat model %q offered to Claude Code", id)
		}
	}
	for _, id := range []string{"codestral-catalog-test", "codestral-catalog-alias-test"} {
		if got := labels[id]; got != "Codestral ("+id+")" {
			t.Errorf("Claude model %q label = %q", id, got)
		}
	}
}

func TestOpenCodeCatalogRequiresAnAccessKey(t *testing.T) {
	server := newTestServer(t)
	for _, path := range []string{"/opencode/wrong-key/api.json", "/opencode//api.json"} {
		recorder := httptest.NewRecorder()
		server.engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code == http.StatusOK {
			t.Errorf("%s answered 200 without a valid key", path)
		}
	}
}

func TestMaskSensitivePathHidesTheOpenCodeKey(t *testing.T) {
	for path, want := range map[string]string{
		"/opencode/secret-key/api.json": "/opencode/***/api.json",
		"/opencode/secret-key":          "/opencode/***",
		"/v1/models":                    "/v1/models",
	} {
		if got := util.MaskSensitivePath(path); got != want {
			t.Errorf("MaskSensitivePath(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestClaudeSubscriptionCatalogAndRouting(t *testing.T) {
	server := newTestServer(t)
	manager := server.handlers.AuthManager
	executor := &providerScopeExecutor{provider: "claude"}
	manager.RegisterExecutor(executor)
	const model = "claude-mythos-5-2"
	register := func(id, kind string) {
		t.Helper()
		a := &auth.Auth{ID: id, Provider: "claude", Attributes: map[string]string{"auth_kind": kind}}
		if _, err := manager.Register(context.Background(), a); err != nil {
			t.Fatal(err)
		}
		reg := registry.GetGlobalRegistry()
		reg.RegisterClient(id, "claude", []*registry.ModelInfo{{ID: model, ReservedFor: a.ReservedClient()}})
		t.Cleanup(func() { reg.UnregisterClient(id) })
		manager.RefreshSchedulerEntry(id)
	}
	register("mythos-subscription", auth.AuthKindOAuth)
	openCode := map[string]string{"User-Agent": "opencode", "Anthropic-Version": "2023-06-01"}
	claudeCode := map[string]string{"User-Agent": "claude-cli/2.1.332 (external, cli)", "X-App": "cli", "Anthropic-Beta": "claude-code-20250219"}
	checkCatalog := func(path string, headers map[string]string, want bool) {
		t.Helper()
		resp := scopedRequest(server, http.MethodGet, path, "", headers)
		if resp.Code != 200 || strings.Contains(resp.Body.String(), model) != want {
			t.Fatalf("%s: status %d, want listed=%t: %s", path, resp.Code, want, resp.Body.String())
		}
	}
	for _, path := range []string{"/opencode/test-key/api.json", "/v1/models", "/provider/claude/v1/models", "/v1/models?client_version=1.0.0"} {
		checkCatalog(path, openCode, false)
	}
	checkCatalog("/provider/claude/v1/models", claudeCode, true)
	checkCatalog("/v1/models", map[string]string{"User-Agent": "claude-cli/2.1.357 (external, t3-code, agent-sdk/0.3.276)"}, true)
	// Claude Code's gateway model discovery (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY)
	// feeds T3 Code's Claude model picker; it sends claude-code/<version>.
	discovery := map[string]string{"User-Agent": "claude-code/2.1.332", "Anthropic-Version": "2023-06-01"}
	for _, path := range []string{"/v1/models?limit=1000", "/provider/claude/v1/models?limit=1000"} {
		checkCatalog(path, discovery, true)
	}
	checkCatalog("/v1/models", map[string]string{"User-Agent": "claude-code/2.1.332 (spoofed)", "Anthropic-Version": "2023-06-01"}, false)
	checkCatalog("/v1/models", map[string]string{"User-Agent": "claude-code/2.1.332"}, false)
	body := `{"model":"claude-mythos-5-2","messages":[{"role":"user","content":"test"}],"max_tokens":1}`
	for _, headers := range []map[string]string{openCode, discovery} {
		for _, path := range []string{"/v1/messages", "/provider/claude/v1/messages/count_tokens", "/v1/chat/completions"} {
			resp := scopedRequest(server, http.MethodPost, path, body, headers)
			if resp.Code != http.StatusForbidden || !strings.Contains(resp.Body.String(), "only through Claude Code") || len(executor.authIDs) != 0 {
				t.Fatalf("%s as %s: status %d, dispatched to %v", path, headers["User-Agent"], resp.Code, executor.authIDs)
			}
		}
	}
	resp := scopedRequest(server, http.MethodPost, "/v1/messages/count_tokens", body, claudeCode)
	if resp.Code != 200 || len(executor.authIDs) != 1 || executor.authIDs[0] != "mythos-subscription" {
		t.Fatalf("Claude Code: status %d, dispatched to %v", resp.Code, executor.authIDs)
	}
	register("mythos-api-key", auth.AuthKindAPIKey)
	checkCatalog("/opencode/test-key/api.json", openCode, true)
	for range 3 {
		resp = scopedRequest(server, http.MethodPost, "/v1/messages", body, openCode)
		if resp.Code != 200 || executor.authIDs[len(executor.authIDs)-1] != "mythos-api-key" {
			t.Fatalf("OpenCode with API key: status %d, dispatched to %v", resp.Code, executor.authIDs)
		}
	}
}

func TestClientAutoSkipsSubscriptionAndCoolingKey(t *testing.T) {
	server := newTestServer(t)
	manager := server.handlers.AuthManager
	executor := &providerScopeExecutor{provider: "claude"}
	manager.RegisterExecutor(executor)
	reg := registry.GetGlobalRegistry()
	for _, tc := range []struct {
		authID, kind, model string
		created             int64
	}{
		{"auto-scope-sub", auth.AuthKindOAuth, "aaa-shared-new", 2},
		{"auto-scope-cooling", auth.AuthKindAPIKey, "aaa-shared-new", 2},
		{"auto-scope-ready", auth.AuthKindAPIKey, "eligible-older", 1},
	} {
		a := &auth.Auth{ID: tc.authID, Provider: "claude", Attributes: map[string]string{"auth_kind": tc.kind}}
		if _, err := manager.Register(context.Background(), a); err != nil {
			t.Fatal(err)
		}
		reg.RegisterClient(a.ID, "claude", []*registry.ModelInfo{{ID: tc.model, Created: tc.created, ReservedFor: a.ReservedClient()}})
		t.Cleanup(func() { reg.UnregisterClient(a.ID) })
		manager.RefreshSchedulerEntry(a.ID)
	}
	reg.SetModelQuotaExceeded("auto-scope-cooling", "aaa-shared-new")
	resp := scopedRequest(server, http.MethodPost, "/provider/claude/v1/messages", `{"model":"auto","max_tokens":1,"messages":[{"role":"user","content":"test"}]}`, nil)
	if resp.Code != 200 || len(executor.authIDs) != 1 || executor.authIDs[0] != "auto-scope-ready" {
		t.Fatalf("auto: status %d, dispatched to %v", resp.Code, executor.authIDs)
	}
}

func TestAntigravitySubscriptionReservedForAntigravityCLI(t *testing.T) {
	server := newTestServer(t)
	manager := server.handlers.AuthManager
	executor := &providerScopeExecutor{provider: "antigravity"}
	manager.RegisterExecutor(executor)
	const model = "gemini-reserved-test"
	a := &auth.Auth{ID: "antigravity-login", Provider: "antigravity", Status: auth.StatusActive}
	if _, err := manager.Register(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	reg := registry.GetGlobalRegistry()
	reg.RegisterClient(a.ID, "antigravity", []*registry.ModelInfo{{ID: model, OwnedBy: "antigravity", ReservedFor: a.ReservedClient()}})
	t.Cleanup(func() { reg.UnregisterClient(a.ID) })
	manager.RefreshSchedulerEntry(a.ID)

	openCode := map[string]string{"User-Agent": "opencode/1.18.18"}
	claudeCode := map[string]string{"User-Agent": "claude-cli/2.1.332 (external, cli)", "X-App": "cli", "Anthropic-Beta": "claude-code-20250219", "Anthropic-Version": "2023-06-01"}
	agy := map[string]string{"User-Agent": testAntigravityCLIUA}
	for _, tc := range []struct {
		path    string
		headers map[string]string
		listed  bool
	}{
		{"/opencode/test-key/api.json", openCode, false},
		{"/v1/models", openCode, false},
		{"/v1beta/models", openCode, false},
		{"/v1/models", claudeCode, false},
		{"/v1/models", map[string]string{"User-Agent": "claude-code/2.1.332"}, false},
		{"/provider/antigravity/v1beta/models", agy, true},
		{"/v1beta/models", agy, true},
	} {
		resp := scopedRequest(server, http.MethodGet, tc.path, "", tc.headers)
		if resp.Code != http.StatusOK || strings.Contains(resp.Body.String(), model) != tc.listed {
			t.Fatalf("%s (%s): status %d, want listed=%t: %s", tc.path, tc.headers["User-Agent"], resp.Code, tc.listed, resp.Body.String())
		}
	}

	chat := `{"model":"` + model + `","messages":[{"role":"user","content":"hi"}],"max_tokens":1}`
	for _, tc := range []struct {
		path, body string
		headers    map[string]string
	}{
		{"/v1/chat/completions", chat, openCode},
		{"/v1/messages", chat, claudeCode},
		{"/v1beta/models/" + model + ":generateContent", `{"contents":[{"parts":[{"text":"hi"}]}]}`, openCode},
	} {
		resp := scopedRequest(server, http.MethodPost, tc.path, tc.body, tc.headers)
		if resp.Code != http.StatusForbidden || !strings.Contains(resp.Body.String(), "only through the Antigravity CLI") || len(executor.authIDs) != 0 {
			t.Fatalf("%s (%s): status %d, dispatched to %v: %s", tc.path, tc.headers["User-Agent"], resp.Code, executor.authIDs, resp.Body.String())
		}
	}
	resp := scopedRequest(server, http.MethodPost, "/provider/antigravity/v1beta/models/"+model+":generateContent", `{"contents":[{"parts":[{"text":"hi"}]}]}`, agy)
	if resp.Code != http.StatusOK || len(executor.authIDs) != 1 || executor.authIDs[0] != a.ID {
		t.Fatalf("Antigravity CLI: status %d, dispatched to %v: %s", resp.Code, executor.authIDs, resp.Body.String())
	}
	// agy's ACP server in Gemini API key mode, as T3 Code runs it, generates through the Go genai SDK.
	agyACP := map[string]string{"User-Agent": "google-genai-sdk/1.79.1 gl-go/go1.28-20261102-RC01 cl/1012564305 +298f53e483 X:fieldtrack,boringcrypto,nogolistexportnewformat"}
	resp = scopedRequest(server, http.MethodPost, "/provider/antigravity/v1beta/models/"+model+":streamGenerateContent?alt=sse", `{"contents":[{"parts":[{"text":"hi"}]}]}`, agyACP)
	if resp.Code != http.StatusOK || len(executor.authIDs) != 2 || executor.authIDs[1] != a.ID {
		t.Fatalf("Antigravity CLI over ACP: status %d, dispatched to %v: %s", resp.Code, executor.authIDs, resp.Body.String())
	}
}

func TestReservedForOpenCodeServesOnlyOpenCode(t *testing.T) {
	server := newTestServer(t)
	manager := server.handlers.AuthManager
	executor := &providerScopeExecutor{provider: "vibe-test"}
	manager.RegisterExecutor(executor)
	const model = "vibe/mistral-reserved-test"
	a := &auth.Auth{ID: "vibe-key", Provider: "vibe-test", Status: auth.StatusActive, Attributes: map[string]string{
		"api_key":                 "vibe-secret",
		auth.AttributeReservedFor: registry.ReservedForOpenCode,
	}}
	if _, err := manager.Register(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	reg := registry.GetGlobalRegistry()
	reg.RegisterClient(a.ID, "vibe-test", []*registry.ModelInfo{{ID: model, OwnedBy: "mistral", ReservedFor: a.ReservedClient()}})
	t.Cleanup(func() { reg.UnregisterClient(a.ID) })
	manager.RefreshSchedulerEntry(a.ID)

	openCode := map[string]string{"User-Agent": "opencode/latest/2.3.0/cli"}
	openCodeHeaderOnly := map[string]string{"User-Agent": "ai-sdk/openai-compatible", "X-Opencode-Client": "cli"}
	vibe := map[string]string{"User-Agent": "Mistral-Vibe/2.4.0"}
	claudeCode := map[string]string{"User-Agent": "claude-cli/2.1.332 (external, cli)", "X-App": "cli", "Anthropic-Beta": "claude-code-20250219", "Anthropic-Version": "2023-06-01"}
	for _, tc := range []struct {
		path    string
		headers map[string]string
		listed  bool
	}{
		{"/opencode/test-key/api.json", openCode, true},
		{"/opencode/test-key/api.json", nil, true},
		{"/v1/models", openCode, true},
		{"/v1/models", openCodeHeaderOnly, true},
		{"/v1/models", vibe, false},
		{"/v1/models", claudeCode, false},
		{"/v1/models", map[string]string{"User-Agent": testAntigravityCLIUA}, false},
	} {
		resp := scopedRequest(server, http.MethodGet, tc.path, "", tc.headers)
		if resp.Code != http.StatusOK || strings.Contains(resp.Body.String(), model) != tc.listed {
			t.Fatalf("%s (%s): status %d, want listed=%t: %s", tc.path, tc.headers["User-Agent"], resp.Code, tc.listed, resp.Body.String())
		}
	}

	chat := `{"model":"` + model + `","messages":[{"role":"user","content":"hi"}],"max_tokens":1}`
	for _, headers := range []map[string]string{vibe, claudeCode} {
		path := "/v1/chat/completions"
		if headers["X-App"] != "" {
			path = "/v1/messages"
		}
		resp := scopedRequest(server, http.MethodPost, path, chat, headers)
		if resp.Code != http.StatusForbidden || !strings.Contains(resp.Body.String(), "only through OpenCode") || len(executor.authIDs) != 0 {
			t.Fatalf("%s (%s): status %d, dispatched to %v: %s", path, headers["User-Agent"], resp.Code, executor.authIDs, resp.Body.String())
		}
	}
	resp := scopedRequest(server, http.MethodPost, "/v1/chat/completions", chat, openCode)
	if resp.Code != http.StatusOK || len(executor.authIDs) != 1 || executor.authIDs[0] != a.ID {
		t.Fatalf("OpenCode: status %d, dispatched to %v: %s", resp.Code, executor.authIDs, resp.Body.String())
	}
}
