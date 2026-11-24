package executor

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/config"
	cliproxyauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
	sdktranslator "github.com/rune-oai/t3code-proxy/sdk/translator"
)

func newAntigravityThinkingGroupsTestAuth(t *testing.T, id, baseURL string, excluded string) *cliproxyauth.Auth {
	t.Helper()
	attrs := map[string]string{
		"base_url": baseURL,
	}
	if excluded != "" {
		attrs["excluded_models"] = excluded
	}
	auth := &cliproxyauth.Auth{
		ID:                id,
		Provider:          "antigravity",
		RegistrationEpoch: 1,
		Attributes:        attrs,
		Metadata: map[string]any{
			"access_token": "test-access-token",
			"project_id":   "test-project",
			"expired":      time.Now().Add(time.Hour).Format(time.RFC3339),
		},
	}
	groups := map[string]map[string]int{
		"claude-opus-5-5": {
			"low":    128000,
			"medium": 128000,
			"high":   128000,
		},
		"claude-sonnet-5-5": {
			"low":    128000,
			"medium": 128000,
			"high":   128000,
		},
		"gemini-4-carbon": {
			"low":    262144,
			"medium": 262144,
			"high":   262144,
		},
		"gemini-4-argon": {
			"low":  0,
			"high": 65536,
		},
	}
	webSearch := map[string]bool{
		"gemini-4-carbon-low":    true,
		"gemini-4-carbon-medium": true,
		"gemini-4-carbon-high":   true,
	}
	cliproxyauth.StoreAntigravityThinkingGroups(auth, groups, webSearch)
	t.Cleanup(func() {
		cliproxyauth.ClearAntigravityThinkingGroups(auth.ID)
	})
	return auth
}

func TestAntigravityThinkingGroups_RoutesClaude55AndCarbonVariants(t *testing.T) {
	var capturedBodies [][]byte
	var capturedPaths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		capturedBodies = append(capturedBodies, body)
		capturedPaths = append(capturedPaths, r.URL.Path)
		switch r.URL.Path {
		case antigravityCountTokensPath:
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"totalTokens":42}`)
		case antigravityGeneratePath:
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}`)
		default:
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}]}}\n\n")
		}
	}))
	defer server.Close()

	auth := newAntigravityThinkingGroupsTestAuth(t, "ag-thinking-groups-routing", server.URL, "")
	exec := NewAntigravityExecutor(&config.Config{})

	cases := []struct {
		name      string
		model     string
		format    sdktranslator.Format
		payload   string
		mode      string // "execute", "stream", "count"
		wantModel string
		wantLevel string
		wantMax   int64
	}{
		{
			name:      "opus 5.5 suffix low on stream routes to claude-opus-5-5-low",
			model:     "claude-opus-5-5-high(low)",
			format:    sdktranslator.FormatGemini,
			payload:   `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"includeThoughts":true,"thinkingBudget":0}}}`,
			mode:      "stream",
			wantModel: "claude-opus-5-5-low",
			wantLevel: "LOW",
			wantMax:   128000,
		},
		{
			name:      "opus 5.5 suffix medium on non-stream routes to claude-opus-5-5-medium",
			model:     "claude-opus-5-5-high(medium)",
			format:    sdktranslator.FormatGemini,
			payload:   `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}`,
			mode:      "execute",
			wantModel: "claude-opus-5-5-medium",
			wantLevel: "MEDIUM",
			wantMax:   128000,
		},
		{
			name:      "opus 5.5 claude effort low routes to claude-opus-5-5-low",
			model:     "claude-opus-5-5-high",
			format:    sdktranslator.FormatClaude,
			payload:   `{"model":"claude-opus-5-5-high","max_tokens":4096,"thinking":{"type":"adaptive"},"output_config":{"effort":"low"},"messages":[{"role":"user","content":"hi"}]}`,
			mode:      "stream",
			wantModel: "claude-opus-5-5-low",
			wantLevel: "LOW",
			wantMax:   128000,
		},
		{
			name:      "sonnet 5.5 openai reasoning_effort medium routes to claude-sonnet-5-5-medium",
			model:     "claude-sonnet-5-5-high",
			format:    sdktranslator.FormatOpenAI,
			payload:   `{"model":"claude-sonnet-5-5-high","reasoning_effort":"medium","messages":[{"role":"user","content":"hi"}]}`,
			mode:      "stream",
			wantModel: "claude-sonnet-5-5-medium",
			wantLevel: "MEDIUM",
			wantMax:   128000,
		},
		{
			name:      "carbon suffix low routes to gemini-4-carbon-low with 262144 maxOutputTokens",
			model:     "gemini-4-carbon-high(low)",
			format:    sdktranslator.FormatGemini,
			payload:   `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}`,
			mode:      "execute",
			wantModel: "gemini-4-carbon-low",
			wantLevel: "LOW",
			wantMax:   262144,
		},
		{
			name:      "carbon responses effort medium routes to gemini-4-carbon-medium",
			model:     "gemini-4-carbon-high",
			format:    sdktranslator.FormatOpenAIResponse,
			payload:   `{"model":"gemini-4-carbon-high","reasoning":{"effort":"medium"},"input":"hi"}`,
			mode:      "stream",
			wantModel: "gemini-4-carbon-medium",
			wantLevel: "MEDIUM",
			wantMax:   262144,
		},
		{
			name:      "zero-limit variant member is never selected as routing target",
			model:     "gemini-4-argon-high(low)",
			format:    sdktranslator.FormatGemini,
			payload:   `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`,
			mode:      "execute",
			wantModel: "gemini-4-argon-high",
			wantLevel: "LOW",
			wantMax:   0,
		},
		{
			name:      "count tokens targets selected opus 5.5 variant",
			model:     "claude-opus-5-5-high(low)",
			format:    sdktranslator.FormatGemini,
			payload:   `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`,
			mode:      "count",
			wantModel: "models/claude-opus-5-5-low",
			wantLevel: "LOW",
			wantMax:   128000,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := len(capturedBodies)
			req := cliproxyexecutor.Request{
				Model:   tc.model,
				Payload: []byte(tc.payload),
			}
			opts := cliproxyexecutor.Options{
				SourceFormat:    tc.format,
				ResponseFormat:  tc.format,
				OriginalRequest: []byte(tc.payload),
				Stream:          tc.mode == "stream",
			}
			switch tc.mode {
			case "execute":
				if _, err := exec.Execute(context.Background(), auth, req, opts); err != nil {
					t.Fatalf("Execute() error = %v", err)
				}
			case "stream":
				res, err := exec.ExecuteStream(context.Background(), auth, req, opts)
				if err != nil {
					t.Fatalf("ExecuteStream() error = %v", err)
				}
				for chunk := range res.Chunks {
					if chunk.Err != nil {
						t.Fatalf("stream chunk error = %v", chunk.Err)
					}
				}
			case "count":
				if _, err := exec.CountTokens(context.Background(), auth, req, opts); err != nil {
					t.Fatalf("CountTokens() error = %v", err)
				}
			}
			if len(capturedBodies) != before+1 {
				t.Fatalf("expected 1 upstream call, got %d", len(capturedBodies)-before)
			}
			sent := capturedBodies[len(capturedBodies)-1]
			modelPath := "model"
			if tc.mode == "count" {
				modelPath = "request.model"
			}
			if got := ojson.GetBytes(sent, modelPath).String(); got != tc.wantModel {
				t.Fatalf("%s = %q, want %q; body=%s", modelPath, got, tc.wantModel, sent)
			}
			if tc.wantLevel != "" {
				if got := ojson.GetBytes(sent, "request.generationConfig.thinkingConfig.thinkingLevel").String(); got != tc.wantLevel {
					t.Fatalf("thinkingLevel = %q, want %q; body=%s", got, tc.wantLevel, sent)
				}
			}
			if tc.wantMax > 0 {
				if got := ojson.GetBytes(sent, "request.generationConfig.maxOutputTokens").Int(); got != tc.wantMax {
					t.Fatalf("maxOutputTokens = %d, want %d; body=%s", got, tc.wantMax, sent)
				}
			}
		})
	}
}

func TestAntigravityThinkingGroups_ExcludedTargetFallsBackAndPayloadRuleMatchesSource(t *testing.T) {
	var captured []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}]}}\n\n")
	}))
	defer server.Close()

	t.Run("excluded target variant stays on base model", func(t *testing.T) {
		auth := newAntigravityThinkingGroupsTestAuth(t, "ag-thinking-groups-excluded", server.URL, "claude-opus-5-5-low")
		exec := NewAntigravityExecutor(&config.Config{})
		payload := []byte(`{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`)
		res, err := exec.ExecuteStream(context.Background(), auth, cliproxyexecutor.Request{
			Model:   "claude-opus-5-5-high(low)",
			Payload: payload,
		}, cliproxyexecutor.Options{
			SourceFormat:    sdktranslator.FormatGemini,
			ResponseFormat:  sdktranslator.FormatGemini,
			OriginalRequest: payload,
			Stream:          true,
		})
		if err != nil {
			t.Fatalf("ExecuteStream() error = %v", err)
		}
		for chunk := range res.Chunks {
			if chunk.Err != nil {
				t.Fatalf("chunk error = %v", chunk.Err)
			}
		}
		if got := ojson.GetBytes(captured, "model").String(); got != "claude-opus-5-5-high" {
			t.Fatalf("model = %q, want claude-opus-5-5-high when target excluded; body=%s", got, captured)
		}
		if got := ojson.GetBytes(captured, "request.generationConfig.thinkingConfig.thinkingLevel").String(); got != "LOW" {
			t.Fatalf("thinkingLevel = %q, want LOW; body=%s", got, captured)
		}
	})

	t.Run("payload rule targeting base model still applies to routed variant", func(t *testing.T) {
		auth := newAntigravityThinkingGroupsTestAuth(t, "ag-thinking-groups-payload-rule", server.URL, "")
		cfg := &config.Config{
			Payload: config.PayloadConfig{
				Override: []config.PayloadRule{{
					Models: []config.PayloadModelRule{{Name: "claude-opus-5-5-high", Protocol: "antigravity"}},
					Params: map[string]any{"generationConfig.maxOutputTokens": 4321},
				}},
			},
		}
		exec := NewAntigravityExecutor(cfg)
		payload := []byte(`{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`)
		res, err := exec.ExecuteStream(context.Background(), auth, cliproxyexecutor.Request{
			Model:   "claude-opus-5-5-high(low)",
			Payload: payload,
		}, cliproxyexecutor.Options{
			SourceFormat:    sdktranslator.FormatGemini,
			ResponseFormat:  sdktranslator.FormatGemini,
			OriginalRequest: payload,
			Stream:          true,
		})
		if err != nil {
			t.Fatalf("ExecuteStream() error = %v", err)
		}
		for chunk := range res.Chunks {
			if chunk.Err != nil {
				t.Fatalf("chunk error = %v", chunk.Err)
			}
		}
		if got := ojson.GetBytes(captured, "model").String(); got != "claude-opus-5-5-low" {
			t.Fatalf("model = %q, want claude-opus-5-5-low", got)
		}
		if got := ojson.GetBytes(captured, "request.generationConfig.maxOutputTokens").Int(); got != 4321 {
			t.Fatalf("maxOutputTokens = %d, want 4321 from base-model payload override; body=%s", got, captured)
		}
	})
}

func TestAntigravityThinkingGroups_TargetVariantCooldownIsolation(t *testing.T) {
	var upstreamModels []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		model := ojson.GetBytes(body, "model").String()
		upstreamModels = append(upstreamModels, model)
		if model == "claude-opus-5-5-low" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"RATE_LIMIT_EXCEEDED"},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}]}}\n\n")
	}))
	defer server.Close()

	auth := newAntigravityThinkingGroupsTestAuth(t, "ag-thinking-groups-cooldown", server.URL, "")
	exec := NewAntigravityExecutor(&config.Config{})
	payload := []byte(`{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`)
	opts := cliproxyexecutor.Options{
		SourceFormat:    sdktranslator.FormatGemini,
		ResponseFormat:  sdktranslator.FormatGemini,
		OriginalRequest: payload,
		Stream:          true,
	}

	// First request to low triggers a short cooldown on claude-opus-5-5-low.
	if _, err := exec.ExecuteStream(context.Background(), auth, cliproxyexecutor.Request{
		Model:   "claude-opus-5-5-high(low)",
		Payload: payload,
	}, opts); err == nil {
		t.Fatal("expected 429 error from claude-opus-5-5-low")
	}

	// A second request to low should be rejected by short cooldown before hitting upstream.
	if _, err := exec.ExecuteStream(context.Background(), auth, cliproxyexecutor.Request{
		Model:   "claude-opus-5-5-high(low)",
		Payload: payload,
	}, opts); err == nil || !strings.Contains(err.Error(), "short cooldown") {
		t.Fatalf("expected short cooldown rejection for low variant, got %v", err)
	}

	// Requesting high must NOT be blocked by claude-opus-5-5-low's short cooldown.
	res, err := exec.ExecuteStream(context.Background(), auth, cliproxyexecutor.Request{
		Model:   "claude-opus-5-5-high(high)",
		Payload: payload,
	}, opts)
	if err != nil {
		t.Fatalf("high variant should not be blocked by low variant cooldown: %v", err)
	}
	for chunk := range res.Chunks {
		if chunk.Err != nil {
			t.Fatalf("chunk error = %v", chunk.Err)
		}
	}

	if len(upstreamModels) != 2 || upstreamModels[0] != "claude-opus-5-5-low" || upstreamModels[1] != "claude-opus-5-5-high" {
		t.Fatalf("upstreamModels = %v, want [claude-opus-5-5-low claude-opus-5-5-high]", upstreamModels)
	}
}
