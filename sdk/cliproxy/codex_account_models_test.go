package cliproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/rune-oai/t3code-proxy/internal/registry"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
	"github.com/rune-oai/t3code-proxy/sdk/config"
)

// codexModelsExecutor answers the Codex model list request with body.
type codexModelsExecutor struct {
	body []byte
	mu   sync.Mutex
	reqs []*http.Request
}

func (e *codexModelsExecutor) Identifier() string { return "codex" }

func (e *codexModelsExecutor) Refresh(_ context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	return auth, nil
}

func (e *codexModelsExecutor) Execute(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, nil
}

func (e *codexModelsExecutor) ExecuteStream(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	return nil, nil
}

func (e *codexModelsExecutor) CountTokens(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, nil
}

func (e *codexModelsExecutor) HttpRequest(_ context.Context, _ *coreauth.Auth, req *http.Request) (*http.Response, error) {
	e.mu.Lock()
	e.reqs = append(e.reqs, req)
	e.mu.Unlock()
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(e.body))}, nil
}

func (e *codexModelsExecutor) requests() []*http.Request {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]*http.Request(nil), e.reqs...)
}

// liveCodexModelsBody mimics GET /backend-api/codex/models: the catalog's
// gpt-6.1-sol entry plus the same entry renamed to gpt-6.2-sol.
func liveCodexModelsBody(t *testing.T) []byte {
	t.Helper()
	var catalog struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(registry.GetCodexClientModelsJSON(), &catalog); err != nil {
		t.Fatalf("decode catalog: %v", err)
	}
	var models []map[string]any
	for _, model := range catalog.Models {
		if model["slug"] != "gpt-6.1-sol" {
			continue
		}
		newer := make(map[string]any, len(model))
		for key, value := range model {
			newer[key] = value
		}
		newer["slug"] = "gpt-6.2-sol"
		newer["display_name"] = "GPT-6.2-Sol"
		models = append(models, newer, model)
	}
	if len(models) == 0 {
		t.Fatal("catalog has no gpt-6.1-sol entry")
	}
	body, err := json.Marshal(map[string]any{"models": models})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return body
}

func (s *Service) codexAccountModelsIdle(authID string) bool {
	s.codexAccountModels.mu.Lock()
	defer s.codexAccountModels.mu.Unlock()
	_, running := s.codexAccountModels.inFlight[authID]
	return !running
}

func registeredModelIDs(authID string) map[string]bool {
	ids := make(map[string]bool)
	for _, model := range GlobalModelRegistry().GetModelsForClient(authID) {
		if model != nil {
			ids[model.ID] = true
		}
	}
	return ids
}

func TestCodexAccountModelsRegisterModelsTheCatalogLacks(t *testing.T) {
	if registry.LookupStaticModelInfo("gpt-6.2-sol") != nil {
		t.Skip("the catalog already lists gpt-6.2-sol")
	}
	ctx, cancel := context.WithCancel(context.Background())
	exec := &codexModelsExecutor{body: liveCodexModelsBody(t)}
	manager := coreauth.NewManager(nil, nil, nil)
	manager.RegisterExecutor(exec)
	svc := &Service{cfg: &config.Config{}, coreManager: manager, antigravityContext: ctx}
	svc.registerModelRefreshCallback()

	auth := &coreauth.Auth{
		ID:         "codex-account-models-test",
		Provider:   "codex",
		Attributes: map[string]string{"plan_type": "plus"},
		Metadata:   map[string]any{"access_token": "token", "account_id": "acct-123"},
	}
	t.Cleanup(func() {
		cancel()
		registry.SetModelRefreshCallback(nil)
		registry.ResetCodexAccountModels()
		GlobalModelRegistry().UnregisterClient(auth.ID)
	})
	if _, err := manager.Register(context.Background(), auth); err != nil {
		t.Fatalf("register auth: %v", err)
	}
	svc.registerModelsForAuth(context.Background(), auth)

	deadline := time.Now().Add(5 * time.Second)
	for !registeredModelIDs(auth.ID)["gpt-6.2-sol"] || !svc.codexAccountModelsIdle(auth.ID) {
		if time.Now().After(deadline) {
			t.Fatalf("gpt-6.2-sol was not registered; models: %v", registeredModelIDs(auth.ID))
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !registeredModelIDs(auth.ID)["gpt-6.1-sol"] {
		t.Fatal("catalog models must stay registered")
	}

	reqs := exec.requests()
	if len(reqs) != 1 {
		t.Fatalf("model list read %d times, want once", len(reqs))
	}
	req := reqs[0]
	if req.URL.Host != "chatgpt.com" || req.URL.Path != "/backend-api/codex/models" ||
		req.URL.Query().Get("client_version") != registry.CodexAccountModelsClientVersion {
		t.Fatalf("unexpected request URL %s", req.URL)
	}
	if got := req.Header.Get("Chatgpt-Account-Id"); got != "acct-123" {
		t.Fatalf("Chatgpt-Account-Id = %q, want acct-123", got)
	}

	// A re-registration within the minimum interval does not read again.
	svc.registerModelsForAuth(context.Background(), auth)
	if !svc.codexAccountModelsIdle(auth.ID) || len(exec.requests()) != 1 {
		t.Fatalf("re-registration read the model list again (%d reads)", len(exec.requests()))
	}
}

func TestCodexAccountModelsSkipAPIKeysAndStoppedServices(t *testing.T) {
	exec := &codexModelsExecutor{body: []byte(`{"models":[]}`)}
	manager := coreauth.NewManager(nil, nil, nil)
	manager.RegisterExecutor(exec)

	stopped := &Service{cfg: &config.Config{}, coreManager: manager}
	oauth := &coreauth.Auth{ID: "codex-oauth", Provider: "codex", Metadata: map[string]any{"access_token": "token"}}
	stopped.refreshCodexAccountModelsAsync(oauth)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	running := &Service{cfg: &config.Config{}, coreManager: manager, antigravityContext: ctx}
	apiKey := &coreauth.Auth{ID: "codex-key", Provider: "codex", Attributes: map[string]string{"api_key": "sk-test"}}
	running.refreshCodexAccountModelsAsync(apiKey)

	if len(exec.requests()) != 0 || !stopped.codexAccountModelsIdle(oauth.ID) || !running.codexAccountModelsIdle(apiKey.ID) {
		t.Fatal("model lists must only be read for ChatGPT logins of a running service")
	}
}

func TestCodexAccountModelsStateThrottles(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	st := codexAccountModelsState{now: func() time.Time { return now }}
	if !st.claim("a") {
		t.Fatal("first claim refused")
	}
	if st.claim("a") {
		t.Fatal("claim accepted while a read is running")
	}
	st.finish("a", codexAccountModelsRetryInterval, false)
	if st.claim("a") {
		t.Fatal("claim accepted before the retry interval")
	}
	now = now.Add(codexAccountModelsRetryInterval)
	if !st.claim("a") {
		t.Fatal("claim refused after the retry interval")
	}
	st.finish("a", codexAccountModelsMinInterval, true)
	if !st.claim("a") {
		t.Fatal("a forgotten credential should be readable again")
	}
}
