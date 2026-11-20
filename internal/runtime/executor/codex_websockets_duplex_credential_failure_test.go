package executor

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/gorilla/websocket"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	auth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	core "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
	translator "github.com/rune-oai/t3code-proxy/sdk/translator"
)

func TestCodexDuplexQueuedCredentialRejectionArchive(t *testing.T) {
	const rejection = `{"type":"error","status":401,"error":{"type":"authentication_error","message":"queued create rejected"}}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = c.Close() }()
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		for _, frames := range [][]string{
			{`{"type":"response.created","response":{"id":"first","output":[]}}`, `{"type":"response.completed","response":{"id":"first","output":[]}}`},
			{rejection},
		} {
			if _, _, err = c.ReadMessage(); err != nil {
				t.Error(err)
				return
			}
			for _, frame := range frames {
				if err = c.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
					t.Error(err)
					return
				}
			}
		}
		_, _, _ = c.ReadMessage()
	}))
	defer upstream.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	input := make(chan core.WebsocketInput, 1)
	ctx = core.WithWebsocketInput(core.WithDownstreamWebsocket(ctx), input)
	req := core.Request{Model: "gpt-6-astra", Payload: []byte(`{"model":"gpt-6-astra","input":[]}`)}
	ctx, initial, export := beginTestDuplexArchive(t, ctx, req.Payload)
	exec := NewCodexWebsocketsExecutor(&config.Config{Codex: config.CodexConfig{ResponseSteering: true}})
	credential := &auth.Auth{ID: t.Name(), Provider: "codex", Attributes: map[string]string{"api_key": "test", "base_url": upstream.URL, "websockets": "true"}}
	result, err := exec.ExecuteStream(ctx, credential, req, core.Options{SourceFormat: translator.FromString("codex"), Metadata: map[string]any{core.ExecutionSessionMetadataKey: t.Name()}})
	if err != nil {
		t.Fatal(err)
	}
	for chunk := range result.Chunks {
		if ojson.GetBytes(chunk.Payload, "type").String() == "response.completed" {
			input <- core.WebsocketInput{Payload: []byte(`{"type":"response.create","event_id":"queued","input":[]}`)}
		}
	}
	// The handler can still be forwarding the first completion when the socket fails.
	initial.Status(502)
	initial.Finish(502)
	calls := export()
	if len(calls) != 2 {
		t.Fatalf("got %d calls, want 2", len(calls))
	}
	for _, call := range calls {
		if call.Get("client_request.event_id").String() == "queued" {
			if call.Get("status").Int() != 401 || !call.Get("failed").Bool() || call.Get("response.error.message").String() != "queued create rejected" {
				t.Errorf("queued rejection = %s", call.Raw)
			}
		} else if call.Get("status").Int() != 200 || call.Get("attempts.0.status").Int() != 200 || call.Get("failed").Bool() || call.Get("response.id").String() != "first" {
			t.Errorf("initial completion = %s", call.Raw)
		}
	}
}

func TestCodexDuplexLaterCredentialFailure(t *testing.T) {
	for _, kind := range []string{"error", "response.failed"} {
		for _, status := range []int{401, 403, 429} {
			for _, queued := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%d/queued=%t", kind, status, queued), func(t *testing.T) {
					var attempts atomic.Int32
					done := make(chan struct{})
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						defer close(done)
						attempts.Add(1)
						c, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
						if err != nil {
							t.Error(err)
							return
						}
						defer func() { _ = c.Close() }()
						_ = c.SetReadDeadline(time.Now().Add(8 * time.Second))
						if _, _, err = c.ReadMessage(); err != nil {
							t.Error(err)
							return
						}
						write := func(p string) {
							if e := c.WriteMessage(websocket.TextMessage, []byte(p)); e != nil {
								t.Error(e)
							}
						}
						write(`{"type":"response.created","response":{"id":"started","output":[]}}`)
						if queued {
							if _, _, err = c.ReadMessage(); err != nil {
								t.Error(err)
								return
							}
						} else {
							write(`{"type":"response.completed","response":{"id":"started","output":[]}}`)
						}
						errorType := "authentication_error"
						if status == 403 {
							errorType = "permission_error"
						}
						if status == 429 {
							errorType = "usage_limit_reached"
						}
						errorBody := fmt.Sprintf(`{"type":%q,"status":%d,"message":"credential rejected","resets_in_seconds":3600}`, errorType, status)
						if kind == "error" {
							write(fmt.Sprintf(`{"type":"error","status":%d,"headers":{"X-Request-Id":"later-rejection"},"error":%s}`, status, errorBody))
						} else {
							write(fmt.Sprintf(`{"type":"response.failed","response":{"id":"started","error":%s}}`, errorBody))
						}
						// The proxy must terminate this still-open socket on its own.
						_, _, _ = c.ReadMessage()
					}))
					defer upstream.Close()
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					input := make(chan core.WebsocketInput, 1)
					ctx = core.WithWebsocketInput(core.WithDownstreamWebsocket(ctx), input)
					cfg := &config.Config{}
					cfg.Codex.ResponseSteering = true
					cfg.CodexResponseSteering = true
					executor := NewCodexWebsocketsExecutor(cfg)
					executor.store = &codexWebsocketSessionStore{sessions: make(map[string]*codexWebsocketSession)}
					manager := auth.NewManager(nil, &auth.FillFirstSelector{}, nil)
					manager.SetConfig(cfg)
					manager.SetRetryConfig(3, 30*time.Second, 0)
					manager.RegisterExecutor(executor)
					model := "later-credential-model"
					bad := &auth.Auth{ID: t.Name() + "-bad", Provider: "codex", Status: auth.StatusActive, Attributes: map[string]string{"api_key": "test", "base_url": upstream.URL, "websockets": "true", "priority": "4"}}
					good := &auth.Auth{ID: t.Name() + "-good", Provider: "codex", Status: auth.StatusActive, Attributes: map[string]string{"api_key": "unused", "base_url": upstream.URL, "websockets": "true", "priority": "3"}}
					for _, candidate := range []*auth.Auth{bad, good} {
						registry.GetGlobalRegistry().RegisterClient(candidate.ID, "codex", []*registry.ModelInfo{{ID: model}})
						t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(candidate.ID) })
						if _, err := manager.Register(ctx, candidate); err != nil {
							t.Fatal(err)
						}
					}
					req := core.Request{Model: model, Payload: []byte(`{"model":"later-credential-model","input":[]}`)}
					opts := core.Options{SourceFormat: translator.FromString("codex"), Metadata: map[string]any{core.ExecutionSessionMetadataKey: t.Name()}}
					before := time.Now()
					result, err := manager.ExecuteStream(ctx, []string{"codex"}, req, opts)
					if err != nil {
						t.Fatal(err)
					}
					payloadSeen, terminalSeen := false, false
					for chunk := range result.Chunks {
						if chunk.Err != nil {
							terminalSeen = true
							var coded interface{ StatusCode() int }
							if !errors.As(chunk.Err, &coded) || coded.StatusCode() != status {
								t.Errorf("terminal classification lost: %v", chunk.Err)
							}
							var scoped interface{ IsRequestScoped() bool }
							if errors.As(chunk.Err, &scoped) && scoped.IsRequestScoped() {
								t.Error("credential failure became request-scoped")
							}
							if !payloadSeen {
								t.Error("original failure not forwarded before terminal error")
							}
							continue
						}
						event := ojson.GetBytes(chunk.Payload, "type").String()
						if event == "response.created" && queued {
							input <- core.WebsocketInput{Payload: []byte(`{"type":"response.create","input":[]}`)}
						}
						if event == kind {
							payloadSeen = true
						}
					}
					if !payloadSeen || !terminalSeen {
						t.Errorf("failure payload=%t terminal=%t", payloadSeen, terminalSeen)
					}
					current, _ := manager.GetByID(bad.ID)
					state := current.ModelStates[model]
					if state == nil || state.LastError == nil || state.LastError.HTTPStatus != status || !state.Unavailable {
						t.Errorf("account failure not recorded: %+v", state)
					}
					if status == 429 && (current.Quota.Reason != "credential_quota" || current.Quota.NextRecoverAt.Before(before.Add(time.Hour))) {
						t.Errorf("quota scope or retry delay lost: %+v", current.Quota)
					}
					healthy, _ := manager.GetByID(good.ID)
					if healthy.Unavailable || healthy.LastError != nil {
						t.Error("unrelated healthy account changed")
					}
					select {
					case <-done:
					case <-time.After(3 * time.Second):
						t.Fatal("socket cleanup stalled")
					}
					if attempts.Load() != 1 {
						t.Fatalf("started response replayed across %d attempts", attempts.Load())
					}
				})
			}
		}
	}
}
