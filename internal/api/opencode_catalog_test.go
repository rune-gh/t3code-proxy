package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/util"
	"github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

func TestOpenCodeCatalogListsHubModelsInModelsDevFormat(t *testing.T) {
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
	if _, listed := provider.Models["grok-imagine-opencodetest"]; listed {
		t.Fatal("an image-only model must not be offered to OpenCode")
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
		reg.RegisterClient(id, "claude", []*registry.ModelInfo{{ID: model, ClaudeCodeOnly: a.IsClaudeSubscription()}})
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
	body := `{"model":"claude-mythos-5-2","messages":[{"role":"user","content":"test"}],"max_tokens":1}`
	for _, path := range []string{"/v1/messages", "/provider/claude/v1/messages/count_tokens", "/v1/chat/completions"} {
		resp := scopedRequest(server, http.MethodPost, path, body, openCode)
		if resp.Code != http.StatusForbidden || !strings.Contains(resp.Body.String(), "only through Claude Code") || len(executor.authIDs) != 0 {
			t.Fatalf("%s: status %d, dispatched to %v", path, resp.Code, executor.authIDs)
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
		reg.RegisterClient(a.ID, "claude", []*registry.ModelInfo{{ID: tc.model, Created: tc.created, ClaudeCodeOnly: a.IsClaudeSubscription()}})
		t.Cleanup(func() { reg.UnregisterClient(a.ID) })
		manager.RefreshSchedulerEntry(a.ID)
	}
	reg.SetModelQuotaExceeded("auto-scope-cooling", "aaa-shared-new")
	resp := scopedRequest(server, http.MethodPost, "/provider/claude/v1/messages", `{"model":"auto","max_tokens":1,"messages":[{"role":"user","content":"test"}]}`, nil)
	if resp.Code != 200 || len(executor.authIDs) != 1 || executor.authIDs[0] != "auto-scope-ready" {
		t.Fatalf("auto: status %d, dispatched to %v", resp.Code, executor.authIDs)
	}
}
