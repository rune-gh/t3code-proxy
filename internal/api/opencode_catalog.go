package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/registry"
)

// OpenCode reads its model catalog from OPENCODE_MODELS_URL + "/api.json" in the
// models.dev format and refreshes it every few minutes. Pointing that variable
// at https://<hub>/opencode/<access key> makes OpenCode list every model the
// hub serves, live, under one provider whose requests go back to the hub, next
// to OpenCode's own provider (see opencode_upstream.go).
// OpenCode sends no credentials with that fetch, so the access key travels in
// the path; request logs mask it (see util.MaskSensitivePath).

const (
	openCodeProviderID = "t3code-proxy"
	// openCodeAPIKeyEnv is the variable OpenCode reads the hub access key from.
	openCodeAPIKeyEnv = "T3CODE_PROXY_API_KEY"

	openCodeNPMAnthropic        = "@ai-sdk/anthropic"
	openCodeNPMOpenAIResponses  = "@ai-sdk/openai"
	openCodeNPMOpenAICompatible = "@ai-sdk/openai-compatible"

	openCodeDefaultContext = 200000
	openCodeDefaultOutput  = 32000
)

func (s *Server) setupOpenCodeRoutes() {
	s.engine.GET("/opencode/:key/api.json", openCodePathKeyToHeader, AuthMiddleware(s.accessManager), s.openCodeCatalogHandler)
}

// openCodePathKeyToHeader hands the access key from the path to the normal
// access check, which reads it from the Authorization header.
func openCodePathKeyToHeader(c *gin.Context) {
	if key := strings.TrimSpace(c.Param("key")); key != "" {
		c.Request.Header.Set("Authorization", "Bearer "+key)
	}
	c.Next()
}

func (s *Server) openCodeCatalogHandler(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	hub := buildOpenCodeCatalog(requestBaseURL(c.Request)+"/v1", registry.GetGlobalRegistry().OpenCodeModels())
	catalog := make(map[string]any, len(hub)+1)
	for id, provider := range hub {
		catalog[id] = provider
	}
	if upstream := openCodeUpstream.Provider(openCodeUpstreamFirstWait); upstream != nil {
		catalog[openCodeUpstreamProviderID] = upstream
	}
	c.JSON(http.StatusOK, catalog)
}

// isOpenCodeRequest recognizes OpenCode, which may use credentials reserved for it
// (reserved-for: opencode). OpenCode 2.x sends a User-Agent such as
// "opencode/latest/2.3.0/cli" and x-opencode-* headers on its model requests.
func isOpenCodeRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.UserAgent())), "opencode/") {
		return true
	}
	return strings.TrimSpace(r.Header.Get("X-Opencode-Client")) != ""
}

// requestBaseURL is the scheme and host the client used, honoring the
// X-Forwarded-* headers a TLS front (Tailscale serve) adds.
func requestBaseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if proto := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); proto == "https" || proto == "http" {
		scheme = proto
	}
	host := r.Host
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); forwarded != "" {
		host = forwarded
	}
	return scheme + "://" + host
}

type openCodeProvider struct {
	ID     string                   `json:"id"`
	Name   string                   `json:"name"`
	Env    []string                 `json:"env"`
	NPM    string                   `json:"npm"`
	API    string                   `json:"api"`
	Models map[string]openCodeModel `json:"models"`
}

type openCodeModel struct {
	ID               string                   `json:"id"`
	Name             string                   `json:"name"`
	Family           string                   `json:"family,omitempty"`
	ReleaseDate      string                   `json:"release_date"`
	Attachment       bool                     `json:"attachment"`
	Reasoning        bool                     `json:"reasoning"`
	Temperature      bool                     `json:"temperature"`
	ToolCall         bool                     `json:"tool_call"`
	ReasoningOptions []openCodeReasoningOpt   `json:"reasoning_options,omitempty"`
	Limit            openCodeLimit            `json:"limit"`
	Modalities       openCodeModalities       `json:"modalities"`
	Provider         openCodeModelProviderAPI `json:"provider"`
}

type openCodeReasoningOpt struct {
	Type   string   `json:"type"`
	Values []string `json:"values,omitempty"`
}

type openCodeLimit struct {
	Context int `json:"context"`
	Output  int `json:"output"`
}

type openCodeModalities struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

type openCodeModelProviderAPI struct {
	NPM string `json:"npm"`
	API string `json:"api"`
}

// buildOpenCodeCatalog renders the hub's text models as one models.dev
// provider. Each model names the API shape that serves it best: Claude models
// the Anthropic Messages API, Codex models the Responses API, and the rest
// OpenAI chat completions.
func buildOpenCodeCatalog(apiBase string, models []registry.RegisteredModel) map[string]openCodeProvider {
	provider := openCodeProvider{
		ID:     openCodeProviderID,
		Name:   "t3code-proxy",
		Env:    []string{openCodeAPIKeyEnv},
		NPM:    openCodeNPMOpenAICompatible,
		API:    apiBase,
		Models: make(map[string]openCodeModel, len(models)),
	}
	names := make(map[string]int, len(models))
	for _, model := range models {
		info := model.Info
		if info == nil || strings.TrimSpace(info.ID) == "" || !info.SupportsTextChat() {
			continue
		}
		entry := openCodeModelFor(info, model.Providers, apiBase)
		provider.Models[info.ID] = entry
		names[entry.Name]++
	}
	for id, entry := range provider.Models {
		entry.Name = registry.CatalogDisplayName(entry.Name, id, names[entry.Name])
		provider.Models[id] = entry
	}
	return map[string]openCodeProvider{openCodeProviderID: provider}
}

func openCodeModelFor(info *registry.ModelInfo, providers []string, apiBase string) openCodeModel {
	name := strings.TrimSpace(info.DisplayName)
	if name == "" {
		name = info.ID
	}
	input := openCodeInputModalities(info.SupportedInputModalities)
	reasoning := info.Thinking != nil || info.UserDefined
	model := openCodeModel{
		ID:          info.ID,
		Name:        name,
		Family:      registry.ModelFamily(info.ID),
		ReleaseDate: openCodeReleaseDate(info.Created),
		Attachment:  len(input) > 1,
		Reasoning:   reasoning,
		Temperature: true,
		ToolCall:    true,
		Limit:       openCodeLimit{Context: firstPositive(info.ContextLength, info.MaxContextLength, info.InputTokenLimit, openCodeDefaultContext), Output: firstPositive(info.MaxCompletionTokens, info.OutputTokenLimit, openCodeDefaultOutput)},
		Modalities:  openCodeModalities{Input: input, Output: []string{"text"}},
		Provider:    openCodeModelProviderAPI{NPM: openCodeNPMFor(info.ID, providers), API: apiBase},
	}
	if info.Thinking != nil && len(info.Thinking.Levels) > 0 {
		model.ReasoningOptions = []openCodeReasoningOpt{{Type: "effort", Values: append([]string(nil), info.Thinking.Levels...)}}
	}
	return model
}

func openCodeNPMFor(modelID string, providers []string) string {
	has := func(name string) bool {
		for _, provider := range providers {
			if strings.EqualFold(provider, name) {
				return true
			}
		}
		return false
	}
	switch {
	case has("claude") || registry.ModelFamily(modelID) == "claude":
		return openCodeNPMAnthropic
	case has("codex"):
		return openCodeNPMOpenAIResponses
	default:
		return openCodeNPMOpenAICompatible
	}
}

func openCodeInputModalities(raw []string) []string {
	out := []string{"text"}
	for _, modality := range raw {
		switch m := strings.ToLower(strings.TrimSpace(modality)); m {
		case "image", "audio", "video", "pdf":
			found := false
			for _, existing := range out {
				found = found || existing == m
			}
			if !found {
				out = append(out, m)
			}
		}
	}
	return out
}

func openCodeReleaseDate(created int64) string {
	if created <= 0 {
		return ""
	}
	return time.Unix(created, 0).UTC().Format("2006-01-02")
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}
