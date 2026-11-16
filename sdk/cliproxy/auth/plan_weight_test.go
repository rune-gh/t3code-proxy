package auth

import (
	"testing"
	"time"

	internalconfig "github.com/rune-oai/t3code-proxy/internal/config"
)

// setPlanRouting applies plan routing settings for one test and restores the
// defaults afterwards.
func setPlanRouting(t *testing.T, weights map[string]map[string]float64, reserve *float64) {
	t.Helper()
	applyPlanRoutingConfig(&internalconfig.Config{Routing: internalconfig.RoutingConfig{PlanWeights: weights, PlanHeadroomReserve: reserve}})
	t.Cleanup(func() { applyPlanRoutingConfig(nil) })
}

func TestPlanOf(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	tests := []struct {
		name string
		auth *Auth
		want string
	}{
		{name: "nil", auth: nil, want: ""},
		{name: "unknown", auth: &Auth{ID: "p-unknown", Provider: "claude"}, want: ""},
		{name: "codex id token plan", auth: &Auth{ID: "p-codex", Provider: "codex", Attributes: map[string]string{"plan_type": " Plus "}}, want: "plus"},
		{
			name: "codex response header beats stored plan",
			auth: &Auth{
				ID: "p-codex-header", Provider: "codex",
				Attributes: map[string]string{"plan_type": "plus"},
				Quota:      QuotaState{ObservedAt: now, Signals: map[string]string{"X-Codex-Plan-Type": "pro"}},
			},
			want: "pro",
		},
		{
			name: "codex header on a model state",
			auth: &Auth{
				ID: "p-codex-model-header", Provider: "codex",
				Quota:       QuotaState{ObservedAt: now, Signals: map[string]string{"X-Codex-Primary-Used-Percent": "3"}},
				ModelStates: map[string]*ModelState{"gpt-5": {Quota: QuotaState{ObservedAt: now.Add(-time.Minute), Signals: map[string]string{"X-Codex-Plan-Type": "team"}}}},
			},
			want: "team",
		},
		{name: "claude rate-limit tier", auth: &Auth{ID: "p-tier", Provider: "claude", Metadata: map[string]any{"rateLimitTier": "default_claude_max_20x", "subscriptionType": "max"}}, want: "max_20x"},
		{name: "claude tier without multiplier falls through", auth: &Auth{ID: "p-tier-ai", Provider: "claude", Metadata: map[string]any{"rate_limit_tier": "default_claude_ai", "subscription_type": "pro"}}, want: "pro"},
		{name: "claude subscription type", auth: &Auth{ID: "p-sub", Provider: "claude", Metadata: map[string]any{"subscriptionType": "Max"}}, want: "max"},
		{name: "plan spelled with spaces", auth: &Auth{ID: "p-spaces", Provider: "claude", Attributes: map[string]string{"plan": "Max 5x"}}, want: "max_5x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := PlanOf(tt.auth); got != tt.want {
				t.Fatalf("PlanOf() = %q, want %q", got, tt.want)
			}
		})
	}

	t.Run("observed plan wins", func(t *testing.T) {
		auth := &Auth{ID: "p-observed", Provider: "claude", Metadata: map[string]any{"subscriptionType": "pro"}}
		t.Cleanup(func() { ObserveAuthPlan(auth.ID, "") })
		ObserveAuthPlan(auth.ID, "max_20x")
		if got := PlanOf(auth); got != "max_20x" {
			t.Fatalf("PlanOf() = %q, want max_20x", got)
		}
		ObserveAuthPlan(auth.ID, "")
		if got := PlanOf(auth); got != "pro" {
			t.Fatalf("PlanOf() after clear = %q, want pro", got)
		}
	})
}

func TestPlanWeightDefaults(t *testing.T) {
	setPlanRouting(t, nil, nil)
	tests := []struct {
		provider, plan string
		want           float64
	}{
		{"claude", "pro", 1},
		{"claude", "max_5x", 5},
		{"Claude", "Max 20x", 20},
		{"claude", "default_claude_max_20x", 20},
		{"claude", "max", 5},
		{"claude", "max_40x", 40}, // derived from the tier name, no code change needed
		{"claude", "enterprise", 1},
		{"claude", "", 1},
		{"codex", "plus", 1},
		{"codex", "prolite", 5},
		{"codex", "pro", 20},
		{"codex", "promax", 50},
		{"codex", "team", 1},
		{"xai", "SuperGrok", 1},
		{"xai", "SuperGrok Heavy", 10},
		{"grok", "max_20x", 1}, // unknown provider
		{"", "pro", 1},
	}
	for _, tt := range tests {
		if got := PlanWeight(tt.provider, tt.plan); got != tt.want {
			t.Fatalf("PlanWeight(%q, %q) = %v, want %v", tt.provider, tt.plan, got, tt.want)
		}
	}
	auth := &Auth{ID: "w-auth", Provider: "codex", Attributes: map[string]string{"plan_type": "pro"}}
	if got := PlanWeightOf(auth); got != 20 {
		t.Fatalf("PlanWeightOf() = %v, want 20", got)
	}
	if got := PlanWeightOf(nil); got != 1 {
		t.Fatalf("PlanWeightOf(nil) = %v, want 1", got)
	}
}

func TestPlanWeightOverrides(t *testing.T) {
	setPlanRouting(t, map[string]map[string]float64{
		"Codex":  {"Pro": 10, "free": 0.25},
		"claude": {"max-20x": 15},
		"kimi":   {"premium": 3},
	}, nil)
	for _, tt := range []struct {
		provider, plan string
		want           float64
	}{
		{"codex", "pro", 10},
		{"codex", "free", 0.25},
		{"codex", "plus", 1},
		{"claude", "max_20x", 15},
		{"claude", "default_claude_max_20x", 15},
		{"claude", "max_5x", 5},
		{"kimi", "premium", 3},
	} {
		if got := PlanWeight(tt.provider, tt.plan); got != tt.want {
			t.Fatalf("PlanWeight(%q, %q) = %v, want %v", tt.provider, tt.plan, got, tt.want)
		}
	}

	effective := EffectivePlanWeights(map[string]map[string]float64{"Codex": {"Pro": 10}, "kimi": {"premium": 3}})
	if effective["codex"]["pro"] != 10 || effective["codex"]["plus"] != 1 || effective["claude"]["max_20x"] != 20 || effective["kimi"]["premium"] != 3 {
		t.Fatalf("EffectivePlanWeights() = %v", effective)
	}
	if defaults := DefaultPlanWeights(); defaults["codex"]["pro"] != 20 {
		t.Fatalf("DefaultPlanWeights() changed by an override: %v", defaults)
	}

	// A config update without overrides restores the built-in values.
	applyPlanRoutingConfig(&internalconfig.Config{})
	if got := PlanWeight("codex", "pro"); got != 20 {
		t.Fatalf("PlanWeight after reload = %v, want 20", got)
	}
}

func TestPlanRoutingFollowsManagerConfig(t *testing.T) {
	t.Cleanup(func() { applyPlanRoutingConfig(nil) })
	reserve := 0.0
	manager := NewManager(nil, nil, nil)
	manager.SetConfig(&internalconfig.Config{Routing: internalconfig.RoutingConfig{
		PlanWeights:         map[string]map[string]float64{"codex": {"pro": 8}},
		PlanHeadroomReserve: &reserve,
	}})
	if got := PlanWeight("codex", "pro"); got != 8 {
		t.Fatalf("PlanWeight after SetConfig = %v, want 8", got)
	}
	if got := planHeadroomReserve(); got != 0 {
		t.Fatalf("planHeadroomReserve after SetConfig = %v, want 0", got)
	}
	manager.SetConfig(&internalconfig.Config{})
	if got := planHeadroomReserve(); got != internalconfig.DefaultPlanHeadroomReserve {
		t.Fatalf("planHeadroomReserve default = %v, want %v", got, internalconfig.DefaultPlanHeadroomReserve)
	}
}
