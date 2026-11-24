package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizeAntigravityModelID(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"gemini-3-flash", "gemini-3-flash"},
		{"  GEMINI-3-FLASH  ", "gemini-3-flash"},
		{"", ""},
		{"   ", ""},
		{strings.Repeat("a", 256), strings.Repeat("a", 256)},
		{strings.Repeat("a", 257), ""},
	}
	for _, c := range cases {
		got := NormalizeAntigravityModelID(c.input)
		if got != c.expected {
			t.Errorf("NormalizeAntigravityModelID(%q) = %q, want %q", c.input, got, c.expected)
		}
	}
}

func TestParseAntigravityModelCapabilityHints(t *testing.T) {
	t.Run("valid payload with models and web search", func(t *testing.T) {
		body := []byte(`{"models":{"gemini-3-flash":{"displayName":"Gemini 3 Flash"},"claude-sonnet-5-5-medium":{"displayName":"Claude Sonnet 5.5"}},"webSearchModelIds":["gemini-3-flash"]}`)
		hints, ok := ParseAntigravityModelCapabilityHints(body)
		if !ok {
			t.Fatal("expected ok to be true")
		}
		if hints.ModelIDs == nil {
			t.Fatal("expected non-nil ModelIDs")
		}
		if len(hints.ModelIDs) != 2 {
			t.Errorf("got %d models, want 2", len(hints.ModelIDs))
		}
		if _, exists := hints.ModelIDs["gemini-3-flash"]; !exists {
			t.Errorf("missing gemini-3-flash in ModelIDs")
		}
		if len(hints.WebSearchModelIDs) != 1 {
			t.Errorf("got %d webSearchModelIds, want 1", len(hints.WebSearchModelIDs))
		}
		if _, exists := hints.WebSearchModelIDs["gemini-3-flash"]; !exists {
			t.Errorf("missing gemini-3-flash in WebSearchModelIDs")
		}
	})

	t.Run("empty catalog is authoritative empty", func(t *testing.T) {
		body := []byte(`{"models":{}}`)
		hints, ok := ParseAntigravityModelCapabilityHints(body)
		if !ok {
			t.Fatal("expected ok to be true")
		}
		if hints.ModelIDs == nil {
			t.Fatal("expected non-nil empty ModelIDs")
		}
		if len(hints.ModelIDs) != 0 {
			t.Errorf("expected 0 models, got %d", len(hints.ModelIDs))
		}
	})

	t.Run("missing models field leaves ModelIDs nil", func(t *testing.T) {
		body := []byte(`{"webSearchModelIds":["gemini-3.5-flash-lite"]}`)
		hints, ok := ParseAntigravityModelCapabilityHints(body)
		if !ok {
			t.Fatal("expected ok to be true")
		}
		if hints.ModelIDs != nil {
			t.Fatal("expected nil ModelIDs for unknown catalog")
		}
		if len(hints.WebSearchModelIDs) != 1 {
			t.Errorf("got %d webSearchModelIds, want 1", len(hints.WebSearchModelIDs))
		}
	})

	t.Run("parses groupedModels thinking variants and web search flags", func(t *testing.T) {
		body := []byte(`{
			"models": {
				"claude-opus-5-5-low": {"maxOutputTokens": 128000},
				"claude-opus-5-5-medium": {"maxOutputTokens": 128000},
				"claude-opus-5-5-high": {"maxOutputTokens": 128000},
				"gemini-4-carbon-low": {"maxOutputTokens": 262144},
				"gemini-4-carbon-medium": {"maxOutputTokens": 262144},
				"gemini-4-carbon-high": {"maxOutputTokens": 262144},
				"gemini-4-carbon-disabled": {}
			},
			"groupedModels": {
				"claude-opus-5-5": {
					"supportedThinkingLevels": [
						{"thinkingSuffix": "low"},
						{"thinkingSuffix": "medium"},
						{"thinkingSuffix": "high"}
					]
				},
				"gemini-4-carbon": {
					"supportedThinkingLevels": [
						{"thinkingSuffix": "low"},
						{"thinkingSuffix": "medium"},
						{"thinkingSuffix": "high"},
						{"thinkingSuffix": "disabled"}
					]
				}
			},
			"webSearchModelIds": ["gemini-4-carbon-low", "gemini-4-carbon-high"]
		}`)
		hints, ok := ParseAntigravityModelCapabilityHints(body)
		if !ok {
			t.Fatal("expected ok to be true")
		}
		if got := hints.ThinkingGroups["claude-opus-5-5"]["low"]; got != 128000 {
			t.Fatalf("claude-opus-5-5 low = %d, want 128000", got)
		}
		if got := hints.ThinkingGroups["claude-opus-5-5"]["medium"]; got != 128000 {
			t.Fatalf("claude-opus-5-5 medium = %d, want 128000", got)
		}
		if got := hints.ThinkingGroups["gemini-4-carbon"]["low"]; got != 262144 {
			t.Fatalf("gemini-4-carbon low = %d, want 262144", got)
		}
		if got, exists := hints.ThinkingGroups["gemini-4-carbon"]["disabled"]; !exists || got != 0 {
			t.Fatalf("gemini-4-carbon disabled = (%d, %v), want (0, true)", got, exists)
		}
		if !hints.ThinkingWebSearch["gemini-4-carbon-low"] || !hints.ThinkingWebSearch["gemini-4-carbon-high"] {
			t.Fatalf("expected gemini-4-carbon web search flags, got %v", hints.ThinkingWebSearch)
		}
		if hints.ThinkingWebSearch["claude-opus-5-5-low"] {
			t.Fatalf("did not expect claude-opus-5-5-low in ThinkingWebSearch: %v", hints.ThinkingWebSearch)
		}
	})

	t.Run("invalid json returns false", func(t *testing.T) {
		_, ok := ParseAntigravityModelCapabilityHints([]byte(`{not valid json`))
		if ok {
			t.Fatal("expected false for invalid JSON")
		}
	})

	t.Run("clones model IDs out of caller buffer", func(t *testing.T) {
		buf := []byte(`{"models":{"gemini-3-flash":{}},"webSearchModelIds":["gemini-3-flash"]}`)
		hints, ok := ParseAntigravityModelCapabilityHints(buf)
		if !ok {
			t.Fatal("expected ok to be true")
		}
		for i := range buf {
			buf[i] = 'x'
		}
		if _, exists := hints.ModelIDs["gemini-3-flash"]; !exists {
			t.Fatal("expected gemini-3-flash in ModelIDs after buffer mutation")
		}
		if _, exists := hints.WebSearchModelIDs["gemini-3-flash"]; !exists {
			t.Fatal("expected gemini-3-flash in WebSearchModelIDs after buffer mutation")
		}
	})
}

func TestPersistedAntigravityCapabilityHintsRoundTrip(t *testing.T) {
	hints := AntigravityModelCapabilityHints{
		ModelIDs: map[string]struct{}{
			"gemini-3-flash":         {},
			"gemini-4-argon":         {},
			"claude-opus-5-5-low":    {},
			"claude-opus-5-5-high":   {},
			"gemini-4-carbon-low":    {},
			"gemini-4-carbon-high":   {},
			"gemini-4-carbon-medium": {},
		},
		WebSearchModelIDs: map[string]struct{}{
			"gemini-3-flash":       {},
			"gemini-4-carbon-high": {},
		},
		ThinkingGroups: map[string]map[string]int{
			"claude-opus-5-5": {"low": 128000, "high": 128000},
			"gemini-4-carbon": {"low": 262144, "medium": 262144, "high": 262144},
		},
		ThinkingWebSearch: map[string]bool{
			"gemini-4-carbon-high": true,
		},
	}
	project := "aicode-consumers"
	endpointWithUser := "https://user:password@cloudcode-pa.googleapis.com"
	expectedEndpoint := "https://cloudcode-pa.googleapis.com"

	serialized := BuildPersistedAntigravityCapabilityHints(project, endpointWithUser, hints)
	if ep, ok := serialized["endpoint"].(string); !ok || ep != expectedEndpoint {
		t.Errorf("expected endpoint %q, got %q", expectedEndpoint, ep)
	}

	metadata := map[string]any{
		AntigravityPersistedHintsMetaKey: serialized,
	}

	parsed, ok := ParsePersistedAntigravityCapabilityHints(metadata, project, expectedEndpoint)
	if !ok {
		t.Fatal("expected parse to succeed")
	}
	if len(parsed.ModelIDs) != 7 {
		t.Errorf("got %d models, want 7", len(parsed.ModelIDs))
	}
	if len(parsed.WebSearchModelIDs) != 2 {
		t.Errorf("got %d web search models, want 2", len(parsed.WebSearchModelIDs))
	}
	if got := parsed.ThinkingGroups["claude-opus-5-5"]["low"]; got != 128000 {
		t.Errorf("persisted claude-opus-5-5 low = %d, want 128000", got)
	}
	if got := parsed.ThinkingGroups["gemini-4-carbon"]["medium"]; got != 262144 {
		t.Errorf("persisted gemini-4-carbon medium = %d, want 262144", got)
	}
	if !parsed.ThinkingWebSearch["gemini-4-carbon-high"] {
		t.Errorf("expected persisted ThinkingWebSearch[gemini-4-carbon-high]=true, got %v", parsed.ThinkingWebSearch)
	}

	// Mismatched project
	if _, okMismatch := ParsePersistedAntigravityCapabilityHints(metadata, "other-project", expectedEndpoint); okMismatch {
		t.Error("expected mismatch for different project")
	}

	// Mismatched endpoint
	if _, okMismatch := ParsePersistedAntigravityCapabilityHints(metadata, project, "https://other.com"); okMismatch {
		t.Error("expected mismatch for different endpoint")
	}

	// Nil ModelIDs (unknown catalog) must not serialize as authoritative empty catalog
	if gotNil := BuildPersistedAntigravityCapabilityHints(project, expectedEndpoint, AntigravityModelCapabilityHints{}); gotNil != nil {
		t.Errorf("expected nil persisted hints for unknown catalog, got %v", gotNil)
	}
}

func TestFetchAntigravityAvailableModels(t *testing.T) {
	t.Run("successful probe", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				t.Errorf("expected POST, got %s", r.Method)
			}
			if r.Header.Get("Authorization") != "Bearer test-token" {
				t.Errorf("unexpected authorization header: %s", r.Header.Get("Authorization"))
			}
			if r.Header.Get("Content-Type") != "application/json" {
				t.Errorf("unexpected content-type: %s", r.Header.Get("Content-Type"))
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"models":{"gemini-3-flash":{}},"webSearchModelIds":["gemini-3-flash"]}`))
		}))
		defer server.Close()

		hints, status := FetchAntigravityAvailableModels(context.Background(), AntigravityModelProbeRequest{
			BaseURLs:    []string{server.URL},
			AccessToken: "test-token",
			ProjectID:   "aicode-consumers",
		})
		if status != AntigravityProbeStatusSuccess {
			t.Fatalf("expected success, got %v", status)
		}
		if len(hints.ModelIDs) != 1 {
			t.Errorf("got %d models, want 1", len(hints.ModelIDs))
		}
	})

	t.Run("auth error 401", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		}))
		defer server.Close()

		_, status := FetchAntigravityAvailableModels(context.Background(), AntigravityModelProbeRequest{
			BaseURLs:    []string{server.URL},
			AccessToken: "bad-token",
		})
		if status != AntigravityProbeStatusAuthError {
			t.Fatalf("expected auth error, got %v", status)
		}
	})

	t.Run("empty base urls returns transient error", func(t *testing.T) {
		_, status := FetchAntigravityAvailableModels(context.Background(), AntigravityModelProbeRequest{
			BaseURLs:    nil,
			AccessToken: "token",
		})
		if status != AntigravityProbeStatusTransientError {
			t.Fatalf("expected transient error, got %v", status)
		}
	})

	t.Run("empty access token returns auth error", func(t *testing.T) {
		_, status := FetchAntigravityAvailableModels(context.Background(), AntigravityModelProbeRequest{
			BaseURLs:    []string{"https://example.com"},
			AccessToken: "",
		})
		if status != AntigravityProbeStatusAuthError {
			t.Fatalf("expected auth error, got %v", status)
		}
	})

	t.Run("redirect is not followed", func(t *testing.T) {
		redirectTargetVisited := false
		targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			redirectTargetVisited = true
			w.WriteHeader(http.StatusOK)
		}))
		defer targetServer.Close()

		sourceServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, targetServer.URL, http.StatusFound)
		}))
		defer sourceServer.Close()

		_, status := FetchAntigravityAvailableModels(context.Background(), AntigravityModelProbeRequest{
			BaseURLs:    []string{sourceServer.URL},
			AccessToken: "token",
		})
		if redirectTargetVisited {
			t.Fatal("redirect target should not have been visited")
		}
		if status != AntigravityProbeStatusTransientError {
			t.Fatalf("expected transient error for 302 without redirect, got %v", status)
		}
	})
}
