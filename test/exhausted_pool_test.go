package test

// T3 Code assumes a hub answers with a usage limit only when every account it
// routes the provider to is spent. These tests pin that: with one limited
// account the request succeeds on the other within the same client request,
// and with every account limited the client receives the limit error.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	runtimeexecutor "github.com/rune-oai/t3code-proxy/internal/runtime/executor"
	_ "github.com/rune-oai/t3code-proxy/internal/translator"
	"github.com/rune-oai/t3code-proxy/sdk/api/handlers"
	claudehandlers "github.com/rune-oai/t3code-proxy/sdk/api/handlers/claude"
	openaihandlers "github.com/rune-oai/t3code-proxy/sdk/api/handlers/openai"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	sdkconfig "github.com/rune-oai/t3code-proxy/sdk/config"
)

type poolUpstream struct {
	mu       sync.Mutex
	limited  map[string]bool
	attempts []string
}

func (p *poolUpstream) record(key string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.attempts = append(p.attempts, key)
	return p.limited[key]
}

func (p *poolUpstream) seen() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.attempts...)
}

func TestExhaustedPoolOnlyWhenEveryAccountIsLimited(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, provider := range []string{"claude", "codex"} {
		for _, tc := range []struct {
			name       string
			limited    map[string]bool
			wantStatus int
		}{
			{"one limited", map[string]bool{"key-a": true}, http.StatusOK},
			{"all limited", map[string]bool{"key-a": true, "key-b": true}, http.StatusTooManyRequests},
		} {
			t.Run(provider+"/"+tc.name, func(t *testing.T) {
				up := &poolUpstream{limited: tc.limited}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					key := r.Header.Get("X-Api-Key")
					if key == "" {
						key = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
					}
					body, _ := io.ReadAll(r.Body)
					if up.record(key) {
						writeLimit(w, provider)
						return
					}
					writeSuccess(w, provider, strings.Contains(string(body), `"stream":true`))
				}))
				defer server.Close()

				model := fmt.Sprintf("pool-%s-%d", provider, time.Now().UnixNano())
				manager := coreauth.NewManager(nil, &coreauth.SoonestResetFirstSelector{}, nil)
				manager.SetRetryConfig(0, 0, 0)
				cfg := &config.Config{}
				if provider == "claude" {
					manager.RegisterExecutor(runtimeexecutor.NewClaudeExecutor(cfg))
				} else {
					manager.RegisterExecutor(runtimeexecutor.NewCodexExecutor(cfg))
				}
				for i, key := range []string{"key-a", "key-b"} {
					id := fmt.Sprintf("%s-%s", model, key)
					registry.GetGlobalRegistry().RegisterClient(id, provider, []*registry.ModelInfo{{ID: model}})
					t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(id) })
					// key-a ranks first: its weekly window resets sooner.
					reset := time.Now().Add(time.Duration(i+1) * 24 * time.Hour).Unix()
					signals := map[string]string{"Anthropic-Ratelimit-Unified-7d-Reset": fmt.Sprint(reset)}
					if provider == "codex" {
						signals = map[string]string{"X-Codex-Secondary-Window-Minutes": "10080", "X-Codex-Secondary-Reset-At": fmt.Sprint(reset)}
					}
					if _, errRegister := manager.Register(context.Background(), &coreauth.Auth{
						ID: id, Provider: provider, Status: coreauth.StatusActive,
						Attributes: map[string]string{"base_url": server.URL, "api_key": key},
						Quota:      coreauth.QuotaState{ObservedAt: time.Now().Add(-time.Minute), Signals: signals},
					}); errRegister != nil {
						t.Fatal(errRegister)
					}
				}

				base := handlers.NewBaseAPIHandlers(&sdkconfig.SDKConfig{}, manager)
				router := gin.New()
				var path, reqBody string
				if provider == "claude" {
					path = "/v1/messages"
					router.POST(path, claudehandlers.NewClaudeCodeAPIHandler(base).ClaudeMessages)
					reqBody = `{"model":"` + model + `","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`
				} else {
					path = "/v1/responses"
					router.POST(path, openaihandlers.NewOpenAIResponsesAPIHandler(base).Responses)
					reqBody = `{"model":"` + model + `","input":"hi"}`
				}
				req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(reqBody))
				req.Header.Set("Content-Type", "application/json")
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)

				attempts := up.seen()
				if rec.Code != tc.wantStatus {
					t.Fatalf("status=%d want %d; attempts=%v body=%s", rec.Code, tc.wantStatus, attempts, rec.Body.String())
				}
				if len(attempts) != 2 || attempts[0] != "key-a" || attempts[1] != "key-b" {
					t.Fatalf("attempts=%v, want [key-a key-b] (limited account first, then failover)", attempts)
				}
				if tc.wantStatus == http.StatusOK && !strings.Contains(rec.Body.String(), "ok from pool") {
					t.Fatalf("success body missing upstream text: %s", rec.Body.String())
				}
				if tc.wantStatus == http.StatusTooManyRequests && !strings.Contains(strings.ToLower(rec.Body.String()), "limit") {
					t.Fatalf("limit body missing limit error: %s", rec.Body.String())
				}
			})
		}
	}
}

func writeLimit(w http.ResponseWriter, provider string) {
	reset := fmt.Sprint(time.Now().Add(3 * time.Hour).Unix())
	w.Header().Set("Content-Type", "application/json")
	if provider == "claude" {
		w.Header().Set("Anthropic-Ratelimit-Unified-Status", "rejected")
		w.Header().Set("Anthropic-Ratelimit-Unified-Reset", reset)
		w.Header().Set("Anthropic-Ratelimit-Unified-5h-Status", "rejected")
		w.Header().Set("Anthropic-Ratelimit-Unified-5h-Reset", reset)
		w.Header().Set("Anthropic-Ratelimit-Unified-Representative-Claim", "five_hour")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit."}}`)
		return
	}
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = io.WriteString(w, `{"error":{"type":"usage_limit_reached","message":"You've hit your usage limit.","resets_in_seconds":10800}}`)
}

func writeSuccess(w http.ResponseWriter, provider string, stream bool) {
	if provider == "claude" {
		if stream {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"m\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n"+
				"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"+
				"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok from pool\"}}\n\n"+
				"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n"+
				"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n"+
				"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"ok from pool"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":3}}`)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	_, _ = io.WriteString(w, `data: {"type":"response.created","response":{"id":"r1"}}`+"\n\n"+
		`data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok from pool"}]}}`+"\n\n"+
		`data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok from pool"}]}],"usage":{"input_tokens":1,"output_tokens":3,"total_tokens":4}}}`+"\n\n")
}
