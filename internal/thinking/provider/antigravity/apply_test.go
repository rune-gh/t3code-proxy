package antigravity

import (
	"testing"

	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/thinking"
)

func TestApplier_UppercaseThinkingLevelAndSnakeCaseCleanup(t *testing.T) {
	applier := NewApplier()
	modelInfo := &registry.ModelInfo{
		ID: "claude-opus-5-5-low",
		Thinking: &registry.ThinkingSupport{
			Levels: []string{"low", "medium", "high"},
		},
	}

	body := []byte(`{
		"request": {
			"generationConfig": {
				"thinking_config": {
					"thinking_level": "high",
					"include_thoughts": true
				},
				"thinkingConfig": {
					"thinkingBudget": 16000
				}
			}
		}
	}`)

	out, err := applier.Apply(body, thinking.ThinkingConfig{
		Mode:  thinking.ModeLevel,
		Level: thinking.LevelLow,
	}, modelInfo)
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if got := ojson.GetBytes(out, "request.generationConfig.thinkingConfig.thinkingLevel").String(); got != "LOW" {
		t.Fatalf("thinkingLevel = %q, want LOW; body=%s", got, out)
	}
	if !ojson.GetBytes(out, "request.generationConfig.thinkingConfig.includeThoughts").Bool() {
		t.Fatalf("expected includeThoughts=true preserved from snake_case thinking_config; body=%s", out)
	}
	if ojson.GetBytes(out, "request.generationConfig.thinking_config").Exists() {
		t.Fatalf("expected legacy thinking_config to be deleted; body=%s", out)
	}
	if ojson.GetBytes(out, "request.generationConfig.thinkingConfig.thinkingBudget").Exists() {
		t.Fatalf("expected thinkingBudget to be deleted in level mode; body=%s", out)
	}
}

func TestApplier_ClaudeBudgetBelowMinRemovesThinkingWithoutOrphanIncludeThoughts(t *testing.T) {
	applier := NewApplier()
	modelInfo := &registry.ModelInfo{
		ID:                  "claude-opus-4-6-thinking",
		MaxCompletionTokens: 64000,
		Thinking: &registry.ThinkingSupport{
			Min: 1024,
			Max: 64000,
		},
	}

	body := []byte(`{
		"request": {
			"generationConfig": {
				"maxOutputTokens": 512,
				"thinkingConfig": {
					"thinkingBudget": 4096,
					"includeThoughts": true
				}
			}
		}
	}`)

	out, err := applier.Apply(body, thinking.ThinkingConfig{
		Mode:   thinking.ModeBudget,
		Budget: 4096,
	}, modelInfo)
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if ojson.GetBytes(out, "request.generationConfig.thinkingConfig").Exists() {
		t.Fatalf("expected thinkingConfig to be completely removed when clamped budget < min; body=%s", out)
	}
}
