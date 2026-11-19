package api

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/MoeForge/moego/ojson"
	"github.com/gorilla/websocket"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/runtime/executor"
	"github.com/rune-oai/t3code-proxy/internal/tracearchive"
	"github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

func TestTraceArchiveStreamingClaudeThroughServer(t *testing.T) {
	const model = "archive-claude-test"
	const body = `{"model":"archive-claude-test","max_tokens":64,"messages":[{"role":"user","content":"Check the sky"}],"stream":true}`
	wire := make(chan []byte, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		wire <- b
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Set-Cookie", "never-archive-cookie")
		for _, e := range []string{
			`{"type":"message_start","message":{"type":"message","id":"msg_demo","model":"archive-claude-test","role":"assistant","content":[],"usage":{"input_tokens":8}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check the forecast."}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"demo-signature"}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"forecast","input":{}}}`,
			`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"Seoul\"}"}}`,
			`{"type":"content_block_stop","index":1}`,
			`{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}`,
			`{"type":"message_stop"}`,
		} {
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ojson.Get(e, "type").String(), e)
			w.(http.Flusher).Flush()
		}
	}))
	defer upstream.Close()
	cfg := &config.Config{TraceArchive: config.TraceArchiveConfig{Enabled: true, Dir: t.TempDir()}}
	cfg.APIKeys = []string{"never-archive-client-secret"}
	s := newTestServerWithConfig(t, cfg)
	defer s.archive.Close()
	manager := s.handlers.AuthManager
	manager.RegisterExecutor(executor.NewClaudeExecutor(cfg))
	credential := &auth.Auth{ID: "trace-e2e", Provider: "claude", Status: auth.StatusActive, Attributes: map[string]string{"api_key": "never-archive-upstream-secret", "base_url": upstream.URL}}
	if _, err := manager.Register(context.Background(), credential); err != nil {
		t.Fatal(err)
	}
	models := registry.GetGlobalRegistry()
	models.RegisterClient(credential.ID, "claude", []*registry.ModelInfo{{ID: model}})
	defer models.UnregisterClient(credential.ID)
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("X-Api-Key", "never-archive-client-secret")
	req.Header.Set("Authorization", "Bearer never-archive-client-secret")
	req.Header.Set("Cookie", "never-archive-cookie")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), "message_stop") {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body)
	}
	if err := s.archive.Seal(context.Background()); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	if tracearchive.Main([]string{"export", "--dir", cfg.TraceArchive.Dir}, &out, &stderr) != 0 {
		t.Fatal(stderr.String())
	}
	result := ojson.ParseBytes(out.Bytes())
	for k, want := range map[string]string{"transport": "http", "client_protocol": "claude-messages", "requested_model": model, "response.content.0.signature": "demo-signature", "response.content.0.thinking": "Check the forecast.", "response.content.1.input.city": "Seoul", "response.stop_reason": "tool_use", "token_usage.OutputTokens": "12", "attempts.0.status": "200"} {
		if result.Get(k).String() != want {
			t.Errorf("%s = %q; want %q", k, result.Get(k).String(), want)
		}
	}
	if bytes.Contains(out.Bytes(), []byte("never-archive")) {
		t.Fatal("transport credential in archive")
	}
	for key, want := range map[string][]byte{"client_request": []byte(body), "upstream_request": <-wire} {
		if !reflect.DeepEqual(result.Get(key).Value(), ojson.ParseBytes(want).Value()) {
			t.Fatalf("%s differs from wire JSON", key)
		}
	}
	t.Logf("exported response: %s", result.Get("response").Raw)
}

func TestTraceArchiveCodexWebsocketThroughServer(t *testing.T) {
	const model = "trace-ws-model"
	const original = `{"type":"response.create","model":"trace-ws-model","input":[{"role":"user","content":"hello"}]}`
	const done = `{"type":"response.output_item.done","output_index":0,"item":{"id":"i1","type":"reasoning","encrypted_content":"sealed-reasoning","summary":[{"type":"summary_text","text":"abbreviated"}]}}`
	const completed = `{"type":"response.completed","response":{"id":"ws-record","model":"trace-ws-model","output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}`
	sent := make(chan []byte, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var upgrader websocket.Upgrader
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() {
			if errClose := conn.Close(); errClose != nil {
				t.Log(errClose)
			}
		}()
		_, p, err := conn.ReadMessage()
		if err != nil {
			t.Error(err)
			return
		}
		sent <- p
		for _, frame := range []string{`{"type":"response.created","response":{"id":"ws-record","output":[]}}`, done, completed} {
			if err = conn.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
				t.Error(err)
				return
			}
		}
		// Keep the connection available until the downstream client completes.
		_, _, _ = conn.ReadMessage()
	}))
	defer upstream.Close()
	cfg := &config.Config{TraceArchive: config.TraceArchiveConfig{Enabled: true, Dir: t.TempDir()}}
	cfg.APIKeys = []string{"test-key"}
	s := newTestServerWithConfig(t, cfg)
	defer s.archive.Close()
	manager := s.handlers.AuthManager
	manager.RegisterExecutor(executor.NewCodexAutoExecutor(cfg))
	credential := &auth.Auth{ID: "trace-ws-e2e", Provider: "codex", Status: auth.StatusActive, Attributes: map[string]string{"websockets": "true", "api_key": "fake-ws-key", "base_url": upstream.URL}}
	if _, err := manager.Register(context.Background(), credential); err != nil {
		t.Fatal(err)
	}
	catalog := registry.GetGlobalRegistry()
	catalog.RegisterClient(credential.ID, "codex", []*registry.ModelInfo{{ID: model}})
	defer catalog.UnregisterClient(credential.ID)
	finished := make(chan struct{})
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { defer close(finished); s.Handler().ServeHTTP(w, r) }))
	defer hub.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(hub.URL, "http")+"/v1/responses", http.Header{"Authorization": {"Bearer test-key"}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if err = conn.WriteMessage(websocket.TextMessage, []byte(original)); err != nil {
		t.Fatal(err)
	}
	for {
		_, frame, errRead := conn.ReadMessage()
		if errRead != nil {
			t.Fatal(errRead)
		}
		typ := ojson.GetBytes(frame, "type").String()
		if typ == "error" || typ == "response.failed" {
			t.Fatal(string(frame))
		}
		if typ == "response.completed" {
			break
		}
	}
	if err = conn.Close(); err != nil {
		t.Fatal(err)
	}
	<-finished
	if err = s.archive.Seal(context.Background()); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	if tracearchive.Main([]string{"export", "--dir", cfg.TraceArchive.Dir}, &out, &stderr) != 0 {
		t.Fatal(stderr.String())
	}
	record := ojson.ParseBytes(out.Bytes())
	if record.Get("response.output.0.encrypted_content").String() != "sealed-reasoning" || record.Get("response.output.0.summary.0.text").String() != "abbreviated" || record.Get("transport").String() != "ws" || record.Get("attempts.0.transport").String() != "ws" {
		t.Fatal(out.String())
	}
	if !reflect.DeepEqual(record.Get("client_request").Value(), ojson.Parse(original).Value()) || !reflect.DeepEqual(record.Get("upstream_request").Value(), ojson.ParseBytes(<-sent).Value()) {
		t.Fatal("websocket payload differs from wire")
	}
}

func TestTraceArchiveManagement(t *testing.T) {
	t.Setenv("MANAGEMENT_PASSWORD", "test-password")
	cfg := &config.Config{TraceArchive: config.TraceArchiveConfig{Dir: t.TempDir()}}
	s := newTestServerWithConfig(t, cfg, WithLocalManagementPassword("test-password"))
	defer s.archive.Close()
	if err := os.WriteFile(s.configFilePath, []byte("config-version: 8\n"), 0600); err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string, status int) string {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("Authorization", "Bearer test-password")
		w := httptest.NewRecorder()
		s.engine.ServeHTTP(w, req)
		if w.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		return w.Body.String()
	}
	const base = "/v8/management/trace-archive/"
	request("GET", "/v0/management/trace-archive/status", "", 404)
	request("GET", base+"settings", "", 200)
	request("POST", base+"seal-now", "", 409)
	request("PUT", base+"settings", `{"enabled":true,"recipients":["bad"]}`, 422)
	settings := ojson.NewDocString(`{"enabled":true}`)
	_ = settings.Set("dir", cfg.TraceArchive.Dir)
	request("PUT", base+"settings", settings.String(), 200)
	if !ojson.Get(request("GET", base+"settings", "", 200), "enabled").Bool() {
		t.Fatal("settings read missed persisted update")
	}
	// Exercise the same update callback as the file watcher.
	raw, err := os.ReadFile(s.configFilePath)
	if err != nil {
		t.Fatal(err)
	}
	next, err := config.ParseConfigBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	s.UpdateClients(next)
	if !ojson.Get(request("GET", base+"status", "", 200), "enabled").Bool() {
		t.Fatal("watcher did not enable recorder")
	}
	request("POST", base+"seal-now", "", 200)
}
