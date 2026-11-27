// Package models builds model catalogs for Anthropic clients.
package models

import (
	"sort"
	"strings"

	"github.com/rune-oai/t3code-proxy/internal/registry"
)

const claudeDDModelPrefix = "claude-fable-5-dd-"

// BuildResponse builds an Anthropic model response from available models.
// Without cloaking the list holds Claude models only: Claude Code's gateway model
// discovery feeds T3 Code's Claude picker, which keeps every model it has ever been
// shown, so other providers' models must never reach it.
func BuildResponse(availableModels []map[string]any, disableCloaking bool) map[string]any {
	if disableCloaking {
		availableModels = claudeModelsOnly(availableModels)
	}
	names := make(map[string]int, len(availableModels))
	for _, model := range availableModels {
		if name, ok := model["display_name"].(string); ok && name != "" {
			names[name]++
		}
	}
	models := make([]map[string]any, len(availableModels))
	for i, model := range availableModels {
		models[i] = cloneModel(model)
		if id, ok := model["id"].(string); ok {
			if name, ok := model["display_name"].(string); ok {
				models[i]["display_name"] = registry.CatalogDisplayName(name, id, names[name])
			}
			if !disableCloaking {
				models[i]["id"] = EnsureClaudeModelIDPrefix(id)
			}
		}
	}

	sort.SliceStable(models, func(i, j int) bool {
		displayNameI, _ := models[i]["display_name"].(string)
		displayNameJ, _ := models[j]["display_name"].(string)
		if displayNameI != displayNameJ {
			return displayNameI < displayNameJ
		}
		idI, _ := models[i]["id"].(string)
		idJ, _ := models[j]["id"].(string)
		return idI < idJ
	})

	firstID := ""
	lastID := ""
	if len(models) > 0 {
		firstID, _ = models[0]["id"].(string)
		lastID, _ = models[len(models)-1]["id"].(string)
	}

	return map[string]any{
		"data":     models,
		"has_more": false,
		"first_id": firstID,
		"last_id":  lastID,
	}
}

// EnsureClaudeModelIDPrefix rewrites model IDs for Anthropic model listings.
// IDs that already start with "claude-" are returned unchanged; all other IDs
// become "claude-fable-5-dd-" plus the original ID with its characters reversed.
func EnsureClaudeModelIDPrefix(id string) string {
	if id == "" || strings.HasPrefix(id, "claude-") {
		return id
	}
	return claudeDDModelPrefix + reverseModelID(id)
}

// ResolveClaudeModelIDPrefix reverses EnsureClaudeModelIDPrefix for request routing.
// Optional thinking suffixes in model(value) form are preserved.
func ResolveClaudeModelIDPrefix(id string) string {
	if id == "" {
		return id
	}
	base, suffix, hasSuffix := splitModelThinkingSuffix(id)
	if !strings.HasPrefix(base, claudeDDModelPrefix) {
		return id
	}
	encoded := base[len(claudeDDModelPrefix):]
	if encoded == "" {
		return id
	}
	resolved := reverseModelID(encoded)
	if hasSuffix {
		return resolved + "(" + suffix + ")"
	}
	return resolved
}

// claudeModelsOnly keeps the models Claude Code can pick by their real ID.
func claudeModelsOnly(models []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(models))
	for _, model := range models {
		if id, _ := model["id"].(string); strings.HasPrefix(id, "claude-") {
			out = append(out, model)
		}
	}
	return out
}

func cloneModel(model map[string]any) map[string]any {
	cloned := make(map[string]any, len(model))
	for key, value := range model {
		cloned[key] = value
	}
	return cloned
}

func splitModelThinkingSuffix(model string) (base, suffix string, hasSuffix bool) {
	lastOpen := strings.LastIndex(model, "(")
	if lastOpen == -1 || !strings.HasSuffix(model, ")") {
		return model, "", false
	}
	return model[:lastOpen], model[lastOpen+1 : len(model)-1], true
}

func reverseModelID(id string) string {
	runes := []rune(id)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}
