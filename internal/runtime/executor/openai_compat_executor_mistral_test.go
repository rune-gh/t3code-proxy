package executor

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	cliproxyauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
	sdktranslator "github.com/rune-oai/t3code-proxy/sdk/translator"
)

// Mistral rejects echoed reasoning fields on assistant messages with 422
// extra_forbidden, which broke every second turn of an OpenCode conversation
// with GLM or DeepSeek on Mistral. The executor strips them for Mistral only.
func TestOpenAICompatExecutorStripsEchoedReasoningForMistral(t *testing.T) {
	openCodePayload := `{"model":"zai-glm-5-3-flash","messages":[` +
		`{"role":"user","content":"hi"},` +
		`{"role":"assistant","content":"hello","reasoning_content":"r1","reasoning":"r2","reasoning_details":[{"type":"text","text":"r3"}],"reasoning_text":"r4","reasoning_opaque":"r5"},` +
		`{"role":"user","content":"say ok"}]}`
	// Claude Code with thinking on: the hub itself injects a reasoning_content
	// placeholder on assistant tool calls, which Mistral rejects just the same.
	claudePayload := `{"model":"zai-glm-5-3-flash","thinking":{"type":"enabled","budget_tokens":1024},"messages":[` +
		`{"role":"user","content":"what time"},` +
		`{"role":"assistant","content":[{"type":"thinking","thinking":"prior","signature":""},{"type":"tool_use","id":"call_1","name":"get_time","input":{}}]},` +
		`{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"12:00"}]}]}`
	models := []config.PayloadModelRule{{Name: "zai-glm-5-3-flash", Protocol: "openai"}}

	for _, tt := range []struct {
		name          string
		mistral       bool
		source        sdktranslator.Format
		payload       string
		payloadCfg    config.PayloadConfig
		wantReasoning string // "" means reasoning_content must be absent
	}{
		{name: "opencode history on mistral", mistral: true, source: sdktranslator.FormatOpenAI, payload: openCodePayload},
		{name: "claude tool call on mistral", mistral: true, source: sdktranslator.FormatClaude, payload: claudePayload},
		{name: "other upstream keeps reasoning", mistral: false, source: sdktranslator.FormatOpenAI, payload: openCodePayload, wantReasoning: "r1"},
		{
			name:    "final payload override still wins",
			mistral: true,
			source:  sdktranslator.FormatOpenAI,
			payload: openCodePayload,
			payloadCfg: config.PayloadConfig{Override: []config.PayloadRule{
				{Models: models, Params: map[string]any{"messages.1.reasoning_content": "configured"}},
			}},
			wantReasoning: "configured",
		},
	} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%v", tt.name, stream), func(t *testing.T) {
				previous := isMistralBaseURL
				isMistralBaseURL = func(string) bool { return tt.mistral }
				t.Cleanup(func() { isMistralBaseURL = previous })

				bodies := make(chan []byte, 1)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					body, errRead := io.ReadAll(r.Body)
					if errRead != nil {
						t.Errorf("read upstream request: %v", errRead)
					}
					bodies <- body
					if stream {
						w.Header().Set("Content-Type", "text/event-stream")
						_, _ = io.WriteString(w, "data: {\"id\":\"x\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
						return
					}
					w.Header().Set("Content-Type", "application/json")
					_, _ = io.WriteString(w, `{"id":"x","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`)
				}))
				t.Cleanup(server.Close)

				executor := NewOpenAICompatExecutor("openai-compatibility", &config.Config{Payload: tt.payloadCfg})
				auth := &cliproxyauth.Auth{Provider: "openai-compatibility", Attributes: map[string]string{"base_url": server.URL, "api_key": "test-key"}}
				request := cliproxyexecutor.Request{
					Model:   "zai-glm-5-3-flash",
					Payload: []byte(tt.payload),
					Metadata: map[string]any{
						"cliproxy.resolved_api_key_model_info": &registry.ModelInfo{
							IsCompat: true,
							Thinking: &registry.ThinkingSupport{Levels: []string{"none", "low", "medium", "high"}, ZeroAllowed: true},
						},
					},
				}
				options := cliproxyexecutor.Options{SourceFormat: tt.source, ResponseFormat: tt.source, Stream: stream}

				if stream {
					result, errStream := executor.ExecuteStream(context.Background(), auth, request, options)
					if errStream != nil {
						t.Fatalf("ExecuteStream: %v", errStream)
					}
					for chunk := range result.Chunks {
						if chunk.Err != nil {
							t.Fatalf("stream chunk error: %v", chunk.Err)
						}
					}
				} else if _, errExecute := executor.Execute(context.Background(), auth, request, options); errExecute != nil {
					t.Fatalf("Execute: %v", errExecute)
				}

				body := <-bodies
				assistant := ojson.GetBytes(body, "messages.1")
				if !assistant.Exists() {
					t.Fatalf("assistant message missing: %s", body)
				}
				if got := assistant.Get("reasoning_content"); got.Exists() != (tt.wantReasoning != "") || got.String() != tt.wantReasoning {
					t.Fatalf("reasoning_content = %s, want %q: %s", got.Raw, tt.wantReasoning, body)
				}
				if tt.mistral {
					for _, key := range []string{"reasoning", "reasoning_details", "reasoning_text", "reasoning_opaque"} {
						if assistant.Get(key).Exists() {
							t.Fatalf("%s reached Mistral: %s", key, body)
						}
					}
				}
				if tt.source == sdktranslator.FormatClaude && !assistant.Get("tool_calls").Exists() {
					t.Fatalf("tool_calls lost: %s", body)
				}
			})
		}
	}
}
