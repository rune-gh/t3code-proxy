package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const testModelsDevCatalog = `{
	"anthropic": {"id": "anthropic", "models": {"claude-x": {"id": "claude-x"}}},
	"opencode": {
		"id": "opencode",
		"env": ["OPENCODE_API_KEY"],
		"npm": "@ai-sdk/openai-compatible",
		"api": "https://opencode.ai/inference/openai/v1",
		"name": "OpenCode",
		"models": {"big-pickle": {"id": "big-pickle", "cost": {"input": 0, "output": 0}}}
	}
}`

func TestOpenCodeCatalogKeepsOpenCodesOwnProvider(t *testing.T) {
	stubOpenCodeUpstream(t, func(context.Context, string) ([]byte, error) { return []byte(testModelsDevCatalog), nil })
	server := newTestServer(t)

	recorder := httptest.NewRecorder()
	server.engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/opencode/test-key/api.json", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
	}
	var catalog map[string]struct {
		API    string                     `json:"api"`
		Models map[string]json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &catalog); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := catalog[openCodeProviderID]; !ok {
		t.Fatalf("hub provider missing: %s", recorder.Body.String())
	}
	opencode, ok := catalog[openCodeUpstreamProviderID]
	if !ok || opencode.API != "https://opencode.ai/inference/openai/v1" {
		t.Fatalf("opencode provider = %+v, body %s", opencode, recorder.Body.String())
	}
	if _, ok := opencode.Models["big-pickle"]; !ok {
		t.Fatalf("opencode free model missing: %s", recorder.Body.String())
	}
	if _, ok := catalog["anthropic"]; ok {
		t.Fatal("only the opencode provider is copied from models.dev")
	}
}

func TestOpenCodeUpstreamCachesAndKeepsTheLastGoodCopy(t *testing.T) {
	var calls atomic.Int32
	var fail atomic.Bool
	upstream := newOpenCodeUpstreamCatalog("https://models.example/api.json", func(context.Context, string) ([]byte, error) {
		calls.Add(1)
		if fail.Load() {
			return nil, errors.New("offline")
		}
		return []byte(testModelsDevCatalog), nil
	})
	now := time.Unix(1790000000, 0)
	upstream.now = func() time.Time { return now }

	if upstream.Provider(time.Minute) == nil {
		t.Fatal("first request should wait for the first copy")
	}
	if upstream.Provider(time.Minute) == nil || calls.Load() != 1 {
		t.Fatalf("a fresh copy must be served from cache, fetches = %d", calls.Load())
	}

	fail.Store(true)
	now = now.Add(openCodeUpstreamTTL)
	if upstream.Provider(time.Minute) == nil {
		t.Fatal("a stale copy must be served while refreshing")
	}
	waitForOpenCodeRefresh(t, upstream)
	if upstream.Provider(0) == nil {
		t.Fatal("a failed refresh must keep the last copy")
	}
	if calls.Load() != 2 {
		t.Fatalf("a failed refresh must back off before retrying, fetches = %d", calls.Load())
	}
}

func TestOpenCodeUpstreamRejectsACatalogWithoutTheProvider(t *testing.T) {
	upstream := newOpenCodeUpstreamCatalog("https://models.example/api.json", func(context.Context, string) ([]byte, error) {
		return []byte(`{"anthropic": {"models": {}}}`), nil
	})
	if got := upstream.Provider(time.Minute); got != nil {
		t.Fatalf("provider = %s", got)
	}
}

func waitForOpenCodeRefresh(t *testing.T, upstream *openCodeUpstreamCatalog) {
	t.Helper()
	upstream.mu.Lock()
	inflight := upstream.inflight
	upstream.mu.Unlock()
	if inflight != nil {
		<-inflight
	}
}
