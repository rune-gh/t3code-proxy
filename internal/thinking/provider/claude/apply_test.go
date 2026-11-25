package claude

import (
	"testing"

	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/thinking"
)

func TestApplier_DisablesThinkingWhenAdjustedBudgetBelowMin(t *testing.T) {
	applier := NewApplier()
	modelInfo := &registry.ModelInfo{
		ID:                  "claude-sonnet-4-5-20250929",
		MaxCompletionTokens: 64000,
		Thinking: &registry.ThinkingSupport{
			Min: 1024,
			Max: 32000,
		},
	}

	body := []byte(`{"model":"claude-sonnet-4-5-20250929","max_tokens":512,"messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled","budget_tokens":4096}}`)
	out, err := applier.Apply(body, thinking.ThinkingConfig{
		Mode:   thinking.ModeBudget,
		Budget: 4096,
	}, modelInfo)
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if got := ojson.GetBytes(out, "thinking.type").String(); got != "disabled" {
		t.Fatalf("expected thinking.type = disabled when adjusted budget < minBudget, got %q; body=%s", got, out)
	}
	if ojson.GetBytes(out, "thinking.budget_tokens").Exists() {
		t.Fatalf("expected thinking.budget_tokens to be removed when disabled; body=%s", out)
	}
}
