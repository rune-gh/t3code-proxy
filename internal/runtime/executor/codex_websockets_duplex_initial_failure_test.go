package executor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"filippo.io/age"
	"github.com/MoeForge/moego/ojson"
	"github.com/gorilla/websocket"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/tracearchive"
	auth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	core "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
	translator "github.com/rune-oai/t3code-proxy/sdk/translator"
)

// export drains the recorder and reads the live calls after the executor finishes.
func beginTestDuplexArchive(t *testing.T, ctx context.Context, body []byte) (context.Context, *tracearchive.Capture, func() []ojson.Result) {
	t.Helper()
	dir := t.TempDir()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	r := new(tracearchive.Recorder)
	if err = r.Apply(&config.Config{TraceArchive: config.TraceArchiveConfig{Dir: dir, Enabled: true, Recipients: []string{id.Recipient().String()}}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	req := httptest.NewRequestWithContext(ctx, "GET", "/v1/responses", nil)
	ctx, c := tracearchive.Begin(r.Bind(req, "openai-responses", "test"), true, body)
	return ctx, c, func() []ojson.Result {
		r.Close()
		var out, stderr bytes.Buffer
		if tracearchive.Main([]string{"export", "--dir", dir}, &out, &stderr) != 0 {
			t.Fatal(stderr.String())
		}
		var calls []ojson.Result
		for line := range strings.Lines(out.String()) {
			calls = append(calls, ojson.Parse(line))
		}
		return calls
	}
}

func TestCodexDuplexInitialFailure(t *testing.T) {
	for _, tc := range []struct {
		name, payload  string
		status         int
		quota, headers bool
	}{
		{"response_failed_auth", `{"type":"response.failed","response":{"error":{"type":"authentication_error","message":"expired credential"}}}`, 401, false, false},
		{"response_failed_quota", `{"type":"response.failed","response":{"error":{"type":"usage_limit_reached","message":"quota exhausted","resets_in_seconds":3600}}}`, 429, true, false},
		// The top-level status is authoritative even when the error type is generic.
		{"error_auth", `{"type":"error","status":401,"headers":{"X-Request-Id":"initial-rejection"},"error":{"type":"server_error","message":"expired credential"}}`, 401, false, true},
		{"error_quota", `{"type":"error","status_code":429,"headers":{"X-Request-Id":"initial-rejection"},"error":{"type":"usage_limit_reached","message":"quota exhausted","resets_in_seconds":3600}}`, 429, true, true},
	} {
		for _, failover := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/failover=%t", tc.name, failover), func(t *testing.T) {
				var rejected, succeeded atomic.Int32
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					c, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
					if err != nil {
						t.Error(err)
						return
					}
					defer func() { _ = c.Close() }()
					// Bound a broken test without making server closure drive client recovery.
					_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
					if _, _, err = c.ReadMessage(); err != nil {
						t.Error(err)
						return
					}
					payloads := []string{tc.payload}
					if r.Header.Get("Authorization") == "Bearer bad-key" {
						rejected.Add(1)
					} else {
						succeeded.Add(1)
						payloads = []string{
							`{"type":"response.created","response":{"id":"healthy-response","output":[]}}`,
							`{"type":"response.completed","response":{"id":"healthy-response","output":[]}}`,
						}
					}
					for _, payload := range payloads {
						if err = c.WriteMessage(websocket.TextMessage, []byte(payload)); err != nil {
							t.Error(err)
							return
						}
					}
					// Keep the rejected socket open: the executor must terminate it itself.
					_, _, _ = c.ReadMessage()
				}))
				defer upstream.Close()
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				ctx = core.WithWebsocketInput(core.WithDownstreamWebsocket(ctx), make(chan core.WebsocketInput))
				cfg := &config.Config{}
				cfg.Codex.ResponseSteering = true
				cfg.CodexResponseSteering = true
				exec := NewCodexWebsocketsExecutor(cfg)
				exec.store = &codexWebsocketSessionStore{sessions: make(map[string]*codexWebsocketSession)}
				model := "duplex-initial-failure-model"
				bad := &auth.Auth{ID: "duplex-initial-bad", Provider: "codex", Status: auth.StatusActive, Attributes: map[string]string{
					"api_key": "bad-key", "base_url": upstream.URL, "websockets": "true", "priority": "4",
				}}
				req := core.Request{Model: model, Payload: []byte(`{"model":"duplex-initial-failure-model","input":[]}`)}
				opts := core.Options{SourceFormat: translator.FromString("codex"), Metadata: map[string]any{core.ExecutionSessionMetadataKey: t.Name()}}
				if !failover {
					result, err := exec.ExecuteStream(ctx, bad, req, opts)
					if err != nil {
						t.Fatal(err)
					}
					chunk, ok := <-result.Chunks
					if !ok || chunk.Err == nil || len(chunk.Payload) != 0 {
						t.Fatalf("initial rejection must be an error chunk, got %+v (open=%v)", chunk, ok)
					}
					var status interface{ StatusCode() int }
					if !errors.As(chunk.Err, &status) || status.StatusCode() != tc.status {
						t.Fatalf("status lost: %v", chunk.Err)
					}
					var scoped interface{ IsRequestScoped() bool }
					if errors.As(chunk.Err, &scoped) && scoped.IsRequestScoped() {
						t.Fatal("upstream rejection became a connection-only error")
					}
					if tc.quota {
						var quota interface{ IsCredentialScoped() bool }
						var retry interface{ RetryAfter() *time.Duration }
						if !errors.As(chunk.Err, &quota) || !quota.IsCredentialScoped() {
							t.Fatal("credential quota scope lost")
						}
						if !errors.As(chunk.Err, &retry) || retry.RetryAfter() == nil || *retry.RetryAfter() != time.Hour {
							t.Fatal("upstream retry delay lost")
						}
					}
					if tc.headers {
						var headers interface{ Headers() http.Header }
						if !errors.As(chunk.Err, &headers) || headers.Headers().Get("X-Request-Id") != "initial-rejection" {
							t.Fatal("upstream error headers lost")
						}
					}
					select {
					case _, ok := <-result.Chunks:
						if ok {
							t.Fatal("rejected stream remained open")
						}
					case <-ctx.Done():
						t.Fatal("rejected stream did not terminate")
					}
				} else {
					manager := auth.NewManager(nil, &auth.FillFirstSelector{}, nil)
					manager.SetConfig(cfg)
					manager.SetRetryConfig(3, 30*time.Second, 0)
					manager.RegisterExecutor(exec)
					good := &auth.Auth{ID: "duplex-initial-good", Provider: "codex", Status: auth.StatusActive, Attributes: map[string]string{
						"api_key": "good-key", "base_url": upstream.URL, "websockets": "true", "priority": "3",
					}}
					for _, candidate := range []*auth.Auth{bad, good} {
						registry.GetGlobalRegistry().RegisterClient(candidate.ID, "codex", []*registry.ModelInfo{{ID: model}})
						t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(candidate.ID) })
						if _, err := manager.Register(ctx, candidate); err != nil {
							t.Fatal(err)
						}
					}
					ctx, initialCapture, export := beginTestDuplexArchive(t, ctx, req.Payload)
					before := time.Now()
					result, err := manager.ExecuteStream(ctx, []string{"codex"}, req, opts)
					if err != nil {
						t.Fatal(err)
					}
					completed := false
					for chunk := range result.Chunks {
						if chunk.Err != nil {
							t.Fatal(chunk.Err)
						}
						if ojson.GetBytes(chunk.Payload, "type").String() == "response.completed" {
							completed = ojson.GetBytes(chunk.Payload, "response.id").String() == "healthy-response"
							cancel()
						} else if ojson.GetBytes(chunk.Payload, "type").String() != "response.created" {
							t.Fatalf("rejected account payload escaped bootstrap: %s", chunk.Payload)
						}
					}
					initialCapture.Finish(200)
					t.Run("ArchiveAfterFailover", func(t *testing.T) {
						calls := export()
						if len(calls) != 1 || calls[0].Get("status").Int() != 200 || calls[0].Get("failed").Bool() || calls[0].Get("response.id").String() != "healthy-response" || len(calls[0].Get("attempts").Array()) != 2 || calls[0].Get("attempts.0.status").Int() != int64(tc.status) || calls[0].Get("attempts.1.status").Int() != 200 {
							t.Fatalf("failover archive: %v", calls)
						}
					})
					if !completed {
						t.Fatal("healthy account never completed")
					}
					current, _ := manager.GetByID(bad.ID)
					state := current.ModelStates[model]
					if state == nil || state.LastError == nil || state.LastError.HTTPStatus != tc.status || !state.Unavailable {
						t.Fatalf("initial failure was not recorded: %+v", state)
					}
					if tc.quota && (current.Quota.Reason != "credential_quota" || current.Quota.NextRecoverAt.Before(before.Add(time.Hour))) {
						t.Fatalf("credential quota cooldown lost: %+v", current.Quota)
					}
				}
				wantSucceeded := int32(0)
				if failover {
					wantSucceeded = 1
				}
				if rejected.Load() != 1 || succeeded.Load() != wantSucceeded {
					t.Fatalf("attempts: rejected=%d healthy=%d", rejected.Load(), succeeded.Load())
				}
			})
		}
	}
}
