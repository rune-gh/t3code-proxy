package executor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rune-oai/t3code-proxy/internal/config"
	cliproxyauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
	sdktranslator "github.com/rune-oai/t3code-proxy/sdk/translator"
)

// Mistral streams reasoning as content-part arrays; OpenAI clients must get
// string content and reasoning_content instead.
func TestOpenAICompatExecutorStreamNormalizesMistralContentParts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, chunk := range []string{
			`{"id":"x","object":"chat.completion.chunk","model":"zai-glm-5-3","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
			`{"id":"x","object":"chat.completion.chunk","model":"zai-glm-5-3","choices":[{"index":0,"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":"Thinking it over"}],"closed":true}]},"finish_reason":null}]}`,
			`{"id":"x","object":"chat.completion.chunk","model":"zai-glm-5-3","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`,
		} {
			_, _ = w.Write([]byte("data: " + chunk + "\n\n"))
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	executor := NewOpenAICompatExecutor("openai-compatibility", &config.Config{})
	auth := &cliproxyauth.Auth{Provider: "openai-compatibility", Attributes: map[string]string{"base_url": server.URL, "api_key": "test-key"}}
	request := cliproxyexecutor.Request{Model: "zai-glm-5-3", Payload: []byte(`{"model":"zai-glm-5-3","stream":true,"messages":[{"role":"user","content":"hi"}]}`)}
	options := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAI, ResponseFormat: sdktranslator.FormatOpenAI, Stream: true}

	result, err := executor.ExecuteStream(context.Background(), auth, request, options)
	if err != nil {
		t.Fatalf("ExecuteStream: %v", err)
	}
	var out strings.Builder
	for chunk := range result.Chunks {
		if chunk.Err != nil {
			t.Fatalf("stream error: %v", chunk.Err)
		}
		out.Write(chunk.Payload)
		out.WriteByte('\n')
	}
	got := out.String()
	if strings.Contains(got, `"type":"thinking"`) || !strings.Contains(got, `"reasoning_content":"Thinking it over"`) {
		t.Fatalf("stream was not normalized:\n%s", got)
	}
	if !strings.Contains(got, `"content":"ok"`) {
		t.Fatalf("text content missing:\n%s", got)
	}
}
