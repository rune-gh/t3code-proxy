package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/util"
	"github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	coreexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

const scopedSharedModel = "claude-provider-scope-shared"
const scopedOutsideModel = "claude-provider-scope-outside"

type providerScopeExecutor struct {
	provider string
	authIDs  []string
	models   []string
	fail     bool
}

func (e *providerScopeExecutor) Identifier() string { return e.provider }

func (e *providerScopeExecutor) Execute(_ context.Context, a *auth.Auth, req coreexecutor.Request, _ coreexecutor.Options) (coreexecutor.Response, error) {
	e.authIDs = append(e.authIDs, a.ID)
	e.models = append(e.models, req.Model)
	if e.fail {
		return coreexecutor.Response{}, errors.New("scoped upstream failed")
	}
	return coreexecutor.Response{Payload: []byte(`{"id":"scope-response","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"content":[{"type":"text","text":"ok"}],"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"input_tokens":1,"totalTokens":1}`)}, nil
}

func (e *providerScopeExecutor) ExecuteStream(ctx context.Context, a *auth.Auth, req coreexecutor.Request, opts coreexecutor.Options) (*coreexecutor.StreamResult, error) {
	response, errExecute := e.Execute(ctx, a, req, opts)
	if errExecute != nil {
		return nil, errExecute
	}
	chunk := response.Payload
	switch opts.SourceFormat.String() {
	case "openai":
		chunk = []byte("data: {\"id\":\"scope-response\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	case "claude":
		chunk = []byte("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"scope-response\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	case "openai-response":
		chunk = []byte("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"scope-response\",\"status\":\"completed\",\"output\":[]}}\n\n")
	}
	chunks := make(chan coreexecutor.StreamChunk, 1)
	chunks <- coreexecutor.StreamChunk{Payload: chunk}
	close(chunks)
	return &coreexecutor.StreamResult{Chunks: chunks}, nil
}

func (e *providerScopeExecutor) CountTokens(ctx context.Context, a *auth.Auth, req coreexecutor.Request, opts coreexecutor.Options) (coreexecutor.Response, error) {
	return e.Execute(ctx, a, req, opts)
}

func (e *providerScopeExecutor) Refresh(_ context.Context, a *auth.Auth) (*auth.Auth, error) {
	return a, nil
}

func (e *providerScopeExecutor) HttpRequest(context.Context, *auth.Auth, *http.Request) (*http.Response, error) {
	return nil, errors.New("unexpected HTTP passthrough")
}

func newProviderScopeServer(t *testing.T) (*Server, map[string]*providerScopeExecutor) {
	t.Helper()
	server := newTestServer(t)
	executors := make(map[string]*providerScopeExecutor)
	for _, provider := range []string{"antigravity", "claude", "mistral"} {
		providerKey := provider
		if provider == "mistral" {
			providerKey = util.OpenAICompatibleProviderKey(provider)
		}
		executor := &providerScopeExecutor{provider: providerKey}
		executors[provider] = executor
		server.handlers.AuthManager.RegisterExecutor(executor)
		a := &auth.Auth{ID: "provider-scope-" + provider, Provider: provider, Status: auth.StatusActive}
		if provider == "mistral" {
			a.Provider = "openai-compatibility"
			a.Label = "mistral"
		}
		if _, errRegister := server.handlers.AuthManager.Register(context.Background(), a); errRegister != nil {
			t.Fatal(errRegister)
		}
		models := []*registry.ModelInfo{{ID: scopedSharedModel, OwnedBy: provider, DisplayName: provider + " shared"}}
		if provider == "claude" {
			models = append(models, &registry.ModelInfo{ID: scopedOutsideModel, OwnedBy: provider})
		}
		registry.GetGlobalRegistry().RegisterClient(a.ID, providerKey, models)
		t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(a.ID) })
	}
	return server, executors
}

func scopedRequest(server *Server, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	server.engine.ServeHTTP(recorder, req)
	return recorder
}

func TestProviderScopedModels(t *testing.T) {
	server, _ := newProviderScopeServer(t)
	for _, test := range []struct {
		path    string
		headers map[string]string
		field   string
	}{
		{path: "/v1/models", field: "data"},
		{path: "/v1/models", headers: map[string]string{"Anthropic-Version": "2023-06-01"}, field: "data"},
		{path: "/v1/models?client_version=cpa", field: "models"},
		{path: "/v1beta/models", field: "models"},
	} {
		t.Run(test.path+test.field, func(t *testing.T) {
			response := scopedRequest(server, http.MethodGet, "/provider/AnTiGrAvItY"+test.path, "", test.headers)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			models := ojson.Get(response.Body.String(), test.field).Array()
			if len(models) != 1 || !strings.Contains(models[0].Raw, scopedSharedModel) || strings.Contains(response.Body.String(), scopedOutsideModel) {
				t.Fatalf("unexpected scoped catalog: %s", response.Body.String())
			}
			if test.field == "data" && !strings.Contains(response.Body.String(), `"owned_by":"antigravity"`) {
				t.Fatalf("shared model metadata came from another provider: %s", response.Body.String())
			}
			unscoped := scopedRequest(server, http.MethodGet, test.path, "", test.headers)
			if unscoped.Code != http.StatusOK || !strings.Contains(unscoped.Body.String(), scopedOutsideModel) {
				t.Fatalf("unexpected unscoped catalog: %d %s", unscoped.Code, unscoped.Body.String())
			}
		})
	}
	for _, path := range []string{"/v1/models/", "/v1beta/models/"} {
		response := scopedRequest(server, http.MethodGet, "/provider/antigravity"+path+scopedSharedModel, "", nil)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), scopedSharedModel) {
			t.Fatalf("model detail: %d %s", response.Code, response.Body.String())
		}
		response = scopedRequest(server, http.MethodGet, "/provider/antigravity"+path+scopedOutsideModel, "", nil)
		if response.Code != http.StatusNotFound {
			t.Fatalf("outside model detail: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestProviderScopedExecution(t *testing.T) {
	for _, test := range []struct {
		path string
		body string
	}{
		{path: "/v1/chat/completions", body: `{"model":"MODEL","messages":[{"role":"user","content":"hi"}]}`},
		{path: "/v1/chat/completions", body: `{"model":"MODEL","messages":[{"role":"user","content":"hi"}],"stream":true}`},
		{path: "/v1/completions", body: `{"model":"MODEL","prompt":"hi"}`},
		{path: "/v1/responses", body: `{"model":"MODEL","input":"hi"}`},
		{path: "/v1/responses", body: `{"model":"MODEL","input":"hi","stream":true}`},
		{path: "/v1/messages", body: `{"model":"MODEL","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}`},
		{path: "/v1/messages", body: `{"model":"MODEL","max_tokens":32,"messages":[{"role":"user","content":"hi"}],"stream":true}`},
		{path: "/v1/messages/count_tokens", body: `{"model":"MODEL","messages":[{"role":"user","content":"hi"}]}`},
		{path: "/v1beta/models/MODEL:generateContent", body: `{"contents":[{"parts":[{"text":"hi"}]}]}`},
		{path: "/v1beta/models/MODEL:streamGenerateContent", body: `{"contents":[{"parts":[{"text":"hi"}]}]}`},
		{path: "/v1beta/models/MODEL:countTokens", body: `{"contents":[{"parts":[{"text":"hi"}]}]}`},
	} {
		t.Run(test.path+test.body, func(t *testing.T) {
			server, executors := newProviderScopeServer(t)
			for _, provider := range []string{"antigravity", "mistral"} {
				body := strings.ReplaceAll(test.body, "MODEL", scopedSharedModel)
				path := strings.ReplaceAll(test.path, "MODEL", scopedSharedModel)
				response := scopedRequest(server, http.MethodPost, "/provider/"+provider+path, body, nil)
				if response.Code != http.StatusOK || len(executors[provider].authIDs) != 1 || executors[provider].authIDs[0] != "provider-scope-"+provider {
					t.Fatalf("provider=%s status=%d body=%s auths=%v", provider, response.Code, response.Body.String(), executors[provider].authIDs)
				}
				response = scopedRequest(server, http.MethodPost, "/provider/"+provider+strings.ReplaceAll(test.path, "MODEL", scopedOutsideModel), strings.ReplaceAll(test.body, "MODEL", scopedOutsideModel), nil)
				if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "unknown provider for model") {
					t.Fatalf("outside scope: status=%d body=%s", response.Code, response.Body.String())
				}
				if len(executors[provider].authIDs) != 1 || len(executors["claude"].authIDs) != 0 {
					t.Fatal("request reached credentials outside the provider scope")
				}
			}
		})
	}
}

func TestProviderScopedErrorsAndAuth(t *testing.T) {
	server, _ := newProviderScopeServer(t)
	for _, test := range []struct {
		method string
		path   string
		field  string
	}{
		{http.MethodGet, "/v1/models", "error.message"},
		{http.MethodPost, "/v1/chat/completions", "error.message"},
		{http.MethodPost, "/v1/messages", "error.message"},
		{http.MethodGet, "/v1beta/models", "error.message"},
		{http.MethodPost, "/v1beta/models/x:generateContent", "error.message"},
	} {
		response := scopedRequest(server, test.method, "/provider/no-such-provider"+test.path, `{}`, nil)
		if response.Code != http.StatusNotFound || !strings.Contains(ojson.Get(response.Body.String(), test.field).String(), "unknown provider") {
			t.Fatalf("unknown provider: %d %s", response.Code, response.Body.String())
		}
		if strings.Contains(test.path, "/v1beta/") && ojson.Get(response.Body.String(), "error.status").String() != "NOT_FOUND" {
			t.Fatalf("Gemini error shape: %s", response.Body.String())
		}
		if test.path == "/v1/messages" && ojson.Get(response.Body.String(), "type").String() != "error" {
			t.Fatalf("Claude error shape: %s", response.Body.String())
		}
	}
	response := scopedRequest(server, http.MethodGet, "/provider/antigravity/v1/models", "", map[string]string{"Authorization": "Bearer invalid"})
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("authentication: %d %s", response.Code, response.Body.String())
	}
	response = scopedRequest(server, http.MethodPost, "/v1/chat/completions", `{"model":"`+scopedOutsideModel+`","messages":[{"role":"user","content":"hi"}]}`, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("unscoped execution: %d %s", response.Code, response.Body.String())
	}
}

func TestProviderScopedAffinityAndFailure(t *testing.T) {
	server, executors := newProviderScopeServer(t)
	selector := auth.NewSessionAffinitySelectorWithConfig(auth.SessionAffinityConfig{
		Fallback: &auth.RoundRobinSelector{}, RebindOn: auth.SessionAffinityRebindOnNever,
	})
	t.Cleanup(selector.Stop)
	server.handlers.AuthManager.SetSelector(selector)
	body := `{"model":"` + scopedSharedModel + `","messages":[{"role":"user","content":"hi"}]}`
	headers := map[string]string{"X-Session-ID": "scope-shared-session"}
	for _, prefix := range []string{"", "/provider/claude", "/provider/antigravity", "/provider/mistral", "/provider/claude", "/provider/antigravity"} {
		response := scopedRequest(server, http.MethodPost, prefix+"/v1/chat/completions", body, headers)
		if response.Code != http.StatusOK {
			t.Fatalf("affinity %s: %d %s", prefix, response.Code, response.Body.String())
		}
	}
	claudeCalls := len(executors["claude"].authIDs)
	mistralCalls := len(executors["mistral"].authIDs)
	executors["antigravity"].fail = true
	response := scopedRequest(server, http.MethodPost, "/provider/antigravity/v1/chat/completions", body, headers)
	if response.Code == http.StatusOK || len(executors["claude"].authIDs) != claudeCalls || len(executors["mistral"].authIDs) != mistralCalls {
		t.Fatalf("failure fell through to another provider: %d %s", response.Code, response.Body.String())
	}
}

func TestProviderScopedAliasesPrefixesAndAuto(t *testing.T) {
	server, executors := newProviderScopeServer(t)
	manager := server.handlers.AuthManager
	manager.SetOAuthModelAlias(map[string][]config.OAuthModelAlias{
		"antigravity": {{Name: "antigravity-upstream", Alias: "claude-public-scope"}},
		"claude":      {{Name: "claude-upstream", Alias: "claude-public-scope"}},
	})
	for _, provider := range []string{"antigravity", "claude"} {
		a, _ := manager.GetByID("provider-scope-" + provider)
		a.Prefix = "team"
		if _, errUpdate := manager.Update(context.Background(), a); errUpdate != nil {
			t.Fatal(errUpdate)
		}
		registry.GetGlobalRegistry().RegisterClient(a.ID, provider, []*registry.ModelInfo{{ID: "team/claude-public-scope", OwnedBy: provider}})
	}
	for _, model := range []string{"team/claude-public-scope(8192)", "auto(8192)"} {
		body := `{"model":"` + model + `","messages":[{"role":"user","content":"hi"}]}`
		response := scopedRequest(server, http.MethodPost, "/provider/antigravity/v1/chat/completions", body, nil)
		if response.Code != http.StatusOK {
			t.Fatalf("model=%s status=%d body=%s", model, response.Code, response.Body.String())
		}
		models := executors["antigravity"].models
		if models[len(models)-1] != "antigravity-upstream(8192)" || len(executors["claude"].authIDs) != 0 {
			t.Fatalf("model=%s upstream models=%v claude auths=%v", model, models, executors["claude"].authIDs)
		}
	}
	response := scopedRequest(server, http.MethodPost, "/provider/antigravity/v1/chat/completions", `{"model":"claude-public-scope","messages":[]}`, nil)
	if response.Code != http.StatusBadRequest || ojson.Get(response.Body.String(), "error.code").String() != "model_not_found" {
		t.Fatalf("missing credential prefix: %d %s", response.Code, response.Body.String())
	}
}
